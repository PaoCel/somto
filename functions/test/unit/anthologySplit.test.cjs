const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveAnthologySplit,
  applyAnthologySplit,
  applyAnthologySplitsToRows,
  normalizeAnthologyName,
} = require("../../lib/importAdapters/anthologySplit");

function monsterRow(overrides = {}) {
  return {
    kind: "tv_episode",
    seriesNameGuess: "Monster (2022)",
    tvdbSeriesId: 389492,
    seasonNumber: 1,
    episodeNumber: 4,
    watchedDate: new Date("2024-01-01T12:00:00Z"),
    ...overrides,
  };
}

/* ============================= resolveAnthologySplit ============================= */

test("maps Monster (2022) season 1 -> Dahmer, season 1", () => {
  const r = resolveAnthologySplit(monsterRow({ seasonNumber: 1 }));
  assert.deepEqual(r, { titleId: "tmdb_tv_113988", targetSeason: 1, label: r.label });
  assert.equal(r.titleId, "tmdb_tv_113988");
  assert.equal(r.targetSeason, 1);
});

test("maps season 2 -> Menéndez, season 3 -> Ed Gein", () => {
  assert.equal(resolveAnthologySplit(monsterRow({ seasonNumber: 2 })).titleId, "la-storia-di-lyle-ed-erik-menendez-2024");
  assert.equal(resolveAnthologySplit(monsterRow({ seasonNumber: 3 })).titleId, "N0e8PVbOfvKpSEP8Xe4D");
});

test("season 0 (special) is NOT split (falls through to normal path)", () => {
  assert.equal(resolveAnthologySplit(monsterRow({ seasonNumber: 0 })), null);
});

test("unmapped season (e.g. 4) is NOT split", () => {
  assert.equal(resolveAnthologySplit(monsterRow({ seasonNumber: 4 })), null);
});

test("matches by tvdbSeriesId even when the name differs", () => {
  const r = resolveAnthologySplit(monsterRow({ seriesNameGuess: "Some Localized Title", seasonNumber: 2 }));
  assert.equal(r.titleId, "la-storia-di-lyle-ed-erik-menendez-2024");
});

test("exact name fallback 'monster 2022' works without a tvdb id", () => {
  const r = resolveAnthologySplit(monsterRow({ tvdbSeriesId: null, seriesNameGuess: "Monster (2022)", seasonNumber: 1 }));
  assert.equal(r.titleId, "tmdb_tv_113988");
});

test("does NOT match 'The Monster of Florence' (name contains 'monster', different tvdb)", () => {
  const r = resolveAnthologySplit(monsterRow({ tvdbSeriesId: 440698, seriesNameGuess: "The Monster of Florence", seasonNumber: 1 }));
  assert.equal(r, null);
});

test("does NOT match the 2004 anime 'Monster' (no year in name, different tvdb)", () => {
  const r = resolveAnthologySplit(monsterRow({ tvdbSeriesId: 30981, seriesNameGuess: "Monster", seasonNumber: 1 }));
  assert.equal(r, null);
});

test("movie rows are never split", () => {
  assert.equal(resolveAnthologySplit(monsterRow({ kind: "movie" })), null);
});

/* ============================= applyAnthologySplit ============================= */

test("applyAnthologySplit pins titleId, remaps season, preserves episode", () => {
  const row = monsterRow({ seasonNumber: 2, episodeNumber: 5 });
  const applied = applyAnthologySplit(row);
  assert.equal(applied, true);
  assert.equal(row.forcedTitleId, "la-storia-di-lyle-ed-erik-menendez-2024");
  assert.equal(row.forcedTitleStrategy, "anthology_split");
  assert.equal(row.seasonNumber, 1); // remapped
  assert.equal(row.episodeNumber, 5); // preserved
  assert.equal(row.anthologySourceSeason, 2); // audit trail
});

test("applyAnthologySplit is idempotent (double-apply does NOT re-map S1->Dahmer)", () => {
  const row = monsterRow({ seasonNumber: 2, episodeNumber: 5 });
  applyAnthologySplit(row);
  const secondPass = applyAnthologySplit(row);
  assert.equal(secondPass, false); // guarded by forcedTitleId
  assert.equal(row.forcedTitleId, "la-storia-di-lyle-ed-erik-menendez-2024"); // unchanged
  assert.equal(row.seasonNumber, 1);
});

test("applyAnthologySplit no-ops on non-anthology rows", () => {
  const row = { kind: "tv_episode", seriesNameGuess: "Breaking Bad", tvdbSeriesId: 81189, seasonNumber: 5, episodeNumber: 14 };
  assert.equal(applyAnthologySplit(row), false);
  assert.equal(row.forcedTitleId, undefined);
  assert.equal(row.seasonNumber, 5);
});

test("applyAnthologySplitsToRows maps a mixed batch, leaving others untouched", () => {
  const rows = [
    monsterRow({ seasonNumber: 1, episodeNumber: 3 }),
    { kind: "tv_episode", seriesNameGuess: "The Monster of Florence", tvdbSeriesId: 440698, seasonNumber: 1, episodeNumber: 2 },
    monsterRow({ seasonNumber: 3, episodeNumber: 8 }),
  ];
  applyAnthologySplitsToRows(rows);
  assert.equal(rows[0].forcedTitleId, "tmdb_tv_113988");
  assert.equal(rows[1].forcedTitleId, undefined); // Florence untouched
  assert.equal(rows[1].seasonNumber, 1);
  assert.equal(rows[2].forcedTitleId, "N0e8PVbOfvKpSEP8Xe4D");
});

/* ============================= normalizeAnthologyName ============================= */

test("normalizeAnthologyName strips punctuation/case", () => {
  assert.equal(normalizeAnthologyName("Monster (2022)"), "monster 2022");
  assert.equal(normalizeAnthologyName("The Monster of Florence"), "the monster of florence");
});
