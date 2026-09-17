#!/usr/bin/env node
/**
 * apply-wave2-audit-fixes.js
 *
 * Legge le rilevazioni dell'audit (quiz_beta/audit-wave2/a_*.json) e applica i
 * fix alle domande LIVE in `quizQuestions`:
 *   - correctIndexShouldBe ∈ [0,3]  → corregge correctAnswerIndex (+ auditNote)
 *   - severity "critical" & idx < 0  → status:"flagged" (fuori dal pool) + auditNote
 *   - "minor"                        → solo backlog nel report, nessuna scrittura
 *
 * Idempotente. Dry-run default. Dopo il --write rilanciare il rebuild di quizMeta.
 *
 * Usage (da functions/):
 *   node scripts/apply-wave2-audit-fixes.js            # dry-run
 *   node scripts/apply-wave2-audit-fixes.js --write
 */
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

const WRITE = process.argv.includes("--write");
const AUDIT_DIR = path.resolve(__dirname, "../../quiz_beta/audit-wave2");
const REPORT = path.resolve(__dirname, "../../quiz_beta/AUDIT-WAVE2-REPORT.md");

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

function loadFindings() {
  if (!fs.existsSync(AUDIT_DIR)) return [];
  const out = [];
  for (const fn of fs.readdirSync(AUDIT_DIR)) {
    if (!/\.json$/.test(fn)) continue;
    let arr;
    try { arr = JSON.parse(fs.readFileSync(path.join(AUDIT_DIR, fn), "utf8")); } catch (_) { continue; }
    if (!Array.isArray(arr)) continue;
    for (const f of arr) {
      if (f && f.questionId) out.push(f);
    }
  }
  return out;
}

async function main() {
  const findings = loadFindings();
  // Dedupe per questionId: priorità a chi ha indexFix, poi critical, poi minor.
  const rank = (f) => (Number.isInteger(f.correctIndexShouldBe) && f.correctIndexShouldBe >= 0 ? 3 : f.severity === "critical" ? 2 : 1);
  const byQ = new Map();
  for (const f of findings) {
    const prev = byQ.get(f.questionId);
    if (!prev || rank(f) > rank(prev)) byQ.set(f.questionId, f);
  }
  const all = [...byQ.values()];
  const indexFixes = all.filter((f) => Number.isInteger(f.correctIndexShouldBe) && f.correctIndexShouldBe >= 0 && f.correctIndexShouldBe <= 3);
  const flags = all.filter((f) => !(Number.isInteger(f.correctIndexShouldBe) && f.correctIndexShouldBe >= 0) && f.severity === "critical");
  const minors = all.filter((f) => f.severity !== "critical" && !(Number.isInteger(f.correctIndexShouldBe) && f.correctIndexShouldBe >= 0));

  console.log("=".repeat(60));
  console.log("Apply wave2 audit fixes —", WRITE ? "WRITE" : "DRY-RUN");
  console.log("findings totali:", findings.length, "| univoci:", all.length);
  console.log("index-fix:", indexFixes.length, "| flag (critical):", flags.length, "| minor backlog:", minors.length);
  console.log("=".repeat(60));

  if (WRITE) {
    let n = 0;
    const batchAll = [...indexFixes.map((f) => ({ f, kind: "index" })), ...flags.map((f) => ({ f, kind: "flag" }))];
    for (let i = 0; i < batchAll.length; i += 400) {
      const slice = batchAll.slice(i, i + 400);
      const batch = db.batch();
      for (const { f, kind } of slice) {
        const ref = db.collection("quizQuestions").doc(f.questionId);
        if (kind === "index") {
          batch.set(ref, {
            correctAnswerIndex: f.correctIndexShouldBe,
            auditNote: String(f.problem || "").slice(0, 400),
            auditFixedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        } else {
          batch.set(ref, {
            status: "flagged",
            auditNote: String(f.problem || "").slice(0, 400),
            auditFix: String(f.fix || "").slice(0, 400),
            auditFlaggedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        }
      }
      await batch.commit();
      n += slice.length;
      console.log(`  batch: ${slice.length} (tot ${n}/${batchAll.length})`);
    }
    console.log("Scritture applicate:", n);
  } else {
    console.log("\n[dry-run] esempi index-fix:");
    indexFixes.slice(0, 8).forEach((f) => console.log(`  ${f.questionId} → idx ${f.correctIndexShouldBe}`));
    console.log("[dry-run] esempi flag:");
    flags.slice(0, 8).forEach((f) => console.log(`  ${f.questionId}: ${String(f.problem || "").slice(0, 90)}`));
  }

  // Report
  const md = [
    "# Audit wave2 + family-classics — report fix",
    "",
    `Findings univoci: ${all.length}. Index-fix: ${indexFixes.length}. Flagged: ${flags.length}. Minor backlog: ${minors.length}.`,
    "",
    "## Risposta corretta corretta (index-fix)",
    ...indexFixes.map((f) => `- **${f.questionId}** → index ${f.correctIndexShouldBe}. ${String(f.problem || "").slice(0, 180)}`),
    "",
    "## Domande flaggate (fuori dal pool)",
    ...flags.map((f) => `- **${f.questionId}**. ${String(f.problem || "").slice(0, 200)}\n  - fix: ${String(f.fix || "").slice(0, 160)}`),
    "",
    `## Minor (backlog, ${minors.length})`,
    ...minors.map((f) => `- ${f.questionId}: ${String(f.problem || "").slice(0, 130)}`),
  ].join("\n");
  fs.writeFileSync(REPORT, md);
  console.log("\nReport →", REPORT);
}

main().then(() => process.exit(0)).catch((e) => { console.error("Failed:", e); process.exit(1); });
