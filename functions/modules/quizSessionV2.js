const quiz = require("../lib/quizSessionV2");

function asHttpsError(functions, error) {
  if (error instanceof quiz.QuizSessionError) return new functions.https.HttpsError(error.code, error.message);
  return error;
}

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return 0;
}

function toIso(timestamp) {
  return new Date(timestampMillis(timestamp)).toISOString();
}

function requireAuthAndAppCheck(functions, context) {
  if (!context.auth?.uid) throw new functions.https.HttpsError("unauthenticated", "Devi accedere per giocare.");
  // enforceAppCheck is the primary enforcement. The explicit check preserves
  // fail-closed behaviour if callable configuration is ever changed.
  if (!context.app) throw new functions.https.HttpsError("failed-precondition", "Verifica app richiesta.");
  return context.auth.uid;
}

async function fetchPool(db, request) {
  let query = db.collection("quizQuestions").where("status", "==", "approved");
  if (request.titleId) query = query.where("titleId", "==", request.titleId);
  const snap = await query.limit(500).get();
  return snap.docs.map((doc) => ({ id: doc.id, data: doc.data() || {} }));
}

function sessionData({ uid, request, questions, now, Timestamp }) {
  const expiresAt = Timestamp.fromMillis(now.getTime() + quiz.SESSION_TTL_MS);
  return {
    schemaVersion: quiz.CONTRACT_VERSION,
    ownerUid: uid,
    status: "active",
    mode: "solo",
    titleId: request.titleId,
    language: "it",
    questionCount: request.count,
    questions,
    clientRequestId: request.clientRequestId,
    createdAt: Timestamp.fromDate(now),
    expiresAt,
    ttlAt: Timestamp.fromMillis(expiresAt.toMillis() + quiz.ACTIVE_RETENTION_MS),
    submittedAt: null,
    submitIdempotencyKey: null,
    submitPayloadHash: null,
    result: null,
    attemptPath: null,
  };
}

