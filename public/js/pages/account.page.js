import { qs, escapeHtml, fitProfileName } from "../utils/dom.js";
import { t as i18nT } from "../i18n/index.js";
import {
  getWatchTimeUnitMode,
  cycleWatchTimeUnitMode,
  renderWatchTimeInto,
} from "../utils/watchTimeUnit.js";
import { initTabbar } from "../utils/tabbar.js";
import { sanitizeInternalPath } from "../utils/url.js";
import { trapFocus } from "../utils/focusTrap.js";
import { toast } from "../components/toast.js";
import { mountNotificationPermissionBanner } from "../components/notifyPermissionBanner.js";
import {
  openAccountIdentityWizard,
  openAccountTasteWizard,
} from "../components/onboardingFlow.js";
import {
  logout,
  isAppleLinked,
  getLinkedProviderIds,
  startAppleLink,
  handleAppleLinkRedirectResult,
  getAppleLinkErrorMessage,
} from "../services/auth.service.js";
import { initAuthGuard } from "../components/authGuard.js";
import {
  ensureUserDoc,
  listUsersPublicByIds,
  listenFollowers,
  listenFollowing,
  listFollowers,
  listFollowing,
  getMyUserDoc,
  updatePhotoURL,
} from "../api/users.api.js";

import { uploadAvatar } from "../api/storage.api.js";

import { getMyWatchlist, removeFromWatchlist, markAsWatched } from "../api/watchlist.api.js";

import {
  listRecommendationsForMePage,
  listRecommendationsByMePage,
  markRecommendationAsViewed,
  archiveRecommendation,
} from "../api/recommendations.api.js";
import { getTitleById, getTitlesByIds, listTitlesByIds } from "../api/titles.api.js";
import { getPublicProfileActivitySummary, listMyLibrary } from "../api/library.api.js";
import { registerPushToken } from "../pushTokens.js";
import { getMatchQueue } from "../api/match.api.js";
import { listGenres, tmdbGenreCatalog } from "../api/genres.api.js";
import { getNotificationPrefs, setNotificationPrefs } from "../api/notifications.api.js";
import { listMyTitleRatings, upsertRating, countTitleRatings } from "../api/ratings.api.js";
import { showErrorBanner, hideErrorBanner } from "../utils/errorBanner.js";
import { showConfirm } from "../utils/confirmDialog.js";
import { runWithButtonLoading } from "../utils/loading.js";
import { auth } from "../firebase.js";
import { requestAccountDeletion, resumeAccountDeletionAfterReauth } from "../components/accountDeletion.js";
import { logEvent, setAnalyticsUser } from "../analytics.js";

initTabbar();

const btnSignOut = qs("#btnSignOut");
const btnEnablePush = qs("#btnEnablePush");
const avatar = qs("#avatar");
const avatarWrap = qs("#avatarWrap");
const avatarInput = qs("#avatarInput");
const btnAvatarUpload = qs("#btnAvatarUpload");
const avatarPreviewModal = qs("#avatarPreviewModal");
const avatarPreviewFrame = qs("#avatarPreviewFrame");
const btnAvatarChange = qs("#btnAvatarChange");
const btnCloseAvatarPreview = qs("#btnCloseAvatarPreview");
const avatarCropModal = qs("#avatarCropModal");
const avatarCropBackdrop = qs("#avatarCropBackdrop");
const avatarCropStage = qs("#avatarCropStage");
const avatarCropImage = qs("#avatarCropImage");
const avatarCropZoom = qs("#avatarCropZoom");
const avatarCropStatus = qs("#avatarCropStatus");
const btnAvatarCropClose = qs("#btnAvatarCropClose");
const btnAvatarCropCancel = qs("#btnAvatarCropCancel");
const btnAvatarCropConfirm = qs("#btnAvatarCropConfirm");
const meName = qs("#meName");
const meEmail = qs("#meEmail"); // will show @handle (not email)
const profileTagline = qs("#profileTagline");
const profileStatusBadge = qs("#profileStatusBadge");
const btnEditIdentity = qs("#btnEditIdentity");
const btnMenuShareProfile = qs("#btnMenuShareProfile");
const btnTuneTaste = qs("#btnTuneTaste");
const authProvidersCard = qs("#authProvidersCard");
const linkedProvidersList = qs("#linkedProvidersList");
const btnLinkApple = qs("#btnLinkApple");
const appleLinkedBadge = qs("#appleLinkedBadge");
const appleLinkFeedback = qs("#appleLinkFeedback");

// Stats
const statsWatched = qs("#statsWatched");
const statsReviews = qs("#statsReviews");
const statsReviewsHero = qs("#statsReviewsHero");
const statsDerivedRatings = qs("#statsDerivedRatings");
const statsFollowers = qs("#statsFollowers");
const statsFollowing = qs("#statsFollowing");
const statsFollowersBlock = qs("#statsFollowersBlock");
const statsFollowingBlock = qs("#statsFollowingBlock");
const connectionsModal = qs("#connectionsModal");
const btnCloseConnections = qs("#btnCloseConnections");
const connectionsTitle = qs("#connectionsTitle");
const connectionsSearchInput = qs("#connectionsSearchInput");
const connectionsList = qs("#connectionsList");
const profileMenuModal = qs("#profileMenuModal");
const btnProfileMenu = qs("#btnProfileMenu");
const btnCloseProfileMenu = qs("#btnCloseProfileMenu");
const btnMenuEditProfile = qs("#btnMenuEditProfile");
const btnMenuTuneTaste = qs("#btnMenuTuneTaste");
const btnMenuSignOut = qs("#btnMenuSignOut");

// Il container .page usa transform per l'animazione di ingresso.
// Spostando il modal direttamente sotto <body> evitiamo offset su mobile
// (fixed relativo alla pagina scrollata invece che al viewport).
if (connectionsModal && connectionsModal.parentElement !== document.body) {
  document.body.appendChild(connectionsModal);
}
if (profileMenuModal && profileMenuModal.parentElement !== document.body) {
  document.body.appendChild(profileMenuModal);
}
if (avatarPreviewModal && avatarPreviewModal.parentElement !== document.body) {
  document.body.appendChild(avatarPreviewModal);
}

let releaseProfileMenuTrap = null;
function closeProfileMenuModal() {
  if (!profileMenuModal) return;
  profileMenuModal.style.display = "none";
  releaseProfileMenuTrap?.();
  releaseProfileMenuTrap = null;
}
function openProfileMenuModal() {
  if (!profileMenuModal) return;
  profileMenuModal.style.display = "flex";
  releaseProfileMenuTrap?.();
  releaseProfileMenuTrap = trapFocus(profileMenuModal, {
    initialFocus: "#btnMenuEditProfile",
    onEscape: closeProfileMenuModal,
  });
}
btnProfileMenu?.addEventListener("click", openProfileMenuModal);
btnCloseProfileMenu?.addEventListener("click", closeProfileMenuModal);
profileMenuModal?.querySelector(".modal-backdrop")?.addEventListener("click", closeProfileMenuModal);

// Tabs
const tabMyVotes = qs("#tabMyVotes");
const tabActivity = qs("#tabActivity");

// Panels
const panelVotes = qs("#panelVotes");
const panelActivity = qs("#panelActivity");

// Content areas
const myVotesList = qs("#myVotesList");
const recsInbox = qs("#recsInbox");
const btnModeration = qs("#btnModeration");
const btnMenuAdminMetrics = qs("#btnMenuAdminMetrics");
const btnFlashSuggest = qs("#btnFlashSuggest");
const flashSuggestBox = qs("#flashSuggestBox");
const flashSuggestModal = qs("#flashSuggestModal");
const flashSuggestStatus = qs("#flashSuggestStatus");
const btnCloseFlashSuggest = qs("#btnCloseFlashSuggest");

if (flashSuggestModal && flashSuggestModal.parentElement !== document.body) {
  document.body.appendChild(flashSuggestModal);
}


// Watchlist
const tabWatchlist = qs("#tabWatchlist");
const panelWatchlist = qs("#panelWatchlist");
const watchlistList = qs("#watchlistList");
const watchlistEmpty = qs("#watchlistEmpty");
const watchlistSearchInput = qs("#watchlistSearchInput");
const watchlistFilterType = qs("#watchlistFilterType");
const watchlistFilterGenre = qs("#watchlistFilterGenre");
const watchlistFilterYear = qs("#watchlistFilterYear");
let watchlistSortMode = "recent"; // "recent" | "az"
const notifPrefs = qs("#notifPrefs");
const notifPrefsStatus = qs("#notifPrefsStatus");
const statRatedCount = qs("#statRatedCount");
const statAvgRating = qs("#statAvgRating");
const statTopGenre = qs("#statTopGenre");
const statWatchHours = qs("#statWatchHours");
const statWatchlistRatio = qs("#statWatchlistRatio");
const profileWatchSummary = qs("#profileWatchSummary");
const watchTimeUnitBtn = qs("#watchTimeUnitBtn");
const watchTimeDigits = qs("#watchTimeDigits");
const watchTimeUnitHint = qs("#watchTimeUnitHint");
const personalStats = qs("#personalStats");

const pageParams = new URLSearchParams(location.search);
const initialAccountTabParam = String(pageParams.get("tab") || "").trim().toLowerCase();
const isStandaloneWatchlist = document.body.classList.contains("account-page--watchlist-standalone");
const isStandaloneNotifications = document.body.classList.contains("account-page--notifications-standalone");

let me = null;
let meDoc = null;

// Cleanup pool: unsub di listener Firestore al pagehide (followers/following
// erano fire-and-forget e leakavano fra navigazioni PWA).
const _unsubs = [];
function trackUnsub(u) { if (typeof u === "function") _unsubs.push(u); return u; }
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    while (_unsubs.length) { try { _unsubs.pop()(); } catch {} }
  });
}
let releaseConnectionsTrap = null;
let releaseAvatarPreviewTrap = null;
let releaseFlashSuggestTrap = null;
let flashSuggestRunId = 0;
let watchlistCache = []; // [{entry, title}]
let genresCatalog = [];
let genreNameMap = new Map();
let notifDisabled = new Set();
let watchlistSize = 0;
let watchlistStateFilter = "all";
let personalActivitySummaryCache = null;
let lastWatchMinutes = 0;

// Toggle unita' tempo di visione (card "Tempo di visione") — persistito per
// device, logica condivisa con user.page.js via utils/watchTimeUnit.js.

let currentTab = isStandaloneWatchlist ? "watchlist" : isStandaloneNotifications ? "activity" : "votes";

// Pagination & Filters for My Votes
let allVotesData = []; // { item, title }
let votesCurrentPage = 1;
// Filtro TIPO multi-selezione. I conteggi del riepilogo ("Tempo di visione")
// SONO i filtri: la strip di categoria è cliccabile. Set vuoto = "tutti".
// Valori in filter-space: "movie", "tv", "cartoni_animati", "anime".
const votesSelectedCategories = new Set();
let votesStatusFilter = "all"; // "all", "in_progress", "rated", "rewatched" — asse indipendente dal tipo
let votesSearchQuery = ""; // search query
const votesTypeIsAll = () => votesSelectedCategories.size === 0;
// Strip usa data-category film/serie_tv; il filtro usa movie/tv → mappa 1:1.
const STRIP_TO_FILTER_CATEGORY = { film: "movie", serie_tv: "tv", cartoni_animati: "cartoni_animati", anime: "anime" };
const VOTES_PER_PAGE = 9;
const votesSearchInput = qs("#votesSearchInput");

