"use strict";

const test = require("node:test");
const assert = require("node:assert");

const B = require("../../lib/recoBenchmark");

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2025, 0, 1);

function rating(uid, titleId, value, dayOffset) {
  return { uid, titleId, rating: value, atMs: T0 + (dayOffset * DAY) };
}

function title(id, extra = {}) {
  return {
    id,
    name: `Titolo ${id}`,
    originalName: "",
    description: "",
    type: "movie",
    year: 2020,
    genres: ["Azione"],
    cast: [],
    castIds: [],
    directors: [],
    directorIds: [],
    countries: [],
    related: [],
    ratingAvg: 7,
    ratingCount: 10,
    createdAtMs: T0,
    search: { tokens: [] },
    ...extra,
  };
}

test("splitTemporal mette il passato nel train e il futuro nel test", () => {
  const rows = [rating("u", "a", 8, 0), rating("u", "b", 8, 10), rating("u", "c", 8, 20)];
  const { train, test } = B.splitTemporal(rows, T0 + (10 * DAY));
  assert.deepStrictEqual(train.map((r) => r.titleId), ["a"]);
  assert.deepStrictEqual(test.map((r) => r.titleId), ["b", "c"]);
});

test("splitTemporal scarta le righe senza timestamp invece di inventarne uno", () => {
  const rows = [rating("u", "a", 8, 0), { uid: "u", titleId: "z", rating: 9 }];
  const { train, test } = B.splitTemporal(rows, T0 + DAY);
  assert.strictEqual(train.length + test.length, 1);
});

test("pickCutoffByQuantile lascia circa la frazione richiesta nel futuro", () => {
  const rows = Array.from({ length: 100 }, (_, i) => rating("u", `t${i}`, 8, i));
  const cutoff = B.pickCutoffByQuantile(rows, 0.2);
  const { train, test } = B.splitTemporal(rows, cutoff);
  assert.ok(test.length >= 15 && test.length <= 25, `test=${test.length}`);
  assert.strictEqual(train.length + test.length, 100);
});

test("buildEvalUsers esclude chi ha poco passato o nessun futuro positivo", () => {
  const train = [
    ...Array.from({ length: 6 }, (_, i) => rating("ricco", `t${i}`, 8, i)),
    rating("povero", "t0", 8, 0),
    ...Array.from({ length: 6 }, (_, i) => rating("negativo", `t${i}`, 8, i)),
  ];
  const test = [
    rating("ricco", "futuro", 9, 30),
    rating("povero", "futuro", 9, 30),
    rating("negativo", "futuro", 3, 30), // ha guardato, non gli e' piaciuto
  ];

  const users = B.buildEvalUsers({ train, test, minTrain: 5 });
  assert.deepStrictEqual(users.map((u) => u.uid), ["ricco"]);
  assert.ok(users[0].positives.has("futuro"));
  assert.strictEqual(users[0].seenTitleIds.size, 6);
});

test("buildEvalUsers usa la soglia di positivita' richiesta", () => {
  const train = Array.from({ length: 6 }, (_, i) => rating("u", `t${i}`, 8, i));
  const test = [rating("u", "futuro", 6, 30)];
  assert.strictEqual(B.buildEvalUsers({ train, test, minTrain: 5 }).length, 0);
  assert.strictEqual(B.buildEvalUsers({ train, test, minTrain: 5, positiveThreshold: 6 }).length, 1);
});

test("recall@k conta le prese sul totale dei positivi", () => {
  const positives = new Set(["a", "b", "c", "d"]);
  assert.strictEqual(B.recallAtK(["a", "b", "x", "y"], positives, 4), 0.5);
  assert.strictEqual(B.recallAtK(["x", "y"], positives, 4), 0);
  assert.strictEqual(B.recallAtK(["a"], new Set(), 4), 0);
});

test("recall@k rispetta il taglio a k", () => {
  const positives = new Set(["z"]);
  assert.strictEqual(B.recallAtK(["a", "b", "z"], positives, 2), 0);
  assert.strictEqual(B.recallAtK(["a", "b", "z"], positives, 3), 1);
});

