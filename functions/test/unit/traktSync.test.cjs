const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildTraktImportBlob,
  parseTraktBlob,
  buildTraktRatingIntents,
  dayNoonUTC,
} = require("../../lib/importAdapters/traktSync");

/* ============================= dayNoonUTC ============================= */

test("dayNoonUTC parses an ISO timestamp to noon UTC of that calendar day", () => {
  const d = dayNoonUTC("2026-07-05T18:47:38.000Z");
  assert.ok(d instanceof Date);
  assert.equal(d.getUTCFullYear(), 2026);
  assert.equal(d.getUTCMonth(), 6); // July
  assert.equal(d.getUTCDate(), 5);
  assert.equal(d.getUTCHours(), 12);
});

test("dayNoonUTC rejects missing/invalid input", () => {
  assert.equal(dayNoonUTC(""), null);
  assert.equal(dayNoonUTC(null), null);
  assert.equal(dayNoonUTC("not-a-date"), null);
});

/* ============================= buildTraktImportBlob ============================= */

test("buildTraktImportBlob drops entries with no ids.tmdb", () => {
  const library = {
    watchedMovies: [
      { last_watched_at: "2026-01-01T00:00:00Z", movie: { title: "Has Tmdb", year: 2014, ids: { tmdb: 157336 } } },
      { last_watched_at: "2026-01-02T00:00:00Z", movie: { title: "No Tmdb", year: 2010, ids: { imdb: "tt0000000" } } },
    ],
    historyEpisodes: [],
    ratings: { movies: [], shows: [], seasons: [], episodes: [] },
    watchlist: { movies: [], shows: [] },
  };
  const blob = buildTraktImportBlob(library);
  assert.equal(blob.version, 1);
  assert.equal(blob.watched.length, 1);
  assert.equal(blob.watched[0].tmdbId, 157336);
  assert.equal(blob.watched[0].title, "Has Tmdb");
  assert.equal(blob.watched[0].year, 2014);
});

test("buildTraktImportBlob builds shows from history episodes: dedupes distinct episodes keeping earliest date, drops season 0 / no ep number / no show tmdb", () => {
  const bb = (season, number, watched_at, ids = { tmdb: 1396 }, title = "Breaking Bad") =>
    ({ watched_at, type: "episode", episode: { season, number }, show: { title, year: 2008, ids } });
  const library = {
    watchedMovies: [],
    historyEpisodes: [
      bb(0, 1, "2026-03-01T00:00:00Z"), // specials -> dropped
      bb(1, 1, "2026-03-05T00:00:00Z"),
      bb(1, 2, "2026-03-06T00:00:00Z"),
      bb(1, null, "2026-03-07T00:00:00Z"), // no ep number -> dropped
      bb(1, 1, "2026-04-01T00:00:00Z"), // rewatch of S1E1 later -> deduped, earliest kept
      bb(1, 5, "2026-03-08T00:00:00Z", { imdb: "tt0" }), // no show tmdb -> dropped
    ],
    ratings: { movies: [], shows: [], seasons: [], episodes: [] },
    watchlist: { movies: [], shows: [] },
  };
  const blob = buildTraktImportBlob(library);
  assert.equal(blob.watched.length, 1);
  const show = blob.watched[0];
  assert.equal(show.kind, "show");
  assert.equal(show.tmdbId, 1396);
  assert.equal(show.seasons.length, 1); // season 0 dropped
  assert.equal(show.seasons[0].n, 1);
  assert.equal(show.seasons[0].episodes.length, 2); // distinct S1E1 + S1E2 (null-numbered + rewatch collapsed)
  const ep1 = show.seasons[0].episodes.find((e) => e.n === 1);
  assert.equal(ep1.lastWatchedAt, "2026-03-05T00:00:00Z"); // earliest of the two S1E1 watches
});

test("buildTraktImportBlob extracts ratings for all 4 levels anchored on the show tmdb id", () => {
  const library = {
    watchedMovies: [],
    historyEpisodes: [],
    ratings: {
      movies: [{ rated_at: "2026-01-01T00:00:00Z", rating: 9, type: "movie", movie: { year: 2014, ids: { tmdb: 157336 } } }],
      shows: [{ rated_at: "2026-01-02T00:00:00Z", rating: 8, type: "show", show: { ids: { tmdb: 1396 } } }],
      seasons: [{ rated_at: "2026-01-03T00:00:00Z", rating: 10, type: "season", season: { number: 2 }, show: { ids: { tmdb: 1396 } } }],
      episodes: [{ rated_at: "2026-01-04T00:00:00Z", rating: 7, type: "episode", episode: { season: 1, number: 3 }, show: { ids: { tmdb: 1396 } } }],
    },
    watchlist: { movies: [], shows: [] },
  };
  const blob = buildTraktImportBlob(library);
  assert.equal(blob.ratings.length, 4);
  const byType = Object.fromEntries(blob.ratings.map((r) => [r.type, r]));
  assert.equal(byType.movie.tmdbId, 157336);
  assert.equal(byType.movie.rating, 9);
  assert.equal(byType.show.tmdbId, 1396);
  assert.equal(byType.season.season, 2);
  assert.equal(byType.season.tmdbId, 1396);
  assert.equal(byType.episode.season, 1);
  assert.equal(byType.episode.episode, 3);
  assert.equal(byType.episode.tmdbId, 1396);
});