// SVG Star icon
const starSVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`;

// Utils
function initials(name){
  const s = String(name || "").trim();
  if (!s) return "?";
  const parts = s.split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] || "?";
  const b = parts.length > 1 ? parts[parts.length-1][0] : "";
  return (a + b).toUpperCase();
}

function renderAvatar(photoURL, displayName) {
  if (!avatar) return;
  if (photoURL) {
    avatar.innerHTML = `<img src="${escapeHtml(photoURL)}" alt="Avatar" loading="lazy" decoding="async">`;
  } else {
    avatar.textContent = initials(displayName || "");
  }
}

function currentAvatarUrl() {
  const fromDom = avatar?.querySelector("img")?.getAttribute("src") || "";
  if (fromDom) return fromDom;
  return String(meDoc?.photoURL || meDoc?.avatarURL || "");
}

function renderAvatarPreview() {
  if (!avatarPreviewFrame) return;
  const src = currentAvatarUrl();
  const label = meDoc?.displayName || me?.displayName || me?.email || "User";
  if (src) {
    avatarPreviewFrame.innerHTML = `<img src="${escapeHtml(src)}" alt="${i18nT("Foto profilo di {name}", { name: escapeHtml(label) })}" loading="lazy" decoding="async">`;
    return;
  }
  avatarPreviewFrame.innerHTML = `<div class="avatar-preview-fallback">${escapeHtml(initials(label))}</div>`;
}

function closeAvatarPreview() {
  if (!avatarPreviewModal) return;
  avatarPreviewModal.style.display = "none";
  releaseAvatarPreviewTrap?.();
  releaseAvatarPreviewTrap = null;
}

function openAvatarPreview() {
  if (!avatarPreviewModal) return;
  renderAvatarPreview();
  avatarPreviewModal.style.display = "flex";
  releaseAvatarPreviewTrap?.();
  releaseAvatarPreviewTrap = trapFocus(avatarPreviewModal, {
    initialFocus: "#btnAvatarChange",
    onEscape: closeAvatarPreview,
  });
}

function formatMaskedRating(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const q = Math.round(n * 4) / 4;
  const bounded = Math.max(1, Math.min(10, q));
  const floor = Math.floor(bounded);
  const frac = Math.round((bounded - floor) * 100);
  if (frac === 0) return String(floor);
  if (frac === 25) return `${floor}+`;
  if (frac === 50) return `${floor}½`;
  if (frac === 75) return `${Math.min(10, floor + 1)}-`;
  return String(Math.round(bounded * 100) / 100);
}

function setStatLoading(node, loading = true) {
  if (!node) return;
  node.classList.toggle("stat-loading", !!loading);
  if (loading) node.setAttribute("aria-busy", "true");
  else node.removeAttribute("aria-busy");
}

function setStatValue(node, value) {
  if (!node) return;
  setStatLoading(node, false);
  node.textContent = String(Number.isFinite(Number(value)) ? Number(value) : 0);
}

function setReviewBadgeValue(node, value) {
  if (!node) return;
  setStatLoading(node, false);
  const safe = Number.isFinite(Number(value)) ? Number(value) : 0;
  node.textContent = `${safe} ${i18nT("voti")}`;
}

// Voti serie DERIVATI dai voti episodio (privati): mostrati a parte dal conteggio
// review/voti espliciti. Nascosto quando 0.
function setDerivedRatingsCaption(node, value) {
  if (!node) return;
  const safe = Number.isFinite(Number(value)) ? Number(value) : 0;
  if (safe > 0) {
    node.textContent = i18nT("+{safe} dai tuoi voti episodio", { safe });
    node.hidden = false;
  } else {
    node.textContent = "";
    node.hidden = true;
  }
}

function getButtonLabelText(button) {
  if (!button) return "";
  const labelNode = button.querySelector("[data-button-label]");
  return String(labelNode?.textContent || button.textContent || "").trim();
}

function setButtonLabelText(button, value) {
  if (!button) return;
  const labelNode = button.querySelector("[data-button-label]");
  if (labelNode) {
    labelNode.textContent = value;
    return;
  }
  button.textContent = value;
}

const linkedProviderLabels = {
  password: "Email e password",
  "apple.com": "Apple",
  "google.com": "Google",
};

function getLinkedProviderLabel(providerId) {
  const raw = String(providerId || "").trim();
  if (!raw) return i18nT("Altro provider");
  return linkedProviderLabels[raw] || raw;
}

function setAppleLinkFeedback(message = "", tone = "neutral") {
  if (!appleLinkFeedback) return;
  const text = String(message || "").trim();
  appleLinkFeedback.textContent = text;
  appleLinkFeedback.hidden = !text;
  if (text) {
    appleLinkFeedback.dataset.tone = tone;
  } else {
    delete appleLinkFeedback.dataset.tone;
  }
}

function renderLinkedProviders(user) {
  if (!authProvidersCard) return;
  const hasUser = !!user;
  authProvidersCard.hidden = !hasUser;

  if (!hasUser) {
    if (linkedProvidersList) linkedProvidersList.innerHTML = "";
    if (btnLinkApple) btnLinkApple.hidden = true;
    if (appleLinkedBadge) appleLinkedBadge.hidden = true;
    setAppleLinkFeedback("");
    return;
  }

  const providerIds = getLinkedProviderIds(user);
  if (linkedProvidersList) {
    linkedProvidersList.innerHTML = providerIds.length
      ? providerIds.map((providerId) => `
          <span class="account-provider-chip" role="listitem">${escapeHtml(getLinkedProviderLabel(providerId))}</span>
        `).join("")
      : `<span class="hint">${i18nT("Nessun metodo di accesso collegato rilevato.")}</span>`;
  }

  const appleLinked = isAppleLinked(user);
  if (appleLinkedBadge) {
    appleLinkedBadge.hidden = !appleLinked;
  }
  if (btnLinkApple) {
    btnLinkApple.hidden = appleLinked;
    btnLinkApple.disabled = !hasUser || btnLinkApple.dataset.loading === "true";
  }
}

async function handleAppleLinkRedirect(user) {
  const outcome = await handleAppleLinkRedirectResult();
  if (!outcome || outcome.status === "idle") {
    renderLinkedProviders(user);
    return auth.currentUser || user || null;
  }

  const nextUser = outcome.user || auth.currentUser || user || null;
  const fallbackMessage = i18nT("Collegamento Apple non riuscito. Riprova.");
  const message = String(outcome.message || fallbackMessage).trim() || fallbackMessage;

  if (outcome.status === "success") {
    setAppleLinkFeedback(message, "success");
    toast(message, "Accesso");
    console.info("[account] Apple linked", {
      expectedUid: outcome.expectedUid,
      currentUid: outcome.currentUid,
      providers: getLinkedProviderIds(nextUser),
    });
    void logEvent("account_link_completed", {
      provider: "apple",
      source: "account",
      uid_match: outcome.expectedUid && outcome.currentUid === outcome.expectedUid ? "1" : "0",
    });
    renderLinkedProviders(nextUser);
    return nextUser;
  }

  if (outcome.status === "already-linked") {
    setAppleLinkFeedback(message, "success");
    toast(message, "Accesso");
    void logEvent("account_link_already_linked", {
      provider: "apple",
      source: "account",
    });
    renderLinkedProviders(nextUser);
    return nextUser;
  }

  if (outcome.status === "cancelled") {
    setAppleLinkFeedback(message, "neutral");
    toast(message, "Accesso");
    void logEvent("account_link_cancelled", {
      provider: "apple",
      source: "account",
    });
    renderLinkedProviders(nextUser);
    return nextUser;
  }

  if (outcome.status === "uid-mismatch") {
    setAppleLinkFeedback(message, "error");
    toast(message, "Accesso");
    console.warn("[account] Apple link uid mismatch", {
      expectedUid: outcome.expectedUid,
      currentUid: outcome.currentUid,
    });
    void logEvent("account_link_uid_mismatch", {
      provider: "apple",
      source: "account",
    });
    renderLinkedProviders(nextUser);
    return nextUser;
  }

  setAppleLinkFeedback(message, "error");
  toast(message, "Accesso");
  console.warn("[account] Apple link failed", {
    code: outcome.code || "unknown",
    message,
  });
  void logEvent("account_link_failed", {
    provider: "apple",
    source: "account",
    code: outcome.code || "unknown",
  });
  renderLinkedProviders(nextUser);
  return nextUser;
}

function updateProfileHeroNarrative({
  ratedCount = Number(statRatedCount?.textContent || 0),
  topGenre = String(statTopGenre?.textContent || "").trim(),
  watchCount = watchlistSize || 0,
} = {}) {
  const safeRated = Number.isFinite(Number(ratedCount)) ? Number(ratedCount) : 0;
  const safeWatch = Number.isFinite(Number(watchCount)) ? Number(watchCount) : 0;
  const genre = String(topGenre || "").trim();

  if (profileTagline) {
    if (safeRated >= 20 && genre && genre !== "-") {
      profileTagline.textContent = i18nT("{genre} in evidenza: il tuo profilo sta diventando davvero riconoscibile.", { genre });
    } else if (safeRated >= 8) {
      profileTagline.textContent = i18nT("Hai gia' {safeRated} voti che raccontano bene il tuo gusto personale.", { safeRated });
    } else if (safeWatch >= 5) {
      profileTagline.textContent = i18nT("La tua watchlist scalda i motori: ci sono {safeWatch} titoli pronti per il prossimo voto.", { safeWatch });
    } else {
      profileTagline.textContent = i18nT("Piu' voti aggiungi, piu' il tuo profilo prende carattere.");
    }
  }

  if (profileStatusBadge) {
    if (safeWatch > 0) {
      profileStatusBadge.textContent = `${safeWatch} da recuperare`;
    } else if (safeRated > 0) {
      profileStatusBadge.textContent = i18nT("{count} voti registrati", { count: safeRated });
    } else {
      profileStatusBadge.textContent = i18nT("Pronto al prossimo titolo");
    }
  }
}

[statsWatched, statsReviews, statsReviewsHero, statsFollowers, statsFollowing].forEach((node) => setStatLoading(node, true));
window.setTimeout(() => {
  [statsWatched, statsReviews, statsReviewsHero, statsFollowers, statsFollowing].forEach((node) => {
    if (node?.classList.contains("stat-loading")) {
      if (node === statsReviews) {
        setReviewBadgeValue(node, 0);
      } else {
        setStatValue(node, 0);
      }
    }
  });
}, 2600);

function renderWatchTime() {
  if (!watchTimeDigits) return;
  renderWatchTimeInto(watchTimeDigits, lastWatchMinutes, getWatchTimeUnitMode(), watchTimeUnitHint);
}

watchTimeUnitBtn?.addEventListener("click", () => {
  cycleWatchTimeUnitMode();
  renderWatchTime();
});

function applyWatchTimeSummary(totalMinutes) {
  if (!profileWatchSummary) return;
  lastWatchMinutes = Math.max(0, Number(totalMinutes || 0) || 0);
  renderWatchTime();
  profileWatchSummary.style.display = "block";
}

// Variante B — titoli visti per categoria nella card "Tempo di visione".
// I conteggi sono anche i filtri TIPO della libreria: click su una colonna
// attiva/disattiva quel tipo (multi-select). Riquadro attivo = sottolineato.
function renderCategoryStrip(byCategory) {
  const strip = qs("#categoryStrip");
  if (!strip) return;
  const data = byCategory && typeof byCategory === "object" ? byCategory : {};
  let total = 0;
  strip.querySelectorAll(".profile-category-col").forEach((col) => {
    const count = Math.max(0, Math.round(Number(data[col.dataset.category]?.watchedCount) || 0));
    total += count;
    const countEl = col.querySelector(".profile-category-count");
    if (countEl) countEl.textContent = String(count);
    const empty = count === 0;
    col.classList.toggle("is-empty", empty);
    // Colonna cliccabile solo se ha titoli (filtrare un tipo vuoto = niente).
    col.setAttribute("role", "button");
    col.setAttribute("tabindex", empty ? "-1" : "0");
    col.setAttribute("aria-disabled", empty ? "true" : "false");
    col.setAttribute("aria-label", i18nT("Filtra per {v0}", { v0: col.querySelector(".profile-category-label")?.textContent?.trim() || col.dataset.category }));
  });
  strip.classList.remove("is-loading");
  strip.hidden = total === 0;
  syncCategoryStripActive();
}

// Riflette la selezione TIPO corrente sui riquadri del riepilogo.
function syncCategoryStripActive() {
  const strip = qs("#categoryStrip");
  if (!strip) return;
  strip.querySelectorAll(".profile-category-col").forEach((col) => {
    const filterKey = STRIP_TO_FILTER_CATEGORY[col.dataset.category];
    const active = !!filterKey && votesSelectedCategories.has(filterKey);
    col.classList.toggle("is-active", active);
    col.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

// Toggle di un tipo dal riepilogo → filtra la lista "Visti".
function toggleCategoryFilter(stripCategory) {
  const filterKey = STRIP_TO_FILTER_CATEGORY[stripCategory];
  if (!filterKey) return;
  if (votesSelectedCategories.has(filterKey)) votesSelectedCategories.delete(filterKey);
  else votesSelectedCategories.add(filterKey);
  votesCurrentPage = 1;
  syncCategoryStripActive();
  // Il filtro agisce sulla lista Visti: assicurati che sia il tab attivo.
  const votesTab = document.getElementById("tabMyVotes");
  if (votesTab && votesTab.getAttribute("aria-selected") !== "true") votesTab.click();
  renderMyVotes();
}

// Wiring una-tantum (delega su #categoryStrip: sopravvive ai re-render dei count).
(function wireCategoryStripFilter() {
  const strip = qs("#categoryStrip");
  if (!strip) return;
  const handle = (col) => {
    if (!col || col.getAttribute("aria-disabled") === "true") return;
    toggleCategoryFilter(col.dataset.category);
  };
  strip.addEventListener("click", (e) => {
    handle(e.target.closest?.(".profile-category-col"));
  });
  strip.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    const col = e.target.closest?.(".profile-category-col");
    if (!col) return;
    e.preventDefault();
    handle(col);
  });
})();

async function refreshProfileHeader(user) {
  const fresh = await getMyUserDoc(user.uid).catch(() => null);
  if (!fresh) return;
  meDoc = fresh;
  if (fresh.displayName) {
    meName.textContent = fresh.displayName;
    fitProfileName(meName, fresh.displayName);
  }
  const nextHandle = (fresh.displayNameLower || user.uid).slice(0, 20);
  meEmail.textContent = `@${nextHandle}`;
  if (fresh.photoURL || fresh.avatarURL) {
    renderAvatar(fresh.photoURL || fresh.avatarURL, fresh.displayName || "");
  }
}

function safeArray(val) {
  return Array.isArray(val) ? val : [];
}

function parseTimestampMs(value) {
  if (!value) return 0;
  if (typeof value?.toDate === "function") {
    const d = value.toDate();
    return d instanceof Date ? d.getTime() : 0;
  }
  if (value instanceof Date) return value.getTime();
  if (typeof value?.seconds === "number") return value.seconds * 1000;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function getLibrarySortTime(item) {
  return Math.max(
    parseTimestampMs(item?.ratedAt),
    parseTimestampMs(item?.seenAt),
    parseTimestampMs(item?.updatedAt),
    parseTimestampMs(item?.addedAt),
    parseTimestampMs(item?.createdAt)
  );
}

function hasLibraryRating(item) {
  return item?.lastRating !== null && item?.lastRating !== undefined;
}

// Asse "stato" del filtro Visti (indipendente dal tipo). Campi confermati su
// buildLegacyLibraryProjection (functions/lib/titleStates.js): `state`
// ("in_progress" solo per serie TV, mai film), `lastRating` (nullable) e
// `completedCount` (giri di visione, >1 = rewatch).
function voteItemIsRated(item) {
  return hasLibraryRating(item);
}

function voteItemIsInProgress(item) {
  return String(item?.state || "").trim().toLowerCase() === "in_progress";
}

function voteItemRewatchCount(item) {
  const n = Number(item?.completedCount || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function voteItemIsRewatched(item) {
  return voteItemRewatchCount(item) > 1;
}

function isAnimationGenreToken(value) {
  const token = String(value || "").trim().toLowerCase();
  return token === "tmdb_16"
    || token === "16"
    || token === "animation"
    || token === "animazione"
    || token === "anime"
    || token === "cartoon"
    || token === "cartoons"
    || token === "cartoni"
    || token === "cartoni animati"
    || token === "cartone animato"
    || token === "animated";
}

function isJapaneseOriginTitle(title) {
  const meta = title?.meta && typeof title.meta === "object" ? title.meta : {};
  const originalLanguage = String(meta.originalLanguage || title?.originalLanguage || "").trim().toLowerCase();
  if (originalLanguage === "ja" || originalLanguage === "jpn") return true;
  const language = String(meta.language || "").trim().toLowerCase();
  if (language === "giapponese" || language === "japanese") return true;
  const country = String(meta.country || "").trim().toLowerCase();
  if (country === "giappone" || country === "japan") return true;
  const countries = []
    .concat(Array.isArray(meta.originCountry) ? meta.originCountry : [])
    .concat(Array.isArray(title?.originCountry) ? title.originCountry : [])
    .concat(Array.isArray(title?.origin_country) ? title.origin_country : []);
  if (countries.some((code) => String(code || "").trim().toUpperCase() === "JP")) return true;
  return safeArray(title?.keywords).some((keyword) => String(keyword || "").trim().toLowerCase() === "anime");
}

function deriveProfileContentCategory(title) {
  if (safeArray(title?.genres).some(isAnimationGenreToken)) {
    return isJapaneseOriginTitle(title) ? "anime" : "cartoni_animati";
  }
  return title?.type === "tv" ? "tv" : "movie";
}

function profileContentCategoryLabel(title) {
  switch (deriveProfileContentCategory(title)) {
    case "anime": return i18nT("Anime");
    case "cartoni_animati": return i18nT("Cartoni");
    case "tv": return i18nT("Serie TV");
    default: return i18nT("Film");
  }
}

function normalizeGenreKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function prettyGenreLabel(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const normalized = raw
    .replace(/^tmdb[_\s-]?\d+$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  return normalized
    .split(" ")
    .map((part) => part ? (part[0].toUpperCase() + part.slice(1)) : "")
    .join(" ");
}

function isOpaqueGenreKey(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return true;
  if (/^tmdb[_\s-]?\d+$/.test(raw)) return false;
  if (raw.includes(" ")) return false;
  return /^[a-z0-9_-]{12,}$/.test(raw);
}

function rebuildGenreNameMap(catalog) {
  const map = new Map();
  const register = (rawKey, rawName) => {
    const key = String(rawKey || "").trim();
    const name = String(rawName || "").trim();
    if (!key || !name) return;
    map.set(key, name);
    const normalized = normalizeGenreKey(key);
    if (normalized) map.set(normalized, name);
  };

  for (const row of safeArray(catalog)) {
    const id = String(row?.id || "").trim();
    const name = String(row?.name || "").trim();
    if (!id || !name) continue;
    register(id, name);
    register(name, name);
  }

  genreNameMap = map;
}

function mergeGenreCatalog(rows) {
  const merged = [];
  const seen = new Set();
  for (const row of safeArray(rows).concat(tmdbGenreCatalog())) {
    const id = String(row?.id || "").trim();
    const name = String(row?.name || "").trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    merged.push({ ...row, id, name });
  }
  return merged;
}

async function ensureGenresCatalogLoaded() {
  if (genresCatalog.length) return genresCatalog;
  const dbRows = await listGenres(400).catch(() => []);
  genresCatalog = mergeGenreCatalog(dbRows);
  rebuildGenreNameMap(genresCatalog);
  return genresCatalog;
}

function resolveGenreLabel(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const direct = genreNameMap.get(raw);
  if (direct) return direct;
  const normalized = genreNameMap.get(normalizeGenreKey(raw));
  if (normalized) return normalized;
  if (isOpaqueGenreKey(raw)) return "";
  return prettyGenreLabel(raw);
}

// Avatar preview/upload
avatarWrap?.addEventListener("click", () => openAvatarPreview());
avatarWrap?.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" || ev.key === " ") {
    ev.preventDefault();
    openAvatarPreview();
  }
});
btnAvatarUpload?.addEventListener("click", (ev) => {
  ev.preventDefault();
  ev.stopPropagation();
  avatarInput?.click();
});
btnAvatarChange?.addEventListener("click", () => {
  closeAvatarPreview();
  avatarInput?.click();
});
btnCloseAvatarPreview?.addEventListener("click", closeAvatarPreview);
avatarPreviewModal?.querySelector(".avatar-preview-backdrop")?.addEventListener("click", closeAvatarPreview);

const avatarCropState = {
  file: null,
  objectURL: "",
  naturalWidth: 0,
  naturalHeight: 0,
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  pointerId: null,
  pointerX: 0,
  pointerY: 0,
};

function setAvatarCropStatus(message = "", kind = "") {
  if (!avatarCropStatus) return;
  avatarCropStatus.textContent = message;
  avatarCropStatus.classList.toggle("is-error", kind === "error");
}

function avatarCropMetrics() {
  const stageSize = avatarCropStage?.clientWidth || 1;
  const baseScale = Math.max(
    stageSize / Math.max(avatarCropState.naturalWidth, 1),
    stageSize / Math.max(avatarCropState.naturalHeight, 1),
  );
  const scale = baseScale * avatarCropState.zoom;
  return { stageSize, baseScale, scale };
}

function clampAvatarCropOffset() {
  const { stageSize, scale } = avatarCropMetrics();
  const maxX = Math.max(0, (avatarCropState.naturalWidth * scale - stageSize) / 2);
  const maxY = Math.max(0, (avatarCropState.naturalHeight * scale - stageSize) / 2);
  avatarCropState.offsetX = Math.min(Math.max(avatarCropState.offsetX, -maxX), maxX);
  avatarCropState.offsetY = Math.min(Math.max(avatarCropState.offsetY, -maxY), maxY);
}

function renderAvatarCropTransform() {
  if (!avatarCropImage) return;
  clampAvatarCropOffset();
  const { scale } = avatarCropMetrics();
  avatarCropImage.style.width = `${avatarCropState.naturalWidth}px`;
  avatarCropImage.style.height = `${avatarCropState.naturalHeight}px`;
  avatarCropImage.style.transform = `translate(-50%, -50%) translate(${avatarCropState.offsetX}px, ${avatarCropState.offsetY}px) scale(${scale})`;
}

function closeAvatarCrop() {
  if (!avatarCropModal) return;
  avatarCropModal.hidden = true;
  avatarCropModal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  avatarCropState.file = null;
  avatarCropState.pointerId = null;
  if (avatarCropState.objectURL) URL.revokeObjectURL(avatarCropState.objectURL);
  avatarCropState.objectURL = "";
  if (avatarCropImage) avatarCropImage.removeAttribute("src");
  if (avatarInput) avatarInput.value = "";
  setAvatarCropStatus();
  btnAvatarUpload?.focus();
}

function openAvatarCrop(file) {
  if (!avatarCropModal || !avatarCropImage || !avatarCropZoom) return;
  if (avatarCropState.objectURL) URL.revokeObjectURL(avatarCropState.objectURL);
  avatarCropState.file = file;
  avatarCropState.objectURL = URL.createObjectURL(file);
  avatarCropState.zoom = 1;
  avatarCropState.offsetX = 0;
  avatarCropState.offsetY = 0;
  avatarCropZoom.value = "1";
  setAvatarCropStatus(i18nT("Preparo l'anteprima…"));

  avatarCropImage.onload = () => {
    avatarCropState.naturalWidth = avatarCropImage.naturalWidth;
    avatarCropState.naturalHeight = avatarCropImage.naturalHeight;
    avatarCropModal.hidden = false;
    avatarCropModal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => {
      renderAvatarCropTransform();
      setAvatarCropStatus(i18nT("Trascina la foto per cambiare l'inquadratura."));
      avatarCropStage?.focus();
    });
  };
  avatarCropImage.onerror = () => {
    toast(i18nT("Impossibile leggere l'immagine."), i18nT("Errore"));
    closeAvatarCrop();
  };
  avatarCropImage.src = avatarCropState.objectURL;
}

avatarCropZoom?.addEventListener("input", () => {
  avatarCropState.zoom = Math.min(Math.max(Number(avatarCropZoom.value) || 1, 1), 4);
  renderAvatarCropTransform();
});

avatarCropStage?.addEventListener("pointerdown", (event) => {
  if (avatarCropState.pointerId !== null) return;
  avatarCropState.pointerId = event.pointerId;
  avatarCropState.pointerX = event.clientX;
  avatarCropState.pointerY = event.clientY;
  avatarCropStage.setPointerCapture(event.pointerId);
});

avatarCropStage?.addEventListener("pointermove", (event) => {
  if (event.pointerId !== avatarCropState.pointerId) return;
  avatarCropState.offsetX += event.clientX - avatarCropState.pointerX;
  avatarCropState.offsetY += event.clientY - avatarCropState.pointerY;
  avatarCropState.pointerX = event.clientX;
  avatarCropState.pointerY = event.clientY;
  renderAvatarCropTransform();
});

function endAvatarCropPointer(event) {
  if (event.pointerId !== avatarCropState.pointerId) return;
  avatarCropState.pointerId = null;
  if (avatarCropStage?.hasPointerCapture(event.pointerId)) {
    avatarCropStage.releasePointerCapture(event.pointerId);
  }
}
avatarCropStage?.addEventListener("pointerup", endAvatarCropPointer);
avatarCropStage?.addEventListener("pointercancel", endAvatarCropPointer);

avatarCropStage?.addEventListener("keydown", (event) => {
  const step = event.shiftKey ? 12 : 3;
  if (event.key === "ArrowLeft") avatarCropState.offsetX -= step;
  else if (event.key === "ArrowRight") avatarCropState.offsetX += step;
  else if (event.key === "ArrowUp") avatarCropState.offsetY -= step;
  else if (event.key === "ArrowDown") avatarCropState.offsetY += step;
  else return;
  event.preventDefault();
  renderAvatarCropTransform();
});

btnAvatarCropClose?.addEventListener("click", closeAvatarCrop);
btnAvatarCropCancel?.addEventListener("click", closeAvatarCrop);
avatarCropBackdrop?.addEventListener("click", closeAvatarCrop);

function buildCroppedAvatarFile() {
  const { stageSize, scale } = avatarCropMetrics();
  const sourceSide = stageSize / scale;
  const sourceX = (avatarCropState.naturalWidth - sourceSide) / 2 - avatarCropState.offsetX / scale;
  const sourceY = (avatarCropState.naturalHeight - sourceSide) / 2 - avatarCropState.offsetY / scale;
  const canvas = document.createElement("canvas");
  canvas.width = 800;
  canvas.height = 800;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return Promise.reject(new Error(i18nT("Canvas non disponibile.")));
  context.fillStyle = "#000";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(
    avatarCropImage,
    sourceX,
    sourceY,
    sourceSide,
    sourceSide,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error(i18nT("Impossibile creare il ritaglio.")));
      resolve(new File([blob], "avatar.jpg", { type: "image/jpeg", lastModified: Date.now() }));
    }, "image/jpeg", 0.86);
  });
}

btnAvatarCropConfirm?.addEventListener("click", () => {
  if (!me || !avatarCropState.file) return;
  runWithButtonLoading(btnAvatarCropConfirm, async () => {
    setAvatarCropStatus(i18nT("Caricamento foto in corso…"));
    try {
      const croppedFile = await buildCroppedAvatarFile();
      const { url } = await uploadAvatar({ file: croppedFile, uid: me.uid });
      await updatePhotoURL(me.uid, url);
      renderAvatar(url, me.displayName);
      renderAvatarPreview();
      closeAvatarCrop();
      toast(i18nT("Foto profilo aggiornata!"), i18nT("Profilo"));
    } catch (err) {
      console.error("Avatar upload error:", err);
      setAvatarCropStatus(err?.message || i18nT("Errore upload foto."), "error");
      toast(err?.message || i18nT("Errore upload foto."), i18nT("Errore"));
    }
  }, { loadingLabel: i18nT("Carico…") });
});

avatarInput?.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file || !me) return;

  // Validate type
  if (!file.type.startsWith("image/")) {
    toast(i18nT("Seleziona un'immagine (JPG, PNG)."), i18nT("Errore"));
    avatarInput.value = "";
    return;
  }

  // Il ritaglio produce un JPEG ottimizzato; limitiamo solo il file sorgente.
  if (file.size > 15 * 1024 * 1024) {
    toast("Immagine troppo grande (max 15MB).", i18nT("Errore"));
    avatarInput.value = "";
    return;
  }

  openAvatarCrop(file);
});

function setupPushButton(user){
  if (!btnEnablePush) return;

  const supported = ("Notification" in window) && ("serviceWorker" in navigator) && ("PushManager" in window);
  if (!supported){
    setButtonLabelText(btnEnablePush, i18nT("Notifiche non supportate"));
    btnEnablePush.disabled = true;
    btnEnablePush.title = i18nT("Questo browser/dispositivo non supporta le push web.");
    return;
  }

  const refreshLabel = () => {
    const p = Notification.permission;
    if (p === "granted") {
      setButtonLabelText(btnEnablePush, i18nT("Notifiche attive"));
      btnEnablePush.disabled = true;
    } else if (p === "denied") {
      setButtonLabelText(btnEnablePush, "Notifiche bloccate");
      btnEnablePush.disabled = false;
    } else {
      setButtonLabelText(btnEnablePush, i18nT("Attiva notifiche"));
      btnEnablePush.disabled = false;
    }
  };

  refreshLabel();

  btnEnablePush.addEventListener("click", async () => {
    // Se l’utente ha già bloccato, possiamo solo spiegare cosa fare.
    if (Notification.permission === "denied"){
      toast(i18nT("Le notifiche sono bloccate. Vai in Impostazioni del browser e abilita le notifiche per questo sito."), i18nT("Notifiche"));
      return;
    }

    btnEnablePush.disabled = true;
    const oldText = getButtonLabelText(btnEnablePush);
    setButtonLabelText(btnEnablePush, i18nT("Attivo..."));

    try {
      const res = await registerPushToken(user);
      if (res?.ok){
        toast("Notifiche attivate ✅", "Ok");
      } else if (res?.reason === "permission-not-granted"){
        toast(i18nT("Permesso notifiche non concesso."), "Ok");
      } else if (res?.reason === "not-supported"){
        toast(i18nT("Questo browser non supporta le notifiche push."), "Ops");
      } else {
        toast(i18nT("Non riesco ad attivare le notifiche su questo dispositivo."), "Ops");
      }
    } catch (e){
      console.warn("Attivazione push fallita", e);
      toast(i18nT("Errore attivazione notifiche."), "Ops");
    } finally {
      setButtonLabelText(btnEnablePush, oldText);
      btnEnablePush.disabled = false;
      refreshLabel();
    }
  });
}

function wireProfileTools(user) {
  if (!user) return;

  const openIdentity = async () => {
    closeProfileMenuModal();
    const opened = await openAccountIdentityWizard({
      uid: user.uid,
      onCompleted: async () => {
        await refreshProfileHeader(user);
      },
      onClose: async () => {
        await refreshProfileHeader(user);
      },
    });
    if (!opened) toast(i18nT("Impossibile aprire le modifiche profilo ora."), i18nT("Profilo"));
  };

  const openTaste = async () => {
    closeProfileMenuModal();
    const opened = await openAccountTasteWizard({
      uid: user.uid,
      source: "account-inline",
      onCompleted: async () => {
        await refreshProfileHeader(user);
      },
    });
    if (!opened) toast(i18nT("Impossibile aprire i gusti in questo momento."), i18nT("Profilo"));
  };

  const shareProfile = async () => {
    const uid = user.uid;
    if (!uid) return;
    const url = `https://somto.it/user.html?uid=${encodeURIComponent(uid)}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: i18nT("Il mio profilo Somto"), url });
        return;
      }
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        toast(i18nT("Link del profilo copiato negli appunti."), i18nT("Condiviso"));
        return;
      }
      toast(url, i18nT("Copia il link del profilo"));
    } catch (err) {
      // AbortError = l'utente ha chiuso lo share sheet nativo: non è un errore.
      if (err?.name === "AbortError") return;
      console.warn("[account] share profile failed", err);
      toast(i18nT("Impossibile condividere il profilo ora."), i18nT("Errore"));
    }
  };

  btnEditIdentity?.addEventListener("click", openIdentity);
  btnMenuEditProfile?.addEventListener("click", openIdentity);
  // "Condividi profilo" ora vive nel menu tre puntini: chiudi il menu, poi condividi.
  btnMenuShareProfile?.addEventListener("click", () => { closeProfileMenuModal(); shareProfile(); });
  btnTuneTaste?.addEventListener("click", openTaste);
  btnMenuTuneTaste?.addEventListener("click", openTaste);

  btnMenuSignOut?.addEventListener("click", async () => {
    await runWithButtonLoading(btnMenuSignOut, async () => {
      try {
        await logout();
        window.location.href = "/login.html";
      } catch (e) {
        console.error(e);
        toast(i18nT("Errore logout"), "Ops", { type: "error" });
      }
    }, { loadingLabel: i18nT("Uscita...") });
  });

  // Eliminazione account (GDPR / requisito App Store). Doppia conferma
  // + eventuale re-auth: logica in components/accountDeletion.js.
  const btnMenuDeleteAccount = qs("#btnMenuDeleteAccount");
  btnMenuDeleteAccount?.addEventListener("click", async () => {
    try {
      await runWithButtonLoading(btnMenuDeleteAccount, () => requestAccountDeletion(btnMenuDeleteAccount));
    } catch (e) {
      console.error(e);
      toast(i18nT("Impossibile eliminare l'account ora. Riprova più tardi."), i18nT("Errore"));
    }
  });
}

