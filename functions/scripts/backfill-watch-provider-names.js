#!/usr/bin/env node
/**
 * backfill-watch-provider-names.js
 *
 * Denormalizza `titles/{id}.watchProviderNames` (nomi piattaforma streaming
 * abbonamento/gratis) leggendo i doc `titleProviders/{id}` già in cache.
 * Sblocca il raggruppamento/filtro watchlist per piattaforma (F-C) sui titoli
 * i cui provider erano stati fetchati prima dell'introduzione del campo.
 *
 * Usage (da functions/):
 *   node scripts/backfill-watch-provider-names.js          # dry-run (stampa, non scrive)
 *   node scripts/backfill-watch-provider-names.js --write   # scrive titles/{id}.watchProviderNames
 */
const admin = require("firebase-admin");
const { extractStreamingPlatformNames } = require("../lib/watchProviders");
const WRITE = process.argv.includes("--write");

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

(async () => {
  const snap = await db.collection("titleProviders").get();
  console.log(`titleProviders in cache: ${snap.size} doc`);

  let withNames = 0;
  let skipped = 0;
  let batch = db.batch();
  let pending = 0;

  for (const docSnap of snap.docs) {
    const data = docSnap.data() || {};
    const titleId = String(data.titleId || docSnap.id);
    const names = extractStreamingPlatformNames(data.providers, data.customAdmin);
    if (!names.length) {
      skipped += 1;
      continue;
    }
    if (withNames < 12) console.log(`  ${titleId}: [${names.join(", ")}]`);
    if (WRITE) {
      batch.set(db.collection("titles").doc(titleId), { watchProviderNames: names }, { merge: true });
      pending += 1;
      if (pending >= 400) {
        await batch.commit();
        batch = db.batch();
        pending = 0;
      }
    }
    withNames += 1;
  }

  if (WRITE && pending > 0) await batch.commit();

  console.log(
    `${WRITE ? "SCRITTI" : "DRY-RUN — titoli con piattaforme"}: ${withNames}; ` +
    `saltati (nessuna piattaforma abbonamento/gratis): ${skipped}`
  );
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
