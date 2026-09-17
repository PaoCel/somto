"use strict";

// "Persone da seguire" — chi altro ha votato i tuoi stessi titoli.
//
// Il grafo follower esiste da sempre ma non viene mai proposto: al 2026-08-19
// sono 23 utenti su 343 ad aver seguito qualcuno, 91 archi in tutto. Ogni post
// nasce quindi con un pubblico di zero. Questo modulo produce la lista di
// persone da mostrare, a partire dal solo segnale che e' gia' leggibile da un
// utente loggato: i voti (`ratings`, read: isSignedIn).
//
// PRIVACY — perche' i voti e non la libreria: `titleStates` e' owner-only
// (rules), quindi "avete 5 titoli in comune" farebbe trapelare cosa ha visto
// un altro utente. I voti sono gia' visibili in app, e permettono di dire
// *perche'* suggeriamo qualcuno senza rivelare niente di nuovo.
//
// Nessun I/O qui dentro: chi chiama passa i voti gia' caricati.

const { safeArray, toId, clamp } = require("./pureUtils");

// Titoli miei usati come sonda. Ogni seed e' una query su `ratings`, quindi e'
// il parametro che decide il costo della chiamata.
const MAX_SEED_TITLES = 25;

// Tetto di votanti letti per titolo: su un titolo popolare la coda non aggiunge
// segnale, aggiunge solo letture.
const MAX_RATERS_PER_TITLE = 80;

// Un solo titolo in comune non dice niente: due sconosciuti hanno entrambi
// votato Oppenheimer. Da due in su comincia a essere un gusto.
const MIN_SHARED_TITLES = 2;

const MAX_SUGGESTIONS = 10;

// Quota di punteggio che spetta al semplice "l'ha visto anche lui", prima di
// pesare quanto siete d'accordo. Senza questa quota due persone che votano gli
// stessi film con mezzo punto di scarto varrebbero quanto due estranei.
const AGREEMENT_FLOOR = 0.35;

// Titoli in comune restituiti al client, che ci costruisce la frase
// ("tra cui X e Y") con le proprie stringhe tradotte.
const MAX_REASON_TITLES = 2;

/**
 * Accordo fra due voti 1-10 → [0,1]. 10 vs 10 = 1, 10 vs 1 = 0.
 * `null`/`undefined` non sono "voto zero": `Number(null)` vale 0 ed e' finito,
 * quindi il controllo deve essere sul range valido, non solo su isFinite.
 */
function ratingAgreement(mine, theirs) {
  const a = Number(mine);
  const b = Number(theirs);
  if (!isValidRating(a) || !isValidRating(b)) return 0;
  return clamp(1 - Math.abs(a - b) / 9, 0, 1);
}

/** Un voto valido sta in [1,10]: fuori da li' e' un campo assente o corrotto. */
function isValidRating(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 && n <= 10;
}

/**
 * Peso di rarita' di un titolo: piu' gente l'ha votato, meno dice di voi due.
 * 2 votanti → 1.0, 10 → ~0.32, 80 → ~0.16.
 */
function rarityWeight(ratersCount) {
  const raters = Math.max(1, Number(ratersCount) || 1);
  return 1 / Math.log2(2 + Math.max(0, raters - 1));
}

/**
 * Sceglie i titoli miei da usare come sonda: prima i voti alti (dicono di piu'
 * di un 5), poi i piu' recenti. Deterministico a parita' di input.
 *
 * @param {Array<{titleId: string, rating: number, updatedAtMs?: number}>} myRatings
 */
function pickSeedTitles(myRatings, { max = MAX_SEED_TITLES } = {}) {
  const seen = new Set();
  const rows = [];
  for (const raw of safeArray(myRatings)) {
    const titleId = toId(raw?.titleId);
    const rating = Number(raw?.rating);
    if (!titleId || seen.has(titleId)) continue;
    if (!isValidRating(rating)) continue;
    seen.add(titleId);
    rows.push({ titleId, rating, updatedAtMs: Number(raw?.updatedAtMs) || 0 });
  }
  rows.sort((a, b) => {
    if (b.rating !== a.rating) return b.rating - a.rating;
    if (b.updatedAtMs !== a.updatedAtMs) return b.updatedAtMs - a.updatedAtMs;
    return a.titleId.localeCompare(b.titleId);
  });
  return rows.slice(0, Math.max(1, max)).map((row) => row.titleId);
}

/**
 * Classifica i candidati.
 *
 * @param {Object} params
 * @param {Map<string, number>|Object} params.myRatingByTitle  titleId → mio voto
 * @param {Map<string, Array<{uid: string, rating: number}>>} params.ratersByTitle
 * @param {Set<string>|Array<string>} params.excludeUids  me, chi gia' seguo, i bloccati, i sintetici
 * @returns {Array<{uid, score, sharedCount, sharedTitleIds, avgAgreement}>}
 */
function scoreCandidates({
  myRatingByTitle,
  ratersByTitle,
  excludeUids = [],
  minShared = MIN_SHARED_TITLES,
  max = MAX_SUGGESTIONS,
} = {}) {
  const mine = myRatingByTitle instanceof Map
    ? myRatingByTitle
    : new Map(Object.entries(myRatingByTitle || {}));
  const raters = ratersByTitle instanceof Map
    ? ratersByTitle
    : new Map(Object.entries(ratersByTitle || {}));
  const excluded = excludeUids instanceof Set
    ? excludeUids
    : new Set(safeArray(excludeUids).map((uid) => toId(uid)).filter(Boolean));

  const byUid = new Map();

  for (const [titleId, rows] of raters.entries()) {
    const myRating = Number(mine.get(titleId));
    if (!isValidRating(myRating)) continue;

    const list = safeArray(rows).slice(0, MAX_RATERS_PER_TITLE);
    const weight = rarityWeight(list.length);

    for (const row of list) {
      const uid = toId(row?.uid);
      if (!uid || excluded.has(uid)) continue;
      const theirRating = Number(row?.rating);
      if (!isValidRating(theirRating)) continue;

      const agreement = ratingAgreement(myRating, theirRating);
      const entry = byUid.get(uid) || { uid, score: 0, sharedTitleIds: [], agreementSum: 0 };
      entry.score += weight * (AGREEMENT_FLOOR + (1 - AGREEMENT_FLOOR) * agreement);
      entry.agreementSum += agreement;
      entry.sharedTitleIds.push(titleId);
      byUid.set(uid, entry);
    }
  }

  const out = [];
  for (const entry of byUid.values()) {
    const sharedCount = entry.sharedTitleIds.length;
    if (sharedCount < minShared) continue;
    out.push({
      uid: entry.uid,
      score: Math.round(entry.score * 1000) / 1000,
      sharedCount,
      sharedTitleIds: entry.sharedTitleIds.slice(),
      avgAgreement: Math.round((entry.agreementSum / sharedCount) * 100) / 100,
    });
  }

  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.sharedCount !== a.sharedCount) return b.sharedCount - a.sharedCount;
    return a.uid.localeCompare(b.uid);
  });

  return out.slice(0, Math.max(1, max));
}

module.exports = {
  MAX_SEED_TITLES,
  MAX_RATERS_PER_TITLE,
  MIN_SHARED_TITLES,
  MAX_SUGGESTIONS,
  AGREEMENT_FLOOR,
  isValidRating,
  ratingAgreement,
  rarityWeight,
  MAX_REASON_TITLES,
  pickSeedTitles,
  scoreCandidates,
};
