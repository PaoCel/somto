"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DAY_MS,
  PRODUCT_TRACKING_RETENTION_MS,
  isManualProgressTransition,
  buildSuccessfulImportTrackingState,
  buildManualProgressTrackingState,
  computeManualProgressSnapshot,
} = require("../../lib/productTracking");

function movie(state, completedCount = 0) {
  return { mediaType: "movie", state, completedCount };
}

function series(state, episodes, seasons = 0) {
  return {
    mediaType: "tv",
    state,
    completedCount: ["completed_unrated", "rated"].includes(state) ? 1 : 0,
    seriesProgress: {
      episodesWatchedCount: episodes,
      seasonsCompletedCount: seasons,
      lastWatchedSeasonNumber: seasons || 1,
      lastWatchedEpisodeNumber: episodes,
    },
  };
}

test("manual progress conta solo transizioni semantiche in avanti", () => {
  assert.equal(
    isManualProgressTransition(movie("unseen"), movie("seen_unrated", 1), "mark_movie_seen"),
    true
  );
  assert.equal(
    isManualProgressTransition(movie("seen_unrated", 1), movie("seen_unrated", 1), "mark_movie_seen"),
    false
  );
  assert.equal(
    isManualProgressTransition(series("in_progress", 2), series("in_progress", 3), "mark_series_episode"),
    true
  );
  assert.equal(
    isManualProgressTransition(series("in_progress", 3), series("in_progress", 2), "set_series_progress"),
    false
  );
  assert.equal(
    isManualProgressTransition(series("in_progress", 8), series("completed_unrated", 8, 1), "mark_series_completed"),
    true
  );
  assert.equal(
    isManualProgressTransition(series("in_progress", 2), series("in_progress", 2), "toggle_watchlist"),
    false
  );
});

test("import milestone e' idempotente e conserva primo/ultimo import", () => {
  const t0 = Date.UTC(2026, 6, 10, 10);
  const first = buildSuccessfulImportTrackingState({}, { completedAtMs: t0 });
  const retry = buildSuccessfulImportTrackingState(first, { completedAtMs: t0 });
  const second = buildSuccessfulImportTrackingState(retry, { completedAtMs: t0 + 5 * DAY_MS });

  assert.equal(second.firstSuccessfulImportAtMs, t0);
  assert.equal(second.lastSuccessfulImportAtMs, t0 + 5 * DAY_MS);
  assert.equal(second.cohortOrigin, "prospective");
  assert.equal(second.expiresAtMs, t0 + 5 * DAY_MS + PRODUCT_TRACKING_RETENTION_MS);
});

test("import scritto in ritardo recupera milestone manuali gia' osservate", () => {
  const importedAt = Date.UTC(2026, 6, 1, 12);
  const manualAt = importedAt + 3 * DAY_MS;
  const manualFirst = buildManualProgressTrackingState({}, { occurredAtMs: manualAt });
  const recovered = buildSuccessfulImportTrackingState(manualFirst, { completedAtMs: importedAt });

  assert.equal(recovered.firstManualProgressAfterImportAtMs, manualAt);
  assert.equal(recovered.firstManualProgressAtOrAfterD1Ms, manualAt);
  assert.equal(recovered.firstManualProgressAtOrAfterD3Ms, manualAt);
  assert.equal(recovered.firstManualProgressAtOrAfterD7Ms, 0);
});

test("milestone D1/D3/D7 usano boundary esatti e sono set-once", () => {
  const importedAt = Date.UTC(2026, 6, 1, 12);
  let state = buildSuccessfulImportTrackingState({}, { completedAtMs: importedAt });

  state = buildManualProgressTrackingState(state, { occurredAtMs: importedAt + DAY_MS - 1 });
  assert.equal(state.firstManualProgressAfterImportAtMs, importedAt + DAY_MS - 1);
  assert.equal(state.firstManualProgressAtOrAfterD1Ms, 0);

  state = buildManualProgressTrackingState(state, { occurredAtMs: importedAt + DAY_MS });
  assert.equal(state.firstManualProgressAtOrAfterD1Ms, importedAt + DAY_MS);
  assert.equal(state.firstManualProgressAtOrAfterD3Ms, 0);

  state = buildManualProgressTrackingState(state, { occurredAtMs: importedAt + 3 * DAY_MS });
  assert.equal(state.firstManualProgressAtOrAfterD1Ms, importedAt + DAY_MS);
  assert.equal(state.firstManualProgressAtOrAfterD3Ms, importedAt + 3 * DAY_MS);

  state = buildManualProgressTrackingState(state, { occurredAtMs: importedAt + 7 * DAY_MS });
  assert.equal(state.firstManualProgressAtOrAfterD7Ms, importedAt + 7 * DAY_MS);
});

test("snapshot separa coorti prospective e legacy lower-bound", () => {
  const now = Date.UTC(2026, 6, 20, 12);
  const prospectiveImport = now - 10 * DAY_MS;
  const legacyImport = now - 8 * DAY_MS;
  let prospective = buildSuccessfulImportTrackingState({}, {
    completedAtMs: prospectiveImport,
    cohortOrigin: "prospective",
  });
  prospective = buildManualProgressTrackingState(prospective, {
    occurredAtMs: prospectiveImport + 7 * DAY_MS,
  });
  let legacy = buildSuccessfulImportTrackingState({}, {
    completedAtMs: legacyImport,
    cohortOrigin: "legacy_backfill",
    migrationVersion: 1,
  });
  legacy = buildManualProgressTrackingState(legacy, {
    occurredAtMs: legacyImport + DAY_MS,
  });

  const snapshot = computeManualProgressSnapshot({
    nowMs: now,
    consumerUids: new Set(["p", "l", "none"]),
    trackingByUid: new Map([["p", prospective], ["l", legacy]]),
  });

  assert.equal(snapshot.successfulImporters, 2);
  assert.equal(snapshot.eligibleD7, 2);
  assert.equal(snapshot.trackedD7, 1);
  assert.equal(snapshot.prospective.successfulImporters, 1);
  assert.equal(snapshot.prospective.trackedD7, 1);
  assert.equal(snapshot.legacyLowerBound.successfulImporters, 1);
  assert.equal(snapshot.legacyLowerBound.trackedD1, 1);
});
