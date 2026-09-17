// Default "Con chi l'hai visto?" nel modale review — evita di far scorrere
// l'intera lista dei seguiti quando i pattern recenti dell'utente bastano a
// indovinare la risposta piu' probabile (chip "Da solo" + persone frequenti).
//
// Modulo puro: nessuna fetch, nessun import Firestore. Il chiamante passa i
// SUOI rating recenti (qualunque livello), gia' arricchiti con `type` del
// titolo quando disponibile — questo modulo si occupa solo di leggerli e
// riordinarli per data.

// Campione minimo prima di fidarsi di una statistica (per media type o
// overall): sotto questa soglia i pattern sono troppo rumorosi per un
// default silenzioso — meglio non preselezionare nulla.
export const MIN_SAMPLES = 5;

// Quota di rating "senza compagni" (nessun watchedWith) sopra la quale
// preselezioniamo la chip "Da solo": un utente che guarda quasi sempre da
// solo non deve deselezionarla ogni volta.
export const ALONE_SHARE_THRESHOLD = 0.7;

// Numero massimo di chip "persone frequenti" mostrate.
export const MAX_FREQUENT_COMPANIONS = 3;

// Quante review recenti considerare al massimo (il chiamante puo' passarne
// meno; questo modulo comunque non ne guarda piu' di cosi').
export const RECENT_SAMPLE_MAX = 60;

// Le review piu' vecchie contano meno nel conteggio "persone frequenti": i
// gusti/le compagnie cambiano nel tempo, l'ultima manciata pesa di piu' di
// una di un anno fa. Peso lineare da 1 (piu' recente) a 0.2 (piu' vecchia
// del campione).
function recencyWeight(index, total) {
  if (total <= 1) return 1;
  return 1 - (index / (total - 1)) * 0.8;
}

// createdAt puo' arrivare come Firestore Timestamp, {seconds,...} grezzo,
// Date o numero: normalizziamo tutto a millisecondi per poter ordinare senza
// dipendere dal chiamante.
function toMillis(value) {
  if (!value) return 0;
  if (typeof value === "number") return value;
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (typeof value?.seconds === "number") return value.seconds * 1000;
  if (value instanceof Date) return value.getTime();
  return 0;
}

function isAlone(rating) {
  return !Array.isArray(rating?.watchedWith) || rating.watchedWith.length === 0;
}

function sortMostRecentFirst(ratings) {
  return [...ratings].sort((a, b) => toMillis(b?.createdAt) - toMillis(a?.createdAt));
}

function computeFrequentCompanions(ratings) {
  const weightByUid = new Map();
  const nameByUid = new Map();

  ratings.forEach((rating, index) => {
    const weight = recencyWeight(index, ratings.length);
    const companions = Array.isArray(rating?.watchedWith) ? rating.watchedWith : [];
    companions.forEach((c) => {
      const uid = String(c?.uid || "").trim();
      if (!uid) return;
      weightByUid.set(uid, (weightByUid.get(uid) || 0) + weight);
      // Il rating piu' recente con questo uid vince il nome mostrato (le
      // review sono gia' ordinate piu'-recenti-prima, quindi first-write-wins).
      if (!nameByUid.has(uid)) {
        const name = String(c?.displayName || "").trim();
        if (name) nameByUid.set(uid, name);
      }
    });
  });

  return Array.from(weightByUid.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_FREQUENT_COMPANIONS)
    .map(([uid, weight]) => ({ uid, displayName: nameByUid.get(uid) || uid, weight }));
}

/**
 * @param {Array<{watchedWith?: Array<{uid:string, displayName?:string}>, type?: string, createdAt?: any}>} ratings
 *   Rating dell'utente a qualunque livello (title/season/episode), in
 *   qualunque ordine — questa funzione li riordina da sola per `createdAt`.
 * @param {{mediaType?: string}} [opts] "movie" | "tv" del titolo che si sta
 *   recensendo: se ci sono abbastanza campioni di quel tipo si usano solo
 *   quelli, altrimenti si ricade su tutti i rating disponibili.
 * @returns {{preselectAlone: boolean, frequentCompanions: Array<{uid:string, displayName:string, weight:number}>}}
 */
export function computeCompanionDefaults(ratings, { mediaType } = {}) {
  const all = Array.isArray(ratings) ? ratings.filter(Boolean) : [];
  if (!all.length) {
    return { preselectAlone: false, frequentCompanions: [] };
  }

  const recent = sortMostRecentFirst(all).slice(0, RECENT_SAMPLE_MAX);

  const sameType = mediaType
    ? recent.filter((r) => String(r?.type || "").toLowerCase() === String(mediaType).toLowerCase())
    : [];
  const scoped = sameType.length >= MIN_SAMPLES ? sameType : recent;

  const preselectAlone = scoped.length >= MIN_SAMPLES
    && (scoped.filter(isAlone).length / scoped.length) >= ALONE_SHARE_THRESHOLD;

  return {
    preselectAlone,
    frequentCompanions: computeFrequentCompanions(scoped),
  };
}
