// community.page.js - Community Feed (Facebook-style MVP) + composer + badge
// notifiche + "Discussioni attive". Ex home.page.js: la parte feed/composer/
// notifiche/leaderboard è stata spostata qui pari pari da Home (che ora è un
// launchpad personale senza feed sociale). Vedi home.page.js per la parte
// rimasta (hero + righe discovery).

import { initAuthGuard } from "../components/authGuard.js";
import { t as i18nT } from "../i18n/index.js";
import { initTabbar } from "../utils/tabbar.js";
import { ensureUserDoc, listFriends, listFollowing, getUserPublic, searchUsersByPrefix } from "../api/users.api.js";
import { listMyLibrary } from "../api/library.api.js";
import { listMyTitleRatings } from "../api/ratings.api.js";
import { getTitleById, getTitlesByIds, searchTitlesSmart, listRecentTitlesByUsers } from "../api/titles.api.js";
import { listGenres } from "../api/genres.api.js";
import { listPublicThreads, listPublicThreadsByTitleIds, ensurePublicThread, sendThreadMessage } from "../api/threads.api.js";
import {
  listRecentPosts,
  listPublicPostsPage,
  listCommentPostsPage,
  listCommentPostsByTitleIds,
  createPost,
  createSharedPost,
  isPostLikedByMe,
  togglePostLike,
  listPostComments,
  addPostComment,
  togglePostCommentLike,
  getPostSocialCounts,
  registerPostShare,
} from "../api/posts.api.js";
import { listCompletedTitleIDs, markTitleCompleted, getMyTitleStatesByIds } from "../api/titleStates.api.js";
import { mountSpoilerComposer } from "../components/composerSpoiler.js";
import { attachSpoilerHandlers } from "../components/spoilerGate.js";
import {
  attachMentionAutocomplete,
  renderMentionRichText,
  searchMentionTargets,
} from "../components/mentionAutocomplete.js";
import {
  normalizeProgressEntry,
  normalizeSpoilerScope,
  isUnlockedByProgress,
  wrapProgressSpoiler,
  scopeLabel,
} from "../components/spoilerProgress.js";
import { listRecommendationsForMe } from "../api/recommendations.api.js";
import { listFeedEventsPage } from "../api/feed.api.js";
import { addToWatchlist, removeFromWatchlist, isInWatchlist, getMyWatchlist } from "../api/watchlist.api.js";
import { listMyTitleUpdatePreferences, setTitleUpdatePreference } from "../api/titleUpdates.api.js";
import { getUnreadCount, onNotificationsChange, getMyNotifications, markAsRead, markAllAsRead } from "../api/notifications.api.js";
import { getCurrentEvent } from "../api/events.api.js";
import { mountNotificationPermissionBanner } from "../components/notifyPermissionBanner.js";
import { sendReport } from "../api/reports.api.js";
import { listBlockedUserIds } from "../api/safety.api.js";
import { toast } from "../components/toast.js";
import { qs, escapeHtml } from "../utils/dom.js";
import { runWithButtonLoading } from "../utils/loading.js";
import { showErrorBanner, hideErrorBanner } from "../utils/errorBanner.js";
import { attachCharCounter } from "../utils/charCounter.js";
import { logEvent, setAnalyticsUser } from "../analytics.js";
import { trackProductEvent } from "../api/productAnalytics.js";

initTabbar();

// Uid sintetico usato da publishOfficialUpdate (functions/lib/officialUpdates.js)
// per postare gli aggiornamenti ufficiali Somto. Stesso segnale usato da iOS
// (CommunityView.swift `isOfficialUpdate = activity.actor.id == "somto_official"`)
// per mostrare il badge "Ufficiale" — nessun campo dedicato viaggia nei
// feedEvents, quindi replichiamo l'euristica invece di aggiungerne uno lato
// server solo per questo badge.
const SOMTO_OFFICIAL_UID = "somto_official";

// ==============================
// DOM
// ==============================

const navAccount = qs("#navAccount");
const feedEl = qs("#feed");
const feedLoadMoreEl = qs("#feedLoadMore");
const feedTabsEl = qs("#feedTabs");
const leaderboardEl = qs("#leaderboard");
const btnReload = qs("#btnReload");
const quickActionEl = qs("#quickAction");
const socialInsightEl = qs("#socialInsight");
const currentEventEl = qs("#currentEvent");

const composer = qs("#composer");
const composerAvatar = qs("#composerAvatar");
const composerName = qs("#composerName");
const composerText = qs("#composerText");
const composerMentionDropdown = qs("#composerMentionDropdown");
const composerSubmit = qs("#composerSubmit");
const composerVisibility = qs("#composerVisibility");

const notificationLink = qs("#notificationLink");
const notificationBadge = qs("#notificationBadge");
const notificationDropdown = qs("#notificationDropdown");
const notificationDropdownList = qs("#notificationDropdownList");
const notifMarkAll = qs("#notifMarkAll");

const homeSearch = qs("#homeSearch");
const quickSearch = qs("#quickSearch");
const headerSearchBtn = qs("#headerSearchBtn");
const quickSearchResults = qs("#quickSearchResults");

// "Di cosa parliamo?" — starter discussione su titolo + prompt composer.
const discussionStarterEl = qs("#discussionStarter");
const btnStartTitleDiscussion = qs("#btnStartTitleDiscussion");
const discussionTitleSearchEl = qs("#discussionTitleSearch");
const discussionTitleSearchInput = qs("#discussionTitleSearchInput");
const discussionTitleSearchResultsEl = qs("#discussionTitleSearchResults");
const discussionPromptChips = document.querySelectorAll(".discussion-prompt-chip");
const homeQuery = new URLSearchParams(window.location.search || "");
const initialHomeTab = (() => {
  const value = String(homeQuery.get("view") || homeQuery.get("tab") || "").trim().toLowerCase();
  return value === "classifiche" ? "classifiche" : "feed";
})();

// ==============================
// State
// ==============================

// Cleanup pool: unsub di listener Firestore al pagehide (evita leak di canali
// onSnapshot quando l'utente naviga fra pagine PWA).
const _unsubs = [];
function trackUnsub(u) { if (typeof u === "function") _unsubs.push(u); return u; }
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    while (_unsubs.length) { try { _unsubs.pop()(); } catch {} }
  });
}

let unsubscribeNotifications = null;
let genreMap = new Map();
window.__2WATCH_LAST_FEED_MODE = "boot";

const state = {
  me: null,
  sources: [],
  sourceSet: new Set(),
  userMap: new Map(),
  titleMap: new Map(),
  postMap: new Map(),
  postUi: new Map(),
  items: [],
  cursor: 0,
  loadingMore: false,
  io: null,
  leaderboardData: null,
  leaderboardInput: null,
  contributionTotals: new Map(),
  globalLeaderboard: undefined, // undefined=loading, null=empty doc, object=data, {_error:true}=error
  activeTab: initialHomeTab,
  leaderboardSubTab: "amici",
  feedBuildSeq: 0,
  feedMode: "legacy",
  feedCursorDoc: null,
  feedHasMore: false,
  deepLinkPostId: String(new URLSearchParams(window.location.search).get("post") || "").trim(),
  deepLinkHandled: false,
  // Ranked mix (community-alive): profilo generi (cache per sessione pagina),
  // cursore per "Carica altri" post pubblici, ultimo window di post pubblici
  // già mixati (per il load-more).
  genreProfile: null, // Promise|null — cache session-scoped, vedi getMyGenreProfile()
  publicPostsCursorDoc: null,
  publicPostsHasMore: false,
  // Set<uid> bloccati dal viewer corrente (safety.api.js) — ricalcolato a ogni
  // buildHomeFeed, usato per filtrare gli item del feed (iniziali + load-more).
  blockedUserIds: new Set(),
  // Gate anti-spoiler per progresso: `titleId -> entry` (normalizeProgressEntry)
  // per i titoli già interrogati, + set dei titleId già chiesti (anche quelli
  // assenti dalla libreria, per non richiederli a ogni chunk).
  progressMap: new Map(),
  progressAsked: new Set(),
  // Preferenze "aggiornamenti titolo" del viewer: `titleId -> mode`. Caricate
  // una volta sola per sessione di pagina, servono al bottone "Segui" delle
  // card, che deve nascere gia' nello stato giusto.
  titleUpdatePrefs: new Map(),
  titleUpdatePrefsLoaded: null,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const HOME_SKELETON_MIN_MS = 60;
const CONTRIBUTION_WEIGHTS = Object.freeze({
  title_added: 3,
  post: 2,
  thread: 2,
  rating: 1,
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function ensureMinLoading(startMs, minMs = HOME_SKELETON_MIN_MS) {
  const elapsed = Date.now() - startMs;
  if (elapsed < minMs) {
    await sleep(minMs - elapsed);
  }
}

function tsToMillis(ts) {
  if (!ts) return 0;
  if (typeof ts === "number") return ts;
  try {
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (ts.seconds) return (ts.seconds * 1000) + Math.floor((ts.nanoseconds || 0) / 1e6);
  } catch (_) {}
  return 0;
}

function timeText(ts) {
  const ms = tsToMillis(ts);
  if (!ms) return "";
  try {
    const d = new Date(ms);
    return d.toLocaleString("it-IT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function dayKeyFromMs(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfDayMs(ms) {
  const d = new Date(ms || Date.now());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function computeCurrentStreak(daySet, nowMs = Date.now()) {
  if (!daySet || !daySet.size) return 0;
  let cursor = startOfDayMs(nowMs);
  if (!daySet.has(dayKeyFromMs(cursor))) {
    cursor -= DAY_MS;
  }
  let streak = 0;
  while (daySet.has(dayKeyFromMs(cursor))) {
    streak++;
    cursor -= DAY_MS;
  }
  return streak;
}

function initials(name) {
  const s = String(name || "").trim();
  if (!s) return "?";
  const parts = s.split(/\s+/).filter(Boolean);
  const a = (parts[0] || "?").slice(0, 1);
  const b = parts.length > 1 ? (parts[parts.length - 1] || "").slice(0, 1) : "";
  return (a + b).toUpperCase();
}

// ==============================
// Icons (Lucide-like, inline SVG)
// ==============================

function iconMessageCircle(size = 18) {
  return `
    <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 15a4 4 0 0 1-4 4H7l-4 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
    </svg>
  `;
}

function iconStar(size = 16) {
  return `
    <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  `;
}

function iconBookmark(size = 18) {
  return `
    <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  `;
}

function iconBell(size = 16) {
  return `
    <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  `;
}

// ==============================
// Notifiche badge + dropdown
// ==============================

async function initNotificationsBadge(uid) {
  if (!notificationLink || !notificationBadge) return;

  try {
    const count = await getUnreadCount(uid);
    updateNotificationBadge(count);

    if (unsubscribeNotifications) unsubscribeNotifications();
    unsubscribeNotifications = trackUnsub(onNotificationsChange(uid, (notifications) => {
      updateNotificationBadge(notifications.length);
    }));
  } catch (err) {
    console.error("Errore notifiche:", err);
  }
}

function updateNotificationBadge(count) {
  if (!notificationLink || !notificationBadge) return;

  notificationLink.style.display = "inline-flex";
  if (count > 0) {
    notificationBadge.textContent = count > 99 ? "99+" : String(count);
    notificationBadge.style.display = "inline-block";
  } else {
    notificationBadge.style.display = "none";
  }
}

let notifOpen = false;
let outsideNotifListenerAttached = false;

function closeNotificationsDropdown() {
  notifOpen = false;
  if (notificationDropdown) notificationDropdown.style.display = "none";
}

function openNotificationsDropdown() {
  notifOpen = true;
  if (notificationDropdown) notificationDropdown.style.display = "block";
}

async function renderNotificationsList(uid) {
  if (!notificationDropdownList) return;
  notificationDropdownList.innerHTML = `<div class="hint">${i18nT("Caricamento…")}</div>`;

  try {
    const items = await getMyNotifications(uid, { includeRead: true, max: 20 });
    if (!items.length) {
      notificationDropdownList.innerHTML = `<div class="hint">${i18nT("Nessuna notifica per ora.")}</div>`;
      return;
    }

    const fromUids = [...new Set(items.map(n => String(n.fromUid || "").trim()).filter(Boolean))];
    await ensureUsersCached(fromUids);

    const viewItems = items.map(n => {
      const fromName = n.data?.fromName || "Qualcuno";
      const type = String(n.type || "");
      let title = i18nT("Nuova attività");
      let text = "";
      let url = "/notifications.html";
      let icon = "🔔";

      if (type === "recommendation") {
        icon = "🎬";
        title = i18nT("{fromName} ti ha consigliato un titolo", { fromName });
        url = n.data?.titleId ? `/title.html?id=${encodeURIComponent(n.data.titleId)}` : url;
      } else if (type === "follow") {
        icon = "👀";
        title = `${fromName} ha iniziato a seguirti`;
        url = n.fromUid ? `/user.html?uid=${encodeURIComponent(n.fromUid)}` : url;
      } else if (type === "friend_request") {
        // Grafo amici dismesso (fase 1): porta al profilo del mittente.
        icon = "🤝";
        title = i18nT("{fromName} ti ha inviato una richiesta", { fromName });
        url = n.fromUid ? `/user.html?uid=${encodeURIComponent(n.fromUid)}` : url;
      } else if (type === "friend_accept") {
        icon = "✅";
        title = i18nT("{fromName} ha accettato la richiesta", { fromName });
        url = n.fromUid ? `/user.html?uid=${encodeURIComponent(n.fromUid)}` : url;
      } else if (type === "thread_message") {
        icon = "💬";
        title = `${fromName} ha scritto nel thread`;
        text = String(n.data?.preview || i18nT("nuovo messaggio")).slice(0, 100);
        url = n.data?.threadId ? `/thread.html?tid=${encodeURIComponent(n.data.threadId)}` : "/threads.html";
      } else if (type === "thread_mention") {
        icon = "@";
        title = i18nT("{fromName} ti ha menzionato in un thread", { fromName });
        text = String(n.data?.preview || "").slice(0, 100);
        url = n.data?.threadId ? `/thread.html?tid=${encodeURIComponent(n.data.threadId)}` : "/threads.html";
      } else if (type === "post_mention") {
        icon = "@";
        const ctx = String(n.data?.context || "");
        title = ctx === "rating_comment"
          ? i18nT("{fromName} ti ha menzionato su un voto", { fromName })
          : `${fromName} ti ha menzionato`;
        text = String(n.data?.preview || "").slice(0, 100);
        const targetPost = String(n.data?.postId || n.data?.eventId || "").trim();
        url = targetPost ? `/community.html?post=${encodeURIComponent(targetPost)}` : "/community.html";
      } else if (type === "post_like") {
        icon = "❤️";
        title = i18nT("{fromName} ha messo like al tuo post", { fromName });
        const targetPost = String(n.data?.postId || n.data?.eventId || "").trim();
        url = targetPost ? `/community.html?post=${encodeURIComponent(targetPost)}` : "/community.html";
      } else if (type === "post_comment") {
        icon = "💬";
        title = i18nT("{fromName} ha commentato il tuo post", { fromName });
        text = String(n.data?.preview || "").slice(0, 100);
        const targetPost = String(n.data?.postId || n.data?.eventId || "").trim();
        url = targetPost ? `/community.html?post=${encodeURIComponent(targetPost)}` : "/community.html";
      } else if (type === "comment_like") {
        icon = "👍";
        title = i18nT("{fromName} ha messo like al tuo commento", { fromName });
        const targetPost = String(n.data?.postId || n.data?.eventId || "").trim();
        url = targetPost ? `/community.html?post=${encodeURIComponent(targetPost)}` : "/community.html";
      } else if (type === "rating_like") {
        icon = "⭐";
        title = i18nT("{fromName} ha reagito al tuo voto", { fromName });
        url = n.data?.titleId ? `/title.html?id=${encodeURIComponent(n.data.titleId)}` : "/";
      } else if (type === "rating_comment") {
        icon = "🗨️";
        title = i18nT("{fromName} ha commentato il tuo voto", { fromName });
        text = String(n.data?.preview || "").slice(0, 100);
        url = n.data?.titleId ? `/title.html?id=${encodeURIComponent(n.data.titleId)}` : "/";
      } else if (type === "watched_with_tag") {
        icon = "🍿";
        const movieName = String(n.data?.titleName || i18nT("un titolo"));
        title = i18nT("{fromName} ti ha taggato in una visione", { fromName });
        text = i18nT("Hai visto {movieName} con lui/lei. Ti va di votarlo?", { movieName });
        url = n.data?.titleId ? `/title.html?id=${encodeURIComponent(n.data.titleId)}&focus=rating` : "/watchlist.html";
      } else if (type === "engagement_nudge") {
        icon = "✨";
        title = String(n.data?.message || i18nT("Nuovi titoli ti aspettano su Somto"));
        url = String(n.data?.ctaUrl || "/");
      } else if (type === "friend_post") {
        icon = "📝";
        title = i18nT("{fromName} ha pubblicato un post", { fromName });
        text = String(n.data?.preview || "").slice(0, 100);
        const targetPost = String(n.data?.postId || "").trim();
        url = targetPost ? `/community.html?post=${encodeURIComponent(targetPost)}` : "/community.html";
      } else if (type === "admin_import_started") {
        icon = "📥";
        const src = String(n.data?.source || "");
        const srcLabel = src === "netflix_csv" ? "Netflix"
          : (src === "tvtime_gdpr" || src === "tvtime_refract") ? "TV Time"
          : src === "trakt" ? "Trakt" : i18nT("un servizio");
        const rows = Number(n.data?.totalRows || 0);
        title = i18nT("{fromName} ha avviato un import {srcLabel}", { fromName, srcLabel });
        text = rows > 0 ? `${rows} righe da elaborare` : "";
        const importUid = String(n.data?.importUid || n.fromUid || "").trim();
        url = importUid ? `/user.html?uid=${encodeURIComponent(importUid)}` : "/admin-analytics.html";
      }

      const fromUid = String(n.fromUid || "").trim();
      const fromUser = fromUid ? state.userMap.get(fromUid) : null;
      const photo = fromUser?.photoURL || "";
      const avatar = photo
        ? `<img alt="" src="${escapeHtml(photo)}" loading="lazy" decoding="async">`
        : escapeHtml(icon === "@" ? "@" : initials(fromName));

      return {
        id: n.id,
        type,
        read: !!n.read,
        avatar,
        title: escapeHtml(title),
        text: escapeHtml(text),
        when: escapeHtml(timeText(n.createdAt)),
        url: escapeHtml(url),
      };
    });

    notificationDropdownList.innerHTML = viewItems.map(v => {
      const readCls = v.read ? "read" : "";
      return `
        <a class="notif-item ${readCls}" href="${v.url}" data-notif-id="${escapeHtml(v.id)}" data-notif-type="${escapeHtml(v.type || "unknown")}">
          <div class="notif-dot" aria-hidden="true"></div>
          <div class="notif-avatar" aria-hidden="true">${v.avatar}</div>
          <div class="notif-body">
            <div class="notif-title">${v.title}</div>
            ${v.text ? `<div class="notif-text">${v.text}</div>` : ""}
            ${v.when ? `<div class="notif-meta">${v.when}</div>` : ""}
          </div>
          <div class="notif-chevron" aria-hidden="true">›</div>
        </a>
      `;
    }).join("");

    notificationDropdownList.querySelectorAll("[data-notif-id]").forEach(a => {
      a.addEventListener("click", async (ev) => {
        // keep browser default behavior for modified clicks/new-tab open.
        if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0) return;
        ev.preventDefault();
        const id = a.getAttribute("data-notif-id");
        const notifType = a.getAttribute("data-notif-type") || "unknown";
        const href = a.getAttribute("href") || "/notifications.html";
        if (!id) {
          window.location.href = href;
          return;
        }
        try { await markAsRead(uid, id); } catch (_) {}
        void logEvent("notification_opened", {
          notification_type: notifType,
          destination: href,
        });
        a.classList.add("read");
        closeNotificationsDropdown();
        window.location.href = href;
      });
    });
  } catch (e) {
    console.error(e);
    notificationDropdownList.innerHTML = `<div class="hint">${i18nT("Errore nel caricamento notifiche.")}</div>`;
  }
}

// ==============================
// Composer + Mention system
// ==============================

// Mention state
//
// La logica del picker sta in `components/mentionAutocomplete.js` (era copiata
// in tre composer): qui resta solo la ricerca, che ha una regola in piu' — gli
// amici pesano piu' degli sconosciuti.
let cachedFriends = null;   // lazy-loaded list of friends for @ mentions
let composerMentionCtrl = null;

async function searchCommunityMentionTargets(type, query) {
  if (type === "user" && !cachedFriends && state.me) {
    cachedFriends = await listFriends(state.me.uid).catch(() => []);
  }
  const friends = (cachedFriends || []).map((u) => {
    const cached = state.userMap.get(u.uid);
    return { ...u, displayName: cached?.displayName || u.displayName || null };
  });
  return searchMentionTargets(type, query, { friends });
}

/**
 * Picker menzioni sul composer di risposta inline della card commento.
 *
 * Era l'unico composer del feed senza picker: si poteva scrivere `@nome` e non
 * succedeva niente, perche' il token che il backend riconosce lo compone solo
 * il picker. Montarlo e' idempotente (`attachMentionAutocomplete` restituisce
 * il controller gia' agganciato), quindi si puo' chiamare sia all'apertura del
 * composer sia all'invio.
 */
function wireFeedCommentMention(composerEl) {
  if (!composerEl) return null;
  const input = composerEl.querySelector(".feed-comment-input");
  const dropdown = composerEl.querySelector("[data-feed-comment-mention='1']");
  if (!input || !dropdown) return null;
  return attachMentionAutocomplete(input, dropdown, {
    searchTargets: searchCommunityMentionTargets,
  });
}

function extractFirstTitleIdFromTaggedText(text) {
  const source = String(text || "");
  const re = /#\[[^\]]+\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(source))) {
    const rawId = String(m[1] || "").trim();
    if (!rawId || rawId.startsWith("person:")) continue;
    return rawId;
  }
  return null;
}

function autoResizeComposer() {
  if (!composerText) return;
  composerText.style.height = "auto";
  composerText.style.height = Math.min(140, composerText.scrollHeight) + "px";
}

function renderComposerAvatar(u) {
  if (composerName) {
    composerName.textContent = u?.displayName || "Tu";
  }
  if (!composerAvatar) return;
  const photo = u?.photoURL;
  if (photo) {
    composerAvatar.innerHTML = `<img alt="" src="${escapeHtml(photo)}" loading="lazy" decoding="async">`;
  } else {
    composerAvatar.textContent = initials(u?.displayName);
  }
}

function debounce(fn, wait = 150) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function wireComposer() {
  composerText?.addEventListener("input", autoResizeComposer);

  composerMentionCtrl = attachMentionAutocomplete(composerText, composerMentionDropdown, {
    searchTargets: searchCommunityMentionTargets,
    onInsert: autoResizeComposer,
  });

  // Anti-spoiler composer toggle, montato accanto al submit button.
  // Candidates: i titoli taggati nel testo + (best-effort) i recenti titoli
  // popolari sono troppo dispersivi → usiamo SOLO il primo titolo taggato dal
  // testo come opzione iniziale; viene aggiornato dinamicamente on input.
  let composerSpoilerCtrl = null;
  try {
    if (composerSubmit && !composerSubmit.__spoilerMounted) {
      const host = document.createElement("div");
      host.id = "homeSpoilerComposer";
      // Riga propria SOPRA hint+Pubblica: nella riga azioni (380px) tre
      // elementi si schiacciavano e il pannello titoli non aveva spazio.
      const actionsRow = composerSubmit.closest(".home-composer-actions");
      if (actionsRow?.parentElement) {
        actionsRow.parentElement.insertBefore(host, actionsRow);
      } else {
        composerSubmit.parentElement?.insertBefore(host, composerSubmit);
      }
      composerSpoilerCtrl = mountSpoilerComposer(host, { candidateTitles: [] });
      composerSubmit.__spoilerMounted = true;

      composerText?.addEventListener("input", () => {
        if (!composerSpoilerCtrl) return;
        const tid = extractFirstTitleIdFromTaggedText(composerMentionCtrl?.resolveTokens(composerText.value || "") || "");
        const title = tid ? state.titleMap.get(tid) : null;
        composerSpoilerCtrl.setCandidateTitles(
          tid ? [{ id: tid, name: title?.name || tid }] : []
        );
      });
    }
  } catch (err) {
    console.warn("[home] failed to mount spoiler composer", err);
  }

  composerSubmit?.addEventListener("click", () =>
    runWithButtonLoading(composerSubmit, async () => {
      if (!state.me) return;
      const rawText = String(composerText?.value || "").trim();
      if (!rawText) {
        toast(i18nT("Scrivi qualcosa"), i18nT("Post"));
        return;
      }

      const u = state.userMap.get(state.me.uid) || (await getUserPublic(state.me.uid).catch(() => null));
      const authorName = u?.displayName || "User";
      // `resolveForSend` chiude il giro anche sugli `@handle` battuti a mano:
      // senza, un tag scritto senza passare dal menu non notifica nessuno.
      const text = composerMentionCtrl
        ? await composerMentionCtrl.resolveForSend(rawText)
        : rawText;
      const taggedTitleId = extractFirstTitleIdFromTaggedText(text);
      const spoilerPayload = composerSpoilerCtrl ? composerSpoilerCtrl.getState() : { containsSpoiler: false, spoilerTitleIds: [] };
      await createPost({
        authorUid: state.me.uid,
        authorName,
        text,
        titleId: taggedTitleId || null,
        visibility: composerVisibility?.dataset?.value || composerVisibility?.value || "public",
        containsSpoiler: spoilerPayload.containsSpoiler,
        spoilerTitleIds: spoilerPayload.spoilerTitleIds,
      });
      if (composerSpoilerCtrl) composerSpoilerCtrl.reset();
      toast("Pubblicato", i18nT("Post"));
      if (composerText) {
        composerText.value = "";
        composerText.style.height = "auto";
      }
      composerMentionCtrl?.reset();

      // Reload feed (MVP: ricalcolo)
      await buildHomeFeed(state.me.uid);
    }, { loadingLabel: "Invio…" })
  );
}

// ==============================
// "Di cosa parliamo?" — starter discussione su titolo + prompt composer.
// Riusa searchTitlesSmart (stessa API della mention/quick-search) e
// ensurePublicThread (stessa dell'azione "Apri thread pubblico" sul titolo):
// nessuna nuova chiamata backend.
// ==============================

function discussionSearchResultRowHtml(t) {
  const name = escapeHtml(t.name || "");
  const year = t.year ? ` <span class="muted">(${escapeHtml(String(t.year))})</span>` : "";
  const type = t.type === "tv" ? i18nT("Serie") : i18nT("Film");
  return `
    <button type="button" class="quick-item" data-discussion-title-id="${escapeHtml(t.id)}">
      <div class="quick-item-main">
        <div class="quick-item-title">${name}${year}</div>
        <div class="quick-item-sub muted">${escapeHtml(type)}</div>
      </div>
    </button>
  `;
}

async function startTitleDiscussion(titleId) {
  if (!state.me) {
    location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
    return;
  }
  if (!titleId) return;
  try {
    const t = await ensurePublicThread({ titleId, createdBy: state.me.uid });
    window.location.href = `/thread.html?tid=${encodeURIComponent(t.id)}`;
  } catch (err) {
    console.error("[community] startTitleDiscussion error", err);
    toast(err?.message || i18nT("Errore"), i18nT("Discussione"));
  }
}

function wireDiscussionStarter() {
  if (discussionStarterEl) discussionStarterEl.style.display = "block";

  btnStartTitleDiscussion?.addEventListener("click", () => {
    if (!discussionTitleSearchEl) return;
    const isOpen = discussionTitleSearchEl.style.display !== "none";
    discussionTitleSearchEl.style.display = isOpen ? "none" : "flex";
    if (!isOpen) discussionTitleSearchInput?.focus();
  });

  const runSearch = debounce(async (term) => {
    const q = String(term || "").trim();
    if (!discussionTitleSearchResultsEl) return;
    if (!q) {
      discussionTitleSearchResultsEl.innerHTML = "";
      return;
    }
    try {
      const items = await searchTitlesSmart(q, 8).catch(() => []);
      discussionTitleSearchResultsEl.innerHTML = items.length
        ? items.map(discussionSearchResultRowHtml).join("")
        : `<div class="hint">${i18nT("Nessun titolo trovato per “{query}”.", { query: escapeHtml(q) })}</div>`;
    } catch (err) {
      console.error("[community] discussion title search error", err);
      discussionTitleSearchResultsEl.innerHTML = `<div class="hint">${i18nT("Errore nella ricerca.")}</div>`;
    }
  }, 200);

  discussionTitleSearchInput?.addEventListener("input", (e) => {
    runSearch(e.target.value);
  });

  discussionTitleSearchResultsEl?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-discussion-title-id]");
    if (!btn) return;
    void startTitleDiscussion(btn.getAttribute("data-discussion-title-id"));
  });

  discussionPromptChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      const prompt = chip.getAttribute("data-prompt") || "";
      if (!composerText) return;
      composerText.value = prompt;
      autoResizeComposer();
      composerText.focus();
      // Cursore alla fine del testo prefillato, pronto per continuare a scrivere.
      const len = composerText.value.length;
      composerText.setSelectionRange(len, len);
      composerText.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });
}

