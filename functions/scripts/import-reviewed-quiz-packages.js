#!/usr/bin/env node
"use strict";

/**
 * Pubblica due pacchetti quiz revisionati:
 * - sostituisce le 50 domande q_143_* de L'amica geniale;
 * - aggiunge le prime 50 domande di Manifest.
 *
 * Default dry-run. La write richiede sia --write sia --confirm-project gia-visto
 * e salva prima uno snapshot completo dei documenti rimossi.
 *
 * Uso (da functions/):
 *   node scripts/import-reviewed-quiz-packages.js \
 *     --amica /path/lamica_geniale_quiz_50_reviewed.json \
 *     --manifest /path/manifest_quiz_50_reviewed.json
 *
 *   node scripts/import-reviewed-quiz-packages.js ... \
 *     --write --confirm-project gia-visto --backup-dir /safe/backup/path
 */

const admin = require("firebase-admin");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PROJECT_ID = "gia-visto";
const EXPECTED_QUESTIONS = 50;
const PLAYABLE = new Set(["approved", "beta_pending_review"]);
const FIELD_ALLOWLIST = [
  "questionId", "tmdbId", "mediaType", "title", "questionText", "answers",
  "correctAnswerIndex", "explanation", "difficulty", "category", "spoilerLevel",
  "confidence", "sourceLevel", "sourceBasis", "riskNotes", "createdBy", "language",
];
const ENUMS = {
  difficulty: new Set(["easy", "medium", "hard"]),
  category: new Set(["anagraphic", "character", "plot", "scene", "relationship", "object", "motivation", "consequence", "episode", "quote_paraphrase", "chronology", "trivia"]),
  spoilerLevel: new Set(["none", "light", "medium", "heavy"]),
  confidence: new Set(["low", "medium", "high"]),
  sourceLevel: new Set(["GREEN", "YELLOW", "RED"]),
};
const PACKAGE_CONFIGS = [
  {
    key: "amica",
    title: "L'amica geniale",
    tmdbId: "78154",
    mediaType: "tv",
    expectedTitleId: "tmdb_tv_78154",
    idPattern: /^amica_geniale_\d{3}$/,
    retirePattern: /^q_143_(?:[1-9]|[1-4]\d|50)$/,
    retireCount: 50,
  },
  {
    key: "manifest",
    title: "Manifest",
    tmdbId: "79696",
    mediaType: "tv",
    expectedTitleId: "manifest-na-tv",
    idPattern: /^manifest_\d{3}$/,
    retirePattern: null,
    retireCount: 0,
  },
];

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

const WRITE = process.argv.includes("--write");
const CONFIRM_PROJECT = arg("--confirm-project");
const BACKUP_DIR = arg("--backup-dir");

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function normalizedText(value) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("it").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function deterministicAnswerOrder(question, sequenceIndex) {
  const correct = question.answers[question.correctAnswerIndex];
  const wrong = question.answers
    .filter((_, index) => index !== question.correctAnswerIndex)
    .sort((a, b) => sha256(`${question.questionId}:${a}`).localeCompare(sha256(`${question.questionId}:${b}`)));
  const desiredCorrectIndex = sequenceIndex % 4;
  const answers = wrong.slice();
  answers.splice(desiredCorrectIndex, 0, correct);
  return { answers, correctAnswerIndex: desiredCorrectIndex };
}

