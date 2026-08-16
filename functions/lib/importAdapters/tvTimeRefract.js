"use strict";

// "TV Time Out" by Refract adapter — parses the JSON export produced by the
// opensource Refract browser extension (a lifeboat for TV Time's shutdown,
// 2026-07-15). Sample analyzed: tvtime-export-<date>.zip containing:
//   - tvtime-movies-<date>.json
//   - tvtime-series-<date>.json
//   - tvtime-lists-<date>.json    (custom lists)
//   - tvtime-summary-<date>.html  (human-readable report — not data, ignored)
//
// FINDINGS (from the real sample; anonymized copy lives in the test fixture):
//   - Movies: flat JSON array, one object per title:
//       { id: { tvdb: number|null, imdb: string|null }, uuid, created_at
//         (ISO8601, always trailing "Z", sometimes with microseconds),
//         title, year, watched_at (ISO8601 or null), is_watched (bool),
//         is_favorite (bool), rewatch_count (int) }
//     `id.tvdb` was present on every sample row — a MUCH stronger matching
//     signal than the GDPR CSV export ever gave for movies (which had none
//     at all). matching.js's matchViaTvdbId/findTmdbByTvdbId support movies
//     too (expectedType param) so this adapter can use it.
//   - Series: flat JSON array, one object per show:
//       { uuid, id: { tvdb, imdb }, created_at, title, status,
//         is_favorite, _noEpisodeData, seasons: [ { number, is_specials,
//         episodes: [ { id: { tvdb, imdb }, number, name, special,
//         is_watched, watched_at, rewatch_count, watched_count } ] } ] }
//     `season.number === 0` already matches TMDB's own "specials" season
//     convention — no remapping needed.
//   - Timestamp format is NOT uniform: movie/series-level `created_at` and
//     movie `watched_at` are ISO8601 with a trailing "Z" (sometimes with
//     microseconds: "2026-07-05T19:17:02.610019Z"); EPISODE `watched_at` is
//     space-separated with NO "Z" and NO fractional seconds
//     ("2026-07-05 19:19:41"). parseRefractDateTime below accepts both.
//   - NO rating/vote/review field anywhere in either file. Refract's export
//     is watch-status only — the TVTIME_VOTE_ID_TO_DECIMAL mapping (see
//     tvTimeRatings.js) does NOT apply to this source; this adapter never
//     produces rating data and processTvTimeRatingsAndComments (index.js)
//     is never invoked for it.
//   - NO runtime field anywhere (movies or episodes), unlike the GDPR CSV's
//     `runtime` column — `runtimeMinutes` is always null for this source,
//     so backfillTitleDurationsFromImport (index.js) is a no-op here.
//   - `is_favorite` has no destination in Somto's schema (no per-title
//     "favorite" concept) — deliberately dropped, never carried into
//     NormalizedRow. Same for series `status` (continuing/ended) and
//     episode `name` (informational only: season/episode NUMBERS drive
//     matching + progress, exactly like the GDPR adapter never uses
//     episode names when numbers are available).
//   - `tvtime-lists-<date>.json` (custom lists) is OUT OF SCOPE, same
//     decision as the GDPR adapter's lists-prod-lists.csv (see
//     tvTimeLists.js: parser exists, writing is a separate future phase).
//     Never parsed by this module.
//
// Output: the SAME NormalizedRow[] shape as netflixCsv.js/tvTimeGdpr.js,
// plus 2 extras this format uniquely supplies:
//   tvdbMovieId: number | null   // the movie's OWN TheTVDB id (GDPR never had one)
//   tvdbSeriesId: number | null  // same meaning/name as the GDPR adapter's field
// (releaseYear, runtimeMinutes, rewatchCount are carried through same as the
// GDPR adapter; runtimeMinutes is always null here, see above.)
//
// This module is a PURE parser: no Firestore, no TMDB, no I/O. Malformed
// entries (missing title, unparseable date, missing season/episode number
// on a watched episode) produce an entry in `errors` (never a silent skip)
// — same contract as the other adapters. A MISSING/unknown external id
// (tvdb null, imdb absent) is NOT a parse error: the row is still emitted
// with that field null, and falls back to the name-based matching cascade
// downstream (matching.js) — "never guess" applies to title RESOLUTION,
// which already counts an unresolved row rather than fabricating a match;
// it is not this parser's job to reject rows just because an id is absent.

