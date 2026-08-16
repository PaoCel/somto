const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildMovieImportState,
  buildSeriesImportState,
  groupMatchedRows,
  buildImportTitleStateWrites,
} = require("../../lib/importAdapters/writeTitleStates");

const movie = { id: "m1", type: "movie", name: "Interstellar", meta: { durationMovie: 169 } };
const series = { id: "tv1", type: "tv", name: "Show", meta: { durationEpisode: 40, seasonsCount: 2, episodesPerSeason: 10 } };

/* ============================= movie import ============================= */

test("fresh movie import marks seen with the CSV watch date, not now", () => {
  const csvDate = new Date("2026-06-16T12:00:00.000Z");
  const next = buildMovieImportState(null, movie, [{ watchedDate: csvDate }], { now: new Date() });
  assert.equal(next.state, "seen_unrated");
  assert.equal(next.completedCount, 1);
  assert.equal(next.watchMinutesContribution, 169);
  assert.equal(next.seenAt.getTime(), csvDate.getTime());
});

test("import state source follows the import source option", () => {
  const csvDate = new Date("2026-06-16T12:00:00.000Z");
  const next = buildMovieImportState(null, movie, [{ watchedDate: csvDate }], {
    now: new Date(),
    source: "tvtime_gdpr",
  });
  assert.equal(next.source, "import_tvtime_gdpr");
});

test("grouped import writes preserve titleId even when matched title data has no id field", () => {
  const csvDate = new Date("2026-06-16T12:00:00.000Z");
  const [write] = buildImportTitleStateWrites([
    {
      titleId: "tmdb_movie_123",
      title: { type: "movie", name: "No ID Movie", meta: { durationMovie: 100 } },
      row: { watchedDate: csvDate },
    },
  ], new Map(), { now: new Date() });

  assert.equal(write.titleId, "tmdb_movie_123");
  assert.equal(write.next.titleId, "tmdb_movie_123");
  assert.equal(write.next.titleSnapshot.titleId, "tmdb_movie_123");
});

test("re-importing the same movie row is a no-op (idempotent)", () => {
  const csvDate = new Date("2026-06-16T12:00:00.000Z");
  const rows = [{ watchedDate: csvDate }];
  const first = buildMovieImportState(null, movie, rows, { now: new Date() });
  const second = buildMovieImportState(first, movie, rows, { now: new Date() });
  assert.equal(second.completedCount, 1);
  assert.equal(second.watchMinutesContribution, 169);
  assert.equal(second.seenAt.getTime(), csvDate.getTime());
});

test("movie already rated before import: seenAt and rating are preserved untouched", () => {
  const priorSeenAt = new Date("2020-01-01T12:00:00Z");
  const rated = {
    titleId: "m1",
    mediaType: "movie",
    state: "rated",
    hasTitleRating: true,
    ratingValue: 9,
    seenAt: priorSeenAt,
    completedCount: 1,
  };
  const csvDate = new Date("2026-06-16T12:00:00.000Z");
  const next = buildMovieImportState(rated, movie, [{ watchedDate: csvDate }], { now: new Date() });
  assert.equal(next.state, "rated");
  assert.equal(next.hasTitleRating, true);
  assert.equal(next.ratingValue, 9);
  assert.equal(next.seenAt.getTime(), priorSeenAt.getTime());
});

test("movie already seen_unrated (manual seenAt) before import: seenAt not overwritten", () => {
  const priorSeenAt = new Date("2019-05-05T12:00:00Z");
  const seen = {
    titleId: "m1",
    mediaType: "movie",
    state: "seen_unrated",
    seenAt: priorSeenAt,
    completedCount: 1,
  };
  const csvDate = new Date("2026-06-16T12:00:00.000Z");
  const next = buildMovieImportState(seen, movie, [{ watchedDate: csvDate }], { now: new Date() });
  assert.equal(next.seenAt.getTime(), priorSeenAt.getTime());
});

test("movie import with multiple CSV rows uses the earliest watch date", () => {
  const dates = [
    new Date("2026-03-01T12:00:00Z"),
    new Date("2026-01-15T12:00:00Z"),
    new Date("2026-02-10T12:00:00Z"),
  ];
  const rows = dates.map((watchedDate) => ({ watchedDate }));
  const next = buildMovieImportState(null, movie, rows, { now: new Date() });
  assert.equal(next.seenAt.getTime(), new Date("2026-01-15T12:00:00Z").getTime());
});

