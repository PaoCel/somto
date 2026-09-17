const test = require("node:test");
const assert = require("node:assert/strict");

const {
  makeEpisodeEmotionId,
  makeEpisodeEmotionBucketId,
  sanitizeEpisodeEmotionAggregate,
  applyEpisodeEmotionAggregateDelta,
  emotionSetsEqual,
} = require("../../lib/episodeEmotionAggregate");

test("makeEpisodeEmotionId builds the canonical episode id", () => {
  assert.equal(
    makeEpisodeEmotionId({
      uid: "alice",
      titleId: "the-last-of-us",
      season: 1,
      episode: 5,
    }),
    "alice__the-last-of-us__episode__1__5"
  );
});

test("makeEpisodeEmotionId sanitizes id parts and rejects invalid coordinates", () => {
  assert.equal(
    makeEpisodeEmotionId({ uid: "user@example.com", titleId: "show.one", season: 2, episode: 3 }),
    "user_example_com__show_one__episode__2__3"
  );
  assert.equal(makeEpisodeEmotionId({ uid: "alice", titleId: "title1", season: 0, episode: 1 }), null);
  assert.equal(makeEpisodeEmotionId({ uid: "alice", titleId: "title1", season: 1, episode: 1.5 }), null);
  assert.equal(makeEpisodeEmotionId({ uid: "", titleId: "title1", season: 1, episode: 1 }), null);
});

test("makeEpisodeEmotionBucketId accepts only positive integer coordinates", () => {
  assert.equal(makeEpisodeEmotionBucketId(1, 5), "1_5");
  assert.equal(makeEpisodeEmotionBucketId("2", "10"), "2_10");
  assert.equal(makeEpisodeEmotionBucketId(-1, 5), null);
  assert.equal(makeEpisodeEmotionBucketId(1, NaN), null);
  assert.equal(makeEpisodeEmotionBucketId(1, 2.2), null);
});

test("sanitizeEpisodeEmotionAggregate removes corrupt counts and recomputes selections", () => {
  const aggregate = sanitizeEpisodeEmotionAggregate({
    counts: { touched: 2, unknown: 99, sad: -1, amused: "3" },
    totalSelections: 999,
    totalUsers: 4,
  });
  assert.deepEqual(aggregate, {
    counts: { touched: 2, amused: 3 },
    totalSelections: 5,
    totalUsers: 4,
  });
});

test("create adds all canonical selections and one user", () => {
  const { next, changed } = applyEpisodeEmotionAggregateDelta(
    null,
    null,
    ["touched", "thrilled", "tense"]
  );
  assert.equal(changed, true);
  assert.deepEqual(next, {
    counts: { touched: 1, thrilled: 1, tense: 1 },
    totalSelections: 3,
    totalUsers: 1,
  });
});

test("update applies the selection delta without changing totalUsers", () => {
  const { next, changed } = applyEpisodeEmotionAggregateDelta(
    {
      counts: { touched: 4, thrilled: 2, amused: 1 },
      totalSelections: 7,
      totalUsers: 5,
    },
    ["touched", "thrilled"],
    ["touched", "sad"]
  );
  assert.equal(changed, true);
  assert.deepEqual(next, {
    counts: { touched: 4, thrilled: 1, amused: 1, sad: 1 },
    totalSelections: 7,
    totalUsers: 5,
  });
});

test("delete removes zero-count keys and decrements users", () => {
  const { next, changed } = applyEpisodeEmotionAggregateDelta(
    {
      counts: { touched: 1, sad: 3 },
      totalSelections: 4,
      totalUsers: 3,
    },
    ["touched", "sad"],
    null
  );
  assert.equal(changed, true);
  assert.deepEqual(next, {
    counts: { sad: 2 },
    totalSelections: 2,
    totalUsers: 2,
  });
});

test("replayed delete clamps counts and users at zero", () => {
  const { next } = applyEpisodeEmotionAggregateDelta(null, ["touched"], null);
  assert.deepEqual(next, { counts: {}, totalSelections: 0, totalUsers: 0 });
});

test("unknown and duplicate emotion values never enter the aggregate", () => {
  const { next } = applyEpisodeEmotionAggregateDelta(
    null,
    null,
    ["touched", "unknown", "touched", 42]
  );
  assert.deepEqual(next, {
    counts: { touched: 1 },
    totalSelections: 1,
    totalUsers: 1,
  });
});

test("same emotion set is a no-op even when order changes", () => {
  assert.equal(emotionSetsEqual(["touched", "sad"], ["sad", "touched"]), true);
  const { next, changed } = applyEpisodeEmotionAggregateDelta(
    {
      counts: { touched: 2, sad: 2 },
      totalSelections: 4,
      totalUsers: 2,
    },
    ["touched", "sad"],
    ["sad", "touched"]
  );
  assert.equal(changed, false);
  assert.deepEqual(next, {
    counts: { touched: 2, sad: 2 },
    totalSelections: 4,
    totalUsers: 2,
  });
});
