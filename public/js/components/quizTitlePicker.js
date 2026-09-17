/**
 * quizTitlePicker.js — Vetrina "titolo specifico" (web).
 * Mirror di QuizTitlePicker.swift: campo ricerca + griglia locandine dei titoli
 * con quiz. I titoli VISTI dal viewer compaiono per primi ("I tuoi titoli
 * visti con quiz"), poi tutto il resto del catalogo. La ricerca filtra l'intero
 * catalogo. Le locandine si caricano lazy da `titles` (placeholder colorato col
 * titolo finché arrivano).
 *
 * Riusato da quiz-setup.page.js (partita solo) e quiz-challenges.page.js (sfida
 * amico). Stateful: l'istanza sopravvive ai re-render del genitore, basta
 * richiamare `.bind(parentEl)` dopo ogni innerHTML del genitore.
 *
 * Con `includeSagas: true` in cima compare la sezione "Saghe" (da
 * `quizMeta/sagas`, stesse righe di quiz-prova): una saga è un gruppo curato di
 * titleIds, quindi la selezione è alternativa a quella del titolo singolo. Le
 * saghe restano spente di default perché la partita solo (`quiz-play`) accetta
 * un solo `titleId`: oggi solo le sfide sanno giocare un pool di titoli.
 *
 * Uso:
 *   const picker = createTitlePicker({ seenIds, onChange: (sel) => {...} });
 *   parent.innerHTML = `... ${picker.html()} ...`;
 *   picker.bind(parent);
 *   void picker.loadData();          // idempotente
 *   picker.selectedTitleId;          // string | null
 *   picker.getSelection();           // null | { kind, name, titleIds, ... }
 */

import { escapeHtml } from "../utils/dom.js";
import { t as i18nT } from "../i18n/index.js";
import { ICONS } from "./quizUI.js";
import { fetchPlayableThemes, fetchPlayableSagas } from "../api/quiz.api.js";
import { getTitlesByIds } from "../api/titles.api.js";