btnLinkApple?.addEventListener("click", () =>
  runWithButtonLoading(btnLinkApple, async () => {
    const currentUser = auth.currentUser || me;
    if (!currentUser) {
      const message = i18nT("Devi prima accedere al tuo account.");
      setAppleLinkFeedback(message, "error");
      toast(message, "Accesso");
      return;
    }

    if (isAppleLinked(currentUser)) {
      const message = i18nT("Apple è già collegato a questo account.");
      setAppleLinkFeedback(message, "success");
      renderLinkedProviders(currentUser);
      toast(message, "Accesso");
      return;
    }

    setAppleLinkFeedback("");
    renderLinkedProviders(currentUser);
    console.info("[account] Starting Apple link", {
      uid: currentUser.uid,
      providers: getLinkedProviderIds(currentUser),
    });
    void logEvent("account_link_started", {
      provider: "apple",
      source: "account",
      linked_methods: String(getLinkedProviderIds(currentUser).length),
    });
    try {
      await startAppleLink(currentUser);
    } catch (error) {
      const message = getAppleLinkErrorMessage(error);
      setAppleLinkFeedback(message, "error");
      renderLinkedProviders(currentUser);
      toast(message, "Accesso");
      console.warn("[account] Apple link start failed", {
        code: error?.code || "unknown",
        message,
      });
      void logEvent("account_link_start_failed", {
        provider: "apple",
        source: "account",
        code: error?.code || "unknown",
      });
    }
  }, { loadingLabel: "Collegamento..." })
);

