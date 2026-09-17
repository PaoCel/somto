"use strict";

// Unit tests for the pure import-confirmation planner (confirmPlan.js). These
// cover the DECISION surface of `confirmTitlesImport` without the emulator:
// what each resolution means, how skipRemaining sweeps leftovers, and how the
// final status falls out of the remaining count. The Firestore I/O + TMDB
// suggestion resolution in the onCall itself need the emulator / integration
// harness (documented in the task report, not covered here).

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SUGGESTION_ACCEPT_MIN_CONFIDENCE,
  classifyResolution,
  planResolutions,
  planSkipRemaining,
  computeConfirmationStatus,
  suggestionMediaType,
} = require("../../lib/importAdapters/confirmPlan");

/* ============================ classifyResolution ============================ */

test("classifyResolution: explicit title pick -> import_title", () => {
  const out = classifyResolution({ itemId: "i1", titleId: "t1" }, { rawTitle: "X" });
  assert.deepEqual(out, { action: "import_title", itemId: "i1", titleId: "t1" });
});

test("classifyResolution: explicit skip -> skip (wins even with a titleId present)", () => {
  const out = classifyResolution({ itemId: "i1", skip: true, titleId: "t1" }, { rawTitle: "X" });
  assert.deepEqual(out, { action: "skip", itemId: "i1" });
});

test("classifyResolution: acceptSuggestion above threshold -> accept_suggestion", () => {
  const item = { confidence: 0.75, suggestion: { tmdbId: 42, mediaType: "tv" } };
  const out = classifyResolution({ itemId: "i1", acceptSuggestion: true }, item);
  assert.deepEqual(out, { action: "accept_suggestion", itemId: "i1", tmdbId: 42, mediaType: "tv" });
});

test("classifyResolution: acceptSuggestion AT the exact threshold is accepted", () => {
  const item = { confidence: SUGGESTION_ACCEPT_MIN_CONFIDENCE, suggestion: { tmdbId: 7, mediaType: "movie" } };
  const out = classifyResolution({ itemId: "i1", acceptSuggestion: true }, item);
  assert.equal(out.action, "accept_suggestion");
  assert.equal(out.tmdbId, 7);
});

test("classifyResolution: acceptSuggestion below threshold -> ignore (never imports a low-confidence guess)", () => {
  const item = { confidence: 0.4, suggestion: { tmdbId: 42, mediaType: "tv" } };
  const out = classifyResolution({ itemId: "i1", acceptSuggestion: true }, item);
  assert.equal(out.action, "ignore");
  assert.equal(out.reason, "suggestion_below_threshold");
});

test("classifyResolution: acceptSuggestion with no suggestion -> ignore", () => {
  const item = { confidence: 0.9, suggestion: null };
  const out = classifyResolution({ itemId: "i1", acceptSuggestion: true }, item);
  assert.equal(out.action, "ignore");
});

test("classifyResolution: missing item doc -> ignore", () => {
  const out = classifyResolution({ itemId: "i1", titleId: "t1" }, null);
  assert.deepEqual(out, { action: "ignore", itemId: "i1", reason: "item_not_found" });
});

test("classifyResolution: missing itemId -> ignore", () => {
  const out = classifyResolution({ titleId: "t1" }, { rawTitle: "X" });
  assert.equal(out.action, "ignore");
  assert.equal(out.reason, "missing_item_id");
});

test("classifyResolution: empty resolution (no titleId/skip/accept) -> ignore", () => {
  const out = classifyResolution({ itemId: "i1" }, { rawTitle: "X" });
  assert.equal(out.action, "ignore");
  assert.equal(out.reason, "empty_resolution");
});

/* ============================== suggestionMediaType ========================= */

test("suggestionMediaType: prefers suggestion.mediaType, normalizes series->tv", () => {
  assert.equal(suggestionMediaType({ suggestion: { mediaType: "series" } }), "tv");
  assert.equal(suggestionMediaType({ suggestion: { mediaType: "tv" } }), "tv");
  assert.equal(suggestionMediaType({ suggestion: { mediaType: "movie" } }), "movie");
});

test("suggestionMediaType: falls back to resolvedAsType / refKind / kind, defaulting to movie", () => {
  assert.equal(suggestionMediaType({ resolvedAsType: "tv" }), "tv");
  assert.equal(suggestionMediaType({ refKind: "series" }), "tv");
  assert.equal(suggestionMediaType({ kind: "movie" }), "movie");
  assert.equal(suggestionMediaType({}), "movie");
});

/* ============================== planResolutions ============================= */

