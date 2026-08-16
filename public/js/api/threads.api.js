// threads.api.js - VERSIONE CORRETTA con versione Firebase unificata

// ✅ FIX: Usa la stessa versione di Firebase (v10.12.5) di firebase.js
import {
  collection,
  doc,
  documentId,
  getDoc,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  onSnapshot,
  serverTimestamp,
  writeBatch,
  arrayUnion,
  arrayRemove
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";
import { t as i18nT } from "../i18n/index.js";

// Import db dal tuo firebase service
import { app, db } from "../firebase.js";
import { logEvent } from "../analytics.js";

const functions = getFunctions(app, "europe-west1");
const ensureMySupportThreadCallable = httpsCallable(functions, "ensureMySupportThread");
const sendThreadMessageCallable = httpsCallable(functions, "sendThreadMessage");
const gifSearchCallable = httpsCallable(functions, "gifSearch");

// ===== UTILITY =====

function sortPair(a, b) {
  return [a, b].sort();
}

function stableHash(str) {
  let h = 5381;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function toCursorDoc(value) {
  return value && typeof value.data === "function" ? value : null;
}

function mapThreadPageSnapshot(snap, pageSize) {
  const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const nextCursorDoc = snap.docs.length ? snap.docs[snap.docs.length - 1] : null;
  return {
    items,
    nextCursorDoc,
    hasMore: snap.size >= pageSize,
  };
}

// ===== THREAD ID GENERATORS =====

export function threadIdForDM(titleId, uidA, uidB) {
  const [a, b] = sortPair(uidA, uidB);
  return `dm_${titleId}_${a}_${b}`;
}

export function threadIdForPublic(titleId) {
  return `public_${titleId}`;
}

/**
 * Thread pubblico SCOPED a un singolo episodio. Riusa lo stesso doc shape del
 * thread pubblico title-level (`validThreadDocShape` in firestore.rules non
 * ammette campi extra season/episode: l'unica via senza toccare le rules è
 * codificare season/episodio nell'ID stesso, che le rules già permettono
 * come qualunque altra stringa `contextId`/`public_*`). L'id resta conforme
 * al pattern `^public_.+` richiesto da `isPublicThreadId()`.
 */
export function threadIdForPublicEpisode(titleId, season, episode) {
  const s = Number(season);
  const e = Number(episode);
  return `public_${titleId}_s${s}e${e}`;
}

export function threadIdForGroup(titleId, uids) {
  const sorted = [...uids].sort();
  const hash = stableHash(sorted.join("_"));
  // Se titleId è null/undefined, il gruppo è "persistente" (non legato a un titolo)
  return titleId ? `group_${titleId}_${hash}` : `group__${hash}`;
}

// ===== CORE FUNCTION =====

async function ensureThread(threadId, data) {
  const ref = doc(db, "threads", threadId);

  // Prima prova a leggere (funziona se il thread esiste già e l'utente ha accesso)
  try {
    const snap = await getDoc(ref);
    if (snap.exists()) {
      return { id: snap.id, ...snap.data() };
    }
  } catch (_) {
    // getDoc fallisce se il doc non esiste e le regole read usano resource.data
    // (es. thread privati non ancora creati) — prosegui con la creazione
  }

  // Il thread non esiste (o non era leggibile): crealo
  await setDoc(ref, data);
  return { id: ref.id, ...data };
}

// ===== PUBLIC API =====

export async function ensureDMThread({ titleId, uidA, uidB, createdBy }) {
  // Validazione
  if (!titleId) throw new Error("titleId mancante");
  if (!uidA || !uidB) throw new Error("uid mancanti");
  if (uidA === uidB) throw new Error(i18nT("Non puoi aprire un DM con te stesso"));
  
  const tid = threadIdForDM(titleId, uidA, uidB);
  const [a, b] = sortPair(uidA, uidB);
  
  console.log("🔒 DM Thread:", {
    threadId: tid,
    participants: [a, b],
    createdBy,
  });
  
  return ensureThread(tid, {
    titleId,
    visibility: "private",
    contextType: "dm",
    contextId: `${a}_${b}`,
    participants: [a, b],
    groupName: "",
    createdBy,
    createdAt: serverTimestamp(),
    lastMessageAt: null,
    lastMessagePreview: "",
    lastSenderUid: null,
    lastMessageId: null,
  });
}

/**
 * Thread pubblico per un titolo. Se `season`+`episode` sono entrambi presenti
 * (interi > 0), apre/crea il thread SCOPED a quell'episodio (id + contextId
 * dedicati) invece del thread title-level "global". Doc shape identica in
 * entrambi i casi — nessuna modifica alle rules richiesta (vedi
 * threadIdForPublicEpisode).
 */
export async function ensurePublicThread({ titleId, createdBy, season = null, episode = null }) {
  if (!titleId) throw new Error("titleId mancante");

  const s = Number(season);
  const e = Number(episode);
  const isEpisodeScoped = Number.isFinite(s) && s > 0 && Number.isFinite(e) && e > 0;

  const tid = isEpisodeScoped ? threadIdForPublicEpisode(titleId, s, e) : threadIdForPublic(titleId);
  return ensureThread(tid, {
    titleId,
    visibility: "public",
    contextType: "public",
    contextId: isEpisodeScoped ? `s${s}e${e}` : "global",
    participants: [],
    groupName: isEpisodeScoped ? i18nT("Discussione episodio") : "Discussione pubblica",
    createdBy,
    createdAt: serverTimestamp(),
    // Nessun "ultimo messaggio" finché non viene davvero inviato un messaggio.
    lastMessageAt: null,
    lastMessagePreview: "",
    lastSenderUid: null,
    lastMessageId: null,
  });
}

/**
 * Batch-read dei thread episodio per un titolo: dice quali episodi HANNO già
 * una discussione (badge di presenza, non un conteggio esatto — un contatore
 * preciso richiederebbe un aggregato server-side, fuori scope qui). Un
 * episodio "ha discussione" se il suo thread esiste E `lastMessageAt != null`
 * (thread creato ma senza messaggi = nessuna discussione reale).
 *
 * Usa `where(documentId(), "in", [...])`, che non richiede indice composito
 * e passa la rule `allow list` pubblica (ogni id `public_<titleId>_sNeM`
 * matcha `^public_.+`). Chunk a 30 id (limite Firestore per `in`).
 *
 * @param {string} titleId
 * @param {{s:number, e:number}[]} episodeRefs
 * @returns {Promise<Set<string>>} set di "s{season}e{episode}" con discussione attiva
 */
export async function listEpisodeThreadDocs(titleId, episodeRefs) {
  const clean = (episodeRefs || [])
    .map(({ s, e }) => ({ s: Number(s), e: Number(e) }))
    .filter(({ s, e }) => Number.isFinite(s) && s > 0 && Number.isFinite(e) && e > 0);
  if (!titleId || !clean.length) return new Set();

  const idToKey = new Map(clean.map(({ s, e }) => [threadIdForPublicEpisode(titleId, s, e), `s${s}e${e}`]));
  const allIds = Array.from(idToKey.keys());

  const active = new Set();
  const CHUNK = 30;
  for (let i = 0; i < allIds.length; i += CHUNK) {
    const chunk = allIds.slice(i, i + CHUNK);
    try {
      const snap = await getDocs(query(
        collection(db, "threads"),
        where(documentId(), "in", chunk)
      ));
      snap.docs.forEach((d) => {
        const data = d.data() || {};
        if (data.lastMessageAt != null) {
          const key = idToKey.get(d.id);
          if (key) active.add(key);
        }
      });
    } catch (err) {
      console.warn("[threads.api] listEpisodeThreadDocs chunk failed", err);
    }
  }
  return active;
}

export async function ensureGroupThread({ titleId = null, participantUids, groupName, createdBy }) {
  if (!participantUids || participantUids.length < 2) {
    throw new Error("Servono almeno 2 partecipanti");
  }

  const tid = threadIdForGroup(titleId, participantUids);

  console.log("👥 Group Thread:", {
    threadId: tid,
    participants: participantUids,
    createdBy,
  });

  return ensureThread(tid, {
    titleId: titleId || null,
    visibility: "private",
    contextType: "group",
    contextId: stableHash(participantUids.sort().join("_")),
    participants: participantUids.sort(),
    groupName: groupName || i18nT("Gruppo"),
    createdBy,
    createdAt: serverTimestamp(),
    lastMessageAt: null,
    lastMessagePreview: "",
    lastSenderUid: null,
    lastMessageId: null,
  });
}

// ===== MESSAGES =====

export async function sendMessage({ threadId, uid, displayName, text }) {
  if (!threadId) throw new Error("threadId mancante");
  if (!uid) throw new Error("uid mancante");
  if (!text?.trim()) throw new Error(i18nT("Messaggio vuoto"));
  
  const threadRef = doc(db, "threads", threadId);
  const messagesRef = collection(threadRef, "messages");
  const msgRef = doc(messagesRef);
  
  // Aggiungi messaggio
  const msgData = {
    uid,
    displayName: displayName || "Anonimo",
    text: text.trim(),
    type: "text",
    createdAt: serverTimestamp(),
  };

  const batch = writeBatch(db);
  batch.set(msgRef, msgData);
  batch.update(threadRef, {
      lastMessageId: msgRef.id,
      lastMessageAt: serverTimestamp(),
      lastMessagePreview: text.trim().slice(0, 100),
      lastSenderUid: uid,
  });
  await batch.commit();

  void logEvent("thread_message_sent", {
    thread_type: "generic",
    has_title_ref: false,
    message_len: text.trim().length,
  });

  return { id: msgRef.id, ...msgData };
}

export function onMessagesSnapshot(threadId, callback) {
  if (!threadId) throw new Error("threadId mancante");
  
  const threadRef = doc(db, "threads", threadId);
  const messagesRef = collection(threadRef, "messages");
  const msgRef = doc(messagesRef);
  const q = query(messagesRef, orderBy("createdAt", "asc"));
  
  return onSnapshot(q, (snap) => {
    const messages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    callback(messages);
  });
}

export async function getThread(threadId) {
  if (!threadId) throw new Error("threadId mancante");
  
  const ref = doc(db, "threads", threadId);
  const snap = await getDoc(ref);
  
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

export async function ensureMySupportThread() {
  const res = await ensureMySupportThreadCallable({});
  return res?.data || null;
}

/**
 * Invia dalla chat assistenza pubblica passando dal server: mantiene rate
 * limit, moderazione e controllo membership anche se il client è alterato.
 */
export async function sendSupportThreadMessage({ threadId, text }) {
  const cleanThreadId = String(threadId || "").trim();
  const cleanText = String(text || "").trim();
  if (!cleanThreadId) throw new Error("threadId mancante");
  if (!cleanText) throw new Error(i18nT("Messaggio vuoto"));

  const res = await sendThreadMessageCallable({
    threadId: cleanThreadId,
    type: "text",
    text: cleanText,
  });
  return res?.data || null;
}

/**
 * Ultimi messaggi in tempo reale, ordinati dal più vecchio al più recente.
 * La query DESC evita che il cap mostri i primi messaggi storici dei thread
 * lunghi; il reverse ripristina l'ordine naturale nella UI.
 */
export function listenLatestThreadMessages(threadId, { max = 120, onChange, onError } = {}) {
  if (!threadId) throw new Error("threadId mancante");

  const messagesRef = collection(doc(db, "threads", threadId), "messages");
  const q = query(messagesRef, orderBy("createdAt", "desc"), limit(clampInt(max, 1, 250, 120)));

  return onSnapshot(q, (snap) => {
    const messages = snap.docs
      .map((messageDoc) => ({ id: messageDoc.id, ...messageDoc.data() }))
      .reverse();
    onChange?.(messages);
  }, (err) => {
    console.error("[threads.api] listenLatestThreadMessages failed", threadId, err);
    onError?.(err);
  });
}

export async function listMyThreadsPage(uid, opts = {}) {
  if (!uid) throw new Error("uid mancante");

  const pageSize = clampInt(opts.pageSize ?? opts.max, 1, 100, 50);
  const cursorDoc = toCursorDoc(opts.cursorDoc);
  const clauses = [
    where("participants", "array-contains", uid),
    orderBy("lastMessageAt", "desc"),
  ];
  if (cursorDoc) clauses.push(startAfter(cursorDoc));
  clauses.push(limit(pageSize));

  const q = query(collection(db, "threads"), ...clauses);
  const snap = await getDocs(q);
  return mapThreadPageSnapshot(snap, pageSize);
}

export async function listMyThreads(uid, opts = {}) {
  const page = await listMyThreadsPage(uid, opts);
  return page.items;
}

/** Inbox privata live. Usata dalla vista Assistenza dell'account operatore. */
export function listenMyThreads(uid, { max = 100, onChange, onError } = {}) {
  if (!uid) throw new Error("uid mancante");

  const q = query(
    collection(db, "threads"),
    where("participants", "array-contains", uid),
    orderBy("lastMessageAt", "desc"),
    limit(clampInt(max, 1, 100, 100)),
  );

  return onSnapshot(q, (snap) => {
    onChange?.(snap.docs.map((threadDoc) => ({ id: threadDoc.id, ...threadDoc.data() })));
  }, (err) => {
    console.error("[threads.api] listenMyThreads failed", uid, err);
    onError?.(err);
  });
}

export async function listPublicThreadsPage(opts = {}) {
  const pageSize = clampInt(opts.pageSize ?? opts.max ?? opts.limitCount, 1, 100, 50);
  const cursorDoc = toCursorDoc(opts.cursorDoc);
  const clauses = [
    where("visibility", "==", "public"),
    orderBy("lastMessageAt", "desc"),
  ];
  if (cursorDoc) clauses.push(startAfter(cursorDoc));
  clauses.push(limit(pageSize));

  const q = query(collection(db, "threads"), ...clauses);
  const snap = await getDocs(q);
  return mapThreadPageSnapshot(snap, pageSize);
}

export async function listPublicThreads(optsOrLimit = 50) {
  const opts = typeof optsOrLimit === "number" ? { pageSize: optsOrLimit } : (optsOrLimit || {});
  const page = await listPublicThreadsPage(opts);
  return page.items;
}

/**
 * Thread pubblici sui titoli passati, SENZA ordinamento per recency, per
 * "Discussioni per te". Fa emergere le discussioni sui titoli che l'utente
 * guarda anche con `lastMessageAt` vecchio — es. i thread creati dall'import
 * dei commenti-episodio TV Time (nascono con la data originale del commento e
 * la query per recency non li fetcha mai). Query `titleId in` (chunk da 30) +
 * `visibility == public` (indice composito threads visibility+titleId; il
 * filtro visibility è anche richiesto dalle rules di lettura).
 */
export async function listPublicThreadsByTitleIds(titleIds = [], { inputCap = 60 } = {}) {
  const ids = [...new Set((titleIds || []).filter(Boolean))].slice(0, inputCap);
  if (!ids.length) return [];
  const chunks = [];
  for (let i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30));
  const perChunk = await Promise.all(chunks.map(async (chunk) => {
    const q = query(
      collection(db, "threads"),
      where("visibility", "==", "public"),
      where("titleId", "in", chunk),
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }));
  return perChunk.flat();
}

// ===== COMPAT ALIASES (usati da thread.page.js) =====

/**
 * Ascolta messaggi in tempo reale per un thread.
 * Compatibile con la firma { max, onChange } usata da thread.page.js
 */
export function listenThreadMessages(threadId, { max = 500, onChange } = {}) {
  if (!threadId) throw new Error("threadId mancante");

  const threadRef = doc(db, "threads", threadId);
  const messagesRef = collection(threadRef, "messages");
  const q = query(messagesRef, orderBy("createdAt", "asc"), limit(max));

  return onSnapshot(q, (snap) => {
    const messages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (onChange) onChange(messages);
  }, (err) => {
    console.error("[threads.api] listenThreadMessages snapshot error", threadId, err);
  });
}

/**
 * Invia un messaggio in un thread.
 * Compatibile con la firma { threadId, senderUid, type, text } usata da thread.page.js
 */
export async function sendThreadMessage({ threadId, senderUid, displayName, type = "text", text, gifUrl = null, titleRef: titleRefData = null, containsSpoiler = false, spoilerTitleIds = [] }) {
  if (!threadId) throw new Error("threadId mancante");
  if (!senderUid) throw new Error("senderUid mancante");

  // Messaggio GIF: `type:"gif"` + `gifUrl` (host giphy.com, validato dalle
  // rules). Il testo funge da didascalia opzionale e PUÒ essere vuoto — quindi
  // il vincolo "testo non vuoto" vale solo per i messaggi di testo.
  const cleanGifUrl = typeof gifUrl === "string" ? gifUrl.trim() : "";
  const isGif = type === "gif" && cleanGifUrl.length > 0;
  const caption = (text || "").trim();
  if (!isGif && !caption) throw new Error(i18nT("Messaggio vuoto"));

  const threadRef = doc(db, "threads", threadId);
  const messagesRef = collection(threadRef, "messages");
  const msgRef = doc(messagesRef);
  const normalizedType = isGif ? "gif" : "text";

  const msgData = {
    uid: senderUid,
    displayName: displayName || "Anonimo",
    text: caption,
    type: normalizedType,
    createdAt: serverTimestamp(),
  };

  // Le rules ammettono `gifUrl` SOLO con `type:"gif"` (e lo vietano sul testo):
  // aggiungiamo il campo esclusivamente nel ramo gif.
  if (isGif) {
    msgData.gifUrl = cleanGifUrl;
  }

  // Se c'è un riferimento a un titolo (funzione @)
  if (titleRefData) {
    msgData.titleRef = titleRefData; // { titleId, titleName }
  }

  // Anti-spoiler: aggiungiamo i campi SOLO se flaggato (le rules
  // accettano anche l'assenza). Max 5 titoli, allineato alle rules.
  if (containsSpoiler === true) {
    const cleaned = Array.isArray(spoilerTitleIds)
      ? spoilerTitleIds.map((v) => String(v || "").trim()).filter(Boolean).slice(0, 5)
      : [];
    msgData.containsSpoiler = true;
    msgData.spoilerTitleIds = cleaned;
  }

  // Preview lista thread: le GIF non hanno testo → "GIF" (o "GIF · didascalia").
  const preview = isGif
    ? (caption ? `GIF · ${caption}` : i18nT("GIF"))
    : caption;

  const batch = writeBatch(db);
  batch.set(msgRef, msgData);
  batch.update(threadRef, {
      lastMessageId: msgRef.id,
      lastMessageAt: serverTimestamp(),
      lastMessagePreview: preview.slice(0, 100),
      lastSenderUid: senderUid,
  });
  await batch.commit();

  void logEvent("thread_message_sent", {
    thread_type: normalizedType,
    has_title_ref: Boolean(titleRefData),
    message_len: caption.length,
  });

  return { id: msgRef.id, ...msgData };
}

/**
 * Cerca GIF tramite la callable `gifSearch` (proxy Giphy server-side su
 * europe-west1: tiene la API key lato server, forza SFW, normalizza gli URL
 * su host giphy.com). Query vuota → "trending".
 *
 * Ritorna `{ results: [{id, gifUrl, previewUrl, width, height, title}], next }`.
 * NON ingoia gli errori: se la ricerca fallisce (es. `GIPHY_API_KEY` non
 * configurata → `failed-precondition`, oppure Giphy down → `unavailable`)
 * rilancia, così il picker può mostrare lo stato "GIF non disponibili".
 *
 * @param {string} [query]  testo di ricerca (vuoto = trending)
 * @param {number} [offset] paginazione (dallo `next` della pagina precedente)
 */
export async function searchGifs(query = "", offset = 0) {
  const q = String(query || "").trim();
  const off = Number.isFinite(Number(offset)) ? Math.max(0, Math.trunc(Number(offset))) : 0;
  const res = await gifSearchCallable({
    action: q ? "search" : "trending",
    query: q,
    limit: 24,
    offset: off,
  });
  const data = res?.data || {};
  return {
    results: Array.isArray(data.results) ? data.results : [],
    next: Number.isFinite(Number(data.next)) ? Number(data.next) : off + 24,
  };
}

/**
 * Ottieni il titleId associato a un thread.
 */
export async function getTitleIdFromThread(threadId) {
  if (!threadId) return null;
  const thread = await getThread(threadId);
  return thread?.titleId || null;
}

// ===== GROUP MANAGEMENT =====

/**
 * Aggiunge un partecipante a un thread di gruppo esistente.
 */
export async function addParticipantToGroup(threadId, newUid) {
  if (!threadId) throw new Error("threadId mancante");
  if (!newUid) throw new Error("uid mancante");

  const threadRef = doc(db, "threads", threadId);
  const snap = await getDoc(threadRef);

  if (!snap.exists()) throw new Error(i18nT("Thread non trovato."));

  const data = snap.data();
  if (data.contextType !== "group") throw new Error(i18nT("Non è un thread di gruppo"));
  if ((data.participants || []).includes(newUid)) throw new Error(i18nT("Utente già nel gruppo"));

  await updateDoc(threadRef, {
    participants: arrayUnion(newUid),
  });

  return { added: true };
}

/**
 * Ottieni i dati completi del thread (utile per header gruppo).
 */
export async function getThreadDetails(threadId) {
  return getThread(threadId);
}

// ===== REACTIONS =====

/**
 * Aggiunge o rimuove la reazione di un utente su un messaggio.
 * Se l'uid è già nell'array dell'emoji, lo rimuove; altrimenti lo aggiunge.
 */
export async function toggleReaction(threadId, messageId, emoji, uid) {
  if (!threadId || !messageId || !emoji || !uid) throw new Error(i18nT("Parametri mancanti per toggleReaction"));

  const msgRef = doc(db, "threads", threadId, "messages", messageId);
  const snap = await getDoc(msgRef);
  if (!snap.exists()) throw new Error(i18nT("Messaggio non trovato"));

  const data = snap.data();
  const reactions = data.reactions || {};
  const arr = reactions[emoji] || [];

  if (arr.includes(uid)) {
    await updateDoc(msgRef, { [`reactions.${emoji}`]: arrayRemove(uid) });
  } else {
    await updateDoc(msgRef, { [`reactions.${emoji}`]: arrayUnion(uid) });
  }
}

// ===== TYPING INDICATOR =====

/**
 * Segnala che l'utente sta scrivendo.
 * Scrive in /threads/{threadId}/typing/{uid} con un timestamp.
 */
export async function setTyping(threadId, uid, displayName) {
  if (!threadId || !uid) return;
  const ref = doc(db, "threads", threadId, "typing", uid);
  await setDoc(ref, {
    displayName: displayName || "Qualcuno",
    timestamp: serverTimestamp(),
  });
}

/**
 * Rimuove l'indicatore di scrittura.
 */
export async function clearTyping(threadId, uid) {
  if (!threadId || !uid) return;
  const ref = doc(db, "threads", threadId, "typing", uid);
  await deleteDoc(ref).catch(() => {});
}

/**
 * Ascolta chi sta scrivendo nel thread (escluso l'utente corrente).
 */
export function listenTyping(threadId, myUid, callback) {
  if (!threadId) return () => {};
  const typingRef = collection(db, "threads", threadId, "typing");
  return onSnapshot(typingRef, (snap) => {
    const now = Date.now();
    const typers = [];
    snap.docs.forEach((d) => {
      if (d.id === myUid) return;
      const data = d.data();
      const ts = data.timestamp?.toDate?.();
      // Ignora typing più vecchi di 8 secondi
      if (ts && (now - ts.getTime()) < 8000) {
        typers.push({ uid: d.id, displayName: data.displayName || "Qualcuno" });
      }
    });
    callback(typers);
  });
}

// ===== READ TRACKING (localStorage) =====

const READS_KEY = "2w_threadReads";
const MAX_ENTRIES = 200;
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

function getReadMap() {
  try {
    return JSON.parse(localStorage.getItem(READS_KEY) || "{}");
  } catch { return {}; }
}

function pruneReadMap(map) {
  const now = Date.now();
  const entries = Object.entries(map);
  if (entries.length <= MAX_ENTRIES) return map;
  const pruned = {};
  entries
    .filter(([, ts]) => (now - ts) < MAX_AGE_MS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_ENTRIES)
    .forEach(([k, v]) => { pruned[k] = v; });
  return pruned;
}

export function getLastReadAt(threadId) {
  const map = getReadMap();
  return map[threadId] || 0;
}

export function markThreadRead(threadId) {
  let map = getReadMap();
  map[threadId] = Date.now();
  map = pruneReadMap(map);
  try {
    localStorage.setItem(READS_KEY, JSON.stringify(map));
  } catch { /* localStorage full */ }
}

// ===== PERSISTENT GROUPS =====

/**
 * Restituisce tutti i thread di gruppo (contextType == "group")
 * a cui l'utente partecipa. Utile per il selettore gruppi nel review modal.
 */
export async function listMyGroups(uid) {
  if (!uid) return [];
  const q = query(
    collection(db, "threads"),
    where("participants", "array-contains", uid),
    where("contextType", "==", "group")
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
