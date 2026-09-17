#!/usr/bin/env node
/**
 * Audit Italian accent issues in quiz questions.
 *
 * Checks:
 *   - vowel + apostrophe, e.g. e', perche'
 *   - standalone "e" in places that often should be "è"
 *
 * Usage from repo root:
 *   node functions/scripts/audit-quiz-accents.js --download
 *   node functions/scripts/audit-quiz-accents.js --source quiz_beta/quiz_questions_to_10k_import_ready.json
 *   node functions/scripts/audit-quiz-accents.js --source quiz_beta/quiz_questions_to_10k_import_ready.json --write-source
 */
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const OUT_DIR = path.join(ROOT, "quiz_beta/audit-accents");
const DEFAULT_EXPORT = path.join(OUT_DIR, "quizQuestions_firestore_export.json");
const args = new Set(process.argv.slice(2));
const DOWNLOAD = args.has("--download");
const WRITE_SOURCE = args.has("--write-source");
const SOURCE = (() => {
  const idx = process.argv.indexOf("--source");
  if (idx === -1) return DOWNLOAD ? DEFAULT_EXPORT : "";
  return path.resolve(process.argv[idx + 1]);
})();
const REPORT_PREFIX = (() => {
  const idx = process.argv.indexOf("--report-prefix");
  if (idx !== -1) return safeSlug(process.argv[idx + 1] || "accent_audit");
  if (DOWNLOAD) return "firestore";
  if (SOURCE) return safeSlug(path.basename(SOURCE, path.extname(SOURCE)));
  return "accent_audit";
})();

const TEXT_FIELDS = [
  "questionText",
  "explanation",
  "sourceBasis",
  "riskNotes",
  "title",
];

