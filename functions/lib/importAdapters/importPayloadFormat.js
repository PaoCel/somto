"use strict";

const { parseCsv } = require("./csv");

const TV_TIME_SOURCES = new Set(["tvtime_gdpr", "tvtime_refract"]);

function stripBom(value) {
  return String(value || "").replace(/^\uFEFF/, "").trim();
}

function classifyJsonArray(text) {
  const clean = stripBom(text);
  if (!clean) return "missing";
  try {
    return Array.isArray(JSON.parse(clean)) ? "tvtime_refract" : "unknown";
  } catch (_err) {
    return null;
  }
}

function classifyGdprCsv(text, kind) {
  const clean = stripBom(text);
  if (!clean) return "missing";
  let table;
  try {
    // TV Time headers never contain embedded newlines. Parsing only the first
    // record avoids allocating a second full in-memory copy of multi-MB CSVs
    // before the real parser runs.
    table = parseCsv(clean.split(/\r?\n/, 1)[0]);
  } catch (_err) {
    return "unknown";
  }
  if (!Array.isArray(table) || !Array.isArray(table[0])) return "unknown";
  const header = new Set(table[0].map((value) => String(value || "").trim().toLowerCase()));
  const valid = kind === "movies"
    ? header.has("type") && header.has("movie_name")
    : header.has("key") && header.has("series_name");
  return valid ? "tvtime_gdpr" : "unknown";
}

function auditedTvTimePayloadSource(currentData = {}) {
  const requestedSource = String(currentData.requestedSource || "").trim().toLowerCase();
  const effectiveSource = String(currentData.source || "").trim().toLowerCase();
  const detectedFormat = String(currentData.detectedSource || "").trim().toLowerCase();
  if (
    !TV_TIME_SOURCES.has(requestedSource)
    || !TV_TIME_SOURCES.has(effectiveSource)
    || detectedFormat !== effectiveSource
    || typeof currentData.sourceAutoDetected !== "boolean"
    || currentData.sourceAutoDetected !== (requestedSource !== effectiveSource)
  ) {
    return null;
  }
  return {
    valid: true,
    requestedSource,
    effectiveSource,
    autoDetected: currentData.sourceAutoDetected,
    detectedFormat,
  };
}

function classifyCoreFile(text, kind) {
  const jsonKind = classifyJsonArray(text);
  if (jsonKind) return jsonKind;
  return classifyGdprCsv(text, kind);
}

/**
 * Detects only the two TV Time formats that share the movies/series upload
 * slots. Extensions and MIME types are intentionally ignored: the server
 * validates the actual structure. Mixed/unknown payloads fail closed.
 */
function detectTvTimePayloadSource(requestedSource, loaded = {}) {
  const requested = String(requestedSource || "").trim().toLowerCase();
  if (!TV_TIME_SOURCES.has(requested)) {
    return {
      valid: true,
      requestedSource: requested,
      effectiveSource: requested,
      autoDetected: false,
      detectedFormat: null,
    };
  }

  const classifications = [
    classifyCoreFile(loaded.moviesText, "movies"),
    classifyCoreFile(loaded.seriesText, "series"),
  ];
  const present = classifications.filter((kind) => kind !== "missing");
  const detected = Array.from(new Set(present));
  if (present.length === 0) {
    return {
      valid: false,
      requestedSource: requested,
      effectiveSource: requested,
      autoDetected: false,
      detectedFormat: null,
      reason: "File TV Time mancanti.",
    };
  }
  if (detected.length !== 1 || detected[0] === "unknown") {
    return {
      valid: false,
      requestedSource: requested,
      effectiveSource: requested,
      autoDetected: false,
      detectedFormat: null,
      reason: "I file TV Time hanno formati diversi o non riconoscibili.",
    };
  }

  const effectiveSource = detected[0];
  return {
    valid: true,
    requestedSource: requested,
    effectiveSource,
    autoDetected: effectiveSource !== requested,
    detectedFormat: effectiveSource,
  };
}

module.exports = {
  classifyCoreFile,
  auditedTvTimePayloadSource,
  detectTvTimePayloadSource,
};
