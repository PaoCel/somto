const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveTraktRatingWrites, makeRatingId } = require("../../lib/importAdapters/traktRatingsWriter");

const NOW = "SERVER_TS"; // stand-in for a Firestore FieldValue in the payload

/* ============================= makeRatingId ============================= */

test("makeRatingId matches the client id scheme (uid__titleId__level__season__episode)", () => {
  assert.equal(
    makeRatingId({ uid: "alice", titleId: "tmdb_movie_1", level: "title" }),
    "alice__tmdb_movie_1__title__0__0"
  );
  assert.equal(
    makeRatingId({ uid: "alice", titleId: "tmdb_tv_2", level: "episode", season: 1, episode: 3 }),
    "alice__tmdb_tv_2__episode__1__3"
  );
});

/* ============================= resolveTraktRatingWrites ============================= */

test("resolves title-level movie/show ratings via the tmdbId->titleId map", () => {
  const map = new Map([[157336, "tmdb_movie_157336"], [1396, "tmdb_tv_1396"]]);
  const intents = [
    { level: "title", tmdbId: 157336, rating: 9, ratedAt: "2026-01-01" },
    { level: "title", tmdbId: 1396, rating: 8, ratedAt: "2026-01-02" },
  ];
  const { writes, unresolvedCount } = resolveTraktRatingWrites({ uid: "alice", intents, tmdbToTitleId: map, now: NOW });
  assert.equal(unresolvedCount, 0);
  assert.equal(writes.length, 2);
  const byTitle = Object.fromEntries(writes.map((w) => [w.titleId, w]));
  assert.equal(byTitle["tmdb_movie_157336"].ratingId, "alice__tmdb_movie_157336__title__0__0");
  assert.equal(byTitle["tmdb_movie_157336"].payload.rating, 9);
  assert.equal(byTitle["tmdb_movie_157336"].payload.source, "import_trakt");
  assert.equal(byTitle["tmdb_movie_157336"].payload.level, "title");
  assert.equal(byTitle["tmdb_movie_157336"].payload.season, null);
  assert.equal(byTitle["tmdb_movie_157336"].payload.episode, null);
});

test("resolves season/episode-level ratings anchored on the show titleId", () => {
  const map = new Map([[1396, "tmdb_tv_1396"]]);
  const intents = [
    { level: "season", tmdbId: 1396, season: 2, rating: 10, ratedAt: "2026-01-03" },
    { level: "episode", tmdbId: 1396, season: 1, episode: 3, rating: 7, ratedAt: "2026-01-04" },
  ];
  const { writes } = resolveTraktRatingWrites({ uid: "alice", intents, tmdbToTitleId: map, now: NOW });
  const bySeason = writes.find((w) => w.payload.level === "season");
  const byEpisode = writes.find((w) => w.payload.level === "episode");
  assert.equal(bySeason.ratingId, "alice__tmdb_tv_1396__season__2__0");
  assert.equal(bySeason.payload.season, 2);
  assert.equal(bySeason.payload.episode, null);
  assert.equal(byEpisode.ratingId, "alice__tmdb_tv_1396__episode__1__3");
  assert.equal(byEpisode.payload.season, 1);
  assert.equal(byEpisode.payload.episode, 3);
});

test("intents whose tmdbId has no titleId are returned as unresolved (not dropped, not guessed)", () => {
  const map = new Map([[1396, "tmdb_tv_1396"]]);
  const intents = [
    { level: "title", tmdbId: 1396, rating: 8 },      // resolved
    { level: "title", tmdbId: 999999, rating: 6 },    // no title -> unresolved
  ];
  const { writes, unresolvedCount, unresolved } = resolveTraktRatingWrites({ uid: "alice", intents, tmdbToTitleId: map, now: NOW });
  assert.equal(writes.length, 1);
  assert.equal(unresolvedCount, 1);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].tmdbId, 999999);
});

test("accepts a plain object map with string keys (normalizes to numeric tmdbId)", () => {
  const intents = [{ level: "title", tmdbId: 157336, rating: 9 }];
  const { writes } = resolveTraktRatingWrites({ uid: "alice", intents, tmdbToTitleId: { "157336": "tmdb_movie_157336" }, now: NOW });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].titleId, "tmdb_movie_157336");
});

test("skips intents with an invalid tmdbId", () => {
  const map = new Map([[1, "tmdb_movie_1"]]);
  const intents = [
    { level: "title", tmdbId: 0, rating: 8 },
    { level: "title", tmdbId: -5, rating: 8 },
    { level: "title", tmdbId: "abc", rating: 8 },
    { level: "title", tmdbId: 1, rating: 8 },
  ];
  const { writes } = resolveTraktRatingWrites({ uid: "alice", intents, tmdbToTitleId: map, now: NOW });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].titleId, "tmdb_movie_1");
});

test("tolerates empty/undefined intents", () => {
  const r = resolveTraktRatingWrites({ uid: "alice", intents: undefined, tmdbToTitleId: new Map(), now: NOW });
  assert.deepEqual(r, { writes: [], unresolvedCount: 0, unresolved: [] });
});
