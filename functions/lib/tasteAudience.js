"use strict";

// Pubblico per **affinita'**: chi guarda quel genere, quegli attori, quel
// regista — anche se il titolo non ce l'ha in libreria.
//
// PERCHE' — il pubblico di un post ufficiale e' sempre stato "chi ha il titolo
// in libreria o watchlist". Per un'uscita nuova quella lista e' quasi vuota per
// costruzione: nessuno puo' avere in libreria un film uscito ieri. Misurato il
// 2026-08-20: il post su Insidious aveva 1 destinatario, mentre fra i 196
// profili gusti esistenti c'e' chi guarda horror e quel film lo avrebbe voluto
// sapere.
//
// DOVE FINISCE — nel **feed** per tutti, e in **notifica solo per i primissimi**
// della classifica (2026-08-24). Prima la notifica era riservata al pubblico per
// libreria, per non svegliare nessuno su un forse. Il motivo per cui e' cambiato
// sta nei numeri: il canale notifiche non era scarso, era sprecato — 11.116
// nudge di re-engagement letti allo 0,5% contro il 5,1% degli aggiornamenti
// editoriali. Tagliati i nudge, il budget liberato va a chi ha davvero
// affinita': `MIN_TASTE_NOTIFY_SCORE` + `DEFAULT_TASTE_NOTIFY_LIMIT` sotto.
//
// COME SI SCEGLIE — per **classifica**, non per soglia. I punteggi assoluti
// dipendono da quanti generi ha un titolo (2 per un horror, 5 per un family):
// una soglia fissa taglierebbe fuori interi generi. Si prendono i primi N.
//
// Nessun I/O qui dentro: chi chiama passa i profili gia' letti.

const { buildTasteProfile, scoreTasteBias } = require("./recommendationEngine");
const { FEATURE_WEIGHTS } = require("./tasteProfileAggregate");
const { safeArray, toId } = require("./pureUtils");

// Quante persone in piu' raggiunge un post nel feed. Da 25 a 75 il 2026-08-24:
// con 25 i post automatici sulle uscite arrivavano a 25 persone su 395, e le
// misure dicono che i candidati sopra soglia sono ~155 per titolo. Il feed di
// qualcun altro resta un posto dove non si sperimenta, ma 25 era timido.
const DEFAULT_TASTE_AUDIENCE_LIMIT = 75;
const MAX_TASTE_AUDIENCE_LIMIT = 200;

// Chi, dentro il pubblico per affinita', merita anche una notifica.
//
// La soglia non e' inventata: misurata il 2026-08-24 su Reacher e A Different
// World con i 205 profili gusti veri. Distribuzione dei punteggi sopra la
// soglia minima (~155 candidati per titolo): massimo ~1,5, mediana ~0,13.
// A 0,5 restano i primi 8-10, cioe' il 5% dei profili — quelli con piu'
// generi/cast in comune, non "chi somiglia un po' a tutto".
const MIN_TASTE_NOTIFY_SCORE = 0.5;
const DEFAULT_TASTE_NOTIFY_LIMIT = 10;

// Sotto questa confidenza il profilo non ha visto abbastanza per dire qualcosa:
// includerlo sarebbe come tirare a caso.
const MIN_TASTE_CONFIDENCE = 20;

// Un punteggio nullo o negativo significa "questo genere non lo guarda" o
// "lo evita": in nessuno dei due casi va raggiunto.
const MIN_TASTE_SCORE = 0.01;

// Quanti post per affinita' puo' ricevere una persona in un giorno.
//
// PERCHE' SERVE — misurato sui dati veri: senza tetto, i primi 25 di titoli
// diversi si sovrappongono al 61%, perche' chi ha visto piu' film ha affinita'
// alta su tutto. Il tetto sparge la portata senza rovinare la pertinenza.
//
// PERCHE' NON SI NORMALIZZA IL PUNTEGGIO — provato: dividere per il peso del
// profilo abbassa la sovrapposizione al 27%, ma in cima finiscono i profili
// quasi vuoti (un utente con tre voti "somiglia" a tutto). Meglio un ranking
// onesto con un tetto sopra.
const TASTE_DAILY_CAP = 2;

