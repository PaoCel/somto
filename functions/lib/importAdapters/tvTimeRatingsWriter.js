"use strict";

// Resolves merged TV Time vote+comment "rating intents" (tvTimeRatings.js's
// mergeVotesAndComments output) to Somto `ratings/{id}` write payloads. PURE
// logic only: no Firestore reads/writes here — callers (the
// processTitlesImportJob trigger in functions/index.js, which already has a
// `db`/admin SDK context) supply a name->titleId resolution map (built from
// the SAME matching cascade results already computed for the main
// viewing-history import, so this never re-runs TMDB search) and receive
// back a list of ready-to-write rating docs.
//
// Mirrors the id scheme from public/js/api/ratings.api.js#makeRatingId
// EXACTLY (same safePart() sanitization, same field order/join) so a rating
// imported here and one the user later edits via the app land on the SAME
// doc id — no duplicate ratings for the same (uid, titleId, level, season,
// episode).

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

function normalizeNameKey(name) {
  return String(name || "").trim().toLowerCase();
}

/**
 * Builds a lookup key identical to tvTimeRatings.js's mergeVotesAndComments
 * itemKey(), so the SAME normalized key derived from a vote/comment row
 * matches the key built here from the main import's resolved rows.
 */
function intentLookupKey(intent) {
  return intent.kind === "movie"
    ? `movie|${normalizeNameKey(intent.movieNameGuess)}`
    : `tv|${normalizeNameKey(intent.seriesNameGuess)}|${intent.seasonNumber}|${intent.episodeNumber}`;
}

/**
 * Builds a name->titleId resolution map from the main import's already-
 * resolved matchResults (functions/index.js's runTitlesImportPipeline
 * output: Array<{ row, match }>). Only rows that resolved successfully
 * contribute an entry — unresolved rows simply don't produce a key, so a
 * vote/comment for an unmatched title is naturally left unresolved too
 * (never silently guessed).
 */
function buildTitleResolutionMap(matchResults) {
  const map = new Map();
  for (const { row, match } of matchResults) {
    if (!match?.resolved || !match?.titleId) continue;
    if (row.kind === "movie") {
      map.set(`movie|${normalizeNameKey(row.movieNameGuess)}`, match.titleId);
    } else if (row.kind === "tv_episode") {
      map.set(`tv|${normalizeNameKey(row.seriesNameGuess)}|${row.seasonNumber}|${row.episodeNumber}`, match.titleId);
    }
  }
  return map;
}

/**
 * Resolves each rating intent to a titleId using the resolution map, and
 * builds the exact Firestore payload for `ratings/{id}` (matching the
 * client's upsertRating() shape + a `source` marker so downstream trigger
 * guards can recognize import-origin ratings — see the module docstring in
 * functions/index.js's processTvTimeRatingsAndComments for why that marker
 * exists: suppressing social fan-out on a historical bulk import).
 *
 * Returns { writes, unresolvedCount } — `writes` is
 * Array<{ ratingId, payload }>; `unresolvedCount` counts intents whose
 * movie/series name never matched a titles/{id} doc (not silently dropped,
 * counted for the import summary).
 */
function resolveRatingWrites({ uid, intents, titleResolutionMap, now }) {
  const writes = [];
  let unresolvedCount = 0;

  for (const intent of intents) {
    const key = intentLookupKey(intent);
    const titleId = titleResolutionMap.get(key);
    if (!titleId) {
      unresolvedCount += 1;
      continue;
    }

    const level = intent.kind === "movie" ? "title" : "episode";
    const season = intent.kind === "movie" ? null : intent.seasonNumber;
    const episode = intent.kind === "movie" ? null : intent.episodeNumber;
    const ratingId = makeRatingId({ uid, titleId, level, season, episode });

    const payload = {
      uid,
      titleId,
      level,
      season,
      episode,
      rating: intent.decimalRating,
      updatedAt: now,
      createdAt: now,
      source: "import_tvtime_gdpr",
    };
    if (intent.reviewText) {
      payload.reviewText = String(intent.reviewText).slice(0, 5000);
    }
    if (intent.containsSpoiler) {
      payload.containsSpoiler = true;
      payload.spoilerTitleIds = [titleId];
    }

    writes.push({ ratingId, payload, titleId });
  }

  return { writes, unresolvedCount };
}

module.exports = {
  makeRatingId,
  intentLookupKey,
  buildTitleResolutionMap,
  resolveRatingWrites,
};
