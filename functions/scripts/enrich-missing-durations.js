#!/usr/bin/env node
/**
 * enrich-missing-durations.js
 *
 * Forces a TMDB details refresh (in-process, no callable) for the titles
 * blocking watchMinutesContribution (74 "visti" titleStates stuck at 0 because
 * their title doc has no meta.durationEpisode / meta.durationMovie — see
 * functions/lib/tmdbDurations.js for the root cause + fallback).
 *
 * This does NOT call the `refreshTitleFromTmdb` HTTPS callable (that function
 * is tied to `context.auth`, a per-title Firestore lock/cooldown transaction,
 * and a callable rate limiter — none of which make sense for an offline batch
 * script). Instead it reuses the same shared fallback helper
 * (`resolveTvEpisodeRuntime`) and mirrors the TMDB resolve+fetch steps of
 * `buildTmdbTitleRefreshPatch` (functions/index.js), following the same
 * standalone-script pattern already used by scripts/backfill-title-metadata.js.
 *
 * Title selection:
 *   - default: unique titleIds from metadataIssues where kind ==
 *     "missing_watch_minutes" and status == "open" (the exact issues written
 *     by functions/index.js's buildMissingWatchMetricsIssue).
 *   - --all-tv: scan every `titles` doc with type == "tv" and no
 *     meta.durationEpisode (broader net, catches titles that never generated
 *     a metadataIssues doc, e.g. no one has a titleState for them yet).
 *
 * Respects `tmdbSync.syncDisabled` (manually-curated / merged titles are
 * skipped, exactly like refreshTitleFromTmdb and adminBackfillTitleMetadata).
 *
 * Usage:
 *   cd functions
 *   node scripts/enrich-missing-durations.js                  # dry-run (default)
 *   node scripts/enrich-missing-durations.js --write          # apply updates
 *   node scripts/enrich-missing-durations.js --all-tv         # broader scan
 *   node scripts/enrich-missing-durations.js --all-tv --write
 *   node scripts/enrich-missing-durations.js --limit 20
 *
 * Requires TMDB_KEY (or TMDB_API_KEY) env var.
 */

const admin = require("firebase-admin");
const { resolveTvEpisodeRuntime } = require("../lib/tmdbDurations");

const WRITE = process.argv.includes("--write");
const ALL_TV = process.argv.includes("--all-tv");
const LIMIT = getIntArg("--limit", 0);

const TMDB_KEY = process.env.TMDB_KEY || process.env.TMDB_API_KEY;
const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_MIN_GAP_MS = 240;
const TMDB_TITLE_REFRESH_INTERVAL_MS = 15 * 24 * 60 * 60 * 1000;

let tmdbLastReqAt = 0;

if (!TMDB_KEY) {
  console.error("ERRORE: TMDB_KEY mancante. Export TMDB_KEY=... prima di eseguire.");
  process.exit(1);
}

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

function getIntArg(flag, fallback = 0) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0 || idx === process.argv.length - 1) return fallback;
  const n = Number.parseInt(process.argv[idx + 1], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toPosInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const v = Math.round(n);
  return v > 0 ? v : 0;
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseYearFromDate(value) {
  const m = String(value || "").match(/^(\d{4})-/);
  if (!m) return null;
  const y = Number(m[1]);
  if (!Number.isFinite(y) || y < 1870 || y > 2100) return null;
  return y;
}

function mediaTypeOf(title) {
  return String(title?.type || title?.meta?.mediaType || "").toLowerCase() === "tv" ? "tv" : "movie";
}

// Mirrors resolveKnownTmdbTarget in functions/index.js.
function extractKnownTmdb(titleId, title) {
  const mediaType = mediaTypeOf(title);
  const topLevel = toPosInt(title?.tmdbId);
  if (topLevel) return { tmdbId: topLevel, mediaType, source: "title.tmdbId" };

  const metaLevel = toPosInt(title?.meta?.tmdbId);
  if (metaLevel) return { tmdbId: metaLevel, mediaType, source: "title.meta.tmdbId" };

  const m = String(titleId || "").match(/^tmdb_(movie|tv)_(\d+)$/i);
  if (m) return { tmdbId: toPosInt(m[2]), mediaType: m[1] === "tv" ? "tv" : "movie", source: "docId" };

  return null;
}

async function tmdbFetch(path, params = {}) {
  const now = Date.now();
  const wait = TMDB_MIN_GAP_MS - (now - tmdbLastReqAt);
  if (wait > 0) await sleep(wait);
  tmdbLastReqAt = Date.now();

  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set("api_key", TMDB_KEY);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === null || v === undefined || v === "") continue;
    url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString());
  if (res.status === 429) {
    await sleep(1200);
    return tmdbFetch(path, params);
  }
  if (!res.ok) {
    throw new Error(`TMDB ${res.status} ${path}`);
  }
  return res.json();
}

