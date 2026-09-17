"use strict";

const test = require("node:test");
const assert = require("node:assert");

const engine = require("../../lib/recommendationEngine");
const {
  buildSeedStats,
  buildAffinityMap,
  buildTasteProfile,
  scoreTasteBias,
  scoreCandidate,
  scorePeopleAffinity,
  buildPeopleAffinity,
  buildProviderAffinity,
  providerAffinityForCandidate,
  selectProviderRecommendationLane,
  matchSagaKey,
  areMatchRowsTooSimilar,
  diversifyMatchRows,
  pickMatchDeck,
  computeMatchPercent,
  isColdStartProfile,
  rankMatchCandidates,
  moodScore,
  selectTopWithDiversity,
  MATCH_TASTE_HALF_LIFE_MS,
} = engine;

const NOW = 1_750_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

// PRNG deterministico (mulberry32) per i test che toccano l'esplorazione.
function seededRandom(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function title(id, extra = {}) {
  return {
    id,
    name: id,
    type: "movie",
    status: "approved",
    genres: ["Azione"],
    year: 2020,
    ratingAvg: 7,
    ratingCount: 50,
    ...extra,
  };
}

test("buildSeedStats raccoglie generi, persone e tipo dominante", () => {
  const stats = buildSeedStats([
    title("a", { genres: ["Azione", "Thriller"], directors: ["Denis Villeneuve"], type: "movie", year: 2016 }),
    title("b", { genres: ["Azione"], cast: ["Ryan Gosling"], type: "movie", year: 2020 }),
    title("c", { genres: ["Commedia"], type: "tv", year: 2018 }),
  ]);

  assert.ok(stats.genreTokenSet.has("azione"));
  assert.ok(stats.genreTokenSet.has("thriller"));
  assert.ok(stats.directorSet.has("denis villeneuve"));
  assert.ok(stats.castSet.has("ryan gosling"));
  assert.strictEqual(stats.dominantType, "movie");
  assert.strictEqual(stats.avgYear, (2016 + 2020 + 2018) / 3);
});

test("buildSeedStats su lista vuota non esplode e lascia avgYear null", () => {
  const stats = buildSeedStats([]);
  assert.strictEqual(stats.avgYear, null);
  assert.strictEqual(stats.dominantType, "");
  assert.strictEqual(stats.genreTokenSet.size, 0);
});

test("provider affinity richiede due titoli e divide il peso tra piattaforme", () => {
  const seeds = [
    title("a", { watchProviderNames: ["Netflix", "Prime Video"] }),
    title("b", { watchProviderNames: ["Netflix"] }),
    title("c", { watchProviderNames: ["Disney Plus"] }),
  ];
  const affinity = buildProviderAffinity(seeds, new Map([["a", 2], ["b", 2], ["c", 5]]));

  assert.strictEqual(affinity.length, 1);
  assert.strictEqual(affinity[0].name, "Netflix");
  assert.strictEqual(affinity[0].evidenceTitleCount, 2);
  assert.strictEqual(affinity[0].score, 3);
});

test("provider affinity normalizza il nome e seleziona una lane solo da candidati compatibili", () => {
  const affinity = buildProviderAffinity([
    title("a", { watchProviderNames: ["Netflix"] }),
    title("b", { watchProviderNames: ["NETFLIX"] }),
  ]);
  const candidate = title("candidate", { watchProviderNames: ["Netflix"] });
  assert.strictEqual(providerAffinityForCandidate(candidate, affinity)?.name, "Netflix");

  const lane = selectProviderRecommendationLane([
    { ...title("other", { watchProviderNames: ["Prime Video"] }), _score: 9, _reasons: [] },
    { ...candidate, _score: 8, _reasons: ["affine"] },
  ], affinity, 10);
  assert.strictEqual(lane.provider.inferred, true);
  assert.deepStrictEqual(lane.items.map((item) => item.id), ["candidate"]);
});

test("buildAffinityMap applica il decay e scarta le feature troppo deboli", () => {
  const fresh = buildAffinityMap({ azione: { sum: 2, weight: 2, lastAt: NOW } }, NOW);
  assert.strictEqual(fresh.get("azione").decay, 1);
  assert.ok(Math.abs(fresh.get("azione").affinity - (2 / 3.2)) < 1e-9);

  // Esattamente una emivita fa: peso efficace dimezzato.
  const halfLife = buildAffinityMap(
    { azione: { sum: 2, weight: 2, lastAt: NOW - MATCH_TASTE_HALF_LIFE_MS } },
    NOW
  );
  assert.ok(Math.abs(halfLife.get("azione").decay - 0.5) < 1e-9);
  assert.ok(Math.abs(halfLife.get("azione").weight - 1) < 1e-9);

  // Peso efficace sotto MATCH_TASTE_MIN_WEIGHT (0.15) -> feature esclusa.
  const stale = buildAffinityMap(
    { azione: { sum: 0.2, weight: 0.2, lastAt: NOW - (10 * MATCH_TASTE_HALF_LIFE_MS) } },
    NOW
  );
  assert.strictEqual(stale.size, 0);

  // Peso non positivo o non finito -> ignorato.
  assert.strictEqual(buildAffinityMap({ x: { sum: 1, weight: 0 } }, NOW).size, 0);
  assert.strictEqual(buildAffinityMap({ x: { sum: 1, weight: "boh" } }, NOW).size, 0);
  assert.strictEqual(buildAffinityMap(null, NOW).size, 0);
});

test("buildAffinityMap clampa l'affinita' dentro [-1, 1]", () => {
  const positive = buildAffinityMap({ g: { sum: 999, weight: 1, lastAt: NOW } }, NOW);
  assert.strictEqual(positive.get("g").affinity, 1);
  const negative = buildAffinityMap({ g: { sum: -999, weight: 1, lastAt: NOW } }, NOW);
  assert.strictEqual(negative.get("g").affinity, -1);
});

test("buildTasteProfile somma il peso di generi, persone e registi (non i paesi)", () => {
  const profile = buildTasteProfile({
    confidenceScore: 42,
    featureSums: {
      genres: { azione: { sum: 2, weight: 2, lastAt: NOW } },
      people: { p1: { sum: 1, weight: 1, lastAt: NOW } },
      directors: { d1: { sum: 1, weight: 1, lastAt: NOW } },
      countries: { it: { sum: 5, weight: 5, lastAt: NOW } },
    },
  }, NOW);

  assert.strictEqual(profile.confidenceScore, 42);
  assert.ok(Math.abs(profile.totalWeight - 4) < 1e-9, `totalWeight=${profile.totalWeight}`);
  assert.strictEqual(profile.countries.size, 1);
});

test("buildTasteProfile su doc vuoto ritorna un profilo neutro", () => {
  const profile = buildTasteProfile({}, NOW);
  assert.strictEqual(profile.totalWeight, 0);
  assert.strictEqual(profile.confidenceScore, 0);
  assert.strictEqual(profile.genres.size, 0);
});

test("scoreTasteBias premia i generi amati e penalizza quelli rifiutati", () => {
  const loved = buildTasteProfile({
    featureSums: { genres: { Azione: { sum: 3, weight: 3, lastAt: NOW } } },
  }, NOW);
  const liked = scoreTasteBias(title("x", { genres: ["Azione"] }), loved);
  assert.ok(liked.bonus > 0);
  assert.strictEqual(liked.penalty, 0);
  assert.ok(liked.reasons.includes("generi in linea con i tuoi gusti recenti"));

  const hated = buildTasteProfile({
    featureSums: { genres: { Horror: { sum: -3, weight: 3, lastAt: NOW } } },
  }, NOW);
  const disliked = scoreTasteBias(title("y", { genres: ["Horror"] }), hated);
  assert.strictEqual(disliked.bonus, 0);
  assert.ok(disliked.penalty > 0);
});

test("scoreTasteBias senza profilo e' neutro", () => {
  const out = scoreTasteBias(title("x"), null);
  assert.deepStrictEqual(out, { bonus: 0, penalty: 0, reasons: [] });
});

test("scoreCandidate premia generi, regia, cast e collegamenti condivisi", () => {
  const seedStats = buildSeedStats([
    title("seed", {
      genres: ["Azione", "Thriller"],
      directors: ["Denis Villeneuve"],
      cast: ["Ryan Gosling"],
      related: ["rel"],
    }),
  ]);

  const neutral = scoreCandidate(title("n", { genres: ["Commedia"], ratingAvg: 0, ratingCount: 0 }), seedStats);
  const sameGenre = scoreCandidate(title("g", { genres: ["Azione"], ratingAvg: 0, ratingCount: 0 }), seedStats);
  const sameDirector = scoreCandidate(
    title("d", { genres: ["Commedia"], directors: ["Denis Villeneuve"], ratingAvg: 0, ratingCount: 0 }),
    seedStats
  );
  const related = scoreCandidate(title("rel", { genres: ["Commedia"], ratingAvg: 0, ratingCount: 0 }), seedStats);

  assert.ok(sameGenre.score > neutral.score);
  assert.ok(sameDirector.score > neutral.score);
  assert.ok(related.score > neutral.score);
  assert.ok(related.reasons.includes("collegato ai tuoi preferiti"));
  // Un candidato senza alcun aggancio ha comunque una motivazione.
  assert.ok(neutral.reasons.length >= 1);
});

test("scoreCandidate somma il bonus collaborativo con tetto", () => {
  const seedStats = buildSeedStats([title("seed")]);
  const base = scoreCandidate(title("c"), seedStats);
  const withCollab = scoreCandidate(title("c"), seedStats, { collab: { score: 3, voters: 9 } });
  const huge = scoreCandidate(title("c"), seedStats, { collab: { score: 999, voters: 9 } });

  assert.ok(withCollab.score > base.score);
  // clamp(collab.score * 0.8, 0, 4.8)
  assert.ok(Math.abs((huge.score - base.score) - 4.8) < 1e-9);
});

test("moodScore penalizza chi e' fuori mood e ignora mood 'all'", () => {
  assert.deepStrictEqual(moodScore(title("x"), "all"), { bonus: 0, reason: "" });
  const fit = moodScore(title("x", { genres: ["Commedia"] }), "light");
  assert.ok(fit.bonus > 0);
  assert.strictEqual(fit.reason, "mood leggero");
  const miss = moodScore(title("x", { genres: ["Horror"] }), "light");
  assert.strictEqual(miss.bonus, -0.7);
});

test("buildPeopleAffinity pesa i seed e scorePeopleAffinity li ritrova", () => {
  const seeds = [title("s1", { directors: ["Denis Villeneuve"], cast: ["Ryan Gosling"] })];
  const affinity = buildPeopleAffinity(seeds, new Map([["s1", 4]]));

  const hit = scorePeopleAffinity(title("c", { directors: ["Denis Villeneuve"] }), affinity);
  assert.ok(hit.bonus > 0);
  assert.ok(hit.reasons.includes("registi affini ai tuoi gusti"));

  const miss = scorePeopleAffinity(title("c", { directors: ["Chi Sa"] }), affinity);
  assert.strictEqual(miss.bonus, 0);
  assert.deepStrictEqual(miss.reasons, []);

  // Il bonus e' comunque limitato a 4.4.
  const heavy = buildPeopleAffinity(
    Array.from({ length: 40 }, (_, i) => title(`s${i}`, { directors: ["Denis Villeneuve"] })),
    new Map()
  );
  assert.ok(scorePeopleAffinity(title("c", { directors: ["Denis Villeneuve"] }), heavy).bonus <= 4.4);
});

test("matchSagaKey normalizza i sequel sulla stessa chiave", () => {
  assert.strictEqual(matchSagaKey({ name: "John Wick" }), matchSagaKey({ name: "John Wick 2" }));
  assert.strictEqual(matchSagaKey({ name: "John Wick" }), matchSagaKey({ name: "John Wick: Chapter 4" }));
  assert.notStrictEqual(matchSagaKey({ name: "John Wick" }), matchSagaKey({ name: "Dune" }));
});

test("areMatchRowsTooSimilar riconosce stesso id, stessa saga e nome contenuto", () => {
  assert.ok(areMatchRowsTooSimilar({ id: "a", name: "X" }, { id: "a", name: "X" }));
  assert.ok(areMatchRowsTooSimilar({ id: "a", name: "John Wick" }, { id: "b", name: "John Wick 3" }));
  assert.ok(areMatchRowsTooSimilar({ id: "a", name: "Interstellar" }, { id: "b", name: "Interstellar Extended" }));
  assert.ok(!areMatchRowsTooSimilar({ id: "a", name: "Dune" }, { id: "b", name: "Arrival" }));
});

test("diversifyMatchRows separa i titoli della stessa saga", () => {
  const rows = [
    { id: "1", name: "John Wick" },
    { id: "2", name: "John Wick 2" },
    { id: "3", name: "Dune" },
    { id: "4", name: "Arrival" },
  ];
  const out = diversifyMatchRows(rows, 4, { minGap: 2 });
  assert.strictEqual(out.length, 4);
  const idx1 = out.findIndex((r) => r.id === "1");
  const idx2 = out.findIndex((r) => r.id === "2");
  assert.ok(Math.abs(idx1 - idx2) > 1, `saga adiacente: ${out.map((r) => r.id).join(",")}`);
});

test("selectTopWithDiversity limita la quota per tipo ma riempie comunque", () => {
  const rows = Array.from({ length: 10 }, (_, i) => title(`m${i}`, { type: "movie" }));
  const out = selectTopWithDiversity(rows, 6);
  assert.strictEqual(out.length, 6);
  assert.strictEqual(new Set(out.map((r) => r.id)).size, 6);
});

test("pickMatchDeck e' riproducibile con random e nowMs iniettati", () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({
    ...title(`t${i}`, { genres: [`G${i % 7}`] }),
    _score: 10 - (i * 0.1),
  }));

  const a = pickMatchDeck(rows, 18, { random: seededRandom(7), nowMs: NOW });
  const b = pickMatchDeck(rows, 18, { random: seededRandom(7), nowMs: NOW });
  assert.deepStrictEqual(a.map((r) => r.id), b.map((r) => r.id));
  assert.strictEqual(a.length, 18);
  assert.strictEqual(new Set(a.map((r) => r.id)).size, 18, "nessun duplicato nel deck");
});

