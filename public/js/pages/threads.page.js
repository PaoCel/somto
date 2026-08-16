import { initAuthGuard } from "../components/authGuard.js";
import { t as i18nT } from "../i18n/index.js";
import { initTabbar } from "../utils/tabbar.js";
import { ensureUserDoc, getMyUserDoc, listUsersPublicByIds } from "../api/users.api.js";
import { listMyThreadsPage, listPublicThreadsPage, listenMyThreads, getLastReadAt } from "../api/threads.api.js";
import { listTitlesByIds } from "../api/titles.api.js";
import { qs, qsa, escapeHtml } from "../utils/dom.js";

initTabbar();

const threadList = qs("#threadList");
const sectionLabel = qs("#threadsSectionLabel");
const filterBtns = qsa(".threads-seg-btn");
const supportThreadsTab = qs("#supportThreadsTab");

let currentUser = null;
let activeFilter = "discussions";
let allThreads = []; // merged & deduplicated
let titleMap = new Map();
let userMap = new Map(); // uid -> { displayName, photoURL }
let myThreadsState = [];
let publicThreadsState = [];
let myThreadsCursorDoc = null;
let publicThreadsCursorDoc = null;
let myThreadsHasMore = false;
let publicThreadsHasMore = false;
let stopSupportInbox = null;
let canManageSupportInbox = false;

const THREADS_PAGE_SIZE = 40;
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

// ── Helpers ──

function initials(name) {
  const n = String(name || "").trim();
  if (!n) return "?";
  return n.charAt(0).toUpperCase();
}

const SECTION_LABELS = {
  discussions: "DISCUSSIONI PUBBLICHE",
  messages: "MESSAGGI DIRETTI",
  groups: "GRUPPI",
  support: i18nT("ASSISTENZA"),
};

const EMPTY_STATES = {
  discussions: {
    title: i18nT("Nessuna discussione"),
    message: i18nT("Apri il thread pubblico di un titolo dalla pagina dettaglio per iniziare la conversazione."),
  },
  messages: {
    title: i18nT("Nessun messaggio"),
    message: i18nT("Invia un suggerimento o avvia una chat 1:1 da una scheda titolo per popolare questa sezione."),
  },
  groups: {
    title: i18nT("Nessun gruppo"),
    message: i18nT("Crea un gruppo dalla scheda di un titolo per parlarne con i tuoi amici."),
  },
  support: {
    title: i18nT("Nessuna richiesta di assistenza"),
    message: i18nT("Le conversazioni di assistenza appariranno qui in tempo reale."),
  },
};

function emptyStateIcon(filter) {
  if (filter === "messages" || filter === "support") {
    return `<path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/>`;
  }
  if (filter === "groups") {
    return `<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>`;
  }
  return `<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>`;
}

// ── Date formatting (matches iOS .abbreviated/.shortened) ──

function threadDate(row) {
  const raw = row?.lastMessageAt || row?.createdAt;
  if (!raw) return null;
  const d = raw?.toDate?.();
  if (d instanceof Date) return d;
  if (raw instanceof Date) return raw;
  if (typeof raw === "number") return new Date(raw);
  return null;
}

function formatThreadDate(date) {
  if (!date) return "";
  try {
    const day = new Intl.DateTimeFormat("it-IT", { day: "numeric", month: "short" }).format(date);
    const time = new Intl.DateTimeFormat("it-IT", { hour: "2-digit", minute: "2-digit" }).format(date);
    return `${day}, ${time}`;
  } catch (_) {
    return "";
  }
}

// ── Poster / icon block ──

function threadTypeSymbol(th) {
  if (th.visibility === "public") {
    return `<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>`;
  }
  if (th.contextType === "group") {
    return `<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>`;
  }
  return `<path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/>`;
}

function isSupportThread(th) {
  return th?.contextType === "group" && String(th?.contextId || "").startsWith("support_");
}

function threadPoster(th) {
  const t = titleMap.get(th.titleId);
  const posterPath = t?.posterPath;
  const isPrivate = th.visibility !== "public";
  const cornerBadge = isPrivate
    ? `<span class="threadcard-corner ${th.contextType === "group" ? "is-group" : "is-dm"}">${th.contextType === "group" ? i18nT("Gruppo") : "DM"}</span>`
    : "";

  if (posterPath) {
    return `<div class="threadcard-poster">
      <img src="${escapeHtml(posterPath)}" alt="" loading="lazy" />
      ${cornerBadge}
    </div>`;
  }
  return `<div class="threadcard-poster threadcard-poster-ph">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${threadTypeSymbol(th)}</svg>
    ${cornerBadge}
  </div>`;
}

