"use strict";

// Global cross-user title-match cache for viewing-history imports
// (Netflix CSV, TV Time GDPR, future sources). The matching cascade in
// matching.js is the expensive part of an import (Firestore lookups + TMDB
// search + possible stub-create); when TV Time shuts down on 2026-07-15 many
// users will import similar, overlapping catalogs (the same popular shows)
// in a short window. This cache lets a resolution found for ONE user's
// import be reused for every subsequent import that hits the same
// normalized (title, type, year?, tvdbId?) key — server-only, admin SDK,
// deny-all to clients.
//
// Collection: importMatchCache/{cacheKey}
//   cacheKey = sha256("norm(title)|type|year?|tvdbId?").slice(0, 40)
//   doc = {
//     titleId: string,          // resolved titles/{id} doc id
//     resolvedAsType: "movie"|"tv",
//     confidence: number,
//     strategy: string,         // which matching.js strategy resolved this
//     cacheKeyInputs: {...},    // debug/audit trail, not used for lookups
//     hitCount: number,         // FieldValue.increment'd on every cache hit
//     updatedAt: timestamp,
//   }
//
// NO negative caching: unresolved rows are NOT cached, so they always retry
// the full cascade (a title might get imported/stub-created moments later by
// another user's import, or added to the catalog by an admin — we want the
// next attempt to find it). No TTL/expiry is enforced today (`updatedAt` is
// kept for a future logical-expiry pass if the catalog churns); a cache hit
// pointing at a titleId that's since been deleted is handled defensively by
// the caller (matching.js re-validates the doc still exists).

const { createHash } = require("crypto");
const { normalizeText } = require("../../modules/tmdb");

const CACHE_COLLECTION = "importMatchCache";
const CACHE_KEY_MAX_LEN = 40;

function sha256Hex(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

/**
 * Builds the deterministic cache key for a (name, type, year?, tvdbId?, tmdbId?)
 * lookup. `year`/`tvdbId`/`tmdbId` are optional disambiguators — when present
 * they narrow the key so e.g. two different movies that happen to share a name
 * but different release years don't collide. `tmdbId` (Trakt only) is the
 * strongest disambiguator: a Trakt import carries the exact TMDB id, so
 * including it short-circuits repeat shows to 0 TMDB calls across the whole
 * import wave (additive — only Trakt rows set it; existing keys for
 * name/year/tvdb-only lookups are unchanged when tmdbId is absent).
 */
function buildImportMatchCacheKey({ name, expectedType, year, tvdbSeriesId, tmdbId } = {}) {
  const normalizedName = normalizeText(name);
  const tmdbPart = tmdbId != null && Number.isFinite(Number(tmdbId)) ? String(Number(tmdbId)) : "";
  // A Trakt row has a deterministic tmdb id even when the name is empty/absent
  // (unlikely, but the id alone is a valid, sufficient key); only require a
  // name when there is no tmdb id.
  if (!normalizedName && !tmdbPart) return null;
  const type = expectedType === "tv" ? "tv" : "movie";
  const yearPart = year != null && Number.isFinite(Number(year)) ? String(Number(year)) : "";
  const tvdbPart = tvdbSeriesId != null && Number.isFinite(Number(tvdbSeriesId)) ? String(Number(tvdbSeriesId)) : "";
  const raw = `${normalizedName}|${type}|${yearPart}|${tvdbPart}|${tmdbPart}`;
  return sha256Hex(raw).slice(0, CACHE_KEY_MAX_LEN);
}

/**
 * Reads a cache entry. Returns null on miss (never throws — a cache-read
 * failure should never block the matching cascade, it just falls through to
 * the full resolution path).
 */
async function readImportMatchCache(db, cacheKey) {
  if (!cacheKey) return null;
  try {
    const snap = await db.collection(CACHE_COLLECTION).doc(cacheKey).get();
    if (!snap.exists) return null;
    const data = snap.data() || {};
    if (!data.titleId) return null;
    return {
      titleId: String(data.titleId),
      resolvedAsType: data.resolvedAsType === "tv" ? "tv" : "movie",
      confidence: Number(data.confidence || 0),
      strategy: data.strategy || "cache",
    };
  } catch (err) {
    return null;
  }
}

/**
 * Writes/updates a cache entry after a successful resolution. Fire-and-forget
 * from the caller's perspective (failures are swallowed — the cache is a
 * pure optimization, never a correctness dependency). `hitCount` starts at 1
 * on first write and increments on every subsequent write to the same key
 * (each write IS a hit: either the first resolution or a repeat resolution
 * that re-confirms the cache would have been correct).
 */
async function writeImportMatchCache(db, cacheKey, { titleId, resolvedAsType, confidence, strategy, cacheKeyInputs } = {}) {
  if (!cacheKey || !titleId) return;
  const admin = require("firebase-admin");
  try {
    await db.collection(CACHE_COLLECTION).doc(cacheKey).set({
      titleId: String(titleId),
      resolvedAsType: resolvedAsType === "tv" ? "tv" : "movie",
      confidence: Number(confidence || 0),
      strategy: String(strategy || "unknown"),
      cacheKeyInputs: cacheKeyInputs || null,
      hitCount: admin.firestore.FieldValue.increment(1),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (err) {
    // Best-effort: never let a cache-write failure surface to the caller.
  }
}

module.exports = {
  CACHE_COLLECTION,
  buildImportMatchCacheKey,
  readImportMatchCache,
  writeImportMatchCache,
};
