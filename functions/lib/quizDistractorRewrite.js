"use strict";

// Fase C2 del piano quiz (docs/QUIZ_PUSH_PLAN_2026-09-06.md): riscrittura dei
// soli distrattori delle domande in cui la risposta giusta si riconosce dalla
// lunghezza. Qui sta la logica pura di validazione di una proposta di
// riscrittura, senza Firebase, cosi' e' testabile su fixture.
//
// Una proposta e' accettata solo se:
//  * ha 4 risposte non vuote e senza spazi ai bordi;
//  * la risposta giusta e' IDENTICA all'originale e allo stesso indice
//    (qui non si tocca la verita' fattuale, mai);
//  * i distrattori sono diversi fra loro e dalla risposta giusta;
//  * il "tell" e' sparito (`strongLengthTell` torna null);
//  * ogni distrattore rientra nella fascia di lunghezza richiesta
//    (`targetLength.min`..`targetLength.max`), con un margine di tolleranza;
//  * nessuna risposta ha gli accenti mangiati (check stretto dell'audit).

const { strongLengthTell, hasStrictMissingAccent } = require("./quizCorpusAudit");

const LENGTH_TOLERANCE = 0.1; // 10% oltre la fascia: la fascia e' una guida, non un muro

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalize(value) {
  return text(value).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Valida una proposta rispetto all'originale.
 * @param {object} original riga del triage (id, answers, correctAnswerIndex, targetLength)
 * @param {object} proposal { id, answers }
 * @returns {{ ok: boolean, reasons: string[], answers?: string[] }}
 */
function validateRewrite(original, proposal) {
  const reasons = [];
  const answers = Array.isArray(proposal?.answers) ? proposal.answers.map(text) : [];
  const correctIndex = original.correctAnswerIndex;
  const originalCorrect = text(original.answers?.[correctIndex]);

  if (answers.length !== 4) reasons.push("answers_count");
  if (answers.some((a) => !a)) reasons.push("empty_answer");
  if (answers.length === 4 && answers[correctIndex] !== originalCorrect) reasons.push("correct_changed");

  if (answers.length === 4) {
    const seen = new Set();
    answers.forEach((a, i) => {
      const key = normalize(a);
      if (seen.has(key)) reasons.push(`duplicate_${i}`);
      seen.add(key);
    });
    answers.forEach((a, i) => {
      if (i !== correctIndex && normalize(a) === normalize(originalCorrect)) reasons.push(`distractor_equals_correct_${i}`);
    });

    const tell = strongLengthTell({ answers, correctAnswerIndex: correctIndex });
    if (tell) reasons.push("tell_still_present");

    const range = original.targetLength || original.targetLengthRange;
    if (range) {
      const min = Math.floor(range.min * (1 - LENGTH_TOLERANCE));
      const max = Math.ceil(range.max * (1 + LENGTH_TOLERANCE));
      answers.forEach((a, i) => {
        if (i === correctIndex) return;
        if (a.length < min) reasons.push(`too_short_${i}`);
        if (a.length > max) reasons.push(`too_long_${i}`);
      });
    }

    if (hasStrictMissingAccent({ questionText: "", answers, explanation: "" })) reasons.push("missing_accent");
  }

  return { ok: reasons.length === 0, reasons, answers: reasons.length === 0 ? answers : undefined };
}

/**
 * Riparazione meccanica: se la risposta giusta e' presente tal quale ma a un
 * altro indice (il modello ha rimescolato l'ordine), la si riporta al suo
 * posto scambiandola con quella che lo occupava. Non cambia nessun testo.
 * Torna la proposta (riparata o no) e un flag.
 */
function repairShiftedCorrect(original, proposal) {
  const answers = Array.isArray(proposal?.answers) ? proposal.answers.map(text) : [];
  if (answers.length !== 4) return { proposal, repaired: false };
  const correctIndex = original.correctAnswerIndex;
  const originalCorrect = text(original.answers?.[correctIndex]);
  if (answers[correctIndex] === originalCorrect) return { proposal, repaired: false };
  const j = answers.findIndex((a, i) => i !== correctIndex && a === originalCorrect);
  if (j < 0) return { proposal, repaired: false };
  const fixed = answers.slice();
  fixed[j] = answers[correctIndex];
  fixed[correctIndex] = originalCorrect;
  return { proposal: { ...proposal, answers: fixed }, repaired: true };
}

/**
 * Applica `validateRewrite` a un batch: le proposte si abbinano per id.
 * Le originali senza proposta finiscono in `missing`. Prima della validazione
 * si tenta `repairShiftedCorrect`; le righe riparate portano `repaired: true`.
 */
function validateBatch(originals, proposals) {
  const byId = new Map();
  for (const p of proposals || []) {
    if (p && typeof p.id === "string") byId.set(p.id, p);
  }
  const accepted = [];
  const rejected = [];
  const missing = [];
  for (const original of originals) {
    const proposal = byId.get(original.id);
    if (!proposal) {
      missing.push(original.id);
      continue;
    }
    const { proposal: candidate, repaired } = repairShiftedCorrect(original, proposal);
    const result = validateRewrite(original, candidate);
    if (result.ok) {
      accepted.push({ id: original.id, titleId: original.titleId, previousAnswers: original.answers, answers: result.answers, ...(repaired ? { repaired: true } : {}) });
    } else {
      rejected.push({ id: original.id, reasons: result.reasons, answers: candidate.answers, ...(repaired ? { repaired: true } : {}) });
    }
  }
  return { accepted, rejected, missing };
}

module.exports = { validateRewrite, validateBatch, repairShiftedCorrect, LENGTH_TOLERANCE };
