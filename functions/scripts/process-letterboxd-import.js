#!/usr/bin/env node
/**
 * Manual Letterboxd import runner for supportImports uploads.
 *
 * Safety model:
 *   - read-only dry-run by default;
 *   - exact Storage object + generation pin;
 *   - plan hash must be supplied to every mutating phase;
 *   - title preparation is separate from user-data writes;
 *   - immutable schema-v2 snapshots before user mutations;
 *   - existing ratings are never overwritten;
 *   - reviews/comments/profile/likes/deleted/orphaned are never read;
 *   - finalization, upload deletion and support message are a separate phase.
 *
 * Examples (from functions/):
 *   node scripts/process-letterboxd-import.js \
 *     --uid=UID --object=supportImports/UID/letterboxd-....zip
 *
 *   node scripts/process-letterboxd-import.js \
 *     --uid=UID --object=... --generation=... --prepare-titles \
 *     --plan=SHA256 --confirm-project=gia-visto
 *
 *   node scripts/process-letterboxd-import.js \
 *     --uid=UID --object=... --generation=... --write \
 *     --plan=SHA256 --confirm-project=gia-visto
 *
 *   node scripts/process-letterboxd-import.js \
 *     --uid=UID --finalize=IMPORT_ID --write --confirm-project=gia-visto \
 *     --delete-upload --notify
 *
 *   node scripts/process-letterboxd-import.js \
 *     --uid=UID --rollback=IMPORT_ID --write --confirm-project=gia-visto
 */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const admin = require("firebase-admin");

const ROOT = path.resolve(__dirname, "..");
const { parseLetterboxdCsvBundle, PARSER_VERSION } = require("../lib/importAdapters/letterboxd");
const {
  CSV_PATHS_TO_READ,
  MAX_ENTRY_BYTES,
  parseZipInfoListing,
  validateArchiveEntries,
  resolveLetterboxdFilm,
  resolveTmdbMovieByExactNameYear,
} = require("../lib/importAdapters/letterboxdArchive");
const { matchViaTmdbId } = require("../lib/importAdapters/matching");
const { buildImportTitleStateWrites } = require("../lib/importAdapters/writeTitleStates");
const {
  buildNextTitleState,
  buildLegacyLibraryProjection,
  buildLegacyWatchlistProjection,
} = require("../lib/titleStates");
const { recomputeUserStatsForUid } = require("../lib/userStats");

const PROJECT_ID = "gia-visto";
const BUCKET_NAME = "gia-visto.firebasestorage.app";
const SOURCE = "letterboxd";
const REVIEWS_SOURCE = "letterboxd_reviews";
const IMPORT_SOURCE = "import_letterboxd";
const SNAPSHOT_SCHEMA_VERSION = 2;
const RUNNER_VERSION = 2;
const REVIEWS_RUNNER_VERSION = 1;
const RESOLVE_CONCURRENCY = 4;

loadLocalEnv();

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const value = (name) => {
  const prefix = `--${name}=`;
  const hit = args.find((entry) => entry.startsWith(prefix));
  return hit ? hit.slice(prefix.length).trim() : "";
};

const UID = value("uid");
const OBJECT_PATH = value("object");
const REQUESTED_GENERATION = value("generation");
const PLAN_HASH = value("plan");
const PREPARE_TITLES = has("prepare-titles");
const WRITE = has("write");
const FINALIZE_ID = value("finalize");
const ROLLBACK_ID = value("rollback");
const CONFIRM_PROJECT = value("confirm-project");
const DELETE_UPLOAD = has("delete-upload");
const NOTIFY = has("notify");
const REVIEWS = has("reviews");
const ROLLBACK_REVIEWS_ID = value("rollback-reviews");

if (!UID) fail("--uid è obbligatorio");
if (!/^[A-Za-z0-9_-]{10,160}$/.test(UID)) fail("--uid non valido");
if ([PREPARE_TITLES, Boolean(FINALIZE_ID), Boolean(ROLLBACK_ID), Boolean(ROLLBACK_REVIEWS_ID),
  WRITE && !FINALIZE_ID && !ROLLBACK_ID && !ROLLBACK_REVIEWS_ID]
  .filter(Boolean).length > 1) {
  fail("Scegli una sola fase mutante: --prepare-titles, --write, --finalize, --rollback o --rollback-reviews");
}
if (REVIEWS && (PREPARE_TITLES || FINALIZE_ID || ROLLBACK_ID || ROLLBACK_REVIEWS_ID)) {
  fail("--reviews si combina solo con il dry-run o con --write");
}
if (ROLLBACK_REVIEWS_ID && !WRITE) fail("--rollback-reviews richiede --write");
if (ROLLBACK_REVIEWS_ID && CONFIRM_PROJECT !== PROJECT_ID) {
  fail("--rollback-reviews richiede --confirm-project=gia-visto");
}
if (ROLLBACK_REVIEWS_ID && (OBJECT_PATH || REQUESTED_GENERATION || PLAN_HASH)) {
  fail("--rollback-reviews usa i target salvati nell'import; non passare object/generation/plan");
}
if ((PREPARE_TITLES || WRITE) && CONFIRM_PROJECT !== PROJECT_ID) {
  fail("Le fasi mutanti richiedono --confirm-project=gia-visto");
}
if ((PREPARE_TITLES || (WRITE && !FINALIZE_ID && !ROLLBACK_ID && !ROLLBACK_REVIEWS_ID)) && !PLAN_HASH) {
  fail("La fase mutante richiede --plan=<hash del dry-run>");
}
if ((PREPARE_TITLES || (WRITE && !FINALIZE_ID && !ROLLBACK_ID && !ROLLBACK_REVIEWS_ID)) && !REQUESTED_GENERATION) {
  fail("La fase mutante richiede --generation=<generation del dry-run>");
}
if ((FINALIZE_ID || ROLLBACK_ID) && !WRITE) fail("--finalize/--rollback richiede --write");
if ((FINALIZE_ID || ROLLBACK_ID) && (OBJECT_PATH || REQUESTED_GENERATION || PLAN_HASH || PREPARE_TITLES)) {
  fail("--finalize/--rollback usa i target salvati nell'import; non passare object/generation/plan");
}
if (!FINALIZE_ID && !ROLLBACK_ID && !ROLLBACK_REVIEWS_ID && !OBJECT_PATH) fail("--object è obbligatorio");

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: PROJECT_ID,
  storageBucket: BUCKET_NAME,
});

