"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  collectPriorParticipantUids,
  isImportedCommentMessageId,
  isMessageCreatedNearEvent,
  notificationDocumentId,
  planFanoutDecision,
  verifiedAddedReaction,
} = require("../../lib/threadNotificationPolicy");

test("collectPriorParticipantUids deduplicates, excludes sender and mentions, and caps", () => {
  const recipients = collectPriorParticipantUids(
    [{ uid: "sender" }, { uid: "u1" }, { uid: "u1" }, { uid: "mentioned" }, { uid: "u2" }],
    "sender",
    { excludedUids: ["mentioned"], maxRecipients: 1 }
  );
  assert.deepEqual(recipients, ["u1"]);
});

test("imported TV Time comment ids are recognizable without changing message schema", () => {
  assert.equal(isImportedCommentMessageId("a".repeat(40)), true);
  assert.equal(isImportedCommentMessageId("Ab".repeat(20)), false);
  assert.equal(isImportedCommentMessageId("normalFirestoreId123"), false);
});

test("message freshness uses stable event time", () => {
  assert.equal(
    isMessageCreatedNearEvent({ seconds: 100 }, "1970-01-01T00:01:41.000Z", 2_000),
    true
  );
  assert.equal(
    isMessageCreatedNearEvent({ seconds: 100 }, "1970-01-01T00:20:00.000Z", 2_000),
    false
  );
});

test("verifiedAddedReaction accepts one addition by the authenticated actor", () => {
  const before = {
    reactions: { "❤️": ["u1"] },
  };
  const after = {
    reactions: { "❤️": ["u1", "u2"] },
  };
  assert.deepEqual(verifiedAddedReaction(before, after, "u2"), { actorUid: "u2", emoji: "❤️" });
});

test("verifiedAddedReaction rejects unauthenticated, spoofed, removal, and multi-change deltas", () => {
  const base = { reactions: { "👍": ["u1"], "❤️": [] } };
  const oneAdd = { reactions: { "👍": ["u1", "u2"], "❤️": [] } };
  assert.equal(verifiedAddedReaction(base, oneAdd, null), null);
  assert.equal(verifiedAddedReaction(base, oneAdd, "u3"), null);
  assert.equal(verifiedAddedReaction(base, { reactions: { "👍": [], "❤️": [] } }, "u1"), null);
  assert.equal(verifiedAddedReaction(base, {
    reactions: { "👍": ["u1", "u2"], "❤️": ["u2"] },
  }, "u2"), null);
  assert.equal(verifiedAddedReaction(base, {
    reactions: { "👍": ["u1", "u2", "u3"], "❤️": [] },
  }, "u2"), null);
});

test("notificationDocumentId is stable, scoped and Firestore-safe", () => {
  const first = notificationDocumentId(["thread", "m1", "u1"]);
  assert.equal(first, notificationDocumentId(["thread", "m1", "u1"]));
  assert.notEqual(first, notificationDocumentId(["thread", "m2", "u1"]));
  assert.notEqual(notificationDocumentId(["a|b", "c"]), notificationDocumentId(["a", "b|c"]));
  assert.match(first, /^evt_[a-f0-9]{32}$/);
});

test("reaction notification identity coalesces remove and re-add spam", () => {
  const logicalParts = ["thread_reaction", "thread-1", "message-1", "actor-1", "❤️"];
  const firstAdd = notificationDocumentId(logicalParts);
  const reAdd = notificationDocumentId(logicalParts);
  const otherEmoji = notificationDocumentId([...logicalParts.slice(0, -1), "👍"]);
  const otherActor = notificationDocumentId([
    "thread_reaction", "thread-1", "message-1", "actor-2", "❤️",
  ]);
  assert.equal(firstAdd, reAdd);
  assert.notEqual(firstAdd, otherEmoji);
  assert.notEqual(firstAdd, otherActor);
});

test("fanout decision is durable across later events and scopes identical message ids", () => {
  const first = planFanoutDecision({}, {
    decisionKey: "thread-a:event-a",
    eventMs: 100_000,
    threadId: "thread-a",
    messageId: "same-id",
  }, { cooldownMs: 30_000 });
  assert.equal(first.allowed, true);

  const second = planFanoutDecision({
    ...first.state,
    lastFanoutAt: first.state.lastFanoutAtMs,
  }, {
    decisionKey: "thread-b:event-b",
    eventMs: 110_000,
    threadId: "thread-b",
    messageId: "same-id",
  }, { cooldownMs: 30_000 });
  assert.equal(second.allowed, false);

  const replayFirst = planFanoutDecision({
    ...second.state,
    lastFanoutAt: second.state.lastFanoutAtMs,
  }, {
    decisionKey: "thread-a:event-a",
    eventMs: 100_000,
    threadId: "thread-a",
    messageId: "same-id",
  }, { cooldownMs: 30_000 });
  assert.equal(replayFirst.allowed, true);
  assert.equal(replayFirst.replay, true);
});
