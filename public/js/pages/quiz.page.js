/**
 * quiz.page.js — Hub Quiz (web).
 * Mirror di QuizHomeView.swift (redesign 2026-06-18): hero "Gioca" snello con
 * streak inline, strip statistiche compatta, righe menu Sfide/Classifica, barra
 * bonus. La CTA "Gioca" porta a /quiz-setup.html (fork casuale/titolo specifico).
 * Stato loggato richiesto; senza login → redirect a /login.html?next=.
 */

import { initAuthGuard } from "../components/authGuard.js";
import { t as i18nT } from "../i18n/index.js";
import { escapeHtml } from "../utils/dom.js";
import { ICONS, formatScore, loadingState } from "../components/quizUI.js";
import {
  QUIZ_XP, fetchUserStats, fetchReceivedChallenges,
} from "../api/quiz.api.js";

const root = document.getElementById("quizHub");

const state = {
  uid: null,
  stats: null,
  pendingChallenges: 0,
};

/* ===== Helpers stats ===== */

function accuracyPct(stats) {
  const answered = (stats.correctCount || 0) + (stats.wrongCount || 0);
  if (answered <= 0) return null;
  return Math.round((stats.correctCount / answered) * 100);
}

function dailyBonusActive(stats) {
  return (stats.dailyBonusGames || 0) >= QUIZ_XP.dailyBonusGamesRequired;
}

/* ===== Render sezioni ===== */

/** Hero principale: "Gioca" → setup (fork casuale/titolo specifico). */
function renderPlayCTA(stats) {
  const streak = stats.dailyStreak || 0;
  const streakChip = streak > 0
    ? `<span class="quiz-play-cta-streak">${ICONS.flame}${streak}</span>`
    : "";
  return `
    <a class="quiz-pressable" href="/quiz-setup.html" aria-label="${i18nT("Gioca")}">
      <div class="quiz-play-cta">
        ${streakChip}
        <span class="quiz-play-cta-icon">${ICONS.play}</span>
        <div class="quiz-play-cta-copy">
          <div class="quiz-play-cta-title-row">
            <span class="quiz-play-cta-title">${i18nT("Gioca")}</span>
            <span class="quiz-status-pill is-filled" style="--quiz-pill-tint:rgba(255,255,255,0.28)">Beta</span>
          </div>
          <div class="quiz-play-cta-subtitle">${i18nT("Casuale o titolo specifico")}</div>
        </div>
        <span class="quiz-play-cta-chevron">${ICONS.chevron}</span>
      </div>
    </a>`;
}

/** Strip compatta: 3 metriche inline (al posto delle 4 tile grandi). */
function renderStatStrip(stats) {
  const acc = accuracyPct(stats);
  const cell = (value, label) => `
    <div class="quiz-stat-strip-cell">
      <span class="quiz-stat-strip-value">${escapeHtml(value)}</span>
      <span class="quiz-stat-strip-label">${escapeHtml(label)}</span>
    </div>`;
  return `
    <div class="quiz-stat-strip">
      ${cell(formatScore(stats.totalScore), i18nT("Punteggio"))}
      ${cell(acc != null ? `${acc}%` : "0%", "Giuste")}
      ${cell(String(stats.attemptsCount || 0), "Partite")}
    </div>`;
}

/** Nota beta sotto la strip statistiche. */
function renderBetaNote() {
  return `<p class="quiz-beta-note">${i18nT("Il Quiz è in beta: le domande crescono e migliorano ogni settimana. Trovi un errore? Segnalalo dal player.")}</p>`;
}

