// titleUpdatesAdmin.api.js — Console admin degli eventi titolo
// (`titleUpdateEvents`), usata da /admin-title-updates.html.
//
// LETTURA: diretta da Firestore. Le rules (`match /titleUpdateEvents/{eventId}`)
// aprono get/list agli admin anche sui draft, quindi non serve una callable.
//
// SCRITTURA: solo via callable `reviewTitleUpdateEvent` (europe-west1,
// admin-only lato server). La collezione e' deny-all in scrittura per TUTTI i
// client, admin inclusi: ogni correzione passa dall'Admin SDK.
//
// PERCHE' NESSUNA QUERY QUI HA UN `orderBy`: un `where` di uguaglianza piu' un
// ordinamento su un altro campo richiede un indice composito, e questa console
// non ne ha uno. Con le sole uguaglianze bastano gli indici single-field
// automatici (Firestore li combina con l'index merging), e l'ordine lo mette il
// client su insiemi piccoli — i draft e gli eventi gia' corretti a mano sono
// poche decine, non una timeline.
import {
  collection,
  getDocs,
  limit as fbLimit,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";

import { app, db } from "../firebase.js";

const functions = getFunctions(app, "europe-west1");
const reviewTitleUpdateEventCallable = httpsCallable(functions, "reviewTitleUpdateEvent", { timeout: 60000 });

export const RELEASE_DATE_EVENT_TYPE = "release_date";

/** Millisecondi da un Timestamp Firestore, una Date o una stringa. `null` se non e' una data. */
export function toMillis(value) {
  if (!value) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value.seconds === "number") return value.seconds * 1000;
  if (typeof value._seconds === "number") return value._seconds * 1000;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function mapEvent(docSnap) {
  const data = docSnap.data() || {};
  return {
    id: docSnap.id,
    ...data,
    effectiveAtMs: toMillis(data.effectiveAt),
    updatedAtMs: toMillis(data.updatedAt),
  };
}

/**
 * Esegue una query di sole uguaglianze. Se Firestore chiedesse comunque un
 * indice composito (`failed-precondition`), ripiega su UNA sola uguaglianza —
 * servita di sicuro dall'indice single-field automatico — e applica il resto
 * lato client. Cosi' la console funziona anche senza toccare
 * `firestore.indexes.json`.
 */
async function fetchEvents(equalities, max) {
  const clauses = Object.entries(equalities);
  const ref = collection(db, "titleUpdateEvents");
  try {
    const snap = await getDocs(query(
      ref,
      ...clauses.map(([field, value]) => where(field, "==", value)),
      fbLimit(max)
    ));
    return snap.docs.map(mapEvent);
  } catch (err) {
    if (!String(err?.code || err?.message || "").includes("failed-precondition")) throw err;
    const [[firstField, firstValue], ...rest] = clauses;
    const snap = await getDocs(query(
      ref,
      where(firstField, "==", firstValue),
      fbLimit(Math.max(max, 300))
    ));
    return snap.docs
      .map(mapEvent)
      .filter((row) => rest.every(([field, value]) => row[field] === value))
      .slice(0, max);
  }
}

/** I draft release_date: nessuno oggi li puo' pubblicare, quindi si accumulano. */
export async function listReleaseDateDrafts({ max = 120 } = {}) {
  return fetchEvents({ eventType: RELEASE_DATE_EVENT_TYPE, status: "draft" }, max);
}

/**
 * Gli eventi release_date gia' passati da una mano umana.
 *
 * `acquisitionMode === "manual"` e' l'impronta che lascia `buildEditorialPatch`:
 * e' l'unico insieme che puo' contenere un `editorial.sourceConflict`, perche' il
 * conflitto nasce solo dove esistono campi bloccati. Filtrare per uguaglianza su
 * questo campo evita la query `editorial.sourceConflict != null`, che invece
 * vorrebbe un indice composito.
 */
export async function listEditedReleaseDateEvents({ max = 120 } = {}) {
  return fetchEvents({ eventType: RELEASE_DATE_EVENT_TYPE, acquisitionMode: "manual" }, max);
}

/**
 * Gli eventi release_date di un singolo titolo, draft o pubblicati.
 * Serve per il caso "la data automatica e' sbagliata": quell'evento e' gia'
 * pubblicato e non e' mai stato toccato, quindi non compare nelle altre due
 * liste e ci si arriva solo cercando il titolo.
 */
export async function listReleaseDateEventsForTitle(titleId, { max = 20 } = {}) {
  if (!titleId) return [];
  return fetchEvents({ titleId, eventType: RELEASE_DATE_EVENT_TYPE }, max);
}

/**
 * Correggi e/o pubblica un evento titolo.
 *
 * Omettere un campo significa "non toccarlo": per questo il payload viene
 * costruito per esclusione invece di passare stringhe vuote.
 *
 * Con `dryRun: true` non scrive niente e ritorna la stessa risposta che darebbe
 * la scrittura vera — inclusa `willNotify`, che e' il motivo per cui il dry run
 * esiste: pubblicare l'uscita di un film imminente manda una push a chiunque
 * abbia il titolo in watchlist, e non si annulla.
 *
 * Ritorna `{ ok, dryRun, eventId, lockedFields, willNotify, warnings }`.
 */
export async function reviewTitleUpdateEvent({
  eventId,
  effectiveDate,
  region,
  releaseType,
  publish = false,
  note,
  dryRun = false,
} = {}) {
  const payload = { eventId, publish: Boolean(publish), dryRun: Boolean(dryRun) };
  if (effectiveDate !== undefined) payload.effectiveDate = effectiveDate;
  if (region !== undefined) payload.region = region;
  if (releaseType !== undefined) payload.releaseType = releaseType;
  if (note !== undefined) payload.note = note;
  const res = await reviewTitleUpdateEventCallable(payload);
  return res?.data || null;
}
