/**
 * quiz-invite.page.js — Onboarding invito esterno "Prima di iniziare" (web).
 * Replica QuizInviteOnboardingView.swift.
 *
 * Flusso deep link /quiz/invite/{token} (la landing è gestita da una Cloud
 * Function; la pagina web è quiz-invite.html con ?token=<token>):
 *  - utente loggato  → claimExternalInvite(token), poi onboarding titoli;
 *  - utente NON loggato → redirect a /login.html?next=<url completo con token>
 *    così dopo il login torna qui e il claim parte.
 * Se la sfida claimata è già finalizzata si va dritti al player.
 */

import { onAuth } from "../services/auth.service.js";
import { t as i18nT } from "../i18n/index.js";
import { escapeHtml } from "../utils/dom.js";
import {
  ICONS, statusPill, loadingState, errorState,
} from "../components/quizUI.js";
import {
  claimExternalInvite, finalizeExternalChallenge, fetchChallenge,
} from "../api/quiz.api.js";
import { listTitlesByIds, searchTitlesSmart } from "../api/titles.api.js";

const root = document.getElementById("quizInvite");
const splash = document.getElementById("appSplash");

// Token: ?token= query param. Tolleriamo anche /quiz/invite/{token} se il
// rewrite lasciasse la pagina con quel path.
function readToken() {
  const fromQuery = new URLSearchParams(location.search).get("token");
  if (fromQuery) return fromQuery.trim();
  const m = String(location.pathname || "").match(/\/quiz\/invite\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).trim() : "";
}

const token = readToken();

const state = {
  uid: null,
  phase: "loading",        // loading | claiming | picking | finalizing | needMore | error | ready
  errorMessage: "",
  availableQuestions: 0,
  claim: null,             // { challengeId, inviterDisplayName, inviterSeenTitleIds, numQuestions }
  readyChallengeId: null,
  inviterTitles: [],
  addedTitles: [],
  selectedIds: new Set(),
  searchQuery: "",
  searchResults: [],
  isSearching: false,
  searchTimer: null,
  searchSeq: 0,
};

function hideSplash() {
  if (splash) splash.hidden = true;
}

/* ===== Helpers titoli ===== */

function titlePoster(title) {
  // I documenti title hanno posterPath o poster_path; URL TMDB se relativo.
  const raw = title.posterPath || title.poster_path || title.poster || "";
  if (!raw) return "";
  if (/^https?:/i.test(raw)) return raw;
  const base = window.tmdbConfig?.imageBaseUrl || "https://image.tmdb.org/t/p";
  return `${base}/w185${raw}`;
}
function titleName(title) {
  return title.name || title.title || "Titolo";
}
function titleSubtitle(title) {
  const type = (title.type || title.mediaType) === "tv" ? i18nT("Serie") : i18nT("Film");
  const year = title.year || (title.releaseDate || "").slice(0, 4);
  return year ? `${type} · ${year}` : type;
}

/** Titoli offerti = inviter + aggiunti, de-duplicati. */
function allOfferedTitles() {
  const seen = new Set();
  const out = [];
  for (const t of [...state.inviterTitles, ...state.addedTitles]) {
    if (!seen.has(t.id)) { seen.add(t.id); out.push(t); }
  }
  return out;
}
function meetsMinimum() {
  return state.selectedIds.size >= 2;
}

/* ===== Render: stati ===== */

function renderIntro() {
  const claim = state.claim;
  return `
    <div class="quiz-invite-intro quiz-glow-card glow-soft">
      <div class="quiz-invite-intro-head">
        <span class="quiz-invite-intro-icon">${ICONS.popcorn}</span>
        <div>
          <div class="quiz-invite-intro-title">${escapeHtml(claim.inviterDisplayName)} ti ha sfidato</div>
          <div class="quiz-invite-intro-meta">${claim.numQuestions} domande su film e serie</div>
        </div>
      </div>
      <div class="quiz-invite-intro-desc">${i18nT("Seleziona almeno 2 titoli che hai visto, così troviamo domande giuste per entrambi.")}</div>
    </div>`;
}