test("planResolutions: mixed batch tallies each action and marks handled ids", () => {
  const items = {
    a: { titleId: null },
    b: { titleId: null },
    c: { confidence: 0.7, suggestion: { tmdbId: 10, mediaType: "tv" } },
    d: { confidence: 0.3, suggestion: { tmdbId: 11, mediaType: "tv" } }, // below threshold
  };
  const { actions, handledItemIds, tally } = planResolutions([
    { itemId: "a", titleId: "t-a" },
    { itemId: "b", skip: true },
    { itemId: "c", acceptSuggestion: true },
    { itemId: "d", acceptSuggestion: true },
    { itemId: "missing", titleId: "t-x" },
  ], items);

  assert.equal(actions.length, 5);
  assert.deepEqual(tally, { importTitle: 1, acceptSuggestion: 1, skip: 1, ignore: 2 });
  // a (import), b (skip), c (accept) are handled; d (below-threshold ignore) and
  // the missing item are NOT — so skipRemaining stays free to dispose of them.
  assert.deepEqual([...handledItemIds].sort(), ["a", "b", "c"]);
});

test("planResolutions: accepts a Map of items as well as a plain object", () => {
  const items = new Map([["a", { titleId: null }]]);
  const { tally } = planResolutions([{ itemId: "a", titleId: "t1" }], items);
  assert.equal(tally.importTitle, 1);
});

test("planResolutions: quick confirm with zero explicit resolutions handles nothing", () => {
  const { actions, handledItemIds, tally } = planResolutions([], {});
  assert.equal(actions.length, 0);
  assert.equal(handledItemIds.size, 0);
  assert.deepEqual(tally, { importTitle: 0, acceptSuggestion: 0, skip: 0, ignore: 0 });
});

/* ============================== planSkipRemaining ========================== */

test("planSkipRemaining: sweeps every unresolved id not already handled", () => {
  const out = planSkipRemaining({
    skipRemaining: true,
    handledItemIds: new Set(["a", "c"]),
    unresolvedItemIds: ["a", "b", "c", "d", "e"],
  });
  assert.deepEqual(out, ["b", "d", "e"]);
});

test("planSkipRemaining: skipRemaining=false sweeps nothing", () => {
  const out = planSkipRemaining({
    skipRemaining: false,
    handledItemIds: new Set(),
    unresolvedItemIds: ["a", "b"],
  });
  assert.deepEqual(out, []);
});

test("planSkipRemaining: scales to hundreds of unresolved rows (quick 'skip all')", () => {
  const ids = Array.from({ length: 500 }, (_, i) => `row_${i}`);
  const handled = new Set(ids.slice(0, 3)); // user picked 3 titles, finishes the rest
  const out = planSkipRemaining({ skipRemaining: true, handledItemIds: handled, unresolvedItemIds: ids });
  assert.equal(out.length, 497);
  assert.ok(!out.includes("row_0"));
  assert.ok(out.includes("row_499"));
});

test("planSkipRemaining: accepts an array (not only a Set) for handled ids", () => {
  const out = planSkipRemaining({ skipRemaining: true, handledItemIds: ["a"], unresolvedItemIds: ["a", "b"] });
  assert.deepEqual(out, ["b"]);
});

/* ============================ computeConfirmationStatus ===================== */

test("computeConfirmationStatus: nothing left -> completed", () => {
  assert.equal(computeConfirmationStatus(0), "completed");
});

test("computeConfirmationStatus: leftovers -> stays awaiting_confirmation", () => {
  assert.equal(computeConfirmationStatus(5), "awaiting_confirmation");
});

test("computeConfirmationStatus: negative / garbage clamps to completed", () => {
  assert.equal(computeConfirmationStatus(-2), "completed");
  assert.equal(computeConfirmationStatus(NaN), "completed");
});

/* ===================== end-to-end count coherence (pure) =================== */

test("scenario: all-safe import (no unresolved) — quick confirm completes with 0 skipped", () => {
  // No unresolved rows exist -> planSkipRemaining yields nothing, status completed.
  const swept = planSkipRemaining({ skipRemaining: true, handledItemIds: new Set(), unresolvedItemIds: [] });
  assert.deepEqual(swept, []);
  assert.equal(computeConfirmationStatus(0), "completed");
});

test("scenario: hundreds unresolved — 'Salta tutti' skips all, status completed", () => {
  const ids = Array.from({ length: 158 }, (_, i) => `u_${i}`); // avg unresolved from prod
  const swept = planSkipRemaining({ skipRemaining: true, handledItemIds: new Set(), unresolvedItemIds: ids });
  assert.equal(swept.length, 158);
  // After sweeping every leftover, remaining unresolved = 0.
  assert.equal(computeConfirmationStatus(0), "completed");
});

test("scenario: partial manual pass — resolve some, leave the rest, stays awaiting", () => {
  const items = { a: {}, b: {} };
  const { handledItemIds } = planResolutions([
    { itemId: "a", titleId: "t-a" },
    { itemId: "b", skip: true },
  ], items);
  assert.equal(handledItemIds.size, 2);
  // 3 other rows are still unresolved and skipRemaining was NOT requested.
  const swept = planSkipRemaining({ skipRemaining: false, handledItemIds, unresolvedItemIds: ["c", "d", "e"] });
  assert.deepEqual(swept, []);
  assert.equal(computeConfirmationStatus(3), "awaiting_confirmation");
});
