const test = require("node:test");
const assert = require("node:assert/strict");

const {
  matchViaTvdbId,
  findTmdbByTvdbId,
  resolveTitleMatch,
} = require("../../lib/importAdapters/matching");
const { resetTmdbMemoryCache } = require("../../modules/tmdb");

// Fake Firestore: a single "titles" collection with where("==")/
// where("array-contains")/limit/get support (mirrors tmdb-dedup-type.test.cjs's
// makeFakeDb), plus a working .doc(id).get()/.set() for stub-create paths.
function makeFakeDb(initialDocs = []) {
  const store = new Map(initialDocs.map((d) => [d.id, d.data]));

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
        const wrapped = rows.map((d) => ({ id: d.id, data: () => d.data, get: (field) => d.data[field] }));
        return { empty: wrapped.length === 0, docs: wrapped };
      },
    };
  }

  // Separate in-memory map for importMatchCache/{cacheKey} docs — resolveTitleMatch
  // reads/writes this collection ahead of (and after) the titles cascade, so
  // the fake db must support both collections for an end-to-end test.
  const importMatchCacheStore = new Map();

  return {
    store,
    importMatchCacheStore,
    collection(name) {
      if (name === "importMatchCache") {
        return {
          doc(id) {
            return {
              async get() {
                const data = importMatchCacheStore.get(id);
                return { exists: data !== undefined, id, data: () => data };
              },
              async set(payload, opts) {
                const prev = opts?.merge ? (importMatchCacheStore.get(id) || {}) : {};
                // hitCount uses admin.firestore.FieldValue.increment in
                // production; here we just need "starts at 1, increments" —
                // not under test in this file (see importMatchCache.test.cjs).
                importMatchCacheStore.set(id, { ...prev, ...payload, hitCount: (prev.hitCount || 0) + 1 });
              },
            };
          },
        };
      }
      assert.equal(name, "titles");
      return {
        ...makeQuery([]),
        doc(id) {
          return {
            async get() {
              const data = store.get(id);
              return { exists: data !== undefined, id, data: () => data };
            },
            async set(payload, opts) {
              const prev = opts?.merge ? (store.get(id) || {}) : {};
              store.set(id, { ...prev, ...payload });
            },
          };
        },
      };
    },
  };
}

// writeImportMatchCache calls require("firebase-admin") lazily for
// FieldValue.increment/serverTimestamp — stub it so this test file doesn't
// need a real firebase-admin app initialized.
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
test.after(() => {
  Module.prototype.require = originalRequire;
});

function fakeCacheStore() {
  const map = new Map();
  return {
    map,
    async get(key) { return map.get(key) || null; },
    async set(key, value) { map.set(key, value); },
  };
}

test.beforeEach(() => {
  resetTmdbMemoryCache();
});

test("findTmdbByTvdbId returns the first tv_results entry, typed 'tv'", async () => {
  const db = makeFakeDb([]);
  let fetchCalls = 0;
  const row = await findTmdbByTvdbId(db, 385925, {
    cacheStore: fakeCacheStore(),
    fetcher: async (path, params) => {
      fetchCalls += 1;
      assert.equal(path, "/find/385925");
      assert.equal(params.external_source, "tvdb_id");
      return {
        tv_results: [{ id: 65567, name: "Avatar: The Last Airbender", first_air_date: "2024-02-22" }],
        movie_results: [],
      };
    },
  });
  assert.equal(fetchCalls, 1);
  assert.equal(row.type, "tv");
  assert.equal(row.id, 65567);
  assert.equal(row.name, "Avatar: The Last Airbender");
});

test("findTmdbByTvdbId returns null when TMDB has no tv_results for that id", async () => {
  const db = makeFakeDb([]);
  const row = await findTmdbByTvdbId(db, 999999, {
    cacheStore: fakeCacheStore(),
    fetcher: async () => ({ tv_results: [], movie_results: [] }),
  });
  assert.equal(row, null);
});

test("findTmdbByTvdbId returns null for an invalid/non-positive id, without calling fetch", async () => {
  const db = makeFakeDb([]);
  let called = false;
  const row = await findTmdbByTvdbId(db, -1, {
    cacheStore: fakeCacheStore(),
    fetcher: async () => { called = true; return { tv_results: [] }; },
  });
  assert.equal(row, null);
  assert.equal(called, false);
});

test("matchViaTvdbId: existing title doc (by tmdbId) is reused, not re-created", async () => {
  const db = makeFakeDb([
    { id: "tmdb_tv_65567", data: { type: "tv", tmdbId: 65567, nameLower: "avatar the last airbender", year: 2024 } },
  ]);
  const bucket = {};
  const result = await matchViaTvdbId(db, bucket, 385925, {
    cacheStore: fakeCacheStore(),
    fetcher: async () => ({
      tv_results: [{ id: 65567, name: "Avatar: The Last Airbender", first_air_date: "2024-02-22" }],
    }),
  });
  assert.ok(result);
  assert.equal(result.titleId, "tmdb_tv_65567");
  assert.equal(result.strategy, "tvdb_id");
  assert.equal(result.confidence, 1);
});

