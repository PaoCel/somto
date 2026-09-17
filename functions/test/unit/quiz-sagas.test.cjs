const test = require("node:test");
const assert = require("node:assert/strict");
const { MANUAL_QUIZ_SAGAS, buildSagaSlug, buildQuizSagas } = require("../../modules/quizSagas");

test("buildSagaSlug toglie accenti e i suffissi da collection prima di slugificare", () => {
  assert.equal(buildSagaSlug("Harry Potter - Collezione"), "harry-potter");
  assert.equal(buildSagaSlug("Perché No? - Collezione"), "perche-no");
  assert.equal(buildSagaSlug("Qualcosa Collection"), "qualcosa");
  assert.equal(buildSagaSlug("Qualcosa - Saga"), "qualcosa");
});

test("MANUAL_QUIZ_SAGAS ha sagaId e titleId unici, e almeno 2 titoli a saga", () => {
  const seenSagaIds = new Set();
  const seenTitleIds = new Set();
  for (const saga of MANUAL_QUIZ_SAGAS) {
    assert.equal(seenSagaIds.has(saga.sagaId), false, `sagaId duplicato: ${saga.sagaId}`);
    seenSagaIds.add(saga.sagaId);
    assert.ok(saga.titleIds.length >= 2, `${saga.sagaId} ha meno di 2 titoli`);
    for (const titleId of saga.titleIds) {
      assert.equal(seenTitleIds.has(titleId), false, `titleId ${titleId} in piu' di una saga manuale`);
      seenTitleIds.add(titleId);
    }
  }
});

test("una saga manuale ha precedenza su TMDB: i suoi titoli non finiscono anche nella saga per collectionId", () => {
  const themes = [
    { titleId: "t1", title: "Film Uno", mediaType: "movie", count: 30 },
    { titleId: "t2", title: "Film Due", mediaType: "movie", count: 30 },
    { titleId: "t3", title: "Film Tre", mediaType: "movie", count: 30 },
  ];
  const titlesById = {
    t1: { collectionId: 99, collectionName: "Trilogia Test - Collezione" },
    t2: { collectionId: 99, collectionName: "Trilogia Test - Collezione" },
    t3: { collectionId: 99, collectionName: "Trilogia Test - Collezione" },
  };
  const manualSagas = [
    { sagaId: "manuale-test", name: "Saga Manuale Test", mediaType: "movie", titleIds: ["t1", "t2"] },
  ];

  const sagas = buildQuizSagas({ themes, titlesById, manualSagas });

  // Solo la saga manuale: t3 (unico titolo TMDB non reclamato) resta senza
  // saga perché da solo non raggiunge la soglia minima di 2 titoli.
  assert.equal(sagas.length, 1);
  assert.equal(sagas[0].sagaId, "manuale-test");
  assert.equal(sagas[0].source, "manual");
  assert.deepEqual(sagas[0].titleIds.slice().sort(), ["t1", "t2"]);
  assert.equal(sagas[0].count, 60);
});

test("esclude le saghe con un solo titolo con quiz, anche se la collection TMDB ne elenca di più", () => {
  const themes = [
    { titleId: "b1", title: "B Uno", mediaType: "movie", count: 50 },
  ];
  const titlesById = { b1: { collectionId: 55, collectionName: "Solo Uno - Collezione" } };

  const sagas = buildQuizSagas({ themes, titlesById, manualSagas: [] });

  assert.deepEqual(sagas, []);
});

test("esclude le saghe con almeno 2 titoli ma meno di 10 domande totali", () => {
  const themes = [
    { titleId: "a1", title: "A Uno", mediaType: "movie", count: 4 },
    { titleId: "a2", title: "A Due", mediaType: "movie", count: 5 },
  ];
  const titlesById = {
    a1: { collectionId: 7, collectionName: "Trilogia Piccola - Collezione" },
    a2: { collectionId: 7, collectionName: "Trilogia Piccola - Collezione" },
  };

  const sagas = buildQuizSagas({ themes, titlesById, manualSagas: [] });

  assert.deepEqual(sagas, []);
});

test("ordina le saghe risultanti per numero di domande decrescente", () => {
  const themes = [
    { titleId: "s1", title: "Piccola Uno", mediaType: "movie", count: 6 },
    { titleId: "s2", title: "Piccola Due", mediaType: "movie", count: 6 },
    { titleId: "g1", title: "Grande Uno", mediaType: "movie", count: 40 },
    { titleId: "g2", title: "Grande Due", mediaType: "movie", count: 40 },
  ];
  const titlesById = {
    s1: { collectionId: 1, collectionName: "Saga Piccola - Collezione" },
    s2: { collectionId: 1, collectionName: "Saga Piccola - Collezione" },
    g1: { collectionId: 2, collectionName: "Saga Grande - Collezione" },
    g2: { collectionId: 2, collectionName: "Saga Grande - Collezione" },
  };

  const sagas = buildQuizSagas({ themes, titlesById, manualSagas: [] });

  assert.equal(sagas.length, 2);
  assert.equal(sagas[0].sagaId, "saga-grande");
  assert.equal(sagas[0].count, 80);
  assert.equal(sagas[0].source, "tmdb");
  assert.equal(sagas[0].mediaType, "movie");
  assert.deepEqual(sagas[0].titles.slice().sort(), ["Grande Due", "Grande Uno"]);
  assert.equal(sagas[1].sagaId, "saga-piccola");
  assert.equal(sagas[1].count, 12);
});
