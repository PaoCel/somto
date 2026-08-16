/**
 * quiz-prova.page.js — Guest quiz (teaser pubblico, NIENTE login).
 *
 * Funnel di acquisizione: chiunque (da ads/SEO) gioca un quiz su un titolo,
 * vede il risultato, e viene invitato a registrarsi per salvare XP, scalare la
 * classifica e sfidare gli amici. Server-authoritative:
 *   - getGuestQuiz  → domande SENZA risposta corretta
 *   - submitGuestQuiz → punteggio + correttezza + spiegazioni validati lato server
 * Nessuna scrittura Firestore, nessun XP per i guest (è la leva di conversione).
 */
import { ICONS, loadingState, errorState } from "../components/quizUI.js";
import { t as i18nT } from "../i18n/index.js";
import { escapeHtml } from "../utils/dom.js";
import { getGuestQuiz, submitGuestQuiz, fetchPlayableThemes } from "../api/quiz.api.js";
import { logEvent } from "../analytics.js";
import { trackProductEvent } from "../api/productAnalytics.js";

const root = document.getElementById("quizProva");
const LETTERS = ["A", "B", "C", "D"];
const COUNT_OPTIONS = [3, 5, 10];

const state = {
  view: "init",          // init | picker | loading | playing | submitting | result | error
  errorMessage: "",
  themes: [],
  search: "",
  count: 5,
  // partita corrente
  titleId: null,
  title: "",
  questions: [],         // [{questionId, title, questionText, answers[4], ...}]
  index: 0,
  answers: [],           // [{questionId, chosenIndex}]
  result: null,          // { total, correct, results[] }
};

/* ===== utils ===== */
function normalizeSearch(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}
function signupHref() {
  return "/login.html?signup=1&next=%2Fquiz.html";
}

/* ===== PICKER ===== */
function filteredThemes() {
  const q = normalizeSearch(state.search);
  if (!q) return state.themes;
  return state.themes.filter((t) => normalizeSearch(t.title).includes(q));
}

function themeRowMarkup(t) {
  const icon = t.mediaType === "tv" ? ICONS.tv : ICONS.film;
  return `
    <button type="button" class="quiz-setup-theme" data-theme-id="${escapeHtml(t.titleId)}">
      <span class="quiz-setup-theme-icon">${icon}</span>
      <span class="quiz-setup-theme-meta">
        <span class="quiz-setup-theme-name">${escapeHtml(t.title)}</span>
        <span class="quiz-setup-theme-sub">${t.questionCount} domande</span>
      </span>
      <span class="quiz-setup-theme-check"></span>
    </button>`;
}

function renderThemeRows() {
  const list = filteredThemes();
  if (!list.length) {
    if (normalizeSearch(state.search)) {
      return `<div class="quiz-setup-theme-empty">${i18nT("Nessun titolo trovato per “{query}”.", { query: escapeHtml(state.search) })}</div>`;
    }
    return `<div class="quiz-setup-theme-empty">${i18nT("Tocca “Gioca ora” per iniziare.")}</div>`;
  }
  return list.map(themeRowMarkup).join("");
}

function refreshThemeList() {
  const el = root.querySelector(".quiz-setup-theme-list");
  if (!el) return;
  el.innerHTML = renderThemeRows();
  bindThemeRows();
}

function renderPicker() {
  root.innerHTML = `
    <div class="quiz-setup-page">
      <header class="quiz-guest-hero">
        <span class="quiz-guest-hero-badge">${ICONS.controller} Quiz Somto</span>
        <h1 class="quiz-guest-hero-title">${i18nT("Quanto conosci film e serie?")}</h1>
        <p class="quiz-guest-hero-sub">${i18nT("Gioca subito, senza registrarti. Scegli un titolo o lasciati sorprendere.")}</p>
      </header>

      <button type="button" class="quiz-pressable quiz-guest-cta-block" id="guestPlayRandom" aria-label="Gioca a caso">
        <div class="quiz-play-cta">
          <span class="quiz-play-cta-icon">${ICONS.play}</span>
          <div class="quiz-play-cta-copy">
            <div class="quiz-play-cta-title">${i18nT("Gioca ora")}</div>
            <div class="quiz-play-cta-subtitle">${i18nT("5 domande su un titolo a sorpresa")}</div>
          </div>
          <span class="quiz-play-cta-chevron">${ICONS.chevron || ""}</span>
        </div>
      </button>

      <section class="quiz-field">
        <div class="quiz-setup-theme-head">
          <span class="quiz-field-label">${i18nT("…oppure scegli un titolo")}</span>
          ${state.themes.length ? `<span class="quiz-setup-theme-count">${i18nT("{count} titoli", { count: state.themes.length })}</span>` : ""}
        </div>
        <div class="quiz-setup-search">
          ${ICONS.search || ""}
          <input id="guestThemeSearch" type="search" inputmode="search" autocomplete="off"
            placeholder="${i18nT("Cerca un titolo (es. One Piece, Trono di Spade…)")}"
            value="${escapeHtml(state.search)}" aria-label="${i18nT("Cerca un titolo")}">
        </div>
        <div class="quiz-setup-theme-list">${renderThemeRows()}</div>
      </section>
    </div>`;
  bindPicker();
}