async function searchTmdbByName(query, mediaType) {
  const endpoint = mediaType === "tv" ? "/search/tv" : "/search/movie";
  const data = await tmdbFetch(endpoint, { query, language: "it-IT", include_adult: false, page: 1 });
  return Array.isArray(data?.results) ? data.results : [];
}

// Mirrors scoreTmdbSearchResult in functions/index.js.
function pickBestMatch(results, title) {
  if (!Array.isArray(results) || !results.length) return null;

  const mediaType = mediaTypeOf(title);
  const wanted = normalize(title?.name || "");
  const wantedYear = toPosInt(title?.year);

  const scored = results.map((r) => {
    const tmdbName = mediaType === "tv" ? String(r?.name || "") : String(r?.title || "");
    const tmdbOrig = mediaType === "tv" ? String(r?.original_name || "") : String(r?.original_title || "");
    const tmdbNorm = normalize(tmdbName);
    const tmdbOrigNorm = normalize(tmdbOrig);
    const dateStr = mediaType === "tv" ? r?.first_air_date : r?.release_date;
    const y = parseYearFromDate(dateStr);

    let score = 0;
    if (tmdbNorm && tmdbNorm === wanted) score += 100;
    else if (tmdbOrigNorm && tmdbOrigNorm === wanted) score += 92;
    else if (tmdbNorm && (tmdbNorm.includes(wanted) || wanted.includes(tmdbNorm))) score += 55;
    else if (tmdbOrigNorm && (tmdbOrigNorm.includes(wanted) || wanted.includes(tmdbOrigNorm))) score += 46;

    if (wantedYear && y) {
      if (wantedYear === y) score += 30;
      else if (Math.abs(wantedYear - y) === 1) score += 16;
    }

    score += Math.min(Number(r?.popularity || 0) / 100, 6);
    return { row: r, score };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < 40) return null;
  return best.row;
}

async function resolveTmdbTarget(titleId, title) {
  const known = extractKnownTmdb(titleId, title);
  if (known?.tmdbId) return known;

  const mediaType = mediaTypeOf(title);
  const queries = [title?.name, title?.originalName]
    .map((v) => String(v || "").trim())
    .filter(Boolean);

  const seen = new Set();
  for (const q of queries) {
    const key = normalize(q);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const results = await searchTmdbByName(q, mediaType);
    const best = pickBestMatch(results, title);
    if (best?.id) {
      return { tmdbId: toPosInt(best.id), mediaType, source: "search" };
    }
  }

  return null;
}

async function fetchTmdbDetails(tmdbId, mediaType, language = "it-IT") {
  const endpoint = mediaType === "tv" ? `/tv/${tmdbId}` : `/movie/${tmdbId}`;
  return tmdbFetch(endpoint, { language });
}

// --- Title selection -------------------------------------------------------

async function collectTitleIdsFromMetadataIssues() {
  const snap = await db.collection("metadataIssues")
    .where("kind", "==", "missing_watch_minutes")
    .where("status", "==", "open")
    .get();

  const ids = [];
  const seen = new Set();
  for (const docSnap of snap.docs) {
    const titleId = String(docSnap.data()?.titleId || "").trim();
    if (!titleId || seen.has(titleId)) continue;
    seen.add(titleId);
    ids.push(titleId);
  }
  return ids;
}

async function collectAllTvTitleIdsMissingDuration() {
  const snap = await db.collection("titles").where("type", "==", "tv").get();
  const ids = [];
  for (const docSnap of snap.docs) {
    const data = docSnap.data() || {};
    if (!toPosInt(data?.meta?.durationEpisode)) ids.push(docSnap.id);
  }
  return ids;
}

// --- Main --------------------------------------------------------------

async function main() {
  console.log(`\n=== ENRICH MISSING DURATIONS ===${WRITE ? " [WRITE]" : " [DRY-RUN]"}${ALL_TV ? " [ALL-TV SCAN]" : " [metadataIssues]"}`);
  if (!WRITE) console.log("Dry-run: nessuna modifica verra' scritta.\n");
  else console.log();

  let titleIds = ALL_TV
    ? await collectAllTvTitleIdsMissingDuration()
    : await collectTitleIdsFromMetadataIssues();

  if (LIMIT > 0) titleIds = titleIds.slice(0, LIMIT);

  console.log(`Titoli candidati: ${titleIds.length}${LIMIT > 0 ? ` (limit ${LIMIT})` : ""}\n`);

  const stats = {
    processed: 0,
    skippedSyncDisabled: 0,
    skippedNotFound: 0,
    unresolved: 0,
    alreadyHasDuration: 0,
    fixed: 0,
    stillMissing: 0,
    errors: 0,
    fixedBySource: { episode_run_time: 0, last_episode_to_air: 0, next_episode_to_air: 0 },
  };

  for (let i = 0; i < titleIds.length; i++) {
    const titleId = titleIds[i];
    const progress = `[${i + 1}/${titleIds.length}]`;

    try {
      const snap = await db.collection("titles").doc(titleId).get();
      if (!snap.exists) {
        stats.skippedNotFound++;
        console.log(`  ${progress} SKIP ${titleId} - doc non trovato`);
        continue;
      }
      const title = { id: titleId, ...(snap.data() || {}) };

      if (title?.tmdbSync?.syncDisabled === true) {
        stats.skippedSyncDisabled++;
        console.log(`  ${progress} SKIP ${title.name || titleId} - tmdbSync.syncDisabled`);
        continue;
      }

      const mediaType = mediaTypeOf(title);

      if (mediaType === "movie") {
        // Film: nessun fallback necessario, basta il runtime dei details TMDB
        // (mancava solo perche' il doc non e' mai passato da un refresh completo).
        if (toPosInt(title?.meta?.durationMovie) > 0) {
          stats.alreadyHasDuration++;
          console.log(`  ${progress} OK ${title.name || titleId} - durationMovie gia' presente`);
          continue;
        }
        stats.processed++;
        const movieTarget = await resolveTmdbTarget(titleId, title);
        if (!movieTarget?.tmdbId) {
          stats.unresolved++;
          console.log(`  ${progress} MISS ${title.name || titleId} - nessun match TMDB (movie)`);
          continue;
        }
        const movieDetails = await fetchTmdbDetails(movieTarget.tmdbId, "movie", "it-IT");
        const durationMovie = toPosInt(movieDetails?.runtime);
        if (!durationMovie) {
          stats.stillMissing++;
          console.log(`  ${progress} MISS ${title.name || titleId} - TMDB movie ${movieTarget.tmdbId} senza runtime`);
          continue;
        }
        stats.fixed++;
        stats.fixedBySource.movie_runtime = (stats.fixedBySource.movie_runtime || 0) + 1;
        console.log(`  ${progress} FIX ${title.name || titleId} -> durationMovie=${durationMovie} (tmdbId ${movieTarget.tmdbId})`);
        if (WRITE) {
          await db.collection("titles").doc(titleId).set({
            meta: { durationMovie },
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            tmdbSync: {
              ...(title.tmdbSync || {}),
              lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
              nextCheckAt: admin.firestore.Timestamp.fromMillis(Date.now() + TMDB_TITLE_REFRESH_INTERVAL_MS),
              lastStatus: "ok",
              lastTmdbId: movieTarget.tmdbId,
              lastMediaType: "movie",
              lastChangedFields: ["meta.durationMovie"],
              durationMovieFixAt: admin.firestore.FieldValue.serverTimestamp(),
            },
          }, { merge: true });
        }
        continue;
      }

      if (mediaType !== "tv") {
        stats.skippedNotFound++;
        console.log(`  ${progress} SKIP ${title.name || titleId} - media type sconosciuto`);
        continue;
      }

      if (toPosInt(title?.meta?.durationEpisode) > 0) {
        stats.alreadyHasDuration++;
        console.log(`  ${progress} OK ${title.name || titleId} - durationEpisode gia' presente`);
        continue;
      }

      stats.processed++;

      const target = await resolveTmdbTarget(titleId, title);
      if (!target?.tmdbId) {
        stats.unresolved++;
        console.log(`  ${progress} MISS ${title.name || titleId} - nessun match TMDB`);
        continue;
      }

      const detailsIt = await fetchTmdbDetails(target.tmdbId, "tv", "it-IT");
      const { value: durationEpisode, source } = resolveTvEpisodeRuntime(detailsIt);

      if (!durationEpisode) {
        stats.stillMissing++;
        console.log(`  ${progress} MISS ${title.name || titleId} - TMDB ${target.tmdbId} senza runtime (episode_run_time/last_episode_to_air/next_episode_to_air tutti vuoti)`);
        continue;
      }

      stats.fixed++;
      stats.fixedBySource[source] = (stats.fixedBySource[source] || 0) + 1;
      console.log(`  ${progress} FIX ${title.name || titleId} -> durationEpisode=${durationEpisode} (fonte: ${source}, tmdbId ${target.tmdbId})`);

      if (WRITE) {
        await db.collection("titles").doc(titleId).set({
          meta: { durationEpisode },
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          tmdbSync: {
            ...(title.tmdbSync || {}),
            lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
            nextCheckAt: admin.firestore.Timestamp.fromMillis(Date.now() + TMDB_TITLE_REFRESH_INTERVAL_MS),
            lastStatus: "ok",
            lastTmdbId: target.tmdbId,
            lastMediaType: "tv",
            lastChangedFields: ["meta.durationEpisode"],
            durationEpisodeFixSource: source,
            durationEpisodeFixAt: admin.firestore.FieldValue.serverTimestamp(),
          },
        }, { merge: true });
        // recomputeTitleStatesFromTitleMetrics (functions/index.js) picks up
        // this write via its onWrite(titles/{titleId}) trigger and repairs any
        // open metadataIssues for this title automatically once deployed.
      }
    } catch (err) {
      stats.errors++;
      console.log(`  ${progress} ERR ${titleId} - ${err?.message || err}`);
    }
  }

  console.log("\n" + "=".repeat(62));
  console.log("RIEPILOGO ENRICH MISSING DURATIONS");
  console.log("=".repeat(62));
  console.log(`Candidati:                       ${titleIds.length}`);
  console.log(`Processati (serie senza durata): ${stats.processed}`);
  console.log(`Gia' con durationEpisode:        ${stats.alreadyHasDuration}`);
  console.log(`Skip (syncDisabled):             ${stats.skippedSyncDisabled}`);
  console.log(`Skip (non trovato / non-TV):     ${stats.skippedNotFound}`);
  console.log(`Non risolti su TMDB:             ${stats.unresolved}`);
  console.log(`Ancora senza runtime su TMDB:    ${stats.stillMissing}`);
  console.log(`Fix trovati:                     ${stats.fixed}`);
  console.log(`  - da episode_run_time:         ${stats.fixedBySource.episode_run_time}`);
  console.log(`  - da last_episode_to_air:      ${stats.fixedBySource.last_episode_to_air}`);
  console.log(`  - da next_episode_to_air:      ${stats.fixedBySource.next_episode_to_air}`);
  console.log(`Errori:                          ${stats.errors}`);
  console.log(`\n${WRITE ? "Modifiche applicate." : "Dry-run: nessuna modifica salvata. Usa --write per applicare."}`);
  console.log("\n=== FINE ===");
}

main().catch((err) => {
  console.error("ERRORE FATALE:", err);
  process.exit(1);
});
