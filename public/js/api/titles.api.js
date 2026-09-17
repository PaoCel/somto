import {
  collection,
  doc,
  query,
  orderBy,
  startAt,
  endAt,
  limit,
  getDoc,
  getDocs,
  where,
  documentId,
  setDoc,
  updateDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";

import { db, app } from "../firebase.js";
import { bestSearchTokens, scoreTitleMatch } from "../utils/titleSearchRank.js";

const functions = getFunctions(app, "europe-west1");
const refreshTitleFromTmdbCallable = httpsCallable(functions, "refreshTitleFromTmdb");
const enrichTitleAssetsCallable = httpsCallable(functions, "enrichTitleAssets");
const TITLE_BY_ID_CACHE_TTL_MS = 60_000;
const TITLE_BY_ID_BATCH_SIZE = 30;
const titleByIdCache = new Map();

function normalize(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function uniqueTitleIds(ids, max = 500) {
  const safeMax = Math.max(1, Math.min(500, Number(max) || 500));
  return Array.from(new Set(
    (ids || [])
      .map((id) => String(id || "").trim())
      .filter(Boolean)
  )).slice(0, safeMax);
}

function tokenizeNormalized(norm) {
  const parts = String(norm || "")
    .split(/\s+/)
    .map(s => s.trim())
    .filter(Boolean);

  // drop 1-char tokens (troppo rumorosi)
  return unique(parts.filter(p => p.length >= 2));
}

function toPositiveInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i > 0 ? i : null;
}

function normalizeMediaType(value) {
  return String(value || "").trim().toLowerCase() === "tv" ? "tv" : "movie";
}

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.seconds === "number") return (value.seconds * 1000) + Math.floor((value.nanoseconds || 0) / 1e6);
  return 0;
}

function parseTitleDedupeKey(rawKey) {
  const key = String(rawKey || "").trim();
  if (!key) return null;
  const match = key.match(/^(.*)_(movie|tv|null)_(null|\d{4})(?:_tmdb_\d+)?$/i);
  if (!match) return null;

  const typePart = String(match[2] || "").toLowerCase();
  const yearPart = String(match[3] || "").toLowerCase();
  const nameLower = normalize(match[1]);
  const type = typePart === "null" ? null : normalizeMediaType(typePart);
  const year = yearPart === "null" ? null : Number(yearPart);
  if (!nameLower) return null;
  return { nameLower, type, year: Number.isFinite(year) ? year : null };
}

function pickBestTitleMatch(rows, { preferredType = null, preferredTmdbId = null } = {}) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const type = preferredType ? normalizeMediaType(preferredType) : null;
  const tmdbId = toPositiveInt(preferredTmdbId);
  const sorted = [...rows].sort((a, b) => {
    const aTmdbRoot = toPositiveInt(a.tmdbId);
    const bTmdbRoot = toPositiveInt(b.tmdbId);
    const aTmdbMeta = toPositiveInt(a.meta?.tmdbId);
    const bTmdbMeta = toPositiveInt(b.meta?.tmdbId);
    const aTmdbScore = (aTmdbRoot === tmdbId || aTmdbMeta === tmdbId) ? 2 : (aTmdbRoot || aTmdbMeta ? 1 : 0);
    const bTmdbScore = (bTmdbRoot === tmdbId || bTmdbMeta === tmdbId) ? 2 : (bTmdbRoot || bTmdbMeta ? 1 : 0);
    if (aTmdbScore !== bTmdbScore) return bTmdbScore - aTmdbScore;

    const aTypeScore = type && normalizeMediaType(a.type) === type ? 1 : 0;
    const bTypeScore = type && normalizeMediaType(b.type) === type ? 1 : 0;
    if (aTypeScore !== bTypeScore) return bTypeScore - aTypeScore;

    const aCanonical = String(a.id || "").startsWith("tmdb_") ? 1 : 0;
    const bCanonical = String(b.id || "").startsWith("tmdb_") ? 1 : 0;
    if (aCanonical !== bCanonical) return bCanonical - aCanonical;

    const aRating = Number(a.ratingCount || 0);
    const bRating = Number(b.ratingCount || 0);
    if (aRating !== bRating) return bRating - aRating;

    return timestampMillis(b.updatedAt) - timestampMillis(a.updatedAt);
  });
  return sorted[0] || null;
}

