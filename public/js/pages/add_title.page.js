import { initAuthGuard } from "../components/authGuard.js";
import { t as i18nT } from "../i18n/index.js";
import { qs, qsa, escapeHtml } from "../utils/dom.js";
import { trapFocus } from "../utils/focusTrap.js";
import { toast } from "../components/toast.js";
import { ensureUserDoc, getMyUserDoc } from "../api/users.api.js";
import { findTitleByDedupeKey, findTitleByTmdbId, createTitle, updateTitle, searchTitlesSmart, tmdbTitleDocId } from "../api/titles.api.js";
import { listGenres, createGenre, tmdbGenreCatalog } from "../api/genres.api.js";
import { uploadPoster, uploadPosterFromUrl } from "../api/storage.api.js";
import { searchPeopleByPrefix, createPerson, bumpPeopleOccurrences, ensurePersonAvatar } from "../api/people.api.js";
import { stripLeadingEmoji } from "../utils/text.js";
import { searchWikipedia, refineWikipediaSearchResults, parseWikipediaUrl, importFromSearchResult, importFromUrl, getWikipediaSummary } from "../api/wikipedia.api.js";
import { searchTmdb, importFromTmdbResult, getTmdbImageUrl } from "../api/tmdb.api.js";
import { attachCharCounter } from "../utils/charCounter.js";

// --------------------
// DOM Elements
// --------------------
const authGate = qs("#authGate");
const formContainer = qs("#formContainer");
const floatingActions = qs("#floatingActions");
const btnBack = qs("#btnBack");
const btnNext = qs("#btnNext");
const btnNextText = qs("#btnNextText");
const progressBar = qs("#progressBar");

// Form inputs
const nameInput = qs("#name");
// IMPORTANT: there are multiple ".type-option" blocks on this page (step 0 wiki type + step 1 title type).
// We only want the actual title type selector here.
const typeOptions = qsa("[data-type]");
const yearInput = qs("#year");
const yearQuickButtons = qs("#yearQuickButtons");

const durationMovieInput = qs("#durationMovie");
const seasonsCountInput = qs("#seasonsCount");
const episodesPerSeasonInput = qs("#episodesPerSeason");
const durationEpisodeInput = qs("#durationEpisode");
const togglePerSeason = qs("#togglePerSeason");
const seasonsDetailGrid = qs("#seasonsDetailGrid");

const posterFileInput = qs("#posterFile");
const posterPreviewLarge = qs("#posterPreviewLarge");
const posterUploadBtn = qs("#posterUploadBtn");

const genreSearchInput = qs("#genreSearch");
const genresGrid = qs("#genresGrid");
const addCustomGenreBtn = qs("#addCustomGenreBtn");

const originalNameInput = qs("#originalName");
const aliasesInput = qs("#aliases");
const languageInput = qs("#language");
const countryInput = qs("#country");
const networkInput = qs("#network");

// Optional people fields
const directorSearchInput = qs("#directorSearch");
const directorResults = qs("#directorResults");
const directorsSelected = qs("#directorsSelected");
const castSearchInput = qs("#castSearch");
const castResults = qs("#castResults");
const castSelected = qs("#castSelected");
const descriptionInput = qs("#description");

// Custom Genre Modal
const customGenreModal = qs("#customGenreModal");
const customGenreName = qs("#customGenreName");
const customGenreCancel = qs("#customGenreCancel");
const customGenreSave = qs("#customGenreSave");

// Wikipedia import (Step 0)
const importModeCards = qsa(".import-mode-card");
const wikiSearchPanel = qs("#wikiSearchPanel");
const wikiLinkPanel = qs("#wikiLinkPanel");
const wikiSearchInput = qs("#wikiSearchInput");
const wikiSearchBtn = qs("#wikiSearchBtn");
const wikiSearchBtnText = qs("#wikiSearchBtnText");
const wikiSearchResults = qs("#wikiSearchResults");
const wikiLinkInput = qs("#wikiLinkInput");
const wikiLinkBtn = qs("#wikiLinkBtn");
const wikiLinkBtnText = qs("#wikiLinkBtnText");
const wikiStatus = qs("#wikiStatus");
const wikiTypeOptions = qsa("[data-wiki-type]");

if (descriptionInput) attachCharCounter(descriptionInput);
const wikiGenreSuggestions = qs("#wikiGenreSuggestions");
const wikiGenreSuggestionsList = qs("#wikiGenreSuggestionsList");
const wikiImportDetailsCard = qs("#wikiImportDetailsCard");
// TMDB import (Step 0)
const tmdbSearchPanel = qs("#tmdbSearchPanel");
const tmdbSearchInput = qs("#tmdbSearchInput");
const tmdbSearchBtn = qs("#tmdbSearchBtn");
const tmdbSearchBtnText = qs("#tmdbSearchBtnText");
const tmdbSearchResults = qs("#tmdbSearchResults");

// Quick import preview (Step 4)
const wikiImportPreview = qs("#wikiImportPreview");
const wikiImportThumb = qs("#wikiImportThumb");
const wikiImportTitle = qs("#wikiImportTitle");
const wikiImportSub = qs("#wikiImportSub");
const wikiImportPeople = qs("#wikiImportPeople");

// Review
const reviewPoster = qs("#reviewPoster");
const reviewTitle = qs("#reviewTitle");
const reviewTypeYear = qs("#reviewTypeYear");
const reviewGenres = qs("#reviewGenres");
const reviewDetails = qs("#reviewDetails");
const reviewEditBtn = qs("#reviewEditBtn");

// --------------------
// State
// --------------------
let currentUser = null;
let myUserDoc = null;
let isTrustedUser = false;
let allGenres = [];
let currentStep = 0;
const totalSteps = 6;
let posterFile = null;
let importMode = 'manual'; // 'manual' | 'search' | 'link' | 'tmdb'
let wikiImportedData = null; // data from Wikipedia import
let wikiGenreLabels = []; // genre labels from Wikipedia (for display)
let releaseGenreTrap = null;
// Wikipedia context (for nicer UX preview – NOT persisted as poster)
let wikiImportContext = {
  pageTitle: '',
  lang: 'it',
  thumbnailUrl: '',
};
let formData = {
  name: '',
  type: 'movie',
  year: null,
  durationMovie: null,
  seasonsCount: null,
  episodesPerSeason: null,
  durationEpisode: null,
  seasons: [],
  genres: [],
  posterUrl: null,
  originalName: '',
  aliases: [],
  language: '',
  country: '',
  network: '',
  directorsPeople: [],
  castPeople: [],
  description: '',
  sourceTmdb: null,
};

// --------------------
// Helpers
// --------------------
function normalize(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function initialsFromName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  const first = parts[0]?.[0] || '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] || '') : (parts[0]?.[1] || '');
  return (first + last).toUpperCase();
}