function loadAndPrepare(config, sourcePath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) fail(`Sorgente ${config.key} non trovata: ${sourcePath || "(mancante)"}`);
  const rawBytes = fs.readFileSync(sourcePath);
  let rows;
  try { rows = JSON.parse(rawBytes.toString("utf8")); } catch (error) { fail(`${config.key}: JSON non valido (${error.message})`); }
  if (!Array.isArray(rows) || rows.length !== EXPECTED_QUESTIONS) fail(`${config.key}: attese ${EXPECTED_QUESTIONS} domande, trovate ${Array.isArray(rows) ? rows.length : "root non-array"}`);

  const ids = new Set();
  const texts = new Set();
  const indexCounts = [0, 0, 0, 0];
  let correctIsLongest = 0;
  const questions = rows.map((source, sequenceIndex) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) fail(`${config.key} #${sequenceIndex + 1}: domanda non-object`);
    const unknown = Object.keys(source).filter((key) => !FIELD_ALLOWLIST.includes(key) && !["titleId", "status", "answerOrderShuffled"].includes(key));
    if (unknown.length) fail(`${source.questionId || config.key}: campi non ammessi: ${unknown.join(", ")}`);
    for (const field of FIELD_ALLOWLIST) if (!(field in source)) fail(`${source.questionId || config.key}: campo mancante ${field}`);
    if (!config.idPattern.test(source.questionId) || ids.has(source.questionId)) fail(`${config.key}: questionId non valido o duplicato ${source.questionId}`);
    ids.add(source.questionId);
    if (String(source.tmdbId) !== config.tmdbId || source.mediaType !== config.mediaType || source.title !== config.title) fail(`${source.questionId}: metadati titolo incoerenti`);
    if (typeof source.questionText !== "string" || !source.questionText.trim() || source.questionText.length > 95) fail(`${source.questionId}: questionText vuoto o oltre 95 caratteri`);
    const normalizedQuestion = normalizedText(source.questionText);
    if (texts.has(normalizedQuestion)) fail(`${source.questionId}: domanda duplicata`);
    texts.add(normalizedQuestion);
    if (!Array.isArray(source.answers) || source.answers.length !== 4 || source.answers.some((answer) => typeof answer !== "string" || !answer.trim() || answer.length > 34)) fail(`${source.questionId}: servono 4 risposte non vuote, massimo 34 caratteri`);
    if (new Set(source.answers.map(normalizedText)).size !== 4) fail(`${source.questionId}: risposte duplicate`);
    if (!Number.isInteger(source.correctAnswerIndex) || source.correctAnswerIndex < 0 || source.correctAnswerIndex > 3) fail(`${source.questionId}: correctAnswerIndex non valido`);
    if (typeof source.explanation !== "string" || !source.explanation.trim()) fail(`${source.questionId}: explanation mancante`);
    for (const [field, values] of Object.entries(ENUMS)) if (!values.has(source[field])) fail(`${source.questionId}: ${field} non valido (${source[field]})`);
    if (source.language !== "it") fail(`${source.questionId}: language deve essere it`);

    const shuffled = deterministicAnswerOrder(source, sequenceIndex);
    indexCounts[shuffled.correctAnswerIndex] += 1;
    const answerLengths = shuffled.answers.map((answer) => answer.length);
    if (answerLengths[shuffled.correctAnswerIndex] === Math.max(...answerLengths)) correctIsLongest += 1;

    const allowed = Object.fromEntries(FIELD_ALLOWLIST.map((field) => [field, source[field]]));
    return {
      ...allowed,
      titleId: config.expectedTitleId,
      tmdbId: config.tmdbId,
      status: "approved",
      answers: shuffled.answers,
      correctAnswerIndex: shuffled.correctAnswerIndex,
      answerOrderShuffled: true,
    };
  });

  return {
    config,
    sourcePath: path.resolve(sourcePath),
    sourceSha256: sha256(rawBytes),
    questions,
    indexCounts,
    correctIsLongest,
  };
}

function encodeFirestore(value) {
  if (value instanceof admin.firestore.Timestamp) return { __somtoType: "timestamp", millis: value.toMillis() };
  if (value instanceof Date) return { __somtoType: "date", iso: value.toISOString() };
  if (Array.isArray(value)) return value.map(encodeFirestore);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeFirestore(item)]));
  return value;
}

async function resolveTitle(db, config) {
  const snap = await db.collection("titles").where("tmdbId", "==", Number(config.tmdbId)).get();
  const matches = snap.docs.filter((doc) => String(doc.data()?.type || "").toLowerCase() === config.mediaType);
  if (matches.length !== 1) fail(`${config.key}: atteso un match catalogo, trovati ${matches.length}`);
  const match = matches[0];
  if (match.id !== config.expectedTitleId || match.data()?.status !== "approved") fail(`${config.key}: title match inatteso ${match.id} (${match.data()?.status || "no-status"})`);
  return { id: match.id, name: match.data()?.name || "", type: match.data()?.type, tmdbId: match.data()?.tmdbId };
}

async function dependencyHits(db, questionIds) {
  const ids = new Set(questionIds);
  const checks = [
    ["quizChallenges", await db.collection("quizChallenges").select("questionIds").get()],
    ["quizAttempts", await db.collectionGroup("quizAttempts").select("questionIds").get()],
    ["quizSessions", await db.collection("quizSessions").select("questions").get()],
    ["quizQuestionReports", await db.collection("quizQuestionReports").select("questionId").get()],
  ];
  const hits = [];
  for (const [collection, snap] of checks) {
    for (const doc of snap.docs) {
      const data = doc.data() || {};
      const referenced = [data.questionId, ...(Array.isArray(data.questionIds) ? data.questionIds : []), ...(Array.isArray(data.questions) ? data.questions.map((q) => q?.questionId) : [])]
        .filter((id) => ids.has(id));
      if (referenced.length) hits.push({ collection, docId: doc.id, questionIds: referenced });
    }
  }
  return hits;
}

