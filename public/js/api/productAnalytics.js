// productAnalytics.js — beacon funnel prodotto: contatore aggregato anonimo
// (nessun uid memorizzato) via callable `logProductEvent` (whitelist server-side
// in functions/index.js). Fire-and-forget, non deve MAI bloccare o far fallire
// il percorso utente: usare solo per gli step senza già un trigger server.
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";
import { app } from "../firebase.js";

const functions = getFunctions(app, "europe-west1");
const logProductEventCallable = httpsCallable(functions, "logProductEvent");

/**
 * @param {string} event - deve essere nella whitelist server (vedi PRODUCT_EVENT_WHITELIST).
 */
export function trackProductEvent(event) {
  try {
    logProductEventCallable({ event }).catch(() => {});
  } catch (_) {}
}
