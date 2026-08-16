/**
 * quiz-challenge-result.page.js — Risultato sfida Tu vs Avversario (web).
 * Replica QuizChallengeResultView.swift: scoreboard, esito, info rows,
 * prestazioni, confronto risposte per domanda, notice in attesa.
 * URL: ?id=<challengeId>
 */

import { initAuthGuard } from "../components/authGuard.js";
import { t as i18nT } from "../i18n/index.js";
import { escapeHtml } from "../utils/dom.js";
import { fireConfetti } from "../components/quizConfetti.js";
import {
  ICONS, formatScore, statusPill, avatarMarkup, initial,
  loadingState, statTile, errorState,
} from "../components/quizUI.js";
import { fetchChallenge, fetchQuestionsByIds } from "../api/quiz.api.js";
import { listUsersPublicByIds } from "../api/users.api.js";

const root = document.getElementById("quizChallengeResult");
const challengeId = new URLSearchParams(location.search).get("id") || "";

const state = {
  uid: null,
  challenge: null,
  questions: [],
  otherUser: null,
  status: "loading",      // loading | ready | error
  errorMessage: "",
};

/* ===== Derivati ===== */

function isFromMe() {
  return state.challenge && state.challenge.fromUid === state.uid;
}
function myScore() {
  const c = state.challenge;
  return isFromMe() ? c.fromScore : c.toScore;
}
function theirScore() {
  const c = state.challenge;
  return isFromMe() ? c.toScore : c.fromScore;
}
function myAnswers() {
  const c = state.challenge;
  return isFromMe() ? c.fromAnswers : c.toAnswers;
}
function theirAnswers() {
  const c = state.challenge;
  return isFromMe() ? c.toAnswers : c.fromAnswers;
}
function opponentLabel() {
  const c = state.challenge;
  if (c.opponentDisplayName) return c.opponentDisplayName;
  if (c.opponentPlaceholderName) return c.opponentPlaceholderName;
  return c.inviteType === "external" ? "Invito esterno" : "Avversario";
}
/** win | loss | tie | pending */
function outcome() {
  const mine = myScore();
  const theirs = theirScore();
  if (mine == null || theirs == null) return "pending";
  if (mine > theirs) return "win";
  if (mine < theirs) return "loss";
  return "tie";
}
function outcomeTint() {
  switch (outcome()) {
    case "win": return "var(--success)";
    case "loss": return "var(--brand-primary)";
    case "tie": return "var(--accent)";
    default: return "var(--text-muted)";
  }
}

const CATEGORY_LABELS = {
  anagraphic: "Anagrafica", character: "Personaggi", plot: "Trama", scene: "Scene",
  relationship: i18nT("Relazioni"), object: "Oggetti", motivation: "Motivazioni",
  consequence: "Conseguenze", episode: "Episodi", quotePAraphrase: "Citazioni",
  chronology: "Cronologia", trivia: i18nT("Curiosità"),
};

function categoryLabel() {
  const cats = state.questions.map((q) => q.category).filter(Boolean);
  if (!cats.length) return "Mista";
  const unique = new Set(cats);
  if (unique.size > 1) return "Mista";
  return CATEGORY_LABELS[cats[0]] || "Mista";
}

function longestCorrectStreak(answers) {
  let best = 0;
  let run = 0;
  for (const a of answers) {
    if (a.outcome === "correct") { run += 1; best = Math.max(best, run); }
    else run = 0;
  }
  return best;
}

function formatDate(date) {
  if (!date) return "—";
  try {
    return date.toLocaleDateString("it-IT", { day: "numeric", month: "short", year: "numeric" });
  } catch (_) {
    return "—";
  }
}

/* ===== Render ===== */

function renderOpponentHeader() {
  const tint = outcomeTint();
  const photo = state.otherUser ? (state.otherUser.photoURL || state.otherUser.avatarURL) : null;
  const name = opponentLabel();
  const avatar = photo
    ? `<img class="quiz-opponent-avatar" style="--quiz-outcome-tint:${tint}" src="${escapeHtml(photo)}" alt="" loading="lazy">`
    : `<span class="quiz-opponent-avatar quiz-avatar-fallback is-gradient" style="--quiz-outcome-tint:${tint}">${escapeHtml(initial(name))}</span>`;
  const c = state.challenge;
  const isReceived = !isFromMe();
  const hasPlayed = myScore() != null;
  return `
    <div class="quiz-opponent-header">
      ${avatar}
      <span class="quiz-opponent-eyebrow">SFIDA A ${escapeHtml(name.toUpperCase())}</span>
      ${challengeStatePill(c, isReceived, hasPlayed)}
    </div>`;
}

