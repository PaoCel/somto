#!/usr/bin/env node
/**
 * push-coverage-report.js — quanti utenti sono davvero raggiungibili da una
 * push (read-only).
 *
 * È la metrica che governa tutte le notifiche: senza token FCM la push muore in
 * `pushOnNotificationCreate` e resta solo la campanella in-app. Baseline del
 * 2026-08-03: 50 utenti su 361 (13,9%), tutti iOS, zero web.
 *
 * Lo stesso calcolo gira ogni lunedì alle 9 come `reportPushCoverage`
 * (functions/modules/pushCoverage.js) e manda una notifica agli admin; questo
 * script serve per guardarlo quando vuoi, senza aspettare il lunedì.
 *
 * Uso:
 *   node scripts/push-coverage-report.js
 *   node scripts/push-coverage-report.js --json
 *   node scripts/push-coverage-report.js --history   # snapshot settimanali
 */
"use strict";

const admin = require("firebase-admin");
const { readPushCoverage, SNAPSHOT_DOC } = require("../modules/pushCoverage");
const { formatPushCoverageMessage } = require("../lib/pushCoverage");

const args = process.argv.slice(2);
const AS_JSON = args.includes("--json");
const WITH_HISTORY = args.includes("--history");

const projectId = process.env.GCLOUD_PROJECT
  || process.env.GOOGLE_CLOUD_PROJECT
  || "gia-visto";

if (!admin.apps.length) admin.initializeApp({ projectId });
const db = admin.firestore();

function bar(percent) {
  const filled = Math.round(Math.max(0, Math.min(100, Number(percent) || 0)) / 5);
  return `${"█".repeat(filled)}${"·".repeat(20 - filled)}`;
}

async function main() {
  const stateSnap = await db.collection("systemJobs").doc(SNAPSHOT_DOC).get().catch(() => null);
  const previous = stateSnap?.data()?.last || null;
  const summary = await readPushCoverage({ db });

  if (AS_JSON) {
    console.log(JSON.stringify({ summary, previous }, null, 2));
    return;
  }

  console.log(`\nCopertura push — progetto ${projectId}\n`);
  console.log(`  raggiungibili        ${bar(summary.reachablePercent)}  ${summary.reachable}/${summary.users} (${summary.reachablePercent}%)`);
  console.log(`  di cui attivi 7gg    ${bar(summary.activeReachablePercent)}  ${summary.activeReachable}/${summary.activeUsers} (${summary.activeReachablePercent}%)`);
  console.log(`\n  token totali: ${summary.tokens} (${summary.freshTokens} aggiornati negli ultimi 30 giorni)`);
  console.log(`  per piattaforma: ${Object.entries(summary.byPlatform).map(([k, v]) => `${k} ${v}`).join(", ") || "nessuno"}`);
  if (previous) {
    const delta = summary.reachable - Number(previous.reachable || 0);
    const when = previous.measuredAtMs ? new Date(previous.measuredAtMs).toISOString().slice(0, 10) : "?";
    console.log(`\n  rispetto all'ultimo snapshot (${when}): ${delta > 0 ? "+" : ""}${delta} utenti raggiungibili`);
  } else {
    console.log("\n  nessuno snapshot precedente: il primo lo scrive il job del lunedì.");
  }
  console.log(`\n  riga notifica: ${formatPushCoverageMessage(summary, previous)}\n`);

  if (WITH_HISTORY) {
    const history = Array.isArray(stateSnap?.data()?.history) ? stateSnap.data().history : [];
    if (!history.length) {
      console.log("  storico vuoto.\n");
      return;
    }
    console.log("  storico settimanale:");
    history.forEach((row) => {
      const when = row.measuredAtMs ? new Date(row.measuredAtMs).toISOString().slice(0, 10) : "?";
      console.log(`    ${when}  ${String(row.reachable).padStart(4)}/${String(row.users).padEnd(4)} (${row.reachablePercent}%)`);
    });
    console.log("");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal:", err.message);
    process.exit(1);
  });
