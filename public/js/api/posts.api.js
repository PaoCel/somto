// posts.api.js - Post testuali (Home feed)

import {
  collection,
  doc,
  addDoc,
  setDoc,
  deleteDoc,
  getDoc,
  getDocs,
  getCountFromServer,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import { db } from "../firebase.js";
import { t as i18nT } from "../i18n/index.js";

const POST_TEXT_MAX = 2000;
const COMMENT_TEXT_MAX = 5000;
const RATING_THREAD_PREFIX = "rating::";

function postRef(postId) {
  const id = String(postId || "").trim();
  if (!id) throw new Error("postId mancante");
  return doc(db, "posts", id);
}

function isRatingThreadId(postId) {
  return String(postId || "").startsWith(RATING_THREAD_PREFIX);
}

function socialThreadRef(postId) {
  const id = String(postId || "").trim();
  if (!id) throw new Error("postId mancante");
  if (isRatingThreadId(id)) {
    return doc(db, "ratingFeed", id);
  }
  return postRef(id);
}

function normalizeSharedPost(sharedPost) {
  const postId = String(sharedPost?.postId || sharedPost?.id || "").trim();
  const authorUid = String(sharedPost?.authorUid || "").trim();
  const authorName = String(sharedPost?.authorName || "").trim();
  const text = String(sharedPost?.text || "").trim();
  const titleIdRaw = sharedPost?.titleId;
  const titleId = titleIdRaw ? String(titleIdRaw).trim() : null;

  if (!postId) throw new Error(i18nT("post originale non valido"));
  if (!authorUid) throw new Error("autore post originale mancante");
  if (!authorName) throw new Error("nome autore post originale mancante");
  if (!text) throw new Error("testo post originale mancante");

  return {
    postId,
    authorUid,
    authorName: authorName.slice(0, 80),
    text: text.slice(0, POST_TEXT_MAX),
    titleId: titleId || null,
  };
}

/**
 * Crea un post minimale.
 * fields:
 * - authorUid (string)
 * - authorName (string) snapshot per feed
 * - text (string)
 * - titleId (string|null)
 * - kind ("post"|"share")
 * - sharedPost (snapshot post originale per kind=share)
 * - createdAt, updatedAt (serverTimestamp)
 */
export async function createPost({
  authorUid,
  authorName,
  text,
  titleId = null,
  kind = "post",
  sharedPost = null,
  visibility = "public",
  containsSpoiler = false,
  spoilerTitleIds = [],
}) {
  if (!authorUid) throw new Error("authorUid mancante");
  const normalizedKind = kind === "share" ? "share" : "post";
  const body = String(text || "").trim();
  if (normalizedKind === "post" && !body) throw new Error(i18nT("Scrivi qualcosa"));
  if (body.length > POST_TEXT_MAX) throw new Error("Testo troppo lungo");

  const vis = ["public", "friends", "private"].includes(visibility) ? visibility : "public";

  const data = {
    authorUid,
    authorName: String(authorName || "").trim() || "User",
    text: body,
    titleId: titleId || null,
    kind: normalizedKind,
    visibility: vis,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  if (normalizedKind === "share") {
    data.sharedPost = normalizeSharedPost(sharedPost);
  }

  if (containsSpoiler === true) {
    data.containsSpoiler = true;
    data.spoilerTitleIds = Array.isArray(spoilerTitleIds)
      ? spoilerTitleIds.map((v) => String(v || "").trim()).filter(Boolean).slice(0, 5)
      : [];
  }

  const ref = await addDoc(collection(db, "posts"), data);
  return { id: ref.id, ...data };
}

/**
 * Condivide un post nel feed creando un nuovo post "share".
 */
export async function createSharedPost({ authorUid, authorName, sourcePost, text = "" }) {
  const shared = normalizeSharedPost(sourcePost);
  return createPost({
    authorUid,
    authorName,
    text,
    titleId: shared.titleId || null,
    kind: "share",
    sharedPost: shared,
  });
}

/**
 * Lista post recenti (globale). Filtra lato client in base alla feed.
 * @returns { items, nextCursor }
 */
export async function listRecentPosts({ max = 30, cursor = null } = {}) {
  let q;
  if (cursor) {
    q = query(collection(db, "posts"), orderBy("createdAt", "desc"), startAfter(cursor), limit(max));
  } else {
    q = query(collection(db, "posts"), orderBy("createdAt", "desc"), limit(max));
  }

  const snap = await getDocs(q);
  const items = snap.docs.map(d => ({ id: d.id, ...d.data(), _cursor: d }));
  const nextCursor = snap.docs.length ? snap.docs[snap.docs.length - 1] : null;
  return { items, nextCursor };
}

/**
 * Lista post PUBBLICI di TUTTI gli utenti (non solo chi segui), più recenti
 * prima. Usata dal feed Community per il mix ranked (popolarità × recency).
 * Rules: `visibility=="public"` è leggibile da chiunque sia loggato
 * (canReadPost), quindi nessuna modifica alle rules è necessaria.
 * Richiede indice composito posts(visibility ASC, createdAt DESC) —
 * vedi firestore.indexes.json.
 * @returns { items, nextCursorDoc, hasMore }
 */
export async function listPublicPostsPage({ pageSize = 40, cursorDoc = null } = {}) {
  const size = Math.max(1, Math.min(80, Number(pageSize) || 40));
  const cursor = cursorDoc && typeof cursorDoc.data === "function" ? cursorDoc : null;

  const clauses = [
    where("visibility", "==", "public"),
    orderBy("createdAt", "desc"),
  ];
  if (cursor) clauses.push(startAfter(cursor));
  clauses.push(limit(size));

  const q = query(collection(db, "posts"), ...clauses);
  const snap = await getDocs(q);
  const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const nextCursorDoc = snap.docs.length ? snap.docs[snap.docs.length - 1] : null;
  return {
    items,
    nextCursorDoc,
    hasMore: snap.size >= size,
  };
}

// Visibilità riservata ai post-eco dei commenti (functions/lib/commentEcho.js).
// Separata da "public" così i client che non conoscono il gate anti-spoiler
// per progresso (iOS già sullo Store) non li mostrano in chiaro.
export const COMMENT_POST_VISIBILITY = "comment";

/**
 * Finestra per recency dei commenti (post-eco), tutta la community. Usa lo
 * stesso indice posts(visibility ASC, createdAt DESC) dei post pubblici:
 * l'uguaglianza vale per qualunque valore di visibility.
 */
export async function listCommentPostsPage({ pageSize = 30, cursorDoc = null } = {}) {
  const size = Math.max(1, Math.min(80, Number(pageSize) || 30));
  const cursor = cursorDoc && typeof cursorDoc.data === "function" ? cursorDoc : null;

  const clauses = [
    where("visibility", "==", COMMENT_POST_VISIBILITY),
    orderBy("createdAt", "desc"),
  ];
  if (cursor) clauses.push(startAfter(cursor));
  clauses.push(limit(size));

  const snap = await getDocs(query(collection(db, "posts"), ...clauses));
  const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return {
    items,
    nextCursorDoc: snap.docs.length ? snap.docs[snap.docs.length - 1] : null,
    hasMore: snap.size >= size,
  };
}

/**
 * Commenti (post-eco) sui titoli passati, a QUALSIASI età (non solo i più recenti).
 * Serve al feed Community per far emergere i commenti sui titoli che l'utente
 * guarda davvero — inclusi quelli storici creati dal backfill, che con la sola
 * query per recency non uscirebbero mai (stesso problema dei thread importati
 * da TV Time, vedi listPublicThreadsByTitleIds).
 *
 * Query `visibility == comment` + `titleId in <chunk di 30>` ordinata per
 * createdAt desc → indice composito posts(visibility, titleId, createdAt DESC)
 * in firestore.indexes.json.
 *
 * @param {string[]} titleIds
 * @param {{perChunkLimit?: number, inputCap?: number}} [opts]
 */
export async function listCommentPostsByTitleIds(titleIds = [], { perChunkLimit = 20, inputCap = 60 } = {}) {
  const ids = [...new Set((titleIds || []).map((v) => String(v || "").trim()).filter(Boolean))].slice(0, inputCap);
  if (!ids.length) return [];

  const chunks = [];
  for (let i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30));

  const perChunk = await Promise.all(chunks.map(async (chunk) => {
    try {
      const snap = await getDocs(query(
        collection(db, "posts"),
        where("visibility", "==", COMMENT_POST_VISIBILITY),
        where("titleId", "in", chunk),
        orderBy("createdAt", "desc"),
        limit(Math.max(1, Math.min(60, Number(perChunkLimit) || 20))),
      ));
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    } catch (err) {
      console.warn("[posts.api] listCommentPostsByTitleIds chunk failed", err);
      return [];
    }
  }));

  return perChunk.flat();
}

/**
 * Post pubblici di UN autore (più recenti prima). Usata dal tab Community del
 * profilo (proprio e altrui — la lettura `visibility=="public"` è permessa a
 * chiunque sia loggato dalle rules, nessuna modifica alle rules necessaria).
 * Richiede indice composito posts(authorUid ASC, visibility ASC, createdAt
 * DESC) — vedi firestore.indexes.json (NON deployato da questa modifica).
 */
export async function listPublicPostsByAuthor(uid, { max = 200 } = {}) {
  if (!uid) return [];
  const q = query(
    collection(db, "posts"),
    where("authorUid", "==", uid),
    where("visibility", "==", "public"),
    orderBy("createdAt", "desc"),
    limit(max)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function likeRef(postId, uid) {
  const userId = String(uid || "").trim();
  if (!userId) throw new Error("uid mancante");
  return doc(socialThreadRef(postId), "likes", userId);
}

function commentRef(postId, commentId) {
  const cid = String(commentId || "").trim();
  if (!cid) throw new Error("commentId mancante");
  return doc(socialThreadRef(postId), "comments", cid);
}

function commentLikeRef(postId, commentId, uid) {
  const userId = String(uid || "").trim();
  if (!userId) throw new Error("uid mancante");
  return doc(commentRef(postId, commentId), "likes", userId);
}

/**
 * Ritorna true se l'utente ha messo like al post.
 */
export async function isPostLikedByMe({ postId, uid }) {
  if (!postId || !uid) return false;
  const snap = await getDoc(likeRef(postId, uid));
  return snap.exists();
}

/**
 * Toggle like per utente corrente.
 * @returns { liked: boolean }
 */
export async function togglePostLike({ postId, uid }) {
  const ref = likeRef(postId, uid);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    await deleteDoc(ref);
    return { liked: false };
  }
  await setDoc(ref, {
    uid: String(uid).trim(),
    createdAt: serverTimestamp(),
  });
  return { liked: true };
}

/**
 * Lista ultimi commenti del post (ordine cronologico) + meta like.
 */
export async function listPostComments(postId, { max = 20, viewerUid = null } = {}) {
  const q = query(
    collection(socialThreadRef(postId), "comments"),
    orderBy("createdAt", "desc"),
    limit(max)
  );
  const snap = await getDocs(q);
  const base = snap.docs.map(d => ({ id: d.id, ...d.data() })).reverse();

  const withLikes = await Promise.all(base.map(async (row) => {
    const commentId = row.id;
    const [likesSnap, mineSnap] = await Promise.all([
      getCountFromServer(collection(commentRef(postId, commentId), "likes")).catch(() => null),
      viewerUid ? getDoc(commentLikeRef(postId, commentId, viewerUid)).catch(() => null) : Promise.resolve(null),
    ]);
    return {
      ...row,
      likes: Number(likesSnap?.data()?.count || 0),
      likedByMe: !!mineSnap?.exists?.(),
    };
  }));

  return withLikes;
}

/**
 * Aggiunge un commento al post.
 */
export async function addPostComment({ postId, uid, authorName, text, containsSpoiler = false, spoilerTitleIds = [] }) {
  if (!uid) throw new Error("uid mancante");
  const body = String(text || "").trim();
  if (!body) throw new Error(i18nT("Scrivi un commento"));
  if (body.length > COMMENT_TEXT_MAX) throw new Error(i18nT("Commento troppo lungo"));

  const data = {
    uid: String(uid).trim(),
    authorName: String(authorName || "").trim() || "User",
    text: body,
    createdAt: serverTimestamp(),
  };

  if (containsSpoiler === true) {
    data.containsSpoiler = true;
    data.spoilerTitleIds = Array.isArray(spoilerTitleIds)
      ? spoilerTitleIds.map((v) => String(v || "").trim()).filter(Boolean).slice(0, 5)
      : [];
  }

  const ref = await addDoc(collection(socialThreadRef(postId), "comments"), data);
  return { id: ref.id, ...data };
}

/**
 * Toggle like su commento.
 * @returns { liked: boolean }
 */
export async function togglePostCommentLike({ postId, commentId, uid }) {
  const ref = commentLikeRef(postId, commentId, uid);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    await deleteDoc(ref);
    return { liked: false };
  }
  await setDoc(ref, {
    uid: String(uid).trim(),
    createdAt: serverTimestamp(),
  });
  return { liked: true };
}

/**
 * Conteggi social del post.
 */
export async function getPostSocialCounts(postId) {
  const baseRef = socialThreadRef(postId);
  const likesP = getCountFromServer(collection(baseRef, "likes")).catch(() => null);
  const commentsP = getCountFromServer(collection(baseRef, "comments")).catch(() => null);
  const sharesP = isRatingThreadId(postId)
    ? Promise.resolve(null)
    : getCountFromServer(collection(baseRef, "shares")).catch(() => null);

  const [likesSnap, commentsSnap, sharesSnap] = await Promise.all([likesP, commentsP, sharesP]);

  return {
    likes: Number(likesSnap?.data()?.count || 0),
    comments: Number(commentsSnap?.data()?.count || 0),
    shares: Number(sharesSnap?.data()?.count || 0),
  };
}

/** Conteggio leggero per superfici che mostrano solo la conversazione. */
export async function getPostCommentCount(postId) {
  const baseRef = socialThreadRef(postId);
  const snapshot = await getCountFromServer(collection(baseRef, "comments"));
  return Number(snapshot.data()?.count || 0);
}

/**
 * Registra un evento condivisione del post.
 */
export async function registerPostShare({ postId, uid, mode = "feed" }) {
  if (!uid) throw new Error("uid mancante");
  if (isRatingThreadId(postId)) throw new Error(i18nT("Condivisione non disponibile per questo contenuto"));
  const shareMode = mode === "external" ? "external" : "feed";
  await addDoc(collection(socialThreadRef(postId), "shares"), {
    uid: String(uid).trim(),
    mode: shareMode,
    createdAt: serverTimestamp(),
  });
}
