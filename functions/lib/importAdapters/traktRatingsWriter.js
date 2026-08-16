"use strict";

// Resolves Trakt rating intents (traktSync.js's buildTraktRatingIntents output)
// to Somto `ratings/{id}` write payloads. PURE logic only: no Firestore
// reads/writes here — the caller (finalizeImportResults in functions/index.js)
// supplies a `tmdbId -> titleId` resolution map (built from the SAME matching
// cascade results already computed for the viewing-history import, so this
// never re-runs the TMDB match for rated-and-watched titles) and receives back
// a list of ready-to-write rating docs.
//
// Mirrors the id scheme from public/js/api/ratings.api.js#makeRatingId EXACTLY
// (same safePart() sanitization, same field order/join) — reused verbatim from
// tvTimeRatingsWriter.js — so a rating imported here and one the user later
// edits via the app land on the SAME doc id (no duplicate ratings for the same
// (uid, titleId, level, season, episode)).
//
// Trakt ratings are already 1..10 (Somto's native scale) → NO calibration, the
// rating value passes through unchanged.

function safePart(v) {
  return String(v ?? "0").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function makeRatingId({ uid, titleId, level, season = null, episode = null }) {
  return [
    safePart(uid),
    safePart(titleId),
    safePart(level),
    safePart(season ?? 0),
    safePart(episode ?? 0),
  ].join("__");
}

/**
 * Resolves each Trakt rating intent to a titleId via the tmdbId->titleId map,
 * and builds the exact Firestore payload for `ratings/{id}` (matching the
 * client's upsertRating() shape + `source: "import_trakt"` so the fan-out
 * trigger guards recognize it as a bulk import and suppress social
 * notifications/feed events — same mechanism as TV Time's `import_tvtime_gdpr`,
 * see processTvTimeRatingsAndComments's docstring in functions/index.js).
 *
 * Intents whose tmdbId isn't in the map (rated-but-not-watched titles) are
 * NOT silently dropped — they're returned in `unresolvedTmdbIds` (deduped, by
 * level so the caller can best-effort resolve them on the fly via
 * matchViaTmdbId and re-run this for the newly-found ones).
 *
 * Returns { writes, unresolvedCount, unresolved } where:
 *   writes = Array<{ ratingId, payload, titleId }>
 *   unresolved = Array<intent> (the intents whose tmdbId had no titleId)
 */
function resolveTraktRatingWrites({ uid, intents, tmdbToTitleId, now }) {
  const map = tmdbToTitleId instanceof Map ? tmdbToTitleId : toMap(tmdbToTitleId);
  const writes = [];
  const unresolved = [];

  for (const intent of Array.isArray(intents) ? intents : []) {
    const tmdbId = Number(intent?.tmdbId);
    if (!Number.isFinite(tmdbId) || tmdbId <= 0) continue;
    const titleId = map.get(tmdbId);
    if (!titleId) {
      unresolved.push(intent);
      continue;
    }

    const level = intent.level === "season" || intent.level === "episode" ? intent.level : "title";
    const season = level === "title" ? null : (intent.season ?? null);
    const episode = level === "episode" ? (intent.episode ?? null) : null;
    const ratingId = makeRatingId({ uid, titleId, level, season, episode });

    const payload = {
      uid,
      titleId,
      level,
      season,
      episode,
      rating: intent.rating,
      updatedAt: now,
      createdAt: now,
      source: "import_trakt",
    };

    writes.push({ ratingId, payload, titleId });
  }

  return { writes, unresolvedCount: unresolved.length, unresolved };
}

// Accepts either a Map or a plain object keyed by tmdbId. Normalizes keys to
// Number so a string tmdbId from JSON never misses a numeric map key.
function toMap(obj) {
  const map = new Map();
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      const n = Number(k);
      if (Number.isFinite(n) && v) map.set(n, v);
    }
  }
  return map;
}

module.exports = {
  makeRatingId,
  resolveTraktRatingWrites,
};