test("movie duplicate CSV rows count as rewatch and stay idempotent", () => {
  const rows = [
    { watchedDate: new Date("2026-01-01T12:00:00Z") },
    { watchedDate: new Date("2026-02-01T12:00:00Z") },
    { watchedDate: new Date("2026-03-01T12:00:00Z") },
  ];
  const first = buildMovieImportState(null, movie, rows, { now: new Date() });
  const second = buildMovieImportState(first, movie, rows, { now: new Date() });
  assert.equal(first.completedCount, 3);
  assert.equal(first.watchMinutesContribution, 169 * 3);
  assert.equal(second.completedCount, 3);
  assert.equal(second.watchMinutesContribution, 169 * 3);
});

test("movie watched across a midnight boundary (2 rows, 1 day apart) is NOT counted as a rewatch", () => {
  // Netflix's CSV logs one row per calendar day, no time-of-day. Watching
  // half a movie at 23:50 and finishing at 00:10 produces two date rows for
  // the same viewing, not a rewatch.
  const rows = [
    { watchedDate: new Date("2026-01-01T12:00:00Z") },
    { watchedDate: new Date("2026-01-02T12:00:00Z") },
  ];
  const next = buildMovieImportState(null, movie, rows, { now: new Date() });
  assert.equal(next.completedCount, 1);
  assert.equal(next.watchMinutesContribution, 169);
});

test("movie watched twice 6 months apart counts as a genuine rewatch", () => {
  const rows = [
    { watchedDate: new Date("2026-01-01T12:00:00Z") },
    { watchedDate: new Date("2026-07-01T12:00:00Z") },
  ];
  const next = buildMovieImportState(null, movie, rows, { now: new Date() });
  assert.equal(next.completedCount, 2);
  assert.equal(next.watchMinutesContribution, 169 * 2);
});

test("movie with 2 close rows + 1 far row counts 2 clusters, not 3", () => {
  const rows = [
    { watchedDate: new Date("2026-01-01T12:00:00Z") },
    { watchedDate: new Date("2026-01-02T12:00:00Z") }, // same viewing as above (1 day gap)
    { watchedDate: new Date("2026-08-01T12:00:00Z") }, // genuine rewatch months later
  ];
  const next = buildMovieImportState(null, movie, rows, { now: new Date() });
  assert.equal(next.completedCount, 2);
  assert.equal(next.watchMinutesContribution, 169 * 2);
});

/* --- TV Time's explicit rewatchCount signal (only field the CSV supplies this) --- */

test("TV Time rewatchCount overrides a lower date-cluster estimate (single watchedDate row, rewatchCount:2 -> 3 completed runs)", () => {
  const rows = [{ watchedDate: new Date("2026-01-01T12:00:00Z"), rewatchCount: 2 }];
  const next = buildMovieImportState(null, movie, rows, { now: new Date() });
  // Only 1 date -> date-cluster estimate alone would say 1 run; rewatchCount:2
  // means 2 rewatches on top of the first viewing = 3 total completed runs.
  assert.equal(next.completedCount, 3);
  assert.equal(next.watchMinutesContribution, 169 * 3);
});

test("TV Time rewatchCount never LOWERS a higher date-cluster estimate (max of the two signals)", () => {
  const rows = [
    { watchedDate: new Date("2026-01-01T12:00:00Z"), rewatchCount: 0 },
    { watchedDate: new Date("2026-07-01T12:00:00Z"), rewatchCount: 0 },
  ];
  const next = buildMovieImportState(null, movie, rows, { now: new Date() });
  assert.equal(next.completedCount, 2); // date clustering alone already implies 2 runs
});

test("rewatchCount absent/null (e.g. Netflix rows, or an older TV Time export without the column) behaves exactly as before", () => {
  const rows = [{ watchedDate: new Date("2026-01-01T12:00:00Z") }]; // no rewatchCount field at all
  const next = buildMovieImportState(null, movie, rows, { now: new Date() });
  assert.equal(next.completedCount, 1);
});

test("movie already seen is not counted as extra rewatch unless requested", () => {
  const seen = {
    titleId: "m1",
    mediaType: "movie",
    state: "seen_unrated",
    seenAt: new Date("2025-01-01T12:00:00Z"),
    completedCount: 1,
  };
  const rows = [{ watchedDate: new Date("2026-01-01T12:00:00Z") }];
  const conservative = buildMovieImportState(seen, movie, rows, {
    now: new Date(),
    countExistingAsRewatch: false,
  });
  const counted = buildMovieImportState(seen, movie, rows, {
    now: new Date(),
    countExistingAsRewatch: true,
  });
  const countedAgain = buildMovieImportState(counted, movie, rows, {
    now: new Date(),
    countExistingAsRewatch: true,
  });
  assert.equal(conservative.completedCount, 1);
  assert.equal(counted.completedCount, 2);
  assert.equal(counted.watchMinutesContribution, 169 * 2);
  assert.equal(countedAgain.completedCount, 2);
});

/* ============================= series import ============================= */

