import {
  collection,
  doc,
  documentId,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";

import { app, db } from "../firebase.js";

const functions = getFunctions(app, "europe-west1");
const applyTitleStateActionCallable = httpsCallable(functions, "applyTitleStateAction");

function parseTimestampMs(value) {
  if (!value) return 0;
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (typeof value?.seconds === "number") {
    return (value.seconds * 1000) + Math.floor((value.nanoseconds || 0) / 1e6);
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function normalizeStateRow(id, data = {}) {
  return {
    id,
    titleId: data.titleId || id,
    mediaType: data.mediaType === "tv" ? "tv" : "movie",
    state: String(data.state || "").trim().toLowerCase(),
    generalWatchlist: data.generalWatchlist === true,
    rewatchIntent: data.rewatchIntent === true,
    hasTitleRating: data.hasTitleRating === true,
    ratingValue: Number.isFinite(Number(data.ratingValue)) ? Number(data.ratingValue) : null,
    seenAt: data.seenAt || null,
    completedAt: data.completedAt || null,
    ratedAt: data.ratedAt || null,
    updatedAt: data.updatedAt || null,
    lastInteractionAt: data.lastInteractionAt || null,
    completedCount: Math.max(0, Number(data.completedCount || 0) || 0),
    watchMinutesContribution: Math.max(0, Number(data.watchMinutesContribution || 0) || 0),
    schemaVersion: Math.max(0, Number(data.schemaVersion || 0) || 0),
    seriesProgress: data.seriesProgress && typeof data.seriesProgress === "object" ? data.seriesProgress : null,
    titleSnapshot: data.titleSnapshot && typeof data.titleSnapshot === "object" ? data.titleSnapshot : null,
    _sortTime: Math.max(
      parseTimestampMs(data.lastInteractionAt),
      parseTimestampMs(data.completedAt),
      parseTimestampMs(data.ratedAt),
      parseTimestampMs(data.seenAt),
      parseTimestampMs(data.updatedAt),
    ),
  };
}

export async function getMyTitleState(uid, titleId) {
  if (!uid || !titleId) return null;
  const snap = await getDoc(doc(db, "users", uid, "titleStates", titleId));
  return snap.exists() ? normalizeStateRow(snap.id, snap.data() || {}) : null;
}

export async function listMyTitleStates(uid, { max = 250 } = {}) {
  if (!uid) throw new Error("uid mancante");

  try {
    const snap = await getDocs(query(
      collection(db, "users", uid, "titleStates"),
      orderBy("lastInteractionAt", "desc"),
      limit(max)
    ));
    return snap.docs.map((d) => normalizeStateRow(d.id, d.data() || {}));
  } catch (_) {
    const snap = await getDocs(collection(db, "users", uid, "titleStates"));
    return snap.docs
      .map((d) => normalizeStateRow(d.id, d.data() || {}))
      .sort((a, b) => b._sortTime - a._sortTime)
      .slice(0, max);
  }
}

export async function applyTitleStateAction({ titleId, action, source, enabled, episodesWatchedCount, seasonsCompletedCount, lastWatchedSeasonNumber, lastWatchedEpisodeNumber }) {
  if (!titleId) throw new Error("titleId mancante");
  if (!action) throw new Error("action mancante");

  const response = await applyTitleStateActionCallable({
    titleId,
    action,
    source,
    enabled,
    episodesWatchedCount,
    seasonsCompletedCount,
    lastWatchedSeasonNumber,
    lastWatchedEpisodeNumber,
  });

  return normalizeStateRow(titleId, response?.data?.state || {});
}

/**
 * Convenience: riporta un FILM allo stato "non visto" (torna in da-vedere).
 * Delega al callable `applyTitleStateAction`. NB: se il titolo ha anche un voto,
 * questa azione azzera solo il flag di stato ma NON cancella il doc /ratings —
 * il chiamante deve eliminarlo a parte (vedi deleteRating).
 */
export async function markMovieUnseen(titleId) {
  return applyTitleStateAction({
    titleId,
    action: "mark_movie_unseen",
    source: "movie_unseen",
  });
}

/**
 * Convenience: riporta una SERIE allo stato "non iniziata" (torna in da-vedere).
 * Stessa avvertenza di markMovieUnseen sul voto residuo.
 */
export async function markSeriesUnstarted(titleId) {
  return applyTitleStateAction({
    titleId,
    action: "mark_series_unstarted",
    source: "series_unstarted",
  });
}

/**
 * Set<string> di titleIds completati dal viewer. Allineato a iOS
 * `WatchlistRepository.fetchCompletedTitleIDs`:
 *   - movie: `movieStatus in {seen_unrated, rated}`
 *   - tv:    `seriesStatus in {completed_unrated, rated}`
 *
 * Usato dal gate anti-spoiler (`spoilerGate.js`).
 */
export async function listCompletedTitleIDs(uid, { max = 400 } = {}) {
  if (!uid) return new Set();
  try {
    const snap = await getDocs(query(
      collection(db, "users", uid, "titleStates"),
      orderBy("updatedAt", "desc"),
      limit(max),
    ));
    const out = new Set();
    snap.docs.forEach((d) => {
      const data = d.data() || {};
      const mediaType = String(data.mediaType || "").toLowerCase();
      // Il doc Firestore ha UN solo campo `state`; `movieStatus`/`seriesStatus`
      // esistono solo come proprietà del modello iOS. Leggendo quei nomi qui
      // il set usciva sempre vuoto e il gate anti-spoiler manuale non si
      // sbloccava mai, nemmeno sui titoli completati.
      const state = String(data.state || "").trim().toLowerCase();
      const completed = mediaType === "tv"
        ? (state === "completed_unrated" || state === "rated")
        : (state === "seen_unrated" || state === "rated");
      if (completed) out.add(d.id);
    });
    return out;
  } catch (err) {
    console.warn("[titleStates.api] listCompletedTitleIDs failed", err);
    return new Set();
  }
}

/**
 * Progresso del viewer sui titoli richiesti: `Map<titleId, stateRow>`.
 *
 * Letture MIRATE (chunk da 30 su `documentId()`), non l'intera collection:
 * il gate anti-spoiler per progresso serve solo i titoli presenti a schermo,
 * quindi una pagina di feed costa 1-2 query invece di centinaia di doc.
 * I titoli assenti dalla mappa non sono in libreria → contenuto bloccato.
 *
 * @param {string} uid
 * @param {string[]} titleIds
 * @param {{inputCap?: number}} [opts]
 * @returns {Promise<Map<string, object>>}
 */
export async function getMyTitleStatesByIds(uid, titleIds = [], { inputCap = 120 } = {}) {
  const ids = [...new Set((titleIds || []).map((v) => String(v || "").trim()).filter(Boolean))].slice(0, inputCap);
  const out = new Map();
  if (!uid || !ids.length) return out;

  const chunks = [];
  for (let i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30));

  await Promise.all(chunks.map(async (chunk) => {
    try {
      const snap = await getDocs(query(
        collection(db, "users", uid, "titleStates"),
        where(documentId(), "in", chunk),
      ));
      snap.docs.forEach((d) => out.set(d.id, normalizeStateRow(d.id, d.data() || {})));
    } catch (err) {
      console.warn("[titleStates.api] getMyTitleStatesByIds chunk failed", err);
    }
  }));

  return out;
}

/**
 * Convenience: marca un titolo come completato senza voto, delegando
 * al cloud callable `applyTitleStateAction`. Usato dal gate
 * anti-spoiler quando l'utente preme "Ho visto X" sul blur.
 *
 * @param {string} titleId
 * @param {"movie"|"tv"} mediaType
 */
export async function markTitleCompleted(titleId, mediaType) {
  if (!titleId) throw new Error("titleId mancante");
  const action = mediaType === "tv" ? "mark_series_completed" : "mark_movie_seen";
  return applyTitleStateAction({
    titleId,
    action,
    source: action === "mark_series_completed" ? "series_completed" : "movie_seen",
  });
}
