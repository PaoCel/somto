"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  buildItemSimilarityIndex,
  similarityDocFor,
  collectCollabSignals,
  projectedPairs,
  resolveItemCapForBudget,
  COLLAB_SCORE_SCALE,
  INDEX_VERSION,
} = require("../../lib/itemSimilarity");

function view(index, titleId) {
  return (index.get(titleId) || []).map((n) => n.id);
}

test("costruisce i vicini per co-visione", () => {
  const { index } = buildItemSimilarityIndex([
    { uid: "u1", titleId: "a" }, { uid: "u1", titleId: "b" },
    { uid: "u2", titleId: "a" }, { uid: "u2", titleId: "b" },
  ]);
  assert.deepStrictEqual(view(index, "a"), ["b"]);
  assert.deepStrictEqual(view(index, "b"), ["a"]);
  assert.strictEqual(index.get("a")[0].score, 1, "co-visione totale = coseno 1");
});

test("scarta i legami sotto il supporto minimo", () => {
  const rows = [{ uid: "u1", titleId: "a" }, { uid: "u1", titleId: "b" }];
  assert.strictEqual(buildItemSimilarityIndex(rows).index.size, 0, "una sola co-visione e' rumore");
  assert.strictEqual(buildItemSimilarityIndex(rows, { minCoOccurrence: 1 }).index.size, 2);
});

test("il coseno penalizza i titoli visti da tutti", () => {
  // 'popolare' lo vedono in 4, 'nicchia' solo i 2 che vedono anche 'seed'.
  const rows = [];
  for (const uid of ["u1", "u2"]) {
    rows.push({ uid, titleId: "seed" }, { uid, titleId: "nicchia" }, { uid, titleId: "popolare" });
  }
  for (const uid of ["u3", "u4"]) {
    rows.push({ uid, titleId: "popolare" }, { uid, titleId: "altro" });
  }
  const { index } = buildItemSimilarityIndex(rows);
  const vicini = new Map(index.get("seed").map((n) => [n.id, n.score]));
  assert.ok(vicini.get("nicchia") > vicini.get("popolare"),
    `nicchia ${vicini.get("nicchia")} deve battere popolare ${vicini.get("popolare")}`);
});

test("ignora chi ha un solo titolo e le righe malformate", () => {
  const { index, stats } = buildItemSimilarityIndex([
    { uid: "solo", titleId: "a" },
    { uid: "", titleId: "b" },
    { uid: "u", titleId: "" },
    null,
  ]);
  assert.strictEqual(index.size, 0);
  assert.strictEqual(stats.users, 0);
});

test("deduplica lo stesso titolo visto piu' volte dallo stesso utente", () => {
  const rows = [
    { uid: "u1", titleId: "a", atMs: 1 }, { uid: "u1", titleId: "a", atMs: 2 }, { uid: "u1", titleId: "b" },
    { uid: "u2", titleId: "a" }, { uid: "u2", titleId: "b" },
  ];
  const { index } = buildItemSimilarityIndex(rows);
  assert.strictEqual(index.get("a")[0].score, 1, "il doppione non deve gonfiare la co-occorrenza");
});

test("tiene al massimo maxNeighbors vicini, i migliori", () => {
  const rows = [];
  for (let u = 0; u < 6; u++) {
    rows.push({ uid: `u${u}`, titleId: "seed" });
    for (let t = 0; t < 20; t++) rows.push({ uid: `u${u}`, titleId: `t${t}` });
  }
  const { index } = buildItemSimilarityIndex(rows, { maxNeighbors: 5 });
  assert.strictEqual(index.get("seed").length, 5);
  const scores = index.get("seed").map((n) => n.score);
  assert.deepStrictEqual(scores, scores.slice().sort((a, b) => b - a), "ordinati per score");
});

test("il cap per utente tiene i titoli piu' recenti e taglia i vecchi", () => {
  // 12 titoli a testa, cap 10 (il minimo consentito): i due piu' vecchi cadono.
  const rows = [];
  for (const uid of ["u1", "u2"]) {
    rows.push({ uid, titleId: "vecchio1", atMs: 1 });
    rows.push({ uid, titleId: "vecchio2", atMs: 2 });
    for (let t = 0; t < 10; t++) rows.push({ uid, titleId: `recente${t}`, atMs: 1000 + t });
  }
  const { index, stats } = buildItemSimilarityIndex(rows, { maxItemsPerUser: 10 });
  assert.strictEqual(stats.effectiveItemCap, 10);
  assert.ok(index.has("recente0"), "i recenti restano");
  assert.ok(!index.has("vecchio1"), "i piu' vecchi cadono fuori dal cap");
  assert.ok(!index.has("vecchio2"));
});