/** Pill di stato (versione minimale, coerente con la inbox). */
function challengeStatePill(c, isReceived, hasPlayed) {
  const complete = c.fromScore != null && c.toScore != null;
  if (complete) {
    const o = outcome();
    if (o === "win") return statusPill("Vittoria", { tint: "var(--success)", icon: "crown" });
    if (o === "loss") return statusPill("Sconfitta", { tint: "var(--brand-primary)", icon: "flag" });
    if (o === "tie") return statusPill("Pareggio", { tint: "var(--accent)", icon: "equal" });
    return statusPill("Completata", { tint: "var(--success)", icon: "check" });
  }
  if (hasPlayed) return statusPill("In attesa avversario", { tint: "var(--text-muted)", icon: "hourglass" });
  return statusPill("Gioca ora", { tint: "var(--brand-primary)", icon: "play", filled: true });
}

function scoreColumn(name, score, isWinner) {
  return `
    <div class="quiz-score-col${isWinner ? " is-winner" : ""}" style="--quiz-outcome-tint:${outcomeTint()}">
      <span class="name">${escapeHtml(name)}</span>
      <span class="big">${score != null ? formatScore(score) : "—"}</span>
      <span class="pts">${i18nT("PUNTI")}</span>
    </div>`;
}

function renderScoreboard() {
  const o = outcome();
  let pillIcon = ICONS.hourglass;
  let pillLabel = "Sfida in corso";
  if (o === "win") { pillIcon = ICONS.crown; pillLabel = "Vittoria"; }
  else if (o === "loss") { pillIcon = ICONS.flag; pillLabel = "Sconfitta"; }
  else if (o === "tie") { pillIcon = ICONS.equal; pillLabel = "Pareggio"; }
  return `
    <div class="quiz-scoreboard quiz-glow-card${o === "pending" ? " glow-none" : ""}">
      <div class="quiz-scoreboard-row">
        ${scoreColumn("Tu", myScore(), o === "win")}
        <div class="quiz-score-vs-col">
          <span class="vs">VS</span>
          <span>${ICONS.bolt}</span>
        </div>
        ${scoreColumn(opponentLabel(), theirScore(), o === "loss")}
      </div>
      <span class="quiz-outcome-pill${o === "pending" ? " is-pending" : ""}" style="--quiz-outcome-tint:${outcomeTint()}">
        ${pillIcon}<span>${escapeHtml(pillLabel)}</span>
      </span>
    </div>`;
}

function renderInfoRows() {
  const c = state.challenge;
  return `
    <div class="quiz-inforows">
      <div class="quiz-inforow">${ICONS.list}<span class="lbl">Domande</span><span class="val">${c.numQuestions}</span></div>
      <div class="quiz-inforow">${ICONS.calendar}<span class="lbl">${i18nT("Completata il")}</span><span class="val">${escapeHtml(formatDate(c.completedAt))}</span></div>
      <div class="quiz-inforow">${c.inviteType === "external" ? ICONS.link : ICONS.people}<span class="lbl">${i18nT("Modalità")}</span><span class="val">${c.inviteType === "external" ? "Invito esterno" : "Sfida amico"}</span></div>
      <div class="quiz-inforow">${ICONS.filmStack}<span class="lbl">Categoria</span><span class="val">${escapeHtml(categoryLabel())}</span></div>
    </div>`;
}

function renderPerformance() {
  const answers = myAnswers();
  if (!answers.length) return "";
  const correct = answers.filter((a) => a.outcome === "correct").length;
  const accuracy = Math.round((correct / Math.max(answers.length, 1)) * 100);
  const times = answers.map((a) => a.timeMs).filter((t) => typeof t === "number");
  const avgTime = times.length
    ? `${(times.reduce((s, t) => s + t, 0) / times.length / 1000).toFixed(1)}s`
    : "—";
  const best = longestCorrectStreak(answers);
  return `
    <section>
      <div class="quiz-section-head" style="margin-bottom:0.625rem">
        <span class="quiz-section-title">${i18nT("Le tue prestazioni")}</span>
      </div>
      <div class="quiz-stat-grid is-trio">
        ${statTile({ label: i18nT("Corrette"), value: `${accuracy}%`, icon: "scope", accent: "var(--success)", sublabel: `${correct}/${answers.length}` })}
        ${statTile({ label: i18nT("Tempo medio"), value: avgTime, icon: "timer", accent: "var(--accent)", sublabel: i18nT("per domanda") })}
        ${statTile({ label: i18nT("Serie"), value: String(best), icon: "flame", accent: "var(--brand-warm)", sublabel: "migliore" })}
      </div>
    </section>`;
}

function answerText(answer, question) {
  if (!answer) return i18nT("Nessuna risposta");
  const idx = answer.selectedIndex;
  if (idx == null || !question.answers[idx]) return i18nT("Saltata");
  return question.answers[idx];
}

function answerComparisonRow(label, answer, question) {
  const o = answer ? answer.outcome : "skipped";
  let tint = "var(--text-muted)";
  let icon = ICONS.minusCircle;
  if (o === "correct") { tint = "var(--success)"; icon = ICONS.checkCircle; }
  else if (o === "wrong") { tint = "var(--brand-primary)"; icon = ICONS.xCircle; }
  return `
    <div class="quiz-review-answer" style="--quiz-ans-tint:${tint}">
      <span class="who">${escapeHtml(label)}</span>
      <span class="txt">${escapeHtml(answerText(answer, question))}</span>
      ${icon}
    </div>`;
}

