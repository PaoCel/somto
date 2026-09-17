#!/usr/bin/env node
//
// notification-health-report.js — la stessa misura della guardia giornaliera
// (checkNotificationHealth, modules/notificationHealth.js), a mano.
//
// Read-only: non aggiorna systemJobs/notificationHealth e non avvisa nessuno.
//
// Uso:
//   cd functions
//   GCLOUD_PROJECT=gia-visto node scripts/notification-health-report.js [--json]
"use strict";

const admin = require("firebase-admin");
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || "gia-visto" });

const { STATE_DOC, readNotificationHealthInputs } = require("../modules/notificationHealth");
const { evaluateNotificationHealth } = require("../lib/notificationHealth");

const LABELS = {
  delivered: "consegnate",
  no_token: "senza token",
  cooldown: "trattenute dal cooldown",
  failed: "fallite",
  prefs_off: "spente dall'utente",
  missing: "senza esito",
};

function countsLine(counts) {
  return [`create ${counts.created}`, ...Object.entries(LABELS).map(([key, label]) => `${label} ${counts[key]}`)].join(" · ");
}

(async () => {
  const db = admin.firestore();
  const nowMs = Date.now();
  const state = (await db.collection("systemJobs").doc(STATE_DOC).get()).data() || {};
  const inputs = await readNotificationHealthInputs({ admin, db, nowMs });
  const result = evaluateNotificationHealth({
    ...inputs,
    previous: state.last || null,
    trackingSinceMs: Number.isFinite(state.trackingSinceMs) ? state.trackingSinceMs : null,
    nowMs,
  });

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const { summary, alerts } = result;
  console.log("\nSalute notifiche — ultime 24 ore\n");
  console.log(`  ${countsLine(summary.totals)}`);
  for (const [category, counts] of Object.entries(summary.byCategory)) {
    console.log(`    ${category.padEnd(10)} ${countsLine(counts)}`);
  }
  console.log(`\n  push verso chi ha un token: ${summary.totals.delivered}/${summary.reachableAttempts} consegnate`);
  console.log(`  token push: ${summary.tokenCount}${summary.previousTokenCount !== null ? ` (giro prima: ${summary.previousTokenCount})` : ""}`);
  const social = Object.entries(summary.social72h).map(([key, row]) => `${key} ${row.sources}→${row.notifications}`).join(", ");
  console.log(`  ultime 72 ore, interazioni → notifiche: ${social}`);
  console.log(`  notifiche di uscite nelle ultime 72 ore: ${summary.releases72h}`);
  console.log(alerts.length ? `\nProblemi:\n${alerts.map((alert) => `  - ${alert.message}`).join("\n")}` : "\nNessun problema.");
  console.log("");
})().catch((err) => {
  console.error("ERRORE", err.code || "", err.message);
  process.exit(1);
});
