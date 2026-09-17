"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyCoreFile,
  auditedTvTimePayloadSource,
  detectTvTimePayloadSource,
} = require("../../lib/importAdapters/importPayloadFormat");

const MOVIES_CSV = "type,movie_name,created_at\nwatch,Arrival,2026-01-01";
const SERIES_CSV = "key,series_name,created_at\nwatch-episode,Dark,2026-01-01";
const MOVIES_JSON = JSON.stringify([{ title: "Arrival", is_watched: true }]);
const SERIES_JSON = JSON.stringify([{ title: "Dark", seasons: [] }]);

test("recognizes Refract JSON arrays despite BOM and whitespace", () => {
  assert.equal(classifyCoreFile(`\uFEFF \n${MOVIES_JSON}`, "movies"), "tvtime_refract");
});

test("recognizes canonical GDPR headers", () => {
  assert.equal(classifyCoreFile(MOVIES_CSV, "movies"), "tvtime_gdpr");
  assert.equal(classifyCoreFile(SERIES_CSV, "series"), "tvtime_gdpr");
});

test("auto-corrects Refract uploaded through the GDPR route", () => {
  assert.deepEqual(detectTvTimePayloadSource("tvtime_gdpr", {
    moviesText: MOVIES_JSON,
    seriesText: SERIES_JSON,
  }), {
    valid: true,
    requestedSource: "tvtime_gdpr",
    effectiveSource: "tvtime_refract",
    autoDetected: true,
    detectedFormat: "tvtime_refract",
  });
});

test("auto-corrects GDPR uploaded through the Refract route", () => {
  const result = detectTvTimePayloadSource("tvtime_refract", {
    moviesText: MOVIES_CSV,
    seriesText: SERIES_CSV,
  });
  assert.equal(result.valid, true);
  assert.equal(result.effectiveSource, "tvtime_gdpr");
  assert.equal(result.autoDetected, true);
});

test("accepts a single structurally valid core file", () => {
  const result = detectTvTimePayloadSource("tvtime_gdpr", { moviesText: MOVIES_JSON });
  assert.equal(result.valid, true);
  assert.equal(result.effectiveSource, "tvtime_refract");
});

test("fails closed for mixed, malformed, object and missing payloads", () => {
  assert.equal(detectTvTimePayloadSource("tvtime_gdpr", {
    moviesText: MOVIES_JSON,
    seriesText: SERIES_CSV,
  }).valid, false);
  assert.equal(detectTvTimePayloadSource("tvtime_gdpr", {
    moviesText: "{bad",
  }).valid, false);
  assert.equal(detectTvTimePayloadSource("tvtime_gdpr", {
    moviesText: JSON.stringify({ title: "not-an-array" }),
  }).valid, false);
  assert.equal(detectTvTimePayloadSource("tvtime_gdpr", {}).valid, false);
});

test("leaves non-TV-Time sources untouched", () => {
  const result = detectTvTimePayloadSource("netflix_csv", { moviesText: MOVIES_JSON });
  assert.equal(result.valid, true);
  assert.equal(result.effectiveSource, "netflix_csv");
  assert.equal(result.autoDetected, false);
});

test("reuses only a coherent server-owned detection audit", () => {
  assert.deepEqual(auditedTvTimePayloadSource({
    requestedSource: "tvtime_gdpr",
    source: "tvtime_refract",
    detectedSource: "tvtime_refract",
    sourceAutoDetected: true,
  }), {
    valid: true,
    requestedSource: "tvtime_gdpr",
    effectiveSource: "tvtime_refract",
    autoDetected: true,
    detectedFormat: "tvtime_refract",
  });
  assert.equal(auditedTvTimePayloadSource({
    requestedSource: "tvtime_gdpr",
    source: "tvtime_refract",
    detectedSource: "tvtime_gdpr",
    sourceAutoDetected: true,
  }), null);
});
