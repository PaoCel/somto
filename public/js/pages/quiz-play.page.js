/**
 * quiz-play.page.js — Player Quiz (web).
 * Replica QuizPlayView.swift + QuizResultView: caricamento domande, selezione,
 * conferma/salta, reveal con esito + spiegazione, segnalazione problema,
 * schermata risultato con XP/streak/bonus + confetti.
 *
 * Modalità:
 *  - solo (default): domande dal pool. Parametri opzionali da /quiz-setup.html:
 *      ?count=<n>      → numero di domande (3 / 5 / 10, default 10)
 *      ?titleId=<id>   → restringe il pool a un singolo titolo/tema
 *  - sfida: ?challenge=<id> — domande dal questionIds della sfida.
 */

import { initAuthGuard } from "../components/authGuard.js";
import { t as i18nT } from "../i18n/index.js";
import { getUserPublic } from "../api/users.api.js";
import { escapeHtml } from "../utils/dom.js";
import { toast } from "../components/toast.js";
import { fireConfetti } from "../components/quizConfetti.js";
import { logEvent } from "../analytics.js";
import { trackProductEvent } from "../api/productAnalytics.js";
import {
  ICONS, formatScore, xpBadge, streakChip, statusPill, statTile,
  loadingState, errorState,
} from "../components/quizUI.js";
import {
  scoreForAnswers, fetchPlayableQuestions, fetchPlayableQuestionsForTitles,
  fetchQuestionsByIds, fetchChallenge,
  submitAttempt, recordChallengePlay, reportQuestionProblem,
  QUIZ_SESSION_V2_ENABLED, startQuizSessionV2, submitQuizSessionV2,
  isRetryableQuizSessionV2Error,
} from "../api/quiz.api.js";
import {
  canonicalAnswersFromQuizSessionV2,
  clearPendingQuizSessionV2,
  createPendingQuizSessionV2,
  loadPendingQuizSessionV2,
  savePendingQuizSessionV2,
  shouldUseQuizSessionV2,
} from "../utils/quizSessionV2State.js";

const root = document.getElementById("quizPlay");
const params = new URLSearchParams(location.search);
const challengeId = params.get("challenge") || null;
const MODE = challengeId ? "challenge" : "solo";

// Setup solo (da /quiz-setup.html): tema (titleId) + numero domande.
const soloTitleId = params.get("titleId") || null;
const ALLOWED_COUNTS = [3, 5, 10];
const rawCount = parseInt(params.get("count") || "", 10);
const soloCount = ALLOWED_COUNTS.includes(rawCount) ? rawCount : 10;

// uuid v4 leggero per attemptId / id documento.
function uuid() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const state = {
  uid: null,
  user: null,            // { displayName, photoURL } per la leaderboard
  status: "loading",     // loading | error | playing | finished
  errorMessage: "",
  challenge: null,
  questions: [],
  currentIndex: 0,
  selectedIndex: null,
  answers: [],           // [{ questionId, selectedIndex, outcome }]
  isRevealing: false,
  revealedOutcome: null,
  revealedSelectedIndex: null,
  reward: { xpAwarded: 0, dailyStreak: 0, dailyBonusActive: false },
  resolvedChallenge: null,
  reportToastTimer: null,
  usesSessionV2: false,
  sessionV2Id: null,
  sessionV2ExpiresAt: null,
  pendingSessionV2: null,
  questionStartedAtMs: 0,
  serverScore: null,
  submitRetryable: false,
};

function sessionStorageSafe() {
  try { return window.sessionStorage || null; } catch (_) { return null; }
}

function usesQuizSessionV2() {
  return shouldUseQuizSessionV2({
    buildEnabled: QUIZ_SESSION_V2_ENABLED,
    environment: window.__SOMTO_ENV__ || "production",
    challengeId,
  });
}

function answerTimeMs() {
  const elapsed = Date.now() - Number(state.questionStartedAtMs || Date.now());
  return Math.max(0, Math.min(20 * 60 * 1000, Math.round(elapsed)));
}

