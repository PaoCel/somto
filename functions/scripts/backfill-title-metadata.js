#!/usr/bin/env node
/**
 * backfill-title-metadata.js
 *
 * Audit + remediation for title consistency:
 * - fills missing descriptions from TMDB (it-IT, fallback en-US)
 * - fixes/materalizes TV seasons metadata used by season-rating UI:
 *   meta.seasons, meta.seasonsCount, meta.episodesPerSeason
 * - fills missing tmdbId/year when confidently available
 *
 * Usage:
 *   cd functions
 *   node scripts/backfill-title-metadata.js                 # dry-run (default)
 *   node scripts/backfill-title-metadata.js --write         # apply updates
 *   node scripts/backfill-title-metadata.js --write --limit 300
 *   node scripts/backfill-title-metadata.js --only-tv
 *
 * Notes:
 * - Requires TMDB_KEY (or TMDB_API_KEY) env var.
 * - Dry-run still performs TMDB lookups, but writes nothing.
 */

const admin = require("firebase-admin");

const WRITE = process.argv.includes("--write");
const ONLY_TV = process.argv.includes("--only-tv");
const LIMIT = getIntArg("--limit", 0);

const TMDB_KEY = process.env.TMDB_KEY || process.env.TMDB_API_KEY;
const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_MIN_GAP_MS = 240;
const MAX_BATCH_OPS = 450;

let tmdbLastReqAt = 0;

if (!TMDB_KEY) {
  console.error("ERROR: TMDB_KEY mancante. Export TMDB_KEY=... prima di eseguire.");
  process.exit(1);
}

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

class BatchWriter {
  constructor(dbRef) {
    this.db = dbRef;
    this.batch = dbRef.batch();
    this.ops = 0;
    this.totalOps = 0;
    this.totalCommits = 0;
  }

  async update(ref, payload) {
    this.batch.update(ref, payload);
    this.ops++;
    if (this.ops >= MAX_BATCH_OPS) {
      await this.flush();
    }
  }

  async flush() {
    if (this.ops === 0) return;
    if (WRITE) {
      await this.batch.commit();
    }
    this.totalOps += this.ops;
    this.totalCommits++;
    this.batch = this.db.batch();
    this.ops = 0;
  }
}