async function main() {
  const prepared = PACKAGE_CONFIGS.map((config) => loadAndPrepare(config, arg(`--${config.key}`)));
  admin.initializeApp({ projectId: PROJECT_ID });
  const db = admin.firestore();

  const titleMatches = [];
  for (const pkg of prepared) titleMatches.push(await resolveTitle(db, pkg.config));

  const amica = prepared.find((pkg) => pkg.config.key === "amica");
  const oldSnap = await db.collection("quizQuestions").where("titleId", "==", amica.config.expectedTitleId).get();
  const oldDocs = oldSnap.docs.filter((doc) => amica.config.retirePattern.test(doc.id));
  if (oldDocs.length !== amica.config.retireCount || oldSnap.size !== amica.config.retireCount) fail(`L'amica geniale: attese ${amica.config.retireCount} vecchie domande q_143_*, trovate ${oldDocs.length}/${oldSnap.size} totali`);

  const incoming = prepared.flatMap((pkg) => pkg.questions);
  const incomingRefs = incoming.map((q) => db.collection("quizQuestions").doc(q.questionId));
  const collisions = (await db.getAll(...incomingRefs)).filter((doc) => doc.exists).map((doc) => doc.id);
  if (collisions.length) fail(`Collisioni questionId: ${collisions.join(", ")}`);

  const dependencies = await dependencyHits(db, oldDocs.map((doc) => doc.id));
  if (dependencies.length) fail(`Le vecchie domande sono referenziate: ${JSON.stringify(dependencies)}`);

  const beforeMeta = await db.collection("quizMeta").doc("themes").get();
  const playableBefore = Number(beforeMeta.data()?.totalQuestions || 0);
  const titlesBefore = Number(beforeMeta.data()?.totalTitles || 0);
  const report = {
    mode: WRITE ? "WRITE" : "DRY-RUN",
    project: PROJECT_ID,
    sources: prepared.map((pkg) => ({ key: pkg.config.key, path: pkg.sourcePath, sha256: pkg.sourceSha256 })),
    titleMatches,
    create: incoming.length,
    delete: oldDocs.length,
    collisions: collisions.length,
    dependencies: dependencies.length,
    status: "approved",
    answerIndexDistribution: Object.fromEntries(prepared.map((pkg) => [pkg.config.key, pkg.indexCounts])),
    correctIsLongest: Object.fromEntries(prepared.map((pkg) => [pkg.config.key, pkg.correctIsLongest])),
    expectedMetaAfterRebuild: { totalTitles: titlesBefore + 1, totalQuestions: playableBefore + incoming.length - oldDocs.length },
  };
  console.log(JSON.stringify(report, null, 2));

  if (!WRITE) return;
  if (CONFIRM_PROJECT !== PROJECT_ID) fail(`Write richiede --confirm-project ${PROJECT_ID}`);
  if (!BACKUP_DIR) fail("Write richiede --backup-dir");
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const backupPath = path.join(path.resolve(BACKUP_DIR), `quiz-reviewed-import-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  const backup = {
    schemaVersion: 1,
    project: PROJECT_ID,
    createdAt: new Date().toISOString(),
    sources: report.sources,
    newQuestionIds: incoming.map((q) => q.questionId),
    removedQuestions: oldDocs.map((doc) => ({ id: doc.id, data: encodeFirestore(doc.data()) })),
    quizMetaThemesBefore: beforeMeta.exists ? encodeFirestore(beforeMeta.data()) : null,
  };
  fs.writeFileSync(backupPath, `${JSON.stringify(backup, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(`Backup scritto: ${backupPath}`);

  const batch = db.batch();
  for (const doc of oldDocs) batch.delete(doc.ref);
  for (const question of incoming) {
    const ref = db.collection("quizQuestions").doc(question.questionId);
    batch.create(ref, {
      ...canonical(question),
      importedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      moderation: {
        approvedBy: "reviewed_import_2026_08_29",
        approvedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
    });
  }
  await batch.commit();

  for (const pkg of prepared) {
    const verify = await db.collection("quizQuestions")
      .where("titleId", "==", pkg.config.expectedTitleId)
      .where("status", "in", [...PLAYABLE])
      .get();
    if (verify.size !== EXPECTED_QUESTIONS) fail(`${pkg.config.title}: verifica post-write fallita (${verify.size})`);
  }
  console.log(`WRITE completata: create ${incoming.length}, delete ${oldDocs.length}. quizMeta/themes va ora ricostruito.`);
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