/* ===== Derivati ===== */

const LETTERS = ["A", "B", "C", "D"];
const DIFFICULTY = {
  easy: { label: i18nT("Facile"), tint: "var(--success)" },
  medium: { label: i18nT("Media"), tint: "var(--accent)" },
  hard: { label: i18nT("Difficile"), tint: "var(--warning)" },
};

function currentQuestion() {
  return state.questions[state.currentIndex] || null;
}
function liveScore() {
  if (state.usesSessionV2 && Number.isFinite(state.serverScore)) return state.serverScore;
  return scoreForAnswers(state.answers);
}
/** Streak di corrette consecutive che termina sull'ultima risposta. */
function currentStreak() {
  let s = 0;
  for (let i = state.answers.length - 1; i >= 0; i -= 1) {
    if (state.answers[i].outcome === "correct") s += 1;
    else break;
  }
  return s;
}
/** Miglior serie di corrette nel run. */
function bestStreak() {
  let best = 0;
  let run = 0;
  for (const a of state.answers) {
    if (a.outcome === "correct") { run += 1; best = Math.max(best, run); }
    else run = 0;
  }
  return best;
}

/* ===== Caricamento ===== */

async function start() {
  state.status = "loading";
  state.currentIndex = 0;
  state.selectedIndex = null;
  state.answers = [];
  state.isRevealing = false;
  state.revealedOutcome = null;
  state.revealedSelectedIndex = null;
  state.resolvedChallenge = null;
  state.usesSessionV2 = usesQuizSessionV2();
  state.sessionV2Id = null;
  state.sessionV2ExpiresAt = null;
  state.pendingSessionV2 = null;
  state.serverScore = null;
  state.submitRetryable = false;
  render();
  try {
    let questions;
    if (challengeId) {
      const challenge = await fetchChallenge(challengeId);
      if (!challenge) {
        state.status = "error";
        state.errorMessage = i18nT("Sfida non trovata.");
        return render();
      }
      state.challenge = challenge;
      questions = await fetchQuestionsByIds(challenge.questionIds);
    } else if (state.usesSessionV2) {
      const pending = loadPendingQuizSessionV2(sessionStorageSafe(), state.uid);
      if (pending) {
        state.pendingSessionV2 = pending;
        state.sessionV2Id = pending.sessionId;
        state.sessionV2ExpiresAt = pending.expiresAt;
        await submitPendingSessionV2(pending);
        return;
      }
      const started = await startQuizSessionV2({
        clientRequestId: uuid(),
        titleId: soloTitleId,
        count: soloCount,
        language: "it",
      });
      state.sessionV2Id = started.sessionId;
      state.sessionV2ExpiresAt = started.expiresAt;
      questions = started.questions;
    } else if (soloTitleId) {
      clearPendingQuizSessionV2(sessionStorageSafe(), state.uid);
      questions = await fetchPlayableQuestionsForTitles([soloTitleId], soloCount);
    } else {
      clearPendingQuizSessionV2(sessionStorageSafe(), state.uid);
      questions = await fetchPlayableQuestions(soloCount);
    }
    if (!questions.length) {
      state.status = "error";
      state.errorMessage = i18nT("Nessuna domanda disponibile al momento.");
      return render();
    }
    state.questions = questions;
    state.questionStartedAtMs = Date.now();
    state.status = "playing";
  } catch (err) {
    console.error("[quiz-play] start error", err);
    state.status = "error";
    state.errorMessage = err?.message || i18nT("Errore imprevisto.");
  }
  render();
}

/* ===== Azioni player ===== */

function selectAnswer(idx) {
  if (state.isRevealing) return;
  state.selectedIndex = idx;
  render();
}