function renderPersonAvatarInner(avatarUrl, name) {
  const url = String(avatarUrl || '').trim();
  if (url) {
    return `<img src="${escapeHtml(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
  }
  const ini = initialsFromName(name) || '🎭';
  return `<span class="avatar-fallback" aria-hidden="true">${escapeHtml(ini)}</span>`;
}

function makeDedupeKey({ name, year, type }) {
  const cleanType = String(type || "null").trim() || "null";
  const cleanYear = year == null || String(year).trim() === "" ? "null" : String(year).trim();
  return `${normalize(name)}_${cleanType}_${cleanYear}`;
}

function toIntOrNull(v, min, max) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  if (min != null && i < min) return null;
  if (max != null && i > max) return null;
  return i;
}

function isTrustedUserDoc(doc) {
  return !!doc?.trusted;
}

function getUserLevel(doc) {
  const level = String(doc?.level || "base").trim().toLowerCase();
  return ["base", "associate", "doctor"].includes(level) ? level : "base";
}

// --------------------
// Duplicate Detection (live search)
// --------------------
const duplicateWarning = qs("#duplicateWarning");
const duplicateList = qs("#duplicateList");
let dupeTimer = null;

function showDuplicateWarning(results) {
  if (!duplicateWarning || !duplicateList) return;
  if (!results || results.length === 0) {
    duplicateWarning.style.display = "none";
    duplicateList.innerHTML = "";
    return;
  }
  duplicateList.innerHTML = results.map(t => {
    const typeLabel = t.type === "movie" ? i18nT("Film") : i18nT("Serie TV");
    const yearLabel = t.year ? ` (${t.year})` : "";
    return `<li>
      <a href="/title.html?id=${encodeURIComponent(t.id)}" class="duplicate-link" target="_blank">
        ${escapeHtml(t.name)}${yearLabel}
        <span class="duplicate-type">${typeLabel}</span>
      </a>
    </li>`;
  }).join("");
  duplicateWarning.style.display = "block";
}

nameInput?.addEventListener("input", () => {
  clearTimeout(dupeTimer);
  const val = nameInput.value.trim();
  if (val.length < 2) {
    showDuplicateWarning(null);
    return;
  }
  dupeTimer = setTimeout(async () => {
    try {
      const results = await searchTitlesSmart(val, 5);
      showDuplicateWarning(results);
    } catch (err) {
      console.warn("Duplicate check failed:", err);
      showDuplicateWarning(null);
    }
  }, 400);
});

// --------------------
// Step Management
// --------------------
function showStep(step) {
  const steps = qsa('.step-container');
  steps.forEach((s, i) => {
    if (i === step) {
      s.classList.add('active');
    } else {
      s.classList.remove('active');
    }
  });
  
  // Update progress dots
  const dots = qsa('.progress-dot');
  dots.forEach((dot, i) => {
    if (i < step) {
      dot.classList.add('completed');
      dot.classList.remove('active');
    } else if (i === step) {
      dot.classList.add('active');
      dot.classList.remove('completed');
    } else {
      dot.classList.remove('active', 'completed');
    }
  });
  
  // Update button text
  if (step === 0) {
    // In step 0, show "Inizia" only for manual mode; hide for search/link
    const hideNext = importMode !== 'manual';
    if (btnNext) btnNext.style.display = hideNext ? 'none' : 'flex';
    btnNextText.textContent = 'Inizia';
    btnBack.style.display = 'none';
  } else if (step === totalSteps) {
    if (btnNext) btnNext.style.display = 'flex';
    btnNextText.textContent = i18nT("Salva");
  } else {
    if (btnNext) btnNext.style.display = 'flex';
    // Poster step is optional: make the CTA explicit on mobile.
    if (step === 3 && posterFileInput && !(posterFileInput.files && posterFileInput.files.length)) {
      btnNextText.textContent = i18nT("Salta");
    } else {
      btnNextText.textContent = i18nT("Avanti");
    }
    btnBack.style.display = 'flex';
  }

  // Show poster auto-download hint if we have a TMDB/Wikipedia poster
  const posterAutoHint = qs("#posterAutoHint");
  if (posterAutoHint) {
    posterAutoHint.style.display = (step === 3 && wikiImportContext?.thumbnailUrl) ? 'block' : 'none';
  }

  // Show a clear "what was imported" recap right after import (Step 2)
  if (wikiImportDetailsCard) {
    if (step === 2 && wikiImportedData) {
      renderWikiImportDetailsCard(wikiImportedData);
      wikiImportDetailsCard.style.display = 'block';
    } else {
      wikiImportDetailsCard.style.display = 'none';
    }
  }

  // Show genre suggestions only in the Genres step
  if (step === 4 && wikiImportedData && Array.isArray(wikiGenreLabels) && wikiGenreLabels.length) {
    showWikiGenreSuggestions();
  } else {
    if (wikiGenreSuggestions) wikiGenreSuggestions.style.display = 'none';
  }
  
  // Scroll to top
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function canProceed(step) {
  switch(step) {
    case 0:
      // Only manual mode uses the "Inizia" button
      return importMode === 'manual';
    
    case 1:
      const name = nameInput.value.trim();
      if (!name) {
        toast(i18nT("Inserisci un titolo"));
        nameInput.focus();
        return false;
      }
      return true;
    
    case 2:
      // Optional fields
      return true;
    
    case 3:
      // Poster is optional
      return true;
    
    case 4:
      syncGenresToFormData();
      if (!formData.genres.length) {
        toast(i18nT("Seleziona almeno un genere"));
        return false;
      }
      return true;
    
    case 5:
      // All optional
      return true;
    
    default:
      return true;
  }
}

function nextStep() {
  if (!canProceed(currentStep)) return;
  
  if (currentStep === totalSteps) {
    // Submit
    submitForm();
    return;
  }
  
  saveCurrentStepData();
  currentStep++;
  
  // Aggiorna UI in base allo step
  if (currentStep === 2) {
    updateDetailsStep();
  }
  if (currentStep === totalSteps) {
    updateReviewStep();
  }
  
  showStep(currentStep);
}

function prevStep() {
  if (currentStep > 0) {
    currentStep--;
    showStep(currentStep);
  }
}

function goToStep(step) {
  if (step >= 0 && step <= totalSteps) {
    currentStep = step;
    showStep(currentStep);
  }
}

// --------------------
// Save Data from Current Step
// --------------------
function saveCurrentStepData() {
  switch(currentStep) {
    case 1:
      formData.name = nameInput.value.trim();
      formData.type = document.querySelector('input[name="type"]:checked').value;
      formData.year = toIntOrNull(yearInput.value, 1880, 2100);
      break;
    
    case 2:
      if (formData.type === 'movie') {
        formData.durationMovie = toIntOrNull(durationMovieInput.value, 1, 600);
      } else {
        formData.seasonsCount = toIntOrNull(seasonsCountInput.value, 1, 200);
        formData.episodesPerSeason = toIntOrNull(episodesPerSeasonInput.value, 1, 200);
        formData.durationEpisode = toIntOrNull(durationEpisodeInput.value, 1, 300);
        
        if (togglePerSeason.checked) {
          formData.seasons = readSeasonsMeta();
        } else {
          const sc = formData.seasonsCount;
          const ep = formData.episodesPerSeason;
          if (sc && ep) {
            formData.seasons = Array.from({ length: sc }).map((_, i) => ({
              season: i + 1,
              episodes: ep
            }));
          }
        }
      }
      break;
    
    case 3:
      // Poster already handled in file input
      break;
    
    case 4:
      syncGenresToFormData();
      break;
    
    case 5:
      formData.originalName = originalNameInput.value.trim();
      const aliasesRaw = aliasesInput.value.trim();
      formData.aliases = aliasesRaw
        ? aliasesRaw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 20)
        : [];
      formData.language = languageInput.value.trim();
      formData.country = countryInput.value.trim();
      formData.network = networkInput.value.trim();
      break;
  }
}

// --------------------
// Type Selection
// --------------------
typeOptions.forEach(option => {
  option.addEventListener('click', () => {
    typeOptions.forEach(opt => opt.classList.remove('selected'));
    option.classList.add('selected');
    option.querySelector('input').checked = true;
  });
});

// --------------------
// Year Quick Buttons
// --------------------
function generateYearButtons() {
  const currentYear = new Date().getFullYear();
  const years = [
    currentYear,
    currentYear - 1,
    currentYear - 2,
    currentYear - 5,
    currentYear - 10
  ];
  
  yearQuickButtons.innerHTML = years.map(year => 
    `<button type="button" class="year-btn" data-year="${year}">${year}</button>`
  ).join('');
  
  yearQuickButtons.querySelectorAll('.year-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      yearInput.value = btn.dataset.year;
      yearQuickButtons.querySelectorAll('.year-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
}

// --------------------
// Details Step
// --------------------
function updateDetailsStep() {
  const type = document.querySelector('input[name="type"]:checked').value;
  const detailsTitle = qs('#detailsTitle');
  const detailsSubtitle = qs('#detailsSubtitle');
  const movieDetails = qs('#movieDetails');
  const tvDetails = qs('#tvDetails');
  
  if (type === 'movie') {
    detailsTitle.textContent = 'Quanto dura?';
    detailsSubtitle.textContent = i18nT("La durata del film in minuti");
    movieDetails.style.display = 'grid';
    tvDetails.style.display = 'none';
  } else {
    detailsTitle.textContent = i18nT("Info sulla serie");
    detailsSubtitle.textContent = i18nT('Stagioni, episodi e durata');
    movieDetails.style.display = 'none';
    tvDetails.style.display = 'grid';
  }
}

// Seasons toggle
togglePerSeason?.addEventListener('change', () => {
  renderSeasonsDetailGrid();
});

seasonsCountInput?.addEventListener('input', () => {
  if (togglePerSeason?.checked) {
    renderSeasonsDetailGrid();
  }
});

function renderSeasonsDetailGrid() {
  if (!togglePerSeason.checked || !seasonsDetailGrid) {
    seasonsDetailGrid.classList.remove('active');
    return;
  }
  
  const count = toIntOrNull(seasonsCountInput.value, 1, 200) || 0;
  if (count === 0) {
    seasonsDetailGrid.classList.remove('active');
    return;
  }
  
  const defaultEp = toIntOrNull(episodesPerSeasonInput.value, 1, 200) || 10;
  const prefill = Array.isArray(formData.seasons) && formData.seasons.length === count
    ? formData.seasons
    : null;
  
  seasonsDetailGrid.innerHTML = Array.from({ length: count }).map((_, i) => {
    const season = i + 1;
    const prefillEp = prefill?.[i]?.episodes;
    return `
      <div class="season-input-wrapper">
        <div class="season-number">S${season}</div>
        <input
          type="number"
          class="input season-input"
          min="0"
          max="5000"
          value="${(typeof prefillEp === 'number' ? prefillEp : defaultEp)}"
          data-season="${season}"
          inputmode="numeric"
          placeholder="Ep"
        >
      </div>
    `;
  }).join('');
  
  seasonsDetailGrid.classList.add('active');
}

function readSeasonsMeta() {
  const inputs = qsa('.season-input');
  const seasons = [];
  
  inputs.forEach(input => {
    const season = parseInt(input.dataset.season);
    const episodes = toIntOrNull(input.value, 0, 5000) || 0;
    seasons.push({ season, episodes });
  });
  
  return seasons;
}

// --------------------
// Poster Upload
// --------------------
posterUploadBtn.addEventListener('click', () => {
  posterFileInput.click();
});

posterPreviewLarge.addEventListener('click', () => {
  posterFileInput.click();
});

posterFileInput.addEventListener('change', () => {
  const file = posterFileInput.files?.[0];
  
  if (!file) {
    posterFile = null;
    resetPosterPreview();
    if (currentStep === 3 && btnNextText) btnNextText.textContent = i18nT("Salta");
    return;
  }
  
  if (file.size > 5 * 1024 * 1024) {
    toast('File troppo grande (max 5MB)');
    posterFileInput.value = '';
    posterFile = null;
    resetPosterPreview();
    return;
  }
  
  posterFile = file;
  showPosterPreview(file);
  if (currentStep === 3 && btnNextText) btnNextText.textContent = i18nT("Avanti");
});

function showPosterPreview(file) {
  const url = URL.createObjectURL(file);
  posterPreviewLarge.classList.add('has-image');
  posterPreviewLarge.innerHTML = `<img src="${escapeHtml(url)}" alt="Preview locandina" loading="lazy" decoding="async">`;
  
  const img = posterPreviewLarge.querySelector('img');
  if (img) {
    img.onload = () => URL.revokeObjectURL(url);
  }
}

function resetPosterPreview() {
  posterPreviewLarge.classList.remove('has-image');
  posterPreviewLarge.innerHTML = `
    <div class="poster-placeholder">
      <div class="poster-placeholder-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="5" width="18" height="16" rx="2" ry="2"></rect>
          <circle cx="8.5" cy="10" r="1.5"></circle>
          <path d="M21 16l-5-5L5 21"></path>
        </svg>
      </div>
      <div class="poster-placeholder-text">
        ${i18nT("Tocca per caricare")}<br>${i18nT("un'immagine")}
      </div>
    </div>
  `;
}

// --------------------
// Genres
// --------------------
async function loadGenres() {
  const dbGenres = await listGenres(400).catch(() => []);
  const merged = [...dbGenres];
  for (const g of tmdbGenreCatalog()) {
    if (!merged.find(x => x.id === g.id)) merged.push(g);
  }
  allGenres = merged;
  renderGenres();
}

function renderGenres(filterText = '') {
  // Use formData.genres as source of truth (survives DOM re-renders)
  const selected = new Set(formData.genres || []);
  const f = normalize(filterText);

  const filtered = f
    ? allGenres.filter(g => normalize(stripLeadingEmoji(g.name)).includes(f) || normalize(g.id).includes(f))
    : allGenres;

  if (filtered.length === 0) {
    genresGrid.innerHTML = `<div class="hint" style="grid-column: 1/-1;">${i18nT("Nessun genere trovato")}</div>`;
    return;
  }

  genresGrid.innerHTML = filtered.map(g => {
    const isSelected = selected.has(g.id);
    const label = stripLeadingEmoji(g.name);
    return `
      <label class="genre-option ${isSelected ? 'selected' : ''}" data-genre="${escapeHtml(g.id)}">
        <input type="checkbox" value="${escapeHtml(g.id)}" ${isSelected ? 'checked' : ''}>
        <div class="genre-option-label">${escapeHtml(label)}</div>
      </label>
    `;
  }).join('');

  // IMPORTANT:
  // The label element already toggles the checkbox by default.
  // If we ALSO toggle it manually on click, we end up flipping it twice
  // (net effect: nothing gets selected). So here we prevent the default
  // label-toggle only when clicking the "card" area and manage the state
  // ourselves, while keeping the checkbox change handler as source of truth.
  qsa('.genre-option').forEach(option => {
    const checkbox = option.querySelector('input');
    if (!checkbox) return;

    // Keep UI in sync when checkbox changes (keyboard/tap/click on the checkbox)
    checkbox.addEventListener('change', () => {
      option.classList.toggle('selected', checkbox.checked);
      // Sync to formData.genres immediately
      syncGenresToFormData();
    });

    // Clicking anywhere on the option (except the checkbox itself)
    // should toggle exactly once.
    option.addEventListener('click', (e) => {
      if (e.target === checkbox) return;
      e.preventDefault();
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
}

async function autoSelectImportedGenres(data) {
  const ensureGenresLoaded = async () => {
    if (!Array.isArray(allGenres) || !allGenres.length) {
      try {
        await loadGenres();
      } catch (_) {}
    }
  };

  await ensureGenresLoaded();
  const candidates = new Set(formData.genres || []);

  const addIfKnown = (idOrLabel) => {
    if (!idOrLabel || !allGenres) return;
    const norm = normalize(stripLeadingEmoji(idOrLabel));
    const match = allGenres.find(g => normalize(stripLeadingEmoji(g.name)) === norm || normalize(g.id) === norm);
    if (match) candidates.add(match.id);
  };

  if (Array.isArray(data.genreIds)) {
    data.genreIds.forEach((gid) => {
      const key = `tmdb_${gid}`;
      addIfKnown(key);
    });
  }

  if (Array.isArray(data.genreLabels)) {
    data.genreLabels.forEach(addIfKnown);
  }

  // Fallback: pick top 2 TMDB genres if still empty
  if (candidates.size === 0 && Array.isArray(data.genreIds) && data.genreIds.length) {
    data.genreIds.slice(0, 2).forEach((gid) => {
      const key = `tmdb_${gid}`;
      addIfKnown(key);
    });
  }

  formData.genres = Array.from(candidates).slice(0, 4);
  syncGenresToFormData();
  renderGenres(genreSearchInput?.value || '');
}

function syncGenresToFormData() {
  // Merge: keep genres selected in formData that are NOT visible in DOM,
  // plus the currently checked ones in DOM.
  const visibleIds = new Set([...qsa('.genre-option input')].map(cb => cb.value));
  const checkedIds = new Set([...qsa('.genre-option input:checked')].map(cb => cb.value));

  // Start from previous selection
  const merged = new Set(formData.genres || []);
  // For each visible genre: sync its state (add if checked, remove if unchecked)
  for (const id of visibleIds) {
    if (checkedIds.has(id)) {
      merged.add(id);
    } else {
      merged.delete(id);
    }
  }
  formData.genres = [...merged];
}

function getSelectedGenres() {
  return [...(formData.genres || [])];
}

genreSearchInput?.addEventListener('input', () => {
  renderGenres(genreSearchInput.value);
});

// Custom Genre Modal
function openCustomGenreModal() {
  if (!customGenreModal) return;
  customGenreModal.classList.add('active');
  customGenreName.value = '';
  releaseGenreTrap?.();
  releaseGenreTrap = trapFocus(customGenreModal, {
    initialFocus: '#customGenreName',
    onEscape: closeCustomGenreModal,
  });
  customGenreName.focus();
}

function closeCustomGenreModal() {
  if (!customGenreModal) return;
  customGenreModal.classList.remove('active');
  releaseGenreTrap?.();
  releaseGenreTrap = null;
}

addCustomGenreBtn?.addEventListener('click', openCustomGenreModal);

customGenreCancel?.addEventListener('click', closeCustomGenreModal);

customGenreModal?.querySelector('.custom-genre-backdrop')?.addEventListener('click', closeCustomGenreModal);

customGenreSave?.addEventListener('click', async () => {
  if (!isTrustedUser) {
    toast(i18nT("Per ora solo utenti trusted possono aggiungere nuovi generi. Puoi aggiungerlo più tardi o chiedere a un admin."));
    closeCustomGenreModal();
    return;
  }

  const name = customGenreName.value.trim();
  
  if (!name) {
    toast(i18nT("Inserisci un nome per il genere"));
    return;
  }
  
  try {
    customGenreSave.disabled = true;
    const created = await createGenre({ name, createdBy: currentUser.uid });

    // Add the new/existing genre to formData BEFORE re-rendering
    const id = created?.id;
    if (id && !formData.genres.includes(id)) {
      formData.genres.push(id);
    }

    await loadGenres();
    closeCustomGenreModal();
    toast(created?.existed ? i18nT("Genere già presente: selezionato!") : 'Genere aggiunto!');
  } catch (err) {
    console.error(err);
    toast(err?.message || i18nT('Errore aggiunta genere'));
  } finally {
    customGenreSave.disabled = false;
  }
});

// --------------------
// People pickers (directors / cast) - optional
// --------------------
function uniqueByIdOrName(list){
  const seen = new Set();
  const out = [];
  for (const p of list || []) {
    const key = (p?.id ? `id:${p.id}` : `name:${normalize(p?.name)}`);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function renderPeopleChips(container, list, onRemove){
  if (!container) return;
  const items = list || [];
  if (items.length === 0) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = items.map((p, idx) => {
    const exists = p?.id ? `<span class="exists" title="${i18nT("Già nel database")}" aria-label="${i18nT("Già nel database")}">✓</span>` : '';
    const avatarUrl = p?.avatarUrl || p?.avatar?.url || '';
    const avatarInner = renderPersonAvatarInner(avatarUrl, p?.name);
    return `<span class="person-chip" data-idx="${idx}">
      <span class="chip-avatar">${avatarInner}</span>
      <span class="chip-name">${escapeHtml(p.name)}</span>
      ${exists}
      <button type="button" aria-label="${i18nT("Rimuovi")}">×</button>
    </span>`;
  }).join('');

  container.querySelectorAll('.person-chip button').forEach((btn, i) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onRemove(i);
    });
  });
}

function setupPeoplePicker({ searchInput, resultsEl, selectedEl, role, getList, setList }){
  if (!searchInput || !resultsEl || !selectedEl) return;
  let lastTerm = '';
  let t = null;

  const hide = () => {
  resultsEl.style.display = 'none';
  resultsEl.innerHTML = '';
};

const show = () => {
  resultsEl.style.display = 'block';
};

  const renderSelected = () => {
    renderPeopleChips(selectedEl, getList(), (idx) => {
      const next = [...getList()];
      next.splice(idx, 1);
      setList(uniqueByIdOrName(next));
      renderSelected();
    });
  };

  const renderResults = (term, results) => {
    const items = Array.isArray(results) ? results : [];
    const normalizedTerm = String(term || '').trim();

    const rows = items.map(p => {
      const avatarUrl = p?.avatarUrl || p?.avatar?.url || '';
      const avatarInner = renderPersonAvatarInner(avatarUrl, p?.name);
      const roles = Array.isArray(p?.roles) ? p.roles.filter(Boolean) : [];
      const sub = roles.length ? roles.join(', ') : '';

      return `<div class="people-item" data-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}" data-avatar="${escapeHtml(avatarUrl)}" data-wikidata="${escapeHtml(p?.wikidataId || '')}">
        <span class="person-avatar">${avatarInner}</span>
        <div class="people-text">
          <div class="name">${escapeHtml(p.name)}</div>
          ${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ''}
        </div>
        <div class="meta">Seleziona</div>
      </div>`;
    });

    if (normalizedTerm.length >= 2) {
      rows.push(`<div class="people-item" data-add="1" data-name="${escapeHtml(normalizedTerm)}">
        <span class="person-avatar"><span class="avatar-fallback" aria-hidden="true">+</span></span>
        <div class="people-text">
          <div class="name">Aggiungi “${escapeHtml(normalizedTerm)}”</div>
        </div>
        <div class="meta">Nuova persona</div>
      </div>`);
    }

    resultsEl.innerHTML = rows.join('') || `<div class="people-item" data-add="1" data-name="${escapeHtml(normalizedTerm)}">
      <span class="person-avatar"><span class="avatar-fallback" aria-hidden="true">+</span></span>
      <div class="people-text">
        <div class="name">Aggiungi “${escapeHtml(normalizedTerm)}”</div>
      </div>
      <div class="meta">Nuova persona</div>
    </div>`;

    show();
  };

  const search = async (term) => {
    const q = String(term || '').trim();
    if (!q) {
      hide();
      return;
    }
    const prefix = normalize(q);
    if (!prefix) {
      hide();
      return;
    }
    try {
      const res = await searchPeopleByPrefix(prefix, { max: 8, role: role || 'all' });
      renderResults(q, res);
    } catch (err) {
      console.error(err);
      hide();
    }
  };

  const addSelected = async ({ id, name, avatarUrl = null, wikidataId = null }) => {
    const current = getList();
    const next = uniqueByIdOrName([...current, { id: id || null, name, avatarUrl: avatarUrl || null, wikidataId: wikidataId || null }]);
    setList(next);
    renderSelected();
  };

  resultsEl.addEventListener('click', async (e) => {
    const row = e.target?.closest?.('.people-item');
    if (!row) return;
    const isAdd = row.getAttribute('data-add') === '1';
    const name = String(row.getAttribute('data-name') || '').trim();
    const id = row.getAttribute('data-id');
    const avatarUrl = row.getAttribute('data-avatar');
    const wikidataId = row.getAttribute('data-wikidata');

    if (!name) return;

    if (isAdd) {
      // Try create in /people; if not permitted, we still save as plain text.
      let createdId = null;
      let createdAvatar = null;
      try {
        const created = await createPerson({ name, roles: role && role !== 'all' ? [role] : [], wikidataId: wikidataId || null });
        createdId = created?.id || null;
        createdAvatar = created?.avatarUrl || null;
      } catch (err) {
        console.warn('createPerson failed, falling back to plain name', err);
      }
      await addSelected({ id: createdId, name, avatarUrl: createdAvatar, wikidataId: wikidataId || null });
    } else {
      await addSelected({ id, name, avatarUrl: avatarUrl || null, wikidataId: wikidataId || null });
    }

    searchInput.value = '';
    hide();
  });

  searchInput.addEventListener('input', () => {
    const term = searchInput.value;
    if (term === lastTerm) return;
    lastTerm = term;
    clearTimeout(t);
    t = setTimeout(() => search(term), 180);
  });

  searchInput.addEventListener('focus', () => {
    if (searchInput.value.trim()) search(searchInput.value);
  });

  document.addEventListener('click', (e) => {
    if (e.target?.closest?.('.people-picker') === selectedEl.closest('.people-picker')) return;
    hide();
  });

  renderSelected();

  return { renderSelected, hide };
}

let peoplePickersInited = false;
let directorPicker = null;
let castPicker = null;

function initPeoplePickers(){
  if (peoplePickersInited) return;
  peoplePickersInited = true;
  directorPicker = setupPeoplePicker({
    searchInput: directorSearchInput,
    resultsEl: directorResults,
    selectedEl: directorsSelected,
    role: 'director',
    getList: () => formData.directorsPeople,
    setList: (v) => { formData.directorsPeople = v; },
  });
  castPicker = setupPeoplePicker({
    searchInput: castSearchInput,
    resultsEl: castResults,
    selectedEl: castSelected,
    role: 'actor',
    getList: () => formData.castPeople,
    setList: (v) => { formData.castPeople = v; },
  });
}

function refreshPeopleChips() {
  directorPicker?.renderSelected?.();
  castPicker?.renderSelected?.();
}

// Try to match imported people against existing /people documents.
// This is only for UX (showing the green ✓ chip); creation still happens on submit.
async function resolvePeopleIdsForList(list, role) {
  const out = [];
  for (const p of (list || [])) {
    if (!p?.name) continue;
    if (p.id) {
      out.push(p);
      continue;
    }
    const term = String(p.name).trim();
    const prefix = normalize(term);
    if (!prefix) {
      out.push({ id: null, name: term });
      continue;
    }
    try {
      const res = await searchPeopleByPrefix(prefix, { max: 8, role: role || 'all' });
      const exact = (res || []).find(r => normalize(r?.name) === normalize(term));
      if (exact?.id) {
        out.push({ id: exact.id, name: exact.name || term });
      } else {
        out.push({ id: null, name: term });
      }
    } catch {
      out.push({ id: null, name: term });
    }
  }
  return uniqueByIdOrName(out);
}

async function resolveImportedPeopleIds() {
  const [directors, cast] = await Promise.all([
    resolvePeopleIdsForList(formData.directorsPeople, 'director'),
    resolvePeopleIdsForList(formData.castPeople, 'actor'),
  ]);
  formData.directorsPeople = directors;
  formData.castPeople = cast;
  refreshPeopleChips();
}

// --------------------
// Review Step
// --------------------
function updateReviewStep() {
  // Poster
  if (posterFile) {
    const url = URL.createObjectURL(posterFile);
    reviewPoster.innerHTML = `<img src="${escapeHtml(url)}" alt="Locandina" loading="lazy" decoding="async">`;
  } else {
    reviewPoster.innerHTML = `
      <div class="review-poster-placeholder" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 7h16"></path>
          <path d="M4 17h16"></path>
          <path d="M7 7l2 10"></path>
          <path d="M12 7l2 10"></path>
          <path d="M17 7l2 10"></path>
        </svg>
      </div>
    `;
  }
  
  // Title & Meta
  reviewTitle.textContent = formData.name || '-';
  
  const typeText = formData.type === 'movie' ? i18nT("Film") : i18nT("Serie TV");
  const yearText = formData.year ? ` • ${formData.year}` : '';
  reviewTypeYear.textContent = `${typeText}${yearText}`;
  
  // Genres
  reviewGenres.innerHTML = formData.genres.map(genreId => {
    const genre = allGenres.find(g => g.id === genreId);
    const label = stripLeadingEmoji(genre?.name || genreId);
    return `<span class="chip">${escapeHtml(label)}</span>`;
  }).join('');
  
  // Details
  const details = [];
  
  if (formData.type === 'movie' && formData.durationMovie) {
    details.push({ label: 'Durata', value: `${formData.durationMovie} min` });
  }
  
  if (formData.type === 'tv') {
    if (formData.seasonsCount) {
      details.push({ label: i18nT('Stagioni'), value: formData.seasonsCount });
    }
    if (formData.seasons?.length) {
      const seasons = formData.seasons;
      const first = seasons[0]?.episodes || 0;
      const allSame = seasons.every(s => (s?.episodes || 0) === first);
      if (allSame && first > 0) {
        details.push({ label: i18nT("Episodi per stagione"), value: first });
      } else {
        const preview = seasons
          .slice(0, 6)
          .map(s => `S${s.season}: ${s.episodes}`)
          .join(', ');
        details.push({ label: i18nT("Episodi (per stagione)"), value: `${preview}${seasons.length > 6 ? '…' : ''}` });
      }
    } else if (formData.episodesPerSeason) {
      details.push({ label: i18nT("Episodi per stagione"), value: formData.episodesPerSeason });
    }
    if (formData.durationEpisode) {
      details.push({ label: i18nT('Durata episodio'), value: `${formData.durationEpisode} min` });
    }
  }
  
  if (formData.originalName) {
    details.push({ label: i18nT('Titolo originale'), value: formData.originalName });
  }
  if (formData.language) {
    details.push({ label: i18nT("Lingua"), value: formData.language });
  }
  if (formData.country) {
    details.push({ label: 'Paese', value: formData.country });
  }
  if (formData.network) {
    details.push({ label: 'Piattaforma', value: formData.network });
  }
  if (formData.directorsPeople?.length) {
    const names = formData.directorsPeople.map(p => p.name).join(', ');
    const dbCount = formData.directorsPeople.filter(p => p.id).length;
    const hint = dbCount ? ` (✓ ${dbCount})` : '';
    details.push({ label: i18nT("Regia"), value: `${names}${hint}` });
  }
  if (formData.castPeople?.length) {
    const names = formData.castPeople.map(p => p.name).join(', ');
    const dbCount = formData.castPeople.filter(p => p.id).length;
    const hint = dbCount ? ` (✓ ${dbCount}/${formData.castPeople.length})` : '';
    details.push({ label: 'Attori', value: `${names}${hint}` });
  }

  reviewDetails.innerHTML = details.map(d => `
    <div class="review-detail-row">
      <div class="review-detail-label">${escapeHtml(d.label)}</div>
      <div class="review-detail-value">${escapeHtml(String(d.value))}</div>
    </div>
  `).join('');
}

reviewEditBtn?.addEventListener('click', () => {
  goToStep(1);
});

// --------------------
// Submit Form
// --------------------
async function submitForm() {
  try {
    btnNext.disabled = true;
    btnNextText.textContent = i18nT("Salvataggio...");

    const sourceTmdbId = Number(formData.sourceTmdb?.tmdbId || 0) || null;
    const sourceTmdbType = formData.sourceTmdb?.mediaType === "tv" ? "tv" : "movie";

    if (sourceTmdbId) {
      const existingByTmdb = await findTitleByTmdbId(sourceTmdbId, sourceTmdbType, { uid: currentUser.uid });
      if (existingByTmdb) {
        toast(i18nT("Questo titolo esiste già nel database!"));
        btnNext.disabled = false;
        btnNextText.textContent = i18nT("Salva");
        setTimeout(() => {
          window.location.href = `/title.html?id=${existingByTmdb.id}`;
        }, 600);
        return;
      }
    }
    
    // Check duplicates
    const dedupeKey = makeDedupeKey({
      name: formData.name,
      year: formData.year,
      type: formData.type
    });
    
    const existing = await findTitleByDedupeKey(dedupeKey, { uid: currentUser.uid });
    if (existing) {
      toast(i18nT("Questo titolo esiste già nel database!"));
      btnNext.disabled = false;
      btnNextText.textContent = i18nT("Salva");
      setTimeout(() => {
        window.location.href = `/title.html?id=${existing.id}`;
      }, 1000);
      return;
    }
    
    // Build meta
    const meta = {};
    
    if (formData.type === 'movie' && formData.durationMovie) {
      meta.durationMovie = formData.durationMovie;
    }
    
    if (formData.type === 'tv') {
      if (formData.durationEpisode) meta.durationEpisode = formData.durationEpisode;
      if (formData.seasons.length) {
        meta.seasons = formData.seasons;
        meta.seasonsCount = formData.seasons.length;
        
        const first = formData.seasons[0]?.episodes || 0;
        const allSame = formData.seasons.every(s => s.episodes === first);
        if (allSame && first > 0) {
          meta.episodesPerSeason = first;
        }
      } else {
        if (formData.seasonsCount) meta.seasonsCount = formData.seasonsCount;
        if (formData.episodesPerSeason) meta.episodesPerSeason = formData.episodesPerSeason;

        // Robust fallback: if user gave seasonsCount + episodesPerSeason,
        // always materialize meta.seasons so votes/episode UI can render.
        if (formData.seasonsCount && formData.episodesPerSeason) {
          meta.seasons = Array.from({ length: formData.seasonsCount }, (_, i) => ({
            season: i + 1,
            episodes: formData.episodesPerSeason,
          }));
        }
      }
    }
    
    if (formData.language) meta.language = formData.language;
    if (formData.country) meta.country = formData.country;
    if (formData.network) meta.network = formData.network;
    if (sourceTmdbId) {
      meta.tmdbId = sourceTmdbId;
      meta.mediaType = sourceTmdbType;
      if (!meta.source) meta.source = "tmdb-add-title";
    }
    
    const trusted = isTrustedUserDoc(myUserDoc);
    if (!trusted) {
      toast(i18nT("Solo gli utenti trusted possono aggiungere nuovi titoli."));
      btnNext.disabled = false;
      btnNextText.textContent = i18nT("Salva");
      return;
    }
    const userLevel = getUserLevel(myUserDoc);
    const status = (userLevel === "associate" || userLevel === "doctor") ? "approved" : "pending";

    // If trusted, ensure any "tmp_" or missing people get created now.
    // This happens mainly for Wikipedia imports or manual free-text inserts.
    async function materializeMissingPeople(list, role) {
      if (!trusted) return;
      const arr = Array.isArray(list) ? list : [];

      // Deduplicate creates by normalized name (avoid double docs)
      const missingByKey = new Map();
      for (const p of arr) {
        const id = p?.id ? String(p.id) : "";
        if (id && !id.startsWith("tmp_")) continue;
        const key = normalize(p?.name || "");
        if (!key) continue;
        if (!missingByKey.has(key)) missingByKey.set(key, p);
      }

      const createdByKey = new Map();
      for (const [key, p] of missingByKey.entries()) {
        try {
          const created = await createPerson({
            name: p.name,
            role,
            wikidataId: p.wikidataId || null,
            skipAvatar: true,
          });
          createdByKey.set(key, created);
        } catch (e) {
          console.warn("createPerson failed:", e);
        }
      }

      for (let i = 0; i < arr.length; i++) {
        const p = arr[i];
        const id = p?.id ? String(p.id) : "";
        if (id && !id.startsWith("tmp_")) continue;
        const key = normalize(p?.name || "");
        const created = createdByKey.get(key);
        if (created?.id) {
          arr[i] = {
            ...p,
            id: created.id,
            avatarUrl: created.avatarUrl || p.avatarUrl || null,
            wikidataId: created.avatar?.wikidataId || created.wikidataId || p.wikidataId || null,
          };
        }
      }
    }

    await Promise.all([
      materializeMissingPeople(formData.directorsPeople, "director"),
      materializeMissingPeople(formData.castPeople, "actor"),
    ]);

    const directorIds = (formData.directorsPeople || [])
      .map(p => p.id)
      .filter(id => id && !String(id).startsWith("tmp_"));

    const castIds = (formData.castPeople || [])
      .map(p => p.id)
      .filter(id => id && !String(id).startsWith("tmp_"));
    
    // Create title
    const created = await createTitle({
      name: formData.name,
      type: formData.type,
      year: formData.year,
      genres: formData.genres,
      originalName: formData.originalName || null,
      aliases: formData.aliases,
      directors: (formData.directorsPeople || []).map(p => p.name).filter(Boolean),
      directorIds,
      cast: (formData.castPeople || []).map(p => p.name).filter(Boolean),
      castIds,
      status,
      createdBy: currentUser.uid,
      dedupeKey,
      meta,
      description: formData.description || null,
      tmdbId: sourceTmdbId,
      docId: sourceTmdbId ? tmdbTitleDocId(sourceTmdbType || formData.type, sourceTmdbId) : null,
    });

    if (created?.existed) {
      toast(i18nT("Questo titolo esiste già nel database!"));
      setTimeout(() => {
        window.location.href = `/title.html?id=${created.id}`;
      }, 600);
      return;
    }

    // Bump occurrences (fire-and-forget).
    bumpPeopleOccurrences([...directorIds, ...castIds], { delta: 1 }).catch(() => {});

    // Fire-and-forget avatar resolution for newly created people.
    // Avatars were skipped during save for speed; they'll resolve in background.
    for (const p of [...(formData.directorsPeople || []), ...(formData.castPeople || [])]) {
      if (p?.id && !String(p.id).startsWith("tmp_")) {
        ensurePersonAvatar(p.id, { name: p.name, wikidataId: p.wikidataId || null }).catch(() => {});
      }
    }
    
    // Upload poster (manual file takes priority over TMDB URL)
    if (posterFile) {
      btnNextText.textContent = i18nT('Upload poster...');
      const upload = await uploadPoster({
        file: posterFile,
        titleIdOrTemp: created.id,
        uid: currentUser.uid
      });

      await updateTitle(created.id, {
        posterPath: upload.url,
        posterStoragePath: upload.path
      });
    } else if (wikiImportContext?.thumbnailUrl) {
      // Auto-download poster from TMDB (or Wikipedia)
      btnNextText.textContent = 'Download poster...';
      try {
        const upload = await uploadPosterFromUrl({
          url: wikiImportContext.thumbnailUrl,
          titleIdOrTemp: created.id,
          uid: currentUser.uid
        });
        await updateTitle(created.id, {
          posterPath: upload.url,
          posterStoragePath: upload.path
        });
      } catch (posterErr) {
        console.warn('Auto poster download failed (non-blocking):', posterErr);
      }
    }
    
    toast(status === "approved" ? "Contenuto aggiunto!" : i18nT("Inviato! Verrà approvato presto"));
    
    setTimeout(() => {
      window.location.href = `/title.html?id=${created.id}`;
    }, 500);
    
  } catch (err) {
    console.error(err);
    toast(err?.message || i18nT("Errore durante il salvataggio"));
    btnNext.disabled = false;
    btnNextText.textContent = i18nT("Salva");
  }
}

// --------------------
// Wikipedia Import (Step 0)
// --------------------

// Mode card selection
importModeCards.forEach(card => {
  card.addEventListener('click', () => {
    const mode = card.getAttribute('data-mode');
    importMode = mode;
    importModeCards.forEach(c => c.classList.toggle('selected', c === card));

    // Show/hide panels
    if (wikiSearchPanel) wikiSearchPanel.style.display = mode === 'search' ? 'block' : 'none';
    if (wikiLinkPanel) wikiLinkPanel.style.display = mode === 'link' ? 'block' : 'none';
    if (tmdbSearchPanel) tmdbSearchPanel.style.display = mode === 'tmdb' ? 'block' : 'none';
    if (wikiStatus) { wikiStatus.style.display = 'none'; wikiStatus.className = 'wiki-status'; }
    if (wikiSearchResults) wikiSearchResults.style.display = 'none';
    if (tmdbSearchResults) tmdbSearchResults.style.display = 'none';

    // If the user goes back to manual, reset any previous wiki import context
    if (mode === 'manual') {
      wikiImportedData = null;
      wikiGenreLabels = [];
      formData.sourceTmdb = null;
      if (wikiGenreSuggestions) wikiGenreSuggestions.style.display = 'none';
      if (wikiImportPreview) wikiImportPreview.style.display = 'none';
    }

    // Show/hide "Inizia" button based on mode
    if (btnNext) btnNext.style.display = mode === 'manual' ? 'flex' : 'none';
  });
});

// Wiki type selector
wikiTypeOptions.forEach(opt => {
  opt.addEventListener('click', () => {
    wikiTypeOptions.forEach(o => o.classList.remove('selected'));
    opt.classList.add('selected');
  });
});

// Enable/disable search button
wikiSearchInput?.addEventListener('input', () => {
  if (wikiSearchBtn) wikiSearchBtn.disabled = !wikiSearchInput.value.trim();
});

// Enter key triggers search
wikiSearchInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && wikiSearchBtn && !wikiSearchBtn.disabled) {
    e.preventDefault();
    wikiSearchBtn.click();
  }
});

// Enable/disable link button
wikiLinkInput?.addEventListener('input', () => {
  if (wikiLinkBtn) wikiLinkBtn.disabled = !wikiLinkInput.value.trim();
});

// Enter key triggers link import
wikiLinkInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && wikiLinkBtn && !wikiLinkBtn.disabled) {
    e.preventDefault();
    wikiLinkBtn.click();
  }
});

// Search Wikipedia
wikiSearchBtn?.addEventListener('click', async () => {
  const term = wikiSearchInput?.value?.trim();
  if (!term) return;

  const typeRadio = document.querySelector('input[name="wikiType"]:checked');
  const type = typeRadio?.value || 'movie';

  wikiSearchBtn.disabled = true;
  wikiSearchBtnText.textContent = 'Cerco...';
  showWikiStatus(i18nT('Ricerca su Wikipedia...'), 'loading');

  try {
    // IT first (marketing + UX), but refine results using Wikidata instance-of
    // so we don't show actor pages etc. If refined results are empty, fallback to EN.
    const searchAndRefine = async (lang) => {
      const base = await searchWikipedia(term, type, lang);
      if (!base.length) return [];
      const refined = await refineWikipediaSearchResults(base, type, lang);
      return Array.isArray(refined) ? refined : [];
    };

    let lang = 'it';
    let results = await searchAndRefine(lang);
    if (!results.length) {
      showWikiStatus(i18nT("Non trovo nulla in italiano… provo in inglese"), 'loading');
      lang = 'en';
      results = await searchAndRefine(lang);
    }
    hideWikiStatus();

    if (!results.length) {
      showWikiStatus(i18nT("Nessun risultato trovato. Prova con un altro termine."), 'error');
      if (wikiSearchResults) wikiSearchResults.style.display = 'none';
      return;
    }

    // Keep track of the language used for each result.
    const enriched = results.map(r => ({ ...r, _lang: lang }));
    renderWikiResults(enriched, type);
  } catch (err) {
    console.error('Wiki search failed:', err);
    showWikiStatus(i18nT('Errore nella ricerca. Riprova.'), 'error');
  } finally {
    wikiSearchBtn.disabled = false;
    wikiSearchBtnText.textContent = i18nT("Cerca");
  }
});

// Link Wikipedia import
wikiLinkBtn?.addEventListener('click', async () => {
  const url = wikiLinkInput?.value?.trim();
  if (!url) return;

  const parsed = parseWikipediaUrl(url);
  if (!parsed.valid) {
    showWikiStatus(i18nT("URL non valido. Usa un link Wikipedia (es. https://it.wikipedia.org/wiki/...)"), 'error');
    return;
  }

  wikiLinkBtn.disabled = true;
  wikiLinkBtnText.textContent = 'Importo...';
  showWikiStatus('Importazione in corso...', 'loading');

  try {
    // Store context for preview (thumbnail etc.)
    wikiImportContext = { pageTitle: parsed.pageTitle, lang: parsed.language, thumbnailUrl: '' };
    try {
      const summary = await getWikipediaSummary(parsed.pageTitle, parsed.language);
      wikiImportContext.thumbnailUrl = summary?.thumbnailUrl || '';
    } catch {
      // ignore
    }

    const data = await importFromUrl(url);
    await applyWikiImport(data);
  } catch (err) {
    console.error('Wiki link import failed:', err);
    const fallbackTitle = parsed?.pageTitle?.replace(/_/g, ' ')?.replace(/\s*\([^)]*\)/g, '') || '';
    showWikiStatusWithFallback(err.message || i18nT('Errore nell\'importazione. Riprova.'), fallbackTitle);
  } finally {
    wikiLinkBtn.disabled = false;
    wikiLinkBtnText.textContent = 'Importa';
  }
});

// --------------------
// TMDB Import (Step 0)
// --------------------

tmdbSearchInput?.addEventListener('input', () => {
  if (tmdbSearchBtn) tmdbSearchBtn.disabled = !tmdbSearchInput.value.trim();
});

tmdbSearchInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && tmdbSearchBtn && !tmdbSearchBtn.disabled) {
    e.preventDefault();
    tmdbSearchBtn.click();
  }
});

tmdbSearchBtn?.addEventListener('click', async () => {
  const term = tmdbSearchInput?.value?.trim();
  if (!term) return;

  tmdbSearchBtn.disabled = true;
  tmdbSearchBtnText.textContent = 'Cerco...';
  showWikiStatus(i18nT('Ricerca su TMDB...'), 'loading');

  try {
    const results = await searchTmdb(term);
    hideWikiStatus();

    if (!results.length) {
      showWikiStatus(i18nT("Nessun risultato su TMDB. Prova con un altro termine."), 'error');
      if (tmdbSearchResults) tmdbSearchResults.style.display = 'none';
      return;
    }

    renderTmdbResults(results);
  } catch (err) {
    console.error('TMDB search failed:', err);
    showWikiStatus(i18nT('Errore nella ricerca TMDB. Riprova.'), 'error');
  } finally {
    tmdbSearchBtn.disabled = false;
    tmdbSearchBtnText.textContent = i18nT("Cerca");
  }
});

function renderTmdbResults(results) {
  if (!tmdbSearchResults) return;

  tmdbSearchResults.innerHTML = results.map((r, i) => {
    const typeChip = r.mediaType === 'tv' ? i18nT("Serie TV") : i18nT("Film");
    const yearChip = r.year || '';
    const thumbUrl = r.posterPath ? getTmdbImageUrl(r.posterPath, 'w92') : '';

    return `
      <div class="wiki-result-item" data-index="${i}">
        <div class="wiki-result-left">
          <div class="wiki-result-thumb" aria-hidden="true">
            ${thumbUrl ? `<img src="${escapeHtml(thumbUrl)}" alt="" loading="lazy">` : ''}
          </div>
          <div class="wiki-result-text">
            <div class="wiki-result-title">${escapeHtml(r.title)}</div>
            <div class="wiki-result-meta">
              <span class="wiki-type-chip">${escapeHtml(typeChip)}</span>
              ${yearChip ? `<span class="wiki-year-chip">${escapeHtml(yearChip)}</span>` : ''}
              <span class="wiki-lang-chip tmdb-source">${i18nT("TMDB")}</span>
            </div>
            <div class="wiki-result-snippet">${escapeHtml((r.overview || '').substring(0, 120))}${(r.overview || '').length > 120 ? '...' : ''}</div>
          </div>
        </div>
        <div class="wiki-result-arrow">&#x203A;</div>
      </div>
    `;
  }).join('');
  tmdbSearchResults.style.display = 'block';

  // Click handler: import selected result
  tmdbSearchResults.querySelectorAll('.wiki-result-item').forEach(item => {
    item.addEventListener('click', async () => {
      const idx = parseInt(item.getAttribute('data-index'), 10);
      const result = results[idx];
      if (!result) return;

      showWikiStatus(i18nT('Importazione dati da TMDB...'), 'loading');
      tmdbSearchResults.style.display = 'none';

      try {
        const data = await importFromTmdbResult(result);

        wikiImportContext = {
          pageTitle: result.title,
          lang: 'it',
          thumbnailUrl: data.posterUrl || '',
        };

        await applyWikiImport(data);
      } catch (err) {
        console.error('TMDB import failed:', err);
        showWikiStatusWithFallback(
          err.message || i18nT('Errore nell\'importazione da TMDB.'),
          result.title
        );
      }
    });
  });
}

/**
 * Shows a blocking duplicate warning during import.
 * Returns true if user wants to continue adding, false if they chose the existing title.
 */
function showImportDuplicateWarning(matches) {
  return new Promise((resolve) => {
    if (!wikiStatus) return resolve(true);

    const listHtml = matches.map(t => {
      const typeLabel = t.type === 'tv' ? i18nT("Serie TV") : i18nT("Film");
      const yearLabel = t.year ? ` (${t.year})` : '';
      return `<li style="margin: var(--space-xs) 0;">
        <a href="/title.html?id=${encodeURIComponent(t.id)}" class="duplicate-link" style="color: var(--brand-primary); text-decoration: underline;">
          ${escapeHtml(t.name)}${yearLabel} <span style="opacity:0.7;">${typeLabel}</span>
        </a>
      </li>`;
    }).join('');

    wikiStatus.innerHTML = `
      <div style="margin-bottom: var(--space-sm);">
        <strong>${i18nT("⚠️ Questo titolo potrebbe già esistere:")}</strong>
      </div>
      <ul style="list-style:none; padding:0; margin: var(--space-sm) 0;">${listHtml}</ul>
      <div style="display: flex; gap: var(--space-sm); margin-top: var(--space-md); flex-wrap: wrap;">
        <button type="button" class="btn ghost" id="dupeGoExisting" style="flex:1; min-width: 120px;">
          ${i18nT("È un duplicato")}
        </button>
        <button type="button" class="btn primary" id="dupeContinue" style="flex:1; min-width: 120px;">
          ${i18nT("Non è un duplicato, continua")}
        </button>
      </div>
    `;
    wikiStatus.className = 'wiki-status error';
    wikiStatus.style.display = 'block';

    const goBtn = wikiStatus.querySelector('#dupeGoExisting');
    const continueBtn = wikiStatus.querySelector('#dupeContinue');

    goBtn?.addEventListener('click', () => {
      // Navigate to the first match
      window.location.href = `/title.html?id=${encodeURIComponent(matches[0].id)}`;
      resolve(false);
    });

    continueBtn?.addEventListener('click', () => {
      hideWikiStatus();
      resolve(true);
    });
  });
}

function showWikiStatus(msg, type = '') {
  if (!wikiStatus) return;
  wikiStatus.textContent = msg;
  wikiStatus.className = 'wiki-status' + (type ? ` ${type}` : '');
  wikiStatus.style.display = 'block';
}

function hideWikiStatus() {
  if (!wikiStatus) return;
  wikiStatus.style.display = 'none';
}

function showWikiStatusWithFallback(errorMsg, fallbackTitle) {
  if (!wikiStatus) return;
  const cleanTitle = escapeHtml(String(fallbackTitle || '').trim());
  wikiStatus.innerHTML = `
    <div style="margin-bottom: var(--space-sm);">${escapeHtml(errorMsg)}</div>
    ${cleanTitle ? `<button type="button" class="btn ghost" id="wikiManualFallback" style="margin-top: var(--space-xs); font-size: var(--text-sm);">
      Prosegui manualmente con "${cleanTitle}"
    </button>` : ''}
  `;
  wikiStatus.className = 'wiki-status error';
  wikiStatus.style.display = 'block';

  const fallbackBtn = wikiStatus.querySelector('#wikiManualFallback');
  if (fallbackBtn) {
    fallbackBtn.addEventListener('click', () => {
      hideWikiStatus();
      importMode = 'manual';
      formData.name = fallbackTitle || '';
      if (nameInput) nameInput.value = formData.name;
      if (btnNext) btnNext.style.display = 'flex';
      currentStep = 1;
      showStep(1);
    });
  }
}

function renderWikiResults(results, type) {
  if (!wikiSearchResults) return;

  wikiSearchResults.innerHTML = results.map((r, i) => {
    const langChip = (r?._lang || 'it').toUpperCase();
    const detected = r?._detectedType || (type === 'tv' ? 'tv' : 'movie');
    const typeChip = detected === 'tv' ? i18nT("Serie TV") : i18nT("Film");
    const yearChip = r?._year ? String(r._year) : '';
    return `
      <div class="wiki-result-item" data-index="${i}">
        <div class="wiki-result-left">
          <div class="wiki-result-thumb" data-thumb="${i}" aria-hidden="true"></div>
          <div class="wiki-result-text">
            <div class="wiki-result-title">${escapeHtml(r.title)}</div>
            <div class="wiki-result-meta">
              <span class="wiki-type-chip">${escapeHtml(typeChip)}</span>
              ${yearChip ? `<span class="wiki-year-chip">${escapeHtml(yearChip)}</span>` : ''}
              <span class="wiki-lang-chip">${escapeHtml(langChip)}</span>
            </div>
            <div class="wiki-result-snippet">${escapeHtml(r.snippet)}</div>
          </div>
        </div>
        <div class="wiki-result-arrow">›</div>
      </div>
    `;
  }).join('');
  wikiSearchResults.style.display = 'block';

  // Prefetch thumbnails (nice "wow" without slowing down import).
  results.forEach(async (r, i) => {
    try {
      const lang = r?._lang || 'it';
      const summary = await getWikipediaSummary(r.title, lang);
      const thumbEl = wikiSearchResults.querySelector(`.wiki-result-thumb[data-thumb="${i}"]`);
      if (thumbEl && summary?.thumbnailUrl) {
        thumbEl.innerHTML = `<img src="${escapeHtml(summary.thumbnailUrl)}" alt="" loading="lazy">`;
      }
    } catch {
      // ignore
    }
  });

  // Click handler
  wikiSearchResults.querySelectorAll('.wiki-result-item').forEach(item => {
    item.addEventListener('click', async () => {
      const idx = parseInt(item.getAttribute('data-index'), 10);
      const result = results[idx];
      if (!result) return;

      showWikiStatus(i18nT('Importazione dati...'), 'loading');
      wikiSearchResults.style.display = 'none';

      try {
        const lang = result?._lang || 'it';
        // Store context for preview (thumbnail etc.)
        wikiImportContext = { pageTitle: result.title, lang, thumbnailUrl: '' };
        try {
          const summary = await getWikipediaSummary(result.title, lang);
          wikiImportContext.thumbnailUrl = summary?.thumbnailUrl || '';
        } catch {
          // ignore
        }

        const data = await importFromSearchResult(result, lang);
        await applyWikiImport(data);
      } catch (err) {
        console.error('Wiki import failed:', err);
        showWikiStatusWithFallback(err.message || i18nT('Errore nell\'importazione.'), result.title);
      }
    });
  });
}

async function applyWikiImport(data) {
  wikiImportedData = data;
  hideWikiStatus();

  // Fill formData from wiki data
  formData.name = data.name || '';
  formData.type = data.type || 'movie';
  formData.year = data.year || null;
  formData.originalName = data.originalName || '';
  formData.language = data.language || '';
  formData.country = data.country || '';
  formData.network = data.network || '';
  formData.description = data.description || '';
  formData.sourceTmdb = data.sourceTmdb || null;

  // --- Duplicate check (early, before filling the rest of the form) ---
  if (formData.name) {
    try {
      const importTmdbId = Number(formData.sourceTmdb?.tmdbId || 0) || null;
      const importTmdbType = formData.sourceTmdb?.mediaType === "tv" ? "tv" : formData.type;
      if (importTmdbId) {
        const existingByTmdb = await findTitleByTmdbId(importTmdbId, importTmdbType, { uid: currentUser?.uid || null });
        if (existingByTmdb) {
          const keepGoing = await showImportDuplicateWarning([existingByTmdb]);
          if (!keepGoing) return;
        }
      }

      const results = await searchTitlesSmart(formData.name, 5);
      const matches = results.filter(t => {
        const sameName = normalize(t.name) === normalize(formData.name);
        const sameYear = !formData.year || !t.year || t.year === formData.year;
        return sameName && sameYear;
      });
      if (matches.length > 0) {
        const keepGoing = await showImportDuplicateWarning(matches);
        if (!keepGoing) return; // User chose to go to existing title
      }
    } catch (dupeErr) {
      console.warn('Duplicate check during import failed (non-blocking):', dupeErr);
    }
  }

  if (data.type === 'movie') {
    formData.durationMovie = data.durationMinutes || null;
    formData.durationEpisode = null;
    formData.seasonsCount = null;
    formData.episodesPerSeason = null;
    formData.seasons = [];
  } else {
    const seasonsMeta = Array.isArray(data.seasonsMeta) ? data.seasonsMeta : [];
    formData.seasons = seasonsMeta;
    formData.seasonsCount = data.numSeasons || (seasonsMeta.length || null);
    // Wikidata duration for TV series is usually the episode duration.
    formData.durationEpisode = data.durationMinutes || data.durationEpisode || null;
    // If all seasons share the same number of episodes, keep the simple mode.
    const allSame = seasonsMeta.length
      ? seasonsMeta.every(s => (s?.episodes || 0) === (seasonsMeta[0]?.episodes || 0))
      : false;
    formData.episodesPerSeason = data.episodesPerSeason || (allSame ? (seasonsMeta[0]?.episodes || null) : null);
    formData.durationMovie = null;
  }

  // Directors / Cast (max 10 actors)
  formData.directorsPeople = (data.directors || []).filter(Boolean).map(name => ({ id: null, name }));
  formData.castPeople = (data.cast || []).filter(Boolean).slice(0, 10).map(name => ({ id: null, name }));

  // Store genre labels for suggestions (NOT auto-selected)
  wikiGenreLabels = data.genreLabels || [];
  await autoSelectImportedGenres(data);

  // Keep the preview (Step 4) and recap (Step 2) up-to-date.
  // Wrap rendering in try/catch so a render bug never blocks step navigation.
  try {
    renderWikiImportPreview(data);
    renderWikiImportDetailsCard(data);
  } catch (renderErr) {
    console.warn('Wiki import render error (non-blocking):', renderErr);
  }

  // Fill form inputs so they reflect the data
  try {
    fillFormInputsFromData();
    updateDetailsStep();
  } catch (fillErr) {
    console.warn('fillFormInputsFromData error (non-blocking):', fillErr);
  }

  // Resolve people IDs in background (for the ✓ "already in DB" hint)
  resolveImportedPeopleIds()
    .then(() => {
      try { renderWikiImportDetailsCard(wikiImportedData); } catch {}
    })
    .catch(() => {});

  // Build a quality-aware toast message
  const importedFields = [];
  const missingFields = [];

  if (data.name) importedFields.push('titolo');
  if (data.year) importedFields.push('anno');
  else missingFields.push('anno');

  if (data.type === 'tv') {
    if (data.numSeasons) importedFields.push('stagioni');
    else missingFields.push('stagioni');
  } else {
    if (data.durationMinutes) importedFields.push('durata');
    else missingFields.push('durata');
  }

  const dirs = (data.directors || []).filter(Boolean);
  const actors = (data.cast || []).filter(Boolean);
  if (dirs.length) importedFields.push(`${dirs.length} regist${dirs.length === 1 ? 'a' : 'i'}`);
  if (actors.length) importedFields.push(`${actors.length} attor${actors.length === 1 ? 'e' : 'i'}`);
  if (!dirs.length) missingFields.push('regia');
  if (!actors.length) missingFields.push('cast');

  if (data._partial) {
    toast(i18nT("Import parziale: trovato solo il titolo. Completa i dettagli manualmente."));
  } else if (missingFields.length >= 3) {
    toast(i18nT("Pochi dati su Wikipedia: importati {v0}. Completa il resto manualmente.", { v0: importedFields.join(', ') || 'nome e tipo' }));
  } else if (missingFields.length > 0) {
    toast(`Importati ${importedFields.join(', ')}. Mancano: ${missingFields.join(', ')}.`);
  } else {
    toast(i18nT('Import completo! Controlla i dati e continua.'));
  }

  // Fast-track: vai direttamente alla review con dati precompilati (3 step percepiti)
  updateReviewStep();
  currentStep = totalSteps;
  showStep(currentStep);
}

function renderWikiImportPreview(data) {
  if (!wikiImportPreview || !wikiImportTitle || !wikiImportSub || !wikiImportThumb) return;
  if (!data) {
    wikiImportPreview.style.display = 'none';
    return;
  }

  wikiImportPreview.style.display = 'block';
  wikiImportTitle.textContent = data.name || formData.name || '';
  const typeLabel = (data.type || formData.type) === 'tv' ? i18nT("Serie TV") : i18nT("Film");
  const year = data.year || formData.year;
  const lang = data.language || formData.language;
  const country = data.country || formData.country;
  const bits = [typeLabel];
  if (year) bits.push(String(year));
  if (lang) bits.push(lang);
  if (country) bits.push(country);
  wikiImportSub.textContent = bits.join(' • ');

  if (wikiImportPeople) {
    const p = [];
    const directors = (data.directors || []).filter(Boolean);
    const cast = (data.cast || []).filter(Boolean);
    if (directors.length) p.push(`Regia: ${directors.slice(0, 2).join(', ')}${directors.length > 2 ? '…' : ''}`);
    if (cast.length) p.push(`Cast: ${cast.slice(0, 3).join(', ')}${cast.length > 3 ? '…' : ''}`);
    wikiImportPeople.textContent = p.join(' · ');
  }

  // Thumbnail for preview only (does NOT become the actual poster).
  const thumbUrl = wikiImportContext?.thumbnailUrl || '';
  if (thumbUrl) {
    wikiImportThumb.innerHTML = `<img src="${escapeHtml(thumbUrl)}" alt="" loading="lazy">`;
  } else {
    wikiImportThumb.innerHTML = `
      <div class="wiki-import-thumb-ph" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="5" width="18" height="16" rx="2" ry="2"></rect>
          <circle cx="8.5" cy="10" r="1.5"></circle>
          <path d="M21 16l-5-5L5 21"></path>
        </svg>
      </div>
    `;
  }
}

function renderWikiImportDetailsCard(data) {
  if (!wikiImportDetailsCard) return;
  if (!data) {
    wikiImportDetailsCard.style.display = 'none';
    wikiImportDetailsCard.innerHTML = '';
    return;
  }

  const typeLabel = data.type === 'tv' ? i18nT("Serie TV") : i18nT("Film");
  const year = data.year ? ` (${data.year})` : '';
  const lang = (wikiImportContext?.lang || data.lang || 'en').toUpperCase();

  const row = (label, value) => {
    if (value === null || value === undefined || value === '') return '';
    return `
      <div class="wiki-import-details-row">
        <div class="wiki-import-details-label">${escapeHtml(label)}</div>
        <div class="wiki-import-details-value">${escapeHtml(String(value))}</div>
      </div>
    `;
  };

  const directors = (formData.directorsPeople || []).map(p => p.name).filter(Boolean);
  const cast = (formData.castPeople || []).map(p => p.name).filter(Boolean);
  const directorsOk = (formData.directorsPeople || []).filter(p => p.id).length;
  const castOk = (formData.castPeople || []).filter(p => p.id).length;

  let seasonsBlock = '';
  if (data.type === 'tv') {
    const seasonsMeta = Array.isArray(formData.seasons) && formData.seasons.length
      ? formData.seasons
      : (Array.isArray(data.seasonsMeta) ? data.seasonsMeta : []);
    if (seasonsMeta.length) {
      const pills = seasonsMeta.slice(0, 14).map(s => {
        const ep = typeof s.episodes === 'number' ? s.episodes : 0;
        return `<span class="season-pill">S${s.season} · ${ep} ep</span>`;
      }).join('');
      seasonsBlock = `
        <div class="wiki-import-details-row">
          <div class="wiki-import-details-label">Episodi</div>
          <div class="wiki-import-details-value">
            <div class="season-pills" role="list">${pills}</div>
          </div>
        </div>
      `;
    } else {
      const eps = formData.episodesPerSeason || data.episodesPerSeason || null;
      if (eps) seasonsBlock = row(i18nT("Episodi per stagione"), eps);
    }
  }

  const genreHint = (wikiGenreLabels || data.genreLabels || []).slice(0, 6).filter(Boolean);
  const genreText = genreHint.length ? genreHint.join(', ') : '';

  const isPartial = data._partial;

  // Count what's filled vs missing for quality indicator
  const filled = [data.name, data.year, data.originalName, data.language, data.country].filter(Boolean).length;
  const hasPeople = directors.length + cast.length;
  const totalQuality = filled + (hasPeople > 0 ? 2 : 0) + (genreText ? 1 : 0);
  // 0-3 = poor, 4-6 = ok, 7+ = rich
  const qualityLabel = isPartial ? 'Parziale' : totalQuality >= 7 ? 'Completo' : totalQuality >= 4 ? 'Buono' : 'Minimo';
  const qualityClass = isPartial ? 'partial' : totalQuality >= 7 ? 'rich' : totalQuality >= 4 ? 'ok' : 'poor';

  // "missing" row helper – shows greyed-out placeholder for data Wikipedia didn't have
  const missingRow = (label) => `
    <div class="wiki-import-details-row missing">
      <div class="wiki-import-details-label">${escapeHtml(label)}</div>
      <div class="wiki-import-details-value wiki-missing">${i18nT("da compilare")}</div>
    </div>
  `;

  wikiImportDetailsCard.innerHTML = `
    <div class="wiki-import-details-head">
      <div>
        <div class="wiki-import-details-title">${i18nT("Import da Wikipedia")}</div>
        <div class="wiki-import-details-sub">${escapeHtml(typeLabel)}${escapeHtml(year)} · ${escapeHtml(lang)}</div>
      </div>
      <div class="wiki-import-details-badges">
        <span class="wiki-quality-badge ${qualityClass}">${qualityLabel}</span>
        <span class="ai-pill small" aria-label="${i18nT("AI powered")}">
          <span class="ai-sparkle" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2l1.6 5.4L19 9l-5.4 1.6L12 16l-1.6-5.4L5 9l5.4-1.6L12 2z"/>
              <path d="M4 14l.8 2.6L7 17.4l-2.2.8L4 21l-.8-2.8L1 17.4l2.2-.8L4 14z"/>
              <path d="M19 14l.8 2.6L22 17.4l-2.2.8L19 21l-.8-2.8L16.9 17.4l2.3-.8L19 14z"/>
            </svg>
          </span>
          <span>${i18nT("AI powered")}</span>
        </span>
      </div>
    </div>

    <div class="wiki-import-details-grid">
      ${row(i18nT('Titolo'), data.name || formData.name)}
      ${(data.originalName) ? row(i18nT('Titolo originale'), data.originalName) : ''}
      ${data.year ? row('Anno', data.year) : missingRow('Anno')}
      ${(data.language) ? row(i18nT("Lingua"), data.language) : ''}
      ${(data.country) ? row('Paese', data.country) : ''}
      ${(data.network) ? row('Piattaforma', data.network) : ''}
      ${data.type === 'movie' ? ((formData.durationMovie || data.durationMinutes) ? row('Durata', `${formData.durationMovie || data.durationMinutes} min`) : missingRow('Durata')) : ''}
      ${data.type === 'tv' ? ((formData.seasonsCount || data.numSeasons) ? row('Stagioni', formData.seasonsCount || data.numSeasons) : missingRow('Stagioni')) : ''}
      ${seasonsBlock}
      ${data.type === 'tv' ? ((formData.durationEpisode || data.durationMinutes) ? row(i18nT('Durata episodio'), `${formData.durationEpisode || data.durationMinutes} min`) : '') : ''}
      ${directors.length ? row(i18nT("Regia"), `${directors.join(', ')}${directorsOk ? ` (✓ ${directorsOk})` : ''}`) : missingRow(i18nT("Regia"))}
      ${cast.length ? row(i18nT("Cast"), `${cast.join(', ')}${castOk ? ` (✓ ${castOk}/${cast.length})` : ''}`) : missingRow(i18nT("Cast"))}
      ${genreText ? row('Generi suggeriti', genreText) : ''}
    </div>

    <div class="wiki-import-details-footer">
      ${qualityClass === 'poor' || isPartial
        ? i18nT("Wikipedia ha pochi dati per questo titolo. Compila i campi mancanti nei prossimi step.")
        : i18nT("La locandina non viene importata: puoi caricarla (o saltare) nel passo successivo.")}
    </div>
  `;
}

function fillFormInputsFromData() {
  // Step 1 inputs
  if (nameInput) nameInput.value = formData.name;
  const typeRadio = document.querySelector(`input[name="type"][value="${formData.type}"]`);
  if (typeRadio) {
    typeRadio.checked = true;
    typeOptions.forEach(opt => {
      const radio = opt.querySelector('input[type="radio"]');
      opt.classList.toggle('selected', radio?.checked);
    });
  }
  if (yearInput) yearInput.value = formData.year || '';

  // Step 2 inputs
  if (durationMovieInput) durationMovieInput.value = formData.durationMovie || '';
  if (seasonsCountInput) {
    const sc = formData.seasons?.length ? formData.seasons.length : (formData.seasonsCount || '');
    seasonsCountInput.value = sc || '';
  }
  if (episodesPerSeasonInput) episodesPerSeasonInput.value = formData.episodesPerSeason || '';
  if (durationEpisodeInput) durationEpisodeInput.value = formData.durationEpisode || '';

  // Prefill per-season episodes if available
  if (togglePerSeason && seasonsCountInput && seasonsDetailGrid) {
    const seasons = Array.isArray(formData.seasons) ? formData.seasons : [];
    if (seasons.length) {
      // If Wikipedia provided season-by-season episode counts, show them (even if all seasons are equal).
      const first = seasons[0]?.episodes || 0;
      togglePerSeason.checked = true;
      if (!episodesPerSeasonInput.value) episodesPerSeasonInput.value = first || 10;
      renderSeasonsDetailGrid();
    }
  }

  // Step 5 inputs
  if (originalNameInput) originalNameInput.value = formData.originalName || '';
  if (languageInput) languageInput.value = formData.language || '';
  if (countryInput) countryInput.value = formData.country || '';
  if (networkInput) networkInput.value = formData.network || '';

  // Re-render people chips
  refreshPeopleChips();
}

function showWikiGenreSuggestions() {
  if (!wikiGenreSuggestions || !wikiGenreSuggestionsList || !wikiGenreLabels.length) return;
  const cleanLabel = (label) => {
    let n = normalize(label);
    n = n.replace(/^film\s+/, '').replace(/^serie\s+tv\s+/, '').replace(/^serie\s+televisiva\s+/, '');
    n = n.replace(/^di\s+/, '').replace(/^d\s+/, '');
    return n.trim();
  };

  const findMatchId = (label) => {
    const n = cleanLabel(label);
    if (!n) return null;
    // Quick synonym normalization (helps when Wikipedia returns English labels)
    const synonyms = {
      'action': 'azione',
      'comedy': 'commedia',
      'drama': 'drammatico',
      'thriller': 'thriller',
      'horror': 'horror',
      'animation': 'animazione',
      'science fiction': 'fantascienza',
      'sci fi': 'fantascienza',
      'fantasy': 'fantasy',
      'romance': 'romantico',
      'romantic': 'romantico',
      'crime': 'crime',
      'mystery': 'mistero'
    };
    const n2 = synonyms[n] ? normalize(synonyms[n]) : n;

    // 1) exact / contains match on genre names
    for (const g of allGenres || []) {
      const gn = normalize(stripLeadingEmoji(g.name));
      if (!gn) continue;
      if (n2 === gn) return g.id;
    }
    for (const g of allGenres || []) {
      const gn = normalize(stripLeadingEmoji(g.name));
      if (!gn) continue;
      if (n2.includes(gn) || gn.includes(n2)) return g.id;
    }
    return null;
  };

  wikiGenreSuggestionsList.innerHTML = wikiGenreLabels.map(label => {
    const matchId = findMatchId(label);
    const attrs = matchId ? `data-genre="${escapeHtml(matchId)}"` : '';
    const cls = matchId ? 'wiki-genre-badge clickable' : 'wiki-genre-badge';
    return `<button type="button" class="${cls}" ${attrs}>${escapeHtml(label)}</button>`;
  }).join('');

  // Clicking a suggested genre toggles the matching existing genre.
  wikiGenreSuggestionsList.querySelectorAll('button[data-genre]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-genre');
      if (!id) return;
      const opt = qs(`.genre-option[data-genre="${CSS?.escape ? CSS.escape(id) : id}"]`);
      const cb = opt?.querySelector('input');
      if (!cb) return;
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
      opt.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });
  wikiGenreSuggestions.style.display = 'block';
}

// --------------------
// Navigation
// --------------------
btnNext?.addEventListener('click', nextStep);
btnBack?.addEventListener('click', prevStep);

// --------------------
// Auth
// --------------------
initAuthGuard({ requireAuth: false, onReady: async (user) => {
  currentUser = user;

  if (user) {
    await ensureUserDoc(user);
    myUserDoc = await getMyUserDoc(user.uid);
    isTrustedUser = isTrustedUserDoc(myUserDoc);
    if (addCustomGenreBtn) {
      addCustomGenreBtn.style.display = isTrustedUser ? "flex" : "none";
    }

    authGate.style.display = 'none';
    formContainer.style.display = 'block';
    floatingActions.style.display = 'flex';

    // Initialize
    generateYearButtons();
    await loadGenres();
    initPeoplePickers();
    showStep(0);

  } else {
    authGate.style.display = 'block';
    formContainer.style.display = 'none';
    floatingActions.style.display = 'none';
  }
}});

// Prefill from query
const urlParams = new URLSearchParams(location.search);
const urlQ = urlParams.get('q');
if (urlQ) nameInput.value = urlQ;

// Deep link: auto-import from TMDB (e.g. ?tmdb=12345&type=movie)
const urlTmdb = urlParams.get('tmdb');
const urlTmdbType = urlParams.get('type');
if (urlTmdb) {
  const waitForInit = setInterval(async () => {
    if (!currentUser || !allGenres.length) return;
    clearInterval(waitForInit);

    importMode = 'tmdb';
    showWikiStatus('Importazione da TMDB...', 'loading');

    try {
      const data = await importFromTmdbResult({
        tmdbId: parseInt(urlTmdb, 10),
        mediaType: urlTmdbType || 'movie',
      });
      wikiImportContext = {
        pageTitle: data.name,
        lang: 'it',
        thumbnailUrl: data.posterUrl || '',
      };
      await applyWikiImport(data);
    } catch (err) {
      console.error('TMDB auto-import failed:', err);
      showWikiStatus(i18nT('Errore importazione TMDB. Prova manualmente.'), 'error');
    }
  }, 200);
}