// Logout
btnSignOut?.addEventListener("click", async () => {
  await runWithButtonLoading(btnSignOut, async () => {
    try {
      await logout();
      window.location.href = "/login.html";
    } catch (e) {
      console.error(e);
      toast(i18nT("Errore logout"), "Ops", { type: "error" });
    }
  }, { loadingLabel: i18nT("Uscita...") });
});

btnFlashSuggest?.addEventListener("click", () => showFlashSuggestion());

// Tab Switching

function resolveInitialAccountTab() {
  if (isStandaloneWatchlist) return "watchlist";
  if (isStandaloneNotifications) return "activity";
  if (initialAccountTabParam === "watchlist") return "watchlist";
  if (initialAccountTabParam === "activity") return "activity";
  return "votes";
}

function syncAccountTabQuery(tabName) {
  const url = new URL(window.location.href);
  if (isStandaloneNotifications) {
    url.searchParams.delete("tab");
    url.searchParams.delete("state");
    const search = url.searchParams.toString();
    history.replaceState({}, "", `${url.pathname}${search ? `?${search}` : ""}${url.hash}`);
    initTabbar();
    return;
  }

  if (isStandaloneWatchlist) {
    url.searchParams.delete("tab");
    if (watchlistStateFilter === "to_watch" || watchlistStateFilter === "to_rate") {
      url.searchParams.set("state", watchlistStateFilter);
    } else {
      url.searchParams.delete("state");
    }
    const search = url.searchParams.toString();
    history.replaceState({}, "", `${url.pathname}${search ? `?${search}` : ""}${url.hash}`);
    initTabbar();
    return;
  }

  if (tabName === "watchlist") {
    url.searchParams.set("tab", "watchlist");
    if (watchlistStateFilter === "to_watch" || watchlistStateFilter === "to_rate") {
      url.searchParams.set("state", watchlistStateFilter);
    } else {
      url.searchParams.delete("state");
    }
  } else if (tabName === "activity") {
    url.searchParams.set("tab", "activity");
    url.searchParams.delete("state");
  } else {
    url.searchParams.delete("tab");
    url.searchParams.delete("state");
  }
  const search = url.searchParams.toString();
  history.replaceState({}, "", `${url.pathname}${search ? `?${search}` : ""}${url.hash}`);
  initTabbar();
}

tabWatchlist?.addEventListener("click", () => switchTab("watchlist"));

function switchTab(tabName) {
  if (isStandaloneWatchlist && tabName !== "watchlist") {
    tabName = "watchlist";
  }
  if (isStandaloneNotifications && tabName !== "activity") {
    tabName = "activity";
  }
  currentTab = tabName;

  // Update tab buttons
  [tabMyVotes, tabWatchlist, tabActivity]
    .filter(Boolean)
    .forEach((btn) => btn.classList.remove("active"));

  // Update panels
  [panelVotes, panelWatchlist, panelActivity]
    .filter(Boolean)
    .forEach((panel) => {
      panel.style.display = "none";
    });

  if (tabName === "votes") {
    tabMyVotes?.classList.add("active");
    panelVotes && (panelVotes.style.display = "block");
  } else if (tabName === "watchlist") {
    tabWatchlist?.classList.add("active");
    panelWatchlist && (panelWatchlist.style.display = "block");
  } else if (tabName === "activity") {
    tabActivity?.classList.add("active");
    panelActivity && (panelActivity.style.display = "block");
  } else {
    // fallback
    tabMyVotes?.classList.add("active");
    panelVotes && (panelVotes.style.display = "block");
  }
  syncAccountTabQuery(tabName);
}

tabMyVotes?.addEventListener("click", () => switchTab("votes"));
tabActivity?.addEventListener("click", () => switchTab("activity"));

function closeConnectionsModal() {
  if (!connectionsModal) return;
  connectionsModal.style.display = "none";
  releaseConnectionsTrap?.();
  releaseConnectionsTrap = null;
}

