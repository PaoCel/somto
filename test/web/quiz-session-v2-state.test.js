import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  canonicalAnswersFromQuizSessionV2,
  clearPendingQuizSessionV2,
  createPendingQuizSessionV2,
  loadPendingQuizSessionV2,
  savePendingQuizSessionV2,
  shouldUseQuizSessionV2,
} from "../../public/js/utils/quizSessionV2State.js";

const uid = "alice";
const sessionId = "session_1";
const idempotencyKey = "123e4567-e89b-42d3-a456-426614174000";
const expiresAt = "2026-08-05T12:20:00.000Z";
const answers = [{ questionId: "q1", selectedIndex: 2, timeMs: 900 }];

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test("V2 is staging-only, build-gated and never applies to challenges", () => {
  assert.equal(shouldUseQuizSessionV2({ buildEnabled: false, environment: "staging", challengeId: null }), false);
  assert.equal(shouldUseQuizSessionV2({ buildEnabled: true, environment: "production", challengeId: null }), false);
  assert.equal(shouldUseQuizSessionV2({ buildEnabled: true, environment: "staging", challengeId: "challenge" }), false);
  assert.equal(shouldUseQuizSessionV2({ buildEnabled: true, environment: "staging", challengeId: null }), true);
});

test("pending submit survives refresh with the same session and idempotency key", () => {
  const storage = memoryStorage();
  const pending = createPendingQuizSessionV2({ uid, sessionId, expiresAt, idempotencyKey, answers });
  assert.ok(pending);
  assert.equal(savePendingQuizSessionV2(storage, pending), true);
  const restored = loadPendingQuizSessionV2(storage, uid, Date.parse("2026-08-05T12:10:00.000Z"));
  assert.equal(restored.sessionId, sessionId);
  assert.equal(restored.idempotencyKey, idempotencyKey);
  assert.deepEqual(restored.answers, answers);
  clearPendingQuizSessionV2(storage, uid);
  assert.equal(loadPendingQuizSessionV2(storage, uid), null);
});

test("expired, malformed or duplicate pending payloads are rejected", () => {
  const storage = memoryStorage();
  const expired = createPendingQuizSessionV2({ uid, sessionId, expiresAt, idempotencyKey, answers });
  savePendingQuizSessionV2(storage, expired);
  assert.equal(loadPendingQuizSessionV2(storage, uid, Date.parse("2026-08-05T12:21:00.000Z")), null);
  assert.equal(createPendingQuizSessionV2({
    uid, sessionId, expiresAt, idempotencyKey, answers: [answers[0], answers[0]],
  }), null);
});

test("canonical result replaces every client-side pending outcome", () => {
  assert.deepEqual(canonicalAnswersFromQuizSessionV2({
    results: [{ questionId: "q1", selectedIndex: 2, outcome: "wrong", correctIndex: 1 }],
  }), [{ questionId: "q1", selectedIndex: 2, outcome: "wrong" }]);
});

test("PWA V2 stays hard-off and never falls through to legacy submit", async () => {
  const [api, player] = await Promise.all([
    readFile(new URL("../../public/js/api/quiz.api.js", import.meta.url), "utf8"),
    readFile(new URL("../../public/js/pages/quiz-play.page.js", import.meta.url), "utf8"),
  ]);
  assert.match(api, /QUIZ_SESSION_V2_ENABLED\s*=\s*false/);
  assert.match(player, /if \(state\.usesSessionV2\) \{\s*await finishSessionV2\(\);\s*return;/);
  assert.match(player, /state\.usesSessionV2\s*\?\s*"pending"/);
  assert.match(player, /buildEnabled:\s*QUIZ_SESSION_V2_ENABLED/);
  assert.match(player, /environment:\s*window\.__SOMTO_ENV__/);
});