const APOSTROPHE_RE = /[AEIOUaeiou]['’]/g;
const STANDALONE_E_RE = /\be\b/g;

const AUTO_APOSTROPHE_FIXES = [
  [/\b[Ee]['’]\b/g, (m) => (m[0] === "E" ? "È" : "è")],
  [/\bperche['’]\b/gi, preserveCase("perché")],
  [/\bpoiche['’]\b/gi, preserveCase("poiché")],
  [/\bfinche['’]\b/gi, preserveCase("finché")],
  [/\bbenche['’]\b/gi, preserveCase("benché")],
  [/\baffinche['’]\b/gi, preserveCase("affinché")],
  [/\bse['’]\b/gi, preserveCase("sé")],
  [/\bcioe['’]\b/gi, preserveCase("cioè")],
  [/\bnonche['’]\b/gi, preserveCase("nonché")],
  [/\bne['’]\b/gi, preserveCase("né")],
  [/\bpiu['’]\b/gi, preserveCase("più")],
  [/\bpuo['’]\b/gi, preserveCase("può")],
  [/\bpero['’]\b/gi, preserveCase("però")],
  [/\bcosi['’]\b/gi, preserveCase("così")],
  [/\bgia['’]\b/gi, preserveCase("già")],
];

function preserveCase(replacement) {
  return (match) => /^[A-Z]/.test(match) ? capitalize(replacement) : replacement;
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeSlug(value) {
  return String(value || "accent_audit")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "accent_audit";
}

function readQuestionsFromJson(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (Array.isArray(raw)) return { raw, questions: raw, wrapperKey: null };
  if (Array.isArray(raw.questions)) return { raw, questions: raw.questions, wrapperKey: "questions" };
  throw new Error(`Unsupported source shape: ${file}`);
}

async function downloadQuestions() {
  admin.initializeApp({ projectId: "gia-visto" });
  const db = admin.firestore();
  const snap = await db.collection("quizQuestions").get();
  const questions = snap.docs.map((doc) => ({ questionId: doc.id, ...doc.data() }));
  questions.sort((a, b) => String(a.questionId).localeCompare(String(b.questionId)));
  ensureDir(OUT_DIR);
  fs.writeFileSync(DEFAULT_EXPORT, JSON.stringify({ exportedAt: stamp(), count: questions.length, questions }, null, 2));
  return { raw: { questions }, questions, wrapperKey: "questions", sourceFile: DEFAULT_EXPORT };
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function getTextEntries(q) {
  const out = [];
  for (const field of TEXT_FIELDS) {
    if (typeof q[field] === "string" && q[field]) out.push({ field, index: null, text: q[field] });
  }
  if (Array.isArray(q.answers)) {
    q.answers.forEach((text, index) => {
      if (typeof text === "string" && text) out.push({ field: "answers", index, text });
    });
  }
  return out;
}

function setText(q, entry, nextText) {
  if (entry.field === "answers") q.answers[entry.index] = nextText;
  else q[entry.field] = nextText;
}

function applyAutoFixes(text) {
  let next = text;
  for (const [re, fix] of AUTO_APOSTROPHE_FIXES) next = next.replace(re, fix);
  return next;
}

function suggestMissingAccentFixes(text) {
  const replacements = [
    [/\b([Qq]ual) e\b/g, "$1 è"],
    [/\b([Cc]hi) e\b/g, "$1 è"],
    [/\b([Cc]os) e\b/g, "$1'è"],
    [/\b([Cc])'e\b/g, "$1'è"],
    [/\b([Pp])iu\b/g, "$1iù"],
    [/\b([Rr])ealta\b/g, "$1ealtà"],
    [/\b([Aa])ttivita\b/g, "$1ttività"],
    [/\b([Cc])itta\b/g, "$1ittà"],
    [/\b([Ee])ta\b/g, "$1tà"],
    [/\b([Ll])iberta\b/g, "$1ibertà"],
    [/\b([Pp])ossibilita\b/g, "$1ossibilità"],
    [/\b([Uu])niversita\b/g, "$1niversità"],
    [/\b([Ss])ara\s+(distrutto|distrutta|sconfitto|sconfitta|rivelato|rivelata|costretto|costretta|usato|usata|legato|legata|associato|associata)\b/g, "$1arà $2"],
    [/^([A-ZÀ-Ý][\p{L}'.-]*(?:\s+[A-ZÀ-Ý][\p{L}'.-]*){0,3}) e (interpretato|interpretata|basato|basata|ambientato|ambientata|noto|nota)\b/gu, "$1 è $2"],
    [/([.!?]\s+)([A-ZÀ-Ý][\p{L}'.-]*(?:\s+[A-ZÀ-Ý][\p{L}'.-]*){0,3}) e (interpretato|interpretata|basato|basata|ambientato|ambientata|noto|nota)\b/gu, "$1$2 è $3"],
  ];
  let next = text;
  for (const [re, replacement] of replacements) next = next.replace(re, replacement);
  return next;
}

function context(text, index, length) {
  const start = Math.max(0, index - 55);
  const end = Math.min(text.length, index + length + 55);
  return text.slice(start, end);
}

function issue(q, entry, kind, match, index, suggestion = "") {
  return {
    questionId: q.questionId,
    title: q.title || "",
    field: entry.field,
    answerIndex: entry.index,
    kind,
    match,
    suggestion,
    context: context(entry.text, index, String(match).length),
  };
}

function audit(questions) {
  const apostropheIssues = [];
  const standaloneE = [];
  const autoChanges = [];
  const suggestedMissingAccentChanges = [];

  for (const q of questions) {
    for (const entry of getTextEntries(q)) {
      let m;
      APOSTROPHE_RE.lastIndex = 0;
      while ((m = APOSTROPHE_RE.exec(entry.text))) {
        const fixed = applyAutoFixes(m[0]);
        apostropheIssues.push(issue(q, entry, "vowel_apostrophe", m[0], m.index, fixed !== m[0] ? fixed : ""));
      }

      STANDALONE_E_RE.lastIndex = 0;
      while ((m = STANDALONE_E_RE.exec(entry.text))) {
        standaloneE.push(issue(q, entry, "standalone_e_review", m[0], m.index));
      }

      const nextText = applyAutoFixes(entry.text);
      if (nextText !== entry.text) {
        autoChanges.push({
          questionId: q.questionId,
          title: q.title || "",
          field: entry.field,
          answerIndex: entry.index,
          before: entry.text,
          after: nextText,
        });
      }

      const suggestedText = suggestMissingAccentFixes(entry.text);
      if (suggestedText !== entry.text) {
        suggestedMissingAccentChanges.push({
          questionId: q.questionId,
          title: q.title || "",
          field: entry.field,
          answerIndex: entry.index,
          before: entry.text,
          after: suggestedText,
        });
      }
    }
  }

  return { apostropheIssues, standaloneE, autoChanges, suggestedMissingAccentChanges };
}

function writeReport({ sourceFile, questions, result }) {
  ensureDir(OUT_DIR);
  const reportPath = path.join(OUT_DIR, `${REPORT_PREFIX}_accent_audit_report.json`);
  const mdReportPath = path.join(OUT_DIR, `${REPORT_PREFIX}_accent_audit_report.md`);
  const report = {
    generatedAt: stamp(),
    sourceFile,
    totalQuestions: questions.length,
    counts: {
      vowelApostrophe: result.apostropheIssues.length,
      standaloneE: result.standaloneE.length,
      autoFixableEntries: result.autoChanges.length,
      suggestedMissingAccentEntries: result.suggestedMissingAccentChanges.length,
    },
    apostropheIssues: result.apostropheIssues,
    standaloneE: result.standaloneE,
    autoChanges: result.autoChanges,
    suggestedMissingAccentChanges: result.suggestedMissingAccentChanges,
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  const lines = [
    "# Quiz Accent Audit",
    "",
    `Generated: ${report.generatedAt}`,
    `Source: ${sourceFile}`,
    `Questions: ${questions.length}`,
    "",
    "## Counts",
    "",
    `- vowel + apostrophe: ${report.counts.vowelApostrophe}`,
    `- standalone e to review: ${report.counts.standaloneE}`,
    `- auto-fixable text entries: ${report.counts.autoFixableEntries}`,
    `- suggested missing-accent entries: ${report.counts.suggestedMissingAccentEntries}`,
    "",
    "## Vowel + Apostrophe",
    "",
    ...result.apostropheIssues.slice(0, 200).map((x) => `- ${x.questionId} ${x.field}${x.answerIndex === null ? "" : `[${x.answerIndex}]`}: \`${x.context}\`${x.suggestion ? ` → ${x.suggestion}` : ""}`),
    "",
    "## Standalone E Samples",
    "",
    ...result.standaloneE.slice(0, 300).map((x) => `- ${x.questionId} ${x.field}${x.answerIndex === null ? "" : `[${x.answerIndex}]`}: \`${x.context}\``),
    "",
    "## Suggested Missing-Accent Fixes",
    "",
    ...result.suggestedMissingAccentChanges.slice(0, 300).map((x) => `- ${x.questionId} ${x.field}${x.answerIndex === null ? "" : `[${x.answerIndex}]`}\n  - before: ${x.before}\n  - after: ${x.after}`),
  ];
  fs.writeFileSync(mdReportPath, lines.join("\n"));
  return { report, reportPath, mdReportPath };
}

function applySourceChanges(sourceFile, raw, questions, wrapperKey, changes) {
  const byQuestion = new Map(questions.map((q) => [q.questionId, q]));
  for (const change of changes) {
    const q = byQuestion.get(change.questionId);
    if (!q) continue;
    if (change.field === "answers") q.answers[change.answerIndex] = change.after;
    else q[change.field] = change.after;
  }
  const out = wrapperKey ? { ...raw, [wrapperKey]: questions } : questions;
  fs.writeFileSync(sourceFile, JSON.stringify(out, null, 2));
}

async function main() {
  let sourceFile = SOURCE;
  let loaded;
  if (DOWNLOAD) {
    loaded = await downloadQuestions();
    sourceFile = loaded.sourceFile;
  } else {
    if (!sourceFile) throw new Error("Pass --download or --source <json>");
    loaded = readQuestionsFromJson(sourceFile);
  }

  const result = audit(loaded.questions);
  const { report, reportPath, mdReportPath } = writeReport({ sourceFile, questions: loaded.questions, result });

  if (WRITE_SOURCE && result.autoChanges.length > 0) {
    if (DOWNLOAD) throw new Error("--write-source is not allowed with --download export");
    applySourceChanges(sourceFile, loaded.raw, loaded.questions, loaded.wrapperKey, result.autoChanges);
  }

  console.log(JSON.stringify({
    sourceFile,
    totalQuestions: loaded.questions.length,
    vowelApostrophe: report.counts.vowelApostrophe,
    standaloneE: report.counts.standaloneE,
    autoFixableEntries: report.counts.autoFixableEntries,
    suggestedMissingAccentEntries: report.counts.suggestedMissingAccentEntries,
    report: path.relative(ROOT, reportPath),
    mdReport: path.relative(ROOT, mdReportPath),
    wroteSource: Boolean(WRITE_SOURCE && result.autoChanges.length > 0),
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