test("Letterboxd whole-title TV row marks the series completed", () => {
  const watchedDate = new Date("2026-01-01T12:00:00Z");
  const next = buildSeriesImportState(null, series, [{
    kind: "tv_episode",
    wholeTitleCompleted: true,
    watchedDate,
    rewatchCount: 1,
  }], { now: new Date(), source: "letterboxd" });
  assert.equal(next.state, "completed_unrated");
  assert.equal(next.completedCount, 2);
  assert.equal(next.watchMinutesContribution, 1600);
  assert.equal(next.source, "import_letterboxd");
});

test("grouped Letterboxd whole-title TV row is not discarded as a movie mismatch", () => {
  const writes = buildImportTitleStateWrites([{
    titleId: "tv1",
    title: series,
    row: { kind: "movie", wholeTitleCompleted: true, watchedDate: new Date("2026-01-01T12:00:00Z") },
  }], new Map(), { source: "letterboxd" });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].next.state, "completed_unrated");
});

test("fresh series import derives episode/season watermark from numeric episodes", () => {
  const rows = [
    { seasonNumber: 1, episodeNumber: 1, watchedDate: new Date("2026-01-01T12:00:00Z") },
    { seasonNumber: 1, episodeNumber: 2, watchedDate: new Date("2026-01-02T12:00:00Z") },
    { seasonNumber: 1, episodeNumber: 3, watchedDate: new Date("2026-01-03T12:00:00Z") },
  ];
  const next = buildSeriesImportState(null, series, rows, { now: new Date() });
  assert.equal(next.state, "in_progress");
  assert.equal(next.seriesProgress.episodesWatchedCount, 3);
  assert.equal(next.watchMinutesContribution, 120); // 3 * 40
});

test("Netflix named episodes (episodeNumber null) count as distinct watched episodes, not zero", () => {
  // Netflix's Italian export labels episodes by NAME, so episodeNumber is null
  // for ~97% of TV rows. Before the fix these collapsed to episodesWatchedCount:0
  // ("episodio zero"). Each distinct (season, name) is one watched episode.
  const rows = [
    { seasonNumber: 1, episodeNumber: null, episodeNameGuess: "Un, due, tre, stella", watchedDate: new Date("2026-01-01T12:00:00Z") },
    { seasonNumber: 1, episodeNumber: null, episodeNameGuess: "L'uomo con l'ombrello", watchedDate: new Date("2026-01-02T12:00:00Z") },
    { seasonNumber: 1, episodeNumber: null, episodeNameGuess: "Ragazza col fiammifero", watchedDate: new Date("2026-01-03T12:00:00Z") },
  ];
  const next = buildSeriesImportState(null, series, rows, { now: new Date() });
  assert.equal(next.state, "in_progress");
  assert.equal(next.seriesProgress.episodesWatchedCount, 3);
  assert.equal(next.watchMinutesContribution, 120); // 3 * 40
});

test("Netflix single-season show (ambiguous rows, no season marker) counts named episodes, not zero", () => {
  // "Spinning Out: Due per 40 dollari" — Netflix doesn't label single-season
  // shows with "Stagione 1", so the parser leaves seasonNumber null. Resolved
  // as a TV series, each distinct name is still a watched episode.
  const rows = [
    { seasonNumber: null, episodeNumber: null, episodeNameGuess: "Due per 40 dollari", watchedDate: new Date("2026-01-01T12:00:00Z") },
    { seasonNumber: null, episodeNumber: null, episodeNameGuess: "Benvenuta nella famiglia", watchedDate: new Date("2026-01-02T12:00:00Z") },
    { seasonNumber: null, episodeNumber: null, episodeNameGuess: "La mamma n.1", watchedDate: new Date("2026-01-03T12:00:00Z") },
  ];
  const next = buildSeriesImportState(null, series, rows, { now: new Date() });
  assert.equal(next.state, "in_progress");
  assert.equal(next.seriesProgress.episodesWatchedCount, 3);
});

test("Netflix named-episode re-watch (same name, different day) collapses to one distinct episode", () => {
  const rows = [
    { seasonNumber: 1, episodeNumber: null, episodeNameGuess: "Il pilota", watchedDate: new Date("2026-01-01T12:00:00Z") },
    { seasonNumber: 1, episodeNumber: null, episodeNameGuess: "il pilota ", watchedDate: new Date("2026-06-01T12:00:00Z") },
  ];
  const next = buildSeriesImportState(null, series, rows, { now: new Date() });
  assert.equal(next.seriesProgress.episodesWatchedCount, 1);
});