// ==============================
// Feed building
// ==============================

// Empty state semplice: le righe di discovery (blog/tendenze/novità) sono state
// promosse a contenuto primario della Home (vedi home.page.js renderHome()) e
// non si ripetono qui per non duplicare la stessa UI in due tab.
function renderEmpty(text) {
  if (!feedEl) return;
  trackProductEvent("empty_feed");
  void logEvent("empty_feed");
  feedEl.innerHTML = `
    <div class="home-empty-state">
      <div class="home-empty-icon" aria-hidden="true">✨</div>
      <p class="hint home-empty-text">${escapeHtml(text)}</p>
    </div>
  `;
}

function renderSkeleton(count = 4) {
  if (!feedEl) return;
  const rows = Array.from({ length: count }).map(() => `
    <div class="feed-item">
      <div class="feed-item-header">
        <div class="sk sk-avatar"></div>
        <div class="meta" style="flex:1; min-width:0;">
          <div class="sk sk-line" style="width: 60%;"></div>
          <div class="sk sk-line" style="width: 40%; margin-top:.35rem;"></div>
        </div>
      </div>
      <div class="feed-item-content">
        <div class="sk sk-block" style="height: 84px;"></div>
      </div>
    </div>
  `).join("");
  feedEl.innerHTML = rows;
}

async function loadGenreMap() {
  try {
    const gs = await listGenres(300).catch(() => []);
    genreMap = new Map(gs.map(g => [g.id, g.name || g.id]));
  } catch (_) {
    genreMap = new Map();
  }
}

async function getSuggestionForMe(myUid) {
  // 0) Provo a usare le recommendations (se presenti) come bacino suggerimenti
  //    (MVP: prende l'ultimo consiglio ricevuto che non ho ancora votato)
  const [lib, rated] = await Promise.all([
    listMyLibrary(myUid, { max: 25 }).catch(() => []),
    listMyTitleRatings(myUid, { max: 300 }).catch(() => []),
  ]);

  const ratedSet = new Set(rated.map(r => r.titleId).filter(Boolean));
  const libSet = new Set(lib.map(x => x.titleId).filter(Boolean));

  try {
    const recs = await listRecommendationsForMe(myUid, { includeViewed: true, max: 50 });
    // Prefetch in batch (1 read) tutti i candidati non rated/lib.
    const recCandidates = (recs || [])
      .map(r => r?.titleId)
      .filter(Boolean)
      .filter(id => !ratedSet.has(id) && !libSet.has(id));
    if (recCandidates.length) {
      const recMap = await getTitlesByIds(recCandidates).catch(() => new Map());
      for (const candId of recCandidates) {
        const cand = recMap.get(candId);
        if (cand) return cand;
      }
    }
  } catch (_) {
    // ignore: fallback sotto
  }

  // 1) fallback: correlati basati sui titoli votati. Prefetch seed in batch,
  //    poi prefetch tutti i relatedIds in un secondo batch. Niente N+1.
  const seed = lib.slice(0, 10).map(x => x.titleId).filter(Boolean);
  if (!seed.length) return null;

  const seedMap = await getTitlesByIds(seed).catch(() => new Map());
  const relIds = [];
  const relBySeed = new Map();
  for (const seedId of seed) {
    const t = seedMap.get(seedId);
    if (!t) continue;
    const rel = Array.isArray(t.related) ? t.related : [];
    relBySeed.set(seedId, rel);
    for (const candId of rel) {
      if (candId && !ratedSet.has(candId)) relIds.push(candId);
    }
  }
  if (!relIds.length) return null;
  const relMap = await getTitlesByIds(relIds).catch(() => new Map());
  // Stesso ordinamento seed-by-seed dell'implementazione precedente.
  for (const seedId of seed) {
    const rel = relBySeed.get(seedId) || [];
    for (const candId of rel) {
      if (!candId || ratedSet.has(candId)) continue;
      const cand = relMap.get(candId);
      if (cand) return cand;
    }
  }

  return null;
}

async function ensureUsersCached(uids) {
  await Promise.all(uids.map(async uid => {
    if (!uid || state.userMap.has(uid)) return;
    const u = await getUserPublic(uid).catch(() => null);
    if (u) state.userMap.set(uid, u);
  }));
}

async function ensureTitlesCached(ids) {
  const uniq = [...new Set((ids || []).filter(Boolean))].filter(id => !state.titleMap.has(id));
  if (!uniq.length) return;
  const map = await getTitlesByIds(uniq).catch(() => new Map());
  for (const [id, t] of map.entries()) {
    if (t) state.titleMap.set(id, t);
  }
}

/**
 * Progresso del viewer sui titoli richiesti, per il gate anti-spoiler delle
 * card commento. Chiede solo gli id non ancora interrogati (anche quelli
 * risultati assenti dalla libreria restano marcati, così non si ripetono a
 * ogni chunk) e li tiene in `state.progressMap`.
 */
async function ensureProgressCached(titleIds) {
  const myUid = state.me?.uid;
  if (!myUid) return;
  const wanted = [...new Set((titleIds || []).map((v) => String(v || "").trim()).filter(Boolean))]
    .filter((id) => !state.progressAsked.has(id));
  if (!wanted.length) return;

  wanted.forEach((id) => state.progressAsked.add(id));
  const rows = await getMyTitleStatesByIds(myUid, wanted).catch(() => new Map());
  rows.forEach((row, titleId) => {
    const entry = normalizeProgressEntry(row);
    if (entry) state.progressMap.set(titleId, entry);
  });
}

function progressEntryFor(titleId) {
  return state.progressMap.get(String(titleId || "").trim()) || null;
}

function clipText(value, maxLen = 500) {
  const s = String(value || "").trim();
  if (!s) return "";
  return s.slice(0, maxLen);
}

function normalizeSharedPostPayload(sharedPost) {
  if (!sharedPost || typeof sharedPost !== "object") return null;
  const postId = String(sharedPost.postId || "").trim();
  const authorUid = String(sharedPost.authorUid || "").trim();
  if (!postId || !authorUid) return null;
  return {
    postId,
    authorUid,
    authorName: clipText(sharedPost.authorName, 80) || "User",
    text: clipText(sharedPost.text, 500),
    titleId: sharedPost.titleId ? String(sharedPost.titleId).trim() : null,
  };
}

function normalizeWatchedWithPayload(list, { max = 12 } = {}) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const uid = String(row.uid || "").trim();
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    out.push({
      uid,
      displayName: clipText(row.displayName, 80) || i18nT("Amico"),
    });
    if (out.length >= max) break;
  }
  return out;
}

function ratingIdentityKey(item) {
  if (!item || item.kind !== "rating") return "";
  const actorUid = String(item.actorUid || "").trim();
  const titleId = String(item.titleId || "").trim();
  const level = String(item.level || "title").trim() || "title";
  const season = Number(item.season || 0) || 0;
  const episode = Number(item.episode || 0) || 0;
  if (!actorUid || !titleId) return "";
  return `${actorUid}::${titleId}::${level}::${season}::${episode}`;
}

function dedupeFeedItems(items = []) {
  const ratingByKey = new Map();

  (items || []).forEach((it, idx) => {
    const key = ratingIdentityKey(it);
    if (!key) return;
    const prev = ratingByKey.get(key);
    const ts = tsToMillis(it.ts);
    if (!prev) {
      ratingByKey.set(key, { idx, ts, item: it });
      return;
    }
    const prevTs = prev.ts;
    const preferCurrent = ts > prevTs
      || (ts === prevTs && String(it.reviewText || "").length > String(prev.item.reviewText || "").length)
      || (ts === prevTs && !!it.mediaUrl && !prev.item.mediaUrl);
    if (preferCurrent) {
      ratingByKey.set(key, { idx, ts, item: it });
    }
  });

  if (!ratingByKey.size) return items;

  const keepSet = new Set();
  ratingByKey.forEach((row) => keepSet.add(row.item));

  return (items || []).filter((it) => {
    if (it?.kind !== "rating") return true;
    return keepSet.has(it);
  });
}

function ratingPostIdForItem(item) {
  const actorUid = String(item?.actorUid || "").trim();
  const titleId = String(item?.titleId || "").trim();
  if (!actorUid || !titleId) return "";
  const level = String(item?.level || "title").trim() || "title";
  if (level === "season") {
    return `rating::${actorUid}::${titleId}::season::${Number(item?.season || 0) || 0}`;
  }
  if (level === "episode") {
    return `rating::${actorUid}::${titleId}::episode::${Number(item?.season || 0) || 0}::${Number(item?.episode || 0) || 0}`;
  }
  return `rating::${actorUid}::${titleId}`;
}

function mapFeedEventToItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const eventType = String(raw.eventType || "").trim();
  const actorUid = String(raw.actorUid || "").trim();
  if (!eventType || !actorUid) return null;

  const item = {
    kind: eventType,
    actorUid,
    titleId: raw.titleId ? String(raw.titleId).trim() : null,
    ts: raw.createdAt || Date.now(),
  };

  if (eventType === "rating") {
    const rating = Number(raw.rating || 0);
    const level = ["title", "season", "episode"].includes(String(raw.level || "").trim())
      ? String(raw.level || "").trim()
      : "title";
    const season = Number(raw.season || 0) || null;
    const episode = Number(raw.episode || 0) || null;
    item.rating = Number.isFinite(rating) ? rating : null;
    item.level = level;
    item.season = season;
    item.episode = episode;
    item.postId = String(raw.postId || "").trim() || ratingPostIdForItem(item);
    item.reviewText = clipText(raw.reviewText || "", 500);
    item.mediaUrl = raw.mediaUrl ? String(raw.mediaUrl).trim() : null;
    item.watchedWith = normalizeWatchedWithPayload(raw.watchedWith || []);
    return item;
  }

  if (eventType === "watch_together") {
    item.kind = "watch_together";
    item.postId = String(raw.postId || "").trim() || null;
    item.mediaUrl = raw.mediaUrl ? String(raw.mediaUrl).trim() : null;
    item.watchedWith = normalizeWatchedWithPayload(raw.watchedWith || []);
    return item;
  }

  if (eventType === "post" || eventType === "post_share") {
    item.postKind = eventType === "post_share" ? "share" : "post";
    item.postId = String(raw.postId || "").trim();
    // 2000 = tetto delle rules su posts.text: clippare piu' corto tagliava
    // silenziosamente la coda dei post lunghi (es. aggiornamenti editoriali
    // con domanda finale e CTA) anche dopo l'espansione "altro".
    item.text = clipText(raw.text, 2000);
    item.mediaUrl = raw.mediaUrl ? String(raw.mediaUrl).trim() : null;
    item.sharedPost = normalizeSharedPostPayload(raw.sharedPost);
    item.isOfficialUpdate = actorUid === SOMTO_OFFICIAL_UID;
    if (eventType === "post_share" && item.sharedPost?.titleId && !item.titleId) {
      item.titleId = item.sharedPost.titleId;
    }
    return item.postId ? item : null;
  }

  if (eventType === "recommendation") {
    return null;
  }

  if (eventType === "follow") {
    item.kind = "follow";
    item.otherUid = String(raw.targetUid || "").trim() || null;
    return item;
  }

  if (eventType === "post_comment") {
    item.kind = "post_comment";
    item.postId = String(raw.postId || "").trim() || null;
    item.otherUid = String(raw.targetUid || "").trim() || null;
    item.snippet = clipText(raw.snippet || raw.text, 240);
    return item;
  }

  if (eventType === "series_started") {
    item.kind = "series_started";
    return item;
  }

  return null;
}

function collectItemUserIds(items) {
  const set = new Set();
  (items || []).forEach((it) => {
    if (it?.actorUid) set.add(it.actorUid);
    if (it?.otherUid) set.add(it.otherUid);
    if (it?.sharedPost?.authorUid) set.add(it.sharedPost.authorUid);
  });
  return [...set];
}

function collectItemTitleIds(items) {
  const ids = [];
  (items || []).forEach((it) => {
    if (it?.titleId) ids.push(it.titleId);
    if (it?.sharedPost?.titleId) ids.push(it.sharedPost.titleId);
  });
  return [...new Set(ids.filter(Boolean))];
}

function refreshPostMapFromItems(items) {
  const next = new Map();
  (items || []).forEach((row) => {
    if ((row?.kind === "post" || row?.kind === "post_share") && row.postId) {
      next.set(row.postId, row);
    }
  });
  state.postMap = next;
}

async function loadServerFeedPage(myUid, { reset = false, pageSize = 24 } = {}) {
  if (!myUid) return [];
  const page = await listFeedEventsPage(myUid, {
    pageSize,
    cursorDoc: reset ? null : state.feedCursorDoc,
  });

  const mapped = (page.items || [])
    .map(mapFeedEventToItem)
    .filter(Boolean);

  await Promise.all([
    ensureUsersCached(collectItemUserIds(mapped)),
    ensureTitlesCached(collectItemTitleIds(mapped)),
  ]);

  state.feedMode = "server";
  state.feedCursorDoc = page.nextCursorDoc || null;
  state.feedHasMore = !!page.hasMore && !!page.nextCursorDoc;

  if (reset) {
    state.items = dedupeFeedItems(mapped);
  } else if (mapped.length) {
    state.items.push(...mapped);
    state.items = dedupeFeedItems(state.items);
  }
  refreshPostMapFromItems(state.items);
  return mapped;
}

// ==============================
// Ranked mix (community-alive): follow-graph events + public posts +
// "Discussioni per te". Vedi commenti sopra ogni funzione per la formula.
// ==============================

const RANKED_CANDIDATE_CAP = 40; // cap letture per sorgente (feedEvents / public posts / threads)
const RANKED_FEED_SHOWN_CAP = 40; // cap items renderizzati nel feed principale
// Una riga sola: da quando i commenti compaiono come card nel feed, la
// sezione "Discussioni per te" è un promemoria, non il contenuto principale —
// oltre una riga rubava spazio al feed. (iOS resta a 3 finché non arriva la
// stessa modifica lì: CommunityDiscussionsRanking.cap.)
const COMMUNITY_THREADS_MAX = 1;
const COMMUNITY_THREADS_PER_TITLE_CAP = 1; // max thread per singolo titolo (no monopolio episodi)

// Punteggio post pubblico: popolarità (like+commenti) pesata sulla recency.
// Il "+1" alla base garantisce che un post fresco a 0 interazioni non finisca
// invisibile sotto contenuti vecchi — con community piccola/nuova, recency da
// sola deve bastare a far emergere i contenuti. Man mano che crescono i like/
// commenti, il fattore popolarità prende il sopravvento sui post più vecchi.
// Decay più aggressivo (^1.5) dei follow-events perché i post pubblici sono
// un bacino enorme (tutta la community) e vogliamo che "il momento" conti.
function scorePublicPost(post, counts, nowMs = Date.now()) {
  const ageHours = Math.max(0, (nowMs - tsToMillis(post?.createdAt || post?.ts)) / (60 * 60 * 1000));
  const likes = Math.max(0, Number(counts?.likes || 0));
  const comments = Math.max(0, Number(counts?.comments || 0));
  return (1 + likes + 2 * comments) / Math.pow(ageHours + 2, 1.5);
}

// Punteggio evento follow-graph (persone che segui): base alta così l'attività
// recente di chi segui resta ben interfoliata in cima insieme ai post pubblici
// popolari, anche senza like/commenti propri (sono "le tue persone" — la
// ragione per cui il feed esiste). Decay più lento (^1.2) dei post pubblici:
// l'attività di chi segui resta rilevante più a lungo.
// FOLLOW_BASE=6 è tarato empiricamente contro scorePublicPost: a paritá di
// "freschezza" (ageHours=0) un follow-event pesa quanto un post pubblico con
// ~4 interazioni (1 + 4*... ≈ 6 / 2^1.2 ≈ 2.6 vs post score 1/2^1.5≈0.35),
// quindi le persone che segui galleggiano sopra il rumore dei post pubblici
// a bassissimo engagement, ma un post pubblico virale può comunque superarle.
const FOLLOW_BASE = 6;
function scoreFollowEvent(item, nowMs = Date.now()) {
  const ageHours = Math.max(0, (nowMs - tsToMillis(item?.ts)) / (60 * 60 * 1000));
  return FOLLOW_BASE / Math.pow(ageHours + 2, 1.2);
}

// Mappa un doc raw di `posts` (query pubblica, NON feedEvents) sulla stessa
// shape prodotta da mapFeedEventToItem per kind "post"/"post_share" — così
// itemHtml/postSocialHtml/wireFeedInteractions/spoiler-gate funzionano
// invariati, senza duplicare la card.
function mapPublicPostToItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const authorUid = String(raw.authorUid || "").trim();
  const postId = String(raw.id || "").trim();
  if (!authorUid || !postId) return null;

  // Post-eco di un commento in un thread pubblico (lib/commentEcho.js): card
  // dedicata, gate anti-spoiler per progresso, risposte che tornano nel thread.
  if (String(raw.sourceKind || "") === "thread_message") {
    const scope = normalizeSpoilerScope(raw.spoilerScope);
    const titleId = String(raw.titleId || "").trim() || scope?.titleId || null;
    if (!titleId) return null;
    return {
      kind: "title_comment",
      actorUid: authorUid,
      titleId,
      postId,
      text: clipText(raw.text, 2000),
      mediaUrl: raw.mediaUrl ? String(raw.mediaUrl).trim() : null,
      textTruncated: raw.textTruncated === true,
      spoilerScope: scope,
      threadId: String(raw.sourceThreadId || "").trim() || null,
      ts: raw.createdAt || Date.now(),
    };
  }

  const sharedRaw = (raw.sharedPost && typeof raw.sharedPost === "object") ? raw.sharedPost : null;
  const sharedPost = normalizeSharedPostPayload(sharedRaw);
  const isShare = raw.kind === "share";

  return {
    kind: isShare ? "post_share" : "post",
    postKind: isShare ? "share" : "post",
    actorUid: authorUid,
    titleId: raw.titleId ? String(raw.titleId).trim() : (sharedPost?.titleId || null),
    postId,
    // Stesso tetto del path feedEvents (= tetto rules su posts.text).
    text: clipText(raw.text, 2000),
    mediaUrl: raw.mediaUrl ? String(raw.mediaUrl).trim() : null,
    sharedPost,
    isOfficialUpdate: authorUid === SOMTO_OFFICIAL_UID,
    ts: raw.createdAt || Date.now(),
  };
}

