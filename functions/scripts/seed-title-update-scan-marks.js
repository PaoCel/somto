#!/usr/bin/env node
/**
 * seed-title-update-scan-marks.js — sblocca subito le notifiche sugli
 * aggiornamenti titolo per i titoli che lo scanner ha GIA' visto una volta.
 *
 * Contesto (2026-08-03): lo scanner distingueva backfill e live con un flag
 * globale, `systemJobs/titleUpdateScanner.initialBackfillCompleted`, che diventa
 * true solo dopo aver passato in rassegna l'intero catalogo (~20k titoli). Fino
 * a quel momento OGNI evento nasceva `acquisitionMode: "backfill"`, cioe' non
 * notificabile per sempre: nessun utente ha mai ricevuto una notifica di nuovo
 * trailer / nuovo episodio / nuova data.
 *
 * Il gate ora e' per titolo (`titleProviders/{titleId}.titleUpdateScanAtMs`):
 * la prima scansione di un titolo resta backfill, dalla seconda in poi cio' che
 * compare e' davvero nuovo. Questo script scrive il marcatore sui titoli gia'
 * scansionati dal job (source = scheduled_title_updates), cosi' non devono
 * aspettare un altro giro completo per diventare "live".
 *
 * Uso:
 *   node scripts/seed-title-update-scan-marks.js                 # dry-run
 *   node scripts/seed-title-update-scan-marks.js --apply --confirm=gia-visto
 */
"use strict";

const admin = require("firebase-admin");

const args = process.argv.slice(2);
const flag = (name) => {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1).trim() : "";
};
const APPLY = args.includes("--apply");
const CONFIRM = flag("--confirm");

const projectId = process.env.GCLOUD_PROJECT
  || process.env.GOOGLE_CLOUD_PROJECT
  || "gia-visto";

if (APPLY && CONFIRM !== projectId) {
  console.error(`Scrittura rifiutata: serve --confirm=${projectId}`);
  process.exit(1);
}

if (!admin.apps.length) admin.initializeApp({ projectId });
const db = admin.firestore();

async function main() {
  console.log(`progetto=${projectId} modalita=${APPLY ? "APPLY" : "dry-run"}`);

  const snapshot = await db.collection("titleProviders")
    .where("source", "==", "scheduled_title_updates")
    .get();

  let alreadyMarked = 0;
  const pending = [];
  snapshot.docs.forEach((docSnap) => {
    const data = docSnap.data() || {};
    if (Number(data.titleUpdateScanAtMs) > 0) {
      alreadyMarked += 1;
      return;
    }
    const scannedAtMs = Number(data.updatedAtMs);
    if (!Number.isFinite(scannedAtMs) || scannedAtMs <= 0) return;
    pending.push({ ref: docSnap.ref, scannedAtMs });
  });

  console.log(`titoli gia' scansionati dal job: ${snapshot.size}`);
  console.log(`  gia' marcati: ${alreadyMarked}`);
  console.log(`  da marcare:   ${pending.length}`);

  if (!APPLY || !pending.length) {
    console.log(APPLY ? "Niente da fare." : "Dry-run: nessuna scrittura.");
    return;
  }

  let written = 0;
  for (let i = 0; i < pending.length; i += 400) {
    const chunk = pending.slice(i, i + 400);
    const batch = db.batch();
    chunk.forEach(({ ref, scannedAtMs }) => {
      batch.set(ref, { titleUpdateScanAtMs: scannedAtMs }, { merge: true });
    });
    await batch.commit();
    written += chunk.length;
    console.log(`  scritti ${written}/${pending.length}`);
  }

  console.log(`Fatto: ${written} titoli passano a live dalla prossima scansione.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal:", err.message);
    process.exit(1);
  });