test("buildTraktImportBlob tolerates a completely empty/undefined library", () => {
  const blob = buildTraktImportBlob(undefined);
  assert.deepEqual(blob, { version: 1, watched: [], ratings: [], watchlist: [] });
});

/* ============================= parseTraktBlob: movies ============================= */

test("parseTraktBlob: watched movie -> movie row with tmdbId + releaseYear + watchedDate", () => {
  const blob = { version: 1, watched: [{ kind: "movie", tmdbId: 157336, title: "Interstellar", year: 2014, lastWatchedAt: "2026-01-15T00:00:00Z" }], ratings: [], watchlist: [] };
  const { rows, errors } = parseTraktBlob(blob);
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.kind, "movie");
  assert.equal(row.movieNameGuess, "Interstellar");
  assert.equal(row.tmdbId, 157336);
  assert.equal(row.mediaTypeHint, "movie");
  assert.equal(row.releaseYear, 2014);
  assert.ok(row.watchedDate instanceof Date);
  assert.equal(row.watchedDate.getUTCHours(), 12);
});

test("parseTraktBlob: watched movie with a bad date is an error, not a crash", () => {
  const blob = { version: 1, watched: [{ kind: "movie", tmdbId: 1, title: "Bad", year: 2000, lastWatchedAt: "garbage" }], ratings: [], watchlist: [] };
  const { rows, errors } = parseTraktBlob(blob);
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /film/i);
});

/* ============================= parseTraktBlob: shows (per-episode) ============================= */

test("parseTraktBlob: watched show -> ONE ROW PER WATCHED EPISODE", () => {
  const blob = {
    version: 1,
    watched: [{
      kind: "show", tmdbId: 1396, title: "Breaking Bad", year: 2008, lastWatchedAt: "2026-03-10T00:00:00Z",
      seasons: [
        { n: 1, episodes: [{ n: 1, lastWatchedAt: "2026-03-01T00:00:00Z" }, { n: 2, lastWatchedAt: "2026-03-02T00:00:00Z" }] },
        { n: 2, episodes: [{ n: 1, lastWatchedAt: "2026-03-05T00:00:00Z" }] },
      ],
    }],
    ratings: [], watchlist: [],
  };
  const { rows, errors } = parseTraktBlob(blob);
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.kind, "tv_episode");
    assert.equal(row.seriesNameGuess, "Breaking Bad");
    assert.equal(row.tmdbId, 1396);
    assert.equal(row.mediaTypeHint, "tv");
  }
  const keys = rows.map((r) => `${r.seasonNumber}x${r.episodeNumber}`).sort();
  assert.deepEqual(keys, ["1x1", "1x2", "2x1"]);
});

test("parseTraktBlob: episode with no per-episode date falls back to the show lastWatchedAt", () => {
  const blob = {
    version: 1,
    watched: [{
      kind: "show", tmdbId: 1396, title: "Show", year: 2008, lastWatchedAt: "2026-03-10T00:00:00Z",
      seasons: [{ n: 1, episodes: [{ n: 1, lastWatchedAt: null }] }],
    }],
    ratings: [], watchlist: [],
  };
  const { rows, errors } = parseTraktBlob(blob);
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].watchedDate.getUTCDate(), 10);
});

/* ============================= parseTraktBlob: watchlist ============================= */

test("parseTraktBlob: watchlist movie + show -> watchlistOnly rows", () => {
  const blob = {
    version: 1,
    watched: [],
    ratings: [],
    watchlist: [
      { kind: "movie", tmdbId: 100, title: "WL Movie", year: 2020, listedAt: "2026-06-01T00:00:00Z" },
      { kind: "show", tmdbId: 200, title: "WL Show", year: 2021, listedAt: "2026-06-02T00:00:00Z" },
    ],
  };
  const { rows, errors } = parseTraktBlob(blob);
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 2);
  const movie = rows.find((r) => r.tmdbId === 100);
  const show = rows.find((r) => r.tmdbId === 200);
  assert.equal(movie.kind, "movie");
  assert.equal(movie.watchlistOnly, true);
  assert.equal(show.kind, "tv_episode");
  assert.equal(show.watchlistOnly, true);
  assert.equal(show.seasonNumber, null);
});