// Carica una finestra di post pubblici (tutta la community, non solo chi
// segui) e li converte in feed item + calcola lo score. getPostSocialCounts
// fa 2 count-aggregation query per post (like+commenti) — cap RANKED_CANDIDATE_CAP
// per limitare il costo (≤40 post × 2 read aggregate = 80 read max a mix).
async function loadRankedPublicPosts({ append = false } = {}) {
  const page = await listPublicPostsPage({
    pageSize: RANKED_CANDIDATE_CAP,
    cursorDoc: append ? state.publicPostsCursorDoc : null,
  });
  state.publicPostsCursorDoc = page.nextCursorDoc || null;
  state.publicPostsHasMore = !!page.hasMore && !!page.nextCursorDoc;

  const mapped = (page.items || []).map(mapPublicPostToItem).filter(Boolean);
  await Promise.all([
    ensureUsersCached(collectItemUserIds(mapped)),
    ensureTitlesCached(collectItemTitleIds(mapped)),
  ]);

  const nowMs = Date.now();
  // I post-eco dei commenti non hanno like/commenti propri (la conversazione
  // vive nel thread): niente count-aggregation su di loro, si risparmiano 2
  // read a card e si evita di mostrare contatori sempre a zero.
  const counts = await Promise.all(
    mapped.map((it) => (it.kind === "title_comment"
      ? Promise.resolve({ likes: 0, comments: 0, shares: 0 })
      : getPostSocialCounts(it.postId).catch(() => ({ likes: 0, comments: 0, shares: 0 }))))
  );
  return mapped.map((it, i) => {
    if (it.kind === "title_comment") {
      return { item: it, _score: scoreCommentItem(it, nowMs, { inLibrary: false }) };
    }
    // Precarica i conteggi nella cache UI del post così la card non deve
    // rifare le stesse 2 query in hydratePostSocialCard.
    const ui = getPostUiState(it.postId);
    if (ui && !ui.hydrated) {
      ui.counts = {
        likes: Math.max(0, Number(counts[i]?.likes || 0)),
        comments: Math.max(0, Number(counts[i]?.comments || 0)),
        shares: Math.max(0, Number(counts[i]?.shares || 0)),
      };
    }
    return { item: it, _score: scorePublicPost(it, counts[i], nowMs) };
  });
}

// Punteggio di un commento (post-eco). Due differenze rispetto ai post:
// - decay molto più lento (^0.5): un commento su una serie che stai guardando
//   resta interessante anche se scritto mesi fa. È ciò che rende visibile il
//   backfill dello storico senza falsificare le date.
// - bonus forte se il titolo è nella tua libreria: è il segnale di pertinenza
//   più affidabile che abbiamo, ed è anche il caso in cui il gate anti-spoiler
//   lascia il contenuto in chiaro.
const COMMENT_BASE = 3;
const COMMENT_LIBRARY_BONUS = 5;
function scoreCommentItem(item, nowMs = Date.now(), { inLibrary = false } = {}) {
  const ageHours = Math.max(0, (nowMs - tsToMillis(item?.ts)) / (60 * 60 * 1000));
  const base = COMMENT_BASE + (inLibrary ? COMMENT_LIBRARY_BONUS : 0);
  return base / Math.pow(ageHours + 2, 0.5);
}

// Quanti commenti al massimo entrano in una build del feed: la community è
// piccola e senza cap una serie molto commentata riempirebbe tutto.
const COMMENT_ITEMS_CAP = 8;

// Commenti sui titoli della TUA libreria, a qualunque età. Sorgente separata
// dalla finestra per recency: senza questa i commenti storici (backfill) non
// comparirebbero mai. Vedi listPublicPostsByTitleIds.
async function loadCommentsOnMyTitles(myUid) {
  if (!myUid) return [];
  const profile = await getMyGenreProfile(myUid).catch(() => null);
  const libraryTitleIds = [...(profile?.libraryTitleIds || new Set())];
  if (!libraryTitleIds.length) return [];

  const raw = await listCommentPostsByTitleIds(libraryTitleIds, { perChunkLimit: 20 }).catch(() => []);
  const mapped = raw
    .map(mapPublicPostToItem)
    .filter((it) => it && it.kind === "title_comment");
  if (!mapped.length) return [];

  await Promise.all([
    ensureUsersCached(collectItemUserIds(mapped)),
    ensureTitlesCached(collectItemTitleIds(mapped)),
  ]);

  const nowMs = Date.now();
  return mapped.map((it) => ({ item: it, _score: scoreCommentItem(it, nowMs, { inLibrary: true }) }));
}

// Commenti più recenti di TUTTA la community, anche su titoli che non hai in
// libreria: senza questa sorgente il feed di un utente nuovo (libreria vuota)
// resterebbe muto. Restano comunque dietro al gate anti-spoiler, che per un
// titolo non in libreria è chiuso di default.
const RECENT_COMMENTS_CAP = 24;
async function loadRecentComments() {
  const page = await listCommentPostsPage({ pageSize: RECENT_COMMENTS_CAP }).catch(() => ({ items: [] }));
  const mapped = (page.items || [])
    .map(mapPublicPostToItem)
    .filter((it) => it && it.kind === "title_comment");
  if (!mapped.length) return [];

  await Promise.all([
    ensureUsersCached(collectItemUserIds(mapped)),
    ensureTitlesCached(collectItemTitleIds(mapped)),
  ]);

  const nowMs = Date.now();
  return mapped.map((it) => ({ item: it, _score: scoreCommentItem(it, nowMs, { inLibrary: false }) }));
}

/** Sorgenti commenti unite: quelli sui tuoi titoli + i più recenti in assoluto. */
async function loadCommentItems(myUid) {
  const [mine, recent] = await Promise.all([
    loadCommentsOnMyTitles(myUid).catch((err) => { console.warn("[feed-debug] comments(mine) error:", err); return []; }),
    loadRecentComments().catch((err) => { console.warn("[feed-debug] comments(recent) error:", err); return []; }),
  ]);
  console.log(`[feed-debug] comments: mine=${mine.length} recent=${recent.length}`);
  return [...mine, ...recent];
}

// Bonus per i post pubblici di chi segui: sono sia "post" (contano
// popolarità) sia "una persona che segui" (contano vicinanza) — piccolo
// boost così non vengono surclassati identicamente a un post pubblico
// anonimo con lo stesso engagement.
const FOLLOW_BASE_POST_BONUS = 0.5;

// Fonde follow-graph events + post pubblici in un'unica lista ordinata per
// score, deduplicata per postId (un post che è SIA un feedEvent di chi segui
// SIA restituito dalla query pubblica deve comparire una volta sola — tiene
// la versione follow-graph, che porta con sé l'evento "chi l'ha fatto" ma la
// card renderizzata è identica). Item non-post (rating/follow/thread/...)
// mantengono il loro score follow-graph e restano sempre in lista (sono
// "le tue persone").
function blendRankedFeed(followItems, publicPostScored, commentScored = []) {
  const nowMs = Date.now();
  const seenPostIds = new Set();
  const scored = [];

  for (const it of followItems || []) {
    if (!it) continue;
    if (it.postId) {
      if (seenPostIds.has(it.postId)) continue;
      seenPostIds.add(it.postId);
    }
    const isPost = it.kind === "post" || it.kind === "post_share";
    const score = isPost ? scorePublicPost(it, getPostUiState(it.postId)?.counts, nowMs) + FOLLOW_BASE_POST_BONUS : scoreFollowEvent(it, nowMs);
    scored.push({ item: it, _score: score });
  }

  for (const row of publicPostScored || []) {
    const postId = row.item?.postId;
    if (postId && seenPostIds.has(postId)) continue;
    if (postId) seenPostIds.add(postId);
    scored.push(row);
  }

  // I commenti entrano per ultimi e con un tetto proprio: dedupe per postId
  // contro le altre sorgenti (lo stesso eco può arrivare sia dalla finestra
  // per recency sia dalla query per titolo), poi cap ai migliori.
  const comments = [];
  for (const row of commentScored || []) {
    const postId = row?.item?.postId;
    if (!postId || seenPostIds.has(postId)) continue;
    seenPostIds.add(postId);
    comments.push(row);
  }
  comments.sort((a, b) => b._score - a._score);
  scored.push(...comments.slice(0, COMMENT_ITEMS_CAP));

  scored.sort((a, b) => b._score - a._score);
  return scored.slice(0, RANKED_FEED_SHOWN_CAP).map((row) => row.item);
}

// ==============================
// Genre profile utente (per "Discussioni per te")
// ==============================
// Costruito da library + watchlist dell'utente (letture già cachate da
// altre parti della pagina in molti casi). Cache in state.genreProfile per
// tutta la sessione pagina (non ricalcolato ad ogni buildHomeFeed/rebuild).
const GENRE_PROFILE_TITLE_CAP = 40; // cap titoli usati per il profilo genere
const TOP_GENRES_COUNT = 5;

async function computeMyGenreProfile(myUid) {
  const [lib, wl] = await Promise.all([
    listMyLibrary(myUid, { max: GENRE_PROFILE_TITLE_CAP }).catch(() => []),
    getMyWatchlist(myUid, { max: GENRE_PROFILE_TITLE_CAP }).catch(() => []),
  ]);

  const titleIds = [...new Set([
    ...lib.map((r) => r.titleId).filter(Boolean),
    ...wl.map((r) => r.titleId || r.id).filter(Boolean),
  ])].slice(0, GENRE_PROFILE_TITLE_CAP);

  if (!titleIds.length) {
    return { topGenres: new Set(), libraryTitleIds: new Set(), genreCounts: new Map() };
  }

  const titleMap = await getTitlesByIds(titleIds).catch(() => new Map());
  const genreCounts = new Map();
  for (const id of titleIds) {
    const t = titleMap.get(id);
    if (!t) continue;
    for (const g of Array.isArray(t.genres) ? t.genres : []) {
      if (!g) continue;
      genreCounts.set(g, (genreCounts.get(g) || 0) + 1);
    }
  }

  const topGenres = new Set(
    [...genreCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_GENRES_COUNT)
      .map(([g]) => g)
  );

  return {
    topGenres,
    libraryTitleIds: new Set(lib.map((r) => r.titleId).filter(Boolean)),
    genreCounts,
  };
}

// Cache session-scoped: la prima chiamata calcola e memorizza la Promise,
// le successive (rebuild, tab switch) riusano lo stesso risultato senza
// rileggere library/watchlist/titoli.
function getMyGenreProfile(myUid) {
  if (!state.genreProfile) {
    state.genreProfile = computeMyGenreProfile(myUid).catch((err) => {
      console.warn("[community] getMyGenreProfile error", err);
      state.genreProfile = null; // permette un retry al prossimo giro
      return { topGenres: new Set(), libraryTitleIds: new Set(), genreCounts: new Map() };
    });
  }
  return state.genreProfile;
}

// ==============================
// "Discussioni per te" — thread pubblici attivi ranked per rilevanza genere.
// Score = (titolo esatto in libreria ? 5 : 0) + overlap_generi*2, tie-break
// su lastMessageAt (più recente prima). Se NESSUN thread ha overlap>0/match
// esatto, fallback ai thread attivi più recenti (il modulo non è mai vuoto).
// ==============================
async function buildRelevantDiscussions(myUid, { max = COMMUNITY_THREADS_MAX } = {}) {
  // Profilo prima: serve la libreria per la seconda query (thread per titolo).
  const profile = myUid ? await getMyGenreProfile(myUid).catch(() => null) : null;
  const topGenres = profile?.topGenres || new Set();
  const libraryTitleIds = profile?.libraryTitleIds || new Set();

  // (1) thread pubblici più recenti + (2) thread sui titoli in libreria a
  // QUALSIASI età. La (2) fa emergere i thread creati dall'import dei
  // commenti-episodio TV Time (lastMessageAt vecchio → invisibili alla sola
  // query per recency). Merge dedup per id.
  const [recency, byTitle] = await Promise.all([
    listPublicThreads(RANKED_CANDIDATE_CAP).catch(() => []),
    libraryTitleIds.size ? listPublicThreadsByTitleIds([...libraryTitleIds]).catch(() => []) : Promise.resolve([]),
  ]);
  const seen = new Set();
  const threads = [];
  for (const th of [...(recency || []), ...(byTitle || [])]) {
    if (!th || !th.id || seen.has(th.id)) continue;
    seen.add(th.id);
    threads.push(th);
  }

  const withPreview = threads.filter((th) => String(th?.lastMessagePreview || "").trim().length > 0);
  if (!withPreview.length) return { threads: [], fallback: false };

  const threadTitleIds = [...new Set(withPreview.map((th) => th.titleId).filter(Boolean))];
  await ensureTitlesCached(threadTitleIds);

  const scored = withPreview.map((th) => {
    const t = th.titleId ? state.titleMap.get(th.titleId) : null;
    const genres = t && Array.isArray(t.genres) ? t.genres : [];
    const overlap = genres.filter((g) => topGenres.has(g));
    const exactMatch = !!th.titleId && libraryTitleIds.has(th.titleId);
    const score = (exactMatch ? 5 : 0) + overlap.length * 2;
    return { th, score, overlap, exactMatch };
  });

  // Solo i thread su titoli che l'utente ha davvero in libreria. Prima
  // bastava un genere in comune (score > 0), quindi comparivano serie mai
  // viste né aggiunte; e se nemmeno quello bastava, un fallback mostrava i
  // thread più recenti. Meglio un empty state onesto. Il punteggio genere
  // resta, ma solo come ordinamento fra titoli già rilevanti. Stessa regola
  // su iOS (CommunityDiscussionsRanking.buildSuggestions).
  const pool = scored.filter((row) => row.exactMatch);
  if (!pool.length) return { threads: [], fallback: false };

  pool.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return tsToMillis(b.th.lastMessageAt) - tsToMillis(a.th.lastMessageAt);
  });

  // Cap per-titolo: evita che una serie con molte discussioni-episodio (tipico
  // dopo l'import dei commenti TV Time) monopolizzi gli slot del modulo.
  const perTitle = new Map();
  const capped = [];
  for (const row of pool) {
    const key = row.th.titleId || row.th.id;
    const n = perTitle.get(key) || 0;
    if (n >= COMMUNITY_THREADS_PER_TITLE_CAP) continue;
    perTitle.set(key, n + 1);
    capped.push(row);
    if (capped.length >= max) break;
  }

  // `fallback` resta nel contratto per i chiamanti, ma ora è sempre false:
  // ciò che esce da qui è per definizione pertinente.
  return { threads: capped, fallback: false };
}

function actionTextForItem(it) {
  if (it.kind === "rating") {
    if (it.level === "season" && it.season) return i18nT("ha terminato la stagione {season}", { season: it.season });
    if (it.level === "episode" && it.season && it.episode) return i18nT("ha visto S{season} E{episode}", { season: it.season, episode: it.episode });
    return i18nT("ha votato");
  }
  if (it.kind === "watch_together") return i18nT("ha visto un titolo con amici");
  if (it.kind === "thread") return "ha scritto nel thread";
  if (it.kind === "post") return i18nT("ha pubblicato un post");
  if (it.kind === "post_share") return i18nT("ha condiviso un post");
  if (it.kind === "recommendation") return i18nT("ha consigliato un titolo");
  if (it.kind === "follow") return i18nT("ha iniziato a seguire");
  if (it.kind === "post_comment") return i18nT("ha commentato un post");
  if (it.kind === "title_comment") return i18nT("ha commentato");
  if (it.kind === "series_started") return i18nT("ha iniziato a guardare una serie");
  if (it.kind === "title_added") return i18nT("ha aggiunto un titolo");
  if (it.kind === "friend_added") return i18nT("è diventato tuo amico");
  return "";
}

function iconFilmPlus(size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/><line x1="17" y1="17" x2="22" y2="17"/></svg>`;
}

function iconUsers(size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
}

function iconTrophy(size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>`;
}
function iconChat(size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#00D9FF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a4 4 0 0 1-4 4H7l-4 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>`;
}
function iconGlobe(size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#E91E63" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;
}
function iconGenre(size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#9C27B0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M4 12h16M4 17h10"/></svg>`;
}

function iconHeart(size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>`;
}

function iconRepeat(size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>`;
}

function iconShare(size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"></line><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"></line></svg>`;
}

function renderAvatarHtml(u, { linkUid = null } = {}) {
  const photo = u?.photoURL;
  const inner = photo
    ? `<img alt="" src="${escapeHtml(photo)}" loading="lazy" decoding="async">`
    : escapeHtml(initials(u?.displayName));
  if (linkUid) {
    return `<a class="avatar feed-avatar-link" href="/user.html?uid=${encodeURIComponent(linkUid)}">${inner}</a>`;
  }
  return `<div class="avatar">${inner}</div>`;
}

function miniTitleHtml(t, { showBookmark = true } = {}) {
  if (!t) return "";
  const poster = t.posterPath ? `<img alt="" src="${escapeHtml(t.posterPath)}" loading="lazy" decoding="async">` : "";
  const year = t.year ? ` (${escapeHtml(String(t.year))})` : "";

  const gRaw = Array.isArray(t.genres) ? t.genres : [];
  const g = gRaw.map(x => genreMap.get(x) || x).filter(Boolean).slice(0, 2);

  const dir = Array.isArray(t.directors) ? t.directors.slice(0, 2) : [];
  const cast = Array.isArray(t.cast) ? t.cast.slice(0, 3) : [];

  const tv = t.type === "tv";
  const m = t.meta || {};
  const tvMeta = tv
    ? [m.seasonsCount ? `${m.seasonsCount} stag.` : null, m.episodesPerSeason ? `${m.episodesPerSeason} ep/stag.` : null].filter(Boolean).join(" • ")
    : "";

  const lines = [
    g.length ? g.join(" • ") : null,
    dir.length ? `Regia: ${dir.join(", ")}` : null,
    cast.length ? `Cast: ${cast.join(", ")}` : null,
    tvMeta || null,
  ].filter(Boolean);

  return `
    <div class="mini-title" data-title-id="${escapeHtml(t.id)}">
      <a class="poster" href="/title.html?id=${encodeURIComponent(t.id)}" aria-label="${i18nT("Apri titolo")}">${poster}</a>
      <div class="info">
        <div class="tname">${escapeHtml(t.name || "")}${year}</div>
        <div class="tmeta">${escapeHtml(lines.slice(0, 2).join(" • "))}</div>
        ${lines.length > 2 ? `<div class="tmeta">${escapeHtml(lines.slice(2).join(" • "))}</div>` : ""}
      </div>
      ${showBookmark && state.me ? `
        <button class="bookmark" type="button" aria-label="${i18nT("Watchlist")}" title="${i18nT("Watchlist")}" data-bookmark="1" data-title-id="${escapeHtml(t.id)}">
          ${iconBookmark(18)}
        </button>
      ` : ""}
      ${titleFollowButtonHtml(t, { variant: "icon" })}
    </div>
  `;
}

/**
 * "Segui": scrive `users/{uid}/titleUpdatePrefs/{titleId}.mode = "follow"`.
 *
 * Serve perche' senza follow gli eventi di un titolo (per esempio l'uscita in
 * sala) arrivano SOLO a chi ce l'ha in watchlist. Un post editoriale su un
 * film che esce lo legge anche chi quel film non l'ha mai toccato: il bottone
 * e' li' per lui, e alza anche la rilevanza della notifica.
 */
async function ensureTitleUpdatePrefs() {
  if (!state.me) return state.titleUpdatePrefs;
  if (!state.titleUpdatePrefsLoaded) {
    state.titleUpdatePrefsLoaded = listMyTitleUpdatePreferences(state.me.uid)
      .then((map) => {
        state.titleUpdatePrefs = map;
        return map;
      })
      .catch(() => state.titleUpdatePrefs);
  }
  return state.titleUpdatePrefsLoaded;
}

/** Lo stesso titolo puo' comparire in piu' card: si aggiornano tutte insieme. */
function syncTitleFollowButtons(titleId) {
  const following = state.titleUpdatePrefs.get(titleId) === "follow";
  const label = following ? i18nT("Seguito") : i18nT("Segui");
  document.querySelectorAll(`[data-title-follow="1"][data-title-id="${CSS.escape(titleId)}"]`).forEach((btn) => {
    btn.classList.toggle("active", following);
    btn.setAttribute("aria-pressed", following ? "true" : "false");
    btn.setAttribute("aria-label", label);
    btn.setAttribute("title", label);
    const text = btn.querySelector("[data-title-follow-label='1']");
    if (text) text.textContent = label;
  });
}

function titleFollowButtonHtml(t, { variant = "icon" } = {}) {
  if (!t?.id || !state.me) return "";
  const following = state.titleUpdatePrefs.get(t.id) === "follow";
  const label = following ? i18nT("Seguito") : i18nT("Segui");
  const cls = variant === "icon" ? "mini-title-follow" : "feed-inline-title-follow";
  return `
    <button class="${cls}${following ? " active" : ""}" type="button"
      data-title-follow="1" data-title-id="${escapeHtml(t.id)}"
      aria-pressed="${following ? "true" : "false"}"
      aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">
      ${iconBell(16)}${variant === "icon" ? "" : `<span data-title-follow-label="1">${escapeHtml(label)}</span>`}
    </button>
  `;
}

// URL nudi + `@{Nome}(uid)` + `#[Nome](id)` → link. Implementazione condivisa
// con thread e scheda titolo in `components/mentionAutocomplete.js`.
function renderPostText(rawText) {
  return renderMentionRichText(rawText);
}

function postTextToSharePreview(rawText) {
  let out = String(rawText || "");
  out = out.replace(/@\{([^}]+)\}\(([^)]+)\)/g, "@$1");
  out = out.replace(/#\[([^\]]+)\]\(([^)]+)\)/g, "#$1");
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

function truncateAtWord(text, max = 180) {
  const s = String(text || "").trim();
  if (!s) return "";
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > Math.floor(max * 0.6)) {
    return `${cut.slice(0, lastSpace).trim()}...`;
  }
  return `${s.slice(0, max).trim()}...`;
}

const FEED_TEXT_COLLAPSE_MIN_CHARS = 220;

function feedTextHtml(rawText, { collapsible = false } = {}) {
  const text = String(rawText || "").trim();
  if (!text) return "";
  const parsed = renderPostText(text);
  if (!collapsible || text.length <= FEED_TEXT_COLLAPSE_MIN_CHARS) {
    return `<div class="feed-text">${parsed}</div>`;
  }
  return `
    <div class="feed-text feed-text-collapsible" data-feed-text="1" data-expanded="0">
      <div class="feed-text-body">${parsed}</div>
      <button class="feed-text-more" type="button" data-feed-text-toggle="1" aria-expanded="false">${i18nT("altro")}</button>
    </div>
  `;
}

function postCountLabel(type, count) {
  const n = Math.max(0, Number(count || 0));
  if (type === "likes") return `${n} like`;
  if (type === "comments") return i18nT("{count} commenti", { count: n });
  return `${n} ${n === 1 ? "condivisione" : "condivisioni"}`;
}

function getPostUiState(postId) {
  const id = String(postId || "").trim();
  if (!id) return null;
  if (!state.postUi.has(id)) {
    state.postUi.set(id, {
      hydrated: false,
      hydrating: false,
      liked: false,
      counts: { likes: 0, comments: 0, shares: 0 },
      commentsLoaded: false,
      commentsLoading: false,
      comments: [],
      // Controller del picker menzioni del composer commenti, montato al
      // primo wiring della card (components/mentionAutocomplete.js).
      mentionCtrl: null,
    });
  }
  return state.postUi.get(id);
}

function sharedPostHtml(sharedPost) {
  if (!sharedPost) return "";
  const author = escapeHtml(sharedPost.authorName || "User");
  const titleLink = sharedPost.titleId
    ? `<a class="post-shared-title" href="/title.html?id=${encodeURIComponent(sharedPost.titleId)}">${i18nT("Apri titolo collegato")}</a>`
    : "";
  return `
    <div class="post-shared-quote">
      <div class="post-shared-author">@${author}</div>
      <div class="post-shared-text">${renderPostText(sharedPost.text || "")}</div>
      ${titleLink}
    </div>
  `;
}

