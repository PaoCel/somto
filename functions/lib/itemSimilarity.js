"use strict";

// Indice di similarita' item-item PRECALCOLATO.
//
// Sostituisce `computeCollaborativeSignals` di index.js, che a ogni apertura di
// Match rilegge la collection `ratings` per 5 titoli seed (cap 320 doc l'uno) e
// poi per i 24 utenti piu' simili (cap 220 doc l'uno): fino a ~6.9k letture per
// singola richiesta, con un costo che cresce insieme al catalogo e agli utenti.
// Qui il lavoro si fa UNA volta (job schedulato) e a runtime restano poche
// letture per id — costo per richiesta O(seed), indipendente da quanto cresce
// il resto.
//
// Il benchmark offline (docs/reco-benchmarks/) misura questo stesso codice: la
// funzione di accumulo `collectCollabSignals` e' condivisa fra benchmark e
// produzione, cosi' il numero misurato e' quello che poi gira davvero.
//
// Nessun I/O qui dentro: chi chiama passa le interazioni gia' caricate.

const { safeArray, toId, clamp } = require("./pureUtils");

// Tetto di item per utente nella costruzione. Il costo delle co-occorrenze e'
// O(somma |item(u)|^2): un solo power user con 3.100 titoli varrebbe da solo
// ~4,8M coppie. Si tengono i piu' recenti — sono anche i piu' rappresentativi
// del gusto attuale.
const MAX_ITEMS_PER_USER = 400;

// Sotto le 2 co-visioni un legame e' rumore: due sconosciuti che hanno visto lo
// stesso titolo non dicono niente.
const MIN_CO_OCCURRENCE = 2;

// Vicini tenuti per titolo. 40 sta largamente dentro il limite doc Firestore e
// oltre il 40esimo la similarita' e' gia' piatta.
const MAX_NEIGHBORS = 40;

// Seed usati a runtime per interrogare l'indice: ogni seed e' una lettura.
// `resolveSeedTitles` ne materializza al massimo 8; tenere lo stesso limite qui
// rende benchmark e produzione equivalenti e limita il costo a 8 letture.
const MAX_COLLAB_SEEDS = 8;

// Scala del punteggio collaborativo. `scoreCandidate` fa
// clamp(collab.score * 0.8, 0, 4.8): quel bonus era tarato sui valori del
// vecchio computeCollaborativeSignals, che stavano nell'ordine delle unita'.
// Il coseno sta fra 0 e 1, quindi senza riscalare il segnale collaborativo
// verrebbe schiacciato dal punteggio di genere. La scala 6 resta la
// configurazione validata dalla run corretta a parita' di seed
// (NDCG@10 0.097 -> 0.147 sull'ibrido).
const COLLAB_SCORE_SCALE = 6;

// Tetto di coppie tenute in memoria durante la build. Il costo e'
// O(somma min(item(u), cap)^2): cresce col NUMERO di utenti, quindi un valore
// che oggi sta comodo fra un anno non ci sta piu'. Invece di scoprirlo con un
// OOM in produzione, il builder stima le coppie e abbassa da solo il cap per
// utente finche' rientra (vedi resolveItemCapForBudget), loggando la riduzione:
// quando compare nei log e' il segnale che serve una build a shard/incrementale.
//
// Il valore e' misurato, non a naso: sul dataset prod del 2026-08-02 (202 utenti,
// 54.590 interazioni positive) la build fa 6,0M coppie e 726 MB di RSS, cioe'
// ~121 byte a coppia. Con la function a 2GB, 9M coppie stanno intorno a 1,1 GB e
// lasciano margine. Se il cap comincia a scendere nei log, e' ora di passare a
// una build incrementale invece di alzare questo numero.
const PAIR_BUDGET = 9_000_000;

const INDEX_VERSION = 1;