const db = admin.firestore();
const bucket = admin.storage().bucket(BUCKET_NAME);
const Timestamp = admin.firestore.Timestamp;
const FieldValue = admin.firestore.FieldValue;

function fail(message) {
  console.error(`ERRORE: ${message}`);
  process.exit(1);
}

function loadLocalEnv() {
  for (const file of [path.join(ROOT, ".env"), path.join(ROOT, ".env.production")]) {
    if (!fs.existsSync(file)) continue;
    for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const index = line.indexOf("=");
      const key = line.slice(0, index).trim();
      const rawValue = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key && process.env[key] == null) process.env[key] = rawValue;
    }
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalize(value) {
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return { __date: value.toISOString() };
  if (value instanceof Timestamp) return { __timestamp: [value.seconds, value.nanoseconds] };
  if (Buffer.isBuffer(value)) return { __buffer: value.toString("base64") };
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return String(value);
}

function dataHash(data) {
  return data == null ? null : sha256(JSON.stringify(canonicalize(data)));
}

function envelope(snapshot) {
  const data = snapshot?.exists ? (snapshot.data() || {}) : null;
  return { existed: Boolean(snapshot?.exists), data, hash: dataHash(data) };
}

function envelopeMatches(snapshot, expected) {
  if (!expected?.existed) return !snapshot.exists;
  return snapshot.exists && dataHash(snapshot.data() || {}) === expected.hash;
}

function makeRatingId(uid, titleId) {
  const safe = (raw) => String(raw ?? "0").replace(/[^a-zA-Z0-9_-]/g, "_");
  return [safe(uid), safe(titleId), "title", "0", "0"].join("__");
}

async function mapLimit(items, limit, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  async function run() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return output;
}

