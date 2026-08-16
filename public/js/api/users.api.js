import {
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,
  collection,
  collectionGroup,
  serverTimestamp,
  writeBatch,
  query,
  orderBy,
  startAt,
  endAt,
  limit,
  getDocs,
  onSnapshot,
  where,
  documentId,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import { db, auth } from "../firebase.js";
import { t as i18nT } from "../i18n/index.js";
import { notifyFollow } from "./notifications.api.js";

function normalizeName(name){
  return String(name || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/[._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24)
    .replace(/^_+|_+$/g, "")
    .trim();
}

function normalizeDisplayNameLabel(value) {
  return String(value || "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/[._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24)
    .replace(/^_+|_+$/g, "");
}

function buildPublicDisplayName(user) {
  const emailLocalPart = String(user?.email || "").split("@")[0] || "";
  const candidates = [
    user?.displayName,
    emailLocalPart,
    "User",
  ];
  for (const candidate of candidates) {
    const label = normalizeDisplayNameLabel(candidate);
    if (label.length >= 3) return label;
  }
  return "User";
}

function normalizeLevel(level) {
  const v = String(level || "").trim().toLowerCase();
  return ["base", "associate", "doctor"].includes(v) ? v : "base";
}

function buildDefaultOnboardingStatus() {
  return {
    version: 1,
    startedAt: null,
    completedAt: null,
    completedLevel: 0,
    lastPromptAt: null,
    dismissedAt: null,
    confidenceScore: 0,
  };
}

function buildDefaultTasteProfile() {
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
    updatedAt: serverTimestamp(),
  };
}

function getUserPrivateRef(uid) {
  return doc(db, "usersPrivate", uid);
}

function mergeMyUserDocs(publicData = {}, privateData = {}) {
  const merged = { ...(publicData || {}) };
  if (privateData && typeof privateData === "object") {
    if ("email" in privateData) merged.email = privateData.email;
    if ("onboardingStatus" in privateData) merged.onboardingStatus = privateData.onboardingStatus;
    if ("tasteProfile" in privateData) merged.tasteProfile = privateData.tasteProfile;
    if ("onboardingMeta" in privateData) merged.onboardingMeta = privateData.onboardingMeta;
    if ("marketingConsent" in privateData) merged.marketingConsent = privateData.marketingConsent;
  }
  return merged;
}

export async function ensureUserDoc(user, opts = {}){
  if (!user?.uid) throw new Error("ensureUserDoc: user mancante");
  const email = user.email || "";
  const ref = doc(db, "users", user.uid);
  const privateRef = getUserPrivateRef(user.uid);
  const [snap, privateSnap] = await Promise.all([
    getDoc(ref),
    getDoc(privateRef).catch(() => null),
  ]);
  if (snap.exists()) {
    // keep lastActiveAt fresh
    const data = snap.data() || {};
    const patch = { lastActiveAt: serverTimestamp() };
    if (typeof data.level !== "string" || !data.level.trim()) {
      patch.level = "base";
    }
    if (!("avatarURL" in data) && typeof data.photoURL === "string" && data.photoURL) {
      patch.avatarURL = data.photoURL;
    }
    await updateDoc(ref, patch).catch(() => {});

    const privateData = privateSnap?.exists() ? (privateSnap.data() || {}) : {};
    const privatePatch = {};
    if (email) {
      privatePatch.email = email;
    }
    if (!privateData.onboardingStatus || typeof privateData.onboardingStatus !== "object") {
      privatePatch.onboardingStatus = (data.onboardingStatus && typeof data.onboardingStatus === "object")
        ? data.onboardingStatus
        : buildDefaultOnboardingStatus();
    }
    if (!privateData.tasteProfile || typeof privateData.tasteProfile !== "object") {
      privatePatch.tasteProfile = (data.tasteProfile && typeof data.tasteProfile === "object")
        ? data.tasteProfile
        : buildDefaultTasteProfile();
    }
    if (Object.keys(privatePatch).length) {
      privatePatch.updatedAt = serverTimestamp();
      await setDoc(privateRef, privatePatch, { merge: true }).catch(() => {});
    }
    // Utente gia' esistente: NON sovrascrivere il displayName scelto.
    return { isNewUser: false };
  }

  const displayName = buildPublicDisplayName(user);

  // Public profile doc (NO email here: email is sensitive)
  await setDoc(ref, {
    displayName,
    displayNameLower: normalizeName(displayName),
    photoURL: user.photoURL || "",
    avatarURL: user.photoURL || "",
    createdAt: serverTimestamp(),
    lastActiveAt: serverTimestamp(),
    privacyDefault: "public",
    trusted: false,
    isAdmin: false,
    level: normalizeLevel("base"),
    favoriteGenres: [],
    stats: {
      ratingsCount: 0,
      reviewsCount: 0,
      watchedCount: 0,
      totalWatchMinutes: 0,
      rewatchCount: 0,
    },
    // La form di registrazione RICHIEDE il checkbox "Accetto i termini
    // community" prima di poter creare l'account: l'accettazione è quindi
    // implicita al signup web (specchio del gate community-safety iOS).
    communitySafetyAcceptedAt: serverTimestamp(),
    communitySafetyVersion: 1,
    communitySafetyAcceptedSource: "web_signup",
  }, { merge: true });

  // Private doc with sensitive/profile-personal fields
  await setDoc(privateRef, {
    ...(email ? { email } : {}),
    onboardingStatus: buildDefaultOnboardingStatus(),
    tasteProfile: buildDefaultTasteProfile(),
    ...(opts.ageConfirmed ? { ageConfirmed: true, ageConfirmedAt: serverTimestamp() } : {}),
    updatedAt: serverTimestamp(),
  }, { merge: true }).catch(() => {});

  return { isNewUser: true };
}

/**
 * Consenso marketing (email di aggiornamenti/novità). Default OFF: opt-in
 * esplicito dalla pagina Impostazioni, non implicato dalla registrazione.
 */
export async function setMarketingConsent(uid, enabled) {
  if (!uid) throw new Error("setMarketingConsent: uid mancante");
  await setDoc(getUserPrivateRef(uid), {
    marketingConsent: !!enabled,
    marketingConsentAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }, { merge: true });
}

export async function updatePhotoURL(uid, photoURL) {
  const r = doc(db, "users", uid);
  await updateDoc(r, {
    photoURL,
    avatarURL: photoURL || "",
    updatedAt: serverTimestamp(),
  });
}

export async function updateMyDisplayName(uid, newName){
  const ref = doc(db, "users", uid);
  const displayName = String(newName || "").trim();
  if (!displayName) throw new Error(i18nT("Nome non valido"));
  await updateDoc(ref, {
    displayName,
    displayNameLower: normalizeName(displayName),
    updatedAt: serverTimestamp(),
  });
}

export async function getUserPublic(uid){
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? { uid, ...snap.data() } : null;
}

/**
 * L'utente dietro un handle (`@pulart`), o null.
 *
 * `usernames/{displayNameLower}` e' la reservation del nome pubblico: una sola
 * getDoc, leggibile da qualunque utente loggato (firestore.rules), e contiene
 * gia' `{ uid, displayName }`. Serve a trasformare un `@handle` battuto a mano
 * nel token canonico `@{Nome}(uid)` che il backend riconosce come menzione.
 */
export async function getUserByHandle(handle) {
  const key = normalizeName(handle);
  if (!key) return null;
  const snap = await getDoc(doc(db, "usernames", key));
  if (!snap.exists()) return null;
  const data = snap.data() || {};
  const uid = String(data.uid || "").trim();
  if (!uid) return null;
  return { uid, displayName: String(data.displayName || "").trim() || key };
}

export async function listUsersPublicByIds(uids, { max = 200 } = {}) {
  const uniq = Array.from(new Set((uids || []).map((x) => String(x || "").trim()).filter(Boolean)))
    .slice(0, Math.max(1, Math.min(500, Number(max) || 200)));
  if (!uniq.length) return [];

  const chunks = [];
  for (let i = 0; i < uniq.length; i += 10) {
    chunks.push(uniq.slice(i, i + 10));
  }

  const byUid = new Map();
  for (const chunk of chunks) {
    const q = query(
      collection(db, "users"),
      where(documentId(), "in", chunk),
      limit(chunk.length)
    );
    const snap = await getDocs(q);
    snap.docs.forEach((d) => {
      byUid.set(d.id, { uid: d.id, ...d.data() });
    });
  }

  return uniq.map((uid) => byUid.get(uid)).filter(Boolean);
}

export async function searchUsersByPrefix(prefix, { max = 10 } = {}){
  const p = normalizeName(prefix);
  if (!p) return [];

  const q = query(
    collection(db, "users"),
    orderBy("displayNameLower"),
    startAt(p),
    endAt(p + "\uf8ff"),
    limit(max)
  );

  const snap = await getDocs(q);
  return snap.docs.map(d => ({ uid: d.id, ...d.data() }));
}

export async function followUser(myUid, targetUid){
  if (myUid === targetUid) throw new Error(i18nT("Non puoi seguire te stesso"));
  const batch = writeBatch(db);
  const a = doc(db, "users", myUid, "following", targetUid);
  const b = doc(db, "users", targetUid, "followers", myUid);
  batch.set(a, { createdAt: serverTimestamp() });
  batch.set(b, { createdAt: serverTimestamp() });
  await batch.commit();

  // Best-effort: notifica in-app al target
  try {
    const me = await getUserPublic(myUid).catch(() => null);
    const fromName = me?.displayName || "Qualcuno";
    await notifyFollow(targetUid, myUid, fromName);
  } catch (_) {}
}

/**
 * Profili suggeriti per lo step "Segui qualcuno" dell'onboarding v2
 * (docs/ONBOARDING_V2.md). Specchio di
 * `UserRepository.suggestedProfilesToFollow` su iOS.
 *
 * Primario: chi ha in libreria i titoli appena scelti (collectionGroup su
 * `library`). Fallback quando la coincidenza rende poco: i profili con piu'
 * titoli visti. La libreria e' gia' il tab pubblico "Visti", quindi la query
 * non espone niente di nuovo — serve pero' la rule collection-group.
 */
export async function listSuggestedProfiles({
  seedTitleIds = [],
  excluding = [],
  max = 8,
} = {}) {
  const excluded = new Set((excluding || []).filter(Boolean));
  const sharedTitleCount = new Map();

  // Cappato a 4 titoli: costo di lettura lineare e prevedibile.
  for (const titleId of (seedTitleIds || []).filter(Boolean).slice(0, 4)) {
    const snap = await getDocs(query(
      collectionGroup(db, "library"),
      where("titleId", "==", titleId),
      limit(30),
    )).catch(() => null);

    for (const d of snap?.docs || []) {
      // path: users/{uid}/library/{titleId}
      const ownerUid = d.ref.parent?.parent?.id;
      if (!ownerUid || excluded.has(ownerUid)) continue;
      sharedTitleCount.set(ownerUid, (sharedTitleCount.get(ownerUid) || 0) + 1);
    }
  }

  // A parita' di titoli in comune, spareggio sull'uid: la lista non deve
  // ballare tra due aperture.
  const ranked = [...sharedTitleCount.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([uid]) => uid);

  if (ranked.length < max) {
    const fallback = await getDocs(query(
      collection(db, "users"),
      orderBy("stats.watchedCount", "desc"),
      limit(max * 3),
    )).catch(() => null);

    const seen = new Set(ranked);
    for (const d of fallback?.docs || []) {
      if (excluded.has(d.id) || seen.has(d.id)) continue;
      ranked.push(d.id);
      if (ranked.length >= max) break;
    }
  }

  const selected = ranked.slice(0, max);
  if (!selected.length) return [];

  const users = await listUsersPublicByIds(selected).catch(() => []);
  const byId = new Map(users.map((u) => [u.uid, u]));

  // Riaggancio il conteggio dei titoli in comune (serve alla riga per dire
  // perche' lo stiamo proponendo) e scarto chi non ha nome pubblico: una riga
  // "Segui" senza nome non e' seguibile in modo sensato.
  return selected
    .map((uid) => ({ user: byId.get(uid), sharedTitleCount: sharedTitleCount.get(uid) || 0 }))
    .filter((row) => row.user && String(row.user.displayName || "").trim());
}

export async function unfollowUser(myUid, targetUid){
  const batch = writeBatch(db);
  batch.delete(doc(db, "users", myUid, "following", targetUid));
  batch.delete(doc(db, "users", targetUid, "followers", myUid));
  await batch.commit();
}

// Grafo amici in dismissione (fase 1, 2026-07-29): il web non crea né modifica
// più `users/{uid}/friends`. Le write (send/accept/decline/remove) e i listener
// sono stati rimossi; resta solo la read `listFriends`, che ha ancora caller
// live (title/community/thread/quiz) da migrare a `following` in fase 2.
export async function listFriends(myUid){
  const q = query(
    collection(db, "users", myUid, "friends"),
    where("status", "==", "accepted")
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ uid: d.id, ...d.data() }));
}

