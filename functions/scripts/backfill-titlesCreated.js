#!/usr/bin/env node
/**
 * backfill-titlesCreated.js
 *
 * Una-tantum: ricalcola `users/{uid}.stats.titlesCreated` per ogni utente
 * facendo lo scan completo di `titles` (where status == "approved") e
 * raggruppando per `createdBy`. Setta il counter su ciascun utente con
 * `{ merge: true }`, sovrascrivendo eventuali valori esistenti.
 *
 * Da eseguire UNA VOLTA, dopo aver dispiegato i trigger:
 *   - incrementCreatorTitlesCount
 *   - decrementCreatorTitlesCount
 *   - syncCreatorTitlesCountOnStatus
 * così la baseline è coerente; dopo, i counter restano allineati dai trigger.
 *
 * Lo script è idempotente: re-eseguito produce lo stesso valore finale.
 *
 * Usage:
 *   cd functions
 *   node scripts/backfill-titlesCreated.js            # dry-run (no writes)
 *   node scripts/backfill-titlesCreated.js --write    # applica i counter
 *
 * Notes:
 * - Admin SDK, project `gia-visto` (stesso pattern degli altri script).
 * - Solo titoli `status == "approved"` (allineato alla query legacy della
 *   leaderboard).
 * - Writes batched, max 500 ops per batch.
 */

const admin = require("firebase-admin");

const WRITE = process.argv.includes("--write");
const PAGE_SIZE = 500;
const MAX_BATCH_OPS = 500;

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

async function main() {
  console.log(`backfill-titlesCreated — ${WRITE ? "WRITE" : "DRY-RUN"}`);

  // ---- 1) scan titoli approved per createdBy ------------------------------
  const counts = new Map();
  let lastDoc = null;
  let totalTitles = 0;
  while (true) {
    let query = db
      .collection("titles")
      .where("status", "==", "approved")
      .select("createdBy")
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(PAGE_SIZE);
    if (lastDoc) query = query.startAfter(lastDoc);
    const snap = await query.get();
    if (snap.empty) break;
    for (const docSnap of snap.docs) {
      const data = docSnap.data() || {};
      const createdBy = typeof data.createdBy === "string" ? data.createdBy.trim() : "";
      if (!createdBy) continue;
      counts.set(createdBy, (counts.get(createdBy) || 0) + 1);
    }
    totalTitles += snap.size;
    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < PAGE_SIZE) break;
    console.log(`  scansionati ${totalTitles} titoli…`);
  }
  console.log(`Totale titoli approved: ${totalTitles}`);
  console.log(`Creator distinti: ${counts.size}`);

  if (!WRITE) {
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log("Top 10 (dry-run):");
    top.forEach(([uid, c]) => console.log(`  ${uid}  ->  ${c}`));
    console.log("\nRe-run con --write per applicare i counter.");
    return;
  }

  // ---- 2) batch write users/{uid}.stats.titlesCreated --------------------
  let batch = db.batch();
  let ops = 0;
  let totalUsers = 0;
  for (const [uid, count] of counts) {
    batch.set(
      db.doc(`users/${uid}`),
      { stats: { titlesCreated: count } },
      { merge: true }
    );
    ops += 1;
    totalUsers += 1;
    if (ops >= MAX_BATCH_OPS) {
      await batch.commit();
      console.log(`  committed ${totalUsers} utenti…`);
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) {
    await batch.commit();
  }
  console.log(`OK: scritto stats.titlesCreated su ${totalUsers} utenti.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
  });
