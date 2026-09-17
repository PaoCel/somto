const test = require("node:test");
const assert = require("node:assert/strict");
const fixture = require("../fixtures/quiz-corpus-triage.json");
const {
  PRODUCTION_TRIVIA_PATTERNS,
  productionTriviaMatch,
  triageQuizCorpus,
} = require("../../lib/quizCorpusTriage");
const { hasStrictMissingAccent, strongLengthTell } = require("../../lib/quizCorpusAudit");

test("rileva il tell forte ma non la parità sulla lunghezza massima", () => {
  const report = triageQuizCorpus(fixture);

  assert.deepEqual(report.tellStrong.map((row) => row.id), ["q01_tell"]);
  assert.deepEqual(report.tellStrong[0].lengths, [12, 32, 11, 12]);
  assert.deepEqual(report.tellStrong[0].targetLengthRange, { min: 22, max: 32 });
  assert.match(report.tellStrong[0].reason, /unica più lunga/);
  assert.equal(strongLengthTell(fixture.find((row) => row.id === "q02_tie")), null);
  assert.ok(strongLengthTell({ answers: ["123456", "1234", "12345", "12345"], correctAnswerIndex: 0 }));
});

test("classifica la trivia di produzione tramite pattern, non tramite la sola categoria", () => {
  const report = triageQuizCorpus(fixture);

  assert.deepEqual(report.productionTrivia.map((row) => row.id), ["q03_cast", "q04_regia", "q12_year"]);
  assert.equal(report.productionTrivia[0].matchedPattern, "cast_interprete");
  assert.equal(report.productionTrivia[0].categorySignal, false);
  assert.equal(report.productionTrivia[1].categorySignal, true);
  assert.ok(report.productionTrivia.every((row) => row.matchedRegex && row.reason));
  assert.equal(productionTriviaMatch(fixture.find((row) => row.id === "q05_category_only")), null);
  assert.equal(PRODUCTION_TRIVIA_PATTERNS.length, 10);
});

test("copre tutti i tipi documentati di trivia di produzione", () => {
  const cases = [
    ["cast_interprete", "Da chi è interpretata la protagonista?"],
    ["regia", "Chi è il regista del film?"],
    ["incassi_box_office", "Quanto ha incassato al box office?"],
    ["premi", "Quanti Oscar ha vinto?"],
    ["rete_piattaforma", "Su quale rete è andata in onda?"],
    ["numero_stagioni_episodi", "Da quanti episodi è composta la serie?"],
    ["doppiatore_voce_inglese", "Chi presta la voce inglese al personaggio?"],
    ["anno_uscita_produzione", "In che anno è uscito il film?"],
    ["budget", "Qual era il budget della produzione?"],
    ["durata", "Quanto dura il film?"],
  ];

  for (const [expected, questionText] of cases) {
    assert.equal(productionTriviaMatch({ questionText })?.name, expected, questionText);
  }
});

test("esclude dalla promozione accenti mancanti, spoiler, limiti e stati non beta", () => {
  const report = triageQuizCorpus(fixture);

  assert.deepEqual(report.approvedCandidates.map((row) => row.id), ["q02_tie", "q05_category_only", "q06_ready"]);
  assert.equal(hasStrictMissingAccent(fixture.find((row) => row.id === "q07_accent")), true);
  assert.equal(hasStrictMissingAccent(fixture.find((row) => row.id === "q14_accent_answer")), true);
  for (const word of ["perche", "puo", "piu", "gia", "cosi", "citta", "qual e"]) {
    assert.equal(hasStrictMissingAccent({ questionText: word, answers: [], explanation: "" }), true, word);
  }
  assert.ok(report.approvedCandidates.every((row) => row.status === "beta_pending_review" && row.reason));
});

test("esclude i documenti già flagged dalle liste operative", () => {
  const report = triageQuizCorpus(fixture);

  assert.equal(report.tellStrong.some((row) => row.id === "q09_flagged"), false);
  assert.equal(report.productionTrivia.some((row) => row.id === "q09_flagged"), false);
  assert.equal(report.approvedCandidates.some((row) => row.id === "q09_flagged"), false);
});

test("riassume i conteggi globali e per titolo", () => {
  const report = triageQuizCorpus(fixture);

  assert.deepEqual(report.summary.counts, {
    tellStrong: 1,
    productionTrivia: 3,
    approvedCandidates: 3,
  });
  assert.equal(report.summary.totalQuestions, 14);
  assert.deepEqual(report.summary.byTitle.find((row) => row.titleId === "title-b"), {
    titleId: "title-b",
    title: "Titolo B",
    totalQuestions: 4,
    tellStrong: 0,
    productionTrivia: 1,
    approvedCandidates: 2,
  });
});
