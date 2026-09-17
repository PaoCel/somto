const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseTvTimeRefractJson,
  parseRefractMoviesJson,
  parseRefractSeriesJson,
  parseRefractDateTime,
} = require("../../lib/importAdapters/tvTimeRefract");

/* ============================= parseRefractDateTime ============================= */

test("parseRefractDateTime accepts ISO8601 with trailing Z (movie/series created_at, movie watched_at)", () => {
  const d = parseRefractDateTime("2026-07-05T19:17:02Z");
  assert.ok(d instanceof Date);
  assert.equal(d.getUTCFullYear(), 2026);
  assert.equal(d.getUTCMonth(), 6);
  assert.equal(d.getUTCDate(), 5);
  assert.equal(d.getUTCHours(), 19);
  assert.equal(d.getUTCMinutes(), 17);
  assert.equal(d.getUTCSeconds(), 2);
});

test("parseRefractDateTime accepts ISO8601 with fractional seconds", () => {
  const d = parseRefractDateTime("2026-07-05T19:17:02.610019Z");
  assert.ok(d instanceof Date);
  assert.equal(d.getUTCSeconds(), 2);
});

test("parseRefractDateTime accepts the space-separated episode watched_at format (no Z, no fraction)", () => {
  const d = parseRefractDateTime("2026-07-05 19:19:41");
  assert.ok(d instanceof Date);
  assert.equal(d.getUTCHours(), 19);
  assert.equal(d.getUTCMinutes(), 19);
  assert.equal(d.getUTCSeconds(), 41);
});

test("parseRefractDateTime rejects malformed input", () => {
  assert.equal(parseRefractDateTime(""), null);
  assert.equal(parseRefractDateTime("not-a-date"), null);
  assert.equal(parseRefractDateTime("2026-13-40T00:00:00Z"), null);
  assert.equal(parseRefractDateTime(null), null);
});

/* ============================= parseRefractMoviesJson ============================= */
// Fixture trimmed from a real "TV Time Out" (Refract) export sample; uuids
// swapped for placeholders (titles/years are public metadata, nothing
// personally identifying survives here).

test("parseRefractMoviesJson: watched movie -> kind movie, tvdbMovieId + releaseYear carried through", () => {
  const json = JSON.stringify([{
    id: { tvdb: 154, imdb: "tt0304141" },
    uuid: "movie-uuid-1",
    created_at: "2026-07-05T19:17:02Z",
    title: "Harry Potter and the Prisoner of Azkaban",
    year: 2004,
    watched_at: "2026-07-05T19:17:02Z",
    is_watched: true,
    is_favorite: false,
    rewatch_count: 0,
  }]);
  const { rows, errors } = parseRefractMoviesJson(json);
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.kind, "movie");
  assert.equal(row.rawTitle, "Harry Potter and the Prisoner of Azkaban");
  assert.equal(row.movieNameGuess, "Harry Potter and the Prisoner of Azkaban");
  assert.equal(row.tvdbMovieId, 154);
  assert.equal(row.releaseYear, 2004);
  assert.equal(row.runtimeMinutes, null);
  assert.equal(row.rewatchCount, null); // 0 normalizes to null (toPositiveIntOrNull)
  assert.equal(row.watchlistOnly, undefined);
  assert.ok(row.watchedDate instanceof Date);
});

test("parseRefractMoviesJson: unwatched movie -> watchlistOnly:true, dated by created_at (no watched_at)", () => {
  const json = JSON.stringify([{
    id: { tvdb: 361964, imdb: "tt32278481" },
    uuid: "movie-uuid-2",
    created_at: "2026-07-05T19:17:02Z",
    title: "Enola Holmes 3",
    year: 2026,
    watched_at: null,
    is_watched: false,
    is_favorite: false,
    rewatch_count: 0,
  }]);
  const { rows, errors } = parseRefractMoviesJson(json);
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].watchlistOnly, true);
  assert.equal(rows[0].watchedDate.getUTCFullYear(), 2026);
});

test("parseRefractMoviesJson: rewatch_count > 0 is carried through as a positive int", () => {
  const json = JSON.stringify([{
    id: { tvdb: 115 },
    title: "Deadpool",
    year: 2016,
    watched_at: "2026-07-05T19:17:02Z",
    is_watched: true,
    rewatch_count: 3,
  }]);
  const { rows } = parseRefractMoviesJson(json);
  assert.equal(rows[0].rewatchCount, 3);
});

test("parseRefractMoviesJson: missing/null tvdb id is not an error — row still emitted, id null", () => {
  const json = JSON.stringify([{
    id: { tvdb: null, imdb: null },
    title: "Some Obscure Movie",
    year: 2020,
    watched_at: "2026-07-05T19:17:02Z",
    is_watched: true,
  }]);
  const { rows, errors } = parseRefractMoviesJson(json);
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tvdbMovieId, null);
});

