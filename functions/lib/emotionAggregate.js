"use strict";

// Emozioni post-visione ("Che impressione hai avuto?").
//
// Chiavi canoniche stabili (mai emoji nel DB): whitelist condivisa da
// firestore.rules (titleEmotions), trigger recomputeTitleEmotionAggregate,
// backfill e futuro import TV Time (mapping emotion_id -> chiave, TBD dal
// file demo GDPR).
const EMOTION_KEYS = Object.freeze([
  "shocked",
  "frustrated",
  "sad",
  "reflective",
  "touched",
  "amused",
  "scared",
  "bored",
  "understood",
  "thrilled",
  "confused",
  "tense",
]);

const EMOTION_KEY_SET = new Set(EMOTION_KEYS);

// Normalizza il campo `emotions` di un doc titleEmotions: array di chiavi
// valide, dedupe, ordine ignorato. Input non-list o chiavi ignote -> scartate
// (difensivo: le rules le bloccano lato client, ma i doc admin SDK / import
// potrebbero divergere).
function sanitizeEmotions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const key = typeof item === "string" ? item.trim() : "";
    if (!EMOTION_KEY_SET.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

// Aggregato denormalizzato su titles/{id}.emotionAggregate:
//   { counts: { touched: 12, ... },  // solo chiavi > 0
//     totalSelections: number,        // somma dei counts (base delle %)
//     totalUsers: number }            // doc distinti (1 doc = 1 utente)
// updatedAt lo aggiunge il trigger (serverTimestamp).
//
// Applica il delta before->after di UN doc titleEmotions all'aggregato
// corrente. Pura, O(1) rispetto al catalogo: usata dal trigger onWrite e
// riusabile dal backfill (seed = aggregato vuoto, replay dei doc).
function applyEmotionAggregateDelta(seed, beforeEmotions, afterEmotions) {
  const counts = {};
  const seedCounts = (seed && seed.counts) || {};
  for (const key of Object.keys(seedCounts)) {
    if (!EMOTION_KEY_SET.has(key)) continue;
    const n = Number(seedCounts[key]);
    if (Number.isFinite(n) && n > 0) counts[key] = n;
  }

  const before = sanitizeEmotions(beforeEmotions);
  const after = sanitizeEmotions(afterEmotions);

  for (const key of before) {
    counts[key] = Math.max(0, (counts[key] || 0) - 1);
    if (counts[key] === 0) delete counts[key];
  }
  for (const key of after) {
    counts[key] = (counts[key] || 0) + 1;
  }

  const totalSelections = Object.values(counts).reduce((acc, n) => acc + n, 0);

  const seedUsers = Number(seed && seed.totalUsers) || 0;
  let usersDelta = 0;
  if (before.length === 0 && after.length > 0) usersDelta = 1;
  if (before.length > 0 && after.length === 0) usersDelta = -1;
  const totalUsers = Math.max(0, seedUsers + usersDelta);

  return { counts, totalSelections, totalUsers };
}

// True se il delta e' un no-op per l'aggregato (stesso set di emozioni).
function emotionSetsEqual(beforeEmotions, afterEmotions) {
  const a = sanitizeEmotions(beforeEmotions);
  const b = sanitizeEmotions(afterEmotions);
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((key) => set.has(key));
}

module.exports = {
  EMOTION_KEYS,
  sanitizeEmotions,
  applyEmotionAggregateDelta,
  emotionSetsEqual,
};