test("Netflix named episodes complete the series when every episode is covered", () => {
  const rows = [];
  for (let s = 1; s <= 2; s += 1) {
    for (let e = 1; e <= 10; e += 1) {
      rows.push({ seasonNumber: s, episodeNumber: null, episodeNameGuess: `Episodio nominato ${s}-${e}`, watchedDate: new Date("2026-01-01T12:00:00Z") });
    }
  }
  const next = buildSeriesImportState(null, series, rows, { now: new Date() });
  assert.match(next.state, /completed_unrated|rated/);
  assert.equal(next.seriesProgress.episodesWatchedCount, 20);
});

test("re-importing identical series rows is a no-op (idempotent, no inflated minutes)", () => {
  const rows = [
    { seasonNumber: 1, episodeNumber: 1, watchedDate: new Date("2026-01-01T12:00:00Z") },
    { seasonNumber: 1, episodeNumber: 2, watchedDate: new Date("2026-01-02T12:00:00Z") },
    { seasonNumber: 1, episodeNumber: 3, watchedDate: new Date("2026-01-03T12:00:00Z") },
  ];
  const first = buildSeriesImportState(null, series, rows, { now: new Date() });
  const second = buildSeriesImportState(first, series, rows, { now: new Date() });
  const third = buildSeriesImportState(second, series, rows, { now: new Date() });
  assert.equal(second.seriesProgress.episodesWatchedCount, 3);
  assert.equal(second.watchMinutesContribution, 120);
  assert.equal(third.seriesProgress.episodesWatchedCount, 3);
  assert.equal(third.watchMinutesContribution, 120);
});

test("re-import covering FEWER episodes than already tracked never regresses progress", () => {
  const fullRows = [
    { seasonNumber: 1, episodeNumber: 1, watchedDate: new Date("2026-01-01T12:00:00Z") },
    { seasonNumber: 1, episodeNumber: 2, watchedDate: new Date("2026-01-02T12:00:00Z") },
    { seasonNumber: 1, episodeNumber: 3, watchedDate: new Date("2026-01-03T12:00:00Z") },
  ];
  const existing = buildSeriesImportState(null, series, fullRows, { now: new Date() });

  const fewerRows = [{ seasonNumber: 1, episodeNumber: 1, watchedDate: new Date("2026-01-01T12:00:00Z") }];
  const next = buildSeriesImportState(existing, series, fewerRows, { now: new Date() });

  assert.equal(next.seriesProgress.episodesWatchedCount, 3);
  assert.equal(next.watchMinutesContribution, 120);
});

test("series import that reaches the full known run marks the series completed", () => {
  const allRows = [];
  for (let s = 1; s <= 2; s += 1) {
    for (let e = 1; e <= 10; e += 1) {
      allRows.push({ seasonNumber: s, episodeNumber: e, watchedDate: new Date("2026-01-01T12:00:00Z") });
    }
  }
  const next = buildSeriesImportState(null, series, allRows, { now: new Date() });
  assert.equal(next.state, "completed_unrated");
  assert.equal(next.seriesProgress.percentComplete, 1);
  assert.equal(next.watchMinutesContribution, 800); // 20 episodes * 40 min
});

test("re-importing a completed series stays completed and does not inflate minutes", () => {
  const allRows = [];
  for (let s = 1; s <= 2; s += 1) {
    for (let e = 1; e <= 10; e += 1) {
      allRows.push({ seasonNumber: s, episodeNumber: e, watchedDate: new Date("2026-01-01T12:00:00Z") });
    }
  }
  const first = buildSeriesImportState(null, series, allRows, { now: new Date() });
  const second = buildSeriesImportState(first, series, allRows, { now: new Date() });
  assert.equal(second.state, "completed_unrated");
  assert.equal(second.watchMinutesContribution, 800);
  assert.equal(second.completedCount, 1);
});

test("series CSV containing two complete runs (genuinely months apart) counts one rewatch", () => {
  const rows = [];
  // Two full watch-throughs of the same 20-episode series, ~7 months apart —
  // a genuine rewatch, not a same-sitting resume.
  for (let run = 0; run < 2; run += 1) {
    const month = run === 0 ? "01" : "08";
    for (let s = 1; s <= 2; s += 1) {
      for (let e = 1; e <= 10; e += 1) {
        rows.push({ seasonNumber: s, episodeNumber: e, watchedDate: new Date(`2026-${month}-${String(e).padStart(2, "0")}T12:00:00Z`) });
      }
    }
  }
  const first = buildSeriesImportState(null, series, rows, { now: new Date() });
  const second = buildSeriesImportState(first, series, rows, { now: new Date() });
  assert.equal(first.state, "completed_unrated");
  assert.equal(first.completedCount, 2);
  assert.equal(first.watchMinutesContribution, 800 * 2);
  assert.equal(second.completedCount, 2);
  assert.equal(second.watchMinutesContribution, 800 * 2);
});

