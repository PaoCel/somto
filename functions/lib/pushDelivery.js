"use strict";

/**
 * Esito di una push, in funzioni pure. L'I/O sta in
 * modules/notifications.js (pushOnNotificationCreate).
 *
 * Due decisioni che prima stavano inline e che meritano un test:
 *
 * - Quando un token e' morto davvero. FCM risponde `messaging/invalid-argument`
 *   sia per un token che APNs ha disabilitato ("APNs device token is
 *   disabled": app disinstallata) sia per un messaggio malformato (payload
 *   oltre i 4 KB, un valore non valido). Nel secondo caso il token e' sano:
 *   cancellarlo toglie le push a una persona raggiungibile finche' non riapre
 *   l'app, cioe' proprio il sintomo "arrivano a singhiozzo". Quindi
 *   `invalid-argument` conta come token morto solo se il messaggio parla del
 *   token. Misura del 2026-09-10: nei 30 giorni precedenti tutti gli
 *   `invalid-argument` erano token disabilitati, quindi la regola non ha
 *   ancora fatto danni, ma bastava una notifica troppo lunga.
 * - Cosa scrivere sul doc notifica (`pushDelivery`): cosi' "gli e' arrivata?"
 *   si risponde leggendo un campo, e la guardia giornaliera
 *   (lib/notificationHealth.js) conta gli esiti senza leggere i log.
 */

const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

const PUSH_STATUS = Object.freeze({
  DELIVERED: "delivered",
  FAILED: "failed",
  NO_TOKEN: "no_token",
  COOLDOWN: "cooldown",
  PREFS_OFF: "prefs_off",
});

const MAX_ERROR_CODES = 5;

// Sulle uscite il cooldown della push vale per titolo, non per tipo
// (decisione del 2026-09-10): alle 9 partono insieme gli episodi del giorno e
// i post ufficiali, e con una finestra per tipo il secondo titolo della
// mattina restava solo in campanella — 51 push su 378 verso chi aveva un
// token. Il volume resta limitato dai tetti giornalieri dei fanout (3 al
// giorno per gli aggiornamenti titolo).
const TITLE_SCOPED_COOLDOWN_TYPES = new Set(["title_update", "official_update", "new_season_available"]);

function nonNegativeInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function isDeadTokenError(code, message) {
  const normalized = String(code || "");
  if (DEAD_TOKEN_CODES.has(normalized)) return true;
  if (normalized !== "messaging/invalid-argument") return false;
  return /token/i.test(String(message || ""));
}

/**
 * @param {Array<{success: boolean, error?: {code?: string, message?: string}}>} responses
 *   risposte di `sendEach`, nello stesso ordine di `tokens`
 * @param {string[]} tokens
 * @returns {{success: number, failure: number, deadTokens: string[], errorCodes: string[]}}
 *   `errorCodes` contiene solo i rifiuti che NON sono token morti: sono quelli
 *   che dicono che qualcosa si e' rotto dalla nostra parte.
 */
function summarizeSendResults(responses = [], tokens = []) {
  let success = 0;
  const deadTokens = [];
  const errorCodes = [];
  responses.forEach((response, index) => {
    if (response && response.success) {
      success += 1;
      return;
    }
    const code = String(response?.error?.code || "unknown");
    if (isDeadTokenError(code, response?.error?.message)) {
      if (tokens[index]) deadTokens.push(tokens[index]);
      return;
    }
    if (!errorCodes.includes(code) && errorCodes.length < MAX_ERROR_CODES) errorCodes.push(code);
  });
  return { success, failure: responses.length - success, deadTokens, errorCodes };
}

/**
 * Chiave del cooldown dentro il tipo: il titolo per le uscite, `null` (una
 * finestra sola per tipo) per tutto il resto e per un'uscita senza titolo.
 */
function pushCooldownScope(type, data) {
  if (!TITLE_SCOPED_COOLDOWN_TYPES.has(String(type || ""))) return null;
  const titleId = String((data && data.titleId) || "").trim();
  return titleId || null;
}

/**
 * Il campo `pushDelivery` del doc notifica. Il timestamp lo aggiunge chi
 * scrive (serverTimestamp), cosi' questa resta una funzione pura.
 */
function buildPushDelivery({
  status,
  tokens = 0,
  success = 0,
  failure = 0,
  deadTokens = 0,
  errorCodes = [],
} = {}) {
  return {
    status: String(status || ""),
    tokens: nonNegativeInt(tokens),
    success: nonNegativeInt(success),
    failure: nonNegativeInt(failure),
    deadTokens: nonNegativeInt(deadTokens),
    errorCodes: (Array.isArray(errorCodes) ? errorCodes : []).map(String).slice(0, MAX_ERROR_CODES),
  };
}

module.exports = {
  PUSH_STATUS,
  buildPushDelivery,
  isDeadTokenError,
  pushCooldownScope,
  summarizeSendResults,
};
