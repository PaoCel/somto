const test = require("node:test");
const assert = require("node:assert/strict");
const q = require("../../lib/quizSessionV2");

const uuid = "123e4567-e89b-42d3-a456-426614174000";
const question = (id, correctAnswerIndex = 1) => ({
  id, data: { questionId: id, titleId: "title", title: "Titolo", mediaType: "movie", questionText: `Q ${id}`,
    answers: ["a", "b", "c", "d"], correctAnswerIndex, explanation: "Perché", status: "approved", language: "it" },
});

test("start validation accepts only the V2 solo approved contract", () => {
  assert.deepEqual(q.validateStartRequest({ contractVersion: 2, clientRequestId: uuid, mode: "solo", count: 5, language: "it" }), {
    clientRequestId: uuid, mode: "solo", titleId: null, count: 5, language: "it",
  });
  assert.throws(() => q.validateStartRequest({ contractVersion: 2, clientRequestId: uuid, mode: "solo", count: 4, language: "it" }));
  assert.throws(() => q.validateStartRequest({ contractVersion: 2, clientRequestId: uuid, mode: "challenge", count: 5, language: "it" }));
  assert.throws(() => q.validateStartRequest({ contractVersion: 2, clientRequestId: uuid, mode: "solo", count: 5, language: "it", score: 999 }));
});

test("public question omits answer key and explanation", () => {
  const snapshot = q.toSnapshot(question("q1").data, "q1");
  const response = q.publicQuestion(snapshot);
  assert.equal("correctAnswerIndex" in response, false);
  assert.equal("explanation" in response, false);
  assert.equal(response.answers.length, 4);
});

test("pool accepts only structurally valid approved Italian questions", () => {
  const beta = question("beta"); beta.data.status = "beta_pending_review";
  const en = question("en"); en.data.language = "en";
  const bad = question("bad"); bad.data.answers = ["a", "b"];
  const duplicateAnswers = question("duplicate"); duplicateAnswers.data.answers = ["a", "A", "c", "d"];
  assert.deepEqual(q.selectSnapshots([question("a"), question("b"), beta, en, bad, duplicateAnswers], 2, () => 0).map((x) => x.questionId), ["b", "a"]);
  assert.throws(() => q.selectSnapshots([question("a"), beta], 2));
});

test("submit validation rejects duplicates, invalid indices and malformed skips", () => {
  const base = { contractVersion: 2, sessionId: "session", idempotencyKey: uuid, answers: [{ questionId: "q1", selectedIndex: null, timeMs: 0 }] };
  assert.equal(q.validateSubmitRequest(base).answers[0].selectedIndex, null);
  assert.throws(() => q.validateSubmitRequest({ ...base, answers: [base.answers[0], base.answers[0]] }));
  assert.throws(() => q.validateSubmitRequest({ ...base, answers: [{ questionId: "q1", selectedIndex: 4, timeMs: 1 }] }));
  assert.throws(() => q.validateSubmitRequest({ ...base, answers: [{ questionId: "q1", selectedIndex: null, timeMs: null }] }));
  assert.throws(() => q.validateSubmitRequest({ ...base, score: 999 }));
  assert.throws(() => q.validateSubmitRequest({ ...base, sessionId: "owner/session" }));
  assert.throws(() => q.validateSubmitRequest({ ...base, sessionId: "a".repeat(129) }));
  assert.throws(() => q.validateSubmitRequest({ ...base, answers: [{ ...base.answers[0], outcome: "correct" }] }));
});

test("payload hash is order-independent but binds answer contents", () => {
  const a = [{ questionId: "a", selectedIndex: 1, timeMs: 3 }, { questionId: "b", selectedIndex: null, timeMs: 4 }];
  assert.equal(q.payloadHash(a), q.payloadHash(a.slice().reverse()));
  assert.notEqual(q.payloadHash(a), q.payloadHash([{ ...a[0], selectedIndex: 2 }, a[1]]));
});

test("score requires the exact snapshot set and never trusts client outcome", () => {
  const snapshots = [q.toSnapshot(question("a", 1).data, "a"), q.toSnapshot(question("b", 0).data, "b")];
  const result = q.scoreSubmission(snapshots, [
    { questionId: "b", selectedIndex: null, timeMs: 10 }, { questionId: "a", selectedIndex: 1, timeMs: 20 },
  ]);
  assert.deepEqual(result.counts, { correct: 1, wrong: 0, skipped: 1 });
  assert.equal(result.score, 1);
  assert.throws(() => q.scoreSubmission(snapshots, [{ questionId: "a", selectedIndex: 1, timeMs: 1 }]));
});

test("reward mirrors solo XP, third game daily bonus and same-day streak", () => {
  const now = new Date("2026-08-04T12:00:00Z");
  const today = q.romeDayKey(now);
  const reward = q.computeReward({ dailyStreak: 4, lastPlayDayKey: today, dailyBonusDayKey: today, dailyBonusGames: 2 }, 3, now);
  assert.equal(reward.xpAwarded, 19); // round((10 + 6) * 1.2)
  assert.equal(reward.dailyStreak, 4);
  assert.equal(reward.dailyBonusActive, true);
});

test("week key follows the Europe/Rome calendar at the UTC boundary", () => {
  assert.equal(q.isoWeekKey(new Date("2026-08-02T22:30:00Z")), "2026-W32");
});

test("completed replay returns only the cached result for the same key and payload", () => {
  const result = { contractVersion: 2, sessionId: "session", status: "completed", score: 1 };
  const session = { status: "completed", submitIdempotencyKey: uuid, submitPayloadHash: "hash", result };
  assert.deepEqual(q.completedReplay(session, uuid, "hash"), { ...result, status: "already_completed" });
  assert.throws(() => q.completedReplay(session, uuid, "different"), /già stata completata/);
  assert.equal(q.completedReplay({ status: "active" }, uuid, "hash"), null);
});
