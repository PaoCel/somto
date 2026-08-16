#!/usr/bin/env node
"use strict";

// Ricostruisce l'indice di similarita' titoli (`titles/{id}/aggregates/similar`).
//
// Stessa identica logica della Cloud Function schedulata: entrambe chiamano
// lib/titleSimilarityJob.js. Serve per la prima build dopo un deploy, per
// rilanciare a mano dopo un import massivo, e per ispezionare i contatori senza
// aspettare il giro settimanale.
//
// **Dry-run di default**: una build tocca migliaia di doc, non deve partire per
// sbaglio. Serve --write per scrivere davvero.
//
// Uso:
//   node scripts/rebuild-title-similarities.js                  # dry-run su prod
//   node scripts/rebuild-title-similarities.js --write          # build reale
//   node scripts/rebuild-title-similarities.js --project=somto-staging --write

const admin = require("firebase-admin");
const { rebuildTitleSimilarityIndex } = require("../lib/titleSimilarityJob");

function parseArgs(argv) {
  const out = { write: false, project: "gia-visto" };
  for (const raw of argv.slice(2)) {
    const [key, value = ""] = raw.replace(/^--/, "").split("=");
    if (key === "write") out.write = true;
    else if (key === "project") out.project = value || out.project;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!admin.apps.length) admin.initializeApp({ projectId: args.project });
  const db = admin.firestore();

  console.log(`[similarity] progetto=${args.project} modalita'=${args.write ? "SCRITTURA" : "dry-run"}`);
  const summary = await rebuildTitleSimilarityIndex(db, admin, { dryRun: !args.write });

  console.log("");
  console.log(`  interazioni positive : ${summary.interactions}`);
  console.log(`  utenti contribuenti  : ${summary.users}`);
  console.log(`  coppie calcolate     : ${summary.pairs}`);
  console.log(`  cap per utente       : ${summary.effectiveItemCap}${summary.capReduced ? ` (RIDOTTO da ${summary.requestedItemCap} — valutare build incrementale)` : ""}`);
  console.log(`  titoli indicizzati   : ${summary.indexedItems}`);
  console.log(`  doc scritti          : ${summary.written}`);
  console.log(`  doc orfani rimossi   : ${summary.deleted}`);
  console.log(`  durata               : ${(summary.durationMs / 1000).toFixed(1)}s`);
  if (!args.write) {
    console.log("");
    console.log("  (dry-run: nessuna scrittura. Rilancia con --write per costruire davvero.)");
  }
}

main().catch((err) => {
  console.error("[similarity] errore:", err);
  process.exit(1);
});