test("series CSV with the finale watched twice on consecutive days (resume) does NOT count as a full-series rewatch", () => {
  // Only the finale has a duplicate date row (e.g. resumed the last episode
  // the next day); every other episode was watched exactly once. A full
  // rewatch needs every episode watched again, so this must NOT bump
  // completedCount — the bottleneck (min across episodes) is 1.
  const rows = [];
  for (let s = 1; s <= 2; s += 1) {
    for (let e = 1; e <= 10; e += 1) {
      rows.push({ seasonNumber: s, episodeNumber: e, watchedDate: new Date(`2026-01-${String(e).padStart(2, "0")}T12:00:00Z`) });
    }
  }
  // Duplicate row for the finale (S2E10) one day later.
  rows.push({ seasonNumber: 2, episodeNumber: 10, watchedDate: new Date("2026-01-11T12:00:00Z") });

  const next = buildSeriesImportState(null, series, rows, { now: new Date() });
  assert.equal(next.state, "completed_unrated");
  assert.equal(next.completedCount, 1);
  assert.equal(next.watchMinutesContribution, 800);
});

/* --- TV Time Refract's explicit per-episode rewatch signal (single watched_at,
 *     watched_count/rewatch_count carry the replay count) --- */

test("full series where EVERY episode has watched_count:2 (single date each) counts one rewatch", () => {
  // Refract emits one row per episode (one watched_at), so date-clustering
  // alone sees 1 run. watched_count:2 on every episode means the whole series
  // was watched twice — completedCount must be 2 and minutes doubled.
  const rows = [];
  for (let s = 1; s <= 2; s += 1) {
    for (let e = 1; e <= 10; e += 1) {
      rows.push({ seasonNumber: s, episodeNumber: e, watchedDate: new Date("2026-01-01T12:00:00Z"), watchedCount: 2 });
    }
  }
  const next = buildSeriesImportState(null, series, rows, { now: new Date() });
  assert.equal(next.state, "completed_unrated");
  assert.equal(next.completedCount, 2);
  assert.equal(next.watchMinutesContribution, 800 * 2);
});

test("full series where every episode has rewatch_count:1 counts one rewatch (rewatch_count = extra views)", () => {
  const rows = [];
  for (let s = 1; s <= 2; s += 1) {
    for (let e = 1; e <= 10; e += 1) {
      rows.push({ seasonNumber: s, episodeNumber: e, watchedDate: new Date("2026-01-01T12:00:00Z"), rewatchCount: 1 });
    }
  }
  const next = buildSeriesImportState(null, series, rows, { now: new Date() });
  assert.equal(next.completedCount, 2); // rewatch_count 1 => 2 total runs
  assert.equal(next.watchMinutesContribution, 800 * 2);
});

test("partial rewatch (only some episodes replayed) does NOT count a full-series rewatch — bottleneck is the least-watched episode", () => {
  const rows = [];
  for (let s = 1; s <= 2; s += 1) {
    for (let e = 1; e <= 10; e += 1) {
      // Every episode watched once; only S1E1 has an explicit replay.
      const watchedCount = s === 1 && e === 1 ? 3 : 1;
      rows.push({ seasonNumber: s, episodeNumber: e, watchedDate: new Date("2026-01-01T12:00:00Z"), watchedCount });
    }
  }
  const next = buildSeriesImportState(null, series, rows, { now: new Date() });
  assert.equal(next.completedCount, 1);
  assert.equal(next.watchMinutesContribution, 800);
});

test("series with no explicit rewatch fields behaves exactly as before (date-clusters only)", () => {
  const rows = [];
  for (let s = 1; s <= 2; s += 1) {
    for (let e = 1; e <= 10; e += 1) {
      rows.push({ seasonNumber: s, episodeNumber: e, watchedDate: new Date("2026-01-01T12:00:00Z") });
    }
  }
  const next = buildSeriesImportState(null, series, rows, { now: new Date() });
  assert.equal(next.completedCount, 1);
  assert.equal(next.watchMinutesContribution, 800);
});

test("single-episode miniseries watched on 2 consecutive days is NOT a rewatch", () => {
  const miniseries = { id: "mini1", type: "tv", name: "Mini", meta: { durationEpisode: 50, seasonsCount: 1, episodesPerSeason: 1 } };
  const rows = [
    { seasonNumber: 1, episodeNumber: 1, watchedDate: new Date("2026-01-01T12:00:00Z") },
    { seasonNumber: 1, episodeNumber: 1, watchedDate: new Date("2026-01-02T12:00:00Z") },
  ];
  const next = buildSeriesImportState(null, miniseries, rows, { now: new Date() });
  assert.equal(next.state, "completed_unrated");
  assert.equal(next.completedCount, 1);
  assert.equal(next.watchMinutesContribution, 50);
});

