#!/usr/bin/env node
/**
 * import-report.js — report completo di un import titoli (read-only).
 * Uso: node scripts/import-report.js --uid=UID --import=IMPORT_ID
 */
"use strict";
const admin = require("firebase-admin");
const { parseTvTimeGdprCsvs } = require("../lib/importAdapters/tvTimeGdpr");
const R = require("../lib/importAdapters/tvTimeRatings");

const args = process.argv.slice(2);
const g = (f) => { const h = args.find((a) => a.startsWith(`${f}=`)); return h ? h.slice(f.length + 1).trim() : ""; };
const UID = g("--uid"); const IMPORT = g("--import");
if (!UID || !IMPORT) { console.error("Uso: --uid=UID --import=IMPORT_ID"); process.exit(1); }

const BUCKET = "gia-visto.firebasestorage.app";
admin.initializeApp({ projectId: "gia-visto", storageBucket: BUCKET });
const db = admin.firestore();
const bucket = admin.storage().bucket(BUCKET);
const ts = (v) => { try { return v && v.toDate ? v.toDate().toISOString() : v; } catch { return v; } };
const dl = async (p) => { if (!p) return ""; try { const [e] = await bucket.file(p).exists(); if (!e) return ""; const [b] = await bucket.file(p).download(); return b.toString("utf8"); } catch { return ""; } };

(async () => {
  const u = (await db.collection("users").doc(UID).get()).data() || {};
  console.log(`\n========== IMPORT REPORT — ${u.displayName || UID} (${UID}) ==========`);

  const importRef = db.collection("users").doc(UID).collection("imports").doc(IMPORT);
  const x = (await importRef.get()).data() || {};
  console.log(`\n[IMPORT] ${IMPORT}`);
  console.log(`  source=${x.source} platform=${x.platform || "n/a (pre-tracking)"} status=${x.status}`);
  console.log(`  created=${ts(x.createdAt)} completed=${ts(x.completedAt)}`);
  console.log(`  totalRows=${x.totalRows} matched=${x.matchedCount} unresolved=${x.unresolvedCount} errorCount=${x.errorCount} tickCount=${x.tickCount}`);
  if (x.ratingsSummary) console.log(`  ratingsSummary=${JSON.stringify(x.ratingsSummary)}`);

  // ---- items match analysis ----
  const items = await importRef.collection("items").get();
  let resolved = 0, unresolved = 0, wl = 0; const strat = {}; const unresSample = [];
  items.forEach((d) => { const it = d.data(); if (it.resolved) resolved++; else unresolved++; if (it.watchlistOnly) wl++;
    const s = it.strategy || (it.resolved ? "?" : "none"); strat[s] = (strat[s] || 0) + 1;
    if (!it.resolved && unresSample.length < 20) unresSample.push(it.movieNameGuess || it.seriesNameGuess || it.rawTitle); });
  console.log(`\n[MATCH] items=${items.size} resolved=${resolved} (${items.size ? (100 * resolved / items.size).toFixed(1) : 0}%) unresolved=${unresolved} watchlistOnly=${wl}`);
  console.log(`  strategie: ${JSON.stringify(strat)}`);
  if (unresSample.length) console.log(`  irrisolti (sample): ${JSON.stringify(unresSample)}`);

  // ---- parse-error breakdown from source CSVs (if still present) ----
  const sp = x.storagePaths || {};
  if (x.source === "tvtime_gdpr" && sp.movies && sp.series) {
    const [mv, se] = await Promise.all([dl(sp.movies), dl(sp.series)]);
    if (mv || se) {
      const { rows, errors } = parseTvTimeGdprCsvs({ moviesCsv: mv, seriesCsv: se });
      const cat = {};
      for (const e of errors) { const k = (e.reason || "?").replace(/"[^"]*"/g, '"…"').replace(/:.*$/, ""); cat[k] = (cat[k] || 0) + 1; }
      console.log(`\n[PARSE] righe utili=${rows.length} scartate=${errors.length}`);
      for (const [k, n] of Object.entries(cat).sort((a, b) => b[1] - a[1])) console.log(`   ${n}× ${k}`);
      // rewatch-episode count
      const rw = (se.split(/\r?\n/).filter((l) => l.toLowerCase().startsWith("rewatch-episode")).length);
      if (rw) console.log(`   (di cui ${rw} righe rewatch-episode serie — non ancora importate, feature rewatch serie da fare)`);
    }
  }

  // ---- votes / emotions written ----
  const ratings = await db.collection("ratings").where("uid", "==", UID).get();
  const rBy = {}; let impR = 0;
  ratings.forEach((d) => { const r = d.data(); if ((r.source || "").startsWith("import_tvtime")) { impR++; const k = `${r.level}:${r.rating}`; rBy[k] = (rBy[k] || 0) + 1; } });
  console.log(`\n[VOTI] rating import_tvtime_gdpr=${impR} | ${JSON.stringify(rBy)} (tot rating utente ${ratings.size})`);
  const emo = await db.collection("titleEmotions").where("uid", "==", UID).get();
  const emoImp = emo.docs.filter((d) => (d.data().source || "") === "tvtime_import").length;
  console.log(`[EMOZIONI] titleEmotions (tvtime_import)=${emoImp} (tot ${emo.size})`);

  // ---- votes preview from source files (what SHOULD be there) ----
  if (x.source === "tvtime_gdpr") {
    const [epv, mvv, mvr] = await Promise.all([dl(sp.episodeVotes), dl(sp.movieVotes), dl(sp.movieRatings)]);
    if (epv) { const ep = R.parseTvTimeEpisodeVotesCsv(epv); const h = {}; ep.votes.forEach((v) => { h[v.decimalRating] = (h[v.decimalRating] || 0) + 1; }); console.log(`  [src] episode ratings file: ${ep.votes.length} (scale ${ep.scale}) decimals ${JSON.stringify(h)}`); }
    if (mvr) { const mr = R.parseTvTimeMovieRatingsCsv(mvr); const h = {}; mr.votes.forEach((v) => { h[v.decimalRating] = (h[v.decimalRating] || 0) + 1; }); console.log(`  [src] movie ratings file: ${mr.votes.length} (scale ${mr.scale}) decimals ${JSON.stringify(h)}`); }
    else console.log(`  [src] movie ratings file: ASSENTE (ratings-live-votes.csv non caricato → voti-stella film non importabili)`);
    if (mvv) { const em = R.parseTvTimeMovieEmotionsCsv(mvv); console.log(`  [src] movie emotions file: parsed ${em.emotions.length}, id-ignoti ${em.unrecognized}`); }
  }

  // ---- watched titles + user stats ----
  const tsc = await importRef.parent.parent.collection("titleStates").count().get().catch(() => null);
  console.log(`\n[LIBRERIA] titleStates=${tsc ? tsc.data().count : "n/a"}`);
  console.log(`[STATS] ${JSON.stringify(u.stats || {})}`);
  console.log(`\n========== FINE REPORT ==========\n`);
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
