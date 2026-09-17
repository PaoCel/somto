// recommendations.api.js - API suggerimenti con thread e notifiche

import {
  collection,
  doc,
  updateDoc,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  getDocs,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import { db } from "../firebase.js";
import { t as i18nT } from "../i18n/index.js";
import { ensureDMThread, sendThreadMessage } from "./threads.api.js";
import { notifyRecommendation } from "./notifications.api.js";
import { getUserPublic } from "./users.api.js";
import { logSignal } from "./signals.api.js";
import { logEvent } from "../analytics.js";
import { rateLimitedCreate, RateLimitExceededError } from "./_rateLimitedCreate.js";

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function toCursorDoc(value) {
  return value && typeof value.data === "function" ? value : null;
}

function mapPageSnapshot(snap, pageSize) {
  const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const nextCursorDoc = snap.docs.length ? snap.docs[snap.docs.length - 1] : null;
  return {
    items,
    nextCursorDoc,
    hasMore: snap.size >= pageSize,
  };
}

/**
 * Crea un suggerimento e auto-crea thread + notifica.
 *
 * La create del doc `recommendations` deve passare per il rate-limit helper:
 * le rules richiedono che `users/{uid}/rateLimits/recommendations` sia
 * incrementato atomicamente, altrimenti la create viene rifiutata (cap 50/24h).
 * Lo `threadId` viene linkato dopo via updateDoc (path consentito dalle rules
 * via `validRecommendationThreadLinkUpdate`).
 *
 * @param {object} params - { fromUid, toUid, titleId, message }
 */
export async function createRecommendation({ fromUid, toUid, titleId, message = "", containsSpoiler = false, spoilerTitleIds = [] }) {
  if (!fromUid) throw new Error("fromUid mancante");
  if (!toUid) throw new Error("toUid mancante");
  if (!titleId) throw new Error("titleId mancante");
  if (fromUid === toUid) throw new Error(i18nT("Non puoi consigliarlo a te stesso"));

  const recRef = doc(collection(db, "recommendations"));

  // La rule `validRecommendationBase` impone `createdAt == request.time`:
  // serve il transform `serverTimestamp()`, che nel check rules VALE
  // request.time. Un `Timestamp.now()` client non lo eguaglia mai (clock
  // skew) → permission denied. Provato in emulatore
  // (functions/test/rules-repro-suggestion.spec.cjs, 2026-07-30).
  const data = {
    fromUid,
    toUid,
    titleId,
    message: String(message || "").trim(),
    createdAt: serverTimestamp(),
    status: "unread", // unread, seen, archived
    threadId: null,
    viewedAt: null, // Quando apre il thread
  };

  if (containsSpoiler === true) {
    data.containsSpoiler = true;
    data.spoilerTitleIds = Array.isArray(spoilerTitleIds)
      ? spoilerTitleIds.map((v) => String(v || "").trim()).filter(Boolean).slice(0, 5)
      : [];
  }

  // 1. Crea suggerimento atomicamente con il counter rate-limit
  try {
    await rateLimitedCreate({ action: "recommendations", targetRef: recRef, payload: data });
  } catch (err) {
    if (err instanceof RateLimitExceededError) {
      throw new Error(i18nT("Hai raggiunto il limite giornaliero di suggerimenti (50/giorno)."));
    }
    throw err;
  }

  try {
    // 2. Crea/trova thread DM per questo titolo
    const thread = await ensureDMThread({
      titleId,
      uidA: fromUid,
      uidB: toUid,
      createdBy: fromUid,
    });

    // 3. Collega thread al suggerimento
    await updateDoc(recRef, { threadId: thread.id });

    // 4. Ottieni info mittente (serve per messaggio e notifica)
    const fromUser = await getUserPublic(fromUid);
    const fromName = fromUser?.displayName || "Qualcuno";

    // 5. (Opzionale) Aggiungi messaggio iniziale se presente
    if (message && message.trim()) {
      await sendThreadMessage({
        threadId: thread.id,
        senderUid: fromUid,
        displayName: fromName,
        type: "text",
        text: message.trim(),
      });
    }

    // Ottieni nome titolo (dovresti passarlo come parametro, ma per ora faccio senza)
    await notifyRecommendation(toUid, fromUid, fromName, { titleId, postId: recRef.id });

    logSignal({
      uid: fromUid,
      titleId,
      actionType: "suggest_to_friend",
      source: "title_page",
    }).catch(() => {});

    void logEvent("recommendation_sent", {
      has_message: Boolean(message && message.trim()),
      has_thread: true,
    });

    return {
      id: recRef.id,
      threadId: thread.id,
    };

  } catch (err) {
    console.error("Errore creazione thread/notifica:", err);
    void logEvent("recommendation_sent", {
      has_message: Boolean(message && message.trim()),
      has_thread: false,
    });
    // Suggerimento creato comunque, thread può essere creato dopo
    return { id: recRef.id };
  }
}


/**
 * Marca suggerimento come "visto" (quando user apre il thread)
 * @param {string} recId - ID suggerimento
 */
export async function markRecommendationAsViewed(recId) {
  if (!recId) throw new Error("recId mancante");

  const ref = doc(db, "recommendations", recId);
  await updateDoc(ref, {
    status: "seen",
    viewedAt: serverTimestamp(),
  });

  return { viewed: true };
}


export async function listRecommendationsForMePage(uid, opts = {}) {
  if (!uid) throw new Error("uid mancante");

  const includeViewed = opts.includeViewed === true;
  const pageSize = clampInt(opts.pageSize ?? opts.max, 1, 100, 50);
  const cursorDoc = toCursorDoc(opts.cursorDoc);

  const clauses = [where("toUid", "==", uid)];
  if (!includeViewed) clauses.push(where("status", "==", "unread"));
  clauses.push(orderBy("createdAt", "desc"));
  if (cursorDoc) clauses.push(startAfter(cursorDoc));
  clauses.push(limit(pageSize));

  const q = query(collection(db, "recommendations"), ...clauses);
  const snap = await getDocs(q);
  return mapPageSnapshot(snap, pageSize);
}

/**
 * Ottieni suggerimenti ricevuti (compat array-only).
 */
export async function listRecommendationsForMe(uid, opts = {}) {
  const page = await listRecommendationsForMePage(uid, opts);
  return page.items;
}

export async function listRecommendationsByMePage(uid, opts = {}) {
  if (!uid) throw new Error("uid mancante");

  const pageSize = clampInt(opts.pageSize ?? opts.max, 1, 100, 50);
  const cursorDoc = toCursorDoc(opts.cursorDoc);

  const clauses = [
    where("fromUid", "==", uid),
    orderBy("createdAt", "desc"),
  ];
  if (cursorDoc) clauses.push(startAfter(cursorDoc));
  clauses.push(limit(pageSize));

  const q = query(collection(db, "recommendations"), ...clauses);
  const snap = await getDocs(q);
  return mapPageSnapshot(snap, pageSize);
}

/**
 * Ottieni suggerimenti inviati (compat array-only).
 */
export async function listRecommendationsByMe(uid, opts = {}) {
  const page = await listRecommendationsByMePage(uid, opts);
  return page.items;
}


/**
 * Archivia un suggerimento
 * @param {string} recId - ID suggerimento
 */
export async function archiveRecommendation(recId) {
  if (!recId) throw new Error("recId mancante");

  const ref = doc(db, "recommendations", recId);
  await updateDoc(ref, {
    status: "archived",
  });

  return { archived: true };
}