test("parseRefractMoviesJson: missing title is an explicit error, not a silent skip", () => {
  const json = JSON.stringify([{ id: { tvdb: 1 }, title: "", is_watched: true }]);
  const { rows, errors } = parseRefractMoviesJson(json);
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /Titolo film mancante/);
});

test("parseRefractMoviesJson: invalid date is an explicit error", () => {
  const json = JSON.stringify([{ title: "X", is_watched: true, watched_at: "not-a-date", created_at: "also-not" }]);
  const { rows, errors } = parseRefractMoviesJson(json);
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /Data non valida/);
});

test("parseRefractMoviesJson: malformed JSON (parse failure) surfaces one file-level error", () => {
  const { rows, errors } = parseRefractMoviesJson("{not valid json");
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /non valido/);
});

test("parseRefractMoviesJson: valid JSON that isn't an array surfaces one file-level error", () => {
  const { rows, errors } = parseRefractMoviesJson(JSON.stringify({ oops: true }));
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /atteso un array/);
});

test("parseRefractMoviesJson: empty string input -> zero rows, zero errors (treated as empty array)", () => {
  const { rows, errors } = parseRefractMoviesJson("");
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 0);
});

/* ============================= parseRefractSeriesJson ============================= */

const FROM_SERIES = {
  uuid: "series-uuid-1",
  id: { tvdb: 401003, imdb: null },
  created_at: "2026-07-05T19:17:02Z",
  title: "FROM",
  status: "continuing",
  is_favorite: true,
  _noEpisodeData: false,
  seasons: [
    {
      number: 1,
      is_specials: false,
      episodes: [
        { id: { tvdb: 8808273 }, number: 1, name: "Ep 1", special: false, is_watched: true, watched_at: "2026-07-05 19:19:41", rewatch_count: 0, watched_count: 1 },
        { id: { tvdb: 8808282 }, number: 2, name: "Ep 2", special: false, is_watched: true, watched_at: "2026-07-05 19:19:53", rewatch_count: 0, watched_count: 1 },
        { id: { tvdb: 8808290 }, number: 3, name: "Ep 3", special: false, is_watched: false, watched_at: null, rewatch_count: 0, watched_count: 0 },
      ],
    },
  ],
};

test("parseRefractSeriesJson: watched episodes -> one tv_episode row each, with tvdbSeriesId + season/episode numbers", () => {
  const { rows, errors } = parseRefractSeriesJson(JSON.stringify([FROM_SERIES]));
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 2); // only the 2 watched episodes, not the 3rd unwatched
  assert.equal(rows[0].kind, "tv_episode");
  assert.equal(rows[0].seriesNameGuess, "FROM");
  assert.equal(rows[0].tvdbSeriesId, 401003);
  assert.equal(rows[0].seasonNumber, 1);
  assert.equal(rows[0].episodeNumber, 1);
  assert.equal(rows[1].episodeNumber, 2);
});

test("parseRefractSeriesJson: per-episode rewatch_count/watched_count are carried onto the row (series rewatch signal)", () => {
  const series = {
    title: "Teen Wolf",
    id: { tvdb: 259493 },
    seasons: [{
      number: 1,
      episodes: [
        { number: 1, is_watched: true, watched_at: "2026-07-05 10:00:00", rewatch_count: 1, watched_count: 2 },
        { number: 2, is_watched: true, watched_at: "2026-07-05 11:00:00", rewatch_count: 0, watched_count: 1 },
      ],
    }],
  };
  const { rows, errors } = parseRefractSeriesJson(JSON.stringify([series]));
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].watchedCount, 2);
  assert.equal(rows[0].rewatchCount, 1);
  assert.equal(rows[1].watchedCount, 1);
  assert.equal(rows[1].rewatchCount, null); // 0 normalizes to null (toPositiveIntOrNull)
});

test("parseRefractSeriesJson: season 0 (specials) is preserved verbatim — matches TMDB's own convention", () => {
  const series = {
    title: "The Simpsons",
    id: { tvdb: 71663 },
    seasons: [{
      number: 0,
      is_specials: true,
      episodes: [{ number: 1, is_watched: true, watched_at: "2026-07-05 10:00:00" }],
    }],
  };
  const { rows, errors } = parseRefractSeriesJson(JSON.stringify([series]));
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].seasonNumber, 0);
});

test("parseRefractSeriesJson: zero watched episodes anywhere -> single watchlistOnly row for the whole series", () => {
  const series = {
    title: "The Simpsons",
    id: { tvdb: 71663 },
    created_at: "2026-07-05T19:17:02Z",
    seasons: [{
      number: 0,
      is_specials: true,
      episodes: [{ number: 1, is_watched: false, watched_at: null }],
    }],
  };
  const { rows, errors } = parseRefractSeriesJson(JSON.stringify([series]));
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].watchlistOnly, true);
  assert.equal(rows[0].seasonNumber, null);
  assert.equal(rows[0].episodeNumber, null);
  assert.equal(rows[0].tvdbSeriesId, 71663);
});

