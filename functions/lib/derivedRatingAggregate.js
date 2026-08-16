"use strict";

// Roll-up automatico dei voti per-utente (PRIVATO).
//
// Quando un utente vota gli EPISODI di una serie, Somto ricava in automatico:
//   - il voto di ogni STAGIONE  = media dei suoi voti episodio in quella stagione
//   - il voto della SERIE       = media delle stagioni (mean dei season-avg;
//                                 1 sola stagione => serie == stagione)
//
// Questi voti sono DERIVATI e restano privati: alimentano profilo/taste
// dell'utente ma NON entrano nell'aggregato pubblico community
// (titles/{id}.ratingAggregate). Vivono in una sottocollezione dedicata
// users/{uid}/derivedRatings/{titleId}, quindi non toccano MAI la collection
// /ratings/ né il trigger recomputeTitleRatingAggregate: l'esclusione dal voto
// pubblico è garantita per costruzione, non da un filtro.
//
// L'override manuale è gestito a valle (display/consumo): se l'utente dà un
// voto ESPLICITO a stagione/serie (in /ratings/), quello vince; il derivato
// non viene mai sovrascritto perché sta in un altro posto.
//
// Logica delta condivisa qui (pura, O(#stagioni)): usata dal trigger onWrite
// recomputeUserDerivedRating e dal backfill scripts/backfill-derivedRatings.js.

// Arrotonda a 2 decimali (come combined del rating aggregate pubblico).
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Estrae il contributo episodio da un doc rating. Ritorna {season, rating}
// solo se è un voto episodio valido (level=episode, season>0, rating finito);
// altrimenti null. I voti title/season non contribuiscono al derivato.
function episodeContribution(ratingDoc) {
  if (!ratingDoc || ratingDoc.level !== "episode") return null;
  const season = Number(ratingDoc.season);
  const rating = Number(ratingDoc.rating);
  if (!Number.isFinite(season) || season <= 0) return null;
  if (!Number.isFinite(rating)) return null;
  return { season, rating };
}

// True se before/after non cambiano nulla per il derivato (no-op del trigger):
// nessuno dei due è un voto episodio, oppure stessa stagione e stesso voto
// (es. update che tocca solo reviewText/updatedAt).
function derivedDeltaIsNoop(before, after) {
  const b = episodeContribution(before);
  const a = episodeContribution(after);
  if (!b && !a) return true;
  if (b && a && b.season === a.season && b.rating === a.rating) return true;
  return false;
}

// Normalizza la mappa bySeason grezza (sum/count degli episodi) dal seed:
// scarta chiavi non-numeriche, count<=0, valori NaN.
function sanitizeBySeason(rawBySeason) {
  const out = {};
  const src = (rawBySeason && typeof rawBySeason === "object") ? rawBySeason : {};
  for (const key of Object.keys(src)) {
    const seasonNum = Number(key);
    if (!Number.isFinite(seasonNum) || seasonNum <= 0) continue;
    const bucket = src[key] || {};
    const count = Math.max(0, Math.trunc(Number(bucket.count) || 0));
    const sum = Number(bucket.sum) || 0;
    if (count <= 0) continue;
    out[String(seasonNum)] = { sum, count };
  }
  return out;
}

// Applica il delta before->after di UN voto episodio all'aggregato derivato di
// un (utente, titolo). Puro. `seed` è il doc derivato corrente (o null).
//
// Ritorna:
//   {
//     episodeAgg: { bySeason: { "1": {sum, count}, ... } },  // grezzo, per replay
//     season:     { "1": {avg, count}, ... },                // solo count>0
//     series:     { avg, seasonCount, episodeCount } | null, // null se nessun episodio
//     isEmpty:    bool                                       // true => cancellare il doc
//   }
function applyDerivedEpisodeDelta(seed, before, after) {
  const bySeason = sanitizeBySeason(seed && seed.episodeAgg && seed.episodeAgg.bySeason);

  const b = episodeContribution(before);
  const a = episodeContribution(after);

  if (b) {
    const key = String(b.season);
    const bucket = bySeason[key] || { sum: 0, count: 0 };
    bucket.sum = (Number(bucket.sum) || 0) - b.rating;
    bucket.count = (Number(bucket.count) || 0) - 1;
    if (bucket.count <= 0) {
      delete bySeason[key];
    } else {
      bySeason[key] = bucket;
    }
  }
  if (a) {
    const key = String(a.season);
    const bucket = bySeason[key] || { sum: 0, count: 0 };
    bucket.sum = (Number(bucket.sum) || 0) + a.rating;
    bucket.count = (Number(bucket.count) || 0) + 1;
    bySeason[key] = bucket;
  }

  // Derivati per stagione: media episodi (2 dec), solo stagioni con count>0.
  const season = {};
  const seasonAvgs = [];
  let episodeCount = 0;
  for (const key of Object.keys(bySeason)) {
    const bucket = bySeason[key];
    const count = bucket.count;
    if (count <= 0) continue;
    const avg = round2(bucket.sum / count);
    season[key] = { avg, count };
    seasonAvgs.push(avg);
    episodeCount += count;
  }

  // Serie = media delle stagioni (mean dei season-avg). 1 stagione => serie
  // == quella stagione. Nessun episodio => nessun voto serie.
  let series = null;
  if (seasonAvgs.length > 0) {
    const mean = seasonAvgs.reduce((acc, v) => acc + v, 0) / seasonAvgs.length;
    series = {
      avg: round2(mean),
      seasonCount: seasonAvgs.length,
      episodeCount,
    };
  }

  return {
    episodeAgg: { bySeason },
    season,
    series,
    isEmpty: series === null,
  };
}

module.exports = {
  round2,
  episodeContribution,
  derivedDeltaIsNoop,
  sanitizeBySeason,
  applyDerivedEpisodeDelta,
};
