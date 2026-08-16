"use strict";

// Aggregazione profilo gusti (taste profile) — logica di scoring PURA e condivisa.
//
// Estratta dal trigger updateTasteProfileOnSignal (functions/index.js) per essere
// riusata IDENTICA sia dal trigger (1 titolo per segnale) sia dalla coda di
// import (fold di N titoli visti/votati in UNA sola scrittura su
// users/{uid}/tasteProfile/agg — niente fan-out per-segnale, niente contesa
// sull'hot-doc). Nessun nuovo modello: qui vive la stessa matematica di prima.
//
// Modello dati (invariato):
//   featureSums.<bucket>.<id> = { sum, weight, lastAt }
//   bucket ∈ { genres, people, directors, countries }
//   affinity a valle = sum / (weight + 1.2)   (buildAffinityMap in index.js)
//   confidenceScore  = f(peso cumulativo, livello onboarding)
//
// NIENTE Firebase SDK qui: solo dati puri → unit-testabile, zero I/O.

// Pesi feature identici al trigger storico:
//   genres   = [1.0,0.6,0.4] * 0.60
//   cast     = [1.0,0.6,0.4] * 0.30
//   director = [0.25]
//   country  = [0.12]
const FEATURE_WEIGHTS = {
  genres: [1.0, 0.6, 0.4].map((w) => w * 0.60),
  people: [1.0, 0.6, 0.4].map((w) => w * 0.30),
  directors: [0.25],
  countries: [0.12],
};

// Numero massimo di feature lette per titolo (come il trigger: 3/3/1/1).
const FEATURE_TAKE = { genres: 3, people: 3, directors: 1, countries: 1 };

// Cap dimensione bucket: evita che un import massivo faccia superare a
// users/{uid}/tasteProfile/agg il limite doc Firestore (1MB). Generosi: un
// utente normale sta molto sotto; solo importatori estremi vengono potati e si
// tiene il top-K per peso (la coda a peso minimo, cioè le feature più deboli,
// cade — sono anche quelle col decay più aggressivo a valle).
const BUCKET_CAPS = { genres: 50, people: 400, directors: 250, countries: 80 };

// Mappa azione → { weight, normalized } (allineata a quella in index.js usata
// da backfillTasteSignals). `normalized: null` per rating = usa il voto reale
// via normalizedFromRating.
const ACTION_WEIGHTS = {
  rating: { weight: 1.0, normalized: null },
  match_dislike: { weight: 0.55, normalized: -1 },
  match_ok: { weight: 0.15, normalized: 1 },
  match_love: { weight: 0.60, normalized: 1 },
  match_seen: { weight: 0.05, normalized: 0 },
  watchlist_add: { weight: 0.45, normalized: 1 },
  watchlist_remove: { weight: 0.45, normalized: -1 },
  suggest_to_friend: { weight: 0.70, normalized: 1 },
  thread_post: { weight: 0.20, normalized: 1 },
  // Titolo IMPORTATO come "visto" (senza voto): preferenza debole POSITIVA.
  // Non zero (a differenza di match_seen) così un archivio senza voti
  // (Netflix) sposta comunque il profilo verso i generi davvero consumati;
  // abbastanza piccolo da farsi dominare da un eventuale voto (rating,
  // weight 1.0 → può anche essere negativo).
  import_seen: { weight: 0.15, normalized: 0.30 },
};

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, Number(n) || 0));
}

