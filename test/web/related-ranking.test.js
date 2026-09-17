import assert from "node:assert/strict";
import test from "node:test";

import { rankRelatedTitles, tasteAffinityForTitle } from "../../public/js/utils/relatedRanking.js";

function title(id, extra = {}) {
  return { id, name: id, ratingCount: 0, genres: [], castIds: [], ...extra };
}

test("curated titles always come first, in their given order", () => {
  const candidates = [
    title("collab-high", { ratingCount: 1000 }),
    title("curated-b"),
    title("curated-a"),
  ];
  const similarityById = new Map([["collab-high", { score: 0.9 }]]);

  const ranked = rankRelatedTitles({
    curatedIds: ["curated-a", "curated-b"],
    candidates,
    similarityById,
  });

  assert.deepEqual(ranked.map((t) => t.id), ["curated-a", "curated-b", "collab-high"]);
});

test("non-curated titles are ordered by collaborative score first", () => {
  const candidates = [title("low", {}), title("high", {})];
  const similarityById = new Map([
    ["low", { score: 0.1 }],
    ["high", { score: 0.8 }],
  ]);

  const ranked = rankRelatedTitles({ candidates, similarityById });
  assert.deepEqual(ranked.map((t) => t.id), ["high", "low"]);
});

test("excluded ids (page title, saga members) never appear", () => {
  const candidates = [title("keep"), title("page-title"), title("saga-2")];
  const ranked = rankRelatedTitles({ candidates, excludeIds: ["page-title", "saga-2"] });
  assert.deepEqual(ranked.map((t) => t.id), ["keep"]);
});

test("duplicate candidates are deduped, first occurrence wins", () => {
  const a = title("dup", { ratingCount: 1 });
  const b = title("dup", { ratingCount: 999 });
  const ranked = rankRelatedTitles({ candidates: [a, b] });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].ratingCount, 1);
});

test("popularity breaks ties among equally similar titles", () => {
  const candidates = [
    title("obscure", { ratingCount: 2 }),
    title("popular", { ratingCount: 500 }),
  ];
  const ranked = rankRelatedTitles({ candidates });
  assert.deepEqual(ranked.map((t) => t.id), ["popular", "obscure"]);
});

test("tasteAffinityForTitle is 0 without a taste profile", () => {
  assert.equal(tasteAffinityForTitle(title("x", { genres: ["drama"] }), null), 0);
});

test("tasteAffinityForTitle rewards loved genres and penalizes disliked ones", () => {
  const featureSums = {
    genres: {
      drama: { sum: 8, weight: 5 },
      horror: { sum: -6, weight: 5 },
    },
  };
  const loved = tasteAffinityForTitle(title("a", { genres: ["drama"] }), featureSums);
  const hated = tasteAffinityForTitle(title("b", { genres: ["horror"] }), featureSums);
  const neutral = tasteAffinityForTitle(title("c", { genres: ["sci-fi"] }), featureSums);

  assert.ok(loved > 0, "loved genre should score positive");
  assert.ok(hated < 0, "disliked genre should score negative");
  assert.equal(neutral, 0);
  assert.ok(loved > hated);
});

test("taste affinity nudges ranking above raw collaborative score", () => {
  const candidates = [
    title("no-taste-match", { genres: ["horror"] }),
    title("taste-match", { genres: ["drama"] }),
  ];
  const similarityById = new Map([
    ["no-taste-match", { score: 0.5 }],
    ["taste-match", { score: 0.5 }],
  ]);
  const featureSums = { genres: { drama: { sum: 10, weight: 5 } } };

  const ranked = rankRelatedTitles({ candidates, similarityById, featureSums });
  assert.deepEqual(ranked.map((t) => t.id), ["taste-match", "no-taste-match"]);
});
