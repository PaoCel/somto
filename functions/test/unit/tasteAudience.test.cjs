const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_TASTE_AUDIENCE_LIMIT,
  DEFAULT_TASTE_NOTIFY_LIMIT,
  MIN_TASTE_NOTIFY_SCORE,
  selectTasteNotifyUids,
  MIN_TASTE_CONFIDENCE,
  TASTE_DAILY_CAP,
  titleAsCandidate,
  rankTasteAudience,
  filterByDailyCap,
} = require("../../lib/tasteAudience");

const NOW_MS = Date.parse("2026-08-20T10:00:00.000Z");

/** Profilo gusti con affinita' su un genere. `sum/(weight+1.2)` → affinita'. */
function profileWith({ uid, genre, sum, weight = 1, confidence = 80, lastAt = NOW_MS }) {
  return {
    uid,
    data: {
      confidenceScore: confidence,
      featureSums: { genres: { [genre]: { sum, weight, lastAt } } },
    },
  };
}

const HORROR = { genres: ["tmdb_27", "tmdb_53"], castIds: [], directorIds: [], year: 2026, type: "movie" };

test("titleAsCandidate normalizza i campi che servono al punteggio", () => {
  const candidate = titleAsCandidate({ genres: ["tmdb_27"], castIds: ["a"], type: "tv", year: "2026" });
  assert.deepEqual(candidate.genres, ["tmdb_27"]);
  assert.deepEqual(candidate.castIds, ["a"]);
  assert.equal(candidate.type, "tv");
  assert.equal(candidate.year, 2026);
});

test("chi guarda il genere entra, chi lo evita no", () => {
  const out = rankTasteAudience({
    titleData: HORROR,
    profiles: [
      profileWith({ uid: "horror_fan", genre: "tmdb_27", sum: 3 }),
      profileWith({ uid: "horror_no", genre: "tmdb_27", sum: -3 }),
    ],
    nowMs: NOW_MS,
  });
  assert.deepEqual(out.map((row) => row.uid), ["horror_fan"]);
});

test("l'ordine e' per affinita' decrescente, deterministico a parita'", () => {
  const out = rankTasteAudience({
    titleData: HORROR,
    profiles: [
      profileWith({ uid: "tiepido", genre: "tmdb_27", sum: 1 }),
      profileWith({ uid: "zeta", genre: "tmdb_27", sum: 3 }),
      profileWith({ uid: "alfa", genre: "tmdb_27", sum: 3 }),
    ],
    nowMs: NOW_MS,
  });
  assert.deepEqual(out.map((row) => row.uid), ["alfa", "zeta", "tiepido"]);
});

test("chi e' gia' raggiunto per libreria non viene ricontato", () => {
  const out = rankTasteAudience({
    titleData: HORROR,
    profiles: [profileWith({ uid: "gia_dentro", genre: "tmdb_27", sum: 3 })],
    excludeUids: ["gia_dentro"],
    nowMs: NOW_MS,
  });
  assert.deepEqual(out, []);
});

test("un profilo con poca confidenza non tira a indovinare", () => {
  const out = rankTasteAudience({
    titleData: HORROR,
    profiles: [profileWith({ uid: "nuovo", genre: "tmdb_27", sum: 3, confidence: MIN_TASTE_CONFIDENCE - 1 })],
    nowMs: NOW_MS,
  });
  assert.deepEqual(out, []);
});

test("un titolo senza generi ne' cast non produce pubblico", () => {
  const out = rankTasteAudience({
    titleData: { genres: [], castIds: [], directorIds: [] },
    profiles: [profileWith({ uid: "chiunque", genre: "tmdb_27", sum: 3 })],
    nowMs: NOW_MS,
  });
  assert.deepEqual(out, []);
});

test("il tetto e' rispettato e ha un default esplicito", () => {
  const profiles = Array.from(
    { length: DEFAULT_TASTE_AUDIENCE_LIMIT + 5 },
    (_, i) => profileWith({ uid: `u${i}`, genre: "tmdb_27", sum: 3 })
  );
  assert.equal(rankTasteAudience({ titleData: HORROR, profiles, limit: 5, nowMs: NOW_MS }).length, 5);
  assert.equal(
    rankTasteAudience({ titleData: HORROR, profiles, nowMs: NOW_MS }).length,
    DEFAULT_TASTE_AUDIENCE_LIMIT
  );
});