function titleChipCard(title) {
  const selected = state.selectedIds.has(title.id);
  const poster = titlePoster(title);
  const posterMarkup = poster
    ? `<img class="quiz-title-poster" src="${escapeHtml(poster)}" alt="" loading="lazy">`
    : `<span class="quiz-title-poster"></span>`;
  return `
    <button type="button" class="quiz-title-chip-card${selected ? " is-selected" : ""}" data-toggle="${escapeHtml(title.id)}">
      ${posterMarkup}
      <span class="copy">
        <span class="name">${escapeHtml(titleName(title))}</span>
        <span class="sub">${escapeHtml(titleSubtitle(title))}</span>
      </span>
      <span class="mark">${selected ? ICONS.checkCircle : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>`}</span>
    </button>`;
}

function renderTitleGrid() {
  const titles = allOfferedTitles();
  if (!titles.length) {
    return `
      <section>
        <div class="quiz-section-head" style="margin-bottom:0.5rem">
          <span class="quiz-section-title">${i18nT("Titoli che hai visto")}</span>
        </div>
        <div class="quiz-composer-card">
          <span class="icon is-accent">${ICONS.search}</span>
          <div class="copy"><div class="desc">${i18nT("Cerca qui sotto i film e le serie che hai visto.")}</div></div>
        </div>
      </section>`;
  }
  return `
    <section>
      <div class="quiz-section-head" style="margin-bottom:0.625rem">
        <span class="quiz-section-title">${i18nT("Titoli che hai visto")}</span>
        <span class="quiz-section-spacer"></span>
        ${statusPill(`${state.selectedIds.size} scelti`, {
          tint: meetsMinimum() ? "var(--success)" : "var(--warning)",
          icon: "check",
        })}
      </div>
      <div class="quiz-title-grid">${titles.map(titleChipCard).join("")}</div>
    </section>`;
}

function searchRow(title) {
  const added = state.selectedIds.has(title.id);
  const poster = titlePoster(title);
  const posterMarkup = poster
    ? `<img class="quiz-search-poster" src="${escapeHtml(poster)}" alt="" loading="lazy">`
    : `<span class="quiz-search-poster"></span>`;
  return `
    <button type="button" class="quiz-search-row${added ? " is-added" : ""}" data-add="${escapeHtml(title.id)}" ${added ? "disabled" : ""}>
      ${posterMarkup}
      <span class="copy">
        <span class="name">${escapeHtml(titleName(title))}</span>
        <span class="sub">${escapeHtml(titleSubtitle(title))}</span>
      </span>
      <span class="mark">${added ? ICONS.checkCircle : ICONS.plusCircle}</span>
    </button>`;
}

function renderAddMore() {
  let results = "";
  const trimmed = state.searchQuery.trim();
  if (state.searchResults.length) {
    results = `<div class="quiz-search-rows">${state.searchResults.map(searchRow).join("")}</div>`;
  } else if (trimmed.length >= 2 && !state.isSearching) {
    results = `<span class="quiz-field-hint">Nessun titolo trovato per "${escapeHtml(state.searchQuery)}".</span>`;
  }
  const clearBtn = trimmed
    ? `<button type="button" class="quiz-search-clear" id="quizSearchClear" aria-label="${i18nT("Cancella ricerca")}">${ICONS.close}</button>`
    : "";
  const spinner = state.isSearching ? `<span class="quiz-spinner" style="width:1.1rem;height:1.1rem;border-width:2px"></span>` : "";
  return `
    <section>
      <div class="quiz-section-head" style="margin-bottom:0.625rem">
        <span class="quiz-section-title">${i18nT("Aggiungi altri titoli")}</span>
      </div>
      <div class="quiz-search-field">
        ${ICONS.search}
        <input type="text" id="quizTitleSearch" placeholder="${i18nT("Cerca un film o una serie")}" value="${escapeHtml(state.searchQuery)}" autocomplete="off">
        ${spinner}${clearBtn}
      </div>
      ${results}
    </section>`;
}

function renderStartBar() {
  const finalizing = state.phase === "finalizing";
  const hint = !meetsMinimum()
    ? `<div class="quiz-startbar-hint">${ICONS.bulb}<span>${i18nT("Più titoli scegli, migliore sarà la sfida.")}</span></div>`
    : "";
  const label = finalizing
    ? `<span class="quiz-spinner" style="width:1.1rem;height:1.1rem;border-width:2px"></span><span>${i18nT("Preparo la sfida…")}</span>`
    : `${ICONS.play}<span>${i18nT("Inizia sfida")}</span>`;
  return `
    <div class="quiz-startbar">
      <div class="quiz-startbar-inner">
        ${hint}
        <button type="button" class="btn primary full" id="quizStartChallenge" ${(!meetsMinimum() || finalizing) ? "disabled" : ""}>${label}</button>
      </div>
    </div>`;
}

function renderPicking() {
  root.innerHTML = `
    <div class="quiz-invite-page">
      ${renderIntro()}
      ${renderTitleGrid()}
      ${renderAddMore()}
    </div>
    ${renderStartBar()}`;
  bindPicking();
}

function renderNeedMore() {
  const available = state.availableQuestions;
  const message = available > 0
    ? i18nT("Con questi titoli abbiamo solo {available} domande. Aggiungine altri per una sfida completa.", { available })
    : i18nT("Non abbiamo abbastanza domande su questi titoli. Aggiungine altri che hai visto.");
  root.innerHTML = `
    <div class="quiz-invite-page">
      <div class="quiz-notice quiz-glow-card glow-warm" style="--quiz-outcome-tint:var(--warning)">
        <span style="color:var(--warning)">${ICONS.inbox}</span>
        <span class="title">${i18nT("Servono più titoli")}</span>
        <span class="desc">${escapeHtml(message)}</span>
      </div>
      ${renderAddMore()}
      <button type="button" class="btn primary full" id="quizBackToPicking">${ICONS.back}<span>${i18nT("Torna alla selezione")}</span></button>
    </div>`;
  bindAddMore();
  document.getElementById("quizBackToPicking")?.addEventListener("click", () => {
    state.phase = "picking";
    renderPicking();
  });
}

function render() {
  hideSplash();
  if (state.phase === "loading" || state.phase === "claiming") {
    root.innerHTML = loadingState(i18nT("Apro la sfida…"));
    return;
  }
  if (state.phase === "error") {
    root.innerHTML = errorState({ title: i18nT("Invito non valido"), message: state.errorMessage, retryId: "quizRetry" });
    document.getElementById("quizRetry")?.addEventListener("click", () => {
      window.location.href = "/quiz.html";
    });
    return;
  }
  if (state.phase === "needMore") {
    renderNeedMore();
    return;
  }
  if (state.phase === "ready") {
    // Sfida pronta → vai al player.
    window.location.replace(`/quiz-play.html?challenge=${encodeURIComponent(state.readyChallengeId)}`);
    return;
  }
  // picking | finalizing
  renderPicking();
}

/* ===== Ricerca titoli ===== */

function updateSearch(value) {
  state.searchQuery = value;
  if (state.searchTimer) window.clearTimeout(state.searchTimer);
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    state.searchResults = [];
    state.isSearching = false;
    rerenderAddMore();
    return;
  }
  state.isSearching = true;
  rerenderAddMore();
  const seq = ++state.searchSeq;
  state.searchTimer = window.setTimeout(async () => {
    try {
      const results = await searchTitlesSmart(trimmed, 20);
      if (seq !== state.searchSeq) return;
      state.searchResults = results;
    } catch (err) {
      console.error("[quiz-invite] search error", err);
      if (seq !== state.searchSeq) return;
      state.searchResults = [];
    }
    state.isSearching = false;
    rerenderAddMore();
  }, 280);
}

/** Re-render mirato della sola sezione "aggiungi titoli" senza perdere focus. */
function rerenderAddMore() {
  if (state.phase === "needMore") {
    renderNeedMore();
  } else {
    renderPicking();
  }
  // Riporta il focus sul campo di ricerca dopo il re-render.
  const input = document.getElementById("quizTitleSearch");
  if (input && document.activeElement !== input) {
    input.focus();
    const len = input.value.length;
    input.setSelectionRange(len, len);
  }
}

function addFromSearch(titleId) {
  const title = state.searchResults.find((t) => t.id === titleId);
  if (!title) return;
  const already = state.addedTitles.some((t) => t.id === titleId)
    || state.inviterTitles.some((t) => t.id === titleId);
  if (!already) state.addedTitles.push(title);
  state.selectedIds.add(titleId);
  state.searchQuery = "";
  state.searchResults = [];
  render();
}

/* ===== Wiring ===== */

function bindPicking() {
  root.querySelectorAll("[data-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-toggle");
      if (state.selectedIds.has(id)) state.selectedIds.delete(id);
      else state.selectedIds.add(id);
      renderPicking();
    });
  });
  bindAddMore();
  document.getElementById("quizStartChallenge")?.addEventListener("click", finalize);
}

function bindAddMore() {
  const input = document.getElementById("quizTitleSearch");
  if (input) {
    input.addEventListener("input", () => updateSearch(input.value));
  }
  document.getElementById("quizSearchClear")?.addEventListener("click", () => updateSearch(""));
  root.querySelectorAll("[data-add]").forEach((btn) => {
    btn.addEventListener("click", () => addFromSearch(btn.getAttribute("data-add")));
  });
}

/* ===== Claim + finalize ===== */

async function claim() {
  state.phase = "claiming";
  render();
  try {
    const result = await claimExternalInvite(token);
    state.claim = result;
    // Se la sfida ha già le domande, l'onboarding era stato completato → player.
    const challenge = await fetchChallenge(result.challengeId).catch(() => null);
    if (challenge && challenge.questionIds && challenge.questionIds.length) {
      state.readyChallengeId = result.challengeId;
      state.phase = "ready";
      return render();
    }
    // Carica i titoli proposti dall'invitante e pre-selezionali.
    const ids = result.inviterSeenTitleIds || [];
    if (ids.length) {
      state.inviterTitles = await listTitlesByIds(ids, { max: 60 }).catch(() => []);
    }
    state.selectedIds = new Set(state.inviterTitles.map((t) => t.id));
    state.phase = "picking";
  } catch (err) {
    console.error("[quiz-invite] claim error", err);
    state.phase = "error";
    state.errorMessage = err?.message || i18nT("Questo invito non è valido o è scaduto.");
  }
  render();
}

async function finalize() {
  if (!meetsMinimum() || state.phase === "finalizing") return;
  state.phase = "finalizing";
  render();
  try {
    const result = await finalizeExternalChallenge({
      challengeId: state.claim.challengeId,
      confirmedTitleIds: [...state.selectedIds],
    });
    if (result.ready) {
      state.readyChallengeId = state.claim.challengeId;
      state.phase = "ready";
    } else {
      state.availableQuestions = result.availableQuestions || 0;
      state.phase = "needMore";
    }
  } catch (err) {
    console.error("[quiz-invite] finalize error", err);
    state.phase = "error";
    state.errorMessage = err?.message || i18nT("Impossibile preparare la sfida. Riprova.");
  }
  render();
}

/* ===== Init: gestione auth + token ===== */

if (!token) {
  // Nessun token: invito non valido.
  state.phase = "error";
  state.errorMessage = i18nT("Invito non valido: token mancante.");
  render();
} else {
  let settled = false;
  onAuth((user) => {
    if (settled) return;
    settled = true;
    if (user) {
      state.uid = user.uid;
      void claim();
    } else {
      // Non loggato: vai al login conservando l'URL completo (token incluso),
      // così dopo l'accesso si torna qui e il claim parte.
      const next = encodeURIComponent(location.pathname + location.search);
      window.location.replace(`/login.html?next=${next}`);
    }
  });
}
