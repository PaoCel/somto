const test = require("node:test");
const assert = require("node:assert/strict");

const {
  TITLE_STATE_SCHEMA_VERSION,
  buildNextTitleState,
  computeWatchMinutesContribution,
  computeUserStatsFromStateSet,
  applyTitleRatingToState,
  hasNewContentVsSnapshot,
  normalizeStateForTitle,
} = require("../../lib/titleStates");

const movie = {
  id: "m1",
  type: "movie",
  name: "Movie",
  meta: { durationMovie: 120 },
};

const series = {
  id: "tv1",
  type: "tv",
  name: "Series",
  meta: {
    durationEpisode: 50,
    seasonsCount: 2,
    episodesPerSeason: 10,
  },
};

test("mark_movie_seen creates first completion and minutes contribution", () => {
  const now = new Date("2026-04-16T10:00:00Z");
  const next = buildNextTitleState(null, {
    type: "mark_movie_seen",
    source: "unit_test",
  }, movie, { now });

  assert.equal(next.state, "seen_unrated");
  assert.equal(next.completedCount, 1);
  assert.equal(next.watchMinutesContribution, 120);
  assert.equal(next.schemaVersion, TITLE_STATE_SCHEMA_VERSION);
});

test("series rewatch preserves prior completed minutes while in progress", () => {
  const now = new Date("2026-04-16T10:00:00Z");
  const next = buildNextTitleState({
    titleId: "tv1",
    mediaType: "tv",
    state: "rated",
    completedCount: 1,
    rewatchIntent: true,
    hasTitleRating: true,
    ratingValue: 8,
    seriesProgress: {
      episodesWatchedCount: 20,
      seasonsCompletedCount: 2,
      totalEpisodeCount: 20,
      totalSeasonCount: 2,
    },
  }, {
    type: "mark_series_episode",
    source: "unit_test",
  }, series, { now });

  assert.equal(next.state, "in_progress");
  assert.equal(next.completedCount, 1);
  assert.equal(next.seriesProgress.episodesWatchedCount, 1);
  assert.equal(next.watchMinutesContribution, (20 * 50) + 50);
});

test("series completion during rewatch increments completedCount", () => {
  const now = new Date("2026-04-16T10:00:00Z");
  const next = buildNextTitleState({
    titleId: "tv1",
    mediaType: "tv",
    state: "in_progress",
    completedCount: 1,
    rewatchIntent: true,
    seriesProgress: {
      episodesWatchedCount: 19,
      seasonsCompletedCount: 1,
      totalEpisodeCount: 20,
      totalSeasonCount: 2,
    },
  }, {
    type: "mark_series_episode",
    source: "unit_test",
  }, series, { now });

  assert.equal(next.state, "completed_unrated");
  assert.equal(next.completedCount, 2);
  assert.equal(next.rewatchIntent, false);
  assert.equal(next.watchMinutesContribution, 20 * 50 * 2);
});

test("partial series progress keeps the title in the watchlist", () => {
  const now = new Date("2026-04-16T10:00:00Z");
  const next = buildNextTitleState({
    titleId: "tv1",
    mediaType: "tv",
    state: "in_progress",
    generalWatchlist: true,
    seriesProgress: {
      episodesWatchedCount: 3,
      seasonsCompletedCount: 0,
      totalEpisodeCount: 20,
      totalSeasonCount: 2,
    },
  }, {
    type: "mark_series_episode",
    source: "unit_test",
  }, series, { now });

  assert.equal(next.state, "in_progress");
  assert.equal(next.seriesProgress.episodesWatchedCount, 4);
  assert.equal(next.generalWatchlist, true);
});

test("series completion clears the watchlist flag", () => {
  const now = new Date("2026-04-16T10:00:00Z");
  const next = buildNextTitleState({
    titleId: "tv1",
    mediaType: "tv",
    state: "in_progress",
    generalWatchlist: true,
    seriesProgress: {
      episodesWatchedCount: 19,
      seasonsCompletedCount: 1,
      totalEpisodeCount: 20,
      totalSeasonCount: 2,
    },
  }, {
    type: "mark_series_episode",
    source: "unit_test",
  }, series, { now });

  assert.equal(next.state, "completed_unrated");
  assert.equal(next.generalWatchlist, false);
});

