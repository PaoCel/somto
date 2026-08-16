const test = require("node:test");
const assert = require("node:assert/strict");

const {
  manualImportStoragePaths,
  normalizeManualImportFileKinds,
} = require("../../lib/importAdapters/tvTimeRefractStandby");

/* ============================= manualImportStoragePaths ============================= */

test("manualImportStoragePaths: both kinds requested -> both paths, scoped by uid+importId", () => {
  const paths = manualImportStoragePaths("uid1", "import1", ["movies", "series"]);
  assert.deepEqual(paths, {
    movies: "manualImports/uid1/import1/movies.json",
    series: "manualImports/uid1/import1/series.json",
  });
});

test("manualImportStoragePaths: only movies requested -> only the movies key is present", () => {
  const paths = manualImportStoragePaths("uid1", "import1", ["movies"]);
  assert.deepEqual(paths, { movies: "manualImports/uid1/import1/movies.json" });
  assert.ok(!("series" in paths));
});

test("manualImportStoragePaths: empty fileKinds -> empty object, no paths reserved", () => {
  assert.deepEqual(manualImportStoragePaths("uid1", "import1", []), {});
});

/* ============================= normalizeManualImportFileKinds ============================= */

test("normalizeManualImportFileKinds: hasMovies+hasSeries booleans map to the whitelisted kind list", () => {
  const kinds = normalizeManualImportFileKinds({ hasMovies: true, hasSeries: true });
  assert.deepEqual(kinds.sort(), ["movies", "series"]);
});

test("normalizeManualImportFileKinds: only hasMovies -> only 'movies'", () => {
  assert.deepEqual(normalizeManualImportFileKinds({ hasMovies: true, hasSeries: false }), ["movies"]);
});

test("normalizeManualImportFileKinds: garbage/unknown fileKinds entries are filtered out, never trusted verbatim", () => {
  const kinds = normalizeManualImportFileKinds({ fileKinds: ["movies", "../../etc/passwd", "series", "", 42] });
  assert.deepEqual(kinds.sort(), ["movies", "series"]);
});

test("normalizeManualImportFileKinds: no input at all -> empty array", () => {
  assert.deepEqual(normalizeManualImportFileKinds({}), []);
  assert.deepEqual(normalizeManualImportFileKinds(), []);
});

/* ===================== source-aware filenames (gdpr / netflix) ===================== */

test("manualImportStoragePaths: tvtime_refract keeps the .json filenames (default source)", () => {
  const paths = manualImportStoragePaths("u1", "imp1", ["movies", "series"], "tvtime_refract");
  assert.equal(paths.movies, "manualImports/u1/imp1/movies.json");
  assert.equal(paths.series, "manualImports/u1/imp1/series.json");
});

test("manualImportStoragePaths: tvtime_gdpr maps core + optional kinds to .csv filenames", () => {
  const paths = manualImportStoragePaths(
    "u1", "imp1",
    ["movies", "series", "episodeVotes", "movieVotes", "movieComments", "episodeComments", "lists"],
    "tvtime_gdpr"
  );
  assert.equal(paths.movies, "manualImports/u1/imp1/movies.csv");
  assert.equal(paths.series, "manualImports/u1/imp1/series.csv");
  assert.equal(paths.episodeVotes, "manualImports/u1/imp1/episode_votes.csv");
  assert.equal(paths.movieComments, "manualImports/u1/imp1/movie_comments.csv");
  assert.equal(paths.lists, "manualImports/u1/imp1/lists.csv");
});

test("manualImportStoragePaths: netflix_csv maps the single 'netflix' kind", () => {
  const paths = manualImportStoragePaths("u1", "imp1", ["netflix"], "netflix_csv");
  assert.deepEqual(paths, { netflix: "manualImports/u1/imp1/netflix.csv" });
});

test("normalizeManualImportFileKinds: gdpr optional has* flags are recognized, unknown kinds filtered", () => {
  const kinds = normalizeManualImportFileKinds(
    { hasMovies: true, hasSeries: true, hasEpisodeVotes: true, hasLists: true, hasNetflix: true /* not valid for gdpr */ },
    "tvtime_gdpr"
  );
  assert.deepEqual(kinds.sort(), ["episodeVotes", "lists", "movies", "series"]);
});

test("normalizeManualImportFileKinds: netflix source only accepts the 'netflix' kind", () => {
  assert.deepEqual(normalizeManualImportFileKinds({ hasNetflix: true, hasMovies: true }, "netflix_csv"), ["netflix"]);
});
