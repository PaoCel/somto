const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MIN_SHARED_TITLES,
  ratingAgreement,
  rarityWeight,
  pickSeedTitles,
  scoreCandidates,
} = require("../../lib/peopleSuggestions");

// --- accordo fra voti ---
test("ratingAgreement: voto identico = 1, agli estremi = 0", () => {
  assert.equal(ratingAgreement(10, 10), 1);
  assert.equal(ratingAgreement(10, 1), 0);
  assert.equal(ratingAgreement(8, 6), clampRound(1 - 2 / 9));
});

test("ratingAgreement: voto non numerico non conta", () => {
  assert.equal(ratingAgreement(8, null), 0);
  assert.equal(ratingAgreement(undefined, 8), 0);
});

// --- rarita' ---
test("rarityWeight: piu' votanti, meno segnale", () => {
  const pochi = rarityWeight(2);
  const molti = rarityWeight(80);
  assert.ok(pochi > molti);
  assert.equal(rarityWeight(1), 1);
});

test("rarityWeight: valori non validi trattati come un solo votante", () => {
  assert.equal(rarityWeight(0), 1);
  assert.equal(rarityWeight(-5), 1);
  assert.equal(rarityWeight("x"), 1);
});

// --- scelta dei seed ---
test("pickSeedTitles: prima i voti alti, poi i piu' recenti", () => {
  const seeds = pickSeedTitles([
    { titleId: "b", rating: 7, updatedAtMs: 100 },
    { titleId: "a", rating: 10, updatedAtMs: 10 },
    { titleId: "c", rating: 7, updatedAtMs: 900 },
  ]);
  assert.deepEqual(seeds, ["a", "c", "b"]);
});

test("pickSeedTitles: niente duplicati, niente voti a zero", () => {
  const seeds = pickSeedTitles([
    { titleId: "a", rating: 9 },
    { titleId: "a", rating: 4 },
    { titleId: "b", rating: 0 },
    { titleId: "", rating: 8 },
  ]);
  assert.deepEqual(seeds, ["a"]);
});

test("pickSeedTitles: rispetta il tetto", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ titleId: `t${i}`, rating: 8 }));
  assert.equal(pickSeedTitles(many, { max: 5 }).length, 5);
});

// --- classifica ---
function baseInput() {
  return {
    myRatingByTitle: new Map([["t1", 9], ["t2", 8], ["t3", 3]]),
    ratersByTitle: new Map([
      ["t1", [{ uid: "simile", rating: 9 }, { uid: "opposto", rating: 2 }]],
      ["t2", [{ uid: "simile", rating: 8 }, { uid: "opposto", rating: 1 }]],
      ["t3", [{ uid: "solo_uno", rating: 3 }]],
    ]),
  };
}

test("scoreCandidates: chi vota come te sta davanti a chi vota all'opposto", () => {
  const out = scoreCandidates(baseInput());
  assert.equal(out[0].uid, "simile");
  assert.equal(out[1].uid, "opposto");
  assert.ok(out[0].score > out[1].score);
});

test("scoreCandidates: sotto la soglia di titoli condivisi si esce", () => {
  const out = scoreCandidates(baseInput());
  assert.equal(out.some((row) => row.uid === "solo_uno"), false);
  assert.equal(MIN_SHARED_TITLES, 2);
});

test("scoreCandidates: gli esclusi non compaiono", () => {
  const out = scoreCandidates({ ...baseInput(), excludeUids: ["simile"] });
  assert.deepEqual(out.map((row) => row.uid), ["opposto"]);
});

test("scoreCandidates: un titolo che non ho votato non porta candidati", () => {
  const out = scoreCandidates({
    myRatingByTitle: new Map([["t1", 9]]),
    ratersByTitle: new Map([
      ["t1", [{ uid: "a", rating: 9 }]],
      ["mai_visto", [{ uid: "b", rating: 9 }, { uid: "c", rating: 8 }]],
    ]),
    minShared: 1,
  });
  assert.deepEqual(out.map((row) => row.uid), ["a"]);
});

test("scoreCandidates: voti non validi ignorati", () => {
  const out = scoreCandidates({
    myRatingByTitle: new Map([["t1", 9], ["t2", 9]]),
    ratersByTitle: new Map([
      ["t1", [{ uid: "a", rating: 0 }, { uid: "b", rating: 9 }]],
      ["t2", [{ uid: "a", rating: null }, { uid: "b", rating: 8 }]],
    ]),
  });
  assert.deepEqual(out.map((row) => row.uid), ["b"]);
});

test("scoreCandidates: ordine deterministico a parita' di punteggio", () => {
  const input = {
    myRatingByTitle: new Map([["t1", 8], ["t2", 8]]),
    ratersByTitle: new Map([
      ["t1", [{ uid: "zeta", rating: 8 }, { uid: "alfa", rating: 8 }]],
      ["t2", [{ uid: "zeta", rating: 8 }, { uid: "alfa", rating: 8 }]],
    ]),
  };
  assert.deepEqual(scoreCandidates(input).map((r) => r.uid), ["alfa", "zeta"]);
  assert.deepEqual(scoreCandidates(input).map((r) => r.uid), ["alfa", "zeta"]);
});

test("scoreCandidates: un titolo votato da tutti pesa meno di uno di nicchia", () => {
  const affollato = Array.from({ length: 40 }, (_, i) => ({ uid: `u${i}`, rating: 8 }));
  const out = scoreCandidates({
    myRatingByTitle: new Map([["mainstream", 8], ["nicchia_1", 8], ["nicchia_2", 8]]),
    ratersByTitle: new Map([
      ["mainstream", affollato.concat([{ uid: "folla", rating: 8 }])],
      ["nicchia_1", [{ uid: "nicchia", rating: 8 }, { uid: "folla", rating: 8 }]],
      ["nicchia_2", [{ uid: "nicchia", rating: 8 }]],
    ]),
  });
  const nicchia = out.find((r) => r.uid === "nicchia");
  const folla = out.find((r) => r.uid === "folla");
  assert.ok(nicchia.score > folla.score, `${nicchia.score} <= ${folla.score}`);
});

test("scoreCandidates: accordo medio riportato", () => {
  const out = scoreCandidates({
    myRatingByTitle: new Map([["t1", 10], ["t2", 10]]),
    ratersByTitle: new Map([
      ["t1", [{ uid: "a", rating: 10 }]],
      ["t2", [{ uid: "a", rating: 1 }]],
    ]),
  });
  assert.equal(out[0].avgAgreement, 0.5);
});

test("scoreCandidates: tetto sui risultati", () => {
  const ratersByTitle = new Map();
  const myRatingByTitle = new Map();
  for (let t = 0; t < 3; t++) {
    myRatingByTitle.set(`t${t}`, 8);
    ratersByTitle.set(`t${t}`, Array.from({ length: 30 }, (_, i) => ({ uid: `u${i}`, rating: 8 })));
  }
  assert.equal(scoreCandidates({ myRatingByTitle, ratersByTitle, max: 4 }).length, 4);
});

function clampRound(value) {
  return value;
}
