"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseZipInfoListing,
  validateArchiveEntries,
  validateAllowedUrl,
  resolveLetterboxdFilm,
  resolveTmdbMovieByExactNameYear,
} = require("../../lib/importAdapters/letterboxdArchive");

test("legge e valida il listing zipinfo Letterboxd", () => {
  const listing = [
    "Archive: export.zip",
    "-rw----  2.0 fat  100 bl  50 defN 26-Aug-08 05:29 watched.csv",
    "-rw----  2.0 fat  200 bl 100 defN 26-Aug-08 05:29 ratings.csv",
    "2 files, 300 bytes uncompressed, 150 bytes compressed: 50.0%",
  ].join("\n");
  const entries = parseZipInfoListing(listing);
  assert.equal(entries.length, 2);
  assert.deepEqual(validateArchiveEntries(entries), { entryCount: 2, totalUncompressedBytes: 300 });
});

test("rifiuta traversal, symlink, duplicati, entry ignote e zip bomb", () => {
  const base = { mode: "-rw----", uncompressedSize: 100, compressedSize: 50, name: "watched.csv" };
  assert.throws(() => validateArchiveEntries([base, { ...base, name: "../evil.csv" }]), /percorso non sicuro/);
  assert.throws(() => validateArchiveEntries([{ ...base, mode: "lrwxrwxrwx" }]), /non regolare/);
  assert.throws(() => validateArchiveEntries([base, { ...base, name: "WATCHED.CSV" }]), /duplicate/);
  assert.throws(() => validateArchiveEntries([base, { ...base, name: "evil.csv" }]), /non riconosciuta/);
  assert.throws(() => validateArchiveEntries([{ ...base, uncompressedSize: 1000, compressedSize: 1 }]), /ratio eccessiva/);
});

test("valida URL e redirect senza accettare host simili", () => {
  assert.equal(validateAllowedUrl("https://boxd.it/a1", { initial: true }).hostname, "boxd.it");
  assert.throws(() => validateAllowedUrl("https://boxd.it.evil/a1", { initial: true }), /non ammesso/);
  assert.throws(() => validateAllowedUrl("https://u:p@boxd.it/a1", { initial: true }), /non ammesso/);
  assert.throws(() => validateAllowedUrl("http://boxd.it/a1", { initial: true }), /non ammesso/);
});

test("risolve manualmente boxd.it e verifica il TMDB id", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url) === "https://boxd.it/a1") {
      return new Response(null, { status: 302, headers: { location: "https://letterboxd.com/film/example/" } });
    }
    return new Response('<body data-tmdb-id="123"><a href="https://www.themoviedb.org/movie/123">TMDB</a></body>', {
      status: 200,
      headers: { "content-type": "text/html", "content-length": "100" },
    });
  };
  const result = await resolveLetterboxdFilm("https://boxd.it/a1", { fetchImpl });
  assert.deepEqual(result, { tmdbId: 123, mediaType: "movie", canonicalPath: "/film/example/" });
  assert.equal(calls.length, 2);
});

test("risolve una serie Letterboxd dal link TMDB quando data-tmdb-id manca", async () => {
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    if (call === 1) return new Response(null, { status: 302, headers: { location: "https://letterboxd.com/film/example-series/" } });
    return new Response('<a href="https://www.themoviedb.org/tv/999">TMDB</a>', { status: 200 });
  };
  const result = await resolveLetterboxdFilm("https://boxd.it/a1", { fetchImpl });
  assert.deepEqual(result, { tmdbId: 999, mediaType: "tv", canonicalPath: "/film/example-series/" });
});

test("blocca redirect esterno e TMDB id incoerente", async () => {
  await assert.rejects(
    resolveLetterboxdFilm("https://boxd.it/a1", {
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }),
    }),
    /non ammesso/
  );
  let call = 0;
  await assert.rejects(
    resolveLetterboxdFilm("https://boxd.it/a1", {
      fetchImpl: async () => {
        call += 1;
        if (call === 1) return new Response(null, { status: 302, headers: { location: "https://letterboxd.com/film/x/" } });
        return new Response('<div data-tmdb-id="123"></div><a href="https://www.themoviedb.org/movie/456">x</a>', { status: 200 });
      },
    }),
    /incoerente/
  );
});

test("fallback TMDB accetta solo nome e anno esatti e univoci", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    results: [
      { id: 123, title: "Titolo localizzato", original_title: "Exact Film", release_date: "2020-06-01" },
      { id: 456, title: "Exact Film", original_title: "Exact Film", release_date: "2021-01-01" },
    ],
  }), { status: 200, headers: { "content-type": "application/json" } });
  const result = await resolveTmdbMovieByExactNameYear("Exact Film", 2020, { apiKey: "test", fetchImpl });
  assert.deepEqual(result, { tmdbId: 123, mediaType: "movie", resolutionStrategy: "tmdb_exact_name_year" });
});

test("fallback TMDB blocca risultati ambigui", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    results: [
      { id: 1, title: "Same", release_date: "2020-01-01" },
      { id: 2, original_title: "Same", release_date: "2020-03-01" },
    ],
  }), { status: 200 });
  await assert.rejects(
    resolveTmdbMovieByExactNameYear("Same", 2020, { apiKey: "test", fetchImpl }),
    /non univoco/
  );
});