test("pickMatchDeck non supera max e regge pool piu' piccoli della richiesta", () => {
  const few = Array.from({ length: 4 }, (_, i) => ({ ...title(`t${i}`), _score: 5 - i }));
  const out = pickMatchDeck(few, 18, { random: seededRandom(1), nowMs: NOW });
  assert.ok(out.length <= 4);
  assert.strictEqual(pickMatchDeck([], 18).length, 0);
});

test("computeMatchPercent resta nel range mostrato in UI", () => {
  assert.strictEqual(computeMatchPercent({ _score: 10, ratingAvg: 10 }, 10), 99);
  const low = computeMatchPercent({ _score: 0, ratingAvg: 0 }, 10);
  assert.ok(low >= 35 && low <= 99, `low=${low}`);
});

test("isColdStartProfile scatta con pochi seed o poca confidence", () => {
  assert.ok(isColdStartProfile(2, 90));
  assert.ok(isColdStartProfile(10, 5));
  assert.ok(!isColdStartProfile(10, 90));
});

test("rankMatchCandidates esclude, ordina e non serve mai un deck vuoto", () => {
  const seedStats = buildSeedStats([title("seed", { genres: ["Azione"] })]);
  const candidates = [
    title("buono", { genres: ["Azione"], ratingCount: 100, ratingAvg: 8 }),
    title("escluso", { genres: ["Azione"], ratingCount: 100, ratingAvg: 9 }),
    title("scarso", { genres: ["Documentario"], ratingCount: 0, ratingAvg: 0, year: 1970 }),
  ];

  const { scored, isColdStart } = rankMatchCandidates({
    candidates,
    excludedIds: new Set(["escluso"]),
    seedStats,
    seedCount: 1,
    max: 5,
  });

  const ids = scored.map((r) => r.id);
  assert.ok(!ids.includes("escluso"), "il titolo escluso non deve comparire");
  assert.ok(ids.includes("buono"));
  assert.ok(isColdStart, "1 solo seed = cold start");
  // Ordinamento decrescente per score.
  for (let i = 1; i < scored.length; i++) {
    assert.ok(scored[i - 1]._score >= scored[i]._score);
  }
  // Il fallback popolare ha ripescato anche il titolo debole.
  assert.ok(ids.includes("scarso"), "il filler deve riempire fino a max");
});

