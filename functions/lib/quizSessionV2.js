const { createHash } = require("crypto");

const CONTRACT_VERSION = 2;
const ALLOWED_COUNTS = new Set([3, 5, 10]);
const SESSION_TTL_MS = 20 * 60 * 1000;
const ACTIVE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const COMPLETED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ID_LENGTH = 128;
const MAX_TIME_MS = SESSION_TTL_MS;
const START_KEYS = new Set(["contractVersion", "clientRequestId", "mode", "titleId", "count", "language"]);
const SUBMIT_KEYS = new Set(["contractVersion", "sessionId", "idempotencyKey", "answers"]);
const ANSWER_KEYS = new Set(["questionId", "selectedIndex", "timeMs"]);

class QuizSessionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(message) {
  throw new QuizSessionError("invalid-argument", message);
}

function safeString(value, max = 600) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function assertAllowedKeys(value, allowed, label) {
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  if (extras.length) fail(`${label} contiene campi non supportati.`);
}

function requireId(value, field) {
  if (typeof value !== "string") fail(`${field} non valido.`);
  const id = value.trim();
  if (!id || id.length > MAX_ID_LENGTH || !/^[A-Za-z0-9_-]+$/.test(id)) fail(`${field} non valido.`);
  return id;
}

function requireUuid(value, field) {
  const key = safeString(value, MAX_ID_LENGTH);
  // UUIDv4/v7 are the supported client identifiers; accepting other UUID
  // versions avoids coupling the backend to a client UUID implementation.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
    fail(`${field} non valido.`);
  }
  return key.toLowerCase();
}

function validateStartRequest(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) fail("Payload non valido.");
  assertAllowedKeys(data, START_KEYS, "Payload");
  if (data.contractVersion !== CONTRACT_VERSION) fail("Versione contratto non supportata.");
  if (data.mode !== "solo") fail("Modalità quiz non supportata.");
  if (data.language !== "it") fail("Lingua quiz non supportata.");
  if (!ALLOWED_COUNTS.has(data.count)) fail("Numero domande non supportato.");
  const titleId = data.titleId == null ? null : requireId(data.titleId, "titleId");
  return {
    clientRequestId: requireUuid(data.clientRequestId, "clientRequestId"),
    mode: "solo",
    titleId,
    count: data.count,
    language: "it",
  };
}

function validateSubmitRequest(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) fail("Payload non valido.");
  assertAllowedKeys(data, SUBMIT_KEYS, "Payload");
  if (data.contractVersion !== CONTRACT_VERSION) fail("Versione contratto non supportata.");
  const sessionId = requireId(data.sessionId, "sessionId");
  const idempotencyKey = requireUuid(data.idempotencyKey, "idempotencyKey");
  if (!Array.isArray(data.answers) || data.answers.length < 1 || data.answers.length > 10) {
    fail("Risposte non valide.");
  }
  const seen = new Set();
  const answers = data.answers.map((answer) => {
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) fail("Risposta non valida.");
    assertAllowedKeys(answer, ANSWER_KEYS, "Risposta");
    const questionId = requireId(answer.questionId, "questionId");
    if (seen.has(questionId)) fail("Domanda duplicata.");
    seen.add(questionId);
    const selectedIndex = answer.selectedIndex;
    if (selectedIndex !== null && (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex > 3)) {
      fail("Indice risposta non valido.");
    }
    const timeMs = answer.timeMs;
    if (!Number.isInteger(timeMs) || timeMs < 0 || timeMs > MAX_TIME_MS) fail("Tempo risposta non valido.");
    return { questionId, selectedIndex, timeMs };
  });
  return { sessionId, idempotencyKey, answers };
}

function isPlayableQuestion(question) {
  if (!question || question.status !== "approved" || question.language !== "it") return false;
  if (!safeString(question.titleId, MAX_ID_LENGTH) || !safeString(question.questionText, 600)) return false;
  if (!Array.isArray(question.answers) || question.answers.length !== 4) return false;
  const answers = question.answers.map((answer) => safeString(answer, 240));
  if (answers.some((answer) => !answer)) return false;
  if (new Set(answers.map((answer) => answer.toLocaleLowerCase("it"))).size !== 4) return false;
  return Number.isInteger(question.correctAnswerIndex)
    && question.correctAnswerIndex >= 0
    && question.correctAnswerIndex <= 3;
}

function toSnapshot(question, fallbackId) {
  if (!isPlayableQuestion(question)) return null;
  const questionId = requireId(fallbackId || question.questionId, "questionId");
  return {
    questionId,
    titleId: requireId(question.titleId, "titleId"),
    title: safeString(question.title, 180),
    mediaType: safeString(question.mediaType, 20),
    questionText: safeString(question.questionText, 600),
    answers: question.answers.map((answer) => safeString(answer, 240)),
    difficulty: safeString(question.difficulty || "medium", 20) || "medium",
    spoilerLevel: safeString(question.spoilerLevel || "none", 20) || "none",
    correctAnswerIndex: question.correctAnswerIndex,
    explanation: safeString(question.explanation, 600),
  };
}

function publicQuestion(snapshot) {
  const { correctAnswerIndex, explanation, ...question } = snapshot;
  return question;
}

