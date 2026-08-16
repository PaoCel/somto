// quiz.api.js — Quiz data layer for the Somto PWA.
//
// Web port of `ios/TwoWatch/Data/Repositories/QuizRepository.swift` — the iOS
// app is the source of truth. Question fetching, attempts, stats aggregation,
// leaderboard, challenges, reports and the external-invite Cloud Functions are
// replicated here with IDENTICAL logic so a quiz played on web writes exactly
// the same Firestore data as one played on iOS.
//
// Backend (Firestore + Cloud Functions) is already deployed; this module only
// reads/writes against it.

import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  setDoc,
  query,
  where,
  orderBy,
  limit,
  documentId,
  increment,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";
import { t as i18nT } from "../i18n/index.js";

import { db, app } from "../firebase.js";

// Cloud Functions live in europe-west1 (see functions/modules/quizInvite.js).
const functions = getFunctions(app, "europe-west1");

// ============================================================
// QuizSession V2 — server-authoritative solo adapter
//
// Kept disabled until the backend, App Check and approved corpus gates are
// open. Callers must explicitly opt in; this adapter never falls back to the
// client-authoritative quiz path.
// ============================================================

export const QUIZ_SESSION_V2_CONTRACT_VERSION = 2;
export const QUIZ_SESSION_V2_ENABLED = false;

const QUIZ_SESSION_V2_ALLOWED_COUNTS = new Set([3, 5, 10]);
const QUIZ_SESSION_V2_RETRYABLE_CODES = new Set([
  "aborted",
  "deadline-exceeded",
  "internal",
  "resource-exhausted",
  "unavailable",
]);

function quizSessionV2Error(message, code = "invalid-response", retryable = false) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