test("precision@k divide per k, non per la lunghezza della lista", () => {
  assert.strictEqual(B.precisionAtK(["a", "x"], new Set(["a"]), 10), 0.1);
  assert.strictEqual(B.precisionAtK(["a"], new Set(["a"]), 1), 1);
});

test("ndcg@k premia la posizione: stesso hit piu' in alto vale di piu'", () => {
  const positives = new Set(["hit"]);
  const primo = B.ndcgAtK(["hit", "x", "y"], positives, 3);
  const ultimo = B.ndcgAtK(["x", "y", "hit"], positives, 3);
  assert.strictEqual(primo, 1);
  assert.ok(ultimo > 0 && ultimo < primo, `ultimo=${ultimo}`);
  assert.ok(Math.abs(ultimo - (1 / Math.log2(4))) < 1e-9);
});

test("ndcg@k vale 1 quando tutti i positivi sono in cima", () => {
  const positives = new Set(["a", "b"]);
  assert.ok(Math.abs(B.ndcgAtK(["a", "b", "x"], positives, 3) - 1) < 1e-9);
  assert.strictEqual(B.ndcgAtK(["x", "y"], positives, 2), 0);
});

test("average precision penalizza gli hit sparsi", () => {
  const positives = new Set(["a", "b"]);
  const compatti = B.averagePrecisionAtK(["a", "b", "x", "y"], positives, 4);
  const sparsi = B.averagePrecisionAtK(["a", "x", "y", "b"], positives, 4);
  assert.strictEqual(compatti, 1);
  assert.ok(sparsi < compatti);
});

test("listDiversity: cloni 0, generi disgiunti 1", () => {
  const titlesById = new Map([
    ["a", title("a", { genres: ["Azione"] })],
    ["b", title("b", { genres: ["Azione"] })],
    ["c", title("c", { genres: ["Commedia"] })],
  ]);
  assert.strictEqual(B.listDiversity(["a", "b"], titlesById), 0);
  assert.strictEqual(B.listDiversity(["a", "c"], titlesById), 1);
  // Una lista di un solo elemento non ha coppie: 0 per convenzione.
  assert.strictEqual(B.listDiversity(["a"], titlesById), 0);
});

test("listNovelty cresce quando i titoli sono di nicchia", () => {
  const pop = new Map([["mainstream", 100], ["nicchia", 1]]);
  const alta = B.listNovelty(["nicchia"], pop, 100);
  const bassa = B.listNovelty(["mainstream"], pop, 100);
  assert.ok(alta > bassa);
  assert.strictEqual(bassa, 0);
});

test("buildOfflineSeeds scarta i voti bassi e mette in cima i piu' amati e recenti", () => {
  const titlesById = new Map([
    ["amato", title("amato")],
    ["tiepido", title("tiepido")],
    ["odiato", title("odiato")],
  ]);
  const nowMs = T0 + (30 * DAY);
  const { seedTitles } = B.buildOfflineSeeds([
    rating("u", "amato", 10, 29),
    rating("u", "tiepido", 6, 1),
    rating("u", "odiato", 2, 29),
  ], titlesById, nowMs);

  const ids = seedTitles.map((t) => t.id);
  assert.ok(!ids.includes("odiato"), "un voto 2 non e' un seed");
  assert.strictEqual(ids[0], "amato");
});

test("buildOfflineSeeds tiene al massimo 8 seed, come resolveSeedTitles", () => {
  const titlesById = new Map();
  const rows = [];
  for (let i = 0; i < 30; i++) {
    titlesById.set(`t${i}`, title(`t${i}`));
    rows.push(rating("u", `t${i}`, 9, i));
  }
  const { seedTitles } = B.buildOfflineSeeds(rows, titlesById, T0 + (40 * DAY));
  assert.strictEqual(seedTitles.length, 8);
});