function formatFeedRating(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const bounded = Math.max(1, Math.min(10, n));
  const rounded = Math.round(bounded * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function inlineTitleHtml(t, { showPoster = true } = {}) {
  if (!t) return "";
  const poster = showPoster
    ? (t.posterPath
      ? `<span class="feed-inline-title-poster"><img alt="" src="${escapeHtml(t.posterPath)}" loading="lazy" decoding="async"></span>`
      : `<span class="feed-inline-title-poster"><div class="feed-inline-title-ph" aria-hidden="true">🎬</div></span>`)
    : "";
  const year = t.year ? ` (${escapeHtml(String(t.year))})` : "";
  return `
    <div class="feed-inline-title">
      ${poster}
      <a class="feed-inline-title-link" href="/title.html?id=${encodeURIComponent(t.id)}">${escapeHtml(t.name || i18nT("Titolo"))}${year}</a>
      ${titleFollowButtonHtml(t, { variant: "text" })}
    </div>
  `;
}

function feedMediaHtml({ imageUrl, fit = "cover", rating = null, titleName = "" } = {}) {
  const src = String(imageUrl || "").trim();
  if (!src) return "";
  const mediaFit = fit === "contain" ? "contain" : "cover";
  // Guard: solo un rating reale mostra il badge. `Number(null/undefined/"")===0`
  // e `Number.isFinite(0)===true` → senza questo check un POST che linka un
  // titolo (rating null) finiva a "★1/10" per via del clamp Math.max(1,…).
  const ratingValue = (rating !== null && rating !== undefined && rating !== "" && Number.isFinite(Number(rating)))
    ? formatFeedRating(rating)
    : null;
  const ratingBadge = ratingValue
    ? `<div class="feed-media-rating">${iconStar(14)} <span>${escapeHtml(ratingValue)}</span></div>`
    : "";
  return `
    <div class="feed-media-square feed-media-square--${mediaFit}" data-post-media="1">
      <img alt="${escapeHtml(titleName || i18nT("Immagine del post"))}" src="${escapeHtml(src)}" loading="lazy">
      ${ratingBadge}
    </div>
  `;
}

function watchedWithHtml(list = []) {
  const rows = Array.isArray(list) ? list : [];
  const valid = rows
    .map((row) => {
      const uid = String(row?.uid || "").trim();
      const name = String(row?.displayName || "").trim();
      if (!uid || !name) return null;
      return { uid, name };
    })
    .filter(Boolean)
    .slice(0, 6);

  if (!valid.length) return "";
  const first = valid[0];
  if (valid.length === 1) {
    return `<div class="feed-with-people">${i18nT("Con")} <a class="feed-with-person" href="/user.html?uid=${encodeURIComponent(first.uid)}">${escapeHtml(first.name)}</a></div>`;
  }

  const others = valid.slice(1);
  return `
    <div class="feed-with-people" data-with-dropdown="1">
      ${i18nT("Con")} <a class="feed-with-person" href="/user.html?uid=${encodeURIComponent(first.uid)}">${escapeHtml(first.name)}</a>
      <button class="feed-with-more-btn" type="button" data-with-toggle="1">${i18nT("e altri")}</button>
      <div class="feed-with-menu" data-with-menu="1" hidden>
        ${others.map((row) => `
          <a class="feed-with-menu-item" href="/user.html?uid=${encodeURIComponent(row.uid)}">${escapeHtml(row.name)}</a>
        `).join("")}
      </div>
    </div>
  `;
}

function postCommentsPanelHtml() {
  return `
    <div class="post-comments-panel" data-post-comments-panel="1" hidden>
      <div class="post-comments-list" data-post-comments-list="1"></div>
      <div class="post-comment-composer">
        <div class="post-comment-input-wrap">
          <textarea class="input post-comment-input" data-post-comment-input="1" rows="1" maxlength="5000" placeholder="${i18nT("Scrivi un commento...")}"></textarea>
          <div class="mention-dropdown post-comment-mention-dropdown" data-post-comment-mention="1" style="display:none;"></div>
        </div>
        <button class="btn small primary" data-post-comment-send="1" type="button">${i18nT("Invia")}</button>
      </div>
    </div>
  `;
}

function postSocialHtml(it, {
  inline = false,
  includeCommentsPanel = true,
  statsAsButtons = false,
} = {}) {
  if (!it.postId) return "";
  const postId = escapeHtml(it.postId);
  const allowShare = it.kind === "post" || it.kind === "post_share";
  const showShare = allowShare && !inline;
  const cls = inline ? "post-social post-social--inline" : "post-social";
  const likeLabel = inline ? "" : `<span>${i18nT("Like")}</span>`;
  const commentLabel = inline ? "" : `<span>${i18nT("Commenta")}</span>`;
  const likesStat = statsAsButtons
    ? `<button class="post-count-btn" type="button" data-post-likes-stat="1" data-post-count="likes">${postCountLabel("likes", 0)}</button>`
    : `<span data-post-count="likes">${postCountLabel("likes", 0)}</span>`;
  return `
    <div class="${cls}" data-post-social="1" data-post-id="${postId}">
      <div class="post-social-stats" data-post-social-stats="1">
        ${likesStat}
        <button class="post-count-btn" type="button" data-post-comments-stat="1" data-post-count="comments">${postCountLabel("comments", 0)}</button>
        ${showShare ? `<span data-post-count="shares">${postCountLabel("shares", 0)}</span>` : ""}
      </div>
      <div class="post-social-actions">
        <button class="post-action-btn" type="button" data-post-like="1" aria-pressed="false">
          ${iconHeart(16)} ${likeLabel}
        </button>
        <button class="post-action-btn" type="button" data-post-comment-toggle="1">
          ${iconMessageCircle(16)} ${commentLabel}
        </button>
        <button class="post-action-btn" type="button" data-post-report="1"><span>${i18nT("Segnala")}</span></button>
        ${showShare ? `
          <div class="post-share-wrap">
            <button class="post-action-btn" type="button" data-post-share-toggle="1">
              ${iconShare(16)} <span>${i18nT("Condividi")}</span>
            </button>
            <div class="post-share-menu" data-post-share-menu="1" hidden>
              <button type="button" data-post-share-feed="1">${iconRepeat(15)} <span>${i18nT("Ricondividi nel feed")}</span></button>
              <button type="button" data-post-share-external="1">${iconShare(15)} <span>${i18nT("Altri social")}</span></button>
            </div>
          </div>
        ` : ""}
      </div>
      ${includeCommentsPanel ? postCommentsPanelHtml() : ""}
    </div>
  `;
}

function applyPostUiToCard(card, ui) {
  if (!card || !ui) return;
  const likes = Math.max(0, Number(ui.counts?.likes || 0));
  const comments = Math.max(0, Number(ui.counts?.comments || 0));
  const shares = Math.max(0, Number(ui.counts?.shares || 0));

  const likesEl = card.querySelector("[data-post-count='likes']");
  const commentsEl = card.querySelector("[data-post-count='comments']");
  const sharesEl = card.querySelector("[data-post-count='shares']");
  if (likesEl) likesEl.textContent = postCountLabel("likes", likes);
  if (commentsEl) commentsEl.textContent = postCountLabel("comments", comments);
  if (sharesEl) sharesEl.textContent = postCountLabel("shares", shares);

  const likeBtn = card.querySelector("[data-post-like='1']");
  if (likeBtn) {
    likeBtn.classList.toggle("active", !!ui.liked);
    likeBtn.setAttribute("aria-pressed", ui.liked ? "true" : "false");
  }
}

async function hydratePostSocialCard(card) {
  if (!card || !state.me) return;
  const postId = card.getAttribute("data-post-id");
  if (!postId) return;

  const ui = getPostUiState(postId);
  if (!ui) return;
  if (ui.hydrated) {
    applyPostUiToCard(card, ui);
    return;
  }
  if (ui.hydrating) return;

  ui.hydrating = true;
  try {
    const [counts, liked] = await Promise.all([
      getPostSocialCounts(postId).catch(() => ({ likes: 0, comments: 0, shares: 0 })),
      isPostLikedByMe({ postId, uid: state.me.uid }).catch(() => false),
    ]);
    ui.counts = {
      likes: Math.max(0, Number(counts.likes || 0)),
      comments: Math.max(0, Number(counts.comments || 0)),
      shares: Math.max(0, Number(counts.shares || 0)),
    };
    ui.liked = !!liked;
    ui.hydrated = true;
  } finally {
    ui.hydrating = false;
    applyPostUiToCard(card, ui);
  }
}

function commentItemHtml(comment) {
  const uid = String(comment?.uid || "").trim();
  const name = String(comment?.authorName || "").trim() || "User";
  const when = timeText(comment?.createdAt);
  const commentId = String(comment?.id || "").trim();
  const likes = Math.max(0, Number(comment?.likes || 0));
  const liked = !!comment?.likedByMe;
  const authorHtml = uid
    ? `<a class="post-comment-author" href="/user.html?uid=${encodeURIComponent(uid)}">${escapeHtml(name)}</a>`
    : `<span class="post-comment-author">${escapeHtml(name)}</span>`;
  const likeBtnHtml = commentId
    ? `
      <button class="post-comment-like-btn ${liked ? "active" : ""}" type="button" data-post-comment-like="1" data-comment-id="${escapeHtml(commentId)}" aria-pressed="${liked ? "true" : "false"}">
        ${iconHeart(13)}
        <span>${postCountLabel("likes", likes)}</span>
      </button>
    `
    : "";
  return `
    <div class="post-comment-item">
      ${authorHtml}
      <div class="post-comment-text">${renderPostText(comment?.text || "")}</div>
      <div class="post-comment-footer">
        <div class="post-comment-time">${escapeHtml(when)}</div>
        ${likeBtnHtml}
        ${commentId ? `<button class="post-comment-like-btn" type="button" data-comment-report="1" data-comment-id="${escapeHtml(commentId)}">${i18nT("Segnala")}</button>` : ""}
      </div>
    </div>
  `;
}

function autoResizeCommentInput(textarea) {
  if (!textarea) return;
  const MAX = 200;
  textarea.style.height = "auto";
  const nextHeight = Math.min(MAX, textarea.scrollHeight);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > MAX ? "auto" : "hidden";
}

function renderCommentsList(card, ui) {
  const list = card.querySelector("[data-post-comments-list='1']");
  if (!list) return;
  const comments = Array.isArray(ui?.comments) ? ui.comments : [];
  if (!comments.length) {
    list.innerHTML = `<div class="hint">${i18nT("Nessun commento per ora.")}</div>`;
    return;
  }
  list.innerHTML = comments.map(commentItemHtml).join("");
}

async function ensureCommentsLoaded(card) {
  const postId = card.getAttribute("data-post-id");
  if (!postId) return;
  const ui = getPostUiState(postId);
  if (!ui) return;
  if (ui.commentsLoaded) {
    renderCommentsList(card, ui);
    return;
  }
  if (ui.commentsLoading) return;

  const list = card.querySelector("[data-post-comments-list='1']");
  if (list) list.innerHTML = `<div class="hint">${i18nT("Caricamento commenti...")}</div>`;

  ui.commentsLoading = true;
  try {
    const comments = await listPostComments(postId, { max: 20, viewerUid: state.me?.uid || null }).catch(() => []);
    ui.comments = comments;
    ui.commentsLoaded = true;
    ui.counts.comments = Math.max(ui.counts.comments || 0, comments.length);
    renderCommentsList(card, ui);
    applyPostUiToCard(card, ui);
  } finally {
    ui.commentsLoading = false;
  }
}

function closeAllPostShareMenus(except = null) {
  document.querySelectorAll("[data-post-share-menu='1']").forEach(menu => {
    if (except && menu === except) return;
    menu.hidden = true;
  });
}

function closeAllWatchedWithMenus(except = null) {
  document.querySelectorAll("[data-with-menu='1']").forEach((menu) => {
    if (except && menu === except) return;
    menu.hidden = true;
  });
}

function resolveSourcePostForShare(postId) {
  const src = state.postMap.get(String(postId || ""));
  if (!src) return null;
  if (src.postKind === "share" && src.sharedPost) {
    return { ...src.sharedPost };
  }

  const fallbackName = state.userMap.get(src.actorUid)?.displayName || src.actorUid || "User";
  return {
    postId: src.postId,
    authorUid: src.actorUid,
    authorName: src.authorName || fallbackName,
    text: src.text || "",
    titleId: src.titleId || null,
  };
}

// I post editoriali hanno una pagina pubblica (/novita/<slug>): leggibile
// senza login e con i tag og:, quindi e' quella che va condivisa fuori. Lo
// slug e' l'inverso del post id deterministico `official_<slug>` scritto da
// publishOfficialUpdate. Gli altri post restano sul link interno: sono
// pubblici fra gli iscritti, non sul web aperto.
function officialUpdateShareSlug(src) {
  if (!src || String(src.authorUid || "") !== SOMTO_OFFICIAL_UID) return "";
  const fromMeta = String(src.officialUpdate?.slug || "").trim();
  if (fromMeta) return fromMeta;
  const id = String(src.postId || "").trim();
  return id.startsWith("official_") ? id.slice("official_".length) : "";
}

function buildExternalSharePayload(postId) {
  const src = resolveSourcePostForShare(postId);
  const author = String(src?.authorName || "").trim();
  const preview = truncateAtWord(postTextToSharePreview(src?.text || ""), 180);
  const officialSlug = officialUpdateShareSlug(src);
  const url = officialSlug
    ? `${window.location.origin}/novita/${encodeURIComponent(officialSlug)}`
    : `${window.location.origin}/community.html?post=${encodeURIComponent(postId)}`;
  const intro = author
    ? i18nT("Guarda il post di {author} su Somto", { author })
    : i18nT("Guarda questo post su Somto");
  const text = preview
    ? `${intro}: ${preview}`
    : intro;
  return {
    title: author ? `Post di ${author} su Somto` : "Post su Somto",
    text,
    url,
  };
}

// Badge "Ufficiale" sui post di Somto (publishOfficialUpdate). Parità con iOS
// CommunityView.OfficialUpdateBadge (stessa icona checkmark, stesso testo).
function officialUpdateBadgeHtml() {
  return `<span class="official-update-badge" title="${i18nT("Aggiornamento ufficiale Somto")}" aria-label="${i18nT("Aggiornamento ufficiale Somto")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"></path></svg>${i18nT("Ufficiale")}</span>`;
}

function itemHtml(it) {
  if (it.kind === "suggestion") {
    const t = state.titleMap.get(it.titleId);
    return `
      <div class="feed-item" data-kind="suggestion" data-title-id="${escapeHtml(it.titleId)}">
        <div class="feed-item-header">
          <div class="avatar" aria-hidden="true">★</div>
          <div class="meta">
            <div class="line1">${i18nT("Suggerito per te")}</div>
            <div class="line2">${i18nT("in base ai tuoi voti")}</div>
          </div>
        </div>
        <div class="feed-item-content">
          ${miniTitleHtml(t, { showBookmark: true })}
        </div>
        <div class="feed-footer">
          <button class="btn small thread-cta" type="button" data-open-thread="1" data-title-id="${escapeHtml(it.titleId)}">
            ${iconMessageCircle(18)} <span>${i18nT("Thread")}</span>
          </button>
        </div>
      </div>
    `;
  }

  const u = state.userMap.get(it.actorUid);
  const who = u?.displayName || it.actorUid;
  const action = actionTextForItem(it);
  const when = timeText(it.ts);
  const t = it.titleId ? state.titleMap.get(it.titleId) : null;

  // Compact card for lightweight events
  if (it.kind === "title_added") {
    const titleName = t ? escapeHtml(t.name || "") : i18nT("un titolo");
    const titleHref = t ? `/title.html?id=${encodeURIComponent(t.id)}` : "";
    return `
      <div class="feed-item feed-item--compact" data-kind="title_added"${titleHref ? ` data-title-href="${escapeHtml(titleHref)}"` : ""}>
        <div class="feed-item-header">
          ${renderAvatarHtml(u, { linkUid: it.actorUid })}
          <div class="meta">
            <div class="line1">
              <span class="feed-icon feed-icon--film">${iconFilmPlus(14)}</span>
              ${escapeHtml(who)} <span style="font-weight: var(--weight-regular); color: var(--text-secondary);">ha aggiunto</span>
            </div>
            <div class="line2">${escapeHtml(when)}</div>
          </div>
        </div>
        <div class="feed-item-content">
          ${t ? miniTitleHtml(t, { showBookmark: true }) : `<span class="muted">${titleName}</span>`}
        </div>
        ${t ? `
          <div class="feed-footer">
            <button class="btn small thread-cta" type="button" data-open-thread="1" data-title-id="${escapeHtml(t.id)}">
              ${iconMessageCircle(18)} <span>${i18nT("Thread")}</span>
            </button>
          </div>
        ` : ""}
      </div>
    `;
  }

  if (it.kind === "friend_added") {
    const otherUser = state.userMap.get(it.otherUid);
    const otherName = otherUser?.displayName || it.otherUid;
    return `
      <div class="feed-item feed-item--compact" data-kind="friend_added">
        <div class="feed-item-header">
          <div class="feed-avatar-pair">
            ${renderAvatarHtml(otherUser, { linkUid: it.otherUid })}
            ${renderAvatarHtml(u, { linkUid: it.actorUid })}
          </div>
          <div class="meta">
            <div class="line1">
              <span class="feed-icon feed-icon--friend">${iconUsers(14)}</span>
              ${i18nT("Tu e")} <a href="/user.html?uid=${encodeURIComponent(it.otherUid)}">${escapeHtml(otherName)}</a>
            </div>
            <div class="line2">Siete diventati amici &middot; ${escapeHtml(when)}</div>
          </div>
        </div>
      </div>
    `;
  }

  if (it.kind === "follow") {
    const otherUser = state.userMap.get(it.otherUid);
    const otherName = otherUser?.displayName || it.otherUid || i18nT("un utente");
    return `
      <div class="feed-item feed-item--compact" data-kind="follow">
        <div class="feed-item-header">
          ${renderAvatarHtml(u, { linkUid: it.actorUid })}
          <div class="meta">
            <div class="line1">
              <span class="feed-icon feed-icon--friend">${iconUsers(14)}</span>
              ${escapeHtml(who)} <span style="font-weight: var(--weight-regular); color: var(--text-secondary);">${i18nT("segue ora")}</span>
              ${it.otherUid ? `<a href="/user.html?uid=${encodeURIComponent(it.otherUid)}">${escapeHtml(otherName)}</a>` : `<span>${escapeHtml(otherName)}</span>`}
            </div>
            <div class="line2">${escapeHtml(when)}</div>
          </div>
        </div>
      </div>
    `;
  }

  if (it.kind === "series_started") {
    const titleName = t ? escapeHtml(t.name || "") : i18nT("una serie");
    const titleHref = t ? `/title.html?id=${encodeURIComponent(t.id)}` : "";
    return `
      <div class="feed-item feed-item--compact" data-kind="series_started"${titleHref ? ` data-title-href="${escapeHtml(titleHref)}"` : ""}>
        <div class="feed-item-header">
          ${renderAvatarHtml(u, { linkUid: it.actorUid })}
          <div class="meta">
            <div class="line1">
              <span class="feed-icon feed-icon--film">${iconEye(14)}</span>
              ${escapeHtml(who)} <span style="font-weight: var(--weight-regular); color: var(--text-secondary);">ha iniziato a guardare</span>
            </div>
            <div class="line2">${escapeHtml(when)}</div>
          </div>
        </div>
        <div class="feed-item-content">
          ${t ? miniTitleHtml(t, { showBookmark: true }) : `<span class="muted">${titleName}</span>`}
        </div>
      </div>
    `;
  }

  // Commento su film / serie / episodio, eco di un messaggio di thread
  // pubblico. Card volutamente leggera (niente like/condivisione: la
  // conversazione vive nel thread) e testo dietro al gate anti-spoiler
  // calcolato sul progresso del viewer.
  if (it.kind === "title_comment") {
    const scope = it.spoilerScope || null;
    const label = scopeLabel(scope);
    const entry = progressEntryFor(it.titleId);
    // Il commento che hai scritto tu non va mai sfocato: lo spoiler è tuo.
    const isMine = !!state.me?.uid && it.actorUid === state.me.uid;
    const unlocked = isMine || isUnlockedByProgress(scope, entry);
    const bodyHtml = [
      String(it.text || "").trim() ? feedTextHtml(it.text || "", { collapsible: true }) : "",
      it.mediaUrl ? `<img class="feed-comment-gif" src="${escapeHtml(it.mediaUrl)}" alt="GIF" loading="lazy">` : "",
      it.textTruncated ? `<div class="feed-comment-more">…</div>` : "",
    ].join("");
    const titleHrefComment = it.titleId ? `/title.html?id=${encodeURIComponent(it.titleId)}` : "";

    return `
      <div class="feed-item feed-item--comment" data-kind="title_comment" data-title-id="${escapeHtml(it.titleId || "")}"${titleHrefComment ? ` data-title-href="${escapeHtml(titleHrefComment)}"` : ""}${it.postId ? ` data-post-id="${escapeHtml(it.postId)}"` : ""}${it.threadId ? ` data-thread-id="${escapeHtml(it.threadId)}"` : ""}>
        <div class="feed-item-header">
          ${renderAvatarHtml(u, { linkUid: it.actorUid })}
          <div class="meta">
            <div class="line1">
              <span class="feed-icon feed-icon--comment">${iconChat(14)}</span>
              ${escapeHtml(who)} <span style="font-weight: var(--weight-regular); color: var(--text-secondary);">${i18nT("ha commentato")}</span>
              ${label ? `<span class="feed-scope-chip">${escapeHtml(label)}</span>` : ""}
            </div>
            <div class="line2">${escapeHtml(when)}</div>
          </div>
        </div>
        <div class="feed-item-content">
          <div class="feed-comment-body">
            ${unlocked ? bodyHtml : wrapProgressSpoiler(bodyHtml, { scope, entry, titleName: t?.name || "" })}
          </div>
          ${t ? miniTitleHtml(t, { showBookmark: true }) : ""}
        </div>
        <div class="feed-footer feed-footer--comment">
          <button class="btn small" type="button" data-comment-reply="1"${unlocked ? "" : " disabled"}>
            ${iconMessageCircle(18)} <span>${i18nT("Rispondi")}</span>
          </button>
          <button class="btn small ghost" type="button" data-open-comment-thread="1">
            <span>${i18nT("Apri la discussione")}</span>
          </button>
        </div>
        <div class="feed-comment-composer" hidden>
          <div class="feed-comment-input-wrap">
            <textarea class="feed-comment-input" rows="2" maxlength="5000" placeholder="${i18nT("Scrivi un commento")}"></textarea>
            <div class="mention-dropdown feed-comment-mention-dropdown" data-feed-comment-mention="1" style="display:none;"></div>
          </div>
          <button class="btn small primary" type="button" data-comment-send="1">${i18nT("Invia")}</button>
        </div>
      </div>
    `;
  }

  const isPostLike = it.kind === "post" || it.kind === "post_share";
  const isWatchTogether = it.kind === "watch_together";
  const hasSocial = isPostLike || it.kind === "rating" || isWatchTogether;
  const bodyParts = [];
  const isMediaPost = isPostLike || it.kind === "rating" || isWatchTogether;
  const hasUserMedia = !!String(it.mediaUrl || "").trim();
  const primaryMediaUrl = (() => {
    if (it.kind === "rating") {
      if (it.mediaUrl) return it.mediaUrl;
      if (t?.posterPath) return t.posterPath;
      return null;
    }
    if (isWatchTogether) {
      if (it.mediaUrl) return it.mediaUrl;
      if (t?.posterPath) return t.posterPath;
      return null;
    }
    if (it.mediaUrl) return it.mediaUrl;
    if (t?.posterPath) return t.posterPath;
    if (it.sharedPost?.titleId) {
      const sharedTitle = state.titleMap.get(it.sharedPost.titleId);
      return sharedTitle?.posterPath || null;
    }
    return null;
  })();
  const primaryMediaFit = (() => {
    if (it.kind === "rating" || isWatchTogether) {
      return hasUserMedia ? "cover" : "contain";
    }
    if (hasUserMedia) return "cover";
    return "contain";
  })();
  const socialInline = hasSocial && isMediaPost && !!primaryMediaUrl;
  const showSideTitleOnSocialRow = socialInline && hasUserMedia && !!t;

  if (isMediaPost && primaryMediaUrl) {
    bodyParts.push(feedMediaHtml({
      imageUrl: primaryMediaUrl,
      fit: primaryMediaFit,
      rating: it.kind === "rating" ? it.rating : null,
      titleName: t?.name || "",
    }));
  }
  if (socialInline) {
    bodyParts.push(`
      <div class="feed-media-social-row${showSideTitleOnSocialRow ? " feed-media-social-row--with-title" : ""}">
        <div class="feed-media-social-left">
          ${postSocialHtml(it, { inline: true, includeCommentsPanel: false, statsAsButtons: true })}
        </div>
        ${showSideTitleOnSocialRow ? `
          <div class="feed-media-social-right">
            ${inlineTitleHtml(t, { showPoster: true })}
          </div>
        ` : ""}
      </div>
    `);
  }

  const metaLeftParts = [];
  if ((it.kind === "rating" || isWatchTogether) && Array.isArray(it.watchedWith) && it.watchedWith.length) {
    const withHtml = watchedWithHtml(it.watchedWith);
    if (withHtml) metaLeftParts.push(withHtml);
  }
  if (it.kind === "rating" && String(it.reviewText || "").trim()) {
    metaLeftParts.push(feedTextHtml(it.reviewText || "", { collapsible: true }));
  }
  if (isPostLike && String(it.text || "").trim()) {
    // I post ufficiali non si collassano: la parte nascosta dietro "altro" e'
    // esattamente il contenuto (elenco dei titoli, domanda finale, link).
    metaLeftParts.push(feedTextHtml(it.text || "", { collapsible: !it.isOfficialUpdate }));
  }
  if (it.kind === "post_share") {
    metaLeftParts.push(sharedPostHtml(it.sharedPost));
  }

  if (isMediaPost) {
    if (metaLeftParts.length) {
      bodyParts.push(`<div class="feed-media-description">${metaLeftParts.join("")}</div>`);
    }
    if (t && !showSideTitleOnSocialRow) {
      bodyParts.push(`
        <div class="feed-media-title-row">
          ${inlineTitleHtml(t, { showPoster: hasUserMedia })}
        </div>
      `);
    }
    if (socialInline) {
      bodyParts.push(postCommentsPanelHtml());
    }
  } else {
    bodyParts.push(...metaLeftParts);
  }

  if (it.kind === "thread") {
    bodyParts.push(`<div class="thread-snippet">${escapeHtml(it.snippet || "")}</div>`);
  }
  if (it.kind === "recommendation" && String(it.snippet || "").trim()) {
    bodyParts.push(`<div class="thread-snippet">${escapeHtml(it.snippet || "")}</div>`);
  }
  if (it.kind === "post_comment") {
    const prefix = it.snippet ? i18nT("Commento: {snippet}", { snippet: it.snippet }) : i18nT("Nuovo commento");
    bodyParts.push(`<div class="thread-snippet">${escapeHtml(prefix)}</div>`);
  }
  if (!isMediaPost && t) {
    bodyParts.push(miniTitleHtml(t, { showBookmark: true }));
  }

  const titleHref = (it.titleId && !isMediaPost) ? `/title.html?id=${encodeURIComponent(it.titleId)}` : "";
  const postIdAttr = hasSocial && it.postId ? ` data-post-id="${escapeHtml(it.postId)}"` : "";
  const mediaItemClass = isMediaPost ? " feed-item--media-post" : "";
  return `
    <div class="feed-item${mediaItemClass}" data-kind="${escapeHtml(it.kind)}" data-title-id="${escapeHtml(it.titleId || "")}"${titleHref ? ` data-title-href="${escapeHtml(titleHref)}"` : ""}${postIdAttr}>
      <div class="feed-item-header">
        ${renderAvatarHtml(u, { linkUid: it.actorUid })}
        <div class="meta">
          <div class="line1${it.isOfficialUpdate ? " line1--official" : ""}">${escapeHtml(who)} <span style="font-weight: var(--weight-regular); color: var(--text-secondary);">${escapeHtml(action)}</span>${it.isOfficialUpdate ? officialUpdateBadgeHtml() : ""}</div>
          <div class="line2">${escapeHtml(when)}</div>
        </div>
      </div>
      <div class="feed-item-content">${bodyParts.join("")}</div>
      ${hasSocial && !socialInline ? postSocialHtml(it) : ""}
      ${it.titleId && !isMediaPost ? `
        <div class="feed-footer">
          <button class="btn small thread-cta" type="button" data-open-thread="1" data-title-id="${escapeHtml(it.titleId)}">
            ${iconMessageCircle(18)} <span>${i18nT("Thread")}</span>
          </button>
        </div>
      ` : ""}
    </div>
  `;
}

function setInlineActionBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  if (busy) {
    button.dataset.loading = "true";
    button.setAttribute("aria-busy", "true");
  } else {
    delete button.dataset.loading;
    button.removeAttribute("aria-busy");
  }
}

async function wireFeedInteractions(container) {
  const root = container || document;

  // Card click => navigate to title page (skip if clicking interactive elements)
  root.querySelectorAll("[data-title-href]").forEach(card => {
    if (card.dataset.wiredTitleNav === "1") return;
    card.dataset.wiredTitleNav = "1";
    card.style.cursor = "pointer";
    card.addEventListener("click", (e) => {
      // Don't navigate if clicking on a link, button, or interactive element inside
      const target = e.target.closest("a, button, input, textarea, select, label, [contenteditable], [data-bookmark], [data-open-thread], [data-post-social='1']");
      if (target) return;
      const href = card.getAttribute("data-title-href");
      if (href) window.location.href = href;
    });
  });

  // Thread CTA => ensure public thread and navigate
  root.querySelectorAll("[data-open-thread='1']").forEach(btn => {
    if (btn.dataset.wiredThreadCta === "1") return;
    btn.dataset.wiredThreadCta = "1";
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const titleId = btn.getAttribute("data-title-id");
      if (!titleId || !state.me) return;
      await runWithButtonLoading(btn, async () => {
        try {
          const thr = await ensurePublicThread({ titleId, createdBy: state.me.uid });
          window.location.href = `/thread.html?tid=${encodeURIComponent(thr.id)}`;
        } catch (err) {
          console.error(err);
          toast(err?.message || i18nT("Errore"), i18nT("Thread"), { type: "error" });
        }
      }, { loadingLabel: i18nT("Apertura...") });
    });
  });

  // Card commento: reveal del gate anti-spoiler (per-item, non persistente).
  attachSpoilerHandlers(root);

  // Card commento: "Apri la discussione" → thread di origine (l'id è già sul
  // post-eco, nessuna ensurePublicThread necessaria).
  root.querySelectorAll("[data-open-comment-thread='1']").forEach((btn) => {
    if (btn.dataset.wiredCommentThread === "1") return;
    btn.dataset.wiredCommentThread = "1";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const card = btn.closest(".feed-item");
      const tid = card?.getAttribute("data-thread-id");
      if (!tid) return;
      window.location.href = `/thread.html?tid=${encodeURIComponent(tid)}`;
    });
  });

  // Card commento: "Rispondi" apre il composer inline. La risposta va nel
  // THREAD, non nei commenti del post-eco: una sola conversazione per titolo,
  // visibile identica dal feed e dalla scheda titolo.
  root.querySelectorAll("[data-comment-reply='1']").forEach((btn) => {
    if (btn.dataset.wiredCommentReply === "1") return;
    btn.dataset.wiredCommentReply = "1";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const card = btn.closest(".feed-item");
      const composerEl = card?.querySelector(".feed-comment-composer");
      if (!composerEl) return;
      composerEl.hidden = !composerEl.hidden;
      const input = composerEl.querySelector(".feed-comment-input");
      if (composerEl.hidden) {
        input?.__mentionCtrl?.close();
        return;
      }
      // Il picker si monta all'apertura: le card del feed sono tante e il
      // composer di risposta lo apre una alla volta.
      wireFeedCommentMention(composerEl);
      input?.focus();
    });
  });

  root.querySelectorAll("[data-comment-send='1']").forEach((btn) => {
    if (btn.dataset.wiredCommentSend === "1") return;
    btn.dataset.wiredCommentSend = "1";
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const card = btn.closest(".feed-item");
      const input = card?.querySelector(".feed-comment-input");
      const threadId = card?.getAttribute("data-thread-id");
      const raw = String(input?.value || "").trim();
      if (!state.me || !threadId || !raw) return;

      const ctrl = wireFeedCommentMention(card?.querySelector(".feed-comment-composer"));
      const text = ctrl ? await ctrl.resolveForSend(raw) : raw;

      const meName = state.userMap.get(state.me.uid)?.displayName || "User";
      await runWithButtonLoading(btn, async () => {
        try {
          await sendThreadMessage({
            threadId,
            senderUid: state.me.uid,
            displayName: meName,
            text,
          });
          if (input) input.value = "";
          ctrl?.reset();
          const composerEl = card?.querySelector(".feed-comment-composer");
          if (composerEl) composerEl.hidden = true;
          toast(i18nT("Risposta inviata"), i18nT("Discussione"), { type: "success" });
          void logEvent("community_comment_reply_sent", { message_len: text.length });
        } catch (err) {
          console.error("[community] reply to thread failed", err);
          toast(err?.message || i18nT("Errore"), i18nT("Discussione"), { type: "error" });
        }
      }, { loadingLabel: i18nT("Invio...") });
    });
  });

  // "Segui" gli aggiornamenti del titolo. Toggle secco follow ⇄ auto: le
  // sfumature ("solo importanti", "silenzia") restano sulla scheda titolo,
  // qui serve una sola decisione.
  root.querySelectorAll("[data-title-follow='1']").forEach((btn) => {
    if (btn.dataset.wiredTitleFollow === "1") return;
    btn.dataset.wiredTitleFollow = "1";

    const titleId = btn.getAttribute("data-title-id");
    if (!titleId || !state.me) return;

    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!state.me) return;
      const wasFollowing = state.titleUpdatePrefs.get(titleId) === "follow";
      const nextMode = wasFollowing ? "auto" : "follow";
      await runWithButtonLoading(btn, async () => {
        try {
          await setTitleUpdatePreference(state.me.uid, titleId, nextMode);
          if (nextMode === "follow") state.titleUpdatePrefs.set(titleId, "follow");
          else state.titleUpdatePrefs.delete(titleId);
          toast(i18nT("Preferenza salvata."), i18nT("Aggiornamenti"), { type: "success" });
        } catch (err) {
          console.error("[community] follow title failed", err);
          toast(err?.message || i18nT("Impossibile salvare la preferenza. Riprova."), i18nT("Errore"), { type: "error" });
        }
      }, { loadingLabel: "…" });
      // Dopo, non dentro: runWithButtonLoading ripristina l'innerHTML del
      // bottone alla fine, e si mangerebbe l'etichetta appena aggiornata.
      syncTitleFollowButtons(titleId);
    });
  });

  // Watchlist bookmark toggle
  root.querySelectorAll("[data-bookmark='1']").forEach(btn => {
    if (btn.dataset.wiredBookmark === "1") return;
    btn.dataset.wiredBookmark = "1";

    const titleId = btn.getAttribute("data-title-id");
    if (!titleId || !state.me) return;

    // check status best-effort
    isInWatchlist(state.me.uid, titleId).then(inWl => {
      if (inWl) btn.classList.add("active");
    }).catch(() => {});

    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!state.me) return;
      const isActive = btn.classList.contains("active");
      await runWithButtonLoading(btn, async () => {
        try {
          if (isActive) {
            await removeFromWatchlist(state.me.uid, titleId);
            btn.classList.remove("active");
            toast(i18nT("Rimosso dalla watchlist"), i18nT("Watchlist"), { type: "success" });
          } else {
            await addToWatchlist(state.me.uid, titleId);
            btn.classList.add("active");
            toast(i18nT("Aggiunto alla watchlist"), i18nT("Watchlist"), { type: "success" });
          }
        } catch (err) {
          console.error(err);
          toast(err?.message || i18nT("Errore"), i18nT("Watchlist"), { type: "error" });
        }
      }, { loadingLabel: "…" });
    });
  });

  root.querySelectorAll("[data-with-dropdown='1']").forEach((row) => {
    if (row.dataset.wiredWithDropdown === "1") return;
    row.dataset.wiredWithDropdown = "1";
    const toggle = row.querySelector("[data-with-toggle='1']");
    const menu = row.querySelector("[data-with-menu='1']");
    if (!toggle || !menu) return;

    toggle.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const willOpen = menu.hidden;
      closeAllWatchedWithMenus(willOpen ? menu : null);
      menu.hidden = !willOpen;
    });
  });

  root.querySelectorAll("[data-feed-text-toggle='1']").forEach((btn) => {
    if (btn.dataset.wiredFeedTextToggle === "1") return;
    btn.dataset.wiredFeedTextToggle = "1";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const wrap = btn.closest("[data-feed-text='1']");
      if (!wrap) return;
      const nextExpanded = !wrap.classList.contains("is-expanded");
      wrap.classList.toggle("is-expanded", nextExpanded);
      wrap.setAttribute("data-expanded", nextExpanded ? "1" : "0");
      btn.textContent = nextExpanded ? "meno" : "altro";
      btn.setAttribute("aria-expanded", nextExpanded ? "true" : "false");
    });
  });

  // Post social actions (like/comment/share)
  // Batch hydration: fire-and-forget tutte le card insieme invece di una await per card.
  const socialCards = Array.from(root.querySelectorAll(".feed-item[data-post-id]"));
  if (socialCards.length && state.me) {
    void Promise.allSettled(
      socialCards.map(card => hydratePostSocialCard(card))
    );
  }
  socialCards.forEach(card => {
    const postId = card.getAttribute("data-post-id");
    if (!postId || !state.me) return;

    const likeBtn = card.querySelector("[data-post-like='1']");
    const likesStatBtn = card.querySelector("[data-post-likes-stat='1']");
    const mediaEl = card.querySelector("[data-post-media='1']");
    const toggleLikeFromUi = async ({ burstOnLike = false } = {}) => {
      if (!state.me) return false;
      const ui = getPostUiState(postId);
      if (!ui) return false;
      if (!ui.hydrated) await hydratePostSocialCard(card);

      const wasLiked = !!ui.liked;
      setInlineActionBusy(likeBtn, true);
      setInlineActionBusy(likesStatBtn, true);
      try {
        const { liked } = await togglePostLike({ postId, uid: state.me.uid });
        ui.liked = !!liked;
        if (liked && !wasLiked) ui.counts.likes += 1;
        if (!liked && wasLiked) ui.counts.likes = Math.max(0, ui.counts.likes - 1);
        applyPostUiToCard(card, ui);
        if (liked && burstOnLike && mediaEl) {
          mediaEl.classList.remove("feed-media-like-burst");
          // force reflow for retrigger animation
          void mediaEl.offsetWidth;
          mediaEl.classList.add("feed-media-like-burst");
        }
        return !!liked;
      } catch (err) {
        console.error(err);
        toast(i18nT("Non riesco a mettere like ora"), i18nT("Like"));
        return false;
      } finally {
        setInlineActionBusy(likeBtn, false);
        setInlineActionBusy(likesStatBtn, false);
      }
    };

    if (likeBtn && likeBtn.dataset.wiredPostLike !== "1") {
      likeBtn.dataset.wiredPostLike = "1";
      likeBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await toggleLikeFromUi();
      });
    }

    if (likesStatBtn && likesStatBtn.dataset.wiredPostLikesStat !== "1") {
      likesStatBtn.dataset.wiredPostLikesStat = "1";
      likesStatBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await toggleLikeFromUi();
      });
    }

    if (mediaEl && mediaEl.dataset.wiredPostMediaLike !== "1") {
      mediaEl.dataset.wiredPostMediaLike = "1";
      let lastTapAt = 0;
      mediaEl.addEventListener("click", async (e) => {
        const now = Date.now();
        if (now - lastTapAt <= 280) {
          e.preventDefault();
          e.stopPropagation();
          lastTapAt = 0;
          await toggleLikeFromUi({ burstOnLike: true });
          return;
        }
        lastTapAt = now;
      });
      mediaEl.addEventListener("animationend", () => {
        mediaEl.classList.remove("feed-media-like-burst");
      });
    }

    const commentsPanel = card.querySelector("[data-post-comments-panel='1']");
    const toggleCommentsBtn = card.querySelector("[data-post-comment-toggle='1']");
    const commentsStatBtn = card.querySelector("[data-post-comments-stat='1']");
    if (commentsPanel && card.classList.contains("feed-item--media-post")) {
      commentsPanel.hidden = true;
    }
    const setCommentToggleLabel = (isOpen) => {
      const label = toggleCommentsBtn?.querySelector("span");
      if (label) label.textContent = isOpen ? i18nT("Nascondi") : i18nT("Commenta");
      if (toggleCommentsBtn) {
        toggleCommentsBtn.setAttribute("aria-label", isOpen ? i18nT("Nascondi commenti") : i18nT("Apri commenti"));
      }
    };
    const openCommentsPanel = async () => {
      if (!commentsPanel) return;
      commentsPanel.hidden = false;
      toggleCommentsBtn?.classList?.add("active");
      setCommentToggleLabel(true);
      await ensureCommentsLoaded(card);
      const input = card.querySelector("[data-post-comment-input='1']");
      input?.focus();
    };
    setCommentToggleLabel(!!commentsPanel && !commentsPanel.hidden);

    if (toggleCommentsBtn && commentsPanel && toggleCommentsBtn.dataset.wiredPostComments !== "1") {
      toggleCommentsBtn.dataset.wiredPostComments = "1";
      toggleCommentsBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const nextOpen = commentsPanel.hidden;
        if (nextOpen) {
          await openCommentsPanel();
          return;
        }
        commentsPanel.hidden = true;
        toggleCommentsBtn.classList.remove("active");
        setCommentToggleLabel(false);
        getPostUiState(postId)?.mentionCtrl?.close();
      });
    }

    if (commentsStatBtn && commentsStatBtn.dataset.wiredPostCommentsStat !== "1") {
      commentsStatBtn.dataset.wiredPostCommentsStat = "1";
      commentsStatBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!commentsPanel?.hidden) return;
        await openCommentsPanel();
      });
    }

    const commentInput = card.querySelector("[data-post-comment-input='1']");
    const commentMentionDropdown = card.querySelector("[data-post-comment-mention='1']");
    const commentsList = card.querySelector("[data-post-comments-list='1']");
    const sendCommentBtn = card.querySelector("[data-post-comment-send='1']");
    const reportPostBtn = card.querySelector("[data-post-report='1']");
    if (reportPostBtn && reportPostBtn.dataset.wired !== "1") {
      reportPostBtn.dataset.wired = "1";
      reportPostBtn.addEventListener("click", async (e) => {
        e.preventDefault(); e.stopPropagation();
        const reason = prompt(i18nT("Motivo della segnalazione:"))?.trim();
        if (!reason || !state.me) return;
        try {
          await sendReport({ type: "post", targetId: postId, reason, fromUid: state.me.uid });
          toast("Segnalazione inviata. Grazie.", "Sicurezza");
        } catch (err) { toast(err?.message || i18nT("Segnalazione non riuscita"), "Sicurezza"); }
      });
    }
    if (commentInput && sendCommentBtn && sendCommentBtn.dataset.wiredPostCommentSend !== "1") {
      sendCommentBtn.dataset.wiredPostCommentSend = "1";
      const ui = getPostUiState(postId);
      autoResizeCommentInput(commentInput);
      attachCharCounter(commentInput);

      const submitComment = async () => {
        if (!state.me) return;
        const rawBody = String(commentInput.value || "");
        const body = rawBody.trim();
        if (!body) {
          toast(i18nT("Scrivi un commento"), i18nT("Commenti"));
          return;
        }

        if (!ui) return;
        if (!ui.hydrated) await hydratePostSocialCard(card);

        const meName = state.userMap.get(state.me.uid)?.displayName || "User";
        const text = ui.mentionCtrl ? await ui.mentionCtrl.resolveForSend(body) : body;

        await runWithButtonLoading(sendCommentBtn, async () => {
          const saved = await addPostComment({
            postId,
            uid: state.me.uid,
            authorName: meName,
            text,
          });
          const localComment = { ...saved, createdAt: Date.now(), likes: 0, likedByMe: false };
          ui.comments = [...(ui.comments || []), localComment].slice(-40);
          ui.commentsLoaded = true;
          ui.counts.comments += 1;
          commentInput.value = "";
          commentInput.style.height = "auto";
          commentInput.style.overflowY = "hidden";
          ui.mentionCtrl?.reset();
          renderCommentsList(card, ui);
          applyPostUiToCard(card, ui);
        }, { loadingLabel: "Invio…" });
      };

      if (ui) {
        ui.mentionCtrl = attachMentionAutocomplete(commentInput, commentMentionDropdown, {
          searchTargets: searchCommunityMentionTargets,
          onInsert: () => autoResizeCommentInput(commentInput),
          onEnterSubmit: submitComment,
        });
      }
      commentInput.addEventListener("input", () => autoResizeCommentInput(commentInput));

      sendCommentBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await submitComment();
      });
    }

    if (commentsList && commentsList.dataset.wiredCommentLikes !== "1") {
      commentsList.dataset.wiredCommentLikes = "1";
      commentsList.addEventListener("click", async (e) => {
        const reportBtn = e.target.closest("[data-comment-report='1']");
        if (reportBtn) {
          e.preventDefault(); e.stopPropagation();
          const commentId = reportBtn.getAttribute("data-comment-id");
          const reason = prompt(i18nT("Motivo della segnalazione:"))?.trim();
          if (!reason || !commentId || !state.me) return;
          try {
            await sendReport({ type: "comment", targetId: `${postId}:${commentId}`, reason, fromUid: state.me.uid });
            toast("Segnalazione inviata. Grazie.", "Sicurezza");
          } catch (err) { toast(err?.message || i18nT("Segnalazione non riuscita"), "Sicurezza"); }
          return;
        }
        const btn = e.target.closest("[data-post-comment-like='1']");
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        if (!state.me) return;

        const commentId = btn.getAttribute("data-comment-id");
        if (!commentId) return;
        const ui = getPostUiState(postId);
        if (!ui) return;
        const idx = (ui.comments || []).findIndex(c => c.id === commentId);
        if (idx < 0) return;

        setInlineActionBusy(btn, true);
        try {
          const { liked } = await togglePostCommentLike({
            postId,
            commentId,
            uid: state.me.uid,
          });
          const row = ui.comments[idx];
          const prevLiked = !!row.likedByMe;
          row.likedByMe = !!liked;
          const prevLikes = Math.max(0, Number(row.likes || 0));
          if (liked && !prevLiked) row.likes = prevLikes + 1;
          if (!liked && prevLiked) row.likes = Math.max(0, prevLikes - 1);
          renderCommentsList(card, ui);
        } catch (err) {
          console.error(err);
          toast(i18nT("Non riesco a mettere like al commento"), i18nT("Commenti"));
        } finally {
          setInlineActionBusy(btn, false);
        }
      });
    }

    const shareToggle = card.querySelector("[data-post-share-toggle='1']");
    const shareMenu = card.querySelector("[data-post-share-menu='1']");
    const shareFeedBtn = card.querySelector("[data-post-share-feed='1']");
    const shareExternalBtn = card.querySelector("[data-post-share-external='1']");

    if (shareToggle && shareMenu && shareToggle.dataset.wiredPostShareToggle !== "1") {
      shareToggle.dataset.wiredPostShareToggle = "1";
      shareToggle.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const willOpen = shareMenu.hidden;
        closeAllPostShareMenus(willOpen ? shareMenu : null);
        shareMenu.hidden = !willOpen;
      });
    }

    if (shareFeedBtn && shareFeedBtn.dataset.wiredPostShareFeed !== "1") {
      shareFeedBtn.dataset.wiredPostShareFeed = "1";
      shareFeedBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!state.me) return;
        if (shareMenu) shareMenu.hidden = true;

        const source = resolveSourcePostForShare(postId);
        if (!source) {
          toast(i18nT("Post non disponibile per la condivisione"), i18nT("Condividi"));
          return;
        }

        const meName = state.userMap.get(state.me.uid)?.displayName || "User";
        setInlineActionBusy(shareFeedBtn, true);
        try {
          await createSharedPost({
            authorUid: state.me.uid,
            authorName: meName,
            sourcePost: source,
          });
          registerPostShare({ postId, uid: state.me.uid, mode: "feed" }).catch(() => {});
          const ui = getPostUiState(postId);
          if (ui) {
            ui.counts.shares += 1;
            applyPostUiToCard(card, ui);
          }
          toast("Post ricondiviso nel feed", i18nT("Condividi"));
          await buildHomeFeed(state.me.uid);
        } catch (err) {
          console.error(err);
          toast(err?.message || i18nT("Condivisione non riuscita"), i18nT("Condividi"));
        } finally {
          setInlineActionBusy(shareFeedBtn, false);
        }
      });
    }

    if (shareExternalBtn && shareExternalBtn.dataset.wiredPostShareExternal !== "1") {
      shareExternalBtn.dataset.wiredPostShareExternal = "1";
      shareExternalBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (shareMenu) shareMenu.hidden = true;

        const payload = buildExternalSharePayload(postId);
        let didShare = false;
        setInlineActionBusy(shareExternalBtn, true);
        try {
          if (navigator.share) {
            await navigator.share(payload);
            didShare = true;
            toast(i18nT("Condiviso"), i18nT("Condividi"));
          } else if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(`${payload.text}\n${payload.url}`);
            didShare = true;
            toast(i18nT("Link copiato negli appunti"), i18nT("Condividi"));
          } else {
            toast(i18nT("Condivisione non supportata su questo dispositivo"), i18nT("Condividi"));
          }
        } catch (err) {
          if (err?.name !== "AbortError") {
            console.error(err);
            toast(i18nT("Condivisione non riuscita"), i18nT("Condividi"));
          }
        } finally {
          setInlineActionBusy(shareExternalBtn, false);
        }

        if (didShare && state.me) {
          registerPostShare({ postId, uid: state.me.uid, mode: "external" }).catch(() => {});
          const ui = getPostUiState(postId);
          if (ui) {
            ui.counts.shares += 1;
            applyPostUiToCard(card, ui);
          }
        }
      });
    }
  });

  if (!document.body.dataset.wiredPostShareOutside) {
    document.body.dataset.wiredPostShareOutside = "1";
    document.addEventListener("click", (e) => {
      const inside = e.target.closest(".post-share-wrap");
      if (!inside) closeAllPostShareMenus();

      const insideWith = e.target.closest("[data-with-dropdown='1']");
      if (!insideWith) closeAllWatchedWithMenus();

      const insideCommentMention = e.target.closest(".post-comment-input-wrap");
      if (!insideCommentMention) {
        state.postUi.forEach((ui) => ui?.mentionCtrl?.close());
      }
    });
  }
}

