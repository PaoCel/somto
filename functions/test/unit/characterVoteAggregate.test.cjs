const test = require("node:test");
const assert = require("node:assert/strict");

const { EMOTION_KEYS } = require("../../lib/emotionAggregate");
const {
  MAX_PICKS,
  MAX_BUCKET_PERSONS,
  PICK_REACTION_KEYS,
  normalizePicks,
  makeCharacterVoteId,
  makeEpisodeBucketId,
  applyEpisodeAggregateDelta,
  applyPersonalRollupDelta,
  applyUniqueUserAggregateDelta,
  pruneBucket,
} = require("../../lib/characterVoteAggregate");

const pick = (personId, character, reaction) => ({ personId, character, reaction });

test("constants: caps and reaction whitelist reuse EMOTION_KEYS", () => {
  assert.equal(MAX_PICKS, 3);
  assert.equal(MAX_BUCKET_PERSONS, 40);
  assert.equal(PICK_REACTION_KEYS, EMOTION_KEYS); // stessa referenza, non una copia
});

// --- normalizePicks ----------------------------------------------------------

test("normalizePicks: non-array input degrades to []", () => {
  assert.deepEqual(normalizePicks(null), []);
  assert.deepEqual(normalizePicks(undefined), []);
  assert.deepEqual(normalizePicks("nope"), []);
  assert.deepEqual(normalizePicks({ personId: "1" }), []);
});

test("normalizePicks: garbage items are dropped, valid ones survive", () => {
  const out = normalizePicks([null, 42, "x", [], {}, { personId: 123 }, { personId: "" }, pick("1", "Joel")]);
  assert.deepEqual(out, [{ personId: "1", character: "Joel", reaction: null }]);
});

test("normalizePicks: personId too long or empty after trim is dropped", () => {
  const tooLong = "x".repeat(33);
  const out = normalizePicks([{ personId: tooLong }, { personId: "   " }, pick("ok-id", "Name")]);
  assert.deepEqual(out, [{ personId: "ok-id", character: "Name", reaction: null }]);
});

test("normalizePicks: dedup on personId keeps the first occurrence", () => {
  const out = normalizePicks([pick("1", "First"), pick("1", "Second")]);
  assert.equal(out.length, 1);
  assert.equal(out[0].character, "First");
});

test("normalizePicks: caps at MAX_PICKS, preserving input order", () => {
  const out = normalizePicks([pick("1"), pick("2"), pick("3"), pick("4"), pick("5")]);
  assert.deepEqual(out.map((p) => p.personId), ["1", "2", "3"]);
});

test("normalizePicks: invalid reaction is zeroed, valid reaction kept", () => {
  const out = normalizePicks([pick("1", "A", "joy"), pick("2", "B", "touched")]);
  assert.equal(out[0].reaction, null);
  assert.equal(out[1].reaction, "touched");
});

test("normalizePicks: character is trimmed and truncated at 120, blank becomes null", () => {
  const long = "y".repeat(200);
  const out = normalizePicks([pick("1", long), pick("2", "   ")]);
  assert.equal(out[0].character, "y".repeat(120));
  assert.equal(out[1].character, null);
});

// --- makeCharacterVoteId -------------------------------------------------------

test("makeCharacterVoteId: sanitizes odd characters like makeRatingId's safePart", () => {
  const id = makeCharacterVoteId({ uid: "ab c", titleId: "ti#tle", level: "episode", season: 1, episode: 2 });
  assert.equal(id, "ab_c__ti_tle__episode__1__2");
});

test("makeCharacterVoteId: invalid level returns null", () => {
  assert.equal(makeCharacterVoteId({ uid: "u", titleId: "t", level: "season" }), null);
  assert.equal(makeCharacterVoteId({ uid: "u", titleId: "t", level: "movie" }), null);
  assert.equal(makeCharacterVoteId({ uid: "u", titleId: "t" }), null);
});

test("makeCharacterVoteId: missing season/episode default to 0", () => {
  const id = makeCharacterVoteId({ uid: "u1", titleId: "t1", level: "title" });
  assert.equal(id, "u1__t1__title__0__0");
});

// --- makeEpisodeBucketId --------------------------------------------------------

test("makeEpisodeBucketId: builds season_episode for integers", () => {
  assert.equal(makeEpisodeBucketId(1, 5), "1_5");
  assert.equal(makeEpisodeBucketId("2", "3"), "2_3");
});

test("makeEpisodeBucketId: non-integers return null", () => {
  assert.equal(makeEpisodeBucketId(NaN, 1), null);
  assert.equal(makeEpisodeBucketId("abc", 1), null);
  assert.equal(makeEpisodeBucketId(1.5, 2), null);
  assert.equal(makeEpisodeBucketId(undefined, undefined), null);
});

// --- pruneBucket -----------------------------------------------------------------

test("pruneBucket: keeps top-N by count, tie-break ascending on personId", () => {
  const counts = { a: 5, b: 5, c: 10, d: 1, e: 5 };
  assert.deepEqual(pruneBucket(counts, 3), { c: 10, a: 5, b: 5 });
});

