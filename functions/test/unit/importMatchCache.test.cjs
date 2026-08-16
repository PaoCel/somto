const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CACHE_COLLECTION,
  buildImportMatchCacheKey,
  readImportMatchCache,
  writeImportMatchCache,
} = require("../../lib/importAdapters/importMatchCache");

// Minimal fake Firestore: a single "importMatchCache" collection keyed by
// doc id, supporting .doc(id).get()/.set(payload, {merge}).
function makeFakeDb(initialDocs = {}) {
  const store = new Map(Object.entries(initialDocs));
  return {
    store,
    collection(name) {
      assert.equal(name, CACHE_COLLECTION);
      return {
        doc(id) {
          return {
            async get() {
              const data = store.get(id);
              return {
                exists: data !== undefined,
                data: () => data,
              };
            },
            async set(payload, opts) {
              const prev = opts?.merge ? (store.get(id) || {}) : {};
              // Simulate admin.firestore.FieldValue.increment(n) resolving
              // against the previous stored value (the real SDK does this
              // server-side; we only need "increments by n" semantics here).
              const merged = { ...prev, ...payload };
              if (payload.hitCount && payload.hitCount.__increment !== undefined) {
                merged.hitCount = (prev.hitCount || 0) + payload.hitCount.__increment;
              }
              store.set(id, merged);
            },
          };
        },
      };
    },
  };
}

// Stub admin.firestore.FieldValue.increment so writeImportMatchCache's
// `require("firebase-admin")` call resolves to something usable in this
// unit test (no real firebase-admin initialization needed for this path).
const Module = require("node:module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function patchedRequire(id) {
  if (id === "firebase-admin") {
    return {
      firestore: {
        FieldValue: {
          increment: (n) => ({ __increment: n }),
          serverTimestamp: () => ({ __serverTimestamp: true }),
        },
      },
    };
  }
  return originalRequire.apply(this, arguments);
};

test("buildImportMatchCacheKey is deterministic and normalizes the name", () => {
  const a = buildImportMatchCacheKey({ name: "The Bear", expectedType: "tv" });
  const b = buildImportMatchCacheKey({ name: "  the   BEAR  ", expectedType: "tv" });
  assert.equal(a, b);
});

test("buildImportMatchCacheKey differentiates by type", () => {
  const movie = buildImportMatchCacheKey({ name: "Dune", expectedType: "movie" });
  const tv = buildImportMatchCacheKey({ name: "Dune", expectedType: "tv" });
  assert.notEqual(movie, tv);
});

test("buildImportMatchCacheKey differentiates by year and tvdbSeriesId", () => {
  const base = buildImportMatchCacheKey({ name: "Rome", expectedType: "tv" });
  const withYear = buildImportMatchCacheKey({ name: "Rome", expectedType: "tv", year: 2005 });
  const withTvdb = buildImportMatchCacheKey({ name: "Rome", expectedType: "tv", tvdbSeriesId: 1891 });
  assert.notEqual(base, withYear);
  assert.notEqual(base, withTvdb);
  assert.notEqual(withYear, withTvdb);
});

test("buildImportMatchCacheKey returns null for an empty/blank name", () => {
  assert.equal(buildImportMatchCacheKey({ name: "", expectedType: "movie" }), null);
  assert.equal(buildImportMatchCacheKey({ name: "   ", expectedType: "movie" }), null);
});

test("readImportMatchCache: miss returns null", async () => {
  const db = makeFakeDb({});
  const result = await readImportMatchCache(db, "some_key");
  assert.equal(result, null);
});

test("readImportMatchCache: miss on falsy cacheKey never touches Firestore", async () => {
  const result = await readImportMatchCache(null, null);
  assert.equal(result, null);
});

test("writeImportMatchCache then readImportMatchCache: hit returns the written match", async () => {
  const db = makeFakeDb({});
  const key = buildImportMatchCacheKey({ name: "The Bear", expectedType: "tv" });

  await writeImportMatchCache(db, key, {
    titleId: "tmdb_tv_403294",
    resolvedAsType: "tv",
    confidence: 1,
    strategy: "tvdb_id",
  });

  const hit = await readImportMatchCache(db, key);
  assert.ok(hit);
  assert.equal(hit.titleId, "tmdb_tv_403294");
  assert.equal(hit.resolvedAsType, "tv");
  assert.equal(hit.confidence, 1);
  assert.equal(hit.strategy, "tvdb_id");
});

test("writeImportMatchCache increments hitCount on repeated writes to the same key", async () => {
  const db = makeFakeDb({});
  const key = buildImportMatchCacheKey({ name: "Dune", expectedType: "movie", year: 2021 });

  await writeImportMatchCache(db, key, { titleId: "tmdb_movie_438631", resolvedAsType: "movie", confidence: 0.9, strategy: "tmdb_existing" });
  await writeImportMatchCache(db, key, { titleId: "tmdb_movie_438631", resolvedAsType: "movie", confidence: 0.9, strategy: "tmdb_existing" });
  await writeImportMatchCache(db, key, { titleId: "tmdb_movie_438631", resolvedAsType: "movie", confidence: 0.9, strategy: "tmdb_existing" });

  assert.equal(db.store.get(key).hitCount, 3);
});

test("writeImportMatchCache is a no-op when titleId is missing", async () => {
  const db = makeFakeDb({});
  const key = buildImportMatchCacheKey({ name: "Ghost", expectedType: "movie" });
  await writeImportMatchCache(db, key, { titleId: null });
  assert.equal(db.store.has(key), false);
});

test("writeImportMatchCache never throws even if the Firestore write fails", async () => {
  const failingDb = {
    collection: () => ({
      doc: () => ({
        set: async () => { throw new Error("boom"); },
      }),
    }),
  };
  await assert.doesNotReject(writeImportMatchCache(failingDb, "some_key", { titleId: "t1" }));
});

test("readImportMatchCache never throws even if the Firestore read fails", async () => {
  const failingDb = {
    collection: () => ({
      doc: () => ({
        get: async () => { throw new Error("boom"); },
      }),
    }),
  };
  const result = await readImportMatchCache(failingDb, "some_key");
  assert.equal(result, null);
});

// Restore the original require so subsequent test files in the same
// `node --test` run (which shares the process) aren't affected.
test.after(() => {
  Module.prototype.require = originalRequire;
});
