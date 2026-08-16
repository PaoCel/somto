import { initAuthGuard } from "../components/authGuard.js";
import { t as i18nT } from "../i18n/index.js";
import { initTabbar } from "../utils/tabbar.js";
import { searchTitlesSmart, findTitleByDedupeKey, findTitleByTmdbId, createTitle, makeDedupeKey, tmdbTitleDocId } from "../api/titles.api.js";
import { searchTmdb, getTmdbImageUrl, importFromTmdbResult } from "../api/tmdb.api.js";
import { searchUsersByPrefix, ensureUserDoc } from "../api/users.api.js";
import { listGenres } from "../api/genres.api.js";
import { searchPeopleByPrefix, getTitlesByGenre, getTitlesByPerson } from "../api/people.api.js";
import { addToWatchlist, removeFromWatchlist, isInWatchlist } from "../api/watchlist.api.js";
import { qs, qsa, escapeHtml } from "../utils/dom.js";
import { stripLeadingEmoji } from "../utils/text.js";
import { toast } from "../components/toast.js";
import { showErrorBanner, hideErrorBanner } from "../utils/errorBanner.js";
import { runWithButtonLoading } from "../utils/loading.js";

initTabbar();

// -------------------- DOM refs --------------------
const q = qs("#q");
const searchSpinner = qs("#searchSpinner");
const searchClear = qs("#searchClear");

const scopeTabs = qsa("[data-scope]");
const typeBar = qs("#typeBar");
const typeBtns = qsa("#typeBar [data-type]");
const roleBar = qs("#roleBar");
const roleBtns = qsa("#roleBar [data-role]");

// Sections
const titlesSection = qs("#titlesSection");
const usersSection = qs("#usersSection");
const genresSection = qs("#genresSection");
const peopleSection = qs("#peopleSection");
const noResults = qs("#noResults");

// Idle state (hint card + ricerche recenti + suggerimenti)
const idleState = qs("#idleState");
const idleHintIcon = qs("#idleHintIcon");
const idleHintMessage = qs("#idleHintMessage");
const recentStrip = qs("#recentStrip");
const recentList = qs("#recentList");
const recentClear = qs("#recentClear");
const suggestStrip = qs("#suggestStrip");
const suggestTitle = qs("#suggestTitle");
const suggestChips = qs("#suggestChips");

// Titles
const titleResults = qs("#titleResults");
const titlesCount = qs("#titlesCount");
const titlesPagination = qs("#titlesPagination");

// Users
const userResults = qs("#userResults");
const usersCount = qs("#usersCount");
const usersPagination = qs("#usersPagination");

// Genres
const genreSelectorBtn = qs("#genreSelectorBtn");
const selectedTagsWrap = qs("#selectedTags");
const genreTitlesBlock = qs("#genreTitlesBlock");
const genreTitlesTitle = qs("#genreTitlesTitle");
const genreTitlesCount = qs("#genreTitlesCount");
const genreTitlesWrap = qs("#genreTitlesWrap");
const genreTitlesPagination = qs("#genreTitlesPagination");

// Genre Bottom Sheet
const genreSheet = qs("#genreSheet");
const sheetClose = qs("#sheetClose");
const sheetSearch = qs("#sheetSearch");
const sheetContent = qs("#sheetContent");
const sheetClear = qs("#sheetClear");
const sheetApply = qs("#sheetApply");
const sheetSelectedCount = qs("#sheetSelectedCount");

// TMDB
const tmdbSection = qs("#tmdbSection");
const tmdbResults = qs("#tmdbResults");
const tmdbCount = qs("#tmdbCount");
const tmdbImportModal = qs("#tmdbImportModal");
const tmdbImportMessage = qs("#tmdbImportMessage");

// People
const peopleResults = qs("#peopleResults");
const peopleCount = qs("#peopleCount");
const peoplePagination = qs("#peoplePagination");
const personTitlesBlock = qs("#personTitlesBlock");
const personTitlesTitle = qs("#personTitlesTitle");
const personTitlesCount = qs("#personTitlesCount");
const personTitlesWrap = qs("#personTitlesWrap");
const personTitlesPagination = qs("#personTitlesPagination");

// -------------------- State --------------------
let currentUser = null;
let scope = "titles";
let typeFilter = "all";
let roleFilter = "all";
let tmdbImportBusy = false;

let allGenres = [];
let selectedGenres = []; // Applied selection
let tempSelectedGenres = []; // Temporary selection in sheet
let selectedPerson = null;

let searchTimer = null;
let isLoading = false;

// Sequence guards (evita race condition da risposte stale: click rapidi su
// generi/persone/titoli diversi in sequenza). Pattern mutuato da
// appShell.js (searchSeq).
let titlesSeq = 0;
let tmdbSeq = 0;
let genreTitlesSeq = 0;
let personTitlesSeq = 0;

function initialsFromName(name){
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean).slice(0,2);
  const ini = parts.map(p => (p[0] || '').toUpperCase()).join('');
  return ini || '🎭';
}

function safeImgUrl(url){
  const u = String(url || '').trim();
  // Accept only https URLs (Commons/Storage)
  return (u && u.startsWith('https://')) ? u : '';
}

// Pagination
const ITEMS_PER_PAGE = 12;
let currentPage = { titles: 1, users: 1, genreTitles: 1, personTitles: 1, people: 1 };
let allResults = { titles: [], titlesRaw: [], users: [], genreTitles: [], personTitles: [], people: [] };

// -------------------- Auth --------------------
initAuthGuard({ requireAuth: false, onReady: async (user) => {
  currentUser = user || null;
  if (user) {
    await ensureUserDoc(user).catch(() => {});
  }
}});

// -------------------- UI Helpers --------------------
function setActiveBtn(btns, isActiveFn) {
  btns.forEach(b => {
    const active = isActiveFn(b);
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", active ? "true" : "false");
  });
}

function show(el, yes) {
  if (el) el.style.display = yes ? "" : "none";
}

function showCount(el, count) {
  if (!el) return;
  if (count > 0) {
    el.textContent = count;
    el.style.display = "";
  } else {
    el.style.display = "none";
  }
}

function setLoading(loading) {
  isLoading = loading;
  if (searchSpinner) searchSpinner.classList.toggle("visible", loading);
}

