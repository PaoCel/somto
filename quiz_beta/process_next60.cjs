#!/usr/bin/env node
/**
 * process_next60.cjs
 *
 * Merges batch_6..batch_20 (60 new titles × 25 questions = 1500), validates,
 * applies Italian normalization, shuffles answers (rebalancing correct index),
 * and emits import-ready JSON + review subsets + stats.
 *
 * Outputs:
 *   quiz_questions_next60_beta.json
 *   quiz_questions_next60_import_ready.json
 *   quiz_questions_next60_medium_review.json
 *   quiz_questions_next60_heavy_spoiler_review.json
 *   _next60_validation_stats.json
 *   _next60_cleanup_stats.json
 */

const fs = require('fs');
const path = require('path');

// ---------------- Merge ----------------
const batches = [];
for (let i = 6; i <= 20; i++) {
  batches.push(path.resolve(__dirname, `batch_${i}.json`));
}
const all = [];
for (const f of batches) {
  if (!fs.existsSync(f)) {
    console.error('Missing batch file:', f);
    process.exit(1);
  }
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!Array.isArray(d.questions)) {
    console.error('Bad batch shape:', f);
    process.exit(1);
  }
  all.push(...d.questions);
}
console.log('Merged', all.length, 'questions from', batches.length, 'batches.');

// ---------------- Pre-validation ----------------
const preIssues = [];
const ids = new Set();
const dupQTextByTitle = {};
for (const q of all) {
  if (!q.questionId || ids.has(q.questionId)) preIssues.push(['dup_or_missing_id', q.questionId]);
  ids.add(q.questionId);
  if (!Array.isArray(q.answers) || q.answers.length !== 4) preIssues.push(['answers_len', q.questionId]);
  if (q.answers && q.answers.some(a => !a || typeof a !== 'string' || !a.trim())) preIssues.push(['empty_answer', q.questionId]);
  if (typeof q.correctAnswerIndex !== 'number' || q.correctAnswerIndex < 0 || q.correctAnswerIndex > 3) preIssues.push(['bad_index', q.questionId, q.correctAnswerIndex]);
  if (!q.questionText) preIssues.push(['empty_qtext', q.questionId]);
  if (!q.language || q.language !== 'it') preIssues.push(['bad_lang', q.questionId]);
  const tid = q.titleId || '';
  const norm = (q.questionText || '').toLowerCase().replace(/[^a-z0-9àèéìòù ]/g, '').replace(/\s+/g, ' ').trim();
  dupQTextByTitle[tid] = dupQTextByTitle[tid] || new Map();
  const m = dupQTextByTitle[tid];
  m.set(norm, (m.get(norm) || 0) + 1);
}
for (const [tid, m] of Object.entries(dupQTextByTitle)) {
  for (const [k, v] of m) {
    if (v > 1) preIssues.push(['near_dup_text', tid, k.slice(0, 80), 'x' + v]);
  }
}

// ---------------- Pre-stats ----------------
const byTitle = {};
const byConfidence = { low: 0, medium: 0, high: 0 };
const bySource = { GREEN: 0, YELLOW: 0, RED: 0 };
const byDifficulty = { easy: 0, medium: 0, hard: 0 };
const bySpoiler = { none: 0, light: 0, medium: 0, heavy: 0 };
const byCategory = {};
const indexBefore = { 0: 0, 1: 0, 2: 0, 3: 0 };
for (const q of all) {
  byTitle[q.title] = (byTitle[q.title] || 0) + 1;
  byConfidence[q.confidence] = (byConfidence[q.confidence] || 0) + 1;
  bySource[q.sourceLevel] = (bySource[q.sourceLevel] || 0) + 1;
  byDifficulty[q.difficulty] = (byDifficulty[q.difficulty] || 0) + 1;
  bySpoiler[q.spoilerLevel] = (bySpoiler[q.spoilerLevel] || 0) + 1;
  byCategory[q.category] = (byCategory[q.category] || 0) + 1;
  indexBefore[q.correctAnswerIndex] = (indexBefore[q.correctAnswerIndex] || 0) + 1;
}

// ---------------- Save beta merged ----------------
const ts = new Date();
const pad = n => String(n).padStart(2, '0');
const stamp = `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())} ${pad(ts.getHours())}:${pad(ts.getMinutes())}:${pad(ts.getSeconds())}`;
const betaOut = {
  generatedAt: stamp,
  source: 'Somto DB next 60 most-watched titles (rank 21..80)',
  totalTitles: 60,
  totalQuestions: all.length,
  questions: all,
};
fs.writeFileSync(path.resolve(__dirname, 'quiz_questions_next60_beta.json'), JSON.stringify(betaOut, null, 2));

