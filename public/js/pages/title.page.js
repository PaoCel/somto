import { initAuthGuard } from "../components/authGuard.js";
import { t as i18nT, formatDate, getLocale } from "../i18n/index.js";
import { qs, escapeHtml } from "../utils/dom.js";
import { stripLeadingEmoji, slugify } from "../utils/text.js";
import { toast } from "../components/toast.js";
import { runWithButtonLoading } from "../utils/loading.js";

import { applyTitleStateAction, getMyTitleState, markMovieUnseen, markSeriesUnstarted } from "../api/titleStates.api.js";
import { getTitleWatchersProgress } from "../api/library.api.js";
import { showConfirm } from "../utils/confirmDialog.js";

import { ensureUserDoc, getMyUserDoc } from "../api/users.api.js";
import { getTitleById, getTitlesByIds, updateTitle, buildTitleSearchIndex, refreshTitleFromTmdbIfNeeded } from "../api/titles.api.js";
import { listGenres, tmdbGenreCatalog } from "../api/genres.api.js";
import { proposeTitleEdit } from "../api/titleEdits.api.js";
import { listFriends, getUserPublic, listFollowing, listUsersPublicByIds } from "../api/users.api.js";
import { createRecommendation } from "../api/recommendations.api.js";
import { ensurePublicThread, ensureDMThread, ensureGroupThread, sendMessage, listMyGroups, listEpisodeThreadDocs, listenThreadMessages, sendThreadMessage } from "../api/threads.api.js";
import { searchPeopleByPrefix, createPerson, bumpPeopleOccurrences } from "../api/people.api.js";
import { trapFocus } from "../utils/focusTrap.js";
import { getTmdbTrailer, getTrailerByName, getTitleVideos, getTitleReleaseInfo, fetchSeasonEpisodes, peekSeasonEpisodes } from "../api/tmdb.api.js";
import { getWatchProviders, suggestWatchProvider } from "../api/providers.api.js";
import {
  getTitleUpdatePreference,
  listLinkedOfficialPosts,
  listTitleUpdateEvents,
  setTitleUpdatePreference,
} from "../api/titleUpdates.api.js";
import { logEvent, setAnalyticsUser } from "../analytics.js";

// NEW
import { upsertRating, listRatingsForTitle, getMyRating, updateReviewText, migrateRatingLevel, deleteRating, getDerivedRating } from "../api/ratings.api.js";
import { mountNotificationPermissionBanner } from "../components/notifyPermissionBanner.js";
import { uploadPoster, uploadRatingPhoto } from "../api/storage.api.js";
import { logSignal } from "../api/signals.api.js";
import { fetchListsContainingTitle } from "../api/userLists.api.js";
import { EMOTION_KEYS, EMOTION_META, getMyTitleEmotions, upsertTitleEmotions } from "../api/emotions.api.js";
import { getMyEpisodeEmotions, upsertEpisodeEmotions } from "../api/episodeEmotions.api.js";
import { decidePostEpisodeFlow } from "../utils/postEpisodeFlow.js";
import { attachMentionAutocomplete, renderMentionRichText } from "../components/mentionAutocomplete.js";
import {
  characterCandidatesFromTitle,
  fetchEpisodeCharacterCandidates,
  upsertCharacterPicks,
  getMyCharacterPicks,
  characterPicksEqual,
  fetchTitleCharacterAggregate,
  fetchMyCharacterPicksRollup,
  pickCommunityBucket,
  characterAppreciation,
  fetchFullTitleCast,
  rankCharacterCounts,
  fetchEpisodeCharacterBuckets,
  seasonCharacterCounts,
} from "../api/characterVotes.api.js";

console.log("✅ title.page.js LOADED", location.href);

const navAccount = qs("#navAccount");

const tName = qs("#tName");
const tSub = qs("#tSub");
const tGenres = qs("#tGenres");
const tFacts = qs("#tFacts");
const posterLg = qs("#posterLg"); // legacy fallback
const tVisibility = qs("#tVisibility"); // (nel nuovo layout potresti non usarlo)
const tEditHint = qs("#tEditHint"); // (nel nuovo layout potresti non usarlo)

// Social summary (hero tiles)
const statCommunity = qs("#statCommunity");
const statCommunitySub = qs("#statCommunitySub");
const statFriends = qs("#statFriends");
const statFriendsSub = qs("#statFriendsSub");
const statExperts = qs("#statExperts");
const statExpertsSub = qs("#statExpertsSub");
const friendsMiniRow = qs("#friendsMiniRow");

// ⭐ WATCHLIST BUTTON (INLINE IN HEADER)
const watchlistBtn = qs("#watchlistBtn");
const shareTitleBtn = qs("#shareTitleBtn");
const guestUnlockCard = qs("#guestUnlockCard");
const guestUnlockBtn = qs("#guestUnlockBtn");

// Hero header elements (mirror: TitleHeroHeader)
const heroVoteBtn = qs("#heroVoteBtn");
const heroVoteBtnLabel = qs("#heroVoteBtnLabel");
const moreActionsBtn = qs("#moreActionsBtn");
const tTypeBadge = qs("#tTypeBadge");
const tYearBadge = qs("#tYearBadge");
const tOriginal = qs("#tOriginal");
const tStatusRow = qs("#tStatusRow");
const tDuration = qs("#tDuration");
const tDurationText = qs("#tDurationText");

// Recommend UI
const recBox = qs("#recBox");
const btnOpenRecommend = qs("#btnOpenRecommend");
const recHint = qs("#recHint");
const recModal = qs("#recModal");
const recTo = qs("#recTo");
const recMsg = qs("#recMsg");
const recSend = qs("#recSend");
const recStatus = qs("#recStatus");

// Threads UI
const threadBox = qs("#threadBox");
const btnOpenPublicThread = qs("#btnOpenPublicThread");
const btnOpenDmThread = qs("#btnOpenDmThread");
const btnOpenGroupThread = qs("#btnOpenGroupThread");
const threadHint = qs("#threadHint");

const threadModal = qs("#threadModal");
const thrTabDm = qs("#thrTabDm");
const thrTabGroup = qs("#thrTabGroup");
const thrDmPanel = qs("#thrDmPanel");
const thrGroupPanel = qs("#thrGroupPanel");
const thrTo = qs("#thrTo");
const thrGroupName = qs("#thrGroupName");
const thrGroupMembers = qs("#thrGroupMembers");
const thrOpen = qs("#thrOpen");
const thrStatus = qs("#thrStatus");

// Review Modal
const castCard = qs("#castCard");
const castGrid = qs("#castGrid");
const castShowAllBtn = qs("#castShowAllBtn");
const castVoteBtn = qs("#castVoteBtn");
const castModal = qs("#castModal");
const castModalTitle = qs("#castModalTitle");
const castModalHint = qs("#castModalHint");
const castModalGrid = qs("#castModalGrid");
const castModalActions = qs("#castModalActions");
const castModalSave = qs("#castModalSave");
const reviewModal = qs("#reviewModal");
const revHint = qs("#revHint");
const revRatingBox = qs("#revRatingBox");
const revText = qs("#revText");
const revCharCount = qs("#revCharCount");
const revWatchedWithChips = qs("#revWatchedWithChips");
const revWatchedWithSearch = qs("#revWatchedWithSearch");
const revWatchedWithResults = qs("#revWatchedWithResults");
const revWatchedWithHint = qs("#revWatchedWithHint");
const revPhotoFile = qs("#revPhotoFile");
const revPhotoRemove = qs("#revPhotoRemove");
const revPhotoPreview = qs("#revPhotoPreview");
const revPrivate = qs("#revPrivate");
const revPublic = qs("#revPublic");
const revGroup = qs("#revGroup");
const revGroupSelector = qs("#revGroupSelector");
const revGroupList = qs("#revGroupList");
const revNoGroups = qs("#revNoGroups");
const revNewGroup = qs("#revNewGroup");
const revNewGroupForm = qs("#revNewGroupForm");
const revNewGroupName = qs("#revNewGroupName");
const revNewGroupMembers = qs("#revNewGroupMembers");
const revCreateGroup = qs("#revCreateGroup");
const revSubmit = qs("#revSubmit");
const revStatus = qs("#revStatus");
const myReviewPreview = qs("#myReviewPreview");
const myReviewText = qs("#myReviewText");
const btnEditReview = qs("#btnEditReview");

const emotionsPickerCard = qs("#emotionsPickerCard");
const emotionsPickerGrid = qs("#emotionsPickerGrid");
const revEmotionsGrid = qs("#revEmotionsGrid");
const emotionsCommunityCard = qs("#emotionsCommunityCard");
const emotionsCommunitySub = qs("#emotionsCommunitySub");
const emotionsCommunityList = qs("#emotionsCommunityList");

// Personaggi preferiti ("Chi ti ha conquistato?")
const charactersCard = qs("#charactersCard");
const charactersCardSub = qs("#charactersCardSub");
const charactersCardBody = qs("#charactersCardBody");
const charactersFullModal = qs("#charactersFullModal");
const charactersFullSub = qs("#charactersFullSub");
const charactersFullList = qs("#charactersFullList");
const revCharactersField = qs("#revCharactersField");
const revCharactersRow = qs("#revCharactersRow");

// Community rating distribution (/10, PART A)
const communityDistributionCard = qs("#communityDistributionCard");
const communityRatingRing = qs("#communityRatingRing");
const communityRatingRingValue = qs("#communityRatingRingValue");
const communityRatingCount = qs("#communityRatingCount");
const communityDistributionBars = qs("#communityDistributionBars");

// Episode action sheet (PART B)
const epActionSheet = qs("#epActionSheet");
const epSheetTitle = qs("#epSheetTitle");
const epSheetMeta = qs("#epSheetMeta");
const epSheetStats = qs("#epSheetStats");
const epSheetSeenBtn = qs("#epSheetSeenBtn");
const epSheetVoteToggle = qs("#epSheetVoteToggle");
const epSheetVoteBox = qs("#epSheetVoteBox");
const epSheetCommentsBtn = qs("#epSheetCommentsBtn");
const epSheetCommentsLabel = qs("#epSheetCommentsLabel");

// Episode SEEN sheet (post "segnato visto": voto episodio + emozioni + CTA)
const epSeenSheet = qs("#epSeenSheet");
const epSeenTitle = qs("#epSeenTitle");
const epSeenSub = qs("#epSeenSub");
const epSeenVoteBox = qs("#epSeenVoteBox");
const epSeenEmotionsField = qs("#epSeenEmotionsField");
const epSeenEmotionsGrid = qs("#epSeenEmotionsGrid");
const epSeenEmotionsStatus = qs("#epSeenEmotionsStatus");
const epSeenCharactersRow = qs("#epSeenCharactersRow");
const epSeenCharactersStatus = qs("#epSeenCharactersStatus");
const epSeenTalk = qs("#epSeenTalk");
const epSeenCommentBtn = qs("#epSeenCommentBtn");

// Episode discussion sheet (in-page, sostituisce la navigazione a thread.html)
const epDiscussionSheet = qs("#epDiscussionSheet");
const epDiscCode = qs("#epDiscCode");
const epDiscEpisodeName = qs("#epDiscEpisodeName");
const epDiscGate = qs("#epDiscGate");
const epDiscGateText = qs("#epDiscGateText");
const epDiscGateEnter = qs("#epDiscGateEnter");
const epDiscThread = qs("#epDiscThread");
const epDiscMessages = qs("#epDiscMessages");
const epDiscEmpty = qs("#epDiscEmpty");
const epDiscComposerForm = qs("#epDiscComposerForm");
const epDiscComposerInput = qs("#epDiscComposerInput");
const epDiscComposerSend = qs("#epDiscComposerSend");
const epDiscMentionDropdown = qs("#epDiscMentionDropdown");

const btnEdit = qs("#btnEdit");
const btnSuggest = qs("#btnSuggest");
const trailerCard = qs("#trailerCard");
const trailerPlayer = qs("#trailerPlayer");
const trailerFallback = qs("#trailerFallback");
const trailerWatchOnYt = qs("#trailerWatchOnYt");
const titleNewsCard = qs("#titleNewsCard");
const titleNewsUpcoming = qs("#titleNewsUpcoming");
const titleNewsVideos = qs("#titleNewsVideos");
const titleUpdatesHost = qs("#titleUpdatesHost");
const titleUpdatesEmpty = qs("#titleUpdatesEmpty");
const titleUpdatesLoading = qs("#titleUpdatesLoading");
const titleUpdatesError = qs("#titleUpdatesError");
const titleUpdatesRetry = qs("#titleUpdatesRetry");
const titleUpdatePreferences = qs("#titleUpdatePreferences");
const watchProvidersCard = qs("#watchProvidersCard");
const watchProvidersMeta = qs("#watchProvidersMeta");
const watchProvidersList = qs("#watchProvidersList");
const watchProvidersSuggestBtn = qs("#watchProvidersSuggestBtn");
const watchProvidersTmdblink = qs("#watchProvidersTmdblink");
const personalStateCard = qs("#personalStateCard");
const personalStateSummary = qs("#personalStateSummary");
const personalStateMeta = qs("#personalStateMeta");
const personalStateActions = qs("#personalStateActions");
const episodesTabBtn = qs("#episodesTabBtn");
const episodesPanel = qs("#episodesPanel");
const btnWriteReviewSocial = qs("#btnWriteReviewSocial");
const friendsReviewsList = qs("#friendsReviewsList");
const communityReviewsList = qs("#communityReviewsList");
const seriesWatchersCard = qs("#seriesWatchersCard");
const seriesWatchersList = qs("#seriesWatchersList");
const titleListsCard = qs("#titleListsCard");
const titleListsList = qs("#titleListsList");

// ratings containers
const ratingTitleBox = qs("#ratingTitleBox");
const seasonsBox = qs("#seasonsBox");
const noSeasonsHint = qs("#noSeasonsHint");
const myRatingsBreakdownCard = qs("#myRatingsBreakdown");
const myRatingsBreakdownBody = qs("#myRatingsBreakdownBody");

// edit ui
const editBox = qs("#editBox");
const editTitle = qs("#editTitle");
const editSubtitle = qs("#editSubtitle");
const editForm = qs("#editForm");
const editStatus = qs("#editStatus");
const btnCancelEdit = qs("#btnCancelEdit");
const btnSaveEdit = qs("#btnSaveEdit");

const eName = qs("#eName");
const eType = qs("#eType");
const eYear = qs("#eYear");

const eRowDurationMovie = qs("#eRowDurationMovie");
const eDurationMovie = qs("#eDurationMovie");

const eRowTvFields = qs("#eRowTvFields");
const eSeasonsCount = qs("#eSeasonsCount");
const eEpisodesPerSeason = qs("#eEpisodesPerSeason");
const eDurationEpisode = qs("#eDurationEpisode");

const eRowTvSeasonsDetail = qs("#eRowTvSeasonsDetail");
const eTogglePerSeason = qs("#eTogglePerSeason");
const eSeasonsDetailGrid = qs("#eSeasonsDetailGrid");

const eGenres = qs("#eGenres");

const eDescription = qs("#eDescription");
const eOriginalName = qs("#eOriginalName");
const eAliases = qs("#eAliases");
const eLanguage = qs("#eLanguage");
const eCountry = qs("#eCountry");
const eNetwork = qs("#eNetwork");

// people edit (directors / cast)
const eDirectorsSelected = qs("#eDirectorsSelected");
const eDirectorSearch = qs("#eDirectorSearch");
const eDirectorResults = qs("#eDirectorResults");
const eCastSelected = qs("#eCastSelected");
const eCastSearch = qs("#eCastSearch");
const eCastResults = qs("#eCastResults");

// poster edit
const ePosterFile = qs("#ePosterFile");
const ePosterPreview = qs("#ePosterPreview");
const ePosterRemove = qs("#ePosterRemove");

// ===== STATS TOOLTIP (NEW) =====
const statTooltip = qs("#statTooltip");
const tooltipContent = qs("#tooltipContent");
let tooltipTimeout = null;

// Friends votes modal (NEW)
const friendsVotesModal = qs("#friendsVotesModal");
const friendsVotesTitle = qs("#friendsVotesTitle");
const friendsVotesHint = qs("#friendsVotesHint");
const friendsVotesList = qs("#friendsVotesList");

// Attach tooltip listeners (NEW)
const statCommunityBtn = qs("#statCommunityBtn");
const statFriendsBtn = qs("#statFriendsBtn");
const statExpertsBtn = qs("#statExpertsBtn");

// ===== EDIT BADGE (NEW) =====
const btnEditHeader = qs("#btnEditHeader");
const editBadge = qs("#editBadge");

// ===== CORRELATI TAB (NEW) =====
const relatedList = qs("#relatedList");
const relatedEmpty = qs("#relatedEmpty");
const btnAddRelated = qs("#btnAddRelated");
const relatedModal = qs("#relatedModal");
const relatedSearch = qs("#relatedSearch");
const relatedSearchResults = qs("#relatedSearchResults");
const relatedSearchStatus = qs("#relatedSearchStatus");

let relatedTitles = []; // Array of related title IDs
let searchDebounce = null;

const id = new URLSearchParams(location.search).get("id");

let currentUser = null;
let myUserDoc = null;
let currentTitle = null;
let currentTitleState = null;

let genreMap = new Map();
let allGenres = [];

let ratings = []; // tutti i rating per questo title
let myDerivedRating = null; // voto serie/stagione DERIVATO dai voti episodio (privato)

let myEmotions = []; // chiavi selezionate dall'utente per questo titolo (title-level)
let _revEmotionsDraft = []; // stato del picker dentro il modale review, salvato al submit

// Personaggi preferiti ("Chi ti ha conquistato?") — due contesti indipendenti
// (stessa distinzione di emozioni/rating): episodio = salva al tocco dentro
// il foglio "episodio visto"; titolo = draft locale nel modale review,
// committato solo al submit (solo film, le serie votano per episodio).
let _epSeenCharacterCandidates = [];
let _epSeenCharactersLoading = false;
let _epSeenCharacterPicks = [];
let _epSeenCharacterReactionTarget = null;
let _epSeenEmotions = [];
let _epSeenEmotionsLoading = false;

let _revCharacterCandidates = [];
let _revCharacterDraft = [];
let _revCharacterInitialPicks = [];
let _revCharacterReactionTarget = null;

let _charactersFetchedForTitleId = null; // cache: aggregato+rollup fetchati una volta per titolo
let _titleCharacterAggregate = null;
let _myCharacterPicksRollup = null;
let _titleCharacterCandidateCache = []; // cast titolo, per i nomi nei risultati aggregati

let friendsCache = null; // [{uid,...}]
let usersCache = new Map(); // uid -> userDoc

let posterDraft = { file: null, remove: false, previewUrl: null };

// edit state
let editDirectors = [];
let editCast = [];
let editSeasonsMeta = [];

function avg(nums) {
  const arr = nums.filter(n => Number.isFinite(n));
  if (!arr.length) return null;
  return Math.round((arr.reduce((a,b)=>a+b,0)/arr.length) * 10) / 10;
}

function fmtStat(val){
  if (val === null || val === undefined) return "—";
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return n.toFixed(1);
}

function pill(text) {
  return `<span class="pill">${escapeHtml(text)}</span>`;
}

function kv(label, value) {
  if (value === null || value === undefined || value === "") return "";
  return `<div class="kv-row"><div class="k">${escapeHtml(label)}</div><div class="v">${escapeHtml(String(value))}</div></div>`;
}

/* ========================================
   TAB NAVIGATION (NEW)
======================================== */
const tabBtns = document.querySelectorAll(".tab-btn");
const tabPanels = document.querySelectorAll(".tab-panel");
const titleQuery = new URLSearchParams(location.search || "");
const initialTabFocus = String(titleQuery.get("focus") || "").trim().toLowerCase();
let hasAppliedContextualTabFocus = false;

// Il redesign porta i contenuti esistenti nella nuova architettura senza
// duplicare query o perdere azioni: Novità vive in Aggiornamenti, Correlati
// diventa l'ultima sezione di Panoramica.
const overviewPanel = document.querySelector('[data-panel="overview"]');
const legacyRelatedPanel = document.querySelector('[data-panel="correlati"]');
if (titleUpdatesHost && titleNewsCard) titleUpdatesHost.append(titleNewsCard);
if (overviewPanel && legacyRelatedPanel?.firstElementChild) {
  overviewPanel.append(legacyRelatedPanel.firstElementChild);
  legacyRelatedPanel.remove();
}

function normalizedTitleTab(tabName) {
  const aliases = {
    info: "overview",
    correlati: "overview",
    social: "community",
    news: "updates",
    novita: "updates",
  };
  return aliases[tabName] || tabName;
}

function switchTab(tabName) {
  const normalizedTab = normalizedTitleTab(tabName);
  tabBtns.forEach(btn => {
    const isVisible = btn.style.display !== "none";
    if (btn.dataset.tab === normalizedTab && isVisible) btn.classList.add("active");
    else btn.classList.remove("active");
  });

  tabPanels.forEach(panel => {
    const isVisible = panel.style.display !== "none";
    if (panel.dataset.panel === normalizedTab && isVisible) panel.classList.add("active");
    else panel.classList.remove("active");
  });
}

function setTabVisibility(tabName, isVisible) {
  tabBtns.forEach(btn => {
    if (btn.dataset.tab === tabName) btn.style.display = isVisible ? "" : "none";
  });
  tabPanels.forEach(panel => {
    if (panel.dataset.panel === tabName) panel.style.display = isVisible ? "" : "none";
  });
}

function contextualInitialTab(title) {
  if (initialTabFocus === "rating" || initialTabFocus === "ratings") {
    return title?.type === "tv" ? "episodes" : "community";
  }
  if (initialTabFocus === "episodes") {
    return title?.type === "tv" ? "episodes" : "community";
  }
  if (["overview", "updates", "community", "info", "correlati", "social", "news", "novita"].includes(initialTabFocus)) {
    return normalizedTitleTab(initialTabFocus);
  }
  return null;
}

function syncTitleTabs(title) {
  const hasEpisodes = title?.type === "tv";
  setTabVisibility("episodes", hasEpisodes);

  const activeTab = Array.from(tabBtns).find(btn => btn.classList.contains("active"))?.dataset?.tab;
  if (!hasEpisodes && activeTab === "episodes") {
    switchTab("overview");
  }

  if (!hasAppliedContextualTabFocus) {
    const preferred = contextualInitialTab(title);
    if (preferred) switchTab(preferred);
    hasAppliedContextualTabFocus = true;
  }
}

tabBtns.forEach(btn => {
  btn.addEventListener("click", () => {
    switchTab(btn.dataset.tab);
  });
});

// Default tab (se nessuna è attiva)
(function initTabsDefault(){
  if (!tabBtns.length || !tabPanels.length) return;
  const alreadyActive = Array.from(tabBtns).some(b => b.classList.contains("active"));
  if (alreadyActive) {
    if (initialTabFocus === "social") switchTab("community");
    return;
  }
  if (initialTabFocus === "social") {
    switchTab("community");
    return;
  }
  const first = tabBtns[0];
  if (first?.dataset?.tab) switchTab(first.dataset.tab);
})();

/* ========================================
   ONBOARDING LEGGERO DELLA NUOVA SCHEDA
======================================== */
const TITLE_DETAIL_TOUR_VERSION = 1;
const TITLE_DETAIL_TOUR_KEY = "somto.titleDetailTourVersion";
let hasPresentedTitleDetailTour = false;

function storedTitleDetailTourVersion() {
  try {
    return Number(localStorage.getItem(TITLE_DETAIL_TOUR_KEY) || 0);
  } catch (_) {
    return 0;
  }
}

function storeTitleDetailTourVersion() {
  try {
    localStorage.setItem(TITLE_DETAIL_TOUR_KEY, String(TITLE_DETAIL_TOUR_VERSION));
  } catch (_) {}
}

function maybePresentTitleDetailTour() {
  if (hasPresentedTitleDetailTour) return;
  const forceTour = titleQuery.get("tour") === "1";
  if (!forceTour && storedTitleDetailTourVersion() >= TITLE_DETAIL_TOUR_VERSION) return;

  // Non sovrapporre due richieste al primo ingresso: il consenso rimane la
  // priorità e il tour parte subito dopo la scelta dell'utente.
  const consentBanner = document.getElementById("somtoConsentBanner");
  if (consentBanner && getComputedStyle(consentBanner).display !== "none") {
    if (consentBanner.dataset.titleTourWaiting !== "1") {
      consentBanner.dataset.titleTourWaiting = "1";
      consentBanner.addEventListener("click", (event) => {
        const choice = event.target?.closest?.("#somtoConsentAccept, #somtoConsentReject");
        if (choice) window.setTimeout(maybePresentTitleDetailTour, 250);
      });
    }
    return;
  }
  hasPresentedTitleDetailTour = true;

  const steps = [
    {
      eyebrow: i18nT("Il tuo percorso"),
      title: i18nT("Tutto quello che stai guardando, subito"),
      copy: i18nT("Stato, progresso e azioni rapide sono raccolti sotto il titolo."),
    },
    {
      eyebrow: i18nT("Aggiornamenti"),
      title: i18nT("Trailer e uscite hanno un posto dedicato"),
      copy: i18nT("Lo storico del titolo resta separato dagli episodi e dalla community."),
    },
    {
      eyebrow: i18nT("Azioni rapide"),
      title: i18nT("I tre puntini restano il centro di gestione"),
      copy: i18nT("Liste, rewatch e altre azioni sono ancora lì, in una vista più compatta."),
    },
  ];

  const layer = document.createElement("div");
  layer.className = "title-vnext-tour";
  layer.innerHTML = `
    <button class="title-vnext-tour__backdrop" type="button" aria-label="${escapeHtml(i18nT("Salta"))}"></button>
    <section class="title-vnext-tour__sheet" role="dialog" aria-modal="true" aria-labelledby="titleVNextTourTitle">
      <div class="title-vnext-tour__grabber" aria-hidden="true"></div>
      <div class="title-vnext-tour__progress" aria-hidden="true"></div>
      <p class="title-vnext-tour__eyebrow"></p>
      <h2 id="titleVNextTourTitle"></h2>
      <p class="title-vnext-tour__copy"></p>
      <div class="title-vnext-tour__actions">
        <button class="btn ghost title-vnext-tour__skip" type="button">${escapeHtml(i18nT("Salta"))}</button>
        <button class="btn primary title-vnext-tour__next" type="button"></button>
      </div>
    </section>`;
  document.body.append(layer);

  const titleEl = layer.querySelector("#titleVNextTourTitle");
  const eyebrowEl = layer.querySelector(".title-vnext-tour__eyebrow");
  const copyEl = layer.querySelector(".title-vnext-tour__copy");
  const progressEl = layer.querySelector(".title-vnext-tour__progress");
  const nextBtn = layer.querySelector(".title-vnext-tour__next");
  const skipBtn = layer.querySelector(".title-vnext-tour__skip");
  let stepIndex = -1;
  let releaseTrap = () => {};

  const finish = () => {
    storeTitleDetailTourVersion();
    releaseTrap();
    document.body.classList.remove("title-vnext-tour-open");
    layer.remove();
  };

  const render = () => {
    if (stepIndex < 0) {
      eyebrowEl.textContent = i18nT("Novità");
      titleEl.textContent = i18nT("La scheda titolo è cambiata");
      copyEl.textContent = i18nT("Abbiamo aggiornato questa schermata. Puoi vedere cosa è cambiato oppure esplorarla da solo.");
      progressEl.innerHTML = "";
      skipBtn.textContent = i18nT("Salta");
      nextBtn.textContent = i18nT("Mostrami le novità");
      return;
    }

    const step = steps[stepIndex];
    eyebrowEl.textContent = step.eyebrow;
    titleEl.textContent = step.title;
    copyEl.textContent = step.copy;
    progressEl.innerHTML = steps.map((_, index) => `<span class="${index <= stepIndex ? "active" : ""}"></span>`).join("");
    nextBtn.textContent = stepIndex === steps.length - 1 ? i18nT("Chiudi") : i18nT("Avanti");
  };

  nextBtn.addEventListener("click", () => {
    if (stepIndex === steps.length - 1) {
      finish();
      return;
    }
    stepIndex += 1;
    render();
  });
  skipBtn.addEventListener("click", finish);
  layer.querySelector(".title-vnext-tour__backdrop")?.addEventListener("click", finish);

  render();
  document.body.classList.add("title-vnext-tour-open");
  releaseTrap = trapFocus(layer, {
    initialFocus: ".title-vnext-tour__next",
    onEscape: finish,
  });
}

/* ========================================
   BACKDROP IMAGE (NEW)
======================================== */
function setBackdropImage(posterUrl) {
  const backdrop = qs("#titleBackdrop");
  if (!backdrop || !posterUrl) return;

  backdrop.style.setProperty("--backdrop-image", `url(${posterUrl})`);
  backdrop.classList.add("loaded");
}

/* ========================================
   STATS TOOLTIP (NEW)
======================================== */
function showStatTooltip(type) {
  if (!statTooltip || !tooltipContent) return;

  const messages = {
    community: i18nT("Media di tutti i voti dati a questo titolo su Giavisto."),
    friends: i18nT("Media dei voti dati dai tuoi amici a questo titolo."),
    experts: i18nT("Media dei voti dati da utenti appassionati di questo genere.")
  };

  tooltipContent.textContent = messages[type] || "";
  statTooltip.style.display = "block";

  clearTimeout(tooltipTimeout);
  tooltipTimeout = setTimeout(() => {
    statTooltip.style.display = "none";
  }, 3000);
}

if (statCommunityBtn) statCommunityBtn.addEventListener("click", () => showStatTooltip("community"));
// On "Amici" click show the list of friends' votes (instead of tooltip)
if (statFriendsBtn) statFriendsBtn.addEventListener("click", () => openFriendsVotesModal());
if (statExpertsBtn) statExpertsBtn.addEventListener("click", () => showStatTooltip("experts"));

function starIconSvg(){
  // Lucide "star" (open-source - ISC)
  return `
    <svg class="friend-vote-star" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
    </svg>
  `;
}

function safeDisplayName(userDoc){
  const dn = (userDoc && typeof userDoc.displayName === "string") ? userDoc.displayName.trim() : "";
  if (dn) return dn;
  // fallback non-identificativo (mai UID)
  const email = (userDoc && typeof userDoc.email === "string") ? userDoc.email.trim() : "";
  if (email && email.includes("@")) return email.split("@")[0];
  return i18nT("Utente");
}

function initialsFromName(name){
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean).slice(0,2);
  const init = parts.map(p => p[0].toUpperCase()).join("");
  return init || "?";
}

function safeImgUrl(url){
  const u = String(url || '').trim();
  return (u && u.startsWith('https://')) ? u : '';
}

async function openFriendsVotesModal(){
  if (!currentUser) return;
  if (!friendsVotesModal || !friendsVotesList || !friendsVotesHint) return;

  friendsVotesHint.style.display = "none";
  friendsVotesList.innerHTML = "";
  if (friendsVotesTitle) friendsVotesTitle.textContent = i18nT("Voti dei tuoi amici");

  const friends = await ensureFriends().catch(() => []);
  const fSet = new Set((friends || []).map(f => f.uid));
  if (!fSet.size){
    friendsVotesHint.style.display = "block";
    friendsVotesHint.textContent = i18nT("Non hai ancora amici.");
    openModal(friendsVotesModal);
    return;
  }

  const { titleRatings } = computeTitleBuckets();
  const fr = titleRatings.filter(r => fSet.has(r.uid));
  if (!fr.length){
    friendsVotesHint.style.display = "block";
    friendsVotesHint.textContent = i18nT("Nessuno dei tuoi amici ha ancora votato questo titolo.");
    openModal(friendsVotesModal);
    return;
  }

  const sorted = fr.slice().sort((a,b) => Number(b.rating) - Number(a.rating));
  await ensureUsers(sorted.map(r => r.uid));

  const rows = sorted.map(r => {
    const u = usersCache.get(r.uid) || null;
    const name = safeDisplayName(u);
    const initials = initialsFromName(name);
    const ratingVal = formatMaskedRating(r.rating);
    return `
      <div class="friend-vote-row" data-uid="${escapeHtml(r.uid)}" role="button" tabindex="0">
        <div class="friend-vote-left">
          <div class="friend-vote-avatar">${escapeHtml(initials)}</div>
          <div class="friend-vote-name">${escapeHtml(name)}</div>
        </div>
        <div class="friend-vote-right">
          ${starIconSvg()}
          <span>${escapeHtml(ratingVal)}</span>
        </div>
      </div>
    `;
  }).join("");

  friendsVotesList.innerHTML = rows;

  friendsVotesList.querySelectorAll(".friend-vote-row").forEach(el => {
    const u = el.getAttribute("data-uid");
    const go = () => {
      if (u) location.href = `/user.html?uid=${encodeURIComponent(u)}`;
    };
    el.addEventListener("click", go);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " "){
        e.preventDefault();
        go();
      }
    });
  });

  openModal(friendsVotesModal);
}

/* ========================================
   ⭐ WATCHLIST FUNCTIONS (NUOVO)
======================================== */
function isCompletedPersonalState(state) {
  if (!state) return false;
  return state.mediaType === "tv"
    ? (state.state === "completed_unrated" || state.state === "rated" || state.completedCount > 0)
    : (state.state === "seen_unrated" || state.state === "rated" || state.completedCount > 0);
}

function hasStartedPersonalState(state) {
  if (!state) return false;
  return state.mediaType === "tv"
    ? ["in_progress", "completed_unrated", "rated"].includes(state.state) || state.completedCount > 0
    : ["seen_unrated", "rated"].includes(state.state) || state.completedCount > 0;
}

function formatWatchMinutesShort(totalMinutes) {
  const minutes = Math.max(0, Number(totalMinutes || 0) || 0);
  if (!minutes) return "0 min";
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours > 0 && mins > 0) return `${hours} h ${mins} min`;
  if (hours > 0) return `${hours} h`;
  return `${mins} min`;
}

function safePersonalProgress(state) {
  const progress = state?.seriesProgress && typeof state.seriesProgress === "object"
    ? state.seriesProgress
    : null;
  return {
    episodesWatchedCount: Number(progress?.episodesWatchedCount || 0) || 0,
    seasonsCompletedCount: Number(progress?.seasonsCompletedCount || 0) || 0,
    totalEpisodeCount: Number(progress?.totalEpisodeCount || 0) || 0,
    totalSeasonCount: Number(progress?.totalSeasonCount || 0) || 0,
    lastWatchedSeasonNumber: Number(progress?.lastWatchedSeasonNumber || 0) || 0,
    lastWatchedEpisodeNumber: Number(progress?.lastWatchedEpisodeNumber || 0) || 0,
  };
}

function buildPersonalStateSummary(state) {
  if (!state || !currentTitle) {
    return {
      summary: i18nT("Ancora nessuna attivita personale su questo titolo."),
      meta: "",
    };
  }

  const ratingLabel = Number.isFinite(Number(state.ratingValue)) ? i18nT("Voto titolo: {rating}", { rating: formatMaskedRating(state.ratingValue) }) : null;
  const rewatchLabel = state.completedCount > 1 ? i18nT("{count} rewatch completati", { count: state.completedCount - 1 }) : null;
  const minutesLabel = state.watchMinutesContribution > 0 ? i18nT("{time} tracciati", { time: formatWatchMinutesShort(state.watchMinutesContribution) }) : null;

  if (state.mediaType === "movie") {
    let summary = i18nT("Non ancora visto");
    if (state.state === "rated") summary = i18nT("Film visto e votato.");
    else if (state.state === "seen_unrated") summary = i18nT("Film visto, in attesa del voto.");
    else if (state.generalWatchlist) summary = i18nT("Nella watchlist generale.");

    return {
      summary,
      meta: [ratingLabel, rewatchLabel, minutesLabel].filter(Boolean).join(" • "),
    };
  }

  const progress = safePersonalProgress(state);
  let summary = i18nT("Serie non iniziata.");
  if (state.state === "in_progress") {
    summary = progress.totalEpisodeCount > 0
      ? i18nT("{watched}/{total} episodi visti", { watched: progress.episodesWatchedCount, total: progress.totalEpisodeCount })
      : i18nT("{count} episodi visti", { count: progress.episodesWatchedCount });
  } else if (state.state === "completed_unrated") {
    summary = i18nT("Serie completata, in attesa del voto.");
  } else if (state.state === "rated") {
    summary = i18nT("Serie completata e votata.");
  } else if (state.generalWatchlist) {
    summary = i18nT("Serie in watchlist generale.");
  }

  if (state.rewatchIntent) {
    summary = `${summary} ${i18nT("Rewatch attivo.")}`;
  }

  return {
    summary,
    meta: [ratingLabel, rewatchLabel, minutesLabel].filter(Boolean).join(" • "),
  };
}

