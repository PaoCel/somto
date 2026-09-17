#!/usr/bin/env node
/**
 * backfill-watch-minutes.js — Calcola e scrive stats.totalWatchMinutes
 * per ogni utente che ha una library.
 *
 * Per ogni utente:
 *  1. Legge la subcollection library
 *  2. Per ogni entry, legge il titolo dalla collection titles
 *  3. Calcola i minuti totali (durationMovie per film, durationEpisode * seasons * episodes per serie)
 *  4. Scrive stats.totalWatchMinutes e stats.watchedCount sul doc utente
 *
 * Usage:
 *   cd functions
 *   node scripts/backfill-watch-minutes.js              # dry-run
 *   node scripts/backfill-watch-minutes.js --write       # apply changes
 */

const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const WRITE = process.argv.includes("--write");

initializeApp({ projectId: "gia-visto" });
const db = getFirestore();

// Cache titoli per evitare letture duplicate
const titleCache = new Map();

async function getTitle(titleId) {
  if (titleCache.has(titleId)) return titleCache.get(titleId);

  const doc = await db.collection("titles").doc(titleId).get();
  const data = doc.exists ? doc.data() : null;
  titleCache.set(titleId, data);
  return data;
}

function estimatedWatchMinutes(titleData) {
  if (!titleData) return 0;
  const meta = titleData.meta || {};
  const type = titleData.type;

  if (type === "movie") {
    return Math.max(0, meta.durationMovie || 0);
  }

  if (type === "tv") {
    const durationEpisode = Math.max(0, meta.durationEpisode || 0);
    const seasonsCount = Math.max(0, meta.seasonsCount || 0);
    const episodesPerSeason = Math.max(0, meta.episodesPerSeason || 0);
    if (durationEpisode <= 0 || seasonsCount <= 0 || episodesPerSeason <= 0) return 0;
    return durationEpisode * seasonsCount * episodesPerSeason;
  }

  return 0;
}

async function processUser(userDoc) {
  const userId = userDoc.id;
  const userData = userDoc.data();
  const displayName = userData.displayName || userId;

  const librarySnap = await db
    .collection("users")
    .doc(userId)
    .collection("library")
    .get();

  if (librarySnap.empty) {
    return { userId, displayName, watchedCount: 0, totalMinutes: 0, skipped: true };
  }

  const watchedCount = librarySnap.size;
  let totalMinutes = 0;

  for (const entry of librarySnap.docs) {
    const entryData = entry.data();
    const titleId = entryData.titleId || entry.id;
    const titleData = await getTitle(titleId);
    totalMinutes += estimatedWatchMinutes(titleData);
  }

  if (WRITE) {
    await db.collection("users").doc(userId).update({
      "stats.totalWatchMinutes": totalMinutes,
      "stats.watchedCount": watchedCount,
    });
  }

  return { userId, displayName, watchedCount, totalMinutes, skipped: false };
}

async function main() {
  console.log(`\n🎬 Backfill watch minutes — ${WRITE ? "WRITE MODE" : "DRY RUN"}\n`);

  const usersSnap = await db.collection("users").get();
  console.log(`Trovati ${usersSnap.size} utenti.\n`);

  let processed = 0;
  let updated = 0;
  let skipped = 0;

  for (const userDoc of usersSnap.docs) {
    const result = await processUser(userDoc);
    processed++;

    if (result.skipped) {
      skipped++;
      continue;
    }

    updated++;
    const days = Math.floor(result.totalMinutes / 1440);
    const hours = Math.floor((result.totalMinutes % 1440) / 60);
    const mins = result.totalMinutes % 60;
    console.log(
      `  ${result.displayName.padEnd(20)} → ${result.watchedCount} titoli, ` +
      `${days}g ${hours}h ${mins}m (${result.totalMinutes} min)`
    );
  }

  console.log(`\n✅ Processati: ${processed} | Aggiornati: ${updated} | Saltati (library vuota): ${skipped}`);
  console.log(`📦 Titoli in cache: ${titleCache.size}`);
  if (!WRITE) {
    console.log(`\n⚠️  Dry run completato. Usa --write per applicare le modifiche.`);
  }
}

main().catch((err) => {
  console.error("❌ Errore:", err);
  process.exit(1);
});
