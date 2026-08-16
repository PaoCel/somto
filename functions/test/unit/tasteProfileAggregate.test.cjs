const test = require("node:test");
const assert = require("node:assert/strict");

const {
  FEATURE_WEIGHTS,
  ACTION_WEIGHTS,
  normalizedFromRating,
  deltaForAction,
  extractTitleFeatures,
  applyTitleDelta,
  foldTitleDeltas,
  cumulativeWeight,
  computeConfidenceScore,
  pruneFeatureSums,
  buildImportTasteInputs,
} = require("../../lib/tasteProfileAggregate");

// --- feature weights sanity (devono restare identici al trigger) ---
test("FEATURE_WEIGHTS matchano il trigger storico", () => {
  assert.deepEqual(FEATURE_WEIGHTS.genres, [0.6, 0.36, 0.24]);
  assert.deepEqual(FEATURE_WEIGHTS.people, [0.3, 0.18, 0.12]);
  assert.deepEqual(FEATURE_WEIGHTS.directors, [0.25]);
  assert.deepEqual(FEATURE_WEIGHTS.countries, [0.12]);
});

// --- normalizedFromRating ---
test("normalizedFromRating mappa 1..10 su [-1,1]", () => {
  assert.equal(normalizedFromRating(10), 1);
  assert.equal(normalizedFromRating(1), -1);
  assert.equal(normalizedFromRating(5.5), 0);
  assert.ok(normalizedFromRating(2) < 0);
  assert.ok(normalizedFromRating(8) > 0);
  // fuori scala → clamp
  assert.equal(normalizedFromRating(0), -1);
  assert.equal(normalizedFromRating(99), 1);
});

// --- deltaForAction ---
test("deltaForAction: rating usa il voto reale, import_seen è positivo debole", () => {
  assert.equal(deltaForAction("rating", 10), 1 * 1.0);
  assert.equal(deltaForAction("rating", 1), -1 * 1.0);
  assert.equal(deltaForAction("import_seen"), 0.3 * 0.15);
  assert.ok(deltaForAction("import_seen") > 0);
  assert.equal(deltaForAction("match_seen"), 0); // neutro, come prima
  assert.equal(deltaForAction("sconosciuto"), 0);
});

// --- extractTitleFeatures ---
test("extractTitleFeatures tronca a 3/3/1/1 e usa i fallback", () => {
  const f = extractTitleFeatures({
    genres: ["g1", "g2", "g3", "g4"],
    cast: ["c1", "c2", "c3", "c4"],
    directors: ["d1", "d2"],
    originCountry: ["IT", "US"],
  });
  assert.deepEqual(f.genres, ["g1", "g2", "g3"]);
  assert.deepEqual(f.people, ["c1", "c2", "c3"]);
  assert.deepEqual(f.directors, ["d1"]);
  assert.deepEqual(f.countries, ["IT"]);
});

test("extractTitleFeatures preferisce castIds/directorIds/countries e countryCode", () => {
  const f = extractTitleFeatures({
    genres: [],
    castIds: ["p1"],
    cast: ["ignored"],
    directorIds: ["dir1"],
    countryCode: "GB",
  });
  assert.deepEqual(f.people, ["p1"]);
  assert.deepEqual(f.directors, ["dir1"]);
  assert.deepEqual(f.countries, ["GB"]);
});

test("extractTitleFeatures difensivo su titolo sparso/null", () => {
  const f = extractTitleFeatures(null);
  assert.deepEqual(f, { genres: [], people: [], directors: [], countries: [] });
  const stub = extractTitleFeatures({ title: "bare stub" });
  assert.deepEqual(stub.genres, []);
  assert.deepEqual(stub.people, []);
});

// --- applyTitleDelta: matematica identica al trigger ---
test("applyTitleDelta produce sum/weight attesi per un singolo titolo", () => {
  const fs = {};
  const feats = { genres: ["g1", "g2"], people: ["p1"], directors: ["d1"], countries: ["IT"] };
  const added = applyTitleDelta(fs, feats, 1.0, "T0");

  // sum = delta*w, weight = w
  assert.equal(fs.genres.g1.sum, 0.6);
  assert.equal(fs.genres.g1.weight, 0.6);
  assert.equal(fs.genres.g2.sum, 0.36);
  assert.equal(fs.people.p1.sum, 0.3);
  assert.equal(fs.directors.d1.sum, 0.25);
  assert.equal(fs.countries.IT.sum, 0.12);
  assert.equal(fs.genres.g1.lastAt, "T0");

  // peso aggiunto = somma di tutti i w applicati
  assert.equal(added, 0.6 + 0.36 + 0.3 + 0.25 + 0.12);
});

test("applyTitleDelta accumula sullo stesso id e propaga delta negativo", () => {
  const fs = {};
  applyTitleDelta(fs, { genres: ["g1"] }, 1.0, "T0");
  applyTitleDelta(fs, { genres: ["g1"] }, -1.0, "T1");
  // sum: +0.6 -0.6 = 0 ; weight: 0.6 + 0.6 = 1.2 (il peso non si annulla)
  assert.equal(fs.genres.g1.sum, 0);
  assert.equal(fs.genres.g1.weight, 1.2);
  assert.equal(fs.genres.g1.lastAt, "T1");
});