async function refreshPersonalState() {
  if (!currentUser || !currentTitle?.id) {
    currentTitleState = null;
    updateWatchlistButton(false);
    renderPersonalStateCard();
    return null;
  }

  try {
    currentTitleState = await getMyTitleState(currentUser.uid, currentTitle.id);
    updateWatchlistButton(Boolean(currentTitleState?.generalWatchlist));
    renderPersonalStateCard();
    return currentTitleState;
  } catch (err) {
    console.error("Errore caricamento titleState:", err);
    return null;
  }
}

async function checkWatchlistStatus() {
  await refreshPersonalState();
}

function updateWatchlistButton(inWatchlist) {
  if (!watchlistBtn) return;

  watchlistBtn.dataset.inWatchlist = inWatchlist ? "true" : "false";

  if (inWatchlist) {
    watchlistBtn.classList.add("active");
    watchlistBtn.setAttribute("aria-label", i18nT("Rimuovi dalla watchlist"));
  } else {
    watchlistBtn.classList.remove("active");
    watchlistBtn.setAttribute("aria-label", i18nT("Aggiungi a watchlist"));
  }
}

async function handleWatchlistToggle() {
  if (!currentUser) {
    toast(i18nT("Devi essere loggato per usare la watchlist"), "Login");
    const next = encodeURIComponent(location.pathname + location.search);
    location.href = `/login.html?next=${next}`;
    return;
  }

  if (!currentTitle?.id) return;

  const inWatchlist = watchlistBtn.dataset.inWatchlist === "true";
  
  await runWithButtonLoading(watchlistBtn, async () => {
    try {
      await applyTitleStateAction({
        titleId: currentTitle.id,
        action: "toggle_watchlist",
        enabled: !inWatchlist,
        source: "title_page_watchlist",
      });
      await refreshPersonalState();
      toast(inWatchlist ? i18nT("Rimosso dalla watchlist") : i18nT("Aggiunto alla watchlist"), i18nT("Watchlist"));
    } catch (err) {
      console.error("Errore watchlist:", err);
      toast(err?.message || i18nT("Errore. Riprova."), i18nT("Watchlist"), { type: "error" });
    }
  });
}

// Event listener watchlist button
if (watchlistBtn) {
  watchlistBtn.addEventListener("click", handleWatchlistToggle);
}

async function handlePersonalStateAction(action, extra = {}) {
  if (!currentUser) {
    toast(i18nT("Accedi per aggiornare il tuo stato."), "Login");
    const next = encodeURIComponent(location.pathname + location.search);
    location.href = `/login.html?next=${next}`;
    return false;
  }
  if (!currentTitle?.id) return false;

  try {
    const preservedSeasonState = captureSeasonRenderState();
    await applyTitleStateAction({
      titleId: currentTitle.id,
      action,
      source: extra.source || "title_page",
      enabled: extra.enabled,
      episodesWatchedCount: extra.episodesWatchedCount,
      seasonsCompletedCount: extra.seasonsCompletedCount,
      lastWatchedSeasonNumber: extra.lastWatchedSeasonNumber,
      lastWatchedEpisodeNumber: extra.lastWatchedEpisodeNumber,
    });
    await refreshPersonalState();
    renderRatings(currentTitle);
    restoreSeasonRenderState(preservedSeasonState);
    return true;
  } catch (err) {
    console.error("[titleState] action error:", action, err);
    toast(err?.message || i18nT("Errore nel salvataggio dello stato."), i18nT("Stato personale"));
    return false;
  }
}

/**
 * Dopo "Segna visto"/"Segna completata": apri subito il modale recensione
 * (voto facoltativo dentro al modale). Solo se l'utente non ha già un voto
 * title-level, per non riproporre il foglio a chi ha già votato.
 */
function maybeOpenReviewAfterSeen() {
  if (!currentUser || !currentTitle) return false;
  if (!isCompletedPersonalState(currentTitleState)) return false;
  const myTitle = findMyRating("title");
  if (Number.isFinite(Number(myTitle?.rating))) return false;
  void openReviewModal(null);
  return true;
}

/**
 * "Segna come non visto": riporta il titolo in da-vedere.
 *
 * Se esiste un voto dell'utente (a qualsiasi livello title/season/episode),
 * l'azione di unsee lato server NON cancella i doc /ratings → resterebbero
 * voti orfani che continuano a gonfiare l'aggregato community. Quindi qui
 * eliminiamo prima TUTTI i voti dell'utente per questo titolo, poi applichiamo
 * l'azione di unsee.
 */
async function handleMarkUnseen() {
  if (!currentUser) {
    toast(i18nT("Accedi per aggiornare il tuo stato."), "Login");
    location.href = loginHrefWithNext();
    return;
  }
  if (!currentTitle?.id) return;

  const mediaType = currentTitle.type === "tv" ? "tv" : "movie";
  // Solo il voto title-level è legato allo stato "visto": rimuoviamo quello per
  // evitare l'orfano che gonfia l'aggregato. Eventuali voti per stagione/episodio
  // sono item indipendenti (hanno un loro "Rimuovi voto") e NON vengono toccati,
  // per parità col comportamento iOS e per non azzerarli di nascosto.
  const myTitleRating = (ratings || []).find(
    (r) => r.uid === currentUser.uid && (r.level || "title") === "title"
  );
  const hasRating = !!myTitleRating;

  const message = hasRating
    ? i18nT("Segnare come non visto? Il titolo torna tra i \"da vedere\" e il tuo voto verrà rimosso.")
    : i18nT("Segnare come non visto? Il titolo torna tra i \"da vedere\".");
  const ok = await showConfirm(message);
  if (!ok) return;

  try {
    const preservedSeasonState = captureSeasonRenderState();

    // 1) Elimina il voto title-level dell'utente (evita l'orfano che gonfia
    //    l'aggregato). Le rules permettono la delete al proprietario;
    //    il trigger recomputeTitleRatingAggregate sottrae il delta.
    if (myTitleRating) {
      await deleteRating({
        titleId: currentTitle.id,
        level: "title",
        season: 0,
        episode: 0,
      });
    }

    // 2) Riporta lo stato a non-visto / non-iniziato.
    if (mediaType === "tv") {
      await markSeriesUnstarted(currentTitle.id);
    } else {
      await markMovieUnseen(currentTitle.id);
    }

    ratings = await listRatingsForTitle(currentTitle.id);
    await refreshPersonalState();
    renderRatings(currentTitle);
    renderSummaryStats().catch(() => {});
    restoreSeasonRenderState(preservedSeasonState);
    toast(hasRating ? i18nT("Segnato come non visto. Voto rimosso.") : i18nT("Segnato come non visto."), i18nT("Fatto"));
  } catch (err) {
    console.error("[titleState] mark unseen error:", err);
    toast(err?.message || i18nT("Impossibile aggiornare lo stato. Riprova."), i18nT("Errore"));
  }
}

function captureSeasonRenderState() {
  if (!seasonsBox) return null;
  const openSeasons = Array.from(seasonsBox.querySelectorAll("details.season[open]"))
    .map((seasonEl) => {
      const match = seasonEl.querySelector("summary b")?.textContent?.match(/(\d+)/);
      return match ? Number(match[1]) : null;
    })
    .filter(Number.isFinite);

  return {
    openSeasons,
    scrollY: window.scrollY || 0,
  };
}

function restoreSeasonRenderState(state) {
  if (!state || !seasonsBox) return;

  requestAnimationFrame(() => {
    (state.openSeasons || []).forEach((seasonNumber) => {
      const detail = Array.from(seasonsBox.querySelectorAll("details.season")).find((seasonEl) => {
        const match = seasonEl.querySelector("summary b")?.textContent?.match(/(\d+)/);
        return match && Number(match[1]) === Number(seasonNumber);
      });
      if (detail) detail.open = true;
    });

    if (Number.isFinite(state.scrollY)) {
      window.scrollTo({ top: state.scrollY, behavior: "instant" });
    }
  });
}

function renderPersonalStateActions(state) {
  if (!personalStateActions || !currentTitle) return;

  const buttons = [];
  const mediaType = currentTitle.type === "tv" ? "tv" : "movie";
  const isCompleted = isCompletedPersonalState(state);
  const isStarted = hasStartedPersonalState(state);

  if (mediaType === "movie") {
    buttons.push({
      label: state?.rewatchIntent ? i18nT("Completa rewatch") : i18nT("Segna visto"),
      className: "btn primary small",
      onClick: async () => {
        const saved = await handlePersonalStateAction("mark_movie_seen", { source: "title_page_movie_seen" });
        if (saved) maybeOpenReviewAfterSeen();
      },
    });
    if (isCompleted && !state?.rewatchIntent) {
      buttons.push({
        label: i18nT("Aggiungi a rewatch"),
        className: "btn ghost small",
        onClick: () => handlePersonalStateAction("set_rewatch_intent", { source: "title_page_rewatch_on" }),
      });
    }
    if (state?.rewatchIntent) {
      buttons.push({
        label: i18nT("Annulla rewatch"),
        className: "btn ghost small",
        onClick: () => handlePersonalStateAction("clear_rewatch_intent", { source: "title_page_rewatch_off" }),
      });
    }
    if (isCompleted) {
      buttons.push({
        label: i18nT("Segna come non visto"),
        className: "btn ghost small",
        onClick: () => handleMarkUnseen(),
      });
    }
  } else {
    if (!isCompleted || state?.rewatchIntent) {
      buttons.push({
        label: i18nT("+1 episodio"),
        className: "btn primary small",
        onClick: () => handleMarkEpisodeAndNudge(),
      });
      buttons.push({
        label: i18nT("+1 stagione"),
        className: "btn ghost small",
        onClick: async () => {
          const saved = await handlePersonalStateAction("mark_series_season", { source: "title_page_series_season" });
          if (saved) maybeOpenReviewAfterSeen();
        },
      });
      buttons.push({
        label: state?.rewatchIntent ? i18nT("Completa rewatch") : i18nT("Segna completata"),
        className: "btn ghost small",
        onClick: async () => {
          const saved = await handlePersonalStateAction("mark_series_completed", { source: "title_page_series_completed" });
          if (saved) maybeOpenReviewAfterSeen();
        },
      });
    }
    if (isCompleted && !state?.rewatchIntent) {
      buttons.push({
        label: i18nT("Aggiungi a rewatch"),
        className: "btn ghost small",
        onClick: () => handlePersonalStateAction("set_rewatch_intent", { source: "title_page_rewatch_on" }),
      });
    }
    if (state?.rewatchIntent) {
      buttons.push({
        label: i18nT("Annulla rewatch"),
        className: "btn ghost small",
        onClick: () => handlePersonalStateAction("clear_rewatch_intent", { source: "title_page_rewatch_off" }),
      });
    }
    if (!isStarted && !state?.generalWatchlist) {
      buttons.push({
        label: i18nT("Aggiungi a watchlist"),
        className: "btn ghost small",
        onClick: () => handlePersonalStateAction("toggle_watchlist", { enabled: true, source: "title_page_watchlist_cta" }),
      });
    }
    if (isStarted) {
      buttons.push({
        label: i18nT("Segna come non vista"),
        className: "btn ghost small",
        onClick: () => handleMarkUnseen(),
      });
    }
  }

  personalStateActions.innerHTML = "";
  buttons.forEach((button) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = button.className;
    el.textContent = button.label;
    el.addEventListener("click", () => runWithButtonLoading(
      el,
      () => button.onClick(),
      { loadingLabel: i18nT("Salvataggio...") },
    ));
    personalStateActions.appendChild(el);
  });
}

function renderPersonalStateCard() {
  // Gate anti-spoiler dei "Personaggi preferiti" dipende da currentTitleState:
  // questa funzione è il choke point unico chiamato ogni volta che quello
  // stato cambia (refreshPersonalState, azioni "segna visto"/completata...),
  // quindi è il punto giusto per rivalutarlo, login o non-login incluso.
  void refreshCharacterResults();

  if (!personalStateCard || !personalStateSummary || !personalStateMeta) return;
  if (!currentTitle) {
    personalStateCard.style.display = "none";
    return;
  }

  personalStateCard.style.display = "block";

  if (!currentUser) {
    personalStateSummary.textContent = i18nT("Segna visto, episodi, stagioni e rewatch senza dover votare subito.");
    personalStateMeta.textContent = i18nT("Accedi per salvare il tuo stato personale su questo titolo.");
    personalStateActions.innerHTML = "";

    const loginBtn = document.createElement("button");
    loginBtn.type = "button";
    loginBtn.className = "btn primary small";
    loginBtn.textContent = i18nT("Accedi per tracciare");
    loginBtn.addEventListener("click", () => {
      const next = encodeURIComponent(location.pathname + location.search);
      location.href = `/login.html?next=${next}`;
    });
    personalStateActions.appendChild(loginBtn);
    return;
  }

  const summary = buildPersonalStateSummary(currentTitleState);
  personalStateSummary.textContent = summary.summary;
  personalStateMeta.textContent = summary.meta || "";
  renderPersonalStateActions(currentTitleState);
  renderHeroStatusRow();
  updateHeroVoteLabel();
}

// ── Hero vote button (mirror: TitleHeroHeader heroVoteChip / star icon button) ──
function updateHeroVoteLabel() {
  if (!heroVoteBtnLabel || !heroVoteBtn) return;
  const myTitle = (ratings || []).find(r => r.uid === currentUser?.uid && r.level === "title");
  const rating = Number(myTitle?.rating);
  if (Number.isFinite(rating)) {
    heroVoteBtnLabel.textContent = formatMaskedRating(rating);
    heroVoteBtn.classList.add("has-rating");
  } else {
    heroVoteBtnLabel.textContent = i18nT("Vota");
    heroVoteBtn.classList.remove("has-rating");
  }
}

// Hero vote button: jump to the Social tab where the rating row lives.
if (heroVoteBtn) {
  heroVoteBtn.addEventListener("click", () => {
    if (!currentUser) {
      const next = encodeURIComponent(location.pathname + location.search);
      location.href = `/login.html?next=${next}`;
      return;
    }
    switchTab("social");
    requestAnimationFrame(() => {
      ratingTitleBox?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });
}

// ── Hero "more actions" menu (mirror: TitleHeroHeader ellipsis / WatchActionsSheet) ──
var heroMenuPop = null;

function closeHeroMenu() {
  if (heroMenuPop) {
    if (typeof heroMenuPop._releaseTrap === "function") heroMenuPop._releaseTrap();
    heroMenuPop.remove();
    heroMenuPop = null;
    document.body.classList.remove("title-actions-open");
  }
}

if (moreActionsBtn) {
  moreActionsBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (heroMenuPop) { closeHeroMenu(); return; }
    if (!currentTitle) return;

    const items = [];
    const url = buildTitleShareUrl(currentTitle.id);

    items.push({
      label: i18nT("Condividi titolo"),
      icon: `<path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><path d="M16 6l-4-4-4 4"/><path d="M12 2v13"/>`,
      onClick: () => { handleShareTitle(); },
    });

    if (currentUser) {
      const inWatchlist = watchlistBtn?.dataset.inWatchlist === "true";
      items.push({
        label: inWatchlist ? i18nT("Rimuovi dalla watchlist") : i18nT("Aggiungi alla watchlist"),
        icon: `<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>`,
        onClick: () => { handleWatchlistToggle(); },
      });
      items.push({
        label: canDirectEdit() ? i18nT("Modifica contenuto") : i18nT("Proponi una modifica"),
        icon: `<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>`,
        onClick: () => {
          if (!currentTitle) return;
          fillEditFormFromTitle(currentTitle);
          showEditBox(canDirectEdit() ? "edit" : "suggest");
        },
      });
    }

    const pop = document.createElement("div");
    pop.className = "title-hero-menu-pop";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-modal", "true");
    pop.setAttribute("aria-labelledby", "titleActionsHeading");
    pop.innerHTML = `
      <button class="title-hero-menu-backdrop" type="button" aria-label="${escapeHtml(i18nT("Chiudi"))}"></button>
      <section class="title-hero-menu-sheet">
        <div class="title-hero-menu-grabber" aria-hidden="true"></div>
        <div class="title-hero-menu-head">
          <strong id="titleActionsHeading">${escapeHtml(i18nT("Gestisci titolo"))}</strong>
          <button class="title-hero-menu-close" type="button" aria-label="${escapeHtml(i18nT("Chiudi"))}">×</button>
        </div>
        <div class="title-hero-menu-list">
          ${items.map((it, i) => `
            <button type="button" data-menu-idx="${i}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${it.icon}</svg>
              <span>${escapeHtml(it.label)}</span>
              <span class="title-hero-menu-arrow" aria-hidden="true">›</span>
            </button>
          `).join("")}
        </div>
      </section>`;

    document.body.appendChild(pop);
    heroMenuPop = pop;
    document.body.classList.add("title-actions-open");
    pop._releaseTrap = trapFocus(pop, {
      initialFocus: ".title-hero-menu-close",
      onEscape: closeHeroMenu,
    });
    pop.querySelector(".title-hero-menu-close")?.addEventListener("click", closeHeroMenu);
    pop.querySelector(".title-hero-menu-backdrop")?.addEventListener("click", closeHeroMenu);

    pop.querySelectorAll("[data-menu-idx]").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-menu-idx"));
        closeHeroMenu();
        items[idx]?.onClick?.();
      });
    });
  });
}

document.addEventListener("click", (e) => {
  if (heroMenuPop && !heroMenuPop.contains(e.target) && e.target !== moreActionsBtn && !moreActionsBtn?.contains(e.target)) {
    closeHeroMenu();
  }
});

async function handleShareTitle() {
  if (!currentTitle) return;
  const url = buildTitleShareUrl(currentTitle.id);
  const shareTitle = `${currentTitle.name || i18nT("Titolo")} | Somto`;

  try {
    if (navigator.share) {
      // In alcune app target il payload text+url genera URL duplicata.
      // Qui inviamo solo title+url per avere una condivisione pulita.
      await navigator.share({ title: shareTitle, url });
      return;
    }
  } catch (err) {
    if (err?.name !== "AbortError") {
      console.warn("share failed", err);
    } else {
      return;
    }
  }

  try {
    await navigator.clipboard?.writeText(url);
    toast(i18nT("Link copiato! Condividilo dove vuoi."), i18nT("Condividi"));
  } catch (_) {
    window.prompt(i18nT("Copia il link e condividilo"), url);
  }
}

if (shareTitleBtn) {
  shareTitleBtn.addEventListener("click", handleShareTitle);
}

async function handleSuggestProvider() {
  if (!currentTitle?.id) return;
  if (!currentUser) {
    toast(i18nT("Accedi per suggerire una piattaforma"), i18nT("Provider"));
    return;
  }

  const name = (window.prompt("Nome piattaforma (es. NOW TV)") || "").trim();
  if (!name) return;

  const url = (window.prompt(i18nT("Link opzionale (https://...)")) || "").trim();
  const note = (window.prompt(i18nT("Nota opzionale per il team (max 200)")) || "").trim();

  try {
    await suggestWatchProvider(currentTitle.id, {
      name,
      url,
      note,
      region: "IT",
    });
    toast(i18nT("Suggerimento inviato. Grazie!"), i18nT("Provider"));
    await loadWatchProviders(currentTitle, { region: "IT" });
  } catch (err) {
    console.error("suggestWatchProvider failed", err);
    toast(err?.message || i18nT("Impossibile inviare il suggerimento ora."), i18nT("Provider"));
  }
}

if (watchProvidersSuggestBtn) {
  watchProvidersSuggestBtn.addEventListener("click", handleSuggestProvider);
}

function buildTitleShareUrl(titleId) {
  let normalizedId = String(titleId || "").trim();
  if (!normalizedId) return `${location.origin}/title.html`;

  try {
    normalizedId = decodeURIComponent(normalizedId);
  } catch (_) {}

  normalizedId = normalizedId
    .replace(/^https?:\/\/[^/]+\/share\/title\//i, "")
    .replace(/^https?:\/\/[^/]+\/title\.html\?id=/i, "")
    .replace(/^\/?share\/title\//i, "")
    .replace(/^\/?title\.html\?id=/i, "")
    .trim();

  return `${location.origin}/share/title/${encodeURIComponent(normalizedId)}`;
}

/* ========================================
   Modal helpers
======================================== */
function openModal(el){
  if (!el) return;
  el.style.display = "block";
  if (typeof el._releaseTrap === "function") {
    el._releaseTrap();
  }
  if (trapFocus) {
    el._releaseTrap = trapFocus(el);
  }
}

function closeModal(el){
  if (!el) return;
  el.style.display = "none";
  if (typeof el._releaseTrap === "function") {
    el._releaseTrap();
    el._releaseTrap = null;
  }
}

function wireModalClose(el){
  if (!el) return;
  el.querySelectorAll("[data-close]").forEach(n => {
    n.addEventListener("click", () => closeModal(el));
  });
}

// EDIT modal uses the same close buttons
if (editBox) wireModalClose(editBox);
if (threadModal) wireModalClose(threadModal);
if (relatedModal) wireModalClose(relatedModal);
if (recModal) wireModalClose(recModal);
if (friendsVotesModal) wireModalClose(friendsVotesModal);
if (charactersFullModal) wireModalClose(charactersFullModal);
if (reviewModal) wireModalClose(reviewModal);
if (castModal) wireModalClose(castModal);
castShowAllBtn?.addEventListener("click", () => void openCastModal("browse"));
castVoteBtn?.addEventListener("click", () => void openCastModal("vote"));
castModalSave?.addEventListener("click", () => void saveCastVote());
if (epActionSheet) wireModalClose(epActionSheet);
if (reviewModal) {
  reviewModal.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => {
      resetReviewPhotoDraft();
      if (revPhotoFile) revPhotoFile.value = "";
      renderReviewPhotoPreview(null);
    });
  });
}

// ===== Review Modal: event wiring =====
revText?.addEventListener("input", () => {
  if (revCharCount) revCharCount.textContent = (revText.value?.length || 0).toString();
});

revPhotoFile?.addEventListener("change", () => {
  const f = revPhotoFile.files?.[0];
  if (!f) return;
  if (_revPhotoDraft.previewUrl) {
    URL.revokeObjectURL(_revPhotoDraft.previewUrl);
    _revPhotoDraft.previewUrl = null;
  }
  _revPhotoDraft.file = f;
  _revPhotoDraft.remove = false;
  _revPhotoDraft.previewUrl = URL.createObjectURL(f);
  renderReviewPhotoPreview(_revPhotoDraft.previewUrl);
});

revPhotoRemove?.addEventListener("click", () => {
  if (_revPhotoDraft.previewUrl) {
    URL.revokeObjectURL(_revPhotoDraft.previewUrl);
    _revPhotoDraft.previewUrl = null;
  }
  _revPhotoDraft.file = null;
  _revPhotoDraft.remove = !!_revPhotoDraft.remoteUrl || !!_revPhotoDraft.remotePath;
  _revPhotoDraft.remoteUrl = null;
  _revPhotoDraft.remotePath = null;
  if (revPhotoFile) revPhotoFile.value = "";
  renderReviewPhotoPreview(null);
});

revGroup?.addEventListener("change", () => {
  if (revGroupSelector) {
    revGroupSelector.style.display = revGroup.checked ? "block" : "none";
  }
});

revNewGroup?.addEventListener("click", () => {
  if (revNewGroupForm) {
    revNewGroupForm.style.display = revNewGroupForm.style.display === "none" ? "block" : "none";
    if (revNewGroupForm.style.display === "block") {
      loadReviewFriendsForNewGroup().catch(() => {});
    }
  }
});

revCreateGroup?.addEventListener("click", async () => {
  if (!currentUser) return;
  const name = revNewGroupName?.value?.trim();
  if (!name) { showRevStatus(i18nT("Inserisci un nome per il gruppo.")); return; }

  const checked = revNewGroupMembers
    ? [...revNewGroupMembers.querySelectorAll("input[type=checkbox]:checked")].map(i => i.value)
    : [];
  if (checked.length < 1) { showRevStatus(i18nT("Seleziona almeno 1 amico per il gruppo.")); return; }

  revCreateGroup.disabled = true;
  try {
    const participants = [currentUser.uid, ...checked];
    await ensureGroupThread({
      titleId: null,
      participantUids: participants,
      groupName: name,
      createdBy: currentUser.uid,
    });

    // Ricarica la lista gruppi
    await loadReviewGroups();

    // Nascondi il form di creazione
    if (revNewGroupForm) revNewGroupForm.style.display = "none";
    if (revNewGroupName) revNewGroupName.value = "";
    toast(i18nT("Gruppo creato!"), i18nT("Fatto"));
  } catch (err) {
    console.error("[review] createGroup error:", err);
    showRevStatus(err?.message || i18nT("Errore nella creazione del gruppo"));
  } finally {
    revCreateGroup.disabled = false;
  }
});

revSubmit?.addEventListener("click", () => submitReview());

btnEditReview?.addEventListener("click", () => {
  if (!currentUser || !currentTitle) return;
  // Apri modale senza un rating specifico appena dato; usa quello gia' salvato
  const myTitle = ratings?.find(r => r.uid === currentUser.uid && r.level === "title");
  openReviewModal(myTitle?.rating ?? null);
});

btnWriteReviewSocial?.addEventListener("click", () => {
  if (!currentUser) {
    toast(i18nT("Accedi per votare e scrivere recensioni."), "Login richiesto");
    const next = encodeURIComponent(location.pathname + location.search);
    location.href = `/login.html?next=${next}`;
    return;
  }

  // Il voto ora si dà (facoltativamente) dentro al modale stesso
  const myTitle = ratings?.find(r => r.uid === currentUser.uid && r.level === "title");
  openReviewModal(myTitle?.rating ?? null);
});

/* ========================================
   Auth/rules: canDirectEdit
======================================== */
function getUserLevel(userDoc) {
  const level = String(userDoc?.level || "base").trim().toLowerCase();
  return ["base", "associate", "doctor"].includes(level) ? level : "base";
}

function canAutoApprove(userDoc) {
  const level = getUserLevel(userDoc);
  return !!userDoc?.trusted && (level === "associate" || level === "doctor");
}

// Direct updates on /titles are allowed only for:
// 1) Moderators (isAdmin OR trusted+level associate/doctor)
// 2) The creator, but ONLY while the title is still "pending".
function canDirectEdit() {
  if (!currentUser) return false;

  const isMod = (myUserDoc?.isAdmin === true) || canAutoApprove(myUserDoc);
  if (isMod) return true;

  return !!currentTitle
    && currentTitle.status === "pending"
    && currentTitle.createdBy === currentUser.uid;
}

/* ========================================
   EDIT BADGE / HEADER BUTTON (NEW)
======================================== */
function updateEditButton() {
  if (!btnEditHeader) return;

  if (!currentUser) {
    btnEditHeader.style.display = "none";
    return;
  }

  btnEditHeader.style.display = "flex";

  // badge "Proponi" solo se NON trusted/admin/associate/doctor
  if (editBadge) {
    const isTrusted = !!myUserDoc?.isAdmin || !!myUserDoc?.trusted;
    editBadge.style.display = isTrusted ? "none" : "block";
  }
}

if (btnEditHeader) {
  btnEditHeader.addEventListener("click", () => {
    if (!currentTitle) return;
    fillEditFormFromTitle(currentTitle);
    showEditBox(canDirectEdit() ? "edit" : "suggest");
  });
}

/* ========================================
   Poster rendering (MODIFIED)
======================================== */
function renderPoster(url) {
  const heroPoster = qs("#heroPoster");

  // fallback legacy (se non hai ancora aggiornato HTML)
  const target = heroPoster || posterLg;
  if (!target) return;

  if (!url) {
    target.innerHTML = `
      <div class="poster-ph">
        <svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
          <circle cx="8.5" cy="8.5" r="1.5"></circle>
          <polyline points="21 15 16 10 5 21"></polyline>
        </svg>
      </div>
    `;
    return;
  }

  // Hero poster sopra-fold: eager + fetchpriority alta per migliorare LCP.
  target.innerHTML = `<img alt="Locandina" src="${escapeHtml(url)}" loading="eager" fetchpriority="high" decoding="async" />`;
  setBackdropImage(url);
}

function renderPosterPreview(url){
  if (!ePosterPreview) return;
  if (!url){
    ePosterPreview.innerHTML = `<div class="poster-ph">+</div>`;
    return;
  }
  ePosterPreview.innerHTML = `<img alt="Anteprima locandina" src="${escapeHtml(url)}" loading="lazy" decoding="async" />`;
}

function resetPosterDraft(){
  if (posterDraft.previewUrl){
    URL.revokeObjectURL(posterDraft.previewUrl);
  }
  posterDraft = { file: null, remove: false, previewUrl: null };
  if (ePosterFile) ePosterFile.value = "";
}

function toIntOrNull(v, min, max) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (min != null && n < min) return null;
  if (max != null && n > max) return null;
  return Math.trunc(n);
}

async function loadGenres() {
  const dbGenres = await listGenres(400).catch(() => []);
  const merged = [...dbGenres];
  for (const g of tmdbGenreCatalog()) {
    if (!merged.find(x => x.id === g.id)) merged.push(g);
  }
  allGenres = merged;
  genreMap = new Map(allGenres.map(g => [g.id, g.name]));
}

function materializeSeasons(meta) {
  const seasons = Array.isArray(meta?.seasons) ? meta.seasons : [];
  if (seasons.length) return seasons;
  const sc = Number(meta?.seasonsCount || 0);
  const eps = Number(meta?.episodesPerSeason || 0);
  if (sc && eps) {
    return Array.from({ length: sc }, (_, i) => ({ season: i + 1, episodes: eps }));
  }
  return [];
}

function refreshEditSeasonsDetailUI() {
  const isTv = eType?.value === "tv";
  if (!isTv) {
    if (eSeasonsDetailGrid) {
      eSeasonsDetailGrid.style.display = "none";
      eSeasonsDetailGrid.innerHTML = "";
    }
    if (eEpisodesPerSeason) eEpisodesPerSeason.disabled = false;
    editSeasonsMeta = [];
    return;
  }

  const sc = Number(eSeasonsCount?.value || 0);
  const usePer = !!eTogglePerSeason?.checked;
  if (eEpisodesPerSeason) eEpisodesPerSeason.disabled = usePer;

  if (!usePer || !sc) {
    if (eSeasonsDetailGrid) {
      eSeasonsDetailGrid.style.display = "none";
      eSeasonsDetailGrid.innerHTML = "";
    }
    editSeasonsMeta = [];
    return;
  }

  const defaultEps = Number(eEpisodesPerSeason?.value || 0) || 10;
  const next = [];
  for (let i = 1; i <= sc; i++) {
    const prev = (editSeasonsMeta || []).find(s => Number(s.season) === i);
    next.push({ season: i, episodes: Number(prev?.episodes || 0) || defaultEps });
  }
  editSeasonsMeta = next;
  renderEditSeasonsGrid();
}

function renderEditSeasonsGrid() {
  if (!eSeasonsDetailGrid) return;
  eSeasonsDetailGrid.style.display = "grid";
  eSeasonsDetailGrid.innerHTML = (editSeasonsMeta || []).map(s => {
    const sn = Number(s.season);
    const eps = Number(s.episodes || 0);
    return `
      <div class="season-detail-row">
        <div class="season-detail-label">Stagione ${sn}</div>
        <input class="input" type="number" min="1" max="200" data-season="${sn}" value="${eps}" />
      </div>
    `;
  }).join("");

  eSeasonsDetailGrid.querySelectorAll("input[data-season]").forEach(inp => {
    inp.addEventListener("input", () => {
      const sn = Number(inp.getAttribute("data-season"));
      const v = Number(inp.value || 0);
      editSeasonsMeta = (editSeasonsMeta || []).map(s => Number(s.season) === sn ? { ...s, episodes: v } : s);
    });
  });
}

eTogglePerSeason?.addEventListener("change", refreshEditSeasonsDetailUI);
eSeasonsCount?.addEventListener("input", refreshEditSeasonsDetailUI);
eEpisodesPerSeason?.addEventListener("input", refreshEditSeasonsDetailUI);

function refreshEditTypeUI() {
  const t = eType?.value;
  if (!t) return;

  const isTv = t === "tv";

  if (eRowTvFields) eRowTvFields.style.display = isTv ? "block" : "none";
  if (eRowTvSeasonsDetail) eRowTvSeasonsDetail.style.display = isTv ? "block" : "none";
  if (eRowDurationMovie) eRowDurationMovie.style.display = isTv ? "none" : "block";

  refreshEditSeasonsDetailUI();
}
eType?.addEventListener("change", refreshEditTypeUI);

// Poster upload / remove
ePosterFile?.addEventListener("change", () => {
  const f = ePosterFile.files && ePosterFile.files[0] ? ePosterFile.files[0] : null;
  resetPosterDraft();
  if (!f) {
    posterDraft.remove = false;
    renderPosterPreview(currentTitle?.posterPath || null);
    return;
  }
  posterDraft.file = f;
  posterDraft.remove = false;
  posterDraft.previewUrl = URL.createObjectURL(f);
  renderPosterPreview(posterDraft.previewUrl);
});

ePosterRemove?.addEventListener("click", () => {
  resetPosterDraft();
  posterDraft.remove = true;
  renderPosterPreview(null);
});

function showEditBox(kind) {
  resetPosterDraft();
  renderPosterPreview(currentTitle?.posterPath || null);

  openModal(editBox);
  if (editStatus){
    editStatus.style.display = "none";
    editStatus.textContent = "";
  }

  if (kind === "edit") {
    editTitle.textContent = i18nT("Modifica contenuto");
    editSubtitle.textContent = i18nT("Le modifiche vengono applicate subito.");
    btnSaveEdit.textContent = i18nT("Salva");
  } else {
    editTitle.textContent = i18nT("Proponi modifica");
    editSubtitle.textContent = i18nT("La tua proposta verrà controllata prima di diventare pubblica.");
    btnSaveEdit.textContent = i18nT("Invia proposta");
  }
}

function hideEditBox() {
  closeModal(editBox);
}

function renderGenresPills(t) {
  const names = (t.genres || []).map(g => stripLeadingEmoji(genreMap.get(g) || g));
  if (tGenres) tGenres.innerHTML = names.slice(0, 14).map(pill).join("");
}

function renderHeroChrome(t) {
  const m = t.meta || {};
  const typeLabel = t.type === "tv" ? i18nT("Serie TV") : i18nT("Film");

  // Type + year badges
  if (tTypeBadge) tTypeBadge.textContent = typeLabel;
  if (tYearBadge) {
    if (t.year) {
      tYearBadge.textContent = String(t.year);
      tYearBadge.style.display = "inline-flex";
    } else {
      tYearBadge.style.display = "none";
    }
  }

  // Original title (only if different from display name)
  if (tOriginal) {
    const original = String(t.originalName || "").trim();
    const showOriginal = original && original.toLowerCase() !== String(t.name || "").trim().toLowerCase();
    if (showOriginal) {
      tOriginal.textContent = original;
      tOriginal.style.display = "block";
    } else {
      tOriginal.style.display = "none";
    }
  }

  // Duration row
  if (tDuration && tDurationText) {
    let durationLabel = "";
    if (t.type === "movie" && Number(m.durationMovie) > 0) {
      const total = Number(m.durationMovie);
      const h = Math.floor(total / 60);
      const min = total % 60;
      durationLabel = h > 0 ? `${h}h ${min ? `${min}min` : ""}`.trim() : `${total}min`;
    } else if (t.type === "tv" && Number(m.durationEpisode) > 0) {
      durationLabel = i18nT("{minutes}min / episodio", { minutes: Number(m.durationEpisode) });
    }
    if (durationLabel) {
      tDurationText.textContent = durationLabel;
      tDuration.style.display = "inline-flex";
    } else {
      tDuration.style.display = "none";
    }
  }
}

