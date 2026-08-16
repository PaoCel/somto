const test = require("node:test");
const assert = require("node:assert/strict");
const { fetchTmdbRecentCandidatesForType } = require("../../modules/tmdb");

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    async json() {
      return payload;
    },
  };
}

test("fetchTmdbRecentCandidatesForType rotates pages and stops when exhausted", async () => {
  const prevFetch = global.fetch;
  const prevKey = process.env.TMDB_KEY;
  process.env.TMDB_KEY = "test_tmdb_key";

  global.fetch = async (urlString) => {
    const url = new URL(urlString);
    const page = Number(url.searchParams.get("page") || "1");
    const type = String(url.pathname || "").includes("/discover/tv") ? "tv" : "movie";
    return jsonResponse({
      total_pages: 6,
      results: [{
        id: page * 100 + (type === "tv" ? 2 : 1),
        title: type === "movie" ? `Movie ${page}` : undefined,
        name: type === "tv" ? `Show ${page}` : undefined,
        release_date: `2025-01-${String(Math.min(28, page)).padStart(2, "0")}`,
        first_air_date: `2025-01-${String(Math.min(28, page)).padStart(2, "0")}`,
        poster_path: `/poster_${type}_${page}.jpg`,
        overview: `${type} ${page}`,
        genre_ids: [18],
        vote_average: 7.1,
        vote_count: 120,
      }],
    });
  };

  try {
    const state = {
      apiCalls: 0,
      maxApiCalls: 50,
      maxAttempts: 1,
    };

    const first = await fetchTmdbRecentCandidatesForType("movie", state, {
      pageWindow: 4,
      pagesPerCall: 2,
    });
    const second = await fetchTmdbRecentCandidatesForType("movie", state, {
      pageWindow: 4,
      pagesPerCall: 2,
    });
    const third = await fetchTmdbRecentCandidatesForType("movie", state, {
      pageWindow: 4,
      pagesPerCall: 2,
    });

    assert.deepEqual(first.pagesFetched, [1, 2]);
    assert.deepEqual(second.pagesFetched, [3, 4]);
    assert.deepEqual(third.pagesFetched, []);
    assert.equal(first.candidates.length, 2);
    assert.equal(second.candidates.length, 2);
    assert.equal(third.candidates.length, 0);
    assert.equal(third.exhausted, true);
    assert.equal(state.apiCalls, 4);
  } finally {
    global.fetch = prevFetch;
    if (prevKey === undefined) {
      delete process.env.TMDB_KEY;
    } else {
      process.env.TMDB_KEY = prevKey;
    }
  }
});