test("applyTitleDelta no-op su delta 0 o non finito", () => {
  const fs = {};
  assert.equal(applyTitleDelta(fs, { genres: ["g1"] }, 0, "T0"), 0);
  assert.equal(applyTitleDelta(fs, { genres: ["g1"] }, NaN, "T0"), 0);
  assert.deepEqual(fs, {});
});

// --- foldTitleDeltas: fold di N titoli in un colpo ---
test("foldTitleDeltas accumula più titoli", () => {
  const inputs = [
    { features: { genres: ["azione"] }, delta: deltaForAction("import_seen"), createdAt: "T" },
    { features: { genres: ["azione"] }, delta: deltaForAction("import_seen"), createdAt: "T" },
    { features: { genres: ["dramma"] }, delta: deltaForAction("rating", 2), createdAt: "T" },
  ];
  const { featureSums } = foldTitleDeltas({}, inputs);
  // azione: due seen positivi → sum>0, weight = 0.6*2
  assert.ok(featureSums.genres.azione.sum > 0);
  assert.equal(featureSums.genres.azione.weight, 1.2);
  // dramma: voto 2/10 → sum negativo (spinge lontano)
  assert.ok(featureSums.genres.dramma.sum < 0);
});

// --- confidence cumulativa ---
test("computeConfidenceScore cresce con l'evidenza (cumulativa, non per-segnale)", () => {
  const fs = {};
  assert.equal(computeConfidenceScore(fs, 0), 0);

  // un solo titolo, no onboarding
  applyTitleDelta(fs, { genres: ["g1", "g2", "g3"], people: ["p1"], directors: ["d1"] }, 1, "T");
  const c1 = computeConfidenceScore(fs, 0);
  assert.ok(c1 > 0);

  // molti titoli → confidence più alta (accumula), poi satura sotto 100
  for (let i = 0; i < 30; i += 1) {
    applyTitleDelta(fs, { genres: [`g${i}`], people: [`p${i}`], directors: [`d${i}`] }, 1, "T");
  }
  const cMany = computeConfidenceScore(fs, 0);
  assert.ok(cMany > c1);
  assert.ok(cMany <= 100);
  // onboarding aggiunge 15 per livello
  assert.equal(
    computeConfidenceScore({}, 1),
    15,
  );
});

test("cumulativeWeight esclude le countries (come loadTasteProfile)", () => {
  const fs = {};
  applyTitleDelta(fs, { countries: ["IT"] }, 1, "T");
  assert.equal(cumulativeWeight(fs), 0);
  applyTitleDelta(fs, { genres: ["g1"] }, 1, "T");
  assert.equal(cumulativeWeight(fs), 0.6);
});

// --- prune: doc bounded dopo import massivo ---
test("pruneFeatureSums tiene il top-K per peso", () => {
  const bucket = {};
  for (let i = 0; i < 500; i += 1) {
    bucket[`p${i}`] = { sum: i, weight: i, lastAt: "T" };
  }
  const fs = { people: bucket, genres: {}, directors: {}, countries: {} };
  pruneFeatureSums(fs, { people: 400, genres: 50, directors: 250, countries: 80 });
  assert.equal(Object.keys(fs.people).length, 400);
  // i pesi più bassi (p0..p99) devono essere caduti, i più alti restare
  assert.ok(!("p0" in fs.people));
  assert.ok("p499" in fs.people);
});

test("pruneFeatureSums no-op sotto il cap", () => {
  const fs = { genres: { g1: { sum: 1, weight: 0.6, lastAt: "T" } } };
  pruneFeatureSums(fs);
  assert.ok("g1" in fs.genres);
});

// --- buildImportTasteInputs: voto vince su visto, scarta neutro/senza-feature ---
test("buildImportTasteInputs: voto override, import_seen di default, skip", () => {
  const featuresByTitleId = new Map([
    ["a", { genres: ["azione"] }],
    ["b", { genres: ["dramma"] }],
    ["c", { genres: ["horror"] }],
    // "d" senza feature note → deve essere scartato
  ]);
  const ratingByTitleId = new Map([
    ["b", 2],   // voto basso → delta negativo, vince su import_seen
    ["c", 5.5], // voto neutro → delta 0 → scartato
  ]);
  const inputs = buildImportTasteInputs({
    watchedTitleIds: ["a", "b", "c", "d"],
    featuresByTitleId,
    ratingByTitleId,
  });
  const byId = new Map(inputs.map((i) => [i.titleId, i]));

  // a: nessun voto → import_seen positivo
  assert.ok(byId.get("a").delta > 0);
  // b: voto 2 → negativo
  assert.ok(byId.get("b").delta < 0);
  // c: neutro → assente; d: senza feature → assente
  assert.ok(!byId.has("c"));
  assert.ok(!byId.has("d"));
  assert.equal(inputs.length, 2);
});

test("buildImportTasteInputs difensivo su Map assenti", () => {
  const inputs = buildImportTasteInputs({ watchedTitleIds: ["x"] });
  assert.deepEqual(inputs, []);
});