function renderHeroStatusRow() {
  if (!tStatusRow) return;
  const state = currentTitleState;
  const chips = [];

  if (state) {
    const statusText = String(state.statusTitle || "").trim();
    if (statusText) {
      let tint = "warm";
      if (state.state === "rated") tint = "success";
      else if (state.state === "seen_unrated" || state.state === "completed_unrated") tint = "warning";
      else if (state.state === "in_progress") tint = "accent";
      chips.push({ text: statusText, tint });
    }
    if (state.generalWatchlist) {
      chips.push({ text: i18nT("Watchlist"), tint: "accent" });
    } else if (state.rewatchIntent) {
      chips.push({ text: i18nT("Rewatch"), tint: "warm" });
    }
  }

  tStatusRow.innerHTML = chips
    .map(c => `<span class="title-status-chip chip-${c.tint}">${escapeHtml(c.text)}</span>`)
    .join("");
  tStatusRow.style.display = chips.length ? "flex" : "none";
}

function renderFacts(t) {
  const m = t.meta || {};
  const typeLabel = t.type === "tv" ? i18nT("Serie TV") : i18nT("Film");
  const subtitle = [typeLabel, t.year ? String(t.year) : ""].filter(Boolean).join(" • ");
  if (tSub) tSub.textContent = subtitle;

  const facts = [];
  if (t.type === "movie" && m.durationMovie) facts.push(kv("Durata", `${m.durationMovie} min`));
  if (t.type === "tv") {
    if (m.seasonsCount) facts.push(kv(i18nT("Stagioni"), m.seasonsCount));
    if (m.episodesPerSeason) facts.push(kv(i18nT("Episodi/Stagione"), m.episodesPerSeason));
    if (m.durationEpisode) facts.push(kv(i18nT("Durata episodio"), `${m.durationEpisode} min`));
  }
  if (m.network) facts.push(kv("Piattaforma", m.network));
  if (m.language) facts.push(kv(i18nT("Lingua"), m.language));
  if (m.country) facts.push(kv("Paese", m.country));

  // Persone (semplice testo, non invasivo)
  if (Array.isArray(t.directors) && t.directors.length) {
    facts.push(kv(i18nT("Regia"), t.directors.join(", ")));
  }
  if (Array.isArray(t.creators) && t.creators.length) {
    facts.push(kv("Creatori", t.creators.join(", ")));
  }

  const descHtml = t.description
    ? `<div class="title-description">${escapeHtml(t.description)}</div>`
    : '';

  if (tFacts) tFacts.innerHTML = descHtml + (facts.join("") || `<div class="hint">${i18nT("Nessun dettaglio extra ancora.")}</div>`);
}

function formatWatchProvidersDate(ms) {
  const n = Number(ms || 0);
  if (!Number.isFinite(n) || n <= 0) return "";
  try {
    return new Intl.DateTimeFormat("it-IT", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(n));
  } catch (_) {
    return "";
  }
}

function providerBadge(provider, fallbackHref = "") {
  const name = escapeHtml(provider?.name || i18nT("Provider"));
  const logo = String(provider?.logoUrl || "").trim();
  const href = String(fallbackHref || "").trim();
  const inner = `
    <span class="provider-chip-logo">
      ${logo ? `<img src="${escapeHtml(logo)}" alt="" loading="lazy" />` : `<span class="provider-chip-logo-fallback">${name.slice(0, 1)}</span>`}
    </span>
    <span class="provider-chip-name">${name}</span>
  `;
  if (href) {
    return `<a class="provider-chip" href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">${inner}</a>`;
  }
  return `<span class="provider-chip">${inner}</span>`;
}

function providerGroup(label, rows, fallbackHref = "") {
  if (!Array.isArray(rows) || !rows.length) return "";
  return `
    <div class="provider-group">
      <div class="provider-group-label">${escapeHtml(label)}</div>
      <div class="provider-row">
        ${rows.map((row) => providerBadge(row, fallbackHref)).join("")}
      </div>
    </div>
  `;
}

function customProviderGroup(rows) {
  if (!Array.isArray(rows) || !rows.length) return "";
  const cards = rows.map((row) => {
    const name = escapeHtml(row?.name || "Piattaforma");
    const note = row?.note ? `<div class="provider-custom-note">${escapeHtml(row.note)}</div>` : "";
    const by = row?.by ? `<span class="provider-custom-by">• ${escapeHtml(row.by)}</span>` : "";
    const label = `<span>${name}</span>${by}`;
    if (row?.url) {
      return `<a class="provider-custom-item" href="${escapeHtml(row.url)}" target="_blank" rel="noreferrer noopener">${label}${note}</a>`;
    }
    return `<div class="provider-custom-item">${label}${note}</div>`;
  }).join("");

  return `
    <div class="provider-group">
      <div class="provider-group-label">${i18nT("Suggerito da admin")}</div>
      <div class="provider-custom-list">${cards}</div>
    </div>
  `;
}

function renderWatchProviders(payload, region = "IT") {
  if (!watchProvidersCard || !watchProvidersList) return;
  const providers = payload?.providers || {};
  const customAdmin = Array.isArray(payload?.customAdmin) ? payload.customAdmin : [];
  const tmdbLink = String(providers.link || "").trim();

  const groups = [
    providerGroup("Streaming", providers.flatrate, tmdbLink),
    providerGroup("Gratis / Ads", providers.free, tmdbLink || ""),
    providerGroup("Noleggio", providers.rent, tmdbLink || ""),
    providerGroup("Acquisto", providers.buy, tmdbLink || ""),
    providerGroup("Ads", providers.ads, tmdbLink || ""),
    customProviderGroup(customAdmin),
  ].filter(Boolean);

  watchProvidersCard.style.display = "block";
  if (!groups.length) {
    watchProvidersList.innerHTML = `<div class="hint">${i18nT("Non disponibile in {region} al momento.", { region: escapeHtml(region) })}</div>`;
  } else {
    watchProvidersList.innerHTML = groups.join("");
  }

  if (watchProvidersTmdblink) {
    if (tmdbLink) {
      watchProvidersTmdblink.style.display = "inline-flex";
      watchProvidersTmdblink.href = tmdbLink;
    } else {
      watchProvidersTmdblink.style.display = "none";
      watchProvidersTmdblink.removeAttribute("href");
    }
  }

  if (watchProvidersMeta) {
    const updated = formatWatchProvidersDate(payload?.updatedAtMs);
    const staleTag = payload?.stale ? ` • ${i18nT("cache stale")}` : "";
    watchProvidersMeta.textContent = updated
      ? i18nT("Regione {region} • aggiornato {updated}", { region, updated }) + staleTag
      : i18nT("Regione {region}", { region }) + staleTag;
  }
}

let watchProvidersLoadToken = 0;
async function loadWatchProviders(t, { region = "IT" } = {}) {
  if (!watchProvidersCard || !watchProvidersList || !t?.id) return;
  const titleId = String(t.id || "").trim();
  if (!titleId) return;
  const token = ++watchProvidersLoadToken;

  watchProvidersCard.style.display = "block";
  watchProvidersList.innerHTML = `<div class="hint">${i18nT("Caricamento provider...")}</div>`;
  if (watchProvidersMeta) watchProvidersMeta.textContent = i18nT("Regione {region}", { region });
  if (watchProvidersSuggestBtn) {
    watchProvidersSuggestBtn.style.display = currentUser ? "inline-flex" : "none";
  }
  if (watchProvidersTmdblink) watchProvidersTmdblink.style.display = "none";

  try {
    const payload = await getWatchProviders(titleId, { region });
    if (token !== watchProvidersLoadToken) return;
    renderWatchProviders(payload, region);
  } catch (err) {
    if (token !== watchProvidersLoadToken) return;
    console.warn("[title] watch providers load failed", err);
    watchProvidersList.innerHTML = `<div class="hint">${i18nT("Provider non disponibili al momento.")}</div>`;
    if (watchProvidersMeta) watchProvidersMeta.textContent = i18nT("Regione {region}", { region });
  }
}

/* ========================================
   CORRELATI (NEW) - SAFE MODE
   Nota: usa Firestore SDK SOLO se presente globalmente.
======================================== */

function getFirestoreFnsSafe(){
  // proviamo vari punti "probabili"
  const g = window;
  const fs = g.firebaseFirestore || g.firestore || g.FIRESTORE || null;

  // Se in app hai già importato e messo in window queste funzioni, ok.
  // Altrimenti, questa feature resta disattivata.
  const doc = g.doc || fs?.doc;
  const getDoc = g.getDoc || fs?.getDoc;
  const updateDoc = g.updateDoc || fs?.updateDoc;
  const arrayUnion = g.arrayUnion || fs?.arrayUnion;
  const collection = g.collection || fs?.collection;
  const getDocs = g.getDocs || fs?.getDocs;
  const addDoc = g.addDoc || fs?.addDoc;
  const serverTimestamp = g.serverTimestamp || fs?.serverTimestamp;
  const writeBatch = g.writeBatch || fs?.writeBatch;

  const db = g.db || fs?.db;

  const ok = !!(db && doc && getDoc && updateDoc && arrayUnion && collection && getDocs && addDoc && serverTimestamp);
  return { ok, db, doc, getDoc, updateDoc, arrayUnion, collection, getDocs, addDoc, serverTimestamp, writeBatch };
}

async function loadRelated() {
  if (!currentTitle?.id) return;
  if (!relatedList || !relatedEmpty) return;

  const fs = getFirestoreFnsSafe();
  if (!fs.ok) {
    // nessun crash: semplicemente non abilitiamo la feature
    relatedTitles = [];
    relatedList.innerHTML = "";
    relatedEmpty.style.display = "block";
    relatedEmpty.textContent = i18nT("Correlati non disponibili (manca Firestore SDK).");
    console.warn("[related] Firestore SDK non disponibile: feature disattivata.");
    return;
  }

  try {
    const titleRef = fs.doc(fs.db, "titles", currentTitle.id);
    const titleSnap = await fs.getDoc(titleRef);
    const data = titleSnap?.data ? titleSnap.data() : (titleSnap?.data?.() || null);

    relatedTitles = data?.related || [];
    await renderRelated();
  } catch (e) {
    console.error("Error loading related:", e);
  }
}

async function renderRelated() {
  if (!relatedList || !relatedEmpty) return;

  if (!relatedTitles.length) {
    relatedList.innerHTML = "";
    relatedEmpty.style.display = "block";
    return;
  }

  relatedEmpty.style.display = "none";

  // Batched read (1 query per 30 id) invece di N getDoc paralleli. Cache 60s.
  const titlesMap = await getTitlesByIds(relatedTitles).catch(() => new Map());
  const validTitles = relatedTitles.map(id => titlesMap.get(id)).filter(Boolean);

  relatedList.innerHTML = validTitles.map(t => `
    <a href="/title.html?id=${encodeURIComponent(t.id)}" class="related-item">
      <div class="related-poster">
        ${t.posterPath
          ? `<img src="${escapeHtml(t.posterPath)}" alt="${escapeHtml(t.name)}" loading="lazy" decoding="async" />`
          : `<div class="related-poster-placeholder">
               <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                 <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                 <circle cx="8.5" cy="8.5" r="1.5"></circle>
                 <polyline points="21 15 16 10 5 21"></polyline>
               </svg>
             </div>`
        }
      </div>
      <div class="related-info">
        <div class="related-title">${escapeHtml(t.name)}</div>
        <div class="related-meta">${t.year || ""} ${t.type === "tv" ? `• ${i18nT("Serie TV")}` : ""}</div>
      </div>
    </a>
  `).join("");
}

if (btnAddRelated) {
  btnAddRelated.addEventListener("click", () => {
    if (!currentUser) {
      toast(i18nT("Accedi per aggiungere correlati"), "Login richiesto");
      return;
    }

    if (relatedSearch) relatedSearch.value = "";
    if (relatedSearchResults) relatedSearchResults.innerHTML = "";
    if (relatedSearchStatus) relatedSearchStatus.style.display = "none";

    openModal(relatedModal);
  });
}

if (relatedSearch) {
  relatedSearch.addEventListener("input", (e) => {
    const query = String(e.target.value || "").trim();
    clearTimeout(searchDebounce);

    if (!query) {
      if (relatedSearchResults) relatedSearchResults.innerHTML = "";
      if (relatedSearchStatus) relatedSearchStatus.style.display = "none";
      return;
    }

    searchDebounce = setTimeout(async () => {
      await searchTitlesForRelated(query);
    }, 300);
  });
}

async function searchTitlesForRelated(query) {
  if (!relatedSearchResults || !relatedSearchStatus) return;

  const fs = getFirestoreFnsSafe();
  if (!fs.ok) {
    relatedSearchStatus.style.display = "block";
    relatedSearchStatus.textContent = i18nT("Ricerca non disponibile (manca Firestore SDK).");
    return;
  }

  relatedSearchStatus.style.display = "block";
  relatedSearchStatus.textContent = "Cercando...";

  try {
    const q = query.toLowerCase();
    const titlesRef = fs.collection(fs.db, "titles");
    const snap = await fs.getDocs(titlesRef);

    const results = [];
    snap.forEach(d => {
      const data = d.data();
      const name = (data.name || "").toLowerCase();
      const originalName = (data.originalName || "").toLowerCase();

      if (name.includes(q) || originalName.includes(q)) {
        results.push({ id: d.id, ...data });
      }
    });

    if (results.length === 0) {
      relatedSearchResults.innerHTML = `
        <div class="search-result-item" id="createNewTitle">
          <div class="search-result-info" style="flex: 1;">
            <div class="search-result-title">Crea "${escapeHtml(query)}"</div>
            <div class="search-result-meta">${i18nT("Il titolo non esiste, crealo ora")}</div>
          </div>
        </div>
      `;

      relatedSearchStatus.style.display = "none";

      const createBtn = qs("#createNewTitle");
      if (createBtn) {
        createBtn.addEventListener("click", () => {
          createNewTitleForRelated(query);
        });
      }
      return;
    }

    relatedSearchResults.innerHTML = results.slice(0, 10).map(t => `
      <div class="search-result-item" data-title-id="${escapeHtml(t.id)}">
        <div class="search-result-poster">
          ${t.posterPath
            ? `<img src="${escapeHtml(t.posterPath)}" alt="${escapeHtml(t.name)}" loading="lazy" decoding="async" />`
            : `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity: 0.3;">
                 <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
               </svg>`
          }
        </div>
        <div class="search-result-info">
          <div class="search-result-title">${escapeHtml(t.name)}</div>
          <div class="search-result-meta">${t.year || ""} ${t.type === "tv" ? `• ${i18nT("Serie TV")}` : ""}</div>
        </div>
      </div>
    `).join("");

    relatedSearchStatus.style.display = "none";

    relatedSearchResults.querySelectorAll(".search-result-item").forEach(item => {
      item.addEventListener("click", () => {
        const titleId = item.dataset.titleId;
        if (titleId) addRelatedTitle(titleId);
      });
    });
  } catch (e) {
    console.error("Search error:", e);
    relatedSearchStatus.textContent = i18nT("Errore nella ricerca");
  }
}

async function addRelatedTitle(titleId) {
  if (!currentUser || !currentTitle?.id) return;

  const fs = getFirestoreFnsSafe();
  if (!fs.ok) {
    toast("Impossibile aggiungere (manca Firestore SDK)", "Ops");
    return;
  }

  try {
    if (titleId === currentTitle.id) {
      toast(i18nT("Non puoi correlare un titolo con se stesso"), "Info");
      return;
    }

    if (relatedTitles.includes(titleId)) {
      toast(i18nT("Questo titolo è già nei correlati"), "Info");
      return;
    }

    const sourceRef = fs.doc(fs.db, "titles", currentTitle.id);
    const targetRef = fs.doc(fs.db, "titles", titleId);

    if (typeof fs.writeBatch === "function") {
      const batch = fs.writeBatch(fs.db);
      batch.update(sourceRef, { related: fs.arrayUnion(titleId) });
      batch.update(targetRef, { related: fs.arrayUnion(currentTitle.id) });
      await batch.commit();
    } else {
      await fs.updateDoc(sourceRef, { related: fs.arrayUnion(titleId) });
      await fs.updateDoc(targetRef, { related: fs.arrayUnion(currentTitle.id) });
    }

    relatedTitles = Array.from(new Set([...relatedTitles, titleId]));
    await renderRelated();

    closeModal(relatedModal);
    toast(i18nT("Correlati aggiornati su entrambe le schede!"), "Successo");
  } catch (e) {
    console.error("Error adding related:", e);
    toast(e?.message || i18nT("Errore"), "Ops");
  }
}

async function createNewTitleForRelated(titleName) {
  if (!currentUser) return;

  const fs = getFirestoreFnsSafe();
  if (!fs.ok) {
    toast(i18nT("Creazione non disponibile (manca Firestore SDK)"), "Ops");
    return;
  }

  const trusted = !!myUserDoc?.trusted;
  if (!trusted) {
    toast(i18nT("Solo gli utenti trusted possono creare nuovi titoli."), "Permesso negato");
    return;
  }
  const isTrusted = !!myUserDoc?.isAdmin || canAutoApprove(myUserDoc);

  try {
    if (relatedSearchStatus) {
      relatedSearchStatus.style.display = "block";
      relatedSearchStatus.textContent = i18nT("Creazione in corso...");
    }

    const newTitle = {
      name: titleName,
      type: "movie",
      status: isTrusted ? "approved" : "pending",
      createdBy: currentUser.uid,
      createdAt: fs.serverTimestamp(),
      genres: [],
      year: null,
      posterPath: null,
      meta: {},
      related: []
    };

    const titlesRef = fs.collection(fs.db, "titles");
    const docRef = await fs.addDoc(titlesRef, newTitle);

    await addRelatedTitle(docRef.id);

    toast(
      isTrusted
        ? i18nT("Titolo \"{titleName}\" creato! Completa le informazioni dalla sua scheda.", { titleName })
        : i18nT('Titolo "{name}" creato e in attesa di approvazione.', { name: titleName }),
      isTrusted ? i18nT("Creato") : i18nT("In revisione")
    );

    closeModal(relatedModal);
  } catch (e) {
    console.error("Error creating title:", e);
    if (relatedSearchStatus) {
      relatedSearchStatus.textContent = i18nT("Errore nella creazione");
      setTimeout(() => { relatedSearchStatus.style.display = "none"; }, 2000);
    }
  }
}

/* ---------------------------
   Summary stats / friends chips (MODIFIED)
--------------------------- */
async function ensureFriends(){
  if (!currentUser) return [];
  if (Array.isArray(friendsCache)) return friendsCache;
  friendsCache = await listFriends(currentUser.uid).catch(() => []);
  return friendsCache;
}

async function ensureUsers(uids){
  const uniq = Array.from(new Set((uids || []).filter(Boolean)));
  const missing = uniq.filter(uid => !usersCache.has(uid));
  const batch = missing.slice(0, 40);
  const got = await Promise.all(batch.map(uid => getUserPublic(uid).catch(() => null)));
  got.forEach(u => {
    if (u && u.uid) usersCache.set(u.uid, u);
  });
}

function computeTitleBuckets(){
  const titleRatings = (ratings || []).filter(r => r.level === "title" && Number.isFinite(Number(r.rating)));
  const community = {
    avg: avg(titleRatings.map(r => Number(r.rating))),
    count: titleRatings.length,
    items: titleRatings,
  };
  return { titleRatings, community };
}

/**
 * Distribuzione dei voti community su /10, a 5 fasce (dato REALE, calcolato
 * in memoria dai rating title-level già caricati in `ratings`). Ogni voto
 * viene arrotondato a intero (Math.round) e incasellato nella fascia che lo
 * contiene. Nessuna nuova read: usa lo stesso array di computeTitleBuckets().
 */
function computeTitleDistribution10(titleRatings) {
  const BUCKETS = [
    { key: "9-10", label: "9–10", min: 9, max: 10 },
    { key: "7-8", label: "7–8", min: 7, max: 8 },
    { key: "5-6", label: "5–6", min: 5, max: 6 },
    { key: "3-4", label: "3–4", min: 3, max: 4 },
    { key: "1-2", label: "1–2", min: 1, max: 2 },
  ];

  const counts = new Map(BUCKETS.map(b => [b.key, 0]));
  let total = 0;

  (titleRatings || []).forEach((r) => {
    const rounded = Math.round(Number(r.rating));
    if (!Number.isFinite(rounded)) return;
    const bounded = Math.max(1, Math.min(10, rounded));
    const bucket = BUCKETS.find(b => bounded >= b.min && bounded <= b.max);
    if (!bucket) return;
    counts.set(bucket.key, (counts.get(bucket.key) || 0) + 1);
    total += 1;
  });

  return BUCKETS.map(b => {
    const count = counts.get(b.key) || 0;
    return {
      label: b.label,
      count,
      pct: total > 0 ? Math.round((count / total) * 100) : 0,
    };
  });
}

/**
 * Render della card "Voto community" (PART A): ring /10 (stesso dato di
 * statCommunity/statCommunitySub, niente doppia fonte) + barre a 5 fasce.
 * Nascosta se non ci sono voti title-level (hide-if-empty, come le altre
 * card social).
 */
function renderCommunityDistribution(community, titleRatings) {
  if (!communityDistributionCard) return;

  if (!community.count) {
    communityDistributionCard.style.display = "none";
    return;
  }

  communityDistributionCard.style.display = "";

  if (communityRatingRingValue) communityRatingRingValue.textContent = fmtStat(community.avg);
  if (communityRatingCount) {
    communityRatingCount.textContent = i18nT("{count} voti", { count: community.count });
  }

  // Arco proporzionale al voto medio (avg/10), via conic-gradient: sostituisce
  // il vecchio anello a bordo pieno (sempre uguale, non trasmetteva il dato)
  // con un arco reale che si riempie in proporzione allo score. Parte da ore
  // 12 (-90deg) in senso orario. Il var() è settato inline perché dipende dal
  // dato per-titolo, non dal tema.
  if (communityRatingRing) {
    const pct = Math.max(0, Math.min(1, Number(community.avg || 0) / 10));
    communityRatingRing.style.setProperty("--ring-pct", String(pct));
  }

  const buckets = computeTitleDistribution10(titleRatings);
  const maxPct = Math.max(1, ...buckets.map(b => b.pct));

  if (communityDistributionBars) {
    communityDistributionBars.innerHTML = buckets.map((b) => `
      <div class="community-dist-row">
        <span class="community-dist-label">${escapeHtml(b.label)}</span>
        <div class="community-dist-track" aria-hidden="true">
          <div class="community-dist-fill" style="width:${Math.round((b.pct / maxPct) * 100)}%"></div>
        </div>
        <span class="community-dist-value">${b.count ? `${b.pct}%` : "—"}</span>
      </div>
    `).join("");
  }
}

async function renderSummaryStats(){
  if (!statCommunity) return;
  const { titleRatings, community } = computeTitleBuckets();

  statCommunity.textContent = fmtStat(community.avg);
  if (statCommunitySub) statCommunitySub.textContent = community.count ? i18nT("{count} voti", { count: community.count }) : i18nT("Nessun voto");

  renderCommunityDistribution(community, titleRatings);

  let fAvg = null;
  let fCount = 0;
  const friends = await ensureFriends();
  const fSet = new Set((friends || []).map(f => f.uid));

  if (fSet.size){
    const fr = titleRatings.filter(r => fSet.has(r.uid));
    fAvg = avg(fr.map(r => Number(r.rating)));
    fCount = fr.length;

    if (friendsMiniRow){
      const friendsMiniContent = qs("#friendsMiniContent");
      const sorted = fr.slice().sort((a,b) => Number(b.rating) - Number(a.rating));
      await ensureUsers(sorted.map(r => r.uid));

      const chips = sorted.slice(0, 10).map(r => {
        const u = usersCache.get(r.uid);
        const name = (u?.displayName || r.uid);
        const initials = name.split(/\s+/).filter(Boolean).slice(0,2).map(s=>s[0].toUpperCase()).join("") || "?";
        return `
          <a class="mini-chip" href="/user.html?uid=${encodeURIComponent(r.uid)}">
            <span class="mini-avatar">${escapeHtml(initials)}</span>
            <span class="mini-score">${escapeHtml(formatMaskedRating(r.rating))}</span>
          </a>
        `;
      }).join("");

      if (friendsMiniContent) friendsMiniContent.innerHTML = chips;
      else friendsMiniRow.innerHTML = chips;

      friendsMiniRow.style.display = chips ? "flex" : "none";
    }
  } else {
    if (friendsMiniRow) friendsMiniRow.style.display = "none";
  }

  if (statFriends) statFriends.textContent = fmtStat(fAvg);
  if (statFriendsSub) statFriendsSub.textContent = fSet.size ? (fCount ? i18nT("{count} voti", { count: fCount }) : i18nT("Nessun voto")) : i18nT("Nessun amico");

  // Experts: trusted + livello associate/doctor (oppure admin)
  await ensureUsers(titleRatings.map(r => r.uid));
  const expertRatings = titleRatings.filter(r => {
    const u = usersCache.get(r.uid);
    return !!u?.isAdmin || canAutoApprove(u);
  });

  const eAvg = avg(expertRatings.map(r => Number(r.rating)));
  if (statExperts) statExperts.textContent = fmtStat(eAvg);
  if (statExpertsSub) statExpertsSub.textContent = expertRatings.length ? i18nT("{count} voti", { count: expertRatings.length }) : i18nT("Nessun voto");
}

/* ---------------------------
   RATINGS UI (MODIFIED per voto titolo)
--------------------------- */
function canVote() {
  return !!currentUser;
}

function loginHrefWithNext() {
  const next = encodeURIComponent(location.pathname + location.search);
  return `/login.html?next=${next}`;
}

// Mirror iOS shell.presentAuth(): bounce guests to login when an action needs auth.
function requireAuthOrRedirect() {
  if (currentUser) return true;
  location.href = loginHrefWithNext();
  return false;
}

function updateGuestUnlockCta() {
  if (guestUnlockBtn) {
    guestUnlockBtn.href = loginHrefWithNext();
  }
  if (guestUnlockCard) {
    guestUnlockCard.style.display = currentUser ? "none" : "block";
  }
}

function toHalfStep(value) {
  // Guard esplicito su null/undefined: Number(null) === 0 (finito!) in JS,
  // quindi senza questo check "nessun voto" verrebbe letto come voto "0"/"1"
  // invece di "assente". Bug lattente pre-esistente nella vecchia
  // toQuarterStep (stesso pattern) — mai innescato perché ogni call site
  // usava `?.rating` (→ undefined, già filtrato da Number.isFinite... ma
  // NON per null, che Number() converte a 0): reso esplicito qui perché
  // ratingTrackHtml riceve `selected = null` come default e viene chiamato
  // con `?? null` in più punti (title/season/episode).
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 2) / 2;
}

function isSameRating(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.001;
}

/**
 * Formattazione IT del voto (virgola, non punto): "7" per interi, "7,5" per
 * mezzi punti. Usata ovunque il voto viene mostrato (chip /10, bottoni
 * stagione/episodio, breakdown, ring community).
 */
function formatMaskedRating(value) {
  const q = toHalfStep(value);
  if (!Number.isFinite(q)) return "—";

  const bounded = Math.max(1, Math.min(10, q));
  const floor = Math.floor(bounded);
  const frac = Math.round((bounded - floor) * 10);

  if (frac === 0) return String(floor);
  return `${floor},5`;
}

/**
 * Rating track tattile (PART: half-steps, 2026-07-09 redesign): sostituisce
 * la vecchia griglia di 10 bottoni interi + fly-out quarti con un unico
 * slider nativo `<input type="range" step="0.5">` — accessibile di default
 * (frecce tastiera, screen reader, drag/tap-to-position), tappabile a
 * qualunque larghezza (niente 10-20 hit-target minuscoli), e già "a due
 * decimali" (0.5) senza reinventare la gestione del drag.
 * `idPrefix` disambigua più track nella stessa pagina (titolo/stagione/episodio).
 */
let _ratingTrackSeq = 0;
function ratingTrackFillPct(value) {
  const n = Math.max(1, Math.min(10, Number(value) || 1));
  return ((n - 1) / 9) * 100;
}

function ratingTrackHtml(selected = null, idPrefix = null) {
  const sel = toHalfStep(selected);
  const initial = Number.isFinite(sel) ? Math.max(1, Math.min(10, sel)) : 5.5;
  const hasValue = Number.isFinite(sel);
  const uid = idPrefix || `rt${++_ratingTrackSeq}`;
  const ticks = Array.from({ length: 10 }, (_, i) => i + 1)
    .map((v) => `<span class="rating-track-tick" style="left:${((v - 1) / 9) * 100}%">${v}</span>`)
    .join("");

  return `
    <div class="rating-track" data-rating-track="${escapeHtml(uid)}" data-has-value="${hasValue ? "1" : "0"}" style="--fill-pct:${ratingTrackFillPct(initial)}%">
      <div class="rating-track-readout" aria-hidden="true">
        <span class="rating-track-value">${hasValue ? escapeHtml(formatMaskedRating(initial)) : "—"}</span>
      </div>
      <input
        type="range"
        class="rating-track-input"
        id="${escapeHtml(uid)}"
        min="1" max="10" step="0.5"
        value="${initial}"
        aria-label="${i18nT("Il tuo voto, da 1 a 10 con mezzi punti")}"
        aria-valuetext="${hasValue ? escapeHtml(formatMaskedRating(initial)) : i18nT("Nessun voto")}"
      />
      <div class="rating-track-ticks" aria-hidden="true">${ticks}</div>
    </div>`;
}

function findMyRating(level, season = null, episode = null) {
  if (!currentUser) return null;
  const mine = ratings.filter(r =>
    r.uid === currentUser.uid &&
    r.level === level &&
    (r.season ?? null) === (season ?? null) &&
    (r.episode ?? null) === (episode ?? null)
  );
  return mine.length ? mine[0] : null;
}

function computeAvg(level, season = null, episode = null) {
  const nums = ratings
    .filter(r => r.level === level
      && (r.season ?? null) === (season ?? null)
      && (r.episode ?? null) === (episode ?? null)
    )
    .map(r => Number(r.rating));
  return avg(nums);
}

/**
 * Wiring del rating-track (vedi ratingTrackHtml): il readout grande si
 * aggiorna in diretta ad ogni "input" (drag/tastiera), ma `handler` — che fa
 * la write su Firestore via submitRating — parte solo su "change" (rilascio
 * del drag / commit da tastiera), per non spammare una write ad ogni tick di
 * un mezzo punto durante il trascinamento.
 */
function wireRatingTrack(container, handler, selected = null) {
  if (!container) return;
  const track = container.matches?.(".rating-track") ? container : container.querySelector(".rating-track");
  const input = track?.querySelector(".rating-track-input");
  const valueEl = track?.querySelector(".rating-track-value");
  if (!track || !input) return;

  // `hasValue` esplicito (non ri-derivato da toHalfStep(v), che è sempre
  // finito per un range già inizializzato): distingue "nessun voto ancora"
  // (readout "—", fill grigio) da "voto = 5.5" (valore reale). L'utente NON
  // ha ancora interagito finché non scatta "input"/"change".
  const applyDisplay = (v, hasValue) => {
    const q = toHalfStep(v);
    if (valueEl) valueEl.textContent = hasValue && Number.isFinite(q) ? formatMaskedRating(q) : "—";
    input.setAttribute("aria-valuetext", hasValue && Number.isFinite(q) ? formatMaskedRating(q) : i18nT("Nessun voto"));
    track.dataset.hasValue = hasValue ? "1" : "0";
    track.style.setProperty("--fill-pct", `${ratingTrackFillPct(Number.isFinite(q) ? q : input.value)}%`);
  };

  let committedValue = selected;
  input.addEventListener("input", () => applyDisplay(input.value, true));
  input.addEventListener("change", async () => {
    if (input.getAttribute("aria-busy") === "true") return;
    const v = toHalfStep(input.value);
    if (!Number.isFinite(v)) return;
    applyDisplay(v, true);
    input.disabled = true;
    input.setAttribute("aria-busy", "true");
    track.classList.add("is-saving");
    try {
      const result = await handler(v);
      if (result === false) {
        input.value = committedValue == null ? "5.5" : String(committedValue);
        applyDisplay(input.value, committedValue != null);
      } else {
        committedValue = v;
      }
    } catch (err) {
      console.error("[rating] handler error:", err);
      input.value = committedValue == null ? "5.5" : String(committedValue);
      applyDisplay(input.value, committedValue != null);
      toast(i18nT("Errore nel salvataggio del voto. Riprova."), i18nT("Errore"), { type: "error" });
    } finally {
      input.disabled = false;
      input.removeAttribute("aria-busy");
      track.classList.remove("is-saving");
    }
  });

  applyDisplay(selected == null ? input.value : selected, selected != null);
}

