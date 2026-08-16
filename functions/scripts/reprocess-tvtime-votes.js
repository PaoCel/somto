#!/usr/bin/env node
/**
 * reprocess-tvtime-votes.js
 *
 * Ri-processa i VOTI + EMOZIONI di un import TV Time GDPR già completato,
 * usando il decoder CORRETTO (2026-07-09), leggendo i CSV ancora presenti su
 * Storage (ritenzione 7gg) e ricostruendo la mappa nome→titleId dagli `items`
 * dell'import (nessun re-match TMDB). Scrive:
 *   - ratings level=episode  (ratings-3-prod-episode_votes.csv → 3/27/29 = Wow/Good/Meh → 10/7/5)
 *   - ratings level=title    (ratings-live-votes.csv → voti-stella film, se presente)
 *   - titleEmotions          (emotions-live-votes.csv → emozioni film, source:tvtime_import)
 * Tutti i rating portano source:import_tvtime_gdpr (id-doc deterministici →
 * merge idempotente; un re-run non duplica).
 *
 * Prerequisito: prima RIMUOVI i vecchi rating corrotti con
 *   node scripts/purge-tvtime-import-ratings.js --uid=UID --level=title --write
 * (i level=episode legittimi restano; questo script li ri-scrive comunque
 * idempotente con i valori corretti).
 *
 * SICUREZZA: dry-run DEFAULT. --write per applicare. Un solo import per run.
 *
 * Usage (da functions/):
 *   node scripts/reprocess-tvtime-votes.js --uid=UID --import=IMPORT_ID            # dry-run
 *   node scripts/reprocess-tvtime-votes.js --uid=UID --import=IMPORT_ID --write
 */

"use strict";

const admin = require("firebase-admin");
const {
  parseTvTimeEpisodeVotesCsv,
  parseTvTimeMovieRatingsCsv,
  parseTvTimeMovieEmotionsCsv,
  parseTvTimeMovieCommentsCsv,
  parseTvTimeEpisodeCommentsCsv,
  mergeVotesAndComments,
  buildEmotionStashByTitle,
} = require("../lib/importAdapters/tvTimeRatings");
const { resolveRatingWrites, makeRatingId } = require("../lib/importAdapters/tvTimeRatingsWriter");

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
function getArg(flag, def = "") {
  const hit = args.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1).trim() : def;
}
const ARG_UID = getArg("--uid");
const ARG_IMPORT = getArg("--import");

if (!ARG_UID || !ARG_IMPORT) {
  console.error("Usage: node scripts/reprocess-tvtime-votes.js --uid=UID --import=IMPORT_ID [--write]");
  process.exit(1);
}

const BUCKET = "gia-visto.firebasestorage.app";
admin.initializeApp({ projectId: "gia-visto", storageBucket: BUCKET });
const db = admin.firestore();
const bucket = admin.storage().bucket(BUCKET);

async function dl(path) {
  if (!path) return "";
  const file = bucket.file(path);
  const [exists] = await file.exists();
  if (!exists) return "";
  const [buf] = await file.download();
  return buf.toString("utf8");
}

function nameKey(s) { return String(s || "").trim().toLowerCase(); }

