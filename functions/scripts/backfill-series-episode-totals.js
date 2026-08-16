#!/usr/bin/env node
"use strict";
/**
 * backfill-series-episode-totals.js
 *
 * Arricchisce da TMDB la struttura stagioni/episodi (meta.seasons) delle serie
 * TV che ne sono prive, così il totale episodi diventa noto e le serie che un
 * utente ha VISTO PER INTERO possono passare da "in corso" a "terminate"
 * (con i minuti ricalcolati). Nasce dal caso TV Time (import che crea stub
 * leggeri senza episodi -> serie finite mostrate "in corso").
 *
 * Scope: solo i titoli referenziati da titleStates in stato `in_progress`
 * (sono quelli che cambiano i dati utente). NON tocca profili sintetici/guided.
 *
 * Idempotente: salta i titoli che hanno già un totale; ri-eseguibile.
 *
 *   cd functions && set -a; . ./.env; set +a
 *   NODE_PATH="$(pwd)/node_modules" GOOGLE_CLOUD_PROJECT=gia-visto \
 *     GOOGLE_APPLICATION_CREDENTIALS="$HOME/.config/gcloud/application_default_credentials.json" \
 *     node scripts/backfill-series-episode-totals.js            # dry-run
 *   ... node scripts/backfill-series-episode-totals.js --write   # applica
 */
const admin = require("firebase-admin");
const { buildNextTitleState, estimateTitleTotals } = require(`${__dirname}/../lib/titleStates`);

const WRITE = process.argv.includes("--write");
const TMDB_KEY = process.env.TMDB_KEY || process.env.TMDB_API_KEY;
if (!TMDB_KEY) { console.error("❌ TMDB_KEY mancante"); process.exit(1); }
admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmdbIdOf(titleId, data) {
  if (data?.meta?.tmdbId) return Number(data.meta.tmdbId);
  if (data?.tmdbId) return Number(data.tmdbId);
  const m = String(titleId).match(/^tmdb_tv_(\d+)$/);
  return m ? Number(m[1]) : null;
}
async function fetchTvSeasons(tmdbId, tries = 0) {
  const url = `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_KEY}&language=it-IT`;
  const res = await fetch(url);
  if (res.status === 429 && tries < 4) { await sleep(2000); return fetchTvSeasons(tmdbId, tries + 1); }
  if (!res.ok) return null;
  const j = await res.json();
  const seasons = (j.seasons || [])
    .filter((s) => Number(s.season_number) > 0 && Number(s.episode_count) > 0)
    .map((s) => ({ season: Number(s.season_number), episodes: Number(s.episode_count), air_date: s.air_date || null }));
  return seasons.length ? { seasons, seasonsCount: seasons.length } : null;
}

(async () => {
  console.log(WRITE ? "=== WRITE ===" : "=== DRY-RUN ===");

  // 1) raccogli tutti gli in_progress TV
  const snap = await db.collectionGroup("titleStates").get();
  const entries = [];
  snap.forEach((d) => {
    const m = d.data();
    const isTv = m.mediaType === "tv" || m.type === "tv" || !!m.seriesProgress;
    if (m.state !== "in_progress" || !isTv) return;
    entries.push({ ref: d.ref, uid: d.ref.parent.parent.id, titleId: d.id, watched: Number(m.seriesProgress?.episodesWatchedCount || 0), state: m });
  });
  console.log("in_progress TV titleStates:", entries.length);

  // escludi utenti sintetici/guided
  const uids = [...new Set(entries.map((e) => e.uid))];
  const userDocs = await db.getAll(...uids.map((u) => db.collection("users").doc(u)));
  const synthetic = new Set();
  userDocs.forEach((d) => { const u = d.data() || {}; if (u.isSynthetic === true || u.accountType === "guided_profile") synthetic.add(d.id); });
  const work = entries.filter((e) => !synthetic.has(e.uid));
  console.log("utenti:", uids.length, "| sintetici esclusi:", synthetic.size, "| titleStates da valutare:", work.length);

  // 2) titoli distinti -> arricchisci quelli senza totale
  const titleIds = [...new Set(work.map((e) => e.titleId))];
  const totalsByTitle = new Map();      // titleId -> total episodes
  let enriched = 0, hadTotal = 0, noTmdb = 0, tmdbFail = 0;
  for (let i = 0; i < titleIds.length; i += 1) {
    const titleId = titleIds[i];
    const doc = await db.collection("titles").doc(titleId).get();
    if (!doc.exists) { totalsByTitle.set(titleId, 0); continue; }
    const t = doc.data();
    let total = estimateTitleTotals({ ...t, id: titleId }).totalEpisodeCount;
    if (total > 0) { hadTotal++; totalsByTitle.set(titleId, total); continue; }
    const tmdbId = tmdbIdOf(titleId, t);
    if (!tmdbId) { noTmdb++; totalsByTitle.set(titleId, 0); continue; }
    const tv = await fetchTvSeasons(tmdbId);
    await sleep(260);
    if (!tv) { tmdbFail++; totalsByTitle.set(titleId, 0); continue; }
    enriched++;
    total = tv.seasons.reduce((a, s) => a + s.episodes, 0);
    totalsByTitle.set(titleId, total);
    if (WRITE) {
      await doc.ref.set({ meta: { seasons: tv.seasons, seasonsCount: tv.seasonsCount }, seriesEpisodesEnrichedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    }
    if ((i + 1) % 100 === 0) console.log(`  …titoli processati ${i + 1}/${titleIds.length}`);
  }
  console.log(`titoli: gia con totale ${hadTotal} | arricchiti da TMDB ${enriched} | senza tmdbId ${noTmdb} | tmdb fail ${tmdbFail}`);

  // 3) flip completamento dove visti >= totale
  let flipped = 0, minutesAdded = 0; const perUserFlips = {};
  for (const e of work) {
    const total = totalsByTitle.get(e.titleId) || 0;
    if (total <= 0 || e.watched < total) continue;
    const titleDoc = await db.collection("titles").doc(e.titleId).get();
    const title = { ...(titleDoc.data() || {}), id: e.titleId };
    const oldMin = Number(e.state.watchMinutesContribution || 0);
    const next = buildNextTitleState(e.state, { type: "mark_series_completed", source: e.state.source || "import_tvtime_gdpr" }, title, { now: new Date() });
    flipped++; perUserFlips[e.uid] = (perUserFlips[e.uid] || 0) + 1;
    minutesAdded += Math.max(0, Number(next.watchMinutesContribution || 0) - oldMin);
    if (WRITE) await e.ref.set(next, { merge: true });
  }
  console.log(`\nFLIP a completate: ${flipped} | minuti aggiunti stimati: ${minutesAdded} (~${Math.round(minutesAdded / 60)}h)`);
  console.log("flip per utente:", JSON.stringify(Object.entries(perUserFlips).sort((a, b) => b[1] - a[1]).slice(0, 12)));
})().catch((e) => { console.error("ERR", e); process.exit(1); });
