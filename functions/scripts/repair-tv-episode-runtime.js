#!/usr/bin/env node
//
// repair-tv-episode-runtime.js — ricalcola `meta.durationEpisode` delle serie
// TV dai runtime REALI dei singoli episodi TMDB.
//
// Perche': `resolveTvEpisodeRuntime` cadeva su `last_episode_to_air.runtime`
// quando TMDB non espone `episode_run_time` (~86% delle serie), cioe' prendeva
// UN episodio — quasi sempre il finale, che le serie moderne fanno lungo il
// doppio — e lo usava come durata media. Quel numero moltiplica ogni episodio
// visto in `computeWatchMinutesContribution`, quindi l'errore finisce dritto
// sulle ore viste del profilo. Misurato su 70 serie popolari del catalogo:
// 20 sbagliate oltre il 20% (Stranger Things 129' invece di 65', +45h sulla
// serie intera; Il Trono di Spade 80' invece di 58'; Friends 48' invece di 24').
//
// Il fix a monte e' in lib/tmdbDurations.js + i tre call site di
// buildTmdbTitleRefreshPatch in index.js: questo script serve solo a NON
// aspettare che il refresh notturno ripassi tutto il catalogo.
//
// DOPO questo script vanno ricalcolati i minuti gia' scritti sui titleStates:
//   node scripts/backfill-title-states-metrics.js --write
//
// Idempotente e riprendibile. Read-only finche' non passi --write.
//
// Uso:
//   cd functions
//   set -a && . ./.env.gia-visto && set +a
//   node scripts/repair-tv-episode-runtime.js                  # dry-run
//   node scripts/repair-tv-episode-runtime.js --write
//   node scripts/repair-tv-episode-runtime.js --threshold=0.10 --limit=200
"use strict";

const admin = require("firebase-admin");
const { collectAppendedSeasonRuntimes } = require("../lib/tmdbDurations");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() : fallback;
};
const WRITE = args.includes("--write");
// Sotto questa divergenza relativa non si tocca nulla: TMDB arrotonda, e
// riscrivere per un minuto di differenza sporca solo `updatedAt`.
const THRESHOLD = Number(flag("threshold", "0.15"));
const LIMIT = Number(flag("limit", "0")) || Infinity;
const CONCURRENCY = Number(flag("concurrency", "6"));
const START_AFTER = flag("start-after", "");
const TMDB_KEY = process.env.TMDB_KEY;
// TMDB accetta al massimo 20 `append_to_response` per richiesta.
const MAX_SEASONS = 20;
// Sotto questo campione la media non e' piu' affidabile del valore corrente.
const MIN_SAMPLES = 3;

if (!TMDB_KEY) {
  console.error("TMDB_KEY mancante nell'ambiente (usa: set -a && . ./.env.gia-visto && set +a).");
  process.exit(1);
}

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

const toPosInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

async function tmdbSeasonRuntimes(tmdbId, seasonNumbers) {
  const append = seasonNumbers.slice(0, MAX_SEASONS).map((n) => `season/${n}`).join(",");
  const url = `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_KEY}`
    + `&language=it-IT${append ? `&append_to_response=${append}` : ""}`;
  const res = await fetch(url);
  if (!res.ok) return { runtimes: [], status: res.status };
  const payload = await res.json();
  return { runtimes: collectAppendedSeasonRuntimes(payload), status: 200 };
}

async function run() {
  let query = db.collection("titles").where("type", "==", "tv").orderBy(admin.firestore.FieldPath.documentId());
  if (START_AFTER) query = query.startAfter(START_AFTER);

  const candidates = [];
  const PAGE = 500;
  let cursor = START_AFTER;
  for (;;) {
    let page = db.collection("titles").where("type", "==", "tv")
      .orderBy(admin.firestore.FieldPath.documentId()).limit(PAGE);
    if (cursor) page = page.startAfter(cursor);
    // eslint-disable-next-line no-await-in-loop
    const snap = await page.get();
    if (snap.empty) break;
    snap.forEach((doc) => {
      const data = doc.data() || {};
      const meta = data.meta || {};
      const tmdbId = toPosInt(meta.tmdbId);
      const stored = toPosInt(meta.durationEpisode);
      if (!tmdbId || !stored) return;
      const seasons = Array.isArray(meta.seasons)
        ? meta.seasons.map((s) => toPosInt(s.season)).filter((n) => n > 0).sort((a, b) => a - b)
        : [];
      if (!seasons.length) return;
      candidates.push({ id: doc.id, name: data.name || doc.id, tmdbId, stored, seasons });
    });
    cursor = snap.docs[snap.docs.length - 1].id;
    if (candidates.length >= LIMIT) break;
  }

  const targets = candidates.slice(0, LIMIT === Infinity ? candidates.length : LIMIT);
  console.log(`serie TV candidate: ${targets.length} (soglia divergenza ${(THRESHOLD * 100).toFixed(0)}%, modalita' ${WRITE ? "WRITE" : "DRY-RUN"})\n`);

  const stats = { checked: 0, noSamples: 0, ok: 0, fixed: 0, errors: 0 };
  const changes = [];
  let index = 0;

  async function worker() {
    for (;;) {
      const i = index;
      index += 1;
      if (i >= targets.length) return;
      const t = targets[i];
      try {
        // eslint-disable-next-line no-await-in-loop
        const { runtimes, status } = await tmdbSeasonRuntimes(t.tmdbId, t.seasons);
        stats.checked += 1;
        if (status !== 200) { stats.errors += 1; continue; }
        if (runtimes.length < MIN_SAMPLES) { stats.noSamples += 1; continue; }
        const real = Math.round(runtimes.reduce((a, n) => a + n, 0) / runtimes.length);
        if (!real) { stats.noSamples += 1; continue; }
        const delta = Math.abs(t.stored - real) / real;
        if (delta <= THRESHOLD) { stats.ok += 1; continue; }
        stats.fixed += 1;
        changes.push({ ...t, real, episodes: runtimes.length });
        if (WRITE) {
          // eslint-disable-next-line no-await-in-loop
          await db.collection("titles").doc(t.id).set({
            meta: { durationEpisode: real },
            tmdbSync: {
              durationEpisodeRepairedAt: admin.firestore.FieldValue.serverTimestamp(),
              durationEpisodeRepairedFrom: t.stored,
              durationEpisodeSource: "season_episodes",
            },
          }, { merge: true });
        }
      } catch (err) {
        stats.errors += 1;
        console.error(`  ERRORE ${t.name} (${t.id}): ${err?.message || err}`);
      }
      if (stats.checked % 250 === 0) console.log(`  ...${stats.checked}/${targets.length}`);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  changes.sort((a, b) => Math.abs(b.stored - b.real) - Math.abs(a.stored - a.real));
  console.log(`\nprime 40 correzioni (${changes.length} totali):`);
  changes.slice(0, 40).forEach((c) => {
    console.log(`  ${String(c.stored).padStart(4)}' -> ${String(c.real).padStart(4)}'  ${c.name} (${c.id}, ${c.episodes} episodi campionati)`);
  });
  console.log(`\ncontrollate ${stats.checked} · corrette ${stats.fixed} · gia' giuste ${stats.ok} · senza runtime episodi ${stats.noSamples} · errori ${stats.errors}`);
  if (!WRITE) console.log("\nDRY-RUN: nessuna scrittura. Rilancia con --write per applicare.");
  else console.log("\nOra ricalcola i minuti gia' scritti:\n  node scripts/backfill-title-states-metrics.js --write");
}

run().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
