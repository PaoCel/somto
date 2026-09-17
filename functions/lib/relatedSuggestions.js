"use strict";

// Logica pura per i suggerimenti community di "titoli collegati"
// (titleRelatedSuggestions/{uid}__{titleId}__{suggestedTitleId}).
//
// Un utente propone che due titoli siano collegati (es. un film e il suo
// sequel, o due stagioni pubblicate come titoli distinti). Quando abbastanza
// PERSONE DISTINTE propongono la stessa coppia — in una direzione o
// nell'altra, e' lo stesso collegamento — il trigger la auto-approva e scrive
// `related: arrayUnion` su entrambi i titoli. Nessun I/O qui dentro: chi
// chiama (trigger/callable) fa la query Firestore e passa i dati gia' letti.

const DEFAULT_AUTO_APPROVE_THRESHOLD = 3;
const MIN_AUTO_APPROVE_THRESHOLD = 2;

// Soglia overridable via env/config, come `officialSourceIngestionEnabled` in
// modules/officialUpdates.js. Un valore sotto 2 renderebbe una singola
// proposta sufficiente ad auto-approvare, vanificando il senso di "community".
function resolveAutoApproveThreshold(env = process.env) {
  const raw = env && env.RELATED_SUGGESTION_AUTO_APPROVE_THRESHOLD;
  const parsed = Math.floor(Number(raw));
  return Number.isFinite(parsed) && parsed >= MIN_AUTO_APPROVE_THRESHOLD
    ? parsed
    : DEFAULT_AUTO_APPROVE_THRESHOLD;
}

// Chiave NON ordinata per la coppia di titoli: proporre A→B o B→A e' lo
// stesso collegamento, e deve contare per la stessa soglia.
function unorderedPairKey(titleIdA, titleIdB) {
  const a = String(titleIdA || "").trim();
  const b = String(titleIdB || "").trim();
  return [a, b].sort().join("__");
}

// Conta i proponenti DISTINTI (per uid) tra i suggerimenti forniti. Il
// chiamante e' responsabile di aver gia' filtrato per la stessa coppia non
// ordinata e per status in [pending, approved] (rejected non conta).
function countDistinctProposers(suggestionDocs) {
  const uids = new Set();
  for (const row of Array.isArray(suggestionDocs) ? suggestionDocs : []) {
    const uid = String(row?.uid || "").trim();
    if (uid) uids.add(uid);
  }
  return uids.size;
}

function shouldAutoApprove(distinctProposerCount, threshold = DEFAULT_AUTO_APPROVE_THRESHOLD) {
  return Number(distinctProposerCount) >= Number(threshold);
}

module.exports = {
  DEFAULT_AUTO_APPROVE_THRESHOLD,
  MIN_AUTO_APPROVE_THRESHOLD,
  resolveAutoApproveThreshold,
  unorderedPairKey,
  countDistinctProposers,
  shouldAutoApprove,
};