// ── Avatar cluster for participants ──

function renderAvatarsCluster(th) {
  const otherUids = (th.participants || []).filter(uid => uid && uid !== currentUser?.uid);
  const shown = otherUids.slice(0, 3);
  const extra = otherUids.length - shown.length;

  const avatarsHtml = shown.map(uid => {
    const u = userMap.get(uid);
    const photo = u?.photoURL;
    const inner = photo
      ? `<img alt="" src="${escapeHtml(photo)}" loading="lazy" decoding="async" />`
      : escapeHtml(initials(u?.displayName));
    return `<div class="threadcard-avatar">${inner}</div>`;
  }).join("");

  const extraHtml = extra > 0
    ? `<div class="threadcard-avatar threadcard-avatar-extra">+${extra}</div>`
    : "";

  if (!avatarsHtml && !extraHtml) return "";
  return `<div class="threadcard-avatars">${avatarsHtml}${extraHtml}</div>`;
}

// ── Badges row (Pubblico + content type) ──

const REVIEW_PREVIEW_RE = /^\d+(?:[.,]\d+)?\s*\/\s*10\b/;

function isReviewBased(th) {
  const preview = String(th.lastMessagePreview || "").trim();
  return REVIEW_PREVIEW_RE.test(preview);
}

function pill(text, iconPath, { tint = "muted", outlined = false } = {}) {
  return `<span class="threadcard-pill threadcard-pill-${tint}${outlined ? " is-outlined" : ""}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${iconPath}</svg>
    ${escapeHtml(text)}
  </span>`;
}

function badgesRow(th) {
  const parts = [];
  if (th.visibility === "public") {
    parts.push(pill(i18nT("Pubblico"),
      `<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>`,
      { tint: "accent" }));
  }

  if (th.visibility === "public") {
    const review = isReviewBased(th);
    parts.push(pill(
      review ? "Recensione" : i18nT("Discussione"),
      review
        ? `<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>`
        : `<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>`,
      { tint: review ? "warm" : "muted", outlined: true }));
  } else if (th.contextType === "group") {
    parts.push(pill(isSupportThread(th) ? i18nT("Assistenza") : i18nT("Gruppo"),
      `<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>`,
      { tint: "muted", outlined: true }));
    if (canManageSupportInbox && activeFilter === "support" && isSupportThread(th) && th.lastSenderUid && th.lastSenderUid !== currentUser?.uid) {
      parts.push(pill(i18nT("Da rispondere"),
        `<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`,
        { tint: "warm" }));
    }
  } else {
    parts.push(pill("Chat",
      `<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>`,
      { tint: "muted", outlined: true }));
  }

  return `<div class="threadcard-badges">${parts.join("")}</div>`;
}

// ── Unread check ──

function isUnread(th) {
  if (!th.lastMessageAt) return false;
  const lastMsg = th.lastMessageAt?.toDate?.()?.getTime?.()
    || (typeof th.lastMessageAt === "number" ? th.lastMessageAt : 0);
  if (!lastMsg) return false;
  return lastMsg > getLastReadAt(th.id);
}

// ── Thread display name ──

function threadDisplayName(th) {
  const t = titleMap.get(th.titleId);
  if (t?.name) return t.name;
  if (th.visibility !== "public") {
    if (th.contextType === "group" && th.groupName) return th.groupName;
    const otherUids = (th.participants || []).filter(uid => uid && uid !== currentUser?.uid);
    const names = otherUids.map(uid => userMap.get(uid)?.displayName).filter(Boolean);
    if (names.length) return names.join(", ");
  }
  return th.titleId || i18nT("Discussione");
}

// ── Render ──

