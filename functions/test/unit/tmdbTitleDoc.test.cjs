const test = require("node:test");
const assert = require("node:assert/strict");

const { buildTmdbTitleDoc } = require("../../modules/tmdb");

// I generi arrivano in due forme: numeri dalle /search, oggetti {id,name} dai
// dettagli /movie|tv/{id}. Il ramo sugli oggetti mancava e in catalogo sono
// finiti 632 titoli con il genere letterale "[object Object]".
test("i generi si normalizzano da entrambe le forme TMDB", () => {
  const daSearch = buildTmdbTitleDoc({ type: "movie", id: 1, title: "A", genre_ids: [27, 53] }, "");
  const daDettagli = buildTmdbTitleDoc({
    type: "movie",
    id: 2,
    title: "B",
    genres: [{ id: 27, name: "Horror" }, { id: 53, name: "Thriller" }],
  }, "");

  assert.deepEqual(daSearch.genres, ["tmdb_27", "tmdb_53"]);
  assert.deepEqual(daDettagli.genres, ["tmdb_27", "tmdb_53"]);
});

test("un genere gia' corrotto non viene riscritto in catalogo", () => {
  const doc = buildTmdbTitleDoc({ type: "movie", id: 3, title: "C", genres: ["[object Object]", "tmdb_18"] }, "");
  assert.deepEqual(doc.genres, ["tmdb_18"]);
});

test("oggetti senza id non producono generi fantasma", () => {
  const doc = buildTmdbTitleDoc({ type: "movie", id: 4, title: "D", genres: [{ name: "Horror" }, {}] }, "");
  assert.deepEqual(doc.genres, []);
});
