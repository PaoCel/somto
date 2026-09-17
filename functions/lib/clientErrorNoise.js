/**
 * clientErrorNoise.js — filtro rumore per il client-error reporting.
 *
 * `window.onerror` / `unhandledrejection` catturano anche cose che non sono
 * nostre: script iniettati dalle estensioni del browser e promise rifiutate
 * dal motore (view transition annullata, ResizeObserver). Senza filtro ogni
 * caso di questi produce una push admin (`notifyAdminOnClientError`) per un
 * problema che non esiste nel nostro codice.
 *
 * Stessa lista, in ESM, in `public/js/api/errors.api.js`: li' blocca la
 * scrittura, qui blocca l'alert anche per i client vecchi ancora in cache.
 * Se aggiungi un pattern, aggiungilo in entrambi.
 */

// Sostringhe (lowercase) su message: errori generati da estensioni o dal
// browser stesso, mai dal codice Somto.
const NOISE_MESSAGE_PATTERNS = [
  "runtime.sendmessage",
  "extension context invalidated",
  "receiving end does not exist",
  "the message port closed before a response was received",
  "skipping view transition",
  "resizeobserver loop",
];

// Sostringhe (lowercase) su source/stack: qualunque frame di estensione.
const EXTENSION_SOURCE_PATTERNS = [
  "chrome-extension://",
  "moz-extension://",
  "safari-extension://",
  "safari-web-extension://",
  "webkit-masked-url://",
  "extensions::",
];

function lower(value) {
  return String(value || "").toLowerCase();
}

/**
 * @param {{message?: string, source?: string, stack?: string}} error
 * @returns {boolean} true se l'errore e' rumore di terze parti/browser.
 */
function isIgnorableClientError(error = {}) {
  const message = lower(error.message);
  const source = lower(error.source);
  const stack = lower(error.stack);

  if (NOISE_MESSAGE_PATTERNS.some((pattern) => message.includes(pattern))) return true;
  if (EXTENSION_SOURCE_PATTERNS.some((pattern) => source.includes(pattern) || stack.includes(pattern))) {
    return true;
  }

  // "Script error." cross-origin: nessun source, nessuno stack, zero
  // informazione utile. Segnalarlo e' solo una notifica in piu'.
  if (message === "script error." && !source && !stack) return true;

  return false;
}

module.exports = {
  isIgnorableClientError,
  NOISE_MESSAGE_PATTERNS,
  EXTENSION_SOURCE_PATTERNS,
};
