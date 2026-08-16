#!/usr/bin/env node
/**
 * enrich-user-watched-runtime.js
 *
 * Enrichment MIRATO del runtime per i titoli VISTI da un utente che sono
 * privi di durata (tipico degli stub creati da rematch-import-unresolved.js:
 * `/search/movie` NON restituisce `runtime`, solo `/movie/{id}`). Senza durata
 * un film conta 0 minuti. Questo script fa il fetch di dettaglio TMDB e scrive
 * `meta.durationMovie` (film) / `meta.durationEpisode` + struttura stagioni
 * (serie). Il trigger deployato `recomputeTitleStatesFromTitleMetrics` ricalcola
 * da solo i `watchMinutesContribution` (e quindi le ore) di CHIUNQUE ha visto
 * quei titoli.
 *
 * SICUREZZA: dry-run DEFAULT. --write per applicare. Richiede TMDB_KEY.
 *
 * Usage (da functions/):
 *   TMDB_KEY=... node scripts/enrich-user-watched-runtime.js --uid=UID           # dry-run
 *   TMDB_KEY=... node scripts/enrich-user-watched-runtime.js --uid=UID --write
 */
"use strict";
const https = require("https");
const admin = require("firebase-admin");
const { estimateTitleTotals } = require("../lib/titleStates");

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const g = (f) => { const h = args.find((a) => a.startsWith(`${f}=`)); return h ? h.slice(f.length + 1).trim() : ""; };
const UID = g("--uid");
const TMDB_KEY = (process.env.TMDB_KEY || process.env.TMDB_API_KEY || "").trim();
if (!UID) { console.error("Manca --uid=UID"); process.exit(1); }
if (!TMDB_KEY) { console.error("Manca TMDB_KEY (env)"); process.exit(1); }

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

const WATCHED = new Set(["seen_unrated", "rated", "completed_unrated", "completed", "in_progress"]);

function tmdbGet(path, params = {}) {
  const q = new URLSearchParams({ api_key: TMDB_KEY, language: "it-IT", ...params }).toString();
  return new Promise((resolve, reject) => {
    https.get(`https://api.themoviedb.org/3${path}?${q}`, (res) => {
      let data = ""; res.on("data", (c) => (data += c));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

function tmdbIdFromDoc(id, doc) {
  if (Number.isFinite(Number(doc.tmdbId))) return Number(doc.tmdbId);
  const m = String(id).match(/^tmdb_(movie|tv)_(\d+)$/);
  return m ? Number(m[2]) : null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`[enrich-runtime] uid=${UID} mode=${WRITE ? "WRITE" : "DRY-RUN"}`);
  const tsSnap = await db.collection("users").doc(UID).collection("titleStates").get();
  const watched = tsSnap.docs.filter((d) => WATCHED.has(d.data().state));
  const ids = [...new Set(watched.map((d) => d.id))];

  // find missing-runtime titles
  const targets = [];
  for (let i = 0; i < ids.length; i += 30) {
    const chunk = ids.slice(i, i + 30);
    // eslint-disable-next-line no-await-in-loop
    const snaps = await Promise.all(chunk.map((id) => db.collection("titles").doc(id).get()));
    for (const s of snaps) {
      if (!s.exists) continue;
      const doc = s.data();
      const tot = estimateTitleTotals(doc);
      const isTv = tot.mediaType === "tv";
      const missing = isTv ? !tot.durationEpisode : !tot.durationMovie;
      if (missing) targets.push({ id: s.id, doc, isTv, tmdbId: tmdbIdFromDoc(s.id, doc) });
    }
  }
  console.log(`  titoli visti senza durata: ${targets.length} (${targets.filter((t) => t.isTv).length} serie, ${targets.filter((t) => !t.isTv).length} film)`);
  const noTmdb = targets.filter((t) => !t.tmdbId);
  if (noTmdb.length) console.log(`  senza tmdbId (non enrichabili qui): ${noTmdb.length} -> ${JSON.stringify(noTmdb.slice(0, 5).map((t) => t.id))}`);

  let patched = 0, failed = 0;
  for (const t of targets) {
    if (!t.tmdbId) continue;
    // eslint-disable-next-line no-await-in-loop
    const det = await tmdbGet(`/${t.isTv ? "tv" : "movie"}/${t.tmdbId}`).catch(() => null);
    // eslint-disable-next-line no-await-in-loop
    await sleep(60);
    if (!det || det.success === false) { failed++; continue; }
    const metaPatch = {};
    if (t.isTv) {
      const dur = (Array.isArray(det.episode_run_time) && det.episode_run_time[0]) || det.last_episode_to_air?.runtime || 0;
      if (dur > 0) metaPatch.durationEpisode = Math.round(dur);
      if (Number.isFinite(det.number_of_seasons)) metaPatch.seasonsCount = det.number_of_seasons;
      const seasons = Array.isArray(det.seasons)
        ? det.seasons.filter((s) => s.season_number > 0).map((s) => ({ season: s.season_number, episodes: s.episode_count }))
        : [];
      if (seasons.length) metaPatch.seasons = seasons;
    } else {
      if (det.runtime > 0) metaPatch.durationMovie = Math.round(det.runtime);
    }
    if (Object.keys(metaPatch).length === 0) { failed++; continue; }
    if (WRITE) {
      // eslint-disable-next-line no-await-in-loop
      await db.collection("titles").doc(t.id).set({ meta: metaPatch, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    }
    patched++;
    if (patched <= 15) console.log(`  ${WRITE ? "PATCH" : "would-patch"} ${t.doc.name || t.id} -> ${JSON.stringify(metaPatch)}`);
  }
  console.log(`\n  ${WRITE ? "patchati" : "da patchare"}: ${patched} | falliti/senza-runtime-TMDB: ${failed}`);
  if (!WRITE) console.log("  DRY-RUN. Rilancia con --write. Il trigger recomputeTitleStatesFromTitleMetrics aggiorna i minuti da solo.");
  else console.log("  Fatto. I minuti si ricalcolano via trigger (attendi qualche minuto per la propagazione).");
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
