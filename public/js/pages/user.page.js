import { initAuthGuard } from "../components/authGuard.js";
import { t as i18nT } from "../i18n/index.js";
import { initTabbar } from "../utils/tabbar.js";
import { trapFocus } from "../utils/focusTrap.js";
import {
  ensureUserDoc,
  getRelationshipState,
  getUserPublic,
  followUser,
  unfollowUser,
  listFollowers,
  listFollowing,
  listUsersPublicByIds,
} from "../api/users.api.js";
import { getPublicProfileActivitySummary, getPublicProfileSeriesProgress, listMyLibrary } from "../api/library.api.js";
import { getTitleById, getTitlesByIds } from "../api/titles.api.js";
import { toast } from "../components/toast.js";
import { qs, escapeHtml, fitProfileName } from "../utils/dom.js";
import { sendReport } from "../api/reports.api.js";
import { showConfirm } from "../utils/confirmDialog.js";
import { blockUser, unblockUser, isUserBlocked } from "../api/safety.api.js";
import { runWithButtonLoading } from "../utils/loading.js";
import {
  getWatchTimeUnitMode,
  cycleWatchTimeUnitMode,
  renderWatchTimeInto,
} from "../utils/watchTimeUnit.js";

const navAccount = qs("#navAccount");
const profileEl = qs("#profile");
const listEl = qs("#list");
const tabVotati = qs("#tabVotati");
const panelVotati = qs("#panelVotati");
const votesSearchInput = qs("#votesSearchInput");
const connectionsModal = qs("#connectionsModal");
const connectionsTitle = qs("#connectionsTitle");
const btnCloseConnections = qs("#btnCloseConnections");
const connectionsList = qs("#connectionsList");
const connectionsSearchInput = qs("#connectionsSearchInput");
const profileMenuModal = qs("#profileMenuModal");
const btnCloseProfileMenu = qs("#btnCloseProfileMenu");
const btnProfileReport = qs("#btnProfileReport");
const btnProfileBlock = qs("#btnProfileBlock");
const profileWatchSummary = qs("#profileWatchSummary");
const watchTimeUnitBtn = qs("#watchTimeUnitBtn");
const watchTimeDigits = qs("#watchTimeDigits");
const watchTimeUnitHint = qs("#watchTimeUnitHint");

const uid = new URLSearchParams(location.search).get("uid") || "";
const VOTES_PER_PAGE = 9;

let currentViewer = null;
let currentTargetUser = null;
let currentActivitySummary = null;
let allLibraryData = [];
let seriesProgressMap = {}; // titleId -> { state, lastWatchedSeasonNumber, ... } (solo serie iniziate/finite)
let votesSearchQuery = "";
let votesCurrentPage = 1;
// Filtro TIPO multi-selezione: i conteggi del riepilogo SONO i filtri (come sul
// profilo proprio). Set vuoto = "tutti". Valori: movie/tv/cartoni_animati/anime.
const votesSelectedCategories = new Set();
let votesStatusFilter = "all"; // "all" | "in_progress" | "rated" | "rewatched"
const votesTypeIsAll = () => votesSelectedCategories.size === 0;
// Strip usa data-category film/serie_tv; il filtro usa movie/tv.
const STRIP_TO_FILTER_CATEGORY = { film: "movie", serie_tv: "tv", cartoni_animati: "cartoni_animati", anime: "anime" };
let releaseConnectionsTrap = null;
let releaseProfileMenuTrap = null;
let lastWatchMinutes = 0;

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

// Profili guidati (synthetic / AI-assisted) — disclosure obbligatoria.
const GUIDED_DISCLOSURE_FALLBACK =
  i18nT("Profilo guidato da Somto per testare e migliorare l'esperienza nell'app. ") +
  i18nT("I contenuti possono essere generati con supporto AI e supervisionati prima della pubblicazione.");

function isGuidedProfile(userDoc) {
  if (!userDoc || typeof userDoc !== "object") return false;
  return userDoc.accountType === "guided_profile" || userDoc.isSynthetic === true;
}

if (!uid) {
  location.replace("/account.html");
}

if (connectionsModal && connectionsModal.parentElement !== document.body) {
  document.body.appendChild(connectionsModal);
}
if (profileMenuModal && profileMenuModal.parentElement !== document.body) {
  document.body.appendChild(profileMenuModal);
}

