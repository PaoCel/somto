#!/usr/bin/env node
/**
 * backfill-titleEmotionAggregate.cjs
 *
 * Backfill/riconciliazione di `titles/{id}.emotionAggregate` (emozioni
 * post-visione denormalizzate). Da eseguire:
 *   - una volta DOPO il deploy del trigger recomputeTitleEmotionAggregate
 *     (baseline: al lancio la collection titleEmotions e' vuota, quindi il
 *     primo run e' un no-op — lo script serve soprattutto come reconcile
 *     anti-drift e dopo import bulk, es. import retroattivo TV Time);
 *   - dopo ogni import admin-SDK massivo che scrive titleEmotions.
 *
 * Schema scritto sul doc titolo (stesso del trigger):
 *   emotionAggregate = {
 *     counts: { touched: 12, ... },   // solo chiavi > 0, whitelist 12
 *     totalSelections: number,        // base delle percentuali
 *     totalUsers: number,             // doc distinti (1 doc = 1 utente)
 *     updatedAt: serverTimestamp
 *   }
 *
 * Esclude i doc `isSynthetic === true` (profili guidati), come il trigger.
 * Idempotente: ricalcola da zero per ogni titolo con almeno un doc emozioni.
 *
 * Uso:
 *   cd functions   # serve l'admin SDK installato qui
 *   node ../scripts/backfill-titleEmotionAggregate.cjs            # dry-run
 *   node ../scripts/backfill-titleEmotionAggregate.cjs --write    # applica
 */

const admin = require("firebase-admin");
const { applyEmotionAggregateDelta } = require("../functions/lib/emotionAggregate");

const WRITE = process.argv.includes("--write");
const CONCURRENCY = 8;
const LOG_EVERY = 200;

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

async function computeAggregateForTitle(titleId) {
  const snap = await db.collection("titleEmotions")
    .where("titleId", "==", titleId)
    .get();

  // Ricalcolo da zero: replay di ogni doc come "create" sopra un seed vuoto.
  let agg = { counts: {}, totalSelections: 0, totalUsers: 0 };
  let docs = 0;
  snap.forEach((docSnap) => {
    const data = docSnap.data() || {};
    if (data.isSynthetic === true) return; // profili guidati esclusi (parita' trigger)
    agg = applyEmotionAggregateDelta(agg, null, data.emotions);
    docs += 1;
  });

  return { agg, docs };
}

async function gatherTitleIdsWithEmotions() {
  const seen = new Set();
  const stream = db.collection("titleEmotions").select("titleId").stream();
  for await (const docSnap of stream) {
    const titleId = String(docSnap.data()?.titleId || "").trim();
    if (titleId) seen.add(titleId);
  }
  return Array.from(seen);
}

async function main() {
  console.log(`backfill-titleEmotionAggregate — ${WRITE ? "WRITE" : "DRY-RUN"}`);
  const startedAt = Date.now();

  const titleIds = await gatherTitleIdsWithEmotions();
  console.log(`Found ${titleIds.length} unique titleIds with emotions.`);

  let done = 0;
  let writes = 0;
  let errors = 0;

  async function processChunk(chunk) {
    await Promise.all(chunk.map(async (titleId) => {
      try {
        const { agg, docs } = await computeAggregateForTitle(titleId);
        if (WRITE) {
          await db.doc(`titles/${titleId}`).update({
            emotionAggregate: {
              ...agg,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
          });
          writes += 1;
        }
        done += 1;
        if (done % LOG_EVERY === 0) {
          console.log(`  processed ${done}/${titleIds.length} (last: ${titleId}, ${docs} docs)`);
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
