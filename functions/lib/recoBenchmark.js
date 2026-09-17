"use strict";

// Harness di valutazione OFFLINE per il motore di raccomandazione.
//
// Perche' esiste: fino a oggi ogni modifica ai pesi dello scoring si giudicava a
// occhio. La fase 5 di docs/TITLE_UPDATES_RECOMMENDATIONS_PLAN.md chiede invece
// che il collaborativo (e qualunque variante) entri in produzione solo se
// migliora NDCG/Recall senza peggiorare copertura e diversita'. Questo modulo e'
// il metro.
//
// Regole che rendono la misura onesta:
//  - **Split temporale, mai casuale**: si allena su cio' che l'utente aveva
//    fatto PRIMA di una data e si valuta su cio' che ha fatto DOPO. Uno split
//    casuale lascerebbe filtrare il futuro nel passato e gonfierebbe i numeri.
//  - **Stesso pool per tutti i modelli**: si confronta il RANKING, non la
//    fortuna di aver pescato candidati diversi.
//  - **Stesse esclusioni per tutti**: via i titoli gia' visti prima del cutoff.
//  - **Deterministico**: PRNG con seed, `nowMs` fisso. Due run identiche danno
//    lo stesso numero, altrimenti non si distingue un miglioramento dal rumore.
//
// Nessun I/O qui dentro: il dataset arriva gia' caricato (vedi
// scripts/export-reco-dataset.js) e resta un oggetto JS.

const {
  buildSeedStats,
  buildTasteProfile,
  buildPeopleAffinity,
  rankMatchCandidates,
  pickMatchDeck,
} = require("./recommendationEngine");
const {
  extractTitleFeatures,
  deltaForAction,
  foldTitleDeltas,
  computeConfidenceScore,
  pruneFeatureSums,
} = require("./tasteProfileAggregate");
const { safeArray, toId, clamp, tokenizeNormalized } = require("./pureUtils");
const {
  buildItemSimilarityIndex,
  collectCollabSignals,
  MAX_COLLAB_SEEDS,
} = require("./itemSimilarity");

// Finestra di recency dei seed, identica a MATCH_SEED_RECENCY_MS in index.js.
const SEED_RECENCY_MS = 180 * 24 * 60 * 60 * 1000;

// Un voto e' "positivo" (cioe' un titolo che e' piaciuto) da 7 in su. Sotto,
// l'utente ha visto il titolo ma non lo consiglierebbe: contarlo come successo
// premierebbe un motore che indovina cosa guarderai e sbaglia cosa ti piacera'.
const DEFAULT_POSITIVE_THRESHOLD = 7;

