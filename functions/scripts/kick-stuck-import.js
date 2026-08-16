#!/usr/bin/env node
/**
 * kick-stuck-import.js
 *
 * Sblocca un import manuale rimasto a `status: "uploading"`: i file sono stati
 * caricati su Storage (+ payload/raw esiste) ma `finalizeTitlesImportUpload`
 * non è mai andato a buon fine — tipicamente perché la libreria supera il cap
 * `TITLES_IMPORT_MAX_ROWS` (25000) che vive SOLO nella callable finalize, non
 * nel tick worker resumabile (che gestisce qualsiasi dimensione). Il watchdog
 * `reviveStalledTitlesImports` NON copre lo stato "uploading" → resta orfano.
 *
 * Replica la coda di finalizeTitlesImportUpload (SENZA il cap): mette l'import
 * in `queued` e crea il primo tick `importMatchTicks/{importId}_0`; il trigger
 * deployato `runImportMatchTick` fa il resto (match → enrich → finalize, col
 * decoder voti corretto).
 *
 * SICUREZZA: dry-run DEFAULT. --write per applicare. Un solo import per run.
 * Verifica che status=="uploading", payload/raw esista e i file core siano su
 * Storage prima di toccare qualcosa.
 *
 * Usage (da functions/):
 *   node scripts/kick-stuck-import.js --uid=UID --import=IMPORT_ID            # dry-run
 *   node scripts/kick-stuck-import.js --uid=UID --import=IMPORT_ID --write
 */

"use strict";

const crypto = require("crypto");
const admin = require("firebase-admin");

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
function getArg(flag) { const h = args.find((a) => a.startsWith(`${flag}=`)); return h ? h.slice(flag.length + 1).trim() : ""; }
const ARG_UID = getArg("--uid");
const ARG_IMPORT = getArg("--import");
if (!ARG_UID || !ARG_IMPORT) {
  console.error("Usage: node scripts/kick-stuck-import.js --uid=UID --import=IMPORT_ID [--write]");
  process.exit(1);
}

const BUCKET = "gia-visto.firebasestorage.app";
admin.initializeApp({ projectId: "gia-visto", storageBucket: BUCKET });
const db = admin.firestore();
const bucket = admin.storage().bucket(BUCKET);

const sha256Hex = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

async function main() {
  console.log(`[kick-stuck-import] uid=${ARG_UID} import=${ARG_IMPORT} mode=${WRITE ? "WRITE" : "DRY-RUN"}`);
  const importRef = db.collection("users").doc(ARG_UID).collection("imports").doc(ARG_IMPORT);
  const payloadRef = importRef.collection("payload").doc("raw");
  const [importSnap, payloadSnap] = await Promise.all([importRef.get(), payloadRef.get()]);
  if (!importSnap.exists) { console.error("Import non trovato."); process.exit(1); }
  const x = importSnap.data() || {};
  console.log("  source:", x.source, "status:", x.status, "startedBy:", x.startedBy);
  if (x.status !== "uploading") { console.error(`ABORT: status="${x.status}" (mi aspetto "uploading"). Non tocco.`); process.exit(1); }
  if (!payloadSnap.exists) { console.error("ABORT: payload/raw mancante."); process.exit(1); }

  const sp = x.storagePaths || {};
  // Verify core files exist on Storage
  const coreKeys = x.source === "netflix_csv" ? ["netflix"] : ["movies", "series"];
  const present = {};
  for (const [k, p] of Object.entries(sp)) {
    // eslint-disable-next-line no-await-in-loop
    const [e] = await bucket.file(p).exists();
    present[k] = e;
  }
  console.log("  storage files present:", JSON.stringify(present));
  const hasCore = coreKeys.some((k) => present[k]);
  if (!hasCore) { console.error("ABORT: nessun file core (movies/series/netflix) su Storage."); process.exit(1); }

  const totalRows = Number(getArg("--rows")) || null; // opzionale: se lo passi, lo scrivo; altrimenti lo calcola il tick
  const sourceDigest = sha256Hex(JSON.stringify({ storagePaths: sp, totalRows: totalRows || 0 }));

  if (!WRITE) {
    console.log("  DRY-RUN: metterei status→queued + creerei importMatchTicks/" + ARG_IMPORT + "_0 (phase match, cursor 0).");
    console.log("  Il tick worker deployato ri-parsa da Storage e conta le righe da solo (nessun cap nel worker).");
    return;
  }

  await payloadRef.set({
    source: x.source,
    sourceDigest,
    finalizedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    rescuedBy: "kick-stuck-import",
  }, { merge: true });

  await importRef.set({
    sourceDigest,
    status: "queued",
    matchCursor: 0,
    tickCount: 0,
    ...(totalRows ? { totalRows } : {}),
    startedProcessingAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    rescuedBy: "kick-stuck-import",
  }, { merge: true });

  // delete-then-create so onCreate fires even if a stale tick doc exists
  const tickRef = db.collection("importMatchTicks").doc(`${ARG_IMPORT}_0`);
  await tickRef.delete().catch(() => {});
  await tickRef.set({
    uid: ARG_UID,
    importId: ARG_IMPORT,
    cursor: 0,
    phase: "match",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    rescued: true,
  });

  console.log("  Fatto: import in queued + primo tick creato. Segui lo stato su users/" + ARG_UID + "/imports/" + ARG_IMPORT + ".");
}

main().then(() => process.exit(0)).catch((err) => { console.error("[kick-stuck-import] errore:", err); process.exit(1); });