async function submitRating({ level, season = null, episode = null, rating }) {
  if (!canVote()) {
    toast(i18nT("Accedi per votare"), "Login richiesto");
    const next = encodeURIComponent(location.pathname + location.search);
    location.href = `/login.html?next=${next}`;
    return false;
  }

  try {
    await upsertRating({
      uid: currentUser.uid,
      titleId: currentTitle.id,
      level,
      season,
      episode,
      rating,
    });
  } catch (err) {
    console.error("[rating] submitRating error:", err);
    toast(i18nT("Errore nel salvataggio del voto. Riprova."), i18nT("Errore"));
    return false;
  }

  logSignal({
    uid: currentUser.uid,
    titleId: currentTitle.id,
    actionType: "rating",
    rawValue: rating,
    source: "title_page",
  }).catch(() => {});

  // Ha appena votato: è il momento in cui "ti avviso sulle serie che segui"
  // significa qualcosa. Una volta sola, e portato in vista perché a fine
  // votazione la pagina è quasi sempre scrollata.
  try {
    const prompt = mountNotificationPermissionBanner({
      containerSelector: "main.container",
      user: currentUser,
      subtitleText: i18nT("Ti avvisiamo quando escono nuovi episodi delle serie che segui."),
      trigger: "post_rating",
    });
    prompt?.element?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (_) {}

  ratings = await listRatingsForTitle(currentTitle.id);
  renderRatings(currentTitle);
  renderSummaryStats().catch(() => {});

  // Dopo il voto al titolo: apri il modale recensione
  if (level === "title") {
    await refreshPersonalState().catch(() => {});
    openReviewModal(rating);
  }
  return true;
}

// ===== REVIEW MODAL =====

let _revMyGroups = [];         // cache gruppi dell'utente
let _revFollowing = null;      // cache seguiti (uid+displayName) per "con chi l'hai visto"
let _revWWSelected = [];       // persone taggate nella review corrente
let _revRatingDraft = null;    // voto scelto nel track del modale (null = nessun voto)
let _revExistingRating = null; // rating doc già salvato, se esiste
let _revPhotoDraft = { file: null, previewUrl: null, remoteUrl: null, remotePath: null, remove: false };

function updateRevHint() {
  if (!revHint) return;
  const q = toHalfStep(_revRatingDraft);
  revHint.innerHTML = Number.isFinite(q)
    ? i18nT("Hai votato {rating}! Vuoi aggiungere due righe?", { rating: `<strong>${escapeHtml(formatMaskedRating(q))}</strong>` })
    : i18nT("Com'è andata? Voto, impressioni e recensione — tutto facoltativo.");
}

async function openReviewModal(ratingValue) {
  if (!reviewModal || !currentUser || !currentTitle) return;

  // Precarica il picker emozioni con la selezione gia' salvata (se presente)
  _revEmotionsDraft = [...myEmotions];
  renderEmotionChipGrid(revEmotionsGrid, _revEmotionsDraft, toggleRevEmotion);

  // "Chi ti ha conquistato?": solo film a livello titolo (le serie votano i
  // personaggi per episodio, nel foglio "episodio visto" — spec §7). Draft
  // locale precaricato con l'eventuale voto già salvato, committato solo al
  // submit della review.
  const isMovieLevel = String(currentTitle.type || "").toLowerCase() !== "tv";
  if (revCharactersField) revCharactersField.hidden = !isMovieLevel;
  if (isMovieLevel) {
    _revCharacterCandidates = characterCandidatesFromTitle(currentTitle);
    const existingCharacterPicks = await getMyCharacterPicks({
      uid: currentUser.uid,
      titleId: currentTitle.id,
      level: "title",
      season: 0,
      episode: 0,
    }).catch(() => []);
    _revCharacterDraft = existingCharacterPicks;
    _revCharacterInitialPicks = existingCharacterPicks;
    _revCharacterReactionTarget = null;
    renderRevCharacterRow();
  } else {
    _revCharacterCandidates = [];
    _revCharacterDraft = [];
    _revCharacterInitialPicks = [];
    _revCharacterReactionTarget = null;
  }

  // Carica l'eventuale recensione gia' esistente
  const existingRating = await getMyRating({
    uid: currentUser.uid,
    titleId: currentTitle.id,
    level: "title",
  }).catch(() => null);
  _revExistingRating = existingRating;

  // Voto nel modale: parte dal voto appena dato o da quello già salvato.
  // Facoltativo: se resta null si salvano comunque le emozioni.
  _revRatingDraft = toHalfStep(ratingValue) ?? toHalfStep(existingRating?.rating) ?? null;
  if (revRatingBox) {
    revRatingBox.innerHTML = ratingTrackHtml(_revRatingDraft, "ratingTrackReview");
    wireRatingTrack(revRatingBox, (v) => {
      _revRatingDraft = v;
      updateRevHint();
    }, _revRatingDraft);
  }
  updateRevHint();

  if (revText) revText.value = existingRating?.reviewText || "";
  if (revCharCount) revCharCount.textContent = (revText?.value?.length || 0).toString();

  resetReviewPhotoDraft();
  if (revPhotoFile) revPhotoFile.value = "";
  const existingPhotoUrl = String(existingRating?.reviewPhotoUrl || "").trim();
  const existingPhotoPath = String(existingRating?.reviewPhotoStoragePath || "").trim();
  if (existingPhotoUrl) {
    _revPhotoDraft.remoteUrl = existingPhotoUrl;
    _revPhotoDraft.remotePath = existingPhotoPath || null;
    _revPhotoDraft.remove = false;
    renderReviewPhotoPreview(existingPhotoUrl);
  } else {
    renderReviewPhotoPreview(null);
  }

  // Reset visibilita (tutte deselezionate di default)
  if (revPrivate) revPrivate.checked = false;
  if (revPublic) revPublic.checked = false;
  if (revGroup) revGroup.checked = false;
  if (revGroupSelector) revGroupSelector.style.display = "none";
  if (revNewGroupForm) revNewGroupForm.style.display = "none";
  if (revStatus) { revStatus.style.display = "none"; revStatus.textContent = ""; }
  if (revSubmit) revSubmit.disabled = false;

  // Carica gruppi (in background)
  loadReviewGroups().catch(() => {});

  // "Con chi l'hai visto?": chips già taggate + ricerca tra i seguiti.
  // I seguiti si caricano in background: il modale si apre subito.
  _revWWSelected = (Array.isArray(existingRating?.watchedWith) ? existingRating.watchedWith : [])
    .map((row) => ({
      uid: String(row?.uid || "").trim(),
      displayName: String(row?.displayName || "").trim() || String(row?.uid || "").trim(),
    }))
    .filter((row) => row.uid);
  renderRevWWChips();
  if (revWatchedWithSearch) {
    revWatchedWithSearch.value = "";
    revWatchedWithSearch.style.display = "";
  }
  if (revWatchedWithResults) revWatchedWithResults.style.display = "none";
  if (revWatchedWithHint) revWatchedWithHint.style.display = "none";
  ensureReviewFollowingLoaded().then(() => renderRevWWResults()).catch(() => {});

  openModal(reviewModal);
}

async function loadReviewGroups() {
  if (!currentUser) return;
  _revMyGroups = await listMyGroups(currentUser.uid);

  if (!revGroupList) return;
  revGroupList.innerHTML = "";

  if (_revMyGroups.length === 0) {
    if (revNoGroups) revNoGroups.style.display = "block";
    return;
  }
  if (revNoGroups) revNoGroups.style.display = "none";

  _revMyGroups.forEach(g => {
    const label = document.createElement("label");
    label.className = "check-item";
    label.innerHTML = `<input type="checkbox" value="${escapeHtml(g.id)}" /><span class="label">${escapeHtml(g.groupName || i18nT("Gruppo"))}</span>`;
    revGroupList.appendChild(label);
  });
}

async function loadReviewFriendsForNewGroup() {
  if (!revNewGroupMembers || !currentUser) return;
  const friends = await listFriends(currentUser.uid);
  const accepted = friends.filter(f => f.status === "accepted");

  revNewGroupMembers.innerHTML = "";
  if (accepted.length === 0) {
    revNewGroupMembers.innerHTML = `<span class="hint">${i18nT("Nessun amico ancora.")}</span>`;
    return;
  }

  for (const f of accepted) {
    const friendUid = f.id;
    const friendDoc = await getUserPublic(friendUid).catch(() => null);
    const name = friendDoc?.displayName || friendUid;
    const label = document.createElement("label");
    label.className = "check-item";
    label.innerHTML = `<input type="checkbox" value="${escapeHtml(friendUid)}" /><span class="label">${escapeHtml(name)}</span>`;
    revNewGroupMembers.appendChild(label);
  }
}

function showRevStatus(msg) {
  if (!revStatus) return;
  revStatus.textContent = msg;
  revStatus.style.display = "block";
}

function resetReviewPhotoDraft() {
  if (_revPhotoDraft.previewUrl) {
    URL.revokeObjectURL(_revPhotoDraft.previewUrl);
  }
  _revPhotoDraft = { file: null, previewUrl: null, remoteUrl: null, remotePath: null, remove: false };
}

function renderReviewPhotoPreview(url) {
  if (!revPhotoPreview) return;
  const src = String(url || "").trim();
  if (!src) {
    revPhotoPreview.innerHTML = `<div class="review-photo-placeholder">${i18nT("Nessuna foto allegata")}</div>`;
    if (revPhotoRemove) revPhotoRemove.style.display = "none";
    return;
  }
  revPhotoPreview.innerHTML = `<img alt="${i18nT("Anteprima foto recensione")}" src="${escapeHtml(src)}" loading="lazy" decoding="async" />`;
  if (revPhotoRemove) revPhotoRemove.style.display = "inline-flex";
}

/**
 * "Con chi l'hai visto?" — ricerca tra i seguiti invece della vecchia lista
 * di checkbox (illeggibile con tanti seguiti). I seguiti si caricano una
 * volta per sessione: listFollowing + listUsersPublicByIds (batch da 10)
 * per i displayName, che sui doc `following` non ci sono.
 */
async function ensureReviewFollowingLoaded() {
  if (Array.isArray(_revFollowing)) return _revFollowing;
  if (!currentUser) return [];
  const rows = await listFollowing(currentUser.uid, { max: 200 }).catch(() => []);
  const uids = rows.map((r) => String(r.uid || "").trim()).filter(Boolean);
  const users = uids.length ? await listUsersPublicByIds(uids).catch(() => []) : [];
  _revFollowing = users
    .map((u) => ({
      uid: u.uid,
      displayName: String(u?.displayName || "").trim() || u.uid,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, "it"));
  return _revFollowing;
}

function renderRevWWChips() {
  if (!revWatchedWithChips) return;
  if (!_revWWSelected.length) {
    revWatchedWithChips.style.display = "none";
    revWatchedWithChips.innerHTML = "";
    return;
  }
  revWatchedWithChips.style.display = "flex";
  revWatchedWithChips.innerHTML = _revWWSelected.map((p) => `
    <span class="rev-ww-chip" data-uid="${escapeHtml(p.uid)}">
      ${escapeHtml(p.displayName)}
      <button type="button" class="rev-ww-chip-x" data-uid="${escapeHtml(p.uid)}" aria-label="${i18nT("Rimuovi {name}", { name: escapeHtml(p.displayName) })}">×</button>
    </span>
  `).join("");
}

function renderRevWWResults() {
  if (!revWatchedWithResults || !revWatchedWithSearch) return;

  // Empty state: non segue nessuno → niente ricerca, solo la spiegazione.
  if (Array.isArray(_revFollowing) && _revFollowing.length === 0) {
    revWatchedWithSearch.style.display = "none";
    revWatchedWithResults.style.display = "none";
    if (revWatchedWithHint) {
      revWatchedWithHint.style.display = "block";
      revWatchedWithHint.textContent = i18nT("Non segui ancora nessuno: segui qualcuno per taggarlo qui.");
    }
    return;
  }

  const q = String(revWatchedWithSearch.value || "").trim().toLowerCase();
  const focused = document.activeElement === revWatchedWithSearch;
  if (!q && !focused) {
    revWatchedWithResults.style.display = "none";
    return;
  }

  if (!Array.isArray(_revFollowing)) {
    revWatchedWithResults.style.display = "block";
    revWatchedWithResults.innerHTML = `<div class="rev-ww-empty">Carico chi segui…</div>`;
    return;
  }

  const selected = new Set(_revWWSelected.map((p) => p.uid));
  const matches = _revFollowing
    .filter((p) => !selected.has(p.uid))
    .filter((p) => !q || p.displayName.toLowerCase().includes(q))
    .slice(0, 8);

  revWatchedWithResults.style.display = "block";
  revWatchedWithResults.innerHTML = matches.length
    ? matches.map((p) => `<button type="button" class="rev-ww-result" data-uid="${escapeHtml(p.uid)}">${escapeHtml(p.displayName)}</button>`).join("")
    : `<div class="rev-ww-empty">${q ? i18nT("Nessun seguito trovato con questo nome.") : i18nT("Hai già taggato tutti i tuoi seguiti.")}</div>`;
}

function addRevWatchedWith(uid) {
  const person = (_revFollowing || []).find((p) => p.uid === uid);
  if (!person) return;
  if (_revWWSelected.some((p) => p.uid === uid)) return;
  if (_revWWSelected.length >= 12) {
    toast(i18nT("Puoi taggare al massimo 12 persone."), i18nT("Con chi l'hai visto"));
    return;
  }
  _revWWSelected = [..._revWWSelected, person];
  renderRevWWChips();
  if (revWatchedWithSearch) {
    revWatchedWithSearch.value = "";
    revWatchedWithSearch.focus();
  }
  renderRevWWResults();
}

function selectedReviewWatchedWith() {
  return _revWWSelected.slice(0, 12).map((p) => ({ uid: p.uid, displayName: p.displayName }));
}

revWatchedWithSearch?.addEventListener("input", () => renderRevWWResults());
revWatchedWithSearch?.addEventListener("focus", () => {
  renderRevWWResults();
  ensureReviewFollowingLoaded().then(() => renderRevWWResults()).catch(() => {});
});
revWatchedWithResults?.addEventListener("click", (e) => {
  const btn = e.target.closest?.(".rev-ww-result");
  if (btn?.dataset?.uid) addRevWatchedWith(btn.dataset.uid);
});
revWatchedWithChips?.addEventListener("click", (e) => {
  const btn = e.target.closest?.(".rev-ww-chip-x");
  if (!btn?.dataset?.uid) return;
  _revWWSelected = _revWWSelected.filter((p) => p.uid !== btn.dataset.uid);
  renderRevWWChips();
  renderRevWWResults();
});

async function submitReview() {
  const text = String(revText?.value || "").trim().slice(0, 5000);
  if (!currentUser || !currentTitle) return;

  if (revSubmit) revSubmit.disabled = true;
  if (revStatus) revStatus.style.display = "none";

  const uid = currentUser.uid;
  const titleId = currentTitle.id;
  const titleName = currentTitle.name || currentTitle.originalName || i18nT("Titolo");
  const displayName = currentUser.displayName || i18nT("Utente");
  const watchedWith = selectedReviewWatchedWith();

  // Il voto è facoltativo, ma recensione/tag/foto/condivisione vivono sul doc
  // rating (le rules richiedono un rating 1–10 per crearlo): senza voto si
  // salvano solo le emozioni.
  const draftRating = toHalfStep(_revRatingDraft);
  const savedRating = toHalfStep(_revExistingRating?.rating);
  const effectiveRating = Number.isFinite(draftRating) ? draftRating : savedRating;
  const needsRatingDoc = !!(
    text ||
    watchedWith.length ||
    _revPhotoDraft.file ||
    (_revPhotoDraft.remoteUrl && !_revPhotoDraft.remove) ||
    revPrivate?.checked ||
    revPublic?.checked ||
    revGroup?.checked
  );

  try {
    // Salva comunque le emozioni scelte (indipendenti dal voto)
    if (!sameEmotionSet(_revEmotionsDraft, myEmotions)) {
      try {
        await upsertTitleEmotions({ uid, titleId, emotions: _revEmotionsDraft, source: "title_page_review" });
        myEmotions = [..._revEmotionsDraft];
        renderEmotionChipGrid(emotionsPickerGrid, myEmotions, toggleMyEmotion);
        renderEmotionsCommunity();
      } catch (err) {
        console.error("[emotions] save from review modal failed:", err);
      }
    }

    // "Chi ti ha conquistato?" — solo film, indipendente dal voto come le
    // emozioni sopra. revCharactersField resta hidden per le serie: il draft
    // e' vuoto e characterPicksEqual è quindi sempre true, no-op.
    if (!revCharactersField?.hidden && !characterPicksEqual(_revCharacterDraft, _revCharacterInitialPicks)) {
      try {
        await upsertCharacterPicks({
          uid, titleId, level: "title", season: 0, episode: 0,
          picks: _revCharacterDraft,
          source: "title_page_review",
        });
        _revCharacterInitialPicks = [..._revCharacterDraft];
      } catch (err) {
        console.error("[characterVotes] save from review modal failed:", err);
      }
    }

    if (!Number.isFinite(effectiveRating)) {
      if (needsRatingDoc) {
        showRevStatus(i18nT("Per salvare recensione, tag o condivisione serve un voto: usa il cursore in alto."));
        if (revSubmit) revSubmit.disabled = false;
        return;
      }
      // Solo emozioni (o niente): chiudi senza toccare i rating
      closeModal(reviewModal);
      resetReviewPhotoDraft();
      toast(i18nT("Fatto!"), i18nT("Salvato"));
      return;
    }

    // Voto nuovo o cambiato dal track del modale → upsert del rating
    if (Number.isFinite(draftRating) && (!Number.isFinite(savedRating) || !isSameRating(draftRating, savedRating))) {
      await upsertRating({ uid, titleId, level: "title", rating: draftRating });
      logSignal({
        uid,
        titleId,
        actionType: "rating",
        rawValue: draftRating,
        source: "title_page_review_modal",
      }).catch(() => {});
    }

    let nextPhotoUrl = _revPhotoDraft.remoteUrl || null;
    let nextPhotoPath = _revPhotoDraft.remotePath || null;

    if (_revPhotoDraft.file) {
      showRevStatus(i18nT("Carico la foto..."));
      const uploaded = await uploadRatingPhoto({
        file: _revPhotoDraft.file,
        uid,
        titleId,
      });
      nextPhotoUrl = uploaded.url;
      nextPhotoPath = uploaded.path;
    } else if (_revPhotoDraft.remove) {
      nextPhotoUrl = null;
      nextPhotoPath = null;
    }

    // Salva i metadati del voto sul rating (review + companions + photo)
    await updateReviewText({
      uid,
      titleId,
      reviewText: text,
      watchedWith,
      photoUrl: nextPhotoUrl,
      photoStoragePath: nextPhotoPath,
    });

    const peopleSnippet = watchedWith.length
      ? i18nT(" · con {v0}", { v0: watchedWith.map((p) => p.displayName).slice(0, 3).join(", ") })
      : "";
    const reviewSnippet = text ? ` — ${text}` : "";
    // Wire format, non UI: il messaggio pubblicato nel thread resta
    // "7,5/10 — testo" perché sia il web sia iOS riconoscono il voto da quel
    // prefisso e lo rendono come badge ★ senza "/10" (RATING_PREFIX_RE).
    const ratingLabel = `${formatMaskedRating(effectiveRating)}/10`;

    // Se Pubblica: posta nel thread pubblico
    if (revPublic?.checked) {
      const publicThread = await ensurePublicThread({ titleId, createdBy: uid });
      await sendMessage({
        threadId: publicThread.id,
        uid,
        displayName,
        text: `${ratingLabel}${peopleSnippet}${reviewSnippet}`,
      });
    }

    // Se Di gruppo: posta nei gruppi selezionati
    if (revGroup?.checked && revGroupList) {
      const selectedGroupIds = [...revGroupList.querySelectorAll("input[type=checkbox]:checked")]
        .map(i => i.value);

      for (const groupId of selectedGroupIds) {
        await sendMessage({
          threadId: groupId,
          uid,
          displayName,
          text: `${ratingLabel} su ${titleName}${peopleSnippet}${reviewSnippet}`,
        }).catch(err => console.error("[review] sendMessage to group failed:", groupId, err));
      }
    }

    // Aggiorna i dati del rating in locale per mostrare la recensione
    ratings = await listRatingsForTitle(titleId);
    renderRatings(currentTitle);
    renderSummaryStats().catch(() => {});
    refreshPersonalState().catch(() => {});

    closeModal(reviewModal);
    resetReviewPhotoDraft();
    toast("Recensione salvata!", i18nT("Fatto"));

  } catch (err) {
    console.error("[review] submitReview error:", err);
    showRevStatus(err?.message || i18nT("Errore nel salvataggio"));
    if (revSubmit) revSubmit.disabled = false;
  }
}

function buildSeasonProgressMap(seasons, state) {
  const out = new Map();
  const progress = safePersonalProgress(state);
  let remainingEpisodes = Math.max(0, progress.episodesWatchedCount);

  seasons.forEach((season) => {
    const totalEpisodes = Number(season?.episodes || 0) || 0;
    const watchedCount = totalEpisodes > 0
      ? Math.min(totalEpisodes, remainingEpisodes)
      : remainingEpisodes > 0 ? 1 : 0;
    remainingEpisodes = Math.max(0, remainingEpisodes - watchedCount);
    out.set(Number(season?.season || 0), {
      watchedCount,
      totalEpisodes,
      completed: watchedCount > 0 && totalEpisodes > 0 && watchedCount >= totalEpisodes,
    });
  });

  return out;
}

function buildSeasonOffsets(seasons) {
  const offsets = new Map();
  let cumulative = 0;
  seasons.forEach((season) => {
    const seasonNum = Number(season?.season || 0) || 0;
    offsets.set(seasonNum, cumulative);
    cumulative += Math.max(0, Number(season?.episodes || 0) || 0);
  });
  return offsets;
}

function computeSeriesProgressPayload(seasons, seasonNumber, episodeNumber) {
  const safeSeason = Number(seasonNumber || 0) || 0;
  const safeEpisode = Number(episodeNumber || 0) || 0;
  if (!safeSeason || !safeEpisode) return null;

  const offsets = buildSeasonOffsets(seasons);
  const offset = offsets.get(safeSeason);
  const currentSeason = seasons.find((season) => Number(season?.season || 0) === safeSeason);
  const seasonEpisodes = Math.max(0, Number(currentSeason?.episodes || 0) || 0);
  if (offset == null || !seasonEpisodes) return null;

  const boundedEpisode = Math.max(1, Math.min(seasonEpisodes, safeEpisode));
  const episodesWatchedCount = offset + boundedEpisode;
  const seasonsCompletedCount = seasons.reduce((count, season) => {
    const num = Number(season?.season || 0) || 0;
    const totalEpisodes = Math.max(0, Number(season?.episodes || 0) || 0);
    if (!totalEpisodes) return count;
    if (num < safeSeason) return count + 1;
    if (num === safeSeason && boundedEpisode >= totalEpisodes) return count + 1;
    return count;
  }, 0);

  return {
    episodesWatchedCount,
    seasonsCompletedCount,
    lastWatchedSeasonNumber: safeSeason,
    lastWatchedEpisodeNumber: boundedEpisode,
  };
}

async function handleSeriesEpisodeSelect(seasons, seasonNumber, episodeNumber, {
  source = "episode_grid",
  entryAllowsPostEpisode = true,
} = {}) {
  const payload = computeSeriesProgressPayload(seasons, seasonNumber, episodeNumber);
  if (!payload) {
    toast(i18nT("Non riesco a salvare questo episodio."), "Progresso");
    return;
  }

  const before = safePersonalProgress(currentTitleState).episodesWatchedCount;

  await handlePersonalStateAction("set_series_progress", {
    source: "title_page_series_progress_grid",
    episodesWatchedCount: payload.episodesWatchedCount,
    seasonsCompletedCount: payload.seasonsCompletedCount,
    lastWatchedSeasonNumber: payload.lastWatchedSeasonNumber,
    lastWatchedEpisodeNumber: payload.lastWatchedEpisodeNumber,
  });

  const after = safePersonalProgress(currentTitleState).episodesWatchedCount;
  const flow = decidePostEpisodeFlow({
    beforeEpisodes: before,
    afterEpisodes: after,
    isCompleted: isCompletedPersonalState(currentTitleState),
    hasTitleRating: Number.isFinite(Number(findMyRating("title")?.rating)),
    entryAllowsPostEpisode,
  });

  // L'ultimo episodio segue la stessa sequenza di tutti gli altri: prima il
  // foglio episodio; il composer titolo viene accodato alla sua chiusura.
  if (flow.openEpisodeSheet) {
    await openEpisodeSeenSheet(seasonNumber, episodeNumber, {
      source,
      offerTitleReviewAfterClose: flow.openTitleReviewAfterEpisode,
    });
    return;
  }

  // Salti più lunghi sono riallineamenti: niente foglio episodio. Manteniamo
  // però il composer generale se il riallineamento completa davvero la serie.
  if (after > before) maybeOpenReviewAfterSeen();
}

/**
 * "Un-see" di un episodio dall'action sheet (toggle di "Segna visto" quando
 * l'episodio è già visto). LIMITAZIONE POSIZIONALE nota: il progresso
 * personale è un contatore lineare (`episodesWatchedCount`), non un set di
 * episodi — non esiste "episodio 5 visto, episodio 4 no" nel modello dati.
 * Quindi "un-see episodio N" significa "riporta il progresso a N-1"
 * (equivalente a iOS/PWA "torna indietro di un episodio"), non "dimentica
 * solo l'episodio N mantenendo i successivi visti". Se N è il primo
 * episodio della prima stagione, il progresso torna a zero via
 * markSeriesUnstarted (non esiste un "episodio 0" da passare a
 * computeSeriesProgressPayload, che clampa a un minimo di 1).
 */
async function handleEpisodeUnsee(seasons, seasonNumber, episodeNumber) {
  if (!currentUser) {
    toast(i18nT("Accedi per aggiornare il tuo stato."), "Login");
    location.href = loginHrefWithNext();
    return;
  }
  if (!currentTitle?.id) return;

  const isFirstEpisodeOfShow = Number(seasonNumber) === (seasons[0]?.season ?? 1) && Number(episodeNumber) <= 1;

  try {
    const preservedSeasonState = captureSeasonRenderState();

    if (isFirstEpisodeOfShow) {
      await markSeriesUnstarted(currentTitle.id);
    } else {
      // Torna all'episodio precedente nello stesso schema di handleSeriesEpisodeSelect.
      const seasonIdx = seasons.findIndex((s) => Number(s.season) === Number(seasonNumber));
      const prevEpisode = Number(episodeNumber) - 1;
      if (prevEpisode >= 1) {
        await handleSeriesEpisodeSelect(seasons, seasonNumber, prevEpisode, {
          source: "step_back",
          entryAllowsPostEpisode: false,
        });
      } else if (seasonIdx > 0) {
        // Primo episodio di una stagione (non la prima): torna all'ultimo
        // episodio della stagione precedente.
        const prevSeason = seasons[seasonIdx - 1];
        const prevSeasonEpisodes = Math.max(1, Number(prevSeason?.episodes || 0) || 1);
        await handleSeriesEpisodeSelect(seasons, prevSeason.season, prevSeasonEpisodes, {
          source: "step_back",
          entryAllowsPostEpisode: false,
        });
      } else {
        await markSeriesUnstarted(currentTitle.id);
      }
      // handleSeriesEpisodeSelect già passa da handlePersonalStateAction
      // (refresh + re-render + restore incluso) — evita il doppio giro sotto.
      restoreSeasonRenderState(preservedSeasonState);
      return;
    }

    ratings = await listRatingsForTitle(currentTitle.id);
    await refreshPersonalState();
    renderRatings(currentTitle);
    restoreSeasonRenderState(preservedSeasonState);
  } catch (err) {
    console.error("[titleState] episode unsee error:", err);
    toast(err?.message || i18nT("Impossibile aggiornare lo stato. Riprova."), i18nT("Errore"));
  }
}

/* ========================================
   Episode Action Sheet (PART B): tap su un cerchio episodio apre "Segna
   visto" / "Vota" / "Commenti" per quell'episodio.
======================================== */
let _epSheetCtx = null; // { seasons, seasonNumber, episodeNumber }

/**
 * Titolo/sinossi per-episodio: il catalogo Somto NON ha oggi un campo per
 * questo (`titles.meta.seasons[]` è solo `{season, episodes}`, verificato in
 * `functions/scripts/backfill-title-metadata.js` — nessun adapter TMDB
 * salva `episodesDetail`/nome/overview per singolo episodio). Questo helper
 * legge un campo opzionale futuro (`episodesDetail`) se mai comparisse, ma
 * finché non esiste ritorna sempre vuoto: la sheet mostra solo "S{n}·E{m}",
 * niente dato inventato. NON un gap silenzioso — segnalato nel report.
 */
function episodeMetaFromTitle(title, seasonNumber, episodeNumber) {
  const seasonsMeta = Array.isArray(title?.meta?.seasons) ? title.meta.seasons : [];
  const seasonMeta = seasonsMeta.find((s) => Number(s?.season) === Number(seasonNumber));
  const episodesMeta = Array.isArray(seasonMeta?.episodesDetail) ? seasonMeta.episodesDetail : [];
  const epMeta = episodesMeta.find((e) => Number(e?.episode) === Number(episodeNumber));
  return {
    name: typeof epMeta?.name === "string" ? epMeta.name.trim() : "",
    overview: typeof epMeta?.overview === "string" ? epMeta.overview.trim() : "",
  };
}

function renderEpSheetSeenButton(seenByMe) {
  if (!epSheetSeenBtn) return;
  epSheetSeenBtn.textContent = seenByMe ? i18nT("Segna come non visto") : i18nT("Segna visto");
  epSheetSeenBtn.classList.toggle("is-seen", seenByMe);
}

function renderEpSheetVoteToggleLabel(myEp) {
  if (!epSheetVoteToggle) return;
  epSheetVoteToggle.textContent = myEp?.rating ? i18nT("Voto {v0}", { v0: formatMaskedRating(myEp.rating) }) : i18nT("Vota");
}

/**
 * Riga di contesto compatta della sheet: Visto · Tuo voto · Media community ·
 * Commenti. Nessuna nuova read — riusa gli stessi dati già calcolati in
 * openEpisodeActionSheet (seenByMe/myEp/avgEp) + il badge presenza commenti
 * lazy-caricato sul cerchio (hasComments, non un conteggio esatto).
 */
function epSheetStatsHtml({ seenByMe, myEp, avgEp, hasComments }) {
  // Nota: "Tuo voto" è un valore inserito dall'utente (mezzi punti,
  // formatMaskedRating). "Media community" è una media calcolata (avg()
  // arrotonda a 1 decimale) e resta sul formato esistente usato altrove
  // per le medie (stesso pattern di avgSeason/avgEp nella griglia cerchi),
  // niente snap ai mezzi punti che falserebbe il dato aggregato.
  const items = [
    { label: i18nT("Visto"), value: seenByMe ? "Sì" : "No" },
    { label: i18nT("Tuo voto"), value: formatMaskedRating(myEp?.rating) },
    { label: "Media community", value: avgEp != null ? String(avgEp) : "—" },
    { label: i18nT("Commenti"), value: hasComments ? "Sì" : "—" },
  ];
  return items.map(({ label, value }) => `
    <div class="ep-sheet-stat">
      <span class="ep-sheet-stat-value">${escapeHtml(value)}</span>
      <span class="ep-sheet-stat-label">${escapeHtml(label)}</span>
    </div>
  `).join("");
}

/**
 * Apre l'action sheet per un episodio. Legge sempre lo stato CORRENTE (non
 * una closure catturata al render del cerchio): `ratings`/`currentTitleState`
 * possono essere cambiati da un'altra azione nel frattempo, e la sheet può
 * restare aperta a cavallo di un refresh.
 *
 * `hasComments` è opzionale: riflette il badge già caricato (lazy, per
 * stagione aperta) sul cerchio cliccato — evita una seconda read qui dentro
 * per lo stesso dato. Se non passato (es. sheet aperta senza passare dal
 * cerchio) il bottone resta sulla label generica "Commenti".
 */
function openEpisodeActionSheet(seasons, seasonNumber, episodeNumber, hasComments = false, openVote = false) {
  if (!epActionSheet || !currentTitle) return;
  _epSheetCtx = { seasons, seasonNumber: Number(seasonNumber), episodeNumber: Number(episodeNumber) };

  const seasonProgressMap = buildSeasonProgressMap(seasons, currentTitleState);
  const seasonProgress = seasonProgressMap.get(Number(seasonNumber)) || { watchedCount: 0 };
  const seenByMe = Number(episodeNumber) <= seasonProgress.watchedCount;
  const myEp = findMyRating("episode", Number(seasonNumber), Number(episodeNumber));
  const avgEp = computeAvg("episode", Number(seasonNumber), Number(episodeNumber));
  const epMeta = bestEpisodeMeta(seasonNumber, episodeNumber);
  const codeLabel = `S${seasonNumber} · E${episodeNumber}`;

  if (epSheetTitle) {
    epSheetTitle.textContent = epMeta.name ? `${codeLabel} — ${epMeta.name}` : codeLabel;
  }
  if (epSheetMeta) {
    epSheetMeta.innerHTML = epMeta.overview
      ? `<p class="ep-sheet-synopsis">${escapeHtml(epMeta.overview)}</p>`
      : "";
  }
  if (epSheetStats) {
    epSheetStats.innerHTML = epSheetStatsHtml({ seenByMe, myEp, avgEp, hasComments });
  }

  renderEpSheetSeenButton(seenByMe);
  renderEpSheetVoteToggleLabel(myEp);
  if (epSheetVoteBox) {
    epSheetVoteBox.hidden = true;
    epSheetVoteBox.innerHTML = "";
  }
  if (epSheetCommentsLabel) {
    epSheetCommentsLabel.textContent = hasComments ? i18nT("Vedi commenti") : i18nT("Commenti");
  }

  openModal(epActionSheet);

  // Entry-point "★ voto" dalla riga episodio / nudge: apri direttamente il
  // flusso di voto (espande la stessa vote-box del toggle esistente).
  if (openVote && epSheetVoteToggle && epSheetVoteBox && epSheetVoteBox.hidden) {
    epSheetVoteToggle.click();
  }
}

if (epSheetSeenBtn) {
  epSheetSeenBtn.addEventListener("click", async () => {
    if (!_epSheetCtx) return;
    if (!requireAuthOrRedirect()) return;
    const { seasons, seasonNumber, episodeNumber } = _epSheetCtx;

    const seasonProgressMap = buildSeasonProgressMap(seasons, currentTitleState);
    const seasonProgress = seasonProgressMap.get(Number(seasonNumber)) || { watchedCount: 0 };
    const seenByMe = Number(episodeNumber) <= seasonProgress.watchedCount;

    closeModal(epActionSheet);
    if (seenByMe) {
      await handleEpisodeUnsee(seasons, seasonNumber, episodeNumber);
    } else {
      await handleSeriesEpisodeSelect(seasons, seasonNumber, episodeNumber, { source: "episode_action_sheet" });
    }
  });
}

if (epSheetVoteToggle) {
  epSheetVoteToggle.addEventListener("click", () => {
    if (!_epSheetCtx || !epSheetVoteBox) return;
    if (!requireAuthOrRedirect()) return;
    const { seasons, seasonNumber, episodeNumber } = _epSheetCtx;
    const myEp = findMyRating("episode", Number(seasonNumber), Number(episodeNumber));

    const shouldHide = !epSheetVoteBox.hidden;
    if (shouldHide) {
      epSheetVoteBox.hidden = true;
      renderEpSheetVoteToggleLabel(myEp);
      return;
    }

    epSheetVoteBox.innerHTML = ratingTrackHtml(myEp?.rating ?? null, "ratingTrackEpisode");
    wireRatingTrack(epSheetVoteBox, (v) => {
      // submitRating ricarica `ratings` e rilancia renderRatings(): la sheet
      // resta aperta, ma il suo contenuto va riallineato allo stato fresco
      // (incluso il voto community, che cambia col nuovo voto appena inviato).
      submitRating({ level: "episode", season: seasonNumber, episode: episodeNumber, rating: v }).then(() => {
        const freshMyEp = findMyRating("episode", Number(seasonNumber), Number(episodeNumber));
        renderEpSheetVoteToggleLabel(freshMyEp);
        if (epSheetVoteBox) epSheetVoteBox.hidden = true;
        if (epSheetStats) {
          const freshAvgEp = computeAvg("episode", Number(seasonNumber), Number(episodeNumber));
          const seasonProgressMapFresh = buildSeasonProgressMap(seasons, currentTitleState);
          const seasonProgressFresh = seasonProgressMapFresh.get(Number(seasonNumber)) || { watchedCount: 0 };
          const seenByMeFresh = Number(episodeNumber) <= seasonProgressFresh.watchedCount;
          const hasCommentsFresh = !epSheetCommentsLabel || epSheetCommentsLabel.textContent === i18nT("Vedi commenti");
          epSheetStats.innerHTML = epSheetStatsHtml({ seenByMe: seenByMeFresh, myEp: freshMyEp, avgEp: freshAvgEp, hasComments: hasCommentsFresh });
        }
      });
    }, myEp?.rating ?? null);
    epSheetVoteBox.hidden = false;
    epSheetVoteToggle.textContent = i18nT("Chiudi voto");
  });
}

if (epSheetCommentsBtn) {
  epSheetCommentsBtn.addEventListener("click", async () => {
    if (!_epSheetCtx || !currentTitle) return;
    if (!requireAuthOrRedirect()) return;
    const { seasonNumber, episodeNumber } = _epSheetCtx;

    closeModal(epActionSheet);
    await openEpisodeDiscussionSheet(seasonNumber, episodeNumber, { source: "episode_action_sheet" });
  });
}

/* ========================================
   Episode Discussion Sheet (in-page bottom sheet)
   Sostituisce la vecchia navigazione a /thread.html?tid= — che apriva una
   pagina piena a sé, mezza vuota (solo composer+lista, niente altro
   contesto) e difficile da chiudere (nessun back ovvio verso il titolo).
   Qui il thread episodio resta UN thread pubblico reale (stesso
   ensurePublicThread + collection threads/{id}/messages di sempre), solo
   reso come sheet sopra la pagina titolo invece che come pagina a parte.
======================================== */
let _epDiscCtx = null; // { titleId, seasonNumber, episodeNumber, threadId }
let _epDiscUnsub = null; // unsubscribe onSnapshot messaggi, attivo solo a thread aperto

// Warning spoiler mostrato 1x per episodio per sessione tab. Chiave nota
// SUBITO all'apertura (titleId__season__episode, prima ancora di risolvere
// il thread id reale via ensurePublicThread) — niente attesa di rete prima
// di decidere se mostrare il gate. sessionStorage (non localStorage): il
// warning va ripetuto in una sessione futura, non sparire per sempre.
function epDiscGateKey(titleId, seasonNumber, episodeNumber) {
  return `epDiscGateSeen__${titleId}__${seasonNumber}__${episodeNumber}`;
}
function epDiscGateAlreadySeen(key) {
  try { return sessionStorage.getItem(key) === "1"; } catch { return false; }
}
function epDiscGateMarkSeen(key) {
  try { sessionStorage.setItem(key, "1"); } catch { /* storage non disponibile: al peggio ririchiede il gate */ }
}

function closeEpisodeDiscussionSheet() {
  if (_epDiscUnsub) {
    try { _epDiscUnsub(); } catch { /* no-op */ }
    _epDiscUnsub = null;
  }
  closeModal(epDiscussionSheet);
  _epDiscCtx = null;
  if (_pendingTitleReviewAfterDiscussion) openQueuedTitleReview();
}

async function openEpisodeDiscussionSheet(seasonNumber, episodeNumber, {
  source = "episode_page",
} = {}) {
  if (!epDiscussionSheet || !currentTitle) return;

  const epMeta = bestEpisodeMeta(seasonNumber, episodeNumber);
  const codeLabel = `S${seasonNumber} · E${episodeNumber}`;

  if (epDiscCode) epDiscCode.textContent = codeLabel;
  if (epDiscEpisodeName) {
    if (epMeta.name) {
      epDiscEpisodeName.textContent = epMeta.name;
      epDiscEpisodeName.hidden = false;
    } else {
      epDiscEpisodeName.textContent = "";
      epDiscEpisodeName.hidden = true;
    }
  }
  if (epDiscGateText) {
    epDiscGateText.textContent = i18nT("Questa discussione può contenere spoiler della serie fino a {codeLabel}. Vuoi procedere?", { codeLabel });
  }

  if (epDiscThread) epDiscThread.hidden = true;
  if (epDiscGate) epDiscGate.hidden = false;
  if (epDiscMessages) epDiscMessages.innerHTML = "";
  if (epDiscEmpty) epDiscEmpty.hidden = true;
  if (epDiscComposerInput) epDiscComposerInput.value = "";

  const gateKey = epDiscGateKey(currentTitle.id, seasonNumber, episodeNumber);
  _epDiscCtx = {
    titleId: currentTitle.id,
    seasonNumber: Number(seasonNumber),
    episodeNumber: Number(episodeNumber),
    threadId: null,
    gateKey,
  };

  openModal(epDiscussionSheet);
  void logEvent("post_episode_discussion_opened", {
    platform: "web",
    source,
    season: Number(seasonNumber),
    episode: Number(episodeNumber),
  });

  if (epDiscGateAlreadySeen(gateKey)) {
    // Warning già mostrato in questa sessione per questo episodio: entra
    // diretto nel thread, il gate resta pronto ma non visibile.
    await enterEpisodeDiscussion();
  }
}

async function enterEpisodeDiscussion() {
  if (!_epDiscCtx || !currentTitle) return;
  if (!requireAuthOrRedirect()) return;

  if (epDiscGateEnter) epDiscGateEnter.disabled = true;
  try {
    const t = await ensurePublicThread({
      titleId: _epDiscCtx.titleId,
      season: _epDiscCtx.seasonNumber,
      episode: _epDiscCtx.episodeNumber,
      createdBy: currentUser.uid,
    });
    if (!_epDiscCtx) return; // sheet chiusa nel frattempo
    _epDiscCtx.threadId = t.id;
    if (_epDiscCtx.gateKey) epDiscGateMarkSeen(_epDiscCtx.gateKey);

    if (epDiscGate) epDiscGate.hidden = true;
    if (epDiscThread) epDiscThread.hidden = false;

    if (_epDiscUnsub) {
      try { _epDiscUnsub(); } catch { /* no-op */ }
    }
    _epDiscUnsub = listenThreadMessages(t.id, {
      max: 500,
      onChange: (messages) => renderEpisodeDiscussionMessages(messages),
    });
  } catch (err) {
    console.error("[episode discussion] ensurePublicThread error:", err);
    toast(err?.message || i18nT("Errore nell'apertura della discussione."), i18nT("Errore"));
  } finally {
    if (epDiscGateEnter) epDiscGateEnter.disabled = false;
  }
}

function epDiscBubbleHtml(msg) {
  const isMine = currentUser && msg.uid === currentUser.uid;
  const name = msg.displayName || i18nT("Utente Somto");
  const time = formatReviewStamp(msg.createdAt) || "";
  return `
    <div class="ep-disc-msg${isMine ? " is-mine" : ""}">
      <div class="ep-disc-msg-avatar" aria-hidden="true">${escapeHtml(initialsFromName(name))}</div>
      <div class="ep-disc-msg-bubble">
        <div class="ep-disc-msg-head">
          <span class="ep-disc-msg-name">${escapeHtml(name)}</span>
          ${time ? `<span class="ep-disc-msg-time">${escapeHtml(time)}</span>` : ""}
        </div>
        <div class="ep-disc-msg-text">${renderMentionRichText(msg.text || "", { lineBreaks: false })}</div>
      </div>
    </div>
  `;
}

function renderEpisodeDiscussionMessages(messages) {
  if (!epDiscMessages) return;
  const list = Array.isArray(messages) ? messages : [];

  if (!list.length) {
    epDiscMessages.innerHTML = "";
    if (epDiscEmpty) {
      epDiscEmpty.hidden = false;
      epDiscMessages.appendChild(epDiscEmpty);
    }
    return;
  }

  if (epDiscEmpty) epDiscEmpty.hidden = true;
  epDiscMessages.innerHTML = list.map(epDiscBubbleHtml).join("");
  // Sempre scrollato in fondo: coerente con l'aspettativa "ultimo messaggio
  // visibile" di una chat: il volume per-episodio resta basso, niente
  // scroll-jump fastidioso su liste lunghe da preservare.
  epDiscMessages.scrollTop = epDiscMessages.scrollHeight;
}

async function sendEpisodeDiscussionMessage() {
  if (!_epDiscCtx?.threadId || !currentUser) return;
  const raw = epDiscComposerInput?.value?.trim();
  if (!raw) return;

  // Token del picker + `@handle` battuti a mano: senza questa risoluzione il
  // tag resta testo e non notifica nessuno.
  const text = epDiscMentionCtrl ? await epDiscMentionCtrl.resolveForSend(raw) : raw;

  if (epDiscComposerSend) epDiscComposerSend.disabled = true;
  if (epDiscComposerInput) epDiscComposerInput.disabled = true;
  try {
    await sendThreadMessage({
      threadId: _epDiscCtx.threadId,
      senderUid: currentUser.uid,
      displayName: currentUser.displayName || i18nT("Utente"),
      text,
    });
    if (epDiscComposerInput) epDiscComposerInput.value = "";
    epDiscMentionCtrl?.reset();
  } catch (err) {
    console.error("[episode discussion] sendThreadMessage error:", err);
    toast(err?.message || i18nT("Errore nell'invio del messaggio."), i18nT("Errore"));
  } finally {
    if (epDiscComposerSend) epDiscComposerSend.disabled = false;
    if (epDiscComposerInput) {
      epDiscComposerInput.disabled = false;
      epDiscComposerInput.focus();
    }
  }
}

// Picker menzioni sul composer della discussione episodio. Il thread è sempre
// pubblico, quindi vale la ricerca di default del modulo (utenti per `@`,
// titoli e persone per `#`).
const epDiscMentionCtrl = attachMentionAutocomplete(epDiscComposerInput, epDiscMentionDropdown);

if (epDiscGateEnter) {
  epDiscGateEnter.addEventListener("click", () => { enterEpisodeDiscussion(); });
}

if (epDiscComposerForm) {
  epDiscComposerForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!requireAuthOrRedirect()) return;
    sendEpisodeDiscussionMessage();
  });
}

