"use strict";

// TV Time GDPR export adapter — parses the 2 relevant CSVs from the "Request
// your data" ZIP export (TV Time shuts down 2026-07-15) into the SAME
// NormalizedRow[] intermediate shape produced by netflixCsv.js, plus a small
// set of OPTIONAL extra fields the format uniquely provides (tvdbSeriesId,
// releaseYear, runtimeMinutes, rewatchCount, watchlistOnly). This module is a
// PURE parser: no Firestore, no TMDB, no I/O. Matching/writing happen
// downstream.
//
// The export ZIP contains ~20 CSVs; ONLY 2 are viewing-history data:
//   - tracking-prod-records.csv     (v1, MOVIES: watch + follow/towatch rows)
//   - tracking-prod-records-v2.csv  (v2, SERIES: user-series + watch-episode rows)
// Every other CSV (user.csv, ip_address.csv, auth-prod-login.csv,
// lists-prod-lists.csv, ratings-*/emotions-*/comments-*.csv,
// where-to-watch-*.csv, ...) is either PII or out of scope for this parser
// (custom lists, emoji reactions, comments — see docs/... for the decision
// not to import them) and MUST NEVER be parsed by this module.
//
// IMPORTANT — the export's CSV header is a raw DynamoDB dump: column ORDER
// and even the exact SET of columns present varies between export snapshots
// (observed firsthand: 2 real exports had `type`/`movie_name`/`rewatch_count`
// etc. in completely different positions, and the second export had a
// `rewatch_count` column the first one didn't surface). This parser MUST
// ALWAYS resolve columns by header NAME (`header.indexOf(...)`), never by
// positional index — every column lookup below goes through `idx.<field>`
// built from the actual header row.
//
// NormalizedRow (shared shape, see netflixCsv.js header for the base fields):
//   {
//     rawTitle, kind: "movie" | "tv_episode",
//     seriesNameGuess, movieNameGuess, seasonNumber, episodeNumber,
//     episodeNameGuess: null (TV Time gives explicit season/episode numbers,
//       never a name-only episode — kept for shape parity with netflixCsv),
//     watchedDate: Date,
//     // --- TV Time-only extras (optional, undefined/null when not applicable) ---
//     tvdbSeriesId: number | null,   // from `s_id` — TheTVDB numeric id
//     releaseYear: number | null,    // from movie `release_date` (v1 only)
//     runtimeMinutes: number | null, // from `runtime` (seconds), rounded
//     rewatchCount: number | null,   // from movie `rewatch_count` (v1 only;
//       absent in some export snapshots — column may not exist at all)
//     watchlistOnly: true | undefined, // follow/towatch/is_for_later, NOT watched
//   }
//
// Malformed/unrecognized rows produce an entry in `errors` (never a silent
// skip) UNLESS they are a known aggregate/meta row we deliberately ignore
// (count-watch-movie, time-count, tracking-stats) — those are expected noise
// in a DynamoDB dump, not user data, so they're silently dropped without
// inflating the error list users would see.

const { parseCsv } = require("./csv");

function safeString(value, maxLen = 500) {
  return String(value ?? "").trim().slice(0, maxLen);
}

