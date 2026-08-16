// account.api.js — operazioni sensibili sull'account.
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";
import { app } from "../firebase.js";

const functions = getFunctions(app, "europe-west1");
const deleteMyAccountCallable = httpsCallable(functions, "deleteMyAccount");
const exportMyDataCallable = httpsCallable(functions, "exportMyData");

/**
 * Elimina definitivamente l'account corrente e i dati associati (GDPR art. 17).
 * Richiede conferma esplicita lato server (`confirm: true`).
 * @returns {Promise<object>} riepilogo di cosa è stato cancellato
 */
export async function deleteMyAccount() {
  const res = await deleteMyAccountCallable({ confirm: true });
  return res?.data || {};
}

/**
 * Genera un export JSON dei dati personali dell'utente corrente (GDPR art. 20:
 * watchlist, voti, liste, profilo, attività). Richiede re-auth recente lato
 * server, come `deleteMyAccount` (errore `failed-precondition` con
 * `auth/requires-recent-login` nel messaggio se la sessione è troppo vecchia).
 * @returns {Promise<{ok:boolean, url:string, exportedAt:string}>}
 */
export async function exportMyData() {
  const res = await exportMyDataCallable();
  return res?.data || {};
}