test("pruneBucket: cap >= size returns an equivalent new object", () => {
  const counts = { a: 1, b: 2 };
  const out = pruneBucket(counts, 10);
  assert.deepEqual(out, counts);
  assert.notEqual(out, counts);
});

test("pruneBucket: cap 0 and malformed input degrade to {}", () => {
  assert.deepEqual(pruneBucket({ a: 1 }, 0), {});
  assert.deepEqual(pruneBucket(null), {});
  assert.deepEqual(pruneBucket("nope"), {});
});

// --- applyEpisodeAggregateDelta --------------------------------------------------

test("episode aggregate: first vote seeds counts and totalUsers=1", () => {
  const { next, changed } = applyEpisodeAggregateDelta(null, { beforePicks: [], afterPicks: [pick("1"), pick("2")] });
  assert.deepEqual(next, { counts: { "1": 1, "2": 1 }, totalPicks: 2, totalUsers: 1 });
  assert.equal(changed, true);
});

test("episode aggregate: switching a pick updates counts, totalUsers unchanged", () => {
  const current = { counts: { "1": 1 }, totalPicks: 1, totalUsers: 1 };
  const { next, changed } = applyEpisodeAggregateDelta(current, {
    beforePicks: [pick("1")],
    afterPicks: [pick("2")],
  });
  assert.deepEqual(next, { counts: { "2": 1 }, totalPicks: 1, totalUsers: 1 });
  assert.equal(changed, true);
});

test("episode aggregate: deleting the vote removes the key and drops totalUsers to 0", () => {
  const current = { counts: { "1": 1 }, totalPicks: 1, totalUsers: 1 };
  const { next, changed } = applyEpisodeAggregateDelta(current, { beforePicks: [pick("1")], afterPicks: null });
  assert.deepEqual(next, { counts: {}, totalPicks: 0, totalUsers: 0 });
  assert.equal(changed, true);
});

test("episode aggregate: corrupted seed never goes negative", () => {
  const current = { counts: { "1": -5, "2": "abc" }, totalUsers: -10 };
  const { next, changed } = applyEpisodeAggregateDelta(current, { beforePicks: null, afterPicks: null });
  assert.deepEqual(next, { counts: {}, totalPicks: 0, totalUsers: 0 });
  assert.equal(changed, false);
});

test("episode aggregate: changed=false when the personId set is unchanged (reaction-only edit)", () => {
  const current = { counts: { "1": 1 }, totalPicks: 1, totalUsers: 1 };
  const { next, changed } = applyEpisodeAggregateDelta(current, {
    beforePicks: [pick("1", "A", "touched")],
    afterPicks: [pick("1", "A", "amused")],
  });
  assert.deepEqual(next, current);
  assert.equal(changed, false);
});

// --- applyPersonalRollupDelta -----------------------------------------------------

test("personal rollup: entering a series/season set on first episode vote", () => {
  const result = applyPersonalRollupDelta(null, {
    level: "episode",
    season: 1,
    beforePicks: [],
    afterPicks: [pick("A", "Alice")],
  });
  assert.deepEqual(result.next.series, { A: 1 });
  assert.deepEqual(result.next.bySeason, { "1": { A: 1 } });
  assert.equal(result.next.episodes, 1);
  assert.deepEqual(result.next.top, { personId: "A", character: "Alice", count: 1 });
  assert.deepEqual(result.seriesEntered, ["A"]);
  assert.deepEqual(result.seasonEntered, ["A"]);
  assert.equal(result.seasonKey, "1");
  assert.deepEqual(result.seriesLeft, []);
  assert.deepEqual(result.seasonLeft, []);
  assert.equal(result.changed, true);
});

test("personal rollup: leaving the series/season set when the last episode pick is removed", () => {
  const current = {
    series: { A: 1 },
    bySeason: { "1": { A: 1 } },
    direct: {},
    top: { personId: "A", character: "Alice", count: 1 },
    episodes: 1,
  };
  const result = applyPersonalRollupDelta(current, {
    level: "episode",
    season: 1,
    beforePicks: [pick("A", "Alice")],
    afterPicks: [],
  });
  assert.deepEqual(result.next.series, {});
  assert.deepEqual(result.next.bySeason, { "1": {} });
  assert.equal(result.next.episodes, 0);
  assert.equal(result.next.top, null);
  assert.deepEqual(result.seriesLeft, ["A"]);
  assert.deepEqual(result.seasonLeft, ["A"]);
  assert.equal(result.changed, true);
});

test("personal rollup: level=title updates series+direct but never bySeason/episodes", () => {
  const current = {
    series: { A: 2 },
    bySeason: { "1": { A: 2 } },
    direct: {},
    top: { personId: "A", character: "Alice", count: 2 },
    episodes: 2,
  };
  const result = applyPersonalRollupDelta(current, {
    level: "title",
    beforePicks: [],
    afterPicks: [pick("B", "Bob")],
  });
  assert.deepEqual(result.next.series, { A: 2, B: 1 });
  assert.deepEqual(result.next.direct, { B: 1 });
  assert.deepEqual(result.next.bySeason, { "1": { A: 2 } }); // invariato
  assert.equal(result.next.episodes, 2); // invariato
  assert.equal(result.seasonKey, null);
  assert.deepEqual(result.seasonEntered, []);
  assert.deepEqual(result.seasonLeft, []);
});

