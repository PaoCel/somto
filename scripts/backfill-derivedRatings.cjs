#!/usr/bin/env node
/**
 * backfill-derivedRatings.cjs
 *
 * Popola users/{uid}/derivedRatings/{titleId} (voto derivato PRIVATO: media dei
 * voti episodio -> stagione -> serie) per gli utenti che hanno già voti episodio
 * storici (es. import TV Time di Marty, 3097 voti episodio). Va eseguito UNA
 * VOLTA dopo il deploy del trigger recomputeUserDerivedRating, che gestisce solo
 * i delta nuovi.
 *
 * Per ogni (uid, titleId) con voti episodio:
 *   - somma sum/count degli episodi per stagione
 *   - deriva season.avg (media episodi) e series.avg (media stagioni)
 * riusando la stessa logica pura del trigger (lib/derivedRatingAggregate.js).
 * Poi ricalcola users/{uid}.stats.derivedRatingsCount = # titoli con voto serie.
 *
 * Esclude i voti sintetici (profili guidati), come il trigger.
 *
 * Idempotente: rieseguire ricalcola da zero i doc derivati e il contatore.
 *
 * Uso:
 *   cd functions           # serve l'admin SDK installato qui
 *   node ../scripts/backfill-derivedRatings.cjs                 # dry-run
 *   node ../scripts/backfill-derivedRatings.cjs --write         # applica
 *   node ../scripts/backfill-derivedRatings.cjs --uid=<UID>     # 1 solo utente
 *   node ../scripts/backfill-derivedRatings.cjs --write --uid=<UID>
 *
 * NON eseguire come parte del commit: deploy del trigger prima, backfill dopo.
 */

const admin = require("firebase-admin");
const { applyDerivedEpisodeDelta } = require("../functions/lib/derivedRatingAggregate");

const WRITE = process.argv.includes("--write");
const ONLY_UID = (process.argv.find((a) => a.startsWith("--uid=")) || "").split("=")[1] || null;
const LOG_EVERY = 100;

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

function isSynthetic(row) {
  return Boolean(row && row.isSynthetic === true);
}

// Raccoglie i voti episodio raggruppati per uid -> titleId -> {bySeason}.
async function gatherEpisodeAggByUser() {
  // byUser: Map<uid, Map<titleId, { bySeason: { [season]: {sum,count} } }>>
  const byUser = new Map();
  // Solo il filtro single-field level==episode (indice automatico): niente
  // indice composito. ONLY_UID è filtrato in-stream sotto.
  const stream = db.collection("ratings")
    .where("level", "==", "episode")
    .select("uid", "titleId", "season", "rating", "isSynthetic")
    .stream();

  let scanned = 0;
  for await (const doc of stream) {
    const row = doc.data() || {};
    scanned += 1;
    if (isSynthetic(row)) continue;
    const uid = String(row.uid || "").trim();
    if (ONLY_UID && uid !== ONLY_UID) continue;
    const titleId = String(row.titleId || "").trim();
    const season = Number(row.season);
    const rating = Number(row.rating);
    if (!uid || !titleId) continue;
    if (!Number.isFinite(season) || season <= 0) continue;
    if (!Number.isFinite(rating)) continue;

    if (!byUser.has(uid)) byUser.set(uid, new Map());
    const byTitle = byUser.get(uid);
    // Shape atteso dal lib: seed.episodeAgg.bySeason.
    if (!byTitle.has(titleId)) byTitle.set(titleId, { episodeAgg: { bySeason: {} } });
    const agg = byTitle.get(titleId).episodeAgg.bySeason;
    const key = String(season);
    if (!agg[key]) agg[key] = { sum: 0, count: 0 };
    agg[key].sum += rating;
    agg[key].count += 1;
  }

  return { byUser, scanned };
}

async function main() {
  console.log(`backfill-derivedRatings — ${WRITE ? "WRITE" : "DRY-RUN"}${ONLY_UID ? ` uid=${ONLY_UID}` : ""}`);
  const startedAt = Date.now();

  const { byUser, scanned } = await gatherEpisodeAggByUser();
  console.log(`Scanned ${scanned} episode ratings across ${byUser.size} users.`);

  let userDone = 0;
  let derivedWrites = 0;
  let errors = 0;

  for (const [uid, byTitle] of byUser) {
    try {
      let seriesCount = 0;
      const batch = db.batch();
      let opsInBatch = 0;

      for (const [titleId, seed] of byTitle) {
        const next = applyDerivedEpisodeDelta(seed, null, null);
        if (next.isEmpty) continue;
        seriesCount += 1;
        derivedWrites += 1;
        if (WRITE) {
          const ref = db.doc(`users/${uid}/derivedRatings/${titleId}`);
          batch.set(ref, {
            uid,
            titleId,
            episodeAgg: next.episodeAgg,
            season: next.season,
            series: next.series,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          opsInBatch += 1;
          if (opsInBatch >= 400) { await batch.commit(); opsInBatch = 0; }
        }
      }

      if (WRITE) {
        if (opsInBatch > 0) await batch.commit();
        // Contatore separato da ratingsCount: "+N dai tuoi voti episodio".
        await db.doc(`users/${uid}`).set(
          { stats: { derivedRatingsCount: seriesCount } },
          { merge: true }
        );
      }

      userDone += 1;
      if (userDone % LOG_EVERY === 0) {
        console.log(`  processed ${userDone}/${byUser.size} users (last: ${uid}, ${seriesCount} derived series)`);
      }
    } catch (err) {
      errors += 1;
      console.warn(`  [skip] user ${uid}: ${err.message || err}`);
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`DONE — users=${userDone} derivedDocs=${derivedWrites} errors=${errors} in ${elapsed}s`);
  if (!WRITE) console.log("Dry-run: passa --write per scrivere i voti derivati + il contatore.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