function initials(name) {
  const s = String(name || "").trim();
  if (!s) return "?";
  const parts = s.split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] || "?";
  const b = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (a + b).toUpperCase();
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

// Asse STATO (indipendente dal tipo), stessa logica del profilo proprio.
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

// Vero per le categorie che sono serie episodiche (serie / cartoni / anime),
// quindi candidate al badge "a che punto è". I film non hanno badge.
function isSeriesCategory(title) {
  return deriveProfileContentCategory(title) !== "movie";
}

// Badge "a che punto è" per le serie viste dall'utente del profilo.
// In corso → "S{stagione}·E{episodio}" (fallback "{percent}%" se mancano).
// Stati completati → "Completa". Niente badge se il titolo non è nella mappa.
function buildSeriesProgressBadge(titleId) {
  const progress = titleId ? seriesProgressMap[titleId] : null;
  if (!progress || typeof progress !== "object") return "";

  const state = String(progress.state || "").trim().toLowerCase();
  const isCompleted = state === "completed_unrated" || state === "rated";

  let label = "";
  if (isCompleted) {
    label = i18nT("Completa");
  } else {
    const season = Number(progress.lastWatchedSeasonNumber);
    const episode = Number(progress.lastWatchedEpisodeNumber);
    if (Number.isFinite(season) && season > 0 && Number.isFinite(episode) && episode > 0) {
      label = `S${season}·E${episode}`;
    } else {
      const percent = Number(progress.percentComplete);
      if (Number.isFinite(percent) && percent > 0) {
        // percentComplete e' una frazione 0-1 (callable getPublicProfile*): *100 per la %.
        // Floor a 1: un progresso reale ma minuscolo (1 ep su 300) non deve
        // arrotondare a "0%".
        label = `${Math.max(1, Math.round(Math.max(0, Math.min(1, percent)) * 100))}%`;
      } else {
        // Iniziata ma senza segnaposto utile: non mostrare un badge vuoto.
        return "";
      }
    }
  }

  const stateClass = isCompleted ? "is-complete" : "is-progress";
  return `<span class="profile-progress-badge ${stateClass}">${escapeHtml(label)}</span>`;
}

// Renderizza #watchTimeDigits secondo la modalita' scelta (persistita in
// localStorage, condivisa col profilo proprio via utils/watchTimeUnit.js).
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
// I conteggi del riepilogo sono anche i filtri TIPO della libreria: click su una
// colonna attiva/disattiva quel tipo (multi-select). Riquadro attivo = sottolineato.
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
    col.setAttribute("role", "button");
    col.setAttribute("tabindex", empty ? "-1" : "0");
    col.setAttribute("aria-disabled", empty ? "true" : "false");
    col.setAttribute("aria-label", i18nT("Filtra per {v0}", { v0: col.querySelector(".profile-category-label")?.textContent?.trim() || col.dataset.category }));
  });
  strip.classList.remove("is-loading");
  strip.hidden = total === 0;
  syncCategoryStripActive();
}

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

function toggleCategoryFilter(stripCategory) {
  const filterKey = STRIP_TO_FILTER_CATEGORY[stripCategory];
  if (!filterKey) return;
  if (votesSelectedCategories.has(filterKey)) votesSelectedCategories.delete(filterKey);
  else votesSelectedCategories.add(filterKey);
  votesCurrentPage = 1;
  syncCategoryStripActive();
  renderLibraryUI();
}

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

function closeConnectionsModal() {
  if (!connectionsModal) return;
  connectionsModal.style.display = "none";
  releaseConnectionsTrap?.();
  releaseConnectionsTrap = null;
}

function closeProfileMenuModal() {
  if (!profileMenuModal) return;
  profileMenuModal.style.display = "none";
  releaseProfileMenuTrap?.();
  releaseProfileMenuTrap = null;
}

