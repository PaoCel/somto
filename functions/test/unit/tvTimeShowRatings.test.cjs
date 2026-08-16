const test = require("node:test");
const assert = require("node:assert/strict");

const { parseTvTimeShowRatingsCsv, toSomtoDecimal, detectScale } = require("../../lib/importAdapters/tvTimeShowRatings");

const HEADER = "updated_at,tv_show_name,user_id,tv_show_id,rating,created_at";

test("file reale (account 2016): 3.50 su scala 5 diventa 7 decimi", () => {
  const csv = `${HEADER}\n2016-08-27 12:52:01,Arrow,8646887,257655,3.50,2016-08-27 12:52:01`;
  const { ratings, scale, errors } = parseTvTimeShowRatingsCsv(csv);
  assert.equal(scale, 5);
  assert.equal(errors.length, 0);
  assert.equal(ratings.length, 1);
  assert.equal(ratings[0].seriesName, "Arrow");
  assert.equal(ratings[0].decimalRating, 7);
  assert.equal(ratings[0].ratedAt.toISOString().slice(0, 10), "2016-08-27");
});

test("un solo voto sopra 5 sposta TUTTO il file sulla scala 0-10", () => {
  const csv = `${HEADER}\n,A,1,1,3.5,2020-01-01 10:00:00\n,B,1,2,8,2020-01-02 10:00:00`;
  const { ratings, scale } = parseTvTimeShowRatingsCsv(csv);
  assert.equal(scale, 10);
  assert.deepEqual(ratings.map((r) => r.decimalRating), [3.5, 8]);
});

test("voto 0 = non votata: scartato, non diventa 1", () => {
  const csv = `${HEADER}\n,A,1,1,0,2020-01-01 10:00:00`;
  assert.equal(parseTvTimeShowRatingsCsv(csv).ratings.length, 0);
});

test("colonne in ordine diverso: risolte per nome", () => {
  const csv = "rating,tv_show_name,created_at\n4.5,Lost,2015-05-05 09:00:00";
  const { ratings } = parseTvTimeShowRatingsCsv(csv);
  assert.equal(ratings[0].seriesName, "Lost");
  assert.equal(ratings[0].decimalRating, 9);
});

test("header inatteso: errore esplicito, nessun voto inventato", () => {
  const { ratings, errors } = parseTvTimeShowRatingsCsv("a,b,c\n1,2,3");
  assert.equal(ratings.length, 0);
  assert.match(errors[0].reason, /Header CSV voti serie inatteso/);
});

test("righe rotte segnalate una per una", () => {
  const csv = `${HEADER}\n,,1,1,3,2020-01-01 10:00:00\n,B,1,2,abc,2020-01-02 10:00:00`;
  const { ratings, errors } = parseTvTimeShowRatingsCsv(csv);
  assert.equal(ratings.length, 0);
  assert.equal(errors.length, 2);
});

test("file vuoto: nessun errore fabbricato", () => {
  assert.deepEqual(parseTvTimeShowRatingsCsv(""), { ratings: [], scale: 5, errors: [] });
});

test("conversione: mai sotto 1, mai sopra 10", () => {
  assert.equal(toSomtoDecimal(0.5, 5), 1);
  assert.equal(toSomtoDecimal(5, 5), 10);
  assert.equal(toSomtoDecimal(11, 10), 10);
  assert.equal(detectScale([1, 2, 5]), 5);
});
