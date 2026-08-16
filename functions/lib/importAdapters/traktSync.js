"use strict";

// Trakt.tv import adapter — OAuth device-flow helpers + sync-library fetch +
// PURE parse/normalize into the SAME NormalizedRow[] shape produced by
// netflixCsv.js / tvTimeGdpr.js. Trakt is the EASIEST import source: every
// item carries `ids.tmdb`, and Somto titles are keyed on TMDB (docId
// `tmdb_<type>_<id>`, field `tmdbId`, `mergedTmdbIds[]`), so matching is
// DETERMINISTIC by tmdbId (no fuzzy name search). Ratings are already 1..10
// (Trakt native) → map 1:1 to Somto, NO calibration.
//
// This module is split in two halves:
//   - NETWORK (traktFetch, requestDeviceCode, pollDeviceToken,
//     refreshAccessToken, revokeToken, fetchTraktLibrary) — uses the global
//     `fetch` (Node 22). NEVER reads process.env: clientId/clientSecret are
//     passed in as args, keeping the module unit-testable and side-effect-free
//     at require time.
//   - PURE (buildTraktImportBlob, parseTraktBlob, buildTraktRatingIntents) —
//     no network, no Firestore, deterministic, fully unit-tested. These take a
//     compact "blob" (buildTraktImportBlob's tmdb-only projection of the raw
//     library) and never touch the raw Trakt payload again.
//
// Tokens/deviceCodes MUST NEVER be logged or returned to a client (callers in
// index.js enforce this; this module simply never logs them).
//
// NormalizedRow (shared shape — see netflixCsv.js / tvTimeGdpr.js headers for
// the base fields) plus ONE Trakt-only optional field:
//   {
//     rawTitle, kind: "movie" | "tv_episode",
//     seriesNameGuess, movieNameGuess, seasonNumber, episodeNumber,
//     episodeNameGuess: null, watchedDate: Date,
//     // --- Trakt-only extras ---
//     tmdbId: number,                 // ids.tmdb — enables the deterministic match
//     mediaTypeHint: "movie" | "tv",  // never ambiguous for Trakt rows
//     releaseYear: number | null,     // movie/show `year`
//     watchlistOnly: true | undefined,// watchlist rows (no watch signal)
//   }

const TRAKT_API = "https://api.trakt.tv";
const TRAKT_API_VERSION = "2";
const OOB_REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeString(value, maxLen = 500) {
  return String(value ?? "").trim().slice(0, maxLen);
}

// noon UTC of the ISO date's calendar day — parity with the rest of the import
// pipeline (day-granularity), avoids a timezone-induced off-by-one when later
// rendered. Returns null for missing/invalid input so callers can skip+count.
function dayNoonUTC(iso) {
  const raw = safeString(iso, 40);
  if (!raw) return null;
  const parsed = new Date(raw);
  const ms = parsed.getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate(), 12, 0, 0));
}

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function clampRating(value) {
  const n = Number(value);
  if (!Number.isInteger(n)) return null;
  if (n < 1 || n > 10) return null;
  return n;
}

function extractYear(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1870 && n <= 2100 ? Math.trunc(n) : null;
}

/* ============================= NETWORK ============================= */

/**
 * Low-level Trakt request. Sets the required Trakt headers; attaches the
 * Bearer token for sync (user) endpoints when `token` is provided. JSON body
 * for POSTs. Retries transient 5xx (up to `retries`) and honors 429
 * `Retry-After` with a bounded backoff — never throws on an HTTP error status
 * (returns { status, data, headers } so callers decide), only on a network
 * failure after exhausting retries.
 *
 * clientId is REQUIRED (Trakt rejects requests without `trakt-api-key`).
 */
