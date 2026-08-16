#!/usr/bin/env node
/**
 * apply-quiz-audit-fixes.js
 *
 * Applica le correzioni dell'audit qualità (quiz_beta/AUDIT-NEXT50-REPORT.md):
 *  - fixIndex: corregge correctAnswerIndex (risposta segnata errata).
 *  - flag: imposta status="flagged" (esce dal pool giocabile, finisce nella
 *    coda admin) per le domande con premessa falsa / doppia risposta / testo
 *    rotto, da riscrivere. Aggiunge auditNote con il problema.
 * Aggiorna sia Firestore (prod) sia i file sorgente quiz_beta/next50/*.json.
 *
 * Dati: /tmp/audit_fix.json (prodotto dall'estrazione dell'output di audit).
 * Usage (da functions/):
 *   node scripts/apply-quiz-audit-fixes.js            # dry-run
 *   node scripts/apply-quiz-audit-fixes.js --write
 */
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

const WRITE = process.argv.includes("--write");
const DATA = JSON.parse(fs.readFileSync("/tmp/audit_fix.json", "utf8"));
const NEXT50_DIR = path.resolve(__dirname, "../../quiz_beta/next50");

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

function rankOf(qid) { const m = /^q_(\d+)_/.exec(qid); return m ? Number(m[1]) : null; }

// Patch dei file sorgente per coerenza (re-import non annullerebbe il fix).
function patchSource(qid, mutate) {
  const rank = rankOf(qid);
  if (!rank) return;
  const fp = path.join(NEXT50_DIR, `q_${rank}.json`);
  if (!fs.existsSync(fp)) return;
  const arr = JSON.parse(fs.readFileSync(fp, "utf8"));
  let changed = false;
  for (const q of arr) if (q.questionId === qid) { mutate(q); changed = true; }
  if (changed && WRITE) fs.writeFileSync(fp, JSON.stringify(arr, null, 2));
  return changed;
}

(async () => {
  console.log(`Audit fixes — mode: ${WRITE ? "WRITE" : "DRY-RUN"}`);
  console.log(`  fixIndex: ${DATA.fixIndex.length} | flag: ${DATA.flag.length}`);

  // 1) Correggi indice risposta corretta.
  for (const x of DATA.fixIndex) {
    console.log(`  FIX-INDEX ${x.qid} → ${x.newIndex} (${x.title})`);
    patchSource(x.qid, (q) => { q.correctAnswerIndex = x.newIndex; q.auditNote = "correctAnswerIndex corretto da audit"; });
    if (WRITE) {
      await db.collection("quizQuestions").doc(x.qid).set({
        correctAnswerIndex: x.newIndex,
        auditNote: "correctAnswerIndex corretto da audit",
        auditFixedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  }

  // 2) Flag domande difettose (fuori dal pool, da riscrivere).
  for (const x of DATA.flag) {
    console.log(`  FLAG ${x.qid} (${x.title})`);
    patchSource(x.qid, (q) => { q.status = "flagged"; q.auditNote = String(x.problem).slice(0, 480); });
    if (WRITE) {
      await db.collection("quizQuestions").doc(x.qid).set({
        status: "flagged",
        auditNote: String(x.problem).slice(0, 480),
        auditFix: String(x.fix || "").slice(0, 480),
        auditFlaggedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  }

  console.log(WRITE ? "\nDone (Firestore + source patched)." : "\n[dry-run] nothing written.");
})().then(() => process.exit(0)).catch((e) => { console.error("Failed:", e); process.exit(1); });