function renderConnectionsList(users) {
  if (!connectionsList) return;
  if (!users.length) {
    connectionsList.innerHTML = `<div class="hint">${i18nT("Nessun utente trovato.")}</div>`;
    return;
  }

  connectionsList.innerHTML = users.map((u) => {
    const label = u.displayName || u.uid;
    const avatarUrl = String(u.photoURL || u.avatarURL || "").trim();
    const avatarImg = avatarUrl
      ? `<img src="${escapeHtml(avatarUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
      : "";

    return `
      <a class="friend-item" href="/user.html?uid=${encodeURIComponent(u.uid)}">
        <div class="avatar ${avatarUrl ? "has-photo" : ""}">
          <span class="avatar-fallback">${escapeHtml(initials(label))}</span>
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
    renderConnectionsList(users);
    if (connectionsSearchInput) {
      connectionsSearchInput.oninput = (ev) => {
        const q = String(ev.target.value || "").trim().toLowerCase();
        if (!q) {
          renderConnectionsList(users);
          return;
        }
        renderConnectionsList(
          users.filter((entry) => String(entry.displayName || entry.uid || "").toLowerCase().includes(q))
        );
      };
    }
  } catch (err) {
    console.error("Errore caricamento connessioni:", err);
    connectionsList.innerHTML = `<div class="hint">${i18nT("Errore nel caricamento.")}</div>`;
  }
}

function openProfileMenuModal() {
  if (!profileMenuModal) return;
  profileMenuModal.style.display = "flex";
  releaseProfileMenuTrap?.();
  releaseProfileMenuTrap = trapFocus(profileMenuModal, {
    initialFocus: "#btnProfileReport",
    onEscape: closeProfileMenuModal,
  });
}

async function renderUserHeader(targetUser, viewer, activitySummary) {
  currentTargetUser = targetUser;
  currentViewer = viewer;
  currentActivitySummary = activitySummary;

  const name = targetUser?.displayName || uid;
  const guided = isGuidedProfile(targetUser);
  const guidedBadgeHtml = guided
    ? `<span class="guided-badge" title="${i18nT("Profilo guidato da Somto")}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 8V4H8"></path><rect x="4" y="8" width="16" height="12" rx="2"></rect><path d="M2 14h2M20 14h2M15 13v2M9 13v2"></path></svg>
        ${i18nT("Profilo guidato")}
      </span>`
    : "";
  const verifiedBadgeHtml = targetUser?.verified === true
    ? `<span class="verified-badge" title="${i18nT("Profilo verificato")}" aria-label="${i18nT("Profilo verificato")}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"></path></svg>
      </span>`
    : "";
  const guidedDisclosureHtml = guided
    ? `<div class="guided-disclosure" role="note">
        <span class="guided-disclosure-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
        </span>
        <div class="guided-disclosure-body">
          <div class="guided-disclosure-title">${i18nT("Profilo guidato")}</div>
          <div class="guided-disclosure-text">${escapeHtml(String(targetUser?.bio || "").trim() || GUIDED_DISCLOSURE_FALLBACK)}</div>
        </div>
      </div>`
    : "";
  const photoURL = targetUser?.photoURL || "";
  const avatarContent = photoURL
    ? `<img src="${escapeHtml(photoURL)}" alt="Avatar" loading="lazy" decoding="async">`
    : escapeHtml(initials(name));
  const handle = `@${String(targetUser?.displayNameLower || uid).slice(0, 20)}`;
  // `stats.reviewsCount` non lo aggiorna nessuno (nasce 0 e resta 0): su ogni
  // profilo altrui il contatore mostrava 0. La fonte vera e' `ratingsCount`
  // (titoli votati), mantenuto server-side e riconciliato ogni settimana.
  const ratedCount = Number(
    activitySummary?.ratedTitlesCount ?? targetUser?.stats?.ratingsCount ?? 0
  ) || 0;
  const watchedCount = Number(activitySummary?.watchedTitlesCount || targetUser?.stats?.watchedCount || 0) || 0;

  const relationshipPromise = (viewer && viewer.uid !== uid)
    ? getRelationshipState(viewer.uid, uid).catch(() => ({ isFollowing: false }))
    : Promise.resolve(null);

  const [followers, following, rel] = await Promise.all([
    listFollowers(uid).catch(() => []),
    listFollowing(uid).catch(() => []),
    relationshipPromise,
  ]);

  const shareButtonHtml = `
    <button id="btnShareProfile" class="user-menu-btn" type="button" aria-label="${i18nT("Condividi profilo")}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>
    </button>
  `;

  let actionHtml = "";
  if (viewer && viewer.uid !== uid) {
    actionHtml = `
      <div class="user-profile-actions">
        <button id="btnFollow" class="user-follow-btn ${rel?.isFollowing ? "is-following" : "is-primary"}" type="button">
          ${rel?.isFollowing ? "Seguito" : i18nT("Segui")}
        </button>
        ${shareButtonHtml}
        <button id="btnProfileMenu" class="user-menu-btn" type="button" aria-label="${i18nT("Azioni profilo")}">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.9"></circle><circle cx="12" cy="12" r="1.9"></circle><circle cx="19" cy="12" r="1.9"></circle></svg>
        </button>
      </div>
    `;
  } else if (!viewer) {
    actionHtml = `
      <div class="user-profile-actions">
        <a href="/login.html" class="user-follow-btn is-primary">${i18nT("Accedi per seguire")}</a>
        ${shareButtonHtml}
      </div>
    `;
  }

  profileEl.innerHTML = `
    <div class="profile-hero-identity">
      <div class="profile-hero-avatar" style="cursor:default;">
        <div class="profile-hero-avatar-inner">${avatarContent}</div>
      </div>
      <div class="profile-hero-meta">
        <h1 class="profile-hero-name">${escapeHtml(name)} ${verifiedBadgeHtml}${guidedBadgeHtml}</h1>
        <p class="profile-hero-handle">${escapeHtml(handle)}</p>
      </div>
    </div>
    <div class="profile-hero-stats" aria-label=i18nT("Statistiche profilo")>
      <div class="profile-hero-stat">
        <span class="profile-hero-stat-value">${escapeHtml(String(watchedCount))}</span>
        <span class="profile-hero-stat-label">${i18nT("Visti")}</span>
      </div>
      <span class="profile-hero-stat-divider" aria-hidden="true"></span>
      <div class="profile-hero-stat">
        <span class="profile-hero-stat-value">${escapeHtml(String(ratedCount))}</span>
        <span class="profile-hero-stat-label">${i18nT("Voti")}</span>
      </div>
      <span class="profile-hero-stat-divider" aria-hidden="true"></span>
      <button id="followersBlock" class="profile-hero-stat" type="button" aria-label="Vedi follower">
        <span class="profile-hero-stat-value">${escapeHtml(String(followers.length))}</span>
        <span class="profile-hero-stat-label">${i18nT("Follower")}</span>
      </button>
      <span class="profile-hero-stat-divider" aria-hidden="true"></span>
      <button id="followingBlock" class="profile-hero-stat" type="button" aria-label="Vedi seguiti">
        <span class="profile-hero-stat-value">${escapeHtml(String(following.length))}</span>
        <span class="profile-hero-stat-label">${i18nT("Seguiti")}</span>
      </button>
    </div>
    ${actionHtml}
    ${guidedDisclosureHtml}
  `;

  // Nickname lunghi: riduci il font per stare su una riga (niente wrap/sfarfallio).
  fitProfileName(qs(".profile-hero-name", profileEl), name);

  qs("#followersBlock")?.addEventListener("click", () => openConnectionsModal(i18nT("Follower"), Promise.resolve(followers)));
  qs("#followingBlock")?.addEventListener("click", () => openConnectionsModal(i18nT("Seguiti"), Promise.resolve(following)));
  qs("#btnProfileMenu")?.addEventListener("click", openProfileMenuModal);

  qs("#btnShareProfile")?.addEventListener("click", async () => {
    const shareUrl = `https://somto.it/user.html?uid=${encodeURIComponent(uid)}`;
    const shareData = { title: `${name} su Somto`, url: shareUrl };
    try {
      if (navigator.share) {
        await navigator.share(shareData);
        return;
      }
    } catch (err) {
      if (err?.name === "AbortError") return; // utente ha chiuso lo share sheet
      console.error(err);
    }
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast(i18nT("Link del profilo copiato!"), i18nT("Condividi"));
    } catch (err) {
      console.error(err);
      toast(i18nT("Impossibile copiare il link"), i18nT("Condividi"));
    }
  });

  const btnFollow = qs("#btnFollow");
  if (btnFollow && viewer) {
    btnFollow.addEventListener("click", async () => {
      await runWithButtonLoading(btnFollow, async () => {
        try {
          const rel = await getRelationshipState(viewer.uid, uid).catch(() => ({ isFollowing: false }));
          if (rel.isFollowing) {
            await unfollowUser(viewer.uid, uid);
            toast(i18nT("Non lo segui più."), "Follow");
          } else {
            await followUser(viewer.uid, uid);
            toast(i18nT("Ora lo segui!"), "Follow");
          }
          const nextSummary = await getPublicProfileActivitySummary(uid).catch(() => activitySummary);
          await renderUserHeader(targetUser, viewer, nextSummary || activitySummary);
        } catch (err) {
          console.error(err);
          toast(err?.message || i18nT("Errore"), "Follow", { type: "error" });
        }
      }, { loadingLabel: i18nT("Aggiornamento...") });
    });
  }
}

