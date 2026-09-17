#!/usr/bin/env node
/**
 * backfill-watch-provider-names.js
 *
 * Denormalizza `titles/{id}.watchProviderNames` (nomi piattaforma streaming
 * abbonamento/gratis) leggendo i doc `titleProviders/{id}` già in cache.
 * Sblocca il raggruppamento/filtro watchlist per piattaforma (F-C) sui titoli
 * i cui provider erano stati fetchati prima dell'introduzione del campo.
 *
 * SCRIVE SOLO SUI TITOLI CHE ESISTONO. La cache `titleProviders` sopravvive
 * alla cancellazione del titolo, e la vecchia versione usava `set(merge)`: su
 * un id cancellato (un doppione accorpato) faceva rinascere un documento con il
 * solo `watchProviderNames`, cioè un titolo senza `name` — "Senza titolo" a
 * schermo e commenti sfocati dal gate anti-spoiler (incidente 2026-09-09,
 * `tmdb_tv_308014` e `devil-in-the-family-…-8vub`).
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
  let orphan = 0;

  const candidates = [];
  for (const docSnap of snap.docs) {
    const data = docSnap.data() || {};
    const titleId = String(data.titleId || docSnap.id);
    const names = extractStreamingPlatformNames(data.providers, data.customAdmin);
    if (!names.length) {
      skipped += 1;
      continue;
    }
    if (withNames < 12) console.log(`  ${titleId}: [${names.join(", ")}]`);
    candidates.push({ titleId, names });
    withNames += 1;
  }

  // A chunk: si leggono i titoli e si scrive solo su quelli che esistono.
  // `update` in batch farebbe fallire l'intero batch su un doc mancante, e
  // `set(merge)` lo creerebbe: la lettura preventiva è ciò che tiene fuori
  // entrambe le cose.
  for (let i = 0; i < candidates.length; i += 300) {
    const chunk = candidates.slice(i, i + 300);
    const refs = chunk.map((row) => db.collection("titles").doc(row.titleId));
    // eslint-disable-next-line no-await-in-loop
    const snaps = await db.getAll(...refs);
    const existing = new Set(snaps.filter((s) => s.exists).map((s) => s.id));

    const batch = db.batch();
    let pending = 0;
    for (const row of chunk) {
      if (!existing.has(row.titleId)) {
        orphan += 1;
        console.log(`  ORFANO (titolo assente, non scrivo): ${row.titleId}`);
        continue;
      }
      if (!WRITE) continue;
      batch.update(db.collection("titles").doc(row.titleId), { watchProviderNames: row.names });
      pending += 1;
    }
    // eslint-disable-next-line no-await-in-loop
    if (pending > 0) await batch.commit();
  }

  console.log(
    `${WRITE ? "SCRITTI" : "DRY-RUN — titoli con piattaforme"}: ${withNames - orphan}; ` +
    `saltati (nessuna piattaforma abbonamento/gratis): ${skipped}; ` +
    `cache orfane (titolo cancellato): ${orphan}`
  );
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