function safeString(value, maxLen = 500) {
  return String(value ?? "").trim().slice(0, maxLen);
}

function toPositiveIntOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

// Season numbers include 0 (specials) — unlike episode/id fields, which are
// always > 0.
function toNonNegativeIntOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

function toYearOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1870 && n <= 2100 ? Math.trunc(n) : null;
}

// Accepts both timestamp shapes found in the export (see header comment):
// "2026-07-05T19:17:02Z", "2026-07-05T19:17:02.610019Z" (movie/series
// created_at, movie watched_at) and "2026-07-05 19:19:41" (episode
// watched_at only). Parsed at second precision as an absolute UTC instant
// (unlike the GDPR adapter's day-only noon-UTC bucketing: this export gives
// real session timestamps, worth keeping for rewatch/date-cluster logic
// downstream in writeTitleStates.js).
function parseRefractDateTime(raw) {
  const trimmed = safeString(raw, 40);
  const m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z?$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}

function parseJsonArray(rawText, emptyErrorReason, notArrayErrorReason) {
  let data;
  try {
    data = JSON.parse(rawText || "[]");
  } catch (err) {
    return { data: null, error: emptyErrorReason };
  }
  if (!Array.isArray(data)) {
    return { data: null, error: notArrayErrorReason };
  }
  return { data, error: null };
}

/* ============================= movies ============================= */

function parseRefractMoviesJson(rawText) {
  const rows = [];
  const { data, error } = parseJsonArray(
    rawText,
    "JSON film non valido (parse fallito).",
    "JSON film: atteso un array."
  );
  if (error) return { rows, errors: [{ line: 0, rawTitle: "", reason: error }] };

  const errors = [];
  data.forEach((entry, index) => {
    const line = index + 1;
    const rawTitle = safeString(entry?.title, 500);
    if (!rawTitle) {
      errors.push({ line, rawTitle: "", reason: "Titolo film mancante." });
      return;
    }

    const isWatched = entry?.is_watched === true;
    // Watched movies: prefer the precise `watched_at` viewing timestamp;
    // watchlist-only movies have no watched_at, fall back to `created_at`
    // (when the title was tracked/added) — the same "row date" role the
    // GDPR adapter gives its follow/towatch rows.
    const dateRaw = isWatched ? (entry?.watched_at || entry?.created_at) : entry?.created_at;
    const watchedDate = parseRefractDateTime(dateRaw);
    if (!watchedDate) {
      errors.push({ line, rawTitle, reason: `Data non valida: "${safeString(dateRaw, 40)}".` });
      return;
    }

    rows.push({
      rawTitle,
      kind: "movie",
      seriesNameGuess: null,
      movieNameGuess: rawTitle,
      seasonNumber: null,
      episodeNumber: null,
      episodeNameGuess: null,
      watchedDate,
      tvdbMovieId: toPositiveIntOrNull(entry?.id?.tvdb),
      tvdbSeriesId: null,
      releaseYear: toYearOrNull(entry?.year),
      runtimeMinutes: null,
      rewatchCount: toPositiveIntOrNull(entry?.rewatch_count),
      ...(isWatched ? {} : { watchlistOnly: true }),
    });
  });

  return { rows, errors };
}

/* ============================= series ============================= */