function renderLibraryUI() {
  if (!listEl) return;

  // Filtro TIPO multi-select dai conteggi del riepilogo. Set vuoto = tutti.
  let filtered = votesTypeIsAll()
    ? allLibraryData
    : allLibraryData.filter((d) => votesSelectedCategories.has(deriveProfileContentCategory(d.title)));

  // Filtro STATO (In corso / Votati / Rivisti), asse indipendente dal tipo.
  if (votesStatusFilter !== "all") {
    filtered = filtered.filter((d) => {
      if (votesStatusFilter === "rated") return voteItemIsRated(d.item);
      if (votesStatusFilter === "in_progress") return voteItemIsInProgress(d.item);
      if (votesStatusFilter === "rewatched") return voteItemIsRewatched(d.item);
      return true;
    });
  }

  if (votesSearchQuery) {
    const q = votesSearchQuery.toLowerCase();
    filtered = filtered.filter((d) => (d.title.name || "").toLowerCase().includes(q));
  }

  const totalPages = Math.ceil(filtered.length / VOTES_PER_PAGE);
  if (votesCurrentPage > totalPages) votesCurrentPage = Math.max(1, totalPages);
  const start = (votesCurrentPage - 1) * VOTES_PER_PAGE;
  const pageData = filtered.slice(start, start + VOTES_PER_PAGE);

  // Filtro TIPO ora vive nel riepilogo cliccabile; qui resta solo l'asse STATO.
  const statusPills = `
    <div class="profile-status-chips">
      <button class="profile-status-chip ${votesStatusFilter === "all" ? "active" : ""}" onclick="setUserVotesStatusFilter('all')">${i18nT("Tutti")}</button>
      <button class="profile-status-chip ${votesStatusFilter === "in_progress" ? "active" : ""}" onclick="setUserVotesStatusFilter('in_progress')">${i18nT("In corso")}</button>
      <button class="profile-status-chip ${votesStatusFilter === "rated" ? "active" : ""}" onclick="setUserVotesStatusFilter('rated')">${i18nT("Votati")}</button>
      <button class="profile-status-chip ${votesStatusFilter === "rewatched" ? "active" : ""}" onclick="setUserVotesStatusFilter('rewatched')">${i18nT("Rivisti")}</button>
    </div>
  `;

  if (!filtered.length) {
    const statusEmptyMessages = {
      in_progress: i18nT("Nessuna serie in corso"),
      rated: i18nT("Nessun titolo votato con questi filtri."),
      rewatched: i18nT("Nessun titolo rivisto (rewatch)."),
    };
    const emptyMsg = votesSearchQuery
      ? i18nT("Prova a cambiare filtro o a cercare un altro titolo nella libreria dell'utente.")
      : (votesStatusFilter !== "all"
        ? (statusEmptyMessages[votesStatusFilter] || i18nT("Nessun titolo con questo stato."))
        : (votesTypeIsAll() ? i18nT("Appena l'utente guarda e vota titoli, compariranno qui.") : i18nT("Nessun titolo in questa categoria.")));
    listEl.innerHTML = `
      ${statusPills}
      <div class="profile-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
        </svg>
        <p class="profile-empty-title">${i18nT("Nessun titolo trovato")}</p>
        <p class="profile-empty-text">${emptyMsg}</p>
      </div>
    `;
    return;
  }

  const summaryLabel = votesSearchQuery
    ? `${filtered.length} risultati`
    : i18nT("{count} titoli", { count: filtered.length });

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
    // Badge "a che punto è" solo per le serie presenti nella mappa progresso (i film non lo ricevono).
    const progressBadge = isSeriesCategory(title) ? buildSeriesProgressBadge(title.id) : "";

    return `
      <a class="profile-poster-tile" href="/title.html?id=${encodeURIComponent(title.id)}">
        <div class="profile-poster-frame">
          ${poster}
          ${badge}
          ${progressBadge}
        </div>
        <div class="profile-poster-meta">
          <div class="profile-poster-title">${escapeHtml(title.name || "")}</div>
          <div class="profile-poster-sub">${typeLabel}</div>
        </div>
      </a>
    `;
  }).join("");

  let pagination = "";
  if (totalPages > 1) {
    pagination = `
      <div class="votes-pagination">
        <button class="page-btn" ${votesCurrentPage <= 1 ? "disabled" : ""} onclick="changeUserVotesPage(${votesCurrentPage - 1})">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"></polyline></svg>
        </button>
        <span class="page-info">${votesCurrentPage} / ${totalPages}</span>
        <button class="page-btn" ${votesCurrentPage >= totalPages ? "disabled" : ""} onclick="changeUserVotesPage(${votesCurrentPage + 1})">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </button>
      </div>
    `;
  }

  listEl.innerHTML = `
    ${statusPills}
    <div class="profile-list-summary">${summaryLabel}</div>
    <div class="profile-poster-grid">${cards}</div>
    ${pagination}
  `;
}

