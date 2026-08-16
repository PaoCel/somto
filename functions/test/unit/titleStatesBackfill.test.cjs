const test = require("node:test");
const assert = require("node:assert/strict");

const { previewUserStatsFromEnrichedStates } = require("../../lib/titleStatesBackfill");

// Regression test for the 2 confirmed backfill-title-states-metrics.js defects:
//   (a) listProgressEntries minutes were dropped from stats.totalWatchMinutes
//   (b) stats.byCategory was never written
test("previewUserStatsFromEnrichedStates includes listProgressEntries minutes in totalWatchMinutes", () => {
  const titleMap = new Map([
    ["movie1", { type: "movie", name: "Film" }],
    ["tv1", { type: "tv", name: "Serie" }],
  ]);

  const enrichedStates = [
    {
      id: "movie1",
      titleId: "movie1",
      mediaType: "movie",
      state: "seen_unrated",
      completedCount: 1,
      watchMinutesContribution: 100,
    },
  ];
  const listProgressRows = [
    { titleId: "tv1", mediaType: "tv", watchMinutesContribution: 250 },
  ];

  const stats = previewUserStatsFromEnrichedStates(enrichedStates, listProgressRows, titleMap);

  assert.equal(stats.totalWatchMinutes, 350); // 100 (titleStates) + 250 (listProgressEntries)
  assert.equal(stats.watchedCount, 1);
});

test("previewUserStatsFromEnrichedStates buckets both titleStates and listProgressEntries minutes into byCategory", () => {
  const titleMap = new Map([
    ["movie1", { type: "movie", name: "Film" }],
    ["tv1", { type: "tv", name: "Serie" }],
  ]);

  const enrichedStates = [
    {
      id: "movie1",
      titleId: "movie1",
      mediaType: "movie",
      state: "seen_unrated",
      completedCount: 1,
      watchMinutesContribution: 100,
    },
  ];
  const listProgressRows = [
    { titleId: "tv1", mediaType: "tv", watchMinutesContribution: 250 },
  ];

  const stats = previewUserStatsFromEnrichedStates(enrichedStates, listProgressRows, titleMap);

  assert.ok(stats.byCategory);
  assert.equal(stats.byCategory.film.totalWatchMinutes, 100);
  assert.equal(stats.byCategory.serie_tv.totalWatchMinutes, 250);
  assert.equal(stats.byCategory.anime.totalWatchMinutes, 0);
  assert.equal(stats.byCategory.cartoni_animati.totalWatchMinutes, 0);
});

test("previewUserStatsFromEnrichedStates ignores zero/invalid listProgressEntries minutes", () => {
  const titleMap = new Map();
  const stats = previewUserStatsFromEnrichedStates(
    [],
    [
      { titleId: "x", mediaType: "movie", watchMinutesContribution: 0 },
      { titleId: "y", mediaType: "movie", watchMinutesContribution: -5 },
      { titleId: "z", mediaType: "movie" },
    ],
    titleMap
  );

  assert.equal(stats.totalWatchMinutes, 0);
});

test("previewUserStatsFromEnrichedStates falls back to media type when the title doc is missing", () => {
  const stats = previewUserStatsFromEnrichedStates(
    [],
    [{ titleId: "unknown-title", mediaType: "tv", watchMinutesContribution: 60 }],
    new Map()
  );

  assert.equal(stats.totalWatchMinutes, 60);
  assert.equal(stats.byCategory.serie_tv.totalWatchMinutes, 60);
});
