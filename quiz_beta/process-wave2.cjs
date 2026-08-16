#!/usr/bin/env node
/**
 * process-wave2.cjs
 *
 * Merge dei file generati dal fan-out (quiz_beta/wave2/q_<rank>.json, ognuno un
 * array di domande) → reshuffle Fisher-Yates di `answers` + riallineo
 * `correctAnswerIndex`, normalizzazione italiana deterministica, validazione
 * strutturale. Porta della logica di cleanup.cjs (batch top20).
 *
 * Output (in quiz_beta/):
 *  - quiz_questions_wave2_import_ready.json   ({ questions: [...] }, pronto per import)
 *  - quiz_questions_wave2_medium_review.json  (confidence==medium)
 *  - quiz_questions_wave2_heavy_spoiler_review.json (spoilerLevel==heavy)
 *  - _wave2_cleanup_stats.json
 *
 * Nessuna scrittura su DB. Run: node quiz_beta/process-wave2.cjs
 */
const fs = require('fs');
const path = require('path');

const DIR = path.resolve(__dirname, 'wave2');
const TITLES = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'quiz_wave2_titles.json'), 'utf8'));

// --- Italian normalization (stesse regole deterministiche del batch top20) ---
const fixCounts = {};
const FIXES = [
  { pat: /\bE'/g, rep: 'È', kind: "E' -> È" },
  { pat: /\be'/g, rep: 'è', kind: "e' -> è" },
  { pat: /\bqual e\b/gi, rep: (m) => (m[0] === 'Q' ? 'Qual è' : 'qual è'), kind: 'qual e -> qual è' },
  { pat: /\bperche\b/gi, rep: (m) => (m[0] === 'P' ? 'Perché' : 'perché'), kind: 'perche -> perché' },
  { pat: /\bpoiche\b/gi, rep: (m) => (m[0] === 'P' ? 'Poiché' : 'poiché'), kind: 'poiche -> poiché' },
  { pat: /\baffinche\b/gi, rep: (m) => (m[0] === 'A' ? 'Affinché' : 'affinché'), kind: 'affinche -> affinché' },
  { pat: /\bbenche\b/gi, rep: (m) => (m[0] === 'B' ? 'Benché' : 'benché'), kind: 'benche -> benché' },
  { pat: /\bfinche\b/gi, rep: (m) => (m[0] === 'F' ? 'Finché' : 'finché'), kind: 'finche -> finché' },
  { pat: /\bpiu\b/gi, rep: (m) => (m[0] === 'P' ? 'Più' : 'più'), kind: 'piu -> più' },
  { pat: /\bpuo\b/gi, rep: (m) => (m[0] === 'P' ? 'Può' : 'può'), kind: 'puo -> può' },
  { pat: /\bgia\b/gi, rep: (m) => (m[0] === 'G' ? 'Già' : 'già'), kind: 'gia -> già' },
  { pat: /\bcosi\b/gi, rep: (m) => (m[0] === 'C' ? 'Così' : 'così'), kind: 'cosi -> così' },
  { pat: /\bcitta\b/gi, rep: (m) => (m[0] === 'C' ? 'Città' : 'città'), kind: 'citta -> città' },
  { pat: /\bautorita\b/gi, rep: (m) => (m[0] === 'A' ? 'Autorità' : 'autorità'), kind: 'autorita -> autorità' },
  { pat: /\bcapacita\b/gi, rep: (m) => (m[0] === 'C' ? 'Capacità' : 'capacità'), kind: 'capacita -> capacità' },
  { pat: /\bqualita\b/gi, rep: (m) => (m[0] === 'Q' ? 'Qualità' : 'qualità'), kind: 'qualita -> qualità' },
  { pat: /\bverita\b/gi, rep: (m) => (m[0] === 'V' ? 'Verità' : 'verità'), kind: 'verita -> verità' },
  { pat: /\brealta\b/gi, rep: (m) => (m[0] === 'R' ? 'Realtà' : 'realtà'), kind: 'realta -> realtà' },
  { pat: /\bsocieta\b/gi, rep: (m) => (m[0] === 'S' ? 'Società' : 'società'), kind: 'societa -> società' },
  { pat: /\bnovita\b/gi, rep: (m) => (m[0] === 'N' ? 'Novità' : 'novità'), kind: 'novita -> novità' },
  { pat: /\bliberta\b/gi, rep: (m) => (m[0] === 'L' ? 'Libertà' : 'libertà'), kind: 'liberta -> libertà' },
  { pat: /\bfelicita\b/gi, rep: (m) => (m[0] === 'F' ? 'Felicità' : 'felicità'), kind: 'felicita -> felicità' },
  { pat: /\beta\b/gi, rep: (m) => (m[0] === 'E' ? 'Età' : 'età'), kind: 'eta -> età' },
];
function normalize(s) {
  if (typeof s !== 'string') return s;
  let out = s;
  for (const f of FIXES) {
    let n = 0;
    out = out.replace(f.pat, (m) => { n++; return typeof f.rep === 'function' ? f.rep(m) : f.rep; });
    if (n) fixCounts[f.kind] = (fixCounts[f.kind] || 0) + n;
  }
  return out;
}
let questionsTouched = 0;
function normalizeQuestion(q) {
  let changed = false;
  for (const f of ['questionText', 'explanation', 'sourceBasis', 'riskNotes', 'title']) {
    const before = q[f]; const after = normalize(before);
    if (before !== after) { q[f] = after; changed = true; }
  }
  if (Array.isArray(q.answers)) {
    q.answers = q.answers.map((a) => { const after = normalize(a); if (a !== after) changed = true; return after; });
  }
  if (changed) questionsTouched++;
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// --- Merge da disco ---
const all = [];
const perTitle = [];
for (const t of TITLES) {
  const fp = path.join(DIR, `q_${t.rank}.json`);
  if (!fs.existsSync(fp)) { perTitle.push({ rank: t.rank, title: t.title, count: 0, missingFile: true }); continue; }
  let arr;
  try { arr = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { perTitle.push({ rank: t.rank, title: t.title, count: 0, parseError: e.message }); continue; }
  if (!Array.isArray(arr)) arr = Array.isArray(arr?.questions) ? arr.questions : [];
  perTitle.push({ rank: t.rank, title: t.title, count: arr.length, short: arr.length < 50 });
  for (const q of arr) all.push(q);
}

// --- Validazione + normalizzazione + reshuffle ---
const before = { 0: 0, 1: 0, 2: 0, 3: 0 };
const after = { 0: 0, 1: 0, 2: 0, 3: 0 };
const structuralIssues = [];
const ids = new Set();
const clean = [];
for (const q of all) {
  if (!Array.isArray(q.answers) || q.answers.length !== 4) { structuralIssues.push(['answers_len', q.questionId]); continue; }
  if (typeof q.correctAnswerIndex !== 'number' || q.correctAnswerIndex < 0 || q.correctAnswerIndex > 3) { structuralIssues.push(['bad_index', q.questionId]); continue; }
  if (q.answers.some((a) => !a || typeof a !== 'string' || !a.trim())) { structuralIssues.push(['empty_answer', q.questionId]); continue; }
  if (!q.questionId || ids.has(q.questionId)) { structuralIssues.push(['dup_or_missing_id', q.questionId]); continue; }
  ids.add(q.questionId);
  before[q.correctAnswerIndex]++;
  normalizeQuestion(q);
  const correct = q.answers[q.correctAnswerIndex];
  const shuffled = shuffle(q.answers);
  const newIdx = shuffled.indexOf(correct);
  if (newIdx < 0) { structuralIssues.push(['lost_correct', q.questionId]); continue; }
  q.answers = shuffled;
  q.correctAnswerIndex = newIdx;
  q.answerOrderShuffled = true;
  q.status = q.status || 'beta_pending_review';
  q.language = q.language || 'it';
  q.createdBy = q.createdBy || 'ai';
  after[newIdx]++;
  clean.push(q);
}

const mediumReview = clean.filter((q) => q.confidence === 'medium' || q.confidence === 'low');
const heavySpoiler = clean.filter((q) => q.spoilerLevel === 'heavy');
const conf = {}; const spo = {}; const diff = {}; const cat = {};
for (const q of clean) {
  conf[q.confidence] = (conf[q.confidence] || 0) + 1;
  spo[q.spoilerLevel] = (spo[q.spoilerLevel] || 0) + 1;
  diff[q.difficulty] = (diff[q.difficulty] || 0) + 1;
  cat[q.category] = (cat[q.category] || 0) + 1;
}
const ts = new Date(); const pad = (n) => String(n).padStart(2, '0');
const stamp = `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())} ${pad(ts.getHours())}:${pad(ts.getMinutes())}:${pad(ts.getSeconds())}`;

const importReady = {
  generatedAt: stamp,
  source: 'Somto quiz batch acquisizione (wave2 titles, rank 81..130)',
  totalTitles: TITLES.length,
  totalQuestions: clean.length,
  cleanup: { answerOrderShuffled: true, italianNormalizationApplied: true, fixCounts },
  questions: clean,
};
const W = (name, obj) => fs.writeFileSync(path.resolve(__dirname, name), JSON.stringify(obj, null, 2));
W('quiz_questions_wave2_import_ready.json', importReady);
W('quiz_questions_wave2_medium_review.json', { generatedAt: stamp, count: mediumReview.length, questions: mediumReview });
W('quiz_questions_wave2_heavy_spoiler_review.json', { generatedAt: stamp, count: heavySpoiler.length, questions: heavySpoiler });
const report = {
  generatedAt: stamp, totalQuestions: clean.length, expected: TITLES.length * 50,
  perTitle, indexBefore: before, indexAfter: after, questionsTouchedByNormalization: questionsTouched,
  fixCounts, confidence: conf, spoiler: spo, difficulty: diff, category: cat,
  structuralIssues, mediumReview: mediumReview.length, heavySpoiler: heavySpoiler.length,
};
W('_wave2_cleanup_stats.json', report);
console.log(JSON.stringify({ totalQuestions: clean.length, expected: TITLES.length * 50, shortTitles: perTitle.filter((p) => p.short || p.missingFile), indexAfter: after, confidence: conf, structuralIssues: structuralIssues.length }, null, 2));