if (epDiscussionSheet) {
  // Niente wireModalClose qui (chiuderebbe solo il display, senza fermare
  // il listener onSnapshot dei messaggi): tutti i [data-close] della sheet
  // passano da closeEpisodeDiscussionSheet, che fa anche l'unsub.
  epDiscussionSheet.querySelectorAll("[data-close]").forEach((n) => {
    n.addEventListener("click", closeEpisodeDiscussionSheet);
  });

  // Swipe-down per chiudere: attivo solo quando il tocco parte dal grabber
  // o dall'header (mai dal corpo messaggi, per non rubare lo scroll verticale
  // della lista chat). Nessuna libreria: drag verticale semplice su
  // pointerdown/move/up, soglia 90px o velocità alta.
  const dragHandle = epDiscussionSheet.querySelector(".ep-sheet-grabber");
  const dragCard = epDiscussionSheet.querySelector(".ep-disc-card");
  if (dragHandle && dragCard) {
    let dragStartY = null;
    let dragCurrentY = 0;
    let dragStartTime = 0;

    const onPointerMove = (e) => {
      if (dragStartY == null) return;
      dragCurrentY = Math.max(0, e.clientY - dragStartY);
      dragCard.style.transform = `translateY(${dragCurrentY}px)`;
      dragCard.style.transition = "none";
    };
    const onPointerUp = () => {
      if (dragStartY == null) return;
      const elapsed = Date.now() - dragStartTime;
      const velocity = dragCurrentY / Math.max(elapsed, 1);
      dragCard.style.transition = "";
      dragCard.style.transform = "";
      dragStartY = null;
      if (dragCurrentY > 90 || velocity > 0.6) {
        closeEpisodeDiscussionSheet();
      }
      dragCurrentY = 0;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
    dragHandle.addEventListener("pointerdown", (e) => {
      dragStartY = e.clientY;
      dragStartTime = Date.now();
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    });
  }
}

function timestampToMillis(value) {
  if (!value) return 0;
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value?.seconds === "number") return value.seconds * 1000;
  if (typeof value === "number") return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatReviewStamp(value) {
  const ms = timestampToMillis(value);
  if (!ms) return "";
  return new Intl.DateTimeFormat("it-IT", {
    day: "numeric",
    month: "short",
  }).format(new Date(ms));
}

function reviewPreviewText(value, max = 220) {
  const clean = String(value || "").trim().replace(/\s+/g, " ");
  if (!clean) return "";
  return clean.length > max ? `${clean.slice(0, max).trim()}…` : clean;
}

function sortRatingsByRecency(items) {
  return (items || []).slice().sort((a, b) => {
    const left = timestampToMillis(a?.updatedAt || a?.createdAt);
    const right = timestampToMillis(b?.updatedAt || b?.createdAt);
    return right - left;
  });
}

function buildSocialReviewCardHtml(entry) {
  const displayName = usersCache.get(entry.uid)?.displayName || i18nT("Utente Somto");
  const score = Number.isFinite(Number(entry?.rating)) ? formatMaskedRating(entry.rating) : "—";
  const stamp = formatReviewStamp(entry.updatedAt || entry.createdAt);
  const reviewText = reviewPreviewText(entry.reviewText);
  const watchedWith = Array.isArray(entry.watchedWith) && entry.watchedWith.length
    ? i18nT("Con {people}", { people: entry.watchedWith.slice(0, 3).map(person => person.displayName).join(", ") })
    : "";

  return `
    <article class="social-review-card">
      <div class="social-review-head">
        <div class="social-review-avatar">${escapeHtml(initialsFromName(displayName))}</div>
        <div class="social-review-meta">
          <div class="social-review-author">${escapeHtml(displayName)}</div>
          <div class="social-review-sub">${escapeHtml(score)}${stamp ? ` · ${escapeHtml(stamp)}` : ""}</div>
        </div>
      </div>
      ${watchedWith ? `<div class="social-review-tag">${escapeHtml(watchedWith)}</div>` : ""}
      <p class="social-review-body">${escapeHtml(reviewText || i18nT("Ha dato {score} a questo titolo.", { score }))}</p>
    </article>
  `;
}

function renderSocialReviewList(container, items, emptyText) {
  if (!container) return;
  if (!items.length) {
    container.innerHTML = `<div class="social-review-empty">${escapeHtml(emptyText)}</div>`;
    return;
  }
  container.innerHTML = items.map(buildSocialReviewCardHtml).join("");
}

async function renderSocialSections() {
  const titleRatings = sortRatingsByRecency(
    (ratings || []).filter(r => r.level === "title" && Number.isFinite(Number(r.rating)))
  );
  const friendIDs = new Set((await ensureFriends().catch(() => [])).map(friend => friend.uid));
  const friendItems = titleRatings.filter(r => friendIDs.has(r.uid));
  const communityItems = titleRatings.filter(r => r.uid !== currentUser?.uid && !friendIDs.has(r.uid));

  await ensureUsers([
    ...friendItems.map(r => r.uid),
    ...communityItems.map(r => r.uid),
  ]);

  renderSocialReviewList(
    friendsReviewsList,
    friendItems.slice(0, 4),
    currentUser
      ? (friendIDs.size
        ? i18nT("I tuoi amici non hanno ancora lasciato voti o recensioni su questo titolo.")
        : i18nT("Quando aggiungi amici, qui vedrai i loro voti e le loro recensioni."))
      : i18nT("Accedi per vedere cosa pensano i tuoi amici di questo titolo.")
  );
  renderSocialReviewList(
    communityReviewsList,
    communityItems.slice(0, 6),
    i18nT("La community non ha ancora lasciato voti o recensioni leggibili per questo titolo.")
  );
}

/* ========================================
   Chi la sta guardando (amici/seguiti) — solo serie
======================================== */
// Costruisce il chip di progresso "a che punto è": S{stagione}·E{episodio}
// in corso, "Completa" se finita, fallback "{percent}%". "" se nessun dato.
function buildWatcherProgressChip(state, seriesProgress) {
  const normState = String(state || "").trim().toLowerCase();
  const isCompleted = normState === "completed_unrated" || normState === "rated";
  if (isCompleted) {
    return `<span class="watcher-progress-chip is-complete">${i18nT("Completa")}</span>`;
  }

  const progress = seriesProgress && typeof seriesProgress === "object" ? seriesProgress : null;
  const season = Number(progress?.lastWatchedSeasonNumber);
  const episode = Number(progress?.lastWatchedEpisodeNumber);
  if (Number.isFinite(season) && season > 0 && Number.isFinite(episode) && episode > 0) {
    return `<span class="watcher-progress-chip is-progress">S${season}·E${episode}</span>`;
  }
  const percent = Number(progress?.percentComplete);
  if (Number.isFinite(percent) && percent > 0) {
    // percentComplete e' una frazione 0-1 (callable getTitleWatchersProgress): *100 per la %.
    return `<span class="watcher-progress-chip is-progress">${Math.round(Math.max(0, Math.min(1, percent)) * 100)}%</span>`;
  }
  return `<span class="watcher-progress-chip is-progress">${i18nT("In corso")}</span>`;
}

async function renderSeriesWatchers() {
  if (!seriesWatchersCard || !seriesWatchersList) return;

  // Solo serie, solo loggati. Per i film la CF torna [], quindi hide-if-empty fa da rete di sicurezza.
  const isSeries = String(currentTitle?.type || "").toLowerCase() === "tv";
  if (!currentUser || !currentTitle?.id || !isSeries) {
    seriesWatchersCard.style.display = "none";
    return;
  }

  const watchers = await getTitleWatchersProgress(currentTitle.id).catch(() => []);
  if (!Array.isArray(watchers) || !watchers.length) {
    seriesWatchersCard.style.display = "none";
    return;
  }

  seriesWatchersList.innerHTML = watchers.map((w) => {
    const uid = String(w?.uid || "").trim();
    const name = safeDisplayName(w);
    const initials = initialsFromName(name);
    const photo = safeImgUrl(w?.photoURL);
    const avatar = photo
      ? `<img class="watcher-avatar-img" src="${escapeHtml(photo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
      : "";
    const chip = buildWatcherProgressChip(w?.state, w?.seriesProgress);
    const guidedMarker = w?.isSynthetic === true
      ? `<span class="watcher-guided-marker" title="${i18nT("Profilo guidato da Somto")}">${i18nT("Profilo guidato")}</span>`
      : "";

    return `
      <div class="watcher-row" data-uid="${escapeHtml(uid)}" role="button" tabindex="0">
        <div class="watcher-left">
          <div class="watcher-avatar">${avatar}<span class="watcher-avatar-fallback">${escapeHtml(initials)}</span></div>
          <div class="watcher-meta">
            <div class="watcher-name">${escapeHtml(name)}</div>
            ${guidedMarker}
          </div>
        </div>
        <div class="watcher-right">${chip}</div>
      </div>
    `;
  }).join("");

  seriesWatchersList.querySelectorAll(".watcher-row").forEach((el) => {
    const u = el.getAttribute("data-uid");
    const go = () => {
      if (u) location.href = `/user.html?uid=${encodeURIComponent(u)}`;
    };
    el.addEventListener("click", go);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        go();
      }
    });
  });

  seriesWatchersCard.style.display = "";
}

/**
 * "In queste liste" — liste pubbliche che includono il titolo corrente.
 * Dipende dal campo server `itemTitleIds` (array-contains) su userLists.
 * Se il campo non è ancora popolato il risultato è vuoto → card nascosta.
 */
async function renderTitleLists() {
  if (!titleListsCard || !titleListsList) return;
  // Liste pubbliche: dato pubblico, non dipende dall'auth (currentUser può non
  // essere ancora pronto al primo render → non gate-are su di esso, altrimenti
  // la sezione resta vuota anche quando esistono liste col titolo).
  if (!currentTitle?.id) {
    titleListsCard.style.display = "none";
    return;
  }

  const lists = await fetchListsContainingTitle(currentTitle.id, { max: 12, currentUid: currentUser?.uid || null })
    .catch(() => []);

  if (!Array.isArray(lists) || lists.length === 0) {
    titleListsCard.style.display = "none";
    return;
  }

  titleListsList.innerHTML = lists.map((list) => {
    const slug = list.slug || list.editorialSlug || list.id;
    const href = `/lista.html?id=${encodeURIComponent(list.id)}`;
    const shareUrl = `https://somto.it/lista/${encodeURIComponent(slug)}`;
    const isEditorial = list.editorial === true || Boolean(list.editorialSlug);
    const chipHtml = isEditorial
      ? `<span class="title-lists-chip editorial">Editoriale</span>`
      : `<span class="title-lists-chip">${i18nT("Pubblica")}</span>`;
    const itemCount = i18nT("{count} titoli", { count: list.itemCount });
    const ownerName = escapeHtml(list.owner?.displayName || i18nT("Somto"));

    return `
      <a class="title-lists-row" href="${escapeHtml(href)}">
        <div class="title-lists-info">
          <div class="title-lists-name">${escapeHtml(list.title)}</div>
          <div class="title-lists-sub">${ownerName} · ${escapeHtml(itemCount)} ${chipHtml}</div>
        </div>
        <svg class="title-lists-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 18l6-6-6-6"/>
        </svg>
      </a>
    `;
  }).join("");

  titleListsCard.style.display = "";
}

/**
 * Breakdown dei voti personali per stagione + voto generale.
 * Visibile solo per serie con voti dell'utente. Permette di:
 *  - vedere/modificare il voto per ogni stagione (click sulla riga)
 *  - vedere la media calcolata dalle stagioni
 *  - migrare 1-tap il voto generale su una stagione specifica
 */
function renderMyRatingsBreakdown(title) {
  if (!myRatingsBreakdownCard || !myRatingsBreakdownBody) return;

  const isSeries = String(title?.type || "").toLowerCase() === "tv";
  const myTitle = findMyRating("title");
  const seasons = isSeries ? materializeSeasons(title.meta || {}) : [];
  const availableSeasons = seasons.length
    ? seasons.map(s => Number(s.season)).filter(Number.isFinite).sort((a,b) => a - b)
    : [];

  const mySeasonRatings = (ratings || [])
    .filter(r => r.uid === currentUser?.uid && r.level === "season" && Number.isFinite(Number(r.season)))
    .reduce((acc, r) => { acc[Number(r.season)] = r; return acc; }, {});
  const seasonKeys = Object.keys(mySeasonRatings).map(Number).sort((a,b) => a - b);

  // Voto derivato (privato) dai voti episodio. Le stagioni con voto ESPLICITO
  // vincono, quindi le escludiamo dalle righe derivate.
  const derivedSeries = myDerivedRating && myDerivedRating.series ? myDerivedRating.series : null;
  const hasDerivedSeries = Boolean(derivedSeries && Number.isFinite(Number(derivedSeries.avg)));
  const derivedSeasonMap = (myDerivedRating && myDerivedRating.season && typeof myDerivedRating.season === "object")
    ? myDerivedRating.season : {};
  const derivedSeasonKeys = Object.keys(derivedSeasonMap)
    .map(Number)
    .filter(s => Number.isFinite(s) && !mySeasonRatings[s])
    .sort((a,b) => a - b);

  // Mostra la card solo per serie quando c'è qualcosa di rilevante (voto
  // esplicito o derivato dai propri voti episodio).
  if (!currentUser || !isSeries || (seasonKeys.length === 0 && !myTitle && !hasDerivedSeries)) {
    myRatingsBreakdownCard.style.display = "none";
    return;
  }
  myRatingsBreakdownCard.style.display = "";

  const migrationTargets = availableSeasons.filter(s => !mySeasonRatings[s]);
  const avgSeasons = seasonKeys.length
    ? (seasonKeys.reduce((sum, s) => sum + Number(mySeasonRatings[s].rating || 0), 0) / seasonKeys.length)
    : null;

  let html = "";

  if (seasonKeys.length > 0) {
    html += `<div class="breakdown-seasons">`;
    html += `<div class="breakdown-list-label muted">${i18nT("Le tue stagioni")}</div>`;
    html += seasonKeys.map(s => `
      <div class="breakdown-row-wrap">
        <button type="button" class="breakdown-row" data-edit-season="${escapeHtml(String(s))}">
          <span><b>Stagione ${escapeHtml(String(s))}</b></span>
          <span class="breakdown-row-right">
            <span class="breakdown-rating">${escapeHtml(formatMaskedRating(mySeasonRatings[s].rating) ?? "—")}</span>
            <span aria-hidden="true">›</span>
          </span>
        </button>
        <button type="button" class="btn ghost xs breakdown-remove" data-remove-season="${escapeHtml(String(s))}">${i18nT("Rimuovi voto")}</button>
      </div>
    `).join("");
    if (Number.isFinite(avgSeasons)) {
      html += `
        <div class="breakdown-row breakdown-row-static">
          <span><b>${i18nT("Media stagioni")}</b></span>
          <span class="breakdown-rating">${escapeHtml(avgSeasons.toFixed(1))}</span>
        </div>
      `;
    }
    html += `</div>`;
  }

  if (migrationTargets.length > 0) {
    html += `
      <details class="breakdown-add">
        <summary class="btn ghost small">${i18nT("+ Aggiungi voto per stagione")}</summary>
        <div class="breakdown-add-list">
          ${migrationTargets.map(s => `
            <button class="btn ghost xs" type="button" data-add-season="${escapeHtml(String(s))}">Stagione ${escapeHtml(String(s))}</button>
          `).join("")}
        </div>
      </details>
    `;
  }

  if (myTitle) {
    html += `<hr class="breakdown-divider" />`;
    html += `
      <div class="breakdown-titlelevel">
        <div>
          <div class="muted">${i18nT("Voto generale")}</div>
          <div class="breakdown-title-rating">${escapeHtml(formatMaskedRating(myTitle.rating) ?? "—")}</div>
        </div>
        <div class="breakdown-titlelevel-actions">
          ${migrationTargets.length > 0 ? `
            <details class="breakdown-migrate">
              <summary class="btn ghost small">${i18nT("Sposta su…")}</summary>
              <div class="breakdown-add-list">
                ${migrationTargets.map(s => `
                  <button class="btn ghost xs" type="button" data-migrate-season="${escapeHtml(String(s))}">Stagione ${escapeHtml(String(s))}</button>
                `).join("")}
              </div>
            </details>
          ` : ""}
          <button class="btn ghost small breakdown-remove" type="button" data-remove-title="1">${i18nT("Rimuovi voto")}</button>
        </div>
      </div>
    `;
  }

  // Blocco DERIVATO (sola lettura): media automatica dai voti episodio.
  // Additivo, non tocca le righe esplicite sopra; niente handler/migrazione.
  if (hasDerivedSeries) {
    html += `<hr class="breakdown-divider" />`;
    html += `<div class="breakdown-derived">`;
    html += `
      <div class="breakdown-list-label muted">
        ${i18nT("Dai tuoi voti episodio")}
        <span class="breakdown-auto-tag">${"auto"}</span>
      </div>
      <p class="breakdown-derived-sub">${i18nT("Media automatica dai voti che hai dato ai singoli episodi.")}</p>
      <div class="breakdown-row breakdown-row-static">
        <span><b>${i18nT("Serie (media)")}</b></span>
        <span class="breakdown-rating">${escapeHtml(formatMaskedRating(derivedSeries.avg) ?? "—")}</span>
      </div>
    `;
    html += derivedSeasonKeys.map(s => `
      <div class="breakdown-row breakdown-row-static">
        <span>Stagione ${escapeHtml(String(s))}</span>
        <span class="breakdown-rating">${escapeHtml(formatMaskedRating(derivedSeasonMap[s].avg) ?? "—")}</span>
      </div>
    `).join("");
    html += `</div>`;
  }

  myRatingsBreakdownBody.innerHTML = html;

  // Wire click su riga stagione: scroll alla card della stagione + apri il composer.
  myRatingsBreakdownBody.querySelectorAll("[data-edit-season]").forEach(btn => {
    btn.addEventListener("click", () => {
      const s = Number(btn.dataset.editSeason);
      openSeasonRateBox(s);
    });
  });
  myRatingsBreakdownBody.querySelectorAll("[data-add-season]").forEach(btn => {
    btn.addEventListener("click", () => {
      const s = Number(btn.dataset.addSeason);
      openSeasonRateBox(s);
    });
  });
  myRatingsBreakdownBody.querySelectorAll("[data-migrate-season]").forEach(btn => {
    btn.addEventListener("click", () => {
      const s = Number(btn.dataset.migrateSeason);
      void migrateTitleToSeason(s);
    });
  });
  myRatingsBreakdownBody.querySelectorAll("[data-remove-season]").forEach(btn => {
    btn.addEventListener("click", () => {
      const s = Number(btn.dataset.removeSeason);
      void handleRemoveRating("season", s);
    });
  });
  myRatingsBreakdownBody.querySelectorAll("[data-remove-title]").forEach(btn => {
    btn.addEventListener("click", () => {
      void handleRemoveRating("title");
    });
  });
}

/**
 * Apre/scrolla la card della stagione selezionata e mostra il box di voto.
 * Usata sia dal breakdown ("modifica stagione X") che da "aggiungi voto".
 */
function openSeasonRateBox(seasonNum) {
  if (!seasonsBox || !Number.isFinite(seasonNum)) return;
  // Nuovo layout a selettore: porta il selettore sulla stagione scelta,
  // ri-renderizza la sezione e apri la vote-box di quella stagione.
  _selectedEpisodeSeason = Number(seasonNum);
  renderRatings(currentTitle);
  const wrap = seasonsBox.querySelector(".ep-season");
  const rateBox = seasonsBox.querySelector(".ep-season-rate");
  const toggleBtn = seasonsBox.querySelector(".ep-season-vote-toggle");
  if (rateBox) rateBox.hidden = false;
  if (toggleBtn) toggleBtn.textContent = i18nT("Chiudi voto stagione");
  if (wrap) wrap.scrollIntoView({ behavior: "smooth", block: "center" });
}

/**
 * Migrazione 1-tap: sposta il voto title-level dell'utente sulla stagione
 * scelta. Crea il nuovo doc, elimina il vecchio, ricarica i voti.
 */
async function migrateTitleToSeason(seasonNum) {
  if (!currentUser || !currentTitle || !Number.isFinite(seasonNum)) return;
  try {
    await migrateRatingLevel({
      uid: currentUser.uid,
      titleId: currentTitle.id,
      fromLevel: "title",
      toLevel: "season",
      toSeason: seasonNum,
    });
    ratings = await listRatingsForTitle(currentTitle.id);
    renderRatings(currentTitle);
    renderSummaryStats().catch(() => {});
    toast(i18nT("Voto generale spostato su stagione {season}.", { season: seasonNum }), i18nT("Aggiornato"));
  } catch (err) {
    console.error("[rating] migrateTitleToSeason error:", err);
    toast(i18nT("Impossibile spostare il voto. Riprova."), i18nT("Errore"));
  }
}

/**
 * "Rimuovi voto": elimina il voto dell'utente per un item (title o season).
 * Il titolo resta visto (diventa "visto senza voto"): il flag rating sul
 * titleState viene azzerato dal trigger server e l'aggregato community sottrae
 * il delta. Chiede conferma (azione distruttiva), poi ricarica i voti.
 *
 * @param {"title"|"season"} level
 * @param {number|null} season
 */
async function handleRemoveRating(level, season = null) {
  if (!currentUser || !currentTitle?.id) return;
  const label = level === "season" && Number.isFinite(Number(season))
    ? i18nT("il voto della stagione {season}", { season })
    : i18nT("il tuo voto");
  const ok = await showConfirm(i18nT("Rimuovere {label}? Il titolo resta tra i visti, senza voto.", { label }));
  if (!ok) return;
  try {
    await deleteRating({
      titleId: currentTitle.id,
      level,
      season: season ?? 0,
      episode: 0,
    });
    ratings = await listRatingsForTitle(currentTitle.id);
    renderRatings(currentTitle);
    renderSummaryStats().catch(() => {});
    refreshPersonalState().catch(() => {});
    toast(i18nT("Voto rimosso."), i18nT("Fatto"));
  } catch (err) {
    console.error("[rating] handleRemoveRating error:", err);
    toast(i18nT("Impossibile rimuovere il voto. Riprova."), i18nT("Errore"));
  }
}

// renderRatings (sostituita)
/* ========================================
   Emozioni post-visione (i18nT("Che impressione hai avuto?"))
======================================== */

function sameEmotionSet(a, b) {
  const sa = new Set(a || []);
  const sb = new Set(b || []);
  if (sa.size !== sb.size) return false;
  for (const v of sa) if (!sb.has(v)) return false;
  return true;
}

// Renderizza una griglia di chip (picker standalone o dentro il modale
// review). `selected` = array chiavi correnti, `onToggle(key)` = handler.
// Cap 3: al raggiungimento le chip non selezionate si disabilitano.
function renderEmotionChipGrid(gridEl, selected, onToggle, { disabled = false } = {}) {
  if (!gridEl) return;
  const sel = new Set(selected || []);
  const atCap = sel.size >= 3;

  gridEl.innerHTML = EMOTION_KEYS.map((key) => {
    const meta = EMOTION_META[key];
    const isSelected = sel.has(key);
    const isDisabled = disabled || (!isSelected && atCap);
    const cls = ["emotion-chip", isSelected ? "is-selected" : "", isDisabled ? "is-disabled" : ""]
      .filter(Boolean).join(" ");
    return `
      <button type="button" class="${cls}" data-key="${escapeHtml(key)}" ${isDisabled ? "disabled" : ""} aria-pressed="${isSelected}">
        <span class="emotion-chip-emoji" aria-hidden="true">${meta.emoji}</span>
        <span class="emotion-chip-label">${escapeHtml(meta.label)}</span>
      </button>`;
  }).join("");

  gridEl.querySelectorAll(".emotion-chip").forEach((btn) => {
    btn.addEventListener("click", () => onToggle(btn.dataset.key));
  });
}

/* ============================================
   PERSONAGGI PREFERITI ("Chi ti ha conquistato?")
   docs/CHARACTER_VOTES_SPEC.md §7 — vincolo di ingombro: riga orizzontale di
   volti compatta (mai una griglia/schermata a sé), nessuno step dedicato nel
   flusso, reazione opzionale inline al secondo tap su un volto già scelto.
   ============================================ */

// Renderizza la riga volti compatta + (se aperto) il pannello reazione
// inline sotto. Stessa idiom di renderEmotionChipGrid: innerHTML + rebind
// listener a ogni render. `picks` = [{personId,character,reaction}], max 3.
function renderCharacterPickRow(container, { candidates, picks, isLoading, reactionTarget, onTap, onReaction, onRemove }) {
  if (!container) return;

  if (isLoading) {
    container.innerHTML = `<div class="char-pick-loading" aria-label="${i18nT("Carico il cast")}"><span class="spinner" aria-hidden="true"></span></div>`;
    return;
  }

  if (!candidates.length) {
    container.innerHTML = `<div class="char-pick-empty">${i18nT("Cast non disponibile per questo titolo.")}</div>`;
    return;
  }

  const pickIndex = new Map(picks.map((p, i) => [p.personId, i]));
  const atCap = picks.length >= 3;

  const cells = candidates.map((c) => {
    const idx = pickIndex.has(c.personId) ? pickIndex.get(c.personId) : -1;
    const isSelected = idx >= 0;
    const isAtCap = !isSelected && atCap;
    const reactionKey = isSelected ? picks[idx].reaction : null;
    const reactionMeta = reactionKey ? EMOTION_META[reactionKey] : null;
    const initials = initialsFromName(c.name);
    const src = safeImgUrl(c.profilePath);
    const img = src
      ? `<img class="char-avatar-img" src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">`
      : "";
    const cls = ["char-pick-cell", isSelected ? "is-selected" : "", isAtCap ? "is-at-cap" : ""].filter(Boolean).join(" ");

    return `
      <button type="button" class="${cls}" data-person-id="${escapeHtml(c.personId)}" aria-pressed="${isSelected}">
        <span class="char-avatar">
          ${img}<span class="char-avatar-fallback">${escapeHtml(initials)}</span>
          ${isSelected ? `<span class="char-avatar-order">${idx + 1}</span>` : ""}
          ${c.isGuest ? `<span class="char-avatar-guest">${i18nT("Guest")}</span>` : ""}
          ${reactionMeta ? `<span class="char-avatar-reaction" title="${escapeHtml(reactionMeta.label)}">${reactionMeta.emoji}</span>` : ""}
        </span>
        <span class="char-pick-name">${escapeHtml(c.name)}</span>
        ${c.character ? `<span class="char-pick-role">${escapeHtml(c.character)}</span>` : ""}
      </button>`;
  }).join("");

  let reactionPanel = "";
  if (reactionTarget && pickIndex.has(reactionTarget)) {
    const idx = pickIndex.get(reactionTarget);
    const name = candidates.find((c) => c.personId === reactionTarget)?.name || i18nT("questo personaggio");
    const currentReaction = picks[idx].reaction || null;
    const chips = EMOTION_KEYS.map((key) => {
      const meta = EMOTION_META[key];
      const isSel = currentReaction === key;
      return `
        <button type="button" class="char-reaction-chip${isSel ? " is-selected" : ""}" data-reaction="${key}" aria-pressed="${isSel}">
          <span aria-hidden="true">${meta.emoji}</span> ${escapeHtml(meta.label)}
        </button>`;
    }).join("");
    reactionPanel = `
      <div class="char-reaction-panel">
        <div class="char-reaction-head">
          <span class="char-reaction-title">Reazione per ${escapeHtml(name)}</span>
          <button type="button" class="char-reaction-remove" data-remove="${escapeHtml(reactionTarget)}">${i18nT("Rimuovi")}</button>
        </div>
        <div class="char-reaction-chips">${chips}</div>
      </div>`;
  }

  container.innerHTML = `<div class="char-pick-scroll"><div class="char-pick-row">${cells}</div></div>${reactionPanel}`;

  container.querySelectorAll(".char-pick-cell").forEach((btn) => {
    btn.addEventListener("click", () => onTap(btn.dataset.personId));
  });
  container.querySelectorAll(".char-reaction-chip").forEach((btn) => {
    btn.addEventListener("click", () => onReaction(reactionTarget, btn.dataset.reaction));
  });
  const removeBtn = container.querySelector(".char-reaction-remove");
  if (removeBtn) removeBtn.addEventListener("click", () => onRemove(removeBtn.dataset.remove));
}

// ── Contesto EPISODIO (dentro il foglio "episodio visto"): salva al tocco,
//    debounced come le emozioni — nessun bottone "Salva" dedicato. ──
function renderEpSeenCharacterRow() {
  renderCharacterPickRow(epSeenCharactersRow, {
    candidates: _epSeenCharacterCandidates,
    picks: _epSeenCharacterPicks,
    isLoading: _epSeenCharactersLoading,
    reactionTarget: _epSeenCharacterReactionTarget,
    onTap: handleEpSeenCharacterTap,
    onReaction: handleEpSeenCharacterReaction,
    onRemove: handleEpSeenCharacterRemove,
  });
}

function handleEpSeenCharacterTap(personId) {
  const idx = _epSeenCharacterPicks.findIndex((p) => p.personId === personId);
  if (idx >= 0) {
    // Secondo tap su un volto già scelto: apri/chiudi il pannello reazione.
    _epSeenCharacterReactionTarget = _epSeenCharacterReactionTarget === personId ? null : personId;
    renderEpSeenCharacterRow();
    return;
  }
  if (_epSeenCharacterPicks.length >= 3) {
    toast(i18nT("Puoi scegliere al massimo 3 personaggi."), i18nT("Chi ti ha conquistato?"));
    return;
  }
  const candidate = _epSeenCharacterCandidates.find((c) => c.personId === personId);
  _epSeenCharacterPicks = [..._epSeenCharacterPicks, { personId, character: candidate?.character || null, reaction: null }];
  renderEpSeenCharacterRow();
  saveEpSeenCharacterPicksDebounced();
}

function handleEpSeenCharacterReaction(personId, key) {
  const idx = _epSeenCharacterPicks.findIndex((p) => p.personId === personId);
  if (idx < 0) return;
  const nextReaction = _epSeenCharacterPicks[idx].reaction === key ? null : key;
  _epSeenCharacterPicks = _epSeenCharacterPicks.map((p, i) => (i === idx ? { ...p, reaction: nextReaction } : p));
  _epSeenCharacterReactionTarget = null;
  renderEpSeenCharacterRow();
  saveEpSeenCharacterPicksDebounced();
}

function handleEpSeenCharacterRemove(personId) {
  _epSeenCharacterPicks = _epSeenCharacterPicks.filter((p) => p.personId !== personId);
  _epSeenCharacterReactionTarget = null;
  renderEpSeenCharacterRow();
  saveEpSeenCharacterPicksDebounced();
}

let _epSeenCharacterSaveTimer = null;
let _epSeenCharacterPendingSave = null;
let _epSeenCharacterSaveChain = Promise.resolve();
let _epSeenCharacterSaveVersion = 0;

function setEpSeenSaveStatus(element, state, text) {
  if (!element) return;
  element.className = `ep-seen-save-status${state ? ` is-${state}` : ""}`;
  element.textContent = text || "";
}

function sameEpisodeSeenContext(a, b) {
  return Boolean(a && b)
    && Number(a.season) === Number(b.season)
    && Number(a.episode) === Number(b.episode);
}

function persistEpSeenCharacterPicks(payload) {
  if (!payload) return _epSeenCharacterSaveChain;
  const { ctx, picks, version, uid, titleId } = payload;
  _epSeenCharacterSaveChain = _epSeenCharacterSaveChain.then(async () => {
    try {
      const result = await upsertCharacterPicks({
        uid,
        titleId,
        level: "episode",
        season: ctx.season,
        episode: ctx.episode,
        picks,
        source: "post_seen",
      });
      if (result?.skipped) throw new Error(i18nT("titleId non compatibile con il salvataggio"));
      void logEvent("episode_characters_saved", {
        platform: "web",
        source: "post_episode_sheet",
        season: ctx.season,
        episode: ctx.episode,
      });
      if (version === _epSeenCharacterSaveVersion && sameEpisodeSeenContext(_epSeenCtx, ctx)) {
        setEpSeenSaveStatus(epSeenCharactersStatus, "saved", i18nT("Salvato"));
      }
    } catch (err) {
      console.error("[characterVotes] upsertCharacterPicks (episode) error:", err);
      void logEvent("episode_characters_failed", {
        platform: "web",
        source: "post_episode_sheet",
        season: ctx.season,
        episode: ctx.episode,
      });
      if (version === _epSeenCharacterSaveVersion && sameEpisodeSeenContext(_epSeenCtx, ctx)) {
        setEpSeenSaveStatus(epSeenCharactersStatus, "error", i18nT("Salvataggio non riuscito"));
      }
      toast(i18nT("Errore nel salvataggio dei personaggi preferiti. Riprova."), i18nT("Errore"));
    }
  });
  return _epSeenCharacterSaveChain;
}

function saveEpSeenCharacterPicksDebounced() {
  // Snapshot di contesto+picks al momento della SCHEDULAZIONE (non alla
  // scadenza del timer): se l'utente chiude e riapre il foglio su un altro
  // episodio prima che il debounce scada, un save in volo non deve finire
  // scritto sotto l'episodio sbagliato.
  const ctx = _epSeenCtx;
  const picksSnapshot = _epSeenCharacterPicks.map((pick) => ({ ...pick }));
  if (!ctx || !currentUser || !currentTitle) return;
  _epSeenCharacterPendingSave = {
    ctx: { ...ctx },
    picks: picksSnapshot,
    version: ++_epSeenCharacterSaveVersion,
    uid: currentUser.uid,
    titleId: currentTitle.id,
  };
  setEpSeenSaveStatus(epSeenCharactersStatus, "saving", i18nT("Salvataggio…"));
  if (_epSeenCharacterSaveTimer) clearTimeout(_epSeenCharacterSaveTimer);
  _epSeenCharacterSaveTimer = setTimeout(() => {
    _epSeenCharacterSaveTimer = null;
    const pending = _epSeenCharacterPendingSave;
    _epSeenCharacterPendingSave = null;
    void persistEpSeenCharacterPicks(pending);
  }, 600);
}

function flushEpSeenCharacterPicks() {
  if (_epSeenCharacterSaveTimer) {
    clearTimeout(_epSeenCharacterSaveTimer);
    _epSeenCharacterSaveTimer = null;
  }
  const pending = _epSeenCharacterPendingSave;
  _epSeenCharacterPendingSave = null;
  return persistEpSeenCharacterPicks(pending);
}

// ── Contesto TITOLO (dentro il modale review, solo film): draft locale,
//    committato al submit della review — stesso pattern di _revEmotionsDraft. ──
function renderRevCharacterRow() {
  renderCharacterPickRow(revCharactersRow, {
    candidates: _revCharacterCandidates,
    picks: _revCharacterDraft,
    isLoading: false,
    reactionTarget: _revCharacterReactionTarget,
    onTap: handleRevCharacterTap,
    onReaction: handleRevCharacterReaction,
    onRemove: handleRevCharacterRemove,
  });
}

function handleRevCharacterTap(personId) {
  const idx = _revCharacterDraft.findIndex((p) => p.personId === personId);
  if (idx >= 0) {
    _revCharacterReactionTarget = _revCharacterReactionTarget === personId ? null : personId;
    renderRevCharacterRow();
    return;
  }
  if (_revCharacterDraft.length >= 3) {
    toast(i18nT("Puoi scegliere al massimo 3 personaggi."), i18nT("Chi ti ha conquistato?"));
    return;
  }
  const candidate = _revCharacterCandidates.find((c) => c.personId === personId);
  _revCharacterDraft = [..._revCharacterDraft, { personId, character: candidate?.character || null, reaction: null }];
  renderRevCharacterRow();
}

function handleRevCharacterReaction(personId, key) {
  const idx = _revCharacterDraft.findIndex((p) => p.personId === personId);
  if (idx < 0) return;
  const nextReaction = _revCharacterDraft[idx].reaction === key ? null : key;
  _revCharacterDraft = _revCharacterDraft.map((p, i) => (i === idx ? { ...p, reaction: nextReaction } : p));
  _revCharacterReactionTarget = null;
  renderRevCharacterRow();
}

function handleRevCharacterRemove(personId) {
  _revCharacterDraft = _revCharacterDraft.filter((p) => p.personId !== personId);
  _revCharacterReactionTarget = null;
  renderRevCharacterRow();
}

// ── Risultati community "Personaggi preferiti" (scheda titolo, tab Social) ──
// Anti-spoiler (spec §5, obbligatorio): l'aggregato somma TUTTI gli episodi
// di TUTTE le stagioni votati dalla community, quindi non basta aver visto UN
// episodio — resta coperto finché il titolo non è completato (film visto /
// serie finita), stesso segnale di isCompletedPersonalState già usato dal
// resto della pagina. Sotto quella soglia zero byte di risultati arrivano al
// client: nessuna fetch, non solo un blur.
function characterCandidateLookup() {
  const map = new Map();
  // La cache si riempie solo quando il titolo e' completato (percorso
  // dell'aggregato). Le classifiche per episodio hanno un cancello piu' basso
  // — basta aver visto quell'episodio — quindi qui si ricade sul cast del
  // titolo, gia' denormalizzato: senza questo i nomi mancavano e la riga non
  // veniva disegnata affatto.
  const source = _titleCharacterCandidateCache.length
    ? _titleCharacterCandidateCache
    : characterCandidatesFromTitle(currentTitle);
  for (const c of source) if (!map.has(c.personId)) map.set(c.personId, c);
  return map;
}

// Bucket personaggi per episodio ("{stagione}_{episodio}"): una read di
// collection sola per titolo, riusata sia per la riga del singolo episodio sia
// per la classifica di stagione. I trigger li scrivevano da sempre, non li
// leggeva nessuna UI.
let _episodeCharacterBuckets = new Map();
let _episodeCharacterBucketsTitleId = null;

async function ensureEpisodeCharacterBuckets(titleId) {
  if (!titleId || _episodeCharacterBucketsTitleId === titleId) return _episodeCharacterBuckets;
  _episodeCharacterBucketsTitleId = titleId;
  _episodeCharacterBuckets = await fetchEpisodeCharacterBuckets(titleId);
  return _episodeCharacterBuckets;
}

/** Nome da mostrare per un personaggio: personaggio se c'e', altrimenti attore. */
function characterLabel(personId, lookup) {
  const c = lookup.get(String(personId));
  if (!c) return null;
  return c.character || c.name || null;
}

/** Riga "piu' votato" sotto un episodio gia' visto. Stringa vuota se non c'e' nulla. */
function episodeTopCharacterHtml(seasonNumber, ep, seenByMe, lookup) {
  if (!seenByMe) return "";
  const bucket = _episodeCharacterBuckets.get(`${Number(seasonNumber)}_${Number(ep)}`);
  if (!bucket) return "";
  const top = rankCharacterCounts(bucket.counts)[0];
  if (!top) return "";
  const label = characterLabel(top.personId, lookup);
  if (!label) return "";
  return `<div class="ep-row-topchar">${i18nT("Più votato:")} <strong>${escapeHtml(label)}</strong></div>`;
}

/**
 * Classifica personaggi della stagione, mostrata solo a stagione completata:
 * stesso cancello del titolo, sapere chi e' il piu' votato dice che compare a
 * lungo. Sono voti totali sommati dagli episodi, non utenti unici — l'etichetta
 * lo dice invece di far finta che sia la stessa metrica del titolo.
 */
function seasonCharacterBlockHtml(seasonNumber, seasonProgress, episodesCount) {
  if (!episodesCount || Number(seasonProgress?.watchedCount || 0) < episodesCount) return "";
  const ranked = seasonCharacterCounts(_episodeCharacterBuckets, seasonNumber).slice(0, 3);
  if (!ranked.length) return "";
  const lookup = characterCandidateLookup();
  const rows = ranked.map((entry, i) => {
    const label = characterLabel(entry.personId, lookup) || i18nT("Personaggio");
    const votes = entry.count === 1 ? i18nT("1 voto") : i18nT("{count} voti", { count: entry.count });
    return `<li><span class="season-char-rank">${i + 1}</span>
      <span class="season-char-name">${escapeHtml(label)}</span>
      <span class="season-char-count">${escapeHtml(votes)}</span></li>`;
  }).join("");
  return `
    <div class="season-char-block">
      <h4>${i18nT("Personaggi più votati della stagione")}</h4>
      <ol class="season-char-list">${rows}</ol>
      <p class="season-char-note">${i18nT("Somma dei voti dei singoli episodi.")}</p>
    </div>`;
}

function characterEntryMarkup(entry, totalUsers, showsPercent, lookup, rank) {
  const candidate = lookup.get(entry.personId) || { name: "Personaggio", character: null, profilePath: null };
  const fraction = totalUsers > 0 ? entry.count / totalUsers : 0;
  const percent = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  const initials = initialsFromName(candidate.name);
  const src = safeImgUrl(candidate.profilePath);
  const img = src
    ? `<img class="char-avatar-img" src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">`
    : "";
  return `
    <div class="char-result-row">
      ${rank != null ? `<span class="char-result-rank">${rank}</span>` : ""}
      <span class="char-avatar char-avatar-md">${img}<span class="char-avatar-fallback">${escapeHtml(initials)}</span></span>
      <div class="char-result-meta">
        <div class="char-result-top">
          <span class="char-result-name">${escapeHtml(candidate.name)}${candidate.character ? ` <span class="char-result-role">— ${escapeHtml(candidate.character)}</span>` : ""}</span>
          ${showsPercent ? `<span class="char-result-value">${percent}%</span>` : ""}
        </div>
        ${showsPercent ? `
          <div class="char-result-track" aria-hidden="true">
            <div class="char-result-fill" style="width:${Math.max(2, percent)}%"></div>
          </div>` : ""}
      </div>
    </div>`;
}

async function refreshCharacterResults() {
  if (!charactersCard) return;
  if (!currentUser || !currentTitle?.id) {
    charactersCard.style.display = "none";
    return;
  }

  if (!hasStartedPersonalState(currentTitleState)) {
    // Titolo mai iniziato: niente ingombro, la sezione non si mostra proprio.
    charactersCard.style.display = "none";
    return;
  }

  const isTv = String(currentTitle.type || "").toLowerCase() === "tv";

  if (!isCompletedPersonalState(currentTitleState)) {
    charactersCard.style.display = "block";
    if (charactersCardSub) charactersCardSub.textContent = "";
    if (charactersCardBody) {
      charactersCardBody.innerHTML = `
        <div class="char-locked-teaser">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
          </svg>
          <span>${isTv ? i18nT("Risultati visibili a fine serie, per non anticipare chi compare.") : i18nT("Risultati visibili dopo la visione.")}</span>
        </div>`;
    }
    return;
  }

  const titleId = currentTitle.id;
  if (_charactersFetchedForTitleId !== titleId) {
    _charactersFetchedForTitleId = titleId;
    const [aggregate, rollup] = await Promise.all([
      fetchTitleCharacterAggregate(titleId),
      fetchMyCharacterPicksRollup(currentUser.uid, titleId),
    ]);
    if (currentTitle?.id !== titleId) return; // cambio titolo durante il fetch
    _titleCharacterAggregate = aggregate;
    _myCharacterPicksRollup = rollup;
    _titleCharacterCandidateCache = characterCandidatesFromTitle(currentTitle);
  }

  renderCharacterResultsCard();
}

function renderCharacterResultsCard() {
  if (!charactersCard || !charactersCardBody) return;
  charactersCard.style.display = "block";

  const bucket = pickCommunityBucket(_titleCharacterAggregate);
  const totalUsers = Number(bucket?.totalUsers) || 0;

  if (!bucket || totalUsers <= 0) {
    if (charactersCardSub) charactersCardSub.textContent = "";
    charactersCardBody.innerHTML = `<p class="hint">${i18nT("Nessuno ha ancora votato. Apri le danze.")}</p>`;
    return;
  }

  const ranked = rankCharacterCounts(bucket.counts);
  const showsPercent = totalUsers >= 3;
  const lookup = characterCandidateLookup();

  if (charactersCardSub) {
    charactersCardSub.textContent = i18nT("{count} persone", { count: totalUsers });
  }

  const top3Html = ranked.slice(0, 3)
    .map((entry, i) => characterEntryMarkup(entry, totalUsers, showsPercent, lookup, i + 1))
    .join("");

  const myTop = _myCharacterPicksRollup?.top;
  const myTopName = myTop?.character || (myTop?.personId ? lookup.get(String(myTop.personId))?.name : null);
  const mineHtml = myTopName
    ? `<div class="char-result-mine">${i18nT("⭐ Il tuo preferito:")} <strong>${escapeHtml(myTopName)}</strong></div>`
    : "";

  const seeAllHtml = ranked.length > 3
    ? `<button type="button" id="charactersSeeAllBtn" class="btn ghost small char-result-seeall">${i18nT("Vedi tutti")}</button>`
    : "";

  const disclaimerHtml = showsPercent
    ? `<p class="char-result-disclaimer">${i18nT("Si possono scegliere fino a 3 personaggi: il totale delle percentuali può superare il 100%.")}</p>`
    : "";

  charactersCardBody.innerHTML = `
    <div class="char-result-list">${top3Html}</div>
    ${mineHtml}
    ${seeAllHtml}
    ${disclaimerHtml}
  `;

  const seeAllBtn = qs("#charactersSeeAllBtn", charactersCardBody);
  if (seeAllBtn) {
    seeAllBtn.addEventListener("click", () => openCharactersFullModal(ranked, totalUsers, showsPercent, lookup));
  }
}

function openCharactersFullModal(ranked, totalUsers, showsPercent, lookup) {
  if (!charactersFullModal || !charactersFullList) return;
  if (charactersFullSub) {
    charactersFullSub.style.display = showsPercent ? "block" : "none";
    charactersFullSub.textContent = showsPercent
      ? i18nT("Si possono scegliere fino a 3 personaggi: il totale delle percentuali può superare il 100%.")
      : "";
  }
  charactersFullList.innerHTML = ranked
    .map((entry, i) => characterEntryMarkup(entry, totalUsers, showsPercent, lookup, i + 1))
    .join("");
  openModal(charactersFullModal);
}

// Picker standalone nel tab Social: persiste subito (debounce) a ogni toggle,
// niente bottone "Salva" esplicito — coerente col voto stelle sopra, che
// salva anch'esso al tap senza conferma.
let _emotionsSaveTimer = null;
let _persistedMyEmotions = [];
function saveMyEmotionsDebounced() {
  if (_emotionsSaveTimer) clearTimeout(_emotionsSaveTimer);
  _emotionsSaveTimer = setTimeout(async () => {
    if (!currentUser || !currentTitle) return;
    try {
      await upsertTitleEmotions({
        uid: currentUser.uid,
        titleId: currentTitle.id,
        emotions: myEmotions,
        source: "title_page",
      });
      _persistedMyEmotions = [...myEmotions];
      renderEmotionsCommunity();
    } catch (err) {
      console.error("[emotions] upsertTitleEmotions error:", err);
      myEmotions = [..._persistedMyEmotions];
      renderEmotionChipGrid(emotionsPickerGrid, myEmotions, toggleMyEmotion);
      toast(i18nT("Errore nel salvataggio dell'impressione. Riprova."), i18nT("Errore"));
    }
  }, 600);
}

function toggleMyEmotion(key) {
  const idx = myEmotions.indexOf(key);
  if (idx >= 0) {
    myEmotions = myEmotions.filter((k) => k !== key);
  } else {
    if (myEmotions.length >= 3) return;
    myEmotions = [...myEmotions, key];
  }
  renderEmotionChipGrid(emotionsPickerGrid, myEmotions, toggleMyEmotion);
  saveMyEmotionsDebounced();
}

let _emotionsFetchedForTitleId = null;
async function refreshMyEmotions() {
  if (!emotionsPickerCard) return;
  if (!currentUser || !currentTitle?.id) {
    emotionsPickerCard.style.display = "none";
    return;
  }

  emotionsPickerCard.style.display = "block";
  // Fetch una sola volta per titolo: renderRatings() rigira dopo OGNI azione
  // della pagina (voto, review, mark seen...) e rifare la getDoc a ogni giro
  // (a) spreca read, (b) sovrascriverebbe una selezione locale con un save
  // debounced ancora in volo.
  if (_emotionsFetchedForTitleId === currentTitle.id) return;
  const titleId = currentTitle.id;
  const existing = await getMyTitleEmotions({ uid: currentUser.uid, titleId }).catch(() => null);
  if (currentTitle?.id !== titleId) return; // cambio titolo durante il fetch
  _emotionsFetchedForTitleId = titleId;
  myEmotions = Array.isArray(existing?.emotions) ? existing.emotions : [];
  _persistedMyEmotions = [...myEmotions];
  renderEmotionChipGrid(emotionsPickerGrid, myEmotions, toggleMyEmotion);
  // Ridisegna la card community: l'evidenza "is-mine" dipende da myEmotions
  // appena caricato (al primo render era vuoto).
  renderEmotionsCommunity();
}

// Voto derivato dai voti episodio (privato). Come le emozioni: fetch UNA volta
// per titolo (renderRatings rigira dopo ogni azione), solo per serie loggate.
let _derivedRatingFetchedForTitleId = null;
async function refreshMyDerivedRating() {
  if (!currentUser || !currentTitle?.id) { myDerivedRating = null; return; }
  if (String(currentTitle?.type || "").toLowerCase() !== "tv") { myDerivedRating = null; return; }
  if (_derivedRatingFetchedForTitleId === currentTitle.id) return;
  const titleId = currentTitle.id;
  const derived = await getDerivedRating(currentUser.uid, titleId).catch(() => null);
  if (currentTitle?.id !== titleId) return; // cambio titolo durante il fetch
  _derivedRatingFetchedForTitleId = titleId;
  myDerivedRating = derived;
  renderMyRatingsBreakdown(currentTitle);
}

function toggleRevEmotion(key) {
  const idx = _revEmotionsDraft.indexOf(key);
  if (idx >= 0) {
    _revEmotionsDraft = _revEmotionsDraft.filter((k) => k !== key);
  } else {
    if (_revEmotionsDraft.length >= 3) return;
    _revEmotionsDraft = [..._revEmotionsDraft, key];
  }
  renderEmotionChipGrid(revEmotionsGrid, _revEmotionsDraft, toggleRevEmotion);
}

// Card community "Che impressione ha fatto": top 5 per count + %, o solo
// emoji/label senza % se totalUsers < 3 (n troppo piccolo per una percentuale
// significativa). Nascosta se non c'e' aggregato o e' vuoto.
function renderEmotionsCommunity() {
  if (!emotionsCommunityCard || !emotionsCommunityList) return;

  const agg = currentTitle?.emotionAggregate;
  const counts = agg?.counts && typeof agg.counts === "object" ? agg.counts : {};
  const totalSelections = Number(agg?.totalSelections) || 0;
  const totalUsers = Number(agg?.totalUsers) || 0;

  const entries = Object.entries(counts)
    .filter(([key, count]) => EMOTION_META[key] && Number(count) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 5);

  if (!totalUsers || !entries.length) {
    emotionsCommunityCard.style.display = "none";
    return;
  }

  emotionsCommunityCard.style.display = "block";
  if (emotionsCommunitySub) {
    emotionsCommunitySub.textContent = i18nT("{count} persone", { count: totalUsers });
  }

  const showPercent = totalUsers >= 3 && totalSelections > 0;
  const mine = new Set(myEmotions);

  emotionsCommunityList.innerHTML = entries.map(([key, count]) => {
    const meta = EMOTION_META[key];
    const percent = showPercent ? Math.round((Number(count) / totalSelections) * 100) : null;
    const rowCls = mine.has(key) ? "emotion-bar-row is-mine" : "emotion-bar-row";
    return `
      <div class="${rowCls}">
        <div class="emotion-bar-top">
          <span class="emotion-bar-label"><span aria-hidden="true">${meta.emoji}</span> ${escapeHtml(meta.label)}</span>
          <span class="emotion-bar-value">${percent != null ? `${percent}%` : `${count}`}</span>
        </div>
        <div class="emotion-bar-track" aria-hidden="true">
          <div class="emotion-bar-fill" style="width:${percent != null ? percent : Math.min(100, Math.round((Number(count) / (entries[0][1] || 1)) * 100))}%"></div>
        </div>
      </div>`;
  }).join("");
}

/**
 * Mostra/nasconde il bottone "Rimuovi voto" accanto al voto title-level, nel
 * riquadro azioni della card social. Creato lazy una sola volta e riusato a
 * ogni render (renderRatings gira dopo ogni azione della pagina).
 */
let _removeTitleVoteBtn = null;
function renderRemoveTitleVoteButton(hasTitleRating) {
  const actionsBar = btnWriteReviewSocial?.parentElement;
  if (!actionsBar) return;

  if (!hasTitleRating) {
    if (_removeTitleVoteBtn) _removeTitleVoteBtn.style.display = "none";
    return;
  }

  if (!_removeTitleVoteBtn) {
    _removeTitleVoteBtn = document.createElement("button");
    _removeTitleVoteBtn.type = "button";
    _removeTitleVoteBtn.className = "btn ghost small full";
    _removeTitleVoteBtn.textContent = i18nT("Rimuovi voto");
    _removeTitleVoteBtn.addEventListener("click", () => { void handleRemoveRating("title"); });
    actionsBar.appendChild(_removeTitleVoteBtn);
  }
  _removeTitleVoteBtn.style.display = "";
}

function renderRatings(title) {
  const myTitle = findMyRating("title");

  if (ratingTitleBox){
    ratingTitleBox.innerHTML = ratingTrackHtml(myTitle?.rating ?? null, "ratingTrackTitle");
    wireRatingTrack(ratingTitleBox, (v) => submitRating({ level: "title", rating: v }), myTitle?.rating ?? null);
  }

  renderRemoveTitleVoteButton(Boolean(myTitle));

  updateHeroVoteLabel();

  // Mostra la recensione dell'utente sotto i bottoni (se ha scritto qualcosa)
  if (myReviewPreview && myReviewText) {
    const reviewContent = myTitle?.reviewText?.trim();
    if (reviewContent) {
      myReviewText.textContent = reviewContent;
      myReviewPreview.style.display = "block";
    } else {
      myReviewPreview.style.display = "none";
    }
  }

  renderMyRatingsBreakdown(title);

  void renderSocialSections();
  void refreshMyEmotions();
  void refreshMyDerivedRating();
  renderEmotionsCommunity();

  const seasons = materializeSeasons(title.meta || {});
  const seasonProgressMap = buildSeasonProgressMap(seasons, currentTitleState);
  const currentProgress = safePersonalProgress(currentTitleState);

  renderSeasonsEpisodesSection(seasons, seasonProgressMap, currentProgress);
}

/* ============================================
   EPISODI — selettore stagione + righe episodio (redesign 2026-07-14)
   Sostituisce la vecchia griglia di pallini per-stagione: una stagione per
   volta (selettore), una riga per episodio con nome + data messa in onda
   (TMDB via fetchSeasonEpisodes), affordance voto (rosa) / commenti (viola) /
   visto (verde) + menu ⋯. Lo stato "visto" resta CUMULATIVO
   (episodesWatchedCount): "Visto" su E{n} = watermark fino a n (riusa
   handleSeriesEpisodeSelect / handleEpisodeUnsee, stesso modello dei pallini).
   ============================================ */
let _selectedEpisodeSeason = null;
let _openEpRowMenu = null;

function formatEpisodeAirDate(airDate) {
  if (!airDate || typeof airDate !== "string") return "";
  const m = airDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("it-IT", { day: "numeric", month: "short", year: "numeric" }).format(d);
  } catch (_) {
    return "";
  }
}