// --- Provenienza (2026-08-26) -----------------------------------------------
//
// PERCHE' — misurato su "Mousetrap - Identita' rubata" (serie coreana Netflix)
// con i 205 profili veri: la classifica per soli generi metteva al #51 chi ha
// 118 titoli coreani visti e 367 in watchlist, e la motivazione era sempre
// "generi in linea" — cioe' Mistero/Crime/Dramma, meta' catalogo. Sovrapposizione
// con chi guarda davvero coreano: 1 su 15.
//
// PERCHE' NON BASTA L'AFFINITA' DEL BUCKET — `sum/(weight+1.2)` e' una MEDIA:
// con `import_seen` normalizzato a 0.30 satura li' sopra sia per chi ha 118
// titoli coreani sia per chi ne ha 2. Risponde a "quando ne vedi uno ti piace?",
// non a "quanto lo cerchi?". Aggiungere il bucket come gli altri sposta la
// classifica da 1/15 a 2/15: praticamente niente.
//
// COSA MISURIAMO INVECE — lo scostamento dalla media di popolazione. La quota
// di quel paese nel profilo diviso la quota che quel paese ha su tutti i
// profili (KR = 1,28%, US = 68,1%). In log2, cosi' raddoppiare la quota vale
// sempre lo stesso. US e IT restano vicini a zero per tutti — la provenienza
// discrimina solo quando e' rara, che e' esattamente quando significa qualcosa.
//
// PERCHE' LO SMORZAMENTO — senza, in cima finisce chi ha UN titolo coreano e
// una libreria da un titolo: quota 100%, scostamento massimo. E' la stessa
// trappola dei profili quasi vuoti gia' scartata per il punteggio normalizzato
// (vedi TASTE_DAILY_CAP). L'evidenza cresce fino a `PROVENANCE_MIN_TITLES`
// titoli di quel paese e li' si ferma.
//
// Risultato sulla stessa misura: primi 20 da 1/15 a 9/15, notifica da 0/10 a
// 6/10 pertinenti.
const PROVENANCE_MIN_TITLES = 8;
const PROVENANCE_SCORE_WEIGHT = 0.8;
const PROVENANCE_SCORE_MAX = 3.0;

/** Peso che un singolo titolo aggiunge al bucket paesi (una feature per titolo). */
const PROVENANCE_TITLE_WEIGHT = FEATURE_WEIGHTS.countries[0];

/** I paesi di un titolo, dall'unico campo dove esistono davvero. */
function titleCountries(titleData = {}) {
  const direct = safeArray(titleData.countries);
  if (direct.length) return direct.map((code) => toId(code)).filter(Boolean);
  return safeArray(titleData.meta?.originCountry).map((code) => toId(code)).filter(Boolean);
}

/**
 * Quota di ogni paese sul totale dei profili passati: la media da cui misurare
 * lo scostamento del singolo. Si calcola dagli stessi profili che si stanno
 * classificando, quindi non serve nessuna lettura in piu'.
 *
 * @returns {Map<string, number>} codice paese → quota in [0, 1]
 */
function buildProvenanceBaseline(profiles = []) {
  const totals = new Map();
  let grandTotal = 0;
  for (const row of safeArray(profiles)) {
    const bucket = row?.data?.featureSums?.countries;
    if (!bucket || typeof bucket !== "object") continue;
    for (const [code, entry] of Object.entries(bucket)) {
      const key = toId(code);
      const weight = Number(entry?.weight || 0);
      if (!key || !Number.isFinite(weight) || weight <= 0) continue;
      totals.set(key, (totals.get(key) || 0) + weight);
      grandTotal += weight;
    }
  }
  if (grandTotal <= 0) return new Map();
  const baseline = new Map();
  for (const [code, weight] of totals) baseline.set(code, weight / grandTotal);
  return baseline;
}