async function traktFetch(path, { clientId, token, method = "GET", body = null, retries = 2 } = {}) {
  const url = `${TRAKT_API}${path}`;
  const headers = {
    "Content-Type": "application/json",
    // Trakt sits behind Cloudflare, which 403s requests carrying no/Node's
    // default undici User-Agent (server-to-server calls from Cloud Functions).
    // A real UA is REQUIRED — without it every /oauth and /sync call fails 403.
    "User-Agent": "Somto/1.0 (+https://somto.it)",
    "trakt-api-version": TRAKT_API_VERSION,
    "trakt-api-key": String(clientId || ""),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let attempt = 0;
  // attempt 0 is the first try; up to `retries` extra tries for 429/5xx.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        ...(body != null ? { body: JSON.stringify(body) } : {}),
      });
    } catch (networkErr) {
      if (attempt >= retries) throw networkErr;
      attempt += 1;
      // eslint-disable-next-line no-await-in-loop
      await sleep(Math.min(2000, 300 * 2 ** attempt));
      continue;
    }

    const status = res.status;

    // 429: honor Retry-After (seconds) with a small cap; retry.
    if (status === 429 && attempt < retries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(10000, retryAfter * 1000)
        : Math.min(5000, 500 * 2 ** attempt);
      attempt += 1;
      // eslint-disable-next-line no-await-in-loop
      await sleep(waitMs);
      continue;
    }

    // 5xx: transient server error — bounded backoff retry.
    if (status >= 500 && status < 600 && attempt < retries) {
      attempt += 1;
      // eslint-disable-next-line no-await-in-loop
      await sleep(Math.min(4000, 400 * 2 ** attempt));
      continue;
    }

    let data = null;
    const text = await res.text().catch(() => "");
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (parseErr) {
        data = null; // some endpoints (204, revoke) return empty/non-JSON
      }
    }
    return { status, data, headers: res.headers };
  }
}

/**
 * OAuth device flow step 1: request a device+user code. Returns the raw Trakt
 * shape { device_code, user_code, verification_url, expires_in, interval }.
 * Throws on a non-200 (device-code request should always succeed given a valid
 * client id).
 */
async function requestDeviceCode({ clientId }) {
  const { status, data } = await traktFetch("/oauth/device/code", {
    clientId,
    method: "POST",
    body: { client_id: clientId },
    retries: 2,
  });
  if (status !== 200 || !data?.device_code || !data?.user_code) {
    throw new Error(`Trakt device code request failed (status ${status}).`);
  }
  return {
    device_code: String(data.device_code),
    user_code: String(data.user_code),
    verification_url: String(data.verification_url || "https://trakt.tv/activate"),
    expires_in: Number(data.expires_in) || 600,
    interval: Number(data.interval) || 5,
  };
}

/**
 * OAuth device flow step 2: poll for the token. Maps Trakt's status codes to a
 * stable client-facing status enum. The client polls this every `interval`
 * seconds until it stops being "pending".
 *   200 -> authorized (+ tokens)   400 -> pending (keep polling)
 *   404 -> error (invalid device_code)   409 -> error (already used)
 *   410 -> expired   418 -> denied   429 -> pending (slow down)
 */
async function pollDeviceToken({ clientId, clientSecret, deviceCode }) {
  const { status, data } = await traktFetch("/oauth/device/token", {
    clientId,
    method: "POST",
    body: { code: deviceCode, client_id: clientId, client_secret: clientSecret },
    retries: 0, // polling: caller re-invokes on its own cadence, don't stack retries
  });
  if (status === 200 && data?.access_token) {
    return { status: "authorized", tokens: normalizeTokens(data) };
  }
  if (status === 400 || status === 429) return { status: "pending" };
  if (status === 410) return { status: "expired" };
  if (status === 418) return { status: "denied" };
  return { status: "error" };
}

/**
 * Refreshes an access token via the refresh token (oob grant). Throws on a
 * non-200 so the caller can surface "reconnect Trakt".
 */
async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  const { status, data } = await traktFetch("/oauth/token", {
    clientId,
    method: "POST",
    body: {
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: OOB_REDIRECT_URI,
      grant_type: "refresh_token",
    },
    retries: 1,
  });
  if (status !== 200 || !data?.access_token) {
    throw new Error(`Trakt token refresh failed (status ${status}).`);
  }
  return normalizeTokens(data);
}

/**
 * Revokes a token (on disconnect). Best-effort — never throws; a failure to
 * revoke on Trakt's side must not block deleting our local token doc.
 */
async function revokeToken({ clientId, clientSecret, token }) {
  try {
    await traktFetch("/oauth/revoke", {
      clientId,
      method: "POST",
      body: { token, client_id: clientId, client_secret: clientSecret },
      retries: 0,
    });
  } catch (err) {
    // swallow — revoke is best-effort
  }
}

// Normalizes Trakt's token response into a stable shape, computing the
// absolute access-token expiry (created_at + expires_in) in epoch seconds.
function normalizeTokens(data) {
  const createdAt = Number(data.created_at) || Math.floor(Date.now() / 1000);
  const expiresIn = Number(data.expires_in) || 0;
  return {
    accessToken: String(data.access_token || ""),
    refreshToken: String(data.refresh_token || ""),
    tokenType: String(data.token_type || "bearer"),
    scope: String(data.scope || ""),
    createdAt,
    expiresIn,
    expiresAtSeconds: createdAt + expiresIn,
  };
}

