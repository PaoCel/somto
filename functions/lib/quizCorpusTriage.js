"use strict";

const {
  answerLengths,
  hasStrictMissingAccent,
  strongLengthTell,
} = require("./quizCorpusAudit");

// Pattern italiani per trivia di produzione. Ogni voce descrive una domanda
// da scheda: cast/interpreti, regia, dati economici, premi, distribuzione TV,
// conteggi di stagioni o episodi, doppiaggio, anno, budget e durata.
const PRODUCTION_TRIVIA_PATTERNS = [
  { name: "cast_interprete", regex: /\b(?:chi|quale\s+(?:attore|attrice)|da\s+chi)\b.{0,90}\b(?:interpreta(?:to|ta)?|ha\s+interpretato|veste\s+i\s+panni|fa\s+parte\s+del\s+cast)\b|\b(?:attore|attrice)\b.{0,90}\b(?:interpreta|ruolo)\b|\bcast\b/iu },
  { name: "regia", regex: /\b(?:regista|regia|dirett[oa]\s+da|chi\s+ha\s+diretto|chi\s+dirige)\b/iu },
  { name: "incassi_box_office", regex: /\b(?:incass[oi]|box[\s-]?office)\b/iu },
  { name: "premi", regex: /\b(?:premi(?:o|ata|ato)?|oscar|golden\s+globe)\b/iu },
  { name: "rete_piattaforma", regex: /\b(?:rete|canale|piattaforma)\b.{0,90}\b(?:mess[oa]|andat[oa])\s+in\s+onda|\b(?:rete|canale|piattaforma)\b.{0,90}\b(?:trasmess[oa]|distribuit[oa]|disponibile|debutt)|\b(?:mess[oa]|andat[oa]|trasmess[oa])\s+in\s+onda\b.{0,90}\b(?:rete|canale|piattaforma)\b/iu },
  { name: "numero_stagioni_episodi", regex: /\b(?:quante\s+stagioni|quanti\s+episodi|numero\s+di\s+(?:stagioni|episodi)|totale\s+di\s+(?:stagioni|episodi))\b|\b(?:stagioni|episodi)\b.{0,50}\b(?:ha|conta|totali|compost[oa])\b/iu },
  { name: "doppiatore_voce_inglese", regex: /\b(?:doppiator[ei]|doppiat[oa]\s+da|voce\s+(?:originale|inglese))\b|\bchi\b.{0,90}\bdoppia(?:to|ta)?\b/iu },
  { name: "anno_uscita_produzione", regex: /\b(?:in\s+che|quale)\s+anno\b.{0,90}\b(?:uscit[oa]|prodott[oa]|realizzat[oa]|debutt)|\banno\s+(?:di\s+)?(?:uscita|produzione)\b/iu },
  { name: "budget", regex: /\bbudget\b/iu },
  { name: "durata", regex: /\b(?:quanto\s+dura|durata)\b/iu },
];

const PLAYABLE_STATUSES = new Set(["approved", "beta_pending_review"]);
const READY_SPOILER_LEVELS = new Set(["none", "light"]);

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function baseRow(question) {
  return {
    id: text(question.id) || text(question.questionId) || "(missing-id)",
    titleId: text(question.titleId),
    title: text(question.title),
    questionText: text(question.questionText),
    answers: Array.isArray(question.answers) ? question.answers.slice() : [],
    correctAnswerIndex: question.correctAnswerIndex,
    explanation: text(question.explanation),
    status: text(question.status),
    spoilerLevel: text(question.spoilerLevel),
    category: text(question.category),
    difficulty: text(question.difficulty),
    accentAuditStatus: text(question.accentAuditStatus),
  };
}

function productionTriviaMatch(question) {
  return PRODUCTION_TRIVIA_PATTERNS.find(({ regex }) => regex.test(text(question?.questionText))) || null;
}

function isReadyForScreen(question, excludedIds) {
  const lengths = answerLengths(question);
  return text(question.status) === "beta_pending_review"
    && READY_SPOILER_LEVELS.has(text(question.spoilerLevel))
    && text(question.questionText).length <= 95
    && Boolean(lengths)
    && Math.max(...lengths) <= 34
    && !hasStrictMissingAccent(question)
    && !excludedIds.has(text(question.id) || text(question.questionId));
}

function summarizeByTitle(questions, lists) {
  const byTitle = new Map();
  const ensure = (row) => {
    const titleId = text(row.titleId) || "(missing-title-id)";
    if (!byTitle.has(titleId)) {
      byTitle.set(titleId, {
        titleId,
        title: text(row.title),
        totalQuestions: 0,
        tellStrong: 0,
        productionTrivia: 0,
        approvedCandidates: 0,
      });
    }
    return byTitle.get(titleId);
  };

  for (const question of questions) ensure(question).totalQuestions += 1;
  for (const [listName, rows] of Object.entries(lists)) {
    for (const row of rows) ensure(row)[listName] += 1;
  }

  return Array.from(byTitle.values()).sort((a, b) =>
    a.title.localeCompare(b.title, "it") || a.titleId.localeCompare(b.titleId, "it")
  );
}

function triageQuizCorpus(rows = []) {
  const questions = rows.map((row) => row && typeof row === "object" ? row : {});
  const tellStrong = [];
  const productionTrivia = [];

  for (const question of questions) {
    if (!PLAYABLE_STATUSES.has(text(question.status))) continue;

    const tell = strongLengthTell(question);
    if (tell) {
      tellStrong.push({
        ...baseRow(question),
        lengths: tell.lengths,
        targetLengthRange: {
          min: Math.floor(tell.correctLength / 1.5) + 1,
          max: tell.correctLength,
        },
        reason: `La risposta corretta è l'unica più lunga (${tell.correctLength}) ed è almeno 1,5× la più corta (${tell.shortestLength}).`,
      });
    }

    const productionMatch = productionTriviaMatch(question);
    if (productionMatch) {
      productionTrivia.push({
        ...baseRow(question),
        matchedPattern: productionMatch.name,
        matchedRegex: productionMatch.regex.source,
        categorySignal: ["trivia", "anagraphic"].includes(text(question.category)),
        reason: `La domanda corrisponde al pattern di trivia di produzione “${productionMatch.name}”.`,
      });
    }
  }

  const excludedIds = new Set([
    ...tellStrong.map((row) => row.id),
    ...productionTrivia.map((row) => row.id),
  ]);
  const approvedCandidates = questions
    .filter((question) => isReadyForScreen(question, excludedIds))
    .map((question) => ({
      ...baseRow(question),
      lengths: answerLengths(question),
      reason: "Passa tutti i filtri di prontezza per lo schermo ed è beta_pending_review.",
    }));

  for (const list of [tellStrong, productionTrivia, approvedCandidates]) {
    list.sort((a, b) => a.id.localeCompare(b.id, "it"));
  }

  const lists = { tellStrong, productionTrivia, approvedCandidates };
  return {
    ...lists,
    summary: {
      totalQuestions: questions.length,
      counts: Object.fromEntries(Object.entries(lists).map(([name, list]) => [name, list.length])),
      byTitle: summarizeByTitle(questions, lists),
    },
  };
}

module.exports = {
  PRODUCTION_TRIVIA_PATTERNS,
  productionTriviaMatch,
  triageQuizCorpus,
};