function confirmCurrent() {
  const q = currentQuestion();
  if (!q || state.selectedIndex == null) return;
  const outcome = state.usesSessionV2
    ? "pending"
    : (state.selectedIndex === q.correctAnswerIndex ? "correct" : "wrong");
  state.answers.push({
    questionId: q.questionId,
    selectedIndex: state.selectedIndex,
    outcome,
    ...(state.usesSessionV2 ? { timeMs: answerTimeMs() } : {}),
  });
  state.revealedOutcome = outcome;
  state.revealedSelectedIndex = state.selectedIndex;
  state.isRevealing = true;
  render();
}

function skipCurrent() {
  const q = currentQuestion();
  if (!q) return;
  state.answers.push({
    questionId: q.questionId,
    selectedIndex: null,
    outcome: "skipped",
    ...(state.usesSessionV2 ? { timeMs: answerTimeMs() } : {}),
  });
  state.revealedOutcome = "skipped";
  state.revealedSelectedIndex = null;
  state.isRevealing = true;
  render();
}

function continueFromReveal() {
  state.isRevealing = false;
  state.revealedOutcome = null;
  state.revealedSelectedIndex = null;
  state.selectedIndex = null;
  state.currentIndex += 1;
  state.questionStartedAtMs = Date.now();
  // Reset scroll: il reveal scrollava in basso; senza questo la domanda/risultato
  // successivi comparivano scrollati sotto l'header flottante (titolo "Buon risultato"
  // sovrapposto al wordmark).
  window.scrollTo({ top: 0, behavior: "auto" });
  if (state.currentIndex >= state.questions.length) {
    void finish();
  } else {
    render();
  }
}

async function finish() {
  if (state.usesSessionV2) {
    await finishSessionV2();
    return;
  }
  state.status = "finished";
  render(); // mostra subito il risultato (i reward arrivano dopo)

  if (!state.uid) return;

  const correctCount = state.answers.filter((a) => a.outcome === "correct").length;
  const wrongCount = state.answers.filter((a) => a.outcome === "wrong").length;
  const skippedCount = state.answers.filter((a) => a.outcome === "skipped").length;
  const score = scoreForAnswers(state.answers);
  const attempt = {
    attemptId: uuid(),
    uid: state.uid,
    mode: MODE,
    challengeId: challengeId,
    questionIds: state.questions.map((q) => q.questionId),
    answers: state.answers,
    score,
    correctCount,
    wrongCount,
    skippedCount,
    createdAt: new Date(),
  };
  try {
    let reward = await submitAttempt(attempt, state.user);
    trackProductEvent("quiz_played");
    void logEvent("quiz_played", { mode: MODE, score, correct_count: correctCount });
    if (state.challenge) {
      const side = state.challenge.fromUid === state.uid ? "from" : "to";
      reward = await recordChallengePlay({
        challengeId: state.challenge.challengeId,
        side,
        playerUid: state.uid,
        score,
        correctCount,
        answers: state.answers,
      });
      state.resolvedChallenge = await fetchChallenge(state.challenge.challengeId).catch(() => null);
    }
    state.reward = reward;
  } catch (err) {
    console.error("[quiz-play] finish/submit error", err);
  }
  render();
}