export function tmdbTitleDocId(mediaType, tmdbId) {
  const cleanTmdbId = toPositiveInt(tmdbId);
  if (!cleanTmdbId) return "";
  return `tmdb_${normalizeMediaType(mediaType)}_${cleanTmdbId}`;
}


export function buildTitleSearchIndex({ name, type, year, aliases = [], originalName = null } = {}){
  const nameLower = normalize(name);
  const aNorm = (Array.isArray(aliases) ? aliases : []).map(normalize).filter(Boolean);
  const oNorm = originalName ? [normalize(originalName)] : [];
  const all = [nameLower, ...aNorm, ...oNorm].filter(Boolean).join(" ");
  const tokens = tokenizeNormalized(all);

  const prefixes = [];
  for (let i = 1; i <= Math.min(12, nameLower.length); i++) {
    prefixes.push(nameLower.slice(0, i));
  }

  const dedupeKey = `${nameLower}_${type || "null"}_${year ?? "null"}`;

  return {
    nameLower,
    search: {
      normalized: nameLower,
      dedupeKey,
      prefixes,
      tokens,
    }
  };
}

export function makeDedupeKey(name, type, year){
  const nameLower = normalize(name);
  return `${nameLower}_${type || "null"}_${year ?? "null"}`;
}



/**
 * Titoli popolari (proxy: ordina per ratingCount DESC). Replica iOS
 * TitleRepository.listPopularTitles, usato dalla Home empty state come
 * sezione "Tendenze".
 */