test("rankMatchCandidates applica il taste bias solo con evidenza sufficiente", () => {
  const seedStats = buildSeedStats([title("seed", { genres: ["Commedia"] })]);
  const candidates = [
    title("azione", { genres: ["Azione"], ratingCount: 50 }),
    title("horror", { genres: ["Horror"], ratingCount: 50 }),
  ];

  const strongProfile = buildTasteProfile({
    confidenceScore: 80,
    featureSums: {
      genres: {
        Azione: { sum: 4, weight: 4, lastAt: NOW },
        Horror: { sum: -4, weight: 4, lastAt: NOW },
      },
    },
  }, NOW);

  const biased = rankMatchCandidates({
    candidates,
    excludedIds: new Set(),
    seedStats,
    seedCount: 5,
    tasteProfile: strongProfile,
    max: 2,
  });
  assert.ok(biased.hasTasteBias);
  assert.strictEqual(biased.scored[0].id, "azione", "il genere amato deve stare davanti");

  // Profilo praticamente vuoto: nessun bias applicato.
  const weak = rankMatchCandidates({
    candidates,
    excludedIds: new Set(),
    seedStats,
    seedCount: 5,
    tasteProfile: buildTasteProfile({ featureSums: {} }, NOW),
    max: 2,
  });
  assert.ok(!weak.hasTasteBias);
});

