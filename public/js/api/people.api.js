import {
  collection,
  query,
  where,
  orderBy,
  startAt,
  endAt,
  startAfter,
  limit,
  getDoc,
  getDocs,
  addDoc,
  doc,
  updateDoc,
  increment,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import { db } from "../firebase.js";
import { buildPrefixes } from "../utils/text.js";
import { resolvePersonAvatar } from "./wikipedia.api.js";
import { uploadPersonAvatarFromUrl } from "./storage.api.js";

// Avatar caching policy
// - "default on" (meaning: if caching is enabled, we try it automatically)
// - BUT we only cache on Storage for "popular" people to stay within free tier
export const POPULAR_AVATAR_THRESHOLD = 10; // occurrences >= 10
export const DEFAULT_MAX_AVATAR_BYTES = 50 * 1024; // ~50KB max per cached avatar
export const DEFAULT_CACHE_POPULAR_AVATARS = true;

function normalize(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function searchPeopleByPrefix(prefix, opts = {}) {
  // Backward compat: some pages still pass (prefix, 8)
  if (typeof opts === 'number') opts = { max: opts };
  const { max = 20, role = "all" } = opts || {};
  const p = normalize(prefix);
  if (!p) return [];

  // Prefix search su people.search.prefixes (come titles.search.tokens)
  // Nota: richiede indice array-contains + optional roles
  let qBase = query(
    collection(db, "people"),
    where("search.prefixes", "array-contains", p),
    limit(Math.min(60, max * 3))
  );

  const snap = await getDocs(qBase);
  let out = snap.docs.map(d => {
    const data = d.data() || {};
    return { id: d.id, ...data, avatarUrl: getBestAvatarUrl(data) };
  });

  // filtro lato client per ruolo (evitiamo nuovi indici finché non serve)
  if (role && role !== "all") {
    out = out.filter(x => Array.isArray(x.roles) && x.roles.includes(role));
  }

  // ordina: startsWith sul nomeLower, poi alfabetico
  out.sort((a, b) => {
    const an = String(a.nameLower || "");
    const bn = String(b.nameLower || "");
    const aS = an.startsWith(p) ? 2 : (an.includes(p) ? 1 : 0);
    const bS = bn.startsWith(p) ? 2 : (bn.includes(p) ? 1 : 0);
    if (aS !== bS) return bS - aS;
    return an.localeCompare(bn, "it");
  });

  return out.slice(0, max);
}

function getBestAvatarUrl(person){
  if (!person) return '';
  return person.avatarUrl || person?.avatar?.url || person?.avatar?.storageUrl || person?.avatar?.externalUrl || '';
}

export async function getTitlesByGenre(genreIdOrName, { type = "all", max = 60 } = {}) {
  const g = String(genreIdOrName || "").trim();
  if (!g) return [];

  // NOTE: se nei titoli salvi genres come slug (es. "fantascienza"), passa quello.
  const clauses = [
    where("status", "==", "approved"),
    where("genres", "array-contains", g),
  ];
  if (type && type !== "all") clauses.push(where("type", "==", type));

  const q1 = query(collection(db, "titles"), ...clauses, limit(max));
  const snap = await getDocs(q1);
  const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // sort client-side: ratingCount desc, poi year desc
  items.sort((a, b) => {
    const aC = Number(a.ratingCount || 0);
    const bC = Number(b.ratingCount || 0);
    if (aC !== bC) return bC - aC;
    const aY = Number(a.year || 0);
    const bY = Number(b.year || 0);
    return bY - aY;
  });

  return items;
}

export async function getTitlesByPerson(personId, { type = "all", role = "all", max = 60 } = {}) {
  const pid = String(personId || "").trim();
  if (!pid) return [];

  const base = [ where("status", "==", "approved") ];
  if (type && type !== "all") base.push(where("type", "==", type));

  const wantsActor = (role === "all" || role === "actor");
  const wantsDirector = (role === "all" || role === "director");

  const queries = [];
  if (wantsActor) {
    queries.push(query(collection(db, "titles"), ...base, where("castIds", "array-contains", pid), limit(max)));
  }
  if (wantsDirector) {
    queries.push(query(collection(db, "titles"), ...base, where("directorIds", "array-contains", pid), limit(max)));
  }

  const snaps = await Promise.all(queries.map(qx => getDocs(qx)));
  const map = new Map();
  for (const s of snaps) {
    for (const d of s.docs) map.set(d.id, { id: d.id, ...d.data() });
  }

  const items = Array.from(map.values());
  items.sort((a, b) => {
    const aC = Number(a.ratingCount || 0);
    const bC = Number(b.ratingCount || 0);
    if (aC !== bC) return bC - aC;
    const aY = Number(a.year || 0);
    const bY = Number(b.year || 0);
    return bY - aY;
  });

  return items.slice(0, max);
}

// Create a new person in /people.
// If the caller isn't trusted (Firestore rules), this will throw.
export async function createPerson({
  name,
  roles = [],
  role = null,
  wikidataId = null,
  skipAvatar = false,
  cacheToStorage = DEFAULT_CACHE_POPULAR_AVATARS,
  maxBytes = DEFAULT_MAX_AVATAR_BYTES,
  occurrences = 1,
  popularOnly = true,
  popularThreshold = POPULAR_AVATAR_THRESHOLD,
} = {}){
  const n = String(name || "").trim();
  if (!n) throw new Error("Nome persona mancante");

  const nameLower = normalize(n);
  const prefixes = buildPrefixes(nameLower);

  // Support legacy call signature: createPerson({ name, role: 'actor' })
  const legacyRole = (arguments?.[0] && typeof arguments[0] === 'object') ? arguments[0].role : null;
  let rls = Array.isArray(roles) ? roles.filter(Boolean) : [];
  const roleToUse = (typeof role === 'string' && role.trim()) ? role.trim() : (typeof legacyRole === 'string' ? legacyRole.trim() : null);
  if (!rls.length && roleToUse) {
    rls = [roleToUse];
  }

  const docData = {
    name: n,
    nameLower,
    roles: rls,
    occurrences: Math.max(0, Number(occurrences || 0) || 0),
    search: {
      normalized: nameLower,
      prefixes,
      tokens: nameLower.split(/\s+/).filter(Boolean).filter(t => t.length >= 2),
    },
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  const ref = await addDoc(collection(db, "people"), docData);

  // Best-effort avatar resolution + (optional) Storage cache.
  let avatarInfo = null;
  if (!skipAvatar) {
    try {
      avatarInfo = await ensurePersonAvatar(ref.id, {
        name: n,
        wikidataId,
        cacheToStorage,
        maxBytes,
        occurrences: docData.occurrences,
        popularOnly,
        popularThreshold,
      });
    } catch {
      // ignore
    }
  }

  return {
    id: ref.id,
    ...docData,
    ...(avatarInfo ? { avatarUrl: avatarInfo.avatarUrl, avatar: avatarInfo.avatar } : {}),
  };
}

/**
 * Ensure a person has an avatarUrl on their Firestore doc.
 * Strategy:
 * 1) Resolve a tiny Wikimedia thumb (P18 on Wikidata → Commons thumb)
 * 2) Optionally cache that tiny image to Firebase Storage (deny if not small enough)
 * 3) Persist avatarUrl + metadata on the person doc
 */
export async function ensurePersonAvatar(personId, {
  name,
  wikidataId = null,
  cacheToStorage = DEFAULT_CACHE_POPULAR_AVATARS,
  maxBytes = DEFAULT_MAX_AVATAR_BYTES,
  occurrences = null,
  popularOnly = true,
  popularThreshold = POPULAR_AVATAR_THRESHOLD,
} = {}) {
  const pid = String(personId || '').trim();
  const n = String(name || '').trim();
  if (!pid || !n) return null;

  // If we only want to cache "popular" people, we need the occurrences number.
  // If caller didn't pass it, read the doc once.
  let occ = null;
  let existing = null;
  try {
    const snap = await getDoc(doc(db, 'people', pid));
    existing = snap.exists() ? snap.data() : null;
    occ = Number(existing?.occurrences ?? null);
  } catch {
    // ignore
  }

  // If we already have a stored avatar on Storage, do nothing.
  if (existing?.avatar?.source === 'storage' && existing?.avatarUrl) {
    return { avatarUrl: existing.avatarUrl, avatar: existing.avatar };
  }

  const occToUse = Number((occurrences ?? occ ?? 0) || 0);
  const shouldCache = !!cacheToStorage && (!popularOnly || occToUse >= Number(popularThreshold || 0));

  const resolved = await resolvePersonAvatar(n, { lang: 'it', width: 96, wikidataId });
  if (!resolved?.avatarUrl) return null;

  const externalUrl = resolved.avatarUrl;
  let cached = null;
  if (shouldCache) {
    try {
      cached = await uploadPersonAvatarFromUrl({ url: externalUrl, personId: pid, maxBytes });
    } catch {
      cached = null;
    }
  }

  const finalUrl = cached?.url || externalUrl;
  const avatar = {
    url: finalUrl,
    source: cached ? 'storage' : 'commons',
    externalUrl,
    storageUrl: cached?.url || null,
    storagePath: cached?.path || null,
    imageFilename: resolved?.imageFilename || null,
    wikidataId: resolved?.wikidataId || null,
    occurrences: occToUse,
    updatedAt: serverTimestamp(),
  };

  await updateDoc(doc(db, 'people', pid), {
    wikidataId: resolved?.wikidataId || wikidataId || null,
    avatarUrl: finalUrl,
    avatar,
    updatedAt: serverTimestamp(),
  });

  return { avatarUrl: finalUrl, avatar };
}

/**
 * Bump occurrences for a list of people.
 * - Best effort (failures are ignored)
 * - If a person becomes "popular" (occurrences >= threshold), we try to cache their avatar on Storage.
 */
export async function bumpPeopleOccurrences(personIds, {
  delta = 1,
  popularThreshold = POPULAR_AVATAR_THRESHOLD,
  cacheToStorage = DEFAULT_CACHE_POPULAR_AVATARS,
  maxBytes = DEFAULT_MAX_AVATAR_BYTES,
  popularOnly = true,
} = {}) {
  const ids = Array.from(new Set((personIds || []).filter(Boolean).map(String)));
  if (!ids.length) return { processed: 0, cached: 0 };

  let processed = 0;
  let cached = 0;

  for (const id of ids) {
    processed++;
    const pref = doc(db, 'people', id);

    // 1) increment occurrences (best-effort)
    try {
      await updateDoc(pref, { occurrences: increment(delta), updatedAt: serverTimestamp() });
    } catch {
      // ignore
    }

    // 2) if popular, cache avatar (best-effort)
    if (!cacheToStorage) continue;
    try {
      const snap = await getDoc(pref);
      if (!snap.exists()) continue;
      const data = snap.data() || {};
      const occ = Number(data.occurrences || 0);
      if (popularOnly && occ < Number(popularThreshold || 0)) continue;

      // already cached
      if (data?.avatar?.source === 'storage' && getBestAvatarUrl(data)) continue;

      const res = await ensurePersonAvatar(id, {
        name: data.name || '',
        wikidataId: data.wikidataId || null,
        cacheToStorage: true,
        maxBytes,
        occurrences: occ,
        popularOnly,
        popularThreshold,
      });
      if (res?.avatarUrl && res?.avatar?.source === 'storage') cached++;
    } catch {
      // ignore
    }
  }

  return { processed, cached };
}

/**
 * Admin helper (run from console): backfill avatarUrl on existing /people docs.
 * Scans people ordered by updatedAt desc, resolves missing avatars and writes them.
 */
export async function backfillPeopleAvatars({
  pageSize = 150,
  maxToProcess = 1000,
  sleepMs = 150,
  cacheToStorage = DEFAULT_CACHE_POPULAR_AVATARS,
  maxBytes = DEFAULT_MAX_AVATAR_BYTES,
  popularOnly = true,
  popularThreshold = POPULAR_AVATAR_THRESHOLD,
} = {}) {
  let processed = 0;
  let updated = 0;
  let scanned = 0;

  let last = null;
  while (processed < maxToProcess) {
    const qx = last
      ? query(collection(db, 'people'), orderBy('updatedAt', 'desc'), startAfter(last), limit(pageSize))
      : query(collection(db, 'people'), orderBy('updatedAt', 'desc'), limit(pageSize));

    const snap = await getDocs(qx);
    if (snap.empty) break;

    for (const d of snap.docs) {
      scanned++;
      const data = d.data() || {};
      // Skip if already has any avatarUrl
      if (data.avatarUrl) continue;
      if (!data.name) continue;
      if (processed >= maxToProcess) break;

      // Popular-only gate
      const occ = Number(data.occurrences || 0);
      if (popularOnly && occ < Number(popularThreshold || 0)) continue;

      processed++;
      try {
        const res = await ensurePersonAvatar(d.id, {
          name: data.name,
          wikidataId: data.wikidataId || null,
          cacheToStorage,
          maxBytes,
          occurrences: occ,
          popularOnly,
          popularThreshold,
        });
        if (res?.avatarUrl) updated++;
      } catch {
        // ignore single failures
      }

      if (sleepMs) {
        await new Promise(r => setTimeout(r, sleepMs));
      }
    }

    last = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < pageSize) break;
  }

  return { scanned, processed, updated, lastId: last?.id || null };
}
