"use strict";

// Auto-checker deterministico per spoiler nei contenuti social.
// Restituisce `null` se il testo NON sembra uno spoiler, altrimenti
// un oggetto `{ pattern, match }` con l'indizio che ha causato l'hit.
//
// Le regex sono volutamente conservative: l'output va in
// `moderationQueue` per review umana, non blocca la pubblicazione.

// Le regex girano SEMPRE tutte, in tutte le lingue: la lingua del contenuto
// non e' un dato che abbiamo, e un utente con account italiano puo' scrivere
// in inglese (e viceversa). Non filtrare per lingua dichiarata dall'autore.
const SPOILER_PATTERNS = [
  // Italiano
  /\b(muore|morto|morta|uccide|uccisione|massacrato|massacrata|ammazzato|ammazzata)\b/i,
  /\b(finale|ultima puntata|ultimo episodio|episode finale|season finale)\b/i,
  /\b(si scopre che|si rivela che|scopriamo che|in realt[aà]\b)/i,
  /\b(spoiler|spoilerare)\b/i,
  /\b(plot twist|colpo di scena|finale a sorpresa|sorpresa finale)\b/i,
  /\b(traditore|tradisce|tradimento finale)\b/i,
  // Inglese — stessa griglia semantica. Senza queste, un post tipo
  // "he dies at the end, huge plot twist" matchava solo i prestiti gia'
  // presenti sopra e la moderazione anti-spoiler si spegneva in silenzio sul
  // contenuto inglese: nessun errore, nessun log, solo spoiler non protetti.
  // NB: niente `\bdead\b` da solo — "The Walking Dead" lo farebbe scattare su
  // ogni menzione del titolo.
  /\b(dies|died|is killed|gets killed|kills off|murdered|death of)\b/i,
  /\b(final episode|last episode|series finale|ending scene)\b/i,
  /\b(it turns out|turns out that|we find out|is revealed|the reveal)\b/i,
  /\b(spoilers|spoiled)\b/i,
  /\b(twist ending|shocking twist)\b/i,
  /\b(betrays|betrayal|traitor)\b/i,
];

// Anchor specifici per titolo (chiave = nome titolo lowercase, valori = parole-chiave lowercase).
// Espandibile da admin in futuro spostandolo su Firestore.
const SPOILER_KEYWORDS_BY_TITLE = {
  "il trono di spade": ["red wedding", "jon snow muore", "jon snow dies", "negan", "ned stark"],
  "game of thrones": ["red wedding", "jon snow muore", "jon snow dies", "ned stark"],
  "breaking bad": ["walter muore", "walter dies", "hank muore", "hank dies"],
  "lost": ["sono morti", "they are dead", "isola purgatorio", "purgatory island"],
  "the walking dead": ["negan", "glenn"],
  "stranger things": ["vecna", "eddie muore", "eddie dies"],
};

function looksLikeSpoiler(text, titleNames = []) {
  if (text == null) return null;
  const t = String(text);
  if (t.length < 20) return null;

  for (const pat of SPOILER_PATTERNS) {
    const m = t.match(pat);
    if (m) return { pattern: pat.source, match: m[0] };
  }

  const lower = t.toLowerCase();
  const names = Array.isArray(titleNames) ? titleNames : [];
  for (const rawName of names) {
    const name = String(rawName || "").toLowerCase().trim();
    if (!name) continue;
    const kws = SPOILER_KEYWORDS_BY_TITLE[name];
    if (!kws) continue;
    for (const kw of kws) {
      if (lower.includes(kw)) return { pattern: "title-keyword", match: kw };
    }
  }

  return null;
}

module.exports = { looksLikeSpoiler };