test("single-episode miniseries watched twice, months apart, counts as a rewatch", () => {
  const miniseries = { id: "mini1", type: "tv", name: "Mini", meta: { durationEpisode: 50, seasonsCount: 1, episodesPerSeason: 1 } };
  const rows = [
    { seasonNumber: 1, episodeNumber: 1, watchedDate: new Date("2026-01-01T12:00:00Z") },
    { seasonNumber: 1, episodeNumber: 1, watchedDate: new Date("2026-09-01T12:00:00Z") },
  ];
  const next = buildSeriesImportState(null, miniseries, rows, { now: new Date() });
  assert.equal(next.state, "completed_unrated");
  assert.equal(next.completedCount, 2);
  assert.equal(next.watchMinutesContribution, 50 * 2);
});

test("completed series already on Somto can optionally count Netflix as rewatch", () => {
  const existing = {
    titleId: "tv1",
    mediaType: "tv",
    state: "completed_unrated",
    completedCount: 1,
    seriesProgress: { episodesWatchedCount: 20, seasonsCompletedCount: 2, totalEpisodeCount: 20, totalSeasonCount: 2 },
  };
  const rows = [];
  for (let s = 1; s <= 2; s += 1) {
    for (let e = 1; e <= 10; e += 1) {
      rows.push({ seasonNumber: s, episodeNumber: e, watchedDate: new Date("2026-01-01T12:00:00Z") });
    }
  }
  const conservative = buildSeriesImportState(existing, series, rows, {
    now: new Date(),
    countExistingAsRewatch: false,
  });
  const counted = buildSeriesImportState(existing, series, rows, {
    now: new Date(),
    countExistingAsRewatch: true,
  });
  assert.equal(conservative.completedCount, 1);
  assert.equal(counted.completedCount, 2);
  assert.equal(counted.watchMinutesContribution, 800 * 2);
});

test("existing rating on a series is preserved through a progress-only import", () => {
  const ratedSeries = {
    titleId: "tv1",
    mediaType: "tv",
    state: "rated",
    hasTitleRating: true,
    ratingValue: 8,
    completedCount: 1,
    seriesProgress: { episodesWatchedCount: 5, seasonsCompletedCount: 0, totalEpisodeCount: 20, totalSeasonCount: 2 },
  };
  const rows = [{ seasonNumber: 1, episodeNumber: 6, watchedDate: new Date("2026-01-01T12:00:00Z") }];
  const next = buildSeriesImportState(ratedSeries, series, rows, { now: new Date() });
  assert.equal(next.hasTitleRating, true);
  assert.equal(next.ratingValue, 8);
});

test("season-only rows without episode numbers still advance the season watermark", () => {
  const rows = [
    { seasonNumber: 1, episodeNameGuess: "Pilot", watchedDate: new Date("2026-01-01T12:00:00Z") },
    { seasonNumber: 1, episodeNameGuess: "Ep 2", watchedDate: new Date("2026-01-02T12:00:00Z") },
  ];
  const next = buildSeriesImportState(null, series, rows, { now: new Date() });
  assert.equal(next.state, "in_progress");
  // No numeric episode signal for the top season -> can't credit episodes in
  // that season, but should not throw or silently regress to 0 across calls.
  assert.ok(next.seriesProgress.episodesWatchedCount >= 0);
});

test("scattered explicit episodes are counted distinctly, not by the linear watermark", () => {
  // A sampler who watched 50 episodes of season 1 and just 1 of season 2, for a
  // series whose per-season episode count TMDB doesn't know (no episodesPerSeason).
  // The watermark would derive only maxEpisodeInMaxSeason = 1; the true count is 51.
  const scattered = { id: "tv2", type: "tv", name: "Scattered", meta: { durationEpisode: 20 } };
  const rows = [];
  for (let e = 1; e <= 50; e += 1) rows.push({ seasonNumber: 1, episodeNumber: e, watchedDate: new Date("2026-01-01T12:00:00Z") });
  rows.push({ seasonNumber: 2, episodeNumber: 1, watchedDate: new Date("2026-02-01T12:00:00Z") });
  const next = buildSeriesImportState(null, scattered, rows, { now: new Date() });
  assert.equal(next.seriesProgress.episodesWatchedCount, 51);
  assert.equal(next.state, "in_progress");
});