// mulberry32: PRNG piccolo e deterministico, per riprodurre le run.
function seededRandom(seed) {
  let a = Number(seed) >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- split

// I voti in Somto esistono a tre livelli (title/season/episode) e sullo storico
// reale quelli per stagione sono la maggioranza. Qui si collassa a UN voto per
// (utente, titolo): tenere piu' righe dello stesso titolo lo farebbe contare piu'
// volte sia nello storico sia nella verita' di riferimento, gonfiando le
// metriche. Si tiene il voto piu' alto — e' quello che esprime "mi e' piaciuto" —
// con il timestamp della riga scelta.
//
// `levels`: "title" resta fedele a quello che i seed leggono oggi in produzione
// (loadUserRatingSeedScores filtra level=="title"); "all" usa tutti i livelli.
function collapseRatingsByTitle(rows, { levels = "title" } = {}) {
  const best = new Map();
  for (const row of safeArray(rows)) {
    const level = String(row?.level || "title");
    if (levels === "title" && level !== "title") continue;
    const uid = toId(row?.uid);
    const titleId = toId(row?.titleId);
    const rating = Number(row?.rating || 0);
    const atMs = Number(row?.atMs || 0);
    if (!uid || !titleId || !Number.isFinite(rating) || rating <= 0 || !atMs) continue;

    const key = `${uid}\u0000${titleId}`;
    const prev = best.get(key);
    if (!prev || rating > prev.rating) {
      best.set(key, { uid, titleId, rating, atMs });
    }
  }
  return [...best.values()].sort((a, b) => a.atMs - b.atMs);
}


// Divide le interazioni su una data. `atMs` e' gia' normalizzato in millisecondi
// dall'exporter.
function splitTemporal(ratings, cutoffMs) {
  const cutoff = Number(cutoffMs);
  const train = [];
  const test = [];
  for (const row of safeArray(ratings)) {
    const at = Number(row?.atMs || 0);
    if (!at) continue;
    if (at < cutoff) train.push(row);
    else test.push(row);
  }
  return { train, test };
}

// Sceglie il cutoff che lascia `testFraction` delle interazioni nel futuro.
// Meglio di una data fissa scelta a mano: si adatta a com'e' distribuito lo
// storico reale invece di produrre uno split vuoto.
function pickCutoffByQuantile(ratings, testFraction = 0.2) {
  const times = safeArray(ratings)
    .map((r) => Number(r?.atMs || 0))
    .filter((t) => t > 0)
    .sort((a, b) => a - b);
  if (!times.length) return 0;
  const frac = clamp(Number(testFraction) || 0.2, 0.02, 0.9);
  const idx = Math.floor(times.length * (1 - frac));
  return times[Math.min(idx, times.length - 1)];
}

function groupByUid(rows) {
  const out = new Map();
  for (const row of safeArray(rows)) {
    const uid = toId(row?.uid);
    if (!uid) continue;
    if (!out.has(uid)) out.set(uid, []);
    out.get(uid).push(row);
  }
  return out;
}

// Utenti valutabili: abbastanza storico prima del cutoff per costruire un
// profilo, e almeno un titolo che gli e' piaciuto dopo. Chi non ha futuro
// positivo non e' misurabile — includerlo abbasserebbe tutte le metriche
// allo stesso modo, senza dire nulla su quale motore e' migliore.
function buildEvalUsers({ train, test, minTrain = 5, minTestPositives = 1, positiveThreshold = DEFAULT_POSITIVE_THRESHOLD } = {}) {
  const trainByUid = groupByUid(train);
  const testByUid = groupByUid(test);
  const out = [];

  for (const [uid, testRows] of testByUid.entries()) {
    const trainRows = trainByUid.get(uid) || [];
    if (trainRows.length < minTrain) continue;

    const positives = new Set();
    for (const row of testRows) {
      if (Number(row.rating || 0) >= positiveThreshold) positives.add(toId(row.titleId));
    }
    positives.delete("");
    if (positives.size < minTestPositives) continue;

    out.push({
      uid,
      trainRows: trainRows.slice().sort((a, b) => Number(a.atMs || 0) - Number(b.atMs || 0)),
      seenTitleIds: new Set(trainRows.map((r) => toId(r.titleId)).filter(Boolean)),
      positives,
    });
  }

  out.sort((a, b) => (b.trainRows.length - a.trainRows.length) || (a.uid < b.uid ? -1 : 1));
  return out;
}


// Stati che significano "l'ha davvero guardato". `not_started`/`unseen` sono
// watchlist: intenzione, non consumo — restano fuori dalla verita' di
// riferimento (se no si misurerebbe "indovina cosa salvera'", non "cosa
// guardera'").
const WATCHED_STATES = new Set(["completed_unrated", "seen_unrated", "rated", "in_progress"]);

// Normalizza voti e stati titolo in una sola lista di interazioni:
//   { uid, titleId, kind: "rating"|"watched", rating, positive, atMs }
// Una interazione per (utente, titolo): il voto esplicito, quando c'e', vince
// sullo stato implicito perche' porta piu' informazione (puo' anche essere
// negativo).
function buildInteractions({ ratings = [], watched = [], levels = "title", positiveThreshold = DEFAULT_POSITIVE_THRESHOLD, useWatched = true, useRatings = true } = {}) {
  const out = new Map();
  const key = (uid, titleId) => `${uid}\u0000${titleId}`;

  if (useWatched) {
    for (const row of safeArray(watched)) {
      const uid = toId(row?.uid);
      const titleId = toId(row?.titleId);
      const atMs = Number(row?.atMs || 0);
      if (!uid || !titleId || !atMs) continue;
      if (!WATCHED_STATES.has(String(row?.state || ""))) continue;
      out.set(key(uid, titleId), { uid, titleId, kind: "watched", rating: 0, positive: true, atMs });
    }
  }

  if (useRatings) {
    for (const row of collapseRatingsByTitle(ratings, { levels })) {
      out.set(key(row.uid, row.titleId), {
        uid: row.uid,
        titleId: row.titleId,
        kind: "rating",
        rating: row.rating,
        positive: row.rating >= positiveThreshold,
        atMs: row.atMs,
      });
    }
  }

  return [...out.values()].sort((a, b) => a.atMs - b.atMs);
}

// Holdout per utente, NON temporale.
//
// Serve perche' su questo dataset i timestamp degli stati titolo importati
// valgono la data dell'import, non della visione: uno split "temporale" li' non
// sarebbe piu' vero di uno casuale, si limiterebbe a nasconderlo. Questa
// modalita' e' esplicitamente etichettata come non-temporale nei report, cosi'
// nessuno la scambia per la misura pulita.
function buildHoldoutUsers({ interactions, testFraction = 0.2, minTrain = 5, minTestPositives = 1, random = Math.random } = {}) {
  const byUid = groupByUid(interactions);
  const out = [];

  for (const [uid, rows] of byUid.entries()) {
    const shuffled = rows.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const testSize = Math.max(1, Math.round(shuffled.length * clamp(testFraction, 0.05, 0.5)));
    const testRows = shuffled.slice(0, testSize);
    const trainRows = shuffled.slice(testSize);
    if (trainRows.length < minTrain) continue;

    const positives = new Set(testRows.filter((r) => r.positive).map((r) => r.titleId));
    if (positives.size < minTestPositives) continue;

    out.push({
      uid,
      trainRows: trainRows.slice().sort((a, b) => a.atMs - b.atMs),
      // SOLO le righe di training: mettere qui anche il test escluderebbe dai
      // consigli proprio i titoli che stiamo cercando di indovinare, e ogni
      // modello farebbe zero per costruzione.
      seenTitleIds: new Set(trainRows.map((r) => r.titleId)),
      positives,
    });
  }

  out.sort((a, b) => (b.trainRows.length - a.trainRows.length) || (a.uid < b.uid ? -1 : 1));
  return out;
}

// Ricostruisce il catalogo visibile al momento della predizione. I conteggi
// aggregati esportati da `titles` descrivono il presente e, in uno split
// temporale, includono anche voti arrivati dopo il cutoff. Usarli nel pool o
// nella baseline farebbe filtrare il futuro. Qui ratingCount/ratingAvg sono
// derivati esclusivamente dalle interazioni di training; i titoli creati dopo
// il cutoff non sono candidati.
function buildEvaluationCatalog(rawTitles, trainRows, { cutoffMs = 0, temporal = false } = {}) {
  const ratingStats = new Map();
  const popularityByTitle = new Map();
  const trainUsers = new Set();

  for (const row of safeArray(trainRows)) {
    const uid = toId(row?.uid);
    const titleId = toId(row?.titleId);
    if (!uid || !titleId) continue;
    trainUsers.add(uid);
    popularityByTitle.set(titleId, (popularityByTitle.get(titleId) || 0) + 1);
    if (row?.kind !== "rating") continue;
    const rating = Number(row?.rating || 0);
    if (!(rating > 0)) continue;
    const prev = ratingStats.get(titleId) || { count: 0, sum: 0 };
    prev.count++;
    prev.sum += rating;
    ratingStats.set(titleId, prev);
  }

  const byId = new Map();
  for (const raw of safeArray(rawTitles)) {
    const id = toId(raw?.id);
    if (!id) continue;
    const createdAtMs = Number(raw?.createdAtMs || 0);
    if (temporal && cutoffMs > 0 && createdAtMs > 0 && createdAtMs >= cutoffMs) continue;
    const stat = ratingStats.get(id);
    byId.set(id, {
      ...raw,
      ratingCount: stat?.count || 0,
      ratingAvg: stat?.count ? (stat.sum / stat.count) : 0,
    });
  }

  const rows = [...byId.values()];
  const byPopularity = rows.slice().sort((a, b) =>
    (Number(b.ratingCount || 0) - Number(a.ratingCount || 0))
    || (Number(b.ratingAvg || 0) - Number(a.ratingAvg || 0))
    || (toId(a.id) < toId(b.id) ? -1 : 1));
  const byRecency = rows.slice().sort((a, b) =>
    (Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0))
    || (toId(a.id) < toId(b.id) ? -1 : 1));

  return {
    byId,
    byPopularity,
    byRecency,
    popularityByTitle,
    totalTrainUsers: trainUsers.size,
  };
}