test("in-progress series can be re-added to the watchlist", () => {
  const now = new Date("2026-04-16T10:00:00Z");
  const next = buildNextTitleState({
    titleId: "tv1",
    mediaType: "tv",
    state: "in_progress",
    generalWatchlist: false,
    seriesProgress: {
      episodesWatchedCount: 4,
      seasonsCompletedCount: 0,
      totalEpisodeCount: 20,
      totalSeasonCount: 2,
    },
  }, {
    type: "toggle_watchlist",
    enabled: true,
    source: "unit_test",
  }, series, { now });

  assert.equal(next.generalWatchlist, true);
});

test("completed series stays out of the watchlist on toggle", () => {
  const now = new Date("2026-04-16T10:00:00Z");
  const next = buildNextTitleState({
    titleId: "tv1",
    mediaType: "tv",
    state: "completed_unrated",
    generalWatchlist: false,
    completedCount: 1,
    seriesProgress: {
      episodesWatchedCount: 20,
      seasonsCompletedCount: 2,
      totalEpisodeCount: 20,
      totalSeasonCount: 2,
    },
  }, {
    type: "toggle_watchlist",
    enabled: true,
    source: "unit_test",
  }, series, { now });

  assert.equal(next.generalWatchlist, false);
});

test("rating sync upgrades title state without inventing extra rewatches", () => {
  const now = new Date("2026-04-16T10:00:00Z");
  const next = applyTitleRatingToState({
    titleId: "tv1",
    mediaType: "tv",
    state: "completed_unrated",
    completedCount: 2,
    rewatchIntent: false,
    seriesProgress: {
      episodesWatchedCount: 20,
      seasonsCompletedCount: 2,
      totalEpisodeCount: 20,
      totalSeasonCount: 2,
    },
  }, {
    uid: "alice",
    titleId: "tv1",
    level: "title",
    rating: 9,
    updatedAt: now,
  }, series, { now });

  assert.equal(next.state, "rated");
  assert.equal(next.completedCount, 2);
  assert.equal(next.ratingValue, 9);
});

test("series completion via mark_series_completed snapshots totals", () => {
  const now = new Date("2026-04-16T10:00:00Z");
  const next = buildNextTitleState(null, {
    type: "mark_series_completed",
    source: "unit_test",
  }, series, { now });

  assert.equal(next.state, "completed_unrated");
  assert.equal(next.completedAtTotalEpisodes, 20);
  assert.equal(next.completedAtTotalSeasons, 2);
  assert.equal(next.hasNewContent, false);
  assert.equal(next.watchMinutesContribution, 20 * 50);
});

test("watchMinutes uses historical snapshot when title gets new seasons", () => {
  const seriesGrown = {
    ...series,
    meta: { durationEpisode: 50, seasonsCount: 3, episodesPerSeason: 10 },
  };
  const minutes = computeWatchMinutesContribution(seriesGrown, {
    mediaType: "tv",
    state: "completed_unrated",
    completedCount: 1,
    completedAtTotalEpisodes: 20,
    seriesProgress: { episodesWatchedCount: 20, totalEpisodeCount: 30 },
  });
  // Without snapshot the minutes would inflate to 30 * 50 = 1500.
  assert.equal(minutes, 1000);
});

test("hasNewContentVsSnapshot detects season growth", () => {
  assert.equal(hasNewContentVsSnapshot({ completedAtTotalEpisodes: 20 }, { totalEpisodeCount: 30 }), true);
  assert.equal(hasNewContentVsSnapshot({ completedAtTotalEpisodes: 20 }, { totalEpisodeCount: 20 }), false);
  assert.equal(hasNewContentVsSnapshot({ completedAtTotalSeasons: 2 }, { totalSeasonCount: 3 }), true);
  assert.equal(hasNewContentVsSnapshot({}, { totalEpisodeCount: 30 }), false);
});

