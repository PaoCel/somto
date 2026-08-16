#!/usr/bin/env node
/**
 * Read-only Firestore audit for quizQuestions.
 * It has no write flag and never creates files or mutates Firestore.
 *
 * Usage (from functions/):
 *   node scripts/audit-quiz-corpus.cjs --project gia-visto
 *   node scripts/audit-quiz-corpus.cjs --project somto-staging --json
 */
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { auditQuizCorpus } = require("../lib/quizCorpusAudit");

const args = yargs(hideBin(process.argv))
  .strict()
  .option("project", { type: "string", default: "gia-visto", describe: "Firebase project (read-only)" })
  .option("json", { type: "boolean", default: false, describe: "Print the complete JSON report" })
  .help()
  .parseSync();

async function readQuizQuestions(projectId) {
  if (!getApps().length) initializeApp({ projectId });
  const snapshot = await getFirestore().collection("quizQuestions").get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

function formatTextReport(report, projectId) {
  const approved = report.readiness.approved.summary;
  const pending = report.readiness.betaPendingReview.summary;
  const legacyPlayable = report.readiness.legacyPlayable.summary;
  return [
    "Quiz corpus audit (READ-ONLY)",
    `project: ${projectId}`,
    `questions: ${report.totalQuestions}`,
    `invalid structural: ${report.structuralValidity.invalidQuestions}`,
    `duplicate groups: ${report.duplicateQuestionTexts.duplicateGroups}`,
    `approved: ${approved.totalQuestions} | titles >=50: ${approved.titlesReadyAt50} | >=100: ${approved.titlesReadyAt100}`,
    `beta_pending_review: ${pending.totalQuestions} | titles >=50: ${pending.titlesReadyAt50} | >=100: ${pending.titlesReadyAt100}`,
    `legacy playable (approved + beta): ${legacyPlayable.totalQuestions} | titles >=50: ${legacyPlayable.titlesReadyAt50} | deficit to 50: ${legacyPlayable.totalDeficitTo50}`,
    "No Firestore documents or local files were written. Use --json for the complete report.",
  ].join("\n");
}

async function main() {
  const projectId = String(args.project || "").trim();
  if (!projectId) throw new Error("--project must not be empty");
  const report = auditQuizCorpus(await readQuizQuestions(projectId));
  const output = { project: projectId, ...report };
  process.stdout.write(args.json
    ? `${JSON.stringify(output, null, 2)}\n`
    : `${formatTextReport(report, projectId)}\n`);
}

main().catch((error) => {
  process.stderr.write(`audit-quiz-corpus failed: ${error?.message || error}\n`);
  process.exitCode = 1;
});
