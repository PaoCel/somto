"use strict";

// Shared "re-derive cached users/{uid}.stats from scratch" logic.
//
// Single source of truth used by:
//   - functions/index.js (`reconcileUserStats` scheduled job + `recomputeUserStats` callable)
//   - functions/scripts/backfill-title-states-metrics.js (one-off backfill script)
//
// Previously this lived only as a private function inside functions/index.js,
// which the backfill script could not reuse (index.js calls
// admin.initializeApp() unconditionally at module load, so requiring it from a
// standalone script double-initializes the Admin SDK and throws). The script
// ended up with its own partial reimplementation that dropped
// listProgressEntries minutes and stats.byCategory. Extracting the logic here
// lets both callers share one implementation.

const admin = require("firebase-admin");
const {
  computeUserStatsFromStateSet,
  deriveContentCategory,
} = require("./titleStates");

function toId(value) {
  return String(value || "").trim();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function toPositiveInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

function uniqueIdList(values) {
  const out = [];
  const seen = new Set();
  for (const raw of safeArray(values)) {
    const value = toId(raw);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

// Firestore `in` queries cap at 10 values per call, so this chunks the id list.
async function fetchDocumentMapById(collectionRef, ids) {
  const out = new Map();
  const uniqueIds = uniqueIdList(ids);
  for (let i = 0; i < uniqueIds.length; i += 10) {
    const chunk = uniqueIds.slice(i, i + 10);
    if (!chunk.length) continue;
    const snap = await collectionRef.where(admin.firestore.FieldPath.documentId(), "in", chunk).get();
    snap.docs.forEach((docSnap) => out.set(docSnap.id, docSnap.data() || {}));
  }
  return out;
}

// Re-derives a user's cached stats from scratch (titleStates + listProgressEntries).
// Used by the scheduled reconciliation, the admin/self callable, and the
// titleStates-metrics backfill script to correct any drift.
async function recomputeUserStatsForUid(db, uid) {
  const userRef = db.collection("users").doc(uid);
  const [statesSnap, listProgressSnap, derivedSnap] = await Promise.all([
    userRef.collection("titleStates").get().catch(() => ({ docs: [] })),
    userRef.collection("listProgressEntries").get().catch(() => ({ docs: [] })),
    userRef.collection("derivedRatings").get().catch(() => ({ docs: [] })),
  ]);

  // Voti serie derivati dai voti episodio (privati): contati a parte da
  // ratingsCount, mostrati come "+N dai tuoi voti episodio". Ricomputati qui
  // per auto-guarire l'eventuale drift del contatore incrementale.
  const derivedRatingsCount = derivedSnap.docs
    .filter((docSnap) => Boolean((docSnap.data() || {}).series))
    .length;

  const stateRows = statesSnap.docs.map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }));
  const listRows = listProgressSnap.docs.map((docSnap) => docSnap.data() || {});

  // Resolve the content category by joining the referenced title docs once.
  const titleIds = [];
  for (const row of stateRows) {
    const id = toId(row.titleId || row.id);
    if (id) titleIds.push(id);
  }
  for (const row of listRows) {
    const id = toId(row.titleId);
    if (id) titleIds.push(id);
  }
  const titleMap = await fetchDocumentMapById(db.collection("titles"), titleIds);
  const categoryForTitle = (rawTitleId, fallbackMediaType) => {
    const titleData = titleMap.get(toId(rawTitleId));
    return deriveContentCategory(titleData || { type: fallbackMediaType });
  };

  const stats = computeUserStatsFromStateSet(
    stateRows,
    (row) => categoryForTitle(row.titleId || row.id, row.mediaType)
  );

  // listProgressEntries hold extra rewatch minutes; bucket them per category too.
  let listProgressMinutes = 0;
  for (const row of listRows) {
    const minutes = toPositiveInt(row.watchMinutesContribution);
    if (!minutes) continue;
    listProgressMinutes += minutes;
    const category = categoryForTitle(row.titleId, row.mediaType);
    if (stats.byCategory[category]) {
      stats.byCategory[category].totalWatchMinutes += minutes;
    }
  }

  const resolved = {
    watchedCount: stats.watchedCount,
    ratingsCount: stats.ratingsCount,
    totalWatchMinutes: stats.totalWatchMinutes + listProgressMinutes,
    rewatchCount: stats.rewatchCount,
    derivedRatingsCount,
    byCategory: stats.byCategory,
  };

  await userRef.set({ stats: resolved }, { merge: true });
  return resolved;
}

module.exports = {
  fetchDocumentMapById,
  recomputeUserStatsForUid,
};
