const test = require("node:test");
const assert = require("node:assert/strict");

const {
  makeRatingId,
  buildTitleResolutionMap,
  resolveRatingWrites,
} = require("../../lib/importAdapters/tvTimeRatingsWriter");

/* ============================= makeRatingId ============================= */

test("makeRatingId mirrors the client's id scheme (ratings.api.js#makeRatingId)", () => {
  // Same shape as the PWA client: uid__titleId__level__season__episode,
  // season/episode default to "0" when null (safePart(season ?? 0)).
  assert.equal(
    makeRatingId({ uid: "u1", titleId: "t1", level: "title" }),
    "u1__t1__title__0__0"
  );
  assert.equal(
    makeRatingId({ uid: "u1", titleId: "t1", level: "episode", season: 1, episode: 3 }),
    "u1__t1__episode__1__3"
  );
});

test("makeRatingId sanitizes unsafe characters the same way as the client", () => {
  const id = makeRatingId({ uid: "u/1", titleId: "t 1", level: "title" });
  assert.doesNotMatch(id, /[/ ]/);
});

/* ============================= buildTitleResolutionMap ============================= */

test("buildTitleResolutionMap indexes resolved movie and tv_episode rows by normalized name(+season+episode)", () => {
  const matchResults = [
    { row: { kind: "movie", movieNameGuess: "Supergirl" }, match: { resolved: true, titleId: "tmdb_movie_1" } },
    { row: { kind: "tv_episode", seriesNameGuess: "The Simpsons", seasonNumber: 1, episodeNumber: 1 }, match: { resolved: true, titleId: "tmdb_tv_1" } },
    { row: { kind: "movie", movieNameGuess: "Unresolved Movie" }, match: { resolved: false, titleId: null } },
  ];
  const map = buildTitleResolutionMap(matchResults);
  assert.equal(map.get("movie|supergirl"), "tmdb_movie_1");
  assert.equal(map.get("tv|the simpsons|1|1"), "tmdb_tv_1");
  assert.equal(map.has("movie|unresolved movie"), false);
});

test("buildTitleResolutionMap normalizes case/whitespace so lookups aren't case-sensitive", () => {
  const matchResults = [
    { row: { kind: "movie", movieNameGuess: "  SUPERGIRL  " }, match: { resolved: true, titleId: "tmdb_movie_1" } },
  ];
  const map = buildTitleResolutionMap(matchResults);
  assert.equal(map.get("movie|supergirl"), "tmdb_movie_1");
});

/* ============================= resolveRatingWrites ============================= */

const NOW = new Date("2026-07-05T12:00:00Z");

test("resolveRatingWrites: movie intent resolves to a level=title rating with the exact makeRatingId scheme", () => {
  const intents = [{ kind: "movie", movieNameGuess: "Supergirl", decimalRating: 7, reviewText: "top", containsSpoiler: false }];
  const titleResolutionMap = new Map([["movie|supergirl", "tmdb_movie_1"]]);
  const { writes, unresolvedCount } = resolveRatingWrites({ uid: "u1", intents, titleResolutionMap, now: NOW });
  assert.equal(unresolvedCount, 0);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].ratingId, "u1__tmdb_movie_1__title__0__0");
  assert.equal(writes[0].payload.uid, "u1");
  assert.equal(writes[0].payload.titleId, "tmdb_movie_1");
  assert.equal(writes[0].payload.level, "title");
  assert.equal(writes[0].payload.season, null);
  assert.equal(writes[0].payload.episode, null);
  assert.equal(writes[0].payload.rating, 7);
  assert.equal(writes[0].payload.reviewText, "top");
  assert.equal(writes[0].payload.source, "import_tvtime_gdpr");
  assert.equal("containsSpoiler" in writes[0].payload, false); // omitted entirely when false
});

test("resolveRatingWrites: tv_episode intent resolves to a level=episode rating with season/episode set", () => {
  const intents = [{ kind: "tv_episode", seriesNameGuess: "The Simpsons", seasonNumber: 1, episodeNumber: 1, decimalRating: 7, reviewText: null, containsSpoiler: false }];
  const titleResolutionMap = new Map([["tv|the simpsons|1|1", "tmdb_tv_1"]]);
  const { writes } = resolveRatingWrites({ uid: "u1", intents, titleResolutionMap, now: NOW });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].ratingId, "u1__tmdb_tv_1__episode__1__1");
  assert.equal(writes[0].payload.level, "episode");
  assert.equal(writes[0].payload.season, 1);
  assert.equal(writes[0].payload.episode, 1);
  assert.equal("reviewText" in writes[0].payload, false); // null reviewText omitted, not written as null
});

test("resolveRatingWrites: containsSpoiler:true sets spoilerTitleIds to [titleId]", () => {
  const intents = [{ kind: "movie", movieNameGuess: "SpoilerMovie", decimalRating: 10, reviewText: "il finale...", containsSpoiler: true }];
  const titleResolutionMap = new Map([["movie|spoilermovie", "tmdb_movie_2"]]);
  const { writes } = resolveRatingWrites({ uid: "u1", intents, titleResolutionMap, now: NOW });
  assert.equal(writes[0].payload.containsSpoiler, true);
  assert.deepEqual(writes[0].payload.spoilerTitleIds, ["tmdb_movie_2"]);
});

test("resolveRatingWrites: an intent whose name never matched a titleId is counted as unresolved, not dropped silently", () => {
  const intents = [{ kind: "movie", movieNameGuess: "Never Matched", decimalRating: 5, reviewText: null, containsSpoiler: false }];
  const { writes, unresolvedCount } = resolveRatingWrites({ uid: "u1", intents, titleResolutionMap: new Map(), now: NOW });
  assert.equal(writes.length, 0);
  assert.equal(unresolvedCount, 1);
});

test("resolveRatingWrites: reviewText is capped at 5000 chars (mirrors validRatingReviewFields)", () => {
  const longText = "a".repeat(6000);
  const intents = [{ kind: "movie", movieNameGuess: "LongReview", decimalRating: 8, reviewText: longText, containsSpoiler: false }];
  const titleResolutionMap = new Map([["movie|longreview", "tmdb_movie_3"]]);
  const { writes } = resolveRatingWrites({ uid: "u1", intents, titleResolutionMap, now: NOW });
  assert.equal(writes[0].payload.reviewText.length, 5000);
});

test("resolveRatingWrites: rating value passes through unchanged (already converted by tvTimeRatings.js's calibrated map)", () => {
  const intents = [
    { kind: "movie", movieNameGuess: "A", decimalRating: 4, reviewText: null, containsSpoiler: false },
    { kind: "movie", movieNameGuess: "B", decimalRating: 10, reviewText: null, containsSpoiler: false },
  ];
  const titleResolutionMap = new Map([["movie|a", "t_a"], ["movie|b", "t_b"]]);
  const { writes } = resolveRatingWrites({ uid: "u1", intents, titleResolutionMap, now: NOW });
  assert.equal(writes.find((w) => w.titleId === "t_a").payload.rating, 4);
  assert.equal(writes.find((w) => w.titleId === "t_b").payload.rating, 10);
});