test("un genere che il titolo non ha non porta nessuno", () => {
  const out = rankTasteAudience({
    titleData: HORROR,
    profiles: [profileWith({ uid: "commedie", genre: "tmdb_35", sum: 3 })],
    nowMs: NOW_MS,
  });
  assert.deepEqual(out, []);
});

test("il tetto giornaliero toglie chi ne ha gia' ricevuti abbastanza", () => {
  const rows = [{ uid: "a" }, { uid: "b" }, { uid: "c" }];
  const counts = new Map([["a", TASTE_DAILY_CAP], ["b", TASTE_DAILY_CAP - 1]]);
  assert.deepEqual(filterByDailyCap(rows, counts).map((row) => row.uid), ["b", "c"]);
});

test("senza contatori nessuno viene escluso", () => {
  const rows = [{ uid: "a" }, { uid: "b" }];
  assert.equal(filterByDailyCap(rows).length, 2);
});

test("la notifica va solo ai primissimi della classifica", () => {
  const rows = [
    { uid: "alta", score: 1.4 },
    { uid: "soglia", score: MIN_TASTE_NOTIFY_SCORE },
    { uid: "sotto", score: MIN_TASTE_NOTIFY_SCORE - 0.01 },
    { uid: "quasi-zero", score: 0.02 },
  ];
  assert.deepEqual(selectTasteNotifyUids(rows), ["alta", "soglia"]);
});

test("il tetto della notifica taglia anche i punteggi alti", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ uid: `u${i}`, score: 1 }));
  assert.equal(selectTasteNotifyUids(rows).length, DEFAULT_TASTE_NOTIFY_LIMIT);
  assert.equal(selectTasteNotifyUids(rows, { limit: 3 }).length, 3);
  assert.deepEqual(selectTasteNotifyUids(rows, { limit: 0 }), []);
});

test("senza pubblico per affinita' non si notifica nessuno", () => {
  assert.deepEqual(selectTasteNotifyUids([]), []);
  assert.deepEqual(selectTasteNotifyUids(), []);
  assert.deepEqual(selectTasteNotifyUids([{ uid: "", score: 9 }]), []);
});

// --- Provenienza (2026-08-26) -----------------------------------------------

const {
  PROVENANCE_MIN_TITLES,
  PROVENANCE_SCORE_MAX,
  buildProvenanceBaseline,
  provenanceLift,
  titleCountries,
} = require("../../lib/tasteAudience");

/** Peso del bucket paesi per N titoli di quel paese (0.12 a titolo). */
function countryWeight(titles) {
  return titles * 0.12;
}

/** Profilo con un bucket paesi realistico: { codice: titoli visti }. */
function profileWithCountries({ uid, countries, genre = "tmdb_9648", genreSum = 0.6, confidence = 80 }) {
  const bucket = {};
  for (const [code, titles] of Object.entries(countries)) {
    const weight = countryWeight(titles);
    // delta positivo debole, come `import_seen`: e' il caso normale post-import
    bucket[code] = { sum: 0.3 * weight, weight, lastAt: NOW_MS };
  }
  return {
    uid,
    data: {
      confidenceScore: confidence,
      featureSums: {
        genres: { [genre]: { sum: genreSum, weight: 1, lastAt: NOW_MS } },
        countries: bucket,
      },
    },
  };
}

const KDRAMA = { genres: ["tmdb_9648", "tmdb_80"], castIds: [], directorIds: [], meta: { originCountry: ["KR"] } };

test("i paesi del titolo si leggono da meta.originCountry", () => {
  assert.deepEqual(titleCountries({ meta: { originCountry: ["KR", "JP"] } }), ["KR", "JP"]);
  assert.deepEqual(titleCountries({ countries: ["IT"], meta: { originCountry: ["KR"] } }), ["IT"]);
  assert.deepEqual(titleCountries({}), []);
  assert.deepEqual(titleAsCandidate(KDRAMA).countries, ["KR"]);
});

test("la baseline e' la quota di ogni paese su tutti i profili", () => {
  const baseline = buildProvenanceBaseline([
    profileWithCountries({ uid: "a", countries: { US: 90, KR: 10 } }),
    profileWithCountries({ uid: "b", countries: { US: 100 } }),
  ]);
  assert.equal(Math.round(baseline.get("US") * 100), 95);
  assert.equal(Math.round(baseline.get("KR") * 100), 5);
});

test("baseline vuota quando nessun profilo ha paesi", () => {
  assert.equal(buildProvenanceBaseline([]).size, 0);
  assert.equal(buildProvenanceBaseline([profileWith({ uid: "a", genre: "tmdb_27", sum: 2 })]).size, 0);
});