// ---------------- Italian normalization (same as cleanup.cjs) ----------------
const fixCounts = {};
const FIXES = [
  { pat: /\bE'/g, rep: 'È', kind: "E' -> È" },
  { pat: /\be'/g, rep: 'è', kind: "e' -> è" },
  { pat: /\bqual e\b/gi, rep: m => m[0] === 'Q' ? 'Qual è' : 'qual è', kind: 'qual e -> qual è' },
  { pat: /\bperche\b/gi, rep: m => m[0] === 'P' ? 'Perché' : 'perché', kind: 'perche -> perché' },
  { pat: /\bpoiche\b/gi, rep: m => m[0] === 'P' ? 'Poiché' : 'poiché', kind: 'poiche -> poiché' },
  { pat: /\baffinche\b/gi, rep: m => m[0] === 'A' ? 'Affinché' : 'affinché', kind: 'affinche -> affinché' },
  { pat: /\bbenche\b/gi, rep: m => m[0] === 'B' ? 'Benché' : 'benché', kind: 'benche -> benché' },
  { pat: /\bfinche\b/gi, rep: m => m[0] === 'F' ? 'Finché' : 'finché', kind: 'finche -> finché' },
  { pat: /\bpiu\b/gi, rep: m => m[0] === 'P' ? 'Più' : 'più', kind: 'piu -> più' },
  { pat: /\bpuo\b/gi, rep: m => m[0] === 'P' ? 'Può' : 'può', kind: 'puo -> può' },
  { pat: /\bgia\b/gi, rep: m => m[0] === 'G' ? 'Già' : 'già', kind: 'gia -> già' },
  { pat: /\bcosi\b/gi, rep: m => m[0] === 'C' ? 'Così' : 'così', kind: 'cosi -> così' },
  { pat: /\bcitta\b/gi, rep: m => m[0] === 'C' ? 'Città' : 'città', kind: 'citta -> città' },
  { pat: /\bautorita\b/gi, rep: m => m[0] === 'A' ? 'Autorità' : 'autorità', kind: 'autorita -> autorità' },
  { pat: /\bcapacita\b/gi, rep: m => m[0] === 'C' ? 'Capacità' : 'capacità', kind: 'capacita -> capacità' },
  { pat: /\bqualita\b/gi, rep: m => m[0] === 'Q' ? 'Qualità' : 'qualità', kind: 'qualita -> qualità' },
  { pat: /\bverita\b/gi, rep: m => m[0] === 'V' ? 'Verità' : 'verità', kind: 'verita -> verità' },
  { pat: /\brealta\b/gi, rep: m => m[0] === 'R' ? 'Realtà' : 'realtà', kind: 'realta -> realtà' },
  { pat: /\bsocieta\b/gi, rep: m => m[0] === 'S' ? 'Società' : 'società', kind: 'societa -> società' },
  { pat: /\bnovita\b/gi, rep: m => m[0] === 'N' ? 'Novità' : 'novità', kind: 'novita -> novità' },
  { pat: /\bliberta\b/gi, rep: m => m[0] === 'L' ? 'Libertà' : 'libertà', kind: 'liberta -> libertà' },
  { pat: /\bfelicita\b/gi, rep: m => m[0] === 'F' ? 'Felicità' : 'felicità', kind: 'felicita -> felicità' },
  { pat: /\beta\b/gi, rep: m => m[0] === 'E' ? 'Età' : 'età', kind: 'eta -> età' },
];

function normalize(s) {
  if (typeof s !== 'string') return s;
  let out = s;
  for (const f of FIXES) {
    let n = 0;
    out = out.replace(f.pat, (m) => {
      n++;
      return typeof f.rep === 'function' ? f.rep(m) : f.rep;
    });
    if (n) fixCounts[f.kind] = (fixCounts[f.kind] || 0) + n;
  }
  return out;
}

let questionsTouched = 0;
function normalizeQuestion(q) {
  let changed = false;
  const fields = ['questionText', 'explanation', 'sourceBasis', 'riskNotes', 'title'];
  for (const f of fields) {
    const before = q[f];
    const after = normalize(before);
    if (before !== after) {
      q[f] = after;
      changed = true;
    }
  }
  if (Array.isArray(q.answers)) {
    q.answers = q.answers.map(a => {
      const before = a;
      const after = normalize(a);
      if (before !== after) changed = true;
      return after;
    });
  }
  if (changed) questionsTouched++;
}

// ---------------- Reshuffle answers ----------------
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const indexAfter = { 0: 0, 1: 0, 2: 0, 3: 0 };
const structuralIssues = [];
const seenIds = new Set();
for (const q of all) {
  if (!Array.isArray(q.answers) || q.answers.length !== 4) {
    structuralIssues.push(['answers_len', q.questionId]);
    continue;
  }
  if (typeof q.correctAnswerIndex !== 'number' || q.correctAnswerIndex < 0 || q.correctAnswerIndex > 3) {
    structuralIssues.push(['bad_index', q.questionId]);
    continue;
  }
  if (q.answers.some(a => !a || typeof a !== 'string' || !a.trim())) {
    structuralIssues.push(['empty_answer', q.questionId]);
    continue;
  }
  normalizeQuestion(q);
  const correctAnswer = q.answers[q.correctAnswerIndex];
  const shuffled = shuffle(q.answers);
  const newIdx = shuffled.indexOf(correctAnswer);
  if (newIdx < 0) {
    structuralIssues.push(['lost_correct', q.questionId]);
    continue;
  }
  q.answers = shuffled;
  q.correctAnswerIndex = newIdx;
  q.answerOrderShuffled = true;
  indexAfter[newIdx]++;
  if (!q.questionId || seenIds.has(q.questionId)) structuralIssues.push(['dup_or_missing_id', q.questionId]);
  seenIds.add(q.questionId);
}

// ---------------- Final validation ----------------
const finalIssues = [];
for (const q of all) {
  if (!Array.isArray(q.answers) || q.answers.length !== 4) finalIssues.push(['answers_len', q.questionId]);
  if (q.answers && q.answers.some(a => !a || !a.trim())) finalIssues.push(['empty_answer', q.questionId]);
  if (q.correctAnswerIndex < 0 || q.correctAnswerIndex > 3) finalIssues.push(['bad_index', q.questionId]);
  if (!q.questionId) finalIssues.push(['no_id', q.questionId]);
}

// ---------------- Subsets for manual review ----------------
const mediumReview = all.filter(q => q.confidence === 'medium');
const heavySpoiler = all.filter(q => q.spoilerLevel === 'heavy');
const yellowSource = all.filter(q => q.sourceLevel === 'YELLOW');

// ---------------- Outputs ----------------
const importReady = {
  generatedAt: stamp,
  source: 'Somto DB next 60 most-watched titles (rank 21..80)',
  totalTitles: 60,
  totalQuestions: all.length,
  cleanup: {
    answerOrderShuffled: true,
    italianNormalizationApplied: true,
    fixCounts,
  },
  questions: all,
};
fs.writeFileSync(path.resolve(__dirname, 'quiz_questions_next60_import_ready.json'), JSON.stringify(importReady, null, 2));
fs.writeFileSync(path.resolve(__dirname, 'quiz_questions_next60_medium_review.json'), JSON.stringify({ generatedAt: stamp, count: mediumReview.length, questions: mediumReview }, null, 2));
fs.writeFileSync(path.resolve(__dirname, 'quiz_questions_next60_heavy_spoiler_review.json'), JSON.stringify({ generatedAt: stamp, count: heavySpoiler.length, questions: heavySpoiler }, null, 2));
fs.writeFileSync(path.resolve(__dirname, 'quiz_questions_next60_yellow_source_review.json'), JSON.stringify({ generatedAt: stamp, count: yellowSource.length, questions: yellowSource }, null, 2));

const validationOut = { total: all.length, byTitle, byConfidence, bySource, byDifficulty, bySpoiler, byCategory, indexBefore, issues: preIssues };
fs.writeFileSync(path.resolve(__dirname, '_next60_validation_stats.json'), JSON.stringify(validationOut, null, 2));

const cleanupReport = {
  generatedAt: stamp,
  total: all.length,
  indexBefore,
  indexAfter,
  questionsTouchedByNormalization: questionsTouched,
  fixCounts,
  confidence: byConfidence,
  spoiler: bySpoiler,
  difficulty: byDifficulty,
  category: byCategory,
  source: bySource,
  byTitleCount: Object.keys(byTitle).length,
  mediumReviewFile: { file: 'quiz_questions_next60_medium_review.json', count: mediumReview.length },
  heavySpoilerFile: { file: 'quiz_questions_next60_heavy_spoiler_review.json', count: heavySpoiler.length },
  yellowSourceFile: { file: 'quiz_questions_next60_yellow_source_review.json', count: yellowSource.length },
  structuralIssuesDuringProcessing: structuralIssues,
  finalIssues,
};
fs.writeFileSync(path.resolve(__dirname, '_next60_cleanup_stats.json'), JSON.stringify(cleanupReport, null, 2));

console.log('\n=== STATS ===');
console.log(JSON.stringify(cleanupReport, null, 2));
console.log('\nWROTE quiz_questions_next60_import_ready.json');