async function loadLibraryData(targetUser, activitySummary) {
  if (!listEl) return;
  listEl.innerHTML = `<div class="hint">${i18nT("Caricamento...")}</div>`;

  try {
    // getPublicProfileSeriesProgress non dipende dagli item della libreria: la
    // lanciamo subito, in parallelo a listMyLibrary, invece di aspettarla dopo.
    const progressPromise = getPublicProfileSeriesProgress(uid).catch(() => ({}));
    const items = await listMyLibrary(uid, { max: 500 });
    // Batched read invece di N+1 (1 query/30 id, cache 60s).
    const ids = items.map(i => i.titleId).filter(Boolean);
    const [titlesMap, progress] = await Promise.all([
      getTitlesByIds(ids).catch(() => new Map()),
      progressPromise,
    ]);
    seriesProgressMap = progress && typeof progress === "object" ? progress : {};
    allLibraryData = [];

    for (let idx = 0; idx < items.length; idx += 1) {
      const item = items[idx];
      const title = titlesMap.get(item.titleId);
      if (title) allLibraryData.push({ item, title });
    }

    allLibraryData.sort((a, b) => {
      return getLibrarySortTime(b.item) - getLibrarySortTime(a.item);
    });

    votesCurrentPage = 1;
    votesSelectedCategories.clear();
    votesStatusFilter = "all";
    syncCategoryStripActive();
    renderLibraryUI();
  } catch (err) {
    console.error("Errore caricamento libreria:", err);
    listEl.innerHTML = `<div class="hint">${i18nT("Errore nel caricamento.")}</div>`;
  }
}

