#!/usr/bin/env node
/**
 * import-quiz-q172.js
 *
 * Importa le 50 domande di quiz_beta/wave2/q_172.json (titleId tmdb_movie_1891 =
 * L'Impero colpisce ancora) in `quizQuestions/{questionId}` (set merge, idempotente).
 * Erano state ESCLUSE dal merge wave2 per la collisione del doc tmdb_movie_1891
 * (ora risolta da fix-rome-empire-titles.js). Stesso shape dell'import wave2.
 *
 * Usage (da functions/):
 *   node scripts/import-quiz-q172.js            # dry-run
 *   node scripts/import-quiz-q172.js --write      # applica
 */
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

const WRITE = process.argv.includes("--write");
const SOURCE = path.resolve(__dirname, "../../quiz_beta/wave2/q_172.json");
const EXPECTED_TITLE_ID = "tmdb_movie_1891";

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

async function main() {
  const questions = JSON.parse(fs.readFileSync(SOURCE, "utf8"));
  console.log("=".repeat(60));
  console.log("Import quiz q_172 — L'Impero colpisce ancora");
  console.log("source   :", SOURCE);
  console.log("questions:", questions.length, "| mode:", WRITE ? "WRITE" : "DRY-RUN");

  const bad = questions.filter((q) => q.titleId !== EXPECTED_TITLE_ID || !q.questionId);
  if (bad.length) { console.error(`ABORT: ${bad.length} domande con titleId/questionId inatteso.`); process.exit(1); }

  // verifica che il titolo esista
  const t = await db.collection("titles").doc(EXPECTED_TITLE_ID).get();
  if (!t.exists) { console.error(`ABORT: titles/${EXPECTED_TITLE_ID} non esiste — esegui prima fix-rome-empire-titles.js --write`); process.exit(1); }
  if (t.data().type !== "movie" || Number(t.data().tmdbId) !== 1891) {
    console.error("ABORT: il doc titolo non e' il film Empire:", { type: t.data().type, tmdbId: t.data().tmdbId }); process.exit(1);
  }
  console.log(`titolo ok: "${t.data().name}" (${t.data().year})`);

  if (!WRITE) { console.log("\n[dry-run] nessuna scrittura. Re-run con --write."); return; }

  const batch = db.batch();
  for (const q of questions) {
    const ref = db.collection("quizQuestions").doc(q.questionId);
    batch.set(ref, {
      ...q,
      status: q.status || "beta_pending_review",
      importedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  await batch.commit();
  console.log(`\nDone. Scritte ${questions.length} domande.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("Failed:", e); process.exit(1); });
