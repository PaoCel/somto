#!/usr/bin/env node
/**
 * scan-series-progress-zero.js — censimento READ-ONLY delle serie con
 * progresso "zero nonsense" nei titleStates:
 *
 *   [S0/E0]        seriesProgress.lastWatchedSeasonNumber === 0 oppure
 *                  lastWatchedEpisodeNumber === 0 (zeri LETTERALI nel doc:
 *                  il badge iOS li rende "S0·E4" / "S2·E0")
 *   [ZERO-PROGRESS] state === "in_progress" con episodesWatchedCount 0 e
 *                  seasonsCompletedCount 0 (iOS rende "0%", la serie appare
 *                  "in corso" senza aver visto nulla)
 *
 * Non scrive niente. Output: per utente, titolo, source e campi incriminati.
 *
 * Uso:
 *   cd functions
 *   node scripts/scan-series-progress-zero.js            # tutti gli utenti
 *   node scripts/scan-series-progress-zero.js --uid=UID  # un utente solo
 */
"use strict";

const admin = require("firebase-admin");

const args = process.argv.slice(2);
const ONLY_UID = (args.find((a) => a.startsWith("--uid=")) || "").split("=")[1] || null;

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

const titleCache = new Map();
async function getTitleName(titleId) {
  if (!titleCache.has(titleId)) {
    const snap = await db.collection("titles").doc(titleId).get();
    titleCache.set(titleId, snap.exists ? (snap.data().name || titleId) : `${titleId} (manca)`);
  }
  return titleCache.get(titleId);
}

const isZero = (v) => typeof v === "number" && v === 0;

(async () => {
  const usersSnap = ONLY_UID
    ? { docs: [await db.collection("users").doc(ONLY_UID).get()] }
    : await db.collection("users").get();

  const findings = [];
  let usersScanned = 0;
  let statesScanned = 0;

  for (const userDoc of usersSnap.docs) {
    if (!userDoc.exists) continue;
    const uid = userDoc.id;
    const displayName = userDoc.data()?.displayName || uid;
    // eslint-disable-next-line no-await-in-loop
    const statesSnap = await db.collection("users").doc(uid).collection("titleStates").get();
    usersScanned += 1;
    statesScanned += statesSnap.size;

    for (const stateDoc of statesSnap.docs) {
      const state = stateDoc.data() || {};
      const p = state.seriesProgress;
      if (!p || typeof p !== "object") continue;

      const tags = [];
      if (isZero(p.lastWatchedSeasonNumber) || isZero(p.lastWatchedEpisodeNumber)) {
        tags.push("S0/E0");
      }
      const epCount = Number(p.episodesWatchedCount) || 0;
      const seasonCount = Number(p.seasonsCompletedCount) || 0;
      if (state.state === "in_progress" && epCount === 0 && seasonCount === 0) {
        tags.push("ZERO-PROGRESS");
      }
      if (!tags.length) continue;

      findings.push({
        uid,
        displayName,
        titleId: stateDoc.id,
        source: state.source || "?",
        state: state.state || "?",
        tags,
        progress: {
          episodesWatchedCount: p.episodesWatchedCount ?? null,
          seasonsCompletedCount: p.seasonsCompletedCount ?? null,
          lastWatchedSeasonNumber: p.lastWatchedSeasonNumber ?? null,
          lastWatchedEpisodeNumber: p.lastWatchedEpisodeNumber ?? null,
          lastWatchedEpisodeName: p.lastWatchedEpisodeName ?? null,
          percentComplete: p.percentComplete ?? null,
          totalEpisodeCount: p.totalEpisodeCount ?? null,
        },
      });
    }
  }

  console.log(`\n===== SCAN: ${usersScanned} utenti, ${statesScanned} titleStates, ${findings.length} anomalie =====\n`);

  const byUser = new Map();
  findings.forEach((f) => {
    if (!byUser.has(f.uid)) byUser.set(f.uid, []);
    byUser.get(f.uid).push(f);
  });

  for (const [uid, list] of byUser) {
    console.log(`\n== ${list[0].displayName} (${uid}) — ${list.length} serie`);
    for (const f of list) {
      // eslint-disable-next-line no-await-in-loop
      const name = await getTitleName(f.titleId);
      console.log(`  [${f.tags.join("][")}] ${name} [${f.titleId}] · ${f.state} · ${f.source}`);
      console.log(`      ${JSON.stringify(f.progress)}`);
    }
  }

  const bySource = new Map();
  const byTag = new Map();
  findings.forEach((f) => {
    bySource.set(f.source, (bySource.get(f.source) || 0) + 1);
    f.tags.forEach((t) => byTag.set(t, (byTag.get(t) || 0) + 1));
  });
  console.log("\n===== RIEPILOGO =====");
  console.log("per tag:   ", Object.fromEntries(byTag));
  console.log("per source:", Object.fromEntries(bySource));
  console.log(`utenti coinvolti: ${byUser.size}`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
