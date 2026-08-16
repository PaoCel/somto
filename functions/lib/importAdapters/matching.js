"use strict";

// Title matching cascade for imported viewing-history rows (NormalizedRow
// from netflixCsv.js / future adapters). Resolves a row's series/movie name
// guess to a `titles/{id}` doc, escalating through progressively more
// expensive strategies:
//   1. exact `nameLower` match (filtered by expected type)
//   2. normalized-variant match (tokenized, reuses tmdb.js helpers)
//   3. altNamesLower match (original/alternative TMDB titles, denormalized
//      on the titles doc — catches EN/original-title rows, e.g. TV Time
//      exports, that don't match the localized IT `nameLower` at all)
//   4. TMDB search IT, in-process (reuses tmdb.js internals — never calls
//      the `tmdbProxy` callable, this runs server-side already)
//   5. stub-create a new `titles` doc from a high-confidence TMDB hit
//   6. otherwise: unresolved, queued for user confirmation
//
// `kind: "ambiguous"` rows get two matching attempts (whole title as movie,
// parts[0] as series); exactly one succeeding auto-resolves, both/neither
// queues for confirmation with the best-effort guess attached.

const {
  normalizeText,
  tokenizeNormalized,
  fetchTmdbCachedJson,
  existsLogicalDuplicateTitle,
  upsertTmdbTitle,
  tmdbTitleDocId,
  titleDocMediaType,
} = require("../../modules/tmdb");
const {
  buildImportMatchCacheKey,
  readImportMatchCache,
  writeImportMatchCache,
} = require("./importMatchCache");
const { searchAnilistAnime, anilistQueryCandidates } = require("./anilist");

const HIGH_CONFIDENCE_SCORE = 0.82;
const MIN_STUB_SCORE = 0.6;

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function titleDocType(doc) {
  const data = asObject(doc);
  if (data.type === "tv" || data.type === "movie") return data.type;
  return asObject(data.meta).mediaType === "tv" ? "tv" : "movie";
}

