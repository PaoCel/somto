const test = require("node:test");
const assert = require("node:assert/strict");
const {
  existsLogicalDuplicateTitle,
  tmdbLogicalDuplicateKey,
  titleDocMediaType,
} = require("../../modules/tmdb");

// Fake Firestore minimale: una sola collection "titles" in memoria, con
// supporto per where("==") / where("array-contains") / limit / get.
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

// Catalogo: stesso tmdbId 1891 su due doc di tipo diverso (caso reale Rome/Empire).
const CATALOG = [
  {
    id: "tmdb_tv_1891",
    data: { type: "tv", tmdbId: 1891, nameLower: "roma", year: 2005 },
  },
  {
    id: "tmdb_movie_1891",
    data: { type: "movie", tmdbId: 1891, nameLower: "l impero colpisce ancora", year: 1980 },
  },
];

test("dedup per tmdbId aggancia il doc dello STESSO tipo (tv -> tv)", async () => {
  const db = makeFakeDb(CATALOG);
  const row = { type: "tv", tmdbId: 1891, name: "Rome", first_air_date: "2005-08-28" };
  const docId = await existsLogicalDuplicateTitle(db, row, null);
  assert.equal(docId, "tmdb_tv_1891");
});

test("dedup per tmdbId aggancia il doc dello STESSO tipo (movie -> movie)", async () => {
  const db = makeFakeDb(CATALOG);
  const row = { type: "movie", tmdbId: 1891, name: "The Empire Strikes Back", release_date: "1980-05-21" };
  const docId = await existsLogicalDuplicateTitle(db, row, null);
  assert.equal(docId, "tmdb_movie_1891");
});

test("dedup non aggancia cross-tipo quando esiste solo l'altro tipo", async () => {
  // Catalogo con SOLO la serie tv/1891. Un import del film 1891 NON deve
  // agganciare la serie (pre-fix: lo faceva e corrompeva il doc).
  const db = makeFakeDb([CATALOG[0]]);
  const row = { type: "movie", tmdbId: 1891, name: "The Empire Strikes Back", release_date: "1980-05-21" };
  const docId = await existsLogicalDuplicateTitle(db, row, null);
  assert.equal(docId, null);
});

test("dedup via mergedTmdbIds rispetta il tipo", async () => {
  const db = makeFakeDb([
    { id: "berlino", data: { type: "tv", tmdbId: 999, mergedTmdbIds: [146176, 308014], nameLower: "berlino", year: 2023 } },
    { id: "tmdb_movie_146176", data: { type: "movie", tmdbId: 146176, nameLower: "altro film", year: 2012 } },
  ]);
  // Una serie con tmdbId 146176 deve risolvere al doc tv che lo ha accorpato,
  // non al film omonimo per id.
  const tvRow = { type: "tv", tmdbId: 146176, name: "Berlino", first_air_date: "2023-12-29" };
  assert.equal(await existsLogicalDuplicateTitle(db, tvRow, null), "berlino");
  // Un film con lo stesso id resta sul proprio doc movie, niente merge nella tv.
  const movieRow = { type: "movie", tmdbId: 146176, name: "Altro Film", release_date: "2012-01-01" };
  assert.equal(await existsLogicalDuplicateTitle(db, movieRow, null), "tmdb_movie_146176");
});

test("fallback nameLower+year filtra per tipo", async () => {
  const db = makeFakeDb([
    { id: "film_x", data: { type: "movie", nameLower: "titolo condiviso", year: 2010 } },
    { id: "serie_x", data: { type: "tv", nameLower: "titolo condiviso", year: 2010 } },
  ]);
  // Nessun tmdbId: si passa al fallback nome+anno. Il tipo deve discriminare.
  const tvRow = { type: "tv", name: "Titolo Condiviso", first_air_date: "2010-03-01" };
  assert.equal(await existsLogicalDuplicateTitle(db, tvRow, null), "serie_x");
  const movieRow = { type: "movie", name: "Titolo Condiviso", release_date: "2010-03-01" };
  assert.equal(await existsLogicalDuplicateTitle(db, movieRow, null), "film_x");
});

test("la chiave logica di dedup include il tipo (no collisione movie/tv)", () => {
  const k1 = tmdbLogicalDuplicateKey({ type: "tv", name: "Rome", first_air_date: "2005-01-01" });
  const k2 = tmdbLogicalDuplicateKey({ type: "movie", name: "Rome", release_date: "2005-01-01" });
  assert.notEqual(k1, k2);
});

test("titleDocMediaType usa root type con fallback meta.mediaType", () => {
  assert.equal(titleDocMediaType({ type: "tv" }), "tv");
  assert.equal(titleDocMediaType({ type: "movie" }), "movie");
  assert.equal(titleDocMediaType({ meta: { mediaType: "tv" } }), "tv");
  assert.equal(titleDocMediaType({}), "movie");
});