function getIntArg(flag, fallback = 0) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0 || idx === process.argv.length - 1) return fallback;
  const n = Number.parseInt(process.argv[idx + 1], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasText(value) {
  return String(value || "").trim().length > 0;
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

function titleYear(title) {
  const y = toPosInt(title?.year);
  return y || null;
}

function mediaTypeOf(title) {
  return String(title?.type || "").toLowerCase() === "tv" ? "tv" : "movie";
}

function normalizeSeasons(rows) {
  if (!Array.isArray(rows)) return [];
  const bySeason = new Map();
  rows.forEach((row) => {
    const sn = toPosInt(row?.season ?? row?.season_number);
    if (!sn) return;
    const eps = toPosInt(row?.episodes ?? row?.episode_count);
    bySeason.set(sn, { season: sn, episodes: eps });
  });
  return Array.from(bySeason.values()).sort((a, b) => a.season - b.season);
}

function sameSeasons(a, b) {
  const x = normalizeSeasons(a);
  const y = normalizeSeasons(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i += 1) {
    if (x[i].season !== y[i].season || x[i].episodes !== y[i].episodes) return false;
  }
  return true;
}

function uniformEpisodes(seasons) {
  const rows = normalizeSeasons(seasons).filter((s) => toPosInt(s.episodes) > 0);
  if (!rows.length) return 0;
  const first = rows[0].episodes;
  return rows.every((s) => s.episodes === first) ? first : 0;
}

function materializeUniformSeasons(seasonsCount, episodesPerSeason) {
  const sc = toPosInt(seasonsCount);
  const eps = toPosInt(episodesPerSeason);
  if (!sc || !eps) return [];
  return Array.from({ length: sc }, (_, i) => ({ season: i + 1, episodes: eps }));
}

function hasRenderableTvSeasons(meta) {
  const seasons = normalizeSeasons(meta?.seasons);
  if (seasons.length && seasons.every((s) => toPosInt(s.episodes) > 0)) return true;
  return toPosInt(meta?.seasonsCount) > 0 && toPosInt(meta?.episodesPerSeason) > 0;
}

function needsTvMetadataFix(meta) {
  const seasons = normalizeSeasons(meta?.seasons);
  if (!seasons.length) {
    return !(toPosInt(meta?.seasonsCount) > 0 && toPosInt(meta?.episodesPerSeason) > 0);
  }
  if (seasons.some((s) => toPosInt(s.episodes) === 0)) return true;
  if (toPosInt(meta?.seasonsCount) === 0) return true;
  return false;
}

function cloneMeta(meta) {
  if (!meta || typeof meta !== "object") return {};
  try {
    return JSON.parse(JSON.stringify(meta));
  } catch (_) {
    return { ...meta };
  }
}

function normalizeTvMetaLocal(meta) {
  const next = cloneMeta(meta);
  const beforeSeasons = next.seasons;
  const normalized = normalizeSeasons(beforeSeasons);
  if (!sameSeasons(beforeSeasons, normalized)) {
    next.seasons = normalized;
  }

  const sc = toPosInt(next.seasonsCount);
  const eps = toPosInt(next.episodesPerSeason);

  if (normalized.length && sc !== normalized.length) {
    next.seasonsCount = normalized.length;
  }

  const uniform = uniformEpisodes(normalized);
  if (uniform && eps !== uniform) {
    next.episodesPerSeason = uniform;
  }

  if (!normalized.length && sc && eps) {
    next.seasons = materializeUniformSeasons(sc, eps);
  }

  return next;
}

function applyTvDetailsToMeta(meta, details) {
  const next = cloneMeta(meta);
  const tmdbSeasons = normalizeSeasons(
    Array.isArray(details?.seasons)
      ? details.seasons
        .filter((s) => toPosInt(s?.season_number) > 0)
        .map((s) => ({ season: s.season_number, episodes: s.episode_count || 0 }))
      : []
  );

  if (tmdbSeasons.length) {
    next.seasons = tmdbSeasons;
    next.seasonsCount = tmdbSeasons.length;
    const uniform = uniformEpisodes(tmdbSeasons);
    if (uniform > 0) {
      next.episodesPerSeason = uniform;
    }
  } else {
    const ns = toPosInt(details?.number_of_seasons);
    const ne = toPosInt(details?.number_of_episodes);
    if (ns && !toPosInt(next.seasonsCount)) next.seasonsCount = ns;
    if (ns && ne && ne % ns === 0) {
      const eps = Math.round(ne / ns);
      if (eps > 0) {
        if (!toPosInt(next.episodesPerSeason)) next.episodesPerSeason = eps;
        if (!normalizeSeasons(next.seasons).length) {
          next.seasons = materializeUniformSeasons(ns, eps);
        }
      }
    }
  }

  const epRuntime = toPosInt(
    Array.isArray(details?.episode_run_time)
      ? details.episode_run_time[0]
      : details?.episode_run_time
  );
  if (epRuntime && !toPosInt(next.durationEpisode)) {
    next.durationEpisode = epRuntime;
  }

  return next;
}

function applyMovieDetailsToMeta(meta, details) {
  const next = cloneMeta(meta);
  const runtime = toPosInt(details?.runtime);
  if (runtime && !toPosInt(next.durationMovie)) {
    next.durationMovie = runtime;
  }
  return next;
}

function extractKnownTmdb(title) {
  const top = toPosInt(title?.tmdbId);
  if (top) return { tmdbId: top, mediaType: mediaTypeOf(title), source: "title.tmdbId" };

  const meta = toPosInt(title?.meta?.tmdbId);
  if (meta) return { tmdbId: meta, mediaType: mediaTypeOf(title), source: "title.meta.tmdbId" };

  const m = String(title?.id || "").match(/^tmdb_(movie|tv)_(\d+)$/i);
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

function pickBestMatch(results, title) {
  if (!Array.isArray(results) || !results.length) return null;

  const mediaType = mediaTypeOf(title);
  const wanted = normalize(title?.name || "");
  const wantedYear = titleYear(title);

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
    return { row: r, score, y };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < 40) return null;
  return best.row;
}

async function resolveTmdbTarget(title) {
  const known = extractKnownTmdb(title);
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

function auditSummary(titles) {
  const summary = {
    totalTitles: titles.length,
    tvTitles: 0,
    missingDescription: 0,
    tvMissingSeasonsRenderable: 0,
    tvMissingTmdbId: 0,
  };

  for (const t of titles) {
    const isTv = mediaTypeOf(t) === "tv";
    if (isTv) summary.tvTitles++;
    if (!hasText(t?.description)) summary.missingDescription++;
    if (isTv) {
      if (!hasRenderableTvSeasons(t?.meta || {})) summary.tvMissingSeasonsRenderable++;
      if (!extractKnownTmdb(t)?.tmdbId) summary.tvMissingTmdbId++;
    }
  }

  return summary;
}

function shouldProcessTitle(t) {
  const isTv = mediaTypeOf(t) === "tv";
  const missingDesc = !hasText(t?.description);
  const needsTvFix = isTv && needsTvMetadataFix(t?.meta || {});
  if (ONLY_TV) return isTv && (needsTvFix || missingDesc);
  return missingDesc || needsTvFix;
}

function printAudit(summary) {
  console.log("\n" + "=".repeat(62));
  console.log("AUDIT TITOLI");
  console.log("=".repeat(62));
  console.log(`Titoli totali:                    ${summary.totalTitles}`);
  console.log(`Serie TV totali:                  ${summary.tvTitles}`);
  console.log(`Titoli senza description:         ${summary.missingDescription}`);
  console.log(`Serie TV senza stagioni render:   ${summary.tvMissingSeasonsRenderable}`);
  console.log(`Serie TV senza tmdbId noto:       ${summary.tvMissingTmdbId}`);
  console.log("=".repeat(62) + "\n");
}

async function main() {
  console.log(`\n=== BACKFILL TITLE METADATA ===${WRITE ? " [WRITE]" : " [DRY-RUN]"}${ONLY_TV ? " [ONLY TV]" : ""}`);
  if (!WRITE) {
    console.log("Dry-run mode: nessuna modifica verra scritta.\n");
  } else {
    console.log();
  }

  const snap = await db.collection("titles").get();
  const titles = snap.docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() }));
  const summary = auditSummary(titles);
  printAudit(summary);

  let work = titles.filter(shouldProcessTitle);
  if (LIMIT > 0) work = work.slice(0, LIMIT);

  console.log(`Titoli candidati al fix: ${work.length}${LIMIT > 0 ? ` (limit ${LIMIT})` : ""}\n`);

  const writer = new BatchWriter(db);
  const stats = {
    processed: 0,
    updated: 0,
    localOnlyFixes: 0,
    tmdbLookups: 0,
    tmdbResolved: 0,
    tmdbUnresolved: 0,
    tmdbDetailCalls: 0,
    descriptionFilled: 0,
    tvSeasonsFixed: 0,
    yearFilled: 0,
    tmdbIdFilled: 0,
    errors: 0,
  };
  const unresolved = [];

  for (let i = 0; i < work.length; i++) {
    const t = work[i];
    const progress = `[${i + 1}/${work.length}]`;
    const isTv = mediaTypeOf(t) === "tv";

    try {
      stats.processed++;

      const originalMeta = cloneMeta(t.meta || {});
      let nextMeta = cloneMeta(t.meta || {});
      const originalDesc = String(t.description || "");
      let nextDesc = originalDesc;
      let nextYear = toPosInt(t.year) || null;

      // Local-only normalization first (no TMDB call)
      if (isTv) {
        nextMeta = normalizeTvMetaLocal(nextMeta);
      }

      let needRemoteTv = isTv && needsTvMetadataFix(nextMeta);
      let needRemoteDesc = !hasText(nextDesc);
      if (ONLY_TV && !isTv) needRemoteDesc = false;
      const needRemoteYear = !nextYear;
      const wantsRemote = needRemoteTv || needRemoteDesc || needRemoteYear;

      let resolved = extractKnownTmdb(t);
      if (wantsRemote) {
        stats.tmdbLookups++;
        if (!resolved?.tmdbId) {
          resolved = await resolveTmdbTarget(t);
        }
      }

      let usedRemote = false;
      if (wantsRemote && resolved?.tmdbId) {
        stats.tmdbResolved++;
        const detailsIt = await fetchTmdbDetails(resolved.tmdbId, resolved.mediaType, "it-IT");
        stats.tmdbDetailCalls++;
        usedRemote = true;

        if (isTv) {
          nextMeta = applyTvDetailsToMeta(nextMeta, detailsIt);
        } else {
          nextMeta = applyMovieDetailsToMeta(nextMeta, detailsIt);
        }

        if (!nextYear) {
          const dateValue = resolved.mediaType === "tv" ? detailsIt?.first_air_date : detailsIt?.release_date;
          nextYear = parseYearFromDate(dateValue) || null;
        }

        if (!hasText(nextDesc)) {
          let overview = String(detailsIt?.overview || "").trim();
          if (!overview) {
            const detailsEn = await fetchTmdbDetails(resolved.tmdbId, resolved.mediaType, "en-US");
            stats.tmdbDetailCalls++;
            overview = String(detailsEn?.overview || "").trim();
          }
          if (overview) nextDesc = overview;
        }
      } else if (wantsRemote && !resolved?.tmdbId) {
        stats.tmdbUnresolved++;
        unresolved.push({ id: t.id, name: t.name, type: t.type, reason: "no_tmdb_match" });
      }

      const metaChanged = JSON.stringify(originalMeta) !== JSON.stringify(nextMeta);
      const descChanged = !hasText(originalDesc) && hasText(nextDesc);
      const yearChanged = !toPosInt(t.year) && toPosInt(nextYear);
      const tmdbIdChanged = !toPosInt(t.tmdbId) && toPosInt(resolved?.tmdbId);

      if (!metaChanged && !descChanged && !yearChanged && !tmdbIdChanged) {
        continue;
      }

      const update = {
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (metaChanged) update.meta = nextMeta;
      if (descChanged) update.description = nextDesc;
      if (yearChanged) update.year = nextYear;
      if (tmdbIdChanged) update.tmdbId = toPosInt(resolved.tmdbId);

      await writer.update(t.ref, update);
      stats.updated++;

      if (metaChanged && isTv) stats.tvSeasonsFixed++;
      if (descChanged) stats.descriptionFilled++;
      if (yearChanged) stats.yearFilled++;
      if (tmdbIdChanged) stats.tmdbIdFilled++;
      if (!usedRemote) stats.localOnlyFixes++;

      const tags = [];
      if (metaChanged && isTv) tags.push("tv-meta");
      if (descChanged) tags.push("desc");
      if (yearChanged) tags.push("year");
      if (tmdbIdChanged) tags.push("tmdbId");
      console.log(`  ${progress} OK ${t.name} [${tags.join(", ")}]`);
    } catch (err) {
      stats.errors++;
      unresolved.push({
        id: t.id,
        name: t.name,
        type: t.type,
        reason: String(err?.message || err),
      });
      console.log(`  ${progress} ERR ${t.name} - ${err?.message || err}`);
    }
  }

  await writer.flush();

  console.log("\n" + "=".repeat(62));
  console.log("RIEPILOGO BACKFILL");
  console.log("=".repeat(62));
  console.log(`Processati:                      ${stats.processed}`);
  console.log(`Aggiornati:                      ${stats.updated}`);
  console.log(`Fix solo locali (no TMDB):       ${stats.localOnlyFixes}`);
  console.log(`Lookup TMDB:                     ${stats.tmdbLookups}`);
  console.log(`TMDB risolti:                    ${stats.tmdbResolved}`);
  console.log(`TMDB non risolti:                ${stats.tmdbUnresolved}`);
  console.log(`Chiamate dettagli TMDB:          ${stats.tmdbDetailCalls}`);
  console.log(`Description riempite:            ${stats.descriptionFilled}`);
  console.log(`Meta stagioni TV corretto:       ${stats.tvSeasonsFixed}`);
  console.log(`Anno riempito:                   ${stats.yearFilled}`);
  console.log(`tmdbId riempito:                 ${stats.tmdbIdFilled}`);
  console.log(`Errori:                          ${stats.errors}`);
  console.log(`Batch flush:                     ${writer.totalCommits}`);
  console.log(`Operazioni batch:                ${writer.totalOps}`);
  console.log(`\n${WRITE ? "Modifiche applicate." : "Dry-run: nessuna modifica salvata."}`);

  if (unresolved.length) {
    console.log(`\nNon risolti / errori (sample ${Math.min(20, unresolved.length)} su ${unresolved.length}):`);
    unresolved.slice(0, 20).forEach((u) => {
      console.log(`  - ${u.name} [${u.id}] (${u.type}) -> ${u.reason}`);
    });
  }

  console.log("\n=== FINE BACKFILL ===");
}

main().catch((err) => {
  console.error("ERRORE FATALE:", err);
  process.exit(1);
});