// Jaccard similarity over normalized token sets — cheap, good enough to rank
// candidates from a TMDB search page (which is already a small, relevant set).
function tokenSetSimilarity(aTokens, bTokens) {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Strategy 1: exact `nameLower` match, filtered by expected type.
 */
async function matchExact(db, name, expectedType) {
  const nameLower = normalizeText(name);
  if (!nameLower) return null;
  const snap = await db.collection("titles")
    .where("nameLower", "==", nameLower)
    .limit(10)
    .get();
  const match = snap.docs.find((d) => titleDocType(d.data()) === expectedType);
  return match ? { titleId: match.id, title: match.data(), confidence: 1, strategy: "exact" } : null;
}

/**
 * Strategy 2: normalized-variant match — token-set overlap against a
 * prefix-window query on `nameLower` (cheap Firestore fan-in, no new index:
 * range query on an already-indexed field). Filters candidates by type and
 * ranks by token similarity; only returns a match above HIGH_CONFIDENCE_SCORE
 * so this stage never silently mismatches unrelated titles.
 */
async function matchNormalizedVariant(db, name, expectedType) {
  const nameLower = normalizeText(name);
  if (!nameLower) return null;
  const nameTokens = tokenizeNormalized(name);
  if (nameTokens.length === 0) return null;

  // Prefix-range scan on nameLower (same field as strategy 1's equality
  // query, no composite index needed) to gather nearby candidates.
  const prefix = nameLower.slice(0, Math.min(nameLower.length, 12));
  const snap = await db.collection("titles")
    .where("nameLower", ">=", prefix)
    .where("nameLower", "<", `${prefix}`)
    .limit(25)
    .get();

  let best = null;
  for (const doc of snap.docs) {
    const data = doc.data();
    if (titleDocType(data) !== expectedType) continue;
    const candidateTokens = tokenizeNormalized(data.name || "");
    const score = tokenSetSimilarity(nameTokens, candidateTokens);
    if (score > (best?.score || 0)) {
      best = { titleId: doc.id, title: data, score };
    }
  }

  if (best && best.score >= HIGH_CONFIDENCE_SCORE) {
    return { titleId: best.titleId, title: best.title, confidence: best.score, strategy: "normalized_variant" };
  }
  return null;
}

/**
 * Strategy 3: `altNamesLower` match — array-contains on the denormalized
 * original/alternative TMDB titles (see tmdb.js's extractAltNamesLower,
 * populated by the backfill script + refreshTitleFromTmdb/enrichment).
 * Exact match on a normalized name, filtered by expected type (same
 * cross-type-collision guard as the rest of the cascade: TMDB ids — and
 * therefore alternate titles imported from them — can coincidentally
 * describe both a movie and a tv show, e.g. TMDB 1891 = Empire Strikes Back
 * movie AND Rome tv series).
 *
 * This exists because Netflix/TV Time exports are NOT always in the same
 * language TMDB uses for `name`/`title` (Italian, our catalog default): TV
 * Time in particular exports English/original names. Rather than routing
 * every such row through a full TMDB search (`matchViaTmdb`, expensive and
 * rate-limited), this catches the common case cheaply once altNamesLower is
 * populated for a title — no TMDB call at all, just a Firestore query.
 */
async function matchAltNamesLower(db, name, expectedType) {
  const nameLower = normalizeText(name);
  if (!nameLower) return null;
  const snap = await db.collection("titles")
    .where("altNamesLower", "array-contains", nameLower)
    .limit(10)
    .get();
  const match = snap.docs.find((d) => titleDocMediaType(d.data()) === expectedType);
  return match
    ? { titleId: match.id, title: match.data(), confidence: 0.95, strategy: "alt_names_lower" }
    : null;
}

/**
 * Strategy 4: TMDB search IT, in-process. Reuses tmdb.js's cached fetch
 * helper directly — never invokes the `tmdbProxy` callable (this already
 * runs server-side inside a Cloud Function). TMDB's `/search` endpoints
 * match against ALL known titles/aliases for a result (not just the
 * `language` translation), so an English source title (TV Time exports
 * names in English/original, unlike Netflix's Italian-localized export)
 * still finds the right row even with `language: it-IT` — that param only
 * affects which translation is returned for rendering, not the match set.
 *
 * `year` (optional): TMDB's `year`/`first_air_date_year` params narrow the
 * search to a specific release year, which matters for disambiguating
 * common titles (only meaningful for movies — the TV Time v1 CSV supplies
 * `releaseYear` from `release_date`; TV search intentionally ignores it,
 * TMDB's TV `first_air_date_year` param is unreliable for shows that moved
 * networks/re-aired).
 */
async function searchTmdb(db, name, expectedType, { state, year, fetcher, cacheStore } = {}) {
  const query = String(name || "").trim();
  if (!query) return [];
  const path = expectedType === "tv" ? "/search/tv" : "/search/movie";
  const params = {
    query,
    language: "it-IT",
    include_adult: false,
    page: 1,
  };
  const yearNum = Number(year);
  if (expectedType === "movie" && Number.isFinite(yearNum) && yearNum > 0) {
    params.year = yearNum;
  }
  const result = await fetchTmdbCachedJson(path, params, {
    db,
    state: state || {},
    cacheScope: `titlesImport_${expectedType}`,
    ttlSeconds: 24 * 60 * 60,
    allowStaleOnError: true,
    // `fetcher`/`cacheStore` are test-only seams (never set in production
    // callers) — see tmdb.js's fetchTmdbCachedJson, which already supports
    // swapping the network call and cache backing store for unit tests.
    ...(fetcher ? { fetcher } : {}),
    ...(cacheStore ? { cacheStore } : {}),
  });
  const results = Array.isArray(result?.data?.results) ? result.data.results : [];
  return results.map((row) => ({ ...row, type: expectedType }));
}

/**
 * TheTVDB-id resolution path (TV Time GDPR export: `s_id` in the v2 series
 * CSV; Refract export: `id.tvdb` on BOTH movies and series). TMDB's
 * `/find/{id}` endpoint with `external_source=tvdb_id` maps it to a TMDB
 * result directly — this is near-deterministic (an external-id lookup, not a
 * fuzzy name search) and SKIPS the name cascade entirely, which matters
 * because TV Time exports names in English/original and would otherwise
 * have to rely on TMDB's fuzzy multi-language search.
 *
 * `/find/{id}` returns BOTH `tv_results` and `movie_results` for a given
 * external id in one payload (TheTVDB movie/series ids are separate
 * namespaces, but the endpoint doesn't know which one you meant), so the
 * same cached response serves either lookup — only `expectedType` picks
 * which array to read from it. Defaults to "tv" for backward compatibility
 * with the GDPR adapter's series-only usage.
 */
async function findTmdbByTvdbId(db, tvdbId, { state, fetcher, cacheStore } = {}, expectedType = "tv") {
  const id = Number(tvdbId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const result = await fetchTmdbCachedJson(`/find/${id}`, {
    external_source: "tvdb_id",
    language: "it-IT",
  }, {
    db,
    state: state || {},
    cacheScope: "titlesImport_tvdb_find",
    ttlSeconds: 7 * 24 * 60 * 60,
    allowStaleOnError: true,
    ...(fetcher ? { fetcher } : {}),
    ...(cacheStore ? { cacheStore } : {}),
  });
  const resultsKey = expectedType === "movie" ? "movie_results" : "tv_results";
  const matches = Array.isArray(result?.data?.[resultsKey]) ? result.data[resultsKey] : [];
  if (matches.length === 0) return null;
  return { ...matches[0], type: expectedType };
}

/**
 * TMDB-id direct resolution (Trakt gives `ids.tmdb` on every item). Fetches
 * the TMDB details for the id, then reuses the SAME dedup/stub-create pattern
 * as the tvdb/name cascade: if that TMDB id already has a `titles` doc
 * (existsLogicalDuplicateTitle) use it; otherwise stub-create it
 * (upsertTmdbTitle). DETERMINISTIC — no fuzzy score needed, the id IS the
 * match — so confidence is 1 unconditionally. `expectedType` picks the
 * `/movie/{id}` vs `/tv/{id}` endpoint (TMDB movie/tv ids share a namespace,
 * e.g. 1891 = movie "Empire Strikes Back" AND tv "Rome", so the endpoint —
 * not just the id — determines which title we mean).
 */
async function matchViaTmdbId(db, bucket, tmdbId, expectedType, ctx = {}) {
  const id = Number(tmdbId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const path = expectedType === "tv" ? `/tv/${id}` : `/movie/${id}`;
  const res = await fetchTmdbCachedJson(path, { language: "it-IT" }, {
    db,
    state: ctx.state || {},
    cacheScope: "titlesImport_tmdb_details",
    ttlSeconds: 7 * 24 * 60 * 60,
    allowStaleOnError: true,
    // Test-only seams (never set in production callers) — see tmdb.js's
    // fetchTmdbCachedJson, which supports swapping the network call and cache
    // backing store for unit tests.
    ...(ctx.fetcher ? { fetcher: ctx.fetcher } : {}),
    ...(ctx.cacheStore ? { cacheStore: ctx.cacheStore } : {}),
  });
  const details = res?.data;
  if (!details || !(details.id || id)) return null;
  // Normalize the /movie|/tv details node into the row shape the dedup/upsert
  // helpers expect (they read `type`, `tmdbId`, `id`, title/name fields).
  const row = { ...details, id, tmdbId: id, type: expectedType };

  const existingDocId = await existsLogicalDuplicateTitle(db, row, ctx.logicalDupCache);
  if (existingDocId) {
    const doc = await db.collection("titles").doc(existingDocId).get();
    return { titleId: existingDocId, title: doc.data(), confidence: 1, strategy: "tmdb_id" };
  }

  const upsertResult = await upsertTmdbTitle(db, bucket, row, ctx.logicalDupCache);
  if (!upsertResult.imported) return null;
  const docId = tmdbTitleDocId(expectedType, id);
  const doc = await db.collection("titles").doc(docId).get();
  return { titleId: docId, title: doc.data(), confidence: 1, strategy: "tmdb_id_stub_created" };
}

/**
 * Resolves a TV Time row via its TheTVDB id: TMDB `/find` -> if the
 * resulting TMDB id already has a `titles` doc (existsLogicalDuplicateTitle,
 * reusing the same dedup pattern as the name cascade) use that; otherwise
 * stub-create it (upsertTmdbTitle, same helper the name cascade's strategy 4
 * uses). This is treated as HIGH confidence unconditionally — an external-id
 * lookup does not need a fuzzy-match score, unlike a name search. `expectedType`
 * defaults to "tv" (the GDPR adapter's only caller); the Refract adapter also
 * passes "movie" (its movies carry a tvdb id the GDPR export never had).
 */
async function matchViaTvdbId(db, bucket, tvdbId, ctx = {}, expectedType = "tv") {
  const row = await findTmdbByTvdbId(db, tvdbId, ctx, expectedType);
  if (!row) return null;

  const existingDocId = await existsLogicalDuplicateTitle(db, row, ctx.logicalDupCache);
  if (existingDocId) {
    const doc = await db.collection("titles").doc(existingDocId).get();
    return {
      titleId: existingDocId,
      title: doc.data(),
      confidence: 1,
      strategy: "tvdb_id",
    };
  }

  const upsertResult = await upsertTmdbTitle(db, bucket, row, ctx.logicalDupCache);
  if (!upsertResult.imported) return null;
  const docId = tmdbTitleDocId(expectedType, row.tmdbId || row.id);
  const doc = await db.collection("titles").doc(docId).get();
  return {
    titleId: docId,
    title: doc.data(),
    confidence: 1,
    strategy: "tvdb_id_stub_created",
  };
}

// Scoring tokenizer: like tokenizeNormalized (modules/tmdb.js) but PRESERVES
// single-digit tokens. tokenizeNormalized filters `length >= 2`, so "3"/"4"
// vanish and "Home Alone 3" tokenizes IDENTICALLY to "Home Alone" -> a false
// 1.0 score on the wrong sequel (TMDB ranks Home Alone 3 above the 1990
// original by popularity). With digits preserved the sequel drops to 0.67
// (below the auto-stub threshold) while the true original — whose
// original_title is an exact match — wins the ranking.
function tokenizeForScoring(value) {
  return Array.from(new Set(
    normalizeText(value)
      .split(/\s+/)
      .filter(Boolean)
      .filter((t) => t.length >= 2 || /^\d$/.test(t))
  ));
}

// CJK / non-Latin scoring. `normalizeText` strips everything outside [a-z0-9]
// (incl. Japanese/Korean/Chinese) to spaces, so tokenizeForScoring yields ZERO
// tokens for a pure-CJK title (名探偵コナン, 귀공자, ハウルの動く城) → token
// similarity is always 0 and the CORRECT TMDB result (whose original_name IS
// that CJK string) gets thrown away below the 0.82 threshold, even though
// searchTmdb sends the raw query and TMDB returns the right row. Fix: score
// CJK-vs-CJK by character-BIGRAM Jaccard (word tokens are meaningless for
// scriptio-continua languages). This runs ONLY as a fallback alongside token
// similarity; Latin titles are unaffected (they have no CJK chars → cjkSim 0).
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\uac00-\ud7af]/;
function hasCjk(value) { return CJK_RE.test(String(value || "")); }

// Keep CJK chars + latin alphanumerics, drop spaces/punctuation, lowercase.
function cjkNormalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\uac00-\ud7af]/g, "");
}

