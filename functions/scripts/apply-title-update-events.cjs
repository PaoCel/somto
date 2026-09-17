#!/usr/bin/env node
/**
 * Applica candidati titleUpdateEvents esclusivamente a somto-staging.
 *
 * Dry-run di default, senza credenziali:
 *   node scripts/apply-title-update-events.cjs --input scan.json
 *
 * Scrittura staging esplicita:
 *   node scripts/apply-title-update-events.cjs --input scan.json \
 *     --project somto-staging --apply --confirm somto-staging --publish-eligible
 */

const fs = require("fs");
const path = require("path");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { writeTitleUpdateEvents } = require("../lib/titleUpdateEvents");

const STAGING_PROJECT = "somto-staging";

const args = yargs(hideBin(process.argv))
  .strict()
  .option("input", { type: "string", demandOption: true, describe: "JSON prodotto dallo scanner con candidates[]" })
  .option("project", { type: "string", default: STAGING_PROJECT, describe: "Solo somto-staging è consentito" })
  .option("mode", { choices: ["backfill", "manual"], default: "backfill", describe: "Origine eventi" })
  .option("limit", { type: "number", default: 20, describe: "Massimo eventi (1-50)" })
  .option("all-candidates", { type: "boolean", default: false, describe: "Ignora candidateIdsInWindow (solo audit manuale)" })
  .option("publish-eligible", { type: "boolean", default: false, describe: "Pubblica solo candidati già auto-publish eligible" })
  .option("apply", { type: "boolean", default: false, describe: "Esegue le scritture staging" })
  .option("confirm", { type: "string", default: "", describe: "Conferma esatta: somto-staging" })
  .help()
  .parseSync();

function readCandidates(inputPath) {
  const resolved = path.resolve(String(inputPath));
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  const candidates = Array.isArray(parsed) ? parsed : parsed?.candidates;
  if (!Array.isArray(candidates)) throw new Error("Il JSON deve essere un array o contenere candidates[]");
  const windowIds = !Array.isArray(parsed) && Array.isArray(parsed?.candidateIdsInWindow)
    ? parsed.candidateIdsInWindow.map((value) => String(value || "").trim()).filter(Boolean)
    : null;
  return { resolved, candidates, windowIds };
}

function clampLimit(value) {
  return Math.max(1, Math.min(50, Math.floor(Number(value) || 20)));
}

function assertStagingWriteAllowed({ projectId, confirm }) {
  if (projectId !== STAGING_PROJECT) {
    throw new Error(`Scrittura rifiutata: questo script consente solo ${STAGING_PROJECT}`);
  }
  if (confirm !== STAGING_PROJECT) {
    throw new Error(`Conferma mancante: usa --confirm ${STAGING_PROJECT}`);
  }
}

async function main() {
  const input = readCandidates(args.input);
  const projectId = String(args.project || STAGING_PROJECT).trim();
  const dryRun = args.apply !== true;
  let db = null;
  const selectedCandidates = input.windowIds && args.allCandidates !== true
    ? input.candidates.filter((candidate) => input.windowIds.includes(String(candidate?.id || "")))
    : input.candidates;

  if (!dryRun) {
    assertStagingWriteAllowed({ projectId, confirm: String(args.confirm || "").trim() });
    initializeApp({ projectId });
    db = getFirestore();
  }

  const report = await writeTitleUpdateEvents({
    db,
    candidates: selectedCandidates,
    acquisitionMode: args.mode,
    publishEligible: args.publishEligible === true,
    dryRun,
    maxEvents: clampLimit(args.limit),
  });

  process.stdout.write(`${JSON.stringify({
    mode: dryRun ? "dry-run" : "apply",
    project: dryRun ? null : projectId,
    input: input.resolved,
    selection: input.windowIds && args.allCandidates !== true ? "candidateIdsInWindow" : "allCandidates",
    inputCandidates: input.candidates.length,
    selectedCandidates: selectedCandidates.length,
    acquisitionMode: args.mode,
    publishEligible: args.publishEligible === true,
    notificationFanout: false,
    report,
  }, null, 2)}\n`);

  if (report.errors.length) process.exitCode = 2;
}

main().catch((err) => {
  process.stderr.write(`apply-title-update-events fallito: ${err?.message || err}\n`);
  process.exitCode = 1;
});

module.exports = { STAGING_PROJECT, assertStagingWriteAllowed, clampLimit, readCandidates };