test("personal rollup: top uses ascending lexicographic tie-break and the freshest character snapshot", () => {
  const result = applyPersonalRollupDelta(null, {
    level: "title",
    beforePicks: [],
    afterPicks: [pick("200", "Bob"), pick("100", "Alice")],
  });
  assert.deepEqual(result.next.top, { personId: "100", character: "Alice", count: 1 });
});

test("personal rollup: top falls back to the current snapshot's character when the winner isn't in afterPicks", () => {
  const current = {
    series: { "5": 3, "9": 1 },
    bySeason: {},
    direct: {},
    top: { personId: "5", character: "Zed", count: 3 },
    episodes: 4,
  };
  const result = applyPersonalRollupDelta(current, {
    level: "episode",
    season: 1,
    beforePicks: [pick("9", "Nine")],
    afterPicks: [pick("9", "Nine")],
  });
  assert.deepEqual(result.next.top, { personId: "5", character: "Zed", count: 3 });
});

test("personal rollup: episodes counter never drops below 0", () => {
  const current = { series: {}, bySeason: { "1": {} }, direct: {}, top: null, episodes: 0 };
  const result = applyPersonalRollupDelta(current, {
    level: "episode",
    season: 1,
    beforePicks: [pick("A")],
    afterPicks: [],
  });
  assert.equal(result.next.episodes, 0);
});

test("personal rollup: changed=false on a true no-op replay", () => {
  const current = {
    series: { A: 1 },
    bySeason: { "1": { A: 1 } },
    direct: {},
    top: { personId: "A", character: "Alice", count: 1 },
    episodes: 1,
  };
  const result = applyPersonalRollupDelta(current, {
    level: "episode",
    season: 1,
    beforePicks: [pick("A", "Alice")],
    afterPicks: [pick("A", "Alice")],
  });
  assert.equal(result.changed, false);
  assert.deepEqual(result.seriesEntered, []);
  assert.deepEqual(result.seriesLeft, []);
});

// --- applyUniqueUserAggregateDelta -----------------------------------------------

test("unique-user: entered adds counts and totalUsers on scope=series", () => {
  const { next, changed } = applyUniqueUserAggregateDelta(null, {
    scope: "series",
    entered: ["A", "B"],
    userEntered: true,
  });
  assert.deepEqual(next.series, { counts: { A: 1, B: 1 }, totalUsers: 1 });
  assert.deepEqual(next.bySeason, {});
  assert.deepEqual(next.direct, { counts: {}, totalUsers: 0 });
  assert.equal(changed, true);
});

test("unique-user: left removes a person but keeps the user counted without userLeft", () => {
  const current = { series: { counts: { A: 1, B: 1 }, totalUsers: 1 }, bySeason: {}, direct: {} };
  const { next } = applyUniqueUserAggregateDelta(current, { scope: "series", left: ["A"] });
  assert.deepEqual(next.series, { counts: { B: 1 }, totalUsers: 1 });
});

test("unique-user: userLeft on the last person drops totalUsers to 0", () => {
  const current = { series: { counts: { B: 1 }, totalUsers: 1 }, bySeason: {}, direct: {} };
  const { next } = applyUniqueUserAggregateDelta(current, { scope: "series", left: ["B"], userLeft: true });
  assert.deepEqual(next.series, { counts: {}, totalUsers: 0 });
});

test("unique-user: clamps counts and totalUsers, never negative on incoherent input", () => {
  const { next } = applyUniqueUserAggregateDelta(null, { scope: "series", left: ["Z"], userLeft: true });
  assert.deepEqual(next.series, { counts: {}, totalUsers: 0 });
});

test("unique-user: scope=season targets bySeason[seasonKey] only", () => {
  const { next } = applyUniqueUserAggregateDelta(null, {
    scope: "season",
    seasonKey: 2,
    entered: ["A"],
    userEntered: true,
  });
  assert.deepEqual(next.bySeason, { "2": { counts: { A: 1 }, totalUsers: 1 } });
  assert.deepEqual(next.series, { counts: {}, totalUsers: 0 });
});

test("unique-user: scope=direct targets the direct bucket only", () => {
  const { next } = applyUniqueUserAggregateDelta(null, { scope: "direct", entered: ["C"], userEntered: true });
  assert.deepEqual(next.direct, { counts: { C: 1 }, totalUsers: 1 });
  assert.deepEqual(next.series, { counts: {}, totalUsers: 0 });
});

test("unique-user: unknown scope is a no-op, changed=false", () => {
  const current = { series: { counts: { A: 1 }, totalUsers: 1 }, bySeason: {}, direct: {} };
  const { next, changed } = applyUniqueUserAggregateDelta(current, { scope: "bogus", entered: ["Z"] });
  assert.deepEqual(next.series, { counts: { A: 1 }, totalUsers: 1 });
  assert.equal(changed, false);
});
