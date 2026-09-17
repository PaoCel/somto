/**
 * quiz-prova.page.js — Guest quiz (teaser pubblico, NIENTE login).
 *
 * Funnel di acquisizione: chiunque (da ads/SEO) gioca un quiz su un titolo,
 * vede il risultato, e viene invitato a registrarsi per salvare XP, scalare la
 * classifica e sfidare gli amici. Server-authoritative:
 *   - getGuestQuiz  → domande SENZA risposta corretta
 *   - submitGuestQuiz → punteggio + correttezza + spiegazioni validati lato server
 * Nessuna scrittura utente e nessun XP per i guest; il server conserva solo
 * una sessione effimera deny-all per legare il submit alle domande emesse.
 */
import { ICONS, loadingState, errorState } from "../components/quizUI.js";
import { t as i18nT } from "../i18n/index.js";
import { escapeHtml } from "../utils/dom.js";
import { getGuestQuiz, submitGuestQuiz, fetchPlayableThemes, fetchPlayableSagas } from "../api/quiz.api.js";
import { logEvent } from "../analytics.js";
import { trackProductEvent } from "../api/productAnalytics.js";

const root = document.getElementById("quizProva");
const LETTERS = ["A", "B", "C", "D"];
const COUNT_OPTIONS = [3, 5, 10];

const state = {
  view: "init",          // init | picker | loading | playing | submitting | result | error
  errorMessage: "",
  themes: [],
  sagas: [],              // saghe giocabili (es. "Harry Potter"), da quizMeta/sagas
  search: "",
  count: 5,
  pickerNotice: "",       // avviso inline sopra il picker (es. saga da deep-link non trovata)
  // partita corrente
  titleId: null,
  sagaId: null,           // valorizzato solo quando si gioca una saga intera
  isSaga: false,
  title: "",
  sessionToken: "",
  questions: [],         // [{questionId, title, questionText, answers[4], ...}]
  index: 0,
  answers: [],           // [{questionId, chosenIndex}]
  result: null,          // { total, correct, results[] }
};

/* ===== utils ===== */
function normalizeSearch(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}
/**
 * Dove atterra chi si registra dal risultato: la partita "vera" (con XP e
 * classifica) sullo stesso titolo appena giocato, non l'hub. `state.titleId`
 * arriva sempre dal server — anche per il titolo a sorpresa e per le saghe,
 * dove è il titolo da cui è uscita la partita. `quiz-play.html` accetta solo
 * `titleId` e `count`: la saga in quanto tale non è ancora giocabile da
 * loggati, quindi si ripiega sul titolo.
 */
function signupNextPath() {
  if (!state.titleId) return "/quiz.html";
  const qs = new URLSearchParams({ titleId: state.titleId, count: String(state.count) });
  return `/quiz-play.html?${qs.toString()}`;
}

function signupHref() {
  return `/login.html?signup=1&next=${encodeURIComponent(signupNextPath())}`;
}

/**
 * Toglie dall'URL un parametro di deep-link (`titleId` / `saga`) senza
 * ricaricare. Serve dopo un avvio fallito: se il parametro resta, un refresh
 * (o il "Riprova" della schermata d'errore, che richiama `init()`) ritenta
 * all'infinito la stessa partita impossibile.
 */
function dropDeepLinkParam(name) {
  try {
    const url = new URL(location.href);
    if (!url.searchParams.has(name)) return;
    url.searchParams.delete(name);
    const qs = url.searchParams.toString();
    history.replaceState(null, "", `${url.pathname}${qs ? `?${qs}` : ""}${url.hash}`);
  } catch (_) { /* history non disponibile: il flusso non cambia */ }
}

/* ===== PICKER ===== */
function filteredThemes() {
  const q = normalizeSearch(state.search);
  if (!q) return state.themes;
  return state.themes.filter((t) => normalizeSearch(t.title).includes(q));
}

function filteredSagas() {
  const q = normalizeSearch(state.search);
  if (!q) return state.sagas;
  return state.sagas.filter((s) => normalizeSearch(s.name).includes(q));
}

function themeRowMarkup(t) {
  const icon = t.mediaType === "tv" ? ICONS.tv : ICONS.film;
  return `
    <button type="button" class="quiz-setup-theme" data-theme-id="${escapeHtml(t.titleId)}">
      <span class="quiz-setup-theme-icon">${icon}</span>
      <span class="quiz-setup-theme-meta">
        <span class="quiz-setup-theme-name">${escapeHtml(t.title)}</span>
        <span class="quiz-setup-theme-sub">${i18nT("{count} domande", { count: t.questionCount })}</span>
      </span>
      <span class="quiz-setup-theme-check"></span>
    </button>`;
}