function renderFiltered() {
  if (!threadList) return;
  if (sectionLabel) sectionLabel.textContent = SECTION_LABELS[activeFilter] || SECTION_LABELS.discussions;

  let filtered;
  switch (activeFilter) {
    case "support":
      filtered = allThreads.filter(th => isSupportThread(th) && th._isMine);
      break;
    case "messages":
      filtered = allThreads.filter(th => th.visibility !== "public" && th.contextType !== "group" && th._isMine);
      break;
    case "groups":
      filtered = allThreads.filter(th => th.visibility !== "public" && th.contextType === "group" && !isSupportThread(th) && th._isMine);
      break;
    default: // discussions: all public threads
      filtered = allThreads.filter(th => th.visibility === "public");
      break;
  }

  const canLoadMorePublic = activeFilter === "discussions" && publicThreadsHasMore;
  const canLoadMoreMine = activeFilter !== "discussions" && activeFilter !== "support" && myThreadsHasMore;
  const canLoadMore = canLoadMorePublic || canLoadMoreMine;
  const loadMode = canLoadMorePublic ? "public" : "mine";

  const loadMoreHtml = canLoadMore
    ? `<button class="threads-load-more" type="button" data-load-more-threads="${loadMode}">${i18nT("Carica altri")}</button>`
    : "";

  if (!filtered.length) {
    const es = EMPTY_STATES[activeFilter] || EMPTY_STATES.discussions;
    threadList.innerHTML = `
      <div class="threads-empty">
        <span class="threads-empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${emptyStateIcon(activeFilter)}</svg>
        </span>
        <div class="threads-empty-title">${escapeHtml(es.title)}</div>
        <p class="threads-empty-msg">${escapeHtml(es.message)}</p>
      </div>${loadMoreHtml}`;
    bindLoadMore(loadMode);
    return;
  }

  const cards = filtered.map(th => {
    const titleName = threadDisplayName(th);
    const unread = isUnread(th);
    const preview = String(th.lastMessagePreview || "").trim();
    const date = formatThreadDate(threadDate(th));

    return `
      <a class="threadcard${unread ? ' is-unread' : ''}" href="/thread.html?tid=${encodeURIComponent(th.id)}">
        ${threadPoster(th)}
        <div class="threadcard-body">
          <div class="threadcard-top">
            <span class="threadcard-name">${escapeHtml(titleName)}</span>
            ${unread ? '<span class="threadcard-unread-dot"></span>' : ''}
          </div>
          ${badgesRow(th)}
          ${preview ? `<p class="threadcard-preview">${escapeHtml(preview)}</p>` : ''}
          <div class="threadcard-foot">
            ${renderAvatarsCluster(th)}
            <span class="threadcard-foot-spacer"></span>
            ${date ? `<span class="threadcard-date">${escapeHtml(date)}</span>` : ''}
            <svg class="threadcard-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
          </div>
        </div>
      </a>`;
  }).join("");

  threadList.innerHTML = cards + loadMoreHtml;
  bindLoadMore(loadMode);
}

function bindLoadMore(loadMode) {
  threadList.querySelector("[data-load-more-threads]")?.addEventListener("click", async (ev) => {
    ev.preventDefault();
    await loadAllThreads(currentUser?.uid, { reset: false, source: loadMode });
  });
}

// ── Filter tabs ──

function setFilter(filter) {
  if (filter === "support" && supportThreadsTab?.hidden) filter = "groups";
  activeFilter = filter;
  filterBtns.forEach(btn => {
    btn.classList.toggle("active", btn.dataset.filter === filter);
    btn.setAttribute("aria-selected", btn.dataset.filter === filter ? "true" : "false");
  });
  const url = new URL(window.location.href);
  if (filter === "discussions") url.searchParams.delete("filter");
  else url.searchParams.set("filter", filter);
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  renderFiltered();
}

filterBtns.forEach(btn => {
  btn.addEventListener("click", () => setFilter(btn.dataset.filter));
});

// ── Data loading ──

function threadTsMs(row) {
  const raw = row?.lastMessageAt;
  if (!raw) return 0;
  const d = raw?.toDate?.();
  if (d instanceof Date) return d.getTime();
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === "number") return raw;
  return 0;
}

function rebuildMergedThreads(uid) {
  const mine = myThreadsState.map((t) => ({ ...t, _isMine: true }));
  const mineIds = new Set(mine.map((t) => t.id));
  const pub = publicThreadsState
    .filter((t) => !mineIds.has(t.id))
    .map((t) => ({ ...t, _isMine: false }));

  const merged = [];
  let i = 0;
  let j = 0;
  while (i < mine.length || j < pub.length) {
    if (j >= pub.length) {
      merged.push(mine[i++]);
      continue;
    }
    if (i >= mine.length) {
      merged.push(pub[j++]);
      continue;
    }
    if (threadTsMs(mine[i]) >= threadTsMs(pub[j])) merged.push(mine[i++]);
    else merged.push(pub[j++]);
  }

  allThreads = merged;
}

async function preloadThreadCards(uid) {
  const missingTitleIds = [...new Set(
    allThreads
      .map((t) => String(t?.titleId || "").trim())
      .filter((id) => id && !titleMap.has(id))
  )];
  if (missingTitleIds.length) {
    const titles = await listTitlesByIds(missingTitleIds, { max: missingTitleIds.length }).catch(() => []);
    titles.forEach((t) => {
      if (t?.id) titleMap.set(t.id, t);
    });
  }

  const missingUserIds = [...new Set(
    allThreads.flatMap((th) => {
      if (th.visibility === "public" || !Array.isArray(th.participants)) return [];
      return th.participants.filter((p) => p && p !== uid && !userMap.has(p));
    })
  )];
  if (missingUserIds.length) {
    const users = await listUsersPublicByIds(missingUserIds, { max: missingUserIds.length }).catch(() => []);
    users.forEach((u) => {
      if (u?.uid) userMap.set(u.uid, u);
    });
  }
}

