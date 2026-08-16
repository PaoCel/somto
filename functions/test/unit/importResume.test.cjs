"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { computeMatchWindow, buildMatchResultsFromItems } = require("../../lib/importAdapters/resumeMatch");
const { parseTvTimeGdprCsvs } = require("../../lib/importAdapters/tvTimeGdpr");
const { parseNetflixCsv } = require("../../lib/importAdapters/netflixCsv");

/* ============================= computeMatchWindow ============================= */

test("computeMatchWindow: first window from cursor 0", () => {
  assert.deepEqual(computeMatchWindow(0, 1000, 400), { start: 0, end: 400 });
});

test("computeMatchWindow: mid-file window advances by windowMax", () => {
  assert.deepEqual(computeMatchWindow(400, 1000, 400), { start: 400, end: 800 });
});

test("computeMatchWindow: last partial window is clamped to total", () => {
  assert.deepEqual(computeMatchWindow(800, 1000, 400), { start: 800, end: 1000 });
});

test("computeMatchWindow: cursor already at total -> empty window (start==end)", () => {
  assert.deepEqual(computeMatchWindow(1000, 1000, 400), { start: 1000, end: 1000 });
});

test("computeMatchWindow: cursor past total is clamped (never negative-length)", () => {
  const w = computeMatchWindow(5000, 1000, 400);
  assert.equal(w.start, 1000);
  assert.equal(w.end, 1000);
});

test("computeMatchWindow: windowMax larger than remaining rows", () => {
  assert.deepEqual(computeMatchWindow(0, 10, 400), { start: 0, end: 10 });
});

/* ======================= buildMatchResultsFromItems ======================= */

const itemIdFor = (row) => `id:${row.rawTitle}`;

function makeRows(names) {
  return names.map((rawTitle) => ({ rawTitle, kind: "movie" }));
}

test("buildMatchResultsFromItems: resolved item with present title -> resolved match", () => {
  const rows = makeRows(["Inception"]);
  const itemById = new Map([["id:Inception", { resolved: true, titleId: "t1", resolvedAsType: "movie", confidence: 0.9, strategy: "tmdb_search", skip: false }]]);
  const titleById = new Map([["t1", { name: "Inception", type: "movie" }]]);
  const out = buildMatchResultsFromItems({ rows, itemById, titleById, itemIdFor });
  assert.equal(out.length, 1);
  assert.equal(out[0].match.resolved, true);
  assert.equal(out[0].match.titleId, "t1");
  assert.deepEqual(out[0].match.title, { name: "Inception", type: "movie" });
  assert.equal(out[0].match.confidence, 0.9);
  assert.equal(out[0].match.strategy, "tmdb_search");
});

test("buildMatchResultsFromItems: user-skipped item -> unresolved (never written)", () => {
  const rows = makeRows(["Skipme"]);
  const itemById = new Map([["id:Skipme", { resolved: true, titleId: "t2", skip: true }]]);
  const titleById = new Map([["t2", { name: "Skipme" }]]);
  const out = buildMatchResultsFromItems({ rows, itemById, titleById, itemIdFor });
  assert.equal(out[0].match.resolved, false);
  assert.equal(out[0].match.titleId, null);
});

test("buildMatchResultsFromItems: resolved item but title doc vanished -> unresolved (no crash)", () => {
  const rows = makeRows(["Ghost"]);
  const itemById = new Map([["id:Ghost", { resolved: true, titleId: "gone" }]]);
  const titleById = new Map(); // title fetch came back empty
  const out = buildMatchResultsFromItems({ rows, itemById, titleById, itemIdFor });
  assert.equal(out[0].match.resolved, false);
  assert.equal(out[0].match.title, null);
});

test("buildMatchResultsFromItems: row with no persisted item -> unresolved", () => {
  const rows = makeRows(["Never matched"]);
  const out = buildMatchResultsFromItems({ rows, itemById: new Map(), titleById: new Map(), itemIdFor });
  assert.equal(out[0].match.resolved, false);
});

test("buildMatchResultsFromItems: preserves row order and one entry per row", () => {
  const rows = makeRows(["A", "B", "C"]);
  const itemById = new Map([
    ["id:A", { resolved: true, titleId: "ta" }],
    ["id:C", { resolved: true, titleId: "tc" }],
  ]);
  const titleById = new Map([["ta", { name: "A" }], ["tc", { name: "C" }]]);
  const out = buildMatchResultsFromItems({ rows, itemById, titleById, itemIdFor });
  assert.deepEqual(out.map((r) => r.row.rawTitle), ["A", "B", "C"]);
  assert.deepEqual(out.map((r) => r.match.resolved), [true, false, true]);
});

test("buildMatchResultsFromItems: reconstruction is deterministic across repeated calls (resume idempotency)", () => {
  const rows = makeRows(["A", "B"]);
  const itemById = new Map([["id:A", { resolved: true, titleId: "ta", confidence: 1 }]]);
  const titleById = new Map([["ta", { name: "A" }]]);
  const a = buildMatchResultsFromItems({ rows, itemById, titleById, itemIdFor });
  const b = buildMatchResultsFromItems({ rows, itemById, titleById, itemIdFor });
  assert.deepEqual(a, b);
});

/* ================= large-library parsing (past the old 5000 cap) ================= */

test("parseTvTimeGdprCsvs: parses a 7000-movie export (well past the old 5000-row cap)", () => {
  const header = "type,movie_name,release_date,runtime,created_at,rewatch_count";
  const lines = [header];
  const N = 7000;
  for (let i = 0; i < N; i += 1) {
    lines.push(`watch,Movie ${i},2020-01-01,7200,2024-01-01 12:00:00,0`);
  }
  const { rows, errors } = parseTvTimeGdprCsvs({ moviesCsv: lines.join("\n"), seriesCsv: "" });
  assert.equal(rows.length, N);
  // The only permissible "error" here is the empty-series-file notice (we
  // passed no series CSV); no movie row should have failed to parse.
  assert.equal(errors.filter((e) => /film/i.test(e.reason || "")).length, 0);
  assert.equal(rows[0].kind, "movie");
  assert.equal(rows[N - 1].movieNameGuess, `Movie ${N - 1}`);
});

test("parseTvTimeGdprCsvs: handles a >1MB movies CSV without error (the old Firestore-doc transport would have failed)", () => {
  const header = "type,movie_name,release_date,runtime,created_at,rewatch_count";
  const lines = [header];
  // Pad the title so the whole CSV comfortably exceeds 1MB with a realistic
  // row count — the point is that PARSING scales; the size only mattered for
  // the old single-doc transport, now replaced by the Storage upload path.
  const pad = "X".repeat(120);
  const N = 8000;
  for (let i = 0; i < N; i += 1) {
    lines.push(`watch,Movie ${i} ${pad},2020-01-01,7200,2024-01-01 12:00:00,0`);
  }
  const csv = lines.join("\n");
  assert.ok(Buffer.byteLength(csv, "utf8") > 1024 * 1024, "test fixture should exceed 1MB");
  const { rows } = parseTvTimeGdprCsvs({ moviesCsv: csv, seriesCsv: "" });
  assert.equal(rows.length, N);
});

test("parseNetflixCsv: parses a 6000-row viewing history", () => {
  const lines = ["Title,Date"];
  const N = 6000;
  for (let i = 0; i < N; i += 1) {
    lines.push(`Some Movie ${i},1/2/24`);
  }
  const { rows } = parseNetflixCsv(lines.join("\n"));
  assert.equal(rows.length, N);
});
