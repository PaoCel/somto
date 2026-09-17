const test = require("node:test");
const assert = require("node:assert/strict");
const { auditQuizCorpus, normalizeText } = require("../../lib/quizCorpusAudit");

test("normalizza testo per deduplica senza differenze di maiuscole, accenti o punteggiatura", () => {
  assert.equal(normalizeText("  Perché?  "), "perche");
  assert.equal(normalizeText("PERCHE'"), "perche");
});

test("audit separa readiness approvata dalla coda beta e rileva gli errori strutturali", () => {
  const report = auditQuizCorpus([
    {
      id: "a1", titleId: "title-a", title: "Titolo A", questionText: "Perché il cielo è blu?",
      answers: ["Per l'atmosfera", "Per il mare", "Per il sole", "Per caso"], correctAnswerIndex: 0,
      status: "approved", language: "it", confidence: "high", spoilerLevel: "none",
    },
    {
      id: "a2", titleId: "title-a", title: "Titolo A", questionText: "PERCHE il cielo e blu",
      answers: ["A", "a ", "", "D"], correctAnswerIndex: 4,
      status: "beta_pending_review", language: "it", confidence: "medium", spoilerLevel: "light",
    },
    {
      id: "bad", questionText: "", answers: ["A", "B", "C"], correctAnswerIndex: 0,
      status: "", language: "", confidence: "", spoilerLevel: "",
    },
  ]);

  assert.equal(report.readOnly, true);
  assert.equal(report.totalQuestions, 3);
  assert.deepEqual(report.totals.byStatus, { approved: 1, beta_pending_review: 1, missing: 1 });
  assert.equal(report.structuralValidity.invalidQuestions, 2);
  assert.deepEqual(report.structuralValidity.invalidQuestionDetails[0], {
    questionId: "a2", issues: ["answer_empty", "answer_duplicate", "correct_answer_index_invalid"],
  });
  assert.deepEqual(report.structuralValidity.invalidQuestionDetails[1].issues, [
    "missing_question_text", "answers_not_exactly_four", "missing_title_id", "missing_language", "missing_status",
  ]);
  assert.equal(report.duplicateQuestionTexts.duplicateGroups, 1);
  assert.deepEqual(report.duplicateQuestionTexts.groups[0].questionIds, ["a1", "a2"]);
  assert.equal(report.titleCounts[0].totalQuestions, 2);
  assert.equal(report.titleCounts.length, 1);
  assert.equal(report.readiness.approved.byTitle[0].questionCount, 1);
  assert.equal(report.readiness.approved.byTitle[0].deficitTo50, 49);
  assert.equal(report.readiness.betaPendingReview.byTitle[0].questionCount, 1);
  assert.equal(report.readiness.betaPendingReview.byTitle[0].deficitTo100, 99);
  assert.equal(report.readiness.legacyPlayable.byTitle[0].questionCount, 2);
  assert.equal(report.readiness.legacyPlayable.summary.totalDeficitTo50, 48);
});