function menuRow({ href, icon, title, sub, accent, badge }) {
  const badgeMarkup = badge > 0 ? `<span class="quiz-menu-row-badge">${badge}</span>` : "";
  return `
    <a class="quiz-pressable" href="${href}" aria-label="${escapeHtml(title)}">
      <div class="quiz-menu-row" style="--quiz-row-accent:${accent}">
        <span class="quiz-menu-row-icon">${icon}</span>
        <span class="quiz-menu-row-copy">
          <span class="quiz-menu-row-title">${escapeHtml(title)}</span>
          <span class="quiz-menu-row-sub">${escapeHtml(sub)}</span>
        </span>
        ${badgeMarkup}
        <span class="quiz-menu-row-chev">${ICONS.chevron}</span>
      </div>
    </a>`;
}

function renderMenuRows() {
  const pending = state.pendingChallenges;
  return `
    <div class="quiz-menu-list">
      ${menuRow({
        href: "/quiz-challenges.html",
        icon: ICONS.people,
        title: i18nT("Sfide"),
        sub: pending > 0 ? `${pending} in attesa` : i18nT("Sfida un amico"),
        accent: "var(--brand-secondary)",
        badge: pending,
      })}
      ${menuRow({
        href: "/quiz-leaderboard.html",
        icon: ICONS.trophy,
        title: i18nT("Classifica"),
        sub: "Scopri i migliori",
        accent: "var(--brand-warm)",
        badge: 0,
      })}
    </div>`;
}

function renderBonusCard(stats) {
  const goal = QUIZ_XP.dailyBonusGamesRequired;
  const progress = Math.min(stats.dailyBonusGames || 0, goal);
  const active = dailyBonusActive(stats);
  const remaining = Math.max(goal - progress, 0);
  const headline = active ? "Bonus giornaliero attivo!" : "Bonus giornaliero +20% XP";
  let subtitle;
  if (active) {
    subtitle = i18nT("Stai guadagnando il 20% di XP in più su ogni partita.");
  } else if (remaining === 1) {
    subtitle = i18nT("Gioca ancora 1 partita per attivare il bonus.");
  } else {
    subtitle = i18nT("Gioca {remaining} partite per attivare il bonus.", { remaining });
  }
  const pct = goal > 0 ? progress / goal : 0;
  const fillVariant = active ? "success" : "warm";
  return `
    <div class="quiz-bonus-card${active ? " is-active" : ""}">
      <div class="quiz-bonus-head">
        <span class="quiz-bonus-icon">${ICONS.gift}</span>
        <div class="quiz-bonus-copy">
          <div class="quiz-bonus-title">${escapeHtml(headline)}</div>
          <div class="quiz-bonus-subtitle">${escapeHtml(subtitle)}</div>
        </div>
      </div>
      <div class="quiz-bonus-progressrow">
        <div class="quiz-progress is-slim"><div class="quiz-progress-fill fill-${fillVariant}${pct <= 0 ? " is-zero" : ""}" style="width:${pct * 100}%"></div></div>
        <span class="quiz-bonus-count">${progress}/${goal}</span>
      </div>
    </div>`;
}

function render() {
  if (!state.stats) {
    root.innerHTML = loadingState(i18nT("Carico il Quiz…"));
    return;
  }
  const stats = state.stats;
  root.innerHTML = [
    renderPlayCTA(stats),
    renderStatStrip(stats),
    renderBetaNote(),
    renderMenuRows(),
    renderBonusCard(stats),
  ].filter(Boolean).join("");
}

/* ===== Caricamento dati ===== */

async function loadStats() {
  if (!state.uid) return;
  try {
    const [stats, inbox] = await Promise.all([
      fetchUserStats(state.uid),
      fetchReceivedChallenges(state.uid).catch(() => []),
    ]);
    state.stats = stats;
    state.pendingChallenges = inbox.filter((c) => c.status === "pending").length;
  } catch (err) {
    console.error("[quiz] loadStats error", err);
    state.stats = state.stats || await fetchUserStats(null);
  }
  render();
}

/* ===== Init ===== */

initAuthGuard({
  requireAuth: true,
  onReady: (user) => {
    if (!user) return;
    state.uid = user.uid;
    render(); // skeleton loading
    void loadStats();
  },
});