// Coppie generate da un cap: somma di min(n, cap)^2 / 2 su tutti gli utenti.
function projectedPairs(itemCounts, cap) {
  let total = 0;
  for (const n of itemCounts) {
    const k = Math.min(n, cap);
    if (k > 1) total += (k * (k - 1)) / 2;
  }
  return total;
}

// Il cap piu' alto (<= maxCap) che sta dentro il budget. Ricerca binaria: la
// funzione e' monotona crescente nel cap.
function resolveItemCapForBudget(itemCounts, maxCap, pairBudget = PAIR_BUDGET) {
  const counts = safeArray(itemCounts).map((n) => Number(n) || 0);
  if (!counts.length) return maxCap;
  if (projectedPairs(counts, maxCap) <= pairBudget) return maxCap;

  let lo = 2;
  let hi = maxCap;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (projectedPairs(counts, mid) <= pairBudget) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// Costruisce l'indice da una lista di interazioni positive:
//   [{ uid, titleId }]
// Il chiamante decide cosa e' positivo (voto alto, titolo completato...).
// Ritorna Map<titleId, [{ id, score }]> con score = coseno sulle co-occorrenze.
function buildItemSimilarityIndex(interactions, opts = {}) {
  const maxItemsPerUser = clamp(Number(opts.maxItemsPerUser || MAX_ITEMS_PER_USER), 10, 5000);
  const minCoOccurrence = clamp(Number(opts.minCoOccurrence ?? MIN_CO_OCCURRENCE), 1, 50);
  const maxNeighbors = clamp(Number(opts.maxNeighbors || MAX_NEIGHBORS), 5, 200);

  // Item per utente, gia' potati. `atMs` opzionale: se c'e' si tengono i piu'
  // recenti, se no i primi incontrati (ordine stabile).
  const rowsByUser = new Map();
  for (const row of safeArray(interactions)) {
    const uid = toId(row?.uid);
    const titleId = toId(row?.titleId);
    if (!uid || !titleId) continue;
    if (!rowsByUser.has(uid)) rowsByUser.set(uid, new Map());
    const bucket = rowsByUser.get(uid);
    const atMs = Number(row?.atMs || 0);
    const prev = bucket.get(titleId);
    if (!prev || atMs > prev) bucket.set(titleId, atMs);
  }

  // Cap effettivo: quello richiesto, oppure ridotto se lo storico e' cresciuto
  // al punto da sfondare il budget di coppie.
  const pairBudget = Number(opts.pairBudget) > 0 ? Number(opts.pairBudget) : PAIR_BUDGET;
  const effectiveCap = resolveItemCapForBudget(
    [...rowsByUser.values()].map((b) => b.size),
    maxItemsPerUser,
    pairBudget
  );

  const itemsByUser = new Map();
  const userCountByItem = new Map();
  for (const [uid, bucket] of rowsByUser.entries()) {
    const items = [...bucket.entries()]
      .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
      .slice(0, effectiveCap)
      .map(([titleId]) => titleId);
    if (items.length < 2) continue;
    itemsByUser.set(uid, items);
    for (const id of items) userCountByItem.set(id, (userCountByItem.get(id) || 0) + 1);
  }

  // Co-occorrenze solo fra item dello stesso utente.
  const cooc = new Map();
  let pairs = 0;
  for (const items of itemsByUser.values()) {
    for (let i = 0; i < items.length; i++) {
      const a = items[i];
      let rowA = cooc.get(a);
      if (!rowA) { rowA = new Map(); cooc.set(a, rowA); }
      for (let j = i + 1; j < items.length; j++) {
        const b = items[j];
        let rowB = cooc.get(b);
        if (!rowB) { rowB = new Map(); cooc.set(b, rowB); }
        rowA.set(b, (rowA.get(b) || 0) + 1);
        rowB.set(a, (rowB.get(a) || 0) + 1);
        pairs++;
      }
    }
  }

  const index = new Map();
  for (const [item, others] of cooc.entries()) {
    const normA = Math.sqrt(userCountByItem.get(item) || 1);
    const neighbors = [];
    for (const [other, count] of others.entries()) {
      if (count < minCoOccurrence) continue;
      const normB = Math.sqrt(userCountByItem.get(other) || 1);
      neighbors.push({ id: other, score: count / (normA * normB), count });
    }
    if (!neighbors.length) continue;
    neighbors.sort((x, y) => (y.score - x.score) || (x.id < y.id ? -1 : 1));
    index.set(item, neighbors.slice(0, maxNeighbors).map((n) => ({
      id: n.id,
      // 4 decimali: la precisione oltre non cambia un ordinamento e fa pesare
      // il doc il doppio.
      score: Math.round(n.score * 10000) / 10000,
      count: n.count,
    })));
  }

  return {
    index,
    stats: {
      users: itemsByUser.size,
      items: userCountByItem.size,
      pairs,
      indexedItems: index.size,
      requestedItemCap: maxItemsPerUser,
      effectiveItemCap: effectiveCap,
      capReduced: effectiveCap < maxItemsPerUser,
    },
  };
}

// Forma del doc `titles/{titleId}/aggregates/similar`. Sottocollezione gia'
// esistente e gia' server-owned nelle rules (read isSignedIn / write false):
// nessuna regola nuova, nessuna superficie nuova da revisionare.
function similarityDocFor(titleId, neighbors, { updatedAt = null, source = "cooccurrence" } = {}) {
  return {
    titleId: toId(titleId),
    neighbors: safeArray(neighbors).map((n) => ({ id: toId(n.id), score: Number(n.score) || 0 })),
    version: INDEX_VERSION,
    source,
    updatedAt,
  };
}

// Accumulo a runtime: dai titoli seed dell'utente ai candidati consigliati.
//
// `neighborsOf(titleId)` ritorna la lista di vicini (dall'indice in memoria nel
// benchmark, dai doc Firestore in produzione). Stessa funzione nei due mondi:
// e' cio' che rende trasferibile il numero misurato offline.
//
// Ritorna Map<titleId, { score, voters, similarCommon }>, la stessa forma che
// `scoreCandidate` si aspetta gia' oggi da computeCollaborativeSignals.
function collectCollabSignals(seedTitleIds, neighborsOf, opts = {}) {
  const maxSeeds = clamp(Number(opts.maxSeeds || MAX_COLLAB_SEEDS), 1, 60);
  const scale = Number.isFinite(Number(opts.scale)) ? Number(opts.scale) : COLLAB_SCORE_SCALE;
  const excluded = opts.excludedIds instanceof Set ? opts.excludedIds : new Set();
  const out = new Map();

  const seeds = Array.from(new Set(safeArray(seedTitleIds).map(toId).filter(Boolean))).slice(0, maxSeeds);
  for (const seedId of seeds) {
    const neighbors = typeof neighborsOf === "function" ? neighborsOf(seedId) : null;
    for (const neighbor of safeArray(neighbors)) {
      const id = toId(neighbor?.id);
      const score = Number(neighbor?.score || 0);
      if (!id || !(score > 0)) continue;
      if (id === seedId || excluded.has(id)) continue;
      const prev = out.get(id) || { score: 0, voters: 0, similarCommon: 0 };
      out.set(id, {
        score: prev.score + (score * scale),
        voters: prev.voters + 1,
        similarCommon: Math.max(prev.similarCommon, Number(neighbor?.count || 0)),
      });
    }
  }

  return out;
}

module.exports = {
  MAX_ITEMS_PER_USER,
  MIN_CO_OCCURRENCE,
  MAX_NEIGHBORS,
  MAX_COLLAB_SEEDS,
  COLLAB_SCORE_SCALE,
  PAIR_BUDGET,
  projectedPairs,
  resolveItemCapForBudget,
  INDEX_VERSION,
  buildItemSimilarityIndex,
  similarityDocFor,
  collectCollabSignals,
};
