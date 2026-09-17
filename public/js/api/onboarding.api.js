import {
  doc,
  collection,
  query,
  where,
  limit,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  serverTimestamp,
  runTransaction,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import { db } from "../firebase.js";
import { t as i18nT } from "../i18n/index.js";
import { logEvent } from "../analytics.js";
import { trackProductEvent } from "./productAnalytics.js";

export const ONBOARDING_VERSION = 1;
export const ONBOARDING_LEVEL = Object.freeze({
  NONE: 0,
  EASY: 1,
  MEDIUM: 2,
  ADVANCED: 3,
});

// Versione del tutorial guidato "Il giro di Somto" (3 step). Bump solo se
// cambia il contenuto/struttura del tour, per far riapparire il tour agli
// utenti che l'hanno gia' visto. Identica costante lato iOS.
export const TOUR_VERSION = 1;

const DISPLAY_NAME_MIN = 3;
const DISPLAY_NAME_MAX = 24;
const VIBE_MAX = 2;
const SEED_MIN = 4;
const SEED_MAX = 12;
const DISLIKES_MAX = 5;
const CONTEXT_MAX = 3;

function clamp(value, min, max) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function tsToMs(ts) {
  if (!ts) return 0;
  if (typeof ts === "number") return ts;
  if (typeof ts?.toMillis === "function") return ts.toMillis();
  if (typeof ts?.seconds === "number") {
    return (ts.seconds * 1000) + Math.floor((ts.nanoseconds || 0) / 1e6);
  }
  return 0;
}

function uniqueLimited(values, max = 12) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const value = String(raw || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function asValidChoice(value, allowed, fallback = null) {
  const v = String(value || "").trim().toLowerCase();
  return allowed.includes(v) ? v : fallback;
}

function safeText(value, { max = 80 } = {}) {
  const v = String(value || "").replace(/\s+/g, " ").trim();
  if (!v) return null;
  return v.slice(0, max);
}

function userPrivateRef(uid) {
  return doc(db, "usersPrivate", uid);
}

async function loadUserProfileBundle(uid) {
  const [userSnap, privateSnap] = await Promise.all([
    getDoc(doc(db, "users", uid)),
    getDoc(userPrivateRef(uid)).catch(() => null),
  ]);
  const userData = userSnap.exists() ? (userSnap.data() || {}) : {};
  const privateData = privateSnap?.exists() ? (privateSnap.data() || {}) : {};
  return {
    exists: userSnap.exists(),
    userSnap,
    privateSnap,
    userData,
    privateData,
    mergedData: {
      ...userData,
      ...privateData,
    },
  };
}

export function normalizeDisplayNameKey(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9._ -]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDisplayNameLabel(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/[._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, DISPLAY_NAME_MAX)
    .replace(/^_+|_+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function validateDisplayName(value) {
  const displayName = normalizeDisplayNameLabel(value);
  const displayNameLower = normalizeDisplayNameKey(displayName);

  if (!displayName) {
    return { ok: false, error: i18nT("Inserisci un nome pubblico.") };
  }
  if (displayName.length < DISPLAY_NAME_MIN || displayName.length > DISPLAY_NAME_MAX) {
    return { ok: false, error: i18nT("Il nome deve essere tra {DISPLAY_NAME_MIN} e {DISPLAY_NAME_MAX} caratteri.", { DISPLAY_NAME_MIN, DISPLAY_NAME_MAX }) };
  }
  if (!/[a-z0-9]/i.test(displayNameLower)) {
    return { ok: false, error: i18nT("Il nome deve contenere almeno una lettera o un numero.") };
  }
  if (displayNameLower.length < DISPLAY_NAME_MIN) {
    return { ok: false, error: i18nT("Nome non valido.") };
  }
  return { ok: true, displayName, displayNameLower };
}

export function buildDefaultOnboardingStatus() {
  return {
    version: ONBOARDING_VERSION,
    startedAt: null,
    completedAt: null,
    completedLevel: 0,
    lastPromptAt: null,
    dismissedAt: null,
    confidenceScore: 0,
    tourSeenAt: null,
    tourSeenVersion: 0,
  };
}

export function buildDefaultTasteProfile() {
  return {
    seedTitleIds: [],
    seedLikedTitleIds: [],
    vibe: [],
    filmVsSeries: "mix",
    mainstream: "mix",
    era: null,
    context: [],
    dislikes: [],
    favoriteTitleText: null,
    contentTolerance: null,
    updatedAt: null,
  };
}

function normalizeStatus(raw) {
  const base = buildDefaultOnboardingStatus();
  const status = (raw && typeof raw === "object") ? raw : {};
  return {
    ...base,
    ...status,
    version: ONBOARDING_VERSION,
    completedLevel: clamp(status.completedLevel || 0, 0, 3),
    confidenceScore: clamp(status.confidenceScore || 0, 0, 100),
    tourSeenVersion: clamp(status.tourSeenVersion || 0, 0, 999),
  };
}

function normalizeTasteProfile(raw) {
  const base = buildDefaultTasteProfile();
  const src = (raw && typeof raw === "object") ? raw : {};
  return {
    ...base,
    ...src,
    seedTitleIds: uniqueLimited(src.seedTitleIds || [], 24),
    seedLikedTitleIds: uniqueLimited(src.seedLikedTitleIds || [], 24),
    vibe: uniqueLimited(src.vibe || [], VIBE_MAX),
    filmVsSeries: asValidChoice(src.filmVsSeries, ["film", "mix", "series"], "mix"),
    mainstream: asValidChoice(src.mainstream, ["mainstream", "mix", "discover"], "mix"),
    era: safeText(src.era, { max: 40 }),
    context: uniqueLimited(src.context || [], CONTEXT_MAX),
    dislikes: uniqueLimited(src.dislikes || [], DISLIKES_MAX),
    favoriteTitleText: safeText(src.favoriteTitleText, { max: 120 }),
    contentTolerance: asValidChoice(src.contentTolerance, ["light", "heavy", "disturbing"], null),
  };
}

function buildCandidateName(baseName, idx) {
  if (idx <= 0) return baseName;
  const suffix = String(idx + 1);
  const maxLen = Math.max(DISPLAY_NAME_MIN, DISPLAY_NAME_MAX - suffix.length);
  const base = baseName.slice(0, maxLen).trim();
  return `${base}${suffix}`;
}

async function reserveDisplayNameCandidate({ uid, candidateName, previousKey = null }) {
  const checked = validateDisplayName(candidateName);
  if (!checked.ok) {
    const err = new Error(checked.error || i18nT("Nome non valido"));
    err.code = "invalid-display-name";
    throw err;
  }

  const { displayName, displayNameLower } = checked;

  await runTransaction(db, async (tx) => {
    const userRef = doc(db, "users", uid);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists()) {
      const err = new Error(i18nT("Utente non trovato"));
      err.code = "user-not-found";
      throw err;
    }

    const userData = userSnap.data() || {};
    const oldKey = normalizeDisplayNameKey(previousKey || userData.displayNameLower || "");
    const usernameRef = doc(db, "usernames", displayNameLower);
    const usernameSnap = await tx.get(usernameRef);
    const oldRef = oldKey && oldKey !== displayNameLower
      ? doc(db, "usernames", oldKey)
      : null;
    const oldSnap = oldRef ? await tx.get(oldRef) : null;

    if (usernameSnap.exists() && usernameSnap.data()?.uid !== uid) {
      const err = new Error(i18nT("Nome pubblico non disponibile"));
      err.code = "display-name-taken";
      throw err;
    }

    const preservedCreatedAt = usernameSnap.exists() ? (usernameSnap.data()?.createdAt || null) : null;
    tx.set(usernameRef, {
      uid,
      displayName,
      displayNameLower,
      createdAt: preservedCreatedAt || serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true });

    tx.set(userRef, {
      displayName,
      displayNameLower,
      updatedAt: serverTimestamp(),
    }, { merge: true });

    if (oldRef && oldSnap?.exists() && oldSnap.data()?.uid === uid) {
      tx.delete(oldRef);
    }
  });

  return { displayName, displayNameLower };
}

export async function reserveDisplayNameUnique({ uid, desiredName, previousKey = null, maxAttempts = 14 }) {
  const checked = validateDisplayName(desiredName);
  if (!checked.ok) throw new Error(checked.error || i18nT("Nome non valido"));

  const baseName = checked.displayName;
  let lastError = null;

  for (let idx = 0; idx < maxAttempts; idx++) {
    const candidateName = buildCandidateName(baseName, idx);
    try {
      const reserved = await reserveDisplayNameCandidate({
        uid,
        candidateName,
        previousKey,
      });
      return {
        ...reserved,
        autoFallback: idx > 0,
      };
    } catch (err) {
      if (err?.code !== "display-name-taken") {
        throw err;
      }
      lastError = err;
    }
  }

  if (lastError) throw lastError;
  throw new Error(i18nT("Nome pubblico non disponibile. Riprova con una variante."));
}

export async function checkDisplayNameAvailability({ desiredName, uid = null } = {}) {
  const checked = validateDisplayName(desiredName);
  if (!checked.ok) {
    return {
      ok: false,
      available: false,
      error: checked.error || i18nT("Nome non valido"),
      displayName: "",
      displayNameLower: "",
      ownerUid: null,
    };
  }

  const { displayName, displayNameLower } = checked;
  const ref = doc(db, "usernames", displayNameLower);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    return {
      ok: true,
      available: true,
      displayName,
      displayNameLower,
      ownerUid: null,
    };
  }

  const ownerUid = String(snap.data()?.uid || "");
  const isMine = !!uid && ownerUid === String(uid);
  return {
    ok: true,
    available: isMine,
    displayName,
    displayNameLower,
    ownerUid: ownerUid || null,
  };
}

export async function listOnboardingSeedTitles({ max = 18 } = {}) {
  const targetMax = clamp(max, 20, 84);
  const perQueryLimit = clamp(Math.max(90, targetMax * 2), 90, 220);
  const nowMs = Date.now();
  const twoYearsAgo = nowMs - (730 * 24 * 60 * 60 * 1000);

  const candidateMap = new Map();
  const pushRows = (snap) => {
    for (const d of snap.docs) {
      const row = { id: d.id, ...d.data() };
      if (row.status !== "approved") continue;
      if (!row.name) continue;
      if (!candidateMap.has(row.id)) {
        candidateMap.set(row.id, row);
      }
    }
  };

  // Query rule-safe: include status filter so Firestore rules can authorize the list.
  // We avoid extra orderBy here to reduce index requirements on fresh deployments.
  await getDocs(
    query(
      collection(db, "titles"),
      where("status", "==", "approved"),
      limit(perQueryLimit),
    )
  ).then(pushRows).catch(() => {});

  const rows = [...candidateMap.values()];
  const movie = [];
  const series = [];
  const other = [];
  const scoreOf = (item) => {
    const ratingCount = Number(item.ratingCount || 0);
    const ratingAvg = Number(item.ratingAvg || 0);
    const createdMs = tsToMs(item.createdAt);
    const year = Number(item.year || 0);

    let score = Math.log10(ratingCount + 1) * 2.5;
    score += clamp(ratingAvg, 0, 10) * 0.85;
    if (createdMs && createdMs >= twoYearsAgo) score += 2.1;
    if (year >= (new Date().getFullYear() - 2)) score += 1.2;
    if (item.posterPath) score += 0.5;
    return score;
  };

  for (const item of rows) {
    item._seedScore = scoreOf(item);
    const type = String(item.type || "").toLowerCase();
    if (type === "movie") movie.push(item);
    else if (type === "tv" || type === "series") series.push(item);
    else other.push(item);
  }

  const sorter = (a, b) => Number(b._seedScore || 0) - Number(a._seedScore || 0);
  movie.sort(sorter);
  series.sort(sorter);
  other.sort(sorter);

  // Interleave by bucket for a balanced and broader strategic set.
  const picked = [];
  const pickedIds = new Set();
  const usedGenres = new Set();
  const buckets = [movie, series, other];
  let cursor = 0;
  while (picked.length < targetMax) {
    let advanced = false;
    for (const bucket of buckets) {
      const row = bucket[cursor];
      if (!row) continue;
      advanced = true;
      if (pickedIds.has(row.id)) continue;

      const genres = Array.isArray(row.genres) ? row.genres : [];
      const hasFreshGenre = genres.some(g => !usedGenres.has(String(g)));
      if (picked.length > Math.floor(targetMax * 0.55) && !hasFreshGenre) {
        continue;
      }

      pickedIds.add(row.id);
      picked.push(row);
      genres.forEach(g => usedGenres.add(String(g)));
      if (picked.length >= targetMax) break;
    }
    if (!advanced) break;
    cursor += 1;
  }

  // Fill eventual gaps without genre constraint.
  if (picked.length < targetMax) {
    const fallback = rows.sort(sorter);
    for (const row of fallback) {
      if (picked.length >= targetMax) break;
      if (pickedIds.has(row.id)) continue;
      pickedIds.add(row.id);
      picked.push(row);
    }
  }

  return picked.map(t => ({
    id: t.id,
    name: t.name || "Titolo",
    year: t.year || null,
    type: t.type || null,
    posterPath: t.posterPath || null,
    description: safeText(t.description || t.overview || "", { max: 240 }),
  }));
}

export async function getOnboardingSnapshot(uid) {
  const profile = await loadUserProfileBundle(uid);
  if (!profile.exists) {
    return {
      exists: false,
      userDoc: null,
      onboardingStatus: buildDefaultOnboardingStatus(),
      tasteProfile: buildDefaultTasteProfile(),
      shouldShowFullscreen: false,
      shouldShowCard: false,
      shouldShowTour: false,
    };
  }

  const userDoc = profile.mergedData || {};
  const onboardingStatus = normalizeStatus(userDoc.onboardingStatus);
  const tasteProfile = normalizeTasteProfile(userDoc.tasteProfile);
  const completedLevel = onboardingStatus.completedLevel || 0;
  const shouldShowCard = completedLevel < ONBOARDING_LEVEL.EASY;
  const shouldShowFullscreen = shouldShowCard && !onboardingStatus.lastPromptAt;
  // Tutorial "Il giro di Somto": auto-show una volta per gli utenti che hanno
  // gia' passato (o non necessitano piu' di) il carosello fullscreen di
  // onboarding, e non hanno ancora visto la versione corrente del tour.
  const tourAlreadySeen = Number(onboardingStatus.tourSeenVersion || 0) >= TOUR_VERSION;
  const hasPassedOnboardingGate = completedLevel >= ONBOARDING_LEVEL.EASY || !!onboardingStatus.lastPromptAt;
  const shouldShowTour = hasPassedOnboardingGate && !tourAlreadySeen && !shouldShowFullscreen;

  return {
    exists: true,
    userDoc,
    onboardingStatus,
    tasteProfile,
    completedLevel,
    confidenceScore: onboardingStatus.confidenceScore || 0,
    shouldShowCard,
    shouldShowFullscreen,
    shouldShowTour,
  };
}

// Timbra il tutorial "Il giro di Somto" come visto, cross-device.
// SEMPRE setDoc/merge con mappa annidata (mai updateDoc dotted-path: fallisce
// se usersPrivate/{uid} non esiste ancora, caso reale per account vecchi).
export async function markTutorialTourSeen(uid) {
  if (!uid) return;
  await setDoc(userPrivateRef(uid), {
    onboardingStatus: {
      version: ONBOARDING_VERSION,
      tourSeenAt: serverTimestamp(),
      tourSeenVersion: TOUR_VERSION,
    },
    updatedAt: serverTimestamp(),
  }, { merge: true });
}

/**
 * Timbra la risposta alla domanda d'ingresso dell'onboarding v2 ("hai gia' una
 * cronologia da portare?"). `source` e' `trakt | tvtime_gdpr | netflix_csv |
 * letterboxd | none`. Specchio di `UserRepository.markOnboardingSource` (iOS).
 */
export async function markOnboardingSource(uid, source) {
  if (!uid) return;
  await setDoc(userPrivateRef(uid), {
    onboardingStatus: {
      flowVersion: 2,
      source: String(source || "none"),
      startedAt: serverTimestamp(),
    },
    updatedAt: serverTimestamp(),
  }, { merge: true });
}

export async function dismissOnboardingPrompt(uid, { source = "fullscreen" } = {}) {
  await setDoc(userPrivateRef(uid), {
    onboardingStatus: {
      version: ONBOARDING_VERSION,
      dismissedAt: serverTimestamp(),
      lastPromptAt: serverTimestamp(),
    },
    onboardingMeta: {
      lastDismissSource: String(source || "unknown").slice(0, 32),
      updatedAt: serverTimestamp(),
    },
    updatedAt: serverTimestamp(),
  }, { merge: true });
}

function normalizeLevel(level) {
  const n = clamp(level, 0, 3);
  if (n <= 0) return ONBOARDING_LEVEL.EASY;
  return n;
}

function normalizeFinalizeScope(scope) {
  const raw = String(scope || "full").trim().toLowerCase();
  if (raw === "identity" || raw === "taste") return raw;
  return "full";
}

export async function startOnboardingSession({ uid, level }) {
  const pickedLevel = normalizeLevel(level);
  const sessionId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const telemetryRef = doc(db, "users", uid, "onboardingTelemetry", sessionId);
  await setDoc(telemetryRef, {
    version: ONBOARDING_VERSION,
    uid,
    sessionId,
    levelChosen: pickedLevel,
    startedAt: serverTimestamp(),
    completed: false,
    steps: {},
    clicks: [],
    counters: {
      toggleCount: 0,
      clickCount: 0,
    },
  }, { merge: true });

  const userRef = doc(db, "users", uid);
  await setDoc(userPrivateRef(uid), {
    onboardingStatus: {
      version: ONBOARDING_VERSION,
      startedAt: serverTimestamp(),
      lastPromptAt: serverTimestamp(),
    },
    updatedAt: serverTimestamp(),
  }, { merge: true });

  void logEvent("onboarding_started", {
    level: pickedLevel,
    source: "wizard",
  });
  trackProductEvent("onboarding_started");

  return { sessionId, level: pickedLevel };
}

function sanitizeTelemetry(raw) {
  const src = (raw && typeof raw === "object") ? raw : {};
  const clickRows = Array.isArray(src.clicks) ? src.clicks : [];
  const allowedActions = new Set(["add", "remove", "like", "softlike", "dislike", "undo"]);
  const safeClicks = clickRows.slice(0, 120).map((item, idx) => ({
    itemId: String(item?.itemId || "").slice(0, 120),
    action: allowedActions.has(String(item?.action || "")) ? String(item.action) : "add",
    orderIndex: Number.isFinite(item?.orderIndex) ? Number(item.orderIndex) : idx + 1,
    timestampMs: Number.isFinite(item?.timestampMs) ? Number(item.timestampMs) : Date.now(),
  })).filter(item => item.itemId);

  const rawSteps = (src.steps && typeof src.steps === "object") ? src.steps : {};
  const safeSteps = {};
  for (const [stepId, val] of Object.entries(rawSteps)) {
    if (!stepId || typeof val !== "object" || !val) continue;
    safeSteps[String(stepId).slice(0, 40)] = {
      startMs: Number.isFinite(val.startMs) ? Number(val.startMs) : null,
      endMs: Number.isFinite(val.endMs) ? Number(val.endMs) : null,
      dwellMs: Number.isFinite(val.dwellMs) ? Number(val.dwellMs) : 0,
      toggleCount: Number.isFinite(val.toggleCount) ? Number(val.toggleCount) : 0,
    };
  }

  return {
    steps: safeSteps,
    clicks: safeClicks,
    counters: {
      toggleCount: Number.isFinite(src?.counters?.toggleCount) ? Number(src.counters.toggleCount) : 0,
      clickCount: safeClicks.length,
    },
  };
}

function mergeTaste(baseRaw, patchRaw) {
  const base = normalizeTasteProfile(baseRaw);
  const patch = (patchRaw && typeof patchRaw === "object") ? patchRaw : {};
  return {
    ...base,
    seedTitleIds: uniqueLimited(patch.seedTitleIds ?? base.seedTitleIds, 24),
    seedLikedTitleIds: uniqueLimited(patch.seedLikedTitleIds ?? base.seedLikedTitleIds, 24),
    vibe: uniqueLimited(patch.vibe ?? base.vibe, VIBE_MAX),
    filmVsSeries: asValidChoice(patch.filmVsSeries, ["film", "mix", "series"], base.filmVsSeries || "mix"),
    mainstream: asValidChoice(patch.mainstream, ["mainstream", "mix", "discover"], base.mainstream || "mix"),
    era: safeText(patch.era, { max: 40 }) ?? base.era,
    context: uniqueLimited(patch.context ?? base.context, CONTEXT_MAX),
    dislikes: uniqueLimited(patch.dislikes ?? base.dislikes, DISLIKES_MAX),
    favoriteTitleText: safeText(patch.favoriteTitleText, { max: 120 }) ?? base.favoriteTitleText,
    contentTolerance: asValidChoice(
      patch.contentTolerance,
      ["light", "heavy", "disturbing"],
      base.contentTolerance || null
    ),
  };
}

export function computeConfidenceScore({
  completedLevel = 0,
  tasteProfile = {},
  hasDisplayName = false,
  hasAvatar = false,
} = {}) {
  const levelBase = [0, 30, 55, 72][clamp(completedLevel, 0, 3)] || 0;
  let score = levelBase;
  if (hasDisplayName) score += 10;
  if (hasAvatar) score += 6;

  const tp = normalizeTasteProfile(tasteProfile);
  score += Math.min(22, tp.seedTitleIds.length * 2);
  score += Math.min(10, tp.seedLikedTitleIds.length);
  score += Math.min(6, tp.vibe.length * 3);
  if (tp.filmVsSeries) score += 3;
  if (tp.mainstream) score += 3;
  if (tp.era) score += 3;
  score += Math.min(4, tp.context.length * 2);
  score += Math.min(4, tp.dislikes.length);
  if (tp.favoriteTitleText) score += 2;
  if (tp.contentTolerance) score += 2;
  return clamp(score, 0, 100);
}

export async function finalizeOnboarding({
  uid,
  selectedLevel,
  scope = "full",
  answers = {},
  telemetry = null,
  sessionId = null,
} = {}) {
  const level = normalizeLevel(selectedLevel);
  const safeScope = normalizeFinalizeScope(scope);
  const saveIdentity = safeScope !== "taste";
  const saveTaste = safeScope !== "identity";
  const userRef = doc(db, "users", uid);
  const profile = await loadUserProfileBundle(uid);
  if (!profile.exists) throw new Error(i18nT("Utente non trovato"));

  const userData = profile.mergedData || {};
  const previousStatus = normalizeStatus(userData.onboardingStatus);
  const previousTaste = normalizeTasteProfile(userData.tasteProfile);
  const existingAvatar = safeText(userData.avatarURL, { max: 1500 })
    || safeText(userData.photoURL, { max: 1500 })
    || "";

  let chosenDisplayName = String(userData.displayName || "").trim();
  let displayNameLower = normalizeDisplayNameKey(userData.displayNameLower || userData.displayName || "");
  let displayAutoFallback = false;
  if (saveIdentity) {
    const requestedDisplayName = safeText(answers.displayName, { max: DISPLAY_NAME_MAX }) || chosenDisplayName || "";
    const requestedDisplayNameLower = normalizeDisplayNameKey(requestedDisplayName || "");
    const currentDisplayNameLower = normalizeDisplayNameKey(userData.displayName || userData.displayNameLower || "");
    const shouldReserveDisplayName = !!requestedDisplayName
      && requestedDisplayNameLower
      && requestedDisplayNameLower !== currentDisplayNameLower;

    chosenDisplayName = requestedDisplayName;
    displayNameLower = requestedDisplayNameLower || currentDisplayNameLower || displayNameLower;

    if (shouldReserveDisplayName) {
      const reserved = await reserveDisplayNameUnique({
        uid,
        desiredName: requestedDisplayName,
        previousKey: userData.displayNameLower || null,
        maxAttempts: 1,
      });
      chosenDisplayName = reserved.displayName;
      displayNameLower = reserved.displayNameLower;
      displayAutoFallback = !!reserved.autoFallback;
    }
  }

  const mergedTaste = saveTaste ? mergeTaste(previousTaste, answers) : previousTaste;
  const completedLevel = saveTaste
    ? Math.max(Number(previousStatus.completedLevel || 0), level)
    : Number(previousStatus.completedLevel || 0);
  const explicitAvatar = safeText(answers.avatarURL, { max: 1500 });
  const avatarRemoved = answers?.avatarRemoved === true;
  const avatarURL = saveIdentity
    ? (avatarRemoved ? "" : (explicitAvatar || existingAvatar))
    : existingAvatar;
  const confidenceScore = computeConfidenceScore({
    completedLevel,
    tasteProfile: mergedTaste,
    hasDisplayName: !!displayNameLower,
    hasAvatar: !!avatarURL,
  });

  const publicWritePayload = {
    avatarURL: avatarURL || "",
    photoURL: avatarURL || "",
    updatedAt: serverTimestamp(),
  };

  if (saveIdentity) {
    publicWritePayload.displayName = chosenDisplayName || userData.displayName || "User";
    publicWritePayload.displayNameLower = displayNameLower || userData.displayNameLower || "";
  }

  const privateWritePayload = {
    onboardingStatus: {
      version: ONBOARDING_VERSION,
      completedLevel,
      completedAt: saveTaste ? serverTimestamp() : (previousStatus.completedAt || null),
      lastPromptAt: serverTimestamp(),
      dismissedAt: saveTaste ? null : (previousStatus.dismissedAt || null),
      confidenceScore,
      startedAt: previousStatus.startedAt || serverTimestamp(),
    },
    tasteProfile: {
    ...mergedTaste,
    updatedAt: saveTaste ? serverTimestamp() : null,
    },
    updatedAt: serverTimestamp(),
  };

  await Promise.all([
    setDoc(userRef, publicWritePayload, { merge: true }),
    setDoc(userPrivateRef(uid), privateWritePayload, { merge: true }),
  ]);

  if (sessionId) {
    const telemetryRef = doc(db, "users", uid, "onboardingTelemetry", sessionId);
    const safeTelemetry = sanitizeTelemetry(telemetry);
    await setDoc(telemetryRef, {
      version: ONBOARDING_VERSION,
      uid,
      sessionId,
      completed: true,
      completedLevel,
      confidenceScore,
      endedAt: serverTimestamp(),
      ...safeTelemetry,
    }, { merge: true });
  }

  void logEvent("onboarding_completed", {
    level: completedLevel,
    scope: safeScope,
    confidence_score: confidenceScore,
    seed_count: (mergedTaste.seedTitleIds || []).length,
  });
  trackProductEvent("onboarding_completed");

  return {
    completedLevel,
    confidenceScore,
    displayName: chosenDisplayName,
    displayNameLower,
    avatarURL: avatarURL || "",
    tasteProfile: mergedTaste,
    autoFallbackDisplayName: displayAutoFallback,
    seedCount: (mergedTaste.seedTitleIds || []).length,
    minSeedRecommended: SEED_MIN,
    maxSeedRecommended: SEED_MAX,
    scope: safeScope,
  };
}

export async function saveOnboardingTelemetry({
  uid,
  sessionId,
  telemetry,
  completed = false,
} = {}) {
  if (!uid || !sessionId) return;
  const telemetryRef = doc(db, "users", uid, "onboardingTelemetry", sessionId);
  const safeTelemetry = sanitizeTelemetry(telemetry);
  await setDoc(telemetryRef, {
    version: ONBOARDING_VERSION,
    uid,
    sessionId,
    completed: !!completed,
    updatedAt: serverTimestamp(),
    ...safeTelemetry,
  }, { merge: true });
}

export async function saveOnboardingDraft({
  uid,
  selectedLevel,
  answers = {},
} = {}) {
  if (!uid) return;
  const level = normalizeLevel(selectedLevel || 1);
  const profile = await loadUserProfileBundle(uid);
  if (!profile.exists) return;

  const current = profile.mergedData || {};
  const mergedTaste = mergeTaste(current.tasteProfile, answers);
  await setDoc(userPrivateRef(uid), {
    tasteProfile: {
      ...mergedTaste,
      updatedAt: serverTimestamp(),
    },
    onboardingStatus: {
      version: ONBOARDING_VERSION,
      startedAt: serverTimestamp(),
      lastPromptAt: serverTimestamp(),
      completedLevel: Math.max(Number(current?.onboardingStatus?.completedLevel || 0), 0),
    },
    onboardingMeta: {
      draftLevel: level,
      draftSavedAt: serverTimestamp(),
    },
    updatedAt: serverTimestamp(),
  }, { merge: true });
}

export async function updateOnboardingPromptTouch(uid) {
  if (!uid) return;
  await updateDoc(userPrivateRef(uid), {
    "onboardingStatus.version": ONBOARDING_VERSION,
    "onboardingStatus.lastPromptAt": serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export function getOnboardingLevelLabel(level) {
  const n = normalizeLevel(level);
  if (n === ONBOARDING_LEVEL.EASY) return i18nT("Lieve");
  if (n === ONBOARDING_LEVEL.MEDIUM) return i18nT("Medio");
  return "Avanzato";
}

export function getNextUpgradeLevel(completedLevel) {
  const lvl = clamp(completedLevel, 0, 3);
  if (lvl < 1) return 1;
  if (lvl < 2) return 2;
  if (lvl < 3) return 3;
  return 3;
}