/* ============================= parseTraktBlob: determinism ============================= */

test("parseTraktBlob produces a deterministic row order across shuffled input (critical for the resumable cursor)", () => {
  const makeBlob = (watched) => ({ version: 1, watched, ratings: [], watchlist: [] });
  const showA = { kind: "show", tmdbId: 20, title: "A", year: 2000, lastWatchedAt: "2026-01-01T00:00:00Z", seasons: [{ n: 1, episodes: [{ n: 2, lastWatchedAt: "2026-01-02T00:00:00Z" }, { n: 1, lastWatchedAt: "2026-01-01T00:00:00Z" }] }] };
  const movieB = { kind: "movie", tmdbId: 5, title: "B", year: 1999, lastWatchedAt: "2026-01-03T00:00:00Z" };
  const showC = { kind: "show", tmdbId: 10, title: "C", year: 2010, lastWatchedAt: "2026-01-04T00:00:00Z", seasons: [{ n: 2, episodes: [{ n: 1, lastWatchedAt: "2026-01-05T00:00:00Z" }] }] };

  const order1 = parseTraktBlob(makeBlob([showA, movieB, showC])).rows.map((r) => `${r.kind}:${r.tmdbId}:${r.seasonNumber}:${r.episodeNumber}`);
  const order2 = parseTraktBlob(makeBlob([showC, showA, movieB])).rows.map((r) => `${r.kind}:${r.tmdbId}:${r.seasonNumber}:${r.episodeNumber}`);
  const order3 = parseTraktBlob(makeBlob([movieB, showC, showA])).rows.map((r) => `${r.kind}:${r.tmdbId}:${r.seasonNumber}:${r.episodeNumber}`);
  assert.deepEqual(order1, order2);
  assert.deepEqual(order2, order3);
});

test("parseTraktBlob tolerates an empty/undefined blob", () => {
  assert.deepEqual(parseTraktBlob(undefined), { rows: [], errors: [] });
  assert.deepEqual(parseTraktBlob({}), { rows: [], errors: [] });
});

/* ============================= buildTraktRatingIntents ============================= */

test("buildTraktRatingIntents maps the 4 levels and passes 1..10 through unchanged", () => {
  const blob = {
    version: 1, watched: [], watchlist: [],
    ratings: [
      { type: "movie", tmdbId: 157336, rating: 9, ratedAt: "2026-01-01T00:00:00Z" },
      { type: "show", tmdbId: 1396, rating: 8, ratedAt: "2026-01-02T00:00:00Z" },
      { type: "season", tmdbId: 1396, season: 2, rating: 10, ratedAt: "2026-01-03T00:00:00Z" },
      { type: "episode", tmdbId: 1396, season: 1, episode: 3, rating: 7, ratedAt: "2026-01-04T00:00:00Z" },
    ],
  };
  const intents = buildTraktRatingIntents(blob);
  assert.equal(intents.length, 4);
  const byLevel = {};
  for (const i of intents) byLevel[`${i.level}:${i.tmdbId}:${i.season || 0}:${i.episode || 0}`] = i;
  assert.equal(byLevel["title:157336:0:0"].rating, 9);
  assert.equal(byLevel["title:1396:0:0"].rating, 8); // show -> title level
  assert.equal(byLevel["season:1396:2:0"].rating, 10);
  assert.equal(byLevel["episode:1396:1:3"].rating, 7);
});

test("buildTraktRatingIntents drops out-of-range / non-integer ratings (defensive re-clamp)", () => {
  const blob = {
    version: 1, watched: [], watchlist: [],
    ratings: [
      { type: "movie", tmdbId: 1, rating: 11 },   // out of range high
      { type: "movie", tmdbId: 2, rating: 0 },    // out of range low
      { type: "movie", tmdbId: 3, rating: 7.5 },  // non-integer
      { type: "movie", tmdbId: 4, rating: 6 },    // valid
    ],
  };
  const intents = buildTraktRatingIntents(blob);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].tmdbId, 4);
  assert.equal(intents[0].rating, 6);
});

test("buildTraktRatingIntents drops season/episode intents missing their number", () => {
  const blob = {
    version: 1, watched: [], watchlist: [],
    ratings: [
      { type: "season", tmdbId: 1, rating: 8 },                 // no season number
      { type: "episode", tmdbId: 1, season: 1, rating: 8 },     // no episode number
      { type: "episode", tmdbId: 1, season: 1, episode: 2, rating: 8 }, // valid
    ],
  };
  const intents = buildTraktRatingIntents(blob);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].level, "episode");
  assert.equal(intents[0].episode, 2);
});

test("buildTraktRatingIntents tolerates an empty/undefined blob", () => {
  assert.deepEqual(buildTraktRatingIntents(undefined), []);
  assert.deepEqual(buildTraktRatingIntents({ ratings: [] }), []);
});