/**
 * Quanto questo profilo guarda quei paesi PIU' della media, in log2, smorzato
 * dall'evidenza. Zero quando il paese e' sotto la media, quando l'affinita' e'
 * negativa (li' vede ma non gli piacciono) o quando la baseline non esiste.
 */
function provenanceLift(profileData = {}, codes = [], baseline = new Map()) {
  const bucket = profileData?.featureSums?.countries;
  if (!bucket || typeof bucket !== "object" || !(baseline instanceof Map) || !baseline.size) return 0;

  let profileTotal = 0;
  for (const entry of Object.values(bucket)) {
    const weight = Number(entry?.weight || 0);
    if (Number.isFinite(weight) && weight > 0) profileTotal += weight;
  }
  if (profileTotal <= 0) return 0;

  let best = 0;
  for (const rawCode of safeArray(codes)) {
    const code = toId(rawCode);
    if (!code) continue;
    const entry = bucket[code];
    const weight = Number(entry?.weight || 0);
    if (!Number.isFinite(weight) || weight <= 0) continue;

    // Lo guarda ma non gli piace: la quota alta non e' un motivo per scrivergli.
    const affinity = Number(entry.sum || 0) / (weight + 1.2);
    if (!(affinity > 0)) continue;

    const base = Number(baseline.get(code) || 0);
    if (!(base > 0)) continue;
    const ratio = (weight / profileTotal) / base;
    if (!(ratio > 1)) continue;

    const evidence = Math.min(1, weight / (PROVENANCE_MIN_TITLES * PROVENANCE_TITLE_WEIGHT));
    best = Math.max(best, Math.log2(ratio) * evidence);
  }
  return best;
}

/** Il titolo come lo vuole `scoreTasteBias`, piu' i paesi per la provenienza. */
function titleAsCandidate(titleData = {}) {
  return {
    genres: safeArray(titleData.genres),
    castIds: safeArray(titleData.castIds),
    directorIds: safeArray(titleData.directorIds),
    countries: titleCountries(titleData),
    year: Number(titleData.year) || null,
    type: titleData.type === "tv" ? "tv" : "movie",
  };
}

/**
 * Classifica i profili per affinita' con un titolo.
 *
 * @param {Object} params
 * @param {Object} params.titleData        doc `titles/{id}`
 * @param {Array<{uid: string, data: Object}>} params.profiles  doc `tasteProfile/agg`
 * @param {Set<string>|Array<string>} params.excludeUids  chi e' gia' raggiunto
 * @returns {Array<{uid: string, score: number, reasons: string[]}>}
 */
function rankTasteAudience({
  titleData,
  profiles = [],
  excludeUids = [],
  limit = DEFAULT_TASTE_AUDIENCE_LIMIT,
  minConfidence = MIN_TASTE_CONFIDENCE,
  nowMs = Date.now(),
} = {}) {
  const candidate = titleAsCandidate(titleData);
  // Un titolo senza generi ne' cast non ha niente su cui somigliare: meglio
  // nessun pubblico che un pubblico casuale. La provenienza da sola non basta:
  // "e' coreano" non e' un motivo per scrivere a qualcuno.
  if (!candidate.genres.length && !candidate.castIds.length && !candidate.directorIds.length) return [];

  const provenanceBaseline = buildProvenanceBaseline(profiles);

  const excluded = excludeUids instanceof Set
    ? excludeUids
    : new Set(safeArray(excludeUids).map((uid) => toId(uid)).filter(Boolean));

  const cap = Math.max(1, Math.min(MAX_TASTE_AUDIENCE_LIMIT, Math.floor(Number(limit) || DEFAULT_TASTE_AUDIENCE_LIMIT)));
  const rows = [];

  for (const row of safeArray(profiles)) {
    const uid = toId(row?.uid);
    if (!uid || excluded.has(uid)) continue;

    const profile = buildTasteProfile(row?.data || {}, nowMs);
    if (Number(profile.confidenceScore || 0) < minConfidence) continue;

    const { bonus, penalty, reasons } = scoreTasteBias(candidate, profile, {});
    const lift = provenanceLift(row?.data || {}, candidate.countries, provenanceBaseline);
    const provenanceBonus = Math.min(lift * PROVENANCE_SCORE_WEIGHT, PROVENANCE_SCORE_MAX);
    const score = Number(bonus || 0) - Number(penalty || 0) + provenanceBonus;
    if (!(score >= MIN_TASTE_SCORE)) continue;

    const why = safeArray(reasons);
    if (provenanceBonus > 0) why.push("guardi molto piu' della media titoli da li'");
    rows.push({ uid, score: Math.round(score * 1000) / 1000, reasons: why });
  }

  rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.uid.localeCompare(b.uid);
  });

  return rows.slice(0, cap);
}