export function listenFollowing(myUid, cb){
  const q = query(collection(db, "users", myUid, "following"), orderBy("createdAt", "desc"));
  return onSnapshot(q, (snap) => {
    const items = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
    cb(items);
  }, (err) => {
    console.warn('listenFollowing: snapshot error', err);
    cb([]);
  });
}

export function listenFollowers(myUid, cb){
  const q = query(collection(db, "users", myUid, "followers"), orderBy("createdAt", "desc"));
  return onSnapshot(q, (snap) => {
    const items = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
    cb(items);
  }, (err) => {
    console.warn("listenFollowers: snapshot error", err);
    cb([]);
  });
}

export async function listFollowing(myUid, { max = 200 } = {}){
  const q = query(
    collection(db, "users", myUid, "following"),
    orderBy("createdAt", "desc"),
    limit(max)
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ uid: d.id, ...d.data() }));
}

export async function listFollowers(myUid, { max = 200 } = {}){
  const q = query(
    collection(db, "users", myUid, "followers"),
    orderBy("createdAt", "desc"),
    limit(max)
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ uid: d.id, ...d.data() }));
}

export async function getRelationshipState(myUid, otherUid){
  const followSnap = await getDoc(doc(db, "users", myUid, "following", otherUid));
  return { isFollowing: followSnap.exists() };
}


