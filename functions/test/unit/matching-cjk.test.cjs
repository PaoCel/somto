"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { rankTmdbResults, cjkSimilarity, hasCjk } = require("../../lib/importAdapters/matching");

const HIGH = 0.82; // matching.js HIGH_CONFIDENCE_SCORE (auto-stub threshold)

test("hasCjk detects Japanese/Korean/Chinese, not Latin", () => {
  assert.equal(hasCjk("ハウルの動く城"), true);   // katakana + kanji
  assert.equal(hasCjk("귀공자"), true);           // hangul
  assert.equal(hasCjk("名探偵コナン"), true);      // kanji + katakana
  assert.equal(hasCjk("Home Alone"), false);
  assert.equal(hasCjk("Fear Street: 1994"), false);
});

test("cjkSimilarity is 0 for any Latin string (never interferes with token scoring)", () => {
  assert.equal(cjkSimilarity("Home", "House"), 0);
  assert.equal(cjkSimilarity("ハウル", "Howl"), 0); // one side Latin -> 0
});

test("cjkSimilarity is 1 for identical CJK titles", () => {
  assert.equal(cjkSimilarity("名探偵コナン", "名探偵コナン"), 1);
  assert.equal(cjkSimilarity("귀공자", "귀공자"), 1);
});

test("rankTmdbResults: exact CJK query matches its original_name above threshold", () => {
  // Before the fix this scored 0 (normalizeText strips CJK -> empty tokens) and
  // the correct TMDB result was thrown away. Now it clears the auto-stub bar.
  const results = [
    { type: "movie", title: "Il castello errante di Howl", original_title: "ハウルの動く城", id: 4935 },
    { type: "movie", title: "Altro film", original_title: "別の映画", id: 1 },
  ];
  const ranked = rankTmdbResults(results, "ハウルの動く城");
  assert.equal(ranked[0].row.id, 4935);
  assert.ok(ranked[0].score >= HIGH, `score ${ranked[0].score} should clear ${HIGH}`);
});

test("rankTmdbResults: Korean title resolves", () => {
  const ranked = rankTmdbResults([{ type: "movie", title: "The Prince", original_title: "귀공자", id: 3 }], "귀공자");
  assert.ok(ranked[0].score >= HIGH);
});

test("rankTmdbResults: TV Time subtitle variant clears threshold via containment", () => {
  // Query carries an extra "(フルスコア)" the TMDB title lacks -> pure bigram
  // Jaccard is ~0.67 (below HIGH), but containment of the exact base title
  // boosts it over the bar.
  const ranked = rankTmdbResults(
    [{ type: "movie", title: "Detective Conan", original_title: "名探偵コナン 戦慄の楽譜", id: 2 }],
    "名探偵コナン 戦慄の楽譜(フルスコア)"
  );
  assert.ok(ranked[0].score >= HIGH, `score ${ranked[0].score} should clear ${HIGH}`);
});

test("cjkSimilarity: short franchise stub is NOT containment-boosted (no false movie match)", () => {
  // 鬼滅の刃 (4 chars) is contained in a long movie query, but too short to
  // trust as containment -> stays low so it can't hijack a specific movie.
  const s = cjkSimilarity("劇場版鬼滅の刃無限城編第一章猗窩座再来", "鬼滅の刃");
  assert.ok(s < HIGH, `short-franchise containment must stay below ${HIGH}, got ${s}`);
});

test("cjkSimilarity: long real subtitle IS contained -> boosted", () => {
  const s = cjkSimilarity("劇場版 鬼滅の刃 無限列車編", "鬼滅の刃 無限列車編");
  assert.ok(s >= HIGH, `long contained title should clear ${HIGH}, got ${s}`);
});

test("rankTmdbResults: Latin titles unaffected (regression) — original_title still wins", () => {
  // Localized IT differs from the EN query; original_title matches exactly.
  const ranked = rankTmdbResults(
    [{ type: "movie", title: "Mamma ho perso l'aereo", original_title: "Home Alone", id: 5 }],
    "Home Alone"
  );
  assert.equal(ranked[0].row.id, 5);
  assert.equal(ranked[0].score, 1);
});
