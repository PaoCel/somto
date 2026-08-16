const admin = require("firebase-admin");
const { defineString } = require("firebase-functions/params");
const { logger } = require("firebase-functions");
const { randomUUID, createHash } = require("crypto");
const { withCircuitBreaker } = require("../lib/circuitBreaker");

const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p/w500";
const TMDB_KEY_PARAM = defineString("TMDB_KEY", { default: "" });
const MIN_REQ_GAP_MS = 130;
const MAX_API_CALLS = 150;
const MAX_ATTEMPTS = 4;
const MAX_PAGES = 5;
const MAX_DISCOVER_WINDOW = 500;
const TMDB_CACHE_COLLECTION = "tmdbCache";
const TMDB_CACHE_MAX_ITEMS = 350;
const TMDB_CACHE_DEFAULT_TTL_SECONDS = 6 * 60 * 60;
const TMDB_CACHE_MIN_TTL_SECONDS = 60;

let tmdbLastRequestAtMs = 0;
const tmdbMemoryCache = new Map();

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function safeString(str, maxLen = 500) {
  return String(str || "").slice(0, maxLen || 500);
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeNormalized(value) {
  return Array.from(
    new Set(
      normalizeText(value)
        .split(/\s+/)
        .filter(Boolean)
        .filter((t) => t.length >= 2)
    )
  );
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function parseYearFromDate(dateString) {
  const raw = String(dateString || "").trim();
  if (!raw) return null;
  const m = raw.match(/^(\d{4})-/);
  if (!m) return null;
  const year = Number(m[1]);
  if (!Number.isFinite(year) || year < 1870 || year > 2100) return null;
  return year;
}

function getTmdbApiKey() {
  const paramKey = String(TMDB_KEY_PARAM.value() || "").trim();
  if (paramKey) return paramKey;

  const envKey = String(process.env.TMDB_KEY || process.env.TMDB_API_KEY || "").trim();
  if (envKey) return envKey;

  return "";
}

function normalizeCacheScope(scope) {
  const raw = String(scope || "default")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
  return raw || "default";
}

function normalizeCacheParams(params = {}) {
  return Object.entries(params || {})
    .filter(([, v]) => !(v === undefined || v === null || v === ""))
    .map(([k, v]) => [String(k), String(v)])
    .sort(([ak], [bk]) => ak.localeCompare(bk));
}

function buildTmdbCacheSignature(path, params = {}, scope = "default") {
  const normalizedScope = normalizeCacheScope(scope);
  const normalizedPath = String(path || "").trim() || "/";
  const pairs = normalizeCacheParams(params);
  const queryString = pairs
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return `${normalizedScope}|${normalizedPath}?${queryString}`;
}

function buildTmdbCacheDocId(path, params = {}, scope = "default") {
  const normalizedScope = normalizeCacheScope(scope);
  const normalizedPath = String(path || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 36) || "tmdb";
  const hash = createHash("sha1")
    .update(buildTmdbCacheSignature(path, params, normalizedScope))
    .digest("hex");
  return `${normalizedScope}_${normalizedPath}_${hash}`;
}

function readMemoryCache(docId, nowMs = Date.now()) {
  const entry = tmdbMemoryCache.get(docId);
  if (!entry) return null;
  if (Number(entry.expiresAtMs || 0) <= nowMs) {
    tmdbMemoryCache.delete(docId);
    return null;
  }
  return entry;
}

function writeMemoryCache(docId, payload, expiresAtMs, updatedAtMs = Date.now()) {
  tmdbMemoryCache.set(docId, {
    payload,
    expiresAtMs: Number(expiresAtMs || 0),
    updatedAtMs: Number(updatedAtMs || Date.now()),
  });
  if (tmdbMemoryCache.size <= TMDB_CACHE_MAX_ITEMS) return;
  const oldestKey = tmdbMemoryCache.keys().next().value;
  if (oldestKey) tmdbMemoryCache.delete(oldestKey);
}

async function readFirestoreCacheEntry(db, docId) {
  if (!db) return null;
  const snap = await db.collection(TMDB_CACHE_COLLECTION).doc(docId).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  if (!data || typeof data.payload !== "object" || data.payload === null) return null;
  return {
    payload: data.payload,
    expiresAtMs: Number(data.expiresAtMs || 0),
    updatedAtMs: Number(data.updatedAtMs || 0),
  };
}

async function writeFirestoreCacheEntry(db, docId, entry, meta = {}) {
  if (!db) return;
  await db.collection(TMDB_CACHE_COLLECTION).doc(docId).set(
    {
      payload: entry.payload,
      expiresAtMs: Number(entry.expiresAtMs || 0),
      updatedAtMs: Number(entry.updatedAtMs || Date.now()),
      scope: normalizeCacheScope(meta.scope || "default"),
      path: safeString(meta.path || "", 120),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function tmdbFetch(path, params = {}, state = {}) {
  return withCircuitBreaker(
    "tmdb",
    async () => {
      const apiKey = getTmdbApiKey();
      if (!apiKey) throw new Error("TMDB API key mancante");

      const maxCalls = clamp(Number(state.maxApiCalls || MAX_API_CALLS), 20, 2000);
      const attempts = clamp(Number(state.maxAttempts || MAX_ATTEMPTS), 1, 8);

      for (let attempt = 1; attempt <= attempts; attempt++) {
        const now = Date.now();
        const waitMs = MIN_REQ_GAP_MS - (now - tmdbLastRequestAtMs);
        if (waitMs > 0) await sleepMs(waitMs);
        tmdbLastRequestAtMs = Date.now();

        state.apiCalls = Number(state.apiCalls || 0) + 1;
        if (state.apiCalls > maxCalls) {
          throw new Error(`TMDB API call cap superato (${maxCalls})`);
        }

        const url = new URL(`${TMDB_BASE_URL}${path}`);
        url.searchParams.set("api_key", apiKey);
        for (const [k, v] of Object.entries(params || {})) {
          if (v === undefined || v === null || v === "") continue;
          url.searchParams.set(k, String(v));
        }

        let res;
        try {
          res = await fetch(url.toString());
        } catch (err) {
          state.apiNetworkErrors = Number(state.apiNetworkErrors || 0) + 1;
          if (attempt >= attempts) throw err;
          await sleepMs(500 * attempt);
          continue;
        }

        if (res.status === 429) {
          state.apiRateLimitHits = Number(state.apiRateLimitHits || 0) + 1;
          if (attempt >= attempts) {
            throw new Error(`TMDB 429 su ${path} (tentativi esauriti)`);
          }
          await sleepMs(1200 * attempt);
          continue;
        }

        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          const err = new Error(`TMDB ${res.status} su ${path}: ${safeString(txt, 180)}`);
          err.status = res.status;
          // Un 404 e' una risposta legittima ("questa risorsa non esiste"), non
          // un guasto: capita di routine sui credits di episodio (anime, serie
          // vecchie). Marcato perche' il circuit breaker non lo conti.
          if (res.status === 404) err.code = "TMDB_NOT_FOUND";
          throw err;
        }

        return res.json();
      }

      throw new Error(`TMDB fetch fallita per ${path}`);
    },
    {
      shouldCountFailure: (err) => !err || err.code !== "TMDB_NOT_FOUND",
      failureThreshold: clamp(Number(state.circuitFailureThreshold || 4), 1, 10),
      coolDownMs: clamp(Number(state.circuitCoolDownMs || 2 * 60 * 1000), 5 * 1000, 15 * 60 * 1000),
      resetAfterMs: clamp(Number(state.circuitResetAfterMs || 30 * 60 * 1000), 10 * 1000, 24 * 60 * 60 * 1000),
    }
  );
}

async function fetchTmdbCachedJson(path, params = {}, opts = {}) {
  const ttlSecondsRaw = Number(opts.ttlSeconds ?? TMDB_CACHE_DEFAULT_TTL_SECONDS);
  const ttlSeconds = Number.isFinite(ttlSecondsRaw)
    ? clamp(Math.floor(ttlSecondsRaw), 0, 60 * 60 * 24 * 30)
    : TMDB_CACHE_DEFAULT_TTL_SECONDS;
  const ttlMs = ttlSeconds > 0 ? Math.max(TMDB_CACHE_MIN_TTL_SECONDS * 1000, ttlSeconds * 1000) : 0;
  const nowMs = Date.now();
  const scope = normalizeCacheScope(opts.cacheScope || "default");
  const docId = buildTmdbCacheDocId(path, params, scope);
  const allowStaleOnError = opts.allowStaleOnError !== false;
  const state = opts.state || {};
  const fetcher = typeof opts.fetcher === "function" ? opts.fetcher : tmdbFetch;
  const cacheStore = (opts.cacheStore && typeof opts.cacheStore.get === "function")
    ? opts.cacheStore
    : null;
  const db = cacheStore || ttlMs <= 0 ? null : (opts.db || admin.firestore());

  if (ttlMs > 0) {
    const memHit = readMemoryCache(docId, nowMs);
    if (memHit) {
      state.cacheHits = Number(state.cacheHits || 0) + 1;
      state.cacheMemoryHits = Number(state.cacheMemoryHits || 0) + 1;
      return {
        data: memHit.payload,
        cache: { key: docId, hit: true, stale: false, source: "memory", scope, ttlSeconds },
      };
    }
  }

  let cacheEntry = null;
  if (ttlMs > 0) {
    try {
      cacheEntry = cacheStore
        ? await cacheStore.get(docId)
        : await readFirestoreCacheEntry(db, docId);
    } catch (err) {
      logger.warn("[tmdb-cache] read failed", { key: docId, error: err?.message || String(err) });
    }
    if (cacheEntry && Number(cacheEntry.expiresAtMs || 0) > nowMs) {
      writeMemoryCache(docId, cacheEntry.payload, cacheEntry.expiresAtMs, cacheEntry.updatedAtMs || nowMs);
      state.cacheHits = Number(state.cacheHits || 0) + 1;
      state.cacheFirestoreHits = Number(state.cacheFirestoreHits || 0) + 1;
      return {
        data: cacheEntry.payload,
        cache: { key: docId, hit: true, stale: false, source: "firestore", scope, ttlSeconds },
      };
    }
  }

  try {
    const data = await fetcher(path, params, state);
    if (ttlMs > 0) {
      const freshEntry = {
        payload: data,
        expiresAtMs: nowMs + ttlMs,
        updatedAtMs: nowMs,
      };
      writeMemoryCache(docId, freshEntry.payload, freshEntry.expiresAtMs, freshEntry.updatedAtMs);
      try {
        if (cacheStore && typeof cacheStore.set === "function") {
          await cacheStore.set(docId, freshEntry);
        } else {
          await writeFirestoreCacheEntry(db, docId, freshEntry, { scope, path });
        }
      } catch (err) {
        logger.warn("[tmdb-cache] write failed", { key: docId, error: err?.message || String(err) });
      }
    }
    return {
      data,
      cache: { key: docId, hit: false, stale: false, source: "network", scope, ttlSeconds },
    };
  } catch (err) {
    if (allowStaleOnError && cacheEntry?.payload) {
      state.cacheStaleFallbacks = Number(state.cacheStaleFallbacks || 0) + 1;
      return {
        data: cacheEntry.payload,
        cache: { key: docId, hit: true, stale: true, source: "stale", scope, ttlSeconds },
      };
    }
    throw err;
  }
}

async function fetchTmdbGenreCatalog(state = {}) {
  const movie = await tmdbFetch("/genre/movie/list", { language: "it-IT" }, state);
  const tv = await tmdbFetch("/genre/tv/list", { language: "it-IT" }, state);
  return {
    movie: safeArray(movie?.genres),
    tv: safeArray(tv?.genres),
  };
}

function toGenreDocId(rawId) {
  const s = String(rawId || "").trim();
  if (!s) return null;
  return s.startsWith("tmdb_") ? s : `tmdb_${s}`;
}

async function ensureTmdbGenreDocs(db, genreCatalog) {
  const catalog = genreCatalog || {};
  const batch = db.batch();
  let touched = 0;

  const writeGenre = (g, type) => {
    const id = toGenreDocId(g?.id);
    const name = safeString(g?.name, 120);
    if (!id || !name) return;
    const ref = db.collection("genres").doc(id);
    batch.set(ref, {
      id,
      name,
      type,
      nameLower: normalizeText(name),
      source: "tmdb",
      tmdbGenreId: Number(String(id).replace("tmdb_", "")) || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    touched++;
  };

  safeArray(catalog.movie).forEach((g) => writeGenre(g, "movie"));
  safeArray(catalog.tv).forEach((g) => writeGenre(g, "tv"));

  if (touched > 0) {
    await batch.commit();
  }

  return touched;
}

function mapDiscoverRow(row, type) {
  const mediaType = type === "tv" ? "tv" : "movie";
  const tmdbId = Number(row?.id || 0);
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) return null;

  const title = mediaType === "tv" ? row?.name : row?.title;
  const releaseDate = mediaType === "tv" ? row?.first_air_date : row?.release_date;
  const posterPath = safeString(row?.poster_path, 240) || null;
  if (!posterPath) return null;

  return {
    ...row,
    type: mediaType,
    tmdbId,
    name: safeString(title, 160),
    release_date: releaseDate || null,
    first_air_date: mediaType === "tv" ? releaseDate : null,
    poster_path: posterPath,
    overview: safeString(row?.overview, 2000) || "",
    genre_ids: safeArray(row?.genre_ids).map((x) => Number(x)).filter((x) => Number.isFinite(x)),
    vote_average: Number(row?.vote_average || 0) || 0,
    vote_count: Number(row?.vote_count || 0) || 0,
  };
}

function pickRecentDiscoverPages(totalPages, count, usedPages = new Set()) {
  const maxPage = clamp(Number(totalPages || 1), 1, MAX_DISCOVER_WINDOW);
  const wantedRaw = Number(count || 0);
  if (!Number.isFinite(wantedRaw) || wantedRaw <= 0) return [];
  const wanted = clamp(Math.floor(wantedRaw), 1, maxPage);
  const used = usedPages instanceof Set
    ? usedPages
    : new Set(
      safeArray(usedPages)
        .map((x) => Number(x))
        .filter((x) => Number.isFinite(x) && x >= 1 && x <= maxPage)
    );
  const picked = [];
  const seen = new Set();

  const add = (page) => {
    const n = Number(page);
    if (!Number.isFinite(n)) return;
    const p = Math.floor(n);
    if (p < 1 || p > maxPage) return;
    if (used.has(p)) return;
    if (seen.has(p)) return;
    seen.add(p);
    picked.push(p);
  };

  add(1);
  for (const page of [2, 3, 4, 5, 6, 7, 8]) {
    if (picked.length >= wanted) break;
    add(page);
  }

  let guard = 0;
  while (picked.length < wanted && guard < wanted * 40) {
    const roll = Math.random();
    const page = roll < 0.75
      ? (1 + Math.floor(Math.pow(Math.random(), 1.8) * maxPage))
      : (1 + Math.floor(Math.random() * maxPage));
    add(page);
    guard++;
    if (used.size + picked.length >= maxPage) break;
  }

  if (picked.length < wanted) {
    for (let page = 1; page <= maxPage && picked.length < wanted; page++) {
      add(page);
    }
  }

  return picked;
}

async function fetchTmdbRecentCandidatesForType(type, state = {}, options = {}) {
  const mediaType = type === "tv" ? "tv" : "movie";
  const candidates = [];
  const processPage = (payload) => {
    safeArray(payload?.results).forEach((row) => {
      if (!row?.poster_path) return;
      const mapped = mapDiscoverRow(row, mediaType);
      if (mapped) candidates.push(mapped);
    });
  };

  const stateObj = state && typeof state === "object" ? state : {};
  const language = safeString(options.language || "it-IT", 16) || "it-IT";
  const sortBy = safeString(options.sortBy || "popularity.desc", 40) || "popularity.desc";
  const voteCountGteRaw = Number(options.voteCountGte || 10);
  const voteCountGte = Number.isFinite(voteCountGteRaw) ? Math.max(0, Math.floor(voteCountGteRaw)) : 10;
  const pageWindow = clamp(
    Number(options.pageWindow || stateObj.recentPageWindow || MAX_DISCOVER_WINDOW),
    1,
    MAX_DISCOVER_WINDOW
  );
  const pagesPerCall = clamp(
    Number(options.pagesPerCall || stateObj.pagesPerType || MAX_PAGES),
    1,
    Math.max(1, pageWindow)
  );

  if (!stateObj.__discoverCursors || typeof stateObj.__discoverCursors !== "object") {
    stateObj.__discoverCursors = {};
  }

  let cursor = stateObj.__discoverCursors[mediaType];
  if (!cursor || typeof cursor !== "object") {
    cursor = {
      totalPages: null,
      usedPages: new Set(),
      firstPagePayload: null,
    };
    stateObj.__discoverCursors[mediaType] = cursor;
  }
  if (!(cursor.usedPages instanceof Set)) {
    cursor.usedPages = new Set(
      safeArray(cursor.usedPages)
        .map((x) => Number(x))
        .filter((x) => Number.isFinite(x) && x >= 1 && x <= MAX_DISCOVER_WINDOW)
    );
  }

  if (!Number.isFinite(cursor.totalPages) || cursor.totalPages <= 0) {
    const firstPage = await tmdbFetch(`/discover/${mediaType}`, {
      language,
      sort_by: sortBy,
      "vote_count.gte": voteCountGte,
      page: 1,
    }, stateObj);
    cursor.totalPages = clamp(Number(firstPage?.total_pages || 1), 1, MAX_DISCOVER_WINDOW);
    cursor.firstPagePayload = firstPage;
  }

  const maxPage = clamp(Math.min(Number(cursor.totalPages || 1), pageWindow), 1, MAX_DISCOVER_WINDOW);
  if (cursor.usedPages.size >= maxPage) {
    return {
      candidates,
      pagesFetched: [],
      exhausted: true,
      totalPages: maxPage,
      remainingPages: 0,
    };
  }

  const wantedPages = Math.min(pagesPerCall, Math.max(0, maxPage - cursor.usedPages.size));
  const pages = pickRecentDiscoverPages(maxPage, wantedPages, cursor.usedPages);

  for (const page of pages) {
    let payload = null;
    if (page === 1 && cursor.firstPagePayload) {
      payload = cursor.firstPagePayload;
      cursor.firstPagePayload = null;
    } else {
      payload = await tmdbFetch(`/discover/${mediaType}`, {
        language,
        sort_by: sortBy,
        "vote_count.gte": voteCountGte,
        page,
      }, stateObj);
    }
    processPage(payload);
    cursor.usedPages.add(page);
  }

  return {
    candidates,
    pagesFetched: pages,
    exhausted: cursor.usedPages.size >= maxPage,
    totalPages: maxPage,
    remainingPages: Math.max(0, maxPage - cursor.usedPages.size),
  };
}

function tmdbTitleDocId(type, tmdbId) {
  const mediaType = type === "tv" ? "tv" : "movie";
  return `tmdb_${mediaType}_${String(tmdbId)}`;
}

function tmdbLogicalDuplicateKey(row) {
  const name = normalizeText(row?.title || row?.name);
  const year = safeString(row?.release_date || row?.first_air_date || "", 4);
  if (!name) return "";
  // Gli id TMDB collidono tra movie e tv (es. 1891 = movie "L'Impero colpisce
  // ancora" E tv "Rome"): la chiave logica deve includere il tipo, altrimenti
  // un film e una serie con stesso nome+anno collidono nella cache di dedup.
  const mediaType = row?.type === "tv" ? "tv" : "movie";
  return `${mediaType}__${name}__${year}`;
}

// Tipo media canonico di un doc `titles` (root `type`, fallback `meta.mediaType`).
function titleDocMediaType(doc) {
  const t = doc?.get ? doc.get("type") : doc?.type;
  if (t === "tv" || t === "movie") return t;
  const metaType = doc?.get ? doc.get("meta")?.mediaType : doc?.meta?.mediaType;
  return metaType === "tv" ? "tv" : "movie";
}

// Paesi rilevanti per gli alternative_titles: IT (localizzazione italiana,
// import Netflix), US/GB (fonte piu' comune per import EN come TV Time export
// in inglese/originale). Tutti gli altri paesi TMDB restano fuori dal
// denormalizzato altNamesLower per tenerlo piccolo e mirato al matching import.
const ALT_NAMES_RELEVANT_COUNTRIES = new Set(["IT", "US", "GB"]);
const ALT_NAMES_MAX_ITEMS = 10;

/**
 * Estrae le varianti di nome normalizzate (lowercase, accent-stripped, via
 * normalizeText) da un payload TMDB details `{ original_title|original_name,
 * alternative_titles: { titles|results: [{iso_3166_1, title}] } }`.
 *
 * - Include SEMPRE il titolo originale (original_title/original_name), utile
 *   per import EN (TV Time) quando il titolo TMDB "name"/"title" e' localizzato IT.
 * - Filtra gli alternative_titles ai soli paesi in ALT_NAMES_RELEVANT_COUNTRIES
 *   (IT/US/GB) — TMDB elenca decine di varianti per mercato, la maggior parte
 *   irrilevante per un import da un utente italiano.
 * - Dedup + esclude qualunque variante che normalizza uguale a `nameLower`
 *   (nessun valore ridondante nell'array — nameLower e' gia' indicizzato).
 * - Cap a ALT_NAMES_MAX_ITEMS per tenere il doc piccolo (array-contains non
 *   beneficia di array enormi, e la maggior parte del segnale utile sta nelle
 *   prime varianti).
 */
function extractAltNamesLower(details, { nameLower = "", mediaType: mediaTypeHint } = {}) {
  const data = asObject(details);
  // Prefer an explicit type hint (search rows carry `row.type`, the refresh
  // flow knows `target.mediaType`); fall back to shape-sniffing the payload
  // (a tv details/search row has `first_air_date`/`name`, a movie has
  // `release_date`/`title` — `original_name` is TV-only, `original_title` is
  // movie-only, so checking those directly avoids false positives from a
  // movie row that happens to also carry an unrelated `name` field).
  const mediaType = mediaTypeHint === "tv" || mediaTypeHint === "movie"
    ? mediaTypeHint
    : (data.type === "tv" || data.type === "movie")
      ? data.type
      : (data.original_name !== undefined || data.first_air_date !== undefined) ? "tv" : "movie";
  const originalRaw = safeString(
    mediaType === "tv" ? data.original_name : data.original_title,
    160
  ).trim();

  const altPayload = asObject(data.alternative_titles);
  const rows = [
    ...safeArray(altPayload.titles),
    ...safeArray(altPayload.results),
  ];
  const filteredAltTitles = rows
    .filter((row) => ALT_NAMES_RELEVANT_COUNTRIES.has(safeString(row?.iso_3166_1 || "", 4).trim().toUpperCase()))
    .map((row) => row?.title || row?.name);

  const candidates = [originalRaw, ...filteredAltTitles];
  const excludeLower = normalizeText(nameLower);

  const out = [];
  const seen = new Set();
  for (const raw of candidates) {
    const normalized = normalizeText(raw);
    if (!normalized || normalized.length < 2) continue;
    if (normalized === excludeLower) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= ALT_NAMES_MAX_ITEMS) break;
  }
  return out;
}

async function existsLogicalDuplicateTitle(db, row, cache) {
  const logicalKey = tmdbLogicalDuplicateKey(row);
  if (!logicalKey) return null;

  if (cache instanceof Map && cache.has(logicalKey)) {
    return cache.get(logicalKey) || null;
  }

  const rowType = row?.type === "tv" ? "tv" : "movie";
  const sameType = (doc) => titleDocMediaType(doc) === rowType;

  // L'id TMDB e' il segnale di dedup piu' forte: un titolo gia' presente puo'
  // possederlo direttamente (tmdbId) o tramite un merge manuale (mergedTmdbIds).
  // ATTENZIONE: gli id TMDB collidono tra movie e tv (es. 1891 = movie + tv),
  // quindi filtra sempre per tipo per non agganciare/mergeare un doc di tipo
  // diverso. Post-filtro client-side (la collisione e' al massimo 1 doc per
  // tipo) per non richiedere un indice composito tmdbId+type.
  const rowTmdbId = Number(row?.tmdbId || row?.id) || null;
  if (rowTmdbId) {
    const byId = await db.collection("titles")
      .where("tmdbId", "==", rowTmdbId)
      .limit(5)
      .get();
    let match = byId.docs.find(sameType);
    if (!match) {
      const byMerged = await db.collection("titles")
        .where("mergedTmdbIds", "array-contains", rowTmdbId)
        .limit(5)
        .get();
      match = byMerged.docs.find(sameType);
    }
    if (match) {
      const docId = match.id;
      if (cache instanceof Map) cache.set(logicalKey, docId);
      return docId;
    }
  }

  const nameLower = normalizeText(row?.title || row?.name);
  const year = parseYearFromDate(row?.release_date || row?.first_air_date);
  if (!nameLower || !year) {
    if (cache instanceof Map) cache.set(logicalKey, null);
    return null;
  }

  const snap = await db.collection("titles")
    .where("nameLower", "==", nameLower)
    .where("year", "==", year)
    .limit(10)
    .get();

  const match = snap.docs.find(sameType);
  const docId = match ? match.id : null;
  if (cache instanceof Map) cache.set(logicalKey, docId);
  return docId;
}

async function uploadTmdbPosterToStorage(bucket, row) {
  try {
    const docId = tmdbTitleDocId(row?.type, row?.tmdbId || row?.id);
    const posterPath = safeString(row?.poster_path, 260);
    if (!posterPath) return { url: "" };

    const imageUrl = `${TMDB_IMAGE_BASE_URL}${posterPath}`;
    const res = await fetch(imageUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());

    const token = randomUUID();
    const filePath = `posters/${docId}.jpg`;
    const file = bucket.file(filePath);
    await file.save(buffer, {
      contentType: "image/jpeg",
      metadata: {
        metadata: {
          firebaseStorageDownloadTokens: token,
        },
      },
      resumable: false,
      public: false,
    });

    const publicUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(filePath)}?alt=media&token=${token}`;
    return { url: publicUrl };
  } catch (err) {
    logger.warn("[tmdb] poster upload failed", { error: err?.message });
    return { url: "" };
  }
}

function buildTmdbTitleDoc(row, posterUrl) {
  const type = row?.type === "tv" ? "tv" : "movie";
  const name = safeString(row?.name || row?.title || row?.original_title || row?.original_name || "", 160);
  const nameLower = normalizeText(name);
  const year = parseYearFromDate(row?.release_date || row?.first_air_date) ?? (Number(row?.year) || null);
  const genres = safeArray(row?.genre_ids || row?.genres)
    .map((g) => (typeof g === "number" ? `tmdb_${g}` : String(g)))
    .filter(Boolean);
  const tokens = tokenizeNormalized(name);
  const tmdbRating = Number(row?.vote_average || row?.tmdbRating || row?.voteAverage || 0) || 0;

  const originalLanguage = safeString(row?.original_language || "", 12).trim().toLowerCase();
  const originCountry = safeArray(row?.origin_country)
    .map((code) => safeString(code || "", 4).trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 5);
  const meta = { mediaType: type };
  if (originalLanguage) meta.originalLanguage = originalLanguage;
  if (originCountry.length) meta.originCountry = originCountry;

  // `row` here is a /search/{movie|tv} or /find/{id} result, not a full
  // /movie|tv/{id} details payload — no `alternative_titles` sub-resource
  // available without an extra API call. Still worth seeding altNamesLower
  // with the original title/name (already on the row, free): a stub created
  // from an EN search (e.g. TV Time's "The Bear") often differs from the
  // localized IT name TMDB returns as `name`/`title`. Full alternative_titles
  // coverage comes later from the backfill script or refreshTitleFromTmdb.
  const altNamesLower = extractAltNamesLower(row, { nameLower, mediaType: type });

  return {
    name,
    nameLower,
    type,
    year,
    description: safeString(row?.overview || row?.description || "", 2000),
    posterPath: posterUrl || "",
    genres,
    meta,
    tmdbId: Number(row?.tmdbId || row?.id) || null,
    tmdbRating,
    status: "approved",
    source: "tmdb_auto",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    search: {
      tokens,
    },
    ...(altNamesLower.length ? { altNamesLower } : {}),
  };
}

// A TV import stub is built from a /search result, which carries no
// season/episode structure -> the title lands without a total episode count,
// so a fully-watched series can't be marked "completed" at import time (it
// stays "in corso"). Fetch the /tv/{id} details so a freshly-agganciata series
// is completion-ready. Best-effort: on any TMDB error return null and let the
// stub land seasons-less (backfill-series-episode-totals.js / lazy refresh fill
// it in later).
async function fetchTmdbTvSeasons(tmdbId) {
  const id = Number(tmdbId);
  if (!id) return null;
  try {
    const details = await tmdbFetch(`/tv/${id}`, { language: "it-IT" });
    const seasons = (details?.seasons || [])
      .filter((s) => Number(s.season_number) > 0 && Number(s.episode_count) > 0)
      .map((s) => ({ season: Number(s.season_number), episodes: Number(s.episode_count), air_date: s.air_date || null }));
    return seasons.length ? seasons : null;
  } catch (_) {
    return null;
  }
}

async function upsertTmdbTitle(db, bucket, row, logicalDupCache) {
  try {
    const logicalKey = tmdbLogicalDuplicateKey(row);
    let targetDocId = null;

    if (logicalKey && logicalDupCache instanceof Map && logicalDupCache.has(logicalKey)) {
      targetDocId = logicalDupCache.get(logicalKey);
    }

    if (!targetDocId) {
      targetDocId = await existsLogicalDuplicateTitle(db, row, logicalDupCache);
    }

    const duplicate = Boolean(targetDocId);
    const docId = targetDocId || tmdbTitleDocId(row?.type, row?.tmdbId || row?.id);

    // Mai sovrascrivere un titolo curato manualmente / sync-locked.
    if (targetDocId) {
      const existing = await db.collection("titles").doc(docId).get();
      if (existing.exists && existing.data()?.tmdbSync?.syncDisabled === true) {
        if (logicalKey && logicalDupCache instanceof Map) {
          logicalDupCache.set(logicalKey, docId);
        }
        return { imported: true, duplicate: true, error: null };
      }
    }

    const poster = await uploadTmdbPosterToStorage(bucket, row);
    const doc = buildTmdbTitleDoc(row, poster.url);

    // Solo per stub TV NUOVI (i duplicati esistono già e possono essere
    // curati): scarica la struttura stagioni/episodi così la serie è
    // completabile subito all'import invece di restare "in corso".
    if (!duplicate && String(row?.type) === "tv") {
      const seasons = await fetchTmdbTvSeasons(row?.tmdbId || row?.id);
      if (seasons) {
        doc.meta = { ...(doc.meta || {}), seasons, seasonsCount: seasons.length };
      }
    }

    await db.collection("titles").doc(docId).set(doc, { merge: true });

    if (logicalKey && logicalDupCache instanceof Map) {
      logicalDupCache.set(logicalKey, docId);
    }

    return { imported: true, duplicate, error: null };
  } catch (err) {
    return { imported: false, duplicate: false, error: safeString(err?.message || String(err), 240) };
  }
}

async function writeTmdbImportRunReport(db, payload) {
  const runId = String(payload?.runId || `${Date.now()}`);
  const summaryRef = db.collection("_system").doc("tmdbAutoImport");
  const runRef = summaryRef.collection("runs").doc(runId);
  const writePayload = {
    ...payload,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await summaryRef.set(writePayload, { merge: true });
  await runRef.set({
    ...writePayload,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

function shuffleRows(array) {
  const out = Array.from(array || []);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function resetTmdbMemoryCache() {
  tmdbMemoryCache.clear();
}

module.exports = {
  getTmdbApiKey,
  fetchTmdbCachedJson,
  normalizeText,
  tokenizeNormalized,
  fetchTmdbGenreCatalog,
  ensureTmdbGenreDocs,
  fetchTmdbRecentCandidatesForType,
  tmdbTitleDocId,
  tmdbLogicalDuplicateKey,
  titleDocMediaType,
  extractAltNamesLower,
  ALT_NAMES_RELEVANT_COUNTRIES,
  ALT_NAMES_MAX_ITEMS,
  existsLogicalDuplicateTitle,
  uploadTmdbPosterToStorage,
  buildTmdbTitleDoc,
  upsertTmdbTitle,
  writeTmdbImportRunReport,
  shuffleRows,
  safeString,
  buildTmdbCacheDocId,
  buildTmdbCacheSignature,
  normalizeCacheParams,
  normalizeCacheScope,
  resetTmdbMemoryCache,
};
