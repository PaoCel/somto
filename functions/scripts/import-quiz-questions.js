#!/usr/bin/env node
/**
 * import-quiz-questions.js
 *
 * Reads quiz_beta/quiz_questions_import_ready.json and writes each question
 * into Firestore collection `quizQuestions/{questionId}` (set with merge so
 * the script is idempotent).
 *
 * Status is preserved as in the source file (typically `beta_pending_review`).
 *
 * Usage:
 *   cd functions
 *   node scripts/import-quiz-questions.js              # dry-run, prints summary
 *   node scripts/import-quiz-questions.js --write      # apply writes
 *   node scripts/import-quiz-questions.js --write --limit 50
 */

const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

const WRITE = process.argv.includes("--write");
const LIMIT = (() => {
  const idx = process.argv.indexOf("--limit");
  if (idx === -1) return 0;
  const v = parseInt(process.argv[idx + 1], 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
})();

const SOURCE = path.resolve(
  __dirname,
  "../../quiz_beta/quiz_questions_import_ready.json"
);

if (!fs.existsSync(SOURCE)) {
  console.error("Source file not found:", SOURCE);
  process.exit(1);
}

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

async function main() {
  const raw = JSON.parse(fs.readFileSync(SOURCE, "utf8"));
  if (!Array.isArray(raw.questions)) {
    console.error('Source JSON missing "questions" array.');
    process.exit(1);
  }
  let questions = raw.questions;
  if (LIMIT > 0) questions = questions.slice(0, LIMIT);

  console.log("=".repeat(60));
  console.log("Import quiz questions");
  console.log("=".repeat(60));
  console.log("source        :", SOURCE);
  console.log("questions     :", questions.length);
  console.log("mode          :", WRITE ? "WRITE" : "DRY-RUN");
  console.log();

  const byStatus = {};
  for (const q of questions) {
    byStatus[q.status] = (byStatus[q.status] || 0) + 1;
  }
  console.log("status breakdown:", byStatus);

  if (!WRITE) {
    console.log("\n[dry-run] no documents written. Re-run with --write to apply.");
    return;
  }

  const batchSize = 400;
  let writtenCount = 0;
  for (let i = 0; i < questions.length; i += batchSize) {
    const slice = questions.slice(i, i + batchSize);
    const batch = db.batch();
    for (const q of slice) {
      if (!q.questionId) continue;
      const ref = db.collection("quizQuestions").doc(q.questionId);
      const payload = {
        ...q,
        // Replace `null` with a Firestore-friendly default and ensure status default.
        status: q.status || "beta_pending_review",
        importedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      batch.set(ref, payload, { merge: true });
    }
    await batch.commit();
    writtenCount += slice.length;
    console.log(
      `  batch ${(i / batchSize) + 1}: wrote ${slice.length} (total ${writtenCount}/${questions.length})`
    );
  }

  console.log("\nDone. Total written:", writtenCount);
}

main().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});
