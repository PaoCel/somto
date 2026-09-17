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

// --- Corsia "in uscita" (2026-08-26) ----------------------------------------

const { fetchTmdbUpcomingCandidatesForType } = require("../../modules/tmdb");

const NOW_MS = Date.parse("2026-08-26T10:00:00.000Z");

function upcomingRow(id, { popularity = 20, voteCount = 0, name = "Serie" } = {}) {
  return {
    id,
    name,
    title: name,
    first_air_date: "2026-09-10",
    release_date: "2026-09-10",
    poster_path: `/p_${id}.jpg`,
    overview: "x",
    genre_ids: [18],
    vote_average: 0,
    vote_count: voteCount,
    popularity,
  };
}

/** Sostituisce global.fetch e restituisce gli URL richiesti. */
async function withFakeTmdb(results, run) {
  const prevFetch = global.fetch;
  const prevKey = process.env.TMDB_KEY;
  process.env.TMDB_KEY = "test_tmdb_key";
  const urls = [];
  global.fetch = async (urlString) => {
    urls.push(new URL(urlString));
    return jsonResponse({ page: 1, total_pages: 1, results });
  };
  try {
    return { out: await run(), urls };
  } finally {
    global.fetch = prevFetch;
    if (prevKey === undefined) delete process.env.TMDB_KEY;
    else process.env.TMDB_KEY = prevKey;
  }
}

const STATE = () => ({ apiCalls: 0, maxApiCalls: 50, maxAttempts: 1 });

test("la finestra uscite chiede a TMDB le date future, non i voti", async () => {
  const { urls } = await withFakeTmdb([upcomingRow(1)], () =>
    fetchTmdbUpcomingCandidatesForType("tv", STATE(), { nowMs: NOW_MS, aheadDays: 45, pages: 1 }));
  const q = urls[0].searchParams;
  assert.equal(q.get("first_air_date.gte"), "2026-08-26");
  assert.equal(q.get("first_air_date.lte"), "2026-10-10");
  assert.equal(q.get("sort_by"), "popularity.desc");
  // il cancello per voti non deve esserci: escluderebbe l'84% delle uscite
  assert.equal(q.get("vote_count.gte"), null);
});

test("sui film chiede le date di uscita italiane in sala", async () => {
  const { urls } = await withFakeTmdb([upcomingRow(2)], () =>
    fetchTmdbUpcomingCandidatesForType("movie", STATE(), { nowMs: NOW_MS, pages: 1 }));
  const q = urls[0].searchParams;
  assert.equal(q.get("region"), "IT");
  assert.equal(q.get("with_release_type"), "2|3");
  assert.ok(q.get("primary_release_date.gte"));
});

test("popolare passa, coda lunga no", async () => {
  const { out } = await withFakeTmdb(
    [upcomingRow(10, { popularity: 20 }), upcomingRow(11, { popularity: 0.4 })],
    () => fetchTmdbUpcomingCandidatesForType("tv", STATE(), { nowMs: NOW_MS, pages: 1, minPopularity: 5 }));
  assert.deepEqual(out.candidates.map((row) => row.tmdbId), [10]);
});

test("vote_count resta una seconda porta: poco popolare ma gia' votato entra", async () => {
  const { out } = await withFakeTmdb(
    [upcomingRow(20, { popularity: 0.5, voteCount: 40 }), upcomingRow(21, { popularity: 0.5, voteCount: 2 })],
    () => fetchTmdbUpcomingCandidatesForType("tv", STATE(), {
      nowMs: NOW_MS, pages: 1, minPopularity: 5, voteCountGte: 10,
    }));
  assert.deepEqual(out.candidates.map((row) => row.tmdbId), [20]);
});

test("senza locandina non entra, come nella corsia storica", async () => {
  const noPoster = { ...upcomingRow(30), poster_path: null };
  const { out } = await withFakeTmdb([noPoster], () =>
    fetchTmdbUpcomingCandidatesForType("tv", STATE(), { nowMs: NOW_MS, pages: 1 }));
  assert.deepEqual(out.candidates, []);
});

test("la finestra e' limitata: niente cursore, si rilegge intera", async () => {
  const { out, urls } = await withFakeTmdb([upcomingRow(40)], () =>
    fetchTmdbUpcomingCandidatesForType("tv", STATE(), { nowMs: NOW_MS, pages: 3 }));
  // una sola pagina perche' il finto TMDB ne restituisce meno di 20 risultati
  assert.equal(urls.length, 1);
  assert.equal(out.exhausted, true);
  assert.equal(out.candidates.length, 1);
});