function charBigrams(s) {
  const out = new Set();
  if (s.length === 1) { out.add(s); return out; }
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

// Jaccard over character bigrams. 0 unless BOTH strings actually contain CJK
// (so it never fires for two Latin strings — those stay on token similarity).
function cjkSimilarity(a, b) {
  if (!hasCjk(a) || !hasCjk(b)) return 0;
  const na = cjkNormalize(a);
  const nb = cjkNormalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  // Containment boost: TV Time often appends a subtitle to the base title
  // ("名探偵コナン 戦慄の楽譜(フルスコア)" vs TMDB "名探偵コナン 戦慄の楽譜").
  // If the SHORTER normalized string (>=6 CJK-dense chars, so not a generic
  // franchise stub like the 4-char "鬼滅の刃") is fully contained in the
  // longer, it's almost certainly the same title → clear the auto-stub bar.
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  const containment = shorter.length >= 6 && longer.includes(shorter) ? 0.85 : 0;
  const A = charBigrams(na);
  const B = charBigrams(nb);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  const union = A.size + B.size - inter;
  const jaccard = union > 0 ? inter / union : 0;
  return Math.max(jaccard, containment);
}

// Scores each TMDB search result against the query by token-set similarity.
// The similarity is the MAX of the localized it-IT title AND the original
// title (`original_title` for movies / `original_name` for tv): TMDB's
// /search endpoints match against ALL known aliases of a result, so a query
// in the original language (TV Time exports EN/original names) finds the
// right row — but scoring it only against the localized name would then
// throw it away ("Home Alone" vs "Mamma ho perso l'aereo" -> ~0; "Fear
// Street: 1994" vs "Fear Street Parte 1: 1994" -> 0.75, below the 0.82
// auto-stub threshold, while the original title clears it). For CJK titles the
// token score is structurally 0 (see cjkSimilarity) — a char-bigram score is
// max()'d in so the right CJK result clears the threshold.
function rankTmdbResults(results, name) {
  const nameTokens = tokenizeForScoring(name);
  const similarityTo = (candidate) => {
    const tokens = tokenizeForScoring(candidate || "");
    const tokenScore = tokens.length ? tokenSetSimilarity(nameTokens, tokens) : 0;
    return Math.max(tokenScore, cjkSimilarity(name, candidate));
  };
  return results
    .map((row) => {
      const localizedName = row.type === "tv" ? row.name : row.title;
      const originalName = row.type === "tv" ? row.original_name : row.original_title;
      const score = Math.max(similarityTo(localizedName), similarityTo(originalName));
      return { row, score };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Strategies 3+4 combined: TMDB search -> if a high-confidence hit exists
 * and it already has a `titles` doc (existsLogicalDuplicateTitle), use that;
 * otherwise stub-create a new title doc from the TMDB row.
 */
async function matchViaTmdb(db, bucket, name, expectedType, ctx = {}) {
  const results = await searchTmdb(db, name, expectedType, ctx);
  if (results.length === 0) return null;

  const ranked = rankTmdbResults(results, name);
  const top = ranked[0];
  if (!top || top.score < MIN_STUB_SCORE) return null;

  const existingDocId = await existsLogicalDuplicateTitle(db, top.row, ctx.logicalDupCache);
  if (existingDocId) {
    const doc = await db.collection("titles").doc(existingDocId).get();
    return {
      titleId: existingDocId,
      title: doc.data(),
      confidence: top.score,
      strategy: "tmdb_existing",
    };
  }

  if (top.score < HIGH_CONFIDENCE_SCORE) {
    // Not confident enough to auto-stub a brand-new title doc; surface as a
    // suggestion for the confirmation queue instead.
    return {
      titleId: null,
      title: null,
      confidence: top.score,
      strategy: "tmdb_suggestion",
      suggestion: {
        tmdbId: Number(top.row.tmdbId || top.row.id) || null,
        name: top.row.type === "tv" ? top.row.name : top.row.title,
        year: Number(String(top.row.release_date || top.row.first_air_date || "").slice(0, 4)) || null,
        posterPath: top.row.poster_path || null,
        mediaType: expectedType,
      },
    };
  }

  const upsertResult = await upsertTmdbTitle(db, bucket, top.row, ctx.logicalDupCache);
  if (!upsertResult.imported) return null;
  const docId = tmdbTitleDocId(expectedType, top.row.tmdbId || top.row.id);
  const doc = await db.collection("titles").doc(docId).get();
  return {
    titleId: docId,
    title: doc.data(),
    confidence: top.score,
    strategy: "tmdb_stub_created",
  };
}

/**
 * AniList bridge: search AniList for an anime `name` (romaji/English fan-name),
 * then re-run the TMDB cascade with each returned title form (native CJK first,
 * then official English) at AniList's media type. Returns the FIRST TMDB match
 * that resolves (strategy prefixed `anilist_`), or null. Never throws — a
 * bridge miss/error leaves the title unresolved exactly as before.
 */
async function matchViaAnilist(db, bucket, name, expectedType, ctx = {}) {
  let candidates = [];
  try {
    candidates = await searchAnilistAnime(name, ctx.anilistFetcher ? { fetcher: ctx.anilistFetcher } : {});
  } catch (err) {
    return null;
  }
  for (const cand of candidates.slice(0, 2)) {
    const type = cand.type || expectedType;
    for (const q of anilistQueryCandidates(cand)) {
      // eslint-disable-next-line no-await-in-loop
      const m = await matchViaTmdb(db, bucket, q, type, { ...ctx, year: cand.year || ctx.year });
      if (m?.titleId) return { ...m, strategy: `anilist_${m.strategy}` };
    }
  }
  return null;
}

/**
 * Resolves a single name+type against the full cascade, with 2 optional
 * fast-path shortcuts ahead of the name-based strategies:
 *
 *   0) GLOBAL CACHE — a prior import (any user) already resolved this exact
 *      (normalized name, type, year?, tvdbId?) combination. Read-through
 *      cache: on a miss, the resolution below still runs and (if
 *      successful) populates the cache for the next lookup.
 *   0.5) TVDB-ID LOOKUP — `ctx.tvdbSeriesId` (TV series: TV Time's `s_id`/
 *      Refract's `id.tvdb`) or `ctx.tvdbMovieId` (movies: Refract's
 *      `id.tvdb` — the GDPR export never had one) resolves
 *      near-deterministically via TMDB `/find`, skipping the fuzzy name
 *      cascade entirely. This matters because TV Time exports names in
 *      English/original.
 *
 * `ctx.year` (movies only) narrows the TMDB search to a specific release
 * year (see searchTmdb's docstring) — passed through to matchViaTmdb.
 */
async function resolveTitleMatch(db, bucket, name, expectedType, ctx = {}) {
  const trimmedName = String(name || "").trim();
  // Reuses the same cache-key "tvdbSeriesId" slot for a movie's tvdb id too:
  // the key already carries `expectedType`, so a movie and a series never
  // collide even if their tvdb ids coincide (separate TheTVDB namespaces
  // anyway). Only one of the two is ever set on a given row.
  const cacheKey = buildImportMatchCacheKey({
    name: trimmedName,
    expectedType,
    year: ctx.year,
    tvdbSeriesId: ctx.tvdbSeriesId ?? ctx.tvdbMovieId,
    tmdbId: ctx.tmdbId,
  });

  if (cacheKey) {
    const cached = await readImportMatchCache(db, cacheKey);
    if (cached) {
      // Re-validate the cached titleId still exists (defensive: a title can
      // be deleted/merged after the cache entry was written).
      const doc = await db.collection("titles").doc(cached.titleId).get();
      if (doc.exists) {
        return { titleId: cached.titleId, title: doc.data(), confidence: cached.confidence, strategy: `cache_${cached.strategy}` };
      }
    }
  }

  let result = null;

  // TMDB-id fast path (Trakt): the item already carries `ids.tmdb`, so we can
  // resolve deterministically — skip both the tvdb `/find` and the fuzzy name
  // cascade entirely.
  if (ctx.tmdbId) {
    result = await matchViaTmdbId(db, bucket, ctx.tmdbId, expectedType, ctx);
  }

  if (!result?.titleId && expectedType === "tv" && ctx.tvdbSeriesId) {
    result = await matchViaTvdbId(db, bucket, ctx.tvdbSeriesId, ctx, "tv");
  } else if (!result?.titleId && expectedType === "movie" && ctx.tvdbMovieId) {
    result = await matchViaTvdbId(db, bucket, ctx.tvdbMovieId, ctx, "movie");
  }

  if (!result?.titleId && trimmedName) {
    const exact = await matchExact(db, trimmedName, expectedType);
    if (exact) {
      result = exact;
    } else {
      const variant = await matchNormalizedVariant(db, trimmedName, expectedType);
      if (variant) {
        result = variant;
      } else {
        const altNames = await matchAltNamesLower(db, trimmedName, expectedType);
        if (altNames) {
          result = altNames;
        } else {
          result = await matchViaTmdb(db, bucket, trimmedName, expectedType, ctx);
        }
      }
    }
  }

  // AniList bridge (LAST fallback): romaji / English fan-names for ANIME that
  // TMDB's name search can't map to its official Japanese/English title
  // ("Akagami no Shirayuki-hime", "Kekkai Sensen"). Only fires on an otherwise-
  // unresolved LATIN name (CJK is already handled by the char-bigram scorer) —
  // AniList rewrites the query to the native (CJK) + English title + correct
  // media type, then we re-run the TMDB cascade, so the final match still
  // clears the normal confidence threshold (no new false-positive surface).
  // `ctx.anilist === false` disables it (tests / non-anime bulk imports).
  if (!result?.titleId && trimmedName && ctx.anilist !== false && !hasCjk(trimmedName)) {
    const bridged = await matchViaAnilist(db, bucket, trimmedName, expectedType, ctx);
    if (bridged?.titleId) result = bridged;
  }

  if (cacheKey && result?.titleId) {
    // Fire-and-forget: never block/throw on cache-write failure.
    void writeImportMatchCache(db, cacheKey, {
      titleId: result.titleId,
      resolvedAsType: expectedType,
      confidence: result.confidence,
      strategy: result.strategy,
      cacheKeyInputs: { name: trimmedName, expectedType, year: ctx.year ?? null, tvdbSeriesId: ctx.tvdbSeriesId ?? null, tmdbId: ctx.tmdbId ?? null },
    });
  }

  return result; // may be null, a resolved match, or a tmdb_suggestion (unresolved but with a hint)
}

/**
 * Resolves a NormalizedRow (as produced by netflixCsv.js) to a title match.
 * For `kind: "ambiguous"` rows, tries both interpretations (whole title as a
 * movie, parts[0] as a series) and only auto-resolves when EXACTLY one
 * succeeds; otherwise queues for confirmation with whichever guess looks
 * best (highest confidence, if any).
 *
 * Returns:
 *   {
 *     resolved: boolean,
 *     titleId: string|null,
 *     title: object|null,
 *     confidence: number,
 *     strategy: string|null,
 *     resolvedAsType: "movie"|"tv"|null,
 *     suggestion: object|null,  // best-effort hint for the confirmation UI
 *   }
 */
async function resolveRowMatch(db, bucket, row, ctx = {}) {
  // Anthology installments (anthologySplit.js) are pinned to a concrete
  // titleId in the parser, since the name/tvdb cascade can't resolve a
  // multi-show anthology like "Monster (2022)" to any single title. Honor
  // that pin directly, falling through to the normal cascade only if the
  // pinned title has since vanished (deleted/merged).
  if (row.forcedTitleId) {
    const doc = await db.collection("titles").doc(row.forcedTitleId).get();
    if (doc.exists) {
      return finalizeSingleAttempt(
        { titleId: row.forcedTitleId, title: doc.data(), confidence: 1, strategy: row.forcedTitleStrategy || "forced" },
        "tv",
      );
    }
  }

  if (row.kind === "movie") {
    // `releaseYear` (TV Time CSV/Refract; undefined for Netflix rows) narrows
    // the TMDB search — see searchTmdb's docstring. `tvdbMovieId` (Refract
    // only — the GDPR export never had a movie tvdb id) enables the
    // near-deterministic TMDB `/find` shortcut, same idea as the series path.
    const movieCtx = { ...ctx };
    if (row.releaseYear != null) movieCtx.year = row.releaseYear;
    if (row.tvdbMovieId != null) movieCtx.tvdbMovieId = row.tvdbMovieId;
    // `tmdbId` (Trakt only — every item carries `ids.tmdb`) enables the
    // deterministic TMDB `/movie/{id}` fast path ahead of everything else.
    if (row.tmdbId != null) movieCtx.tmdbId = row.tmdbId;
    const match = await resolveTitleMatch(db, bucket, row.movieNameGuess, "movie", movieCtx);
    return finalizeSingleAttempt(match, "movie");
  }

  if (row.kind === "tv_episode") {
    // `tvdbSeriesId` (TV Time v2 CSV only; undefined for Netflix rows)
    // enables the near-deterministic TMDB `/find` shortcut ahead of the name
    // cascade — see resolveTitleMatch's docstring.
    // `tmdbId` (Trakt) enables the deterministic TMDB `/tv/{id}` fast path;
    // `tvdbSeriesId` (TV Time) the near-deterministic `/find` shortcut. Only
    // one of the two is ever set on a given row.
    let tvCtx = ctx;
    if (row.tmdbId != null || row.tvdbSeriesId != null) {
      tvCtx = { ...ctx };
      if (row.tmdbId != null) tvCtx.tmdbId = row.tmdbId;
      if (row.tvdbSeriesId != null) tvCtx.tvdbSeriesId = row.tvdbSeriesId;
    }
    const match = await resolveTitleMatch(db, bucket, row.seriesNameGuess, "tv", tvCtx);
    return finalizeSingleAttempt(match, "tv");
  }

  // kind === "ambiguous": try movie (whole raw title) AND tv (parts[0]).
  const [movieAttempt, tvAttempt] = await Promise.all([
    resolveTitleMatch(db, bucket, row.movieNameGuess, "movie", ctx),
    resolveTitleMatch(db, bucket, row.seriesNameGuess, "tv", ctx),
  ]);

  const movieResolved = Boolean(movieAttempt?.titleId);
  const tvResolved = Boolean(tvAttempt?.titleId);

  if (movieResolved && !tvResolved) return finalizeSingleAttempt(movieAttempt, "movie");
  if (tvResolved && !movieResolved) return finalizeSingleAttempt(tvAttempt, "tv");

  // Both resolved, or neither: can't safely auto-decide. Queue with the
  // best-available hint (prefer whichever has higher confidence).
  const best = (movieAttempt?.confidence || 0) >= (tvAttempt?.confidence || 0) ? movieAttempt : tvAttempt;
  const bestType = best === movieAttempt ? "movie" : "tv";
  return {
    resolved: false,
    titleId: null,
    title: null,
    confidence: best?.confidence || 0,
    strategy: best?.strategy || null,
    resolvedAsType: null,
    ambiguousBothMatched: movieResolved && tvResolved,
    suggestion: best?.suggestion || (best?.titleId ? {
      titleId: best.titleId,
      name: best.title?.name || null,
      mediaType: bestType,
    } : null),
  };
}

function finalizeSingleAttempt(match, expectedType) {
  if (match?.titleId) {
    return {
      resolved: true,
      titleId: match.titleId,
      title: match.title,
      confidence: match.confidence,
      strategy: match.strategy,
      resolvedAsType: expectedType,
      suggestion: null,
    };
  }
  return {
    resolved: false,
    titleId: null,
    title: null,
    confidence: match?.confidence || 0,
    strategy: match?.strategy || null,
    resolvedAsType: null,
    suggestion: match?.suggestion || null,
  };
}

module.exports = {
  matchExact,
  matchNormalizedVariant,
  matchAltNamesLower,
  matchViaTmdb,
  matchViaTmdbId,
  matchViaTvdbId,
  findTmdbByTvdbId,
  searchTmdb,
  resolveTitleMatch,
  resolveRowMatch,
  tokenSetSimilarity,
  rankTmdbResults,
  cjkSimilarity,
  hasCjk,
  matchViaAnilist,
  // Verified confidence thresholds (reused by the import-confirm flow: a row
  // that carries a `suggestion` already scored in [MIN_STUB_SCORE, HIGH_CONFIDENCE_SCORE)
  // — that band IS the "safe enough to offer as a best guess" signal, so the
  // bulk "use best suggestions" action never invents a new threshold).
  MIN_STUB_SCORE,
  HIGH_CONFIDENCE_SCORE,
};