async function renderNextChunk(n = 8) {
  if (!feedEl) return;
  const slice = state.items.slice(state.cursor, state.cursor + n);
  state.cursor += slice.length;
  if (!slice.length) return;

  // Il gate anti-spoiler deve conoscere il progresso PRIMA di produrre l'HTML:
  // renderizzare in chiaro e sfocare dopo mostrerebbe lo spoiler per un frame.
  await ensureProgressCached(
    slice.filter((it) => it?.kind === "title_comment").map((it) => it.titleId)
  );
  // Stesso motivo per il bottone "Segui": nascere spento e correggersi dopo
  // sarebbe un lampeggio (e un invito a cliccare due volte).
  await ensureTitleUpdatePrefs();

  const html = slice.map(itemHtml).join("");
  const wrap = document.createElement("div");
  wrap.innerHTML = html;
  // append each child to preserve event wiring scope
  while (wrap.firstElementChild) {
    feedEl.appendChild(wrap.firstElementChild);
  }
  await wireFeedInteractions(feedEl);
}

function focusDeepLinkedPostCard() {
  if (state.deepLinkHandled) return;
  const targetId = String(state.deepLinkPostId || "").trim();
  if (!targetId) return;
  const card = Array.from(document.querySelectorAll(".feed-item[data-post-id]"))
    .find((el) => String(el.getAttribute("data-post-id") || "") === targetId);
  if (!card) return;

  state.deepLinkHandled = true;
  card.classList.add("feed-item-focus");
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  setTimeout(() => {
    card.classList.remove("feed-item-focus");
  }, 2600);
}

