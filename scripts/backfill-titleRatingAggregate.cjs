#!/usr/bin/env node
/**
 * backfill-titleRatingAggregate.js
 *
 * Backfill di `titles/{id}.ratingAggregate` (denormalizzazione dei voti
 * community per titolo). Va eseguito UNA VOLTA dopo il deploy del trigger
 *   exports.recomputeTitleRatingAggregate
 * per popolare l'aggregato storico (il trigger gestisce solo i delta nuovi).
 *
 * Schema scritto sul doc titolo:
 *   ratingAggregate = {
 *     titleLevel: { sum, count, avg },
 *     bySeason:   { "1": { sum, count, avg }, "2": { ... }, ... },
 *     combined:   number (media pesata title + tutte le stagioni, 2 dec)
 *   }
 *
 * Modello `combined`:
 *   combined = (titleLevel.sum + Σ bySeason[*].sum)
 *            / (titleLevel.count + Σ bySeason[*].count)
 * Trasparente, defensible: ogni voto pesa 1, indipendentemente dal livello.
 *
 * Idempotente: rieseguire l'intero script ricalcola da zero gli aggregati per
 * tutti i titoli con almeno una review presente in `/ratings`. Sicuro anche
 * con writes concorrenti (il trigger applica delta sopra il valore corrente).
 *
 * Uso:
 *   cd functions   # serve l'admin SDK già installato qui
 *   node ../scripts/backfill-titleRatingAggregate.js            # dry-run
 *   node ../scripts/backfill-titleRatingAggregate.js --write    # applica
 *
 * NON eseguire come parte del commit: deploy del trigger prima, backfill dopo.
 */

const admin = require("firebase-admin");

const WRITE = process.argv.includes("--write");
const CONCURRENCY = 8;        // titoli processati in parallelo
const LOG_EVERY = 200;        // log progress

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

function makeBucket() {
  return { sum: 0, count: 0, avg: 0 };
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

async function computeAggregateForTitle(titleId) {
  const snap = await db.collection("ratings")
    .where("titleId", "==", titleId)
    .get();

  const agg = {
    titleLevel: makeBucket(),
    bySeason: {},
    combined: 0,
  };

  snap.forEach((doc) => {
    const r = doc.data() || {};
    const value = Number(r.rating);
    if (!Number.isFinite(value)) return;

    if (r.level === "title") {
      agg.titleLevel.sum += value;
      agg.titleLevel.count += 1;
    } else if (r.level === "season") {
      const seasonNum = Number(r.season);
      if (!Number.isFinite(seasonNum)) return;
      const key = String(seasonNum);
      if (!agg.bySeason[key]) agg.bySeason[key] = makeBucket();
      agg.bySeason[key].sum += value;
      agg.bySeason[key].count += 1;
    }
    // episode-level intenzionalmente fuori dall'aggregato community (troppo granulare)
  });

  // medie singole
  agg.titleLevel.avg = agg.titleLevel.count > 0
    ? round2(agg.titleLevel.sum / agg.titleLevel.count)
    : 0;
  Object.values(agg.bySeason).forEach((bucket) => {
    bucket.avg = bucket.count > 0 ? round2(bucket.sum / bucket.count) : 0;
  });

  // combined: media pesata title-level + tutte le stagioni
  let totalSum = agg.titleLevel.sum;
  let totalCount = agg.titleLevel.count;
  Object.values(agg.bySeason).forEach((bucket) => {
    totalSum += bucket.sum;
    totalCount += bucket.count;
  });
  agg.combined = totalCount > 0 ? round2(totalSum / totalCount) : 0;

  return { agg, totalRatings: snap.size };
}

async function gatherTitleIdsWithRatings() {
  // Streaming completo della collection. Su un dataset di taglia normale Somto
  // (decine di migliaia di review) ~10s. Se cresce molto, sostituire con
  // paginazione esplicita (.orderBy(documentId).startAfter()).
  const seen = new Set();
  const stream = db.collection("ratings").select("titleId").stream();
  for await (const doc of stream) {
    const titleId = String(doc.data()?.titleId || "").trim();
    if (titleId) seen.add(titleId);
  }
  return Array.from(seen);
}

async function main() {
  console.log(`backfill-titleRatingAggregate — ${WRITE ? "WRITE" : "DRY-RUN"}`);
  const startedAt = Date.now();

  const titleIds = await gatherTitleIdsWithRatings();
  console.log(`Found ${titleIds.length} unique titleIds with ratings.`);

  let done = 0;
  let writes = 0;
  let errors = 0;

  // chunk parallelo
  async function processChunk(chunk) {
    await Promise.all(chunk.map(async (titleId) => {
      try {
        const { agg, totalRatings } = await computeAggregateForTitle(titleId);
        if (WRITE) {
          await db.doc(`titles/${titleId}`).update({
            ratingAggregate: {
              ...agg,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
          });
          writes += 1;
        }
        done += 1;
        if (done % LOG_EVERY === 0) {
          console.log(`  processed ${done}/${titleIds.length} (last: ${titleId}, ${totalRatings} ratings)`);
        }
      } catch (err) {
        errors += 1;
        console.warn(`  [skip] ${titleId}: ${err.message || err}`);
      }
    }));
  }

  for (let i = 0; i < titleIds.length; i += CONCURRENCY) {
    await processChunk(titleIds.slice(i, i + CONCURRENCY));
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`DONE — processed=${done} writes=${writes} errors=${errors} in ${elapsed}s`);
  if (!WRITE) {
    console.log("Dry-run: passa --write per applicare gli aggregati.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