test("parseRefractSeriesJson: _noEpisodeData:true with empty seasons -> same watchlistOnly fallback, no crash", () => {
  const series = {
    title: "Dutton Ranch",
    id: { tvdb: 463308 },
    created_at: "2026-07-05T19:17:02Z",
    _noEpisodeData: true,
    seasons: [],
  };
  const { rows, errors } = parseRefractSeriesJson(JSON.stringify([series]));
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].watchlistOnly, true);
});

test("parseRefractSeriesJson: watched episode missing a valid episode number is an explicit error; the series still falls back to a watchlistOnly row (never silently dropped)", () => {
  const series = {
    title: "Weird Show",
    created_at: "2026-07-05T19:17:02Z",
    seasons: [{ number: 1, episodes: [{ number: null, is_watched: true, watched_at: "2026-07-05 10:00:00" }] }],
  };
  const { rows, errors } = parseRefractSeriesJson(JSON.stringify([series]));
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /stagione\/episodio mancante/);
  // watchedEpisodeCount stayed 0 (the only episode failed validation) -> same
  // fallback as a series with zero watched episodes.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].watchlistOnly, true);
});

test("parseRefractSeriesJson: watched episode with an invalid watched_at is an explicit error; the series still falls back to a watchlistOnly row", () => {
  const series = {
    title: "Weird Show",
    created_at: "2026-07-05T19:17:02Z",
    seasons: [{ number: 1, episodes: [{ number: 1, is_watched: true, watched_at: "garbage" }] }],
  };
  const { rows, errors } = parseRefractSeriesJson(JSON.stringify([series]));
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /Data episodio non valida/);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].watchlistOnly, true);
});

test("parseRefractSeriesJson: missing series title is an explicit error", () => {
  const { rows, errors } = parseRefractSeriesJson(JSON.stringify([{ id: { tvdb: 1 }, seasons: [] }]));
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /Titolo serie mancante/);
});

/* ============================= parseTvTimeRefractJson (merge) ============================= */

test("parseTvTimeRefractJson merges movies + series rows and concatenates errors", () => {
  const moviesJson = JSON.stringify([{ title: "", is_watched: true }]); // 1 error
  const seriesJson = JSON.stringify([FROM_SERIES]); // 2 rows
  const { rows, errors } = parseTvTimeRefractJson({ moviesJson, seriesJson });
  assert.equal(rows.length, 2);
  assert.equal(errors.length, 1);
});

test("parseTvTimeRefractJson tolerates missing/undefined JSON strings without throwing", () => {
  const { rows, errors } = parseTvTimeRefractJson({});
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 0);
});

/* ============================= dedup / rewatch integration (writeTitleStates) ============================= */
// These exercise the SAME shared writer the GDPR/Netflix adapters use,
// proving Refract rows flow through it correctly (non-destructive merge:
// re-running an import on top of a further-along state never regresses).

const { buildMovieImportState, buildSeriesImportState } = require("../../lib/importAdapters/writeTitleStates");

test("Refract movie row through buildMovieImportState: rewatch_count signal bumps completedCount like the GDPR adapter's", () => {
  const movie = { id: "m1", type: "movie", name: "Deadpool", meta: { durationMovie: 108 } };
  const { rows } = parseRefractMoviesJson(JSON.stringify([{
    title: "Deadpool", watched_at: "2026-07-05T19:17:02Z", is_watched: true, rewatch_count: 2,
  }]));
  const next = buildMovieImportState(null, movie, rows, { now: new Date() });
  assert.equal(next.completedCount, 3); // 2 rewatches + first viewing
});

test("Refract series rows through buildSeriesImportState: re-import on top of further-along state never regresses (idempotent + non-destructive)", () => {
  const series = { id: "tv1", type: "tv", name: "FROM", meta: { durationEpisode: 45, seasonsCount: 2, episodesPerSeason: 10 } };
  const { rows } = parseRefractSeriesJson(JSON.stringify([FROM_SERIES]));
  const first = buildSeriesImportState(null, series, rows, { now: new Date() });
  assert.equal(first.seriesProgress.episodesWatchedCount, 2);

  // Simulate the user having ALREADY advanced further on Somto (manually)
  // before re-running the same Refract import — re-import must not regress.
  const ahead = { ...first, seriesProgress: { ...first.seriesProgress, episodesWatchedCount: 15, seasonsCompletedCount: 1 } };
  const second = buildSeriesImportState(ahead, series, rows, { now: new Date() });
  assert.equal(second.seriesProgress.episodesWatchedCount, 15); // max(existing, derived), never regressed
});
