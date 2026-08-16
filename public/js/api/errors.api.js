/**
 * errors.api.js — Client-error reporting (osservabilità minima).
 *
 * Scrive un doc di diagnostica in `clientErrors` per ogni errore JS non
 * gestito su pagine autenticate (mai su landing pubbliche: vedi guard
 * `auth.currentUser` sotto + wiring in appShell.js che non gira su pagine
 * `data-no-shell`).
 *
 * IMPORTANTE:
 * - `clientErrors` è admin-read-only (vedi firestore.rules): i client possono
 *   solo creare il proprio doc, mai leggerlo/aggiornarlo/eliminarlo.
 * - Serve abilitare la TTL policy su `clientErrors.expiresAt` dalla console
 *   Firebase (Firestore > TTL) per l'auto-pulizia dopo 14 giorni — il campo
 *   è già scritto qui ma la policy va attivata manualmente una tantum.
 * - Questo modulo non deve MAI lanciare/rilanciare eccezioni: un bug qui
 *   dentro potrebbe altrimenti generare un loop di error-reporting.
 */

import {
  collection,
  addDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import { db, auth } from "../firebase.js";

const MAX_WRITES_PER_SESSION = 8;
const DEDUPE_WINDOW_MS = 60 * 1000;
const TTL_DAYS = 14;

let writeCount = 0;
const recentMessages = new Map(); // message -> timestamp (ms) dell'ultimo invio

function pruneRecentMessages(now) {
  for (const [key, ts] of recentMessages) {
    if (now - ts > DEDUPE_WINDOW_MS) recentMessages.delete(key);
  }
}

function toSafeString(value, maxLen) {
  const str = value === undefined || value === null ? "" : String(value);
  return str.slice(0, maxLen);
}

function toSafeInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * Segnala un errore client non gestito. No-op silenzioso se:
 * - l'utente non è autenticato (landing pubbliche / guest = mai scritture)
 * - è stato raggiunto il cap di scritture per sessione di pagina
 * - lo stesso messaggio è già stato segnalato negli ultimi 60s
 *
 * @param {{message?: string, source?: string, line?: number, col?: number, stack?: string}} info
 */
export function reportClientError(info) {
  try {
    const user = auth?.currentUser;
    if (!user?.uid) return;

    if (writeCount >= MAX_WRITES_PER_SESSION) return;

    const message = toSafeString(info?.message, 500);
    if (!message) return;

    const now = Date.now();
    pruneRecentMessages(now);
    const lastSeen = recentMessages.get(message);
    if (lastSeen && now - lastSeen < DEDUPE_WINDOW_MS) return;
    recentMessages.set(message, now);

    writeCount += 1;

    const expiresAt = new Date(now + TTL_DAYS * 24 * 60 * 60 * 1000);

    const payload = {
      uid: user.uid,
      message,
      source: toSafeString(info?.source, 300),
      line: toSafeInt(info?.line),
      col: toSafeInt(info?.col),
      stack: toSafeString(info?.stack, 2000),
      page: toSafeString(
        `${window.location?.pathname || ""}${window.location?.search || ""}`,
        300
      ),
      ua: toSafeString(navigator?.userAgent, 300),
      createdAt: serverTimestamp(),
      expiresAt,
    };

    // Fire-and-forget: non vogliamo che un fallimento di rete/regole diventi
    // a sua volta un unhandledrejection (ricorsione). .catch consuma l'errore.
    addDoc(collection(db, "clientErrors"), payload).catch(() => {});
  } catch (_err) {
    // Mai propagare: error-reporting non deve mai diventare un'altra fonte di errori.
  }
}
