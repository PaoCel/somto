"use strict";

// Quante persone puo' notificare un singolo testo.
//
// PERCHE' UN TETTO — ogni menzione produce una notifica, e la scrittura dei
// commenti dal web va DIRETTA su Firestore (`addPostComment`), senza callable
// e quindi senza rate limit. Un solo commento con cinquanta token produce
// cinquanta notifiche in un batch. Dieci e' gia' oltre qualunque uso legittimo
// (il caso reale e' "taggo due amici"), e sopra quella soglia si smette di
// notificare invece di fingere che vada bene.
const MAX_MENTIONS_PER_TEXT = 10;

// Il token canonico inserito dal picker: `@{Nome Visibile}(uid)`. La label e'
// il displayName, l'uid e' cio' che conta. Stessa regex su web e iOS.
const MENTION_TOKEN_REGEX = /@\{[^}]+\}\(([^)]+)\)/g;

/**
 * Gli uid menzionati in un testo, con il tetto applicato.
 *
 * Ritorna anche `total` cosi' il chiamante puo' ACCORGERSI di aver troncato e
 * dirlo nei log: un tetto silenzioso si legge come "ho notificato tutti".
 */
function extractMentionUids(text, { max = MAX_MENTIONS_PER_TEXT } = {}) {
  const raw = String(text || "");
  if (!raw) return { uids: [], total: 0 };

  const seen = new Set();
  const regex = new RegExp(MENTION_TOKEN_REGEX.source, "g");
  let match;
  while ((match = regex.exec(raw)) !== null) {
    const uid = String(match[1] || "").trim();
    if (uid) seen.add(uid);
  }

  const all = [...seen];
  return { uids: all.slice(0, Math.max(0, max)), total: all.length };
}

module.exports = {
  MAX_MENTIONS_PER_TEXT,
  MENTION_TOKEN_REGEX,
  extractMentionUids,
};
