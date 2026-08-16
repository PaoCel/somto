/**
 * quiz-leaderboard.page.js — Classifica Quiz (web).
 * Replica QuizLeaderboardView.swift: segmented Settimanale/All-time, podio
 * top-3 gold/silver/bronze, lista posizioni 4+, barra "la tua posizione".
 */

import { initAuthGuard } from "../components/authGuard.js";
import { t as i18nT } from "../i18n/index.js";
import { escapeHtml } from "../utils/dom.js";
import {
  ICONS, formatScore, statusPill, avatarMarkup, loadingState, emptyState, errorState,
} from "../components/quizUI.js";
import { fetchLeaderboard, fetchUserStats } from "../api/quiz.api.js";

const root = document.getElementById("quizLeaderboard");

const state = {
  uid: null,
  scope: "weekly",        // weekly | allTime
  entries: [],
  myRank: null,
  myScore: 0,
  status: "loading",      // loading | ready | empty | error
  errorMessage: "",
};

const RING_BY_RANK = ["var(--quiz-gold)", "var(--quiz-silver)", "var(--quiz-bronze)"];

/* ===== Render ===== */

function renderScopePicker() {
  const opts = [
    { key: "weekly", label: i18nT("Settimanale") },
    { key: "allTime", label: i18nT("All time") },
  ];
  return `
    <div class="quiz-segmented" role="tablist" aria-label="Periodo classifica">
      ${opts.map((o) => `
        <button type="button" role="tab" data-scope="${o.key}"
          class="${state.scope === o.key ? "is-active" : ""}"
          aria-selected="${state.scope === o.key}">${o.label}</button>`).join("")}
    </div>`;
}

function podiumColumn(entry, rank) {
  const ring = RING_BY_RANK[rank - 1] || "var(--accent)";
  if (!entry) {
    return `
      <div class="quiz-podium-col quiz-podium-empty${rank === 1 ? " is-first" : ""}">
        ${rank === 1 ? `<span class="quiz-podium-crown" style="visibility:hidden">${ICONS.crown}</span>` : ""}
        <span class="quiz-podium-avatar">${ICONS.qmark}</span>
        <span class="quiz-podium-name">—</span>
        <div class="quiz-podium-block"></div>
      </div>`;
  }
  const isMe = entry.uid === state.uid;
  return `
    <div class="quiz-podium-col${rank === 1 ? " is-first" : ""}">
      ${rank === 1 ? `<span class="quiz-podium-crown">${ICONS.crown}</span>` : ""}
      ${avatarMarkup(entry.photoURL, entry.displayName, { className: "quiz-podium-avatar" }).replace("quiz-podium-avatar", `quiz-podium-avatar" style="--quiz-podium-ring:${ring}`)}
      <span class="quiz-podium-name">${escapeHtml(entry.displayName)}</span>
      ${isMe ? `<div>${statusPill("Tu", { tint: "var(--brand-primary)", filled: true })}</div>` : ""}
      <div class="quiz-podium-block" style="--quiz-podium-ring:${ring}">
        <span class="quiz-podium-rank">${rank}</span>
        <span class="quiz-podium-score">${formatScore(entry.score)}</span>
      </div>
    </div>`;
}

function renderPodium() {
  const top = state.entries.slice(0, 3);
  // Ordine visivo: 2° a sinistra, 1° al centro, 3° a destra.
  return `
    <div class="quiz-podium">
      ${podiumColumn(top[1], 2)}
      ${podiumColumn(top[0], 1)}
      ${podiumColumn(top[2], 3)}
    </div>`;
}

