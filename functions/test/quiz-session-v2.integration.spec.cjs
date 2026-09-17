const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const admin = require("firebase-admin");
const { registerQuizSessionV2 } = require("../modules/quizSessionV2");

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("FIRESTORE_EMULATOR_HOST is not set. Run via npm run test:rules.");
}

const projectId = "quiz-session-v2-integration";
const app = admin.initializeApp({ projectId }, `quiz-session-v2-${process.pid}`);
const db = admin.firestore(app);
let clock = new Date("2026-08-04T12:00:00Z");
let handlers;

class HttpsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fakeFunctions() {
  return {
    https: { HttpsError },
    region(region) {
      assert.equal(region, "europe-west1");
      return {
        runWith(options) {
          assert.equal(options.enforceAppCheck, true);
          return { https: { onCall: (handler) => handler } };
        },
      };
    },
  };
}

function adminDependency() {
  const firestore = () => db;
  firestore.Timestamp = admin.firestore.Timestamp;
  firestore.FieldValue = admin.firestore.FieldValue;
  return { firestore };
}

async function seedQuestions() {
  const batch = db.batch();
  for (let index = 0; index < 3; index += 1) {
    const id = `v2_q${index + 1}`;
    batch.set(db.collection("quizQuestions").doc(id), {
      questionId: id,
      titleId: "v2_title",
      title: "Titolo V2",
      mediaType: "movie",
      questionText: `Domanda ${index + 1}`,
      answers: ["A", "B", "C", "D"],
      correctAnswerIndex: index,
      explanation: `Spiegazione ${index + 1}`,
      difficulty: "medium",
      spoilerLevel: "none",
      status: "approved",
      language: "it",
    });
  }
  await batch.commit();
}

function context(uid) {
  return { auth: { uid }, app: { appId: "test-app" } };
}

async function start(uid) {
  return handlers.startQuizSessionV2({
    contractVersion: 2,
    clientRequestId: randomUUID(),
    mode: "solo",
    titleId: "v2_title",
    count: 3,
    language: "it",
  }, context(uid));
}

function answersFor(started) {
  return started.questions.map((question, index) => ({
    questionId: question.questionId,
    selectedIndex: question.questionId === "v2_q1" ? 0 : (question.questionId === "v2_q2" ? 0 : null),
    timeMs: 1000 + index,
  }));
}

async function submit(uid, started, idempotencyKey, answers = answersFor(started), extras = {}) {
  return handlers.submitQuizSessionV2({
    contractVersion: 2,
    sessionId: started.sessionId,
    idempotencyKey,
    answers,
    ...extras,
  }, context(uid));
}

before(async () => {
  await seedQuestions();
  const exported = {};
  registerQuizSessionV2(exported, {
    functions: fakeFunctions(),
    admin: adminDependency(),
    enforceCallableRateLimit: async () => {},
    now: () => new Date(clock),
    random: () => 0,
  });
  handlers = exported;
});

after(async () => {
  await app.delete();
});

test("start omette answer key e ricontrolla il pool approved", async () => {
  const started = await start("start-user");
  assert.equal(started.questions.length, 3);
  assert.equal(started.status, "active");
  for (const question of started.questions) {
    assert.equal("correctAnswerIndex" in question, false);
    assert.equal("explanation" in question, false);
  }
  const stored = (await db.collection("quizSessions").doc(started.sessionId).get()).data();
  assert.equal(stored.ownerUid, "start-user");
  assert.equal(stored.questions[0].correctAnswerIndex >= 0, true);
});

test("submit atomico calcola score e salva attempt senza answer key", async () => {
  const uid = "submit-user";
  const started = await start(uid);
  const result = await submit(uid, started, randomUUID());
  assert.equal(result.score, 0.8);
  assert.deepEqual(result.counts, { correct: 1, wrong: 1, skipped: 1 });
  assert.equal(result.reward.xpAwarded, 12);

  const attempt = (await db.doc(`users/${uid}/quizAttempts/${started.sessionId}`).get()).data();
  assert.equal(attempt.answers.some((answer) => "correctIndex" in answer || "explanation" in answer), false);
  const stats = (await db.doc(`users/${uid}/quizStats/agg`).get()).data();
  assert.equal(stats.attemptsCount, 1);
  assert.equal(stats.xp, 12);
});

test("retry concorrente accredita una sola volta e restituisce cached result", async () => {
  const uid = "retry-user";
  const started = await start(uid);
  const key = randomUUID();
  const results = await Promise.all([
    submit(uid, started, key),
    submit(uid, started, key),
  ]);
  assert.deepEqual(new Set(results.map((result) => result.status)), new Set(["completed", "already_completed"]));
  const stats = (await db.doc(`users/${uid}/quizStats/agg`).get()).data();
  assert.equal(stats.attemptsCount, 1);
  assert.equal(stats.xp, 12);
});

test("payload alterato, sessione altrui e replay diverso sono rifiutati", async () => {
  const uid = "tamper-user";
  const started = await start(uid);
  const key = randomUUID();
  await assert.rejects(() => submit(uid, started, key, answersFor(started), { score: 999 }), { code: "invalid-argument" });
  await assert.rejects(() => submit("intruder", started, key), { code: "not-found" });
  await submit(uid, started, key);
  const changed = answersFor(started);
  changed[0] = { ...changed[0], selectedIndex: 1 };
  await assert.rejects(() => submit(uid, started, key, changed), { code: "failed-precondition" });
  const stats = (await db.doc(`users/${uid}/quizStats/agg`).get()).data();
  assert.equal(stats.attemptsCount, 1);
});

test("submit scaduto marca la sessione senza creare reward", async () => {
  const uid = "expired-user";
  clock = new Date("2026-08-04T12:00:00Z");
  const started = await start(uid);
  clock = new Date("2026-08-04T12:21:00Z");
  await assert.rejects(() => submit(uid, started, randomUUID()), { code: "failed-precondition" });
  const session = (await db.collection("quizSessions").doc(started.sessionId).get()).data();
  assert.equal(session.status, "expired");
  assert.equal((await db.doc(`users/${uid}/quizStats/agg`).get()).exists, false);
  assert.equal((await db.doc(`users/${uid}/quizAttempts/${started.sessionId}`).get()).exists, false);
});