// Posizione S/E dell'ultimo episodio visto secondo la distribuzione lineare
// client (buildSeasonProgressMap) — coerente con quello che le righe mostrano
// come "visto". Più robusta di currentTitleState.lastWatched* (che il server
// deriva assumendo stagioni uniformi: sbaglia su stagioni non uniformi).
function deriveWatchedPosition(seasons, state) {
  const map = buildSeasonProgressMap(seasons, state);
  let lastS = 0, lastE = 0;
  (Array.isArray(seasons) ? seasons : []).forEach((s) => {
    const sn = Number(s?.season || 0) || 0;
    const wc = map.get(sn)?.watchedCount || 0;
    if (wc > 0) { lastS = sn; lastE = wc; }
  });
  return { season: lastS, episode: lastE };
}

function tmdbIdForCurrentTitle() {
  return Number(currentTitle?.tmdbId || currentTitle?.meta?.tmdbId || 0) || 0;
}

// Nome/sinossi "migliore disponibile" per un episodio: prima la cache TMDB
// (peek, NO rete), poi il campo curato eventuale del catalogo, altrimenti
// vuoto. Nessun dato inventato.
function bestEpisodeMeta(seasonNumber, episodeNumber) {
  const tmdbId = tmdbIdForCurrentTitle();
  const cached = tmdbId ? peekSeasonEpisodes(tmdbId, seasonNumber) : null;
  let name = "", overview = "";
  if (Array.isArray(cached)) {
    const hit = cached.find((e) => Number(e?.episode_number) === Number(episodeNumber));
    if (hit) {
      if (typeof hit.name === "string") name = hit.name.trim();
      if (typeof hit.overview === "string") overview = hit.overview.trim();
    }
  }
  const meta = episodeMetaFromTitle(currentTitle, seasonNumber, episodeNumber);
  return { name: name || meta.name || "", overview: overview || meta.overview || "" };
}

function renderSeasonsEpisodesSection(seasons, seasonProgressMap, currentProgress) {
  if (!seasonsBox) return;
  closeEpRowMenu();
  seasonsBox.innerHTML = "";
  if (noSeasonsHint) noSeasonsHint.style.display = seasons.length ? "none" : "block";
  if (!seasons.length) return;

  const seasonNums = seasons.map((s) => Number(s.season)).filter((n) => Number.isFinite(n));
  let selected = Number(_selectedEpisodeSeason);
  if (!seasonNums.includes(selected)) {
    const lastWatchedSeason = Number(currentProgress?.lastWatchedSeasonNumber) || 0;
    selected = seasonNums.includes(lastWatchedSeason) ? lastWatchedSeason : seasonNums[0];
  }
  _selectedEpisodeSeason = selected;

  const selectedMeta = seasons.find((s) => Number(s.season) === selected) || seasons[0];
  const episodesCount = Number(selectedMeta?.episodes || 0) || 0;
  const seasonProgress = seasonProgressMap.get(selected) || { watchedCount: 0, totalEpisodes: episodesCount, completed: false };
  const mySeason = findMyRating("season", selected, null);
  const avgSeason = computeAvg("season", selected, null);

  const optionsHtml = seasons.map((s) => {
    const sn = Number(s.season);
    return `<option value="${sn}"${sn === selected ? " selected" : ""}>${i18nT("Stagione {season}", { season: sn })}</option>`;
  }).join("");

  const watchedText = episodesCount > 0
    ? `${seasonProgress.watchedCount}/${episodesCount} viste`
    : `${seasonProgress.watchedCount} viste`;
  const percent = episodesCount > 0
    ? Math.max(0, Math.min(100, Math.round((seasonProgress.watchedCount / episodesCount) * 100)))
    : 0;

  const wrap = document.createElement("div");
  wrap.className = "ep-season";
  wrap.innerHTML = `
    <div class="ep-season-head">
      <label class="ep-season-select-field">
        <select class="ep-season-select" id="epSeasonSelect" aria-label=i18nT("Scegli stagione")>${optionsHtml}</select>
        <svg class="ep-season-select-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      </label>
      <div class="ep-season-sub">
        <span class="ep-season-count">${episodesCount > 0 ? i18nT("{count} episodi", { count: episodesCount }) : i18nT("Episodi")}</span>
        ${episodesCount > 0 ? `<span class="ep-season-dot" aria-hidden="true">·</span><span class="ep-season-watched">${escapeHtml(watchedText)}</span>` : ""}
      </div>
    </div>

    <div class="ep-season-progress" aria-hidden="true">
      <div class="ep-season-progress-fill" style="width:${percent}%"></div>
    </div>

    <div class="ep-season-actions">
      <button class="btn ghost small ep-season-complete" type="button">${i18nT("Segna stagione completa")}</button>
      <button class="btn ghost small ep-season-vote-toggle" type="button">${mySeason?.rating ? i18nT("Voto stagione {rating}", { rating: formatMaskedRating(mySeason.rating) }) : i18nT("Vota stagione")}</button>
      ${avgSeason != null ? `<span class="ep-season-avg muted">Media ${escapeHtml(String(avgSeason))}</span>` : ""}
    </div>
    <div class="ep-season-rate" hidden>${ratingTrackHtml(mySeason?.rating ?? null, `ratingTrackSeason${selected}`)}</div>

    <div class="ep-rows" id="epRows" aria-live="polite"></div>
  `;

  seasonsBox.appendChild(wrap);

  const select = wrap.querySelector("#epSeasonSelect");
  if (select) {
    select.addEventListener("change", () => {
      const next = Number(select.value);
      if (!Number.isFinite(next)) return;
      _selectedEpisodeSeason = next;
      renderSeasonsEpisodesSection(seasons, seasonProgressMap, currentProgress);
    });
  }

  const completeBtn = wrap.querySelector(".ep-season-complete");
  if (completeBtn) {
    if (episodesCount <= 0) completeBtn.disabled = true;
    completeBtn.addEventListener("click", async () => {
      await runWithButtonLoading(completeBtn, async () => {
        const target = Math.max(1, episodesCount);
        await handleSeriesEpisodeSelect(seasons, selected, target, {
          source: "season_alignment",
          entryAllowsPostEpisode: false,
        });
      }, { loadingLabel: i18nT("Salvataggio...") });
    });
  }

  const seasonRateBox = wrap.querySelector(".ep-season-rate");
  const seasonVoteToggle = wrap.querySelector(".ep-season-vote-toggle");
  if (seasonRateBox) {
    wireRatingTrack(seasonRateBox, (v) => submitRating({ level: "season", season: selected, rating: v }), mySeason?.rating ?? null);
  }
  if (seasonVoteToggle && seasonRateBox) {
    seasonVoteToggle.addEventListener("click", () => {
      const willShow = seasonRateBox.hidden;
      seasonRateBox.hidden = !willShow;
      seasonVoteToggle.textContent = willShow
        ? i18nT("Chiudi voto stagione")
        : (mySeason?.rating ? i18nT("Voto stagione {rating}", { rating: formatMaskedRating(mySeason.rating) }) : i18nT("Vota stagione"));
    });
  }

  const rowsBox = wrap.querySelector("#epRows");
  void renderEpisodeRows(seasons, selected, rowsBox, seasonProgress, currentProgress);
}