function restrictEvalUsersToCatalog(evalUsers, titlesById) {
  return safeArray(evalUsers).map((user) => ({
    ...user,
    positives: new Set([...user.positives].filter((id) => titlesById.has(toId(id)))),
  })).filter((user) => user.positives.size > 0);
}

// ------------------------------------------------------- profilo utente

// Ricostruisce users/{uid}/tasteProfile/agg dallo storico pre-cutoff, con la
// STESSA matematica del trigger di produzione (lib/tasteProfileAggregate).
function buildOfflineTasteProfile(trainRows, titlesById, nowMs) {
  const inputs = [];
  for (const row of safeArray(trainRows)) {
    const title = titlesById.get(toId(row.titleId));
    if (!title) continue;
    // Voto esplicito -> delta del voto. Riga implicita (visto senza voto) ->
    // "import_seen", esattamente come fa applyImportTasteProfile in produzione.
    const delta = row.kind === "watched"
      ? deltaForAction("import_seen")
      : deltaForAction("rating", row.rating);
    if (!delta) continue;
    inputs.push({ features: extractTitleFeatures(title), delta, createdAt: Number(row.atMs || 0) });
  }
  const { featureSums } = foldTitleDeltas({}, inputs);
  pruneFeatureSums(featureSums);
  return buildTasteProfile(
    { featureSums, confidenceScore: computeConfidenceScore(featureSums, 0) },
    nowMs
  );
}

