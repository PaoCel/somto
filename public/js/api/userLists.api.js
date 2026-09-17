// userLists.api.js — Collection `userLists` (root) + items/members/progress.
// Replica WatchlistRepository.swift (iOS) per PWA. Modelli condivisi con
// firestore.rules `match /userLists/{listId}` (visibility/memberUids/editorUids).

import {
  collection,
  doc,
  setDoc,
  getDoc,
  getDocs,
  deleteDoc,
  writeBatch,
  query,
  where,
  orderBy,
  limit as fbLimit,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import { db } from "../firebase.js";
import { t as i18nT } from "../i18n/index.js";
import { getMyUserDoc } from "./users.api.js";
import { getTitlesByIds } from "./titles.api.js";

const LIST_COLLECTION = "userLists";
const PUBLIC_LIST_COLLECTION = "publicUserLists";

// Vincolo condiviso con firestore.rules `validUserListDoc` (title.size() tra 2 e 80).
const LIST_TITLE_MIN_LENGTH = 2;
const LIST_TITLE_MAX_LENGTH = 80;

/** Valida il titolo lista lato client, prima di mandarlo alle rules (che altrimenti
 * rifiutano con un generico permission-denied poco leggibile per l'utente). */
function validateListTitle(rawTitle) {
  const title = String(rawTitle || "").trim();
  if (title.length < LIST_TITLE_MIN_LENGTH) {
    throw new Error(i18nT("Il titolo della lista deve avere almeno {LIST_TITLE_MIN_LENGTH} caratteri.", { LIST_TITLE_MIN_LENGTH }));
  }
  if (title.length > LIST_TITLE_MAX_LENGTH) {
    throw new Error(i18nT("Il titolo della lista può avere al massimo {LIST_TITLE_MAX_LENGTH} caratteri.", { LIST_TITLE_MAX_LENGTH }));
  }
  return title;
}

function timestampMs(value) {
  if (!value) return 0;
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (typeof value?.seconds === "number") {
    return (value.seconds * 1000) + Math.floor((value.nanoseconds || 0) / 1e6);
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStringIds(value, max = 100) {
  const seen = new Set();
  const out = [];
  safeArray(value).forEach((raw) => {
    const id = String(raw || "").trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  });
  return out.slice(0, max);
}

function sameStringSet(a, b) {
  const aa = uniqueStringIds(a, 500).sort();
  const bb = uniqueStringIds(b, 500).sort();
  return aa.length === bb.length && aa.every((v, i) => v === bb[i]);
}

function normalizeListDoc(id, data = {}, currentUid = null) {
  const ownerUid = String(data.ownerUid || "").trim();
  const memberUids = safeArray(data.memberUids).map((v) => String(v || ""));
  const editorUids = safeArray(data.editorUids).map((v) => String(v || ""));
  const visibility = ["private", "public", "shared"].includes(String(data.visibility || "").toLowerCase())
    ? String(data.visibility).toLowerCase()
    : "private";
  const kind = String(data.kind || "").toLowerCase() === "ordered_path" ? "ordered_path" : "collection";

  const isOwner = !!currentUid && ownerUid === currentUid;
  const isEditor = !!currentUid && editorUids.includes(currentUid);

  // slug: prefer explicit `slug`, fallback to `editorialSlug`, else null.
  const slug = data.slug ? String(data.slug) : (data.editorialSlug ? String(data.editorialSlug) : null);

  return {
    id,
    title: String(data.title || i18nT("Senza titolo")),
    description: data.description ? String(data.description) : null,
    visibility,
    kind,
    ownerUid,
    owner: data.owner && typeof data.owner === "object" ? data.owner : null,
    memberUids,
    editorUids,
    cover: {
      imageURL: data.cover?.imageUrl || data.cover?.imageURL || data.coverImageURL || null,
      storagePath: data.cover?.storagePath || null,
      fallbackTitleIds: safeArray(data.cover?.fallbackTitleIds || data.previewTitleIds),
      accentHex: data.cover?.accentHex || null,
    },
    itemCount: Math.max(0, Number(data.itemCount || 0) || 0),
    completedCount: Math.max(0, Number(data.completedCount || 0) || 0),
    followersCount: Math.max(0, Number(data.followersCount || 0) || 0),
    createdAt: data.createdAt || null,
    updatedAt: data.updatedAt || null,
    isOwnedByCurrentUser: isOwner,
    canEdit: isOwner || isEditor,
    isSavedByCurrentUser: false,
    previewTitles: [],
    slug,
    editorialSlug: data.editorialSlug ? String(data.editorialSlug) : null,
    editorial: data.editorial === true,
    itemTitleIds: safeArray(data.itemTitleIds),
    _sortTime: Math.max(timestampMs(data.updatedAt), timestampMs(data.createdAt)),
  };
}

function normalizeItemDoc(id, data = {}) {
  return {
    id,
    titleId: String(data.titleId || id),
    orderIndex: Number(data.orderIndex || 0) || 0,
    addedByUid: data.addedByUid ? String(data.addedByUid) : null,
    note: data.note ? String(data.note) : null,
    addedAt: data.addedAt || null,
    updatedAt: data.updatedAt || null,
  };
}

function normalizeMemberDoc(id, data = {}) {
  return {
    id,
    uid: String(data.uid || id),
    displayName: String(data.displayName || ""),
    photoURL: data.photoURL || null,
    role: ["owner", "editor", "viewer"].includes(String(data.role || "")) ? data.role : "viewer",
    joinedAt: data.joinedAt || null,
  };
}

function normalizeProgressDoc(id, data = {}) {
  return {
    id,
    uid: String(data.uid || id),
    displayName: String(data.displayName || ""),
    photoURL: data.photoURL || null,
    completedCount: Math.max(0, Number(data.completedCount || 0) || 0),
    totalCount: Math.max(0, Number(data.totalCount || 0) || 0),
    percentComplete: Math.max(0, Math.min(1, Number(data.percentComplete || 0) || 0)),
    lastCompletedAt: data.lastCompletedAt || null,
    updatedAt: data.updatedAt || null,
  };
}

/* ===== READ ===== */

export async function fetchOwnedAndSharedLists(uid, { max = 80 } = {}) {
  if (!uid) return [];
  const snap = await getDocs(query(
    collection(db, LIST_COLLECTION),
    where("memberUids", "array-contains", uid),
    orderBy("updatedAt", "desc"),
    fbLimit(max),
  )).catch(() => null);
  if (!snap) return [];
  return snap.docs.map((d) => normalizeListDoc(d.id, d.data() || {}, uid));
}

export async function fetchPublicLists(currentUid, { max = 24 } = {}) {
  const snap = await getDocs(query(
    collection(db, PUBLIC_LIST_COLLECTION),
    orderBy("followersCount", "desc"),
    fbLimit(max),
  )).catch(() => null);
  if (!snap) return [];
  return snap.docs
    .map((d) => normalizeListDoc(d.id, d.data() || {}, currentUid))
    .filter((list) => list.ownerUid !== currentUid);
}

export async function fetchListDetail(listId, currentUid = null) {
  if (!listId) return null;
  const listRef = doc(db, LIST_COLLECTION, listId);
  const listSnap = await getDoc(listRef).catch(() => null);
  let summary = null;
  let canReadPrivateSubdocs = false;
  if (listSnap?.exists()) {
    summary = normalizeListDoc(listSnap.id, listSnap.data() || {}, currentUid);
    canReadPrivateSubdocs = summary.isOwnedByCurrentUser
      || summary.canEdit
      || summary.memberUids.includes(currentUid);
  } else {
    const publicSnap = await getDoc(doc(db, PUBLIC_LIST_COLLECTION, listId)).catch(() => null);
    if (!publicSnap?.exists()) return null;
    summary = normalizeListDoc(publicSnap.id, publicSnap.data() || {}, currentUid);
  }

  const [itemsSnap, membersSnap, progressSnap] = await Promise.all([
    getDocs(query(collection(listRef, "items"), orderBy("orderIndex", "asc"))).catch(() => null),
    canReadPrivateSubdocs ? getDocs(collection(listRef, "members")).catch(() => null) : Promise.resolve(null),
    canReadPrivateSubdocs ? getDocs(collection(listRef, "progress")).catch(() => null) : Promise.resolve(null),
  ]);

  const items = itemsSnap ? itemsSnap.docs.map((d) => normalizeItemDoc(d.id, d.data() || {})) : [];
  const members = membersSnap ? membersSnap.docs.map((d) => normalizeMemberDoc(d.id, d.data() || {})) : [];
  const progress = progressSnap ? progressSnap.docs.map((d) => normalizeProgressDoc(d.id, d.data() || {})) : [];

  return { list: summary, items, members, progress };
}

/**
 * Hydrate ogni list con poster preview (fino a 4) recuperando i titoli dai fallbackTitleIds
 * o, in mancanza, dai primi item della subcollection items.
 */
export async function hydratePreviewTitles(lists, { perList = 4 } = {}) {
  if (!Array.isArray(lists) || lists.length === 0) return lists;

  const tasks = lists.map(async (list) => {
    try {
      let titleIds = safeArray(list.cover.fallbackTitleIds).slice(0, perList);
      if (titleIds.length === 0 && list.itemCount > 0) {
        const itemsSnap = await getDocs(query(
          collection(db, LIST_COLLECTION, list.id, "items"),
          orderBy("orderIndex", "asc"),
          fbLimit(perList),
        )).catch(() => null);
        titleIds = itemsSnap ? itemsSnap.docs.map((d) => d.data()?.titleId).filter(Boolean) : [];
      }
      if (titleIds.length === 0) return list;
      // Batched read (1 query/30 id, cache 60s) invece di N+1.
      const titlesMap = await getTitlesByIds(titleIds).catch(() => new Map());
      list.previewTitles = titleIds.map(id => titlesMap.get(id)).filter(Boolean);
    } catch (_) { /* noop */ }
    return list;
  });

  return Promise.all(tasks);
}

/* ===== SAVED LISTS =====
 * "Lista pubblica salvata" in users/{uid}/savedLists/{listId}
 * Schema allineato a iOS WatchlistRepository.togglePublicListPin (firestore.rules:475).
 */
const SAVED_LISTS_COLL = "savedLists";

export async function fetchPinnedPublicListIds(uid) {
  if (!uid) return [];
  const snap = await getDocs(collection(db, "users", uid, SAVED_LISTS_COLL)).catch(() => null);
  if (!snap) return [];
  return snap.docs.map((d) => d.id);
}

export async function togglePublicListPin(uid, listId, isPinned) {
  if (!uid || !listId) throw new Error("uid/listId mancante");
  const ref = doc(db, "users", uid, SAVED_LISTS_COLL, listId);
  if (isPinned) {
    await setDoc(ref, {
      listId,
      isPinned: true,
      pinnedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true });
  } else {
    await deleteDoc(ref).catch(() => {});
  }
  return { listId, isPinned };
}

/* ===== PROGRESS ENTRIES (su liste pubbliche) =====
 * Memorizzati in users/{uid}/listProgressEntries (vedi WatchlistRepository.swift)
 */
export async function fetchPublicListProgressEntries(uid) {
  if (!uid) return [];
  const snap = await getDocs(collection(db, "users", uid, "listProgressEntries")).catch(() => null);
  if (!snap) return [];
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
}

/* ===== CRUD ===== */

export async function createList(uid, draft = {}) {
  if (!uid) throw new Error("uid mancante");
  const title = validateListTitle(draft.title);
  const visibility = ["private", "public", "shared"].includes(draft.visibility) ? draft.visibility : "private";
  const kind = draft.kind === "ordered_path" ? "ordered_path" : "collection";

  const ownerDoc = await getMyUserDoc(uid).catch(() => null);
  // FASE 1: la lista nasce SEMPRE con il solo creator come member. Le rules
  // (firestore.rules `match /userLists/{listId}` allow create) richiedono
  // `memberUids == [uid()]` e `editorUids == []` (o assente) per evitare che
  // un attaccante pre-inserisca utenti che non hanno mai accettato. I
  // collaboratori vanno invitati uno alla volta in FASE 2 via update.
  const collaboratorIDs = visibility === "shared"
    ? uniqueStringIds(draft.collaboratorIDs).filter((c) => c !== uid)
    : [];
  if (collaboratorIDs.length > 0) {
    throw new Error(i18nT("Inviti collaboratori non ancora disponibili: serve accettazione esplicita."));
  }

  const listRef = doc(collection(db, LIST_COLLECTION));
  const now = serverTimestamp();
  const selectedTitleIDs = uniqueStringIds(draft.selectedTitleIDs);
  const payload = {
    ownerUid: uid,
    title,
    description: draft.description ? String(draft.description) : null,
    visibility,
    kind,
    memberUids: [uid],
    editorUids: [],
    cover: {
      imageUrl: null,
      storagePath: null,
      fallbackTitleIds: [],
      accentHex: null,
    },
    itemTitleIds: [],
    previewTitleIds: [],
    itemCount: 0,
    completedCount: 0,
    followersCount: 0,
    owner: ownerDoc
      ? {
          uid,
          displayName: String(ownerDoc.displayName || i18nT("Utente")),
          photoURL: ownerDoc.photoURL || null,
        }
      : { uid, displayName: i18nT("Utente"), photoURL: null },
    createdAt: now,
    updatedAt: now,
  };

  const batch = writeBatch(db);
  batch.set(listRef, payload);

  const ownerMemberRef = doc(listRef, "members", uid);
  batch.set(ownerMemberRef, {
    uid,
    displayName: payload.owner.displayName,
    photoURL: payload.owner.photoURL,
    role: "owner",
    joinedAt: now,
  });

  if (selectedTitleIDs.length > 0) {
    selectedTitleIDs.forEach((titleId, idx) => {
      const itemRef = doc(listRef, "items", titleId);
      batch.set(itemRef, {
        titleId,
        orderIndex: idx,
        addedByUid: uid,
        note: null,
        addedAt: now,
        updatedAt: now,
      });
    });
  }

  await batch.commit();

  return { id: listRef.id };
}

export async function updateList(listId, patch = {}) {
  if (!listId) throw new Error("listId mancante");
  const ref = doc(db, LIST_COLLECTION, listId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error(i18nT("Lista non trovata."));

  const existing = snap.data() || {};
  const allowedPatchKeys = new Set(["title", "description", "kind", "visibility", "collaboratorIDs"]);
  const next = { updatedAt: serverTimestamp() };
  Object.entries(patch || {}).forEach(([key, value]) => {
    if (allowedPatchKeys.has(key)) next[key] = value;
  });
  if (Object.prototype.hasOwnProperty.call(patch || {}, "title")) {
    next.title = validateListTitle(patch.title);
  }
  if (patch.collaboratorIDs && Array.isArray(patch.collaboratorIDs)) {
    const requested = uniqueStringIds(patch.collaboratorIDs);
    const current = uniqueStringIds(existing.editorUids);
    if (!sameStringSet(requested, current)) {
      throw new Error(i18nT("Modifica collaboratori non ancora disponibile: serve accettazione esplicita."));
    }
    delete next.collaboratorIDs;
  }

  await setDoc(ref, next, { merge: true });
  return { updated: true };
}

export async function deleteList(listId) {
  if (!listId) throw new Error("listId mancante");
  const ref = doc(db, LIST_COLLECTION, listId);
  await deleteDoc(ref);
  return { deleted: true };
}

export async function addTitleToList(listId, titleId, { uid, note = null } = {}) {
  if (!listId || !titleId) throw new Error("listId/titleId mancante");
  const listRef = doc(db, LIST_COLLECTION, listId);
  const itemRef = doc(listRef, "items", String(titleId));

  const existing = await getDoc(itemRef);
  if (existing.exists()) return { id: itemRef.id, alreadyPresent: true };

  const listSnap = await getDoc(listRef);
  const listData = listSnap.data() || {};
  const currentIds = uniqueStringIds(listData.itemTitleIds, 500);
  const nextIds = currentIds.includes(String(titleId)) ? currentIds : [...currentIds, String(titleId)];

  const batch = writeBatch(db);
  batch.set(itemRef, {
    titleId: String(titleId),
    orderIndex: nextIds.length - 1,
    addedByUid: uid || null,
    note: note ? String(note) : null,
    addedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  batch.set(listRef, { updatedAt: serverTimestamp() }, { merge: true });
  await batch.commit();
  return { id: itemRef.id, alreadyPresent: false };
}

export async function removeTitleFromList(listId, titleId, { uid = null } = {}) {
  if (!listId || !titleId) throw new Error("listId/titleId mancante");
  const listRef = doc(db, LIST_COLLECTION, listId);
  const itemRef = doc(listRef, "items", String(titleId));

  const batch = writeBatch(db);
  batch.delete(itemRef);
  batch.set(listRef, { updatedAt: serverTimestamp() }, { merge: true });
  await batch.commit();
  return { deleted: true };
}

export async function reorderListItems(listId, orderedTitleIds = [], { uid = null } = {}) {
  if (!listId || !Array.isArray(orderedTitleIds)) throw new Error("listId/orderedTitleIds mancante");
  const listRef = doc(db, LIST_COLLECTION, listId);
  const orderedIds = uniqueStringIds(orderedTitleIds, 500);

  const batch = writeBatch(db);
  orderedIds.forEach((titleId, idx) => {
    const ref = doc(listRef, "items", titleId);
    batch.set(ref, { orderIndex: idx, updatedAt: serverTimestamp() }, { merge: true });
  });
  batch.set(listRef, { updatedAt: serverTimestamp() }, { merge: true });
  await batch.commit();
  return { reordered: orderedIds.length };
}

/* ===== NUOVE QUERY (contratto condiviso iOS + web) ===== */

/**
 * Risolve slug → lista pubblica.
 * Prima prova `slug == slug`, poi `editorialSlug == slug` come fallback.
 * Allineato al deep link iOS: la risoluzione pubblica usa la proiezione server-owned.
 *
 * @param {string} slug
 * @param {string|null} [currentUid]
 * @returns {Promise<object|null>}
 */
export async function fetchListBySlug(slug, currentUid = null) {
  if (!slug) return null;
  const s = String(slug).trim();

  // 1. Cerca su campo `slug`
  const snap1 = await getDocs(query(
    collection(db, PUBLIC_LIST_COLLECTION),
    where("slug", "==", s),
    fbLimit(1),
  )).catch(() => null);
  const doc1 = snap1?.docs?.[0];
  if (doc1) return normalizeListDoc(doc1.id, doc1.data() || {}, currentUid);

  // 2. Fallback su `editorialSlug`
  const snap2 = await getDocs(query(
    collection(db, PUBLIC_LIST_COLLECTION),
    where("editorialSlug", "==", s),
    fbLimit(1),
  )).catch(() => null);
  const doc2 = snap2?.docs?.[0];
  if (doc2) return normalizeListDoc(doc2.id, doc2.data() || {}, currentUid);

  return null;
}

/**
 * Recupera le liste pubbliche che contengono un determinato titolo.
 * Dipende dal campo server-side `itemTitleIds` (array di titleId mantenuto da CF).
 * Se il campo non esiste ancora, il risultato sarà vuoto (array vuoto).
 *
 * @param {string} titleId
 * @param {object} [opts]
 * @param {number} [opts.max=12]
 * @param {string|null} [opts.currentUid]
 * @returns {Promise<object[]>}
 */
export async function fetchListsContainingTitle(titleId, { max = 12, currentUid = null } = {}) {
  if (!titleId) return [];
  const snap = await getDocs(query(
    collection(db, PUBLIC_LIST_COLLECTION),
    where("itemTitleIds", "array-contains", String(titleId)),
    orderBy("followersCount", "desc"),
    fbLimit(max),
  )).catch(() => null);
  if (!snap) return [];
  return snap.docs.map((d) => normalizeListDoc(d.id, d.data() || {}, currentUid));
}