test("projectedPairs conta le coppie per cap", () => {
  assert.strictEqual(projectedPairs([4], 4), 6);
  assert.strictEqual(projectedPairs([4], 2), 1);
  assert.strictEqual(projectedPairs([1, 1], 10), 0);
  assert.strictEqual(projectedPairs([3, 3], 3), 6);
});

test("resolveItemCapForBudget abbassa il cap solo quando serve", () => {
  // Sotto budget: il cap richiesto resta intatto.
  assert.strictEqual(resolveItemCapForBudget([10, 10], 400, 1_000_000), 400);
  // Sopra budget: scende, e il risultato sta davvero dentro il budget.
  const counts = [1000, 1000, 1000];
  const cap = resolveItemCapForBudget(counts, 400, 10_000);
  assert.ok(cap < 400 && cap >= 2, `cap=${cap}`);
  assert.ok(projectedPairs(counts, cap) <= 10_000);
  assert.ok(projectedPairs(counts, cap + 1) > 10_000, "deve essere il piu' alto possibile");
});

test("resolveItemCapForBudget non esplode su input vuoto", () => {
  assert.strictEqual(resolveItemCapForBudget([], 400, 100), 400);
});

test("il builder rispetta il budget di coppie e lo segnala", () => {
  const rows = [];
  for (const uid of ["u1", "u2"]) {
    for (let t = 0; t < 60; t++) rows.push({ uid, titleId: `t${t}`, atMs: t });
  }
  const senza = buildItemSimilarityIndex(rows, { maxItemsPerUser: 60 });
  assert.strictEqual(senza.stats.effectiveItemCap, 60);
  assert.strictEqual(senza.stats.capReduced, false);

  const con = buildItemSimilarityIndex(rows, { maxItemsPerUser: 60, pairBudget: 200 });
  assert.ok(con.stats.effectiveItemCap < 60, `cap=${con.stats.effectiveItemCap}`);
  assert.strictEqual(con.stats.capReduced, true, "la riduzione va segnalata, non subita in silenzio");
  assert.ok(con.stats.pairs <= 200);
});

test("similarityDocFor produce un doc pulito e versionato", () => {
  const doc = similarityDocFor("  abc  ", [{ id: " x ", score: 0.5 }, { id: "y", score: "boh" }]);
  assert.strictEqual(doc.titleId, "abc");
  assert.deepStrictEqual(doc.neighbors, [{ id: "x", score: 0.5 }, { id: "y", score: 0 }]);
  assert.strictEqual(doc.version, INDEX_VERSION);
  assert.strictEqual(doc.source, "cooccurrence");
});

test("collectCollabSignals somma i vicini dei seed e applica la scala", () => {
  const neighbors = new Map([
    ["s1", [{ id: "c", score: 0.5, count: 3 }]],
    ["s2", [{ id: "c", score: 0.25, count: 9 }]],
  ]);
  const out = collectCollabSignals(["s1", "s2"], (id) => neighbors.get(id));
  const row = out.get("c");
  assert.strictEqual(row.voters, 2);
  assert.strictEqual(row.similarCommon, 9, "tiene il supporto piu' alto");
  assert.ok(Math.abs(row.score - (0.75 * COLLAB_SCORE_SCALE)) < 1e-9);
});

test("collectCollabSignals rispetta esclusioni, self-match e tetto di seed", () => {
  const neighbors = new Map([
    ["s1", [{ id: "s1", score: 1 }, { id: "escluso", score: 1 }, { id: "ok", score: 1 }]],
    ["s2", [{ id: "solo-secondo", score: 1 }]],
  ]);
  const out = collectCollabSignals(["s1", "s2"], (id) => neighbors.get(id), {
    excludedIds: new Set(["escluso"]),
    maxSeeds: 1,
  });
  assert.deepStrictEqual([...out.keys()], ["ok"]);
});

test("collectCollabSignals regge seed senza vicini e input sporchi", () => {
  assert.strictEqual(collectCollabSignals(["ignoto"], () => null).size, 0);
  assert.strictEqual(collectCollabSignals(null, () => null).size, 0);
  assert.strictEqual(collectCollabSignals(["a"], null).size, 0);
  const out = collectCollabSignals(["a"], () => [{ id: "b", score: 0 }, { id: "", score: 1 }]);
  assert.strictEqual(out.size, 0, "score 0 e id vuoto non sono segnali");
});

test("collectCollabSignals deduplica i seed ripetuti", () => {
  const neighbors = new Map([["s", [{ id: "c", score: 1 }]]]);
  const out = collectCollabSignals(["s", "s", "s"], (id) => neighbors.get(id), { scale: 1 });
  assert.strictEqual(out.get("c").voters, 1);
  assert.strictEqual(out.get("c").score, 1);
});