function normalize(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

export function createTitlePicker({ seenIds = new Set(), includeSagas = false, onChange = () => {} } = {}) {
  const state = {
    status: "idle",      // idle | loading | ready | error
    themes: [],          // [{ titleId, title, mediaType, questionCount }]
    sagas: [],           // [{ sagaId, name, mediaType, titleIds, questionCount }]
    posters: new Map(),  // titleId -> url
    query: "",
    selectedTitleId: null,
    selectedSagaId: null,
  };
  let rootEl = null;     // .quiz-title-picker corrente
  let didLoad = false;

  const seenThemes = () => state.themes.filter((t) => seenIds.has(t.titleId));
  const otherThemes = () => state.themes.filter((t) => !seenIds.has(t.titleId));
  function filteredThemes() {
    const q = normalize(state.query);
    if (!q) return [];
    return state.themes.filter((t) => normalize(t.title).includes(q));
  }
  function filteredSagas() {
    if (!includeSagas) return [];
    const q = normalize(state.query);
    if (!q) return state.sagas;
    return state.sagas.filter((s) => normalize(s.name).includes(q));
  }

  /** Selezione corrente, titolo o saga, nella forma che serve a chi crea la sfida. */
  function getSelection() {
    if (state.selectedSagaId) {
      const saga = state.sagas.find((s) => s.sagaId === state.selectedSagaId);
      if (saga) {
        return {
          kind: "saga",
          sagaId: saga.sagaId,
          name: saga.name,
          titleIds: saga.titleIds.slice(),
        };
      }
    }
    if (state.selectedTitleId) {
      const theme = state.themes.find((t) => t.titleId === state.selectedTitleId);
      return {
        kind: "title",
        titleId: state.selectedTitleId,
        name: theme?.title || "",
        titleIds: [state.selectedTitleId],
      };
    }
    return null;
  }

  function emitChange() {
    try { onChange(getSelection()); } catch (_) { /* noop */ }
  }

  /* ===== Markup ===== */

  function posterCell(theme) {
    const url = state.posters.get(theme.titleId);
    const selected = state.selectedTitleId === theme.titleId;
    const mediaLabel = theme.mediaType === "tv" ? i18nT("Serie TV") : i18nT("Film");
    const glyph = theme.mediaType === "tv" ? ICONS.tv : ICONS.film;
    const art = url
      ? `<img src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async">`
      : `<span class="quiz-poster-plate" data-plate="${Math.abs(hashCode(theme.titleId)) % 6}">${glyph}<span>${escapeHtml(theme.title)}</span></span>`;
    return `
      <button type="button" class="quiz-poster-cell${selected ? " is-selected" : ""}"
        data-pick-id="${escapeHtml(theme.titleId)}" aria-pressed="${selected}"
        aria-label="${escapeHtml(theme.title)}. ${mediaLabel}.${selected ? ` ${i18nT("Selezionato")}.` : ""}">
        <span class="quiz-poster-art">
          ${art}
          ${selected ? `<span class="quiz-poster-check">${ICONS.checkCircle}</span>` : ""}
        </span>
        <span class="quiz-poster-name">${escapeHtml(theme.title)}</span>
      </button>`;
  }

  const grid = (themes) => `<div class="quiz-poster-grid">${themes.map(posterCell).join("")}</div>`;

  /** Riga saga: stesso markup delle righe tema di quiz-prova, più lo stato selezionato. */
  function sagaRow(saga) {
    const selected = state.selectedSagaId === saga.sagaId;
    const icon = saga.mediaType === "tv" ? ICONS.tv : ICONS.filmStack;
    const sub = saga.mediaType === "tv"
      ? i18nT("{titles} serie · {questions} domande", { titles: saga.titleIds.length, questions: saga.questionCount })
      : i18nT("{titles} film · {questions} domande", { titles: saga.titleIds.length, questions: saga.questionCount });
    return `
      <button type="button" class="quiz-setup-theme${selected ? " is-selected" : ""}"
        data-pick-saga="${escapeHtml(saga.sagaId)}" aria-pressed="${selected}">
        <span class="quiz-setup-theme-icon">${icon}</span>
        <span class="quiz-setup-theme-meta">
          <span class="quiz-setup-theme-name">${escapeHtml(saga.name)}</span>
          <span class="quiz-setup-theme-sub">${sub}</span>
        </span>
        <span class="quiz-setup-theme-check${selected ? " is-on" : ""}">${ICONS.checkCircle}</span>
      </button>`;
  }

  function sagaSectionHTML() {
    const list = filteredSagas();
    if (!list.length) return "";
    return `
      <div class="quiz-picker-shelf-title">${i18nT("Saghe")}</div>
      <div class="quiz-setup-theme-list">${list.map(sagaRow).join("")}</div>`;
  }

  function bodyHTML() {
    if (state.status === "loading" || state.status === "idle") {
      return `<div class="quiz-picker-status">${ICONS.popcorn || ""}<span>${i18nT("Carico i titoli")}</span></div>`;
    }
    if (state.status === "error") {
      return `<div class="quiz-picker-status is-error">${ICONS.wifiOff || ""}<span>${i18nT("Impossibile caricare i titoli")}</span><button type="button" class="btn ghost" data-pick-retry>${i18nT("Riprova")}</button></div>`;
    }
    const sagas = sagaSectionHTML();
    if (state.query.trim()) {
      const list = filteredThemes();
      if (!list.length) {
        if (sagas) return sagas;
        return `<div class="quiz-picker-empty">${ICONS.qmark || ""}<div><strong>${i18nT("Nessun titolo trovato per “{query}”.", { query: escapeHtml(state.query) })}</strong><span>${i18nT("Prova un altro titolo, oppure gioca in modalità casuale.")}</span></div></div>`;
      }
      return `${sagas}${grid(list)}`;
    }
    const seen = seenThemes();
    const others = otherThemes();
    let html = sagas;
    if (seen.length) html += `<div class="quiz-picker-shelf-title">${i18nT("I tuoi titoli visti con quiz")}</div>${grid(seen)}`;
    if (others.length) html += `<div class="quiz-picker-shelf-title">${seen.length ? i18nT("Altri titoli con quiz") : i18nT("Titoli con quiz")}</div>${grid(others)}`;
    html += `<div class="quiz-picker-hint">${ICONS.bulb || ""}<span>${i18nT("Cerca qualunque titolo: se ha un quiz, parte la partita.")}</span></div>`;
    return html;
  }

  function html() {
    return `
      <div class="quiz-title-picker">
        <div class="quiz-setup-search">
          ${ICONS.search || ""}
          <input type="search" inputmode="search" autocomplete="off" data-pick-search
            placeholder="${i18nT("Cerca un film o una serie…")}" value="${escapeHtml(state.query)}" aria-label="${i18nT("Cerca un titolo")}">
        </div>
        <div class="quiz-picker-body" data-pick-body>${bodyHTML()}</div>
      </div>`;
  }

  /* ===== DOM wiring ===== */

  function refreshBody() {
    if (!rootEl || !rootEl.isConnected) return;
    const body = rootEl.querySelector("[data-pick-body]");
    if (!body) return;
    body.innerHTML = bodyHTML();
    bindCells();
  }

  function bindCells() {
    if (!rootEl) return;
    rootEl.querySelectorAll("[data-pick-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.selectedTitleId = btn.getAttribute("data-pick-id");
        state.selectedSagaId = null;
        emitChange();
        refreshBody();
      });
    });
    rootEl.querySelectorAll("[data-pick-saga]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.selectedSagaId = btn.getAttribute("data-pick-saga");
        state.selectedTitleId = null;
        emitChange();
        refreshBody();
      });
    });
    rootEl.querySelector("[data-pick-retry]")?.addEventListener("click", () => { void loadData(true); });
  }

  function bind(parentEl) {
    rootEl = (parentEl?.querySelector?.(".quiz-title-picker")) || parentEl;
    if (!rootEl) return;
    const search = rootEl.querySelector("[data-pick-search]");
    if (search) {
      search.addEventListener("input", () => {
        state.query = search.value;
        refreshBody();
        void ensurePosters(filteredThemes().map((t) => t.titleId));
      });
    }
    bindCells();
  }

  /* ===== Dati ===== */

  async function ensurePosters(ids) {
    const missing = ids.filter((id) => !state.posters.has(id));
    if (!missing.length) return;
    try {
      const map = await getTitlesByIds(missing);
      let changed = false;
      map.forEach((t, id) => {
        const url = t?.posterPath || t?.backdropPath;
        if (url) { state.posters.set(id, url); changed = true; }
      });
      if (changed) refreshBody();
    } catch (_) { /* posters are best-effort */ }
  }

  async function loadData(force = false) {
    if (didLoad && !force && state.status === "ready") return;
    didLoad = true;
    state.status = "loading";
    refreshBody();
    try {
      // Le saghe sono best-effort: se l'aggregato non c'è il picker resta
      // quello di sempre invece di andare in errore.
      const [themes, sagas] = await Promise.all([
        fetchPlayableThemes(),
        includeSagas ? fetchPlayableSagas().catch(() => []) : Promise.resolve([]),
      ]);
      state.themes = themes;
      state.sagas = sagas;
      state.status = "ready";
      refreshBody();
      await ensurePosters(seenThemes().map((t) => t.titleId));
      void ensurePosters(otherThemes().map((t) => t.titleId));
    } catch (err) {
      console.error("[quizTitlePicker] loadData error", err);
      state.status = "error";
      didLoad = false;
      refreshBody();
    }
  }

  return {
    html,
    bind,
    loadData,
    get selectedTitleId() { return state.selectedTitleId; },
    set selectedTitleId(v) { state.selectedTitleId = v || null; },
    get selectedSagaId() { return state.selectedSagaId; },
    getSelection,
    getTheme(id) { return state.themes.find((t) => t.titleId === id) || null; },
    get isReady() { return state.status === "ready"; },
  };
}

/** Stable-ish hash per scegliere il colore del placeholder locandina. */
function hashCode(str) {
  let h = 0;
  const s = String(str || "");
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h;
}