function updateClearButton() {
  const hasText = (q?.value || "").trim().length > 0;
  if (searchClear) {
    searchClear.classList.toggle("visible", hasText && !isLoading);
  }
}

function showOnlySection(which) {
  show(titlesSection, which === "titles");
  show(tmdbSection, which === "titles");
  show(usersSection, which === "users");
  show(genresSection, which === "genres");
  show(peopleSection, which === "people");
}

function showSecondaryBars() {
  const wantsType = (scope === "titles" || scope === "genres" || scope === "people");
  const wantsRole = (scope === "people");
  if (typeBar) typeBar.classList.toggle("hidden", !wantsType);
  if (roleBar) roleBar.classList.toggle("hidden", !wantsRole);
}

function resetContextOnScopeChange() {
  selectedGenres = [];
  tempSelectedGenres = [];
  selectedPerson = null;
  currentPage = { titles: 1, users: 1, genreTitles: 1, personTitles: 1, people: 1 };
  allResults = { titles: [], titlesRaw: [], users: [], genreTitles: [], personTitles: [], people: [] };
  
  if (genreTitlesBlock) show(genreTitlesBlock, false);
  if (personTitlesBlock) show(personTitlesBlock, false);
  updateGenreSelectorBtn();
  renderSelectedTags();
}

// -------------------- Skeleton --------------------
function buildSkeletonGrid(n = 8) {
  return Array.from({ length: n }).map(() => `
    <div class="grid-card" aria-hidden="true">
      <div class="grid-poster skel skel-poster"></div>
      <div class="grid-meta">
        <div class="skel skel-text w-80"></div>
        <div class="skel skel-text w-60" style="margin-top:6px;"></div>
      </div>
    </div>
  `).join("");
}

// -------------------- Poster Grid --------------------
function iconBookmarkGrid(size = 16) {
  return `
    <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  `;
}

function buildPosterGrid(items) {
  return (items || []).map(t => {
    const year = t.year ? ` • ${t.year}` : "";
    const type = t.type === "tv" ? i18nT("Serie") : i18nT("Film");
    const href = `/title.html?id=${encodeURIComponent(t.id)}`;

    const poster = t.posterPath
      ? `<img alt="" src="${escapeHtml(t.posterPath)}" loading="lazy" />`
      : `<div class="poster-fallback">🎬</div>`;

    const avg = Number(t.ratingAvg || 0);
    const cnt = Number(t.ratingCount || 0);
    const badge = (cnt > 0 && avg > 0)
      ? `<div class="grid-badge">${escapeHtml(avg.toFixed(1))}</div>`
      : "";

    return `
      <div class="grid-card-wrap">
        <a class="grid-card" href="${href}">
          <div class="grid-poster">${poster}${badge}</div>
          <div class="grid-meta">
            <div class="grid-title">${escapeHtml(t.name || i18nT("(senza titolo)"))}</div>
            <div class="grid-sub">${escapeHtml(type + year)}</div>
          </div>
        </a>
        <button
          class="grid-quick-add"
          type="button"
          data-quick-add="1"
          data-title-id="${escapeHtml(t.id)}"
          aria-label="${i18nT("Aggiungi a watchlist")}"
          title="${i18nT("Aggiungi a watchlist")}"
        >${iconBookmarkGrid(16)}</button>
      </div>
    `;
  }).join("");
}

// Wiring del bottone "+" quick-add su ogni card poster: toggle watchlist,
// richiede login se serve (redirect con next=), stato "active" se già presente.
function wireQuickAddButtons(container) {
  if (!container) return;
  container.querySelectorAll("[data-quick-add='1']").forEach(btn => {
    if (btn.dataset.wiredQuickAdd === "1") return;
    btn.dataset.wiredQuickAdd = "1";

    const titleId = btn.getAttribute("data-title-id");
    if (!titleId) return;

    if (currentUser) {
      isInWatchlist(currentUser.uid, titleId).then(inWl => {
        if (inWl) btn.classList.add("active");
      }).catch(() => {});
    }

    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();

      if (!currentUser) {
        const next = encodeURIComponent(location.pathname + location.search);
        location.href = `/login.html?next=${next}`;
        return;
      }

      const isActive = btn.classList.contains("active");
      await runWithButtonLoading(btn, async () => {
        try {
          if (isActive) {
            await removeFromWatchlist(currentUser.uid, titleId);
            btn.classList.remove("active");
            toast(i18nT("Rimosso dalla watchlist"), i18nT("Watchlist"), { type: "success" });
          } else {
            await addToWatchlist(currentUser.uid, titleId, { source: "search_page" });
            btn.classList.add("active");
            toast(i18nT("Aggiunto alla watchlist"), i18nT("Watchlist"), { type: "success" });
          }
        } catch (err) {
          console.error(err);
          toast(err?.message || i18nT("Errore. Riprova."), i18nT("Watchlist"), { type: "error" });
        }
      }, { loadingLabel: "…" });
    });
  });
}

// -------------------- Pagination --------------------
function buildPagination(totalItems, currentPg) {
  const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE);
  if (totalPages <= 1) return "";

  const maxVisible = 5;
  let startPage = Math.max(1, currentPg - Math.floor(maxVisible / 2));
  let endPage = Math.min(totalPages, startPage + maxVisible - 1);
  if (endPage - startPage < maxVisible - 1) {
    startPage = Math.max(1, endPage - maxVisible + 1);
  }

  let html = `
    <button class="page-btn" data-page="prev" ${currentPg === 1 ? 'disabled' : ''}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg>
    </button>
  `;

  if (startPage > 1) {
    html += `<button class="page-btn" data-page="1">1</button>`;
    if (startPage > 2) html += `<span class="page-ellipsis">…</span>`;
  }

  for (let i = startPage; i <= endPage; i++) {
    html += `<button class="page-btn ${i === currentPg ? 'active' : ''}" data-page="${i}">${i}</button>`;
  }

  if (endPage < totalPages) {
    if (endPage < totalPages - 1) html += `<span class="page-ellipsis">…</span>`;
    html += `<button class="page-btn" data-page="${totalPages}">${totalPages}</button>`;
  }

  html += `
    <button class="page-btn" data-page="next" ${currentPg === totalPages ? 'disabled' : ''}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
    </button>
  `;

  return html;
}

