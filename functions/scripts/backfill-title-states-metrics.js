#!/usr/bin/env node
//
// Backfill: repara completedCount/watchMinutesContribution/schemaVersion sui
// titleStates, poi ricalcola users/{uid}.stats da zero.
//
// Fix 2026-07 (audit Database Architect):
//   (a) stats.totalWatchMinutes ora include anche i minuti da
//       listProgressEntries (rewatch da liste pubbliche/condivise) — prima
//       venivano ignorati, disallineando questo script da recomputeUserStatsForUid.
//   (b) scrive anche stats.byCategory (film/serie_tv/cartoni_animati/anime),
//       prima assente.
// Entrambi ora derivano da recomputeUserStatsForUid (functions/lib/userStats.js),
// la STESSA funzione usata da reconcileUserStats/recomputeUserStats in
// functions/index.js — nessuna logica duplicata.
//
// Usage:
//   cd functions
//   node scripts/backfill-title-states-metrics.js            # dry-run (default)
//   node scripts/backfill-title-states-metrics.js --write    # applica le modifiche

const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const {
  TITLE_STATE_SCHEMA_VERSION,
  computeWatchMinutesContribution,
} = require("../lib/titleStates");
const { recomputeUserStatsForUid } = require("../lib/userStats");
const { previewUserStatsFromEnrichedStates } = require("../lib/titleStatesBackfill");

const WRITE = process.argv.includes("--write");

initializeApp();
const db = getFirestore();

const titleCache = new Map();

async function getTitle(titleId) {
  if (titleCache.has(titleId)) return titleCache.get(titleId);
  const snap = await db.collection("titles").doc(titleId).get().catch(() => null);
  const data = snap?.exists ? { id: titleId, ...(snap.data() || {}) } : null;
  titleCache.set(titleId, data);
  return data;
}

async function processUser(userDoc) {
  const uid = userDoc.id;
  const userRef = userDoc.ref;
  const statesSnap = await userRef.collection("titleStates").get().catch(() => ({ docs: [] }));
  if (!statesSnap.docs.length) {
    return { uid, updatedStates: 0, stats: null };
  }

  const batch = db.batch();
  let updatedStates = 0;
  const enrichedStates = [];

  for (const docSnap of statesSnap.docs) {
    const state = docSnap.data() || {};
    const titleId = String(state.titleId || docSnap.id || "").trim();
    const title = await getTitle(titleId);
    const isCompleted = state.mediaType === "tv"
      ? ["completed_unrated", "rated"].includes(String(state.state || "").trim().toLowerCase())
      : ["seen_unrated", "rated"].includes(String(state.state || "").trim().toLowerCase());
    const completedCount = Math.max(0, Number(state.completedCount || 0) || 0) || (isCompleted ? 1 : 0);
    const nextState = {
      ...state,
      completedCount,
      watchMinutesContribution: computeWatchMinutesContribution(title || { id: titleId, type: state.mediaType || "movie" }, {
        ...state,
        completedCount,
      }),
      schemaVersion: TITLE_STATE_SCHEMA_VERSION,
    };

    enrichedStates.push(nextState);

    const changed = Number(state.completedCount || 0) !== nextState.completedCount
      || Number(state.watchMinutesContribution || 0) !== nextState.watchMinutesContribution
      || Number(state.schemaVersion || 0) !== nextState.schemaVersion;

    if (WRITE && changed) {
      batch.set(docSnap.ref, {
        completedCount: nextState.completedCount,
        watchMinutesContribution: nextState.watchMinutesContribution,
        schemaVersion: nextState.schemaVersion,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      updatedStates += 1;
    } else if (changed) {
      updatedStates += 1;
    }
  }

  let stats;
  if (WRITE) {
    // Commit the titleStates fixes first, then re-derive users/{uid}.stats
    // from Firestore (titleStates + listProgressEntries) so the write reflects
    // the just-fixed watchMinutesContribution values and includes byCategory.
    await batch.commit();
    stats = await recomputeUserStatsForUid(db, uid);
  } else {
    // Dry-run preview: compute from the in-memory enriched states (title docs
    // are not written yet) so the printed numbers match what --write would
    // produce, without touching Firestore. listProgressEntries are fetched
    // read-only to include their minutes in the preview total, mirroring
    // recomputeUserStatsForUid (see lib/titleStatesBackfill.js).
    const titleMap = new Map();
    for (const s of enrichedStates) {
      const id = String(s.titleId || s.id || "").trim();
      if (id && !titleMap.has(id)) titleMap.set(id, await getTitle(id));
    }
    const listProgressSnap = await userRef.collection("listProgressEntries").get().catch(() => ({ docs: [] }));
    const listProgressRows = [];
    for (const docSnap of listProgressSnap.docs) {
      const row = docSnap.data() || {};
      const titleId = String(row.titleId || "").trim();
      if (titleId && !titleMap.has(titleId)) titleMap.set(titleId, await getTitle(titleId));
      listProgressRows.push(row);
    }

    stats = previewUserStatsFromEnrichedStates(enrichedStates, listProgressRows, titleMap);
  }

  return { uid, updatedStates, stats };
}

async function main() {
  console.log(`\nTitleStates metrics backfill - ${WRITE ? "WRITE" : "DRY RUN"}\n`);
  const usersSnap = await db.collection("users").get();
  let usersWithStates = 0;
  let updatedStates = 0;

  for (const userDoc of usersSnap.docs) {
    const result = await processUser(userDoc);
    if (!result.stats) continue;
    usersWithStates += 1;
    updatedStates += result.updatedStates;
    console.log(`${result.uid}: ${result.updatedStates} titleStates da aggiornare, ${result.stats.totalWatchMinutes} min`);
  }

  console.log(`\nUtenti con titleStates: ${usersWithStates}`);
  console.log(`TitleStates da aggiornare: ${updatedStates}`);
  console.log(`Titoli in cache: ${titleCache.size}`);
  if (!WRITE) {
    console.log("\nDry run completato. Usa --write per applicare le modifiche.");
  }
}

main().catch((err) => {
  console.error("Errore backfill titleStates:", err);
  process.exit(1);
});
