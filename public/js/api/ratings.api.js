import {
  doc,
  setDoc,
  getDoc,
  deleteDoc,
  query,
  where,
  getDocs,
  serverTimestamp,
  collection,
  getCountFromServer,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import { db, auth } from "../firebase.js";
import { t as i18nT } from "../i18n/index.js";
import { logEvent } from "../analytics.js";

function safePart(v){
  return String(v ?? "0").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function normalizeWatchedWith(list, { max = 10 } = {}) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const uid = String(row.uid || "").trim();
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    out.push({
      uid,
      displayName: String(row.displayName || "").trim().slice(0, 80) || "Amico",
    });
    if (out.length >= max) break;
  }
  return out;
}

export function makeRatingId({ uid, titleId, level, season = null, episode = null }){
  return [
    safePart(uid),
    safePart(titleId),
    safePart(level),
    safePart(season ?? 0),
    safePart(episode ?? 0),
  ].join("__");
}

/**
 * Upsert: 1 voto per utente per item (title/season/episode)
 * - Se esiste -> update
 * - Se non esiste -> create
 *
 * `reviewText` opzionale: ammesso su ogni livello (title/season/episode),
 * vincolato a 5000 char dalle rules. Se omesso (undefined) il campo non
 * viene toccato; se "" (stringa vuota) la review viene cancellata.
 */
export async function upsertRating({ uid, titleId, level, season = null, episode = null, rating, reviewText }){
  if (!uid) throw new Error("uid mancante");
  if (!titleId) throw new Error("titleId mancante");
  if (!level) throw new Error("level mancante");
  const ratingId = makeRatingId({ uid, titleId, level, season, episode });

  const data = {
    uid,
    titleId,
    level,
    season,
    episode,
    rating: Number(rating),
    source: "user",
    updatedAt: serverTimestamp(),
  };

  if (reviewText !== undefined) {
    const trimmed = String(reviewText ?? "").trim().slice(0, 5000);
    data.reviewText = trimmed || null;
  }

  const ratingRef = doc(db, "ratings", ratingId);

  await setDoc(ratingRef, { ...data, createdAt: serverTimestamp() }, { merge: true });
  void logEvent("rating_created", { level });
  return { id: ratingId };
}

/**
 * Migrazione 1-tap: sposta un voto esistente da un livello a un altro
 * (es. title → season). Mantiene rating, reviewText e gli extra (watchedWith,
 * media). Operazione = create new + delete old (Firestore non ha rename).
 */
export async function migrateRatingLevel({ uid, titleId, fromLevel, fromSeason = null, fromEpisode = null, toLevel, toSeason = null, toEpisode = null }){
  if (!uid) throw new Error("uid mancante");
  if (!titleId) throw new Error("titleId mancante");
  const oldId = makeRatingId({ uid, titleId, level: fromLevel, season: fromSeason, episode: fromEpisode });
  const newId = makeRatingId({ uid, titleId, level: toLevel, season: toSeason, episode: toEpisode });
  if (oldId === newId) return { id: newId };

  const oldRef = doc(db, "ratings", oldId);
  const oldSnap = await getDoc(oldRef);
  if (!oldSnap.exists()) {
    throw new Error(i18nT("rating originale non trovato"));
  }
  const oldData = oldSnap.data() || {};

  const newRef = doc(db, "ratings", newId);
  const payload = {
    ...oldData,
    level: toLevel,
    season: toSeason,
    episode: toEpisode,
    source: "user",
    updatedAt: serverTimestamp(),
  };
  // createdAt deve restare valid timestamp; se mancava sul vecchio doc, usa server.
  if (!payload.createdAt) payload.createdAt = serverTimestamp();

  await setDoc(newRef, payload, { merge: false });
  const { deleteDoc } = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js");
  await deleteDoc(oldRef);
  return { id: newId };
}

/**
 * Elimina il voto dell'utente per un item (title/season/episode).
 *
 * Il backend fa il resto in autonomia:
 *  - trigger `recomputeTitleRatingAggregate` (onWrite /ratings) sottrae il delta
 *    dall'aggregato community (`titles/{id}.ratingAggregate`);
 *  - trigger `syncTitleStateFromTitleRating` azzera il flag rating sul titleState
 *    (per il level "title") lasciando il titolo "visto senza voto".
 *
 * Client-only: le rules permettono la delete al proprietario del doc.
 * L'uid è preso dall'utente autenticato corrente.
 */
export async function deleteRating({ titleId, level = "title", season = 0, episode = 0 }){
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error("uid mancante");
  if (!titleId) throw new Error("titleId mancante");
  const ratingId = makeRatingId({ uid, titleId, level, season, episode });
  await deleteDoc(doc(db, "ratings", ratingId));
  return { id: ratingId };
}

