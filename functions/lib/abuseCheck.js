// Filtro deterministico per linguaggio abusivo/odioso nei contenuti UGC
// (posts, commenti, messaggi thread, suggerimenti). Richiesto da App Review
// (Guideline 1.2 — "a method for filtering objectionable content"): affianca
// la coda di review umana, non la sostituisce. Stesso stile del
// `spoilerChecker`: regex pure, nessuna dipendenza, testabile in isolamento.
//
// Filosofia della lista: SOLO alta severità — minacce dirette, incitazioni
// all'autolesionismo, slur e insulti diretti alla persona. La volgarità
// generica ("che film di merda") NON viene flaggata: intasherebbe la coda di
// falsi positivi e il bersaglio della policy sono le persone, non i film.
"use strict";

const ABUSE_PATTERNS = [
  // --- Minacce dirette (IT) ---
  { id: "it_threat_kill", re: /\bti\s+(ammazzo|uccido|sgozzo|massacro|stupro)\b/i },
  { id: "it_threat_find", re: /\bti\s+vengo\s+a\s+(prendere|cercare)\b/i },
  { id: "it_threat_face", re: /\bti\s+spacco\s+la\s+faccia\b/i },
  // --- Incitazione autolesionismo (IT) ---
  { id: "it_selfharm", re: /\b(ammazzati|ucciditi|impiccati|suicidati|sparati)\b/i },
  { id: "it_selfharm_die", re: /\b(vai\s+a\s+morire|fatti\s+ammazzare|dovresti\s+morire)\b/i },
  // --- Slur e odio (IT) ---
  { id: "it_slur_homophobic", re: /\b(froci[oa]|frocetti|ricchion[ei])\b/i },
  { id: "it_slur_racist", re: /\b(sporc[oa]\s+(negr[oa]|ebre[oa])|negr[oi]\s+di\s+merda)\b/i },
  // --- Insulti diretti alla persona (IT) ---
  { id: "it_directed_insult", re: /\bsei\s+un[a']?\s*(troia|puttana|merda|pezzo\s+di\s+merda|cesso|ritardat[oa])\b/i },
  { id: "it_directed_family", re: /\b(tua\s+madre|tua\s+sorella)\s+(è\s+una?\s+)?(troia|puttana)\b/i },
  // --- EN (utenti/contenuti internazionali) ---
  { id: "en_selfharm", re: /\b(kill\s+yourself|kys|go\s+die)\b/i },
  { id: "en_slur", re: /\b(nigger|faggot|retard(ed)?\s+(bitch|whore))\b/i },
  { id: "en_threat", re: /\b(i('|\s+wi)ll\s+kill\s+you|i\s+will\s+find\s+you\s+and)\b/i },
  { id: "en_directed_insult", re: /\byou(\s+are|'re)\s+a\s+(whore|slut|cunt|piece\s+of\s+shit)\b/i },
];

/**
 * Ritorna `{ pattern, match }` sul primo hit, `null` se il testo è pulito.
 * Testo non-stringa/vuoto → null (mai throw: gira dentro trigger onCreate).
 */
function looksLikeAbuse(text) {
  if (typeof text !== "string") return null;
  const value = text.trim();
  if (!value) return null;

  for (const { id, re } of ABUSE_PATTERNS) {
    const match = value.match(re);
    if (match) {
      return { pattern: id, match: String(match[0]).slice(0, 80) };
    }
  }
  return null;
}

module.exports = { looksLikeAbuse, ABUSE_PATTERNS };
