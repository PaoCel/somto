#!/usr/bin/env node
/**
 * recompute-user-stats.js — Ricalcola da zero le statistiche cache di ogni utente
 * (stats.{watchedCount,ratingsCount,totalWatchMinutes,rewatchCount} + stats.byCategory),
 * fissando un baseline pulito per i contatori incrementali mantenuti dai trigger
 * recomputeUserStatsFromTitleStates e recomputeUserStatsFromListProgress.
 *
 * totalWatchMinutes = somma titleStates.watchMinutesContribution
 *                   + somma listProgressEntries.watchMinutesContribution
 *
 * byCategory = stessi contatori suddivisi per categoria (film / serie_tv /
 * cartoni_animati / anime), risolta via deriveContentCategory sul titolo.
 *
 * Usage:
 *   cd functions
 *   node scripts/recompute-user-stats.js            # dry-run (mostra il drift)
 *   node scripts/recompute-user-stats.js --write    # applica
 */

const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldPath } = require("firebase-admin/firestore");
const { computeUserStatsFromStateSet, deriveContentCategory } = require("../lib/titleStates.js");

const WRITE = process.argv.includes("--write");
const PAGE_SIZE = 100;
const COUNTER_KEYS = ["watchedCount", "ratingsCount", "totalWatchMinutes", "rewatchCount"];

initializeApp({ projectId: "gia-visto" });
const db = getFirestore();

function toPositiveInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

async function fetchTitleMap(titleIds) {
  const unique = [...new Set(titleIds.map((x) => String(x || "").trim()).filter(Boolean))];
  const map = new Map();
  for (let i = 0; i < unique.length; i += 10) {
    const chunk = unique.slice(i, i + 10);
    if (!chunk.length) continue;
    const snap = await db.collection("titles").where(FieldPath.documentId(), "in", chunk).get();
    snap.docs.forEach((d) => map.set(d.id, d.data() || {}));
  }
  return map;
}

async function recomputeForUser(userRef) {
  const [statesSnap, listProgressSnap] = await Promise.all([
    userRef.collection("titleStates").get(),
    userRef.collection("listProgressEntries").get(),
  ]);

  const stateRows = statesSnap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
  const listRows = listProgressSnap.docs.map((d) => d.data() || {});

  // Resolve the content category by joining the referenced title docs.
  const titleIds = [];
  for (const row of stateRows) titleIds.push(row.titleId || row.id);
  for (const row of listRows) titleIds.push(row.titleId);
  const titleMap = await fetchTitleMap(titleIds);
  const categoryForTitle = (rawId, fallbackMediaType) => {
    const data = titleMap.get(String(rawId || "").trim());
    return deriveContentCategory(data || { type: fallbackMediaType });
  };

  const stats = computeUserStatsFromStateSet(
    stateRows,
    (row) => categoryForTitle(row.titleId || row.id, row.mediaType)
  );

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

  return {
    watchedCount: stats.watchedCount,
    ratingsCount: stats.ratingsCount,
    totalWatchMinutes: stats.totalWatchMinutes + listProgressMinutes,
    rewatchCount: stats.rewatchCount,
    byCategory: stats.byCategory,
  };
}

async function main() {
  console.log(`recompute-user-stats — ${WRITE ? "WRITE" : "DRY-RUN"}`);
  let processed = 0;
  let changed = 0;
  let lastDoc = null;
  let hasMore = true;

  while (hasMore) {
    let query = db.collection("users").orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (lastDoc) query = query.startAfter(lastDoc);
    const snap = await query.get();
    if (snap.empty) break;

    for (const docSnap of snap.docs) {
      const resolved = await recomputeForUser(docSnap.ref);
      const current = (docSnap.data() || {}).stats || {};
      const drift = COUNTER_KEYS.filter((k) => toPositiveInt(current[k]) !== resolved[k]);
      const missingByCategory = !current.byCategory || typeof current.byCategory !== "object";

      if (drift.length || missingByCategory) {
        changed += 1;
        const detail = drift.length
          ? drift.map((k) => `${k} ${toPositiveInt(current[k])}->${resolved[k]}`).join(", ")
          : "byCategory mancante";
        console.log(`  ${docSnap.id}: ${detail}`);
        if (WRITE) {
          await docSnap.ref.set({ stats: resolved }, { merge: true });
        }
      }
      processed += 1;
    }

    lastDoc = snap.docs[snap.docs.length - 1];
    hasMore = snap.size === PAGE_SIZE;
  }

  console.log(`\nFatto. Utenti: ${processed}, con drift: ${changed}${WRITE ? " (scritti)" : " (dry-run, nulla scritto)"}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
