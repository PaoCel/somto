// watchlist.api.js - API per gestire la watchlist utente

import { t as i18nT } from "../i18n/index.js";
import {
  collection,
  doc,
  setDoc,
  getDoc,
  getDocs,
  deleteDoc,
  query,
  orderBy,
  limit,
  serverTimestamp,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import { db } from "../firebase.js";
import { logSignal } from "./signals.api.js";
import { applyTitleStateAction, getMyTitleState } from "./titleStates.api.js";
import { logEvent } from "../analytics.js";

async function getApprovedTitleMediaType(titleId) {
  if (!titleId) return "movie";
  try {
    const snap = await getDoc(doc(db, "titles", titleId));
    if (!snap.exists()) return "movie";
    return String(snap.data()?.type || "").trim().toLowerCase() === "tv" ? "tv" : "movie";
  } catch (_) {
    return "movie";
  }
}

/**
 * Aggiungi un titolo ESISTENTE (approved) alla watchlist
 * @param {string} uid - User ID
 * @param {string} titleId - Title ID (deve esistere e essere approved)
 * @param {object} opts - Opzioni: { notes, priority }
 */
export async function addToWatchlist(uid, titleId, opts = {}) {
  if (!uid) throw new Error("uid mancante");
  if (!titleId) throw new Error("titleId mancante");

  const rawState = String(opts.watchState || "").trim().toLowerCase();
  const watchState = rawState === "to_rate" ? "to_rate" : "to_watch";
  const rawPriority = String(opts.priority || "").trim().toLowerCase();
  const priority = ["high", "low"].includes(rawPriority)
    ? rawPriority
    : (watchState === "to_rate" ? "low" : "normal");

  const source = String(opts.source || "title_page").trim().toLowerCase() || "title_page";
  if (watchState === "to_rate") {
    const mediaType = await getApprovedTitleMediaType(titleId);
    await applyTitleStateAction({
      titleId,
      action: mediaType === "tv" ? "mark_series_completed" : "mark_movie_seen",
      source,
    });

    void logEvent("watchlist_marked_watched", {
      source,
      moved_to_rate: true,
      existed_in_watchlist: false,
    });
    return { id: titleId };
  }

  await applyTitleStateAction({
    titleId,
    action: "toggle_watchlist",
    enabled: true,
    source,
  });

  logSignal({
    uid,
    titleId,
    actionType: "watchlist_add",
    rawValue: null,
    source,
  }).catch(() => {});

  void logEvent("watchlist_item_added", {
    source,
    watch_state: watchState,
    priority,
  });

  return { id: titleId };
}


/**
 * Aggiungi un titolo PENDING (non ancora nel DB) alla watchlist
 * Crea una richiesta di approvazione e la collega alla watchlist
 * @param {string} uid - User ID
 * @param {object} titleData - Dati del titolo: { name, type, year, genres }
 */
export async function addPendingToWatchlist(uid, titleData) {
  if (!uid) throw new Error("uid mancante");
  if (!titleData.name) throw new Error(i18nT("Nome titolo mancante"));
  if (!titleData.type) throw new Error(i18nT("Tipo titolo mancante"));

  // 1. Crea richiesta di approvazione in titleEdits
  const editRef = doc(collection(db, "titleEdits"));
  
  await setDoc(editRef, {
    type: "create",
    name: titleData.name,
    titleType: titleData.type,
    year: titleData.year || null,
    genres: titleData.genres || [],
    originalName: titleData.originalName || null,
    posterPath: null,
    targetTitleId: null,
    requestedBy: uid,
    status: "pending",
    reviewedBy: null,
    reviewedAt: null,
    reviewNotes: null,
    resultTitleId: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  // 2. Aggiungi alla watchlist come "pending"
  const watchlistRef = doc(db, "users", uid, "watchlist", `pending_${editRef.id}`);
  
  await setDoc(watchlistRef, {
    titleId: null,
    addedAt: serverTimestamp(),
    pendingTitle: {
      name: titleData.name,
      type: titleData.type,
      year: titleData.year || null,
      editRequestId: editRef.id,
    },
    notes: null,
    priority: "normal",
  });

  return { 
    id: `pending_${editRef.id}`,
    editRequestId: editRef.id 
  };
}


/**
 * Rimuovi un titolo dalla watchlist
 * @param {string} uid - User ID
 * @param {string} entryId - ID dell'entry (titleId o "pending_xxx")
 */
export async function removeFromWatchlist(uid, entryId) {
  if (!uid) throw new Error("uid mancante");
  if (!entryId) throw new Error("entryId mancante");

  const ref = doc(db, "users", uid, "watchlist", entryId);
  const snap = await getDoc(ref).catch(() => null);
  const data = snap?.exists?.() ? (snap.data() || {}) : null;

  if (data?.pendingTitle || String(entryId).startsWith("pending_")) {
    await deleteDoc(ref);
  } else {
    await applyTitleStateAction({
      titleId: entryId,
      action: "toggle_watchlist",
      enabled: false,
      source: "watchlist_remove",
    });
  }

  logSignal({
    uid,
    titleId: entryId,
    actionType: "watchlist_remove",
    rawValue: null,
    source: "title_page",
  }).catch(() => {});
  
  return { deleted: true };
}


/**
 * Aggiorna note/priorità di un'entry watchlist
 * @param {string} uid - User ID
 * @param {string} entryId - ID dell'entry
 * @param {object} updates - { notes?, priority? }
 */
export async function updateWatchlistEntry(uid, entryId, updates) {
  if (!uid) throw new Error("uid mancante");
  if (!entryId) throw new Error("entryId mancante");

  const ref = doc(db, "users", uid, "watchlist", entryId);
  
  const updateData = {
    updatedAt: serverTimestamp(),
  };
  
  if (updates.notes !== undefined) updateData.notes = updates.notes;
  if (updates.priority !== undefined) updateData.priority = updates.priority;

  await setDoc(ref, updateData, { merge: true });
  
  return { updated: true };
}


/**
 * Ottieni tutta la watchlist di un utente
 * @param {string} uid - User ID
 * @param {object} opts - Opzioni: { max }
 */
export async function getMyWatchlist(uid, opts = {}) {
  if (!uid) throw new Error("uid mancante");

  const q = query(
    collection(db, "users", uid, "watchlist"),
    orderBy("addedAt", "desc"),
    limit(opts.max || 200)
  );

  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}


/**
 * Controlla se un titolo è già nella watchlist
 * @param {string} uid - User ID
 * @param {string} titleId - Title ID
 */
export async function isInWatchlist(uid, titleId) {
  if (!uid || !titleId) return false;

  const state = await getMyTitleState(uid, titleId).catch(() => null);
  if (state) {
    return state.generalWatchlist === true;
  }

  const ref = doc(db, "users", uid, "watchlist", titleId);
  const snap = await getDoc(ref);
  
  return snap.exists();
}


function sanitizeSource(value, fallback = "watchlist") {
  const src = String(value || "").trim().toLowerCase();
  return src || fallback;
}

/**
 * Segna come visto SENZA voto:
 * - mantiene/crea entry watchlist in stato "to_rate"
 * - aggiorna la library (visti) con lastRating = null
 */
export async function markAsWatched(uid, titleId, opts = {}) {
  if (!uid) throw new Error("uid mancante");
  if (!titleId) throw new Error("titleId mancante");

  const watchlistRef = doc(db, "users", uid, "watchlist", titleId);
  const source = sanitizeSource(opts.source, "watchlist_seen");

  const watchSnap = await getDoc(watchlistRef).catch(() => null);
  const watchData = watchSnap?.exists?.() ? (watchSnap.data() || {}) : null;
  if (watchData?.pendingTitle) {
    return { movedToRate: false, reason: "pending_entry" };
  }

  const mediaType = await getApprovedTitleMediaType(titleId);
  await applyTitleStateAction({
    titleId,
    action: mediaType === "tv" ? "mark_series_completed" : "mark_movie_seen",
    source,
  });

  void logEvent("watchlist_marked_watched", {
    source,
    moved_to_rate: true,
    existed_in_watchlist: !!watchData,
  });

  return { movedToRate: true, existedInWatchlist: !!watchData };
}


/**
 * Listener real-time per watchlist (opzionale, per future notifiche)
 * @param {string} uid - User ID
 * @param {function} callback - Funzione chiamata ad ogni update
 */
export function onWatchlistChange(uid, callback) {
  if (!uid) throw new Error("uid mancante");

  const q = query(
    collection(db, "users", uid, "watchlist"),
    orderBy("addedAt", "desc")
  );

  return onSnapshot(q, (snapshot) => {
    const items = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    callback(items);
  });
}