// Fetches ALL pages of a Trakt sync list endpoint. Trakt paginates /sync/*
// with a MAX limit of 250/page (their 2026 limits change: /sync/watched no
// longer returns everything in one response — verified live, a heavy account
// was capped at 100/page), so we MUST follow X-Pagination-Page-Count to the
// end. Tolerates a non-200 by stopping and returning what it has, so one bad
// collection never fails the whole library fetch. `maxPages` bounds a
// pathological account so a single import can't run unbounded.
async function fetchTraktPaginated(path, { clientId, token, maxPages = 400 }) {
  const out = [];
  let page = 1;
  let pageCount = 1;
  do {
    const sep = path.includes("?") ? "&" : "?";
    // eslint-disable-next-line no-await-in-loop
    const { status, data, headers } = await traktFetch(`${path}${sep}page=${page}&limit=250`, { clientId, token, retries: 2 });
    if (status !== 200 || !Array.isArray(data)) break;
    for (const item of data) out.push(item);
    pageCount = Number(headers && headers.get ? headers.get("x-pagination-page-count") : 0) || 1;
    page += 1;
  } while (page <= pageCount && page <= maxPages);
  return out;
}

/**
 * Fetches the full Trakt sync library, PAGINATED. Movies come from
 * /sync/watched/movies (aggregated → distinct). EPISODES come from
 * /sync/history/episodes — NOT /sync/watched/shows, which since Trakt's 2026
 * change returns shows WITHOUT any per-episode seasons breakdown (verified: 0
 * episodes even with extended=full — the `seasons` key is simply gone). The
 * history log gives every episode watch with its show + season/episode + tmdb
 * id + watched_at; buildTraktImportBlob dedupes it to distinct episodes.
 * Ratings + watchlist are paginated the same way.
 */
async function fetchTraktLibrary({ clientId, token }) {
  const [
    watchedMovies,
    historyEpisodes,
    ratingsMovies,
    ratingsShows,
    ratingsSeasons,
    ratingsEpisodes,
    watchlistMovies,
    watchlistShows,
  ] = await Promise.all([
    fetchTraktPaginated("/sync/watched/movies", { clientId, token }),
    fetchTraktPaginated("/sync/history/episodes", { clientId, token }),
    fetchTraktPaginated("/sync/ratings/movies", { clientId, token }),
    fetchTraktPaginated("/sync/ratings/shows", { clientId, token }),
    fetchTraktPaginated("/sync/ratings/seasons", { clientId, token }),
    fetchTraktPaginated("/sync/ratings/episodes", { clientId, token }),
    fetchTraktPaginated("/sync/watchlist/movies", { clientId, token }),
    fetchTraktPaginated("/sync/watchlist/shows", { clientId, token }),
  ]);

  return {
    watchedMovies,
    historyEpisodes,
    ratings: {
      movies: ratingsMovies,
      shows: ratingsShows,
      seasons: ratingsSeasons,
      episodes: ratingsEpisodes,
    },
    watchlist: {
      movies: watchlistMovies,
      shows: watchlistShows,
    },
  };
}

/* ============================= PURE: blob ============================= */

// tmdb id off a Trakt movie/show node.
function tmdbIdOf(node) {
  return toPositiveInt(node?.ids?.tmdb);
}

/**
 * Compacts the raw Trakt library into a small, tmdb-only blob that the PURE
 * parser/intent-builders consume. Entries with no `ids.tmdb` are DROPPED (we
 * match deterministically by tmdb id; a Trakt item without one cannot be
 * matched and would only produce noise). Shows keep their per-episode
 * structure so parseTraktBlob can emit one row per watched episode (mirrors
 * TV Time — writeTitleStates derives series progress from per-episode rows).
 *
 * Blob shape:
 *   {
 *     version: 1,
 *     watched: [
 *       { kind:"movie", tmdbId, title, year, lastWatchedAt },
 *       { kind:"show", tmdbId, title, year, lastWatchedAt,
 *         seasons:[{ n, episodes:[{ n, lastWatchedAt }] }] },
 *     ],
 *     ratings: [
 *       { type:"movie"|"show"|"season"|"episode", tmdbId, season?, episode?,
 *         rating, ratedAt }
 *     ],
 *     watchlist: [ { kind:"movie"|"show", tmdbId, title, year, listedAt } ],
 *   }
 */
