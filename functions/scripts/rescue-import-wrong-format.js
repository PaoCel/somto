#!/usr/bin/env node
/**
 * rescue-import-wrong-format.js — riprocessa i file di un import fallito
 * leggendoli col parser GIUSTO, senza chiedere all'utente di ricaricare nulla.
 *
 * Caso che ha motivato lo script: l'export Refract (JSON) caricato negli slot
 * del formato GDPR (CSV). I file sono validi e sono ancora su Storage
 * (`manualImports/{uid}/{importId}/…`), ma il parser CSV non ne cava niente e
 * l'import finisce a zero titoli. Qui si crea un NUOVO import che punta agli
 * STESSI file dichiarando il formato corretto, e lo si mette in coda: da lì in
 * poi è la pipeline normale (match → enrich → write) a fare tutto.
 *
 * Uso:
 *   node scripts/rescue-import-wrong-format.js --uid=UID --import=OLD_IMPORT_ID \
 *     --source=tvtime_refract [--write]
 * Senza --write è un dry-run: legge i file, li parsa e stampa cosa verrebbe
 * importato, senza creare nulla.
 */
"use strict";

const { createHash } = require("crypto");
const admin = require("firebase-admin");
const { parseTvTimeRefractJson } = require("../lib/importAdapters/tvTimeRefract");
const { parseTvTimeGdprCsvs } = require("../lib/importAdapters/tvTimeGdpr");

const args = process.argv.slice(2);
const flag = (name) => {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1).trim() : "";
};
const UID = flag("--uid");
const OLD_IMPORT = flag("--import");
const SOURCE = flag("--source") || "tvtime_refract";
const WRITE = args.includes("--write");

if (!UID || !OLD_IMPORT) {
  console.error("Uso: --uid=UID --import=OLD_IMPORT_ID [--source=tvtime_refract] [--write]");
  process.exit(1);
}
if (!["tvtime_refract", "tvtime_gdpr"].includes(SOURCE)) {
  console.error(`Sorgente non supportata: ${SOURCE}`);
  process.exit(1);
}

const BUCKET = "gia-visto.firebasestorage.app";
admin.initializeApp({ projectId: "gia-visto", storageBucket: BUCKET });
const db = admin.firestore();
const bucket = admin.storage().bucket(BUCKET);

const download = async (path) => {
  if (!path) return "";
  const [exists] = await bucket.file(path).exists();
  if (!exists) return "";
  const [buf] = await bucket.file(path).download();
  return buf.toString("utf8");
};

(async () => {
  const oldRef = db.collection("users").doc(UID).collection("imports").doc(OLD_IMPORT);
  const oldSnap = await oldRef.get();
  if (!oldSnap.exists) {
    console.error(`Import ${OLD_IMPORT} non trovato.`);
    process.exit(1);
  }
  const oldData = oldSnap.data() || {};
  const storagePaths = oldData.storagePaths || {};
  if (!storagePaths.movies && !storagePaths.series) {
    console.error("L'import non ha file su Storage (probabilmente inline o già ripulito).");
    process.exit(1);
  }

  const [moviesText, seriesText] = await Promise.all([
    download(storagePaths.movies),
    download(storagePaths.series),
  ]);
  if (!moviesText && !seriesText) {
    console.error("I file non ci sono più su Storage.");
    process.exit(1);
  }

  const parsed = SOURCE === "tvtime_refract"
    ? parseTvTimeRefractJson({ moviesJson: moviesText, seriesJson: seriesText })
    : parseTvTimeGdprCsvs({ moviesCsv: moviesText, seriesCsv: seriesText });

  const movies = parsed.rows.filter((r) => r.kind === "movie").length;
  const episodes = parsed.rows.filter((r) => r.kind === "tv_episode").length;
  const series = new Set(parsed.rows.filter((r) => r.kind === "tv_episode").map((r) => r.seriesNameGuess)).size;
  const watchlist = parsed.rows.filter((r) => r.watchlistOnly).length;

  console.log(`Import originale ${OLD_IMPORT} (${oldData.source}, ${oldData.status}) — riletto come ${SOURCE}:`);
  console.log(`  ${parsed.rows.length} righe: ${movies} film, ${episodes} episodi su ${series} serie, ${watchlist} in watchlist, ${parsed.errors.length} errori`);

  if (parsed.rows.length === 0) {
    console.error("Zero righe utili anche col parser nuovo: non c'è niente da recuperare.");
    process.exit(1);
  }

  if (!WRITE) {
    console.log("\nDry-run: nessun import creato. Aggiungi --write per accodarlo davvero.");
    process.exit(0);
  }

  // Nuovo import doc che riusa gli STESSI file. Stessa forma che
  // finalizeTitlesImportUpload lascia al worker: status queued + payload/raw
  // con gli storagePaths + il primo tick.
  const newRef = db.collection("users").doc(UID).collection("imports").doc();
  const now = admin.firestore.FieldValue.serverTimestamp();
  const sourceDigest = createHash("sha256")
    .update(JSON.stringify({ storagePaths, totalRows: parsed.rows.length, rescuedFrom: OLD_IMPORT }))
    .digest("hex");

  await newRef.set({
    source: SOURCE,
    platform: oldData.platform || null,
    dryRun: false,
    importOptions: oldData.importOptions || {},
    status: "queued",
    sourceDigest,
    totalRows: parsed.rows.length,
    processedCount: 0,
    matchCursor: 0,
    tickCount: 0,
    matchedCount: 0,
    unresolvedCount: 0,
    errorCount: parsed.errors.length,
    titleStateIdsWritten: [],
    storagePaths,
    startedBy: UID,
    rescuedFromImportId: OLD_IMPORT,
    rescuedBy: "rescue-import-wrong-format",
    createdAt: now,
    startedProcessingAt: now,
    updatedAt: now,
    expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)),
  });

  await newRef.collection("payload").doc("raw").set({
    source: SOURCE,
    storageBucket: BUCKET,
    storagePaths,
    sourceDigest,
    finalizedAt: now,
    createdAt: now,
    updatedAt: now,
    rescuedBy: "rescue-import-wrong-format",
  });

  await db.collection("importMatchTicks").doc(`${newRef.id}_0`).set({
    uid: UID,
    importId: newRef.id,
    cursor: 0,
    phase: "match",
    createdAt: now,
    rescued: true,
  });

  console.log(`\nCreato import ${newRef.id} in coda (${parsed.rows.length} righe). Il worker parte da solo.`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