async function renderEpisodeRows(seasons, seasonNumber, container, seasonProgress, currentProgress) {
  if (!container) return;
  const seasonMeta = seasons.find((s) => Number(s.season) === Number(seasonNumber));
  const episodesCount = Number(seasonMeta?.episodes || 0) || 0;

  if (episodesCount <= 0) {
    container.innerHTML = `<div class="ep-rows-empty muted">${i18nT("Elenco episodi non ancora disponibile per questa stagione.")}</div>`;
    return;
  }

  const tmdbId = tmdbIdForCurrentTitle();

  // Render sincrono se gli episodi sono già in cache (no flicker al re-render
  // dopo un mark/voto); altrimenti spinner discreto + fetch lazy.
  let episodes = tmdbId ? peekSeasonEpisodes(tmdbId, seasonNumber) : null;
  if (!Array.isArray(episodes)) {
    container.innerHTML = `<div class="ep-rows-loading"><span class="ep-spinner" aria-hidden="true"></span><span class="muted">${i18nT("Carico gli episodi…")}</span></div>`;
    episodes = tmdbId ? await fetchSeasonEpisodes(tmdbId, seasonNumber) : [];
    // Stagione cambiata (o sezione ricostruita) mentre fetchava: abbandona.
    if (Number(_selectedEpisodeSeason) !== Number(seasonNumber) || !container.isConnected) return;
  }

  const byNumber = new Map();
  (Array.isArray(episodes) ? episodes : []).forEach((e) => {
    const n = Number(e?.episode_number) || 0;
    if (n > 0) byNumber.set(n, e);
  });

  // I personaggi piu' votati arrivano da una read sola: se fallisce, le righe
  // si disegnano lo stesso senza quella parte.
  await ensureEpisodeCharacterBuckets(currentTitle?.id).catch(() => {});
  if (Number(_selectedEpisodeSeason) !== Number(seasonNumber) || !container.isConnected) return;
  const charLookup = characterCandidateLookup();

  const rowsHtml = [];
  for (let ep = 1; ep <= episodesCount; ep++) {
    const tmdbEp = byNumber.get(ep) || null;
    const name = (tmdbEp?.name && String(tmdbEp.name).trim())
      || bestEpisodeMeta(seasonNumber, ep).name
      || i18nT("Episodio {episode}", { episode: ep });
    const dateLabel = formatEpisodeAirDate(tmdbEp?.air_date);
    const seenByMe = ep <= seasonProgress.watchedCount;
    const isLastWatched = Number(currentProgress?.lastWatchedSeasonNumber) === Number(seasonNumber)
      && Number(currentProgress?.lastWatchedEpisodeNumber) === ep;
    const myEp = findMyRating("episode", Number(seasonNumber), ep);
    const avgEp = computeAvg("episode", Number(seasonNumber), ep);
    const unaired = isFutureAirDate(tmdbEp?.air_date)
      || isFutureAirDate((seasons || []).find((s) => Number(s?.season) === Number(seasonNumber))?.air_date);
    rowsHtml.push(episodeRowHtml({
      seasonNumber, ep, name, dateLabel, seenByMe, isLastWatched, myEp, avgEp, unaired,
      topCharacterHtml: episodeTopCharacterHtml(seasonNumber, ep, seenByMe, charLookup),
    }));
  }
  container.innerHTML = seasonCharacterBlockHtml(seasonNumber, seasonProgress, episodesCount)
    + rowsHtml.join("");

  container.querySelectorAll(".ep-row").forEach((row) => {
    const ep = Number(row.dataset.episode);
    const sNum = Number(row.dataset.season);
    const seenByMe = row.dataset.seen === "1";

    const rateBtn = row.querySelector(".ep-row-rate");
    if (rateBtn) rateBtn.addEventListener("click", () => openEpisodeActionSheet(seasons, sNum, ep, false, true));

    const commentBtn = row.querySelector(".ep-row-comment");
    if (commentBtn) {
      commentBtn.addEventListener("click", () => {
        void openEpisodeDiscussionSheet(sNum, ep, { source: "episode_row" });
      });
    }

    const seenBtn = row.querySelector(".ep-row-seen");
    if (seenBtn) {
      seenBtn.addEventListener("click", async () => {
        await runWithButtonLoading(seenBtn, async () => {
          if (seenByMe) await handleEpisodeUnsee(seasons, sNum, ep);
          else await handleSeriesEpisodeSelect(seasons, sNum, ep, { source: "episode_row" });
        });
      });
    }

    const moreBtn = row.querySelector(".ep-row-more");
    if (moreBtn) {
      moreBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        openEpRowMenu(moreBtn, seasons, sNum, ep, row);
      });
    }
  });

  // Dot commenti (presenza reale, non conteggio): fetch lazy per la stagione.
  const episodeRefs = Array.from({ length: episodesCount }, (_, i) => ({ s: Number(seasonNumber), e: i + 1 }));
  listEpisodeThreadDocs(currentTitle?.id, episodeRefs).then((activeSet) => {
    if (!container.isConnected) return;
    container.querySelectorAll(".ep-row").forEach((row) => {
      const key = `s${row.dataset.season}e${row.dataset.episode}`;
      const dot = row.querySelector(".ep-row-comment-dot");
      if (dot) dot.hidden = !activeSet.has(key);
    });
  }).catch(() => {});
}

// Episodio non ancora in onda: non marcabile come visto (il giorno stesso
// conta come uscito; data assente → mai bloccare). Caso Reacher S4 annunciata
// su TMDB prima della messa in onda.
function isFutureAirDate(raw) {
  if (!raw) return false;
  const ms = Date.parse(`${raw}T00:00:00Z`);
  return Number.isFinite(ms) && ms > Date.now();
}

function episodeRowHtml({ seasonNumber, ep, name, dateLabel, seenByMe, isLastWatched, myEp, avgEp, unaired, topCharacterHtml = "" }) {
  const myRated = myEp?.rating != null;
  const avgLabel = avgEp != null ? escapeHtml(String(avgEp)) : "";
  const rateAria = myRated ? i18nT("Il tuo voto {v0}", { v0: formatMaskedRating(myEp.rating) }) : i18nT("Vota episodio");
  // ⋯ solo quando c'è qualcosa da annullare (visto e/o voto): niente menu vuoto.
  const showMore = seenByMe || myRated;
  return `
    <div class="ep-row${seenByMe ? " is-seen" : ""}${isLastWatched ? " is-current" : ""}" data-season="${escapeHtml(String(seasonNumber))}" data-episode="${escapeHtml(String(ep))}" data-seen="${seenByMe ? "1" : "0"}">
      <span class="ep-row-num">${escapeHtml(String(ep))}</span>
      <div class="ep-row-main">
        <div class="ep-row-name">${escapeHtml(name)}</div>
        ${dateLabel ? `<div class="ep-row-date">${escapeHtml(dateLabel)}</div>` : ""}
        ${topCharacterHtml}
      </div>
      <div class="ep-row-actions">
        <button class="ep-row-btn ep-row-rate${myRated ? " is-mine" : ""}" type="button" aria-label="${escapeHtml(rateAria)}">
          <svg viewBox="0 0 24 24" fill="${myRated ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
          ${avgLabel ? `<span class="ep-row-rate-num">${avgLabel}</span>` : ""}
        </button>
        <button class="ep-row-btn ep-row-comment" type="button" aria-label=i18nT("Commenti episodio")>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a4 4 0 0 1-4 4H7l-4 4V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>
          <span class="ep-row-comment-dot" hidden aria-hidden="true"></span>
        </button>
        <button class="ep-row-seen${!seenByMe && unaired ? " is-unaired" : ""}" type="button" ${!seenByMe && unaired ? "disabled" : ""} aria-label="${seenByMe ? i18nT("Visto, tocca per togliere") : (unaired ? i18nT("Inedito") : "Segna visto fino a qui")}">
          ${seenByMe
            ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg><span>${i18nT("Visto")}</span>`
            : (unaired
              ? `<span>${i18nT("Inedito")}</span>`
              : `<span class="ep-row-seen-ring" aria-hidden="true"></span><span>${i18nT("Da vedere")}</span>`)}
        </button>
        ${showMore ? `<button class="ep-row-btn ep-row-more" type="button" aria-label="${i18nT("Altre azioni")}" aria-haspopup="true">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg>
        </button>` : ""}
      </div>
    </div>
  `;
}

function closeEpRowMenu() {
  if (_openEpRowMenu) {
    try { _openEpRowMenu.remove(); } catch (_) { /* no-op */ }
    _openEpRowMenu = null;
  }
  document.removeEventListener("click", closeEpRowMenu);
}

function openEpRowMenu(anchorBtn, seasons, seasonNumber, episodeNumber, row) {
  const alreadyOpen = _openEpRowMenu && _openEpRowMenu._ownerRow === row;
  closeEpRowMenu();
  if (alreadyOpen) return; // toggle: secondo tap sullo stesso ⋯ chiude

  const seenByMe = row?.dataset?.seen === "1";
  const myEp = findMyRating("episode", Number(seasonNumber), Number(episodeNumber));
  const items = [];
  if (seenByMe) items.push({ label: i18nT("Annulla visto"), danger: false, run: () => handleEpisodeUnsee(seasons, seasonNumber, episodeNumber) });
  if (myEp) items.push({ label: i18nT("Annulla voto"), danger: true, run: () => handleEpisodeVoteDelete(seasonNumber, episodeNumber) });
  if (!items.length) return;

  const menu = document.createElement("div");
  menu.className = "ep-row-menu";
  menu._ownerRow = row;
  menu.innerHTML = items
    .map((it, i) => `<button type="button" class="ep-row-menu-item${it.danger ? " is-danger" : ""}" data-i="${i}">${escapeHtml(it.label)}</button>`)
    .join("");
  (row || anchorBtn.parentElement).appendChild(menu);
  menu.querySelectorAll(".ep-row-menu-item").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const idx = Number(btn.dataset.i);
      closeEpRowMenu();
      if (!requireAuthOrRedirect()) return;
      void items[idx].run();
    });
  });
  _openEpRowMenu = menu;
  // Chiudi al primo click fuori (deferito per non catturare il click corrente).
  setTimeout(() => document.addEventListener("click", closeEpRowMenu), 0);
}

async function handleEpisodeVoteDelete(seasonNumber, episodeNumber) {
  if (!currentUser || !currentTitle?.id) return;
  try {
    const preserved = captureSeasonRenderState();
    await deleteRating({
      titleId: currentTitle.id,
      level: "episode",
      season: Number(seasonNumber),
      episode: Number(episodeNumber),
    });
    ratings = await listRatingsForTitle(currentTitle.id);
    renderRatings(currentTitle);
    restoreSeasonRenderState(preserved);
    toast(i18nT("Voto episodio rimosso."), i18nT("Fatto"));
  } catch (err) {
    console.error("[rating] episode delete error:", err);
    toast(err?.message || i18nT("Errore nella rimozione del voto."), i18nT("Errore"));
  }
}

/**
 * Foglio "episodio visto": voto, emozioni e personaggi sono riferiti
 * all'episodio appena visto. Il composer del titolo, se necessario, viene
 * accodato alla chiusura per evitare modali sovrapposti.
 */
let _epSeenCtx = null;
let _epSeenEmotionSaveTimer = null;
let _epSeenEmotionPendingSave = null;
let _epSeenEmotionSaveChain = Promise.resolve();
let _epSeenEmotionSaveVersion = 0;
let _epSeenClosingPromise = null;
let _pendingTitleReviewAfterEpisode = false;
let _pendingTitleReviewAfterDiscussion = false;

function toggleEpSeenEmotion(key) {
  if (_epSeenEmotionsLoading) return;
  const idx = _epSeenEmotions.indexOf(key);
  if (idx >= 0) {
    _epSeenEmotions = _epSeenEmotions.filter((k) => k !== key);
  } else {
    if (_epSeenEmotions.length >= 3) return;
    _epSeenEmotions = [..._epSeenEmotions, key];
  }
  renderEmotionChipGrid(epSeenEmotionsGrid, _epSeenEmotions, toggleEpSeenEmotion);
  saveEpSeenEmotionsDebounced();
}

function persistEpSeenEmotions(payload) {
  if (!payload) return _epSeenEmotionSaveChain;
  const { ctx, emotions, version, uid, titleId } = payload;
  _epSeenEmotionSaveChain = _epSeenEmotionSaveChain.then(async () => {
    try {
      await upsertEpisodeEmotions({
        uid,
        titleId,
        season: ctx.season,
        episode: ctx.episode,
        emotions,
        source: "post_seen",
      });
      void logEvent("episode_emotions_saved", {
        platform: "web",
        source: "post_episode_sheet",
        season: ctx.season,
        episode: ctx.episode,
      });
      if (version === _epSeenEmotionSaveVersion && sameEpisodeSeenContext(_epSeenCtx, ctx)) {
        setEpSeenSaveStatus(epSeenEmotionsStatus, "saved", i18nT("Salvato"));
      }
    } catch (err) {
      console.error("[episodeEmotions] upsertEpisodeEmotions error:", err);
      void logEvent("episode_emotions_failed", {
        platform: "web",
        source: "post_episode_sheet",
        season: ctx.season,
        episode: ctx.episode,
      });
      if (version === _epSeenEmotionSaveVersion && sameEpisodeSeenContext(_epSeenCtx, ctx)) {
        setEpSeenSaveStatus(epSeenEmotionsStatus, "error", i18nT("Salvataggio non riuscito"));
      }
      toast(i18nT("Errore nel salvataggio delle emozioni. Riprova."), i18nT("Errore"));
    }
  });
  return _epSeenEmotionSaveChain;
}

function saveEpSeenEmotionsDebounced() {
  if (!_epSeenCtx || !currentUser || !currentTitle) return;
  _epSeenEmotionPendingSave = {
    ctx: { ..._epSeenCtx },
    emotions: [..._epSeenEmotions],
    version: ++_epSeenEmotionSaveVersion,
    uid: currentUser.uid,
    titleId: currentTitle.id,
  };
  setEpSeenSaveStatus(epSeenEmotionsStatus, "saving", i18nT("Salvataggio…"));
  if (_epSeenEmotionSaveTimer) clearTimeout(_epSeenEmotionSaveTimer);
  _epSeenEmotionSaveTimer = setTimeout(() => {
    _epSeenEmotionSaveTimer = null;
    const pending = _epSeenEmotionPendingSave;
    _epSeenEmotionPendingSave = null;
    void persistEpSeenEmotions(pending);
  }, 600);
}

function flushEpSeenEmotions() {
  if (_epSeenEmotionSaveTimer) {
    clearTimeout(_epSeenEmotionSaveTimer);
    _epSeenEmotionSaveTimer = null;
  }
  const pending = _epSeenEmotionPendingSave;
  _epSeenEmotionPendingSave = null;
  return persistEpSeenEmotions(pending);
}

async function flushEpisodeSeenSaves() {
  await Promise.all([
    flushEpSeenEmotions(),
    flushEpSeenCharacterPicks(),
  ]);
}

function openQueuedTitleReview() {
  if (!_pendingTitleReviewAfterEpisode && !_pendingTitleReviewAfterDiscussion) return;
  _pendingTitleReviewAfterEpisode = false;
  _pendingTitleReviewAfterDiscussion = false;
  maybeOpenReviewAfterSeen();
}

async function closeEpisodeSeenSheet({ openDiscussion = false } = {}) {
  if (_epSeenClosingPromise) return _epSeenClosingPromise;
  const ctx = _epSeenCtx ? { ..._epSeenCtx } : null;
  const shouldReviewTitle = _pendingTitleReviewAfterEpisode;
  _pendingTitleReviewAfterEpisode = false;

  _epSeenClosingPromise = (async () => {
    await flushEpisodeSeenSaves();
    closeModal(epSeenSheet);
    _epSeenCtx = null;

    if (openDiscussion && ctx) {
      _pendingTitleReviewAfterDiscussion ||= shouldReviewTitle;
      await openEpisodeDiscussionSheet(ctx.season, ctx.episode, { source: "post_episode_sheet" });
    } else if (shouldReviewTitle) {
      _pendingTitleReviewAfterEpisode = true;
      openQueuedTitleReview();
    }
  })().finally(() => {
    _epSeenClosingPromise = null;
  });
  return _epSeenClosingPromise;
}

async function openEpisodeSeenSheet(seasonNumber, episodeNumber, {
  source = "title_page",
  offerTitleReviewAfterClose = false,
} = {}) {
  if (!epSeenSheet || !currentUser || !currentTitle) return;
  const s = Number(seasonNumber), e = Number(episodeNumber);
  if (!s || !e) return;

  if (_epSeenCtx && !sameEpisodeSeenContext(_epSeenCtx, { season: s, episode: e })) {
    await flushEpisodeSeenSaves();
  }
  _epSeenCtx = { season: s, episode: e };
  _pendingTitleReviewAfterEpisode = Boolean(offerTitleReviewAfterClose);

  const name = bestEpisodeMeta(s, e).name;
  if (epSeenTitle) epSeenTitle.textContent = i18nT("Visto S{season} · E{episode}", { season: s, episode: e });
  if (epSeenSub) epSeenSub.textContent = name || "";

  // Voto episodio: salva al tocco (stesso pattern del vote-box episodio)
  const myEp = findMyRating("episode", s, e);
  if (epSeenVoteBox) {
    epSeenVoteBox.innerHTML = ratingTrackHtml(myEp?.rating ?? null, "ratingTrackSeenSheet");
    wireRatingTrack(epSeenVoteBox, (v) => {
      void submitRating({ level: "episode", season: s, episode: e, rating: v });
    }, myEp?.rating ?? null);
  }

  // Emozioni episodio: sempre proposte, indipendenti dalle emozioni generali
  // del titolo. Il picker resta inattivo finché non sono caricati i valori
  // preesistenti, così una risposta lenta non può sovrascrivere la scelta.
  if (epSeenEmotionsField) epSeenEmotionsField.hidden = false;
  _epSeenEmotions = [];
  _epSeenEmotionsLoading = true;
  if (epSeenEmotionsGrid) {
    epSeenEmotionsGrid.innerHTML = `<div class="char-pick-loading" aria-label="${i18nT("Carico le emozioni")}"><span class="spinner" aria-hidden="true"></span></div>`;
  }
  setEpSeenSaveStatus(epSeenEmotionsStatus, "", "");
  getMyEpisodeEmotions({
    uid: currentUser.uid,
    titleId: currentTitle.id,
    season: s,
    episode: e,
  }).then((saved) => {
    if (!sameEpisodeSeenContext(_epSeenCtx, { season: s, episode: e })) return;
    _epSeenEmotions = Array.isArray(saved?.emotions) ? saved.emotions : [];
    _epSeenEmotionsLoading = false;
    renderEmotionChipGrid(epSeenEmotionsGrid, _epSeenEmotions, toggleEpSeenEmotion);
  }).catch((err) => {
    console.error("[episodeEmotions] getMyEpisodeEmotions error:", err);
    if (!sameEpisodeSeenContext(_epSeenCtx, { season: s, episode: e })) return;
    renderEmotionChipGrid(
      epSeenEmotionsGrid,
      _epSeenEmotions,
      toggleEpSeenEmotion,
      { disabled: true },
    );
    setEpSeenSaveStatus(
      epSeenEmotionsStatus,
      "error",
      i18nT("Impossibile caricare la scelta salvata. Riapri per riprovare."),
    );
  });

  // Personaggi preferiti: candidati (cast dell'EPISODIO via TMDB, fallback
  // silenzioso sul cast del titolo) + pick già salvati per QUESTO episodio.
  // Emozioni e personaggi si propongono entrambi a ogni episodio.
  _epSeenCharacterCandidates = [];
  _epSeenCharacterPicks = [];
  _epSeenCharacterReactionTarget = null;
  _epSeenCharactersLoading = true;
  setEpSeenSaveStatus(epSeenCharactersStatus, "", "");
  renderEpSeenCharacterRow();
  Promise.all([
    fetchEpisodeCharacterCandidates(currentTitle, s, e),
    getMyCharacterPicks({
      uid: currentUser.uid,
      titleId: currentTitle.id,
      level: "episode",
      season: s,
      episode: e,
      throwOnError: true,
    }),
  ]).then(([candidates, picks]) => {
    if (_epSeenCtx?.season !== s || _epSeenCtx?.episode !== e) return; // cambio episodio durante il fetch
    _epSeenCharacterCandidates = candidates;
    _epSeenCharacterPicks = picks;
    _epSeenCharactersLoading = false;
    renderEpSeenCharacterRow();
  }).catch((err) => {
    console.error("[characterVotes] load episode picks error:", err);
    if (_epSeenCtx?.season !== s || _epSeenCtx?.episode !== e) return;
    _epSeenCharacterCandidates = [];
    _epSeenCharacterPicks = [];
    _epSeenCharactersLoading = false;
    renderEpSeenCharacterRow();
    setEpSeenSaveStatus(
      epSeenCharactersStatus,
      "error",
      i18nT("Impossibile caricare la scelta salvata. Riapri per riprovare."),
    );
  });

  // "Se ne sta già parlando": presenza reale del thread episodio (1 query)
  if (epSeenTalk) epSeenTalk.hidden = true;
  if (epSeenCommentBtn) epSeenCommentBtn.textContent = i18nT("Dì la tua");
  listEpisodeThreadDocs(currentTitle.id, [{ s, e }]).then((activeSet) => {
    if (_epSeenCtx?.season !== s || _epSeenCtx?.episode !== e) return;
    if (!activeSet?.has(`s${s}e${e}`)) return;
    if (epSeenTalk) epSeenTalk.hidden = false;
    if (epSeenCommentBtn) epSeenCommentBtn.textContent = "Partecipa";
  }).catch(() => {});

  openModal(epSeenSheet);
  void logEvent("post_episode_sheet_opened", {
    platform: "web",
    source,
    season: s,
    episode: e,
  });
}

if (epSeenCommentBtn) {
  epSeenCommentBtn.addEventListener("click", () => {
    void closeEpisodeSeenSheet({ openDiscussion: true });
  });
}

if (epSeenSheet) {
  epSeenSheet.querySelectorAll("[data-close]").forEach((node) => {
    node.addEventListener("click", () => {
      void closeEpisodeSeenSheet();
    });
  });
}

// Wrapper del "+1 episodio" (sezione generale) che, a mutazione riuscita,
// apre il foglio "episodio visto" sull'episodio appena raggiunto.
async function handleMarkEpisodeAndNudge() {
  const seasons = materializeSeasons(currentTitle?.meta || {});
  const before = safePersonalProgress(currentTitleState).episodesWatchedCount;
  await handlePersonalStateAction("mark_series_episode", { source: "title_page_series_episode" });
  const after = safePersonalProgress(currentTitleState).episodesWatchedCount;
  const flow = decidePostEpisodeFlow({
    beforeEpisodes: before,
    afterEpisodes: after,
    isCompleted: isCompletedPersonalState(currentTitleState),
    hasTitleRating: Number.isFinite(Number(findMyRating("title")?.rating)),
  });
  if (flow.openEpisodeSheet) {
    const pos = deriveWatchedPosition(seasons, currentTitleState);
    if (pos.season && pos.episode) {
      if (Number(_selectedEpisodeSeason) !== pos.season) {
        _selectedEpisodeSeason = pos.season;
        renderRatings(currentTitle);
      }
      await openEpisodeSeenSheet(pos.season, pos.episode, {
        source: "quick_add",
        offerTitleReviewAfterClose: flow.openTitleReviewAfterEpisode,
      });
    }
  }
}


/* ---------------------------
   THREAD UI (come prima)
--------------------------- */
function showThreadStatus(msg){
  if (!thrStatus) return;
  thrStatus.style.display = "block";
  thrStatus.textContent = msg;
}

function setThreadTab(which){
  const dm = which === "dm";
  if (thrTabDm) thrTabDm.classList.toggle("active", dm);
  if (thrTabGroup) thrTabGroup.classList.toggle("active", !dm);
  if (thrDmPanel) thrDmPanel.style.display = dm ? "block" : "none";
  if (thrGroupPanel) thrGroupPanel.style.display = dm ? "none" : "block";
  if (thrStatus) thrStatus.style.display = "none";
}

async function loadFriendsForThread(){
  const friends = await listFriends(currentUser.uid).catch(() => []);
  const users = await Promise.all(friends.map(f => getUserPublic(f.uid).catch(() => null)));
  const clean = users.filter(Boolean);

  if (thrTo){
    thrTo.innerHTML = clean.length
      ? clean.map(u => `<option value="${escapeHtml(u.uid)}">${escapeHtml(u.displayName || u.uid)}</option>`).join("")
      : `<option value="">${i18nT("Nessun amico")}</option>`;
  }

  if (thrGroupMembers){
    thrGroupMembers.innerHTML = clean.length
      ? clean.map(u => {
          const id = `thrchk_${u.uid}`;
          return `<label class="check-item"><input type="checkbox" value="${escapeHtml(u.uid)}" id="${escapeHtml(id)}" /><span class="label">${escapeHtml(u.displayName || u.uid)}</span></label>`;
        }).join("")
      : `<div class="hint">${i18nT("Non hai ancora amici.")}</div>`;
  }

  if (btnOpenDmThread) btnOpenDmThread.disabled = clean.length === 0;
  if (btnOpenGroupThread) btnOpenGroupThread.disabled = clean.length < 2;
}

async function openThreadModal(which){
  await loadFriendsForThread();
  setThreadTab(which);
  openModal(threadModal);
}

if (threadModal){
  thrTabDm?.addEventListener("click", () => setThreadTab("dm"));
  thrTabGroup?.addEventListener("click", () => setThreadTab("group"));
}

/* ---------------------------
   RECOMMENDATIONS (come prima)
--------------------------- */
function showRecStatus(msg){
  if (!recStatus) return;
  recStatus.style.display = "block";
  recStatus.textContent = msg;
}

function openRecModal(){
  if (!recStatus || !recMsg || !recModal) return;
  recStatus.style.display = "none";
  recMsg.value = "";
  recModal.style.display = "block";
}

function closeRecModal(){
  if (!recModal) return;
  recModal.style.display = "none";
}

recModal?.querySelectorAll("[data-close]").forEach(el => {
  el.addEventListener("click", () => closeRecModal());
});

btnOpenRecommend?.addEventListener("click", async () => {
  if (!requireAuthOrRedirect()) return;

  if (recTo) recTo.innerHTML = "";
  try {
    // Suggerimenti = grafo follow, come su iOS (il grafo amici è dismesso,
    // fase 1 2026-07-29: `listFriends` qui tornava vuoto/stantio e "pulart"
    // non si trovava). Riusa la cache dei seguiti della review.
    const users = await ensureReviewFollowingLoaded();
    if (!users.length){
      if (recHint){
        recHint.style.display = "block";
        recHint.textContent = i18nT("Segui qualcuno per suggerirgli titoli dalla scheda.");
      }
      toast(i18nT("Non segui ancora nessuno"), i18nT("Suggerisci"));
      return;
    }

    const opts = users
      .map(u => `<option value="${escapeHtml(u.uid)}">${escapeHtml(u.displayName || u.uid)}</option>`)
      .join("");

    if (recTo) recTo.innerHTML = opts;
    openRecModal();
  } catch (e){
    console.error(e);
    toast(e?.message || i18nT("Errore"), i18nT("Suggerisci"));
  }
});

recSend?.addEventListener("click", async () => {
  if (!currentUser) return;
  const toUid = recTo?.value;
  if (!toUid) return;
  recSend.disabled = true;
  try {
    showRecStatus("Invio in corso…");
    await createRecommendation({
      fromUid: currentUser.uid,
      toUid,
      titleId: currentTitle.id,
      message: recMsg?.value || "",
    });
    showRecStatus("Inviato ✅");
    toast(i18nT("Suggerimento inviato."), "Suggerisci");
    setTimeout(() => closeRecModal(), 400);
  } catch (e){
    console.error(e);
    showRecStatus(e?.message || i18nT("Errore invio"));
  } finally {
    recSend.disabled = false;
  }
});

/* ---------------------------
   EDIT (come prima)
--------------------------- */

// ===== People picker (edit modal) =====
function renderPersonChips(targetEl, items, onRemove){
  if (!targetEl) return;
  targetEl.innerHTML = (items || []).map(p => {
    const id = escapeHtml(p.id);
    const name = escapeHtml(p.name);
    const img = safeImgUrl(p.avatarUrl || p?.avatar?.url || "");
    const ini = escapeHtml(initialsFromName(p.name));
    const avatar = img
      ? `<img src="${escapeHtml(img)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : `<span class="person-initials">${ini}</span>`;
    return `<span class="person-chip" data-id="${id}"><span class="person-avatar">${avatar}</span><span class="person-label">${name}</span><button type="button" data-remove="${id}">×</button></span>`;
  }).join("");

  targetEl.querySelectorAll("button[data-remove]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-remove");
      onRemove?.(id);
    });
  });
}

function renderEditPeople(){
  renderPersonChips(eDirectorsSelected, editDirectors, (id) => {
    editDirectors = (editDirectors || []).filter(p => p.id !== id);
    renderEditPeople();
  });
  renderPersonChips(eCastSelected, editCast, (id) => {
    editCast = (editCast || []).filter(p => p.id !== id);
    renderEditPeople();
  });
}

function _uniq(arr){
  return [...new Set(arr.filter(Boolean))];
}

function _addPersonTo(listName, person){
  const arr = listName === "directors" ? (editDirectors || []) : (editCast || []);
  const exists = arr.some(p => (p.id && p.id === person.id) || p.name.toLowerCase() === person.name.toLowerCase());
  if (!exists) {
    arr.push(person);
  }
  if (listName === "directors") editDirectors = arr; else editCast = arr;
  renderEditPeople();
}