async function resolveFilmWithRetry(uri, attempts = 3) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await resolveLetterboxdFilm(uri);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) {
        // Short bounded backoff for transient Letterboxd throttling/network
        // failures. The whole preflight still fails closed after 3 attempts.
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

async function fetchAll(refs, chunkSize = 100) {
  const output = [];
  for (let i = 0; i < refs.length; i += chunkSize) {
    // eslint-disable-next-line no-await-in-loop
    output.push(...await db.getAll(...refs.slice(i, i + chunkSize)));
  }
  return output;
}

function validateObjectTarget(objectPath) {
  const expectedPrefix = `supportImports/${UID}/`;
  if (!objectPath.startsWith(expectedPrefix)) throw new Error("L'object Storage non appartiene all'UID richiesto");
  const basename = objectPath.slice(expectedPrefix.length);
  if (!/^letterboxd-[A-Za-z0-9._-]+\.zip$/i.test(basename)) throw new Error("Nome object Letterboxd non valido");
}

async function downloadAndParseArchive(objectPath, requestedGeneration) {
  validateObjectTarget(objectPath);
  const file = bucket.file(objectPath, requestedGeneration ? { generation: requestedGeneration } : undefined);
  const [metadata] = await file.getMetadata();
  const generation = String(metadata.generation || "");
  if (requestedGeneration && generation !== String(requestedGeneration)) throw new Error("Generation Storage diversa da quella richiesta");
  if (String(metadata?.metadata?.source || "") !== "letterboxd_zip") throw new Error("Metadata source Letterboxd mancante");
  const size = Number(metadata.size || 0);
  if (!Number.isSafeInteger(size) || size <= 0 || size >= 30 * 1024 * 1024) throw new Error("Dimensione upload non valida");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "somto-letterboxd-"));
  const zipPath = path.join(tempDir, "export.zip");
  try {
    await file.download({ destination: zipPath });
    const archiveBuffer = fs.readFileSync(zipPath);
    if (archiveBuffer.length !== size) throw new Error("Dimensione ZIP scaricata incoerente");
    if (archiveBuffer.subarray(0, 4).toString("hex") !== "504b0304") throw new Error("Magic bytes ZIP non validi");

    const listing = execFileSync("zipinfo", ["-l", zipPath], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
    const archiveSummary = validateArchiveEntries(parseZipInfoListing(listing));
    execFileSync("unzip", ["-tqq", zipPath], { stdio: "ignore", timeout: 30_000 });

    const csvFiles = {};
    for (const csvPath of CSV_PATHS_TO_READ) {
      try {
        csvFiles[csvPath] = execFileSync("unzip", ["-p", zipPath, csvPath], {
          encoding: "utf8",
          maxBuffer: MAX_ENTRY_BYTES + 1024,
          timeout: 30_000,
        });
      } catch (error) {
        if (csvPath === "watched.csv") throw error;
        csvFiles[csvPath] = "";
      }
    }

    return {
      objectPath,
      generation,
      storageMd5Hash: String(metadata.md5Hash || ""),
      archiveSha256: sha256(archiveBuffer),
      archiveBytes: archiveBuffer.length,
      archiveSummary,
      parsed: parseLetterboxdCsvBundle(csvFiles),
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function enrichFilms(parsed) {
  let completed = 0;
  const failures = [];
  const enriched = await mapLimit(parsed.films, RESOLVE_CONCURRENCY, async (film, index) => {
    try {
      let resolved;
      try {
        resolved = await resolveFilmWithRetry(film.letterboxdUri);
        resolved.resolutionStrategy = "letterboxd_tmdb_id";
      } catch (error) {
        if (!String(error?.message || error).includes("TMDB id assente")) throw error;
        resolved = await resolveTmdbMovieByExactNameYear(film.name, film.year, { apiKey: process.env.TMDB_KEY });
      }
      completed += 1;
      if (completed % 25 === 0 || completed === parsed.films.length) {
        console.log(`  Letterboxd -> TMDB ${completed}/${parsed.films.length}`);
      }
      return { ...film, ...resolved };
    } catch (error) {
      failures.push({ index, reason: String(error?.message || error).slice(0, 180) });
      return { ...film, resolutionError: true };
    }
  });
  return { enriched, failures };
}

function buildPlan(archive, enriched) {
  const planData = {
    parserVersion: PARSER_VERSION,
    uid: UID,
    objectPath: archive.objectPath,
    generation: archive.generation,
    archiveSha256: archive.archiveSha256,
    films: enriched.map((film) => ({
      uri: film.letterboxdUri,
      name: film.name,
      year: film.year,
      tmdbId: film.tmdbId,
      mediaType: film.mediaType,
      resolutionStrategy: film.resolutionStrategy,
      watched: film.watched,
      watchedDate: film.watchedDate?.toISOString?.() || null,
      watchlist: film.watchlist,
      watchlistDate: film.watchlistDate?.toISOString?.() || null,
      rating: film.rating,
      ratingDate: film.ratingDate?.toISOString?.() || null,
      rewatchCount: film.rewatchCount,
    })),
  };
  return { data: planData, hash: sha256(JSON.stringify(canonicalize(planData))) };
}

async function currentUserOverlap(enriched) {
  const userRef = db.collection("users").doc(UID);
  const [userSnap, statesSnap, ratingsSnap] = await Promise.all([
    userRef.get(),
    userRef.collection("titleStates").get(),
    db.collection("ratings").where("uid", "==", UID).get(),
  ]);
  if (!userSnap.exists) throw new Error(`users/${UID} non trovato`);
  const titleIds = Array.from(new Set([
    ...statesSnap.docs.map((doc) => doc.id),
    ...ratingsSnap.docs.map((doc) => String((doc.data() || {}).titleId || "")).filter(Boolean),
  ]));
  const titleSnaps = await fetchAll(titleIds.map((id) => db.collection("titles").doc(id)));
  const tmdbByTitleId = new Map(titleSnaps.filter((snap) => snap.exists).map((snap) => {
    const data = snap.data() || {};
    return [snap.id, `${String(data.type || data.mediaType || "movie").toLowerCase() === "tv" ? "tv" : "movie"}:${Number(data.tmdbId) || 0}`];
  }));
  const incoming = new Map(enriched.map((film) => [
    `${film.mediaType}:${film.tmdbId}`,
    { name: film.name, year: film.year, letterboxdUri: film.letterboxdUri },
  ]));
  const overlappingStateDetails = statesSnap.docs.flatMap((doc) => {
    const tmdbKey = tmdbByTitleId.get(doc.id);
    return incoming.has(tmdbKey) ? [{ titleId: doc.id, tmdbKey, ...incoming.get(tmdbKey) }] : [];
  });
  const overlappingRatingDetails = ratingsSnap.docs.flatMap((doc) => {
    const titleId = String((doc.data() || {}).titleId || "");
    const tmdbKey = tmdbByTitleId.get(titleId);
    return incoming.has(tmdbKey) ? [{ titleId, tmdbKey, ...incoming.get(tmdbKey) }] : [];
  });
  return {
    displayName: String((userSnap.data() || {}).displayName || ""),
    existingTitleStates: statesSnap.size,
    existingRatings: ratingsSnap.size,
    overlappingStates: overlappingStateDetails.length,
    overlappingRatings: overlappingRatingDetails.length,
    overlappingStateDetails,
    overlappingRatingDetails,
  };
}

async function runPreflight() {
  console.log("[letterboxd] validazione ZIP e parsing CSV");
  const archive = await downloadAndParseArchive(OBJECT_PATH, REQUESTED_GENERATION);
  if (archive.parsed.unlinkedDiary.length || archive.parsed.ambiguousDiary.length) {
    throw new Error(`Diary non collegabile: unlinked=${archive.parsed.unlinkedDiary.length}, ambiguous=${archive.parsed.ambiguousDiary.length}`);
  }
  console.log(`[letterboxd] ${archive.parsed.summary.distinctFilms} film distinti; risoluzione TMDB in corso`);
  const { enriched, failures } = await enrichFilms(archive.parsed);
  if (failures.length) {
    const failureReasons = {};
    for (const failure of failures) failureReasons[failure.reason] = (failureReasons[failure.reason] || 0) + 1;
    console.log(JSON.stringify({ resolutionFailures: failures.length, failureReasons }, null, 2));
    throw new Error("Preflight bloccato: tutti i titoli devono risolversi su TMDB");
  }
  const tmdbKeys = new Set(enriched.map((film) => `${film.mediaType}:${film.tmdbId}`));
  if (tmdbKeys.size !== enriched.length) throw new Error("Più URI Letterboxd convergono sullo stesso TMDB id");
  const plan = buildPlan(archive, enriched);
  const overlap = await currentUserOverlap(enriched);
  return { archive, enriched, plan, overlap };
}

function assertPlan(plan, archive) {
  if (plan.hash !== PLAN_HASH) throw new Error(`Plan hash diverso. Atteso dal dry-run: ${plan.hash}`);
  if (archive.generation !== REQUESTED_GENERATION) throw new Error("Generation diversa dal dry-run");
}

async function resolveSomtoTitles(enriched) {
  const logicalDupCache = new Map();
  const byUri = new Map();
  let index = 0;
  for (const film of enriched) {
    // eslint-disable-next-line no-await-in-loop
    const match = await matchViaTmdbId(db, bucket, film.tmdbId, film.mediaType, { logicalDupCache });
    if (!match?.titleId || !match?.title) throw new Error(`TMDB ${film.tmdbId} non preparato`);
    byUri.set(film.letterboxdUri, match);
    index += 1;
    if (index % 25 === 0 || index === enriched.length) console.log(`  titoli Somto ${index}/${enriched.length}`);
  }
  if (new Set(Array.from(byUri.values()).map((match) => match.titleId)).size !== enriched.length) {
    throw new Error("Più titoli Letterboxd convergono sullo stesso titleId Somto");
  }
  return byUri;
}

async function prepareTitles(preflight) {
  assertPlan(preflight.plan, preflight.archive);
  console.log("[letterboxd] preparazione titoli globale (nessun dato utente)");
  const matches = await resolveSomtoTitles(preflight.enriched);
  console.log(JSON.stringify({ preparedTitles: matches.size, planHash: preflight.plan.hash }, null, 2));
}

async function captureCurrentRecords(titleIds, ratedTitleIds) {
  const userRef = db.collection("users").doc(UID);
  const stateRefs = titleIds.map((id) => userRef.collection("titleStates").doc(id));
  const libraryRefs = titleIds.map((id) => userRef.collection("library").doc(id));
  const watchlistRefs = titleIds.map((id) => userRef.collection("watchlist").doc(id));
  const [stateSnaps, librarySnaps, watchlistSnaps, allRatingsSnap] = await Promise.all([
    fetchAll(stateRefs),
    fetchAll(libraryRefs),
    fetchAll(watchlistRefs),
    db.collection("ratings").where("uid", "==", UID).get(),
  ]);
  const rated = new Set(ratedTitleIds);
  const ratingSnaps = allRatingsSnap.docs.filter((snap) => {
    const data = snap.data() || {};
    const level = String(data.level || "title");
    return level === "title" && rated.has(String(data.titleId || ""));
  });
  return {
    states: new Map(stateSnaps.map((snap) => [snap.id, envelope(snap)])),
    library: new Map(librarySnaps.map((snap) => [snap.id, envelope(snap)])),
    watchlist: new Map(watchlistSnaps.map((snap) => [snap.id, envelope(snap)])),
    // Query by uid+titleId semantics rather than only by the modern
    // deterministic document id: legacy ratings may have random doc ids.
    ratings: new Map(ratingSnaps.map((snap) => [
      String((snap.data() || {}).titleId || ""),
      { ...envelope(snap), documentId: snap.id },
    ])),
  };
}

async function persistSnapshots({ importRef, titleIds, ratedTitleIds, current, plannedStates }) {
  const rated = new Set(ratedTitleIds);
  const capturedAt = Timestamp.now();
  const writer = db.bulkWriter();
  const operations = [];
  for (const titleId of titleIds) {
    const payload = {
      titleId,
      existed: current.states.get(titleId)?.existed === true,
      state: current.states.get(titleId) || { existed: false, data: null, hash: null },
      library: current.library.get(titleId) || { existed: false, data: null, hash: null },
      watchlist: current.watchlist.get(titleId) || { existed: false, data: null, hash: null },
      rating: rated.has(titleId)
        ? (current.ratings.get(titleId) || { existed: false, data: null, hash: null })
        : null,
      plannedStateHash: dataHash(plannedStates.get(titleId)),
      capturedAt,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    };
    operations.push(writer.create(importRef.collection("previousStates").doc(titleId), payload)
      .catch((error) => {
        const code = String(error?.code || "").toLowerCase();
        if (code === "6" || code.includes("already")) return;
        throw error;
      }));
  }
  await writer.close();
  await Promise.all(operations);
  const countSnap = await importRef.collection("previousStates").count().get();
  const count = Number(countSnap.data().count || 0);
  if (count !== titleIds.length) throw new Error(`Snapshot incompleto: ${count}/${titleIds.length}`);
  await importRef.set({
    previousStateSnapshot: {
      storage: "subcollection_v2",
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      status: "ready",
      count,
      capturedAt,
      verifiedAt: FieldValue.serverTimestamp(),
    },
  }, { merge: true });
  return count;
}

function buildImportRows(preflight, matchByUri) {
  const filmByUri = new Map(preflight.enriched.map((film) => [film.letterboxdUri, film]));
  return preflight.archive.parsed.rows.map((row) => {
    const match = matchByUri.get(row.letterboxdUri);
    const film = filmByUri.get(row.letterboxdUri);
    const isWholeTvTitle = film?.mediaType === "tv" && row.watchedDate instanceof Date;
    return {
      titleId: match.titleId,
      title: match.title,
      row: {
        ...row,
        kind: isWholeTvTitle ? "tv_episode" : row.kind,
        wholeTitleCompleted: isWholeTvTitle || undefined,
        mediaTypeHint: film?.mediaType || row.mediaTypeHint,
        tmdbId: Number(match.title.tmdbId) || null,
      },
    };
  });
}

async function applyStateRecord({ importRef, titleId, plannedState, snapshot }) {
  const userRef = db.collection("users").doc(UID);
  const stateRef = userRef.collection("titleStates").doc(titleId);
  const libraryRef = userRef.collection("library").doc(titleId);
  const watchlistRef = userRef.collection("watchlist").doc(titleId);
  const plannedLibrary = buildLegacyLibraryProjection(plannedState);
  const plannedWatchlist = buildLegacyWatchlistProjection(plannedState);

  return db.runTransaction(async (tx) => {
    const [stateSnap, librarySnap, watchlistSnap] = await Promise.all([
      tx.get(stateRef), tx.get(libraryRef), tx.get(watchlistRef),
    ]);
    const alreadyApplied = stateSnap.exists
      && dataHash(stateSnap.data() || {}) === dataHash(plannedState)
      && (plannedLibrary ? (librarySnap.exists && dataHash(librarySnap.data() || {}) === dataHash(plannedLibrary)) : !librarySnap.exists)
      && (plannedWatchlist ? (watchlistSnap.exists && dataHash(watchlistSnap.data() || {}) === dataHash(plannedWatchlist)) : !watchlistSnap.exists);
    if (alreadyApplied) return "already";
    if (
      !envelopeMatches(stateSnap, snapshot.state)
      || !envelopeMatches(librarySnap, snapshot.library)
      || !envelopeMatches(watchlistSnap, snapshot.watchlist)
    ) return "conflict";

    tx.set(stateRef, plannedState, { merge: true });
    if (plannedLibrary) tx.set(libraryRef, plannedLibrary, { merge: true });
    else if (librarySnap.exists) tx.delete(libraryRef);
    if (plannedWatchlist) tx.set(watchlistRef, plannedWatchlist, { merge: true });
    else if (watchlistSnap.exists) tx.delete(watchlistRef);
    tx.set(importRef.collection("items").doc(titleId), {
      titleId,
      resolved: true,
      stateApplyStatus: "applied",
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return "applied";
  });
}

async function applyRatingRecord({ importRef, importId, titleId, ratingIntent, snapshot }) {
  const ratingId = makeRatingId(UID, titleId);
  const ratingRef = db.collection("ratings").doc(ratingId);
  if (snapshot?.rating?.existed) {
    await importRef.collection("items").doc(titleId).set({
      ratingApplyStatus: "preserved_existing",
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return "preserved";
  }
  return db.runTransaction(async (tx) => {
    const current = await tx.get(ratingRef);
    if (current.exists) {
      const data = current.data() || {};
      if (data.source === IMPORT_SOURCE && data.importId === importId) return "already";
      tx.set(importRef.collection("items").doc(titleId), {
        ratingApplyStatus: "preserved_race",
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return "preserved";
    }
    tx.create(ratingRef, {
      uid: UID,
      titleId,
      level: "title",
      season: null,
      episode: null,
      rating: ratingIntent.rating,
      createdAt: ratingIntent.ratedAt,
      updatedAt: ratingIntent.ratedAt,
      source: IMPORT_SOURCE,
      importId,
      importedAt: FieldValue.serverTimestamp(),
    });
    tx.set(importRef.collection("items").doc(titleId), {
      ratingApplyStatus: "created",
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return "created";
  });
}

async function applyImport(preflight) {
  assertPlan(preflight.plan, preflight.archive);
  console.log("[letterboxd] risoluzione titoli Somto preparati");
  const matchByUri = await resolveSomtoTitles(preflight.enriched);
  const importId = `letterboxd_${preflight.archive.archiveSha256.slice(0, 24)}_r${RUNNER_VERSION}`;
  const userRef = db.collection("users").doc(UID);
  const importRef = userRef.collection("imports").doc(importId);
  const existingImport = await importRef.get();
  const existingImportData = existingImport.data() || {};
  if (existingImport.exists) {
    const data = existingImportData;
    if (data.planHash !== preflight.plan.hash) throw new Error("Import ID esistente con plan hash diverso");
    if (["completed", "rolled_back"].includes(data.status)) throw new Error(`Import già ${data.status}`);
  }

  const importRows = buildImportRows(preflight, matchByUri);
  const watchedRows = importRows.filter((entry) => entry.row.watchlistOnly !== true);
  const watchlistRows = importRows.filter((entry) => entry.row.watchlistOnly === true);
  const titleIds = importRows.map((entry) => entry.titleId);
  const ratingIntentByTitleId = new Map();
  for (const intent of preflight.archive.parsed.ratingIntents) {
    const match = matchByUri.get(intent.letterboxdUri);
    ratingIntentByTitleId.set(match.titleId, intent);
  }
  const ratedTitleIds = Array.from(ratingIntentByTitleId.keys());
  const current = await captureCurrentRecords(titleIds, ratedTitleIds);
  const currentStates = new Map(titleIds.map((id) => [id, current.states.get(id)?.data || null]));
  const planNow = existingImportData.planAppliedAt?.toDate?.() || new Date();

  const stateWrites = buildImportTitleStateWrites(watchedRows, currentStates, {
    now: planNow,
    source: SOURCE,
    countDuplicateRewatches: true,
    countExistingAsRewatch: false,
  });
  const plannedStates = new Map(stateWrites.map(({ titleId, next }) => [titleId, next]));
  for (const { titleId, title } of watchlistRows) {
    plannedStates.set(titleId, buildNextTitleState(currentStates.get(titleId) || null, {
      type: "toggle_watchlist",
      enabled: true,
      source: IMPORT_SOURCE,
    }, { ...(title || {}), id: titleId }, { now: planNow }));
  }
  if (plannedStates.size !== titleIds.length) throw new Error("Piano titleStates incompleto");

  const userSnap = await userRef.get();
  if (!userSnap.exists) throw new Error("Utente target non trovato");
  const parentPayload = {
    source: SOURCE,
    status: "snapshotting",
    parserVersion: PARSER_VERSION,
    runnerVersion: RUNNER_VERSION,
    planHash: preflight.plan.hash,
    archiveSha256: preflight.archive.archiveSha256,
    supportStorageObject: preflight.archive.objectPath,
    supportStorageGeneration: preflight.archive.generation,
    totalRows: preflight.archive.parsed.summary.distinctFilms,
    matchedCount: titleIds.length,
    unresolvedCount: 0,
    errorCount: 0,
    previousUserStats: (userSnap.data() || {}).stats || null,
    planAppliedAt: Timestamp.fromDate(planNow),
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (!existingImport.exists) await importRef.create({ ...parentPayload, startedAt: FieldValue.serverTimestamp() });
  else await importRef.set(parentPayload, { merge: true });

  console.log("[letterboxd] snapshot immutabile pre-write");
  await persistSnapshots({ importRef, titleIds, ratedTitleIds, current, plannedStates });
  const itemWriter = db.bulkWriter();
  for (const entry of importRows) {
    itemWriter.set(importRef.collection("items").doc(entry.titleId), {
      itemId: entry.titleId,
      titleId: entry.titleId,
      tmdbId: Number(entry.title.tmdbId) || null,
      refKind: String(entry.title.type || entry.title.meta?.mediaType || "movie") === "tv" ? "tv" : "movie",
      watchlistOnly: entry.row.watchlistOnly === true,
      resolved: true,
      stateApplyStatus: "planned",
      ratingApplyStatus: ratingIntentByTitleId.has(entry.titleId) ? "planned" : "none",
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  await itemWriter.close();
  await importRef.set({ status: "applying", updatedAt: FieldValue.serverTimestamp() }, { merge: true });

  const snapshots = await importRef.collection("previousStates").get();
  const snapshotByTitleId = new Map(snapshots.docs.map((doc) => [doc.id, doc.data() || {}]));
  const stateCounts = { applied: 0, already: 0, conflict: 0 };
  let processed = 0;
  for (const titleId of titleIds) {
    // eslint-disable-next-line no-await-in-loop
    const result = await applyStateRecord({
      importRef,
      titleId,
      plannedState: plannedStates.get(titleId),
      snapshot: snapshotByTitleId.get(titleId),
    });
    stateCounts[result] += 1;
    processed += 1;
    if (processed % 25 === 0 || processed === titleIds.length) console.log(`  titleStates ${processed}/${titleIds.length}`);
  }

  const ratingCounts = { created: 0, preserved: 0, already: 0 };
  processed = 0;
  for (const [titleId, intent] of ratingIntentByTitleId) {
    // eslint-disable-next-line no-await-in-loop
    const result = await applyRatingRecord({
      importRef,
      importId,
      titleId,
      ratingIntent: intent,
      snapshot: snapshotByTitleId.get(titleId),
    });
    ratingCounts[result] += 1;
    processed += 1;
    if (processed % 25 === 0 || processed === ratingIntentByTitleId.size) console.log(`  ratings ${processed}/${ratingIntentByTitleId.size}`);
  }

  const status = stateCounts.conflict > 0 ? "awaiting_admin_review" : "applied_pending_verification";
  const ratingIdsCreated = [];
  const ratingIdsPreserved = [];
  for (const titleId of ratedTitleIds) {
    const item = await importRef.collection("items").doc(titleId).get();
    if ((item.data() || {}).ratingApplyStatus === "created") ratingIdsCreated.push(makeRatingId(UID, titleId));
    else ratingIdsPreserved.push(makeRatingId(UID, titleId));
  }
  await importRef.set({
    status,
    stateApplySummary: stateCounts,
    ratingsSummary: { ...ratingCounts, requested: ratedTitleIds.length },
    titleStateIdsWritten: titleIds,
    watchedTitleIds: watchedRows.map((entry) => entry.titleId),
    watchlistTitleIds: watchlistRows.map((entry) => entry.titleId),
    ratingIdsCreated,
    ratingIdsPreserved,
    importedTitleCount: titleIds.length,
    updatedAt: FieldValue.serverTimestamp(),
    appliedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  console.log(JSON.stringify({ importId, status, stateCounts, ratingCounts }, null, 2));
  if (stateCounts.conflict > 0) throw new Error("Import parziale: conflitti rilevati, non finalizzare");
}

async function sendSupportCompletionMessage(uid, summary, importId) {
  const supportUid = String(process.env.SUPPORT_UID || process.env.ADMIN_UIDS?.split(",")[0] || "").trim();
  if (!supportUid) throw new Error("SUPPORT_UID non configurato");
  const threadRef = db.collection("threads").doc(`support_${uid}`);
  const threadSnap = await threadRef.get();
  const thread = threadSnap.data() || {};
  const participants = Array.isArray(thread.participants) ? thread.participants : [];
  if (!threadSnap.exists || !participants.includes(uid) || !participants.includes(supportUid)) {
    throw new Error("Thread supporto target non valido");
  }
  const text = `Ciao! Il tuo import da Letterboxd è completato: ${summary.watched} film visti, ${summary.ratings} voti e ${summary.watchlist} titoli in watchlist. Recensioni, commenti e dati del profilo non sono stati importati.`;
  const messageId = `import_${String(importId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120)}`;
  const messageRef = threadRef.collection("messages").doc(messageId);
  if ((await messageRef.get()).exists) return messageId;
  const now = FieldValue.serverTimestamp();
  const batch = db.batch();
  batch.create(messageRef, {
    uid: supportUid,
    displayName: "Assistenza Somto",
    text,
    type: "text",
    createdAt: now,
    containsSpoiler: false,
    spoilerTitleIds: [],
  });
  batch.set(threadRef, {
    lastMessageId: messageRef.id,
    lastMessageAt: now,
    lastMessagePreview: text.slice(0, 100),
    lastSenderUid: supportUid,
  }, { merge: true });
  await batch.commit();
  return messageRef.id;
}

async function finalizeImport(importId) {
  const importRef = db.collection("users").doc(UID).collection("imports").doc(importId);
  const importSnap = await importRef.get();
  if (!importSnap.exists) throw new Error("Import da finalizzare non trovato");
  const data = importSnap.data() || {};
  if (data.source !== SOURCE) throw new Error("Sorgente import non Letterboxd");
  if (!["applied_pending_verification", "completed"].includes(data.status)) throw new Error(`Stato non finalizzabile: ${data.status}`);
  if (data.status === "completed") {
    console.log(JSON.stringify({ importId, status: "completed", idempotent: true }, null, 2));
    return;
  }

  const watchedIds = Array.isArray(data.watchedTitleIds) ? data.watchedTitleIds : [];
  const watchlistIds = Array.isArray(data.watchlistTitleIds) ? data.watchlistTitleIds : [];
  const ratingIds = Array.isArray(data.ratingIdsCreated) ? data.ratingIdsCreated : [];
  const userRef = db.collection("users").doc(UID);
  const [watchedStates, watchlistStates, ratings] = await Promise.all([
    fetchAll(watchedIds.map((id) => userRef.collection("titleStates").doc(id))),
    fetchAll(watchlistIds.map((id) => userRef.collection("titleStates").doc(id))),
    fetchAll(ratingIds.map((id) => db.collection("ratings").doc(id))),
  ]);
  const invalidWatched = watchedStates.filter((snap) => !snap.exists || Number((snap.data() || {}).completedCount || 0) < 1).length;
  const invalidWatchlist = watchlistStates.filter((snap) => {
    if (!snap.exists) return true;
    const state = snap.data() || {};
    return state.generalWatchlist !== true && !["seen_unrated", "rated", "in_progress", "completed_unrated"].includes(state.state);
  }).length;
  const invalidRatings = ratings.filter((snap) => {
    const rating = snap.data() || {};
    return !snap.exists || rating.uid !== UID || rating.source !== IMPORT_SOURCE || rating.importId !== importId;
  }).length;
  if (invalidWatched || invalidWatchlist || invalidRatings) {
    await importRef.set({
      status: "verification_failed",
      verificationSummary: { invalidWatched, invalidWatchlist, invalidRatings },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    throw new Error(`Verifica fallita: watched=${invalidWatched}, watchlist=${invalidWatchlist}, ratings=${invalidRatings}`);
  }

  const stats = await recomputeUserStatsForUid(db, UID);
  const objectPath = String(data.supportStorageObject || "");
  const generation = String(data.supportStorageGeneration || "");
  let uploadDeleted = data?.verificationSummary?.uploadDeleted === true;
  if (DELETE_UPLOAD && !uploadDeleted) {
    validateObjectTarget(objectPath);
    if (!generation) throw new Error("Generation upload assente nel record import");
    const file = bucket.file(objectPath, { generation });
    await file.delete({ ifGenerationMatch: generation });
    uploadDeleted = true;
    await importRef.set({
      verificationSummary: { ...(data.verificationSummary || {}), uploadDeleted: true },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  let supportMessageId = String(data?.verificationSummary?.supportMessageId || "") || null;
  if (NOTIFY && !supportMessageId) {
    supportMessageId = await sendSupportCompletionMessage(UID, {
      watched: watchedIds.length,
      ratings: Number(data?.ratingsSummary?.created || 0) + Number(data?.ratingsSummary?.preserved || 0),
      watchlist: watchlistIds.length,
    }, importId);
  }

  await importRef.set({
    status: "completed",
    verificationSummary: {
      invalidWatched: 0,
      invalidWatchlist: 0,
      invalidRatings: 0,
      stats,
      uploadDeleted,
      supportMessageId,
    },
    completedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  console.log(JSON.stringify({ importId, status: "completed", stats, uploadDeleted, notified: Boolean(supportMessageId) }, null, 2));
}

async function rollbackImport(importId) {
  const userRef = db.collection("users").doc(UID);
  const importRef = userRef.collection("imports").doc(importId);
  const importSnap = await importRef.get();
  if (!importSnap.exists || (importSnap.data() || {}).source !== SOURCE) throw new Error("Import Letterboxd da rollback non trovato");
  await importRef.set({ status: "rolling_back", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  const snapshots = await importRef.collection("previousStates").get();
  let conflicts = 0;

  // Imported ratings were create-only. Delete only documents still carrying
  // this import's marker; a later manual edit must win and is left untouched.
  for (const snap of snapshots.docs) {
    const previous = snap.data() || {};
    if (!previous.rating || previous.rating.existed) continue;
    const ratingRef = db.collection("ratings").doc(makeRatingId(UID, snap.id));
    // eslint-disable-next-line no-await-in-loop
    const current = await ratingRef.get();
    if (!current.exists) continue;
    const rating = current.data() || {};
    if (rating.source === IMPORT_SOURCE && rating.importId === importId) {
      // eslint-disable-next-line no-await-in-loop
      await ratingRef.delete();
    } else conflicts += 1;
  }

  for (const snap of snapshots.docs) {
    const previous = snap.data() || {};
    const titleId = snap.id;
    const stateRef = userRef.collection("titleStates").doc(titleId);
    const libraryRef = userRef.collection("library").doc(titleId);
    const watchlistRef = userRef.collection("watchlist").doc(titleId);
    // eslint-disable-next-line no-await-in-loop
    const current = await stateRef.get();
    const currentData = current.data() || {};
    const safeRatingSyncFromThisImport = Boolean(
      previous.rating
      && previous.rating.existed === false
      && currentData.source === "rating_sync"
    );
    if (
      current.exists
      && currentData.source !== IMPORT_SOURCE
      && dataHash(currentData) !== previous.plannedStateHash
      && !safeRatingSyncFromThisImport
      && !envelopeMatches(current, previous.state)
    ) {
      conflicts += 1;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await db.runTransaction(async (tx) => {
      if (previous.state?.existed) tx.set(stateRef, previous.state.data, { merge: false }); else tx.delete(stateRef);
      if (previous.library?.existed) tx.set(libraryRef, previous.library.data, { merge: false }); else tx.delete(libraryRef);
      if (previous.watchlist?.existed) tx.set(watchlistRef, previous.watchlist.data, { merge: false }); else tx.delete(watchlistRef);
    });
  }
  const stats = await recomputeUserStatsForUid(db, UID);
  const status = conflicts ? "rollback_conflicts" : "rolled_back";
  await importRef.set({ status, rollbackConflicts: conflicts, rollbackStats: stats, rolledBackAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  console.log(JSON.stringify({ importId, status, conflicts, stats }, null, 2));
  if (conflicts) throw new Error("Rollback completato con conflitti; revisione manuale richiesta");
}

// ---------------------------------------------------------------------------
// Reviews phase. Separate from the main import on purpose: watched/ratings/
// watchlist are private data, a review is public content on the title page.
// It only ever fills an EMPTY reviewText on a rating the user already has;
// existing text is never overwritten and no rating is created here.
// ---------------------------------------------------------------------------

function reviewsImportId(archiveSha256) {
  return `letterboxd_reviews_${archiveSha256.slice(0, 24)}_r${REVIEWS_RUNNER_VERSION}`;
}

async function currentTitleRatings() {
  const snap = await db.collection("ratings").where("uid", "==", UID).get();
  const byTitleId = new Map();
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    if (String(data.level || "title") !== "title") continue;
    const titleId = String(data.titleId || "");
    if (!titleId) continue;
    // Legacy ratings may carry random document ids: the deterministic id wins.
    const existing = byTitleId.get(titleId);
    if (!existing || doc.id === makeRatingId(UID, titleId)) byTitleId.set(titleId, doc);
  }
  return byTitleId;
}

function planReviews(preflight, matchByUri, ratingByTitleId) {
  return preflight.archive.parsed.reviewIntents.map((intent) => {
    const match = matchByUri.get(intent.letterboxdUri);
    if (!match?.titleId) throw new Error(`Recensione senza titolo Somto: ${intent.name} (${intent.year})`);
    const ratingSnap = ratingByTitleId.get(match.titleId) || null;
    const currentText = String(ratingSnap?.data()?.reviewText || "").trim();
    let action = "update";
    if (!ratingSnap) action = "skip_no_rating";
    else if (currentText === intent.text) action = "already";
    else if (currentText) action = "skip_existing_review";
    return {
      titleId: match.titleId,
      titleName: String(match.title?.title || match.title?.name || intent.name),
      ratingId: ratingSnap?.id || null,
      intent,
      action,
      snapshot: envelope(ratingSnap),
    };
  });
}

async function applyReviewRecord({ importRef, importId, entry }) {
  const ratingRef = db.collection("ratings").doc(entry.ratingId);
  const outcome = await db.runTransaction(async (tx) => {
    const current = await tx.get(ratingRef);
    if (!current.exists) return "vanished";
    const data = current.data() || {};
    const existingText = String(data.reviewText || "").trim();
    if (existingText === entry.intent.text) return "already";
    if (existingText) return "preserved_race";
    if (!envelopeMatches(current, entry.snapshot)) return "conflict";
    tx.set(ratingRef, {
      reviewText: entry.intent.text,
      reviewSource: IMPORT_SOURCE,
      reviewImportId: importId,
      reviewImportedAt: FieldValue.serverTimestamp(),
      reviewSourceDate: entry.intent.reviewedAt ? Timestamp.fromDate(entry.intent.reviewedAt) : null,
    }, { merge: true });
    return "applied";
  });
  await importRef.collection("items").doc(entry.titleId).set({
    titleId: entry.titleId,
    ratingId: entry.ratingId,
    reviewApplyStatus: outcome,
    reviewLength: entry.intent.text.length,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return outcome;
}

async function applyReviews(preflight) {
  assertPlan(preflight.plan, preflight.archive);
  console.log("[letterboxd] risoluzione titoli Somto per le recensioni");
  const matchByUri = await resolveSomtoTitles(preflight.enriched);
  const ratingByTitleId = await currentTitleRatings();
  const plan = planReviews(preflight, matchByUri, ratingByTitleId);
  const importId = reviewsImportId(preflight.archive.archiveSha256);
  const importRef = db.collection("users").doc(UID).collection("imports").doc(importId);
  const existing = await importRef.get();
  if (existing.exists) {
    const data = existing.data() || {};
    if (data.source !== REVIEWS_SOURCE) throw new Error("Import ID recensioni già usato da un'altra sorgente");
    if (data.planHash !== preflight.plan.hash) throw new Error("Import recensioni esistente con plan hash diverso");
    if (data.status === "rolled_back") throw new Error("Import recensioni già annullato");
  }

  const writable = plan.filter((entry) => entry.action === "update");
  const parentPayload = {
    source: REVIEWS_SOURCE,
    status: "snapshotting",
    parserVersion: PARSER_VERSION,
    runnerVersion: REVIEWS_RUNNER_VERSION,
    planHash: preflight.plan.hash,
    archiveSha256: preflight.archive.archiveSha256,
    supportStorageObject: preflight.archive.objectPath,
    supportStorageGeneration: preflight.archive.generation,
    reviewRows: preflight.archive.parsed.summary.reviewRows,
    plannedCount: writable.length,
    skippedNoRating: plan.filter((entry) => entry.action === "skip_no_rating").length,
    skippedExistingReview: plan.filter((entry) => entry.action === "skip_existing_review").length,
    alreadyCount: plan.filter((entry) => entry.action === "already").length,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (!existing.exists) await importRef.create({ ...parentPayload, startedAt: FieldValue.serverTimestamp() });
  else await importRef.set(parentPayload, { merge: true });

  console.log("[letterboxd] snapshot immutabile dei voti da recensire");
  const capturedAt = Timestamp.now();
  const writer = db.bulkWriter();
  for (const entry of writable) {
    writer.set(importRef.collection("previousReviews").doc(entry.titleId), {
      titleId: entry.titleId,
      ratingId: entry.ratingId,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      rating: entry.snapshot,
      plannedText: entry.intent.text,
      capturedAt,
    }, { merge: false });
  }
  await writer.close();
  const snapshotCount = (await importRef.collection("previousReviews").count().get()).data().count;
  if (snapshotCount !== writable.length) throw new Error("Snapshot recensioni incompleto");
  await importRef.set({ status: "applying", updatedAt: FieldValue.serverTimestamp() }, { merge: true });

  const outcomes = {};
  for (const entry of writable) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await applyReviewRecord({ importRef, importId, entry });
    outcomes[outcome] = (outcomes[outcome] || 0) + 1;
  }
  const failed = Object.entries(outcomes)
    .filter(([outcome]) => !["applied", "already"].includes(outcome))
    .reduce((total, [, count]) => total + count, 0);
  await importRef.set({
    status: failed ? "completed_with_conflicts" : "completed",
    outcomes,
    completedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  console.log(JSON.stringify({ importId, outcomes, failed }, null, 2));
  if (failed) throw new Error("Alcune recensioni non sono state applicate; revisione manuale richiesta");
}

async function rollbackReviews(importId) {
  const importRef = db.collection("users").doc(UID).collection("imports").doc(importId);
  const importSnap = await importRef.get();
  if (!importSnap.exists || (importSnap.data() || {}).source !== REVIEWS_SOURCE) {
    throw new Error("Import recensioni da rollback non trovato");
  }
  await importRef.set({ status: "rolling_back", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  const snapshots = await importRef.collection("previousReviews").get();
  let restored = 0;
  let conflicts = 0;
  for (const snap of snapshots.docs) {
    const previous = snap.data() || {};
    const ratingRef = db.collection("ratings").doc(String(previous.ratingId || ""));
    // eslint-disable-next-line no-await-in-loop
    const current = await ratingRef.get();
    if (!current.exists) continue;
    const data = current.data() || {};
    // Only undo documents still carrying this import's marker with the exact
    // text we wrote: a later manual edit wins and is left untouched.
    if (data.reviewImportId !== importId || String(data.reviewText || "") !== String(previous.plannedText || "")) {
      conflicts += 1;
      continue;
    }
    if (!previous.rating?.existed) { conflicts += 1; continue; }
    // eslint-disable-next-line no-await-in-loop
    await ratingRef.set(previous.rating.data, { merge: false });
    restored += 1;
  }
  const status = conflicts ? "rollback_conflicts" : "rolled_back";
  await importRef.set({
    status,
    rollbackRestored: restored,
    rollbackConflicts: conflicts,
    rolledBackAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  console.log(JSON.stringify({ importId, status, restored, conflicts }, null, 2));
  if (conflicts) throw new Error("Rollback recensioni completato con conflitti; revisione manuale richiesta");
}

async function main() {
  if (FINALIZE_ID) return finalizeImport(FINALIZE_ID);
  if (ROLLBACK_ID) return rollbackImport(ROLLBACK_ID);
  if (ROLLBACK_REVIEWS_ID) return rollbackReviews(ROLLBACK_REVIEWS_ID);

  const preflight = await runPreflight();
  const summary = {
    mode: REVIEWS ? (WRITE ? "reviews-write" : "reviews-dry-run") : (PREPARE_TITLES ? "prepare-titles" : (WRITE ? "write" : "dry-run")),
    uid: UID,
    displayName: preflight.overlap.displayName,
    object: preflight.archive.objectPath,
    generation: preflight.archive.generation,
    archiveBytes: preflight.archive.archiveBytes,
    archiveEntries: preflight.archive.archiveSummary.entryCount,
    parserVersion: PARSER_VERSION,
    ...preflight.archive.parsed.summary,
    existingTitleStates: preflight.overlap.existingTitleStates,
    existingRatings: preflight.overlap.existingRatings,
    overlappingStates: preflight.overlap.overlappingStates,
    overlappingRatings: preflight.overlap.overlappingRatings,
    overlappingStateDetails: preflight.overlap.overlappingStateDetails,
    overlappingRatingDetails: preflight.overlap.overlappingRatingDetails,
    planHash: preflight.plan.hash,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (REVIEWS) {
    if (WRITE) return applyReviews(preflight);
    const matchByUri = await resolveSomtoTitles(preflight.enriched);
    const plan = planReviews(preflight, matchByUri, await currentTitleRatings());
    const actions = {};
    for (const entry of plan) actions[entry.action] = (actions[entry.action] || 0) + 1;
    console.log(JSON.stringify({
      reviewsPlan: actions,
      skipped: plan.filter((entry) => entry.action !== "update")
        .map((entry) => ({ title: entry.titleName, action: entry.action })),
      unlinkedReviews: preflight.archive.parsed.unlinkedReviews,
      ambiguousReviews: preflight.archive.parsed.ambiguousReviews,
      oversizedReviews: preflight.archive.parsed.oversizedReviews,
      planHash: preflight.plan.hash,
    }, null, 2));
    console.log("DRY-RUN recensioni: nessuna scrittura eseguita.");
    return undefined;
  }
  if (PREPARE_TITLES) return prepareTitles(preflight);
  if (WRITE) return applyImport(preflight);
  console.log("DRY-RUN: nessuna scrittura eseguita.");
  return undefined;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("FATAL:", String(error?.message || error));
    process.exit(1);
  });