window.setUserVotesStatusFilter = function(status) {
  votesStatusFilter = status;
  votesCurrentPage = 1;
  renderLibraryUI();
};

window.changeUserVotesPage = function(page) {
  votesCurrentPage = page;
  renderLibraryUI();
  listEl?.scrollIntoView({ behavior: "smooth", block: "start" });
};

votesSearchInput?.addEventListener("input", (ev) => {
  votesSearchQuery = String(ev.target.value || "").trim();
  votesCurrentPage = 1;
  renderLibraryUI();
});

tabVotati?.addEventListener("click", () => {
  tabVotati.classList.add("active");
  if (panelVotati) panelVotati.style.display = "block";
});

btnCloseConnections?.addEventListener("click", closeConnectionsModal);
connectionsModal?.querySelector(".modal-backdrop")?.addEventListener("click", closeConnectionsModal);
btnCloseProfileMenu?.addEventListener("click", closeProfileMenuModal);
profileMenuModal?.querySelector(".modal-backdrop")?.addEventListener("click", closeProfileMenuModal);

btnProfileReport?.addEventListener("click", async () => {
  if (!currentViewer) {
    location.href = "/login.html";
    return;
  }
  try {
    const targetName = currentTargetUser?.displayName || uid;
    const reason = prompt(i18nT("Motivo della segnalazione (es. spam, contenuti inappropriati, abuso):")) || "";
    if (!reason.trim()) return;
    const shouldSend = await showConfirm(i18nT("Inviare la segnalazione su {targetName}?", { targetName }));
    if (!shouldSend) return;
    await runWithButtonLoading(btnProfileReport, async () => {
      await sendReport({
        type: "user",
        targetId: uid,
        reason: reason.trim(),
        fromUid: currentViewer.uid,
      });
      closeProfileMenuModal();
      toast("Segnalazione inviata. Grazie!", i18nT("Segnala"));
    }, { loadingLabel: i18nT("Invio...") });
  } catch (err) {
    console.error(err);
    toast(err?.message || i18nT("Errore durante la segnalazione"), i18nT("Segnala"));
  }
});

