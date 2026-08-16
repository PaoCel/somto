const test = require("node:test");
const assert = require("node:assert/strict");

const {
  EMOTION_KEYS,
  sanitizeEmotions,
  applyEmotionAggregateDelta,
  emotionSetsEqual,
} = require("../../lib/emotionAggregate");

test("EMOTION_KEYS has the 12 canonical keys", () => {
  assert.equal(EMOTION_KEYS.length, 12);
  assert.equal(new Set(EMOTION_KEYS).size, 12);
  assert.ok(EMOTION_KEYS.includes("touched"));
  assert.ok(EMOTION_KEYS.includes("tense"));
});

test("sanitizeEmotions drops unknown keys, duplicates and non-lists", () => {
  assert.deepEqual(sanitizeEmotions(["touched", "epic_win", "touched", 42]), ["touched"]);
  assert.deepEqual(sanitizeEmotions("touched"), []);
  assert.deepEqual(sanitizeEmotions(null), []);
});

test("create: first doc seeds counts, selections and users", () => {
  const agg = applyEmotionAggregateDelta(null, null, ["touched", "thrilled"]);
  assert.deepEqual(agg.counts, { touched: 1, thrilled: 1 });
  assert.equal(agg.totalSelections, 2);
  assert.equal(agg.totalUsers, 1);
});

test("update: changing the set applies a net delta, users unchanged", () => {
  const seed = { counts: { touched: 3, thrilled: 1 }, totalSelections: 4, totalUsers: 3 };
  const agg = applyEmotionAggregateDelta(seed, ["thrilled"], ["amused", "sad"]);
  assert.deepEqual(agg.counts, { touched: 3, amused: 1, sad: 1 });
  assert.equal(agg.totalSelections, 5);
  assert.equal(agg.totalUsers, 3);
});

test("delete: last selection removes zero-count keys and decrements users", () => {
  const seed = { counts: { touched: 1, amused: 2 }, totalSelections: 3, totalUsers: 2 };
  const agg = applyEmotionAggregateDelta(seed, ["touched"], null);
  assert.deepEqual(agg.counts, { amused: 2 });
  assert.equal(agg.totalSelections, 2);
  assert.equal(agg.totalUsers, 1);
});

test("counts and users never go negative on replayed deletes", () => {
  const agg = applyEmotionAggregateDelta(null, ["touched"], null);
  assert.deepEqual(agg.counts, {});
  assert.equal(agg.totalSelections, 0);
  assert.equal(agg.totalUsers, 0);
});

test("corrupted seed (unknown keys, negative numbers) is cleaned", () => {
  const seed = {
    counts: { touched: 2, legacy_key: 5, sad: -3 },
    totalSelections: 99,
    totalUsers: "x",
  };
  const agg = applyEmotionAggregateDelta(seed, null, ["tense"]);
  assert.deepEqual(agg.counts, { touched: 2, tense: 1 });
  assert.equal(agg.totalSelections, 3);
  assert.equal(agg.totalUsers, 1);
});

test("emotionSetsEqual ignores order and duplicates, detects real changes", () => {
  assert.ok(emotionSetsEqual(["touched", "sad"], ["sad", "touched"]));
  assert.ok(emotionSetsEqual(["touched", "touched"], ["touched"]));
  assert.ok(emotionSetsEqual(null, []));
  assert.ok(!emotionSetsEqual(["touched"], ["sad"]));
  assert.ok(!emotionSetsEqual([], ["sad"]));
});
