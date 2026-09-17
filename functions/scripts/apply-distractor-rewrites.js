#!/usr/bin/env node
/**
 * apply-distractor-rewrites.js — fase C2 del piano quiz.
 *
 * Due modi:
 *
 *   node scripts/apply-distractor-rewrites.js --validate <dirOut> --originals <tell-strong.json> --report <dir>
 *     Legge tutti i file `out_*.json` in <dirOut> (proposte [{id, answers}]),
 *     li valida contro le righe del triage e scrive in <dir>:
 *       accepted.json, rejected.json, missing.json, summary.md
 *
 *   node scripts/apply-distractor-rewrites.js --apply <accepted.json> [--write] [--limit N]
 *     Dry-run: stampa cosa cambierebbe. Con --write: prima salva il backup dei
 *     doc originali (answers + updatedAt) in <accepted.json>.backup.json, poi
 *     aggiorna `answers` in batch da 400 con precondizione: le answers sul doc
 *     devono essere ANCORA quelle del triage, altrimenti la riga si salta
 *     (qualcuno l'ha gia' toccata). `correctAnswerIndex` non cambia mai.
 *
 * Nessun altro campo viene toccato, a parte `distractorsRewrittenAt` e
 * `distractorsRewriteBatch`, che marcano la riga per l'audit successivo.
 */
const fs = require("fs");
const path = require("path");
const { validateBatch } = require("../lib/quizDistractorRewrite");

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
const WRITE = args.includes("--write");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function validate() {
  const dirOut = flag("--validate");
  const originalsFile = flag("--originals");
  const reportDir = flag("--report") || dirOut;
  if (!dirOut || !originalsFile) {
    console.error("uso: --validate <dirOut> --originals <tell-strong.json> [--report <dir>]");
    process.exit(2);
  }
  const originals = readJson(originalsFile);
  const proposals = [];
  const broken = [];
  for (const name of fs.readdirSync(dirOut).filter((f) => /^out_.*\.json$/.test(f)).sort()) {
    try {
      const parsed = readJson(path.join(dirOut, name));
      const list = Array.isArray(parsed) ? parsed : parsed.items || parsed.results || [];
      proposals.push(...list);
    } catch (err) {
      broken.push({ file: name, error: err.message });
    }
  }
  const { accepted, rejected, missing } = validateBatch(originals, proposals);
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, "accepted.json"), JSON.stringify(accepted, null, 1));
  fs.writeFileSync(path.join(reportDir, "rejected.json"), JSON.stringify(rejected, null, 1));
  fs.writeFileSync(path.join(reportDir, "missing.json"), JSON.stringify(missing, null, 1));
  const reasonCounts = {};
  for (const r of rejected) for (const reason of r.reasons) reasonCounts[reason.replace(/_\d$/, "")] = (reasonCounts[reason.replace(/_\d$/, "")] || 0) + 1;
  const summary = [
    "# Validazione riscrittura distrattori",
    "",
    `- Originali: ${originals.length}`,
    `- Proposte lette: ${proposals.length} (file rotti: ${broken.length})`,
    `- Accettate: ${accepted.length}`,
    `- Rifiutate: ${rejected.length}`,
    `- Mancanti: ${missing.length}`,
    "",
    "## Motivi di rifiuto",
    ...Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`),
    ...(broken.length ? ["", "## File non leggibili", ...broken.map((b) => `- ${b.file}: ${b.error}`)] : []),
    "",
  ].join("\n");
  fs.writeFileSync(path.join(reportDir, "summary.md"), summary);
  console.log(summary);
}

async function apply() {
  const acceptedFile = flag("--apply");
  const limit = Number(flag("--limit") || 0) || Infinity;
  if (!acceptedFile) {
    console.error("uso: --apply <accepted.json> [--write] [--limit N]");
    process.exit(2);
  }
  const accepted = readJson(acceptedFile).slice(0, limit);
  console.log(`${accepted.length} righe da applicare (${WRITE ? "WRITE" : "dry-run"})`);

  const admin = require("firebase-admin");
  admin.initializeApp({ projectId: "gia-visto" });
  const db = admin.firestore();
  const batchTag = new Date().toISOString().slice(0, 10);

  const backup = [];
  let applied = 0;
  let skipped = 0;
  let missingDocs = 0;
  const CHUNK = 400;
  for (let i = 0; i < accepted.length; i += CHUNK) {
    const slice = accepted.slice(i, i + CHUNK);
    const refs = slice.map((row) => db.collection("quizQuestions").doc(row.id));
    const snaps = await db.getAll(...refs);
    const batch = db.batch();
    let inBatch = 0;
    snaps.forEach((snap, j) => {
      const row = slice[j];
      if (!snap.exists) {
        missingDocs += 1;
        return;
      }
      const data = snap.data();
      const current = Array.isArray(data.answers) ? data.answers : [];
      const same = current.length === row.previousAnswers.length && current.every((a, k) => a === row.previousAnswers[k]);
      if (!same) {
        skipped += 1;
        return;
      }
      backup.push({ id: row.id, answers: current, correctAnswerIndex: data.correctAnswerIndex, updateTime: snap.updateTime?.toDate?.().toISOString?.() });
      if (WRITE) {
        batch.update(snap.ref, {
          answers: row.answers,
          distractorsRewrittenAt: admin.firestore.FieldValue.serverTimestamp(),
          distractorsRewriteBatch: batchTag,
        });
        inBatch += 1;
      }
      applied += 1;
    });
    if (WRITE && inBatch > 0) await batch.commit();
    console.log(`  ${Math.min(i + CHUNK, accepted.length)}/${accepted.length}`);
  }
  if (WRITE) {
    const backupFile = acceptedFile.replace(/\.json$/, "") + `.backup-${Date.now()}.json`;
    fs.writeFileSync(backupFile, JSON.stringify(backup, null, 1));
    console.log(`backup di ${backup.length} doc in ${backupFile}`);
  }
  console.log(`applicate: ${applied}, saltate (answers gia' cambiate): ${skipped}, doc mancanti: ${missingDocs}`);
  if (!WRITE) console.log("[dry-run] nessuna scrittura. Rilancia con --write.");
}

(async () => {
  if (flag("--validate")) await validate();
  else if (flag("--apply")) await apply();
  else {
    console.error("uso: --validate ... | --apply ...");
    process.exit(2);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
