"use strict";

// Job di ricostruzione dell'indice di similarita' titoli.
//
// Vive qui e non dentro index.js perche' serve da DUE porte: la Cloud Function
// schedulata (piu' la callable admin) e lo script ops
// scripts/rebuild-title-similarities.js. Una sola implementazione, due modi di
// lanciarla — se fossero due copie divergerebbero al primo fix.
//
// Ha I/O (legge e scrive Firestore): la matematica pura sta in lib/itemSimilarity.js.

const { logger } = require("firebase-functions");
const {
  buildItemSimilarityIndex,
  similarityDocFor,
  MAX_ITEMS_PER_USER,
} = require("./itemSimilarity");
const { safeArray, toId, toMillis } = require("./pureUtils");
const { isGuidedUid } = require("../modules/guidedProfiles/guards");

// Doc dell'indice, dentro la sottocollezione server-owned gia' esistente
// `titles/{id}/aggregates` (rules: read isSignedIn, write false).
const TITLE_SIMILAR_DOC_ID = "similar";
// Stati che valgono come segnale positivo: il titolo e' stato davvero
// consumato. `not_started`/`unseen` sono watchlist, cioe' intenzione.
const SIMILARITY_WATCHED_STATES = ["completed_unrated", "seen_unrated", "rated", "in_progress"];
const SIMILARITY_MIN_RATING = 7;

// Raccoglie le interazioni positive di tutti gli utenti: titoli davvero
// consumati (titleStates) piu' i voti alti. E' lo stesso segnale che il
// benchmark offline usa per misurare il guadagno.
async function collectSimilarityInteractions(db, { maxRows = 400000 } = {}) {
  const rowsByPair = new Map();
  const push = (uid, titleId, atMs) => {
    if (!uid || !titleId) return;
    if (isGuidedUid(uid)) return;
    const key = `${uid}\u0000${titleId}`;
    const nextAtMs = atMs || 0;
    const previous = rowsByPair.get(key);
    if (previous) {
      if (nextAtMs > previous.atMs) rowsByPair.set(key, { uid, titleId, atMs: nextAtMs });
      return;
    }
    if (rowsByPair.size >= maxRows) return;
    rowsByPair.set(key, { uid, titleId, atMs: nextAtMs });
  };

  let cursor = null;
  let scanned = 0;
  for (;;) {
    let q = db.collectionGroup("titleStates").orderBy("__name__").limit(2000);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      scanned++;
      const data = doc.data() || {};
      if (!SIMILARITY_WATCHED_STATES.includes(String(data.state || ""))) continue;
      const uid = String(doc.ref.path.split("/")[1] || "").trim();
      push(uid, toId(data.titleId || doc.id), Math.max(toMillis(data.seenAt), toMillis(data.completedAt), toMillis(data.createdAt)));
    }
    cursor = snap.docs[snap.docs.length - 1];
    if (snap.size < 2000 || rowsByPair.size >= maxRows) break;
  }

  let ratingCursor = null;
  for (;;) {
    let q = db.collection("ratings").orderBy("__name__").limit(2000);
    if (ratingCursor) q = q.startAfter(ratingCursor);
    const snap = await q.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      const data = doc.data() || {};
      if (data.isSynthetic === true) continue;
      if (Number(data.rating || 0) < SIMILARITY_MIN_RATING) continue;
      push(String(data.uid || "").trim(), toId(data.titleId), toMillis(data.createdAt));
    }
    ratingCursor = snap.docs[snap.docs.length - 1];
    if (snap.size < 2000 || rowsByPair.size >= maxRows) break;
  }

  return { rows: [...rowsByPair.values()], scanned };
}

// Ricostruisce `titles/{id}/aggregates/similar` per tutto il catalogo.
// Idempotente: riscrive i doc dei titoli che hanno vicini e cancella quelli
// rimasti orfani da una build precedente (se no un titolo che perde i suoi
// legami continuerebbe a consigliarne di vecchi per sempre).
async function rebuildTitleSimilarityIndex(db, admin, { dryRun = false } = {}) {
  const startedAt = Date.now();
  const { rows, scanned } = await collectSimilarityInteractions(db);
  const { index, stats } = buildItemSimilarityIndex(rows, { maxItemsPerUser: MAX_ITEMS_PER_USER });

  if (stats.capReduced) {
    logger.warn(`[similarity] cap per utente ridotto ${stats.requestedItemCap} -> ${stats.effectiveItemCap} per stare nel budget di coppie: valutare una build a shard/incrementale.`);
  }

  const summary = {
    dryRun,
    scannedTitleStates: scanned,
    interactions: rows.length,
    ...stats,
    written: 0,
    deleted: 0,
    durationMs: 0,
  };

  if (dryRun) {
    summary.durationMs = Date.now() - startedAt;
    logger.info(`[similarity] dry-run: ${JSON.stringify(summary)}`);
    return summary;
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  let batch = db.batch();
  let pending = 0;
  const flush = async () => {
    if (!pending) return;
    await batch.commit();
    batch = db.batch();
    pending = 0;
  };

  for (const [titleId, neighbors] of index.entries()) {
    const ref = db.collection("titles").doc(titleId).collection("aggregates").doc(TITLE_SIMILAR_DOC_ID);
    batch.set(ref, similarityDocFor(titleId, neighbors, { updatedAt: now }));
    summary.written++;
    if (++pending >= 400) await flush();
  }
  await flush();

  // Pulizia degli indici non piu' prodotti da questa build.
  const staleSnap = await db.collectionGroup("aggregates").where("version", "==", 1).get()
    .catch((err) => {
      // Degrada senza far fallire la build: nel peggiore dei casi restano indici
      // vecchi, che e' meno grave di non averne affatto.
      logger.warn(`[similarity] cleanup query failed, indici orfani non rimossi: ${err.message}`);
      return null;
    });
  if (staleSnap) {
    for (const doc of staleSnap.docs) {
      if (doc.id !== TITLE_SIMILAR_DOC_ID) continue;
      const titleId = doc.ref.path.split("/")[1];
      if (index.has(titleId)) continue;
      batch.delete(doc.ref);
      summary.deleted++;
      if (++pending >= 400) await flush();
    }
    await flush();
  }

  summary.durationMs = Date.now() - startedAt;
  await db.collection("appConfig").doc("titleSimilarity").set({
    lastRunAt: now,
    ...summary,
  }, { merge: true }).catch((err) => logger.warn(`[similarity] summary write failed: ${err.message}`));

  logger.info(`[similarity] rebuild: ${JSON.stringify(summary)}`);
  return summary;
}

module.exports = {
  TITLE_SIMILAR_DOC_ID,
  SIMILARITY_WATCHED_STATES,
  SIMILARITY_MIN_RATING,
  collectSimilarityInteractions,
  rebuildTitleSimilarityIndex,
};