function bindThemeRows() {
  root.querySelectorAll("[data-theme-id]").forEach((btn) => {
    btn.addEventListener("click", () => startGame(btn.getAttribute("data-theme-id")));
  });
}

function bindPicker() {
  document.getElementById("guestPlayRandom")?.addEventListener("click", () => startGame(null));
  const s = document.getElementById("guestThemeSearch");
  if (s) s.addEventListener("input", () => { state.search = s.value; refreshThemeList(); });
  bindThemeRows();
}

/* ===== PLAY ===== */
function currentQuestion() {
  return state.questions[state.index] || null;
}

function renderPlaying() {
  const q = currentQuestion();
  if (!q) return;
  const total = state.questions.length;
  const current = state.index + 1;
  const filled = state.index / Math.max(total, 1);
  const selected = state._selected;
  const answersHtml = q.answers.map((a, idx) => {
    const cls = ["quiz-answer"];
    let mark = "";
    if (selected === idx) { cls.push("is-selected"); mark = `<span class="quiz-answer-mark">${ICONS.checkCircle}</span>`; }
    return `
      <button type="button" class="${cls.join(" ")}" data-answer="${idx}">
        <span class="quiz-answer-letter">${LETTERS[idx] || "?"}</span>
        <span class="quiz-answer-text">${escapeHtml(a)}</span>
        ${mark}
      </button>`;
  }).join("");

  root.innerHTML = `
    <div class="quiz-play-page">
      <div class="quiz-play-progresshead">
        <div class="row">
          <span class="quiz-play-step">Domanda ${current} di ${total}</span>
        </div>
        <div class="quiz-progress"><div class="quiz-progress-fill${filled <= 0 ? " is-zero" : ""}" style="width:${filled * 100}%"></div></div>
      </div>
      <div class="quiz-question-card">
        <span class="quiz-question-reel">${ICONS.filmStack || ICONS.film}</span>
        <div class="quiz-question-body">
          <span class="quiz-title-chip">${ICONS.film}<span>${escapeHtml(q.title)}</span></span>
          <div class="quiz-question-text">${escapeHtml(q.questionText)}</div>
        </div>
      </div>
      <div class="quiz-answers">${answersHtml}</div>
    </div>
    <div class="quiz-actionbar">
      <div class="quiz-actionbar-inner">
        <button type="button" class="btn ghost quiz-skip-btn" id="guestSkip">${i18nT("Salta")}</button>
        <button type="button" class="btn primary" id="guestConfirm" ${selected == null ? "disabled" : ""}>
          ${current >= total ? i18nT("Vedi risultato") : i18nT("Conferma")}
        </button>
      </div>
    </div>`;

  root.querySelectorAll("[data-answer]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state._selected = Number(btn.getAttribute("data-answer"));
      renderPlaying();
    });
  });
  document.getElementById("guestSkip")?.addEventListener("click", () => advance(-1));
  document.getElementById("guestConfirm")?.addEventListener("click", () => {
    if (state._selected == null) return;
    advance(state._selected);
  });
}

function advance(chosenIndex) {
  const q = currentQuestion();
  if (q) state.answers.push({ questionId: q.questionId, chosenIndex });
  state._selected = null;
  state.index += 1;
  if (state.index >= state.questions.length) {
    void submitGame();
  } else {
    renderPlaying();
  }
}

/* ===== RESULT ===== */

/** Riga "brag" del catalogo, dinamica dai temi caricati (niente numeri stantii). */
function catalogBragLine() {
  const titlesN = state.themes?.length || 0;
  const qN = (state.themes || []).reduce((s, t) => s + (Number(t.questionCount) || 0), 0);
  if (titlesN >= 10 && qN >= 100) {
    const qRounded = Math.floor(qN / 100) * 100;
    return i18nT("Oltre {questions} domande su {titles} film e serie", { questions: qRounded, titles: titlesN });
  }
  return i18nT("Migliaia di domande su film e serie");
}

