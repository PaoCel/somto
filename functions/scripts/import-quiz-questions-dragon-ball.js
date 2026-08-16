#!/usr/bin/env node
/**
 * import-quiz-questions-dragon-ball.js
 *
 * Importa il pacchetto Dragon Ball in quizQuestions/{questionId}.
 *
 * Default: 50 DBZ ripulite + 150 nuove (200 totali).
 * Opzioni:
 *   --new-only              importa solo le 150 nuove
 *   --clean-existing-only   importa solo le 50 DBZ esistenti ripulite
 *   --write                 applica le scritture, altrimenti dry-run
 *   --limit N               limita il numero di domande processate
 *
 * Uso da functions/:
 *   node scripts/import-quiz-questions-dragon-ball.js
 *   node scripts/import-quiz-questions-dragon-ball.js --new-only --write
 */
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

const WRITE = process.argv.includes("--write");
const NEW_ONLY = process.argv.includes("--new-only");
const CLEAN_EXISTING_ONLY = process.argv.includes("--clean-existing-only");
const LIMIT = (() => {
  const idx = process.argv.indexOf("--limit");
  if (idx === -1) return 0;
  const v = parseInt(process.argv[idx + 1], 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
})();

if (NEW_ONLY && CLEAN_EXISTING_ONLY) {
  console.error("Use only one of --new-only or --clean-existing-only.");
  process.exit(1);
}

const sourceName = CLEAN_EXISTING_ONLY
  ? "quiz_questions_dragon_ball_existing_dbz_cleaned_import_ready.json"
  : NEW_ONLY
    ? "quiz_questions_dragon_ball_expansion_import_ready.json"
    : "quiz_questions_dragon_ball_total_import_ready.json";

const SOURCE = path.resolve(__dirname, "../../quiz_beta/dragon-ball-expansion", sourceName);
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

  const byTitle = {};
  const byStatus = {};
  const byConfidence = {};
  for (const q of questions) {
    byTitle[q.title] = (byTitle[q.title] || 0) + 1;
    byStatus[q.status] = (byStatus[q.status] || 0) + 1;
    byConfidence[q.confidence] = (byConfidence[q.confidence] || 0) + 1;
  }

  console.log("=".repeat(64));
  console.log("Import quiz questions — Dragon Ball franchise");
  console.log("=".repeat(64));
  console.log("source        :", SOURCE);
  console.log("questions     :", questions.length);
  console.log("mode          :", WRITE ? "WRITE" : "DRY-RUN");
  console.log("by title      :", byTitle);
  console.log("status        :", byStatus);
  console.log("confidence    :", byConfidence);

  if (!WRITE) {
    console.log("\n[dry-run] no documents written. Re-run with --write to apply.");
    return;
  }

  const batchSize = 400;
  let written = 0;
  for (let i = 0; i < questions.length; i += batchSize) {
    const slice = questions.slice(i, i + batchSize);
    const batch = db.batch();
    for (const q of slice) {
      if (!q.questionId) continue;
      batch.set(db.collection("quizQuestions").doc(q.questionId), {
        ...q,
        status: q.status || "beta_pending_review",
        importedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    await batch.commit();
    written += slice.length;
    console.log(`  batch ${(i / batchSize) + 1}: wrote ${slice.length} (total ${written}/${questions.length})`);
  }
  console.log("\nDone. Total written:", written);
}

main().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});