// Seed dell'utente: replica loadUserRatingSeedScores + loadMatchSeedTitleIds di
// index.js (voto >= 6, boost di recency su 180 giorni, top 42 -> primi 18 ->
// resolveSeedTitles ne tiene 8).
function buildOfflineSeeds(trainRows, titlesById, nowMs) {
  const scoreMap = new Map();
  // Le righe implicite pesano come in loadUserLibrarySeedScores (0.65 + freschezza
  // * 0.8): un titolo in libreria e' un seed piu' debole di un voto alto.
  const watchedRows = safeArray(trainRows).filter((r) => r.kind === "watched");
  const watchedOrder = watchedRows.slice().sort((a, b) => Number(b.atMs || 0) - Number(a.atMs || 0));

  for (const row of safeArray(trainRows)) {
    const titleId = toId(row.titleId);
    if (!titleId) continue;
    if (row.kind === "watched") continue;
    const rating = Number(row.rating || 0);
    if (!Number.isFinite(rating) || rating < 6) continue;
    const tsMs = Number(row.atMs || 0);
    const recencyBoost = tsMs ? clamp(1 - ((nowMs - tsMs) / SEED_RECENCY_MS), 0, 1) : 0;
    const score = ((rating - 5) * 1.45) + (recencyBoost * 1.2);
    scoreMap.set(titleId, (scoreMap.get(titleId) || 0) + score);
  }

  watchedOrder.forEach((row, i) => {
    const titleId = toId(row.titleId);
    if (!titleId) return;
    const freshness = clamp(1 - (i / 220), 0, 1);
    scoreMap.set(titleId, (scoreMap.get(titleId) || 0) + 0.65 + (freshness * 0.8));
  });

  const ranked = [...scoreMap.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1)).slice(0, 42);
  const seedIds = ranked.slice(0, 18).map(([titleId]) => titleId);
  const seedTitles = seedIds
    .map((id) => titlesById.get(id))
    .filter(Boolean)
    .slice(0, 8);

  return { seedTitles, seedScoreByTitle: new Map(ranked) };
}