function toNullableInt(value) {
  const n = Number(String(value ?? "").trim());
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toPositiveIntOrNull(value) {
  const n = toNullableInt(value);
  return n != null && n > 0 ? n : null;
}

// TV Time timestamps: "YYYY-MM-DD HH:MM:SS" (UTC-ish, no offset in the
// export). We only care about the calendar day for watchedDate bookkeeping
// (parity with the rest of the import pipeline, which works at day
// granularity) — parsed as noon UTC of that day to avoid a timezone-induced
// off-by-one when later rendered.
function parseTvTimeDateTime(raw) {
  const trimmed = safeString(raw, 32);
  const m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return d;
}

// Movie `release_date` (v1 CSV) -> 4-digit year, used both as a NormalizedRow
// extra (releaseYear) and to disambiguate the TMDB search downstream.
function parseYearFromDateString(raw) {
  const trimmed = safeString(raw, 32);
  const m = trimmed.match(/^(\d{4})-\d{2}-\d{2}/);
  if (!m) return null;
  const year = Number(m[1]);
  return year >= 1870 && year <= 2100 ? year : null;
}

// `runtime` columns are in SECONDS in both CSVs. Rounds to the nearest
// minute; returns null (not 0) when absent so callers can distinguish
// "unknown" from "zero-length".
function secondsToMinutes(raw) {
  const seconds = toNullableInt(raw);
  if (seconds == null || seconds <= 0) return null;
  return Math.round(seconds / 60);
}

/* ============================= v1: movies ============================= */
// tracking-prod-records.csv columns (sparse DynamoDB dump; header is
// authoritative, column ORDER is not to be assumed beyond looking up by
// name): user_id, type-uuid-n, watch_count, watches, type, uuid, updated_at,
// alpha_range_key, movie_name, release_date_range_key, follow_date_range_key,
// release_date, runtime, created_at, entity_type, total_movies_runtime,
// country, watch_date_range_key.
//
// Rows that matter: `type` == "watch" (seen) or "follow" (watchlist-only).
// Rows to ignore (not per-viewing data): `type` in
// {"count-watch-movie", "time-count"} — user-level aggregates, no title info.

const V1_IGNORED_TYPES = new Set(["count-watch-movie", "time-count"]);

function parseTvTimeMoviesCsv(rawText) {
  const rows = [];
  const errors = [];
  const table = parseCsv(rawText);

  if (table.length === 0) {
    return { rows, errors: [{ line: 0, rawTitle: "", reason: "File CSV film vuoto." }] };
  }

  const header = table[0].map((h) => safeString(h, 60).toLowerCase());
  const col = (name) => header.indexOf(name);
  const idx = {
    typeUuidN: col("type-uuid-n"),
    type: col("type"),
    movieName: col("movie_name"),
    releaseDate: col("release_date"),
    runtime: col("runtime"),
    createdAt: col("created_at"),
    rewatchCount: col("rewatch_count"),
    uuid: col("uuid"),
  };

  if (idx.type === -1 || idx.movieName === -1) {
    return {
      rows,
      errors: [{ line: 1, rawTitle: "", reason: "Header CSV film inatteso (attese colonne type,movie_name,...)." }],
    };
  }

  for (let i = 1; i < table.length; i += 1) {
    const line = i + 1;
    const record = table[i];
    if (!record || record.length === 0) continue;

    // Aggregate/meta rows (count-watch-movie, time-count) carry their kind in
    // the composite `type-uuid-n` key, NOT in `type` (which is empty for
    // them) — this is a raw DynamoDB dump, `type-uuid-n` is effectively the
    // sort key. Check it first so these never fall through to "unrecognized".
    const typeUuidN = idx.typeUuidN !== -1 ? safeString(record[idx.typeUuidN], 60).toLowerCase() : "";
    if (V1_IGNORED_TYPES.has(typeUuidN)) continue; // expected aggregate noise, not an error

    const type = safeString(record[idx.type], 40).toLowerCase();
    if (V1_IGNORED_TYPES.has(type)) continue; // belt-and-suspenders: same check on `type` if ever populated

    // "follow" and "towatch" are both watchlist-only markers seen in the
    // wild across different export snapshots (TV Time appears to have
    // renamed/aliased this row kind at some point) — both mean the same
    // thing: no watch signal, just "want to watch".
    const isWatchlistMarker = type === "follow" || type === "towatch";
    if (type !== "watch" && !isWatchlistMarker) {
      // Unknown row kind in a sparse dump: could be a future TV Time export
      // variant. Surface it rather than silently dropping potential data.
      errors.push({ line, rawTitle: safeString(record[idx.movieName], 500), reason: `Tipo riga film non riconosciuto: "${type}".` });
      continue;
    }

    const rawTitle = safeString(record[idx.movieName], 500);
    if (!rawTitle) {
      errors.push({ line, rawTitle: "", reason: "Nome film mancante." });
      continue;
    }

    const dateRaw = idx.createdAt !== -1 ? record[idx.createdAt] : "";
    const watchedDate = parseTvTimeDateTime(dateRaw);
    if (!watchedDate) {
      errors.push({ line, rawTitle, reason: `Data non valida: "${safeString(dateRaw, 32)}".` });
      continue;
    }

    const releaseYear = idx.releaseDate !== -1 ? parseYearFromDateString(record[idx.releaseDate]) : null;
    const runtimeMinutes = idx.runtime !== -1 ? secondsToMinutes(record[idx.runtime]) : null;
    const rewatchCount = idx.rewatchCount !== -1 ? toPositiveIntOrNull(record[idx.rewatchCount]) : null;

    rows.push({
      rawTitle,
      kind: "movie",
      seriesNameGuess: null,
      movieNameGuess: rawTitle,
      seasonNumber: null,
      episodeNumber: null,
      episodeNameGuess: null,
      watchedDate,
      tvdbSeriesId: null,
      releaseYear,
      runtimeMinutes,
      rewatchCount, // null when absent/0 — see toPositiveIntOrNull
      tvtimeUuid: idx.uuid !== -1 ? (safeString(record[idx.uuid], 80) || null) : null,
      ...(isWatchlistMarker ? { watchlistOnly: true } : {}),
    });
  }

  return { rows, errors };
}

/* ============================= v2: series ============================= */
// tracking-prod-records-v2.csv columns: key, updated_at, user_id,
// series_follow_count, ep_watch_count, created_at, movie_watch_count,
// total_movies_runtime, total_series_runtime, is_followed, s_id, followed_at,
// uuid, is_for_later, is_archived, series_name, most_recent_ep_watched,
// runtime, is_unitary, ep_id, episode_id, gsi, season_number, s_no, ep_no,
// episode_number.
//
// Two row shapes matter, distinguished by `key`:
//   - `user-series-{uuid}`         -> a FOLLOWED series (may be watchlist-only
//                                     via is_for_later OR when no sibling
//                                     watch-episode rows exist; may be
//                                     in-progress — the actual watched
//                                     episodes come from the sibling
//                                     watch-episode rows, NOT from this row's
//                                     `most_recent_ep_watched`, which is a Go
//                                     %v dump like
//                                     "map[ep_id:... s_no:1 ...]" — NOT JSON,
//                                     deliberately ignored).
//   - `watch-episode-{sUuid}-{epUuid}` -> one watched episode, with EXPLICIT
//                                     season_number/s_no + ep_no/episode_number
//                                     (both column names appear to alias the
//                                     same value in the dump; prefer the
//                                     longer name, fall back to the short one).
// Ignored: `key == "tracking-stats"` (user-level aggregate, no title info).

function seriesRowKind(key) {
  if (key === "tracking-stats") return "ignore";
  if (/^user-series-/.test(key)) return "series_follow";
  if (/^watch-episode-/.test(key)) return "episode_watch";
  return "unknown";
}

function firstNonEmpty(record, indices) {
  for (const idx of indices) {
    if (idx === -1) continue;
    const v = safeString(record[idx], 500);
    if (v) return v;
  }
  return "";
}

function parseTvTimeSeriesCsv(rawText) {
  const rows = [];
  const errors = [];
  const extraEpisodes = [];
  const table = parseCsv(rawText);

  if (table.length === 0) {
    return { rows, extraEpisodes, errors: [{ line: 0, rawTitle: "", reason: "File CSV serie vuoto." }] };
  }

  const header = table[0].map((h) => safeString(h, 60).toLowerCase());
  const col = (name) => header.indexOf(name);
  const idx = {
    key: col("key"),
    createdAt: col("created_at"),
    sId: col("s_id"),
    isFollowed: col("is_followed"),
    isForLater: col("is_for_later"),
    seriesName: col("series_name"),
    runtime: col("runtime"),
    seasonNumber: col("season_number"),
    sNo: col("s_no"),
    epNo: col("ep_no"),
    episodeNumber: col("episode_number"),
    epId: col("ep_id"),
  };

  if (idx.key === -1 || idx.seriesName === -1) {
    return {
      rows,
      extraEpisodes,
      errors: [{ line: 1, rawTitle: "", reason: "Header CSV serie inatteso (attese colonne key,series_name,...)." }],
    };
  }

  const watchedSeriesIds = new Set();
  for (let i = 1; i < table.length; i += 1) {
    const record = table[i];
    if (!record || record.length === 0) continue;
    const key = safeString(record[idx.key], 200);
    if (seriesRowKind(key) !== "episode_watch") continue;
    const tvdbSeriesId = idx.sId !== -1 ? toPositiveIntOrNull(record[idx.sId]) : null;
    if (tvdbSeriesId != null) watchedSeriesIds.add(tvdbSeriesId);
  }

  for (let i = 1; i < table.length; i += 1) {
    const line = i + 1;
    const record = table[i];
    if (!record || record.length === 0) continue;

    const key = safeString(record[idx.key], 200);
    const rowKind = seriesRowKind(key);
    if (rowKind === "ignore") continue; // tracking-stats: expected aggregate noise

    if (rowKind === "unknown") {
      errors.push({ line, rawTitle: safeString(record[idx.seriesName], 500), reason: `Riga serie non riconosciuta: "${key}".` });
      continue;
    }

    const seriesName = safeString(record[idx.seriesName], 500);
    const tvdbSeriesId = idx.sId !== -1 ? toPositiveIntOrNull(record[idx.sId]) : null;

    if (rowKind === "series_follow") {
      const isForLater = safeString(record[idx.isForLater], 10).toLowerCase() === "true";
      const isFollowed = idx.isFollowed !== -1
        ? safeString(record[idx.isFollowed], 10).toLowerCase() === "true"
        : false;
      const hasWatchedEpisodes = tvdbSeriesId != null && watchedSeriesIds.has(tvdbSeriesId);
      if (!isForLater && (!isFollowed || hasWatchedEpisodes)) {
        // Followed series with watched episodes are represented by sibling
        // watch-episode rows below. A followed series with NO watched episode
        // rows is safer as watchlist-only than silently dropped: users can
        // remove a false-positive "to watch", but they cannot recover a row
        // we never persisted.
        continue;
      }
      const rawTitle = seriesName || (tvdbSeriesId != null ? `TVDB Series ${tvdbSeriesId}` : "");
      if (!rawTitle) {
        errors.push({ line, rawTitle: "", reason: "Nome serie mancante (riga follow senza s_id)." });
        continue;
      }
      const dateRaw = idx.createdAt !== -1 ? record[idx.createdAt] : "";
      const watchedDate = parseTvTimeDateTime(dateRaw);
      if (!watchedDate) {
        errors.push({ line, rawTitle, reason: `Data non valida: "${safeString(dateRaw, 32)}".` });
        continue;
      }
      rows.push({
        rawTitle,
        kind: "tv_episode",
        seriesNameGuess: seriesName || rawTitle,
        movieNameGuess: null,
        seasonNumber: null,
        episodeNumber: null,
        episodeNameGuess: null,
        watchedDate,
        tvdbSeriesId,
        releaseYear: null,
        runtimeMinutes: null,
        watchlistOnly: true,
      });
      continue;
    }

    // rowKind === "episode_watch"
    if (!seriesName && tvdbSeriesId == null) {
      errors.push({ line, rawTitle: "", reason: "Nome serie mancante (episodio visto)." });
      continue;
    }
    const resolvedSeriesName = seriesName || `TVDB Series ${tvdbSeriesId}`;
    const dateRaw = idx.createdAt !== -1 ? record[idx.createdAt] : "";
    const watchedDate = parseTvTimeDateTime(dateRaw);
    if (!watchedDate) {
      errors.push({ line, rawTitle: resolvedSeriesName, reason: `Data non valida: "${safeString(dateRaw, 32)}".` });
      continue;
    }
    const seasonNumber = toPositiveIntOrNull(firstNonEmpty(record, [idx.seasonNumber, idx.sNo]));
    const episodeNumber = toPositiveIntOrNull(firstNonEmpty(record, [idx.episodeNumber, idx.epNo]));
    if (seasonNumber == null || episodeNumber == null) {
      const rawSeason = toNullableInt(firstNonEmpty(record, [idx.seasonNumber, idx.sNo]));
      const rawEpisode = toNullableInt(firstNonEmpty(record, [idx.episodeNumber, idx.epNo]));
      extraEpisodes.push({
        rawTitle: resolvedSeriesName,
        seriesNameGuess: resolvedSeriesName,
        watchedDate,
        tvdbSeriesId,
        tvdbEpisodeId: idx.epId !== -1 ? toPositiveIntOrNull(record[idx.epId]) : null,
        seasonNumber: rawSeason != null && rawSeason >= 0 ? rawSeason : null,
        episodeNumber: rawEpisode != null && rawEpisode >= 0 ? rawEpisode : null,
        classification: rawSeason === 0 && rawEpisode != null && rawEpisode > 0 ? "special" : "unnumbered",
      });
      errors.push({ line, rawTitle: resolvedSeriesName, reason: "Numero stagione/episodio non ordinario; conservato come episodio extra." });
      continue;
    }
    const runtimeMinutes = idx.runtime !== -1 ? secondsToMinutes(record[idx.runtime]) : null;

    rows.push({
      rawTitle: resolvedSeriesName,
      kind: "tv_episode",
      seriesNameGuess: resolvedSeriesName,
      movieNameGuess: null,
      seasonNumber,
      episodeNumber,
      episodeNameGuess: null,
      watchedDate,
      tvdbSeriesId,
      releaseYear: null,
      runtimeMinutes,
    });
  }

  return { rows, extraEpisodes, errors };
}

/**
 * Parses the 2 relevant TV Time GDPR export CSVs and merges the results into
 * a single NormalizedRow[] (movies + series), matching the shape callers
 * already expect from netflixCsv.js's parseNetflixCsv. Errors from both
 * files are concatenated, line numbers are per-source-file (kept as-is; the
 * caller only surfaces counts/messages, never cross-references line numbers
 * across the two files).
 */
function parseTvTimeGdprCsvs({ moviesCsv, seriesCsv }) {
  const movies = parseTvTimeMoviesCsv(moviesCsv || "");
  const series = parseTvTimeSeriesCsv(seriesCsv || "");
  return {
    rows: [...movies.rows, ...series.rows],
    extraEpisodes: series.extraEpisodes || [],
    errors: [...movies.errors, ...series.errors],
  };
}

module.exports = {
  parseTvTimeGdprCsvs,
  parseTvTimeMoviesCsv,
  parseTvTimeSeriesCsv,
  parseTvTimeDateTime,
};