// feedHasMore (refill feedEvents) vale solo per il branch "server";
// publicPostsHasMore (finestra post pubblici) vale per entrambi i branch
// (server e legacy) — vedi loadRankedPublicPosts chiamato in entrambi in
// buildHomeFeed. Ricalcolata a ogni check (mai catturata in una var stale)
// perché lo stato cambia tra un'intersezione e l'altra dello stesso observer.
function canLoadMoreFeed() {
  return (state.feedMode === "server" && state.feedHasMore) || state.publicPostsHasMore;
}

function mountInfiniteScroll() {
  if (!feedLoadMoreEl) return;
  const hasBufferedItems = state.cursor < state.items.length;
  feedLoadMoreEl.innerHTML = (hasBufferedItems || canLoadMoreFeed()) ? `<div class="feed-sentinel"></div>` : "";
  const sentinel = feedLoadMoreEl.querySelector(".feed-sentinel");
  if (!sentinel) return;

  if (state.io) state.io.disconnect();
  state.io = new IntersectionObserver(async (entries) => {
    const e = entries[0];
    if (!e?.isIntersecting) return;
    if (state.loadingMore) return;
    if (state.cursor >= state.items.length && !canLoadMoreFeed()) return;
    state.loadingMore = true;

    const PLACEHOLDER_ATTR = "data-feed-placeholder";
    const placeholderHtml = () => `
      <div class="feed-item" ${PLACEHOLDER_ATTR}="1">
        <div class="feed-item-header">
          <div class="sk sk-avatar"></div>
          <div class="meta" style="flex:1; min-width:0;">
            <div class="sk sk-line" style="width: 58%;"></div>
            <div class="sk sk-line" style="width: 38%; margin-top:.35rem;"></div>
          </div>
        </div>
        <div class="feed-item-content">
          <div class="sk sk-block" style="height: 84px;"></div>
        </div>
      </div>
    `;

    try {
      if (state.cursor >= state.items.length && state.feedMode === "server" && state.feedHasMore && state.me?.uid) {
        await loadServerFeedPage(state.me.uid, { pageSize: 24 });
      }
      // "Carica altri" (v1, bounded — vedi report): quando il buffer ranked
      // si esaurisce ma esiste ancora una finestra più vecchia di post
      // pubblici, la appendiamo IN CODA (score più basso per costruzione,
      // essendo una finestra successiva ordinata per createdAt desc) invece
      // di tentare un merge con cursori Firestore multipli (fuori scope v1).
      if (state.cursor >= state.items.length && state.publicPostsHasMore) {
        const more = await loadRankedPublicPosts({ append: true }).catch(() => []);
        const seenPostIds = new Set(state.items.map((it) => it?.postId).filter(Boolean));
        const fresh = more.filter((row) => !row.item.postId || !seenPostIds.has(row.item.postId));
        fresh.sort((a, b) => b._score - a._score);
        if (fresh.length) {
          const appended = fresh.map((row) => row.item);
          state.items.push(...appended);
          refreshPostMapFromItems(state.items);
        }
      }
      // Safety: sia loadServerFeedPage (feedEvents di chi segui — puoi seguire
      // e bloccare la stessa persona) sia loadRankedPublicPosts (community
      // intera) possono aver appena appeso item di utenti bloccati; il filtro
      // iniziale di buildHomeFeed copre solo il batch di apertura.
      if (state.blockedUserIds?.size) {
        state.items = state.items.filter((row) => !state.blockedUserIds.has(String(row?.actorUid || row?.authorUid || "")));
        refreshPostMapFromItems(state.items);
      }
      if (state.cursor >= state.items.length) return;

      // Facebook-like: mostro già 3 placeholder che verranno "riempiti" a breve
      const phWrap = document.createElement("div");
      phWrap.innerHTML = [placeholderHtml(), placeholderHtml(), placeholderHtml()].join("");
      while (phWrap.firstElementChild) feedEl.appendChild(phWrap.firstElementChild);

      await renderNextChunk(8);

      // rimuovo i placeholder
      feedEl.querySelectorAll(`[${PLACEHOLDER_ATTR}="1"]`).forEach(n => n.remove());
    } finally {
      state.loadingMore = false;
      mountInfiniteScroll();
    }
  }, { rootMargin: "500px 0px" });

  state.io.observe(sentinel);
}

// ==============================
// Quick Action (Fase 2)
// ==============================

function iconArrowRight(size = 18) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`;
}

function iconEye(size = 18) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
}

function iconUserPlus(size = 18) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>`;
}

function iconPlus(size = 18) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
}

async function renderQuickAction(myUid, hasSources) {
  if (!quickActionEl) return;

  let icon = "";
  let title = "";
  let sub = "";
  let href = "";

  // Priorità 1: se hai titoli in watchlist, suggerisci di segnarne uno come visto
  try {
    const wl = await getMyWatchlist(myUid, { max: 5 });
    const firstApproved = wl.find(e => e.titleId && !e.pendingTitle);
    if (firstApproved) {
      const t = await getTitleById(firstApproved.titleId).catch(() => null);
      if (t) {
        icon = iconEye(18);
        title = i18nT("Hai visto {v0}?", { v0: t.name || i18nT("questo titolo") });
        sub = i18nT("Votalo e aggiungilo alla tua libreria");
        href = `/title.html?id=${encodeURIComponent(t.id)}`;
      }
    }
  } catch (_) {}

  // Priorità 2: se non ha amici/following
  if (!title && !hasSources) {
    icon = iconUserPlus(18);
    title = i18nT("Cerca amici su Somto");
    sub = i18nT("Il feed si riempie quando segui qualcuno");
    href = "/search.html";
  }

  // Priorità 3: fallback generico
  if (!title) {
    icon = iconPlus(18);
    title = i18nT("Hai visto qualcosa di nuovo?");
    sub = i18nT("Cercalo e votalo in un attimo");
    href = "/search.html?scope=titles";
  }

  quickActionEl.style.display = "block";
  quickActionEl.innerHTML = `
    <a class="quick-action-card" href="${escapeHtml(href)}">
      <div class="quick-action-icon">${icon}</div>
      <div class="quick-action-body">
        <div class="quick-action-title">${escapeHtml(title)}</div>
        <div class="quick-action-sub">${escapeHtml(sub)}</div>
      </div>
      <div class="quick-action-arrow">${iconArrowRight(16)}</div>
    </a>
  `;
}

function aggregateContributionEvents(feedItems, { sinceMs = 0 } = {}) {
  const map = new Map();

  function ensure(uid) {
    if (!map.has(uid)) {
      map.set(uid, {
        uid,
        score: 0,
        title_added: 0,
        post: 0,
        thread: 0,
        rating: 0,
        latestMs: 0,
        days: new Set(),
      });
    }
    return map.get(uid);
  }

  for (const it of feedItems || []) {
    if (!it?.actorUid) continue;
    const scoreKind = it.kind === "post_share" ? "post" : it.kind;
    const weight = CONTRIBUTION_WEIGHTS[scoreKind];
    if (!weight) continue;
    const ms = tsToMillis(it.ts);
    if (!ms) continue;
    if (sinceMs && ms < sinceMs) continue;

    const row = ensure(it.actorUid);
    row[scoreKind] += 1;
    row.score += weight;
    row.latestMs = Math.max(row.latestMs, ms);
    row.days.add(dayKeyFromMs(ms));
  }

  return map;
}

function sortByCountThenName(rows) {
  return rows.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    const an = (state.userMap.get(a.uid)?.displayName || a.uid || "").toLowerCase();
    const bn = (state.userMap.get(b.uid)?.displayName || b.uid || "").toLowerCase();
    return an.localeCompare(bn);
  });
}

function contributionSubtext(counters, { includeThreads = true } = {}) {
  const parts = [];
  if (counters?.title_added) parts.push(i18nT("{count} titoli", { count: counters.title_added }));
  if (counters?.post) parts.push(`${counters.post} post`);
  if (counters?.rating) parts.push(i18nT("{count} voti", { count: counters.rating }));
  if (includeThreads && counters?.thread) parts.push(`${counters.thread} thread`);
  if (!parts.length) return "";
  return parts.slice(0, 3).join(" · ");
}

function hasKnownUser(uid) {
  return !!uid && state.userMap.has(uid);
}

// ==============================
// Leaderboard (Classifiche)
// ==============================

function computeLeaderboards(feedItems, recentTitles, libs, myUid, contributionTotals = new Map()) {
  const nowMs = Date.now();
  const weekSinceMs = nowMs - (7 * DAY_MS);

  const weeklyEvents = aggregateContributionEvents(feedItems, { sinceMs: weekSinceMs });
  const allEventWindow = aggregateContributionEvents(feedItems);

  // Conteggi "all-time" da profilo utente + fallback libreria in memoria.
  const allUidsRaw = [...new Set((libs || []).map(l => l.uid).filter(Boolean))];
  const allUids = allUidsRaw.filter(uid => hasKnownUser(uid));
  const allUidSet = new Set(allUids);

  const ratingsByUid = new Map();
  for (const { uid, items } of libs) {
    if (!allUidSet.has(uid)) continue;
    const userDoc = state.userMap.get(uid);
    const statsCount = Number(userDoc?.stats?.ratingsCount || 0);
    const fallback = items.filter(it => it.lastRating !== undefined && it.lastRating !== null).length;
    const rated = statsCount > 0 ? statsCount : fallback;
    if (rated > 0) ratingsByUid.set(uid, rated);
  }

  // Conteggio titoli recenti (fallback per chi non ha count totals caricati)
  const recentAddedByUid = new Map();
  const weeklyAddedByUid = new Map();
  for (const t of recentTitles || []) {
    if (!t?.createdBy) continue;
    recentAddedByUid.set(t.createdBy, (recentAddedByUid.get(t.createdBy) || 0) + 1);
    const ms = tsToMillis(t.createdAt);
    if (ms && ms >= weekSinceMs) {
      weeklyAddedByUid.set(t.createdBy, (weeklyAddedByUid.get(t.createdBy) || 0) + 1);
    }
  }

  const weeklyRankings = [];
  const allTimeRankings = [];
  const topStreaksRaw = [];

  for (const uid of allUids) {
    const weekly = weeklyEvents.get(uid) || {
      title_added: 0, post: 0, thread: 0, rating: 0, score: 0, latestMs: 0,
    };
    if (weeklyAddedByUid.has(uid) && weekly.title_added < weeklyAddedByUid.get(uid)) {
      weekly.title_added = weeklyAddedByUid.get(uid);
      weekly.score = (weekly.title_added * CONTRIBUTION_WEIGHTS.title_added)
        + (weekly.post * CONTRIBUTION_WEIGHTS.post)
        + (weekly.thread * CONTRIBUTION_WEIGHTS.thread)
        + (weekly.rating * CONTRIBUTION_WEIGHTS.rating);
    }

    const allSeen = allEventWindow.get(uid) || {
      title_added: 0, post: 0, thread: 0, rating: 0, score: 0, latestMs: 0, days: new Set(),
    };
    const streak = computeCurrentStreak(allSeen.days, nowMs);
    if (streak > 0) {
      topStreaksRaw.push({ uid, count: streak });
    }

    if (weekly.score > 0) {
      weeklyRankings.push({
        uid,
        score: weekly.score,
        count: weekly.score,
        streak,
        latestMs: weekly.latestMs || 0,
        counters: {
          title_added: weekly.title_added || 0,
          post: weekly.post || 0,
          rating: weekly.rating || 0,
          thread: weekly.thread || 0,
        },
      });
    }

    const totals = contributionTotals.get(uid) || {};
    const hasTitlesTotal = totals.titles !== null && totals.titles !== undefined && Number.isFinite(Number(totals.titles));
    const hasPostsTotal = totals.posts !== null && totals.posts !== undefined && Number.isFinite(Number(totals.posts));
    const totalTitles = hasTitlesTotal
      ? Number(totals.titles)
      : (recentAddedByUid.get(uid) || allSeen.title_added || 0);
    const totalPosts = hasPostsTotal
      ? Number(totals.posts)
      : (allSeen.post || 0);
    const totalRatings = Number(ratingsByUid.get(uid) || 0);

    const allTimeScore = (totalTitles * CONTRIBUTION_WEIGHTS.title_added)
      + (totalPosts * CONTRIBUTION_WEIGHTS.post)
      + (totalRatings * CONTRIBUTION_WEIGHTS.rating);

    if (allTimeScore > 0 || streak > 0) {
      allTimeRankings.push({
        uid,
        score: allTimeScore,
        count: allTimeScore,
        streak,
        counters: {
          title_added: totalTitles,
          post: totalPosts,
          rating: totalRatings,
          thread: allSeen.thread || 0,
        },
      });
    }
  }

  weeklyRankings.sort((a, b) => (b.score - a.score) || (b.streak - a.streak) || (b.latestMs - a.latestMs));
  allTimeRankings.sort((a, b) => (b.score - a.score) || (b.streak - a.streak));
  topStreaksRaw.sort((a, b) => b.count - a.count);

  const topRaters = sortByCountThenName(
    [...ratingsByUid.entries()].map(([uid, count]) => ({ uid, count }))
  ).slice(0, 10);

  const topAdders = sortByCountThenName(
    allTimeRankings
      .map(r => ({ uid: r.uid, count: Number(r.counters?.title_added || 0) }))
      .filter(r => r.count > 0)
  ).slice(0, 10);

  const topThreaders = sortByCountThenName(
    weeklyRankings
      .map(r => ({ uid: r.uid, count: Number(r.counters?.thread || 0) }))
      .filter(r => r.count > 0)
  ).slice(0, 10);

  // I tuoi generi preferiti
  const myLib = libs.find(l => l.uid === myUid);
  const genreCounts = new Map();
  if (myLib) {
    for (const it of myLib.items) {
      const title = state.titleMap.get(it.titleId);
      if (!title?.genres) continue;
      for (const g of title.genres) {
        genreCounts.set(g, (genreCounts.get(g) || 0) + 1);
      }
    }
  }
  const topGenres = [...genreCounts.entries()]
    .map(([genre, count]) => ({ genre, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const weeklyStart = new Date(nowMs - (6 * DAY_MS));
  const weeklyEnd = new Date(nowMs);
  const weekLabel = `${weeklyStart.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit" })} - ${weeklyEnd.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit" })}`;

  const summary = {
    activeWeeklyUsers: weeklyRankings.length,
    topWeeklyUid: weeklyRankings[0]?.uid || null,
    topAllTimeUid: allTimeRankings[0]?.uid || null,
    topStreak: topStreaksRaw[0]?.count || 0,
  };

  return {
    topRaters,
    topAdders,
    topThreaders,
    topGenres,
    weeklyRankings: weeklyRankings.slice(0, 20),
    allTimeRankings: allTimeRankings.slice(0, 20),
    topStreaks: topStreaksRaw.slice(0, 10),
    weekLabel,
    summary,
  };
}

async function loadContributionTotals(uids) {
  const uniq = [...new Set((uids || []).filter(Boolean))];
  if (!uniq.length) return new Map();

  const { collection, query, where, getCountFromServer } = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js");
  const { db } = await import("../firebase.js");

  const out = new Map();
  for (const uid of uniq) out.set(uid, { titles: null, posts: null });

  await Promise.allSettled(uniq.map(async (uid) => {
    const [titleCnt, postCnt] = await Promise.allSettled([
      getCountFromServer(query(collection(db, "titles"), where("createdBy", "==", uid))),
      getCountFromServer(query(collection(db, "posts"), where("authorUid", "==", uid))),
    ]);

    const row = out.get(uid) || { titles: null, posts: null };
    if (titleCnt.status === "fulfilled") row.titles = Number(titleCnt.value.data().count || 0);
    if (postCnt.status === "fulfilled") row.posts = Number(postCnt.value.data().count || 0);
    out.set(uid, row);
  }));

  return out;
}

async function rebuildLeaderboardsFromState() {
  if (!state.leaderboardInput) return;
  const { all, recentTitles, libs, myUid } = state.leaderboardInput;
  state.leaderboardData = computeLeaderboards(all, recentTitles, libs, myUid, state.contributionTotals);

  const uids = new Set([
    ...(state.leaderboardData.weeklyRankings || []).map(r => r.uid),
    ...(state.leaderboardData.allTimeRankings || []).map(r => r.uid),
    ...(state.leaderboardData.topRaters || []).map(r => r.uid),
    ...(state.leaderboardData.topAdders || []).map(r => r.uid),
    ...(state.leaderboardData.topThreaders || []).map(r => r.uid),
    ...(state.leaderboardData.topStreaks || []).map(r => r.uid),
  ]);
  await ensureUsersCached([...uids]);
}

// ==============================
// Podium + Stat Chips (new visual)
// ==============================

function renderPodium(entries, { valueLabel = "pt", globalMode = false } = {}) {
  if (!entries || entries.length === 0) return "";

  const padded = [entries[0] || null, entries[1] || null, entries[2] || null];

  function podiumItem(entry, position) {
    if (!entry) return `<div class="lb-podium-item lb-podium-item--${position} lb-podium-item--empty"></div>`;

    const uid = entry.uid;
    const profileAvailable = hasKnownUser(uid);
    let name, photo;
    if (globalMode && entry.displayName) {
      name = entry.displayName;
      photo = entry.photoURL || "";
    } else {
      const u = state.userMap.get(uid);
      name = u?.displayName || entry.displayName || i18nT("Utente non disponibile");
      photo = u?.photoURL || entry.photoURL || "";
    }

    const avatarInner = photo
      ? `<img alt="" src="${escapeHtml(photo)}" loading="lazy" decoding="async">`
      : escapeHtml(initials(name));

    const value = entry.score !== undefined ? `${entry.score} ${valueLabel}`
                : entry.count !== undefined ? `${entry.count} ${valueLabel}`
                : "";

    const medalClass = position === "first" ? "gold" : position === "second" ? "silver" : "bronze";
    const rankNum = position === "first" ? "1" : position === "second" ? "2" : "3";
    const cardClass = `lb-podium-item lb-podium-item--${position}${profileAvailable ? "" : " lb-user-missing"}`;
    const openTag = profileAvailable
      ? `<a class="${cardClass}" href="/user.html?uid=${encodeURIComponent(uid)}">`
      : `<div class="${cardClass}" aria-disabled="true">`;
    const closeTag = profileAvailable ? "</a>" : "</div>";

    return `
      ${openTag}
        <div class="lb-podium-ring lb-podium-ring--${medalClass}">
          <div class="lb-podium-avatar">${avatarInner}</div>
        </div>
        <div class="lb-podium-rank">${rankNum}</div>
        <div class="lb-podium-name">${escapeHtml(name)}</div>
        <div class="lb-podium-value">${escapeHtml(value)}</div>
      ${closeTag}
    `;
  }

  // Layout order: 2nd | 1st | 3rd
  return `
    <div class="lb-podium">
      ${podiumItem(padded[1], "second")}
      ${podiumItem(padded[0], "first")}
      ${podiumItem(padded[2], "third")}
    </div>
  `;
}

function renderStatChips(sections) {
  const chips = sections
    .filter(s => s.rows && s.rows.length > 0)
    .map(s => {
      const top = s.rows[0];
      const u = state.userMap.get(top.uid);
      const name = u?.displayName || top.displayName || i18nT("Utente");
      const photo = u?.photoURL || top.photoURL || "";
      const profileAvailable = hasKnownUser(top.uid);
      const avatarInner = photo
        ? `<img alt="" src="${escapeHtml(photo)}" loading="lazy" decoding="async">`
        : escapeHtml(initials(name));
      const value = top.count !== undefined ? top.count : top.score || "";
      const cardClass = `lb-chip${profileAvailable ? "" : " lb-user-missing"}`;
      const openTag = profileAvailable
        ? `<a class="${cardClass}" href="/user.html?uid=${encodeURIComponent(top.uid)}">`
        : `<div class="${cardClass}" aria-disabled="true">`;
      const closeTag = profileAvailable ? "</a>" : "</div>";
      return `
        ${openTag}
          <div class="lb-chip-avatar">${avatarInner}</div>
          <div class="lb-chip-body">
            <div class="lb-chip-label">${escapeHtml(s.title)}</div>
            <div class="lb-chip-value">${escapeHtml(name)} <span class="lb-chip-stat">${escapeHtml(String(value))}</span></div>
          </div>
        ${closeTag}
      `;
    });

  if (!chips.length) return "";
  return `<div class="lb-stat-chips">${chips.join("")}</div>`;
}

function renderLeaderboardSection(title, icon, rows, { startRank = 1 } = {}) {
  if (!rows.length) return "";
  const rowsHtml = rows.map((r, i) => {
    const u = state.userMap.get(r.uid);
    const name = u?.displayName || r.displayName || i18nT("Utente");
    const photo = u?.photoURL;
    const profileAvailable = hasKnownUser(r.uid);
    const avatarInner = photo
      ? `<img alt="" src="${escapeHtml(photo)}" loading="lazy" decoding="async">`
      : escapeHtml(initials(name));
    const rank = startRank + i;
    const medal = rank === 1 ? "gold" : rank === 2 ? "silver" : rank === 3 ? "bronze" : "";
    const rowClass = `tc-row${profileAvailable ? "" : " lb-user-missing"}`;
    const openTag = profileAvailable
      ? `<a class="${rowClass}" href="/user.html?uid=${encodeURIComponent(r.uid)}">`
      : `<div class="${rowClass}" aria-disabled="true">`;
    const closeTag = profileAvailable ? "</a>" : "</div>";
    return `
      ${openTag}
        <span class="tc-rank ${medal}">${rank}</span>
        <div class="avatar tc-avatar">${avatarInner}</div>
        <span class="tc-name-wrap">
          <span class="tc-name">${escapeHtml(name)}</span>
          ${r.sub ? `<span class="tc-sub">${escapeHtml(r.sub)}</span>` : ""}
        </span>
        <span class="tc-score">${r.value}</span>
      ${closeTag}
    `;
  }).join("");

  // When called without title (overflow after podium), return just the list
  if (!title) return `<div class="tc-list">${rowsHtml}</div>`;

  return `<div class="lb-section">
    <div class="lb-section-header">
      <span class="lb-section-icon">${icon}</span>
      <span class="lb-section-title">${title}</span>
    </div>
    <div class="tc-list">${rowsHtml}</div>
  </div>`;
}

function renderLeaderboardSubTabs() {
  const isAmici = state.leaderboardSubTab === "amici";
  return `<div class="lb-subtabs">
    <button class="lb-subtab ${isAmici ? "active" : ""}" data-lb-tab="amici" type="button">${i18nT("Amici")}</button>
    <button class="lb-subtab ${!isAmici ? "active" : ""}" data-lb-tab="alltime" type="button">Globale</button>
  </div>`;
}

function iconFlame(size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A5.5 5.5 0 1 0 19 17c0-4-2-6-4-8-1.2 3.2-4 3.5-5.3 5.5-.8 1.2-.8 2.8.1 4"/><path d="M12 2c1.6 2.4 2.2 4.2 1.8 5.8-.5 2-2.4 2.7-3.8 4.2-1.4 1.5-1.8 3.5-.7 5.2"/></svg>`;
}

function userDisplayName(uid) {
  const u = state.userMap.get(uid);
  return u?.displayName || i18nT("Utente");
}

function renderLeaderboardOverview(data) {
  if (!data) return "";
  const weeklyName = data.summary?.topWeeklyUid ? userDisplayName(data.summary.topWeeklyUid) : "—";
  const totalName = data.summary?.topAllTimeUid ? userDisplayName(data.summary.topAllTimeUid) : "—";
  return `
    <div class="lb-overview">
      <div class="lb-overview-head">
        <div class="lb-overview-title">Contributi amici</div>
        <div class="lb-overview-sub">Settimana: ${escapeHtml(data.weekLabel || "ultimi 7 giorni")}</div>
      </div>
      <div class="lb-overview-grid">
        <div class="lb-overview-item">
          <div class="lb-overview-label">Attivi settimana</div>
          <div class="lb-overview-value">${escapeHtml(String(data.summary?.activeWeeklyUsers || 0))}</div>
          <div class="lb-overview-meta">${escapeHtml(weeklyName)}</div>
        </div>
        <div class="lb-overview-item">
          <div class="lb-overview-label">Top totale</div>
          <div class="lb-overview-value">${escapeHtml(String(data.allTimeRankings?.[0]?.score || 0))} pt</div>
          <div class="lb-overview-meta">${escapeHtml(totalName)}</div>
        </div>
        <div class="lb-overview-item">
          <div class="lb-overview-label">Streak migliore</div>
          <div class="lb-overview-value">${escapeHtml(String(data.summary?.topStreak || 0))} g</div>
          <div class="lb-overview-meta">giorni consecutivi</div>
        </div>
      </div>
    </div>
  `;
}

function renderFriendsLeaderboard() {
  if (!state.leaderboardData) {
    return `<div class="lb-empty-state">
      <div class="lb-empty-icon">${iconTrophy(32)}</div>
      <div class="lb-empty-text">${i18nT("Nessun dato disponibile")}</div>
      <div class="lb-empty-sub">${i18nT("Aggiungi amici per vedere le classifiche")}</div>
    </div>`;
  }

  const {
    topRaters,
    topAdders,
    topThreaders,
    topGenres,
    weeklyRankings,
    allTimeRankings,
    topStreaks,
  } = state.leaderboardData;

  // Check if all empty
  if (!weeklyRankings.length && !allTimeRankings.length && !topRaters.length && !topAdders.length && !topThreaders.length && !topGenres.length) {
    return `<div class="lb-empty-state">
      <div class="lb-empty-icon">${iconTrophy(32)}</div>
      <div class="lb-empty-text">${i18nT("Nessuna classifica disponibile")}</div>
      <div class="lb-empty-sub">${i18nT("L'attività dei tuoi amici apparirà qui")}</div>
    </div>`;
  }

  let html = renderLeaderboardOverview(state.leaderboardData);

  // Podium: Top Contributors - questa settimana
  if (weeklyRankings.length) {
    html += `<div class="lb-section lb-section--podium">
      <div class="lb-section-header">
        <span class="lb-section-icon">${iconTrophy(18)}</span>
        <span class="lb-section-title">Top contributori settimana</span>
      </div>
      ${renderPodium(weeklyRankings.slice(0, 3), { valueLabel: "pt" })}
      ${weeklyRankings.length > 3 ? renderLeaderboardSection(
        "",
        "",
        weeklyRankings.slice(3).map(r => ({
          uid: r.uid,
          value: `${r.score} pt`,
          sub: contributionSubtext(r.counters, { includeThreads: true }),
        })),
        { startRank: 4 }
      ) : ""}
    </div>`;
  }

  if (allTimeRankings.length) {
    html += renderLeaderboardSection(
      "Top contributori totali",
      iconGlobe(18),
      allTimeRankings.slice(0, 10).map(r => ({
        uid: r.uid,
        value: `${r.score} pt`,
        sub: contributionSubtext(r.counters, { includeThreads: false }),
      }))
    );
  }

  if (topStreaks.length) {
    html += renderLeaderboardSection(
      "Streak attivi",
      iconFlame(18),
      topStreaks.slice(0, 10).map(r => ({
        uid: r.uid,
        value: `${r.count} g`,
      }))
    );
  }

  // Stat chips metriche secondarie
  const chipSections = [];
  if (topRaters.length) chipSections.push({ title: i18nT("Più voti"), rows: topRaters });
  if (topAdders.length) chipSections.push({ title: i18nT("Più titoli"), rows: topAdders });
  if (topThreaders.length) chipSections.push({ title: i18nT("Più thread (settimana)"), rows: topThreaders });
  html += renderStatChips(chipSections);

  // Genre preferences (kept as compact list)
  if (topGenres.length) {
    const genreRows = topGenres.map((g, i) => {
      const medal = i === 0 ? "gold" : i === 1 ? "silver" : i === 2 ? "bronze" : "";
      const label = genreMap.get(g.genre) || g.genre;
      return `<div class="tc-row">
        <span class="tc-rank ${medal}">${i + 1}</span>
        <span class="tc-name">${escapeHtml(label)}</span>
        <span class="tc-score">${g.count} titoli</span>
      </div>`;
    }).join("");

    html += `<div class="lb-section">
      <div class="lb-section-header">
        <span class="lb-section-icon">${iconGenre(18)}</span>
        <span class="lb-section-title">${i18nT("I tuoi generi preferiti")}</span>
      </div>
      <div class="tc-list">${genreRows}</div>
    </div>`;
  }

  return html;
}

function renderGlobalLeaderboard() {
  const gl = state.globalLeaderboard;

  // Error state
  if (gl && gl._error) {
    return `<div class="lb-empty-state">
      <div class="lb-empty-icon">${iconGlobe(32)}</div>
      <div class="lb-empty-text">${i18nT("Errore nel caricamento della classifica")}</div>
      <button class="btn small ghost lb-retry" type="button">${i18nT("Riprova")}</button>
    </div>`;
  }

  // Loading state
  if (gl === undefined) {
    return `<div class="lb-loading">
      <div class="lb-loading-podium">
        <div class="sk sk-avatar" style="width:48px;height:48px;"></div>
        <div class="sk sk-avatar" style="width:60px;height:60px;"></div>
        <div class="sk sk-avatar" style="width:48px;height:48px;"></div>
      </div>
      <div class="sk sk-line" style="width:50%;height:14px;margin:.75rem auto 0;"></div>
    </div>`;
  }

  // Empty state (doc doesn't exist)
  if (!gl || (!gl.topContributors?.length && !gl.topRaters?.length && !gl.topAdders?.length)) {
    return `<div class="lb-empty-state">
      <div class="lb-empty-icon">${iconTrophy(32)}</div>
      <div class="lb-empty-text">${i18nT("La classifica globale non è ancora disponibile")}</div>
      <div class="lb-empty-sub">${i18nT("Verrà aggiornata automaticamente")}</div>
    </div>`;
  }

  let html = "";

  // Podium: Top Contributors
  if (gl.topContributors?.length) {
    html += `<div class="lb-section lb-section--podium">
      <div class="lb-section-header">
        <span class="lb-section-icon">${iconTrophy(18)}</span>
        <span class="lb-section-title">Top Contributor</span>
      </div>
      ${renderPodium(gl.topContributors.slice(0, 3), { valueLabel: "pt", globalMode: true })}
      ${gl.topContributors.length > 3 ? renderLeaderboardSection("", "", gl.topContributors.slice(3, 10).map(r => ({ uid: r.uid, value: `${r.score} pt` })), { startRank: 4 }) : ""}
    </div>`;
  }

  // Stat chips for secondary rankings
  const chipSections = [];
  if (gl.topRaters?.length) chipSections.push({ title: i18nT("Più voti"), rows: gl.topRaters });
  if (gl.topAdders?.length) chipSections.push({ title: i18nT("Più titoli"), rows: gl.topAdders });
  html += renderStatChips(chipSections);

  return html;
}

function wireLeaderboardSubTabs() {
  if (!leaderboardEl) return;
  leaderboardEl.querySelectorAll("[data-lb-tab]").forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.lbTab;
      if (tab === state.leaderboardSubTab) return;
      state.leaderboardSubTab = tab;
      renderLeaderboard();
    });
  });
  // Retry button for global leaderboard error
  const retryBtn = leaderboardEl.querySelector(".lb-retry");
  if (retryBtn) {
    retryBtn.addEventListener("click", () => {
      state.globalLeaderboard = undefined;
      renderLeaderboard();
      loadGlobalLeaderboard().catch(() => {});
    });
  }
}