// --------------------------------------------------------------- pool

// Replica offline di collectCandidatePool: popolari, recenti, stessi generi,
// token in comune, correlati. Serve la stessa forma del pool di produzione,
// altrimenti si misurerebbe un motore che in prod non vede mai quei candidati.
function buildOfflineCandidatePool(titles, seedTitles, opts = {}) {
  const popularLimit = clamp(Number(opts.popularLimit || 450), 60, 700);
  const recentLimit = clamp(Number(opts.recentLimit || 220), 60, 420);
  const genreLimit = clamp(Number(opts.genreLimit || 260), 70, 420);
  const tokenLimit = clamp(Number(opts.tokenLimit || 220), 70, 380);
  const relatedLimit = clamp(Number(opts.relatedLimit || 80), 20, 120);

  const pool = new Map();
  const add = (title) => {
    const id = toId(title?.id);
    if (id) pool.set(id, title);
  };

  const byPopularity = opts.byPopularity || [];
  const byRecency = opts.byRecency || [];
  byPopularity.slice(0, popularLimit).forEach(add);
  byRecency.slice(0, recentLimit).forEach(add);

  const topGenres = new Set(
    Array.from(new Set(seedTitles.flatMap((t) => safeArray(t.genres)).filter(Boolean))).slice(0, 10)
  );
  if (topGenres.size) {
    let taken = 0;
    for (const title of byPopularity) {
      if (taken >= genreLimit) break;
      if (safeArray(title.genres).some((g) => topGenres.has(g))) {
        add(title);
        taken++;
      }
    }
  }

  const seedTokens = new Set(
    Array.from(new Set(
      seedTitles.flatMap((t) => tokenizeNormalized([t.name, t.originalName, t.description].join(" ")))
    )).slice(0, 10)
  );
  if (seedTokens.size) {
    let taken = 0;
    for (const title of byPopularity) {
      if (taken >= tokenLimit) break;
      const tokens = safeArray(title?.search?.tokens);
      if (tokens.some((tok) => seedTokens.has(tok))) {
        add(title);
        taken++;
      }
    }
  }

  const relatedIds = Array.from(new Set(
    seedTitles.flatMap((t) => safeArray(t.related)).map(toId).filter(Boolean)
  )).slice(0, relatedLimit);
  for (const rid of relatedIds) {
    const title = titles.byId.get(rid);
    if (title) add(title);
  }

  return pool;
}

// -------------------------------------------------------------- modelli

// Baseline: i titoli piu' votati, senza personalizzazione. Se un motore
// personalizzato non la batte, non sta aggiungendo niente.
function recommendPopularity({ pool, excluded, k }) {
  return Array.from(pool.values())
    .filter((t) => !excluded.has(toId(t.id)))
    .sort((a, b) =>
      (Number(b.ratingCount || 0) - Number(a.ratingCount || 0))
      || (Number(b.ratingAvg || 0) - Number(a.ratingAvg || 0))
      || (toId(a.id) < toId(b.id) ? -1 : 1)
    )
    .slice(0, k)
    .map((t) => toId(t.id));
}