export async function getMyUserDoc(uid){
  const [publicSnap, privateSnap] = await Promise.all([
    getDoc(doc(db, "users", uid)),
    getDoc(getUserPrivateRef(uid)).catch(() => null),
  ]);
  if (!publicSnap.exists() && !privateSnap?.exists()) return null;
  return mergeMyUserDocs(
    publicSnap.exists() ? publicSnap.data() : {},
    privateSnap?.exists() ? privateSnap.data() : {}
  );
}

/**
 * Salva la lingua scelta su `usersPrivate/{uid}.language`.
 *
 * Non e' la fonte di verita' del cambio lingua — quella e' localStorage, che
 * agisce subito e funziona anche da sloggati. Questo serve solo a ritrovare la
 * preferenza su un altro dispositivo, quindi e' best-effort: se fallisce,
 * l'utente ha comunque l'app nella lingua che ha scelto.
 *
 * Le rules accettano solo `it` e `en` (validUserLanguage in firestore.rules):
 * un valore diverso verrebbe rifiutato lato server, non silenziosamente
 * accettato.
 */
export async function saveMyLanguage(language) {
  const uid = auth.currentUser?.uid;
  if (!uid) return false;
  const value = String(language || "").trim();
  if (value !== "it" && value !== "en") return false;
  await setDoc(getUserPrivateRef(uid), { language: value }, { merge: true });
  return true;
}