function buildTraktImportBlob(library) {
  const lib = library && typeof library === "object" ? library : {};
  const watched = [];
  const ratings = [];
  const watchlist = [];

  // --- watched movies ---
  for (const entry of Array.isArray(lib.watchedMovies) ? lib.watchedMovies : []) {
    const movie = entry?.movie;
    const tmdbId = tmdbIdOf(movie);
    if (!tmdbId) continue;
    watched.push({
      kind: "movie",
      tmdbId,
      title: safeString(movie?.title, 500),
      year: extractYear(movie?.year),
      lastWatchedAt: safeString(entry?.last_watched_at, 40) || null,
    });
  }

  // --- watched episodes (from /sync/history/episodes) ---
  // Trakt's /sync/watched/shows no longer carries the per-episode seasons
  // breakdown (2026 change), so episodes come from the history log: one event
  // per watch (rewatches included). We only need the SET of watched episodes,
  // so dedupe to distinct (show tmdb, season, episode) keeping the EARLIEST
  // watched_at, then group back into the show → season → episode blob shape
  // that parseTraktBlob already consumes (so nothing downstream changes).
  const showsByTmdb = new Map();
  for (const ev of Array.isArray(lib.historyEpisodes) ? lib.historyEpisodes : []) {
    const showTmdb = tmdbIdOf(ev?.show);
    // Trakt uses season 0 for specials; toPositiveInt drops it (Somto's season
    // model is 1-based; specials aren't tracked as numbered progress).
    const seasonNumber = toPositiveInt(ev?.episode?.season);
    const episodeNumber = toPositiveInt(ev?.episode?.number);
    if (!showTmdb || seasonNumber == null || episodeNumber == null) continue;
    const watchedAt = safeString(ev?.watched_at, 40) || null;
    let show = showsByTmdb.get(showTmdb);
    if (!show) {
      show = {
        tmdbId: showTmdb,
        title: safeString(ev?.show?.title, 500),
        year: extractYear(ev?.show?.year),
        lastWatchedAt: watchedAt,
        seasons: new Map(), // seasonNumber -> Map(episodeNumber -> earliest watchedAt)
      };
      showsByTmdb.set(showTmdb, show);
    }
    let seasonEps = show.seasons.get(seasonNumber);
    if (!seasonEps) { seasonEps = new Map(); show.seasons.set(seasonNumber, seasonEps); }
    const prev = seasonEps.get(episodeNumber);
    if (prev === undefined) {
      seasonEps.set(episodeNumber, watchedAt);
    } else if (watchedAt && (!prev || watchedAt < prev)) {
      seasonEps.set(episodeNumber, watchedAt); // keep the earliest watch date
    }
    if (watchedAt && (!show.lastWatchedAt || watchedAt > show.lastWatchedAt)) {
      show.lastWatchedAt = watchedAt;
    }
  }
  for (const show of showsByTmdb.values()) {
    const seasons = [];
    for (const [seasonNumber, epMap] of show.seasons) {
      const episodes = [];
      for (const [episodeNumber, lastWatchedAt] of epMap) episodes.push({ n: episodeNumber, lastWatchedAt });
      if (episodes.length > 0) seasons.push({ n: seasonNumber, episodes });
    }
    watched.push({
      kind: "show",
      tmdbId: show.tmdbId,
      title: show.title,
      year: show.year,
      lastWatchedAt: show.lastWatchedAt,
      seasons,
    });
  }

  // --- ratings (movies/shows/seasons/episodes) ---
  pushRatingBlobEntries(ratings, lib?.ratings);

  // --- watchlist (movies/shows) ---
  for (const entry of Array.isArray(lib?.watchlist?.movies) ? lib.watchlist.movies : []) {
    const movie = entry?.movie;
    const tmdbId = tmdbIdOf(movie);
    if (!tmdbId) continue;
    watchlist.push({
      kind: "movie",
      tmdbId,
      title: safeString(movie?.title, 500),
      year: extractYear(movie?.year),
      listedAt: safeString(entry?.listed_at, 40) || null,
    });
  }
  for (const entry of Array.isArray(lib?.watchlist?.shows) ? lib.watchlist.shows : []) {
    const show = entry?.show;
    const tmdbId = tmdbIdOf(show);
    if (!tmdbId) continue;
    watchlist.push({
      kind: "show",
      tmdbId,
      title: safeString(show?.title, 500),
      year: extractYear(show?.year),
      listedAt: safeString(entry?.listed_at, 40) || null,
    });
  }

  return { version: 1, watched, ratings, watchlist };
}

