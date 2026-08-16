import {
  doc,
  setDoc,
  serverTimestamp,
  increment,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";
import { t as i18nT } from "../i18n/index.js";

import { app, db } from "../firebase.js";

const functions = getFunctions(app, "europe-west1");
const getMatchQueueCallable = httpsCallable(functions, "getMatchQueue");

const ALLOWED_ACTIONS = new Set(["like", "skip", "superlike", "seen"]);

function safeTitleId(value) {
  return String(value || "").trim();
}

function safeAction(value) {
  return String(value || "").trim().toLowerCase();
}

function toReasonList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .slice(0, 3);
}

function normalizeMatchItem(raw) {
  const id = safeTitleId(raw?.id || raw?.titleId);
  if (!id) return null;

  return {
    id,
    name: String(raw?.name || i18nT("(senza titolo)")),
    type: String(raw?.type || "movie"),
    year: Number(raw?.year || 0) || null,
    posterPath: String(raw?.posterPath || "").trim() || null,
    overview: String(raw?.overview || "").trim() || "",
    genres: Array.isArray(raw?.genres) ? raw.genres.slice(0, 4).map((g) => String(g || "").trim()).filter(Boolean) : [],
    reasons: toReasonList(raw?.reasons),
    score: Number(raw?.score || 0),
    matchPercent: Math.max(0, Math.min(100, Number(raw?.matchPercent || 0))),
    ratingAvg: Number(raw?.ratingAvg || 0),
    ratingCount: Number(raw?.ratingCount || 0),
  };
}

export async function getMatchQueue(opts = {}) {
  const max = Math.max(5, Math.min(36, Number(opts.max || 18)));
  const excludeTitleIds = Array.isArray(opts.excludeTitleIds)
    ? opts.excludeTitleIds.map((x) => safeTitleId(x)).filter(Boolean).slice(0, 500)
    : [];
  const fastStart = opts.fastStart === true;

  const payload = {
    max,
    fastStart,
    excludeTitleIds,
  };

  const res = await getMatchQueueCallable(payload);
  const data = res?.data || {};
  const providerLaneRaw = data?.providerLane;
  const providerName = String(providerLaneRaw?.provider?.name || "").trim();
  const providerItems = (Array.isArray(providerLaneRaw?.items) ? providerLaneRaw.items : [])
    .map(normalizeMatchItem)
    .filter(Boolean);

  return {
    engine: String(data.engine || "hybrid"),
    rationale: String(data.rationale || ""),
    generatedAtMs: Number(data.generatedAtMs || Date.now()),
    items: (Array.isArray(data.items) ? data.items : [])
      .map(normalizeMatchItem)
      .filter(Boolean),
    providerLane: providerName && providerItems.length
      ? {
          providerName,
          evidenceTitleCount: Math.max(2, Number(providerLaneRaw?.provider?.evidenceTitleCount || 2)),
          inferred: providerLaneRaw?.provider?.inferred === true,
          items: providerItems,
        }
      : null,
  };
}

export async function markMatchShown(uid, item) {
  const titleId = safeTitleId(item?.id || item?.titleId);
  if (!uid) throw new Error("uid mancante");
  if (!titleId) throw new Error("titleId mancante");

  const ref = doc(db, "users", uid, "matchFeedback", titleId);
  const patch = {
    titleId,
    shownAt: serverTimestamp(),
    shownCount: increment(1),
    scoreSnapshot: Number(item?.score || 0),
    matchPercentSnapshot: Number(item?.matchPercent || 0),
    source: "match_mode",
    reasonsSnapshot: toReasonList(item?.reasons),
    updatedAt: serverTimestamp(),
  };

  await setDoc(ref, patch, { merge: true });
  return { id: titleId };
}

export async function saveMatchFeedback(uid, item, action) {
  const titleId = safeTitleId(item?.id || item?.titleId);
  const safe = safeAction(action);

  if (!uid) throw new Error("uid mancante");
  if (!titleId) throw new Error("titleId mancante");
  if (!ALLOWED_ACTIONS.has(safe)) throw new Error(i18nT("azione non valida"));

  const ref = doc(db, "users", uid, "matchFeedback", titleId);
  const patch = {
    titleId,
    action: safe,
    actionAt: serverTimestamp(),
    shownAt: serverTimestamp(),
    scoreSnapshot: Number(item?.score || 0),
    matchPercentSnapshot: Number(item?.matchPercent || 0),
    source: "match_mode",
    reasonsSnapshot: toReasonList(item?.reasons),
    updatedAt: serverTimestamp(),
  };

  await setDoc(ref, patch, { merge: true });
  return { id: titleId, action: safe };
}