test("chi guarda coreano molto piu' della media prende il bonus, chi e' nella media no", () => {
  const profiles = [
    profileWithCountries({ uid: "kfan", countries: { US: 60, KR: 40 } }),
    profileWithCountries({ uid: "medio", countries: { US: 990, KR: 10 } }),
  ];
  const baseline = buildProvenanceBaseline(profiles);
  const kfan = provenanceLift(profiles[0].data, ["KR"], baseline);
  const medio = provenanceLift(profiles[1].data, ["KR"], baseline);
  assert.ok(kfan > medio, "chi ne guarda di piu' deve stare sopra");
  assert.ok(kfan > 1);
});

test("il paese sotto la media di popolazione non da' bonus", () => {
  const profiles = [
    profileWithCountries({ uid: "kfan", countries: { KR: 100 } }),
    profileWithCountries({ uid: "poco", countries: { US: 99, KR: 1 } }),
  ];
  const baseline = buildProvenanceBaseline(profiles);
  assert.equal(provenanceLift(profiles[1].data, ["KR"], baseline), 0);
});

test("l'evidenza sottile viene smorzata: un titolo solo non vale una libreria", () => {
  const many = profileWithCountries({ uid: "many", countries: { KR: PROVENANCE_MIN_TITLES, US: 92 } });
  const one = profileWithCountries({ uid: "one", countries: { KR: 1 } });
  const baseline = buildProvenanceBaseline([many, one, profileWithCountries({ uid: "us", countries: { US: 400 } })]);
  const liftMany = provenanceLift(many.data, ["KR"], baseline);
  const liftOne = provenanceLift(one.data, ["KR"], baseline);
  // "one" ha quota 100% (scostamento massimo) ma un ottavo dell'evidenza
  assert.ok(liftOne < liftMany, `atteso ${liftOne} < ${liftMany}`);
});

test("chi guarda quel paese ma lo vota male non prende bonus", () => {
  const hater = {
    uid: "hater",
    data: {
      confidenceScore: 80,
      featureSums: {
        genres: { tmdb_9648: { sum: 0.6, weight: 1, lastAt: NOW_MS } },
        countries: { KR: { sum: -2, weight: countryWeight(30), lastAt: NOW_MS } },
      },
    },
  };
  const baseline = buildProvenanceBaseline([hater, profileWithCountries({ uid: "us", countries: { US: 300 } })]);
  assert.equal(provenanceLift(hater.data, ["KR"], baseline), 0);
});

test("senza bucket paesi il punteggio resta quello dei generi", () => {
  const senza = profileWith({ uid: "senza", genre: "tmdb_9648", sum: 2 });
  const rows = rankTasteAudience({ titleData: KDRAMA, profiles: [senza], nowMs: NOW_MS });
  assert.equal(rows.length, 1);
  assert.ok(!rows[0].reasons.includes("guardi molto piu' della media titoli da li'"));
});

test("a parita' di generi, chi guarda coreano passa davanti", () => {
  const profiles = [
    profileWithCountries({ uid: "kfan", countries: { KR: 40, US: 60 }, genreSum: 0.6 }),
    profileWithCountries({ uid: "generalista", countries: { US: 1000 }, genreSum: 0.6 }),
  ];
  const rows = rankTasteAudience({ titleData: KDRAMA, profiles, nowMs: NOW_MS });
  assert.equal(rows[0].uid, "kfan");
  assert.ok(rows[0].score > rows[1].score);
  assert.ok(rows[0].reasons.includes("guardi molto piu' della media titoli da li'"));
});

test("il bonus provenienza non puo' sfondare il tetto", () => {
  const estremo = profileWithCountries({ uid: "estremo", countries: { KR: 500 } });
  const filler = Array.from({ length: 40 }, (_, i) => profileWithCountries({ uid: `us${i}`, countries: { US: 500 } }));
  const baseline = buildProvenanceBaseline([estremo, ...filler]);
  const lift = provenanceLift(estremo.data, ["KR"], baseline);
  assert.ok(Math.min(lift * 0.8, PROVENANCE_SCORE_MAX) <= PROVENANCE_SCORE_MAX);
});

test("un titolo senza generi ne' cast non fa pubblico solo perche' e' straniero", () => {
  const rows = rankTasteAudience({
    titleData: { meta: { originCountry: ["KR"] } },
    profiles: [profileWithCountries({ uid: "kfan", countries: { KR: 50 } })],
    nowMs: NOW_MS,
  });
  assert.deepEqual(rows, []);
});