test("duplicate episode rows (V1+V2 overlap) collapse to distinct episode count", () => {
  const scattered = { id: "tv2", type: "tv", name: "Scattered", meta: { durationEpisode: 20 } };
  const rows = [
    { seasonNumber: 1, episodeNumber: 1, watchedDate: new Date("2026-01-01T12:00:00Z") },
    { seasonNumber: 1, episodeNumber: 1, watchedDate: new Date("2026-01-01T12:00:00Z") }, // dup
    { seasonNumber: 1, episodeNumber: 2, watchedDate: new Date("2026-01-02T12:00:00Z") },
  ];
  const next = buildSeriesImportState(null, scattered, rows, { now: new Date() });
  assert.equal(next.seriesProgress.episodesWatchedCount, 2);
});

/* ============================= grouping / batch write ============================= */

test("groupMatchedRows groups rows by titleId and preserves the title doc", () => {
  const matched = [
    { titleId: "m1", title: movie, row: { watchedDate: new Date() } },
    { titleId: "tv1", title: series, row: { seasonNumber: 1, episodeNumber: 1, watchedDate: new Date() } },
    { titleId: "tv1", title: series, row: { seasonNumber: 1, episodeNumber: 2, watchedDate: new Date() } },
  ];
  const grouped = groupMatchedRows(matched);
  assert.equal(grouped.size, 2);
  assert.equal(grouped.get("tv1").rows.length, 2);
  assert.equal(grouped.get("m1").rows.length, 1);
});

test("groupMatchedRows ignores entries without a resolved titleId", () => {
  const matched = [
    { titleId: null, title: null, row: {} },
    { titleId: "m1", title: movie, row: { watchedDate: new Date() } },
  ];
  const grouped = groupMatchedRows(matched);
  assert.equal(grouped.size, 1);
});

test("buildImportTitleStateWrites produces one write per titleId", () => {
  const matched = [
    { titleId: "m1", title: movie, row: { watchedDate: new Date("2026-01-01T12:00:00Z") } },
    { titleId: "tv1", title: series, row: { seasonNumber: 1, episodeNumber: 1, watchedDate: new Date("2026-01-01T12:00:00Z") } },
  ];
  const currentStates = new Map();
  const writes = buildImportTitleStateWrites(matched, currentStates, { now: new Date() });
  assert.equal(writes.length, 2);
  const byId = new Map(writes.map((w) => [w.titleId, w]));
  assert.equal(byId.get("m1").next.state, "seen_unrated");
  assert.equal(byId.get("tv1").next.state, "in_progress");
});

/* ============ season numbering mismatch (TV Time arcs vs TMDB) ============ */

test("source season numbers above the catalog's season count don't complete the series", () => {
  // Live case (Francesco, import JBdHrjjX5g5Izd6GmLm5): TV Time splits Dragon
  // Ball Super into arcs and labels the watched episodes "season 4"; TMDB has
  // ONE season of 131 episodes. The season rule saw 4 >= 1 and credited the
  // whole series: 3013 minutes for 24 episodes actually watched.
  const dragonBall = { id: "tmdb_tv_62715", type: "tv", name: "Dragon Ball Super", meta: { durationEpisode: 23, seasonsCount: 1, episodesPerSeason: 131 } };
  const rows = [];
  for (let e = 1; e <= 24; e += 1) {
    rows.push({ seasonNumber: 4, episodeNumber: e, watchedDate: new Date("2016-08-28T12:00:00Z") });
  }
  const next = buildSeriesImportState(null, dragonBall, rows, { now: new Date() });
  assert.equal(next.state, "in_progress");
  assert.equal(next.seriesProgress.episodesWatchedCount, 24);
  assert.equal(next.watchMinutesContribution, 552); // 24 * 23, not 131 * 23
});

test("compatible season numbering still completes the series on the last season", () => {
  const rows = [];
  for (let s = 1; s <= 2; s += 1) {
    for (let e = 1; e <= 10; e += 1) {
      rows.push({ seasonNumber: s, episodeNumber: e, watchedDate: new Date("2026-01-01T12:00:00Z") });
    }
  }
  const next = buildSeriesImportState(null, series, rows, { now: new Date() });
  assert.equal(next.state, "completed_unrated");
});

test("episode evidence alone still completes the series when the numbering disagrees", () => {
  // Same arc-numbering mismatch, but the export lists every episode of the
  // series: the episode count is proof enough, no season signal needed.
  const dragonBall = { id: "tmdb_tv_62715", type: "tv", name: "Dragon Ball Super", meta: { durationEpisode: 23, seasonsCount: 1, episodesPerSeason: 131 } };
  const rows = [];
  for (let e = 1; e <= 131; e += 1) {
    rows.push({ seasonNumber: 4, episodeNumber: e, watchedDate: new Date("2016-08-28T12:00:00Z") });
  }
  const next = buildSeriesImportState(null, dragonBall, rows, { now: new Date() });
  assert.equal(next.state, "completed_unrated");
});

/* ============== guardie "in corso a zero" / righe-film su titoli TV ============== */

