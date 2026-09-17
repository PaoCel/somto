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

/**
 * Eventi titolo pubblicati, per la scheda titolo. Doppia query, merge per id:
 * - legacy `titleId == pageTitleId` (tutti i doc, anche quelli senza il
 *   campo nuovo, prima del backfill)
 * - nuova `linkedTitleIds array-contains pageTitleId` (doc di saga/collegati
 *   che citano questo titolo pur avendo `titleId` diverso — es. un trailer
 *   di stagione pubblicato sul film "sorgente" della saga)
 * Un doc puo' comparire in entrambe le query (titleId proprio + presente
 * anche in linkedTitleIds, dove e' sempre il primo elemento): si tiene una
 * sola copia. La query nuova puo' fallire finche' l'indice non e' pronto o
 * su doc pre-backfill senza il campo — non deve rompere la lista legacy.
 */
export async function listTitleUpdateEvents(titleId, { locale = "it", max = 20 } = {}) {
  const safeMax = Math.max(1, Math.min(50, Number(max) || 20));

  const [legacySnap, linkedSnap] = await Promise.all([
    getDocs(query(
      collection(db, "titleUpdateEvents"),
      where("titleId", "==", titleId),
      where("status", "==", "published"),
      orderBy("sortAt", "desc"),
      limit(safeMax),
    )),
    getDocs(query(
      collection(db, "titleUpdateEvents"),
      where("linkedTitleIds", "array-contains", titleId),
      where("status", "==", "published"),
      orderBy("sortAt", "desc"),
      limit(safeMax),
    )).catch((err) => {
      console.warn("[titleUpdates] query linkedTitleIds fallita (indice non pronto?)", err?.message || err);
      return { docs: [] };
    }),
  ]);

  const byId = new Map();
  for (const row of [...legacySnap.docs, ...linkedSnap.docs]) {
    if (byId.has(row.id)) continue;
    const data = row.data() || {};
    byId.set(row.id, {
      id: row.id,
      ...data,
      headline: localized(data.headlineByLocale, locale),
      entityName: localized(data.entityNameByLocale, locale),
      sortAtMs: timestampMs(data.sortAt),
      // Evento "in prestito" da un altro titolo della saga: la scheda lo
      // marca con un'etichetta "Da {titolo}" risolta lato chiamante (batch
      // getTitlesByIds, per non fare una getDoc a evento).
      fromOtherTitle: Boolean(data.titleId) && data.titleId !== titleId,
    });
  }

  return Array.from(byId.values())
    .sort((a, b) => b.sortAtMs - a.sortAtMs)
    .slice(0, safeMax);
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