async function main() {
  console.log(`[reprocess-tvtime-votes] uid=${ARG_UID} import=${ARG_IMPORT} mode=${WRITE ? "WRITE" : "DRY-RUN"}`);

  const importRef = db.collection("users").doc(ARG_UID).collection("imports").doc(ARG_IMPORT);
  const importSnap = await importRef.get();
  if (!importSnap.exists) { console.error("Import non trovato."); process.exit(1); }
  const importData = importSnap.data() || {};
  const sp = importData.storagePaths || {};
  console.log("  source:", importData.source, "status:", importData.status);
  console.log("  storagePaths:", Object.keys(sp).join(", ") || "(none)");

  // --- Load the retained CSVs from Storage ---
  const [episodeVotesCsv, movieRatingsCsv, movieEmotionsCsv, movieCommentsCsv, episodeCommentsCsv] = await Promise.all([
    dl(sp.episodeVotes),   // ratings-3 -> episode ratings
    dl(sp.movieRatings),   // ratings-live -> movie ratings (probabilmente assente sugli import vecchi)
    dl(sp.movieVotes),     // emotions-live -> movie emotions
    dl(sp.movieComments),
    dl(sp.episodeComments),
  ]);
  console.log(`  bytes: episodeVotes=${episodeVotesCsv.length} movieRatings=${movieRatingsCsv.length} movieEmotions=${movieEmotionsCsv.length} movieComments=${movieCommentsCsv.length} episodeComments=${episodeCommentsCsv.length}`);

  // --- Rebuild name->titleId resolution map from the import's items ---
  const itemsSnap = await importRef.collection("items").get();
  const resolutionMap = new Map();
  itemsSnap.forEach((doc) => {
    const it = doc.data() || {};
    if (!it.resolved || !it.titleId || it.skip === true) return;
    if (it.kind === "movie") {
      resolutionMap.set(`movie|${nameKey(it.movieNameGuess)}`, it.titleId);
    } else {
      resolutionMap.set(`tv|${nameKey(it.seriesNameGuess)}|${it.seasonNumber}|${it.episodeNumber}`, it.titleId);
    }
  });
  console.log(`  resolution keys from items: ${resolutionMap.size}`);

  // --- Ratings (episode + movie) + comments ---
  const epRes = parseTvTimeEpisodeVotesCsv(episodeVotesCsv);
  const mvRes = parseTvTimeMovieRatingsCsv(movieRatingsCsv);
  const { comments: movieComments } = parseTvTimeMovieCommentsCsv(movieCommentsCsv);
  const { comments: episodeComments } = parseTvTimeEpisodeCommentsCsv(episodeCommentsCsv);
  console.log(`  episode ratings: ${epRes.votes.length} (scale ${epRes.scale}, domUnrecog ${epRes.dominantIdUnrecognized})`);
  console.log(`  movie ratings:   ${mvRes.votes.length} (scale ${mvRes.scale})`);

  const { intents, unrecognizedVotes, commentsWithoutVote } = mergeVotesAndComments(
    [...epRes.votes, ...mvRes.votes],
    [...movieComments, ...episodeComments]
  );
  const now = admin.firestore.FieldValue.serverTimestamp();
  const { writes, unresolvedCount } = resolveRatingWrites({ uid: ARG_UID, intents, titleResolutionMap: resolutionMap, now });
  const ratingValHist = {};
  writes.forEach((w) => { const k = `${w.payload.level}:${w.payload.rating}`; ratingValHist[k] = (ratingValHist[k] || 0) + 1; });
  console.log(`  → rating da scrivere: ${writes.length} | ${JSON.stringify(ratingValHist)} | unrecognizedVotes ${unrecognizedVotes} commentsWithoutVote ${commentsWithoutVote} unresolved ${unresolvedCount}`);

  // --- Movie emotions -> titleEmotions stash ---
  const { emotions, unrecognized: emUnrecog } = parseTvTimeMovieEmotionsCsv(movieEmotionsCsv);
  const stash = buildEmotionStashByTitle(emotions);
  const emotionWrites = [];
  let emUnresolved = 0;
  for (const entry of stash) {
    const titleId = resolutionMap.get(`movie|${nameKey(entry.movieNameGuess)}`);
    if (!titleId) { emUnresolved += 1; continue; }
    if (!entry.emotionKeys.length) continue;
    emotionWrites.push({
      docId: makeRatingId({ uid: ARG_UID, titleId, level: "title" }),
      payload: { uid: ARG_UID, titleId, level: "title", season: null, episode: null, emotions: entry.emotionKeys, source: "tvtime_import", createdAt: now, updatedAt: now },
    });
  }
  console.log(`  → emozioni film da stash: ${emotionWrites.length} (movie distinti ${stash.length}, unrecognized-id ${emUnrecog}, non risolti ${emUnresolved})`);

  if (!WRITE) {
    console.log("\n  DRY-RUN: nessuna scrittura. Rilancia con --write per applicare.");
    console.log("  Anteprima rating:", JSON.stringify(writes.slice(0, 5).map((w) => ({ id: w.ratingId, lvl: w.payload.level, r: w.payload.rating }))));
    console.log("  Anteprima emozioni:", JSON.stringify(emotionWrites.slice(0, 5).map((w) => ({ id: w.docId, e: w.payload.emotions }))));
    return;
  }

  // Write ratings
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch();
    for (const w of writes.slice(i, i + 400)) batch.set(db.collection("ratings").doc(w.ratingId), w.payload, { merge: true });
    // eslint-disable-next-line no-await-in-loop
    await batch.commit();
  }
  // Write emotions
  for (let i = 0; i < emotionWrites.length; i += 400) {
    const batch = db.batch();
    for (const w of emotionWrites.slice(i, i + 400)) batch.set(db.collection("titleEmotions").doc(w.docId), w.payload, { merge: true });
    // eslint-disable-next-line no-await-in-loop
    await batch.commit();
  }
  // Update import summary for visibility
  await importRef.set({
    ratingsSummary: {
      ratingsWritten: writes.length, unrecognizedVotes, commentsWithoutVote, unresolvedRatings: unresolvedCount,
      emotionsStashed: emotionWrites.length, emotionsUnresolved: emUnresolved,
      episodeScale: epRes.scale || null, movieScale: mvRes.scale || null,
      reprocessedAt: now,
    },
  }, { merge: true });

  console.log(`\n  Fatto. rating scritti: ${writes.length}, emozioni stash: ${emotionWrites.length}.`);
  console.log("  NB: aggregati emozioni NON ricalcolati (feature non live). Lancia backfill-titleEmotionAggregate quando la feature va live.");
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("[reprocess-tvtime-votes] errore:", err);
  process.exit(1);
});