function parseRefractSeriesJson(rawText) {
  const rows = [];
  const { data, error } = parseJsonArray(
    rawText,
    "JSON serie non valido (parse fallito).",
    "JSON serie: atteso un array."
  );
  if (error) return { rows, errors: [{ line: 0, rawTitle: "", reason: error }] };

  const errors = [];
  data.forEach((series, seriesIndex) => {
    const line = seriesIndex + 1;
    const rawTitle = safeString(series?.title, 500);
    if (!rawTitle) {
      errors.push({ line, rawTitle: "", reason: "Titolo serie mancante." });
      return;
    }

    const tvdbSeriesId = toPositiveIntOrNull(series?.id?.tvdb);
    const seasons = Array.isArray(series?.seasons) ? series.seasons : [];
    let watchedEpisodeCount = 0;

    seasons.forEach((season) => {
      const seasonNumber = toNonNegativeIntOrNull(season?.number);
      const episodes = Array.isArray(season?.episodes) ? season.episodes : [];

      episodes.forEach((episode) => {
        if (episode?.is_watched !== true) return; // unwatched episode: no row

        const episodeNumber = toPositiveIntOrNull(episode?.number);
        if (seasonNumber == null || episodeNumber == null) {
          errors.push({
            line,
            rawTitle,
            reason: `Numero stagione/episodio mancante o non valido (stagione ${JSON.stringify(season?.number ?? null)}, episodio ${JSON.stringify(episode?.number ?? null)}).`,
          });
          return;
        }
        const watchedDate = parseRefractDateTime(episode?.watched_at);
        if (!watchedDate) {
          errors.push({ line, rawTitle, reason: `Data episodio non valida: "${safeString(episode?.watched_at, 40)}".` });
          return;
        }

        watchedEpisodeCount += 1;
        rows.push({
          rawTitle,
          kind: "tv_episode",
          seriesNameGuess: rawTitle,
          movieNameGuess: null,
          seasonNumber,
          episodeNumber,
          episodeNameGuess: null,
          watchedDate,
          tvdbSeriesId,
          releaseYear: null,
          runtimeMinutes: null,
          // Explicit per-episode rewatch signal. Refract gives ONE row per
          // watched episode (a single watched_at), so date-clustering alone
          // can never see a rewatch — the multiplicity lives only in these
          // counts. watched_count = total views; rewatch_count = extra views
          // beyond the first. Carried through so csvCompletedRunsForSeries can
          // credit series rewatches (movies already use rewatchCount).
          rewatchCount: toPositiveIntOrNull(episode?.rewatch_count),
          watchedCount: toPositiveIntOrNull(episode?.watched_count),
        });
      });
    });

    // Zero watched episodes: the show is tracked/followed but not started
    // — same semantics as the GDPR adapter's "user-series-{uuid}" follow row
    // with is_for_later=true. Also covers `_noEpisodeData: true` shows
    // (Refract couldn't enumerate episodes at all): no watch signal is
    // derivable either way, so the safe fallback is identical — a single
    // watchlist-only row for the whole series.
    if (watchedEpisodeCount === 0) {
      const watchedDate = parseRefractDateTime(series?.created_at);
      if (!watchedDate) {
        errors.push({ line, rawTitle, reason: `Data non valida: "${safeString(series?.created_at, 40)}".` });
        return;
      }
      rows.push({
        rawTitle,
        kind: "tv_episode",
        seriesNameGuess: rawTitle,
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
    }
  });

  return { rows, errors };
}

/**
 * Parses the 2 relevant Refract export JSON files (movies + series;
 * lists.json is out of scope, see header comment) and merges the results
 * into a single NormalizedRow[] — matching the shape callers already expect
 * from netflixCsv.js/tvTimeGdpr.js. Errors from both files are concatenated,
 * line numbers are per-source-file (the caller only surfaces counts/messages,
 * never cross-references line numbers across the two files).
 */
function parseTvTimeRefractJson({ moviesJson, seriesJson }) {
  const movies = parseRefractMoviesJson(moviesJson || "");
  const series = parseRefractSeriesJson(seriesJson || "");
  return {
    rows: [...movies.rows, ...series.rows],
    errors: [...movies.errors, ...series.errors],
  };
}

module.exports = {
  parseTvTimeRefractJson,
  parseRefractMoviesJson,
  parseRefractSeriesJson,
  parseRefractDateTime,
};