function shuffled(items, random = Math.random) {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function selectSnapshots(documents, count, random) {
  const unique = new Map();
  for (const doc of documents) {
    const snapshot = toSnapshot(doc.data || doc, doc.id);
    if (snapshot && !unique.has(snapshot.questionId)) unique.set(snapshot.questionId, snapshot);
  }
  const pool = [...unique.values()];
  if (pool.length < count) {
    throw new QuizSessionError("failed-precondition", "Non ci sono abbastanza domande approvate per iniziare.");
  }
  return shuffled(pool, random).slice(0, count);
}

function canonicalAnswers(answers) {
  return answers.slice().sort((a, b) => a.questionId.localeCompare(b.questionId)).map((a) => ({
    questionId: a.questionId,
    selectedIndex: a.selectedIndex,
    timeMs: a.timeMs,
  }));
}

function payloadHash(answers) {
  return createHash("sha256").update(JSON.stringify(canonicalAnswers(answers))).digest("hex");
}

function assertExactQuestionSet(snapshotQuestions, answers) {
  if (!Array.isArray(snapshotQuestions) || snapshotQuestions.length !== answers.length) {
    throw new QuizSessionError("invalid-argument", "Le risposte non corrispondono alla sessione.");
  }
  const expected = new Set(snapshotQuestions.map((q) => q.questionId));
  const received = new Set(answers.map((answer) => answer.questionId));
  if (expected.size !== snapshotQuestions.length) {
    throw new QuizSessionError("failed-precondition", "Snapshot sessione non valido.");
  }
  if (received.size !== answers.length) {
    throw new QuizSessionError("invalid-argument", "Le risposte contengono duplicati.");
  }
  for (const answer of answers) {
    if (!expected.has(answer.questionId)) {
      throw new QuizSessionError("invalid-argument", "Le risposte non corrispondono alla sessione.");
    }
  }
}

function scoreSubmission(snapshotQuestions, answers) {
  assertExactQuestionSet(snapshotQuestions, answers);
  const byId = new Map(answers.map((answer) => [answer.questionId, answer]));
  let score = 0;
  const counts = { correct: 0, wrong: 0, skipped: 0 };
  const results = snapshotQuestions.map((question) => {
    const answer = byId.get(question.questionId);
    const selectedIndex = answer.selectedIndex;
    const outcome = selectedIndex === null
      ? "skipped"
      : (selectedIndex === question.correctAnswerIndex ? "correct" : "wrong");
    counts[outcome] += 1;
    if (outcome === "correct") score += 1;
    else if (outcome === "wrong") score -= 0.2;
    return {
      questionId: question.questionId,
      selectedIndex,
      correctIndex: question.correctAnswerIndex,
      outcome,
      explanation: question.explanation || "",
      timeMs: answer.timeMs,
    };
  });
  return { score: Number(score.toFixed(1)), counts, results };
}

function romeDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const value = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  return { year: value("year"), month: value("month"), day: value("day") };
}

function romeDayKey(date = new Date()) {
  const { year, month, day } = romeDateParts(date);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function previousRomeDayKey(date = new Date()) {
  return romeDayKey(new Date(date.getTime() - 24 * 60 * 60 * 1000));
}

function isoWeekKey(date = new Date()) {
  const parts = romeDateParts(date);
  const local = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const day = local.getUTCDay() || 7;
  local.setUTCDate(local.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(local.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((local - yearStart) / 86400000) + 1) / 7);
  return `${local.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function completedReplay(session, idempotencyKey, hash) {
  if (session?.status !== "completed") return null;
  if (session.submitIdempotencyKey === idempotencyKey && session.submitPayloadHash === hash && session.result) {
    return { ...session.result, status: "already_completed" };
  }
  throw new QuizSessionError("failed-precondition", "La sessione è già stata completata.");
}

function computeReward(stats, correct, now = new Date()) {
  const data = stats || {};
  const today = romeDayKey(now);
  const yesterday = previousRomeDayKey(now);
  const storedStreak = Number(data.dailyStreak) || 0;
  const lastDay = data.lastPlayDayKey || null;
  const dailyStreak = lastDay === today ? Math.max(storedStreak, 1)
    : (lastDay === yesterday ? storedStreak + 1 : 1);
  const bestDailyStreak = Math.max(Number(data.bestDailyStreak) || 0, dailyStreak);
  const priorGames = data.dailyBonusDayKey === today ? (Number(data.dailyBonusGames) || 0) : 0;
  const dailyBonusGames = priorGames + 1;
  const dailyBonusActive = dailyBonusGames >= 3;
  const baseXp = 10 + (2 * correct);
  const xpAwarded = dailyBonusActive ? Math.round(baseXp * 1.2) : baseXp;
  return {
    xpAwarded, dailyStreak, dailyBonusActive,
    statsPatch: {
      totalScore: (Number(data.totalScore) || 0),
      attemptsCount: (Number(data.attemptsCount) || 0),
      correctCount: (Number(data.correctCount) || 0),
      wrongCount: (Number(data.wrongCount) || 0),
      skippedCount: (Number(data.skippedCount) || 0),
      xp: (Number(data.xp) || 0),
      bestDailyStreak, lastPlayDayKey: today, dailyBonusDayKey: today, dailyBonusGames,
    },
  };
}

module.exports = {
  CONTRACT_VERSION, SESSION_TTL_MS, ACTIVE_RETENTION_MS, COMPLETED_RETENTION_MS,
  QuizSessionError, validateStartRequest, validateSubmitRequest, isPlayableQuestion,
  toSnapshot, publicQuestion, selectSnapshots, payloadHash, assertExactQuestionSet,
  scoreSubmission, computeReward, romeDayKey, isoWeekKey, completedReplay,
};
