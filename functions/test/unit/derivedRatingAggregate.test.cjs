const test = require("node:test");
const assert = require("node:assert/strict");

const {
  round2,
  episodeContribution,
  derivedDeltaIsNoop,
  sanitizeBySeason,
  applyDerivedEpisodeDelta,
} = require("../../lib/derivedRatingAggregate");

const ep = (season, episode, rating) => ({
  level: "episode",
  season,
  episode,
  rating,
});

test("round2 rounds to two decimals", () => {
  assert.equal(round2(8.333333), 8.33);
  assert.equal(round2(7 / 3 + 6), 8.33);
  assert.equal(round2(undefined), 0);
});

test("episodeContribution accepts only valid episode ratings", () => {
  assert.deepEqual(episodeContribution(ep(2, 3, 9)), { season: 2, rating: 9 });
  assert.equal(episodeContribution({ level: "title", rating: 8 }), null);
  assert.equal(episodeContribution({ level: "season", season: 1, rating: 8 }), null);
  assert.equal(episodeContribution(ep(0, 3, 9)), null); // season must be > 0
  assert.equal(episodeContribution({ level: "episode", season: 1, episode: 1, rating: "x" }), null);
  assert.equal(episodeContribution(null), null);
});

test("derivedDeltaIsNoop: non-episode writes and unchanged episodes are no-ops", () => {
  assert.ok(derivedDeltaIsNoop(null, { level: "title", rating: 8 }));
  assert.ok(derivedDeltaIsNoop({ level: "season", season: 1, rating: 7 }, { level: "season", season: 1, rating: 7 }));
  // same episode, same rating (e.g. only reviewText/updatedAt changed)
  assert.ok(derivedDeltaIsNoop(ep(1, 4, 8), ep(1, 4, 8)));
  // real changes are NOT no-ops
  assert.ok(!derivedDeltaIsNoop(null, ep(1, 4, 8)));
  assert.ok(!derivedDeltaIsNoop(ep(1, 4, 8), ep(1, 4, 9)));
  assert.ok(!derivedDeltaIsNoop(ep(1, 4, 8), null));
});

test("sanitizeBySeason drops bad keys, zero/negative counts and NaN", () => {
  const clean = sanitizeBySeason({
    "1": { sum: 16, count: 2 },
    "0": { sum: 5, count: 1 },       // season 0 invalid
    "2": { sum: 8, count: 0 },       // count 0 dropped
    foo: { sum: 9, count: 3 },       // non-numeric key
  });
  assert.deepEqual(clean, { "1": { sum: 16, count: 2 } });
});

test("create: first episode seeds a one-season series equal to that episode", () => {
  const next = applyDerivedEpisodeDelta(null, null, ep(1, 1, 8));
  assert.deepEqual(next.episodeAgg.bySeason, { "1": { sum: 8, count: 1 } });
  assert.deepEqual(next.season, { "1": { avg: 8, count: 1 } });
  assert.deepEqual(next.series, { avg: 8, seasonCount: 1, episodeCount: 1 });
  assert.equal(next.isEmpty, false);
});

test("second episode in same season averages the season", () => {
  const seed = { episodeAgg: { bySeason: { "1": { sum: 8, count: 1 } } } };
  const next = applyDerivedEpisodeDelta(seed, null, ep(1, 2, 6));
  assert.deepEqual(next.episodeAgg.bySeason, { "1": { sum: 14, count: 2 } });
  assert.equal(next.season["1"].avg, 7);
  assert.deepEqual(next.series, { avg: 7, seasonCount: 1, episodeCount: 2 });
});

test("series = mean of season averages (each season weighs equally)", () => {
  // Season 1: two episodes avg 9; Season 2: one episode 6.
  // Per-vote weighting would give (9+9+6)/3 = 8; season-mean gives (9+6)/2 = 7.5.
  const seed = {
    episodeAgg: { bySeason: { "1": { sum: 18, count: 2 } } },
  };
  const next = applyDerivedEpisodeDelta(seed, null, ep(2, 1, 6));
  assert.equal(next.season["1"].avg, 9);
  assert.equal(next.season["2"].avg, 6);
  assert.equal(next.series.avg, 7.5);
  assert.equal(next.series.seasonCount, 2);
  assert.equal(next.series.episodeCount, 3);
});

test("update: re-rating an episode changes the season avg, count unchanged", () => {
  const seed = { episodeAgg: { bySeason: { "1": { sum: 14, count: 2 } } } };
  // episode S1E2 was 6, now 10 -> sum 14-6+10 = 18, count still 2
  const next = applyDerivedEpisodeDelta(seed, ep(1, 2, 6), ep(1, 2, 10));
  assert.deepEqual(next.episodeAgg.bySeason, { "1": { sum: 18, count: 2 } });
  assert.equal(next.season["1"].avg, 9);
});

test("delete: removing the last episode of a season drops that season", () => {
  const seed = {
    episodeAgg: { bySeason: { "1": { sum: 8, count: 1 }, "2": { sum: 6, count: 1 } } },
  };
  const next = applyDerivedEpisodeDelta(seed, ep(2, 1, 6), null);
  assert.deepEqual(next.episodeAgg.bySeason, { "1": { sum: 8, count: 1 } });
  assert.deepEqual(next.season, { "1": { avg: 8, count: 1 } });
  assert.deepEqual(next.series, { avg: 8, seasonCount: 1, episodeCount: 1 });
  assert.equal(next.isEmpty, false);
});

test("delete: removing the last episode of the title empties the derived doc", () => {
  const seed = { episodeAgg: { bySeason: { "1": { sum: 8, count: 1 } } } };
  const next = applyDerivedEpisodeDelta(seed, ep(1, 1, 8), null);
  assert.deepEqual(next.episodeAgg.bySeason, {});
  assert.deepEqual(next.season, {});
  assert.equal(next.series, null);
  assert.equal(next.isEmpty, true);
});

test("counts never go negative on replayed deletes", () => {
  const next = applyDerivedEpisodeDelta(null, ep(1, 1, 8), null);
  assert.deepEqual(next.episodeAgg.bySeason, {});
  assert.equal(next.series, null);
  assert.equal(next.isEmpty, true);
});

test("episode moving to another season is handled as remove+add", () => {
  const seed = { episodeAgg: { bySeason: { "1": { sum: 8, count: 1 } } } };
  const next = applyDerivedEpisodeDelta(seed, ep(1, 1, 8), ep(2, 1, 8));
  assert.deepEqual(next.episodeAgg.bySeason, { "2": { sum: 8, count: 1 } });
  assert.deepEqual(next.series, { avg: 8, seasonCount: 1, episodeCount: 1 });
});
