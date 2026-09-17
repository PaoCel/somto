import test from "node:test";
import assert from "node:assert/strict";

import {
  ARTICLES,
  normalizeText,
  tokenize,
  stripLeadingArticle,
  bestSearchTokens,
  scoreTitleMatch,
} from "../../public/js/utils/titleSearchRank.js";

function title(overrides = {}) {
  return {
    id: overrides.id || "t1",
    name: "",
    nameLower: "",
    originalName: null,
    aliases: [],
    collectionName: null,
    keywords: [],
    searchableText: "",
    description: "",
    ratingCount: 0,
    year: null,
    ...overrides,
  };
}

test("normalizeText strips diacritics, punctuation and collapses whitespace", () => {
  assert.equal(normalizeText("  Amélie: la fàvolosa storia!  "), "amelie la favolosa storia");
});

test("tokenize drops 1-char tokens and dedupes", () => {
  assert.deepEqual(tokenize("il re leone a a").sort(), ["il", "leone", "re"].sort());
});

test("stripLeadingArticle removes a single leading article and never empties the string", () => {
  assert.equal(stripLeadingArticle("the beekeeper"), "beekeeper");
  assert.equal(stripLeadingArticle("il primo natale"), "primo natale");
  assert.equal(stripLeadingArticle("la"), "la"); // singola parola, non svuota
  assert.equal(stripLeadingArticle("beekeeper"), "beekeeper"); // nessun articolo
});

test("bestSearchTokens prefers the longest non-article token", () => {
  assert.deepEqual(bestSearchTokens(["la", "casa", "di", "carta"], 1), ["carta"]);
  // Se dopo aver escluso gli articoli non resta nulla, ripiega sui token
  // originali (stessa lunghezza -> ordine alfabetico per determinismo).
  assert.deepEqual(bestSearchTokens(["la", "il"], 1), ["il"]);
});

test("\"beekeeper\" finds \"The Beekeeper\" via article-stripped match (score 9)", () => {
  const beekeeper = title({ id: "beekeeper", name: "The Beekeeper", nameLower: "the beekeeper" });
  const normalized = normalizeText("beekeeper");
  const score = scoreTitleMatch(beekeeper, normalized, tokenize(normalized));
  assert.equal(score, 9);
  assert.ok(score > 0);
});

test("exact match \"Natale a Rio\" beats \"Il Primo Natale\" and \"Natale a Tutti i Costi\" even with ratingCount 0", () => {
  const query = normalizeText("natale a rio");
  const tokens = tokenize(query);

  const nataleARio = title({ id: "rio", name: "Natale a Rio", nameLower: "natale a rio", ratingCount: 0 });
  const ilPrimoNatale = title({ id: "primo", name: "Il Primo Natale", nameLower: "il primo natale", ratingCount: 500 });
  const nataleATuttiICosti = title({
    id: "costi",
    name: "Natale a Tutti i Costi",
    nameLower: "natale a tutti i costi",
    ratingCount: 500,
  });

  const scoreRio = scoreTitleMatch(nataleARio, query, tokens);
  const scorePrimo = scoreTitleMatch(ilPrimoNatale, query, tokens);
  const scoreCosti = scoreTitleMatch(nataleATuttiICosti, query, tokens);

  assert.equal(scoreRio, 12);
  assert.ok(scoreRio > scorePrimo);
  assert.ok(scoreRio > scoreCosti);
});

test("all-tokens-in-name (8) beats a single token-in-name (6) and alias/originalName also scores 8", () => {
  const query = normalizeText("casa carta");
  const tokens = tokenize(query);

  const bothTokens = title({ nameLower: "la casa di carta" });
  const oneToken = title({ nameLower: "una casa in collina" });

  assert.equal(scoreTitleMatch(bothTokens, query, tokens), 8);
  assert.equal(scoreTitleMatch(oneToken, query, tokens), 6);

  const aliasMatch = title({ nameLower: "money heist", aliases: ["La Casa di Carta"] });
  assert.equal(scoreTitleMatch(aliasMatch, normalizeText("casa di carta"), tokenize(normalizeText("casa di carta"))), 8);
});

test("description-only match scores lowest non-zero (3), no match scores 0", () => {
  const query = normalizeText("astronave perduta");
  const descOnly = title({ nameLower: "un film qualunque", searchableText: "trama su una astronave perduta nello spazio" });
  assert.equal(scoreTitleMatch(descOnly, query, tokenize(query)), 3);

  const noMatch = title({ nameLower: "tutt'altra cosa" });
  assert.equal(scoreTitleMatch(noMatch, query, tokenize(query)), 0);
});

test("ARTICLES covers the required it/en/es/fr/de leading articles", () => {
  for (const article of ["il", "lo", "la", "i", "gli", "le", "un", "uno", "una", "the", "a", "an", "el", "los", "las", "der", "die", "das"]) {
    assert.ok(ARTICLES.has(article), `missing article: ${article}`);
  }
});