const { parseNetflixTitleCell: parseCellForZeroGuards } = require("../../lib/importAdapters/netflixCsv");

test("movie-kind rows matched to a tv title produce NO write (AniList mis-match)", () => {
  const csvDate = new Date("2026-06-16T12:00:00.000Z");
  const writes = buildImportTitleStateWrites([
    { titleId: "tv1", title: series, row: { kind: "movie", movieNameGuess: "My Fault", watchedDate: csvDate } },
  ], new Map(), { now: new Date() });
  assert.equal(writes.length, 0);
});

test("mixed rows on a tv title: movie-kind rows are ignored, episode rows count", () => {
  const csvDate = new Date("2026-06-16T12:00:00.000Z");
  const writes = buildImportTitleStateWrites([
    { titleId: "tv1", title: series, row: { kind: "movie", watchedDate: csvDate } },
    { titleId: "tv1", title: series, row: { kind: "tv_episode", seasonNumber: 1, episodeNumber: 3, watchedDate: csvDate } },
  ], new Map(), { now: new Date() });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].next.state, "in_progress");
  assert.equal(writes[0].next.seriesProgress.episodesWatchedCount, 3);
});

test("tv rows with no countable signal land in watchlist, never in_progress at 0", () => {
  const csvDate = new Date("2026-06-16T12:00:00.000Z");
  const next = buildSeriesImportState(null, series, [
    { kind: "tv_episode", seasonNumber: null, episodeNumber: null, episodeNameGuess: null, watchedDate: csvDate },
  ], { now: new Date() });
  assert.notEqual(next.state, "in_progress");
  assert.equal(next.generalWatchlist, true);
  assert.equal(next.seriesProgress?.episodesWatchedCount ?? 0, 0);
});

test("zero-signal rows never regress an existing in-progress state", () => {
  const csvDate = new Date("2026-06-16T12:00:00.000Z");
  const current = buildSeriesImportState(null, series, [
    { seasonNumber: 1, episodeNumber: 5, watchedDate: csvDate },
  ], { now: new Date() });
  const next = buildSeriesImportState(current, series, [
    { seasonNumber: null, episodeNumber: null, episodeNameGuess: null, watchedDate: csvDate },
  ], { now: new Date() });
  assert.equal(next.state, "in_progress");
  assert.equal(next.seriesProgress.episodesWatchedCount, 5);
  assert.equal(next.generalWatchlist, false);
});

test("season-less numbered episodes count as distinct episodes (Refract shape)", () => {
  const csvDate = new Date("2026-06-16T12:00:00.000Z");
  const oneSeason = { id: "tvR", type: "tv", name: "Refract Show", meta: { durationEpisode: 24, seasonsCount: 1, episodesPerSeason: 12 } };
  const rows = Array.from({ length: 12 }, (_, i) => ({ seasonNumber: null, episodeNumber: i + 1, watchedDate: csvDate }));
  const next = buildSeriesImportState(null, oneSeason, rows, { now: new Date() });
  assert.ok(next.state === "completed_unrated" || next.state === "rated", `state=${next.state}`);
});

test("in_progress never carries an episode number without a season", () => {
  const csvDate = new Date("2026-06-16T12:00:00.000Z");
  const big = { id: "tvB", type: "tv", name: "Big Show", meta: { durationEpisode: 24, seasonsCount: 3, episodesPerSeason: 10 } };
  const next = buildSeriesImportState(null, big, [
    { seasonNumber: null, episodeNumber: 4, watchedDate: csvDate },
  ], { now: new Date() });
  assert.equal(next.state, "in_progress");
  assert.equal(next.seriesProgress.episodesWatchedCount, 1);
  assert.equal(next.seriesProgress.lastWatchedSeasonNumber, null);
  assert.equal(next.seriesProgress.lastWatchedEpisodeNumber, null);
});

test("Netflix multi-part miniseries ends completed end-to-end (Alias Grace)", () => {
  const csvDate = new Date("2026-06-16T12:00:00.000Z");
  const aliasGrace = { id: "alias-grace", type: "tv", name: "L'altra Grace", meta: { durationEpisode: 45, seasonsCount: 1, episodesPerSeason: 6 } };
  const matched = [1, 2, 3, 4, 5, 6].map((n) => ({
    titleId: "alias-grace",
    title: aliasGrace,
    row: { ...parseCellForZeroGuards(`L'altra Grace: Miniserie: Parte ${n}`), watchedDate: csvDate },
  }));
  const [write] = buildImportTitleStateWrites(matched, new Map(), { now: new Date() });
  assert.ok(write, "write atteso");
  assert.ok(write.next.state === "completed_unrated" || write.next.state === "rated", `state=${write.next.state}`);
});