// Il motore di produzione. `applyDeck` riproduce anche pickMatchDeck (quindi il
// 20% di esplorazione e la diversificazione per saga): serve per misurare quanto
// costa in accuratezza la varieta' che il deck introduce di proposito.
function recommendSomto({ pool, excluded, k, seedStats, seedCount, peopleAffinity, tasteProfile, collabSignals, applyDeck, random, nowMs }) {
  const { scored } = rankMatchCandidates({
    candidates: pool,
    excludedIds: excluded,
    seedStats,
    seedCount,
    peopleAffinity,
    tasteProfile,
    collabSignals,
    genreLabelMap: null,
    max: k,
  });

  if (!applyDeck) return scored.slice(0, k).map((r) => toId(r.id));
  return pickMatchDeck(scored, k, { random, nowMs }).map((r) => toId(r.id));
}

// Collaborativo item-item. NON e' una seconda implementazione: delega a
// lib/itemSimilarity.js, lo stesso modulo che alimenta l'indice precalcolato in
// produzione. Se qui e la' fossero due copie, il benchmark misurerebbe un
// modello che non verra' mai servito.
function buildItemKnnIndex(trainRows, { positiveThreshold = DEFAULT_POSITIVE_THRESHOLD, maxNeighbors = 60, minCoOccurrence = 2, maxItemsPerUser } = {}) {
  const positives = safeArray(trainRows).filter((row) => {
    if (row?.positive !== undefined) return row.positive === true;
    return Number(row?.rating || 0) >= positiveThreshold;
  });
  const { index, stats } = buildItemSimilarityIndex(positives, { maxNeighbors, minCoOccurrence, maxItemsPerUser });
  return { neighbors: index, stats };
}

// Segnali collaborativi per un utente, con lo STESSO accumulo di produzione
// (numero di seed interrogati incluso: ogni seed a runtime e' una lettura).
function collabSignalsFor(index, likedTitleIds, { maxSeeds, excludedIds, scale } = {}) {
  return collectCollabSignals(
    likedTitleIds,
    (titleId) => index.neighbors.get(titleId),
    { maxSeeds, excludedIds, scale }
  );
}

function recommendItemKnn({ pool, excluded, k, likedTitleIds, index, maxSeeds }) {
  // Qui la scala non conta: itemknn ordina solo per punteggio collaborativo.
  const signals = collabSignalsFor(index, likedTitleIds, { maxSeeds, excludedIds: excluded, scale: 1 });
  return [...signals.entries()]
    .filter(([titleId]) => pool.has(titleId))
    .sort((a, b) => (b[1].score - a[1].score) || (a[0] < b[0] ? -1 : 1))
    .slice(0, k)
    .map(([titleId]) => titleId);
}

// ------------------------------------------------------------- metriche

function recallAtK(recommended, positives, k) {
  if (!positives.size) return 0;
  let hits = 0;
  for (const id of recommended.slice(0, k)) if (positives.has(id)) hits++;
  return hits / positives.size;
}

function precisionAtK(recommended, positives, k) {
  if (!k) return 0;
  let hits = 0;
  for (const id of recommended.slice(0, k)) if (positives.has(id)) hits++;
  return hits / k;
}

// NDCG con rilevanza binaria: premia i successi che stanno in cima alla lista.
function ndcgAtK(recommended, positives, k) {
  if (!positives.size) return 0;
  let dcg = 0;
  recommended.slice(0, k).forEach((id, idx) => {
    if (positives.has(id)) dcg += 1 / Math.log2(idx + 2);
  });
  let idcg = 0;
  const ideal = Math.min(positives.size, k);
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);
  return idcg > 0 ? (dcg / idcg) : 0;
}