function registerQuizSessionV2(exports, deps) {
  const { functions, admin, enforceCallableRateLimit, now = () => new Date(), random = Math.random } = deps;
  const Timestamp = admin.firestore.Timestamp;
  const FieldValue = admin.firestore.FieldValue;
  const callable = functions.region("europe-west1").runWith({ enforceAppCheck: true }).https;

  exports.startQuizSessionV2 = callable.onCall(async (data, context) => {
    try {
      const uid = requireAuthAndAppCheck(functions, context);
      const request = quiz.validateStartRequest(data);
      const db = admin.firestore();
      await enforceCallableRateLimit(db, uid, "startQuizSessionV2", { windowSeconds: 60, maxInWindow: 5, dailyMax: 80 });
      const questions = quiz.selectSnapshots(await fetchPool(db, request), request.count, random);
      const sessionRef = db.collection("quizSessions").doc();
      const questionRefs = questions.map((question) => db.collection("quizQuestions").doc(question.questionId));
      const createdAt = now();
      let created;
      await db.runTransaction(async (tx) => {
        const liveSnaps = await tx.getAll(...questionRefs);
        const liveById = new Map(liveSnaps.filter((snap) => snap.exists).map((snap) => [snap.id, snap.data() || {}]));
        const liveQuestions = questions.map((question) => quiz.toSnapshot(liveById.get(question.questionId), question.questionId));
        if (liveQuestions.some((question) => !question)) {
          throw new quiz.QuizSessionError("failed-precondition", "Il pool quiz è cambiato. Riprova.");
        }
        created = sessionData({ uid, request, questions: liveQuestions, now: createdAt, Timestamp });
        tx.create(sessionRef, created);
      });
      return {
        contractVersion: quiz.CONTRACT_VERSION, sessionId: sessionRef.id, status: "active",
        expiresAt: toIso(created.expiresAt), questions: created.questions.map(quiz.publicQuestion),
      };
    } catch (error) { throw asHttpsError(functions, error); }
  });

  exports.submitQuizSessionV2 = callable.onCall(async (data, context) => {
    try {
      const uid = requireAuthAndAppCheck(functions, context);
      const request = quiz.validateSubmitRequest(data);
      const db = admin.firestore();
      await enforceCallableRateLimit(db, uid, "submitQuizSessionV2", { windowSeconds: 60, maxInWindow: 10, dailyMax: 120 });
      const sessionRef = db.collection("quizSessions").doc(request.sessionId);
      const statsRef = db.collection("users").doc(uid).collection("quizStats").doc("agg");
      const attemptRef = db.collection("users").doc(uid).collection("quizAttempts").doc(request.sessionId);
      const hash = quiz.payloadHash(request.answers);
      const response = await db.runTransaction(async (tx) => {
        const [sessionSnap, statsSnap] = await Promise.all([tx.get(sessionRef), tx.get(statsRef)]);
        if (!sessionSnap.exists) throw new quiz.QuizSessionError("not-found", "Sessione non trovata.");
        const session = sessionSnap.data() || {};
        if (session.ownerUid !== uid) {
          throw new quiz.QuizSessionError("not-found", "Sessione non trovata.");
        }
        if (session.mode !== "solo" || session.schemaVersion !== quiz.CONTRACT_VERSION) {
          throw new quiz.QuizSessionError("failed-precondition", "Sessione non valida.");
        }
        const replay = quiz.completedReplay(session, request.idempotencyKey, hash);
        if (replay) return replay;
        if (session.status !== "active") throw new quiz.QuizSessionError("failed-precondition", "Sessione non attiva.");
        const completedAt = now();
        if (timestampMillis(session.expiresAt) <= completedAt.getTime()) {
          tx.update(sessionRef, { status: "expired" });
          return { expired: true };
        }
        const scored = quiz.scoreSubmission(session.questions, request.answers);
        const reward = quiz.computeReward(statsSnap.exists ? (statsSnap.data() || {}) : {}, scored.counts.correct, completedAt);
        const weekKey = quiz.isoWeekKey(completedAt);
        const prior = reward.statsPatch;
        const priorWeekScore = (statsSnap.exists && statsSnap.data()?.weekKey === weekKey)
          ? (Number(statsSnap.data()?.weeklyScore) || 0) : 0;
        const canonicalResult = {
          contractVersion: quiz.CONTRACT_VERSION, sessionId: request.sessionId, status: "completed",
          score: scored.score, counts: scored.counts,
          results: scored.results.map(({ timeMs, ...result }) => result),
          reward: { xpAwarded: reward.xpAwarded, dailyStreak: reward.dailyStreak, dailyBonusActive: reward.dailyBonusActive },
        };
        tx.set(attemptRef, {
          schemaVersion: quiz.CONTRACT_VERSION, sessionId: request.sessionId, mode: "solo", titleId: session.titleId,
          questionCount: session.questionCount, score: scored.score, counts: scored.counts,
          answers: scored.results.map(({ correctIndex, explanation, ...answer }) => answer),
          reward: canonicalResult.reward, createdAt: Timestamp.fromDate(completedAt), completedAt: Timestamp.fromDate(completedAt),
        });
        tx.set(statsRef, {
          totalScore: prior.totalScore + scored.score, weeklyScore: priorWeekScore + scored.score, weekKey,
          attemptsCount: prior.attemptsCount + 1, correctCount: prior.correctCount + scored.counts.correct,
          wrongCount: prior.wrongCount + scored.counts.wrong, skippedCount: prior.skippedCount + scored.counts.skipped,
          xp: prior.xp + reward.xpAwarded, dailyStreak: reward.dailyStreak, bestDailyStreak: prior.bestDailyStreak,
          lastPlayDayKey: prior.lastPlayDayKey, dailyBonusDayKey: prior.dailyBonusDayKey, dailyBonusGames: prior.dailyBonusGames,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        tx.update(sessionRef, {
          status: "completed", submittedAt: Timestamp.fromDate(completedAt), submitIdempotencyKey: request.idempotencyKey,
          submitPayloadHash: hash, result: canonicalResult, attemptPath: attemptRef.path,
          ttlAt: Timestamp.fromMillis(completedAt.getTime() + quiz.COMPLETED_RETENTION_MS),
        });
        return canonicalResult;
      });
      if (response.expired) throw new quiz.QuizSessionError("failed-precondition", "La sessione è scaduta.");
      return response;
    } catch (error) { throw asHttpsError(functions, error); }
  });
}

module.exports = { registerQuizSessionV2, requireAuthAndAppCheck, fetchPool, sessionData, timestampMillis };
