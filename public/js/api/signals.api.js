import {
  collection,
  addDoc,
  query,
  where,
  getDocs,
  limit,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import { db } from "../firebase.js";

const ACTION_DEFAULTS = {
  rating: { weight: 1.0 },
  match_dislike: { weight: 0.55, normalized: -1 },
  match_ok: { weight: 0.15, normalized: 1 },
  match_love: { weight: 0.60, normalized: 1 },
  match_seen: { weight: 0.05, normalized: 0 },
  watchlist_add: { weight: 0.45, normalized: 1 },
  watchlist_remove: { weight: 0.45, normalized: -1 },
  suggest_to_friend: { weight: 0.70, normalized: 1 },
  thread_post: { weight: 0.20, normalized: 1 },
};

function clamp(value, min, max) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function todayKeyUTC() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function normalizeFromAction(actionType, rawValue) {
  if (actionType === "rating") {
    const r = clamp(Number(rawValue || 0), 1, 10);
    return clamp((r - 5.5) / 4.5, -1, 1);
  }
  const preset = ACTION_DEFAULTS[actionType]?.normalized;
  if (preset === undefined) return 0;
  return preset;
}

export async function logSignal({
  uid,
  titleId,
  actionType,
  rawValue = null,
  normalizedValue,
  actionWeight,
  source = "other",
} = {}) {
  if (!uid) throw new Error("uid mancante");
  if (!titleId) throw new Error("titleId mancante");
  if (!actionType) throw new Error("actionType mancante");

  const defaults = ACTION_DEFAULTS[actionType] || {};
  const baseWeight = Number(actionWeight ?? defaults.weight ?? 0.2);
  const normValue = Number(
    normalizedValue ?? normalizeFromAction(actionType, rawValue)
  );

  const dedupeKey = `${actionType}_${titleId}_${todayKeyUTC()}`;
  let multiplier = 1;
  try {
    const snap = await getDocs(query(
      collection(db, "users", uid, "signals"),
      where("dedupeKey", "==", dedupeKey),
      where("titleId", "==", titleId),
      limit(1)
    ));
    if (!snap.empty) {
      multiplier = 0.2; // diminishing returns within 24h window
    }
  } catch (_) {
    // non-blocking
  }

  const effectiveWeight = baseWeight * multiplier;
  const delta = normValue * effectiveWeight;

  const payload = {
    titleId: String(titleId),
    actionType: String(actionType),
    rawValue: rawValue === undefined ? null : rawValue,
    normalizedValue: normValue,
    actionWeight: baseWeight,
    delta,
    source: String(source || "other"),
    dedupeKey,
    multiplier,
    createdAt: serverTimestamp(),
  };

  await addDoc(collection(db, "users", uid, "signals"), payload);
  return { delta, deduped: multiplier < 1 };
}