function averagePrecisionAtK(recommended, positives, k) {
  if (!positives.size) return 0;
  let hits = 0;
  let sum = 0;
  recommended.slice(0, k).forEach((id, idx) => {
    if (positives.has(id)) {
      hits++;
      sum += hits / (idx + 1);
    }
  });
  const denom = Math.min(positives.size, k);
  return denom > 0 ? (sum / denom) : 0;
}

// Diversita' intra-lista: 1 - Jaccard medio sui generi fra tutte le coppie.
// Una lista di 10 cloni fa 0, una lista di 10 generi diversi fa 1.
function listDiversity(recommended, titlesById) {
  const rows = recommended.map((id) => titlesById.get(id)).filter(Boolean);
  if (rows.length < 2) return 0;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = new Set(safeArray(rows[i].genres).map(String));
      const b = new Set(safeArray(rows[j].genres).map(String));
      if (!a.size && !b.size) continue;
      let inter = 0;
      for (const g of a) if (b.has(g)) inter++;
      const union = a.size + b.size - inter;
      sum += union > 0 ? (1 - (inter / union)) : 0;
      pairs++;
    }
  }
  return pairs ? (sum / pairs) : 0;
}

// Novelty: quanto sono "di nicchia" i consigli. Un motore che consiglia sempre i
// 10 blockbuster ha novelty bassa anche con recall decente.
function listNovelty(recommended, popularityByTitle, totalUsers) {
  if (!recommended.length || !totalUsers) return 0;
  let sum = 0;
  for (const id of recommended) {
    const pop = Math.max(1, Number(popularityByTitle.get(id) || 1));
    sum += -Math.log2(pop / totalUsers);
  }
  return sum / recommended.length;
}

function mean(values) {
  const arr = safeArray(values).filter((v) => Number.isFinite(v));
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// Aggrega le liste per-utente in un blocco di metriche confrontabile.
function summarizeRuns({ runs, titlesById, catalogSize, popularityByTitle, totalUsers, k }) {
  const covered = new Set();
  for (const run of runs) for (const id of run.recommended) covered.add(id);

  return {
    users: runs.length,
    [`recall@${k}`]: mean(runs.map((r) => recallAtK(r.recommended, r.positives, k))),
    [`precision@${k}`]: mean(runs.map((r) => precisionAtK(r.recommended, r.positives, k))),
    [`ndcg@${k}`]: mean(runs.map((r) => ndcgAtK(r.recommended, r.positives, k))),
    [`map@${k}`]: mean(runs.map((r) => averagePrecisionAtK(r.recommended, r.positives, k))),
    hitRate: runs.length
      ? runs.filter((r) => r.recommended.slice(0, k).some((id) => r.positives.has(id))).length / runs.length
      : 0,
    coverage: catalogSize ? (covered.size / catalogSize) : 0,
    diversity: mean(runs.map((r) => listDiversity(r.recommended, titlesById))),
    novelty: mean(runs.map((r) => listNovelty(r.recommended, popularityByTitle, totalUsers))),
    emptyLists: runs.filter((r) => !r.recommended.length).length,
  };
}

module.exports = {
  SEED_RECENCY_MS,
  WATCHED_STATES,
  collapseRatingsByTitle,
  buildInteractions,
  buildHoldoutUsers,
  buildEvaluationCatalog,
  restrictEvalUsersToCatalog,
  DEFAULT_POSITIVE_THRESHOLD,
  seededRandom,
  splitTemporal,
  pickCutoffByQuantile,
  groupByUid,
  buildEvalUsers,
  buildOfflineTasteProfile,
  buildOfflineSeeds,
  buildOfflineCandidatePool,
  recommendPopularity,
  recommendSomto,
  buildItemKnnIndex,
  collabSignalsFor,
  recommendItemKnn,
  recallAtK,
  precisionAtK,
  ndcgAtK,
  averagePrecisionAtK,
  listDiversity,
  listNovelty,
  mean,
  summarizeRuns,
  buildSeedStats,
  buildPeopleAffinity,
  MAX_COLLAB_SEEDS,
};
