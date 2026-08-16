// url.js — helper URL condivisi.

// Riduce un valore arbitrario a un path interno SICURO (stesso origin).
// Blocca open redirect: URL assoluti cross-origin, `//evil.com` (protocol
// relative) e schemi tipo `javascript:` tornano "" (→ il chiamante usa il
// fallback). Restituisce solo `pathname + search + hash` quando l'origin
// coincide con quello corrente.
export function sanitizeInternalPath(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value, window.location.origin);
    if (parsed.origin !== window.location.origin) return "";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch (_) {
    return "";
  }
}