function idOf(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

// Voto 1..10 → [-1, 1] (identico a normalizedFromRating in index.js).
function normalizedFromRating(raw) {
  const n = clamp(Number(raw || 0), 1, 10);
  return clamp((n - 5.5) / 4.5, -1, 1);
}

// Delta di un'azione da ACTION_WEIGHTS. Per `rating` (normalized:null) usa il
// voto reale; altrimenti normalized fisso. Ritorna un numero (può essere <0).
function deltaForAction(actionType, rawValue) {
  const meta = ACTION_WEIGHTS[actionType];
  if (!meta) return 0;
  const normalized = meta.normalized === null
    ? normalizedFromRating(rawValue)
    : Number(meta.normalized);
  return normalized * meta.weight;
}

// Estrae le feature rilevanti da un doc titolo con lo STESSO ordine/fallback
// del trigger: genres, castIds||cast, directorIds||directors,
// countries||originCountry||[countryCode]. Ritorna array di id (stringhe)
// troncati a FEATURE_TAKE.
function extractTitleFeatures(title) {
  const t = title && typeof title === "object" ? title : {};
  const take = (arr, n) => (Array.isArray(arr) ? arr : []).map(idOf).filter(Boolean).slice(0, n);
  const genres = take(t.genres, FEATURE_TAKE.genres);
  const people = take(Array.isArray(t.castIds) ? t.castIds : t.cast, FEATURE_TAKE.people);
  const directors = take(Array.isArray(t.directorIds) ? t.directorIds : t.directors, FEATURE_TAKE.directors);
  let countries;
  if (Array.isArray(t.countries)) countries = take(t.countries, FEATURE_TAKE.countries);
  else if (Array.isArray(t.originCountry)) countries = take(t.originCountry, FEATURE_TAKE.countries);
  else if (t.countryCode) countries = [idOf(t.countryCode)].filter(Boolean);
  else countries = [];
  return { genres, people, directors, countries };
}

// Applica il delta di UN titolo alle sue feature dentro featureSums (mutato in
// place). `createdAt` finisce in lastAt (per il decay a valle). Ritorna il peso
// totale aggiunto (per la confidence). Specchio esatto di apply() nel trigger.
function applyTitleDelta(featureSums, features, delta, createdAt) {
  const d = Number(delta);
  if (!Number.isFinite(d) || d === 0) return 0;
  const feats = features || {};
  featureSums.genres = featureSums.genres || {};
  featureSums.people = featureSums.people || {};
  featureSums.directors = featureSums.directors || {};
  featureSums.countries = featureSums.countries || {};

  let addedWeight = 0;
  const applyBucket = (bucket, ids, weights) => {
    (Array.isArray(ids) ? ids : []).forEach((id, idx) => {
      const w = Number(weights[idx] ?? weights[weights.length - 1] ?? 0);
      if (!Number.isFinite(w) || !id) return;
      addedWeight += w;
      const prev = bucket[id] || { sum: 0, weight: 0, lastAt: null };
      bucket[id] = {
        sum: Number(prev.sum || 0) + d * w,
        weight: Number(prev.weight || 0) + w,
        lastAt: createdAt,
      };
    });
  };
  applyBucket(featureSums.genres, feats.genres, FEATURE_WEIGHTS.genres);
  applyBucket(featureSums.people, feats.people, FEATURE_WEIGHTS.people);
  applyBucket(featureSums.directors, feats.directors, FEATURE_WEIGHTS.directors);
  applyBucket(featureSums.countries, feats.countries, FEATURE_WEIGHTS.countries);
  return addedWeight;
}

// Fold di N titoli (inputs = [{ features, delta, createdAt }]) dentro un
// featureSums esistente (mutato/creato). Ritorna { featureSums, addedWeight }.
// Il chiamante calcola i delta (deltaForAction) e fa UNA sola tx a valle.
function foldTitleDeltas(currentFeatureSums, inputs) {
  const featureSums = currentFeatureSums && typeof currentFeatureSums === "object"
    ? currentFeatureSums
    : {};
  let addedWeight = 0;
  for (const input of Array.isArray(inputs) ? inputs : []) {
    if (!input || !input.features) continue;
    addedWeight += applyTitleDelta(featureSums, input.features, input.delta, input.createdAt);
  }
  return { featureSums, addedWeight };
}

// Costruisce gli input di fold per un import (logica PURA, testabile). Per
// ogni titolo visto: usa il delta del VOTO se presente (ratingByTitleId),
// altrimenti "import_seen" (visto-positivo debole). Scarta i titoli senza
// feature note e i voti esattamente neutri (5.5 → delta 0). `featuresByTitleId`
// e `ratingByTitleId` sono Map. Ritorna [{ titleId, features, delta }] — il
// chiamante aggiunge createdAt e chiama foldTitleDeltas.
function buildImportTasteInputs({ watchedTitleIds, featuresByTitleId, ratingByTitleId }) {
  const feats = featuresByTitleId instanceof Map ? featuresByTitleId : new Map();
  const ratings = ratingByTitleId instanceof Map ? ratingByTitleId : new Map();
  const inputs = [];
  for (const titleId of Array.isArray(watchedTitleIds) ? watchedTitleIds : []) {
    const features = feats.get(titleId);
    if (!features) continue;
    const delta = ratings.has(titleId)
      ? deltaForAction("rating", ratings.get(titleId))
      : deltaForAction("import_seen");
    if (!delta) continue;
    inputs.push({ titleId, features, delta });
  }
  return inputs;
}

// Peso cumulativo su generi+persone+registi (esclude countries), stessa
// definizione di totalWeight in loadTasteProfile (index.js). Sui valori GREZZI
// (no decay): è lo snapshot memorizzato in confidenceScore.
function cumulativeWeight(featureSums) {
  const fs = featureSums || {};
  let total = 0;
  for (const bucketName of ["genres", "people", "directors"]) {
    const bucket = fs[bucketName] || {};
    for (const v of Object.values(bucket)) {
      const w = Number(v && v.weight);
      if (Number.isFinite(w) && w > 0) total += w;
    }
  }
  return total;
}

// confidenceScore = onboarding*15 + min(70, pesoCumulativo*12), clamp 0..100.
// DIVERSO dal trigger storico, che usava il peso del SINGOLO segnale (quindi il
// valore veniva sovrascritto ad ogni scrittura e NON accumulava): qui è
// funzione dello stato CUMULATIVO → cresce con l'evidenza, non regredisce al
// segnale successivo. Fix del bug latente + rende durevole l'apporto import.
function computeConfidenceScore(featureSums, completedLevel) {
  const lvl = Number(completedLevel) || 0;
  return clamp(lvl * 15 + Math.min(70, cumulativeWeight(featureSums) * 12), 0, 100);
}

// Pota ogni bucket al top-K per peso (tie-break |sum|), per tenere il doc agg
// sotto il limite Firestore dopo un import massivo. Mutato in place.
function pruneFeatureSums(featureSums, caps = BUCKET_CAPS) {
  const fs = featureSums || {};
  for (const bucketName of Object.keys(caps)) {
    const bucket = fs[bucketName];
    if (!bucket || typeof bucket !== "object") continue;
    const keys = Object.keys(bucket);
    const cap = caps[bucketName];
    if (keys.length <= cap) continue;
    keys
      .map((k) => ({
        k,
        w: Number(bucket[k] && bucket[k].weight) || 0,
        s: Math.abs(Number(bucket[k] && bucket[k].sum) || 0),
      }))
      .sort((a, b) => (b.w - a.w) || (b.s - a.s))
      .slice(cap)
      .forEach(({ k }) => { delete bucket[k]; });
  }
  return fs;
}

module.exports = {
  FEATURE_WEIGHTS,
  FEATURE_TAKE,
  BUCKET_CAPS,
  ACTION_WEIGHTS,
  clamp,
  idOf,
  normalizedFromRating,
  deltaForAction,
  extractTitleFeatures,
  applyTitleDelta,
  foldTitleDeltas,
  buildImportTasteInputs,
  cumulativeWeight,
  computeConfidenceScore,
  pruneFeatureSums,
};
