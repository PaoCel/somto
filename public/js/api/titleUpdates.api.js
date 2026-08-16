import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import { db } from "../firebase.js";

function timestampMs(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.seconds === "number") return value.seconds * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function localized(map, locale) {
  if (!map || typeof map !== "object") return "";
  const normalized = String(locale || "it").toLowerCase();
  const preferred = normalized.startsWith("en") ? "en-US" : "it-IT";
  return String(map[preferred] || map["en-US"] || map["it-IT"] || Object.values(map).find(Boolean) || "");
}

export async function listTitleUpdateEvents(titleId, { locale = "it", max = 20 } = {}) {
  const snap = await getDocs(query(
    collection(db, "titleUpdateEvents"),
    where("titleId", "==", titleId),
    where("status", "==", "published"),
    orderBy("sortAt", "desc"),
    limit(Math.max(1, Math.min(50, Number(max) || 20))),
  ));
  return snap.docs.map((row) => {
    const data = row.data() || {};
    return {
      id: row.id,
      ...data,
      headline: localized(data.headlineByLocale, locale),
      entityName: localized(data.entityNameByLocale, locale),
      sortAtMs: timestampMs(data.sortAt),
    };
  });
}

export async function listLinkedOfficialPosts(titleId, { max = 12 } = {}) {
  const snap = await getDocs(query(
    collection(db, "posts"),
    where("linkedTitleIds", "array-contains", titleId),
    where("visibility", "==", "public"),
    limit(Math.max(1, Math.min(30, Number(max) || 12))),
  ));
  return snap.docs
    .map((row) => ({ id: row.id, ...row.data(), sortAtMs: timestampMs(row.data()?.createdAt) }))
    .filter((row) => row.isOfficialUpdate === true && row.visibility === "public")
    .sort((a, b) => b.sortAtMs - a.sortAtMs);
}

const preferenceRef = (uid, titleId) => doc(db, "users", uid, "titleUpdatePrefs", titleId);

export async function getTitleUpdatePreference(uid, titleId) {
  if (!uid || !titleId) return "auto";
  const snap = await getDoc(preferenceRef(uid, titleId));
  const mode = snap.exists() ? String(snap.data()?.mode || "") : "";
  return ["follow", "important", "muted"].includes(mode) ? mode : "auto";
}

/**
 * Tutte le preferenze aggiornamenti dell'utente, come Map titleId → mode.
 *
 * Una sola query invece di una getDoc per card: il feed Community mostra
 * decine di titoli e il bottone "segui" deve nascere gia' nello stato giusto.
 * La collezione e' piccola per definizione (solo i titoli su cui l'utente ha
 * espresso una preferenza) e la rule e' `read: isOwner(userId)`, che copre
 * anche la list.
 */
export async function listMyTitleUpdatePreferences(uid, { max = 300 } = {}) {
  const out = new Map();
  if (!uid) return out;
  const snap = await getDocs(query(
    collection(db, "users", uid, "titleUpdatePrefs"),
    limit(Math.max(1, Math.min(1000, Number(max) || 300))),
  ));
  snap.docs.forEach((row) => {
    const mode = String(row.data()?.mode || "");
    if (["follow", "important", "muted"].includes(mode)) out.set(row.id, mode);
  });
  return out;
}

export async function setTitleUpdatePreference(uid, titleId, mode) {
  if (!uid || !titleId) throw new Error("uid e titleId obbligatori");
  if (mode === "auto") {
    await deleteDoc(preferenceRef(uid, titleId));
    return "auto";
  }
  if (!["follow", "important", "muted"].includes(mode)) throw new Error("preferenza non valida");
  await setDoc(preferenceRef(uid, titleId), {
    titleId,
    mode,
    updatedAt: serverTimestamp(),
  });
  return mode;
}
