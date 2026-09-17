// Ordinamento "Correlati" nella scheda titolo — modulo puro, nessuna fetch,
// nessun import Firestore. Il chiamante (title.page.js via titles.api.js) fa
// tutte le letture e passa qui solo dati gia' in memoria: titoli candidati,
// vicini collaborativi (titles/{id}/aggregates/similar) e il tasteProfile
// dell'utente (users/{uid}/tasteProfile/agg → featureSums), quando disponibile.
//
// Ordine finale: curati (title.related, approvati) sempre primi e nell'ordine
// dato; il resto (collaborativi + fallback per genere) ordinato per punteggio
// = 2x affinita' collaborativa (aggregates/similar.score) + affinita' gusti
// personali (overlap generi/persone coi featureSums, quando l'utente e'
// loggato e ha un profilo) + un piccolo termine di popolarita' (log del
// numero di voti, per non far vincere sempre titoli senza community).
// Senza tasteProfile (utente non loggato o profilo vuoto) resta solo il
// punteggio collaborativo + popolarita'.

const RATING_COUNT_WEIGHT = 0.35;
const COLLAB_SCORE_WEIGHT = 2;
const TASTE_GENRE_WEIGHT = 1;
const TASTE_PEOPLE_WEIGHT = 0.6;
const TASTE_PEOPLE_SAMPLE = 8;

function toId(value) {
  return String(value || "").trim();
}

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

// Stessa formula di functions/lib/recommendationEngine.js:buildAffinityMap,
// senza il decadimento temporale (qui non riceviamo `lastAt`, e per una lista
// correlati — non per Match — la precisione extra non vale la complessita').
function featureAffinity(bucket, id) {
  if (!bucket || typeof bucket !== "object") return 0;
  const entry = bucket[id];
  if (!entry) return 0;
  const sum = Number(entry.sum || 0);
  const weight = Number(entry.weight || 0);
  if (!Number.isFinite(sum) || !Number.isFinite(weight) || weight <= 0) return 0;
  return clamp(sum / (weight + 1.2), -1, 1);
}

/**
 * Affinita' gusti personali di un titolo, da -1 (evitato) a un valore
 * positivo aperto (piu' generi/persone amate ci sono, piu' sale).
 * @param {{genres?: string[], castIds?: string[]}} title
 * @param {{genres?: object, people?: object}|null} featureSums
 */
export function tasteAffinityForTitle(title, featureSums) {
  if (!featureSums) return 0;
  let score = 0;

  const genres = Array.isArray(title?.genres) ? title.genres : [];
  const seenGenres = new Set();
  for (const g of genres) {
    const key = toId(g);
    if (!key || seenGenres.has(key)) continue;
    seenGenres.add(key);
    score += featureAffinity(featureSums.genres, key) * TASTE_GENRE_WEIGHT;
  }

  const people = Array.isArray(title?.castIds) ? title.castIds : [];
  const seenPeople = new Set();
  for (const id of people.slice(0, TASTE_PEOPLE_SAMPLE)) {
    const key = toId(id);
    if (!key || seenPeople.has(key)) continue;
    seenPeople.add(key);
    score += featureAffinity(featureSums.people, key) * TASTE_PEOPLE_WEIGHT;
  }

  return score;
}

function popularityTerm(title) {
  const ratingCount = Math.max(0, Number(title?.ratingCount || 0));
  return Math.log10(1 + ratingCount) * RATING_COUNT_WEIGHT;
}

/**
 * @param {object} opts
 * @param {string[]} [opts.curatedIds] Id in `title.related`, gia' filtrati
 *   agli approvati dal chiamante (dedupe + ordine di apparizione preservato).
 * @param {Array<object>} opts.candidates Titoli candidati (curati +
 *   collaborativi + fallback genere), ciascuno con almeno `id`.
 * @param {Map<string,{score:number}>} [opts.similarityById] Punteggio
 *   collaborativo per id, da `aggregates/similar.neighbors`.
 * @param {{genres?: object, people?: object}|null} [opts.featureSums]
 * @param {Iterable<string>} [opts.excludeIds] Id da escludere sempre (titolo
 *   pagina, membri della saga già mostrati altrove).
 * @returns {Array<object>} Titoli ordinati: curati prima, poi per punteggio.
 */
export function rankRelatedTitles({
  curatedIds = [],
  candidates = [],
  similarityById = new Map(),
  featureSums = null,
  excludeIds = [],
} = {}) {
  const curatedSet = new Set((curatedIds || []).map(toId).filter(Boolean));
  const excluded = new Set(Array.from(excludeIds || []).map(toId).filter(Boolean));

  const byId = new Map();
  for (const title of candidates) {
    const id = toId(title?.id);
    if (!id || excluded.has(id) || byId.has(id)) continue;
    byId.set(id, title);
  }

  const curated = curatedIds
    .map(toId)
    .filter((id) => id && byId.has(id))
    .map((id) => byId.get(id));

  const rest = [];
  for (const [id, title] of byId.entries()) {
    if (curatedSet.has(id)) continue;
    const simScore = Number(similarityById.get(id)?.score || 0);
    const score = (simScore * COLLAB_SCORE_WEIGHT) + tasteAffinityForTitle(title, featureSums) + popularityTerm(title);
    rest.push({ title, score });
  }
  rest.sort((a, b) => b.score - a.score || String(a.title?.name || "").localeCompare(String(b.title?.name || "")));

  return [...curated, ...rest.map((r) => r.title)];
}