/** Riga saga: stesso markup/classi delle righe titolo, sub-riga con conteggio film/serie + domande. */
function sagaRowMarkup(s) {
  const icon = s.mediaType === "tv" ? ICONS.tv : ICONS.filmStack;
  const sub = s.mediaType === "tv"
    ? i18nT("{titles} serie · {questions} domande", { titles: s.titleIds.length, questions: s.questionCount })
    : i18nT("{titles} film · {questions} domande", { titles: s.titleIds.length, questions: s.questionCount });
  return `
    <button type="button" class="quiz-setup-theme" data-saga-id="${escapeHtml(s.sagaId)}">
      <span class="quiz-setup-theme-icon">${icon}</span>
      <span class="quiz-setup-theme-meta">
        <span class="quiz-setup-theme-name">${escapeHtml(s.name)}</span>
        <span class="quiz-setup-theme-sub">${sub}</span>
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

function renderSagaRows() {
  return filteredSagas().map(sagaRowMarkup).join("");
}

/** Aggiorna le liste titoli/saghe sotto la ricerca in place, senza toccare l'input (perderebbe il focus). */
function refreshThemeList() {
  const themeList = document.getElementById("guestThemeList");
  if (themeList) themeList.innerHTML = renderThemeRows();

  const sagaSection = document.getElementById("guestSagaSection");
  const sagaList = document.getElementById("guestSagaList");
  if (sagaSection && sagaList) {
    sagaSection.classList.toggle("quiz-hidden", filteredSagas().length === 0);
    sagaList.innerHTML = renderSagaRows();
  }

  bindThemeRows();
  bindSagaRows();
}

function renderPicker() {
  root.innerHTML = `
    <div class="quiz-setup-page">
      <header class="quiz-guest-hero">
        <span class="quiz-guest-hero-badge">${ICONS.controller} Quiz Somto</span>
        <h1 class="quiz-guest-hero-title">${i18nT("Quanto conosci film e serie?")}</h1>
        <p class="quiz-guest-hero-sub">${i18nT("Gioca subito, senza registrarti. Scegli un titolo o lasciati sorprendere.")}</p>
      </header>

      ${state.pickerNotice ? `
      <div class="quiz-notice is-muted">
        ${ICONS.warn}
        <span class="desc">${escapeHtml(state.pickerNotice)}</span>
      </div>` : ""}

      <button type="button" class="quiz-pressable quiz-guest-cta-block" id="guestPlayRandom" aria-label="${i18nT("Gioca a caso")}">
        <div class="quiz-play-cta">
          <span class="quiz-play-cta-icon">${ICONS.play}</span>
          <div class="quiz-play-cta-copy">
            <div class="quiz-play-cta-title">${i18nT("Gioca ora")}</div>
            <div class="quiz-play-cta-subtitle">${i18nT("5 domande su un titolo a sorpresa")}</div>
          </div>
          <span class="quiz-play-cta-chevron">${ICONS.chevron || ""}</span>
        </div>
      </button>

      <section class="quiz-field${filteredSagas().length ? "" : " quiz-hidden"}" id="guestSagaSection">
        <div class="quiz-setup-theme-head">
          <span class="quiz-field-label">${i18nT("Saghe")}</span>
          ${state.sagas.length ? `<span class="quiz-setup-theme-count">${i18nT("{count} saghe", { count: state.sagas.length })}</span>` : ""}
        </div>
        <div class="quiz-setup-theme-list" id="guestSagaList">${renderSagaRows()}</div>
      </section>

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
        <div class="quiz-setup-theme-list" id="guestThemeList">${renderThemeRows()}</div>
      </section>
    </div>`;
  bindPicker();
}

function bindThemeRows() {
  root.querySelectorAll("[data-theme-id]").forEach((btn) => {
    btn.addEventListener("click", () => startGame({ titleId: btn.getAttribute("data-theme-id") }));
  });
}

function bindSagaRows() {
  root.querySelectorAll("[data-saga-id]").forEach((btn) => {
    btn.addEventListener("click", () => startGame({ sagaId: btn.getAttribute("data-saga-id") }));
  });
}

function bindPicker() {
  document.getElementById("guestPlayRandom")?.addEventListener("click", () => startGame({}));
  const s = document.getElementById("guestThemeSearch");
  if (s) s.addEventListener("input", () => { state.search = s.value; refreshThemeList(); });
  bindThemeRows();
  bindSagaRows();
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
          <span class="quiz-play-step">${i18nT("Domanda {current} di {total}", { current, total })}</span>
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
        <div class="quiz-guest-score-pct">${i18nT("{pct}% di risposte giuste", { pct })}</div>
        <div class="quiz-guest-score-verdict">${verdict}</div>
        <div class="quiz-guest-score-title">${ICONS.film}<span>${escapeHtml(state.title)}</span></div>
      </div>

      <div class="quiz-guest-conversion">
        <div class="quiz-guest-conversion-title">${ICONS.gift || ICONS.star} ${i18nT("Crea il tuo account gratis")}</div>
        <ul class="quiz-guest-conversion-list">
          <li>${ICONS.star} ${i18nT("Salva XP e punteggio")}</li>
          <li>${ICONS.trophy} ${i18nT("Scala la classifica settimanale")}</li>
          <li>${ICONS.people} ${i18nT("Sfida i tuoi amici sugli stessi titoli")}</li>
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
async function startGame({ titleId = null, sagaId = null } = {}) {
  resetGame();
  state.view = "loading";
  root.innerHTML = loadingState(i18nT("Preparo il quiz…"));
  try {
    const data = await getGuestQuiz({ titleId, sagaId, count: state.count });
    if (!data || !Array.isArray(data.questions) || !data.questions.length) {
      throw new Error(i18nT("Nessuna domanda disponibile per questo tema."));
    }
    state.titleId = data.titleId || null;
    state.sagaId = data.sagaId || null;
    state.isSaga = Boolean(data.isSaga);
    state.title = (state.isSaga && data.sagaName) ? data.sagaName : (data.title || "");
    state.sessionToken = data.sessionToken || "";
    state.questions = data.questions;
    state.index = 0;
    state.answers = [];
    state._selected = null;
    state.view = "playing";
    renderPlaying();
  } catch (err) {
    console.error("[quiz-prova] start error", err);
    if (sagaId || titleId) {
      // Saga o titolo (da deep-link o dal picker) non più giocabili: niente
      // vicolo cieco, si torna al picker con un avviso invece di un errore a
      // schermo intero senza via d'uscita (il "Riprova" lì sotto rifarebbe la
      // stessa chiamata fallita in loop, perché l'URL resta invariato).
      state.pickerNotice = err?.message
        || (sagaId ? i18nT("Saga non trovata.") : i18nT("Nessuna domanda disponibile per questo tema."));
      dropDeepLinkParam(sagaId ? "saga" : "titleId");
      await Promise.all([loadThemes(), loadSagas()]);
      state.view = "picker";
      renderPicker();
    } else {
      state.view = "error";
      state.errorMessage = err?.message || i18nT("Errore imprevisto.");
      renderError();
    }
  }
}

async function submitGame() {
  state.view = "submitting";
  root.innerHTML = loadingState(i18nT("Calcolo il punteggio…"));
  try {
    const data = await submitGuestQuiz(state.sessionToken, state.answers);
    state.result = data || { total: state.questions.length, correct: 0, results: [] };
    trackProductEvent("guest_quiz_played");
    void logEvent("guest_quiz_played", {
      title_id: state.titleId,
      saga_id: state.sagaId,
      is_saga: state.isSaga,
    });
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
  state.sagaId = null;
  state.isSaga = false;
  state.pickerNotice = "";
  state.title = "";
  state.sessionToken = "";
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

async function loadSagas() {
  try {
    state.sagas = await fetchPlayableSagas();
  } catch (err) {
    console.warn("[quiz-prova] sagas load failed", err);
    state.sagas = [];
  }
}

async function init() {
  const params = new URLSearchParams(location.search);
  const titleId = params.get("titleId");
  const sagaId = params.get("saga");
  const count = Number(params.get("count"));
  if (COUNT_OPTIONS.includes(count)) state.count = count;

  if (titleId) {
    // Deep-link da pagina titolo / ads: parte subito su quel titolo.
    void startGame({ titleId });
    // Carica temi e saghe in background per "Rigioca".
    void loadThemes();
    void loadSagas();
    return;
  }
  if (sagaId) {
    // Deep-link da campagna saga (es. video social "Quanto ne sai di Harry Potter?").
    void startGame({ sagaId });
    void loadThemes();
    void loadSagas();
    return;
  }
  state.view = "loading";
  root.innerHTML = loadingState(i18nT("Carico i quiz…"));
  await Promise.all([loadThemes(), loadSagas()]);
  state.view = "picker";
  renderPicker();
}

init();