test("catch-up: completed series with new content advances from snapshot", () => {
  const seriesGrown = {
    ...series,
    meta: { durationEpisode: 50, seasonsCount: 3, episodesPerSeason: 10 },
  };
  const now = new Date("2026-04-16T10:00:00Z");
  const next = buildNextTitleState({
    titleId: "tv1",
    mediaType: "tv",
    state: "completed_unrated",
    completedCount: 1,
    rewatchIntent: false,
    completedAtTotalEpisodes: 20,
    completedAtTotalSeasons: 2,
    seriesProgress: {
      episodesWatchedCount: 20,
      seasonsCompletedCount: 2,
      totalEpisodeCount: 20,
      totalSeasonCount: 2,
    },
  }, {
    type: "mark_series_episode",
    source: "unit_test",
  }, seriesGrown, { now });

  assert.equal(next.state, "in_progress");
  assert.equal(next.completedCount, 1);
  assert.equal(next.seriesProgress.episodesWatchedCount, 21);
  // 1 prior run × 20 ep × 50 min + 21 progress × 50 min = 1000 + 1050 = 2050
  assert.equal(next.watchMinutesContribution, 2050);
});

test("catch-up reaching new total: snapshot updates, completedCount stays", () => {
  const seriesGrown = {
    ...series,
    meta: { durationEpisode: 50, seasonsCount: 3, episodesPerSeason: 10 },
  };
  const now = new Date("2026-04-16T10:00:00Z");
  const next = buildNextTitleState({
    titleId: "tv1",
    mediaType: "tv",
    state: "in_progress",
    completedCount: 1,
    rewatchIntent: false,
    completedAtTotalEpisodes: 20,
    completedAtTotalSeasons: 2,
    seriesProgress: {
      episodesWatchedCount: 29,
      seasonsCompletedCount: 2,
      totalEpisodeCount: 30,
      totalSeasonCount: 3,
    },
  }, {
    type: "mark_series_episode",
    source: "unit_test",
  }, seriesGrown, { now });

  assert.equal(next.state, "completed_unrated");
  assert.equal(next.completedCount, 1);
  assert.equal(next.completedAtTotalEpisodes, 30);
  assert.equal(next.completedAtTotalSeasons, 3);
  assert.equal(next.hasNewContent, false);
  // 1 run × 30 ep × 50 = 1500
  assert.equal(next.watchMinutesContribution, 1500);
});

test("in_progress series with seenAt does not gain a phantom completed run", () => {
  // Regression: seenAt is stamped at the FIRST episode, so an in_progress
  // series with seenAt but no completedCount must stay at 0 completed runs —
  // otherwise every progress update adds a full-run worth of minutes.
  const now = new Date("2026-07-05T10:00:00Z");
  const next = buildNextTitleState({
    titleId: "tv1",
    mediaType: "tv",
    state: "in_progress",
    seenAt: new Date("2026-07-01T10:00:00Z"),
    seriesProgress: {
      episodesWatchedCount: 5,
      seasonsCompletedCount: 0,
      totalEpisodeCount: 20,
      totalSeasonCount: 2,
    },
  }, {
    type: "mark_series_episode",
    source: "unit_test",
  }, series, { now });

  assert.equal(next.state, "in_progress");
  assert.equal(next.completedCount, 0);
  // 6 episodes × 50 min — NOT + one full run (20 × 50).
  assert.equal(next.watchMinutesContribution, 6 * 50);
});

test("set_series_progress on in_progress series with seenAt keeps minutes linear", () => {
  const now = new Date("2026-07-05T10:00:00Z");
  const next = buildNextTitleState({
    titleId: "tv1",
    mediaType: "tv",
    state: "in_progress",
    seenAt: new Date("2026-07-01T10:00:00Z"),
    seriesProgress: {
      episodesWatchedCount: 5,
      seasonsCompletedCount: 0,
      totalEpisodeCount: 20,
      totalSeasonCount: 2,
    },
  }, {
    type: "set_series_progress",
    source: "unit_test",
    episodesWatchedCount: 10,
    seasonsCompletedCount: 1,
  }, series, { now });

  assert.equal(next.state, "in_progress");
  assert.equal(next.completedCount, 0);
  assert.equal(next.watchMinutesContribution, 10 * 50);
});

