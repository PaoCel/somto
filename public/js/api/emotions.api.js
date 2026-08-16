import {
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  collection,
  query,
  where,
  getDocs,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import { db } from "../firebase.js";
import { t as i18nT } from "../i18n/index.js";

// Emozioni post-visione ("Che impressione hai avuto?").
// Chiavi canoniche stabili (mai emoji nel DB) — devono restare identiche
// alla whitelist server in firestore.rules e functions/lib/emotionAggregate.js.
export const EMOTION_KEYS = Object.freeze([
  "shocked",
  "frustrated",
  "sad",
  "reflective",
  "touched",
  "amused",
  "scared",
  "bored",
  "understood",
  "thrilled",
  "confused",
  "tense",
]);

// Label IT + emoji, ordine di visualizzazione nella griglia.
export const EMOTION_META = Object.freeze({
  shocked: { label: i18nT("Scioccato"), emoji: "🤯" },
  frustrated: { label: i18nT("Frustrato"), emoji: "😤" },
  sad: { label: i18nT("Triste"), emoji: "😢" },
  reflective: { label: i18nT("Riflessivo"), emoji: "🤔" },
  touched: { label: i18nT("Commosso"), emoji: "🥹" },
  amused: { label: i18nT("Divertito"), emoji: "😂" },
  scared: { label: i18nT("Spaventato"), emoji: "😱" },
  bored: { label: i18nT("Annoiato"), emoji: "🥱" },
  understood: { label: i18nT("Mi ci rivedo"), emoji: "🫶" },
  thrilled: { label: i18nT("Elettrizzato"), emoji: "🤩" },
  confused: { label: i18nT("Confuso"), emoji: "😵‍💫" },
  tense: { label: i18nT("Teso"), emoji: "😬" },
});

const EMOTION_KEY_SET = new Set(EMOTION_KEYS);

function safePart(v) {
  return String(v ?? "0").replace(/[^a-zA-Z0-9_-]/g, "_");
}

// Stessa sanitizzazione/formato di makeRatingId (ratings.api.js): level fisso
// "title", season/episode fissi a 0 (v1 solo title-level).
export function makeEmotionId({ uid, titleId }) {
  return [safePart(uid), safePart(titleId), "title", safePart(0), safePart(0)].join("__");
}

export function sanitizeEmotions(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const key = typeof item === "string" ? item.trim() : "";
    if (!EMOTION_KEY_SET.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export async function getMyTitleEmotions({ uid, titleId }) {
  if (!uid || !titleId) return null;
  const ref = doc(db, "titleEmotions", makeEmotionId({ uid, titleId }));
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

// Upsert 1..3 emozioni uniche (whitelist). Array vuoto/nullo -> deleteDoc
// (deselezione totale, coerente col contratto backend).
export async function upsertTitleEmotions({ uid, titleId, emotions, source }) {
  if (!uid) throw new Error("uid mancante");
  if (!titleId) throw new Error("titleId mancante");

  const clean = sanitizeEmotions(emotions).slice(0, 3);
  const ref = doc(db, "titleEmotions", makeEmotionId({ uid, titleId }));

  if (!clean.length) {
    // Delete su doc inesistente = permission denied dalle rules (resource
    // null): capita se l'utente seleziona e deseleziona prima del primo save.
    const snap = await getDoc(ref);
    if (snap.exists()) await deleteDoc(ref);
    return { id: ref.id, emotions: [] };
  }

  const data = {
    uid,
    titleId,
    level: "title",
    season: null,
    episode: null,
    emotions: clean,
    updatedAt: serverTimestamp(),
  };
  if (source) data.source = String(source).slice(0, 40);

  // Stesso pattern di upsertRating (ratings.api.js): merge:true + createdAt
  // sempre presente nel payload. Con merge:true Firestore non sovrascrive un
  // createdAt gia' esistente sul documento con un nuovo valore diverso solo
  // se il campo e' omesso dalla write; qui lo includiamo sempre per il primo
  // create, e le rules richiedono comunque `updatedAt == request.time` a ogni
  // upsert, quindi la data "vera" di riferimento resta updatedAt.
  await setDoc(ref, { ...data, createdAt: serverTimestamp() }, { merge: true });
  return { id: ref.id, emotions: clean };
}

/**
 * Tutte le emozioni scelte dall'utente (title-level, v1). Usata dal tab
 * Community del profilo. NB: solo equality `uid == uid` (indice automatico
 * single-field), niente `orderBy` per evitare indici compositi extra — il
 * chiamante ordina lato client per `updatedAt`.
 */
export async function listMyEmotions(uid, { max = 200 } = {}) {
  if (!uid) return [];
  const q = query(collection(db, "titleEmotions"), where("uid", "==", uid));
  const snap = await getDocs(q);
  const out = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return out.slice(0, max);
}