function renderRow(entry, rank) {
  const isMe = entry.uid === state.uid;
  return `
    <div class="quiz-lb-row${isMe ? " is-me" : ""}">
      <span class="quiz-lb-rank-num">${rank}</span>
      ${avatarMarkup(entry.photoURL, entry.displayName, { className: "quiz-lb-avatar" })}
      <div class="quiz-lb-info">
        <div class="quiz-lb-nameline">
          <span class="quiz-lb-name">${escapeHtml(entry.displayName)}</span>
          ${isMe ? statusPill("Tu", { tint: "var(--brand-primary)", filled: true }) : ""}
        </div>
        <span class="quiz-lb-sub">${entry.attemptsCount || 0} partite</span>
      </div>
      <span class="quiz-lb-score">${formatScore(entry.score)}</span>
    </div>`;
}

function renderMyRankBar() {
  if (!state.uid) return "";
  const hasRank = state.myRank != null;
  return `
    <div class="quiz-myrank-bar">
      <div class="quiz-myrank-inner">
        ${hasRank ? `<span style="color:var(--brand-warm)">${ICONS.trophy}</span>` : `<span style="color:var(--text-muted)">${ICONS.people}</span>`}
        ${hasRank
          ? `<span class="quiz-myrank-label">${i18nT("La tua posizione")}</span><span class="quiz-myrank-value">#${state.myRank}</span>`
          : `<span class="quiz-myrank-label">${i18nT("Non sei ancora in classifica")}</span>`}
        <span class="quiz-myrank-score">${formatScore(state.myScore)} punti</span>
      </div>
    </div>`;
}

function render() {
  if (state.status === "loading") {
    root.innerHTML = `${renderScopePicker()}${loadingState(i18nT("Carico la classifica…"))}`;
    bindScope();
    return;
  }
  if (state.status === "error") {
    root.innerHTML = `${renderScopePicker()}${errorState({ title: i18nT("Classifica non disponibile"), message: state.errorMessage })}`;
    bindScope();
    document.getElementById("quizRetry")?.addEventListener("click", load);
    return;
  }
  if (state.status === "empty") {
    const message = state.scope === "weekly"
      ? i18nT("Nessuno ha ancora giocato questa settimana. Sii il primo a comparire qui.")
      : i18nT("Nessun punteggio registrato. Inizia un quiz per scalare la classifica.");
    root.innerHTML = `${renderScopePicker()}${emptyState({ icon: "trophy", title: i18nT("Classifica vuota"), message })}`;
    bindScope();
    return;
  }

  const restRows = state.entries.length > 3
    ? state.entries.slice(3).map((e, idx) => renderRow(e, idx + 4)).join("")
    : "";

  root.innerHTML = `
    ${renderScopePicker()}
    ${renderPodium()}
    ${restRows ? `<div class="quiz-lb-list">${restRows}</div>` : ""}
    <div class="quiz-lb-footer">${ICONS.clock}<span>${i18nT("La classifica si aggiorna ogni lunedì alle 00:00")}</span></div>
    ${renderMyRankBar()}`;
  bindScope();
}

/* ===== Dati ===== */

async function load() {
  state.status = "loading";
  render();
  try {
    const entries = await fetchLeaderboard(state.scope, 100);
    state.entries = entries;
    if (state.uid) {
      const idx = entries.findIndex((e) => e.uid === state.uid);
      if (idx >= 0) {
        state.myRank = idx + 1;
        state.myScore = entries[idx].score;
      } else {
        state.myRank = null;
        const stats = await fetchUserStats(state.uid).catch(() => null);
        state.myScore = stats
          ? (state.scope === "weekly" ? stats.weeklyScore : stats.totalScore)
          : 0;
      }
    }
    state.status = entries.length ? "ready" : "empty";
  } catch (err) {
    console.error("[quiz-leaderboard] load error", err);
    state.status = "error";
    state.errorMessage = err?.message || i18nT("Errore imprevisto.");
  }
  render();
}

/* ===== Wiring ===== */

function bindScope() {
  root.querySelectorAll("[data-scope]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.getAttribute("data-scope");
      if (next === state.scope) return;
      state.scope = next;
      void load();
    });
  });
}

/* ===== Init ===== */

initAuthGuard({
  requireAuth: false,
  onReady: (user) => {
    state.uid = user ? user.uid : null;
    void load();
  },
});
