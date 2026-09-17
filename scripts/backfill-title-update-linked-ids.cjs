#!/usr/bin/env node
/**
 * backfill-title-update-linked-ids.js
 *
 * Popola `titleUpdateEvents/{eventId}.linkedTitleIds` per gli eventi scritti
 * PRIMA del deploy di CONTRACT 3. Da quel deploy in poi `writeTitleUpdateEvent`
 * (functions/lib/titleUpdateEvents.js) calcola il campo da solo a ogni
 * scrittura nuova o aggiornata — questo script ripara solo lo storico.
 *
 * Due modalita':
 *   - default: dove manca, imposta `linkedTitleIds = [titleId]`. Nessuna
 *     query aggiuntiva, costo minimo — copre la maggioranza degli eventi
 *     (serie TV, film senza saga).
 *   - `--expand`: per gli eventi di FILM il cui titolo ha
 *     `titles.collectionId`, espande a `[titleId, ...fratelli approvati della
 *     stessa collection]` — la STESSA logica di `resolveLinkedTitleIds`
 *     (functions/lib/titleUpdateEvents.js), riusata qui e non riscritta, cosi'
 *     backfill e scrittura live restano un solo posto da mantenere.
 *
 * Dry-run di default. Batch 400 (il limite Firestore e' 500, margine per un
 * eventuale retry). Idempotente: un evento che ha gia' `linkedTitleIds`
 * popolato viene saltato, a meno di `--force` (ricalcola e sovrascrive se il
 * valore risulta diverso — utile per applicare `--expand` a eventi gia'
 * riparati in modalita' default).
 *
 * Uso:
 *   cd functions   # serve l'admin SDK gia' installato qui
 *   node ../scripts/backfill-title-update-linked-ids.js                    # dry-run, solo [titleId]
 *   node ../scripts/backfill-title-update-linked-ids.js --expand           # dry-run, con saghe
 *   node ../scripts/backfill-title-update-linked-ids.js --write            # applica [titleId]
 *   node ../scripts/backfill-title-update-linked-ids.js --write --expand   # applica con saghe
 *   node ../scripts/backfill-title-update-linked-ids.js --force --expand --write   # ricalcola anche dove gia' presente
 *   node ../scripts/backfill-title-update-linked-ids.js --project=somto-staging --write
 *
 * NON eseguire come parte del commit: deploy del codice CONTRACT 3 prima,
 * backfill dopo (e non e' nemmeno bloccante: gli eventi senza `linkedTitleIds`
 * semplicemente non entrano nel fanout collegato finche' non vengono riparati
 * o riscritti dallo scanner).
 */

const admin = require("firebase-admin");
const { resolveLinkedTitleIds, normalizeLinkedTitleIds } = require("../functions/lib/titleUpdateEvents");

const WRITE = process.argv.includes("--write");
const EXPAND = process.argv.includes("--expand");
const FORCE = process.argv.includes("--force");
const PROJECT = (process.argv.find((a) => a.startsWith("--project=")) || "").split("=")[1] || "gia-visto";
const PAGE_SIZE = 500;
const BATCH_SIZE = 400;

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

function alreadyEqual(existing, next) {
  if (!Array.isArray(existing)) return false;
  if (existing.length !== next.length) return false;
  return existing.every((id, i) => id === next[i]);
}

async function main() {
  console.log(`[backfill-linkedTitleIds] project=${PROJECT} write=${WRITE ? "SI" : "no (dry-run)"} expand=${EXPAND} force=${FORCE}`);

  let processed = 0;
  let toUpdate = 0;
  let skippedAlready = 0;
  let batch = db.batch();
  let batchPending = 0;
  let cursor = null;

  for (;;) {
    let page = db.collection("titleUpdateEvents")
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(PAGE_SIZE);
    if (cursor) page = page.startAfter(cursor);
    const snap = await page.get();
    if (snap.empty) break;
    cursor = snap.docs[snap.docs.length - 1];

    for (const doc of snap.docs) {
      processed += 1;
      const data = doc.data() || {};
      const titleId = String(data.titleId || "").trim();
      if (!titleId) continue;

      const hasExisting = Array.isArray(data.linkedTitleIds) && data.linkedTitleIds.length > 0;
      if (hasExisting && !FORCE) {
        skippedAlready += 1;
        continue;
      }

      const linkedTitleIds = EXPAND
        ? await resolveLinkedTitleIds(db, { titleId, mediaType: data.mediaType })
        : normalizeLinkedTitleIds(titleId, hasExisting ? data.linkedTitleIds : []);

      if (hasExisting && alreadyEqual(data.linkedTitleIds, linkedTitleIds)) {
        skippedAlready += 1;
        continue;
      }

      toUpdate += 1;
      if (WRITE) {
        batch.update(doc.ref, { linkedTitleIds });
        batchPending += 1;
        if (batchPending >= BATCH_SIZE) {
          await batch.commit();
          batch = db.batch();
          batchPending = 0;
        }
      }
    }

    console.log(`[backfill-linkedTitleIds] processati ${processed}, da aggiornare ${toUpdate}, gia' a posto ${skippedAlready}`);
    if (snap.size < PAGE_SIZE) break;
  }

  if (WRITE && batchPending > 0) await batch.commit();

  console.log(`[backfill-linkedTitleIds] fine. processati=${processed} ${WRITE ? "aggiornati" : "da aggiornare (dry-run)"}=${toUpdate} gia_a_posto=${skippedAlready}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
