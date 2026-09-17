"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateRewrite, validateBatch, repairShiftedCorrect } = require("../../lib/quizDistractorRewrite");

const original = {
  id: "q1",
  titleId: "t1",
  answers: ["Rosa Solara", "Raffaella Cerullo", "Lidia Greco", "Rachele Carracci"],
  correctAnswerIndex: 1,
  targetLength: { min: 13, max: 21 },
};

test("accetta una riscrittura che toglie il tell e lascia la giusta intatta", () => {
  const r = validateRewrite(original, {
    id: "q1",
    answers: ["Rosa Solara Greco", "Raffaella Cerullo", "Lidia Greco Sarratore", "Rachele Carracci Peluso"],
  });
  assert.equal(r.ok, true, r.reasons.join(","));
});

test("rifiuta se la risposta giusta cambia anche di una lettera", () => {
  const r = validateRewrite(original, {
    id: "q1",
    answers: ["Rosa Solara Greco", "Raffaella Cerullo.", "Lidia Greco Sarratore", "Rachele Carracci Peluso"],
  });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes("correct_changed"));
});

test("rifiuta distrattori duplicati o uguali alla giusta", () => {
  const r = validateRewrite(original, {
    id: "q1",
    answers: ["raffaella cerullo", "Raffaella Cerullo", "Lidia Greco Sarratore", "Lidia Greco Sarratore"],
  });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.startsWith("distractor_equals_correct")));
  assert.ok(r.reasons.some((x) => x.startsWith("duplicate")));
});

test("rifiuta se il tell resta (giusta ancora unica piu' lunga di 1,5x)", () => {
  const r = validateRewrite(original, {
    id: "q1",
    answers: ["Rosa", "Raffaella Cerullo", "Lidia", "Rachele"],
  });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes("tell_still_present"));
});

test("rifiuta accenti mangiati nei distrattori", () => {
  const r = validateRewrite(original, {
    id: "q1",
    answers: ["Rosa Solara, perche no", "Raffaella Cerullo", "Lidia Greco Sarratore", "Rachele Carracci Peluso"],
  });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes("missing_accent"));
});

test("validateBatch separa accettate, rifiutate e mancanti", () => {
  const originals = [original, { ...original, id: "q2" }, { ...original, id: "q3" }];
  const proposals = [
    { id: "q1", answers: ["Rosa Solara Greco", "Raffaella Cerullo", "Lidia Greco Sarratore", "Rachele Carracci Peluso"] },
    { id: "q2", answers: ["Rosa", "Raffaella Cerullo", "Lidia", "Rachele"] },
  ];
  const r = validateBatch(originals, proposals);
  assert.equal(r.accepted.length, 1);
  assert.equal(r.rejected.length, 1);
  assert.deepEqual(r.missing, ["q3"]);
  assert.deepEqual(r.accepted[0].previousAnswers, original.answers);
});

test("ripara la giusta spostata a un altro indice senza toccare i testi", () => {
  const shifted = {
    id: "q1",
    answers: ["Rosa Solara Greco", "Lidia Greco Sarratore", "Raffaella Cerullo", "Rachele Carracci Peluso"],
  };
  const { proposal, repaired } = repairShiftedCorrect(original, shifted);
  assert.equal(repaired, true);
  assert.deepEqual(proposal.answers, ["Rosa Solara Greco", "Raffaella Cerullo", "Lidia Greco Sarratore", "Rachele Carracci Peluso"]);
  const r = validateBatch([original], [shifted]);
  assert.equal(r.accepted.length, 1);
  assert.equal(r.accepted[0].repaired, true);
});

test("non ripara se la giusta non compare da nessuna parte", () => {
  const { repaired } = repairShiftedCorrect(original, { id: "q1", answers: ["a", "b", "c", "d"] });
  assert.equal(repaired, false);
});
