/**
 * quiz-setup.page.js — Setup partita solo (web).
 * Fork prima di giocare: CASUALE (domande a sorpresa dall'archivio) oppure
 * TITOLO SPECIFICO (vetrina con ricerca: scegli un film/serie con quiz). Poi il
 * numero domande (3 / 5 / 10) → /quiz-play.html?titleId=<id>&count=<n>
 * ("Casuale" → solo ?count=<n>). Mirror di QuizGameSetupView.swift.
 * Stato loggato richiesto; senza login → redirect a /login.html?next=.
 */

import { initAuthGuard } from "../components/authGuard.js";
import { t as i18nT } from "../i18n/index.js";
import { ICONS } from "../components/quizUI.js";
import { createTitlePicker } from "../components/quizTitlePicker.js";
import { listCompletedTitleIDs } from "../api/titleStates.api.js";

const root = document.getElementById("quizSetup");

// Numero domande selezionabile (deve combaciare con ALLOWED_COUNTS in quiz-play.page.js).
const COUNT_OPTIONS = [3, 5, 10];

const state = {
  uid: null,
  mode: "random",        // random | specific
  count: 5,
  seenIds: new Set(),
  picker: null,          // createTitlePicker(...)
};

/* ===== Render ===== */

function renderHeader() {
  return `
    <header class="quiz-setup-header">
      <a class="quiz-setup-back" href="/quiz.html" aria-label="Torna al Quiz">${ICONS.back}</a>
      <div class="quiz-setup-headcopy">
        <h1 class="quiz-setup-title">${i18nT("Nuova partita")}</h1>
        <p class="quiz-setup-subtitle">${i18nT("Casuale o su un titolo che scegli tu.")}</p>
      </div>
    </header>`;
}

function renderModeSection() {
  const opts = [
    { key: "random", label: i18nT("Casuale") },
    { key: "specific", label: i18nT("Titolo specifico") },
  ];
  return `
    <section class="quiz-field">
      <span class="quiz-field-label">${i18nT("Come vuoi giocare?")}</span>
      <div class="quiz-segmented" role="group" aria-label="${i18nT("Modalità di gioco")}">
        ${opts.map((o) => `
          <button type="button" data-mode="${o.key}"
            class="${state.mode === o.key ? "is-active" : ""}"
            aria-pressed="${state.mode === o.key}">${o.label}</button>`).join("")}
      </div>
    </section>`;
}

function renderRandomCard() {
  return `
    <div class="quiz-composer-card">
      <span class="icon is-pink">${ICONS.shuffle}</span>
      <div class="copy">
        <div class="title">${i18nT("Tema a sorpresa")}</div>
        <div class="desc">${i18nT("Le domande arrivano a caso dall'intero archivio di film e serie.")}</div>
      </div>
    </div>`;
}

function renderSpecificSection() {
  return `<section class="quiz-field">${state.picker ? state.picker.html() : ""}</section>`;
}

function renderCountSection() {
  return `
    <section class="quiz-field">
      <span class="quiz-field-label">${i18nT("Numero domande")}</span>
      <div class="quiz-segmented" role="group" aria-label="${i18nT("Numero domande")}">
        ${COUNT_OPTIONS.map((n) => `
          <button type="button" data-count="${n}"
            class="${state.count === n ? "is-active" : ""}"
            aria-pressed="${state.count === n}">${n}</button>`).join("")}
      </div>
    </section>`;
}

function canStart() {
  return state.mode === "random" || !!state.picker?.selectedTitleId;
}

function startLabelHTML() {
  if (state.mode === "specific" && !state.picker?.selectedTitleId) {
    return `${ICONS.filmStack}<span>${i18nT("Scegli un titolo")}</span>`;
  }
  if (state.mode === "specific") {
    const theme = state.picker?.getTheme(state.picker.selectedTitleId);
    return `${ICONS.play}<span>Gioca su ${escapeText(theme?.title || "")}</span>`;
  }
  return `${ICONS.play}<span>${i18nT("Inizia partita")}</span>`;
}

function escapeText(s) {
  const d = document.createElement("div");
  d.textContent = String(s || "");
  return d.innerHTML;
}

function renderStartBar() {
  return `
    <div class="quiz-actionbar">
      <div class="quiz-actionbar-inner">
        <button type="button" class="btn primary full" id="quizSetupStart" ${canStart() ? "" : "disabled"}>
          ${startLabelHTML()}
        </button>
      </div>
    </div>`;
}

function render() {
  root.innerHTML = `
    <div class="quiz-setup-page">
      ${renderHeader()}
      ${renderModeSection()}
      ${state.mode === "random" ? renderRandomCard() : renderSpecificSection()}
      ${renderCountSection()}
    </div>
    ${renderStartBar()}`;
  bindBody();
}

/* ===== Wiring ===== */

function refreshCountButtons() {
  root.querySelectorAll("[data-count]").forEach((b) => {
    const on = Number(b.getAttribute("data-count")) === state.count;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-pressed", String(on));
  });
}

/** Aggiorna SOLO la start bar (label + disabled) senza re-render globale,
 *  così la selezione di una locandina non resetta la ricerca. */
function refreshStartBar() {
  const btn = document.getElementById("quizSetupStart");
  if (!btn) return;
  btn.disabled = !canStart();
  btn.innerHTML = startLabelHTML();
}

function onPickTitle() {
  refreshStartBar();
}

function bindBody() {
  root.querySelectorAll("[data-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.getAttribute("data-mode");
      if (next === state.mode) return;
      state.mode = next;
      render();
    });
  });
  root.querySelectorAll("[data-count]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.count = Number(btn.getAttribute("data-count"));
      refreshCountButtons();
    });
  });
  document.getElementById("quizSetupStart")?.addEventListener("click", startGame);

  if (state.mode === "specific" && state.picker) {
    state.picker.bind(root);
    void state.picker.loadData();
  }
}

function startGame() {
  if (!canStart()) return;
  const qs = new URLSearchParams();
  if (state.mode === "specific" && state.picker?.selectedTitleId) {
    qs.set("titleId", state.picker.selectedTitleId);
  }
  qs.set("count", String(state.count));
  window.location.href = `/quiz-play.html?${qs.toString()}`;
}

/* ===== Init ===== */

async function init() {
  state.picker = createTitlePicker({ seenIds: state.seenIds, onChange: onPickTitle });
  render();
  try {
    const seen = await listCompletedTitleIDs(state.uid);
    seen.forEach((id) => state.seenIds.add(id));
  } catch (_) { /* vetrina funziona anche senza i visti */ }
}

initAuthGuard({
  requireAuth: true,
  onReady: (user) => {
    if (!user) return;
    state.uid = user.uid;
    void init();
  },
});