function renderConnectionList(users) {
  if (!connectionsList) return;
  if (!users.length) {
    connectionsList.innerHTML = `<div class="hint">${i18nT("Nessun utente trovato.")}</div>`;
    return;
  }

  connectionsList.innerHTML = users.map((u) => {
    const initial = initials(u.displayName || u.uid);
    const label = u.displayName || u.uid;
    const avatarUrl = String(u.photoURL || u.avatarURL || "").trim();
    const avatarImg = avatarUrl
      ? `<img src="${escapeHtml(avatarUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
      : "";
    return `
      <a class="friend-item" href="/user.html?uid=${encodeURIComponent(u.uid)}">
        <div class="avatar ${avatarUrl ? "has-photo" : ""}">
          <span class="avatar-fallback">${escapeHtml(initial)}</span>
          ${avatarImg}
        </div>
        <div class="name" style="flex:1;min-width:0;">${escapeHtml(label)}</div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;color:var(--text-muted);">
          <polyline points="9 18 15 12 9 6"></polyline>
        </svg>
      </a>
    `;
  }).join("");
}

async function openConnectionsModal(title, rowsPromise) {
  if (!connectionsModal || !connectionsList) return;
  connectionsModal.style.display = "flex";
  if (connectionsTitle) connectionsTitle.textContent = title;
  if (connectionsSearchInput) connectionsSearchInput.value = "";
  connectionsList.innerHTML = `<div class="hint">${i18nT("Caricamento...")}</div>`;
  releaseConnectionsTrap?.();
  releaseConnectionsTrap = trapFocus(connectionsModal, {
    initialFocus: "#connectionsSearchInput",
    onEscape: closeConnectionsModal,
  });

  try {
    const rows = await rowsPromise;
    const users = await listUsersPublicByIds(rows.map((entry) => entry.uid));
    renderConnectionList(users);
    if (connectionsSearchInput) {
      connectionsSearchInput.oninput = (ev) => {
        const q = String(ev.target.value || "").trim().toLowerCase();
        if (!q) {
          renderConnectionList(users);
          return;
        }
        renderConnectionList(users.filter((entry) => String(entry.displayName || entry.uid || "").toLowerCase().includes(q)));
      };
    }
  } catch (err) {
    console.error("Errore caricamento connessioni:", err);
    connectionsList.innerHTML = `<div class="hint">${i18nT("Errore nel caricamento.")}</div>`;
  }
}

statsFollowersBlock?.addEventListener("click", () => {
  if (!me) return;
  openConnectionsModal(i18nT("Follower"), listFollowers(me.uid));
});
statsFollowingBlock?.addEventListener("click", () => {
  if (!me) return;
  openConnectionsModal(i18nT("Seguiti"), listFollowing(me.uid));
});
btnCloseConnections?.addEventListener("click", closeConnectionsModal);
connectionsModal?.querySelector(".modal-backdrop")?.addEventListener("click", closeConnectionsModal);

function closeFlashSuggestModal() {
  if (!flashSuggestModal) return;
  flashSuggestModal.style.display = "none";
  releaseFlashSuggestTrap?.();
  releaseFlashSuggestTrap = null;
}

function openFlashSuggestModal() {
  if (!flashSuggestModal) return;
  flashSuggestModal.style.display = "flex";
  releaseFlashSuggestTrap?.();
  releaseFlashSuggestTrap = trapFocus(flashSuggestModal, {
    initialFocus: "#btnCloseFlashSuggest",
    onEscape: closeFlashSuggestModal,
  });
}

btnCloseFlashSuggest?.addEventListener("click", closeFlashSuggestModal);
flashSuggestModal?.querySelector(".modal-backdrop")?.addEventListener("click", closeFlashSuggestModal);

async function attachFollowersListener(){
  trackUnsub(listenFollowers(me.uid, (items) => {
    setStatValue(statsFollowers, items.length);
  }));
}

// Following count
async function attachFollowingListener(){
  trackUnsub(listenFollowing(me.uid, (items) => {
    setStatValue(statsFollowing, items.length);
  }));
}

// My Votes - with pagination and filters
async function loadMyVotesData() {
  if (!myVotesList) return;
  myVotesList.innerHTML = `<div class="hint">${i18nT("Caricamento...")}</div>`;

  try {
    const items = await listMyLibrary(me.uid, { max: 500 });
    // Batched read invece di N+1 (1 query/30 id).
    const ids = items.map(i => i.titleId).filter(Boolean);
    const titlesMap = await getTitlesByIds(ids).catch(() => new Map());

    // Store data for filtering/pagination
    allVotesData = [];
    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx];
      const t = titlesMap.get(it.titleId);
      if (t) allVotesData.push({ item: it, title: t });
    }

    // Piu' recenti prima, sia votati sia "visti senza voto".
    allVotesData.sort((a, b) => {
      return getLibrarySortTime(b.item) - getLibrarySortTime(a.item);
    });

    const watchedCount = Number(meDoc?.stats?.watchedCount || allVotesData.length) || allVotesData.length;
    setStatValue(statsWatched, watchedCount);

    votesCurrentPage = 1;
    votesSelectedCategories.clear();
    votesStatusFilter = "all";
    syncCategoryStripActive();
    renderMyVotes();
  } catch (e) {
    console.error(e);
    setStatValue(statsWatched, 0);
    myVotesList.innerHTML = `<div class="hint">${i18nT("Errore nel caricamento.")}</div>`;
  }
}

function renderMyVotes() {
  if (!myVotesList) return;

  // Filter by type — multi-select dai conteggi del riepilogo. Set vuoto = tutti.
  let filtered = votesTypeIsAll()
    ? allVotesData
    : allVotesData.filter(d => votesSelectedCategories.has(deriveProfileContentCategory(d.title)));

  // Filter by status — asse indipendente dal tipo (In corso / Votati / Rivisti).
  if (votesStatusFilter !== "all") {
    filtered = filtered.filter(d => {
      if (votesStatusFilter === "rated") return voteItemIsRated(d.item);
      if (votesStatusFilter === "in_progress") return voteItemIsInProgress(d.item);
      if (votesStatusFilter === "rewatched") return voteItemIsRewatched(d.item);
      return true;
    });
  }

  // Filter by search query
  if (votesSearchQuery) {
    const q = votesSearchQuery.toLowerCase();
    filtered = filtered.filter(d => (d.title.name || "").toLowerCase().includes(q));
  }

  const totalPages = Math.ceil(filtered.length / VOTES_PER_PAGE);
  if (votesCurrentPage > totalPages) votesCurrentPage = Math.max(1, totalPages);

  const start = (votesCurrentPage - 1) * VOTES_PER_PAGE;
  const pageData = filtered.slice(start, start + VOTES_PER_PAGE);

  // Il filtro TIPO ora vive nei conteggi del riepilogo (category strip),
  // niente più pills duplicate qui. Resta solo l'asse STATO.
  const statusPills = `
    <div class="profile-status-chips">
      <button class="profile-status-chip ${votesStatusFilter === 'all' ? 'active' : ''}" onclick="setVotesStatusFilter('all')">${i18nT("Tutti")}</button>
      <button class="profile-status-chip ${votesStatusFilter === 'in_progress' ? 'active' : ''}" onclick="setVotesStatusFilter('in_progress')">${i18nT("In corso")}</button>
      <button class="profile-status-chip ${votesStatusFilter === 'rated' ? 'active' : ''}" onclick="setVotesStatusFilter('rated')">${i18nT("Votati")}</button>
      <button class="profile-status-chip ${votesStatusFilter === 'rewatched' ? 'active' : ''}" onclick="setVotesStatusFilter('rewatched')">${i18nT("Rivisti")}</button>
    </div>
  `;

  if (!filtered.length) {
    const statusEmptyMessages = {
      in_progress: i18nT("Nessuna serie in corso al momento."),
      rated: i18nT("Nessun titolo votato con questi filtri."),
      rewatched: i18nT("Nessun titolo rivisto (rewatch) ancora."),
    };
    const emptyMsg = votesSearchQuery
      ? i18nT("Prova a cambiare filtro o a cercare un altro titolo nella tua libreria.")
      : (votesStatusFilter !== 'all'
        ? (statusEmptyMessages[votesStatusFilter] || i18nT("Nessun titolo con questo stato."))
        : (votesTypeIsAll() ? i18nT("Ancora niente qui. Salva un titolo in Watchlist e segnalo come visto: comparirà in questa libreria.") : i18nT("Nessun titolo in questa categoria.")));
    myVotesList.innerHTML = `
      ${statusPills}
      <div class="profile-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
        </svg>
        <p class="profile-empty-title">${i18nT("Nessun titolo trovato")}</p>
        <p class="profile-empty-text">${emptyMsg}</p>
        ${(!votesSearchQuery && votesTypeIsAll() && votesStatusFilter === 'all') ? `<a class="btn primary" href="/import.html">${i18nT("Importa la tua cronologia")}</a>` : ''}
      </div>
    `;
    return;
  }

  const summaryLabel = votesSearchQuery
    ? `${filtered.length} risultati`
    : i18nT("{count} titoli", { count: filtered.length });

  // Poster grid (iOS ProfilePosterTile)
  const cards = pageData.map(({ item, title }) => {
    const poster = title.posterPath
      ? `<img alt="${escapeHtml(title.name || "")}" src="${escapeHtml(title.posterPath)}" loading="lazy" />`
      : `<div class="poster-placeholder"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="20" height="20" rx="2"></rect><circle cx="12" cy="12" r="3"></circle></svg></div>`;
    const rating = item.lastRating ?? null;
    const typeLabel = profileContentCategoryLabel(title);
    // Serie ancora in corso (non finita): badge "In corso" invece di "Visto",
    // altrimenti sembrerebbe completata. Il rating vince sempre se presente.
    const isInProgress = rating === null && String(item.state || "").trim().toLowerCase() === "in_progress";
    const badge = rating !== null
      ? `<span class="profile-poster-badge is-rating"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>${escapeHtml(formatMaskedRating(rating))}</span>`
      : isInProgress
        ? `<span class="profile-poster-badge is-progress"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 3"></path></svg>${i18nT("In corso")}</span>`
        : `<span class="profile-poster-badge is-seen"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"></path><circle cx="12" cy="12" r="3"></circle></svg>${i18nT("Visto")}</span>`;
    const rewatchCount = voteItemRewatchCount(item);
    const rewatchBadge = rewatchCount > 1
      ? `<span class="profile-vote-rewatch-badge" title="${i18nT("Rivisto {count} volte", { count: rewatchCount })}">↺ ×${rewatchCount}</span>`
      : "";

    return `
      <a class="profile-poster-tile" href="/title.html?id=${encodeURIComponent(title.id)}">
        <div class="profile-poster-frame">
          ${poster}
          ${badge}
        </div>
        <div class="profile-poster-meta">
          <div class="profile-poster-title">${escapeHtml(title.name || "")}</div>
          <div class="profile-poster-sub">${typeLabel}</div>
          ${rewatchBadge}
        </div>
      </a>
    `;
  }).join("");

  // Build pagination
  let pagination = '';
  if (totalPages > 1) {
    pagination = `
      <div class="votes-pagination">
        <button class="page-btn" ${votesCurrentPage <= 1 ? 'disabled' : ''} onclick="changeVotesPage(${votesCurrentPage - 1})">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"></polyline></svg>
        </button>
        <span class="page-info">${votesCurrentPage} / ${totalPages}</span>
        <button class="page-btn" ${votesCurrentPage >= totalPages ? 'disabled' : ''} onclick="changeVotesPage(${votesCurrentPage + 1})">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </button>
      </div>
    `;
  }

  myVotesList.innerHTML = `
    ${statusPills}
    <div class="profile-list-summary">${summaryLabel}</div>
    <div class="profile-poster-grid">${cards}</div>
    ${pagination}
  `;
}

// Global functions for onclick
window.setVotesStatusFilter = function(status) {
  votesStatusFilter = status;
  votesCurrentPage = 1;
  renderMyVotes();
};

window.changeVotesPage = function(page) {
  votesCurrentPage = page;
  renderMyVotes();
  // Scroll to top of votes section
  myVotesList?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

// Votes search
votesSearchInput?.addEventListener("input", (e) => {
  votesSearchQuery = e.target.value.trim();
  votesCurrentPage = 1;
  renderMyVotes();
});

const recsSent = qs("#recsSent");
const recsSentEmpty = qs("#recsSentEmpty");
const RECS_PAGE_SIZE = 20;
const recTitleCache = new Map();
const recUserCache = new Map();
const PERF_DEBUG = (() => {
  try {
    const params = new URLSearchParams(window.location.search || "");
    return params.has("debugPerf") || window.localStorage?.getItem("debugPerf") === "1";
  } catch (_) {
    return false;
  }
})();

function perfNow() {
  return (typeof performance !== "undefined" && typeof performance.now === "function")
    ? performance.now()
    : Date.now();
}

function logPerf(label, startedAt, extra = {}) {
  if (!PERF_DEBUG) return;
  const ms = Math.round((perfNow() - startedAt) * 10) / 10;
  console.info(`[perf] ${label}`, { ms, ...extra });
}

let recInboxRows = [];
let recInboxCursorDoc = null;
let recInboxHasMore = false;

let recSentRows = [];
let recSentCursorDoc = null;
let recSentHasMore = false;

async function warmRecommendationCaches(rows, userField) {
  const missingTitleIds = [...new Set(
    rows
      .map((r) => String(r?.titleId || "").trim())
      .filter((id) => id && !recTitleCache.has(id))
  )];
  if (missingTitleIds.length) {
    const titles = await listTitlesByIds(missingTitleIds, { max: missingTitleIds.length }).catch(() => []);
    titles.forEach((t) => {
      if (t?.id) recTitleCache.set(t.id, t);
    });
    missingTitleIds.forEach((id) => {
      if (!recTitleCache.has(id)) recTitleCache.set(id, null);
    });
  }

  const missingUserIds = [...new Set(
    rows
      .map((r) => String(r?.[userField] || "").trim())
      .filter((uid) => uid && !recUserCache.has(uid))
  )];
  if (missingUserIds.length) {
    const users = await listUsersPublicByIds(missingUserIds, { max: missingUserIds.length }).catch(() => []);
    users.forEach((u) => {
      if (u?.uid) recUserCache.set(u.uid, u);
    });
    missingUserIds.forEach((uid) => {
      if (!recUserCache.has(uid)) recUserCache.set(uid, null);
    });
  }
}

async function renderRecommendations({ reset = true } = {}) {
  if (!recsInbox) return;
  const startedAt = perfNow();
  if (reset) {
    recInboxRows = [];
    recInboxCursorDoc = null;
    recInboxHasMore = false;
    recsInbox.innerHTML = `<div class="hint">${i18nT("Caricamento...")}</div>`;
  }

  try {
    const fetchStartedAt = perfNow();
    const page = await listRecommendationsForMePage(me.uid, {
      includeViewed: false,
      pageSize: RECS_PAGE_SIZE,
      cursorDoc: reset ? null : recInboxCursorDoc,
    });
    const fetchMs = Math.round((perfNow() - fetchStartedAt) * 10) / 10;

    recInboxRows = reset ? page.items : recInboxRows.concat(page.items);
    recInboxCursorDoc = page.nextCursorDoc || null;
    recInboxHasMore = page.hasMore === true;

    if (!recInboxRows.length) {
      recsInbox.innerHTML = `<div class="hint">${i18nT("Nessun suggerimento per ora.")}</div>`;
      logPerf("account.renderRecommendations", startedAt, {
        reset,
        pageItems: page.items.length,
        totalItems: 0,
        hasMore: false,
        fetchMs,
        preloadMs: 0,
      });
      return;
    }

    const preloadStartedAt = perfNow();
    await warmRecommendationCaches(recInboxRows, "fromUid");
    const preloadMs = Math.round((perfNow() - preloadStartedAt) * 10) / 10;

    const blocks = recInboxRows.map((r) => {
      const t = recTitleCache.get(r.titleId) || null;
      const sender = recUserCache.get(r.fromUid) || null;
      const titleName = t?.name || i18nT("(Titolo non disponibile)");
      const year = t?.year ? ` (${t.year})` : "";
      const senderName = sender?.displayName || r.fromUid;
      const msg = r.message ? `"${r.message}"` : "";
      const posterUrl = t?.posterPath || "";

      return `
        <div class="rec-card" onclick="openRecommendation('${r.id}', '${r.threadId}')">
          <div class="rec-card-poster">
            ${posterUrl ? `<img src="${escapeHtml(posterUrl)}" alt="" loading="lazy" />` : `<div class="poster-placeholder"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect><circle cx="12" cy="12" r="3"></circle></svg></div>`}
          </div>
          <div class="rec-card-content">
            <div class="rec-card-title">${escapeHtml(titleName)}${year}</div>
            <div class="rec-card-from">Da <strong>${escapeHtml(senderName)}</strong></div>
            ${msg ? `<div class="rec-card-msg">${escapeHtml(msg)}</div>` : ""}
          </div>
          <div class="rec-card-action-wrap">
            <button class="rec-archive-btn" type="button" data-archive-rec="${escapeHtml(r.id)}">${i18nT("Archivia")}</button>
            <div class="rec-card-action">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>
            </div>
          </div>
        </div>
      `;
    }).join("");

    const loadMore = recInboxHasMore
      ? `<div style="margin-top:.75rem;text-align:center;"><button class="btn small ghost" type="button" data-load-more-recs="1">${i18nT("Carica altri")}</button></div>`
      : "";

    recsInbox.innerHTML = blocks + loadMore;

    recsInbox.querySelectorAll("[data-archive-rec]").forEach((btn) => {
      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const recId = btn.getAttribute("data-archive-rec");
        if (!recId) return;
        await runWithButtonLoading(btn, async () => {
          try {
            await archiveRecommendation(recId);
            toast(i18nT("Suggerimento archiviato"), "Attivita'", { type: "success" });
            await renderRecommendations({ reset: true });
          } catch (err) {
            console.error("archive recommendation failed", err);
            toast(i18nT("Impossibile archiviare ora"), "Attivita'", { type: "error" });
          }
        }, { loadingLabel: i18nT("Archiviazione...") });
      });
    });

    recsInbox.querySelector("[data-load-more-recs='1']")?.addEventListener("click", async (ev) => {
      ev.preventDefault();
      await runWithButtonLoading(ev.currentTarget, () => renderRecommendations({ reset: false }), {
        loadingLabel: i18nT("Caricamento..."),
      });
    });
    logPerf("account.renderRecommendations", startedAt, {
      reset,
      pageItems: page.items.length,
      totalItems: recInboxRows.length,
      hasMore: recInboxHasMore,
      fetchMs,
      preloadMs,
    });
  } catch (e) {
    console.error(e);
    recsInbox.innerHTML = `<div class="hint">${i18nT("Errore caricamento")}</div>`;
  }
}