test("buildEvaluationCatalog usa solo aggregati train e nasconde titoli futuri", () => {
  const cutoffMs = T0 + (10 * DAY);
  const catalog = B.buildEvaluationCatalog([
    title("passato", { ratingCount: 999, ratingAvg: 10, createdAtMs: T0 }),
    title("futuro", { ratingCount: 999, ratingAvg: 10, createdAtMs: cutoffMs }),
  ], [
    { ...rating("u1", "passato", 6, 1), kind: "rating" },
    { ...rating("u2", "passato", 8, 2), kind: "rating" },
  ], { cutoffMs, temporal: true });

  assert.strictEqual(catalog.byId.has("futuro"), false);
  assert.strictEqual(catalog.byId.get("passato").ratingCount, 2);
  assert.strictEqual(catalog.byId.get("passato").ratingAvg, 7);
  assert.strictEqual(catalog.totalTrainUsers, 2);
});

test("restrictEvalUsersToCatalog rimuove target non raccomandabili", () => {
  const users = B.restrictEvalUsersToCatalog([
    { uid: "u1", positives: new Set(["presente", "futuro"]) },
    { uid: "u2", positives: new Set(["futuro"]) },
  ], new Map([["presente", title("presente")]]));

  assert.deepStrictEqual(users.map((u) => u.uid), ["u1"]);
  assert.deepStrictEqual([...users[0].positives], ["presente"]);
});

test("buildOfflineTasteProfile sposta il profilo verso i generi votati bene", () => {
  const titlesById = new Map([
    ["a", title("a", { genres: ["Azione"] })],
    ["h", title("h", { genres: ["Horror"] })],
  ]);
  const profile = B.buildOfflineTasteProfile([
    rating("u", "a", 10, 0),
    rating("u", "h", 1, 0),
  ], titlesById, T0 + DAY);

  const azione = profile.genres.get("Azione");
  const horror = profile.genres.get("Horror");
  assert.ok(azione && azione.affinity > 0, "il genere votato alto deve avere affinita' positiva");
  assert.ok(horror && horror.affinity < 0, "il genere votato basso deve avere affinita' negativa");
  assert.ok(profile.totalWeight > 0);
});

test("buildOfflineTasteProfile ignora i titoli fuori catalogo", () => {
  const profile = B.buildOfflineTasteProfile([rating("u", "fantasma", 10, 0)], new Map(), T0);
  assert.strictEqual(profile.totalWeight, 0);
});

function neighborIds(index, titleId) {
  return (index.neighbors.get(titleId) || []).map((n) => n.id);
}

test("buildItemKnnIndex trova i vicini per co-visione e ignora i voti bassi", () => {
  const train = [
    rating("u1", "a", 9, 0), rating("u1", "b", 9, 1),
    rating("u2", "a", 9, 0), rating("u2", "b", 9, 1),
    rating("u3", "a", 9, 0), rating("u3", "c", 2, 1), // voto basso: non e' un legame
  ];
  const index = B.buildItemKnnIndex(train);
  assert.ok(neighborIds(index, "a").includes("b"));
  assert.ok(!neighborIds(index, "a").includes("c"));
});

test("buildItemKnnIndex scarta le co-visioni sotto il supporto minimo", () => {
  // Una sola co-visione: rumore, non un legame.
  const train = [rating("u1", "a", 9, 0), rating("u1", "b", 9, 1)];
  assert.strictEqual(B.buildItemKnnIndex(train).neighbors.size, 0);
  assert.ok(neighborIds(B.buildItemKnnIndex(train, { minCoOccurrence: 1 }), "a").includes("b"));
});