test("rankMatchCandidates: la soglia cold start e' piu' permissiva", () => {
  const seedStats = buildSeedStats([title("seed", { genres: ["Azione"] })]);
  const candidates = [title("tiepido", { genres: ["Documentario"], ratingCount: 3, ratingAvg: 5, year: 2000 })];

  const cold = rankMatchCandidates({ candidates, excludedIds: new Set(), seedStats, seedCount: 1, max: 0 });
  const warm = rankMatchCandidates({
    candidates,
    excludedIds: new Set(),
    seedStats,
    seedCount: 9,
    tasteProfile: buildTasteProfile({ confidenceScore: 90, featureSums: {} }, NOW),
    max: 0,
  });

  assert.strictEqual(cold.threshold, 0.35);
  assert.strictEqual(warm.threshold, 0.65);
});

test("scoreCandidate e' stabile: stesso input, stesso score", () => {
  const seedStats = buildSeedStats([title("seed", { genres: ["Azione"], cast: ["Tizio"] })]);
  const candidate = title("c", { genres: ["Azione"], cast: ["Tizio"], year: 2021 });
  const first = scoreCandidate(candidate, seedStats, { genreLabelMap: null });
  const second = scoreCandidate(candidate, seedStats, { genreLabelMap: null });
  assert.strictEqual(first.score, second.score);
  assert.deepStrictEqual(first.reasons, second.reasons);
});

test("il decay di 30 giorni riduce il peso ma non lo azzera", () => {
  const map = buildAffinityMap({ g: { sum: 3, weight: 3, lastAt: NOW - (30 * DAY) } }, NOW);
  const entry = map.get("g");
  assert.ok(entry.decay < 1 && entry.decay > 0.8, `decay=${entry.decay}`);
});