async function renderSentRecommendations({ reset = true } = {}) {
  if (!recsSent) return;
  const startedAt = perfNow();
  if (reset) {
    recSentRows = [];
    recSentCursorDoc = null;
    recSentHasMore = false;
    recsSent.innerHTML = `<div class="hint">${i18nT("Caricamento...")}</div>`;
  }

  try {
    const fetchStartedAt = perfNow();
    const page = await listRecommendationsByMePage(me.uid, {
      pageSize: RECS_PAGE_SIZE,
      cursorDoc: reset ? null : recSentCursorDoc,
    });
    const fetchMs = Math.round((perfNow() - fetchStartedAt) * 10) / 10;

    recSentRows = reset ? page.items : recSentRows.concat(page.items);
    recSentCursorDoc = page.nextCursorDoc || null;
    recSentHasMore = page.hasMore === true;

    if (!recSentRows.length) {
      recsSent.innerHTML = `<div class="hint">${i18nT("Non hai ancora suggerito nulla.")}</div>`;
      if (recsSentEmpty) recsSentEmpty.style.display = "block";
      logPerf("account.renderSentRecommendations", startedAt, {
        reset,
        pageItems: page.items.length,
        totalItems: 0,
        hasMore: false,
        fetchMs,
        preloadMs: 0,
      });
      return;
    }

    if (recsSentEmpty) recsSentEmpty.style.display = "none";
    const preloadStartedAt = perfNow();
    await warmRecommendationCaches(recSentRows, "toUid");
    const preloadMs = Math.round((perfNow() - preloadStartedAt) * 10) / 10;

    const blocks = recSentRows.map((r) => {
      const t = recTitleCache.get(r.titleId) || null;
      const recipient = recUserCache.get(r.toUid) || null;
      const titleName = t?.name || i18nT("(Titolo non disponibile)");
      const year = t?.year ? ` (${t.year})` : "";
      const recipientName = recipient?.displayName || r.toUid;
      const posterUrl = t?.posterPath || "";
      const viewed = r.viewedAt ? `<span class="rec-viewed">${i18nT("Visto")}</span>` : `<span class="rec-pending">${i18nT("In attesa")}</span>`;

      return `
        <a class="rec-card" href="/thread.html?id=${r.threadId}">
          <div class="rec-card-poster">
            ${posterUrl ? `<img src="${escapeHtml(posterUrl)}" alt="" loading="lazy" />` : `<div class="poster-placeholder"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect><circle cx="12" cy="12" r="3"></circle></svg></div>`}
          </div>
          <div class="rec-card-content">
            <div class="rec-card-title">${escapeHtml(titleName)}${year}</div>
            <div class="rec-card-from">A <strong>${escapeHtml(recipientName)}</strong></div>
            ${viewed}
          </div>
          <div class="rec-card-action-wrap">
            <button class="rec-archive-btn" type="button" data-archive-sent="${escapeHtml(r.id)}">${i18nT("Archivia")}</button>
            <div class="rec-card-action">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>
            </div>
          </div>
        </a>
      `;
    }).join("");

    const loadMore = recSentHasMore
      ? `<div style="margin-top:.75rem;text-align:center;"><button class="btn small ghost" type="button" data-load-more-sent-recs="1">${i18nT("Carica altri")}</button></div>`
      : "";

    recsSent.innerHTML = blocks + loadMore;

    recsSent.querySelectorAll("[data-archive-sent]").forEach((btn) => {
      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const recId = btn.getAttribute("data-archive-sent");
        if (!recId) return;
        await runWithButtonLoading(btn, async () => {
          try {
            await archiveRecommendation(recId);
            toast(i18nT("Suggerimento inviato archiviato"), "Attivita'", { type: "success" });
            await renderSentRecommendations({ reset: true });
          } catch (err) {
            console.error("archive sent recommendation failed", err);
            toast(i18nT("Impossibile archiviare ora"), "Attivita'", { type: "error" });
          }
        }, { loadingLabel: i18nT("Archiviazione...") });
      });
    });

    recsSent.querySelector("[data-load-more-sent-recs='1']")?.addEventListener("click", async (ev) => {
      ev.preventDefault();
      await runWithButtonLoading(ev.currentTarget, () => renderSentRecommendations({ reset: false }), {
        loadingLabel: i18nT("Caricamento..."),
      });
    });
    logPerf("account.renderSentRecommendations", startedAt, {
      reset,
      pageItems: page.items.length,
      totalItems: recSentRows.length,
      hasMore: recSentHasMore,
      fetchMs,
      preloadMs,
    });
  } catch (e) {
    console.error(e);
    recsSent.innerHTML = `<div class="hint">${i18nT("Errore caricamento")}</div>`;
  }
}

// ⭐ NUOVA funzione
window.openRecommendation = async function(recId, threadId) {
  if (!recId || !threadId) {
    console.error("openRecommendation: parametri mancanti", { recId, threadId });
    toast(i18nT("Errore: dati incompleti"), i18nT("Errore"));
    return;
  }
  try {
    await markRecommendationAsViewed(recId);
    window.location.href = `/thread.html?id=${threadId}`;
  } catch (err) {
    console.error(err);
    toast(i18nT("Errore apertura thread"), i18nT("Errore"));
  }
};

async function showFlashSuggestion() {
  if (!me || !btnFlashSuggest || !flashSuggestBox || !flashSuggestStatus || !flashSuggestModal) return;
  const runId = ++flashSuggestRunId;

  btnFlashSuggest.disabled = true;
  const old = getButtonLabelText(btnFlashSuggest);
  setButtonLabelText(btnFlashSuggest, i18nT("Suggerimento..."));

  openFlashSuggestModal();
  flashSuggestBox.innerHTML = "";
  flashSuggestStatus.innerHTML = `
    <div class="flash-suggest-loading">
      <span class="flash-suggest-spinner" aria-hidden="true"></span>
      <span id="flashSuggestLoadingText">${i18nT("Analizzo i tuoi gusti...")}</span>
    </div>
  `;
  const flashSuggestLoadingText = flashSuggestStatus.querySelector("#flashSuggestLoadingText");

  const loadingSteps = [
    { delay: 1200, text: i18nT("Confronto i match con la community...") },
    { delay: 3200, text: i18nT("Quasi pronto, scelgo il titolo migliore...") },
  ];

  const loadingTimers = loadingSteps.map((step) =>
    window.setTimeout(() => {
      if (runId !== flashSuggestRunId || !flashSuggestLoadingText) return;
      flashSuggestLoadingText.textContent = step.text;
    }, step.delay)
  );

  const clearLoadingTimers = () => loadingTimers.forEach((id) => window.clearTimeout(id));

  try {
    const res = await getMatchQueue({ max: 3, fastStart: true });
    if (runId !== flashSuggestRunId) return;

    const item = Array.isArray(res?.items) ? res.items[0] : null;
    if (!item) {
      flashSuggestStatus.innerHTML = `<div class="hint">${i18nT("Nessun suggerimento disponibile ora.")}</div>`;
      flashSuggestBox.innerHTML = `
        <div class="flash-suggest-actions">
          <button class="btn small primary" type="button" data-flash-retry>${i18nT("Riprova")}</button>
          <a class="btn small ghost" href="/match.html">Vai a Match</a>
        </div>
      `;
      flashSuggestBox.querySelector("[data-flash-retry]")?.addEventListener("click", () => showFlashSuggestion());
      return;
    }

    const year = item.year ? ` · ${escapeHtml(String(item.year))}` : "";
    const type = item.type ? escapeHtml(item.type === "tv" || item.type === "series" ? i18nT("Serie") : i18nT("Film")) : "";
    const match = item.matchPercent ? `Match ${item.matchPercent}%` : "";
    const poster = item.posterPath
      ? `<img src="${escapeHtml(item.posterPath)}" alt="${escapeHtml(item.name)}" loading="lazy" decoding="async">`
      : `<div style="padding:0.75rem;color:var(--text-secondary);font-weight:700;">No poster</div>`;

    flashSuggestStatus.innerHTML = `<div class="flash-suggest-ready">${i18nT("Ecco un titolo in linea con il tuo profilo.")}</div>`;
    flashSuggestBox.innerHTML = `
      <div class="flash-suggest-card">
        <div class="flash-suggest-poster">${poster}</div>
        <div class="flash-suggest-body">
          <h3>${escapeHtml(item.name || i18nT("Titolo"))}</h3>
          <p>${type}${year}${match ? " · " + match : ""}</p>
          <p class="flash-suggest-overview">${escapeHtml(item.overview || i18nT("Sembra in linea con i tuoi gusti."))}</p>
          <div class="flash-suggest-actions">
            <a class="btn small primary" href="/title.html?id=${encodeURIComponent(item.id)}">${i18nT("Apri scheda")}</a>
            <a class="btn small ghost" href="/match.html">Vai a Match</a>
            <button class="btn small ghost" type="button" data-close-flash-modal>${i18nT("Chiudi")}</button>
          </div>
        </div>
      </div>
    `;
    flashSuggestBox.querySelector("[data-close-flash-modal]")?.addEventListener("click", closeFlashSuggestModal);
  } catch (err) {
    if (runId !== flashSuggestRunId) return;
    console.error("flash suggestion error", err);
    flashSuggestStatus.innerHTML = `<div class="hint">${i18nT("Errore nel recupero del suggerimento.")}</div>`;
    flashSuggestBox.innerHTML = `
      <div class="flash-suggest-actions">
        <button class="btn small primary" type="button" data-flash-retry>${i18nT("Riprova")}</button>
      </div>
    `;
    flashSuggestBox.querySelector("[data-flash-retry]")?.addEventListener("click", () => showFlashSuggestion());
    toast(i18nT("Errore nel recupero suggerimento."), i18nT("Suggerimento"));
  } finally {
    clearLoadingTimers();
    setButtonLabelText(btnFlashSuggest, old);
    btnFlashSuggest.disabled = false;
  }
}
 

// Initialize
initAuthGuard({ requireAuth: true, onReady: async (user) => {
  me = await handleAppleLinkRedirect(user);
  me = me || user;

  // Banner permessi notifiche (best-effort)
  try { mountNotificationPermissionBanner({ containerSelector: "main.container", user: me }); } catch (_) {}

  void setAnalyticsUser(me);
  meName.textContent = me.displayName || "User";
  fitProfileName(meName, me.displayName || "User");
  renderAvatar(null, me.displayName || me.email || "");
  switchTab(resolveInitialAccountTab());
  renderLinkedProviders(me);

  await ensureUserDoc(me);

  // Push: setup UI (richiede click per chiedere permesso)
  setupPushButton(me);

  // Fetch user doc for handle, admin check, and photoURL
  meDoc = await getMyUserDoc(me.uid).catch(() => null);

  // Show avatar image if photoURL exists
  if (meDoc?.photoURL || meDoc?.avatarURL) {
    renderAvatar(meDoc.photoURL || meDoc.avatarURL, meDoc.displayName || me.displayName || "");
  }

  if (meDoc?.displayName) {
    meName.textContent = meDoc.displayName;
    fitProfileName(meName, meDoc.displayName);
  }

  // Imposta handle DOPO aver ottenuto meDoc
  const handle = (meDoc?.displayNameLower || me.uid).slice(0, 20);
  meEmail.textContent = `@${handle}`;
  updateProfileHeroNarrative();
  wireProfileTools(me);
  await resumeAccountDeletionAfterReauth(qs("#btnMenuDeleteAccount")).catch((err) => {
    console.error("account deletion reauth resume error", err);
    toast(i18nT("Conferma identità non riuscita. Riprova."), i18nT("Errore"));
  });

  const myLevel = String(meDoc?.level || "base").trim().toLowerCase();
  const canOpenModeration = !!meDoc?.isAdmin || (!!meDoc?.trusted && (myLevel === "associate" || myLevel === "doctor"));
  if (btnModeration && canOpenModeration){
    btnModeration.style.display = "inline-flex";
  }
  // Metriche prodotto: dashboard admin-only (stessa fonte di verita' della
  // console editoriale/analytics), non ai moderatori "trusted".
  if (btnMenuAdminMetrics && meDoc?.isAdmin){
    btnMenuAdminMetrics.hidden = false;
  }

  // Load data — indipendenti tra loro (nessuna dipendenza reale verificata:
  // deriveProfileContentCategory usata da loadMyVotesData legge title.genres
  // direttamente, non genreNameMap, quindi non serve aspettare
  // ensureGenresCatalogLoaded). Eseguiti in parallelo invece che in serie
  // (erano ~9 await sequenziali), ognuno con .catch dedicato cosi' un
  // fallimento non blocca gli altri. loadMyVotesData e' il primo elemento
  // cosi' la griglia "Visti" dipinge il prima possibile.
  wireNotificationPrefs();
  await Promise.all([
    loadMyVotesData().catch((err) => console.warn("[account] loadMyVotesData failed", err)),
    attachFollowersListener().catch((err) => console.warn("[account] attachFollowersListener failed", err)),
    attachFollowingListener().catch((err) => console.warn("[account] attachFollowingListener failed", err)),
    renderRecommendations().catch((err) => console.warn("[account] renderRecommendations failed", err)),
    renderSentRecommendations().catch((err) => console.warn("[account] renderSentRecommendations failed", err)),
    loadNotificationPrefs().catch((err) => console.warn("[account] loadNotificationPrefs failed", err)),
    ensureGenresCatalogLoaded().catch((err) => console.warn("[account] ensureGenresCatalogLoaded failed", err)),
    updatePersonalStats().catch((err) => console.warn("[account] updatePersonalStats failed", err)),
  ]);
}});