function attachPaginationListeners(container, pageKey, renderFn) {
  if (!container) return;
  container.querySelectorAll("[data-page]").forEach(btn => {
    btn.addEventListener("click", () => {
      const page = btn.dataset.page;
      const totalPages = Math.ceil(allResults[pageKey].length / ITEMS_PER_PAGE);
      
      if (page === "prev") currentPage[pageKey] = Math.max(1, currentPage[pageKey] - 1);
      else if (page === "next") currentPage[pageKey] = Math.min(totalPages, currentPage[pageKey] + 1);
      else currentPage[pageKey] = parseInt(page, 10);
      
      renderFn();
      container.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  });
}

function getPageItems(items, page) {
  const start = (page - 1) * ITEMS_PER_PAGE;
  return items.slice(start, start + ITEMS_PER_PAGE);
}

// -------------------- No Results --------------------
function renderNoResults(showIt) {
  show(noResults, !!showIt);
}

// -------------------- Idle state (hint + recenti + suggerimenti) --------------------
// Replica SearchView.idleSuggestions: card hint, ricerche recenti (localStorage),
// chip di suggerimenti curati per scope.
const HISTORY_PREFIX = "search.history.v1.";
const HISTORY_LIMIT = 8;

// Glifi SVG per la hint card, per scope (iOS systemImage).
const SCOPE_HINT_ICONS = {
  titles: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm-1 16h16v2H4z"/></svg>`,
  users: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm8 1a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2 19a6.5 6.5 0 0 1 13 0 1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Zm14.5-5c2.5 0 5.5 1.8 5.5 5a1 1 0 0 1-1 1h-3.6c.1-2.3-.7-4.4-2-6 .5-.1 1-.2 1.6-.2Z"/></svg>`,
  genres: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/></svg>`,
  people: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm5 4a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Zm-3 9a3 3 0 0 1 6 0Zm9-8h4v1.6h-4Zm0 3.2h4V15h-4Z"/></svg>`,
};

const SCOPE_HINT_MESSAGES = {
  titles: i18nT("Digita un titolo o tocca un suggerimento per iniziare."),
  users: i18nT("Digita il nome utente o tocca una ricerca recente."),
  genres: i18nT("Tocca un genere o cerca per nome per filtrare il catalogo."),
  people: i18nT("Cerca attori e registi: ottieni filmografia e arricchimento da TMDB."),
};

const SCOPE_SUGGESTIONS = {
  titles: ["Marvel", "Pixar", "Christopher Nolan", "Dune", "Stranger Things"],
  users: [],
  genres: ["Azione", "Commedia", "Documentari", "Thriller"],
  people: ["Margot Robbie", "Denis Villeneuve", "Zendaya", "Cillian Murphy"],
};

function recentQueries(forScope) {
  try {
    const raw = localStorage.getItem(HISTORY_PREFIX + forScope);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((v) => typeof v === "string") : [];
  } catch (_) {
    return [];
  }
}

function writeRecent(forScope, list) {
  try {
    localStorage.setItem(HISTORY_PREFIX + forScope, JSON.stringify(list.slice(0, HISTORY_LIMIT)));
  } catch (_) { /* storage non disponibile */ }
}

function recordRecent(term, forScope) {
  const trimmed = String(term || "").trim();
  if (trimmed.length < 2) return;
  const current = recentQueries(forScope).filter((v) => v.toLowerCase() !== trimmed.toLowerCase());
  current.unshift(trimmed);
  writeRecent(forScope, current);
}

function removeRecent(term, forScope) {
  const current = recentQueries(forScope).filter((v) => v.toLowerCase() !== String(term).toLowerCase());
  writeRecent(forScope, current);
}

function clearRecent(forScope) {
  try {
    localStorage.removeItem(HISTORY_PREFIX + forScope);
  } catch (_) { /* noop */ }
}

function isIdle() {
  return !(q?.value || "").trim();
}

function renderIdleState() {
  if (!idleState) return;
  if (!isIdle()) {
    show(idleState, false);
    return;
  }
  show(idleState, true);

  if (idleHintIcon) idleHintIcon.innerHTML = SCOPE_HINT_ICONS[scope] || SCOPE_HINT_ICONS.titles;
  if (idleHintMessage) idleHintMessage.textContent = SCOPE_HINT_MESSAGES[scope] || "";

  const recent = recentQueries(scope);
  if (recentStrip) show(recentStrip, recent.length > 0);
  if (recentList) {
    recentList.innerHTML = recent.map((entry) => `
      <div class="search-recent-row">
        <button class="search-recent-apply" type="button" data-recent="${escapeHtml(entry)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.7" y2="16.7"/></svg>
          <span>${escapeHtml(entry)}</span>
        </button>
        <button class="search-recent-remove" type="button" data-recent-remove="${escapeHtml(entry)}" aria-label="${i18nT("Rimuovi {name}", { name: escapeHtml(entry) })}">×</button>
      </div>
    `).join("");
  }

  const suggestions = SCOPE_SUGGESTIONS[scope] || [];
  if (suggestStrip) show(suggestStrip, suggestions.length > 0);
  if (suggestTitle) suggestTitle.textContent = recent.length ? i18nT("Esempi") : i18nT("Idee per iniziare");
  if (suggestChips) {
    suggestChips.innerHTML = suggestions.map((s) => `
      <button class="search-suggest-chip" type="button" data-suggest="${escapeHtml(s)}">${escapeHtml(s)}</button>
    `).join("");
  }
}

function applyRecentQuery(term) {
  if (!q) return;
  q.value = term;
  updateClearButton();
  clearTimeout(searchTimer);
  runCurrent();
}

idleState?.addEventListener("click", (ev) => {
  const apply = ev.target.closest("[data-recent]");
  if (apply) return applyRecentQuery(apply.getAttribute("data-recent") || "");

  const removeBtn = ev.target.closest("[data-recent-remove]");
  if (removeBtn) {
    removeRecent(removeBtn.getAttribute("data-recent-remove") || "", scope);
    renderIdleState();
    return;
  }

  const suggest = ev.target.closest("[data-suggest]");
  if (suggest) return applyRecentQuery(suggest.getAttribute("data-suggest") || "");
});

recentClear?.addEventListener("click", () => {
  clearRecent(scope);
  renderIdleState();
});

// -------------------- TITLES --------------------
async function searchTitles() {
  const term = (q?.value || "").trim();
  const container = titlesSection || document.body;
  hideErrorBanner(container);
  
  if (!term) {
    titleResults.innerHTML = `<div class="hint">${i18nT("Digita per cercare film e serie")}</div>`;
    showCount(titlesCount, 0);
    show(titlesPagination, false);
    show(tmdbSection, false);
    renderNoResults(false);
    return;
  }

  renderNoResults(false);
  showCount(titlesCount, 0);
  show(titlesPagination, false);
  titleResults.innerHTML = buildSkeletonGrid(8);
  setLoading(true);

  const runId = ++titlesSeq;

  try {
    const items = await searchTitlesSmart(term, 90);
    if (runId !== titlesSeq) return; // risposta stale, una richiesta più recente ha già scritto lo stato

    allResults.titlesRaw = items;
    currentPage.titles = 1;
    applyTitlesTypeFilter();
    recordRecent(term, "titles");

    // Fire TMDB search in parallel (non-blocking)
    searchTmdbTitles(term);
  } catch (e) {
    if (runId !== titlesSeq) return;
    console.error(e);
    toast(e?.message || i18nT("Errore ricerca"), "Ops");
    titleResults.innerHTML = `<div class="hint">${i18nT("Errore nella ricerca")}</div>`;
    showErrorBanner(container, i18nT("Errore nella ricerca"), () => searchTitles());
  } finally {
    if (runId === titlesSeq) {
      setLoading(false);
      updateClearButton();
    }
  }
}

// Applica il filtro Tutti/Film/Serie ai risultati titoli già recuperati
// (nessuna nuova query Firestore: filtro client-side sui dati in memoria).
function applyTitlesTypeFilter() {
  const raw = allResults.titlesRaw || [];
  const items = (typeFilter && typeFilter !== "all")
    ? raw.filter(t => (t.type === "tv" ? "tv" : "movie") === typeFilter)
    : raw;

  allResults.titles = items;
  currentPage.titles = 1;
  showCount(titlesCount, items.length);

  if (!items.length) {
    titleResults.innerHTML = "";
    renderNoResults(true);
    show(titlesPagination, false);
  } else {
    renderNoResults(false);
    renderTitlesPage();
  }
}

function renderTitlesPage() {
  const items = allResults.titles;
  const pageItems = getPageItems(items, currentPage.titles);
  titleResults.innerHTML = buildPosterGrid(pageItems);
  wireQuickAddButtons(titleResults);

  if (items.length > ITEMS_PER_PAGE) {
    titlesPagination.innerHTML = buildPagination(items.length, currentPage.titles);
    show(titlesPagination, true);
    attachPaginationListeners(titlesPagination, "titles", renderTitlesPage);
  } else {
    show(titlesPagination, false);
  }
}

// -------------------- TMDB --------------------
let tmdbResultsRaw = [];

async function searchTmdbTitles(term) {
  if (!term || term.length < 2) {
    show(tmdbSection, false);
    return;
  }

  show(tmdbSection, true);
  tmdbResults.innerHTML = buildSkeletonGrid(4);
  showCount(tmdbCount, 0);

  const runId = ++tmdbSeq;

  try {
    const results = await searchTmdb(term);
    if (runId !== tmdbSeq) return;
    tmdbResultsRaw = results;
    renderTmdbResults();
  } catch (e) {
    if (runId !== tmdbSeq) return;
    console.error("TMDB search error:", e);
    tmdbResults.innerHTML = `<div class="hint">${i18nT("Errore ricerca TMDB")}</div>`;
  }
}

function renderTmdbResults() {
  const results = (typeFilter && typeFilter !== "all")
    ? tmdbResultsRaw.filter(t => (t.mediaType === "tv" ? "tv" : "movie") === typeFilter)
    : tmdbResultsRaw;

  showCount(tmdbCount, results.length);

  if (!results.length) {
    tmdbResults.innerHTML = `<div class="hint">${i18nT("Nessun risultato su TMDB")}</div>`;
    return;
  }

  tmdbResults.innerHTML = buildTmdbGrid(results);
}

function buildTmdbGrid(items) {
  return (items || []).map(t => {
    const year = t.year ? ` \u2022 ${t.year}` : "";
    const type = t.mediaType === "tv" ? i18nT("Serie") : i18nT("Film");
    const safeTitle = escapeHtml(t.title || i18nT("(senza titolo)"));

    const poster = t.posterPath
      ? `<img alt="" src="${escapeHtml(getTmdbImageUrl(t.posterPath, 'w185'))}" loading="lazy" />`
      : `<div class="poster-fallback">🎬</div>`;

    return `
      <button
        type="button"
        class="grid-card tmdb-card tmdb-card-btn"
        data-tmdb-id="${escapeHtml(String(t.tmdbId || ""))}"
        data-media-type="${escapeHtml(t.mediaType || "movie")}"
        data-title="${safeTitle}"
        data-year="${escapeHtml(String(t.year || ""))}"
      >
        <div class="grid-poster">${poster}
          <div class="grid-badge tmdb-badge">${i18nT("TMDB")}</div>
        </div>
        <div class="grid-meta">
          <div class="grid-title">${safeTitle}</div>
          <div class="grid-sub">${escapeHtml(type + year)}</div>
        </div>
      </button>
    `;
  }).join("");
}

function openTmdbImportModal(message) {
  if (!tmdbImportModal) return;
  if (tmdbImportMessage && message) tmdbImportMessage.textContent = message;
  tmdbImportModal.style.display = "";
  tmdbImportModal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function setTmdbImportMessage(message) {
  if (tmdbImportMessage) tmdbImportMessage.textContent = message;
}

function closeTmdbImportModal() {
  if (!tmdbImportModal) return;
  tmdbImportModal.style.display = "none";
  tmdbImportModal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

function parseYear(value) {
  const y = parseInt(String(value || "").trim(), 10);
  return Number.isFinite(y) ? y : null;
}

async function openTmdbTitle(card) {
  if (tmdbImportBusy) return;

  const tmdbId = parseInt(card?.dataset?.tmdbId || "", 10);
  const mediaType = card?.dataset?.mediaType === "tv" ? "tv" : "movie";
  const title = String(card?.dataset?.title || "").trim() || i18nT("Titolo");
  const year = parseYear(card?.dataset?.year);
  if (!Number.isFinite(tmdbId)) return;

  const dedupeKey = makeDedupeKey(title, mediaType, year);
  const lookupOpts = currentUser?.uid ? { uid: currentUser.uid } : {};
  tmdbImportBusy = true;
  openTmdbImportModal(i18nT("\"{title}\" non e ancora in Somto. Lo stiamo aggiungendo, attendi qualche secondo.", { title }));

  try {
    let local = await findTitleByTmdbId(tmdbId, mediaType, lookupOpts);
    if (!local) {
      local = await findTitleByDedupeKey(dedupeKey, lookupOpts);
    }

    if (!local) {
      setTmdbImportMessage(i18nT("Import da TMDB in corso per \"{title}\". Potrebbe richiedere qualche secondo...", { title }));
      const mapped = await importFromTmdbResult({ tmdbId, mediaType });
      const mappedDedupeKey = makeDedupeKey(mapped.name || title, mapped.type || mediaType, mapped.year ?? year);
      const mappedTmdbId = Number(mapped?.sourceTmdb?.tmdbId || mapped?.meta?.tmdbId || tmdbId) || null;
      const mappedMediaType = (mapped?.sourceTmdb?.mediaType || mapped?.type || mediaType) === "tv" ? "tv" : "movie";

      local = await findTitleByTmdbId(mappedTmdbId, mappedMediaType, lookupOpts);

      if (!local && mappedDedupeKey !== dedupeKey) {
        local = await findTitleByDedupeKey(mappedDedupeKey, lookupOpts);
      }

      if (local) {
        setTmdbImportMessage(i18nT("Titolo gia presente. Apertura scheda..."));
      } else {
        const created = await createTitle({
          ...mapped,
          posterPath: mapped.posterUrl || null,
          backdropPath: mapped.backdropUrl || null,
          status: "approved",
          createdBy: currentUser?.uid || "auto-import",
          dedupeKey: mappedDedupeKey,
          tmdbId: mappedTmdbId || tmdbId,
          docId: tmdbTitleDocId(mappedMediaType, mappedTmdbId || tmdbId),
          meta: { ...(mapped.meta || {}), source: "tmdb-search", tmdbId: mappedTmdbId || tmdbId, mediaType: mappedMediaType },
        });
        local = { id: created.id };
      }
    } else {
      setTmdbImportMessage(i18nT("Titolo gia presente. Apertura scheda..."));
    }

    setTmdbImportMessage(i18nT("Quasi fatto, apertura scheda..."));
    window.location.href = `/title.html?id=${encodeURIComponent(local.id)}`;
  } catch (e) {
    console.error("TMDB import error:", e);
    closeTmdbImportModal();
    toast(i18nT("Errore durante l'aggiunta automatica. Riprova tra poco."), "Ops");
  } finally {
    tmdbImportBusy = false;
  }
}

// -------------------- USERS --------------------
async function searchUsers() {
  const term = (q?.value || "").trim();
  const container = usersSection || document.body;
  hideErrorBanner(container);
  renderNoResults(false);

  if (!currentUser) {
    userResults.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔐</div>
        <p class="empty-title">${i18nT("Accesso richiesto")}</p>
        <p class="empty-text">${i18nT("Per cercare utenti devi essere loggato")}</p>
        <a class="empty-cta" href="/login.html?next=${encodeURIComponent(`/search.html?scope=users`)}">${i18nT("Accedi")}</a>
      </div>
    `;
    showCount(usersCount, 0);
    show(usersPagination, false);
    return;
  }

  if (!term) {
    userResults.innerHTML = `<div class="hint">${i18nT("Cerca persone per nome o username")}</div>`;
    showCount(usersCount, 0);
    show(usersPagination, false);
    return;
  }

  showCount(usersCount, 0);
  show(usersPagination, false);
  userResults.innerHTML = `<div class="loading-indicator"><div class="spinner"></div>${i18nT("Ricerca...")}</div>`;
  setLoading(true);

  try {
    const items = await searchUsersByPrefix(term, { max: 50 });
    allResults.users = items;
    currentPage.users = 1;
    showCount(usersCount, items.length);

    recordRecent(term, "users");
    if (!items.length) {
      userResults.innerHTML = `<div class="hint">${i18nT("Nessun profilo trovato per \"")}<strong>${escapeHtml(term)}</strong>${i18nT("\". Prova con un'altra grafia.")}</div>`;
      return;
    }

    renderUsersPage();
  } catch (e) {
    console.error(e);
    toast(e?.message || i18nT("Errore ricerca"), "Ops");
    userResults.innerHTML = `<div class="hint">${i18nT("Errore nella ricerca")}</div>`;
    showErrorBanner(container, i18nT("Errore nella ricerca"), () => searchUsers());
  } finally {
    setLoading(false);
    updateClearButton();
  }
}

function renderUsersPage() {
  const items = allResults.users;
  const pageItems = getPageItems(items, currentPage.users);

  userResults.innerHTML = pageItems.map(u => {
    const name = u.displayName || i18nT("(senza nome)");
    const handle = u.username ? `@${u.username}` : i18nT("Profilo");
    const avatar = u.photoURL
      ? `<img alt="" src="${escapeHtml(u.photoURL)}" loading="lazy" />`
      : `<span>👤</span>`;

    return `
      <div class="user-card" data-uid="${escapeHtml(u.uid)}" role="button" tabindex="0">
        <div class="user-avatar">${avatar}</div>
        <div class="user-meta">
          <p class="user-name">${escapeHtml(name)}</p>
          <p class="user-sub">${escapeHtml(handle)}</p>
        </div>
        <span class="user-arrow">›</span>
      </div>
    `;
  }).join("");

  userResults.querySelectorAll(".user-card").forEach(el => {
    const go = () => {
      const uid = el.getAttribute("data-uid");
      if (uid) location.href = `/user.html?uid=${encodeURIComponent(uid)}`;
    };
    el.addEventListener("click", go);
    el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") go(); });
  });

  if (items.length > ITEMS_PER_PAGE) {
    usersPagination.innerHTML = buildPagination(items.length, currentPage.users);
    show(usersPagination, true);
    attachPaginationListeners(usersPagination, "users", renderUsersPage);
  } else {
    show(usersPagination, false);
  }
}

// -------------------- GENRES (Bottom Sheet) --------------------
function normalizeText(s) {
  return String(s || "").trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ").trim();
}

async function ensureGenresLoaded() {
  if (allGenres.length) return;
  try {
    allGenres = await listGenres(300);
    allGenres.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id, "it"));
  } catch (e) {
    console.error(e);
    toast(i18nT("Errore caricamento generi"), "Ops");
    allGenres = [];
  }
}

function updateGenreSelectorBtn() {
  if (!genreSelectorBtn) return;
  const btnText = genreSelectorBtn.querySelector(".btn-text");
  if (selectedGenres.length === 0) {
    btnText.textContent = i18nT("Seleziona generi...");
    genreSelectorBtn.classList.remove("has-selection");
  } else if (selectedGenres.length === 1) {
    btnText.textContent = selectedGenres[0].name;
    genreSelectorBtn.classList.add("has-selection");
  } else {
    btnText.textContent = `${selectedGenres.length} generi selezionati`;
    genreSelectorBtn.classList.add("has-selection");
  }
}

function renderSelectedTags() {
  if (!selectedTagsWrap) return;
  
  if (selectedGenres.length === 0) {
    selectedTagsWrap.innerHTML = "";
    return;
  }

  const tags = selectedGenres.map(g => `
    <span class="selected-tag">
      ${escapeHtml(g.name)}
      <button type="button" data-remove="${escapeHtml(g.id)}">×</button>
    </span>
  `).join("");

  const clearBtn = selectedGenres.length > 1 
    ? `<button class="clear-all-btn" id="clearAllGenres">${i18nT("Cancella")}</button>` 
    : "";

  selectedTagsWrap.innerHTML = tags + clearBtn;

  // Attach remove handlers
  selectedTagsWrap.querySelectorAll("[data-remove]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.remove;
      selectedGenres = selectedGenres.filter(g => g.id !== id);
      updateGenreSelectorBtn();
      renderSelectedTags();
      loadGenreTitles();
    });
  });

  const clearAllBtn = selectedTagsWrap.querySelector("#clearAllGenres");
  if (clearAllBtn) {
    clearAllBtn.addEventListener("click", () => {
      selectedGenres = [];
      updateGenreSelectorBtn();
      renderSelectedTags();
      show(genreTitlesBlock, false);
    });
  }
}

function openGenreSheet() {
  tempSelectedGenres = [...selectedGenres];
  renderSheetContent();
  updateSheetCount();
  genreSheet.classList.add("open");
  document.body.style.overflow = "hidden";
}

function closeGenreSheet() {
  genreSheet.classList.remove("open");
  document.body.style.overflow = "";
  if (sheetSearch) sheetSearch.value = "";
}

function updateSheetCount() {
  if (!sheetSelectedCount) return;
  if (tempSelectedGenres.length > 0) {
    sheetSelectedCount.textContent = tempSelectedGenres.length;
    sheetSelectedCount.style.display = "";
  } else {
    sheetSelectedCount.style.display = "none";
  }
}

function renderSheetContent(filter = "") {
  if (!sheetContent) return;
  
  const filterNorm = normalizeText(filter);
  let filtered = allGenres;
  if (filterNorm) {
    filtered = allGenres.filter(g => normalizeText(stripLeadingEmoji(g.name || g.id)).includes(filterNorm));
  }

  if (filtered.length === 0) {
    sheetContent.innerHTML = `<div class="hint">${i18nT("Nessun genere trovato")}</div>`;
    return;
  }

  sheetContent.innerHTML = filtered.map(g => {
    const isSelected = tempSelectedGenres.some(s => s.id === g.id);
    const label = stripLeadingEmoji(g.name || g.id);
    return `
      <div class="genre-item ${isSelected ? 'selected' : ''}" data-id="${escapeHtml(g.id)}">
        <div class="genre-checkbox">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        </div>
        <span class="genre-label">${escapeHtml(label)}</span>
      </div>
    `;
  }).join("");

  // Attach toggle handlers
  sheetContent.querySelectorAll(".genre-item").forEach(item => {
    item.addEventListener("click", () => {
      const id = item.dataset.id;
      const genre = allGenres.find(g => g.id === id);
      if (!genre) return;

      const idx = tempSelectedGenres.findIndex(s => s.id === id);
      if (idx >= 0) {
        tempSelectedGenres.splice(idx, 1);
        item.classList.remove("selected");
      } else {
        tempSelectedGenres.push({ id: genre.id, name: genre.name || genre.id });
        item.classList.add("selected");
      }
      updateSheetCount();
    });
  });
}

async function showGenres() {
  renderNoResults(false);
  await ensureGenresLoaded();
  updateGenreSelectorBtn();
  renderSelectedTags();

  if (selectedGenres.length > 0) {
    show(genreTitlesBlock, true);
    await loadGenreTitles();
  } else {
    show(genreTitlesBlock, false);
  }
}

async function loadGenreTitles() {
  if (selectedGenres.length === 0) {
    show(genreTitlesBlock, false);
    return;
  }

  show(genreTitlesBlock, true);
  
  const names = selectedGenres.map(g => g.name).join(" + ");
  genreTitlesTitle.textContent = selectedGenres.length > 1 ? `${selectedGenres.length} generi` : names;
  
  showCount(genreTitlesCount, 0);
  show(genreTitlesPagination, false);
  genreTitlesWrap.innerHTML = buildSkeletonGrid(8);
  setLoading(true);

  // Sequence guard: se l'utente seleziona/applica un genere diverso mentre
  // questa richiesta è ancora in volo, una risposta lenta non deve più
  // sovrascrivere lo stato più recente (causa nota del bug "pagina vuota
  // dopo back + apertura di un altro genere").
  const runId = ++genreTitlesSeq;

  try {
    const fetches = await Promise.all(
      selectedGenres.map(g => getTitlesByGenre(g.id, { type: typeFilter, max: 100 }))
    );
    if (runId !== genreTitlesSeq) return;

    let items;
    if (selectedGenres.length === 1) {
      items = fetches[0];
    } else {
      // Intersection
      const idSets = fetches.map(arr => new Set(arr.map(t => t.id)));
      items = fetches[0].filter(t => idSets.every(s => s.has(t.id)));
    }

    items.sort((a, b) => {
      const diff = (Number(b.ratingCount || 0)) - (Number(a.ratingCount || 0));
      if (diff !== 0) return diff;
      return (Number(b.year || 0)) - (Number(a.year || 0));
    });

    allResults.genreTitles = items;
    currentPage.genreTitles = 1;
    showCount(genreTitlesCount, items.length);

    if (!items.length) {
      genreTitlesWrap.innerHTML = `<div class="hint">${i18nT("Nessun titolo con questi generi")}</div>`;
      return;
    }

    renderGenreTitlesPage();
  } catch (e) {
    if (runId !== genreTitlesSeq) return;
    console.error(e);
    toast(i18nT("Errore caricamento titoli"), "Ops");
    genreTitlesWrap.innerHTML = `<div class="hint">${i18nT("Errore")}</div>`;
  } finally {
    if (runId === genreTitlesSeq) setLoading(false);
  }
}

function renderGenreTitlesPage() {
  const items = allResults.genreTitles;
  const pageItems = getPageItems(items, currentPage.genreTitles);
  genreTitlesWrap.innerHTML = buildPosterGrid(pageItems);
  wireQuickAddButtons(genreTitlesWrap);

  if (items.length > ITEMS_PER_PAGE) {
    genreTitlesPagination.innerHTML = buildPagination(items.length, currentPage.genreTitles);
    show(genreTitlesPagination, true);
    attachPaginationListeners(genreTitlesPagination, "genreTitles", renderGenreTitlesPage);
  } else {
    show(genreTitlesPagination, false);
  }
}

// Genre sheet events
genreSelectorBtn?.addEventListener("click", () => openGenreSheet());
sheetClose?.addEventListener("click", () => closeGenreSheet());
genreSheet?.addEventListener("click", (e) => {
  if (e.target === genreSheet) closeGenreSheet();
});

sheetSearch?.addEventListener("input", () => {
  renderSheetContent(sheetSearch.value);
});

sheetClear?.addEventListener("click", () => {
  tempSelectedGenres = [];
  renderSheetContent(sheetSearch?.value || "");
  updateSheetCount();
});

sheetApply?.addEventListener("click", async () => {
  selectedGenres = [...tempSelectedGenres];
  closeGenreSheet();
  updateGenreSelectorBtn();
  renderSelectedTags();
  await loadGenreTitles();
});

// -------------------- PEOPLE --------------------
async function showPeople() {
  renderNoResults(false);
  const term = (q?.value || "").trim();

  if (!term) {
    peopleResults.innerHTML = `<div class="hint">${i18nT("Cerca attori o registi per nome")}</div>`;
    showCount(peopleCount, 0);
    show(peoplePagination, false);
    show(personTitlesBlock, false);
    return;
  }

  showCount(peopleCount, 0);
  show(peoplePagination, false);
  show(personTitlesBlock, false);
  peopleResults.innerHTML = `<div class="loading-indicator"><div class="spinner"></div>${i18nT("Ricerca...")}</div>`;
  setLoading(true);

  try {
    const people = await searchPeopleByPrefix(term, { max: 50, role: roleFilter });
    allResults.people = people;
    currentPage.people = 1;
    showCount(peopleCount, people.length);

    recordRecent(term, "people");
    if (!people.length) {
      peopleResults.innerHTML = `<div class="hint">${i18nT("Nessuna persona trovata per \"")}<strong>${escapeHtml(term)}</strong>${i18nT("\". Prova con il nome completo o un altro alias.")}</div>`;
      return;
    }

    renderPeoplePage();
  } catch (e) {
    console.error(e);
    toast(i18nT("Errore ricerca"), "Ops");
    peopleResults.innerHTML = `<div class="hint">${i18nT("Errore nella ricerca")}</div>`;
  } finally {
    setLoading(false);
    updateClearButton();
  }
}

function renderPeoplePage() {
  const items = allResults.people;
  const pageItems = getPageItems(items, currentPage.people);

  peopleResults.innerHTML = pageItems.map(p => {
    const name = p.name || p.id;
    const roles = Array.isArray(p.roles) ? p.roles : [];
    const roleLabel = roles.includes("actor") && roles.includes("director")
      ? "Attore • Regista"
      : roles.includes("actor") ? i18nT("Attore") : roles.includes("director") ? i18nT("Regista") : i18nT("Persona");

    const active = selectedPerson && selectedPerson.id === p.id;

    const img = safeImgUrl(p.avatarUrl || p?.avatar?.url || "");
    const fallback = initialsFromName(name);

    return `
      <div class="user-card ${active ? 'active' : ''}" data-person="${escapeHtml(p.id)}" role="button" tabindex="0">
        <div class="user-avatar">${img ? `<img src="${escapeHtml(img)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span>${escapeHtml(fallback)}</span>`}</div>
        <div class="user-meta">
          <p class="user-name">${escapeHtml(name)}</p>
          <p class="user-sub">${escapeHtml(roleLabel)}</p>
        </div>
        <span class="user-arrow">›</span>
      </div>
    `;
  }).join("");

  peopleResults.querySelectorAll("[data-person]").forEach(el => {
    const pick = async () => {
      const id = el.getAttribute("data-person");
      const name = el.querySelector(".user-name")?.textContent || id;
      if (!id) return;
      
      selectedPerson = { id, name };
      peopleResults.querySelectorAll(".user-card").forEach(c => c.classList.remove("active"));
      el.classList.add("active");
      await loadPersonTitles();
    };
    el.addEventListener("click", pick);
    el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") pick(); });
  });

  if (items.length > ITEMS_PER_PAGE) {
    peoplePagination.innerHTML = buildPagination(items.length, currentPage.people);
    show(peoplePagination, true);
    attachPaginationListeners(peoplePagination, "people", renderPeoplePage);
  } else {
    show(peoplePagination, false);
  }
}

async function loadPersonTitles() {
  if (!selectedPerson) return;

  show(personTitlesBlock, true);
  personTitlesTitle.textContent = `Filmografia di ${selectedPerson.name}`;
  showCount(personTitlesCount, 0);
  show(personTitlesPagination, false);
  personTitlesWrap.innerHTML = buildSkeletonGrid(8);
  setLoading(true);

  const runId = ++personTitlesSeq;

  try {
    const items = await getTitlesByPerson(selectedPerson.id, { type: typeFilter, role: roleFilter, max: 100 });
    if (runId !== personTitlesSeq) return;

    allResults.personTitles = items;
    currentPage.personTitles = 1;
    showCount(personTitlesCount, items.length);

    if (!items.length) {
      personTitlesWrap.innerHTML = `<div class="hint">${i18nT("Nessun titolo trovato")}</div>`;
      return;
    }

    renderPersonTitlesPage();
  } catch (e) {
    if (runId !== personTitlesSeq) return;
    console.error(e);
    toast(i18nT("Errore caricamento"), "Ops");
    personTitlesWrap.innerHTML = `<div class="hint">${i18nT("Errore")}</div>`;
  } finally {
    if (runId === personTitlesSeq) setLoading(false);
  }
}

function renderPersonTitlesPage() {
  const items = allResults.personTitles;
  const pageItems = getPageItems(items, currentPage.personTitles);
  personTitlesWrap.innerHTML = buildPosterGrid(pageItems);
  wireQuickAddButtons(personTitlesWrap);

  if (items.length > ITEMS_PER_PAGE) {
    personTitlesPagination.innerHTML = buildPagination(items.length, currentPage.personTitles);
    show(personTitlesPagination, true);
    attachPaginationListeners(personTitlesPagination, "personTitles", renderPersonTitlesPage);
  } else {
    show(personTitlesPagination, false);
  }
}

// -------------------- Dispatcher --------------------
function runCurrent() {
  showSecondaryBars();

  // Stato idle: query vuota su titoli/utenti/persone -> hint card + suggerimenti.
  // I generi hanno il selettore come landing dedicata, quindi niente idle card.
  const idle = isIdle() && scope !== "genres";
  if (idle) {
    showOnlySection(null);
    renderNoResults(false);
    renderIdleState();
    return;
  }
  show(idleState, false);
  showOnlySection(scope);

  if (scope === "titles") return searchTitles();
  if (scope === "users") return searchUsers();
  if (scope === "genres") return showGenres();
  if (scope === "people") return showPeople();
}

function scheduleRun(ms = 300) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runCurrent(), ms);
}

// -------------------- Event Listeners --------------------
q?.addEventListener("input", () => {
  updateClearButton();
  scheduleRun(250);
});

q?.addEventListener("keydown", e => {
  if (e.key === "Enter") {
    clearTimeout(searchTimer);
    runCurrent();
  }
});

searchClear?.addEventListener("click", () => {
  if (q) {
    q.value = "";
    q.focus();
  }
  updateClearButton();
  runCurrent();
});

tmdbResults?.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const card = target.closest(".tmdb-card-btn");
  if (!card) return;
  event.preventDefault();
  openTmdbTitle(card);
});

scopeTabs.forEach(b => {
  b.addEventListener("click", () => {
    scope = b.dataset.scope;
    setActiveBtn(scopeTabs, x => x.dataset.scope === scope);
    resetContextOnScopeChange();
    runCurrent();
  });
});

typeBtns.forEach(b => {
  b.addEventListener("click", async () => {
    typeFilter = b.dataset.type;
    setActiveBtn(typeBtns, x => x.dataset.type === typeFilter);
    if (scope === "titles") {
      applyTitlesTypeFilter();
      renderTmdbResults();
    }
    if (scope === "genres" && selectedGenres.length > 0) await loadGenreTitles();
    if (scope === "people" && selectedPerson) await loadPersonTitles();
  });
});

roleBtns.forEach(b => {
  b.addEventListener("click", async () => {
    roleFilter = b.dataset.role;
    setActiveBtn(roleBtns, x => x.dataset.role === roleFilter);
    if (scope === "people") {
      selectedPerson = null;
      show(personTitlesBlock, false);
      await showPeople();
    }
  });
});

// -------------------- Init from URL params --------------------
const params = new URLSearchParams(location.search);
const initialQ = params.get("q");
const initialScope = params.get("scope");
const initialType = params.get("type");
const initialRole = params.get("role");

if (initialScope && ["titles", "users", "genres", "people"].includes(initialScope)) scope = initialScope;
if (initialType && ["all", "movie", "tv"].includes(initialType)) typeFilter = initialType;
if (initialRole && ["all", "actor", "director"].includes(initialRole)) roleFilter = initialRole;

setActiveBtn(scopeTabs, x => x.dataset.scope === scope);
setActiveBtn(typeBtns, x => x.dataset.type === typeFilter);
setActiveBtn(roleBtns, x => x.dataset.role === roleFilter);

if (initialQ && q) q.value = initialQ;
updateClearButton();

// Initial state
showSecondaryBars();
showOnlySection(scope);

// Bootstrap
runCurrent();

// Deep-link dalle Tendenze della Home: ?tmdbOpen=movie:12345 apre (o importa
// al volo) il titolo TMDB con lo stesso flusso dei risultati ricerca.
const tmdbOpenMatch = String(params.get("tmdbOpen") || "").match(/^(movie|tv):(\d+)$/);
if (tmdbOpenMatch) {
  openTmdbTitle({
    dataset: {
      tmdbId: tmdbOpenMatch[2],
      mediaType: tmdbOpenMatch[1],
      title: String(params.get("title") || ""),
      year: String(params.get("year") || ""),
    },
  });
}

// -------------------- bfcache (back/forward) --------------------
// Chrome può ripristinare questa pagina dalla back/forward cache: lo script
// NON viene rieseguito da zero, ma lo stato mostrato può essere quello
// dell'ultimo "loading" prima della navigazione in uscita (skeleton fermo,
// sezione vuota). Forziamo un refresh della vista corrente quando la pagina
// torna visibile da bfcache, per non lasciare mai uno stato silenzioso/rotto.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    runCurrent();
  }
});