/**
 * Chiave del giorno a Roma (`YYYYMMDD`), come i contatori delle notifiche.
 * Sta qui e non in titleUpdateNotifications per non creare un ciclo di import.
 */
function tasteDayKey(nowMs = Date.now()) {
  const date = new Date(Number(nowMs));
  if (!Number.isFinite(date.getTime())) throw new Error("nowMs non valido");
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date).replaceAll("-", "");
}

/**
 * Toglie chi ha gia' ricevuto abbastanza post per affinita' oggi.
 *
 * @param {Array<{uid: string}>} rows        candidati gia' ordinati
 * @param {Map<string, number>|Object} counts uid → post ricevuti oggi
 */
function filterByDailyCap(rows, counts = new Map(), cap = TASTE_DAILY_CAP) {
  const map = counts instanceof Map ? counts : new Map(Object.entries(counts || {}));
  const ceiling = Math.max(1, Math.floor(Number(cap) || TASTE_DAILY_CAP));
  return safeArray(rows).filter((row) => Number(map.get(toId(row?.uid)) || 0) < ceiling);
}

/**
 * I pochi, dentro il pubblico per affinita', che meritano una notifica.
 *
 * Vuole le righe gia' ordinate da `rankTasteAudience` (che ordina per punteggio
 * decrescente) e restituisce solo gli uid: chi chiama scrive notifiche, non
 * classifiche.
 *
 * @param {Array<{uid: string, score: number}>} rows
 * @returns {string[]}
 */
function selectTasteNotifyUids(rows = [], {
  minScore = MIN_TASTE_NOTIFY_SCORE,
  limit = DEFAULT_TASTE_NOTIFY_LIMIT,
} = {}) {
  const floor = Number.isFinite(Number(minScore)) ? Number(minScore) : MIN_TASTE_NOTIFY_SCORE;
  const cap = Math.max(0, Math.floor(Number(limit) ?? DEFAULT_TASTE_NOTIFY_LIMIT));
  if (!cap) return [];

  return safeArray(rows)
    .filter((row) => Number(row?.score || 0) >= floor)
    .map((row) => toId(row?.uid))
    .filter(Boolean)
    .slice(0, cap);
}

module.exports = {
  DEFAULT_TASTE_AUDIENCE_LIMIT,
  MAX_TASTE_AUDIENCE_LIMIT,
  PROVENANCE_MIN_TITLES,
  PROVENANCE_SCORE_WEIGHT,
  PROVENANCE_SCORE_MAX,
  buildProvenanceBaseline,
  provenanceLift,
  titleCountries,
  MIN_TASTE_CONFIDENCE,
  MIN_TASTE_SCORE,
  MIN_TASTE_NOTIFY_SCORE,
  DEFAULT_TASTE_NOTIFY_LIMIT,
  selectTasteNotifyUids,
  TASTE_DAILY_CAP,
  titleAsCandidate,
  rankTasteAudience,
  filterByDailyCap,
  tasteDayKey,
};