// Movies/shows rate at the SHOW/TITLE level; the tmdb id lives on the
// movie/show node. Seasons/episodes carry a per-item number but their tmdb
// anchor is always the SHOW's tmdb id (Somto ratings are anchored on the show
// title doc, with season/episode as sub-levels).
function pushRatingBlobEntries(out, ratings) {
  const r = ratings && typeof ratings === "object" ? ratings : {};

  for (const entry of Array.isArray(r.movies) ? r.movies : []) {
    const tmdbId = tmdbIdOf(entry?.movie);
    const rating = clampRating(entry?.rating);
    if (!tmdbId || rating == null) continue;
    out.push({ type: "movie", tmdbId, rating, ratedAt: safeString(entry?.rated_at, 40) || null });
  }
  for (const entry of Array.isArray(r.shows) ? r.shows : []) {
    const tmdbId = tmdbIdOf(entry?.show);
    const rating = clampRating(entry?.rating);
    if (!tmdbId || rating == null) continue;
    out.push({ type: "show", tmdbId, rating, ratedAt: safeString(entry?.rated_at, 40) || null });
  }
  for (const entry of Array.isArray(r.seasons) ? r.seasons : []) {
    const tmdbId = tmdbIdOf(entry?.show); // anchor on the SHOW's tmdb id
    const season = toPositiveInt(entry?.season?.number);
    const rating = clampRating(entry?.rating);
    if (!tmdbId || season == null || rating == null) continue;
    out.push({ type: "season", tmdbId, season, rating, ratedAt: safeString(entry?.rated_at, 40) || null });
  }
  for (const entry of Array.isArray(r.episodes) ? r.episodes : []) {
    const tmdbId = tmdbIdOf(entry?.show); // anchor on the SHOW's tmdb id
    const season = toPositiveInt(entry?.episode?.season);
    const episode = toPositiveInt(entry?.episode?.number);
    const rating = clampRating(entry?.rating);
    if (!tmdbId || season == null || episode == null || rating == null) continue;
    out.push({ type: "episode", tmdbId, season, episode, rating, ratedAt: safeString(entry?.rated_at, 40) || null });
  }
}

/* ============================= PURE: rows ============================= */

// Deterministic sort key. The resumable matcher (runImportMatchTick) uses a
// numeric cursor, so EVERY re-parse across ticks MUST yield identical order —
// sort by (kind, tmdbId, season||0, episode||0, watchedDate ISO).
function rowSortKey(row) {
  return [
    row.kind,
    String(row.tmdbId).padStart(12, "0"),
    String(row.seasonNumber || 0).padStart(6, "0"),
    String(row.episodeNumber || 0).padStart(6, "0"),
    row.watchedDate instanceof Date ? row.watchedDate.toISOString() : "",
    row.watchlistOnly ? "1" : "0",
  ].join("|");
}

/**
 * Parses the compact blob into NormalizedRow[] + errors (defensive: skip+count,
 * never crash). One row per watched movie; one row PER WATCHED EPISODE for
 * shows; one watchlistOnly row per watchlist movie/show. Rows are sorted by a
 * stable key at the end (CRITICAL for the resumable matcher's cursor).
 */
