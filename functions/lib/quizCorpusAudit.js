"use strict";

// Pure quiz-corpus checks. This module deliberately has no Firebase dependency
// so the audit rules can be exercised without credentials or a Firestore write.

const READINESS_TARGETS = [50, 100];

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function bucket(value) {
  return text(value) || "missing";
}

function normalizeText(value) {
  return text(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("it")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function increment(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function structuralIssues(question) {
  const issues = [];
  if (!text(question.questionText)) issues.push("missing_question_text");
  if (!Array.isArray(question.answers) || question.answers.length !== 4) {
    issues.push("answers_not_exactly_four");
  } else {
    const normalizedAnswers = question.answers.map(normalizeText);
    if (normalizedAnswers.some((answer) => !answer)) issues.push("answer_empty");
    if (new Set(normalizedAnswers).size !== normalizedAnswers.length) issues.push("answer_duplicate");
  }
  if (!Number.isInteger(question.correctAnswerIndex) || question.correctAnswerIndex < 0 || question.correctAnswerIndex > 3) {
    issues.push("correct_answer_index_invalid");
  }
  if (!text(question.titleId)) issues.push("missing_title_id");
  if (!text(question.language)) issues.push("missing_language");
  if (!text(question.status)) issues.push("missing_status");
  return issues;
}

function makeTitleEntry(titleId, title) {
  return {
    titleId,
    title,
    totalQuestions: 0,
    approvedQuestions: 0,
    betaPendingReviewQuestions: 0,
    legacyPlayableQuestions: 0,
    statusCounts: {},
  };
}

function readinessByTitle(titleCounts, field) {
  return titleCounts.map((title) => {
    const questionCount = title[field];
    const row = { titleId: title.titleId, title: title.title, questionCount };
    for (const target of READINESS_TARGETS) row[`deficitTo${target}`] = Math.max(0, target - questionCount);
    return row;
  });
}

function readinessSummary(rows) {
  const result = { totalQuestions: 0, titleCount: rows.length };
  for (const row of rows) {
    result.totalQuestions += row.questionCount;
    for (const target of READINESS_TARGETS) {
      result[`titlesReadyAt${target}`] = (result[`titlesReadyAt${target}`] || 0) + (row.questionCount >= target ? 1 : 0);
      result[`totalDeficitTo${target}`] = (result[`totalDeficitTo${target}`] || 0) + row[`deficitTo${target}`];
    }
  }
  return result;
}

function auditQuizCorpus(rows = []) {
  const statusCounts = {};
  const languageCounts = {};
  const confidenceCounts = {};
  const spoilerLevelCounts = {};
  const invalidQuestions = [];
  const titleMap = new Map();
  const duplicateMap = new Map();

  for (const rawQuestion of rows) {
    const question = rawQuestion && typeof rawQuestion === "object" ? rawQuestion : {};
    const questionId = text(question.questionId) || text(question.id) || "(missing-id)";
    const status = bucket(question.status);
    const titleId = text(question.titleId);
    const title = text(question.title);
    increment(statusCounts, status);
    increment(languageCounts, bucket(question.language));
    increment(confidenceCounts, bucket(question.confidence));
    increment(spoilerLevelCounts, bucket(question.spoilerLevel));

    const issues = structuralIssues(question);
    if (issues.length) invalidQuestions.push({ questionId, issues });

    if (titleId) {
      let titleEntry = titleMap.get(titleId);
      if (!titleEntry) {
        titleEntry = makeTitleEntry(titleId, title);
        titleMap.set(titleId, titleEntry);
      } else if (!titleEntry.title && title) {
        titleEntry.title = title;
      }
      titleEntry.totalQuestions += 1;
      increment(titleEntry.statusCounts, status);
      if (status === "approved") titleEntry.approvedQuestions += 1;
      if (status === "beta_pending_review") titleEntry.betaPendingReviewQuestions += 1;
      if (status === "approved" || status === "beta_pending_review") titleEntry.legacyPlayableQuestions += 1;
    }

    const normalizedQuestionText = normalizeText(question.questionText);
    if (normalizedQuestionText && titleId) {
      const duplicateKey = `${titleId}\u0000${normalizedQuestionText}`;
      const group = duplicateMap.get(duplicateKey) || { titleId, normalizedQuestionText, questionIds: [] };
      group.questionIds.push(questionId);
      duplicateMap.set(duplicateKey, group);
    }
  }

  const titleCounts = Array.from(titleMap.values()).sort((a, b) =>
    b.totalQuestions - a.totalQuestions || a.title.localeCompare(b.title, "it") || a.titleId.localeCompare(b.titleId)
  );
  const duplicateQuestionTexts = Array.from(duplicateMap.values())
    .filter((group) => group.questionIds.length > 1)
    .sort((a, b) => a.titleId.localeCompare(b.titleId) || a.normalizedQuestionText.localeCompare(b.normalizedQuestionText));
  const approvedByTitle = readinessByTitle(titleCounts, "approvedQuestions");
  const betaPendingReviewByTitle = readinessByTitle(titleCounts, "betaPendingReviewQuestions");
  const legacyPlayableByTitle = readinessByTitle(titleCounts, "legacyPlayableQuestions");

  return {
    readOnly: true,
    totalQuestions: rows.length,
    totals: {
      byStatus: statusCounts,
      byLanguage: languageCounts,
      byConfidence: confidenceCounts,
      bySpoilerLevel: spoilerLevelCounts,
    },
    structuralValidity: {
      validQuestions: rows.length - invalidQuestions.length,
      invalidQuestions: invalidQuestions.length,
      invalidQuestionDetails: invalidQuestions,
    },
    duplicateQuestionTexts: {
      duplicateGroups: duplicateQuestionTexts.length,
      duplicateQuestions: duplicateQuestionTexts.reduce((total, group) => total + group.questionIds.length, 0),
      groups: duplicateQuestionTexts,
    },
    titleCounts,
    readiness: {
      approved: { summary: readinessSummary(approvedByTitle), byTitle: approvedByTitle },
      betaPendingReview: { summary: readinessSummary(betaPendingReviewByTitle), byTitle: betaPendingReviewByTitle },
      legacyPlayable: { summary: readinessSummary(legacyPlayableByTitle), byTitle: legacyPlayableByTitle },
    },
  };
}

module.exports = { auditQuizCorpus, normalizeText, structuralIssues, READINESS_TARGETS };