test("matchViaTvdbId: no existing doc -> stub-creates a new titles doc", async () => {
  const db = makeFakeDb([]);
  const bucket = {}; // uploadTmdbPosterToStorage will fail gracefully (no poster_path) -> url ""
  const result = await matchViaTvdbId(db, bucket, 403294, {
    cacheStore: fakeCacheStore(),
    fetcher: async (path) => {
      if (path.startsWith("/find/")) {
        return { tv_results: [{ id: 136315, name: "The Bear", first_air_date: "2022-06-23" }] };
      }
      return {};
    },
  });
  assert.ok(result);
  assert.equal(result.titleId, "tmdb_tv_136315");
  assert.equal(result.strategy, "tvdb_id_stub_created");
  assert.equal(result.confidence, 1);
  // The stub-created doc actually landed in the fake db.
  assert.ok(db.store.has("tmdb_tv_136315"));
  assert.equal(db.store.get("tmdb_tv_136315").type, "tv");
});

/* ============================= movie tvdb id (Refract) ============================= */

test("findTmdbByTvdbId with expectedType 'movie' reads movie_results, not tv_results", async () => {
  const db = makeFakeDb([]);
  const row = await findTmdbByTvdbId(db, 154, {
    cacheStore: fakeCacheStore(),
    fetcher: async (path, params) => {
      assert.equal(path, "/find/154");
      assert.equal(params.external_source, "tvdb_id");
      return {
        tv_results: [{ id: 999, name: "Wrong Array" }],
        movie_results: [{ id: 671, title: "Harry Potter and the Philosopher's Stone", release_date: "2001-11-16" }],
      };
    },
  }, "movie");
  assert.equal(row.type, "movie");
  assert.equal(row.id, 671);
  assert.equal(row.title, "Harry Potter and the Philosopher's Stone");
});

test("findTmdbByTvdbId defaults to 'tv' expectedType when omitted (GDPR adapter's call shape, unchanged)", async () => {
  const db = makeFakeDb([]);
  const row = await findTmdbByTvdbId(db, 385925, {
    cacheStore: fakeCacheStore(),
    fetcher: async () => ({ tv_results: [{ id: 65567, name: "Avatar" }], movie_results: [{ id: 1, title: "Should not be picked" }] }),
  });
  assert.equal(row.type, "tv");
  assert.equal(row.id, 65567);
});

test("matchViaTvdbId with expectedType 'movie': no existing doc -> stub-creates tmdb_movie_{id}", async () => {
  const db = makeFakeDb([]);
  const bucket = {};
  const result = await matchViaTvdbId(db, bucket, 154, {
    cacheStore: fakeCacheStore(),
    fetcher: async (path) => {
      if (path.startsWith("/find/")) {
        return { movie_results: [{ id: 671, title: "Harry Potter and the Philosopher's Stone", release_date: "2001-11-16" }] };
      }
      return {};
    },
  }, "movie");
  assert.ok(result);
  assert.equal(result.titleId, "tmdb_movie_671");
  assert.equal(result.strategy, "tvdb_id_stub_created");
  assert.ok(db.store.has("tmdb_movie_671"));
  assert.equal(db.store.get("tmdb_movie_671").type, "movie");
});

test("matchViaTvdbId with expectedType 'movie': existing title doc (by tmdbId) is reused, not re-created", async () => {
  const db = makeFakeDb([
    { id: "tmdb_movie_671", data: { type: "movie", tmdbId: 671, nameLower: "harry potter and the philosopher's stone", year: 2001 } },
  ]);
  const result = await matchViaTvdbId(db, {}, 154, {
    cacheStore: fakeCacheStore(),
    fetcher: async () => ({ movie_results: [{ id: 671, title: "Harry Potter and the Philosopher's Stone", release_date: "2001-11-16" }] }),
  }, "movie");
  assert.equal(result.titleId, "tmdb_movie_671");
  assert.equal(result.strategy, "tvdb_id");
});

test("resolveTitleMatch: movie row with ctx.tvdbMovieId resolves via the tvdb-id path, skipping the name cascade", async () => {
  const db = makeFakeDb([
    { id: "tmdb_movie_671", data: { type: "movie", tmdbId: 671, nameLower: "some other name entirely", year: 2001 } },
  ]);
  let searchCalled = false;
  const result = await resolveTitleMatch(db, {}, "Harry Potter and the Philosopher's Stone", "movie", {
    tvdbMovieId: 154,
    cacheStore: fakeCacheStore(),
    fetcher: async (path) => {
      if (path.startsWith("/find/")) {
        return { movie_results: [{ id: 671, title: "Harry Potter", release_date: "2001-11-16" }] };
      }
      searchCalled = true;
      return { results: [] };
    },
  });
  assert.ok(result);
  assert.equal(result.titleId, "tmdb_movie_671");
  assert.equal(result.strategy, "tvdb_id");
  assert.equal(searchCalled, false);
});

