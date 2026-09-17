#!/usr/bin/env node
/**
 * repair-completed-series-inflated-progress.js
 *
 * Ripara i `titleStates` di serie FINITE a cui una stagione nuova di TMDB ha
 * gonfiato il progresso: `buildTitleStateMetricsRepairPayload` alzava
 * `episodesWatchedCount` fino al totale corrente per tenere in piedi lo stato
 * "finita", accreditando all'utente episodi mai visti (incidente Ted Lasso S4,
 * 2026-08-04 — fix del trigger nello stesso commit).
 *
 * Riconoscibile senza indovinare, perche' lo snapshot di completamento c'e':
 *   completedAtTotalEpisodes > 0
 *   seriesProgress.episodesWatchedCount > completedAtTotalEpisodes
 *   nessuna visione dopo il completamento (lastWatchedAt <= completedAt)
 *
 * L'ultima condizione protegge chi la stagione nuova l'ha vista davvero: in
 * quel caso `lastWatchedAt` e' posteriore e il doc non si tocca.
 *
 * Riporta il progresso allo snapshot e ricalcola `percentComplete` sui totali
 * correnti. NON tocca `state` (chi ha votato resta "rated") ne'
 * `watchMinutesContribution` (gia' calcolato sullo snapshot, non gonfiato).
 *
 * Uso:
 *   cd functions
 *   node scripts/repair-completed-series-inflated-progress.js             # dry-run
 *   node scripts/repair-completed-series-inflated-progress.js --apply     # scrive
 *   node scripts/repair-completed-series-inflated-progress.js --uid=UID   # un utente
 */
"use strict";

const admin = require("firebase-admin");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ONLY_UID = (args.find((a) => a.startsWith("--uid=")) || "").split("=")[1] || null;

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

const toInt = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
const toMillis = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : 0);

const titleCache = new Map();
async function getTitleName(titleId) {
  if (!titleCache.has(titleId)) {
    const snap = await db.collection("titles").doc(titleId).get().catch(() => null);
    titleCache.set(titleId, snap?.exists ? (snap.data().name || titleId) : titleId);
  }
  return titleCache.get(titleId);
}

(async () => {
  const userIds = ONLY_UID
    ? [ONLY_UID]
    : (await db.collection("users").select().get()).docs.map((d) => d.id);

  console.log(`utenti da scansionare: ${userIds.length}${APPLY ? " (APPLY)" : " (dry-run)"}`);

  let scanned = 0;
  let hits = 0;
  let written = 0;

  for (const uid of userIds) {
    const statesSnap = await db.collection("users").doc(uid).collection("titleStates")
      .where("mediaType", "==", "tv")
      .get()
      .catch(() => null);
    if (!statesSnap) continue;

    for (const docSnap of statesSnap.docs) {
      scanned += 1;
      const s = docSnap.data() || {};
      const progress = s.seriesProgress && typeof s.seriesProgress === "object" ? s.seriesProgress : null;
      if (!progress) continue;

      const snapshotEpisodes = toInt(s.completedAtTotalEpisodes);
      const watched = toInt(progress.episodesWatchedCount);
      if (!snapshotEpisodes || watched <= snapshotEpisodes) continue;

      // Visione reale dopo il completamento → non e' gonfiaggio, e' progresso vero.
      const lastWatchedMs = toMillis(progress.lastWatchedAt);
      const completedMs = toMillis(s.completedAt);
      if (completedMs && lastWatchedMs && lastWatchedMs > completedMs + 60_000) continue;

      hits += 1;
      const snapshotSeasons = toInt(s.completedAtTotalSeasons);
      const totalEpisodes = toInt(progress.totalEpisodeCount);
      const nextProgress = { ...progress, episodesWatchedCount: snapshotEpisodes };
      if (snapshotSeasons && toInt(progress.seasonsCompletedCount) > snapshotSeasons) {
        nextProgress.seasonsCompletedCount = snapshotSeasons;
      }
      if (snapshotSeasons && toInt(progress.lastWatchedSeasonNumber) > snapshotSeasons) {
        nextProgress.lastWatchedSeasonNumber = snapshotSeasons;
      }
      nextProgress.percentComplete = totalEpisodes
        ? Math.max(0, Math.min(1, snapshotEpisodes / totalEpisodes))
        : 1;

      const name = await getTitleName(docSnap.id);
      console.log(
        `${APPLY ? "FIX " : "HIT "} ${uid} ${docSnap.id} "${name}": `
        + `${watched}/${totalEpisodes || "?"} → ${snapshotEpisodes}/${totalEpisodes || "?"} `
        + `(snapshot ${snapshotEpisodes}ep/${snapshotSeasons || "?"}st)`
      );

      if (APPLY) {
        await docSnap.ref.set({
          seriesProgress: nextProgress,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        written += 1;
      }
    }
  }

  console.log(`\ntitleStates tv scansionati: ${scanned}`);
  console.log(`da riparare: ${hits}`);
  console.log(`riparati: ${written}${APPLY ? "" : " (dry-run: nessuna scrittura)"}`);
  process.exit(0);
})().catch((e) => {
  console.error("ERRORE", e?.message || e);
  process.exit(1);
});