function renderReview() {
  const mineMap = new Map(myAnswers().map((a) => [a.questionId, a]));
  const theirsMap = new Map(theirAnswers().map((a) => [a.questionId, a]));
  const cards = state.questions.map((q, i) => {
    const correctText = q.answers[q.correctAnswerIndex] || "—";
    return `
      <div class="quiz-review-card">
        <div class="quiz-review-top">
          <span class="quiz-review-index">DOMANDA ${i + 1}</span>
          <span class="quiz-review-titlechip">${ICONS.film}<span>${escapeHtml(q.title)}</span></span>
        </div>
        <div class="quiz-review-question">${escapeHtml(q.questionText)}</div>
        <div class="quiz-review-correct">${ICONS.seal}<span>${escapeHtml(correctText)}</span></div>
        <div class="quiz-review-answers">
          ${answerComparisonRow("Tu", mineMap.get(q.questionId), q)}
          ${answerComparisonRow(opponentLabel(), theirsMap.get(q.questionId), q)}
        </div>
      </div>`;
  }).join("");
  return `
    <section>
      <div class="quiz-section-head" style="margin-bottom:0.625rem">
        <span class="quiz-section-title">${i18nT("Confronto risposte")}</span>
      </div>
      <div class="quiz-review-list">${cards}</div>
    </section>`;
}

function renderWaitingNotice() {
  const mineNull = myScore() == null;
  return `
    <div class="quiz-notice quiz-glow-card glow-none" style="--quiz-outcome-tint:var(--accent)">
      <span style="color:var(--accent)">${ICONS.hourglass}</span>
      <span class="title">${mineNull
        ? i18nT("Devi ancora giocare questa sfida.")
        : i18nT("{v0} non ha ancora giocato.", { v0: escapeHtml(opponentLabel()) })}</span>
      <span class="desc">${i18nT("Il confronto delle risposte è disponibile quando entrambi avete finito.")}</span>
    </div>`;
}

function renderUnavailableNotice() {
  return `
    <div class="quiz-notice is-muted">
      ${ICONS.qmark}
      <span class="desc">${i18nT("Il confronto delle risposte non è disponibile per questa sfida.")}</span>
    </div>`;
}

function renderActions() {
  return `
    <div style="display:flex;flex-direction:column;gap:0.5rem;padding-top:0.25rem">
      <a class="btn primary full" href="/quiz-challenges.html">${ICONS.refresh}<span>${i18nT("Sfida di nuovo")}</span></a>
      <a class="btn ghost full" href="/quiz-challenges.html">${i18nT("Vedi tutte le sfide")}</a>
    </div>`;
}

function render() {
  if (state.status === "loading") {
    root.innerHTML = loadingState(i18nT("Carico il risultato…"));
    return;
  }
  if (state.status === "error") {
    root.innerHTML = errorState({ title: i18nT("Sfida non disponibile"), message: state.errorMessage, retryId: "quizRetry" });
    document.getElementById("quizRetry")?.addEventListener("click", load);
    return;
  }

  const c = state.challenge;
  const complete = c.fromScore != null && c.toScore != null;
  const parts = [renderOpponentHeader(), renderScoreboard()];

  if (complete) {
    parts.push(renderInfoRows());
    if (myAnswers().length) parts.push(renderPerformance());
    if (myAnswers().length && theirAnswers().length) {
      parts.push(renderReview());
    } else {
      parts.push(renderUnavailableNotice());
    }
  } else {
    parts.push(renderWaitingNotice());
  }
  parts.push(renderActions());

  root.innerHTML = parts.filter(Boolean).join("");

  // Confetti se ho vinto.
  if (outcome() === "win") {
    fireConfetti({ pieceCount: 40 });
  }
}

/* ===== Dati ===== */

async function load() {
  if (!challengeId) {
    state.status = "error";
    state.errorMessage = i18nT("Sfida non specificata.");
    return render();
  }
  state.status = "loading";
  render();
  try {
    const challenge = await fetchChallenge(challengeId);
    if (!challenge) {
      state.status = "error";
      state.errorMessage = i18nT("Sfida non trovata.");
      return render();
    }
    state.challenge = challenge;
    const otherUid = isFromMe() ? challenge.toUid : challenge.fromUid;
    const [questions, users] = await Promise.all([
      fetchQuestionsByIds(challenge.questionIds).catch(() => []),
      otherUid ? listUsersPublicByIds([otherUid]).catch(() => []) : Promise.resolve([]),
    ]);
    state.questions = questions;
    state.otherUser = users[0] || null;
    state.status = "ready";
  } catch (err) {
    console.error("[quiz-challenge-result] load error", err);
    state.status = "error";
    state.errorMessage = err?.message || i18nT("Errore imprevisto.");
  }
  render();
}

/* ===== Init ===== */

initAuthGuard({
  requireAuth: true,
  onReady: (user) => {
    if (!user) return;
    state.uid = user.uid;
    void load();
  },
});
