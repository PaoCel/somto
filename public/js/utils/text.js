// public/js/utils/text.js
// Small text helpers (no deps)

/**
 * Remove a leading emoji/icon + optional separators from a label.
 * Example: "🎭 Commedia" -> "Commedia"
 */
export function stripLeadingEmoji(label){
  const s = String(label ?? "").trim();
  if (!s) return "";

  try {
    return s.replace(/^[^\p{L}\p{N}]{1,4}\s*[-–—•|:]*\s*/u, "").trim();
  } catch {
    return s.replace(/^[^A-Za-z0-9]{1,4}\s*[-–—•|:]*\s*/, "").trim();
  }
}

export function normalizeText(str){
  return String(str ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Slugify for stable IDs / tmp keys.
 * Example: "Commedia Drammatica" -> "commedia-drammatica"
 */
export function slugify(s){
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Build search prefixes for a name (for array-contains queries).
 * Includes prefixes for each token (name/surname) and for the compact form.
 */
export function buildPrefixes(nameLower, { maxLen = 12 } = {}){
  const s = String(nameLower ?? "").trim().toLowerCase();
  if (!s) return [];

  const tokens = s.split(/\s+/g).filter(Boolean);
  const out = new Set();

  for (const tok of tokens){
    for (let i = 1; i <= Math.min(maxLen, tok.length); i++){
      out.add(tok.slice(0, i));
    }
  }

  const compact = tokens.join("");
  for (let i = 1; i <= Math.min(maxLen, compact.length); i++){
    out.add(compact.slice(0, i));
  }

  return [...out];
}
