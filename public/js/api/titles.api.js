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

const functions = getFunctions(app, "europe-west1");
const refreshTitleFromTmdbCallable = httpsCallable(functions, "refreshTitleFromTmdb");
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


export async function searchTitlesSmart(term, max = 20){
  const n = normalize(term);
  if (!n) return [];

  const tokens = tokenizeNormalized(n).sort((a,b) => b.length - a.length);
  // Prova prima una ricerca per token (parole "in mezzo")
  if (tokens.length){
    const tok = tokens[0];
    try {
      const qTok = query(
        collection(db, "titles"),
        where("status", "==", "approved"),
        where("search.tokens", "array-contains", tok),
        limit(Math.min(80, max * 4))
      );
      const snapTok = await getDocs(qTok);
      const itemsTok = snapTok.docs.map(d => ({ id: d.id, ...d.data() }));

      // filtro: match su qualunque token richiesto o substring
      const out = itemsTok.filter(t => {
        const nameLower = String(t.nameLower || "");
        const toks = (t.search && Array.isArray(t.search.tokens)) ? t.search.tokens : [];
        return nameLower.includes(n) || tokens.some(x => toks.includes(x));
      });

      // ordina: startsWith > includes > ratingCount
      out.sort((a,b) => {
        const aName = String(a.nameLower || "");
        const bName = String(b.nameLower || "");
        const aS = aName.startsWith(n) ? 2 : (aName.includes(n) ? 1 : 0);
        const bS = bName.startsWith(n) ? 2 : (bName.includes(n) ? 1 : 0);
        if (aS !== bS) return bS - aS;
        const aC = Number(a.ratingCount || 0);
        const bC = Number(b.ratingCount || 0);
        return bC - aC;
      });

      if (out.length) return out.slice(0, max);
      // fallback: prefix
    } catch (err){
      // Se manca l'indice o i vecchi titoli non hanno tokens, facciamo fallback
      console.warn("searchTitlesSmart token query failed, fallback to prefix:", err?.message || err);
    }
  }

  // fallback: prefix classico
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
