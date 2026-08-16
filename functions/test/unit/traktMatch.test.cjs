const test = require("node:test");
const assert = require("node:assert/strict");

const { matchViaTmdbId } = require("../../lib/importAdapters/matching");

// Minimal in-memory Firestore fake supporting BOTH the where(...).limit(...).get()
// queries existsLogicalDuplicateTitle needs AND doc(id).get()/set() for the
// title docs. `titles` is a Map of id -> data.
function makeFakeDb(titles) {
  const store = new Map(Object.entries(titles || {}));

  function makeQuery(filters) {
    return {
      where(field, op, value) {
        return makeQuery([...filters, { field, op, value }]);
      },
      limit(n) {
        return makeQuery([...filters, { op: "limit", value: n }]);
      },
      async get() {
        let rows = Array.from(store.entries()).map(([id, data]) => ({ id, data }));
        let cap = Infinity;
        for (const f of filters) {
          if (f.op === "limit") cap = f.value;
          else if (f.op === "==") rows = rows.filter((d) => d.data[f.field] === f.value);
          else if (f.op === "array-contains") {
            rows = rows.filter((d) => Array.isArray(d.data[f.field]) && d.data[f.field].includes(f.value));
          }
        }
        rows = rows.slice(0, cap);
        const wrapped = rows.map((d) => ({
          id: d.id,
          data: () => d.data,
          get: (field) => d.data[field],
        }));
        return { empty: wrapped.length === 0, docs: wrapped };
      },
    };
  }

  return {
    _store: store,
    collection(name) {
      assert.equal(name, "titles");
      return {
        where(field, op, value) {
          return makeQuery([{ field, op, value }]);
        },
        doc(id) {
          return {
            async get() {
              const data = store.get(id);
              return { exists: data != null, id, data: () => data };
            },
            async set(data, opts) {
              const prev = opts?.merge ? store.get(id) || {} : {};
              store.set(id, { ...prev, ...data });
            },
          };
        },
      };
    },
  };
}

// A bucket whose file().save() is a no-op (upsertTmdbTitle only touches it via
// uploadTmdbPosterToStorage, which early-returns when the row has no
// poster_path — so save() is never actually reached in these tests).
function makeFakeBucket() {
  return {
    name: "test-bucket",
    file() {
      return { async save() {} };
    },
  };
}

// A cacheStore seam (fetchTmdbCachedJson supports get/set) that always misses,
// forcing the fetcher to be used and NOT touching Firestore for caching.
function makeMissCacheStore() {
  return {
    async get() { return null; },
    async set() {},
  };
}

// A fetcher seam returning canned TMDB /movie/{id} or /tv/{id} details.
function makeFetcher(detailsByPath) {
  return async (path) => {
    if (path in detailsByPath) return detailsByPath[path];
    throw new Error(`unexpected fetch ${path}`);
  };
}

/* ============================= existing-title hit ============================= */

test("matchViaTmdbId resolves to an EXISTING title doc (no stub created) when the tmdb id is already in the catalog", async () => {
  const db = makeFakeDb({
    tmdb_movie_157336: { type: "movie", tmdbId: 157336, name: "Interstellar", nameLower: "interstellar", year: 2014 },
  });
  const fetcher = makeFetcher({
    "/movie/157336": { id: 157336, title: "Interstellar", release_date: "2014-11-06", poster_path: null },
  });

  const result = await matchViaTmdbId(db, makeFakeBucket(), 157336, "movie", {
    fetcher,
    cacheStore: makeMissCacheStore(),
    logicalDupCache: new Map(),
  });

  assert.ok(result);
  assert.equal(result.titleId, "tmdb_movie_157336");
  assert.equal(result.confidence, 1);
  assert.equal(result.strategy, "tmdb_id");
  // No new doc should have been created.
  assert.equal(db._store.size, 1);
});

/* ============================= stub-create path ============================= */

test("matchViaTmdbId stub-creates a new movie title doc when the tmdb id is not in the catalog", async () => {
  const db = makeFakeDb({}); // empty catalog
  const fetcher = makeFetcher({
    "/movie/999": { id: 999, title: "Brand New Movie", release_date: "2025-01-01", poster_path: null },
  });

  const result = await matchViaTmdbId(db, makeFakeBucket(), 999, "movie", {
    fetcher,
    cacheStore: makeMissCacheStore(),
    logicalDupCache: new Map(),
  });

  assert.ok(result);
  assert.equal(result.titleId, "tmdb_movie_999");
  assert.equal(result.confidence, 1);
  assert.equal(result.strategy, "tmdb_id_stub_created");
  // The stub doc now exists.
  assert.ok(db._store.has("tmdb_movie_999"));
  assert.equal(db._store.get("tmdb_movie_999").tmdbId, 999);
});

/* ============================= guards ============================= */

test("matchViaTmdbId returns null for an invalid tmdb id (no fetch attempted)", async () => {
  const db = makeFakeDb({});
  const fetcher = makeFetcher({}); // any call throws
  assert.equal(await matchViaTmdbId(db, makeFakeBucket(), 0, "movie", { fetcher, cacheStore: makeMissCacheStore() }), null);
  assert.equal(await matchViaTmdbId(db, makeFakeBucket(), -1, "movie", { fetcher, cacheStore: makeMissCacheStore() }), null);
  assert.equal(await matchViaTmdbId(db, makeFakeBucket(), "abc", "movie", { fetcher, cacheStore: makeMissCacheStore() }), null);
});

test("matchViaTmdbId picks the /tv/{id} endpoint for expectedType tv", async () => {
  const db = makeFakeDb({
    tmdb_tv_1396: { type: "tv", tmdbId: 1396, name: "Breaking Bad", nameLower: "breaking bad", year: 2008 },
  });
  const fetcher = makeFetcher({
    "/tv/1396": { id: 1396, name: "Breaking Bad", first_air_date: "2008-01-20", poster_path: null },
  });
  const result = await matchViaTmdbId(db, makeFakeBucket(), 1396, "tv", {
    fetcher,
    cacheStore: makeMissCacheStore(),
    logicalDupCache: new Map(),
  });
  assert.equal(result.titleId, "tmdb_tv_1396");
  assert.equal(result.strategy, "tmdb_id");
});