// render watchlist
async function renderWatchlist() {
  if (!watchlistList) return;
  watchlistList.innerHTML = `<div class="hint">${i18nT("Caricamento...")}</div>`;
  
  try {
    const [entries] = await Promise.all([
      getMyWatchlist(me.uid),
      ensureGenresCatalogLoaded(),
    ]);
    populateWatchlistGenreFilter(genresCatalog);
    
    if (!entries.length) {
      watchlistCache = [];
      watchlistSize = 0;
      watchlistList.style.display = "none";
      watchlistEmpty.style.display = "block";
      updatePersonalStatsCached();
      return;
    }
    
    // Batched read invece di N+1 (1 query/30 id).
    const idsToFetch = entries.filter(e => !e.pendingTitle).map(e => e.titleId).filter(Boolean);
    const wlTitlesMap = await getTitlesByIds(idsToFetch).catch(() => new Map());
    const rows = entries.map(entry => {
      if (entry.pendingTitle) return null;
      const title = wlTitlesMap.get(entry.titleId);
      return title ? { entry, title } : null;
    });

    watchlistCache = rows.filter(Boolean);
    refreshWatchlistFromCache();
    
  } catch (err) {
    console.error(err);
    watchlistList.innerHTML = `<div class="hint">${i18nT("Errore caricamento")}</div>`;
  }
}

