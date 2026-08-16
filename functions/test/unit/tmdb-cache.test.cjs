const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildTmdbCacheDocId,
  fetchTmdbCachedJson,
  resetTmdbMemoryCache,
} = require("../../modules/tmdb");

function buildStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    async get(key) {
      return map.get(key) || null;
    },
    async set(key, value) {
      map.set(key, value);
    },
  };
}

test("buildTmdbCacheDocId is deterministic regardless params order", () => {
  const first = buildTmdbCacheDocId(
    "/search/multi",
    { query: "dune", page: 1, language: "it-IT" },
    "searchMulti"
  );
  const second = buildTmdbCacheDocId(
    "/search/multi",
    { language: "it-IT", page: 1, query: "dune" },
    "searchmulti"
  );
  assert.equal(first, second);
});

test("fetchTmdbCachedJson returns cache hit without network when entry is fresh", async () => {
  resetTmdbMemoryCache();
  const now = Date.now();
  const docId = buildTmdbCacheDocId(
    "/search/multi",
    { query: "blade runner", language: "it-IT", page: 1 },
    "searchMulti"
  );

  const store = buildStore({
    [docId]: {
      payload: { results: [{ id: 101 }] },
      expiresAtMs: now + 60_000,
      updatedAtMs: now - 1_000,
    },
  });

  let fetchCalls = 0;
  const out = await fetchTmdbCachedJson(
    "/search/multi",
    { language: "it-IT", page: 1, query: "blade runner" },
    {
      cacheScope: "searchmulti",
      ttlSeconds: 3600,
      cacheStore: store,
      fetcher: async () => {
        fetchCalls += 1;
        return { results: [] };
      },
    }
  );

  assert.equal(fetchCalls, 0);
  assert.equal(out.cache.hit, true);
  assert.equal(out.cache.stale, false);
  assert.equal(out.cache.source, "firestore");
  assert.equal(out.data.results[0].id, 101);
});

test("fetchTmdbCachedJson returns stale cache when network fails", async () => {
  resetTmdbMemoryCache();
  const now = Date.now();
  const docId = buildTmdbCacheDocId(
    "/movie/550/videos",
    { language: "it-IT" },
    "videos"
  );

  const store = buildStore({
    [docId]: {
      payload: { results: [{ key: "stale-trailer" }] },
      expiresAtMs: now - 5_000,
      updatedAtMs: now - 10_000,
    },
  });

  const out = await fetchTmdbCachedJson(
    "/movie/550/videos",
    { language: "it-IT" },
    {
      cacheScope: "videos",
      ttlSeconds: 3600,
      allowStaleOnError: true,
      cacheStore: store,
      fetcher: async () => {
        throw new Error("tmdb unavailable");
      },
    }
  );

  assert.equal(out.cache.hit, true);
  assert.equal(out.cache.stale, true);
  assert.equal(out.cache.source, "stale");
  assert.equal(out.data.results[0].key, "stale-trailer");
});