function _setupPersonPicker(listName, inputEl, resultsEl, role){
  if (!inputEl || !resultsEl) return;

  let lastQuery = "";
  let timer = null;

  async function run(){
    const q = (inputEl.value || "").trim();
    lastQuery = q;
    if (q.length < 2){
      resultsEl.style.display = "none";
      resultsEl.innerHTML = "";
      return;
    }

    const hits = await searchPeopleByPrefix(q, 8).catch(() => []);
    if (lastQuery !== q) return;

    const lower = q.toLowerCase();
    const exact = hits.some(h => String(h.nameLower || h.name || "").toLowerCase() === lower);

    const items = []

    for (const h of hits){
      items.push({ kind: "existing", id: h.id, name: h.name || h.id, avatarUrl: h.avatarUrl || h?.avatar?.url || "" });
    }

    if (!exact){
      items.push({ kind: "create", id: "__create__", name: q });
    }

    resultsEl.innerHTML = items.map(it => {
      if (it.kind === "create"){
        return `<button type="button" class="people-result" data-kind="create" data-name="${escapeHtml(it.name)}">${i18nT("Aggiungi “{name}”", { name: escapeHtml(it.name) })}</button>`;
      }
      const img = safeImgUrl(it.avatarUrl || "");
      const ini = escapeHtml(initialsFromName(it.name));
      const avatar = img
        ? `<img src="${escapeHtml(img)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
        : `<span class="person-initials">${ini}</span>`;
      return `<button type="button" class="people-result" data-kind="existing" data-id="${escapeHtml(it.id)}" data-name="${escapeHtml(it.name)}" data-avatar="${escapeHtml(img)}"><span class="person-avatar">${avatar}</span><span class="person-name">${escapeHtml(it.name)}</span></button>`;
    }).join("");

    resultsEl.style.display = "block";

    resultsEl.querySelectorAll(".people-result").forEach(btn => {
      btn.addEventListener("click", async () => {
        const kind = btn.getAttribute("data-kind");
        if (kind === "create"){
          const name = btn.getAttribute("data-name");
          try {
            const created = await createPerson({ name, role });
            _addPersonTo(listName, { id: created.id, name: created.name || name, avatarUrl: created.avatarUrl || null });
            inputEl.value = "";
            resultsEl.style.display = "none";
            resultsEl.innerHTML = "";
          } catch(e){
            console.error(e);
            toast(e?.message || i18nT("Errore creazione persona"), "People");
          }
          return;
        }

        const id = btn.getAttribute("data-id");
        const name = btn.getAttribute("data-name");
        const avatarUrl = btn.getAttribute("data-avatar") || null;
        _addPersonTo(listName, { id, name, avatarUrl });
        inputEl.value = "";
        resultsEl.style.display = "none";
        resultsEl.innerHTML = "";
      });
    });
  }

  inputEl.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(run, 120);
  });

  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!resultsEl.contains(t) && t !== inputEl){
      resultsEl.style.display = "none";
    }
  });
}

function initEditPeoplePickers(){
  _setupPersonPicker("directors", eDirectorSearch, eDirectorResults, "director");
  _setupPersonPicker("cast", eCastSearch, eCastResults, "actor");
}

initEditPeoplePickers();

// ===== Edit modal tabs =====
const editTabsContainer = document.querySelector('.edit-tabs');
if (editTabsContainer) {
  editTabsContainer.addEventListener('click', (e) => {
    const tab = e.target.closest('.edit-tab');
    if (!tab) return;
    const target = tab.getAttribute('data-tab');
    editTabsContainer.querySelectorAll('.edit-tab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.edit-tab-panel').forEach(p => p.classList.toggle('active', p.getAttribute('data-panel') === target));
  });
}

function fillEditFormFromTitle(t) {
  // Reset tabs to "Generale"
  document.querySelectorAll('.edit-tab').forEach(tab => tab.classList.toggle('active', tab.getAttribute('data-tab') === 'general'));
  document.querySelectorAll('.edit-tab-panel').forEach(p => p.classList.toggle('active', p.getAttribute('data-panel') === 'general'));

  eName.value = t.name || "";
  eType.value = t.type || "movie";
  eYear.value = t.year || "";

  const m = t.meta || {};
  eDurationMovie.value = m.durationMovie || "";
  eSeasonsCount.value = m.seasonsCount || "";
  eEpisodesPerSeason.value = m.episodesPerSeason || "";
  eDurationEpisode.value = m.durationEpisode || "";

  // Persone (facoltative)
  const dNames = Array.isArray(t.directors) ? t.directors : [];
  const dIds = Array.isArray(t.directorIds) ? t.directorIds : [];
  editDirectors = dNames.map((n,i) => ({ id: dIds[i] || `tmp_d_${i}_${slugify(n)}`, name: n })).filter(p => p.name);

  const cNames = Array.isArray(t.cast) ? t.cast : [];
  const cIds = Array.isArray(t.castIds) ? t.castIds : [];
  editCast = cNames.map((n,i) => ({ id: cIds[i] || `tmp_c_${i}_${slugify(n)}`, name: n })).filter(p => p.name);

  renderEditPeople();

  // Stagioni/episodi: materializziamo una struttura coerente
  const seasonsArr = materializeSeasons(m);
  const hasSeasons = seasonsArr.length > 0;
  const allSame = hasSeasons && seasonsArr.every(s => Number(s.episodes) === Number(seasonsArr[0].episodes));
  if (eTogglePerSeason) eTogglePerSeason.checked = hasSeasons && !allSame;
  editSeasonsMeta = seasonsArr.map(s => ({ season: Number(s.season), episodes: Number(s.episodes) }));

  if (eDescription) eDescription.value = t.description || "";
  eOriginalName.value = t.originalName || "";
  eAliases.value = (t.aliases || []).join(", ");
  eLanguage.value = m.language || "";
  eCountry.value = m.country || "";
  eNetwork.value = m.network || "";

  const selected = new Set(t.genres || []);
  eGenres.innerHTML = allGenres.map(g => `
    <label class="chip" title="${escapeHtml(g.id)}">
      <input type="checkbox" value="${escapeHtml(g.id)}" ${selected.has(g.id) ? "checked" : ""}/>
      <span>${escapeHtml(stripLeadingEmoji(g.name))}</span>
    </label>
  `).join("");

  refreshEditTypeUI();
  refreshEditSeasonsDetailUI();
}

function collectEditPayload() {
  const name = (eName.value || "").trim();
  const type = eType.value;
  const yearNum = toIntOrNull(eYear.value, 1880, 2100);

  const genres = [...eGenres.querySelectorAll('input[type="checkbox"]:checked')].map(i => i.value);

  if (!name) return { error: i18nT("Inserisci il titolo.") };
  if (!genres.length) return { error: i18nT("Seleziona almeno un genere.") };

  const durationMovie = toIntOrNull(eDurationMovie.value, 1, 600);
  const seasonsCount = toIntOrNull(eSeasonsCount.value, 1, 200);
  const episodesPerSeason = toIntOrNull(eEpisodesPerSeason.value, 1, 200);
  const durationEpisode = toIntOrNull(eDurationEpisode.value, 1, 300);

  const originalName = (eOriginalName.value || "").trim();
  const aliases = (eAliases.value || "").split(",").map(s => s.trim()).filter(Boolean);

  const language = (eLanguage.value || "").trim();
  const country = (eCountry.value || "").trim();
  const network = (eNetwork.value || "").trim();

  // TV validation + seasons materialization
  let seasons = [];
  if (type === "tv") {
    if (!seasonsCount) return { error: i18nT("Per le serie TV inserisci il numero di stagioni.") };

    const perSeason = !!eTogglePerSeason?.checked;
    if (perSeason) {
      if (!editSeasonsMeta || !editSeasonsMeta.length) return { error: i18nT("Inserisci gli episodi per stagione.") };
      seasons = editSeasonsMeta
        .slice(0, seasonsCount)
        .map(s => ({ season: Number(s.season), episodes: Number(s.episodes) }))
        .filter(s => s.season && s.episodes);
      if (seasons.length !== seasonsCount) return { error: i18nT("Controlla gli episodi per ogni stagione.") };
    } else {
      if (!episodesPerSeason) return { error: i18nT("Inserisci gli episodi per stagione (oppure attiva 'episodi diversi per stagione').") };
      seasons = Array.from({ length: seasonsCount }, (_, i) => ({ season: i + 1, episodes: episodesPerSeason }));
    }
  }

  const directorNames = editDirectors.map(p => p.name).filter(Boolean);
  const directorIds = [...new Set(editDirectors.map(p => p.id).filter(id => id && !String(id).startsWith("tmp_")))];
  const castNames = editCast.map(p => p.name).filter(Boolean);
  const castIds = [...new Set(editCast.map(p => p.id).filter(id => id && !String(id).startsWith("tmp_")))];

  const description = eDescription ? (eDescription.value || "").trim() : "";

  return {
    payload: {
      name,
      type,
      year: yearNum ?? null,
      genres,
      description: description || null,
      originalName: originalName || null,
      aliases,
      directors: directorNames,
      directorIds,
      cast: castNames,
      castIds,
      meta: {
        durationMovie: type === "movie" ? durationMovie : null,
        seasonsCount: type === "tv" ? seasonsCount : null,
        episodesPerSeason: type === "tv" && !eTogglePerSeason?.checked ? episodesPerSeason : null,
        durationEpisode: type === "tv" ? durationEpisode : null,
        seasons: type === "tv" ? seasons : null,
        language: language || null,
        country: country || null,
        network: network || null,
      }
    }
  };
}

function showEditStatus(msg) {
  if (!editStatus) return;
  editStatus.style.display = "block";
  editStatus.innerHTML = msg;
}

btnEdit?.addEventListener("click", () => {
  if (!currentTitle) return;
  fillEditFormFromTitle(currentTitle);
  showEditBox("edit");
});

btnSuggest?.addEventListener("click", () => {
  if (!currentTitle) return;
  fillEditFormFromTitle(currentTitle);
  showEditBox("suggest");
});

btnCancelEdit?.addEventListener("click", () => hideEditBox());

editForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentTitle || !currentUser) return;

  const { payload, error } = collectEditPayload();
  if (error) return toast(error, "Controlla");

  btnSaveEdit.disabled = true;
  try {
    let posterChanges = {};
    if (posterDraft.file) {
      showEditStatus(i18nT("Carico la locandina..."));
      const up = await uploadPoster({
        file: posterDraft.file,
        titleIdOrTemp: currentTitle.id,
        uid: currentUser.uid
      });
      posterChanges = { posterPath: up.url, posterStoragePath: up.path };
    } else if (posterDraft.remove) {
      posterChanges = { posterPath: null, posterStoragePath: null };
    }

    if (canDirectEdit()) {
      showEditStatus(i18nT("Salvataggio in corso..."));

      const idx = buildTitleSearchIndex({
        name: payload.name,
        type: payload.type,
        year: payload.year,
        aliases: payload.aliases,
        originalName: payload.originalName
      });

      await updateTitle(currentTitle.id, {
        name: payload.name,
        nameLower: idx.nameLower,
        search: idx.search,

        type: payload.type,
        year: payload.year,
        genres: payload.genres,
        description: payload.description,
        originalName: payload.originalName,
        aliases: payload.aliases,

        directors: payload.directors,
        directorIds: payload.directorIds,
        cast: payload.cast,
        castIds: payload.castIds,

        meta: payload.meta,

        ...posterChanges,
        lastEditedBy: currentUser.uid
      });

      // Best-effort: bump occurrences for newly-added people.
      try {
        const oldIds = new Set([...(currentTitle.directorIds || []), ...(currentTitle.castIds || [])].filter(Boolean).map(String));
        const newIds = new Set([...(payload.directorIds || []), ...(payload.castIds || [])].filter(Boolean).map(String));
        const added = [...newIds].filter(id => !oldIds.has(id));
        if (added.length) bumpPeopleOccurrences(added, { delta: 1 }).catch(() => {});
      } catch {}

      toast(i18nT("Modifica salvata."), "Ok");
      currentTitle = await getTitleById(currentTitle.id);
      renderTitle(currentTitle);
      renderRatings(currentTitle);
      hideEditBox();
    } else {
      showEditStatus(i18nT("Invio proposta..."));

      const idx = buildTitleSearchIndex({
        name: payload.name,
        type: payload.type,
        year: payload.year,
        aliases: payload.aliases,
        originalName: payload.originalName
      });

      await proposeTitleEdit({
        titleId: currentTitle.id,
        proposedBy: currentUser.uid,
        changes: {
          _before: currentTitle,
          _after: {
            ...currentTitle,
            ...payload,
            ...posterChanges,
            nameLower: idx.nameLower,
            search: idx.search
          },
          _changes: payload
        }
      });

      toast(i18nT("Proposta inviata!"), i18nT("Perfetto"));
      hideEditBox();
    }
  } catch (err) {
    console.error(err);
    toast(err?.message || i18nT("Operazione non riuscita"), "Ops");
    showEditStatus(i18nT("Non sono riuscito a completare. Riprova."));
  } finally {
    btnSaveEdit.disabled = false;
  }
});

/* ---------------------------
   renderTitle (MODIFIED)
--------------------------- */
/* ============================================
   CAST — vista completa + voto personaggi
   Il cast era una riga di nomi separati da virgola dentro i "fatti". Qui
   diventa una vista: volto, attore, personaggio, e il grado di apprezzamento
   della community dagli aggregati che gia' calcoliamo
   (docs/CHARACTER_VOTES_SPEC.md). Il voto riusa il picker esistente, non ne
   introduce un secondo.
   ============================================ */

const CAST_PREVIEW_COUNT = 10;
const CAST_MAX_PICKS = 3;

let _castCandidates = [];
let _castBucket = null;
let _castModalMode = "browse"; // "browse" | "vote"
let _castVoteDraft = [];
// I MIEI pick: visibili anche fuori dal voto. Dopo aver votato l'utente si
// aspetta di rivedere la sua scelta, e l'etichetta community non basta
// (richiede un campione minimo).
let _castMyPickIds = new Set();

/** Copy dell'etichetta. Solo positiva: si votano personaggi, mai le persone. */
function castAppreciationLabel(key) {
  if (key === "top") return i18nT("Il più amato");
  if (key === "high") return i18nT("Molto amato");
  if (key === "some") return i18nT("Amato");
  return "";
}

function castVoteCtaLabel() {
  return String(currentTitle?.type || "").toLowerCase() === "tv"
    ? i18nT("Vota il personaggio che più hai preferito in questa serie")
    : i18nT("Vota il personaggio che più hai preferito in questo film");
}

function castCellHtml(candidate, { selectable = false, selectedIndex = -1, atCap = false } = {}) {
  const appreciation = characterAppreciation(_castBucket, candidate.personId);
  const label = appreciation ? castAppreciationLabel(appreciation.key) : "";
  const src = safeImgUrl(candidate.profilePath);
  const img = src
    ? `<img class="cast-photo-img" src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">`
    : "";
  const isSelected = selectedIndex >= 0;
  const cls = [
    "cast-cell",
    selectable ? "is-selectable" : "",
    isSelected ? "is-selected" : "",
    !isSelected && atCap && selectable ? "is-at-cap" : "",
  ].filter(Boolean).join(" ");
  // Non selezionabile = link alla persona. Il cast completo arriva da TMDB e
  // quei person non sono quasi mai nel nostro catalogo: si naviga per NOME,
  // stesso fallback della ricerca. Senza, erano cliccabili solo i pochi che
  // avevamo gia' indicizzato.
  const tag = selectable ? "button" : "a";
  const attrs = selectable
    ? ` type="button" data-cast-person="${escapeHtml(candidate.personId)}" aria-pressed="${isSelected}"`
    : ` href="/search.html?q=${encodeURIComponent(candidate.name)}&scope=people&role=actor"`;

  return `
    <${tag} class="${cls}"${attrs}>
      <span class="cast-photo">
        ${img}<span class="cast-photo-fallback">${escapeHtml(initialsFromName(candidate.name))}</span>
        ${isSelected ? `<span class="cast-photo-order">${selectedIndex + 1}</span>` : ""}
      </span>
      <span class="cast-name">${escapeHtml(candidate.name)}</span>
      ${candidate.character ? `<span class="cast-character">${escapeHtml(candidate.character)}</span>` : ""}
      ${_castMyPickIds.has(candidate.personId) ? `<span class="cast-mypick">${i18nT("Il tuo voto")}</span>` : ""}
      ${label ? `<span class="cast-appreciation">${escapeHtml(label)}</span>` : ""}
    </${tag}>`;
}

/**
 * Il personaggio piu' scelto dalla community, in chiaro sulla scheda. Stava
 * solo dentro la modale e non lo trovava nessuno. Nessuna soglia minima: la
 * percentuale si porta dietro il proprio contesto.
 */
function renderCastLeader() {
  const host = castCard?.querySelector("#castLeader") || (() => {
    if (!castCard || !castGrid) return null;
    const el = document.createElement("div");
    el.id = "castLeader";
    el.className = "cast-leader";
    castGrid.parentNode.insertBefore(el, castGrid);
    return el;
  })();
  if (!host) return;

  const totalUsers = Number(_castBucket?.totalUsers || 0);
  const counts = _castBucket?.counts || {};
  const top = Object.entries(counts).sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))[0];
  const candidate = top ? _castCandidates.find((c) => c.personId === top[0]) : null;

  if (!totalUsers || !candidate) {
    host.style.display = "none";
    host.innerHTML = "";
    return;
  }

  host.style.display = "";
  host.innerHTML = `
    <span class="cast-leader-crown" aria-hidden="true">👑</span>
    <span class="cast-leader-label">${i18nT("Il più votato")}</span>
    <strong class="cast-leader-name">${escapeHtml(candidate.character || candidate.name)}</strong>
    <span class="cast-leader-pct">${Math.round((top[1] / totalUsers) * 100)}%</span>
  `;
}

async function renderCastSection(t) {
  if (!castCard) return;

  _castCandidates = characterCandidatesFromTitle(t);
  _castFullLoaded = false;
  if (!_castCandidates.length) {
    castCard.style.display = "none";
    return;
  }
  castCard.style.display = "";

  // L'aggregato e' pubblico e non blocca il primo paint: la griglia esce
  // subito senza etichette, che compaiono al ritorno della fetch.
  if (castGrid) {
    castGrid.innerHTML = _castCandidates.slice(0, CAST_PREVIEW_COUNT).map((c) => castCellHtml(c)).join("");
  }
  renderCastLeader();
  if (castShowAllBtn) {
    castShowAllBtn.style.display = _castCandidates.length > CAST_PREVIEW_COUNT ? "" : "none";
  }
  if (castVoteBtn) {
    castVoteBtn.textContent = castVoteCtaLabel();
    castVoteBtn.style.display = currentUser ? "" : "none";
  }

  const [aggregate, myPicks] = await Promise.all([
    fetchTitleCharacterAggregate(t.id).catch(() => null),
    currentUser
      ? getMyCharacterPicks({ uid: currentUser.uid, titleId: t.id, level: "title", season: 0, episode: 0 }).catch(() => [])
      : Promise.resolve([]),
  ]);
  _castBucket = pickCommunityBucket(aggregate);
  _castMyPickIds = new Set((myPicks || []).map((p) => p.personId));
  if ((_castBucket || _castMyPickIds.size) && castGrid) {
    castGrid.innerHTML = _castCandidates.slice(0, CAST_PREVIEW_COUNT).map((c) => castCellHtml(c)).join("");
    renderCastLeader();
  }
}

/**
 * Risultati dei voti community. Esiste perche' l'etichetta di apprezzamento
 * richiede un campione minimo: con pochi voti non compariva niente e sembrava
 * che il voto non fosse stato registrato. Qui il dato si vede sempre, col
 * numero di votanti accanto cosi' si capisce quanto pesa.
 */
function renderCastResults() {
  const host = overlayResultsHost();
  if (!host) return;

  const totalUsers = Number(_castBucket?.totalUsers || 0);
  const counts = _castBucket?.counts || {};
  if (_castModalMode !== "browse" || !totalUsers) {
    host.innerHTML = "";
    host.style.display = "none";
    return;
  }

  const byId = new Map(_castCandidates.map((c) => [c.personId, c]));
  const rows = Object.entries(counts)
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([personId, count]) => ({ candidate: byId.get(personId), count }))
    .filter((r) => r.candidate);

  if (!rows.length) {
    host.innerHTML = "";
    host.style.display = "none";
    return;
  }

  host.style.display = "";
  host.innerHTML = `
    <h4 class="cast-results-title">${i18nT("Chi ha conquistato la community")}</h4>
    ${rows.map((r) => `
      <div class="cast-results-row">
        <span class="cast-results-name">${escapeHtml(r.candidate.name)}</span>
        ${r.candidate.character ? `<span class="cast-results-role">${escapeHtml(r.candidate.character)}</span>` : ""}
        <span class="cast-results-pct">${Math.round((r.count / totalUsers) * 100)}%</span>
      </div>`).join("")}
    <p class="cast-results-note">${i18nT("Su {n} votanti. Ognuno può sceglierne fino a 3, quindi la somma supera il 100%.", { n: totalUsers })}</p>
  `;
}

function overlayResultsHost() {
  if (!castModalGrid) return null;
  let host = castModal.querySelector("#castResults");
  if (!host) {
    host = document.createElement("div");
    host.id = "castResults";
    host.className = "cast-results";
    castModalGrid.parentNode.insertBefore(host, castModalGrid);
  }
  return host;
}

function renderCastModalGrid() {
  if (!castModalGrid) return;
  const selectable = _castModalMode === "vote";
  const index = new Map(_castVoteDraft.map((p, i) => [p.personId, i]));
  const atCap = _castVoteDraft.length >= CAST_MAX_PICKS;

  castModalGrid.innerHTML = _castCandidates.map((c) => castCellHtml(c, {
    selectable,
    selectedIndex: index.has(c.personId) ? index.get(c.personId) : -1,
    atCap,
  })).join("");

  if (!selectable) return;
  castModalGrid.querySelectorAll("[data-cast-person]").forEach((btn) => {
    btn.addEventListener("click", () => toggleCastVote(btn.dataset.castPerson));
  });
}

function toggleCastVote(personId) {
  const at = _castVoteDraft.findIndex((p) => p.personId === personId);
  if (at >= 0) {
    _castVoteDraft.splice(at, 1);
  } else {
    if (_castVoteDraft.length >= CAST_MAX_PICKS) {
      toast(i18nT("Puoi votare fino a 3 personaggi."), i18nT("Cast"));
      return;
    }
    const candidate = _castCandidates.find((c) => c.personId === personId);
    if (!candidate) return;
    _castVoteDraft.push({ personId, character: candidate.character || null, reaction: null });
  }
  renderCastModalGrid();
}

let _castFullLoaded = false;

async function openCastModal(mode) {
  if (!castModal || !_castCandidates.length) return;
  _castModalMode = mode;

  // In DB c'e' solo il top-20: il cast COMPLETO si chiede a TMDB, una volta
  // per apertura della scheda. Fallback silenzioso sui 20 se non arriva.
  if (!_castFullLoaded && currentTitle) {
    const full = await fetchFullTitleCast(currentTitle).catch(() => null);
    if (full?.length) _castCandidates = full;
    _castFullLoaded = true;
  }

  if (castModalTitle) {
    castModalTitle.textContent = mode === "vote"
      ? i18nT("Chi ti ha conquistato?")
      : i18nT("Cast completo");
  }
  if (castModalHint) {
    castModalHint.textContent = mode === "vote"
      ? i18nT("Puoi votare fino a 3 personaggi.")
      : "";
    castModalHint.style.display = mode === "vote" ? "" : "none";
  }
  if (castModalActions) castModalActions.style.display = mode === "vote" ? "" : "none";

  if (mode === "vote" && currentUser && currentTitle) {
    _castVoteDraft = await getMyCharacterPicks({
      uid: currentUser.uid,
      titleId: currentTitle.id,
      level: "title",
      season: 0,
      episode: 0,
    }).catch(() => []);
  } else {
    _castVoteDraft = [];
  }

  renderCastResults();
  renderCastModalGrid();
  openModal(castModal);
}

async function saveCastVote() {
  if (!currentUser || !currentTitle) return;
  await runWithButtonLoading(castModalSave, async () => {
    try {
      await upsertCharacterPicks({
        uid: currentUser.uid,
        titleId: currentTitle.id,
        level: "title",
        season: 0,
        episode: 0,
        picks: _castVoteDraft,
        source: "title_page",
      });
      closeModal(castModal);
      toast(i18nT("Voto salvato"), i18nT("Cast"));
      // L'aggregato lo ricalcola un trigger: rileggerlo subito darebbe il
      // valore vecchio. Si aggiorna alla prossima apertura della scheda.
    } catch (err) {
      console.error("character vote save error", err);
      toast(i18nT("Non siamo riusciti a salvare il voto. Riprova."), i18nT("Errore"));
    }
  }, { loadingLabel: i18nT("Salvo...") });
}

function renderTitle(t) {
  if (tName) tName.textContent = t.name || i18nT("(senza titolo)");
  renderPoster(t.posterPath);
  renderGenresPills(t);
  renderHeroChrome(t);
  renderFacts(t);
  void renderCastSection(t);
  renderHeroStatusRow();
  updateOgTags(t);

  // richiesta: non mostrare più hint visibilità / suggerimenti
  // (lascio "safe": se esiste in html, lo nascondo)
  if (tVisibility) tVisibility.style.display = "none";
  if (tEditHint) tEditHint.style.display = "none";

  if (btnEdit) btnEdit.style.display = "none";
  if (btnSuggest) btnSuggest.style.display = "none";

  // Social actions section is always visible; each row auth-gates on tap (mirror iOS).
  if (recBox) recBox.style.display = "none";
  if (threadBox) threadBox.style.display = "block";
  if (btnOpenRecommend) btnOpenRecommend.style.display = "flex";
  updateGuestUnlockCta();

  // ⭐ WATCHLIST BUTTON
  // Mostra l'intero box solo se loggato (oltre al bottone)
  if (watchlistBtn) watchlistBtn.style.display = currentUser ? "inline-flex" : "none";
  renderPersonalStateCard();
  syncTitleTabs(t);

  // show add related button if logged in
  if (btnAddRelated) btnAddRelated.style.display = currentUser ? "inline-flex" : "none";
  if (watchProvidersSuggestBtn) watchProvidersSuggestBtn.style.display = currentUser ? "inline-flex" : "none";

  updateEditButton();
  loadRelated().catch(() => {});
  loadWatchProviders(t, { region: "IT" }).catch(() => {});
}

function updateOgTags(t) {
  const set = (sel, value) => {
    const el = document.querySelector(sel);
    if (el && value) el.setAttribute("content", value);
  };
  const url = `${location.origin}/title.html?id=${encodeURIComponent(t.id)}`;
  set('meta[property="og:title"]', t.name || i18nT("Somto"));
  set('meta[property="og:description"]', t.description ? t.description.slice(0, 180) : i18nT("Scopri e condividi film e serie TV su Somto."));
  set('meta[property="og:image"]', t.posterPath || "/icons/icon-512.png");
  set('meta[property="og:url"]', url);
  set('meta[name="twitter:card"]', "summary_large_image");
}

async function loadTrailer(t) {
  if (!trailerCard || !t) return;
  trailerCard.style.display = "none";
  if (trailerPlayer) trailerPlayer.innerHTML = "";
  if (trailerFallback) trailerFallback.style.display = "none";
  if (trailerWatchOnYt) trailerWatchOnYt.style.display = "none";

  try {
    const trailer = await getTrailerByName({
      name: t.name || t.originalName || "",
      year: t.year || null,
      mediaType: t.type === "tv" ? "tv" : "movie",
      tmdbId: t.tmdbId || t.meta?.tmdbId || null,
    });
    if (!trailer) {
      if (trailerFallback) trailerFallback.style.display = "block";
      trailerCard.style.display = "block";
      return;
    }

    const iframe = document.createElement("iframe");
    iframe.src = `${trailer.embed}?rel=0&modestbranding=1`;
    iframe.title = `${t.name || "Trailer"} — YouTube`;
    iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
    iframe.allowFullscreen = true;
    trailerPlayer.appendChild(iframe);

    trailerCard.style.display = "block";
    if (trailerWatchOnYt) {
      trailerWatchOnYt.style.display = "inline-flex";
      trailerWatchOnYt.onclick = () => window.open(trailer.url, "_blank", "noreferrer");
    }
  } catch (err) {
    console.warn("[title] trailer load failed", err);
  }
}

/* ---------------------------
   Sezione "Novità" — trailer/teaser datati + prossima uscita.
   Progressive enhancement: se TMDB non risponde o non c'è nulla di
   rilevante, la card resta nascosta. Un video appena pubblicato (≤45gg)
   porta il badge "Nuovo".
--------------------------- */
const NEWS_FRESH_DAYS = 45;
const NEWS_MAX_VIDEOS = 6;

function titleUpdateTypeLabel(type) {
  const labels = {
    trailer: i18nT("Trailer"),
    teaser: i18nT("Teaser"),
    release_date: i18nT("Data di uscita"),
    new_episode: i18nT("Nuovo episodio"),
    new_season: i18nT("Nuova stagione"),
    renewal: i18nT("Rinnovo"),
    cancellation: i18nT("Cancellazione"),
    sequel: i18nT("Sequel"),
    casting: i18nT("Casting"),
  };
  return labels[type] || i18nT("Aggiornamento ufficiale");
}

function renderTitleUpdatePreference(mode) {
  titleUpdatePreferences?.querySelectorAll("[data-update-pref]").forEach((button) => {
    const active = button.dataset.updatePref === mode;
    button.classList.toggle("primary", active);
    button.classList.toggle("ghost", !active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

async function loadTitleUpdatePreference(titleId) {
  if (!titleUpdatePreferences) return;
  titleUpdatePreferences.style.display = currentUser ? "block" : "none";
  if (!currentUser) return;
  const mode = await getTitleUpdatePreference(currentUser.uid, titleId).catch(() => "auto");
  renderTitleUpdatePreference(mode);
}

titleUpdatePreferences?.addEventListener("click", async (event) => {
  const button = event.target.closest?.("[data-update-pref]");
  if (!button || !currentUser || !currentTitle?.id) return;
  const previous = titleUpdatePreferences.querySelector('[aria-pressed="true"]')?.dataset?.updatePref || "auto";
  const mode = button.dataset.updatePref;
  renderTitleUpdatePreference(mode);
  titleUpdatePreferences.querySelectorAll("button").forEach((item) => { item.disabled = true; });
  try {
    await setTitleUpdatePreference(currentUser.uid, currentTitle.id, mode);
    toast(i18nT("Preferenza salvata."), i18nT("Aggiornamenti"));
  } catch (err) {
    console.warn("[title] update preference failed", err);
    renderTitleUpdatePreference(previous);
    toast(i18nT("Impossibile salvare la preferenza. Riprova."), i18nT("Errore"));
  } finally {
    titleUpdatePreferences.querySelectorAll("button").forEach((item) => { item.disabled = false; });
  }
});

function playNewsVideo(videoKey, videoName) {
  if (!trailerPlayer || !trailerCard) {
    window.open(`https://www.youtube.com/watch?v=${videoKey}`, "_blank", "noreferrer");
    return;
  }
  trailerPlayer.innerHTML = "";
  const iframe = document.createElement("iframe");
  iframe.src = `https://www.youtube.com/embed/${videoKey}?rel=0&modestbranding=1&autoplay=1`;
  iframe.title = videoName || "Trailer";
  iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
  iframe.allowFullscreen = true;
  trailerPlayer.appendChild(iframe);
  if (trailerFallback) trailerFallback.style.display = "none";
  trailerCard.style.display = "block";
  switchTab("overview");
  trailerCard.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function loadTitleNews(t) {
  if (!titleNewsCard || !t) return;
  titleNewsCard.style.display = "none";
  if (titleUpdatesEmpty) titleUpdatesEmpty.style.display = "none";
  if (titleUpdatesError) titleUpdatesError.style.display = "none";
  if (titleUpdatesLoading) titleUpdatesLoading.style.display = "block";
  void loadTitleUpdatePreference(t.id);
  const tmdbId = t.tmdbId || t.meta?.tmdbId || t.sourceTmdb?.tmdbId || null;
  const mediaType = t.type === "tv" ? "tv" : "movie";

  const [eventsResult, postsResult, videosResult, releaseResult] = await Promise.allSettled([
    listTitleUpdateEvents(t.id, { locale: getLocale(), max: 20 }),
    listLinkedOfficialPosts(t.id, { max: 12 }),
    tmdbId ? getTitleVideos({ tmdbId, mediaType }) : Promise.resolve([]),
    tmdbId ? getTitleReleaseInfo({ tmdbId, mediaType }) : Promise.resolve(null),
  ]);
  if (titleUpdatesLoading) titleUpdatesLoading.style.display = "none";

  const events = eventsResult.status === "fulfilled" ? eventsResult.value : [];
  const posts = postsResult.status === "fulfilled" ? postsResult.value : [];
  const videos = videosResult.status === "fulfilled" ? videosResult.value : [];
  const release = releaseResult.status === "fulfilled" ? releaseResult.value : null;

  try {

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Riga "prossima uscita": prossimo episodio (serie) o data cinema (film).
    let upcomingHtml = "";
    if (release?.mediaType === "tv" && release.nextEpisode?.airDate) {
      const d = new Date(`${release.nextEpisode.airDate}T00:00:00`);
      if (!Number.isNaN(d.getTime()) && d >= today) {
        const se = release.nextEpisode.season && release.nextEpisode.episode
          ? `S${release.nextEpisode.season}E${release.nextEpisode.episode}`
          : "";
        const epName = release.nextEpisode.name ? ` · <em>${escapeHtml(release.nextEpisode.name)}</em>` : "";
        upcomingHtml =
          `<span class="title-news-upcoming-label">${escapeHtml(i18nT("Prossimo episodio"))}</span>` +
          `<strong>${se}</strong>${epName} · ${escapeHtml(formatDate(d, { day: "numeric", month: "long", year: "numeric" }))}`;
      }
    } else if (release?.mediaType === "movie" && release.releaseDate) {
      const d = new Date(`${release.releaseDate}T00:00:00`);
      if (!Number.isNaN(d.getTime()) && d >= today) {
        upcomingHtml =
          `<span class="title-news-upcoming-label">${escapeHtml(i18nT("In uscita"))}</span>` +
          `<strong>${escapeHtml(formatDate(d, { day: "numeric", month: "long", year: "numeric" }))}</strong>`;
      }
    }

    if (titleNewsUpcoming) {
      titleNewsUpcoming.innerHTML = upcomingHtml;
      titleNewsUpcoming.style.display = upcomingHtml ? "flex" : "none";
    }

    // Lista video: dal più recente, badge "Nuovo" sui freschi.
    const freshCutoff = Date.now() - NEWS_FRESH_DAYS * 24 * 60 * 60 * 1000;
    const persistedVideoIds = new Set(events.map((item) => String(item.sourceId || "")).filter(Boolean));
    const eventFocus = String(titleQuery.get("event") || "");
    const eventRows = events.map((item) => {
      const date = item.sortAtMs ? formatDate(new Date(item.sortAtMs), { day: "numeric", month: "short", year: "numeric" }) : "";
      const name = item.entityName || item.headline || titleUpdateTypeLabel(item.eventType);
      const isVideo = ["trailer", "teaser"].includes(item.eventType) && item.sourceId;
      const attrs = isVideo
        ? `type="button" data-video-key="${escapeHtml(item.sourceId)}" data-video-name="${escapeHtml(name)}"`
        : `href="${escapeHtml(item.sourceUrl || "#")}" target="_blank" rel="noreferrer noopener"`;
      const tag = isVideo ? "button" : "a";
      return `<${tag} ${attrs} id="title-update-${escapeHtml(item.id)}" class="title-news-row title-update-event${item.id === eventFocus ? " is-focused" : ""}">` +
        `<span class="title-news-type${item.eventType === "teaser" ? " is-teaser" : ""}">${escapeHtml(titleUpdateTypeLabel(item.eventType))}</span>` +
        `<span class="title-news-name">${escapeHtml(name)}</span>` +
        (item.official ? `<span class="title-news-badge">${escapeHtml(i18nT("Ufficiale"))}</span>` : "") +
        (date ? `<span class="title-news-date">${escapeHtml(date)}</span>` : "") +
        `</${tag}>`;
    });

    const postRows = posts.map((post) =>
      `<a class="title-news-row title-update-event" href="/community.html?post=${encodeURIComponent(post.id)}">` +
        `<span class="title-news-type">${escapeHtml(i18nT("Aggiornamento ufficiale"))}</span>` +
        `<span class="title-news-name">${escapeHtml(post.officialUpdate?.title || post.text || i18nT("Aggiornamento ufficiale"))}</span>` +
        `<span class="title-news-badge">Somto</span>` +
      `</a>`
    );

    const dynamicRows = videos.filter((v) => !persistedVideoIds.has(String(v.key))).slice(0, NEWS_MAX_VIDEOS).map((v) => {
      const isFresh = v.publishedAt && v.publishedAt.getTime() >= freshCutoff;
      const typeLabel = v.type === "teaser" ? "Teaser" : "Trailer";
      const dateLabel = v.publishedAt
        ? escapeHtml(formatDate(v.publishedAt, { day: "numeric", month: "short", year: "numeric" }))
        : "";
      return (
        `<button type="button" class="title-news-row" data-video-key="${escapeHtml(v.key)}" data-video-name="${escapeHtml(v.name)}">` +
          `<span class="title-news-type${v.type === "teaser" ? " is-teaser" : ""}">${typeLabel}</span>` +
          `<span class="title-news-name">${escapeHtml(v.name)}</span>` +
          (isFresh ? `<span class="title-news-badge">${escapeHtml(i18nT("Nuovo"))}</span>` : "") +
          (dateLabel ? `<span class="title-news-date">${dateLabel}</span>` : "") +
        `</button>`
      );
    });

    const rows = [...eventRows, ...postRows, ...dynamicRows];
    if (titleNewsVideos) titleNewsVideos.innerHTML = rows.join("");

    // La tab dedicata è anche lo storico trailer: il primo video non è più
    // nascosto solo perché coincide col trailer principale.
    const worthShowing = Boolean(upcomingHtml) || rows.length > 0;
    titleNewsCard.style.display = worthShowing ? "block" : "none";
    const persistentFailed = eventsResult.status === "rejected";
    const everySourceFailed = persistentFailed && postsResult.status === "rejected" && videosResult.status === "rejected" && releaseResult.status === "rejected";
    if (titleUpdatesError) titleUpdatesError.style.display = everySourceFailed && !worthShowing ? "block" : "none";
    if (titleUpdatesEmpty) titleUpdatesEmpty.style.display = !worthShowing && !everySourceFailed ? "block" : "none";

    if (titleNewsVideos && rows.length) {
      titleNewsVideos.querySelectorAll("[data-video-key]").forEach((btn) => {
        btn.addEventListener("click", () => {
          playNewsVideo(btn.dataset.videoKey, btn.dataset.videoName);
        });
      });
    }
    if (eventFocus) {
      window.setTimeout(() => document.getElementById(`title-update-${eventFocus}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    }
  } catch (err) {
    console.warn("[title] news load failed", err);
    if (titleUpdatesError) titleUpdatesError.style.display = "block";
  }
}

titleUpdatesRetry?.addEventListener("click", () => {
  if (currentTitle) loadTitleNews(currentTitle).catch(() => {});
});

async function maybeRefreshTitleFromTmdbOnOpen(titleId) {
  const cleanTitleId = String(titleId || "").trim();
  if (!cleanTitleId) return;

  try {
    const res = await refreshTitleFromTmdbIfNeeded(cleanTitleId);
    if (!res?.updated) return;

    const fresh = await getTitleById(cleanTitleId);
    if (!fresh) return;

    currentTitle = fresh;
    renderTitle(fresh);
    loadTrailer(fresh).catch(() => {});
    loadTitleNews(fresh).catch(() => {});
  } catch (err) {
    console.warn("[title] tmdb refresh on open failed", err);
  }
}

/* ---------------------------
   LOAD (MODIFIED)
--------------------------- */
async function load() {
  if (!id) {
    if (tName) tName.textContent = i18nT("Contenuto non trovato");
    if (tSub) tSub.textContent = "ID mancante.";
    return;
  }

  await loadGenres();

  const t = await getTitleById(id);
  if (!t) {
    if (tName) tName.textContent = i18nT("Contenuto non trovato");
    if (tSub) tSub.textContent = i18nT("Potrebbe non esistere (o non essere visibile).");
    return;
  }

  currentTitle = t;
  renderTitle(t);
  maybePresentTitleDetailTour();
  loadTrailer(t).catch(() => {});
  loadTitleNews(t).catch(() => {});
  void maybeRefreshTitleFromTmdbOnOpen(t.id);

  void logEvent("title_opened", {
    title_type: t.type || "movie",
    has_tmdb: Boolean(t.tmdbId || t.meta?.tmdbId),
    year: Number(t.year || 0) || null,
  });

  ratings = await listRatingsForTitle(t.id);
  renderRatings(t);
  renderSummaryStats().catch(() => {});

  // ⭐ CHECK WATCHLIST STATUS
  if (currentUser) {
    await checkWatchlistStatus();
  } else {
    renderPersonalStateCard();
  }

  // "Chi la sta guardando" — amici/seguiti su questa serie (solo loggati, hide-if-empty).
  void renderSeriesWatchers();

  // "In queste liste" — liste pubbliche che includono questo titolo.
  void renderTitleLists();
}

/* ---------------------------
   Thread handlers
--------------------------- */
btnOpenPublicThread?.addEventListener("click", async () => {
  if (!requireAuthOrRedirect()) return;
  if (!currentTitle?.id) return;
  try{
    const t = await ensurePublicThread({ titleId: currentTitle.id, createdBy: currentUser.uid });
    window.location.href = `/thread.html?tid=${encodeURIComponent(t.id)}`;
  }catch(e){
    console.error(e);
    toast(e?.message || i18nT("Errore"), i18nT("Thread"));
  }
});

btnOpenDmThread?.addEventListener("click", async () => {
  if (!requireAuthOrRedirect()) return;
  if (!currentTitle?.id) return;
  await openThreadModal("dm");
});

btnOpenGroupThread?.addEventListener("click", async () => {
  if (!requireAuthOrRedirect()) return;
  if (!currentTitle?.id) return;
  await openThreadModal("group");
});

thrOpen?.addEventListener("click", async () => {
  if (!currentUser || !currentTitle?.id) return;
  thrOpen.disabled = true;
  try{
    if (thrTabDm?.classList.contains("active")){
      const otherUid = thrTo?.value;
      if (!otherUid) throw new Error(i18nT("Seleziona un amico"));

      const t = await ensureDMThread({
        titleId: currentTitle.id,
        uidA: currentUser.uid,
        uidB: otherUid,
        createdBy: currentUser.uid
      });

      closeModal(threadModal);
      window.location.href = `/thread.html?tid=${encodeURIComponent(t.id)}`;
    } else {
      const checked = thrGroupMembers
        ? [...thrGroupMembers.querySelectorAll("input[type=checkbox]:checked")].map(i => i.value)
        : [];
      if (checked.length < 2) throw new Error(i18nT("Seleziona almeno 2 amici"));

      const participants = [currentUser.uid, ...checked];
      const t = await ensureGroupThread({
        titleId: currentTitle.id,
        participantUids: participants,
        groupName: thrGroupName?.value,
        createdBy: currentUser.uid
      });

      closeModal(threadModal);
      window.location.href = `/thread.html?tid=${encodeURIComponent(t.id)}`;
    }
  }catch(e){
    console.error(e);
    showThreadStatus(e?.message || i18nT("Errore"));
  }finally{
    thrOpen.disabled = false;
  }
});

window.addEventListener("error", (e) => console.error("💥 JS error:", e.message, e.filename, e.lineno));
window.addEventListener("unhandledrejection", (e) => console.error("💥 Promise rejected:", e.reason));

/* ---------------------------
   AUTH (MODIFIED con watchlist check)
--------------------------- */
initAuthGuard({ requireAuth: false, onReady: async (user) => {
  currentUser = user;
  void setAnalyticsUser(user || null);

  if (user) {
    if (navAccount){
      navAccount.textContent = i18nT("Account");
      navAccount.href = "/account.html";
    }
    await ensureUserDoc(user);
    myUserDoc = await getMyUserDoc(user.uid);
  } else {
    if (navAccount){
      navAccount.textContent = "Login";
      navAccount.href = "/login.html";
    }
  }

  await load();
  updateEditButton();
  updateGuestUnlockCta();
}});