function renderLeaderboard() {
  if (!leaderboardEl) return;

  const subTabsHtml = renderLeaderboardSubTabs();
  const contentHtml = state.leaderboardSubTab === "amici"
    ? renderFriendsLeaderboard()
    : renderGlobalLeaderboard();

  leaderboardEl.innerHTML = subTabsHtml + (contentHtml || `<div class="hint" style="text-align:center;padding:2rem;color:var(--text-muted);">${i18nT("Nessuna classifica disponibile")}</div>`);
  wireLeaderboardSubTabs();
}

async function loadGlobalLeaderboard() {
  try {
    const { getDoc, doc } = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js");
    const { db } = await import("../firebase.js");

    const timeoutMs = 8000;
    const snapPromise = getDoc(doc(db, "leaderboard", "global"));
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), timeoutMs)
    );
    const snap = await Promise.race([snapPromise, timeoutPromise]);

    if (snap.exists()) {
      const data = snap.data();
      if (data.topRaters || data.topAdders || data.topContributors) {
        state.globalLeaderboard = {
          topRaters: data.topRaters || [],
          topAdders: data.topAdders || [],
          topContributors: data.topContributors || [],
        };
      } else {
        state.globalLeaderboard = {
          topRaters: data.rankings || [],
          topAdders: [],
          topContributors: [],
        };
      }
      const allUids = [
        ...(state.globalLeaderboard.topRaters || []),
        ...(state.globalLeaderboard.topAdders || []),
        ...(state.globalLeaderboard.topContributors || []),
      ].map(r => r.uid).filter(Boolean);
      await ensureUsersCached([...new Set(allUids)]);
    } else {
      state.globalLeaderboard = null;
    }
  } catch (err) {
    console.error("loadGlobalLeaderboard error:", err);
    state.globalLeaderboard = { _error: true };
  }
  if (state.activeTab === "classifiche") renderLeaderboard();
}

// ==============================
// Social Insight ("Lo sapevi?")
// ==============================

