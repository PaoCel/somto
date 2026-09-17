const test = require("node:test");
const assert = require("node:assert/strict");

const { extractAltNamesLower } = require("../../modules/tmdb");
const { matchAltNamesLower } = require("../../lib/importAdapters/matching");

// Fake Firestore minimale: una sola collection "titles" in memoria, con
// supporto per where("==") / where("array-contains") / limit / get (mirrors
// tmdb-dedup-type.test.cjs's makeFakeDb).
function makeFakeDb(docs) {
  function makeQuery(filters) {
    return {
      where(field, op, value) {
        return makeQuery([...filters, { field, op, value }]);
      },
      limit(n) {
        return makeQuery([...filters, { op: "limit", value: n }]);
      },
      async get() {
        let rows = docs.slice();
        let cap = Infinity;
        for (const f of filters) {
          if (f.op === "limit") {
            cap = f.value;
          } else if (f.op === "==") {
            rows = rows.filter((d) => d.data[f.field] === f.value);
          } else if (f.op === "array-contains") {
            rows = rows.filter(
              (d) => Array.isArray(d.data[f.field]) && d.data[f.field].includes(f.value)
            );
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
    collection(name) {
      assert.equal(name, "titles");
      return makeQuery([]);
    },
  };
}

// ---------------------------------------------------------------------------
// extractAltNamesLower
// ---------------------------------------------------------------------------

test("extractAltNamesLower includes the original title/name, normalized", () => {
  const details = { type: "movie", original_title: "The Bear" };
  const out = extractAltNamesLower(details, { nameLower: "orso", mediaType: "movie" });
  assert.deepEqual(out, ["the bear"]);
});

test("extractAltNamesLower uses original_name (not original_title) for tv", () => {
  const details = { type: "tv", original_name: "Breaking Bad" };
  const out = extractAltNamesLower(details, { nameLower: "qualcos altro", mediaType: "tv" });
  assert.deepEqual(out, ["breaking bad"]);
});

test("extractAltNamesLower filters alternative_titles to IT/US/GB only", () => {
  const details = {
    type: "movie",
    original_title: "",
    alternative_titles: {
      titles: [
        { iso_3166_1: "US", title: "US Title" },
        { iso_3166_1: "FR", title: "Titre FR" }, // excluded, not IT/US/GB
        { iso_3166_1: "GB", title: "GB Title" },
        { iso_3166_1: "DE", title: "DE Titel" }, // excluded
        { iso_3166_1: "IT", title: "Titolo IT" },
      ],
    },
  };
  const out = extractAltNamesLower(details, { nameLower: "nome canonico", mediaType: "movie" });
  assert.deepEqual(out.sort(), ["gb title", "titolo it", "us title"].sort());
});

test("extractAltNamesLower reads tv alternative_titles from the `results` key (movie uses `titles`)", () => {
  const details = {
    type: "tv",
    original_name: "",
    alternative_titles: {
      results: [{ iso_3166_1: "IT", title: "Nome IT Serie" }],
    },
  };
  const out = extractAltNamesLower(details, { nameLower: "altro", mediaType: "tv" });
  assert.deepEqual(out, ["nome it serie"]);
});

test("extractAltNamesLower excludes a variant equal to nameLower (no redundant entries)", () => {
  const details = {
    type: "movie",
    original_title: "Nome Canonico",
    alternative_titles: { titles: [{ iso_3166_1: "US", title: "Nome Canonico" }] },
  };
  const out = extractAltNamesLower(details, { nameLower: "nome canonico", mediaType: "movie" });
  assert.deepEqual(out, []);
});

test("extractAltNamesLower dedups case/accent-insensitively", () => {
  const details = {
    type: "movie",
    original_title: "Amélie",
    alternative_titles: {
      titles: [
        { iso_3166_1: "US", title: "Amelie" }, // normalizes the same as "Amélie"
        { iso_3166_1: "GB", title: "AMELIE" },
      ],
    },
  };
  const out = extractAltNamesLower(details, { nameLower: "le fabuleux destin d amelie poulain", mediaType: "movie" });
  assert.deepEqual(out, ["amelie"]);
});

test("extractAltNamesLower caps at 10 items", () => {
  const titles = Array.from({ length: 25 }, (_, i) => ({ iso_3166_1: "US", title: `Variant ${i}` }));
  const details = { type: "movie", original_title: "", alternative_titles: { titles } };
  const out = extractAltNamesLower(details, { nameLower: "x", mediaType: "movie" });
  assert.equal(out.length, 10);
});

test("extractAltNamesLower returns [] for an empty/malformed payload", () => {
  assert.deepEqual(extractAltNamesLower(null, { nameLower: "x" }), []);
  assert.deepEqual(extractAltNamesLower({}, { nameLower: "x" }), []);
  assert.deepEqual(extractAltNamesLower({ alternative_titles: null }, { nameLower: "x" }), []);
});

test("extractAltNamesLower infers media type from payload shape when no hint is given", () => {
  const tvDetails = { original_name: "Original TV Name", first_air_date: "2020-01-01" };
  assert.deepEqual(extractAltNamesLower(tvDetails, { nameLower: "altro" }), ["original tv name"]);

  const movieDetails = { original_title: "Original Movie Name", release_date: "2020-01-01" };
  assert.deepEqual(extractAltNamesLower(movieDetails, { nameLower: "altro" }), ["original movie name"]);
});

// ---------------------------------------------------------------------------
// matchAltNamesLower (import matching cascade strategy)
// ---------------------------------------------------------------------------

test("matchAltNamesLower resolves a row whose name only matches an alt name, not nameLower", async () => {
  const db = makeFakeDb([
    { id: "tmdb_tv_1", data: { type: "tv", nameLower: "casa di carta", altNamesLower: ["la casa de papel", "money heist"] } },
  ]);
  const match = await matchAltNamesLower(db, "Money Heist", "tv");
  assert.ok(match);
  assert.equal(match.titleId, "tmdb_tv_1");
  assert.equal(match.strategy, "alt_names_lower");
  assert.ok(match.confidence > 0.9);
});

test("matchAltNamesLower respects the expected media type (movie/tv collision)", async () => {
  // Same alt name present on both a movie and a tv doc; only the tv one
  // should match when expectedType === "tv" (mirrors the tmdbId collision
  // guard elsewhere in the cascade — see tmdb-dedup-type.test.cjs).
  const db = makeFakeDb([
    { id: "tmdb_movie_1", data: { type: "movie", nameLower: "film", altNamesLower: ["shared alt name"] } },
    { id: "tmdb_tv_1", data: { type: "tv", nameLower: "serie", altNamesLower: ["shared alt name"] } },
  ]);
  const tvMatch = await matchAltNamesLower(db, "Shared Alt Name", "tv");
  assert.equal(tvMatch.titleId, "tmdb_tv_1");
  const movieMatch = await matchAltNamesLower(db, "Shared Alt Name", "movie");
  assert.equal(movieMatch.titleId, "tmdb_movie_1");
});

test("matchAltNamesLower returns null when no title has a matching altNamesLower entry", async () => {
  const db = makeFakeDb([
    { id: "tmdb_tv_1", data: { type: "tv", nameLower: "casa di carta", altNamesLower: ["la casa de papel"] } },
  ]);
  const match = await matchAltNamesLower(db, "Totally Unrelated Title", "tv");
  assert.equal(match, null);
});

test("matchAltNamesLower falls back to meta.mediaType when root `type` is absent", async () => {
  const db = makeFakeDb([
    { id: "x", data: { meta: { mediaType: "tv" }, nameLower: "serie", altNamesLower: ["original name"] } },
  ]);
  const match = await matchAltNamesLower(db, "Original Name", "tv");
  assert.ok(match);
  assert.equal(match.titleId, "x");
});

test("matchAltNamesLower normalizes the query name the same way altNamesLower entries are stored", async () => {
  const db = makeFakeDb([
    { id: "tmdb_movie_1", data: { type: "movie", nameLower: "titolo", altNamesLower: ["amelie"] } },
  ]);
  // Accents + casing in the query should still hit the normalized stored entry.
  const match = await matchAltNamesLower(db, "AMÉLIE", "movie");
  assert.ok(match);
  assert.equal(match.titleId, "tmdb_movie_1");
});

test("matchAltNamesLower returns null for an empty/blank name without querying", async () => {
  const db = makeFakeDb([]);
  const match = await matchAltNamesLower(db, "   ", "movie");
  assert.equal(match, null);
});
