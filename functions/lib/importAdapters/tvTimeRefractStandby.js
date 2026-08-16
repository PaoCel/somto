"use strict";

// Manual-import Storage-upload session helpers (originally TV Time "Refract"
// only — hence the filename — now shared by every large-payload source).
//
// WHY Storage instead of the callable request body: some import payloads grow
// large enough to blow Firestore's 1MB per-document field limit (the
// startTitlesImport transport stores the raw CSV/JSON inside a Firestore doc).
// TV Time Refract JSON was the first (verbose per-episode metadata for every
// followed show); TV Time GDPR CSVs and Netflix CSVs hit the same wall for big
// libraries (a real 7128-row GDPR export carried a 1.56MB series CSV). Those
// sources upload their raw files directly to Cloud Storage
// (createTitlesImportUploadSession + finalizeTitlesImportUpload in index.js)
// and the server downloads them (downloadStorageText) instead of reading a
// Firestore doc field. Actual parsing lives in the per-source adapters; actual
// matching+writing is shared via the resumable tick worker (index.js). This
// module only derives the Storage paths for the upload session and normalizes
// which files the client says it's sending.

const { safeString } = require("../../modules/tmdb");

function toId(value) {
  return String(value || "").trim();
}

// Per-source filename map. The client uploads under fixed, whitelisted
// filenames (storage.rules gates writes to exactly these) — never an
// arbitrary client-supplied string in a Storage path. `movies`/`series` are
// the two core files; the rest are OPTIONAL vote/comment CSVs (TV Time GDPR
// only) whose absence never blocks the core viewing-history import.
const MANUAL_IMPORT_FILENAMES = {
  tvtime_refract: { movies: "movies.json", series: "series.json" },
  tvtime_gdpr: {
    movies: "movies.csv",
    series: "series.csv",
    episodeVotes: "episode_votes.csv",   // ratings-3-prod-episode_votes.csv -> episode RATINGS
    movieRatings: "movie_ratings.csv",   // ratings-live-votes.csv           -> movie RATINGS
    showRatings: "show_ratings.csv",     // tv_show_rate.csv                 -> SERIES ratings
    movieVotes: "movie_votes.csv",       // emotions-live-votes.csv          -> movie EMOTIONS (stash, not a rating)
    movieComments: "movie_comments.csv",
    episodeComments: "episode_comments.csv",
    lists: "lists.csv",                  // lists-prod-lists.csv             -> custom userLists
  },
  netflix_csv: { netflix: "netflix.csv" },
};

const OPTIONAL_GDPR_KINDS = ["episodeVotes", "movieRatings", "movieVotes", "movieComments", "episodeComments", "lists", "showRatings"];

function filenameMapForSource(source) {
  return MANUAL_IMPORT_FILENAMES[source] || MANUAL_IMPORT_FILENAMES.tvtime_refract;
}

/**
 * Storage paths for a manual-import upload session — always under
 * `manualImports/{uid}/{importId}/{fileName}` (see storage.rules'
 * `canWriteManualImportUpload`, which gates writes to exactly the whitelisted
 * filenames). Only includes the keys the caller actually requested
 * (`fileKinds`), so a movies-only or series-only export doesn't reserve an
 * unused path.
 */
function manualImportStoragePaths(uid, importId, fileKinds = [], source = "tvtime_refract") {
  const cleanUid = toId(uid);
  const cleanImportId = toId(importId);
  const nameMap = filenameMapForSource(source);
  const kinds = new Set(Array.isArray(fileKinds) ? fileKinds : []);
  const basePath = `manualImports/${cleanUid}/${cleanImportId}`;
  const storagePaths = {};
  for (const kind of kinds) {
    if (nameMap[kind]) storagePaths[kind] = `${basePath}/${nameMap[kind]}`;
  }
  return storagePaths;
}

/**
 * Normalizes the callable's `has*` booleans (+ legacy `fileKinds` array, if
 * ever sent directly) into a deduped, whitelisted subset of the source's
 * valid file kinds — never trusts an arbitrary client-supplied string into a
 * Storage path.
 */
function normalizeManualImportFileKinds(data = {}, source = "tvtime_refract") {
  const nameMap = filenameMapForSource(source);
  const valid = new Set(Object.keys(nameMap));
  const kinds = new Set();

  const rawKinds = Array.isArray(data.fileKinds) ? data.fileKinds : [];
  for (const item of rawKinds) {
    const clean = safeString(item, 20).trim();
    if (valid.has(clean)) kinds.add(clean);
  }
  if (data.hasMovies === true && valid.has("movies")) kinds.add("movies");
  if (data.hasSeries === true && valid.has("series")) kinds.add("series");
  if (data.hasNetflix === true && valid.has("netflix")) kinds.add("netflix");
  for (const kind of OPTIONAL_GDPR_KINDS) {
    // has + PascalCase(kind), e.g. hasEpisodeVotes
    const flag = `has${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
    if (data[flag] === true && valid.has(kind)) kinds.add(kind);
  }
  return Array.from(kinds);
}

module.exports = {
  MANUAL_IMPORT_FILENAMES,
  filenameMapForSource,
  manualImportStoragePaths,
  normalizeManualImportFileKinds,
};