export async function getMyRating({ uid, titleId, level, season = null, episode = null }){
  const id = makeRatingId({ uid, titleId, level, season, episode });
  const snap = await getDoc(doc(db, "ratings", id));
  return snap.exists() ? ({ id: snap.id, ...snap.data() }) : null;
}

export async function listRatingsForTitle(titleId){
  const q = query(collection(db, "ratings"), where("titleId", "==", titleId));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Voto DERIVATO (privato) di serie/stagione, calcolato server-side dai voti
 * episodio dell'utente. Doc read owner-only in users/{uid}/derivedRatings/{titleId}.
 * Ritorna null se non esiste (l'utente non ha voti episodio su quel titolo).
 * Shape: { series:{avg,seasonCount,episodeCount}|null, season:{"1":{avg,count}}, ... }
 */
export async function getDerivedRating(uid, titleId){
  if (!uid || !titleId) return null;
  try {
    const snap = await getDoc(doc(db, "users", uid, "derivedRatings", titleId));
    return snap.exists() ? snap.data() : null;
  } catch (_err) {
    return null;
  }
}

export async function listMyTitleRatings(uid, { max = 200 } = {}){
  // NB: niente orderBy per evitare indici extra: e' OK per MVP.
  const q = query(
    collection(db, "ratings"),
    where("uid", "==", uid),
    where("level", "==", "title")
  );
  const snap = await getDocs(q);
  const out = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return out.slice(0, max);
}

/**
 * Tutti i voti dell'utente a QUALSIASI livello (title/season/episode).
 * Usata dal tab Community del profilo (recensioni a tutti i livelli).
 *
 * NB: nessun filtro `level` e nessun `orderBy` per evitare indici extra
 * (l'unica equality `uid == uid` copre l'indice singolo esistente su
 * `ratings.uid`). Il chiamante filtra/ordina lato client.
 */
export async function listMyRatingsAnyLevel(uid, { max = 200 } = {}){
  if (!uid) return [];
  const q = query(collection(db, "ratings"), where("uid", "==", uid));
  const snap = await getDocs(q);
  const out = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return out.slice(0, max);
}

/**
 * Salva (o aggiorna) il testo della recensione su un rating title-level esistente.
 * Il campo reviewText viene persistito direttamente sul doc rating.
 */
export async function updateReviewText({
  uid,
  titleId,
  reviewText,
  watchedWith,
  photoUrl,
  photoStoragePath,
}){
  if (!uid) throw new Error("uid mancante");
  if (!titleId) throw new Error("titleId mancante");
  const ratingId = makeRatingId({ uid, titleId, level: "title", season: null, episode: null });
  const ratingRef = doc(db, "ratings", ratingId);
  const payload = {
    updatedAt: serverTimestamp(),
  };

  if (reviewText !== undefined) {
    payload.reviewText = String(reviewText ?? "").trim().slice(0, 5000);
  }

  if (watchedWith !== undefined) {
    payload.watchedWith = normalizeWatchedWith(watchedWith, { max: 12 });
  }

  if (photoUrl !== undefined) {
    const nextUrl = String(photoUrl || "").trim();
    payload.reviewPhotoUrl = nextUrl || null;
  }

  if (photoStoragePath !== undefined) {
    const nextPath = String(photoStoragePath || "").trim();
    payload.reviewPhotoStoragePath = nextPath || null;
  }

  await setDoc(ratingRef, {
    ...payload,
  }, { merge: true });
}

/**
 * Numero di voti a livello titolo dell'utente — quello che il profilo mostra
 * come "Review".
 *
 * `users/{uid}.stats.reviewsCount` esiste nello schema ma **non lo incrementa
 * nessuno**: viene inizializzato a 0 e mai piu' toccato, quindi da solo
 * mostrerebbe 0 a chiunque. Stessa strategia di
 * `WatchlistRepository.fetchReviewCount` su iOS: si prova la cache e, se e'
 * zero, si conta lato server (aggregate, non scarica i documenti).
 */
export async function countTitleRatings(uid, cachedCount = 0) {
  const cached = Number(cachedCount) || 0;
  if (cached > 0) return cached;
  if (!uid) return 0;
  try {
    const snap = await getCountFromServer(
      query(collection(db, "ratings"), where("uid", "==", uid), where("level", "==", "title"))
    );
    return Number(snap.data().count) || 0;
  } catch (err) {
    console.warn("countTitleRatings failed", err);
    return 0;
  }
}