/** True when a QuizSession V2 callable failure can safely be retried. */
export function isRetryableQuizSessionV2Error(error) {
  if (error?.retryable === true) return true;
  const code = String(error?.code || "").replace(/^functions\//, "");
  return QUIZ_SESSION_V2_RETRYABLE_CODES.has(code);
}

function normalizeQuizSessionV2CallableError(error) {
  if (error?.code === "invalid-response") return error;
  const code = String(error?.code || "internal").replace(/^functions\//, "");
  return quizSessionV2Error(
    error?.message || i18nT("Errore imprevisto."),
    code,
    QUIZ_SESSION_V2_RETRYABLE_CODES.has(code)
  );
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasValidQuizSessionV2Question(question) {
  return question
    && isNonEmptyString(question.questionId)
    && isNonEmptyString(question.titleId)
    && typeof question.title === "string"
    && isNonEmptyString(question.questionText)
    && Array.isArray(question.answers)
    && question.answers.length === 4
    && question.answers.every(isNonEmptyString)
    // Answer key and explanation must never be exposed before submit.
    && !("correctAnswerIndex" in question)
    && !("explanation" in question);
}

function validateQuizSessionV2StartResponse(data, count) {
  const questionIds = Array.isArray(data?.questions) ? data.questions.map((question) => question?.questionId) : [];
  if (
    !data
    || data.contractVersion !== QUIZ_SESSION_V2_CONTRACT_VERSION
    || !isNonEmptyString(data.sessionId)
    || data.status !== "active"
    || !isNonEmptyString(data.expiresAt)
    || Number.isNaN(Date.parse(data.expiresAt))
    || !Array.isArray(data.questions)
    || data.questions.length !== count
    || new Set(questionIds).size !== questionIds.length
    || !data.questions.every(hasValidQuizSessionV2Question)
  ) {
    throw quizSessionV2Error(i18nT("Risposta non valida dal server."));
  }
  return data;
}

function validateQuizSessionV2SubmitResponse(data, expected) {
  const counts = data?.counts;
  const validCounts = counts
    && ["correct", "wrong", "skipped"].every((key) =>
      Number.isInteger(counts[key]) && counts[key] >= 0);
  const validResults = Array.isArray(data?.results) && data.results.every((result) => (
    result
    && isNonEmptyString(result.questionId)
    && (result.selectedIndex === null || (Number.isInteger(result.selectedIndex) && result.selectedIndex >= 0 && result.selectedIndex <= 3))
    && Number.isInteger(result.correctIndex) && result.correctIndex >= 0 && result.correctIndex <= 3
    && ["correct", "wrong", "skipped"].includes(result.outcome)
    && (result.explanation === undefined || typeof result.explanation === "string")
  ));
  const resultIds = Array.isArray(data?.results) ? data.results.map((result) => result?.questionId) : [];
  const expectedById = new Map((expected?.answers || []).map((answer) => [answer.questionId, answer]));
  const matchesRequest = resultIds.length === expectedById.size
    && new Set(resultIds).size === resultIds.length
    && resultIds.every((questionId) => expectedById.has(questionId))
    && data?.results?.every((result) => expectedById.get(result.questionId)?.selectedIndex === result.selectedIndex);
  const reward = data?.reward;
  if (
    !data
    || data.contractVersion !== QUIZ_SESSION_V2_CONTRACT_VERSION
    || !isNonEmptyString(data.sessionId)
    || data.sessionId !== expected?.sessionId
    || !["completed", "already_completed"].includes(data.status)
    || typeof data.score !== "number"
    || !Number.isFinite(data.score)
    || !validCounts
    || !validResults
    || !matchesRequest
    || (counts.correct + counts.wrong + counts.skipped) !== data.results.length
    || !reward
    || !Number.isInteger(reward.xpAwarded) || reward.xpAwarded < 0
    || !Number.isInteger(reward.dailyStreak) || reward.dailyStreak < 0
    || typeof reward.dailyBonusActive !== "boolean"
  ) {
    throw quizSessionV2Error(i18nT("Risposta non valida dal server."));
  }
  return data;
}

/**
 * Starts an authenticated, server-authoritative solo quiz session.
 * This is intentionally independent from the legacy Firestore quiz methods.
 */
export async function startQuizSessionV2({ clientRequestId, titleId = null, count, language = "it" } = {}) {
  if (!isNonEmptyString(clientRequestId)) {
    throw quizSessionV2Error("Missing clientRequestId", "invalid-argument");
  }
  if (!QUIZ_SESSION_V2_ALLOWED_COUNTS.has(count)) {
    throw quizSessionV2Error("Invalid count", "invalid-argument");
  }
  if (titleId !== null && !isNonEmptyString(titleId)) {
    throw quizSessionV2Error("Invalid titleId", "invalid-argument");
  }
  if (language !== "it") {
    throw quizSessionV2Error("Invalid language", "invalid-argument");
  }

  try {
    const callable = httpsCallable(functions, "startQuizSessionV2");
    const result = await callable({
      contractVersion: QUIZ_SESSION_V2_CONTRACT_VERSION,
      clientRequestId,
      mode: "solo",
      titleId,
      count,
      language,
    });
    return validateQuizSessionV2StartResponse(result?.data, count);
  } catch (error) {
    throw normalizeQuizSessionV2CallableError(error);
  }
}

/** Submits one V2 session once; retry with the same idempotencyKey. */
export async function submitQuizSessionV2({ sessionId, idempotencyKey, answers } = {}) {
  if (!isNonEmptyString(sessionId) || !isNonEmptyString(idempotencyKey)) {
    throw quizSessionV2Error("Missing sessionId or idempotencyKey", "invalid-argument");
  }
  const answerIds = Array.isArray(answers) ? answers.map((answer) => answer?.questionId) : [];
  if (!Array.isArray(answers) || !answers.length || new Set(answerIds).size !== answerIds.length || answers.some((answer) => (
    !answer
    || !isNonEmptyString(answer.questionId)
    || (answer.selectedIndex !== null && (!Number.isInteger(answer.selectedIndex) || answer.selectedIndex < 0 || answer.selectedIndex > 3))
    || !Number.isInteger(answer.timeMs) || answer.timeMs < 0 || answer.timeMs > 20 * 60 * 1000
  ))) {
    throw quizSessionV2Error("Invalid answers", "invalid-argument");
  }

  try {
    const callable = httpsCallable(functions, "submitQuizSessionV2");
    const result = await callable({
      contractVersion: QUIZ_SESSION_V2_CONTRACT_VERSION,
      sessionId,
      idempotencyKey,
      answers: answers.map(({ questionId, selectedIndex, timeMs }) => ({ questionId, selectedIndex, timeMs })),
    });
    return validateQuizSessionV2SubmitResponse(result?.data, { sessionId, answers });
  } catch (error) {
    throw normalizeQuizSessionV2CallableError(error);
  }
}

// ============================================================
// Constants — must match QuizModels.swift EXACTLY
// ============================================================

// Question statuses readable while signed-in (rules: quizQuestions read).
// Beta builds play before the full moderation pass, so `beta_pending_review`
// is included alongside `approved`.
const PLAYABLE_STATUSES = ["approved", "beta_pending_review"];

// Scoring (QuizScoring): +1 correct, -0.2 wrong, 0 skipped.
export const QUIZ_SCORING = Object.freeze({
  correctPoints: 1.0,
  wrongPoints: -0.2,
  skipPoints: 0.0,
});

// Engagement XP (QuizXP) — deliberately separate from the leaderboard score.
// XP never goes negative; it only drives streaks and the daily bonus.
export const QUIZ_XP = Object.freeze({
  perCorrectAnswer: 2,
  quizCompletion: 10,
  challengeCompletion: 15,
  challengeWinBonus: 10,
  challengeDrawBonus: 5,
  dailyBonusGamesRequired: 3,
  dailyBonusMultiplier: 1.2,
});

// ============================================================
// Scoring helpers (QuizScoring)
// ============================================================

/** Points for a single answer outcome ("correct" | "wrong" | "skipped"). */
export function pointsForOutcome(outcome) {
  switch (outcome) {
    case "correct": return QUIZ_SCORING.correctPoints;
    case "wrong": return QUIZ_SCORING.wrongPoints;
    case "skipped": return QUIZ_SCORING.skipPoints;
    default: return 0;
  }
}

/** Total score for a list of `{ outcome }` answers. */
export function scoreForAnswers(answers = []) {
  return answers.reduce((sum, a) => sum + pointsForOutcome(a?.outcome), 0);
}

/** Tallies correct / wrong / skipped counts for a list of answers. */
export function tallyAnswers(answers = []) {
  let correctCount = 0;
  let wrongCount = 0;
  let skippedCount = 0;
  for (const a of answers) {
    if (a?.outcome === "correct") correctCount += 1;
    else if (a?.outcome === "wrong") wrongCount += 1;
    else if (a?.outcome === "skipped") skippedCount += 1;
  }
  return { correctCount, wrongCount, skippedCount };
}

// ============================================================
// XP helpers (QuizXP)
// ============================================================

/** XP for finishing a solo quiz. */
export function soloXP(correctCount) {
  return QUIZ_XP.quizCompletion + QUIZ_XP.perCorrectAnswer * Math.max(0, correctCount);
}

/** XP for finishing a challenge, including the win/draw bonus. */
export function challengeXP(correctCount, outcome) {
  let xp = QUIZ_XP.challengeCompletion + QUIZ_XP.perCorrectAnswer * Math.max(0, correctCount);
  if (outcome === "win") xp += QUIZ_XP.challengeWinBonus;
  else if (outcome === "draw") xp += QUIZ_XP.challengeDrawBonus;
  return xp;
}

/** Applies the +20% daily bonus when active (rounds half-up like Swift). */
export function applyDailyBonus(xp, active) {
  return active ? Math.round(xp * QUIZ_XP.dailyBonusMultiplier) : xp;
}

// ============================================================
// Date keys — mirror QuizRepository's Calendar helpers
// ============================================================

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Local-time day key "yyyy-MM-dd" (Calendar `.dateKey`). */
function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** Local-time day key for the day before `date` (Calendar `.yesterdayKey`). */
function yesterdayKey(date = new Date()) {
  const prior = new Date(date.getTime());
  prior.setDate(prior.getDate() - 1);
  return dayKey(prior);
}

/**
 * ISO-8601 week key "yyyy-Www" with the same rules as iOS:
 * firstWeekday = Monday, minimumDaysInFirstWeek = 4. Determines the weekly
 * leaderboard bucket — must match the Swift `isoWeekKey` exactly.
 */
function isoWeekKey(date = new Date()) {
  // Work in UTC to avoid DST drift, then apply ISO week math.
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // ISO weekday: Monday = 1 ... Sunday = 7.
  const dayNum = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  // Shift to the Thursday of this week — the week's year-defining day.
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const weekYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${String(weekYear).padStart(4, "0")}-W${pad2(week)}`;
}

/** Monday 00:00 of the given ISO week key, as a Date (or null). */
function weekStartForKey(key) {
  const parts = String(key || "").split("-W");
  if (parts.length !== 2) return null;
  const year = Number(parts[0]);
  const week = Number(parts[1]);
  if (!Number.isFinite(year) || !Number.isFinite(week)) return null;
  // Jan 4th is always in ISO week 1; walk to its Monday, then add weeks.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  const week1Monday = new Date(jan4.getTime());
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  week1Monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return week1Monday;
}

// ============================================================
// Misc helpers
// ============================================================

function chunked(array, size) {
  if (size <= 0) return [array];
  const out = [];
  for (let i = 0; i < array.length; i += size) {
    out.push(array.slice(i, i + size));
  }
  return out;
}

function shuffled(array) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ============================================================
// Decoders — mirror QuizRepository.decodeQuestion / decodeChallenge
// ============================================================

// Lingua del pool di domande. Ogni doc `quizQuestions` ha da sempre un campo
// `language` (verificato su prod il 2026-07-29: 10.525 domande, tutte "it",
// nessuna senza campo) ma NESSUNA query lo usava: importare una sola domanda
// in inglese avrebbe mescolato le lingue dentro la stessa partita, per ogni
// utente. Il filtro sta qui nel decode e non nella query perche' a livello di
// query servirebbero nuovi indici compositi, che vanno deployati PRIMA del
// codice che li usa (vedi docs/DECISIONS.md, 2026-07-28): finche' il corpus e'
// monolingua questo e' un no-op a costo zero. Quando esistera' un volume reale
// di domande EN, spostare il filtro nelle query e aggiungere gli indici.
const QUIZ_LANGUAGE = "it";

/** Decodes a quizQuestions doc; returns null when the shape is invalid. */
function decodeQuestion(snap) {
  const data = snap.data();
  if (!data) return null;
  const answers = data.answers;
  const correctIdx = data.correctAnswerIndex;
  if (
    typeof data.questionText !== "string" ||
    typeof data.titleId !== "string" ||
    typeof data.title !== "string" ||
    !Array.isArray(answers) || answers.length !== 4 ||
    typeof correctIdx !== "number" || correctIdx < 0 || correctIdx > 3
  ) {
    return null;
  }
  if ((data.language || "it") !== QUIZ_LANGUAGE) return null;
  return {
    questionId: typeof data.questionId === "string" ? data.questionId : snap.id,
    titleId: data.titleId,
    tmdbId: data.tmdbId ?? null,
    mediaType: data.mediaType || "unknown",
    title: data.title,
    questionText: data.questionText,
    answers,
    correctAnswerIndex: correctIdx,
    explanation: data.explanation ?? null,
    difficulty: data.difficulty || "medium",
    category: data.category ?? null,
    spoilerLevel: data.spoilerLevel || "none",
    confidence: data.confidence || "high",
    sourceLevel: data.sourceLevel ?? null,
    sourceBasis: data.sourceBasis ?? null,
    riskNotes: data.riskNotes ?? null,
    status: data.status || "beta_pending_review",
    createdBy: data.createdBy ?? null,
    language: data.language || "it",
    answerOrderShuffled: data.answerOrderShuffled ?? null,
  };
}

/** Decodes the per-side challenge answers array. */
function decodeChallengeAnswers(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((dict) => {
      if (
        typeof dict?.questionId !== "string" ||
        typeof dict?.outcome !== "string"
      ) {
        return null;
      }
      return {
        questionId: dict.questionId,
        selectedIndex: typeof dict.selectedIndex === "number" ? dict.selectedIndex : null,
        outcome: dict.outcome,
        timeMs: typeof dict.timeMs === "number" ? dict.timeMs : null,
      };
    })
    .filter(Boolean);
}

/** Converts a Firestore Timestamp to a JS Date (passthrough for Date/null). */
function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === "function") return value.toDate();
  return null;
}

/** Decodes a quizChallenges doc; returns null when the shape is invalid. */
function decodeChallenge(snap) {
  const data = snap.data();
  if (!data) return null;
  if (typeof data.fromUid !== "string" || !Array.isArray(data.questionIds)) {
    return null;
  }
  // `toUid` is absent / null on external invites until they are claimed.
  const toUid = typeof data.toUid === "string" ? data.toUid : null;
  return {
    challengeId: snap.id,
    fromUid: data.fromUid,
    toUid,
    questionIds: data.questionIds,
    numQuestions: typeof data.numQuestions === "number" ? data.numQuestions : data.questionIds.length,
    status: data.status || "pending",
    fromScore: typeof data.fromScore === "number" ? data.fromScore : null,
    toScore: typeof data.toScore === "number" ? data.toScore : null,
    createdAt: toDate(data.createdAt) || new Date(),
    completedAt: toDate(data.completedAt),
    sharedTitleIds: Array.isArray(data.sharedTitleIds) ? data.sharedTitleIds : [],
    fromAnswers: decodeChallengeAnswers(data.fromAnswers),
    toAnswers: decodeChallengeAnswers(data.toAnswers),
    inviteType: data.inviteType || "internal",
    opponentDisplayName: data.opponentDisplayName ?? null,
    opponentPlaceholderName: data.opponentPlaceholderName ?? null,
    inviterSeenTitleIds: Array.isArray(data.inviterSeenTitleIds) ? data.inviterSeenTitleIds : [],
    opponentConfirmedSeenTitleIds: Array.isArray(data.opponentConfirmedSeenTitleIds)
      ? data.opponentConfirmedSeenTitleIds : [],
    expiresAt: toDate(data.expiresAt),
  };
}

// ============================================================
// Question fetching
// ============================================================

/**
 * Fetches up to `count` questions sampled from across the whole catalogue
 * ("Casuale" mode) — mirrors `QuizRepository.fetchPlayableQuestions(count:)`.
 *
 * A plain `quizQuestions` query with `limit` and no `orderBy` is NOT random:
 * Firestore returns documents in ascending document-ID order, so the query
 * always read the same fixed slice — in practice `disney_aladdin_*` + the
 * first few `disney_cars_*` docs, since `"disney_"` sorts before every
 * `"q_..."` id in the rest of the catalogue. Every "random" quiz was
 * actually only ever Aladdin and Cars. Fix: pick a random subset of
 * titleIds from the (already catalogue-complete) themes aggregate first,
 * then reuse the per-title fetch, which has no such bias since it never
 * truncates a same-order slice of a huge collection.
 */
export async function fetchPlayableQuestions(count = 10) {
  const themes = await fetchPlayableThemes();
  if (!themes.length) return [];

  const shuffledThemes = shuffled(themes);
  const titleIds = [];
  let running = 0;
  for (const theme of shuffledThemes) {
    titleIds.push(theme.titleId);
    running += theme.questionCount;
    // Cap at 15 so the downstream chunked-by-15 query stays a single
    // Firestore round trip (see fetchPlayableQuestionsForTitles).
    if (titleIds.length >= 15 || running >= count * 4) break;
  }

  return fetchPlayableQuestionsForTitles(titleIds, count);
}

/**
 * Resolves a specific set of questions by id, preserving input order — mirrors
 * `fetchQuestions(byIds:)`. Reads are batched 15-at-a-time perché ora la query
 * combina `documentId IN (15)` con `status IN (2)`, totale 30 disgiunzioni (cap
 * Firestore). Senza il filtro `status` la rule rifiuta i batch che includono
 * domande pending/flagged.
 */
export async function fetchQuestionsByIds(ids = []) {
  if (!ids.length) return [];
  const map = new Map();
  for (const chunk of chunked(ids, 15)) {
    const q = query(
      collection(db, "quizQuestions"),
      where(documentId(), "in", chunk),
      where("status", "in", PLAYABLE_STATUSES)
    );
    const snap = await getDocs(q);
    for (const docSnap of snap.docs) {
      const decoded = decodeQuestion(docSnap);
      if (decoded) map.set(decoded.questionId, decoded);
    }
  }
  return ids.map((id) => map.get(id)).filter(Boolean);
}

/**
 * Returns up to `count` playable questions restricted to the given title pool
 * — mirrors `fetchPlayableQuestions(titleIds:count:)`. Chunk a 15 perché
 * `titleId IN (15)` × `status IN (2)` = 30 disgiunzioni (cap Firestore). Senza
 * `status` filtrato a query-time le rules rigetterebbero il batch.
 */
export async function fetchPlayableQuestionsForTitles(titleIds = [], count = 10) {
  if (!titleIds.length) return fetchPlayableQuestions(count);
  let pool = [];
  for (const chunk of chunked(titleIds, 15)) {
    const q = query(
      collection(db, "quizQuestions"),
      where("titleId", "in", chunk),
      where("status", "in", PLAYABLE_STATUSES)
    );
    const snap = await getDocs(q);
    const filtered = snap.docs.map(decodeQuestion).filter(Boolean);
    pool = pool.concat(filtered);
  }
  return shuffled(pool).slice(0, count);
}

/**
 * Returns the COMPLETE list of playable themes (titoli con domande) from the
 * server-maintained aggregate `quizMeta/themes` — UNA sola read, listing
 * completo e ricercabile. Ogni voce: { titleId, title, mediaType, count }.
 * Fallback al campionamento (groupBy su un pool parziale) se l'aggregato non
 * esiste ancora. Mirror del bisogno di QuizRepository.fetchPlayableThemes.
 */
export async function fetchPlayableThemes() {
  try {
    const snap = await getDoc(doc(db, "quizMeta", "themes"));
    if (snap.exists()) {
      const data = snap.data() || {};
      const list = Array.isArray(data.themes) ? data.themes : [];
      if (list.length) {
        return list
          .filter((t) => t && t.titleId)
          .map((t) => ({
            titleId: t.titleId,
            title: t.title || i18nT("Senza titolo"),
            mediaType: t.mediaType || "unknown",
            questionCount: Number(t.count) || 0,
          }));
      }
    }
  } catch (err) {
    console.warn("[quiz] fetchPlayableThemes aggregate read failed, fallback to sampling", err);
  }
  // Fallback: campiona il pool e raggruppa (parziale, ma meglio di niente).
  // Query diretta (non fetchPlayableQuestions): quella ora dipende da questa
  // stessa funzione per la selezione random dei titoli, farebbe ricorsione.
  const sampleQ = query(
    collection(db, "quizQuestions"),
    where("status", "in", PLAYABLE_STATUSES),
    limit(300)
  );
  const sampleSnap = await getDocs(sampleQ);
  const pool = sampleSnap.docs.map(decodeQuestion).filter(Boolean);
  const map = new Map();
  for (const q of pool) {
    if (!q?.titleId) continue;
    const e = map.get(q.titleId);
    if (e) e.questionCount += 1;
    else map.set(q.titleId, { titleId: q.titleId, title: q.title || i18nT("Senza titolo"), mediaType: q.mediaType || "unknown", questionCount: 1 });
  }
  return [...map.values()].sort((a, b) =>
    b.questionCount !== a.questionCount ? b.questionCount - a.questionCount : a.title.localeCompare(b.title, "it"));
}

// ============================================================
// Guest quiz (teaser pubblico, niente login) — funnel acquisizione.
// Server-authoritative: le domande arrivano SENZA risposta corretta; il punteggio
// è validato da submitGuestQuiz lato server. Nessuna scrittura, nessun XP.
// ============================================================

/** Domande per il guest (no answer-key). `{titleId?, count}` → { titleId, title, questions[] }. */
export async function getGuestQuiz({ titleId = null, count = 5 } = {}) {
  const fn = httpsCallable(functions, "getGuestQuiz");
  const res = await fn({ titleId: titleId || null, count });
  return res.data;
}

/** Invia le risposte del guest e ottiene correttezza + spiegazioni + punteggio. */
export async function submitGuestQuiz(answers = []) {
  const fn = httpsCallable(functions, "submitGuestQuiz");
  const res = await fn({ answers });
  return res.data;
}

// ============================================================
// Attempts / Scoring
// ============================================================

function attemptStatsRef(uid) {
  return doc(db, "users", uid, "quizStats", "agg");
}

/**
 * Persists an attempt and updates the cached stats doc — mirrors
 * `submitAttempt(_:)`. Uses incremental field updates instead of a
 * transaction, exactly like iOS. The weekly bucket is reset when the cached
 * `weekKey` drifted. Solo attempts also apply gamification (XP/streak/bonus);
 * challenge attempts do NOT — they are rewarded via `recordChallengePlay`.
 *
 * @param {object} attempt - { attemptId, uid, mode, challengeId, questionIds,
 *   answers, score, correctCount, wrongCount, skippedCount, createdAt }
 * @param {object} [user] - optional { displayName, photoURL } denormalized
 *   into the stats doc for the leaderboard.
 * @returns {Promise<{xpAwarded:number,dailyStreak:number,dailyBonusActive:boolean}>}
 */
export async function submitAttempt(attempt, user = null) {
  if (!attempt?.uid) throw new Error("uid mancante");
  if (!attempt?.attemptId) throw new Error("attemptId mancante");

  const createdAt = attempt.createdAt instanceof Date ? attempt.createdAt : new Date();
  const attemptRef = doc(db, "users", attempt.uid, "quizAttempts", attempt.attemptId);
  const statsRef = attemptStatsRef(attempt.uid);
  const weekKey = isoWeekKey(createdAt);

  const answers = Array.isArray(attempt.answers) ? attempt.answers : [];
  const score = typeof attempt.score === "number" ? attempt.score : scoreForAnswers(answers);
  const tally = tallyAnswers(answers);
  const correctCount = typeof attempt.correctCount === "number" ? attempt.correctCount : tally.correctCount;
  const wrongCount = typeof attempt.wrongCount === "number" ? attempt.wrongCount : tally.wrongCount;
  const skippedCount = typeof attempt.skippedCount === "number" ? attempt.skippedCount : tally.skippedCount;

  // Write the attempt document (owner-only collection).
  await setDoc(attemptRef, {
    attemptId: attempt.attemptId,
    uid: attempt.uid,
    mode: attempt.mode || "solo",
    challengeId: attempt.challengeId ?? null,
    questionIds: Array.isArray(attempt.questionIds) ? attempt.questionIds : [],
    answers: answers.map((a) => {
      const out = { questionId: a.questionId, outcome: a.outcome };
      if (typeof a.selectedIndex === "number") out.selectedIndex = a.selectedIndex;
      if (typeof a.timeMs === "number") out.timeMs = a.timeMs;
      return out;
    }),
    score,
    correctCount,
    wrongCount,
    skippedCount,
    createdAt,
  });

  // Reset the weekly bucket if the cached week key drifted.
  const existing = await getDoc(statsRef);
  const storedWeekKey = existing.exists() ? (existing.data()?.weekKey || "") : "";
  if (existing.exists() && storedWeekKey !== weekKey) {
    await setDoc(statsRef, { weeklyScore: 0, weekKey }, { merge: true });
  }

  await setDoc(statsRef, {
    totalScore: increment(score),
    weeklyScore: increment(score),
    weekKey,
    attemptsCount: increment(1),
    correctCount: increment(correctCount),
    wrongCount: increment(wrongCount),
    skippedCount: increment(skippedCount),
    updatedAt: serverTimestamp(),
    displayName: user?.displayName ?? null,
    photoURL: user?.photoURL ?? null,
  }, { merge: true });

  // Gamification only applies to solo attempts (challenges go via
  // recordChallengePlay so the same game is never counted twice).
  if ((attempt.mode || "solo") !== "solo") {
    return { xpAwarded: 0, dailyStreak: 0, dailyBonusActive: false };
  }
  return applyGamification(attempt.uid, correctCount, "solo", null);
}

/**
 * Reads the cached stats doc — mirrors `fetchUserStats(uid:)`. The weekly
 * score and daily-bonus progress are zeroed when their key is stale, and the
 * streak is reported as "live" only if the last game was today or yesterday.
 */
export async function fetchUserStats(uid) {
  const emptyStats = {
    totalScore: 0,
    weeklyScore: 0,
    weekStartAt: null,
    attemptsCount: 0,
    correctCount: 0,
    wrongCount: 0,
    skippedCount: 0,
    xp: 0,
    dailyStreak: 0,
    bestDailyStreak: 0,
    lastPlayDayKey: null,
    dailyBonusDayKey: null,
    dailyBonusGames: 0,
  };
  if (!uid) return emptyStats;

  const snap = await getDoc(attemptStatsRef(uid));
  if (!snap.exists()) return emptyStats;
  const data = snap.data() || {};

  const weekKey = data.weekKey || "";
  const currentWeekKey = isoWeekKey(new Date());
  const weeklyScore = weekKey === currentWeekKey ? (Number(data.weeklyScore) || 0) : 0;

  const todayKey = dayKey(new Date());
  const ydayKey = yesterdayKey(new Date());
  const lastPlayDayKey = data.lastPlayDayKey || null;
  const storedStreak = Number(data.dailyStreak) || 0;
  // The streak is "alive" only if the last game was today or yesterday.
  const liveStreak = (lastPlayDayKey === todayKey || lastPlayDayKey === ydayKey)
    ? storedStreak
    : 0;
  const bonusDayKey = data.dailyBonusDayKey || null;
  const bonusGames = bonusDayKey === todayKey ? (Number(data.dailyBonusGames) || 0) : 0;

  return {
    totalScore: Number(data.totalScore) || 0,
    weeklyScore,
    weekStartAt: weekStartForKey(currentWeekKey),
    attemptsCount: Number(data.attemptsCount) || 0,
    correctCount: Number(data.correctCount) || 0,
    wrongCount: Number(data.wrongCount) || 0,
    skippedCount: Number(data.skippedCount) || 0,
    xp: Number(data.xp) || 0,
    dailyStreak: liveStreak,
    bestDailyStreak: Number(data.bestDailyStreak) || 0,
    lastPlayDayKey,
    dailyBonusDayKey: bonusDayKey,
    dailyBonusGames: bonusGames,
  };
}

// ============================================================
// Gamification — mirrors QuizRepository.applyGamification
// ============================================================

/**
 * Read-modify-write of the streak / daily-bonus / XP fields on the cached
 * stats doc. Applied exactly once per finished game. Not exported: callers
 * trigger it through submitAttempt / recordChallengePlay.
 *
 * @param {string} uid
 * @param {number} correctCount
 * @param {"solo"|"challenge"} mode
 * @param {"win"|"loss"|"draw"|null} challengeOutcome
 */
async function applyGamification(uid, correctCount, mode, challengeOutcome) {
  const statsRef = attemptStatsRef(uid);
  const snap = await getDoc(statsRef);
  const data = snap.exists() ? (snap.data() || {}) : {};

  const today = dayKey(new Date());
  const yesterday = yesterdayKey(new Date());

  // Daily streak: +1 if the last game was yesterday, reset to 1 if the chain
  // is broken, unchanged if a game was already played today.
  const lastDay = data.lastPlayDayKey || null;
  const storedStreak = Number(data.dailyStreak) || 0;
  let newStreak;
  if (lastDay === today) {
    newStreak = Math.max(storedStreak, 1);
  } else if (lastDay === yesterday) {
    newStreak = storedStreak + 1;
  } else {
    newStreak = 1;
  }
  const bestStreak = Math.max(Number(data.bestDailyStreak) || 0, newStreak);

  // Daily bonus progress (resets when the day rolls over).
  const bonusDay = data.dailyBonusDayKey || null;
  const priorGames = bonusDay === today ? (Number(data.dailyBonusGames) || 0) : 0;
  const newGames = priorGames + 1;
  const bonusActive = newGames >= QUIZ_XP.dailyBonusGamesRequired;

  const baseXP = mode === "challenge"
    ? challengeXP(correctCount, challengeOutcome)
    : soloXP(correctCount);
  const awardedXP = applyDailyBonus(baseXP, bonusActive);

  await setDoc(statsRef, {
    xp: increment(awardedXP),
    dailyStreak: newStreak,
    bestDailyStreak: bestStreak,
    lastPlayDayKey: today,
    dailyBonusDayKey: today,
    dailyBonusGames: newGames,
    updatedAt: serverTimestamp(),
  }, { merge: true });

  return { xpAwarded: awardedXP, dailyStreak: newStreak, dailyBonusActive: bonusActive };
}

// ============================================================
// Leaderboard
// ============================================================

/**
 * Reads the leaderboard via a collection-group query over every user's cached
 * quizStats agg doc — mirrors `fetchLeaderboard(scope:limit:)`. No backend
 * fan-out required.
 *
 * @param {"weekly"|"allTime"} scope
 * @param {number} [max]
 */
export async function fetchLeaderboard(scope = "weekly", max = 50) {
  const scoreField = scope === "weekly" ? "weeklyScore" : "totalScore";
  const constraints = [];
  if (scope === "weekly") {
    constraints.push(where("weekKey", "==", isoWeekKey(new Date())));
  }
  constraints.push(orderBy(scoreField, "desc"));
  constraints.push(limit(max));

  const q = query(collectionGroup(db, "quizStats"), ...constraints);
  const snap = await getDocs(q);
  return snap.docs
    .map((docSnap) => {
      const data = docSnap.data() || {};
      // Doc path: users/{uid}/quizStats/{docId} — recover uid from the parent.
      const uid = docSnap.ref.parent?.parent?.id;
      if (!uid) return null;
      const rawScore = Number(data[scoreField]) || 0;
      if (rawScore <= 0) return null;
      return {
        uid,
        displayName: data.displayName || i18nT("Utente"),
        photoURL: data.photoURL || null,
        score: rawScore,
        attemptsCount: Number(data.attemptsCount) || 0,
      };
    })
    .filter(Boolean);
}

// ============================================================
// Challenges
// ============================================================

/**
 * Creates an internal (friend) challenge — mirrors `sendChallenge(_:)`.
 * External challenges are created server-side via `createExternalInvite`;
 * the security rules only admit internal ones from clients.
 *
 * @param {object} challenge - { challengeId, fromUid, toUid, questionIds,
 *   numQuestions?, sharedTitleIds? }
 */
export async function sendChallenge(challenge) {
  if (!challenge?.challengeId) throw new Error("challengeId mancante");
  if (!challenge?.fromUid) throw new Error("fromUid mancante");
  if (!challenge?.toUid) throw new Error("toUid mancante");
  const questionIds = Array.isArray(challenge.questionIds) ? challenge.questionIds : [];
  if (!questionIds.length) throw new Error("questionIds mancanti");

  const ref = doc(db, "quizChallenges", challenge.challengeId);
  await setDoc(ref, {
    challengeId: challenge.challengeId,
    fromUid: challenge.fromUid,
    toUid: challenge.toUid,
    questionIds,
    numQuestions: typeof challenge.numQuestions === "number" ? challenge.numQuestions : questionIds.length,
    status: "pending",
    fromScore: null,
    toScore: null,
    fromAnswers: [],
    toAnswers: [],
    sharedTitleIds: Array.isArray(challenge.sharedTitleIds) ? challenge.sharedTitleIds : [],
    inviteType: "internal",
    createdAt: serverTimestamp(),
    completedAt: null,
  });
  return { challengeId: challenge.challengeId };
}

/** Challenges received by `uid` — mirrors `fetchReceivedChallenges`. */
export async function fetchReceivedChallenges(uid, max = 30) {
  if (!uid) throw new Error("uid mancante");
  const q = query(
    collection(db, "quizChallenges"),
    where("toUid", "==", uid),
    orderBy("createdAt", "desc"),
    limit(max)
  );
  const snap = await getDocs(q);
  return snap.docs.map(decodeChallenge).filter(Boolean);
}

/** Challenges sent by `uid` — mirrors `fetchSentChallenges`. */
export async function fetchSentChallenges(uid, max = 30) {
  if (!uid) throw new Error("uid mancante");
  const q = query(
    collection(db, "quizChallenges"),
    where("fromUid", "==", uid),
    orderBy("createdAt", "desc"),
    limit(max)
  );
  const snap = await getDocs(q);
  return snap.docs.map(decodeChallenge).filter(Boolean);
}

/** Single challenge by id — mirrors `fetchChallenge(id:)`. */
export async function fetchChallenge(id) {
  if (!id) return null;
  const snap = await getDoc(doc(db, "quizChallenges", id));
  if (!snap.exists()) return null;
  return decodeChallenge(snap);
}

/**
 * Records one side's outcome on the challenge doc — mirrors
 * `recordChallengePlay(...)`. The per-question answers are denormalized onto
 * the challenge doc (not just `quizAttempts`) so the opponent — who can read
 * the challenge but not the other user's attempts — can review them. Resolves
 * the challenge to `completed` once both sides have a score, then applies the
 * challenge gamification reward.
 *
 * @param {object} params
 * @param {string} params.challengeId
 * @param {"from"|"to"} params.side - which side the playing user is on
 * @param {string} params.playerUid
 * @param {number} params.score
 * @param {number} params.correctCount
 * @param {Array} params.answers - [{ questionId, selectedIndex?, outcome, timeMs? }]
 * @returns {Promise<{xpAwarded:number,dailyStreak:number,dailyBonusActive:boolean}>}
 */
export async function recordChallengePlay({
  challengeId,
  side,
  playerUid,
  score,
  correctCount,
  answers = [],
}) {
  if (!challengeId) throw new Error("challengeId mancante");
  if (side !== "from" && side !== "to") throw new Error(i18nT("side non valido"));
  if (!playerUid) throw new Error("playerUid mancante");

  const ref = doc(db, "quizChallenges", challengeId);

  // Read the opponent's current score (if any) before writing ours, so the
  // outcome can be resolved for the XP award.
  let opponentScore = null;
  try {
    const beforeSnap = await getDoc(ref);
    if (beforeSnap.exists()) {
      const data = beforeSnap.data() || {};
      const raw = side === "from" ? data.toScore : data.fromScore;
      opponentScore = typeof raw === "number" ? raw : null;
    }
  } catch (_) {
    opponentScore = null;
  }

  const answersData = answers.map((answer) => {
    const dict = { questionId: answer.questionId, outcome: answer.outcome };
    if (typeof answer.selectedIndex === "number") dict.selectedIndex = answer.selectedIndex;
    if (typeof answer.timeMs === "number") dict.timeMs = answer.timeMs;
    return dict;
  });

  const updates = { completedAt: serverTimestamp() };
  if (side === "from") {
    updates.fromScore = score;
    updates.fromAnswers = answersData;
  } else {
    updates.toScore = score;
    updates.toAnswers = answersData;
  }
  // Once both sides have a score the challenge is fully resolved.
  if (opponentScore !== null) {
    updates.status = "completed";
  }
  await setDoc(ref, updates, { merge: true });

  let outcome = null;
  if (opponentScore !== null) {
    if (score > opponentScore) outcome = "win";
    else if (score < opponentScore) outcome = "loss";
    else outcome = "draw";
  }
  return applyGamification(playerUid, correctCount, "challenge", outcome);
}

// ============================================================
// Question reports (user-submitted)
// ============================================================

/**
 * Persists a user-submitted report against a question — mirrors
 * `reportQuestionProblem(...)`. Also bumps a counter on the question so
 * heavily-flagged ones surface first in the admin list.
 *
 * @param {object} params
 * @param {string} params.questionId
 * @param {string} params.reportedBy - reporting user's uid
 * @param {string} params.reason
 * @param {"correct"|"wrong"|"skipped"|null} [params.attemptOutcome]
 */
export async function reportQuestionProblem({
  questionId,
  reportedBy,
  reason,
  attemptOutcome = null,
}) {
  if (!questionId) throw new Error("questionId mancante");
  if (!reportedBy) throw new Error("reportedBy mancante");
  if (!reason) throw new Error("reason mancante");

  // quizQuestionReports docs have auto ids.
  const reportRef = doc(collection(db, "quizQuestionReports"));
  await setDoc(reportRef, {
    questionId,
    reportedBy,
    reason,
    outcome: attemptOutcome || "unknown",
    createdAt: serverTimestamp(),
  });

  await setDoc(doc(db, "quizQuestions", questionId), {
    reportsCount: increment(1),
    lastReportAt: serverTimestamp(),
  }, { merge: true });

  return { reportId: reportRef.id };
}

// ============================================================
// External invites — Cloud Functions wrappers (europe-west1)
// ============================================================

/**
 * Creates an external (share-link) challenge via the `createQuizExternalInvite`
 * callable — mirrors `createExternalInvite(...)`. The challenge doc and the
 * invite token hash are written server-side with the admin SDK; the raw token
 * is returned only to the inviter.
 *
 * @param {object} params
 * @param {string} [params.placeholderName] - optional label for the opponent
 * @param {number} params.numQuestions - 5 or 10 (backend clamps to one of those)
 * @param {string[]} params.inviterSeenTitleIds
 * @returns {Promise<{challengeId:string,inviteToken:string,inviteUrl:string}>}
 */
export async function createExternalInvite({
  placeholderName,
  numQuestions = 10,
  inviterSeenTitleIds = [],
}) {
  const payload = {
    numQuestions,
    inviterSeenTitleIds: Array.isArray(inviterSeenTitleIds) ? inviterSeenTitleIds : [],
  };
  const trimmedName = String(placeholderName || "").trim();
  if (trimmedName) payload.placeholderName = trimmedName;

  const callable = httpsCallable(functions, "createQuizExternalInvite");
  const result = await callable(payload);
  const dict = result?.data;
  if (
    !dict ||
    typeof dict.challengeId !== "string" ||
    typeof dict.inviteToken !== "string" ||
    typeof dict.inviteUrl !== "string"
  ) {
    throw new Error(i18nT("Risposta non valida dal server."));
  }
  return {
    challengeId: dict.challengeId,
    inviteToken: dict.inviteToken,
    inviteUrl: dict.inviteUrl,
  };
}

/**
 * Binds the signed-in user to an external invite via the
 * `claimQuizExternalInvite` callable — mirrors `claimExternalInvite(token:)`.
 * Must be called after authentication. Returns the data needed for the titles
 * onboarding step.
 *
 * @param {string} token - raw invite token from the share link
 * @returns {Promise<{challengeId:string,inviterUid:string,
 *   inviterDisplayName:string,inviterSeenTitleIds:string[],numQuestions:number}>}
 */
export async function claimExternalInvite(token) {
  if (!token) throw new Error(i18nT("Token non valido."));
  const callable = httpsCallable(functions, "claimQuizExternalInvite");
  const result = await callable({ token });
  const dict = result?.data;
  if (!dict || typeof dict.challengeId !== "string") {
    throw new Error(i18nT("Risposta non valida dal server."));
  }
  return {
    challengeId: dict.challengeId,
    inviterUid: typeof dict.inviterUid === "string" ? dict.inviterUid : "",
    inviterDisplayName: typeof dict.inviterDisplayName === "string"
      ? dict.inviterDisplayName : i18nT("Un amico"),
    inviterSeenTitleIds: Array.isArray(dict.inviterSeenTitleIds) ? dict.inviterSeenTitleIds : [],
    numQuestions: typeof dict.numQuestions === "number" ? dict.numQuestions : 10,
  };
}

/**
 * Locks in the invitee's confirmed titles and asks the backend to build the
 * question pool via the `finalizeQuizExternalChallenge` callable — mirrors
 * `finalizeExternalChallenge(...)`.
 *
 * @param {object} params
 * @param {string} params.challengeId
 * @param {string[]} params.confirmedTitleIds - titles the invitee confirmed
 * @returns {Promise<{ready:boolean,questionCount:number,availableQuestions:number}>}
 *   `ready:true` with `questionCount` when the pool is built; `ready:false`
 *   with `availableQuestions` when the pool is too thin (pick more titles).
 */
export async function finalizeExternalChallenge({ challengeId, confirmedTitleIds = [] }) {
  if (!challengeId) throw new Error("challengeId mancante");
  const callable = httpsCallable(functions, "finalizeQuizExternalChallenge");
  const result = await callable({
    challengeId,
    opponentConfirmedSeenTitleIds: Array.isArray(confirmedTitleIds) ? confirmedTitleIds : [],
  });
  const dict = result?.data;
  if (!dict || typeof dict !== "object") {
    throw new Error(i18nT("Risposta non valida dal server."));
  }
  if (dict.ok === false) {
    return {
      ready: false,
      questionCount: 0,
      availableQuestions: typeof dict.available === "number" ? dict.available : 0,
    };
  }
  if (typeof dict.questionCount !== "number") {
    throw new Error(i18nT("Risposta non valida dal server."));
  }
  return { ready: true, questionCount: dict.questionCount, availableQuestions: dict.questionCount };
}