test("resolveTitleMatch: a movie's tvdbMovieId and a series' tvdbSeriesId with the SAME numeric id never collide (cache key includes type)", async () => {
  const db = makeFakeDb([]);
  // Shared on purpose: a real TMDB /find/{id} response contains BOTH
  // tv_results AND movie_results in one payload (see matching.js's
  // findTmdbByTvdbId docstring) — the raw-response cache (cacheStore) is
  // legitimately shared for the same id/params regardless of expectedType.
  // What must NOT collide is the resolved-titleId import-match cache
  // (Firestore-level, keyed by name+type+tvdbId) — that's what this test
  // actually verifies, via 2 distinct titleIds out of the SAME cached blob.
  const sharedCacheStore = fakeCacheStore();
  const SAME_ID = 154;
  let fetchCalls = 0;
  const fetcher = async (path) => {
    fetchCalls += 1;
    if (!path.startsWith("/find/")) return {};
    return {
      movie_results: [{ id: 1, title: "Some Movie", release_date: "2020-01-01" }],
      tv_results: [{ id: 2, name: "Some Show", first_air_date: "2020-01-01" }],
    };
  };

  const movieResult = await resolveTitleMatch(db, {}, "Some Movie", "movie", {
    tvdbMovieId: SAME_ID,
    cacheStore: sharedCacheStore,
    fetcher,
  });
  const tvResult = await resolveTitleMatch(db, {}, "Some Show", "tv", {
    tvdbSeriesId: SAME_ID,
    cacheStore: sharedCacheStore,
    fetcher,
  });

  assert.equal(movieResult.titleId, "tmdb_movie_1");
  assert.equal(tvResult.titleId, "tmdb_tv_2");
  // Second call hit the shared raw-response cache (same id/params) — only
  // ONE network fetch for both lookups.
  assert.equal(fetchCalls, 1);
});

test("matchViaTvdbId returns null when TMDB has no mapping for that tvdb id", async () => {
  const db = makeFakeDb([]);
  const result = await matchViaTvdbId(db, {}, 1, {
    cacheStore: fakeCacheStore(),
    fetcher: async () => ({ tv_results: [] }),
  });
  assert.equal(result, null);
});

test("resolveTitleMatch: tv row with ctx.tvdbSeriesId resolves via the tvdb-id path, skipping the name cascade", async () => {
  const db = makeFakeDb([
    { id: "tmdb_tv_65567", data: { type: "tv", tmdbId: 65567, nameLower: "some other name entirely", year: 2024 } },
  ]);
  let searchCalled = false;
  const result = await resolveTitleMatch(db, {}, "Avatar: The Last Airbender (2024)", "tv", {
    tvdbSeriesId: 385925,
    cacheStore: fakeCacheStore(),
    fetcher: async (path) => {
      if (path.startsWith("/find/")) {
        return { tv_results: [{ id: 65567, name: "Avatar", first_air_date: "2024-02-22" }] };
      }
      searchCalled = true;
      return { results: [] };
    },
  });
  assert.ok(result);
  assert.equal(result.titleId, "tmdb_tv_65567");
  assert.equal(result.strategy, "tvdb_id");
  // The nameLower on the existing doc doesn't match the row's name at all —
  // proof this resolved via tvdbId, not the exact/variant name cascade.
  assert.equal(searchCalled, false);
});

test("resolveTitleMatch: second call for the same (name,type) hits the global importMatchCache, skips TMDB entirely", async () => {
  const db = makeFakeDb([
    { id: "tmdb_tv_403294", data: { type: "tv", tmdbId: 403294, nameLower: "the bear", year: 2022 } },
  ]);
  let fetchCalls = 0;
  const sharedCacheStore = fakeCacheStore();

  const first = await resolveTitleMatch(db, {}, "The Bear", "tv", {
    cacheStore: sharedCacheStore,
    fetcher: async (path) => {
      fetchCalls += 1;
      if (path === "/search/tv") return { results: [{ id: 403294, name: "The Bear", first_air_date: "2022-06-23" }] };
      return {};
    },
  });
  assert.ok(first?.titleId);
  assert.equal(db.importMatchCacheStore.size, 1); // cache entry written after first resolution

  const secondFetchCallsBefore = fetchCalls;
  const second = await resolveTitleMatch(db, {}, "The Bear", "tv", {
    cacheStore: sharedCacheStore,
    fetcher: async () => {
      fetchCalls += 1;
      return { results: [] }; // would NOT resolve if the cascade actually ran
    },
  });
  assert.equal(second.titleId, first.titleId);
  assert.ok(second.strategy.startsWith("cache_"));
  assert.equal(fetchCalls, secondFetchCallsBefore); // no network call on the cache hit
});