test("recommendItemKnn esclude il gia' visto e resta dentro il pool", () => {
  const train = [
    rating("u1", "a", 9, 0), rating("u1", "b", 9, 1), rating("u1", "c", 9, 2),
    rating("u2", "a", 9, 0), rating("u2", "b", 9, 1), rating("u2", "c", 9, 2),
  ];
  const index = B.buildItemKnnIndex(train);
  const pool = new Map([["b", title("b")], ["c", title("c")]]);

  const out = B.recommendItemKnn({ pool, excluded: new Set(["b"]), k: 10, likedTitleIds: ["a"], index });
  assert.ok(!out.includes("b"), "il titolo escluso non deve tornare");
  assert.ok(out.includes("c"));

  const fuoriPool = B.recommendItemKnn({ pool: new Map(), excluded: new Set(), k: 10, likedTitleIds: ["a"], index });
  assert.deepStrictEqual(fuoriPool, []);
});

test("recommendPopularity ordina per numero di voti ed e' deterministico", () => {
  const pool = new Map([
    ["poco", title("poco", { ratingCount: 1 })],
    ["tanto", title("tanto", { ratingCount: 500 })],
    ["medio", title("medio", { ratingCount: 50 })],
  ]);
  const out = B.recommendPopularity({ pool, excluded: new Set(), k: 3 });
  assert.deepStrictEqual(out, ["tanto", "medio", "poco"]);
  assert.deepStrictEqual(B.recommendPopularity({ pool, excluded: new Set(["tanto"]), k: 3 }), ["medio", "poco"]);
});

test("summarizeRuns aggrega copertura e liste vuote", () => {
  const titlesById = new Map([["a", title("a")], ["b", title("b", { genres: ["Commedia"] })]]);
  const runs = [
    { uid: "u1", recommended: ["a", "b"], positives: new Set(["a"]) },
    { uid: "u2", recommended: [], positives: new Set(["b"]) },
  ];
  const s = B.summarizeRuns({
    runs,
    titlesById,
    catalogSize: 4,
    popularityByTitle: new Map([["a", 2], ["b", 1]]),
    totalUsers: 2,
    k: 10,
  });
  assert.strictEqual(s.users, 2);
  assert.strictEqual(s.emptyLists, 1);
  assert.strictEqual(s.coverage, 0.5, "2 titoli distinti su 4 di catalogo");
  assert.strictEqual(s.hitRate, 0.5);
});

test("seededRandom e' riproducibile e diverso fra seed", () => {
  const a = B.seededRandom(42);
  const b = B.seededRandom(42);
  const c = B.seededRandom(43);
  const seqA = [a(), a(), a()];
  assert.deepStrictEqual(seqA, [b(), b(), b()]);
  assert.notDeepStrictEqual(seqA, [c(), c(), c()]);
  for (const v of seqA) assert.ok(v >= 0 && v < 1);
});

test("buildOfflineCandidatePool include popolari, recenti e correlati ai seed", () => {
  const rows = Array.from({ length: 30 }, (_, i) => title(`t${i}`, {
    ratingCount: i,
    createdAtMs: T0 + (i * DAY),
    genres: i % 2 === 0 ? ["Azione"] : ["Commedia"],
  }));
  rows.push(title("correlato", { ratingCount: 0, createdAtMs: 0 }));

  const byId = new Map(rows.map((t) => [t.id, t]));
  const byPopularity = rows.slice().sort((a, b) => b.ratingCount - a.ratingCount);
  const byRecency = rows.slice().sort((a, b) => b.createdAtMs - a.createdAtMs);

  const seeds = [title("seed", { genres: ["Azione"], related: ["correlato"] })];
  const pool = B.buildOfflineCandidatePool({ byId, byPopularity, byRecency }, seeds, { byPopularity, byRecency });

  assert.ok(pool.has("correlato"), "i correlati ai seed devono entrare nel pool");
  assert.ok(pool.size > 1);
});

test("collapseRatingsByTitle tiene un solo voto per titolo, il piu' alto", () => {
  const rows = [
    { uid: "u", titleId: "serie", rating: 6, level: "season", atMs: T0 },
    { uid: "u", titleId: "serie", rating: 9, level: "season", atMs: T0 + DAY },
    { uid: "u", titleId: "serie", rating: 7, level: "episode", atMs: T0 + (2 * DAY) },
  ];
  const out = B.collapseRatingsByTitle(rows, { levels: "all" });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].rating, 9);
  assert.strictEqual(out[0].atMs, T0 + DAY, "tiene il timestamp della riga scelta");
});