function renderResult() {
  const r = state.result;
  const total = r.total || state.questions.length;
  const correct = r.correct || 0;
  const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
  let verdict;
  if (pct >= 80) verdict = i18nT("Sei un vero esperto! 🏆");
  else if (pct >= 50) verdict = i18nT("Niente male! Puoi fare di meglio 💪");
  else verdict = i18nT("C’è da allenarsi… rigioca! 🎬");

  const byId = new Map((r.results || []).map((x) => [x.questionId, x]));
  const review = state.questions.map((q, i) => {
    const res = byId.get(q.questionId) || {};
    const chosen = state.answers.find((a) => a.questionId === q.questionId);
    const chosenIdx = chosen ? chosen.chosenIndex : -1;
    const ok = !!res.isCorrect;
    const correctIdx = Number.isInteger(res.correctIndex) ? res.correctIndex : -1;
    const yourAns = chosenIdx >= 0 ? `${LETTERS[chosenIdx]}. ${escapeHtml(q.answers[chosenIdx] || "")}` : i18nT("Saltata");
    const rightAns = correctIdx >= 0 ? `${LETTERS[correctIdx]}. ${escapeHtml(q.answers[correctIdx] || "")}` : "";
    return `
      <div class="quiz-guest-review-item ${ok ? "is-ok" : "is-ko"}">
        <div class="quiz-guest-review-q">${i + 1}. ${escapeHtml(q.questionText)}</div>
        <div class="quiz-guest-review-a ${ok ? "ok" : "ko"}">${ok ? ICONS.checkCircle : ICONS.xCircle}<span>${yourAns}</span></div>
        ${!ok && rightAns ? `<div class="quiz-guest-review-right">${ICONS.checkCircle}<span>${rightAns}</span></div>` : ""}
        ${res.explanation ? `<div class="quiz-guest-review-exp">${escapeHtml(res.explanation)}</div>` : ""}
      </div>`;
  }).join("");

  root.innerHTML = `
    <div class="quiz-guest-result">
      <div class="quiz-guest-scorecard">
        <div class="quiz-guest-score-big">${correct}<span>/${total}</span></div>
        <div class="quiz-guest-score-pct">${pct}% di risposte giuste</div>
        <div class="quiz-guest-score-verdict">${verdict}</div>
        <div class="quiz-guest-score-title">${ICONS.film}<span>${escapeHtml(state.title)}</span></div>
      </div>

      <div class="quiz-guest-conversion">
        <div class="quiz-guest-conversion-title">${ICONS.gift || ICONS.star} Crea il tuo account gratis</div>
        <ul class="quiz-guest-conversion-list">
          <li>${ICONS.star} Salva XP e punteggio</li>
          <li>${ICONS.trophy} Scala la classifica settimanale</li>
          <li>${ICONS.people} Sfida i tuoi amici sugli stessi titoli</li>
          <li>${ICONS.controller} ${catalogBragLine()}</li>
        </ul>
        <a class="btn primary full" href="${signupHref()}">${i18nT("Registrati e salva i progressi")}</a>
      </div>

      <div class="quiz-guest-actions">
        <button type="button" class="btn ghost full" id="guestReplay">${i18nT("Rigioca con un altro titolo")}</button>
      </div>

      <details class="quiz-guest-review">
        <summary>${i18nT("Rivedi le risposte")}</summary>
        <div class="quiz-guest-review-list">${review}</div>
      </details>
    </div>`;

  document.getElementById("guestReplay")?.addEventListener("click", () => { resetGame(); renderPicker(); });
}

/* ===== flow ===== */
async function startGame(titleId) {
  resetGame();
  state.view = "loading";
  root.innerHTML = loadingState(i18nT("Preparo il quiz…"));
  try {
    const data = await getGuestQuiz({ titleId, count: state.count });
    if (!data || !Array.isArray(data.questions) || !data.questions.length) {
      throw new Error(i18nT("Nessuna domanda disponibile per questo tema."));
    }
    state.titleId = data.titleId;
    state.title = data.title || "";
    state.questions = data.questions;
    state.index = 0;
    state.answers = [];
    state._selected = null;
    state.view = "playing";
    renderPlaying();
  } catch (err) {
    console.error("[quiz-prova] start error", err);
    state.view = "error";
    state.errorMessage = err?.message || i18nT("Errore imprevisto.");
    renderError();
  }
}

async function submitGame() {
  state.view = "submitting";
  root.innerHTML = loadingState(i18nT("Calcolo il punteggio…"));
  try {
    const data = await submitGuestQuiz(state.answers);
    state.result = data || { total: state.questions.length, correct: 0, results: [] };
    trackProductEvent("guest_quiz_played");
    void logEvent("guest_quiz_played", { title_id: state.titleId });
    state.view = "result";
    renderResult();
    window.scrollTo(0, 0);
  } catch (err) {
    console.error("[quiz-prova] submit error", err);
    state.view = "error";
    state.errorMessage = err?.message || i18nT("Errore nel calcolo del punteggio.");
    renderError();
  }
}

function renderError() {
  root.innerHTML = errorState({ title: i18nT("Qualcosa è andato storto"), message: state.errorMessage });
  const retry = document.getElementById("quizRetry");
  if (retry) retry.addEventListener("click", () => { resetGame(); init(); });
}

function resetGame() {
  state.titleId = null;
  state.title = "";
  state.questions = [];
  state.index = 0;
  state.answers = [];
  state._selected = null;
  state.result = null;
}

async function loadThemes() {
  try {
    state.themes = await fetchPlayableThemes();
  } catch (err) {
    console.warn("[quiz-prova] themes load failed", err);
    state.themes = [];
  }
}

async function init() {
  const params = new URLSearchParams(location.search);
  const titleId = params.get("titleId");
  const count = Number(params.get("count"));
  if (COUNT_OPTIONS.includes(count)) state.count = count;

  if (titleId) {
    // Deep-link da pagina titolo / ads: parte subito su quel titolo.
    void startGame(titleId);
    // Carica i temi in background per "Rigioca".
    void loadThemes();
    return;
  }
  state.view = "loading";
  root.innerHTML = loadingState("Carico i quiz…");
  await loadThemes();
  state.view = "picker";
  renderPicker();
}

init();
