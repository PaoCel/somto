const test = require("node:test");
const assert = require("node:assert/strict");

const { looksLikeSpoiler } = require("../../modules/spoilerChecker");

// --- italiano (comportamento storico, non deve regredire) -------------------

test("IT: 'muore' viene segnalato", () => {
  const hit = looksLikeSpoiler("Non ci credo che alla fine muore proprio lui");
  assert.ok(hit);
  assert.equal(hit.match.toLowerCase(), "muore");
});

test("IT: 'si scopre che' viene segnalato", () => {
  const hit = looksLikeSpoiler("Alla fine si scopre che era tutto un sogno");
  assert.ok(hit);
});

// --- inglese (la falla: prima di questo fix passava tutto) ------------------

test("EN: 'he dies at the end' viene segnalato", () => {
  const hit = looksLikeSpoiler("I cannot believe he dies at the end of the season");
  assert.ok(hit, "un post inglese sulla morte di un personaggio deve essere segnalato");
  assert.equal(hit.match.toLowerCase(), "dies");
});

test("EN: 'gets killed' viene segnalato", () => {
  assert.ok(looksLikeSpoiler("The main character gets killed in the first ten minutes"));
});

test("EN: 'it turns out' viene segnalato", () => {
  assert.ok(looksLikeSpoiler("So it turns out the whole thing was staged from the start"));
});

test("EN: 'twist ending' viene segnalato", () => {
  assert.ok(looksLikeSpoiler("That twist ending completely destroyed me, wow"));
});

test("EN: keyword per titolo in inglese", () => {
  const hit = looksLikeSpoiler(
    "Everyone warned me but jon snow dies and I was not ready at all",
    ["Game of Thrones"]
  );
  assert.ok(hit);
});

// --- guardie contro i falsi positivi ---------------------------------------

test("il solo titolo 'The Walking Dead' non fa scattare nulla", () => {
  const hit = looksLikeSpoiler(
    "Sto finalmente iniziando The Walking Dead, che ne pensate della serie?",
    ["The Walking Dead"]
  );
  assert.equal(hit, null, "'dead' dentro un titolo non e' uno spoiler");
});

test("testo pulito non viene segnalato", () => {
  assert.equal(looksLikeSpoiler("Bella la fotografia di questa stagione, colori pazzeschi"), null);
});

test("testo troppo corto viene ignorato", () => {
  assert.equal(looksLikeSpoiler("muore"), null);
});

test("null / undefined non esplodono", () => {
  assert.equal(looksLikeSpoiler(null), null);
  assert.equal(looksLikeSpoiler(undefined), null);
});
