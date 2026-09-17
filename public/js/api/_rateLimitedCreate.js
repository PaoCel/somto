// _rateLimitedCreate.js — Helper transazione client-side per le create
// soggette a rate-limit lato rules (recommendations, reports).
//
// Le rules (firestore.rules) attribuiscono a `users/{uid}/rateLimits/{action}`
// uno schema rigido `{count, resetAt}` e richiedono che la create del doc
// bersaglio avvenga atomicamente con l'aggiornamento del counter. Senza un
// counter incrementato in transazione la rule `rateLimitOk(uid, action, cap)`
// rifiuta la create.
//
// Window: 24h sliding. Cap per azione:
//   - "recommendations": 50/giorno
//   - "reports":         20/giorno

import {
  doc,
  runTransaction,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import { db, auth } from "../firebase.js";

const WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

const CAPS = Object.freeze({
  recommendations: 50,
  reports: 20,
});

/**
 * Errore lanciato quando l'utente ha raggiunto il cap nella finestra corrente.
 * Il chiamante può intercettarlo per mostrare un messaggio dedicato.
 */
export class RateLimitExceededError extends Error {
  constructor(action, cap) {
    super(`rate_limit_exceeded: ${action} (cap ${cap}/24h)`);
    this.name = "RateLimitExceededError";
    this.action = action;
    this.cap = cap;
  }
}

/**
 * Esegue in transazione:
 *   1) read di `users/{uid}/rateLimits/{action}`
 *   2) decisione count: nuova finestra (reset a 1) o stessa finestra (count+1)
 *   3) write counter (create/update con solo {count, resetAt} — le rules
 *      enforce hasOnly su quelle key, NON includere updatedAt)
 *   4) set del doc bersaglio (`targetRef`) con `payload`
 *
 * NB: lo schema del counter è IDENTICO a quello richiesto dalle rules. Non
 * aggiungere altri campi (es. updatedAt) o la create/update fallirà.
 *
 * @param {object} params
 * @param {"recommendations"|"reports"} params.action - chiave rate-limit
 * @param {import("firebase/firestore").DocumentReference} params.targetRef
 *   ref del doc bersaglio (es. `doc(collection(db, "recommendations"))`)
 * @param {object} params.payload - payload da scrivere su targetRef
 * @returns {Promise<string>} id del documento bersaglio creato
 * @throws {RateLimitExceededError} se il cap è già stato raggiunto
 */
export async function rateLimitedCreate({ action, targetRef, payload }) {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error("auth required");

  const cap = CAPS[action];
  if (typeof cap !== "number") {
    throw new Error(`unknown rate-limit action: ${action}`);
  }

  const counterRef = doc(db, "users", uid, "rateLimits", action);

  await runTransaction(db, async (tx) => {
    const counterSnap = await tx.get(counterRef);
    const now = Date.now();

    let count;
    let resetMs;

    if (!counterSnap.exists()) {
      // Prima azione assoluta: crea il counter con count=1, finestra nuova.
      count = 1;
      resetMs = now + WINDOW_MS;
    } else {
      const data = counterSnap.data() || {};
      const prevReset = typeof data.resetAt?.toMillis === "function"
        ? data.resetAt.toMillis()
        : 0;
      if (prevReset <= now) {
        // Finestra scaduta: nuovo conteggio, nuova finestra.
        count = 1;
        resetMs = now + WINDOW_MS;
      } else {
        // Finestra ancora attiva: incrementa rispetto al count corrente.
        const prevCount = Number(data.count) || 0;
        if (prevCount >= cap) {
          throw new RateLimitExceededError(action, cap);
        }
        count = prevCount + 1;
        resetMs = prevReset;
      }
    }

    // IMPORTANTE: nessun campo extra (rules hasOnly(["count", "resetAt"])).
    tx.set(counterRef, {
      count,
      resetAt: Timestamp.fromMillis(resetMs),
    });
    tx.set(targetRef, payload);
  });

  return targetRef.id;
}