test("collapseRatingsByTitle con levels=title ignora stagioni ed episodi", () => {
  const rows = [
    { uid: "u", titleId: "a", rating: 9, level: "season", atMs: T0 },
    { uid: "u", titleId: "b", rating: 8, level: "title", atMs: T0 },
  ];
  assert.deepStrictEqual(
    B.collapseRatingsByTitle(rows, { levels: "title" }).map((r) => r.titleId),
    ["b"]
  );
  assert.strictEqual(B.collapseRatingsByTitle(rows, { levels: "all" }).length, 2);
});

test("collapseRatingsByTitle tratta il level mancante come title e ordina nel tempo", () => {
  const rows = [
    { uid: "u", titleId: "tardi", rating: 8, atMs: T0 + (5 * DAY) },
    { uid: "u", titleId: "presto", rating: 8, atMs: T0 },
  ];
  assert.deepStrictEqual(
    B.collapseRatingsByTitle(rows).map((r) => r.titleId),
    ["presto", "tardi"]
  );
});

test("collapseRatingsByTitle non mescola utenti diversi sullo stesso titolo", () => {
  const rows = [
    { uid: "u1", titleId: "a", rating: 9, level: "title", atMs: T0 },
    { uid: "u2", titleId: "a", rating: 3, level: "title", atMs: T0 },
  ];
  const out = B.collapseRatingsByTitle(rows);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out.map((r) => r.rating).sort(), [3, 9]);
});

test("buildHoldoutUsers non maschera i positivi da indovinare", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    uid: "u", titleId: `t${i}`, kind: "watched", rating: 0, positive: true, atMs: T0 + (i * DAY),
  }));
  const users = B.buildHoldoutUsers({ interactions: rows, testFraction: 0.2, minTrain: 5, random: B.seededRandom(1) });
  assert.strictEqual(users.length, 1);
  const u = users[0];
  // Ogni positivo tenuto da parte deve restare consigliabile.
  for (const id of u.positives) {
    assert.ok(!u.seenTitleIds.has(id), `il positivo ${id} non deve essere fra i gia' visti`);
  }
  assert.strictEqual(u.trainRows.length + u.positives.size, 20);
});

test("buildInteractions: il voto esplicito vince sullo stato implicito", () => {
  const out = B.buildInteractions({
    ratings: [{ uid: "u", titleId: "a", rating: 3, level: "title", atMs: T0 + DAY }],
    watched: [{ uid: "u", titleId: "a", state: "completed_unrated", atMs: T0 }],
  });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, "rating");
  assert.strictEqual(out[0].positive, false, "un voto 3 non e' un successo, anche se il titolo e' stato visto");
});

test("buildInteractions tiene fuori la watchlist dalla verita' di riferimento", () => {
  const out = B.buildInteractions({
    ratings: [],
    watched: [
      { uid: "u", titleId: "visto", state: "completed_unrated", atMs: T0 },
      { uid: "u", titleId: "salvato", state: "not_started", atMs: T0 },
      { uid: "u", titleId: "mai", state: "unseen", atMs: T0 },
    ],
  });
  assert.deepStrictEqual(out.map((r) => r.titleId), ["visto"]);
});

test("buildInteractions rispetta i flag di segnale", () => {
  const ratings = [{ uid: "u", titleId: "r", rating: 9, level: "title", atMs: T0 }];
  const watched = [{ uid: "u", titleId: "w", state: "rated", atMs: T0 }];
  assert.deepStrictEqual(
    B.buildInteractions({ ratings, watched, useWatched: false }).map((r) => r.titleId), ["r"]);
  assert.deepStrictEqual(
    B.buildInteractions({ ratings, watched, useRatings: false }).map((r) => r.titleId), ["w"]);
});
