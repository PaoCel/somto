#!/usr/bin/env node
/**
 * import-quiz-questions-next50.js
 *
 * Legge quiz_beta/quiz_questions_next50_import_ready.json e scrive ogni domanda
 * in `quizQuestions/{questionId}` (set merge, idempotente). Batch acquisizione
 * (rank 81..130). NON tocca le domande dei batch precedenti.
 *
 * Status preservato come nel file (beta_pending_review) → resta nascosto agli
 * utenti finché un admin non flippa ad `approved`.
 *
 * Usage (da functions/):
 *   node scripts/import-quiz-questions-next50.js            # dry-run
 *   node scripts/import-quiz-questions-next50.js --write     # applica
 *   node scripts/import-quiz-questions-next50.js --write --limit 50
 */
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const WRITE = process.argv.includes('--write');
const LIMIT = (() => {
  const idx = process.argv.indexOf('--limit');
  if (idx === -1) return 0;
  const v = parseInt(process.argv[idx + 1], 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
})();

const SOURCE = path.resolve(__dirname, '../../quiz_beta/quiz_questions_next50_import_ready.json');
if (!fs.existsSync(SOURCE)) { console.error('Source file not found:', SOURCE); process.exit(1); }

admin.initializeApp({ projectId: 'gia-visto' });
const db = admin.firestore();

async function main() {
  const raw = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
  if (!Array.isArray(raw.questions)) { console.error('Source JSON missing "questions" array.'); process.exit(1); }
  let questions = raw.questions;
  if (LIMIT > 0) questions = questions.slice(0, LIMIT);

  console.log('='.repeat(60));
  console.log('Import quiz questions — NEXT 50 TITLES (acquisizione)');
  console.log('='.repeat(60));
  console.log('source        :', SOURCE);
  console.log('questions     :', questions.length);
  console.log('mode          :', WRITE ? 'WRITE' : 'DRY-RUN');

  const byStatus = {}; const byConfidence = {};
  for (const q of questions) {
    byStatus[q.status] = (byStatus[q.status] || 0) + 1;
    byConfidence[q.confidence] = (byConfidence[q.confidence] || 0) + 1;
  }
  console.log('status breakdown   :', byStatus);
  console.log('confidence breakdown:', byConfidence);

  if (!WRITE) { console.log('\n[dry-run] no documents written. Re-run with --write to apply.'); return; }

  const batchSize = 400;
  let written = 0;
  for (let i = 0; i < questions.length; i += batchSize) {
    const slice = questions.slice(i, i + batchSize);
    const batch = db.batch();
    for (const q of slice) {
      if (!q.questionId) continue;
      const ref = db.collection('quizQuestions').doc(q.questionId);
      batch.set(ref, {
        ...q,
        status: q.status || 'beta_pending_review',
        importedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    await batch.commit();
    written += slice.length;
    console.log(`  batch ${(i / batchSize) + 1}: wrote ${slice.length} (total ${written}/${questions.length})`);
  }
  console.log('\nDone. Total written:', written);
}

main().catch((err) => { console.error('Import failed:', err); process.exit(1); });