export async function listPopularTitles(max = 10) {
  const q = query(
    collection(db, "titles"),
    where("status", "==", "approved"),
    orderBy("ratingCount", "desc"),
    limit(max),
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Titoli più recenti approvati. Replica iOS
 * TitleRepository.listRecentApprovedTitles, usato dalla Home empty state come
 * sezione "Novità".
 */
export async function listRecentApprovedTitles(max = 10) {
  const q = query(
    collection(db, "titles"),
    where("status", "==", "approved"),
    orderBy("createdAt", "desc"),
    limit(max),
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Titoli del catalogo che matchano una lista di id TMDB (root `tmdbId`).
 * Query `in` a chunk da 30 su campo singolo (nessun indice composito:
 * lo status si filtra client-side). Usata dalla Home per capire quali
 * tendenze TMDB sono già in catalogo.
 */
export async function listTitlesByTmdbIds(tmdbIds = []) {
  const ids = [...new Set(tmdbIds.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0))];
  const out = new Map();
  for (let i = 0; i < ids.length; i += 30) {
    const chunk = ids.slice(i, i + 30);
    const q = query(collection(db, "titles"), where("tmdbId", "in", chunk));
    const snap = await getDocs(q);
    for (const d of snap.docs) {
      const data = { id: d.id, ...d.data() };
      if (data.status === "approved") out.set(Number(data.tmdbId), data);
    }
  }
  return out;
}

export async function searchTitlesByPrefix(prefix, max = 20){
  const p = normalize(prefix);
  if (!p) return [];

  // Mostra solo contenuti visibili a tutti
  const q = query(
    collection(db, "titles"),
    where("status", "==", "approved"),
    orderBy("nameLower"),
    startAt(p),
    endAt(p + "\uf8ff"),
    limit(max)
  );

  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}


/**
 * Query di appoggio per `searchTitlesSmart`: range su `nameLower` (exact
 * quando start===end, prefix classico quando end ha il suffisso ``).
 * Stesso indice composito esistente di `searchTitlesByPrefix`
 * (`status asc, nameLower asc`, firestore.indexes.json) — nessun nuovo indice.
 */
async function fetchApprovedTitlesByNameLowerRange(start, end, max) {
  try {
    const q = query(
      collection(db, "titles"),
      where("status", "==", "approved"),
      orderBy("nameLower"),
      startAt(start),
      endAt(end),
      limit(max)
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.warn("searchTitlesSmart nameLower range query failed:", err?.message || err);
    return [];
  }
}

/**
 * Query per token su `search.tokens`, ordinata per `ratingCount` desc:
 * usa l'indice esistente `search.tokens CONTAINS, ratingCount DESC`
 * (firestore.indexes.json:59-72), che NON include `status` — filtrato
 * client-side (i titoli sono a lettura pubblica, va bene).
 */
async function fetchApprovedTitlesByToken(token, max) {
  try {
    const q = query(
      collection(db, "titles"),
      where("search.tokens", "array-contains", token),
      orderBy("ratingCount", "desc"),
      limit(max)
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(t => t.status === "approved");
  } catch (err) {
    console.warn("searchTitlesSmart token query failed:", err?.message || err);
    return [];
  }
}

/**
 * Ricerca titoli "smart": lancia in parallelo (Promise.all) match esatto,
 * prefix e ricerca per token (con eventuale secondo token), poi merge/dedupe
 * per id e scoring puro (`titleSearchRank.scoreTitleMatch`). Permette a
 * "beekeeper" di trovare "The Beekeeper" (via `stripLeadingArticle` nel
 * modulo di scoring) senza perdere un match esatto come "Natale a Rio"
 * dentro agli 80 risultati non ordinati della sola query per token (bug del
 * flusso precedente: nessun `orderBy`, filtro/scoring locale su un
 * sottoinsieme arbitrario).
 *
 * Costo Firestore worst-case per chiamata: 3 (exact) + 20 (prefix) +
 * tokenLimit (primo token, fino a 80) + tokenLimit (secondo token, SOLO se
 * la query ha >=2 token utili e il primo token satura il limite o non copre
 * il secondo) = fino a 183 letture. Caso tipico (query a 1 token, o secondo
 * token non necessario): fino a 103 letture. Nessun nuovo indice, nessun
 * backfill.
 */
export async function searchTitlesSmart(term, max = 20){
  const n = normalize(term);
  if (!n) return [];

  const tokens = tokenizeNormalized(n);
  const bestTokens = bestSearchTokens(tokens, 2);
  const tokenLimit = Math.min(80, Math.max(max * 4, 40));

  const [exact, prefix, firstTokenResults] = await Promise.all([
    fetchApprovedTitlesByNameLowerRange(n, n, 3),
    fetchApprovedTitlesByNameLowerRange(n, n + "", 20),
    bestTokens[0] ? fetchApprovedTitlesByToken(bestTokens[0], tokenLimit) : Promise.resolve([]),
  ]);

  let secondTokenResults = [];
  if (bestTokens.length > 1) {
    const secondToken = bestTokens[1];
    const saturated = firstTokenResults.length >= tokenLimit;
    const coversSecondToken = firstTokenResults.some(t => {
      const toks = (t.search && Array.isArray(t.search.tokens)) ? t.search.tokens : [];
      return toks.includes(secondToken) || normalize(t.searchableText || "").includes(secondToken);
    });
    if (saturated || !coversSecondToken) {
      secondTokenResults = await fetchApprovedTitlesByToken(secondToken, tokenLimit);
    }
  }

  const byId = new Map();
  for (const t of [...exact, ...prefix, ...firstTokenResults, ...secondTokenResults]) {
    if (!byId.has(t.id)) byId.set(t.id, t);
  }

  const ranked = [...byId.values()]
    .map(t => ({ t, score: scoreTitleMatch(t, n, tokens) }))
    .filter(r => r.score > 0)
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      const aC = Number(a.t.ratingCount || 0);
      const bC = Number(b.t.ratingCount || 0);
      if (aC !== bC) return bC - aC;
      const aY = Number(a.t.year || 0);
      const bY = Number(b.t.year || 0);
      return bY - aY;
    });

  if (ranked.length) return ranked.slice(0, max).map(r => r.t);

  // Tutte le query sopra sono fallite (permessi/indice mancante): ultimo
  // ripiego, prefix classico.
  return searchTitlesByPrefix(n, max);
}

/**
 * Fetch recently created titles by a set of users (max 10 uids per Firestore 'in').
 * Returns approved titles ordered by createdAt desc.
 */
export async function listRecentTitlesByUsers(uids, max = 30) {
  if (!uids || !uids.length) return [];
  const chunks = [];
  for (let i = 0; i < uids.length; i += 10) {
    chunks.push(uids.slice(i, i + 10));
  }
  const all = [];
  for (const chunk of chunks) {
    const q = query(
      collection(db, "titles"),
      where("status", "==", "approved"),
      where("createdBy", "in", chunk),
      orderBy("createdAt", "desc"),
      limit(max)
    );
    const snap = await getDocs(q);
    for (const d of snap.docs) all.push({ id: d.id, ...d.data() });
  }
  all.sort((a, b) => {
    const ta = a.createdAt?.seconds || 0;
    const tb = b.createdAt?.seconds || 0;
    return tb - ta;
  });
  return all.slice(0, max);
}

export async function getTitleById(id){
  const ref = doc(db, "titles", id);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  const title = { id: snap.id, ...snap.data() };
  titleByIdCache.set(snap.id, {
    title,
    expiresAt: Date.now() + TITLE_BY_ID_CACHE_TTL_MS,
  });
  return title;
}

export async function refreshTitleFromTmdbIfNeeded(titleId, opts = {}) {
  const cleanTitleId = String(titleId || "").trim();
  if (!cleanTitleId) return { ok: false, checked: false, updated: false, reason: "missing_title_id" };

  const payload = { titleId: cleanTitleId };
  if (opts?.force === true) payload.force = true;

  try {
    const res = await refreshTitleFromTmdbCallable(payload);
    return res?.data || { ok: false, checked: false, updated: false, reason: "empty_response" };
  } catch (err) {
    return {
      ok: false,
      checked: false,
      updated: false,
      reason: "call_error",
      error: String(err?.message || err || ""),
    };
  }
}

/**
 * Arricchisce trailer/cast lato server (functions/index.js enrichTitleAssets,
 * ~L4131): idempotente, scrive castWithCharacters/trailerUrl su titles/{id}
 * quando mancano. Richiede login (la callable rifiuta senza auth) — il
 * chiamante deve gia' aver verificato currentUser prima di invocarla.
 * Fallisce in silenzio (null) su qualunque errore: e' un arricchimento
 * best-effort, mai bloccante per la pagina titolo.
 */
export async function enrichTitleAssets(titleId, { includeCast = true, includeTrailer = true, tmdbId, mediaType } = {}) {
  const cleanTitleId = String(titleId || "").trim();
  if (!cleanTitleId) return null;

  const payload = { titleId: cleanTitleId, includeCast, includeTrailer };
  if (tmdbId) payload.tmdbId = Number(tmdbId);
  if (mediaType) payload.mediaType = mediaType;

  try {
    const res = await enrichTitleAssetsCallable(payload);
    return res?.data || null;
  } catch (err) {
    console.warn("[titles] enrichTitleAssets failed", err?.message || err);
    return null;
  }
}

export async function getTitlesByIds(ids, { max = 500, cacheTtlMs = TITLE_BY_ID_CACHE_TTL_MS } = {}) {
  const uniq = uniqueTitleIds(ids, max);
  const out = new Map();
  if (!uniq.length) return out;

  const now = Date.now();
  const missing = [];
  for (const id of uniq) {
    const cached = titleByIdCache.get(id);
    if (cached && cached.expiresAt > now) {
      out.set(id, cached.title);
    } else {
      titleByIdCache.delete(id);
      missing.push(id);
    }
  }

  const expiresAt = now + Math.max(0, Number(cacheTtlMs) || 0);
  const chunks = [];
  for (let i = 0; i < missing.length; i += TITLE_BY_ID_BATCH_SIZE) {
    chunks.push(missing.slice(i, i + TITLE_BY_ID_BATCH_SIZE));
  }

  // Chunk queries sono indipendenti tra loro: eseguirle in parallelo invece che
  // in serie taglia la latenza totale a ~1 round-trip invece di N. Un chunk che
  // fallisce non deve far perdere i titoli già risolti dagli altri chunk.
  await Promise.all(chunks.map(async (chunk) => {
    try {
      const q = query(
        collection(db, "titles"),
        where(documentId(), "in", chunk),
        limit(chunk.length)
      );
      const snap = await getDocs(q);
      snap.docs.forEach((d) => {
        const title = { id: d.id, ...d.data() };
        out.set(d.id, title);
        if (expiresAt > Date.now()) {
          titleByIdCache.set(d.id, { title, expiresAt });
        }
      });
    } catch (err) {
      console.error("getTitlesByIds: chunk fallito", err);
    }
  }));

  return out;
}

export async function listTitlesByIds(ids, { max = 200 } = {}) {
  const uniq = uniqueTitleIds(ids, max);
  if (!uniq.length) return [];

  const byId = await getTitlesByIds(uniq, { max });
  return uniq.map((id) => byId.get(id)).filter(Boolean);
}

/**
 * List approved titles matching any of the given genre keys.
 * Falls back to popular titles if no genres provided.
 */
export async function listTitlesByGenres(genreKeys = [], max = 40) {
  const safeMax = Math.max(1, Math.min(120, Number(max) || 40));
  const keys = unique(genreKeys).slice(0, 10);

  const results = new Map();

  if (keys.length) {
    try {
      const qGenre = query(
        collection(db, "titles"),
        where("status", "==", "approved"),
        where("genres", "array-contains-any", keys),
        limit(safeMax * 2)
      );
      const snap = await getDocs(qGenre);
      snap.docs.forEach((d) => {
        if (!results.has(d.id)) results.set(d.id, { id: d.id, ...d.data() });
      });
    } catch (err) {
      console.warn("listTitlesByGenres genre query failed:", err?.message || err);
    }
  }

  // Fill with popular titles if not enough results
  if (results.size < safeMax) {
    try {
      const qPopular = query(
        collection(db, "titles"),
        where("status", "==", "approved"),
        orderBy("ratingCount", "desc"),
        limit(safeMax)
      );
      const snap = await getDocs(qPopular);
      snap.docs.forEach((d) => {
        if (!results.has(d.id)) results.set(d.id, { id: d.id, ...d.data() });
      });
    } catch (err) {
      console.warn("listTitlesByGenres popular fallback failed:", err?.message || err);
    }
  }

  return [...results.values()].slice(0, safeMax);
}

export async function updateTitle(id, data){
  const ref = doc(db, "titles", id);
  await updateDoc(ref, { ...data, updatedAt: serverTimestamp() });
}


export async function findTitleByDedupeKey(dedupeKey, opts = {}){
  const requestedKey = String(dedupeKey || "").trim();
  if (!requestedKey) return null;
  const uid = opts?.uid || null;

  // 1) Cerca tra i contenuti pubblici
  const qApproved = query(
    collection(db, "titles"),
    where("status", "==", "approved"),
    where("search.dedupeKey", "==", requestedKey),
    limit(1)
  );
  const s1 = await getDocs(qApproved);
  if (!s1.empty) return { id: s1.docs[0].id, ...s1.docs[0].data() };

  // 2) (Facoltativo) Cerca tra i tuoi pending, così eviti doppi inserimenti tuoi
  if (uid){
    const qMinePending = query(
      collection(db, "titles"),
      where("status", "==", "pending"),
      where("createdBy", "==", uid),
      where("search.dedupeKey", "==", requestedKey),
      limit(1)
    );
    const s2 = await getDocs(qMinePending);
    if (!s2.empty) return { id: s2.docs[0].id, ...s2.docs[0].data() };
  }

  // 3) Fallback robusto: alcuni titoli legacy hanno dedupeKey non standard.
  const parsed = parseTitleDedupeKey(requestedKey);
  if (parsed?.nameLower) {
    try {
      const prefixSeed = parsed.nameLower
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 3)
        .join(" ")
        .trim() || parsed.nameLower;
      const qName = query(
        collection(db, "titles"),
        where("status", "==", "approved"),
        orderBy("nameLower"),
        startAt(prefixSeed),
        endAt(`${prefixSeed}\uf8ff`),
        limit(40)
      );
      const nameSnap = await getDocs(qName);
      const candidates = nameSnap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((row) => {
          const sameName = normalize(row.nameLower || row.name || "") === parsed.nameLower;
          if (!sameName) return false;
          if (parsed.type && normalizeMediaType(row.type) !== parsed.type) return false;
          if (parsed.year != null && Number(row.year || 0) !== parsed.year) return false;
          return true;
        });
      if (candidates.length) {
        return pickBestTitleMatch(candidates, { preferredType: parsed.type });
      }
    } catch (err) {
      console.warn("findTitleByDedupeKey fallback failed:", err?.message || err);
    }
  }

  return null;
}

export async function findTitleByTmdbId(tmdbId, mediaType, opts = {}) {
  const cleanTmdbId = toPositiveInt(tmdbId);
  if (!cleanTmdbId) return null;

  const uid = opts?.uid || null;
  const preferredType = normalizeMediaType(mediaType);
  const canonicalId = tmdbTitleDocId(preferredType, cleanTmdbId);
  if (canonicalId) {
    const canonicalSnap = await getDoc(doc(db, "titles", canonicalId));
    if (canonicalSnap.exists()) {
      const row = { id: canonicalSnap.id, ...canonicalSnap.data() };
      if (row.status === "approved" || (uid && row.createdBy === uid)) return row;
    }
  }

  const queries = [
    query(
      collection(db, "titles"),
      where("status", "==", "approved"),
      where("tmdbId", "==", cleanTmdbId),
      limit(8)
    ),
    query(
      collection(db, "titles"),
      where("status", "==", "approved"),
      where("meta.tmdbId", "==", cleanTmdbId),
      limit(8)
    ),
  ];

  const rows = [];
  for (const q of queries) {
    try {
      const snap = await getDocs(q);
      snap.docs.forEach((d) => rows.push({ id: d.id, ...d.data() }));
    } catch (err) {
      // Best effort: if an index is missing, keep fallback behavior.
      console.warn("findTitleByTmdbId query failed:", err?.message || err);
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row?.id || seen.has(row.id)) continue;
    seen.add(row.id);
    deduped.push(row);
  }
  if (!deduped.length) return null;

  return pickBestTitleMatch(
    deduped.filter((row) => normalizeMediaType(row.type) === preferredType || !mediaType),
    { preferredType, preferredTmdbId: cleanTmdbId }
  ) || pickBestTitleMatch(deduped, { preferredType, preferredTmdbId: cleanTmdbId });
}


function generateSlug(name, year) {
  const base = String(name || "")
    .trim()
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return year ? `${base}-${year}` : base;
}

async function findUniqueSlug(baseSlug) {
  // Prova lo slug base (1 read)
  const baseRef = doc(db, "titles", baseSlug);
  const baseSnap = await getDoc(baseRef);
  if (!baseSnap.exists()) return baseSlug;

  // Slug occupato: prova con suffisso random breve (1 read)
  const rand = Math.random().toString(36).slice(2, 6);
  const candidate = `${baseSlug}-${rand}`;
  const candRef = doc(db, "titles", candidate);
  const candSnap = await getDoc(candRef);
  if (!candSnap.exists()) return candidate;

  // Fallback: timestamp garantisce unicità
  return `${baseSlug}-${Date.now()}`;
}

export async function createTitle({
  name,
  type,
  year,
  genres,
  originalName,
  aliases,
  directors,
  directorIds,
  cast,
  castIds,
  status,
  createdBy,
  dedupeKey,
  meta,
  description,
  posterPath,
  backdropPath,
  tmdbId,
  docId,
}){
  const normalizedType = normalizeMediaType(type);
  const nameLower = normalize(name);

  // Minimal prefixes for search (first 6 chars)
  const prefixes = [];
  for (let i = 1; i <= Math.min(6, nameLower.length); i++){
    prefixes.push(nameLower.slice(0, i));
  }

  // Tokens for smart search (word-level matching)
  const allSearchText = [nameLower];
  if (originalName) {
    const oNorm = normalize(originalName);
    if (oNorm) allSearchText.push(oNorm);
  }
  if (Array.isArray(aliases)) {
    for (const a of aliases) {
      const aNorm = normalize(a);
      if (aNorm) allSearchText.push(aNorm);
    }
  }
  const tokenSet = new Set();
  for (const t of allSearchText) {
    for (const w of t.split(/\s+/).filter(Boolean)) {
      if (w.length >= 2) tokenSet.add(w);
    }
  }
  const tokens = [...tokenSet];

  const safeStatus = status === "approved" ? "approved" : "pending";
  const safeDedupeKey = String(dedupeKey || makeDedupeKey(name, normalizedType, year)).trim();
  const safeMeta = (meta && typeof meta === "object" && !Array.isArray(meta)) ? { ...meta } : {};
  const cleanTmdbId = toPositiveInt(tmdbId ?? safeMeta.tmdbId);
  if (cleanTmdbId) {
    safeMeta.tmdbId = cleanTmdbId;
    if (!safeMeta.mediaType) safeMeta.mediaType = normalizedType;
  }

  const docData = {
    type: normalizedType,
    name,
    nameLower,
    year: year ?? null,
    genres: Array.isArray(genres) ? genres : [],
    originalName: originalName ?? null,
    aliases: Array.isArray(aliases) ? aliases : [],
    // People (optional)
    directors: Array.isArray(directors) ? directors.filter(Boolean) : [],
    directorIds: Array.isArray(directorIds) ? directorIds.filter(Boolean) : [],
    cast: Array.isArray(cast) ? cast.filter(Boolean) : [],
    castIds: Array.isArray(castIds) ? castIds.filter(Boolean) : [],
    description: description || null,
    posterPath: posterPath || null,
    backdropPath: backdropPath || null,
    createdBy,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    status: safeStatus,
    search: {
      normalized: nameLower,
      dedupeKey: safeDedupeKey,
      prefixes,
      tokens,
    },
    meta: safeMeta,
    tmdbId: cleanTmdbId || null,
    ratingCount: 0,
    ratingAvg: 0,
    reviewCount: 0,
  };

  const requestedDocId = String(docId || "").trim();
  let ref;
  if (requestedDocId) {
    ref = doc(db, "titles", requestedDocId);
    const existing = await getDoc(ref);
    if (existing.exists()) return { id: requestedDocId, existed: true };
  } else {
    const baseSlug = generateSlug(name, year);
    const slug = await findUniqueSlug(baseSlug);
    ref = doc(db, "titles", slug);
  }

  await setDoc(ref, docData);
  return { id: ref.id, existed: false };
}

/* ============================================================
   Correlati unificati + Saga (scheda titolo)
   ============================================================ */

const RELATED_CURATED_MAX = 30;
const RELATED_COLLAB_MAX = 24;
const RELATED_GENRE_FALLBACK_MAX = 24;
const RELATED_CANDIDATES_MAX = 40;
const SAGA_TITLES_MAX = 30;

/**
 * Correlati unificati per la scheda titolo: curati (`title.related`, solo
 * approvati) + collaborativi (`titles/{id}/aggregates/similar`, solo se
 * loggato) + fallback per genere quando i primi due segnali non bastano
 * (mirror di `TitleRepository.fetchRelatedTitles` su iOS: status approved,
 * genres array-contains-any ≤10, nessun orderBy in query per non richiedere
 * un indice composito nuovo — l'ordinamento vero vive in relatedRanking.js).
 * Ritorna dati grezzi (nessun ordinamento): il chiamante passa il risultato
 * a `rankRelatedTitles` insieme a `excludeIds` (titolo pagina + saga).
 *
 * Costo letture per apertura pagina, worst case (utente loggato):
 * - 1 getDoc `titles/{id}/aggregates/similar` (anche se assente)
 * - 1 getDoc `users/{uid}/tasteProfile/agg` (anche se assente)
 * - fino a 40 letture doc per i candidati curati+collaborativi (batch da 30
 *   via getTitlesByIds, cache 60s — quasi mai il worst case pieno)
 * - se dopo curati+collaborativi restano <24 candidati: 1 query genere,
 *   fino a 24 letture doc aggiuntive
 * Totale worst case ~2 getDoc + ~64 letture doc; tipico (pochi correlati
 * curati, profilo gusti gia' in cache) molto piu' basso.
 */
export async function getRelatedTitlesUnified(title, { uid = null } = {}) {
  const pageId = String(title?.id || "").trim();
  if (!pageId) return { curatedIds: [], titles: [], similarityById: new Map(), featureSums: null };

  const curatedIds = uniqueTitleIds(title?.related, RELATED_CURATED_MAX);

  let neighbors = [];
  let featureSums = null;
  if (uid) {
    const [simSnap, tasteSnap] = await Promise.all([
      getDoc(doc(db, "titles", pageId, "aggregates", "similar")).catch((err) => {
        console.warn("getRelatedTitlesUnified: similar aggregate failed", err?.message || err);
        return null;
      }),
      getDoc(doc(db, "users", uid, "tasteProfile", "agg")).catch((err) => {
        console.warn("getRelatedTitlesUnified: taste profile failed", err?.message || err);
        return null;
      }),
    ]);
    const simData = simSnap?.exists?.() ? simSnap.data() : null;
    neighbors = Array.isArray(simData?.neighbors) ? simData.neighbors : [];
    const tasteData = tasteSnap?.exists?.() ? tasteSnap.data() : null;
    featureSums = tasteData?.featureSums || null;
  }

  const collabIds = uniqueTitleIds(neighbors.map((n) => n?.id), RELATED_COLLAB_MAX)
    .filter((id) => !curatedIds.includes(id));
  const similarityById = new Map(
    neighbors
      .map((n) => [String(n?.id || "").trim(), { score: Number(n?.score || 0) }])
      .filter(([id]) => id)
  );

  const primaryIds = uniqueTitleIds([...curatedIds, ...collabIds], RELATED_CANDIDATES_MAX);
  const primaryMap = await getTitlesByIds(primaryIds, { max: RELATED_CANDIDATES_MAX });

  const approvedCuratedIds = curatedIds.filter((id) => id !== pageId && primaryMap.get(id)?.status === "approved");
  const approvedCollabIds = collabIds.filter((id) => id !== pageId && primaryMap.get(id)?.status === "approved");

  const titles = [...approvedCuratedIds, ...approvedCollabIds].map((id) => primaryMap.get(id)).filter(Boolean);

  if (titles.length < RELATED_GENRE_FALLBACK_MAX) {
    const genreKeys = unique(title?.genres).slice(0, 10);
    if (genreKeys.length) {
      try {
        const snap = await getDocs(query(
          collection(db, "titles"),
          where("status", "==", "approved"),
          where("genres", "array-contains-any", genreKeys),
          limit(RELATED_GENRE_FALLBACK_MAX),
        ));
        const seen = new Set(titles.map((t) => t.id));
        snap.docs.forEach((d) => {
          if (d.id === pageId || seen.has(d.id)) return;
          seen.add(d.id);
          titles.push({ id: d.id, ...d.data() });
        });
      } catch (err) {
        console.warn("getRelatedTitlesUnified: genre fallback failed", err?.message || err);
      }
    }
  }

  return { curatedIds: approvedCuratedIds, titles, similarityById, featureSums };
}

/**
 * Titoli della stessa saga (`collectionId` condiviso — solo film), ordinati
 * per anno crescente. Query dedicata (indice `collectionId + status + year`
 * in aggiunta): al massimo `max` letture doc.
 */
export async function listSagaTitles(collectionId, { max = SAGA_TITLES_MAX } = {}) {
  const cleanId = String(collectionId || "").trim();
  if (!cleanId) return [];
  const safeMax = Math.max(1, Math.min(SAGA_TITLES_MAX, Number(max) || SAGA_TITLES_MAX));
  try {
    const snap = await getDocs(query(
      collection(db, "titles"),
      where("collectionId", "==", cleanId),
      where("status", "==", "approved"),
      orderBy("year", "asc"),
      limit(safeMax),
    ));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.warn("listSagaTitles failed:", err?.message || err);
    return [];
  }
}

/**
 * Crea una proposta di correlato (`titleRelatedSuggestions/{uid}__{titleId}__{suggestedTitleId}`).
 * Auto-approvata server-side al terzo utente distinto; gli admin/trusted
 * scrivono invece direttamente su `titles.related` (vedi addRelatedTitle in
 * title.page.js). ID deterministico: un utente puo' proporre lo stesso
 * abbinamento una sola volta (rescrivere lo stesso doc e' innocuo).
 */
export async function createRelatedSuggestion(uid, titleId, suggestedTitleId) {
  const cleanUid = String(uid || "").trim();
  const cleanTitleId = String(titleId || "").trim();
  const cleanSuggestedId = String(suggestedTitleId || "").trim();
  if (!cleanUid || !cleanTitleId || !cleanSuggestedId) {
    throw new Error("uid, titleId e suggestedTitleId sono obbligatori");
  }
  if (cleanTitleId === cleanSuggestedId) {
    throw new Error("Un titolo non può essere correlato a se stesso");
  }
  const docId = `${cleanUid}__${cleanTitleId}__${cleanSuggestedId}`;
  await setDoc(doc(db, "titleRelatedSuggestions", docId), {
    uid: cleanUid,
    titleId: cleanTitleId,
    suggestedTitleId: cleanSuggestedId,
    status: "pending",
    createdAt: serverTimestamp(),
  });
  return docId;
}