function isTerminalSessionV2Error(error) {
  const code = String(error?.code || "").replace(/^functions\//, "");
  return ["failed-precondition", "not-found", "permission-denied", "invalid-argument"].includes(code);
}

async function submitPendingSessionV2(pending) {
  state.status = "submitting";
  state.pendingSessionV2 = pending;
  render();
  try {
    const result = await submitQuizSessionV2({
      sessionId: pending.sessionId,
      idempotencyKey: pending.idempotencyKey,
      answers: pending.answers,
    });
    clearPendingQuizSessionV2(sessionStorageSafe(), state.uid);
    state.pendingSessionV2 = null;
    state.answers = canonicalAnswersFromQuizSessionV2(result);
    state.serverScore = result.score;
    state.reward = result.reward;
    state.status = "finished";
    state.submitRetryable = false;
    trackProductEvent("quiz_played");
    void logEvent("quiz_played", {
      mode: "solo_v2",
      score: result.score,
      correct_count: result.counts.correct,
    });
  } catch (err) {
    console.error("[quiz-play] V2 submit error", err);
    const terminal = isTerminalSessionV2Error(err);
    state.status = "submit_error";
    state.errorMessage = err?.message || i18nT("Errore. Riprova.");
    state.submitRetryable = !terminal || isRetryableQuizSessionV2Error(err);
    if (terminal) {
      clearPendingQuizSessionV2(sessionStorageSafe(), state.uid);
      state.pendingSessionV2 = null;
    }
  }
  render();
}

async function finishSessionV2() {
  let pending = state.pendingSessionV2;
  if (!pending) {
    pending = createPendingQuizSessionV2({
      uid: state.uid,
      sessionId: state.sessionV2Id,
      expiresAt: state.sessionV2ExpiresAt,
      idempotencyKey: uuid(),
      answers: state.answers.map(({ questionId, selectedIndex, timeMs }) => ({ questionId, selectedIndex, timeMs })),
    });
    if (!pending) {
      state.status = "submit_error";
      state.errorMessage = i18nT("Errore. Riprova.");
      state.submitRetryable = false;
      render();
      return;
    }
    state.pendingSessionV2 = pending;
    savePendingQuizSessionV2(sessionStorageSafe(), pending);
  }
  await submitPendingSessionV2(pending);
}

/* ===== Segnalazione problema ===== */

function openReportSheet() {
  const q = currentQuestion();
  if (!q) return;
  const reasons = [
    i18nT("Risposta errata"), "Domanda ambigua", i18nT("Più risposte plausibili"),
    i18nT("Spoiler non segnalato"), i18nT("Errore di battitura"), i18nT("Altro"),
  ];
  const overlay = document.createElement("div");
  overlay.className = "quiz-modal is-open";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", i18nT("Segnala problema"));
  overlay.innerHTML = `
    <div class="quiz-modal-backdrop" data-close></div>
    <div class="quiz-modal-sheet">
      <div class="quiz-modal-head">
        <h2>${i18nT("Segnala problema")}</h2>
        <button type="button" class="quiz-modal-close" data-close aria-label="${i18nT("Chiudi")}">&times;</button>
      </div>
      <div class="quiz-modal-body">
        <div class="quiz-field-label">${i18nT("Cosa non torna?")}</div>
        <div class="quiz-friend-list" id="reportReasons">
          ${reasons.map((r, i) => `
            <button type="button" class="quiz-friend-row" data-reason="${escapeHtml(r)}" aria-pressed="${i === 0}">
              <span class="quiz-friend-meta"><span class="quiz-friend-name">${escapeHtml(r)}</span></span>
              <span class="quiz-status-pill${i === 0 ? " is-filled" : ""}" style="--quiz-pill-tint:var(--brand-primary)">${i === 0 ? ICONS.check : ""}</span>
            </button>`).join("")}
        </div>
        <div class="quiz-field">
          <label class="quiz-field-label" for="reportNote">${i18nT("Nota (opzionale)")}</label>
          <input type="text" id="reportNote" placeholder="${i18nT("Aggiungi un dettaglio…")}">
        </div>
        <button type="button" class="btn primary full" id="reportSubmit">${i18nT("Invia segnalazione")}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  let selectedReason = reasons[0];
  overlay.querySelectorAll("[data-reason]").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedReason = btn.getAttribute("data-reason");
      overlay.querySelectorAll("[data-reason]").forEach((b) => {
        const active = b === btn;
        b.setAttribute("aria-pressed", String(active));
        const pill = b.querySelector(".quiz-status-pill");
        if (pill) {
          pill.classList.toggle("is-filled", active);
          pill.innerHTML = active ? ICONS.check : "";
        }
      });
    });
  });
  const close = () => overlay.remove();
  overlay.querySelectorAll("[data-close]").forEach((n) => n.addEventListener("click", close));
  overlay.querySelector("#reportSubmit")?.addEventListener("click", async () => {
    const note = String(overlay.querySelector("#reportNote")?.value || "").trim();
    const reason = note ? `${selectedReason}: ${note}` : selectedReason;
    close();
    await submitReport(reason);
  });
}

async function submitReport(reason) {
  const q = currentQuestion();
  if (!q || !state.uid) return;
  try {
    await reportQuestionProblem({
      questionId: q.questionId,
      reportedBy: state.uid,
      reason,
      attemptOutcome: state.revealedOutcome,
    });
    showReportToast("Segnalazione inviata. Grazie.");
  } catch (err) {
    console.error("[quiz-play] report error", err);
    showReportToast(i18nT("Impossibile inviare la segnalazione."));
  }
}

function showReportToast(text) {
  document.querySelector(".quiz-inline-toast")?.remove();
  if (state.reportToastTimer) window.clearTimeout(state.reportToastTimer);
  const el = document.createElement("div");
  el.className = "quiz-inline-toast";
  el.textContent = text;
  document.body.appendChild(el);
  state.reportToastTimer = window.setTimeout(() => el.remove(), 2600);
}

/* ===== Render: player ===== */

function renderProgressHeader() {
  const current = Math.min(state.currentIndex + 1, state.questions.length);
  const total = state.questions.length;
  const remaining = Math.max(total - current, 0);
  const filled = state.answers.length / Math.max(total, 1);
  return `
    <div class="quiz-play-progresshead">
      <div class="row">
        <span class="quiz-play-step">Domanda ${current} di ${total}</span>
        ${remaining > 0 ? `<span class="quiz-play-remaining">${remaining} restanti</span>` : ""}
      </div>
      <div class="quiz-progress"><div class="quiz-progress-fill${filled <= 0 ? " is-zero" : ""}" style="width:${filled * 100}%"></div></div>
    </div>`;
}

function renderScoreRow() {
  const q = currentQuestion();
  const diff = DIFFICULTY[q?.difficulty] || DIFFICULTY.medium;
  const streak = currentStreak();
  if (state.usesSessionV2) {
    return `
      <div class="quiz-play-scorerow">
        <span style="flex:1"></span>
        ${q ? statusPill(diff.label, { tint: diff.tint, icon: "speedometer" }) : ""}
      </div>`;
  }
  return `
    <div class="quiz-play-scorerow">
      <span class="quiz-score-badge">
        ${ICONS.star}
        <span class="copy">
          <span class="lbl">${i18nT("Punteggio")}</span>
          <span class="val">${formatScore(liveScore())}</span>
        </span>
      </span>
      ${streak >= 2 ? streakChip(streak, { isDaily: false }) : ""}
      <span style="flex:1"></span>
      ${q ? statusPill(diff.label, { tint: diff.tint, icon: "speedometer" }) : ""}
    </div>`;
}

function renderQuestionCard(q) {
  return `
    <div class="quiz-question-card">
      <span class="quiz-question-reel">${ICONS.filmStack}</span>
      <div class="quiz-question-body">
        <span class="quiz-title-chip">
          ${q.mediaType === "tv" ? ICONS.tv : ICONS.film}
          <span>${escapeHtml(q.title)}</span>
        </span>
        <div class="quiz-question-text">${escapeHtml(q.questionText)}</div>
      </div>
    </div>`;
}

function renderAnswers(q) {
  const rows = q.answers.map((answer, idx) => {
    const isSelected = state.selectedIndex === idx;
    const cls = ["quiz-answer"];
    let mark = "";
    if (state.isRevealing) {
      cls.push("is-locked");
      if (state.usesSessionV2 && state.revealedOutcome === "pending") {
        if (state.revealedSelectedIndex === idx) {
          cls.push("is-selected");
          mark = `<span class="quiz-answer-mark">${ICONS.checkCircle}</span>`;
        }
      } else if (idx === q.correctAnswerIndex) {
        cls.push("is-correct");
        mark = `<span class="quiz-answer-mark">${ICONS.checkCircle}</span>`;
      } else if (state.revealedSelectedIndex === idx) {
        cls.push("is-wrong");
        mark = `<span class="quiz-answer-mark">${ICONS.xCircle}</span>`;
      }
    } else if (isSelected) {
      cls.push("is-selected");
      mark = `<span class="quiz-answer-mark">${ICONS.checkCircle}</span>`;
    }
    return `
      <button type="button" class="${cls.join(" ")}" data-answer="${idx}" ${state.isRevealing ? "disabled" : ""}>
        <span class="quiz-answer-letter">${LETTERS[idx] || "?"}</span>
        <span class="quiz-answer-text">${escapeHtml(answer)}</span>
        ${mark}
      </button>`;
  }).join("");
  return `<div class="quiz-answers">${rows}</div>`;
}

function renderOutcomeBanner(q) {
  const outcome = state.revealedOutcome || "skipped";
  const deferred = state.usesSessionV2 && !Number.isInteger(q.correctAnswerIndex);
  let tint = "var(--success)";
  let icon = ICONS.checkCircle;
  let title = i18nT("Risposta corretta!");
  if (outcome === "pending") {
    tint = "var(--accent)";
    title = i18nT("Risposta registrata");
  } else if (outcome === "correct") {
    const streak = currentStreak();
    if (streak === 2) title += " · 2 di fila";
    else if (streak === 3) title += " · 3 di fila!";
    else if (streak === 4) title += i18nT(" · 4 di fila, sei in fiamme!");
    else if (streak > 4) title += ` · ${streak} di fila!`;
  } else if (outcome === "wrong") {
    tint = "var(--brand-primary)";
    icon = ICONS.xCircle;
    title = i18nT("Risposta sbagliata");
  } else {
    tint = "var(--text-muted)";
    icon = ICONS.forward;
    title = "Domanda saltata";
  }
  const correctText = q.answers[q.correctAnswerIndex] || "";
  const correctBlock = !deferred && outcome !== "correct"
    ? `<div>
         <div class="quiz-outcome-correct-label">${i18nT("Risposta corretta")}</div>
         <div class="quiz-outcome-correct-text">${escapeHtml(correctText)}</div>
       </div>`
    : "";
  const explanation = !deferred && q.explanation
    ? `<div class="quiz-outcome-explanation">${escapeHtml(q.explanation)}</div>`
    : "";
  return `
    <div class="quiz-outcome" style="--quiz-outcome-tint:${tint}">
      <div class="quiz-outcome-head">
        <span class="quiz-outcome-icon">${icon}</span>
        <span class="quiz-outcome-title">${escapeHtml(title)}</span>
        ${outcome === "pending" ? "" : `<button type="button" class="quiz-report-btn" id="quizReportBtn">${ICONS.reportBubble}<span>${i18nT("Segnala")}</span></button>`}
      </div>
      ${correctBlock}
      ${explanation}
    </div>`;
}

function renderActionBar() {
  if (state.isRevealing) {
    const last = state.currentIndex + 1 >= state.questions.length;
    return `
      <div class="quiz-actionbar">
        <div class="quiz-actionbar-inner">
          <button type="button" class="btn primary" id="quizContinueBtn">${last ? i18nT("Vedi risultato") : i18nT("Continua")}</button>
        </div>
      </div>`;
  }
  const disabled = state.selectedIndex == null ? "disabled" : "";
  return `
    <div class="quiz-actionbar">
      <div class="quiz-actionbar-inner">
        <button type="button" class="btn ghost quiz-skip-btn" id="quizSkipBtn">${i18nT("Salta")}</button>
        <button type="button" class="btn primary" id="quizConfirmBtn" ${disabled}>${i18nT("Conferma")}</button>
      </div>
    </div>`;
}

function renderPlaying() {
  const q = currentQuestion();
  if (!q) {
    root.innerHTML = loadingState(i18nT("Carico la domanda…"));
    return;
  }
  root.innerHTML = `
    <div class="quiz-play-page">
      ${renderProgressHeader()}
      ${renderScoreRow()}
      ${renderQuestionCard(q)}
      ${renderAnswers(q)}
      ${state.isRevealing ? renderOutcomeBanner(q) : ""}
    </div>
    ${renderActionBar()}`;
}

/* ===== Render: risultato ===== */

function resultHeadline(pct) {
  if (pct >= 90) return { icon: ICONS.crown, tint: "var(--brand-warm)", title: i18nT("Sei un fuoriclasse"), subtitle: "Risultato eccellente." };
  if (pct >= 70) return { icon: ICONS.trophy, tint: "var(--brand-warm)", title: "Ottimo lavoro", subtitle: i18nT("Conosci bene i tuoi titoli.") };
  if (pct >= 50) return { icon: ICONS.star, tint: "var(--accent)", title: "Buon risultato", subtitle: i18nT("C'è ancora margine per migliorare.") };
  if (pct >= 1) return { icon: ICONS.flag, tint: "var(--brand-primary)", title: i18nT("Si può fare di meglio"), subtitle: i18nT("Riprova con un altro round.") };
  return { icon: ICONS.flag, tint: "var(--text-muted)", title: i18nT("Hai saltato tutto"), subtitle: i18nT("Tenta una risposta al prossimo round.") };
}

function renderFinished() {
  const correctCount = state.answers.filter((a) => a.outcome === "correct").length;
  const wrongCount = state.answers.filter((a) => a.outcome === "wrong").length;
  const skippedCount = state.answers.filter((a) => a.outcome === "skipped").length;
  const answered = correctCount + wrongCount;
  const accuracy = answered > 0 ? Math.round((correctCount / answered) * 100) : null;
  const headline = resultHeadline(accuracy || 0);
  const reward = state.reward;

  const rewardBlock = (reward.xpAwarded > 0 || reward.dailyStreak > 0)
    ? `<div class="quiz-reward-block">
         <div class="quiz-reward-head">
           <strong>${i18nT("Ricompense")}</strong>
           ${reward.dailyBonusActive ? statusPill(i18nT("Bonus +20% attivo"), { tint: "var(--success)", icon: "gift" }) : ""}
         </div>
         <div class="quiz-reward-badges">
           ${reward.xpAwarded > 0 ? xpBadge(reward.xpAwarded, { showsPlus: true, regular: true, pop: true }) : ""}
           ${reward.dailyStreak > 0 ? streakChip(reward.dailyStreak, { isDaily: true }) : ""}
         </div>
       </div>`
    : "";

  const challengeDone = state.resolvedChallenge && state.resolvedChallenge.isComplete;
  const primaryAction = challengeDone
    ? `<a class="btn primary full" href="/quiz-challenge-result.html?id=${encodeURIComponent(state.resolvedChallenge.challengeId)}">${ICONS.people}<span>${i18nT("Vedi confronto sfida")}</span></a>`
    : `<button type="button" class="btn primary full" id="quizReplayBtn">${ICONS.refresh}<span>${i18nT("Rigioca")}</span></button>`;

  root.innerHTML = `
    <div class="quiz-result-page">
      <div class="quiz-result-headline">
        <span class="quiz-result-emblem" style="--quiz-result-tint:${headline.tint}">${headline.icon}</span>
        <h1 class="quiz-result-title">${escapeHtml(headline.title)}</h1>
        <p class="quiz-result-subtitle">${escapeHtml(headline.subtitle)}</p>
      </div>
      <div class="quiz-result-scorecard quiz-glow-card is-gradient">
        <span class="quiz-result-score-label">${i18nT("PUNTEGGIO")}</span>
        <span class="quiz-result-score-value">${formatScore(liveScore())}</span>
      </div>
      ${rewardBlock}
      <div class="quiz-stat-grid">
        ${statTile({ label: i18nT("Accuratezza"), value: accuracy != null ? `${accuracy}%` : "—", icon: "scope", accent: "var(--accent)", sublabel: i18nT("risposte giuste") })}
        ${statTile({ label: i18nT("Miglior serie"), value: String(bestStreak()), icon: "flame", accent: "var(--brand-warm)", sublabel: i18nT("di fila") })}
      </div>
      <div class="quiz-breakdown">
        <div class="quiz-breakdown-row"><span style="color:var(--success)">${ICONS.checkCircle}</span><span class="lbl">${i18nT("Corrette")}</span><span class="val">${correctCount}</span></div>
        <div class="quiz-breakdown-row"><span style="color:var(--brand-primary)">${ICONS.xCircle}</span><span class="lbl">Errate</span><span class="val">${wrongCount}</span></div>
        <div class="quiz-breakdown-row"><span style="color:var(--text-muted)">${ICONS.forward}</span><span class="lbl">Saltate</span><span class="val">${skippedCount}</span></div>
      </div>
    </div>
    <div class="quiz-actionbar">
      <div class="quiz-actionbar-inner" style="flex-direction:column;gap:0.5rem">
        ${primaryAction}
        <a class="btn ghost full" href="/quiz.html">${i18nT("Chiudi")}</a>
      </div>
    </div>`;

  // Confetti solo se il run è andato bene (>= 50% accuratezza).
  if ((accuracy || 0) >= 50) {
    fireConfetti({ pieceCount: 40 });
  }
}

/* ===== Render dispatcher ===== */

function render() {
  if (state.status === "loading") {
    root.innerHTML = loadingState(challengeId ? i18nT("Apro la sfida…") : i18nT("Preparo il quiz…"));
    return;
  }
  if (state.status === "error") {
    root.innerHTML = `<div class="quiz-play-page">${errorState({ message: state.errorMessage, retryId: "quizRetry" })}</div>`;
    return;
  }
  if (state.status === "submitting") {
    root.innerHTML = loadingState(i18nT("Invio..."));
    return;
  }
  if (state.status === "submit_error") {
    const retryId = state.pendingSessionV2 && state.submitRetryable ? "quizSubmitRetry" : "quizRestart";
    root.innerHTML = `<div class="quiz-play-page">${errorState({ message: state.errorMessage, retryId })}</div>`;
    document.getElementById("quizSubmitRetry")?.addEventListener("click", () => {
      if (state.pendingSessionV2) void submitPendingSessionV2(state.pendingSessionV2);
    });
    document.getElementById("quizRestart")?.addEventListener("click", () => void start());
    return;
  }
  if (state.status === "finished") {
    renderFinished();
    bindFinished();
    return;
  }
  renderPlaying();
  bindPlaying();
}

/* ===== Wiring ===== */

function bindPlaying() {
  root.querySelectorAll("[data-answer]").forEach((btn) => {
    btn.addEventListener("click", () => selectAnswer(Number(btn.getAttribute("data-answer"))));
  });
  document.getElementById("quizConfirmBtn")?.addEventListener("click", confirmCurrent);
  document.getElementById("quizSkipBtn")?.addEventListener("click", skipCurrent);
  document.getElementById("quizContinueBtn")?.addEventListener("click", continueFromReveal);
  document.getElementById("quizReportBtn")?.addEventListener("click", openReportSheet);
  document.getElementById("quizRetry")?.addEventListener("click", start);
}

function bindFinished() {
  document.getElementById("quizReplayBtn")?.addEventListener("click", () => {
    // Rigioca solo in solo: una sfida ha domande fisse.
    if (challengeId) {
      window.location.href = "/quiz.html";
      return;
    }
    void start();
  });
}

/* ===== Init ===== */

initAuthGuard({
  requireAuth: true,
  onReady: async (user) => {
    if (!user) return;
    state.uid = user.uid;
    // Il displayName reale sta su users/{uid}, non su Auth (che è null) → senza questo
    // la classifica denormalizzava "Utente" invece del nome scelto.
    let profile = null;
    try { profile = await getUserPublic(user.uid); } catch (_) { /* fallback ad Auth */ }
    state.user = {
      displayName: profile?.displayName || user.displayName || null,
      photoURL: profile?.photoURL || profile?.avatarURL || user.photoURL || null,
    };
    void start();
  },
});