function populateWatchlistGenreFilter(genres) {
  if (!watchlistFilterGenre) return;
  const options = ['<option value="all">Genere</option>']
    .concat(genres.map(g => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}</option>`));
  watchlistFilterGenre.innerHTML = options.join("");
}

function resolveWatchState(entry) {
  if (!entry) return "to_watch";
  if (entry.pendingTitle) return "pending";
  const raw = String(entry.watchState || entry.state || "").trim().toLowerCase();
  if (raw === "to_rate") return "to_rate";
  return "to_watch";
}

function watchStateOrder(entry) {
  const state = resolveWatchState(entry);
  if (state === "to_rate") return 0;
  if (state === "to_watch") return 1;
  return 2;
}

function rowMatchesWatchlistId(row, rawId) {
  const id = String(rawId || "");
  if (!id) return false;
  const candidates = [
    row?.entry?.id,
    row?.entry?.titleId,
    row?.title?.id,
  ].map((v) => String(v || "")).filter(Boolean);
  return candidates.includes(id);
}

function refreshWatchlistFromCache() {
  watchlistCache = safeArray(watchlistCache)
    .filter(Boolean)
    .sort((a, b) => watchStateOrder(a.entry) - watchStateOrder(b.entry));
  watchlistSize = watchlistCache.length;

  if (!watchlistSize) {
    if (watchlistList) {
      watchlistList.innerHTML = "";
      watchlistList.style.display = "none";
    }
    if (watchlistEmpty) watchlistEmpty.style.display = "block";
    updatePersonalStatsCached();
    return;
  }

  if (watchlistEmpty) watchlistEmpty.style.display = "none";
  renderWatchlistFiltered();
}

function markWatchlistItemAsToRateLocal(rawId) {
  const index = watchlistCache.findIndex((row) => rowMatchesWatchlistId(row, rawId));
  if (index < 0) return false;
  const row = watchlistCache[index];
  if (!row?.entry || row.entry.pendingTitle) return false;

  watchlistCache[index] = {
    ...row,
    entry: {
      ...row.entry,
      watchState: "to_rate",
      seenAt: row.entry.seenAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
  refreshWatchlistFromCache();
  return true;
}

function removeWatchlistItemLocal(rawId) {
  const before = watchlistCache.length;
  watchlistCache = safeArray(watchlistCache).filter((row) => !rowMatchesWatchlistId(row, rawId));
  const changed = watchlistCache.length !== before;
  if (changed) refreshWatchlistFromCache();
  return changed;
}

function renderWatchlistFiltered() {
  if (!watchlistList || !watchlistCache) return;
  const type = watchlistFilterType?.value || "all";
  const genre = watchlistFilterGenre?.value || "all";
  const yearMin = parseInt(watchlistFilterYear?.value || "0", 10) || 0;
  const search = (watchlistSearchInput?.value || "").trim().toLowerCase();

  let filtered = [];
  for (const row of watchlistCache) {
    const { entry, title } = row;
    const watchState = resolveWatchState(entry);

    if (watchlistStateFilter !== "all" && watchState !== watchlistStateFilter) continue;

    if (entry.pendingTitle) {
      if (type !== "all" && type !== "pending") continue;
      if (search && !entry.pendingTitle.name.toLowerCase().includes(search)) continue;
      filtered.push({ entry, title: null, watchState });
      continue;
    }
    if (!title) continue;

    if (type === "movie" && title.type !== "movie") continue;
    if (type === "tv" && title.type !== "tv") continue;
    if (type === "pending") continue;
    if (yearMin && Number(title.year || 0) < yearMin) continue;
    if (genre !== "all" && !safeArray(title.genres).includes(genre)) continue;
    if (search) {
      const hay = `${title.name} ${title.originalName || ""}`.toLowerCase();
      if (!hay.includes(search)) continue;
    }
    filtered.push({ entry, title, watchState });
  }

  // Sort
  if (watchlistSortMode === "az") {
    filtered.sort((a, b) => {
      const nameA = (a.title?.name || a.entry.pendingTitle?.name || "").toLowerCase();
      const nameB = (b.title?.name || b.entry.pendingTitle?.name || "").toLowerCase();
      return nameA.localeCompare(nameB);
    });
  }

  const blocks = filtered.map(({ entry, title, watchState }) => {
    if (entry.pendingTitle) {
      return `
        <div class="watchlist-row pending" data-entry-id="${escapeHtml(entry.id || entry.titleId || "")}">
          <div class="watchlist-row-inner">
            <div class="watchlist-row-top">
              <div class="watchlist-row-poster">
                <div class="poster-placeholder"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 3"></path></svg></div>
              </div>
              <div class="watchlist-row-body">
                <div class="watchlist-row-title">${escapeHtml(entry.pendingTitle.name)}</div>
                <div class="watchlist-row-meta-pills">
                  <span class="watchlist-meta-pill">In approvazione</span>
                </div>
                <div class="watchlist-row-status">${i18nT("Il titolo sarà disponibile dopo la revisione.")}</div>
              </div>
            </div>
          </div>
        </div>`;
    }

    const entryId = entry.id || entry.titleId || title.id;
    const typeLabel = title.type === "movie" ? i18nT("Film") : title.type === "tv" ? i18nT("Serie TV") : "";
    const yearLabel = title.year ? String(title.year) : "";
    const ratingValue = entry.lastRating ?? null;

    const poster = title.posterPath
      ? `<img src="${escapeHtml(title.posterPath)}" alt="${escapeHtml(title.name)}" loading="lazy">`
      : `<div class="poster-placeholder"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="20" height="20" rx="2"></rect><circle cx="12" cy="12" r="3"></circle></svg></div>`;

    const metaPills = [
      typeLabel ? `<span class="watchlist-meta-pill">${escapeHtml(typeLabel)}</span>` : "",
      yearLabel ? `<span class="watchlist-meta-pill is-mono">${escapeHtml(yearLabel)}</span>` : "",
      ratingValue !== null ? `<span class="watchlist-meta-pill is-rating"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>${escapeHtml(formatMaskedRating(ratingValue))}</span>` : "",
    ].filter(Boolean).join("");

    const statusLabel = watchState === "to_rate"
      ? i18nT("Hai visto questo titolo: aggiungi il tuo voto.")
      : i18nT("In attesa di essere visto.");

    const rateButton = `<button class="watchlist-icon-action is-rate" data-action="rate" data-entry-id="${escapeHtml(entryId)}" data-title-id="${escapeHtml(title.id)}" data-title-name="${escapeHtml(title.name)}" aria-label="${ratingValue !== null ? i18nT("Aggiorna il voto") : i18nT("Vota questo titolo")}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
    </button>`;
    const seenButton = watchState === "to_rate"
      ? ""
      : `<button class="watchlist-icon-action is-seen" data-action="watched" data-entry-id="${escapeHtml(entryId)}" data-title-id="${escapeHtml(title.id)}" aria-label="${i18nT("Segna come visto")}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
        </button>`;

    return `
      <div class="watchlist-row" data-entry-id="${escapeHtml(entryId)}" data-title-id="${escapeHtml(title.id)}">
        <div class="watchlist-swipe-bg right" aria-hidden="true">Visto ✓</div>
        <div class="watchlist-swipe-bg left" aria-hidden="true">${i18nT("Rimuovi")}</div>
        <div class="watchlist-row-inner">
          <div class="watchlist-row-top">
            <a class="watchlist-row-poster" href="/title.html?id=${encodeURIComponent(title.id)}" aria-label="${escapeHtml(title.name)}">${poster}</a>
            <div class="watchlist-row-body">
              <div class="watchlist-row-head">
                <a class="watchlist-row-title" href="/title.html?id=${encodeURIComponent(title.id)}">${escapeHtml(title.name)}</a>
                <svg class="watchlist-row-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>
              </div>
              ${metaPills ? `<div class="watchlist-row-meta-pills">${metaPills}</div>` : ""}
              <div class="watchlist-row-status">${statusLabel}</div>
            </div>
          </div>
          <div class="watchlist-row-actions">
            ${seenButton}
            ${rateButton}
          </div>
        </div>
      </div>`;
  });

  if (!blocks.length) {
    const emptyText = watchlistStateFilter === "to_rate"
      ? i18nT("Nessun titolo da votare per ora.")
      : watchlistStateFilter === "to_watch"
        ? i18nT("Nessun titolo da vedere per ora.")
        : i18nT("Nessun titolo trovato con questi filtri.");
    watchlistList.innerHTML = `<div class="profile-empty"><p class="profile-empty-text">${emptyText}</p></div>`;
    if (watchlistEmpty) watchlistEmpty.style.display = "none";
    return;
  }

  watchlistList.innerHTML = blocks.join("");
  watchlistList.style.display = "flex";
  if (watchlistEmpty) watchlistEmpty.style.display = "none";
  updatePersonalStatsCached();
}

// ===== RATING BOTTOM SHEET =====
const ratingSheetOverlay = qs("#ratingSheetOverlay");
const ratingSheetTitle = qs("#ratingSheetTitle");
const ratingSheetStars = qs("#ratingSheetStars");
const ratingSheetVariants = qs("#ratingSheetVariants");
const ratingSheetConfirm = qs("#ratingSheetConfirm");
const ratingSheetSkip = qs("#ratingSheetSkip");

let ratingSheetState = { titleId: null, entryId: null, selectedRating: 0, baseValue: 0 };

function formatRatingLabel(val) {
  const n = Number(val);
  const floor = Math.floor(n);
  const frac = Math.round((n - floor) * 100);
  if (frac === 0) return String(floor);
  if (frac === 25) return `${floor}+`;
  if (frac === 50) return `${floor}½`;
  if (frac === 75) return `${Math.min(10, floor + 1)}−`;
  return String(n);
}

function updateRatingSheetUI(selectedVal, baseVal) {
  // Highlight numeri base (tutti fino al base incluso)
  ratingSheetStars?.querySelectorAll(".rating-star").forEach((s) => {
    const v = Number(s.dataset.value);
    s.classList.toggle("active", v <= baseVal);
  });

  // Mostra varianti per il base selezionato
  if (ratingSheetVariants && baseVal > 0) {
    const variants = [];
    if (baseVal > 1) variants.push({ value: baseVal - 0.25, label: `${baseVal}−` });
    variants.push({ value: baseVal, label: `${baseVal}` });
    if (baseVal < 10) variants.push({ value: baseVal + 0.25, label: `${baseVal}+` });
    if (baseVal < 10) variants.push({ value: baseVal + 0.5, label: `${baseVal}½` });

    ratingSheetVariants.innerHTML = variants.map(v =>
      `<button class="rating-variant${v.value === selectedVal ? " active" : ""}" data-value="${v.value}">${v.label}</button>`
    ).join("");
    ratingSheetVariants.style.display = "flex";
  }

  // Aggiorna bottone conferma
  if (ratingSheetConfirm) {
    ratingSheetConfirm.disabled = false;
    ratingSheetConfirm.textContent = i18nT("Conferma: {rating}", { rating: formatRatingLabel(selectedVal) });
  }
}

function openRatingSheet(titleId, entryId, titleName) {
  ratingSheetState = { titleId, entryId, selectedRating: 0, baseValue: 0 };
  if (ratingSheetTitle) ratingSheetTitle.textContent = titleName || i18nT("Vota");
  if (ratingSheetConfirm) { ratingSheetConfirm.disabled = true; ratingSheetConfirm.textContent = i18nT("Conferma voto"); }
  ratingSheetStars?.querySelectorAll(".rating-star").forEach((s) => s.classList.remove("active"));
  if (ratingSheetVariants) { ratingSheetVariants.innerHTML = ""; ratingSheetVariants.style.display = "none"; }
  ratingSheetOverlay?.classList.add("open");
  ratingSheetOverlay?.setAttribute("aria-hidden", "false");
}

function closeRatingSheet() {
  ratingSheetOverlay?.classList.remove("open");
  ratingSheetOverlay?.setAttribute("aria-hidden", "true");
  ratingSheetState = { titleId: null, entryId: null, selectedRating: 0, baseValue: 0 };
}

// Click su numero base → mostra varianti
ratingSheetStars?.addEventListener("click", (e) => {
  const star = e.target.closest(".rating-star");
  if (!star) return;
  const baseVal = Number(star.dataset.value);
  ratingSheetState.baseValue = baseVal;
  ratingSheetState.selectedRating = baseVal;
  updateRatingSheetUI(baseVal, baseVal);
});

// Click su variante (−, base, +, ½)
ratingSheetVariants?.addEventListener("click", (e) => {
  const btn = e.target.closest(".rating-variant");
  if (!btn) return;
  const val = Number(btn.dataset.value);
  ratingSheetState.selectedRating = val;
  updateRatingSheetUI(val, ratingSheetState.baseValue);
});

// Conferma voto
ratingSheetConfirm?.addEventListener("click", async () => {
  const { titleId, selectedRating } = ratingSheetState;
  if (!titleId || !selectedRating || !me) return;
  ratingSheetConfirm.disabled = true;
  ratingSheetConfirm.textContent = i18nT("Salvataggio...");
  try {
    await upsertRating({ uid: me.uid, titleId, level: "title", rating: selectedRating });
    if (!removeWatchlistItemLocal(titleId)) {
      await renderWatchlist();
    }
    toast(i18nT("Votato {rating}", { rating: formatRatingLabel(selectedRating) }), i18nT("Ok"));
    closeRatingSheet();
  } catch (err) {
    console.error("Rating error", err);
    toast(i18nT("Errore nel salvataggio"), i18nT("Errore"));
    ratingSheetConfirm.disabled = false;
    ratingSheetConfirm.textContent = i18nT("Conferma: {rating}", { rating: formatRatingLabel(selectedRating) });
  }
});

// Skip: segna come visto senza voto
ratingSheetSkip?.addEventListener("click", async () => {
  const { titleId, entryId } = ratingSheetState;
  if (!me) return;
  await runWithButtonLoading(ratingSheetSkip, async () => {
    try {
      await markAsWatched(me.uid, titleId || entryId, { source: "watchlist_rating_skip" });
      if (!markWatchlistItemAsToRateLocal(titleId || entryId)) {
        await renderWatchlist();
      }
      toast("Spostato in Da votare", "Ok", { type: "success" });
      closeRatingSheet();
    } catch (err) {
      console.error("Mark watched error", err);
      toast(i18nT("Errore, riprova"), i18nT("Errore"), { type: "error" });
    }
  }, { loadingLabel: i18nT("Salvataggio...") });
});

// Chiudi cliccando sull'overlay
ratingSheetOverlay?.addEventListener("click", (e) => {
  if (e.target === ratingSheetOverlay) closeRatingSheet();
});

// Azioni watchlist via event delegation sui bottoni
watchlistList?.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn || !me) return;
  const action = btn.dataset.action;
  const entryId = btn.dataset.entryId;
  const titleId = btn.dataset.titleId;
  if (!entryId) return;

  // "Vota" → apre il bottom sheet
  if (action === "rate") {
    const titleName = btn.dataset.titleName || "";
    openRatingSheet(titleId || entryId, entryId, titleName);
    return;
  }

  // "Visto" → segna come visto direttamente
  const row = btn.closest(".watchlist-row");
  if (action === "remove") {
    try {
      const rowState = safeArray(watchlistCache).find(({ entry, title }) => {
        const entryDocId = String(entry?.id || entry?.titleId || "");
        const titleDocId = String(title?.id || "");
        const lookupId = String(titleId || entryId || "");
        return entryDocId === lookupId || titleDocId === lookupId;
      });
      if (rowState && resolveWatchState(rowState.entry) === "to_rate") {
        toast(i18nT("Questo titolo resta in Da votare finché non lo voti."), i18nT("Watchlist"));
        return;
      }
      const ok = await showConfirm(i18nT("Vuoi rimuovere questo titolo dalla watchlist?"));
      if (!ok) return;
      if (row) {
        row.style.maxHeight = row.offsetHeight + "px";
        row.classList.add("removing");
      }
    } catch (err) {
      console.error("Watchlist action error", err);
      toast(i18nT("Errore, riprova"), i18nT("Errore"), { type: "error" });
      return;
    }
  }

  await runWithButtonLoading(btn, async () => {
    try {
      if (action === "watched") {
        await markAsWatched(me.uid, titleId || entryId, { source: "watchlist_row_action" });
        if (!markWatchlistItemAsToRateLocal(titleId || entryId)) await renderWatchlist();
        toast("Spostato in Da votare", "Ok", { type: "success" });
      } else if (action === "remove") {
        await removeFromWatchlist(me.uid, entryId);
        if (!removeWatchlistItemLocal(entryId)) await renderWatchlist();
        toast(i18nT("Rimosso dalla watchlist"), "Ok", { type: "success" });
      }
    } catch (err) {
      console.error("Watchlist action error", err);
      if (row) row.classList.remove("removing");
      toast(i18nT("Errore, riprova"), i18nT("Errore"), { type: "error" });
    }
  }, { loadingLabel: action === "remove" ? i18nT("Rimozione...") : i18nT("Salvataggio...") });
});

async function loadNotificationPrefs() {
  if (!notifPrefs || !me) return;
  const container = notifPrefs.parentElement || notifPrefs;
  hideErrorBanner(container);
  try {
    const prefs = await getNotificationPrefs(me.uid);
    notifDisabled = new Set(prefs.disabledTypes || []);
    notifPrefs.querySelectorAll("input[type='checkbox']").forEach((chk) => {
      const t = chk.dataset.type;
      chk.checked = !notifDisabled.has(t);
    });
    if (notifPrefsStatus) {
      notifPrefsStatus.textContent = "Preferenze salvate.";
      notifPrefsStatus.style.color = "var(--text-muted)";
    }
  } catch (err) {
    console.warn("Notif prefs load failed", err);
    showErrorBanner(container, i18nT("Errore nel caricamento delle notifiche"), () => loadNotificationPrefs());
    if (notifPrefsStatus) {
      notifPrefsStatus.textContent = i18nT("Impossibile caricare le preferenze notifiche.");
      notifPrefsStatus.style.color = "var(--danger)";
    }
  }
}

function wireNotificationPrefs() {
  if (!notifPrefs) return;
  notifPrefs.querySelectorAll("input[type='checkbox']").forEach((chk) => {
    chk.addEventListener("change", async () => {
      const type = chk.dataset.type;
      if (!type) return;
      if (!chk.checked) notifDisabled.add(type);
      else notifDisabled.delete(type);
      if (notifPrefsStatus) {
        notifPrefsStatus.textContent = i18nT("Salvataggio...");
        notifPrefsStatus.style.color = "var(--text-muted)";
      }
      try {
        await setNotificationPrefs(me.uid, Array.from(notifDisabled));
        if (notifPrefsStatus) {
          notifPrefsStatus.textContent = "Preferenze salvate.";
          notifPrefsStatus.style.color = "var(--text-muted)";
        }
      } catch (err) {
        console.error("Notif prefs save failed", err);
        if (notifPrefsStatus) {
          notifPrefsStatus.textContent = i18nT("Errore nel salvataggio.");
          notifPrefsStatus.style.color = "var(--danger)";
        }
      }
    });
  });
}

async function updatePersonalStats() {
  if (!personalStats || !me) return;

  // Fase 1 (veloce): user doc + activity summary in parallelo → render watch time + categorie SUBITO.
  // Sono entrambi single-doc/callable, leggono `users/{uid}.stats` cached server-side.
  let activitySummary = null;
  let userStats = {};
  let watchedCount = 0;
  let reviewCount = 0;
  try {
    const [freshDoc, summary] = await Promise.all([
      getMyUserDoc(me.uid).catch(() => null),
      getPublicProfileActivitySummary(me.uid).catch(() => null),
    ]);
    if (freshDoc) meDoc = freshDoc;
    activitySummary = summary;
    if (summary) personalActivitySummaryCache = summary;

    userStats = meDoc?.stats && typeof meDoc.stats === "object" ? meDoc.stats : {};
    const totalMinutes = Number.isFinite(Number(activitySummary?.totalWatchMinutes))
      ? Number(activitySummary.totalWatchMinutes)
      : (Number.isFinite(Number(userStats.totalWatchMinutes)) ? Number(userStats.totalWatchMinutes) : 0);
    watchedCount = Number.isFinite(Number(activitySummary?.watchedTitlesCount))
      ? Number(activitySummary.watchedTitlesCount)
      : (Number.isFinite(Number(userStats.watchedCount)) ? Number(userStats.watchedCount) : 0);
    // Titoli votati. Fonte: `stats.ratingsCount`, mantenuto server-side sui
    // titleStates e riconciliato ogni settimana — conta i TITOLI votati, non i
    // doc `ratings`. Contare i doc (vecchio comportamento) gonfiava il numero
    // quando un titolo veniva accorpato e restava un rating con il vecchio id
    // (4 casi in prod al 2026-08-05). `stats.reviewsCount` invece non lo
    // aggiorna nessuno: resta 0 e non va usato.
    reviewCount = Number.isFinite(Number(userStats.ratingsCount)) && Number(userStats.ratingsCount) > 0
      ? Number(userStats.ratingsCount)
      : await countTitleRatings(me.uid, 0);

    setStatValue(statsWatched, watchedCount);
    setReviewBadgeValue(statsReviews, reviewCount);
    // Nella hero il numero sta gia' sopra l'etichetta "Review": qui va il
    // valore nudo, non "N review".
    setStatValue(statsReviewsHero, reviewCount);
    setDerivedRatingsCaption(statsDerivedRatings, userStats.derivedRatingsCount);
    applyWatchTimeSummary(totalMinutes);
    renderCategoryStrip(activitySummary?.byCategory);
  } catch (err) {
    console.warn("activity summary load failed", err);
    applyWatchTimeSummary(0);
    renderCategoryStrip(null);
  }

  // Fase 2 (più lenta, async): ratings + watchlist + topGenre. Non blocca il watch time.
  try {
    const [ratings, watchEntries] = await Promise.all([
      listMyTitleRatings(me.uid, { max: 400 }).catch(() => []),
      watchlistSize ? Promise.resolve(null) : getMyWatchlist(me.uid).catch(() => []),
    ]);
    const ratedCount = Number.isFinite(Number(userStats.ratingsCount))
      ? Number(userStats.ratingsCount)
      : ratings.length;
    const avg = ratings.length
      ? (ratings.reduce((s, r) => s + (Number(r.rating) || 0), 0) / ratings.length)
      : 0;

    // Fix N+1: batched read invece di N getDoc paralleli; cap a 80 (campione sufficiente per topGenre).
    const TOP_GENRE_SAMPLE = 80;
    const sampleIds = ratings
      .map((r) => r.titleId)
      .filter(Boolean)
      .slice(0, TOP_GENRE_SAMPLE);
    const titlesMap = await getTitlesByIds(sampleIds).catch(() => new Map());
    const genreCount = new Map();
    for (const t of titlesMap.values()) {
      if (!t) continue;
      safeArray(t.genres).forEach((g) => {
        genreCount.set(g, (genreCount.get(g) || 0) + 1);
      });
    }
    let topGenre = "-";
    if (genreCount.size) {
      const [best] = [...genreCount.entries()].sort((a, b) => b[1] - a[1]);
      topGenre = resolveGenreLabel(best[0]) || "-";
    }

    const watchCount = watchlistSize || (Array.isArray(watchEntries) ? watchEntries.length : 0);
    watchlistSize = watchCount;
    const totalMinutes = Number.isFinite(Number(activitySummary?.totalWatchMinutes))
      ? Number(activitySummary.totalWatchMinutes)
      : (Number.isFinite(Number(userStats.totalWatchMinutes)) ? Number(userStats.totalWatchMinutes) : 0);
    const watchHours = totalMinutes >= 60 ? Math.round(totalMinutes / 60) : (totalMinutes > 0 ? "<1" : "-");

    statRatedCount.textContent = ratedCount;
    statAvgRating.textContent = ratedCount ? avg.toFixed(1) : "-";
    statTopGenre.textContent = topGenre;
    if (statWatchHours) statWatchHours.textContent = String(watchHours);
    statWatchlistRatio.textContent = String(watchCount);
    personalStats.style.display = "grid";
    updateProfileHeroNarrative({ ratedCount, topGenre, watchCount });
  } catch (err) {
    console.warn("stats load failed", err);
    updateProfileHeroNarrative();
  }
}

function updatePersonalStatsCached() {
  // Refresh the watchlist count without reloading the rest of the profile stats.
  if (!statWatchlistRatio) return;
  statWatchlistRatio.textContent = String(Number.isFinite(Number(watchlistSize)) ? Number(watchlistSize) : 0);
  if (personalActivitySummaryCache && Number(personalActivitySummaryCache.totalWatchMinutes || 0) > 0) {
    applyWatchTimeSummary(personalActivitySummaryCache.totalWatchMinutes);
  }
  updateProfileHeroNarrative();
}
