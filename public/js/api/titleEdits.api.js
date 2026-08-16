// titleEdits.api.js - API per richieste di approvazione titoli

import {
  collection,
  doc,
  addDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import { db } from "../firebase.js";
import { t as i18nT } from "../i18n/index.js";
import { createTitle } from "./titles.api.js";


function normalizeText(s){
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(arr){
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function buildSearchIndex({ name, type, year, aliases = [], originalName = null } = {}){
  const nameLower = normalizeText(name);
  const aNorm = (Array.isArray(aliases) ? aliases : []).map(normalizeText).filter(Boolean);
  const oNorm = originalName ? [normalizeText(originalName)] : [];
  const all = [nameLower, ...aNorm, ...oNorm].filter(Boolean).join(" ");
  const tokens = unique(all.split(/\s+/).map(s => s.trim()).filter(Boolean).filter(t => t.length >= 2));

  const prefixes = [];
  for (let i = 1; i <= Math.min(12, nameLower.length); i++) prefixes.push(nameLower.slice(0, i));

  const dedupeKey = `${nameLower}_${type || "null"}_${year ?? "null"}`;
  return { nameLower, search: { normalized: nameLower, dedupeKey, prefixes, tokens } };
}

function safeSnapshotTitle(t){
  // Solo campi "contenuto" che ci interessa moderare/applicare
  if (!t || typeof t !== "object") return null;
  return {
    name: t.name ?? null,
    type: t.type ?? null,
    year: t.year ?? null,
    genres: Array.isArray(t.genres) ? t.genres : [],
    originalName: t.originalName ?? null,
    aliases: Array.isArray(t.aliases) ? t.aliases : [],
    meta: (t.meta && typeof t.meta === "object") ? t.meta : {},
    posterPath: t.posterPath ?? null,
    posterStoragePath: t.posterStoragePath ?? null,
  };
}
/**
 * Crea una richiesta di approvazione per un nuovo titolo
 * @param {object} data - Dati del titolo
 * @param {string} uid - User ID richiedente
 */
export async function createTitleRequest(data, uid) {
  if (!uid) throw new Error("uid mancante");
  if (!data.name) throw new Error("nome mancante");
  if (!data.titleType) throw new Error("tipo mancante");

  const after = safeSnapshotTitle({
    name: data.name,
    type: data.titleType,
    year: data.year || null,
    genres: Array.isArray(data.genres) ? data.genres : [],
    originalName: data.originalName || null,
    aliases: [],
    posterPath: data.posterPath || null,
    posterStoragePath: data.posterStoragePath || null,
    meta: {},
  });

  const editData = {
    type: "create",
    targetTitleId: null,
    requestedBy: uid,
    status: "pending",
    reviewedBy: null,
    reviewedAt: null,
    reviewNotes: null,
    resultTitleId: null,

    before: null,
    after,
    changes: null,

    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  const ref = await addDoc(collection(db, "titleEdits"), editData);
  return { id: ref.id };
}


/**
 * Crea una richiesta di modifica per un titolo esistente
 * @param {string} titleId - ID del titolo da modificare
 * @param {object} updates - Modifiche proposte
 * @param {string} uid - User ID richiedente
 */
export async function createUpdateRequest(titleId, updates, uid) {
  if (!titleId) throw new Error("titleId mancante");
  if (!uid) throw new Error("uid mancante");

  const before = safeSnapshotTitle(updates?._before);
  const after = safeSnapshotTitle(updates?._after) || safeSnapshotTitle(updates);

  const editData = {
    type: "update",
    targetTitleId: titleId,
    requestedBy: uid,
    status: "pending",
    reviewedBy: null,
    reviewedAt: null,
    reviewNotes: null,
    resultTitleId: null,

    // snapshot utili per moderazione
    before,
    after,
    // diff "grezzo" (opzionale)
    changes: (updates && typeof updates === "object" && updates._changes) ? updates._changes : null,

    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  const ref = await addDoc(collection(db, "titleEdits"), editData);
  return { id: ref.id };
}


/**
 * Approva una richiesta (solo trusted/admin)
 * @param {string} editId - ID della richiesta
 * @param {string} reviewerUid - UID di chi approva
 */
export async function approveTitleEdit(editId, reviewerUid) {
  if (!editId) throw new Error("editId mancante");
  if (!reviewerUid) throw new Error("reviewerUid mancante");

  const editRef = doc(db, "titleEdits", editId);
  const editSnap = await getDoc(editRef);
  if (!editSnap.exists()) throw new Error(i18nT("Richiesta non trovata"));

  const editData = editSnap.data();
  if (editData.status !== "pending") throw new Error(i18nT("Richiesta già processata"));

  const batch = writeBatch(db);

  // Snapshot proposto (after)
  const after = safeSnapshotTitle(editData.after) || safeSnapshotTitle(editData);
  if (!after || !after.name) throw new Error("Richiesta invalida: manca after/name");

  let titleId = null;

  if (editData.type === "create") {
    const titleRef = doc(collection(db, "titles"));
    titleId = titleRef.id;

    const idx = buildSearchIndex({
      name: after.name,
      type: after.type,
      year: after.year,
      aliases: after.aliases,
      originalName: after.originalName,
    });

    batch.set(titleRef, {
      type: after.type,
      name: after.name,
      nameLower: idx.nameLower,
      year: after.year,
      genres: after.genres,
      originalName: after.originalName,
      aliases: after.aliases || [],
      posterPath: after.posterPath || null,
      posterStoragePath: after.posterStoragePath || null,
      backdropPath: null,
      meta: after.meta || {},

      createdBy: editData.requestedBy,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      status: "approved",

      ...idx,

      ratingCount: 0,
      ratingAvg: 0,
      reviewCount: 0,
    });

  } else if (editData.type === "update") {
    titleId = editData.targetTitleId;
    if (!titleId) throw new Error("Richiesta invalida: manca targetTitleId");

    const titleRef = doc(db, "titles", titleId);

    const idx = buildSearchIndex({
      name: after.name,
      type: after.type,
      year: after.year,
      aliases: after.aliases,
      originalName: after.originalName,
    });

    batch.update(titleRef, {
      name: after.name,
      type: after.type,
      nameLower: idx.nameLower,
      year: after.year,
      genres: after.genres,
      originalName: after.originalName,
      aliases: after.aliases || [],
      meta: after.meta || {},
      posterPath: after.posterPath || null,
      posterStoragePath: after.posterStoragePath || null,
      updatedAt: serverTimestamp(),
      search: idx.search,
    });
  } else {
    throw new Error(i18nT("Tipo richiesta non supportato"));
  }

  batch.update(editRef, {
    status: "approved",
    reviewedBy: reviewerUid,
    reviewedAt: serverTimestamp(),
    resultTitleId: titleId,
    updatedAt: serverTimestamp(),
  });

  await batch.commit();

  return { titleId, editId, approved: true };
}



/**
 * Rifiuta una richiesta (solo trusted/admin)
 * @param {string} editId - ID della richiesta
 * @param {string} reviewerUid - UID di chi rifiuta
 * @param {string} reason - Motivo del rifiuto
 */
export async function rejectTitleEdit(editId, reviewerUid, reason = "") {
  if (!editId) throw new Error("editId mancante");
  if (!reviewerUid) throw new Error("reviewerUid mancante");

  const editRef = doc(db, "titleEdits", editId);
  const editSnap = await getDoc(editRef);
  
  if (!editSnap.exists()) throw new Error(i18nT("Richiesta non trovata"));
  
  const editData = editSnap.data();
  
  if (editData.status !== "pending") {
    throw new Error(i18nT("Richiesta già processata"));
  }

  await updateDoc(editRef, {
    status: "rejected",
    reviewedBy: reviewerUid,
    reviewedAt: serverTimestamp(),
    reviewNotes: reason,
    updatedAt: serverTimestamp(),
  });

  return { 
    editId,
    rejected: true 
  };
}


/**
 * Ottieni tutte le richieste pending (per moderatori)
 * @param {object} opts - Opzioni: { max }
 */
export async function getPendingEdits(opts = {}) {
  const q = query(
    collection(db, "titleEdits"),
    where("status", "==", "pending"),
    orderBy("createdAt", "desc"),
    limit(opts.max || 50)
  );

  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}


/**
 * Ottieni le mie richieste
 * @param {string} uid - User ID
 * @param {object} opts - Opzioni: { status, max }
 */
export async function getMyEdits(uid, opts = {}) {
  if (!uid) throw new Error("uid mancante");

  let q;
  
  if (opts.status) {
    q = query(
      collection(db, "titleEdits"),
      where("requestedBy", "==", uid),
      where("status", "==", opts.status),
      orderBy("createdAt", "desc"),
      limit(opts.max || 50)
    );
  } else {
    q = query(
      collection(db, "titleEdits"),
      where("requestedBy", "==", uid),
      orderBy("createdAt", "desc"),
      limit(opts.max || 50)
    );
  }

  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}


/**
 * Ottieni dettagli di una richiesta
 * @param {string} editId - ID della richiesta
 */
export async function getEditById(editId) {
  if (!editId) throw new Error("editId mancante");

  const snap = await getDoc(doc(db, "titleEdits", editId));
  
  if (!snap.exists()) return null;
  
  return { id: snap.id, ...snap.data() };
}


/**
 * Aggiorna watchlist entries dopo approvazione
 * (Helper function chiamata dopo approvazione)
 * @param {string} editId - ID della richiesta approvata
 * @param {string} newTitleId - ID del titolo creato
 */
export async function updateWatchlistAfterApproval(editId, newTitleId) {
  // Trova tutte le watchlist entries con questo editRequestId
  // Nota: questo richiede un query su subcollection, quindi è complesso
  // Per MVP, lo facciamo manualmente o con Cloud Function
  
  // Workaround: l'utente vede nella sua watchlist che è stato approvato
  // e può cliccare per "aggiornare" manualmente
  
  console.log("Watchlist update dopo approvazione:", { editId, newTitleId });
  
  // TODO: implementare con Cloud Function o batch job
}


/**
 * Elimina una richiesta (solo admin o creatore se pending)
 * @param {string} editId - ID della richiesta
 * @param {string} uid - User ID richiedente
 */
export async function deleteTitleEdit(editId, uid) {
  if (!editId) throw new Error("editId mancante");
  if (!uid) throw new Error("uid mancante");

  const editRef = doc(db, "titleEdits", editId);
  const editSnap = await getDoc(editRef);
  
  if (!editSnap.exists()) throw new Error(i18nT("Richiesta non trovata"));
  
  const editData = editSnap.data();
  
  // Solo creatore può eliminare se pending
  if (editData.requestedBy !== uid && editData.status === "pending") {
    throw new Error(i18nT("Non autorizzato"));
  }

  await deleteDoc(editRef);
  
  return { deleted: true };
};
/**
 * Wrapper usato dalle pagine: propone una modifica per un titolo esistente
 * @param {object} params
 * @param {string} params.titleId
 * @param {string} params.proposedBy
 * @param {object} params.changes
 */
export async function proposeTitleEdit({ titleId, proposedBy, changes }) {
  if (!titleId) throw new Error("titleId mancante");
  if (!proposedBy) throw new Error("proposedBy mancante");
  if (!changes || typeof changes !== "object") throw new Error("changes mancanti");

  // Riusa la tua API già esistente
  return createUpdateRequest(titleId, changes, proposedBy);
}