async function loadAllThreads(uid, { reset = true, source = "all" } = {}) {
  if (!threadList) return;
  const startedAt = perfNow();
  if (reset) {
    threadList.innerHTML = `<div class="threads-loading"><div class="spinner"></div></div>`;
    myThreadsState = [];
    publicThreadsState = [];
    myThreadsCursorDoc = null;
    publicThreadsCursorDoc = null;
    myThreadsHasMore = false;
    publicThreadsHasMore = false;
  }

  const shouldLoadMine = Boolean(uid) && (reset || source === "all" || source === "mine");
  const shouldLoadPublic = reset || source === "all" || source === "public";
  const fetchStartedAt = perfNow();

  try {
    const [minePage, publicPage] = await Promise.all([
      shouldLoadMine
        ? listMyThreadsPage(uid, {
            pageSize: THREADS_PAGE_SIZE,
            cursorDoc: reset ? null : myThreadsCursorDoc,
          }).catch((err) => {
            console.error("[threads.page] listMyThreadsPage failed:", err);
            return { items: [], nextCursorDoc: null, hasMore: false };
          })
        : Promise.resolve(null),
      shouldLoadPublic
        ? listPublicThreadsPage({
            pageSize: THREADS_PAGE_SIZE,
            cursorDoc: reset ? null : publicThreadsCursorDoc,
          }).catch((err) => {
            console.error("[threads.page] listPublicThreadsPage failed:", err);
            return { items: [], nextCursorDoc: null, hasMore: false };
          })
        : Promise.resolve(null),
    ]);

    if (minePage) {
      myThreadsState = reset ? minePage.items : myThreadsState.concat(minePage.items);
      myThreadsCursorDoc = minePage.nextCursorDoc || null;
      myThreadsHasMore = minePage.hasMore === true;
    } else if (!uid) {
      myThreadsState = [];
      myThreadsCursorDoc = null;
      myThreadsHasMore = false;
    }

    if (publicPage) {
      publicThreadsState = reset ? publicPage.items : publicThreadsState.concat(publicPage.items);
      publicThreadsCursorDoc = publicPage.nextCursorDoc || null;
      publicThreadsHasMore = publicPage.hasMore === true;
    }
  } catch (err) {
    console.error("[threads.page] loadAllThreads outer error:", err);
  }

  const fetchMs = Math.round((perfNow() - fetchStartedAt) * 10) / 10;
  const preloadStartedAt = perfNow();
  rebuildMergedThreads(uid);
  await preloadThreadCards(uid);
  const preloadMs = Math.round((perfNow() - preloadStartedAt) * 10) / 10;
  renderFiltered();
  logPerf("threads.loadAllThreads", startedAt, {
    reset,
    source,
    fetchMs,
    preloadMs,
    mineCount: myThreadsState.length,
    publicCount: publicThreadsState.length,
    mergedCount: allThreads.length,
    hasMoreMine: myThreadsHasMore,
    hasMorePublic: publicThreadsHasMore,
  });
}

// ── Auth ──

initAuthGuard({ requireAuth: false, onReady: async (user) => {
  currentUser = user;
  let meDoc = null;
  if (user) {
    await ensureUserDoc(user).catch(() => {});
    meDoc = await getMyUserDoc(user.uid).catch(() => null);
  }

  canManageSupportInbox = meDoc?.isAdmin === true;
  if (supportThreadsTab) supportThreadsTab.hidden = !user;

  const requestedFilter = new URLSearchParams(window.location.search).get("filter");
  if (["messages", "groups"].includes(requestedFilter)) activeFilter = requestedFilter;
  if (requestedFilter === "support" && user) activeFilter = "support";

  await loadAllThreads(user?.uid);
  setFilter(activeFilter);

  stopSupportInbox?.();
  stopSupportInbox = null;
  if (user) {
    stopSupportInbox = listenMyThreads(user.uid, {
      max: 100,
      onChange: async (threads) => {
        myThreadsState = threads;
        myThreadsCursorDoc = null;
        myThreadsHasMore = false;
        rebuildMergedThreads(user.uid);
        await preloadThreadCards(user.uid);
        renderFiltered();
      },
    });
  }
}});

window.addEventListener("pagehide", () => stopSupportInbox?.(), { once: true });
