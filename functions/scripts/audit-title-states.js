#!/usr/bin/env node

const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { buildLegacyLibraryProjection, computeUserStatsFromStateSet } = require("../lib/titleStates");

initializeApp();
const db = getFirestore();

async function auditUser(userDoc) {
  const uid = userDoc.id;
  const userRef = userDoc.ref;
  const [statesSnap, librarySnap] = await Promise.all([
    userRef.collection("titleStates").get().catch(() => ({ docs: [] })),
    userRef.collection("library").get().catch(() => ({ docs: [] })),
  ]);

  const states = statesSnap.docs.map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }));
  const libraryMap = new Map(librarySnap.docs.map((docSnap) => [docSnap.id, docSnap.data() || {}]));
  const stats = userDoc.data()?.stats || {};
  const computedStats = computeUserStatsFromStateSet(states);
  const issues = [];

  if (states.length && (stats.totalWatchMinutes == null || stats.watchedCount == null || stats.ratingsCount == null || stats.rewatchCount == null)) {
    issues.push("stats mancanti o incomplete");
  }

  if (
    Number(stats.totalWatchMinutes || 0) !== computedStats.totalWatchMinutes
    || Number(stats.watchedCount || 0) !== computedStats.watchedCount
    || Number(stats.ratingsCount || 0) !== computedStats.ratingsCount
    || Number(stats.rewatchCount || 0) !== computedStats.rewatchCount
  ) {
    issues.push("stats incoerenti rispetto a titleStates");
  }

  for (const state of states) {
    const expectedLibrary = buildLegacyLibraryProjection(state);
    const legacyLibrary = libraryMap.get(state.titleId || state.id);
    if (Boolean(expectedLibrary) !== Boolean(legacyLibrary)) {
      issues.push(`library incoerente per ${state.titleId || state.id}`);
    }

    if (state.mediaType === "tv") {
      const titleSnap = await db.collection("titles").doc(state.titleId || state.id).get().catch(() => null);
      const meta = titleSnap?.data()?.meta || {};
      if (!Number(meta.durationEpisode || 0) || (!Number(meta.seasonsCount || 0) && !Number(meta.episodesPerSeason || 0))) {
        issues.push(`metadata TV incompleti per ${state.titleId || state.id}`);
      }
    }
  }

  return { uid, issues };
}

async function main() {
  console.log("\nAudit titleStates\n");
  const usersSnap = await db.collection("users").get();
  let totalIssues = 0;

  for (const userDoc of usersSnap.docs) {
    const { uid, issues } = await auditUser(userDoc);
    if (!issues.length) continue;
    totalIssues += issues.length;
    console.log(`${uid}`);
    issues.forEach((issue) => console.log(`  - ${issue}`));
  }

  if (!totalIssues) {
    console.log("Nessuna anomalia rilevata.");
  } else {
    console.log(`\nIssue totali: ${totalIssues}`);
  }
}

main().catch((err) => {
  console.error("Errore audit titleStates:", err);
  process.exit(1);
});