btnProfileBlock?.addEventListener("click", async () => {
  if (!currentViewer) return void (location.href = "/login.html");
  const blocked = await isUserBlocked(currentViewer.uid, uid).catch(() => false);
  const confirmed = await showConfirm(blocked
    ? i18nT("Sbloccare questo utente? Tornerai a vedere i suoi contenuti.")
    : i18nT("Bloccare questo utente? I suoi contenuti verranno nascosti dal tuo feed."));
  if (!confirmed) return;
  try {
    await runWithButtonLoading(btnProfileBlock, async () => {
      if (blocked) await unblockUser(currentViewer.uid, uid);
      else await blockUser(currentViewer.uid, uid);
      btnProfileBlock.textContent = blocked ? i18nT("Blocca utente") : i18nT("Sblocca utente");
      closeProfileMenuModal();
      toast(blocked ? i18nT("Utente sbloccato.") : i18nT("Utente bloccato."), "Sicurezza");
    }, { loadingLabel: i18nT("Aggiornamento...") });
  } catch (err) {
    console.error(err);
    toast(i18nT("Operazione non riuscita. Riprova."), "Sicurezza");
  }
});

initTabbar();

initAuthGuard({
  requireAuth: false,
  onReady: async (user) => {
    if (user) {
      if (user.uid === uid) {
        location.replace("/account.html");
        return;
      }
      if (navAccount) {
        navAccount.textContent = i18nT("Account");
        navAccount.href = "/account.html";
      }
    } else if (navAccount) {
      navAccount.textContent = i18nT("Accedi");
      navAccount.href = "/login.html";
    }

    // ensureUserDoc riguarda il doc del VIEWER, non del profilo target: è indipendente
    // da getUserPublic/getPublicProfileActivitySummary (che leggono il target) → parallelo.
    const [, target, activitySummaryRaw, blocked] = await Promise.all([
      user ? ensureUserDoc(user).catch(() => {}) : Promise.resolve(),
      getUserPublic(uid).catch(() => null),
      getPublicProfileActivitySummary(uid).catch(() => null),
      user ? isUserBlocked(user.uid, uid).catch(() => false) : Promise.resolve(false),
    ]);
    if (btnProfileBlock) btnProfileBlock.textContent = blocked ? i18nT("Sblocca utente") : i18nT("Blocca utente");

    if (!target) {
      profileEl.innerHTML = `<div class="profile-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"></circle><path d="M9.5 9.5h.01M14.5 9.5h.01M8.5 15.5a4.5 4.5 0 0 1 7 0"></path></svg>
        <p class="profile-empty-title">${i18nT("Utente non trovato")}</p>
        <p class="profile-empty-text">${i18nT("Il profilo che cercavi non esiste o non è più disponibile.")}</p>
      </div>`;
      listEl.innerHTML = "";
      return;
    }

    // Mostra subito il watch time dai dati pubblici cached.
    if (target?.stats) {
      applyWatchTimeSummary(Number(target.stats.totalWatchMinutes || 0) || 0);
    }

    const activitySummary = activitySummaryRaw || {
      watchedTitlesCount: Number(target?.stats?.watchedCount || 0) || 0,
      ratedTitlesCount: Number(target?.stats?.ratingsCount || 0) || 0,
      totalWatchMinutes: Number(target?.stats?.totalWatchMinutes || 0) || 0,
      rewatchCount: Number(target?.stats?.rewatchCount || 0) || 0,
    };

    // Refresh con il dato server-side (può differire dalla cache su target?.stats).
    applyWatchTimeSummary(activitySummary?.totalWatchMinutes || 0);
    renderCategoryStrip(activitySummary?.byCategory);

    await renderUserHeader(target, user, activitySummary);
    // Library data non blocca più watch time (era chiamato qui dentro a fine load).
    await loadLibraryData(target, activitySummary);
  },
});