test("legacy fallback: movie with seenAt only still counts one run", () => {
  const normalized = normalizeStateForTitle({
    titleId: "m1",
    mediaType: "movie",
    state: "seen_unrated",
    seenAt: new Date("2026-01-01T10:00:00Z"),
  }, movie);

  assert.equal(normalized.completedCount, 1);
  assert.equal(normalized.watchMinutesContribution, 120);
});

test("legacy fallback: in_progress series with completedAt keeps its prior run", () => {
  // Catch-up shape without completedCount (legacy doc): a real completion
  // happened (completedAt set), then the user resumed on new content.
  const normalized = normalizeStateForTitle({
    titleId: "tv1",
    mediaType: "tv",
    state: "in_progress",
    seenAt: new Date("2026-01-01T10:00:00Z"),
    completedAt: new Date("2026-02-01T10:00:00Z"),
    completedAtTotalEpisodes: 20,
    seriesProgress: {
      episodesWatchedCount: 2,
      seasonsCompletedCount: 0,
      totalEpisodeCount: 20,
      totalSeasonCount: 2,
    },
  }, series);

  assert.equal(normalized.completedCount, 1);
  // 1 prior run (20 × 50) + 2 progress episodes × 50.
  assert.equal(normalized.watchMinutesContribution, (20 * 50) + (2 * 50));
});

test("mark_movie_unseen reverts to unseen and clears completion", () => {
  const now = new Date("2026-04-16T10:00:00Z");
  const next = buildNextTitleState({
    titleId: "m1",
    mediaType: "movie",
    state: "seen_unrated",
    completedCount: 1,
    seenAt: now,
  }, {
    type: "mark_movie_unseen",
    source: "unit_test",
  }, movie, { now });

  assert.equal(next.state, "unseen");
  assert.equal(next.completedCount, 0);
  assert.equal(next.watchMinutesContribution, 0);
});

test("acknowledge_new_content clears the indicator without changing watch state", () => {
  const now = new Date("2026-04-16T10:00:00Z");
  const next = buildNextTitleState({
    titleId: "tv1",
    mediaType: "tv",
    state: "completed_unrated",
    completedCount: 1,
    completedAtTotalEpisodes: 20,
    completedAtTotalSeasons: 2,
    hasNewContent: true,
    latestSeasonNumber: 3,
  }, {
    type: "acknowledge_new_content",
    source: "unit_test",
  }, series, { now });

  assert.equal(next.state, "completed_unrated");
  assert.equal(next.hasNewContent, false);
  assert.equal(next.completedCount, 1);
});

test("computeUserStatsFromStateSet aggregates watched, ratings, minutes and rewatches", () => {
  const stats = computeUserStatsFromStateSet([
    {
      mediaType: "movie",
      state: "rated",
      hasTitleRating: true,
      completedCount: 1,
      watchMinutesContribution: 120,
    },
    {
      mediaType: "tv",
      state: "completed_unrated",
      hasTitleRating: false,
      completedCount: 2,
      watchMinutesContribution: 2000,
    },
    {
      mediaType: "tv",
      state: "in_progress",
      hasTitleRating: false,
      completedCount: 0,
      watchMinutesContribution: 150,
    },
  ]);

  assert.deepEqual(stats, {
    watchedCount: 2,
    ratingsCount: 1,
    totalWatchMinutes: 2270,
    rewatchCount: 1,
    byCategory: {
      film: {
        watchedCount: 1,
        ratingsCount: 1,
        totalWatchMinutes: 120,
        rewatchCount: 0,
      },
      serie_tv: {
        watchedCount: 1,
        ratingsCount: 0,
        totalWatchMinutes: 2150,
        rewatchCount: 1,
      },
      cartoni_animati: {
        watchedCount: 0,
        ratingsCount: 0,
        totalWatchMinutes: 0,
        rewatchCount: 0,
      },
      anime: {
        watchedCount: 0,
        ratingsCount: 0,
        totalWatchMinutes: 0,
        rewatchCount: 0,
      },
    },
  });
});
