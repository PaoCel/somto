"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { searchAnilistAnime, anilistQueryCandidates, anilistFormatToType } = require("../../lib/importAdapters/anilist");

const FAKE = {
  data: { Page: { media: [
    { idMal: 20648, format: "TV", seasonYear: 2015, title: { romaji: "Akagami no Shirayuki-hime", english: "Snow White with the Red Hair", native: "赤髪の白雪姫" } },
    { idMal: 1, format: "MOVIE", seasonYear: 2009, title: { romaji: "Summer Wars", english: "Summer Wars", native: "サマーウォーズ" } },
  ] } },
};

test("anilistFormatToType maps MOVIE->movie, else->tv", () => {
  assert.equal(anilistFormatToType("MOVIE"), "movie");
  assert.equal(anilistFormatToType("TV"), "tv");
  assert.equal(anilistFormatToType("ONA"), "tv");
  assert.equal(anilistFormatToType(null), "tv");
});

test("searchAnilistAnime normalizes candidates via injected fetcher", async () => {
  const res = await searchAnilistAnime("Akagami no Shirayuki-hime", { fetcher: async () => FAKE });
  assert.equal(res.length, 2);
  assert.deepEqual(res[0], { malId: 20648, format: "TV", type: "tv", year: 2015, romaji: "Akagami no Shirayuki-hime", english: "Snow White with the Red Hair", native: "赤髪の白雪姫" });
  assert.equal(res[1].type, "movie");
});

test("searchAnilistAnime returns [] on empty query, fetcher error, or no media (never throws)", async () => {
  assert.deepEqual(await searchAnilistAnime("", { fetcher: async () => FAKE }), []);
  assert.deepEqual(await searchAnilistAnime("x", { fetcher: async () => { throw new Error("429"); } }), []);
  assert.deepEqual(await searchAnilistAnime("x", { fetcher: async () => ({}) }), []);
});

test("anilistQueryCandidates: native first, then english, deduped, empties dropped", () => {
  assert.deepEqual(anilistQueryCandidates({ native: "赤髪の白雪姫", english: "Snow White with the Red Hair" }), ["赤髪の白雪姫", "Snow White with the Red Hair"]);
  assert.deepEqual(anilistQueryCandidates({ native: "Summer Wars", english: "Summer Wars" }), ["Summer Wars"]);
  assert.deepEqual(anilistQueryCandidates({ native: null, english: "" }), []);
});
