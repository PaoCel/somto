const test = require("node:test");
const assert = require("node:assert/strict");

const { buildImportWarnings } = require("../../lib/importAdapters/importWarnings");

const episodeRow = (n) => ({ kind: "tv_episode", seriesNameGuess: `Serie ${n}` });
const movieRow = (n) => ({ kind: "movie", movieNameGuess: `Film ${n}` });

test("export TV Time senza film: lo dice, e lo dice come recuperabile", () => {
  const warnings = buildImportWarnings({
    source: "tvtime_gdpr",
    rows: [episodeRow(1), episodeRow(2)],
    errors: [{ reason: "File CSV film vuoto." }],
    matchedCount: 2,
    unresolvedCount: 0,
  });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "no_movies_in_export");
  assert.match(warnings[0].message, /scrivici/);
});

test("nessun film e nessun errore sul file: avvisa senza promettere recuperi", () => {
  const warnings = buildImportWarnings({
    source: "tvtime_gdpr",
    rows: [episodeRow(1)],
    errors: [],
    matchedCount: 1,
    unresolvedCount: 0,
  });
  assert.equal(warnings[0].code, "no_movies_in_export");
  assert.doesNotMatch(warnings[0].message, /scrivici/);
});

test("import con film dentro: nessun avviso sui film", () => {
  const warnings = buildImportWarnings({
    source: "tvtime_gdpr",
    rows: [movieRow(1), episodeRow(1)],
    errors: [],
    matchedCount: 2,
    unresolvedCount: 0,
  });
  assert.equal(warnings.length, 0);
});

test("Netflix senza film non genera l'avviso TV Time", () => {
  const warnings = buildImportWarnings({
    source: "netflix_csv",
    rows: [episodeRow(1)],
    errors: [],
    matchedCount: 1,
    unresolvedCount: 0,
  });
  assert.equal(warnings.length, 0);
});

test("molti titoli non riconosciuti: avvisa con il numero", () => {
  const warnings = buildImportWarnings({
    source: "tvtime_gdpr",
    rows: [movieRow(1), episodeRow(1)],
    errors: [],
    matchedCount: 100,
    unresolvedCount: 60,
  });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "many_unresolved");
  assert.match(warnings[0].message, /60 titoli/);
});

test("pochi non riconosciuti: nessun avviso (rumore normale)", () => {
  const warnings = buildImportWarnings({
    source: "tvtime_gdpr",
    rows: [movieRow(1)],
    errors: [],
    matchedCount: 500,
    unresolvedCount: 15,
  });
  assert.equal(warnings.length, 0);
});

test("import vuoto: nessun avviso fabbricato dal nulla", () => {
  assert.deepEqual(buildImportWarnings({}), []);
  assert.deepEqual(buildImportWarnings({ source: "tvtime_gdpr", rows: [], errors: [] }), []);
});