function parseTraktBlob(blob) {
  const rows = [];
  const errors = [];
  const b = blob && typeof blob === "object" ? blob : {};

  for (const entry of Array.isArray(b.watched) ? b.watched : []) {
    if (entry?.kind === "movie") {
      const watchedDate = dayNoonUTC(entry.lastWatchedAt);
      if (!watchedDate) {
        errors.push({ line: rows.length, rawTitle: entry.title || "", reason: "Data visione film non valida." });
        continue;
      }
      rows.push({
        rawTitle: entry.title || `TMDB ${entry.tmdbId}`,
        kind: "movie",
        seriesNameGuess: null,
        movieNameGuess: entry.title || null,
        seasonNumber: null,
        episodeNumber: null,
        episodeNameGuess: null,
        watchedDate,
        tmdbId: entry.tmdbId,
        mediaTypeHint: "movie",
        releaseYear: entry.year ?? null,
      });
      continue;
    }

    if (entry?.kind === "show") {
      const showTitle = entry.title || `TMDB ${entry.tmdbId}`;
      const seasons = Array.isArray(entry.seasons) ? entry.seasons : [];
      for (const season of seasons) {
        for (const episode of Array.isArray(season?.episodes) ? season.episodes : []) {
          // Prefer the per-episode watch date; fall back to the show-level
          // last_watched_at (present even if the per-episode timestamp isn't).
          const watchedDate = dayNoonUTC(episode.lastWatchedAt) || dayNoonUTC(entry.lastWatchedAt);
          if (!watchedDate) {
            errors.push({ line: rows.length, rawTitle: showTitle, reason: "Data visione episodio non valida." });
            continue;
          }
          rows.push({
            rawTitle: showTitle,
            kind: "tv_episode",
            seriesNameGuess: showTitle,
            movieNameGuess: null,
            seasonNumber: season.n,
            episodeNumber: episode.n,
            episodeNameGuess: null,
            watchedDate,
            tmdbId: entry.tmdbId,
            mediaTypeHint: "tv",
            releaseYear: entry.year ?? null,
          });
        }
      }
    }
  }

  // Watchlist (no watch signal): movies + shows, both watchlistOnly.
  for (const entry of Array.isArray(b.watchlist) ? b.watchlist : []) {
    const watchedDate = dayNoonUTC(entry?.listedAt) || dayNoonUTC(new Date().toISOString());
    if (!watchedDate) continue; // unreachable (fallback is always valid), defensive
    if (entry?.kind === "movie") {
      rows.push({
        rawTitle: entry.title || `TMDB ${entry.tmdbId}`,
        kind: "movie",
        seriesNameGuess: null,
        movieNameGuess: entry.title || null,
        seasonNumber: null,
        episodeNumber: null,
        episodeNameGuess: null,
        watchedDate,
        tmdbId: entry.tmdbId,
        mediaTypeHint: "movie",
        releaseYear: entry.year ?? null,
        watchlistOnly: true,
      });
    } else if (entry?.kind === "show") {
      rows.push({
        rawTitle: entry.title || `TMDB ${entry.tmdbId}`,
        kind: "tv_episode",
        seriesNameGuess: entry.title || `TMDB ${entry.tmdbId}`,
        movieNameGuess: null,
        seasonNumber: null,
        episodeNumber: null,
        episodeNameGuess: null,
        watchedDate,
        tmdbId: entry.tmdbId,
        mediaTypeHint: "tv",
        releaseYear: entry.year ?? null,
        watchlistOnly: true,
      });
    }
  }

  rows.sort((a, b2) => {
    const ka = rowSortKey(a);
    const kb = rowSortKey(b2);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  return { rows, errors };
}

/* ============================= PURE: rating intents ============================= */

/**
 * Builds rating intents from the blob. Trakt ratings are already 1..10 →
 * passthrough unchanged (clampRating already dropped non-integer/out-of-range
 * at blob-build time; re-clamp here defensively). Levels map:
 *   movie   -> level:"title"    (movie tmdbId)
 *   show    -> level:"title"    (show tmdbId == Somto title level)
 *   season  -> level:"season"   (show tmdbId, season)
 *   episode -> level:"episode"  (show tmdbId, season, episode)
 *
 * Returns [{ level, tmdbId, season?, episode?, rating, ratedAt }].
 */
function buildTraktRatingIntents(blob) {
  const b = blob && typeof blob === "object" ? blob : {};
  const intents = [];
  for (const entry of Array.isArray(b.ratings) ? b.ratings : []) {
    const tmdbId = toPositiveInt(entry?.tmdbId);
    const rating = clampRating(entry?.rating);
    if (!tmdbId || rating == null) continue;
    const ratedAt = safeString(entry?.ratedAt, 40) || null;

    if (entry.type === "movie" || entry.type === "show") {
      intents.push({ level: "title", tmdbId, rating, ratedAt });
    } else if (entry.type === "season") {
      const season = toPositiveInt(entry.season);
      if (season == null) continue;
      intents.push({ level: "season", tmdbId, season, rating, ratedAt });
    } else if (entry.type === "episode") {
      const season = toPositiveInt(entry.season);
      const episode = toPositiveInt(entry.episode);
      if (season == null || episode == null) continue;
      intents.push({ level: "episode", tmdbId, season, episode, rating, ratedAt });
    }
  }
  return intents;
}

module.exports = {
  TRAKT_API,
  // network
  traktFetch,
  requestDeviceCode,
  pollDeviceToken,
  refreshAccessToken,
  revokeToken,
  fetchTraktLibrary,
  // pure
  buildTraktImportBlob,
  parseTraktBlob,
  buildTraktRatingIntents,
  // test seams / helpers
  dayNoonUTC,
};