function iconLightbulb(size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/></svg>`;
}

function buildInsight(myUid, libs, friendUids) {
  // libs = [{ uid, items: [{ titleId, lastRating }] }]
  // Raccogliamo dati già in memoria, zero query extra

  const generators = [];

  // --- Generator 1: Titolo più popolare tra amici ---
  generators.push(() => {
    const titleCount = new Map();
    for (const { items } of libs) {
      for (const it of items) {
        if (!it.titleId) continue;
        titleCount.set(it.titleId, (titleCount.get(it.titleId) || 0) + 1);
      }
    }
    let bestId = null, bestCount = 0;
    for (const [tid, count] of titleCount) {
      if (count > bestCount) { bestId = tid; bestCount = count; }
    }
    if (!bestId || bestCount < 2) return null;
    const t = state.titleMap.get(bestId);
    if (!t) return null;
    return `<strong>${escapeHtml(t.name)}</strong> ${i18nT("è stato visto da")} <strong>${bestCount}</strong> dei tuoi amici`;
  });

  // --- Generator 2: Tu e [amico] avete N titoli in comune ---
  generators.push(() => {
    // Libreria utente corrente: raccogliamo da state.items i rating dell'utente
    // Meglio: usiamo i titoli presenti nella titleMap come proxy veloce
    // Ma servono i titleId dell'utente. Usiamo i rating events dell'utente se disponibili.
    // Fallback: verifichiamo i titoli in comune tra amici e utente dalla libreria
    const myLib = libs.find(l => l.uid === myUid);
    if (!myLib || !myLib.items.length) return null;

    const myTitleIds = new Set(myLib.items.map(x => x.titleId).filter(Boolean));
    let bestFriend = null, bestCommon = 0;

    for (const { uid, items } of libs) {
      if (uid === myUid) continue;
      let common = 0;
      for (const it of items) {
        if (it.titleId && myTitleIds.has(it.titleId)) common++;
      }
      if (common > bestCommon) { bestFriend = uid; bestCommon = common; }
    }

    if (!bestFriend || bestCommon < 2) return null;
    const u = state.userMap.get(bestFriend);
    const name = u?.displayName || i18nT("Un amico");
    return i18nT("Tu e {name} avete {count} titoli in comune", { name: `<strong>${escapeHtml(name)}</strong>`, count: `<strong>${bestCommon}</strong>` });
  });

  // --- Generator 3: Film più votato (media più alta) ---
  generators.push(() => {
    const titleRatings = new Map(); // titleId → [rating, ...]
    for (const { items } of libs) {
      for (const it of items) {
        if (!it.titleId || it.lastRating === undefined || it.lastRating === null) continue;
        if (!titleRatings.has(it.titleId)) titleRatings.set(it.titleId, []);
        titleRatings.get(it.titleId).push(Number(it.lastRating));
      }
    }
    let bestId = null, bestAvg = 0, bestCount = 0;
    for (const [tid, ratings] of titleRatings) {
      if (ratings.length < 2) continue;
      const avg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
      if (avg > bestAvg || (avg === bestAvg && ratings.length > bestCount)) {
        bestId = tid; bestAvg = avg; bestCount = ratings.length;
      }
    }
    if (!bestId) return null;
    const t = state.titleMap.get(bestId);
    if (!t) return null;
    return i18nT("Il titolo più apprezzato dai tuoi amici: {title} (media {avg})", { title: `<strong>${escapeHtml(t.name)}</strong>`, avg: bestAvg.toFixed(1) });
  });

  // Shuffle e prendi il primo valido
  for (let i = generators.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [generators[i], generators[j]] = [generators[j], generators[i]];
  }

  for (const gen of generators) {
    const result = gen();
    if (result) return result;
  }
  return null;
}

function renderInsight(insightHtml) {
  if (!socialInsightEl || !insightHtml) {
    if (socialInsightEl) {
      socialInsightEl.style.display = "none";
      socialInsightEl.dataset.wasVisible = "0";
      socialInsightEl.innerHTML = "";
    }
    return;
  }
  socialInsightEl.style.display = "block";
  socialInsightEl.dataset.wasVisible = "1";
  socialInsightEl.innerHTML = `
    <div class="insight-card">
      <div class="insight-icon">${iconLightbulb(16)}</div>
      <div class="insight-body">
        <div class="insight-label">${i18nT("Lo sapevi? 🤓")}</div>
        <div class="insight-text">${insightHtml}</div>
      </div>
    </div>
  `;
}

// ==============================
// Evento Temporaneo
// ==============================

function iconCalendar(size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;
}

async function loadAndRenderEvent() {
  if (!currentEventEl) return;
  try {
    const ev = await getCurrentEvent();
    if (!ev) {
      currentEventEl.style.display = "none";
      return;
    }

    const typeLabels = { weekend: "Weekend", tema: "Tema", challenge: "Challenge" };
    const typeLabel = typeLabels[ev.type] || "Evento";

    const endDate = new Date(ev.endAt).toLocaleDateString("it-IT", { day: "numeric", month: "short" });

    let ctaHtml = "";
    if (ev.threadId) {
      ctaHtml = `
        <a class="event-cta" href="/thread.html?tid=${encodeURIComponent(ev.threadId)}">
          ${iconMessageCircle(16)} <span>Partecipa al thread</span>
        </a>
      `;
    }

    currentEventEl.style.display = "block";
    currentEventEl.innerHTML = `
      <div class="event-banner">
        <div class="event-banner-header">
          <div class="event-badge">${escapeHtml(typeLabel)}</div>
          <span class="event-until">fino al ${escapeHtml(endDate)}</span>
        </div>
        <div class="event-title">${escapeHtml(ev.title)}</div>
        ${ev.description ? `<div class="event-desc">${escapeHtml(ev.description)}</div>` : ""}
        ${ctaHtml}
      </div>
    `;
  } catch (err) {
    console.error("loadAndRenderEvent error:", err);
    currentEventEl.style.display = "none";
  }
}

async function buildHomeFeed(myUid) {
  if (!myUid) return;
  state.blockedUserIds = await listBlockedUserIds(myUid).catch(() => new Set());
  const errorContainer = feedEl?.parentElement || feedEl || document.body;
  hideErrorBanner(errorContainer);
  const startedAt = Date.now();
  const buildSeq = ++state.feedBuildSeq;
  renderSkeleton(4);
  if (feedLoadMoreEl) feedLoadMoreEl.innerHTML = "";
  state.leaderboardInput = null;
  state.contributionTotals = new Map();
  state.postMap = new Map();
  state.postUi = new Map();
  state.feedMode = "legacy";
  window.__2WATCH_LAST_FEED_MODE = "loading";
  state.feedCursorDoc = null;
  state.feedHasMore = false;
  state.publicPostsCursorDoc = null;
  state.publicPostsHasMore = false;
  if (state.deepLinkPostId) state.deepLinkHandled = false;

  try {
  await loadGenreMap();

  const [friends, following] = await Promise.all([
    listFriends(myUid).catch(() => []),
    listFollowing(myUid, { max: 200 }).catch(() => []),
  ]);

  const friendUids = friends.map(f => f.uid);
  const followingUids = following.map(f => f.uid);
  const sourcesAll = [...new Set([...friendUids, ...followingUids])].filter(Boolean);
  console.log("[feed-debug] friends:", friends.length, "following:", following.length, "sources:", sourcesAll.length);

  // MVP performance guard: evitiamo di fare troppe read per 200+ persone.
  const sources = sourcesAll.slice(0, 30);
  state.sources = sources;
  state.sourceSet = new Set(sources);

  // Quick action + evento temporaneo (non bloccanti, partono in parallelo)
  renderQuickAction(myUid, sources.length > 0).catch(() => {});
  loadAndRenderEvent().catch(() => {});

  await ensureUsersCached([...sources, myUid]);

  // 1) suggerimento automatico (max 1)
  const suggestionTitle = await getSuggestionForMe(myUid).catch(() => null);

  const serverItems = await loadServerFeedPage(myUid, { reset: true, pageSize: 28 }).catch((err) => { console.warn("[feed-debug] server feed error:", err); return []; });
  const serverItemsDeduped = dedupeFeedItems(serverItems);
  console.log("[feed-debug] serverItems:", serverItems.length);

  // Se il server feed ha pochi eventi (collection feedEvents poco popolata),
  // usiamo il legacy feed che è più ricco (legge librerie amici, post, thread, ecc.)
  const SERVER_FEED_MIN_ITEMS = 5;
  if (serverItemsDeduped.length >= SERVER_FEED_MIN_ITEMS) {
    // Ranked mix (community-alive): fondi il follow-graph (feedEvents, "le
    // tue persone") con una finestra di post pubblici di TUTTA la community
    // (ranked per popolarità × recency, vedi scorePublicPost/blendRankedFeed).
    // Bounded window v1: non un cursore infinito perfetto, un "Carica altri"
    // aggiunge una finestra più vecchia di post pubblici in coda (vedi sotto).
    const [publicPostScored, commentScored] = await Promise.all([
      loadRankedPublicPosts().catch((err) => { console.warn("[feed-debug] public posts error:", err); return []; }),
      loadCommentItems(myUid).catch((err) => { console.warn("[feed-debug] comments error:", err); return []; }),
    ]);
    const items = blendRankedFeed(serverItemsDeduped, publicPostScored, commentScored)
      .filter((row) => !state.blockedUserIds?.has(String(row?.actorUid || row?.authorUid || "")));
    if (suggestionTitle) {
      state.titleMap.set(suggestionTitle.id, suggestionTitle);
      items.unshift({ kind: "suggestion", titleId: suggestionTitle.id, ts: Date.now() + 1 });
    }

    const deepLinkPostId = String(state.deepLinkPostId || "").trim();
    if (deepLinkPostId) {
      const idx = items.findIndex((row) => String(row?.postId || "") === deepLinkPostId);
      if (idx >= 0) {
        const [target] = items.splice(idx, 1);
        if (items[0]?.kind === "suggestion") items.splice(1, 0, target);
        else items.unshift(target);
      }
    }

    await ensureMinLoading(startedAt);
    if (buildSeq !== state.feedBuildSeq) return;

    state.items = items;
    refreshPostMapFromItems(items);
    state.cursor = 0;
    if (feedEl) feedEl.innerHTML = "";
    if (feedLoadMoreEl) feedLoadMoreEl.innerHTML = "";

    const initialCount = items.length && items[0].kind === "suggestion" ? 5 : 4;
    await renderNextChunk(initialCount);
    mountInfiniteScroll();
    focusDeepLinkedPostCard();
    renderInsight(null);

    const lbUids = [...new Set([...sources, myUid])];
    state.leaderboardInput = {
      all: serverItemsDeduped.slice(0, 200),
      recentTitles: [],
      libs: lbUids.map((uid) => ({ uid, items: [] })),
      myUid,
    };
    await rebuildLeaderboardsFromState();

    loadContributionTotals(lbUids)
      .then(async (totals) => {
        if (buildSeq !== state.feedBuildSeq) return;
        state.contributionTotals = totals;
        await rebuildLeaderboardsFromState();
        if (state.activeTab === "classifiche") renderLeaderboard();
      })
      .catch(() => {});

    if (feedTabsEl) feedTabsEl.style.display = "flex";
    window.__2WATCH_LAST_FEED_MODE = "server";
    loadGlobalLeaderboard().catch(() => {});
    return;
  }

  state.feedMode = "legacy";
  window.__2WATCH_LAST_FEED_MODE = "legacy";
  state.feedCursorDoc = null;
  state.feedHasMore = false;

  if (!sources.length) {
    // Zero follow: il feed pubblico NON richiede follow. Questo è ESATTAMENTE
    // il cohort (utenti nuovi / con pochi follow) per cui il feed globale
    // esiste — mostrargli "aggiungi amici" lascerebbe un feed morto proprio a
    // chi va attivato. Carichiamo i post pubblici ranked di tutta la community.
    console.log("[feed-debug] no sources → public-only ranked feed");
    const [publicPostScored, commentScored] = await Promise.all([
      loadRankedPublicPosts().catch((err) => { console.warn("[feed-debug] public posts error:", err); return []; }),
      loadCommentItems(myUid).catch((err) => { console.warn("[feed-debug] comments error:", err); return []; }),
    ]);
    const rankedItems = blendRankedFeed([], publicPostScored, commentScored)
      .filter((row) => !state.blockedUserIds?.has(String(row?.actorUid || row?.authorUid || "")));

    const items = [];
    if (suggestionTitle) {
      state.titleMap.set(suggestionTitle.id, suggestionTitle);
      items.push({ kind: "suggestion", titleId: suggestionTitle.id, ts: Date.now() + 1 });
    }
    items.push(...rankedItems);

    // Deep-link ?post= in cima (se presente tra i post pubblici caricati).
    const deepLinkPostId = String(state.deepLinkPostId || "").trim();
    if (deepLinkPostId) {
      const idx = items.findIndex((row) => String(row?.postId || "") === deepLinkPostId);
      if (idx >= 0) {
        const [target] = items.splice(idx, 1);
        if (items[0]?.kind === "suggestion") items.splice(1, 0, target);
        else items.unshift(target);
      }
    }

    await ensureTitlesCached(items.flatMap((x) => {
      const ids = [];
      if (x?.titleId) ids.push(x.titleId);
      if (x?.sharedPost?.titleId) ids.push(x.sharedPost.titleId);
      return ids;
    }));

    await ensureMinLoading(startedAt);
    if (buildSeq !== state.feedBuildSeq) return;

    // Solo SE non ci sono nemmeno post pubblici mostriamo l'empty state — e
    // invitante (punta allo starter "Di cosa parliamo?"), non "aggiungi amici".
    const hasRenderableItems = items.some((it) => it.kind !== "suggestion");
    if (!hasRenderableItems) {
      feedEl.innerHTML = "";
      if (feedLoadMoreEl) feedLoadMoreEl.innerHTML = "";
      renderEmpty(i18nT("Ancora nessun post nella community. Rompi il ghiaccio: apri una discussione su un titolo qui sopra."));
      if (feedTabsEl) feedTabsEl.style.display = "flex";
      loadGlobalLeaderboard().catch(() => {});
      return;
    }

    state.items = items;
    refreshPostMapFromItems(items);
    state.cursor = 0;
    if (feedEl) feedEl.innerHTML = "";
    if (feedLoadMoreEl) feedLoadMoreEl.innerHTML = "";

    const initialCount = items.length && items[0].kind === "suggestion" ? 5 : 4;
    await renderNextChunk(initialCount);
    mountInfiniteScroll();
    focusDeepLinkedPostCard();
    renderInsight(null);

    if (feedTabsEl) feedTabsEl.style.display = "flex";
    loadGlobalLeaderboard().catch(() => {});
    return;
  }

  // 2) eventi sociali + mia libreria (per insight)
  const [libs, myLib, recentTitles, publicThreads, postsResult] = await Promise.all([
    Promise.all(
      sources.map(uid => listMyLibrary(uid, { max: 24 }).then(items => ({ uid, items })).catch((err) => { console.warn("[feed-debug] lib error for", uid, err?.code || err?.message); return { uid, items: [] }; }))
    ),
    listMyLibrary(myUid, { max: 25 }).then(items => ({ uid: myUid, items })).catch(() => ({ uid: myUid, items: [] })),
    listRecentTitlesByUsers(sources, 120).catch((err) => { console.warn("[feed-debug] recentTitles error:", err?.code || err?.message); return []; }),
    listPublicThreads(100).catch((err) => { console.warn("[feed-debug] threads error:", err?.code || err?.message); return []; }),
    listRecentPosts({ max: 40 }).catch((err) => { console.warn("[feed-debug] posts error:", err?.code || err?.message); return { items: [] }; }),
  ]);

  const ratingEvents = [];
  for (const { uid, items } of libs) {
    for (const it of items) {
      if (!it.titleId) continue;
      if (it.lastRating === undefined || it.lastRating === null) continue;
      ratingEvents.push({
        kind: "rating",
        actorUid: uid,
        titleId: it.titleId,
        rating: it.lastRating,
        level: "title",
        postId: ratingPostIdForItem({ actorUid: uid, titleId: it.titleId, level: "title" }),
        ts: it.updatedAt || it.createdAt,
      });
    }
  }

  // title_added events
  const titleAddedEvents = recentTitles
    .filter(t => t.createdBy && state.sourceSet.has(t.createdBy))
    .slice(0, 80)
    .map(t => ({
      kind: "title_added",
      actorUid: t.createdBy,
      titleId: t.id,
      ts: t.createdAt,
    }));

  // friend_added events (from already-loaded friends list — zero extra reads)
  const friendAddedEvents = friends
    .filter(f => f.acceptedAt)
    .map(f => ({
      kind: "friend_added",
      actorUid: myUid,
      otherUid: f.uid,
      ts: f.acceptedAt,
    }));

  // Le card "ha scritto nel thread" sono state rimosse: ogni messaggio di
  // thread pubblico ha ora la sua card commento (kind "title_comment") con il
  // gate anti-spoiler. Tenerle entrambe significava mostrare lo stesso
  // commento due volte, e la versione thread esponeva il testo IN CHIARO
  // (`lastMessagePreview`) accanto alla card sfocata — gate aggirato.
  // La scoperta delle discussioni resta in "Discussioni per te".
  const threadEvents = [];

  const { items: recentPosts } = postsResult || { items: [] };
  const postEvents = (recentPosts || [])
    // I post-eco dei commenti NON passano di qui: hanno una card propria con il
    // gate anti-spoiler (kind "title_comment", vedi loadCommentItems). Questa
    // query non filtra per visibility, quindi senza l'esclusione finirebbero
    // nel feed come post normali, in chiaro.
    .filter(p => String(p?.sourceKind || "") !== "thread_message")
    .filter(p => p?.authorUid && (state.sourceSet.has(p.authorUid) || p.authorUid === myUid))
    .slice(0, 40)
    .map(p => {
      const sharedRaw = (p.sharedPost && typeof p.sharedPost === "object") ? p.sharedPost : null;
      const sharedPost = sharedRaw ? {
        postId: String(sharedRaw.postId || "").trim(),
        authorUid: String(sharedRaw.authorUid || "").trim(),
        authorName: String(sharedRaw.authorName || "").trim() || "User",
        text: String(sharedRaw.text || "").trim(),
        titleId: sharedRaw.titleId ? String(sharedRaw.titleId).trim() : null,
      } : null;

      const postKind = p.kind === "share" ? "share" : "post";
      return {
        kind: postKind === "share" ? "post_share" : "post",
        postKind,
        actorUid: p.authorUid,
        authorName: p.authorName || "",
        titleId: p.titleId || sharedPost?.titleId || null,
        postId: p.id,
        text: p.text || "",
        sharedPost,
        ts: p.createdAt,
      };
    });

  state.postMap = new Map(postEvents.filter(p => p.postId).map(p => [p.postId, p]));

  const all = [
    ...ratingEvents,
    ...threadEvents,
    ...postEvents,
    ...titleAddedEvents,
    ...friendAddedEvents,
  ];
  console.log("[feed-debug] legacy items:", { ratings: ratingEvents.length, threads: threadEvents.length, posts: postEvents.length, titleAdded: titleAddedEvents.length, friendAdded: friendAddedEvents.length, total: all.length });

  // dedupedAll (ordine cronologico) resta l'input della leaderboard più sotto
  // (invariato — la leaderboard non deve seguire il ranking del feed).
  const dedupedAll = dedupeFeedItems(all);

  // Ranked mix (community-alive): qui siamo nel branch "legacy" — il caso
  // ESATTO che il task descrive (feedEvents troppo povero → few follows →
  // feed morto). dedupedAll = follow-graph (rating/thread/post/title_added/
  // friend_added di chi segui, `all` include già postEvents che sono post
  // ma SOLO di chi segui). Aggiungiamo qui la finestra di post pubblici di
  // TUTTA la community per dare vita al feed anche a chi ha pochi follow.
  const [publicPostScored, commentScored] = await Promise.all([
    loadRankedPublicPosts().catch((err) => { console.warn("[feed-debug] public posts error:", err); return []; }),
    loadCommentItems(myUid).catch((err) => { console.warn("[feed-debug] comments error:", err); return []; }),
  ]);
  const rankedItems = blendRankedFeed(dedupedAll.slice(0, 200), publicPostScored, commentScored)
    .filter((row) => !state.blockedUserIds?.has(String(row?.actorUid || row?.authorUid || "")));

  const items = [];
  if (suggestionTitle) {
    state.titleMap.set(suggestionTitle.id, suggestionTitle);
    items.push({ kind: "suggestion", titleId: suggestionTitle.id, ts: Date.now() + 1 });
  }

  items.push(...rankedItems);

  // Se arrivo da notifica/home?post=..., porto quel contenuto in alto nel feed.
  const deepLinkPostId = String(state.deepLinkPostId || "").trim();
  if (deepLinkPostId) {
    const idx = items.findIndex((row) => String(row?.postId || "") === deepLinkPostId);
    if (idx >= 0) {
      const [target] = items.splice(idx, 1);
      if (items[0]?.kind === "suggestion") items.splice(1, 0, target);
      else items.unshift(target);
    }
  }

  // cache titoli necessari
  const titleIds = items.flatMap((x) => {
    const ids = [];
    if (x?.titleId) ids.push(x.titleId);
    if (x?.sharedPost?.titleId) ids.push(x.sharedPost.titleId);
    return ids;
  });
  await ensureTitlesCached(titleIds);

  await ensureMinLoading(startedAt);
  if (buildSeq !== state.feedBuildSeq) return;

  state.items = items;
  state.cursor = 0;
  if (feedEl) feedEl.innerHTML = "";
  if (feedLoadMoreEl) feedLoadMoreEl.innerHTML = "";

  // initial load: 1 suggerimento (se c'è) + 4 eventi
  const initialCount = items.length && items[0].kind === "suggestion" ? 5 : 4;
  await renderNextChunk(initialCount);
  mountInfiniteScroll();
  focusDeepLinkedPostCard();

  // Social Insight (client-side, from data already loaded — only 1 extra read for myLib)
  try {
    const insightHtml = buildInsight(myUid, [...libs, myLib], friendUids);
    renderInsight(insightHtml);
  } catch (_) {}

  // Leaderboard: prima passata rapida + enrichment "totali"
  state.leaderboardInput = { all: dedupedAll, recentTitles, libs: [...libs, myLib], myUid };
  await rebuildLeaderboardsFromState();

  loadContributionTotals([...sources, myUid])
    .then(async (totals) => {
      if (buildSeq !== state.feedBuildSeq) return;
      state.contributionTotals = totals;
      await rebuildLeaderboardsFromState();
      if (state.activeTab === "classifiche") renderLeaderboard();
    })
    .catch(() => {});

  // Mostra tabs
  if (feedTabsEl) feedTabsEl.style.display = "flex";

  // Carica classifica globale (non bloccante)
  loadGlobalLeaderboard().catch(() => {});
  } catch (err) {
    console.error("Errore nel caricamento del feed", err);
    showErrorBanner(errorContainer, i18nT("Errore nel caricamento del feed"), () => buildHomeFeed(myUid));
  }
}

// ==============================
// Quick search (Home -> Search)
// ==============================

function setQuickSearchOpen(open) {
  if (!quickSearch) return;
  if (open) quickSearch.classList.add("open");
  else quickSearch.classList.remove("open");
}

function renderQuickResults(items) {
  if (!quickSearchResults) return;
  if (!items || !items.length) {
    quickSearchResults.innerHTML = "";
    return;
  }

  quickSearchResults.innerHTML = items.map(it => {
    if (it.kind === "title") {
      const name = escapeHtml(it.name || "");
      const year = it.year ? ` <span class="muted">(${escapeHtml(String(it.year))})</span>` : "";
      const type = it.type === "tv" ? i18nT("Serie") : i18nT("Film");
      return `
        <a class="quick-item" role="option" href="/title.html?id=${encodeURIComponent(it.id)}">
          <div class="quick-item-main">
            <div class="quick-item-title">${name}${year}</div>
            <div class="quick-item-sub muted">${escapeHtml(type)}</div>
          </div>
        </a>
      `;
    }

    const dn = escapeHtml(it.displayName || i18nT("Utente"));
    return `
      <a class="quick-item" role="option" href="/user.html?uid=${encodeURIComponent(it.uid)}">
        <div class="quick-item-main">
          <div class="quick-item-title">${dn}</div>
          <div class="quick-item-sub muted">@${escapeHtml(it.uid)}</div>
        </div>
      </a>
    `;
  }).join("");
}

async function runQuickSearch(term) {
  const q = String(term || "").trim();
  if (!q) {
    renderQuickResults([]);
    return;
  }

  try {
    const [titles, users] = await Promise.all([
      searchTitlesSmart(q, 6).catch(() => []),
      searchUsersByPrefix(q, { max: 4 }).catch(() => []),
    ]);

    const items = [
      ...titles.slice(0, 6).map(t => ({ kind: "title", id: t.id, name: t.name, year: t.year, type: t.type })),
      ...users.slice(0, 4).map(u => ({ kind: "user", uid: u.uid, displayName: u.displayName })),
    ].slice(0, 8);

    renderQuickResults(items);
  } catch (e) {
    console.error("Quick search error:", e);
    renderQuickResults([]);
  }
}

function openQuickSearch() {
  setQuickSearchOpen(true);
  homeSearch?.focus();
}

headerSearchBtn?.addEventListener("click", () => {
  const isOpen = quickSearch?.classList.contains("open");
  if (isOpen) {
    setQuickSearchOpen(false);
    renderQuickResults([]);
  } else {
    openQuickSearch();
  }
});

homeSearch?.addEventListener("input", debounce((e) => {
  runQuickSearch(e.target.value);
}, 160));

// ==============================
// Feed / Classifiche tab switching
// ==============================

function setFeedTopTab(tab) {
  const nextTab = tab === "classifiche" ? "classifiche" : "feed";
  state.activeTab = nextTab;
  feedTabsEl?.querySelectorAll(".feed-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === nextTab));

  const isFeed = nextTab === "feed";
  if (feedEl) feedEl.style.display = isFeed ? "" : "none";
  if (feedLoadMoreEl) feedLoadMoreEl.style.display = isFeed ? "" : "none";
  if (socialInsightEl) socialInsightEl.style.display = isFeed ? (socialInsightEl.dataset.wasVisible === "1" ? "block" : "none") : "none";
  if (leaderboardEl) leaderboardEl.style.display = isFeed ? "none" : "block";

  if (!isFeed) {
    renderLeaderboard();
  }
}

feedTabsEl?.addEventListener("click", (e) => {
  const btn = e.target.closest(".feed-tab");
  if (!btn) return;
  const tab = btn.dataset.tab;
  if (tab === state.activeTab) return;
  setFeedTopTab(tab);
});

setFeedTopTab(state.activeTab);

// ==============================
// Discussioni per te (thread pubblici ranked per rilevanza genere)
// ==============================
// Riusa listPublicThreads (già importata da threads.api.js; la stessa chiamata
// che il feed legacy usa per i thread event). Markup minimale ispirato a
// .threadcard di threads.page.js (stesse classi CSS, nessun import di
// threads.page.js che si auto-bootstrap). Ranking in buildRelevantDiscussions().

const communityThreadsListEl = qs("#communityThreadsList");
const communityThreadsHeadEl = qs("#communityThreadsHead");

// Hint "perché rilevante": solo per i match genuini (exact match o overlap
// genere) — i fallback (nessun match, mostriamo i thread più recenti) non
// hanno un hint per non inventare una motivazione che non esiste.
function relevanceHintHtml(row) {
  if (!row || row.score <= 0) return "";
  if (row.exactMatch) {
    return `<span class="threadcard-pill threadcard-pill-accent">${i18nT("Nella tua libreria")}</span>`;
  }
  if (row.overlap?.length) {
    // Solo il nome del genere: il "perché" lo spiega il sottotitolo di
    // sezione ("In base ai generi che guardi"), la chip non deve urlare.
    const g = genreMap.get(row.overlap[0]) || row.overlap[0];
    return `<span class="threadcard-pill threadcard-pill-muted">${escapeHtml(g)}</span>`;
  }
  return "";
}

function communityThreadRowHtml(row) {
  // Accetta sia un raw thread (fallback legacy) sia una row scored
  // { th, score, overlap, exactMatch } da buildRelevantDiscussions().
  const th = row?.th || row;
  const titleId = String(th.titleId || "").trim();
  const t = titleId ? state.titleMap.get(titleId) : null;
  const name = t?.name || th.groupName || i18nT("Discussione");
  const preview = String(th.lastMessagePreview || "").trim();
  const poster = t?.posterPath
    ? `<img alt="" src="${escapeHtml(t.posterPath)}" loading="lazy" decoding="async">`
    : "";
  const when = escapeHtml(timeText(th.lastMessageAt));
  const hint = row?.th ? relevanceHintHtml(row) : "";
  // Se il preview inizia col voto ("7.5/10 — recensione…"), separalo: il
  // voto diventa un badge ★ senza "/10", il testo resta solo recensione.
  let voteBadge = "";
  let previewText = preview;
  // `[+½-]` copre i voti a quarti di punto ("8½/10", "7+/10", "9-/10") che
  // `formatMaskedRating` produce; il segmento "· con Anna" viene scartato dal
  // testo dell'anteprima, dove non c'è spazio.
  const voteMatch = preview.match(/^(\d{1,2}(?:[.,]\d+)?[+½-]?)\s*\/\s*10\b\s*(?:·[^—–\n]{0,160})?\s*[—–\-:]*\s*/);
  if (voteMatch) {
    voteBadge = `<span class="threadcard-vote" aria-label="${i18nT("Voto {rating} su 10", { rating: escapeHtml(voteMatch[1]) })}">★ ${escapeHtml(voteMatch[1])}</span>`;
    previewText = preview.slice(voteMatch[0].length).trim();
  }
  const badges = `${voteBadge}${hint}`;
  return `
    <a class="threadcard" href="/thread.html?tid=${encodeURIComponent(th.id)}">
      <div class="threadcard-poster${poster ? "" : " threadcard-poster-ph"}">${poster}</div>
      <div class="threadcard-body">
        <div class="threadcard-top">
          <span class="threadcard-name">${escapeHtml(name)}</span>
          <span class="threadcard-join">Unisciti</span>
        </div>
        ${badges ? `<div class="threadcard-badges">${badges}</div>` : ""}
        ${previewText ? `<p class="threadcard-preview">${escapeHtml(previewText)}</p>` : ""}
        <div class="threadcard-foot">
          <span class="threadcard-foot-spacer"></span>
          ${when ? `<span class="threadcard-date">${when}</span>` : ""}
          <svg class="threadcard-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
        </div>
      </div>
    </a>
  `;
}

function focusDiscussionStarter() {
  const card = discussionStarterEl;
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  if (discussionTitleSearchEl) discussionTitleSearchEl.style.display = "flex";
  discussionTitleSearchInput?.focus();
}

async function loadCommunityThreads() {
  if (!communityThreadsListEl) return;
  try {
    const { threads: scoredRows, fallback } = await buildRelevantDiscussions(state.me?.uid, { max: COMMUNITY_THREADS_MAX });
    if (communityThreadsHeadEl) {
      const h3 = communityThreadsHeadEl.querySelector("h3");
      if (h3) h3.textContent = fallback ? "Discussioni attive" : i18nT("Discussioni per te");
      // Il sottotitolo spiega il ranking per genere: nel fallback (thread
      // recenti, nessun match) sarebbe una bugia → nascosto.
      const sub = communityThreadsHeadEl.querySelector("[data-role='disc-sub']");
      if (sub) sub.style.display = fallback ? "none" : "";
    }

    const withPreview = scoredRows;

    if (!withPreview.length) {
      communityThreadsListEl.innerHTML = `
        <div class="threads-empty-state">
          <span>${i18nT("Ancora nessuna discussione.")}</span>
          <span>${i18nT("Aprine una da un titolo o")} <a href="#discussionStarter" id="communityThreadsEmptyCta">${i18nT("qui sopra")}</a>.</span>
        </div>
      `;
      qs("#communityThreadsEmptyCta", communityThreadsListEl)?.addEventListener("click", (e) => {
        e.preventDefault();
        focusDiscussionStarter();
      });
      return;
    }

    communityThreadsListEl.innerHTML = withPreview.map(communityThreadRowHtml).join("");
  } catch (err) {
    console.warn("loadCommunityThreads error", err);
    communityThreadsListEl.innerHTML = `<div class="hint">${i18nT("Errore nel caricamento delle discussioni.")}</div>`;
  }
}

// ==============================
// INIT
// ==============================
// NB: onboarding nuovo utente + disclaimer "progetto giovane" restano su Home
// (initHomeOnboarding/maybeShowYoungProjectBanner) — Community non li ripete.

wireComposer();
wireDiscussionStarter();

initAuthGuard({ requireAuth: true, onReady: async (user) => {
  state.me = user;
  void setAnalyticsUser(user);

  navAccount?.setAttribute?.("href", "/account.html");
  await ensureUserDoc(user).catch(() => {});

  // composer
  cachedFriends = null; // reset friends cache for mention
  if (composer) composer.style.display = "block";
  const u = await getUserPublic(user.uid).catch(() => null);
  if (u) state.userMap.set(user.uid, u);
  renderComposerAvatar(u);

  // notifiche
  await initNotificationsBadge(user.uid);

  if (notificationLink && notificationDropdown) {
    notificationLink.style.display = "inline-flex";
    notificationLink.addEventListener("click", async (e) => {
      e.preventDefault();
      notifOpen = !notifOpen;
      if (notifOpen) {
        openNotificationsDropdown();
        await renderNotificationsList(user.uid);
      } else {
        closeNotificationsDropdown();
      }
    });
  }

  notifMarkAll?.addEventListener("click", async (e) => {
    e.preventDefault();
    await runWithButtonLoading(notifMarkAll, async () => {
      try {
        await markAllAsRead(user.uid);
        await renderNotificationsList(user.uid);
        toast(i18nT("Notifiche segnate come lette."), i18nT("Notifiche"), { type: "success" });
      } catch (err) {
        console.error(err);
        toast(i18nT("Non siamo riusciti ad aggiornare le notifiche."), i18nT("Notifiche"), { type: "error" });
      }
    }, { loadingLabel: i18nT("Aggiornamento...") });
  });

  if (!outsideNotifListenerAttached) {
    outsideNotifListenerAttached = true;
    document.addEventListener("click", (ev) => {
      if (!notifOpen) return;
      const t = ev.target;
      const inside = notificationDropdown?.contains(t) || notificationLink?.contains(t);
      if (!inside) closeNotificationsDropdown();
    });
  }

  await buildHomeFeed(user.uid);
  loadCommunityThreads().catch(() => {});
  btnReload?.addEventListener("click", () => {
    buildHomeFeed(user.uid);
    loadCommunityThreads().catch(() => {});
  });

  try { mountNotificationPermissionBanner({ containerSelector: "main.container", user }); } catch (_) {}
}});
