import { initAuthGuard } from "../components/authGuard.js";
import { mountNotificationPermissionBanner } from "../components/notifyPermissionBanner.js";
import { t as i18nT, formatTimeAgo } from "../i18n/index.js";
import { toast } from "../components/toast.js";
import { qs, qsa, escapeHtml } from "../utils/dom.js";
import { setAnalyticsUser, logEvent } from "../analytics.js";
import { getMyNotifications, markAsRead, markAllAsRead, onNotificationsChange } from "../api/notifications.api.js";
import { listUsersPublicByIds } from "../api/users.api.js";
import {
  adminImportStartedPresentation,
  genericServerNotificationPresentation,
  importNotificationPresentation,
} from "../utils/importNotificationPresentation.js";

const listEl = qs("#notificationsList");
const markAllBtn = qs("#btnMarkAllRead");
const viewBtns = qsa("[data-view]");
const totalCountEl = qs("#notifTotalCount");
const unreadCountEl = qs("#notifUnreadCount");
const unreadDotEl = qs("#notifUnreadDot");

// Notification types treated as "Commenti" — mirrors iOS NotificationsViewModel.commentTypes.
const COMMENT_TYPES = new Set([
  "post_comment", "rating_comment", "comment_like", "post_mention", "comment_on_post", "comment_reply",
]);

// Cleanup pool: unsub di onSnapshot al pagehide.
const _unsubs = [];
function trackUnsub(u) { if (typeof u === "function") _unsubs.push(u); return u; }
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    while (_unsubs.length) { try { _unsubs.pop()(); } catch {} }
  });
}

const state = {
  uid: null,
  view: "all",
  items: [],
  users: new Map(),
  unreadUnsub: null,
  loading: false,
};

function tsToMillis(ts) {
  if (!ts) return 0;
  if (typeof ts === "number") return ts;
  try {
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.seconds === "number") return (ts.seconds * 1000) + Math.floor((ts.nanoseconds || 0) / 1e6);
  } catch (_) {}
  return 0;
}

function nonNegativeInt(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function commentReviewUrl(data = {}) {
  const explicit = String(data.ctaUrl || "").trim();
  if (explicit.startsWith("/admin-import-comments.html")) return explicit;
  const params = new URLSearchParams();
  const uid = String(data.importUid || "").trim();
  const importId = String(data.importId || "").trim();
  if (uid) params.set("uid", uid);
  if (importId) params.set("importId", importId);
  const query = params.toString();
  return `/admin-import-comments.html${query ? `?${query}` : ""}`;
}

// Short relative label ("2 g fa", "5 min fa") to match the iOS RelativeDateTimeFormatter.
function timeText(ts) {
  try {
    return formatTimeAgo(tsToMillis(ts));
  } catch (_) {
    return "";
  }
}

function initials(name) {
  const raw = String(name || "").trim();
  if (!raw) return "?";
  const parts = raw.split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] || "?";
  const b = parts.length > 1 ? parts[parts.length - 1]?.[0] || "" : "";
  return (a + b).toUpperCase();
}

// SVG glyphs for the small badge over the avatar — mirrors iOS NotificationRowView.badgeIcon.
const BADGE_ICONS = {
  comment: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3.2c-5.2 0-9.4 3.5-9.4 7.9 0 2.4 1.3 4.6 3.3 6-.2 1.1-.8 2.4-1.8 3.3-.3.3-.1.8.3.8 2 0 3.8-.7 5.1-1.6 1 .2 2 .4 3.2.4 5.2 0 9.4-3.6 9.4-7.9S17.2 3.2 12 3.2Z"/></svg>`,
  heart: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7.2-4.4-9.6-9C1.1 9.3 2.4 6 5.7 6c2 0 3.5 1.2 4.3 2.6.3.5 1.1.5 1.4 0C12.8 7.2 14.3 6 16.3 6c3.3 0 4.6 3.3 3.3 6-2.4 4.6-9.6 9-9.6 9Z"/></svg>`,
  person: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12.4a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4ZM4.5 20a7.5 7.5 0 0 1 15 0 1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1Z"/></svg>`,
  eye: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 5C5.6 5 2 12 2 12s3.6 7 10 7 10-7 10-7-3.6-7-10-7Zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8Z"/></svg>`,
  tv: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 7h13V5H8L11 2H9L6 5H3a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1H3Z"/></svg>`,
  sparkles: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11 2.5 12.4 7 17 8.4 12.4 9.8 11 14.3 9.6 9.8 5 8.4 9.6 7 11 2.5ZM18 14l.8 2.6L21.4 17l-2.6.8L18 20.4l-.8-2.6L14.6 17l2.6-.4L18 14Z"/></svg>`,
};

// Maps notification type -> { glyph, tint class } for the avatar badge.
function badgeForType(type) {
  switch (type) {
    case "post_comment":
    case "rating_comment":
    case "comment_on_post":
    case "comment_reply":
    case "thread_message":
    case "thread_mention":
      return { glyph: BADGE_ICONS.comment, tint: "is-accent" };
    case "rating_like":
    case "post_like":
    case "comment_like":
      return { glyph: BADGE_ICONS.heart, tint: "is-brand" };
    case "follow":
    case "friend_request":
    case "friend_accept":
    case "new_user":
      return { glyph: BADGE_ICONS.person, tint: "is-secondary" };
    case "comment_review_pending":
      return { glyph: BADGE_ICONS.comment, tint: "is-accent" };
    case "watched_with_tag":
    case "engagement_friend_watched":
      return { glyph: BADGE_ICONS.eye, tint: "is-success" };
    case "new_season_available":
      return { glyph: BADGE_ICONS.tv, tint: "is-warning" };
    case "official_update":
      return { glyph: BADGE_ICONS.sparkles, tint: "is-accent" };
    case "engagement_nudge":
      return { glyph: BADGE_ICONS.sparkles, tint: "is-muted" };
    case "titles_import_completed":
      return { glyph: BADGE_ICONS.tv, tint: "is-success" };
    case "titles_import_needs_review":
      return { glyph: BADGE_ICONS.tv, tint: "is-warning" };
    case "titles_import_failed":
      return { glyph: BADGE_ICONS.tv, tint: "is-brand" };
    case "admin_import_started":
      return { glyph: BADGE_ICONS.tv, tint: "is-accent" };
    default:
      return null;
  }
}

// Small context pill under the row (Titolo / Post / Thread / Profilo …) — mirrors iOS contextLabel.
function contextForType(type, url) {
  const u = String(url || "");
  if (u.startsWith("/title.html")) return { label: "Titolo", icon: "film" };
  if (u.startsWith("/thread")) return { label: i18nT("Thread"), icon: "thread" };
  if (u.startsWith("/user.html") || u.startsWith("/account.html")) return { label: i18nT("Profilo"), icon: "person" };
  if (u.startsWith("/community.html?post=") || u.startsWith("/?post=") || u.startsWith("/home.html?post=")) return { label: i18nT("Post"), icon: "post" };
  if (u.startsWith("/moderation")) return { label: i18nT("Moderazione"), icon: "shield" };
  if (u.startsWith("/admin-import-comments")) return { label: "Revisione import", icon: "shield" };
  if (u.startsWith("/import.html")) return { label: "Import", icon: "tv" };
  if (u.startsWith("/watchlist.html")) return { label: "Libreria", icon: "film" };
  if (type === "engagement_nudge") return { label: "Suggerimento", icon: "sparkle" };
  return null;
}

const CONTEXT_ICONS = {
  film: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm2 3v2h2V6H6Zm10 0v2h2V6h-2ZM6 11v2h2v-2H6Zm10 0v2h2v-2h-2ZM6 16v2h2v-2H6Zm10 0v2h2v-2h-2Z"/></svg>`,
  post: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 2h9l5 5v15a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Zm2 8v2h8v-2H8Zm0 4v2h6v-2H8Z"/></svg>`,
  thread: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3.2c-5.2 0-9.4 3.5-9.4 7.9 0 2.4 1.3 4.6 3.3 6-.2 1.1-.8 2.4-1.8 3.3-.3.3-.1.8.3.8 2 0 3.8-.7 5.1-1.6 1 .2 2 .4 3.2.4 5.2 0 9.4-3.6 9.4-7.9S17.2 3.2 12 3.2Z"/></svg>`,
  person: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12.4a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4ZM4.5 20a7.5 7.5 0 0 1 15 0 1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1Z"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Z"/></svg>`,
  sparkle: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11 2.5 12.4 7 17 8.4 12.4 9.8 11 14.3 9.6 9.8 5 8.4 9.6 7 11 2.5Z"/></svg>`,
};

function mapNotificationView(notif, userMap) {
  const type = String(notif?.type || "").trim();
  const fromUid = String(notif?.fromUid || "").trim();
  const fromUser = fromUid ? userMap.get(fromUid) : null;
  const fromName = String(notif?.data?.fromName || fromUser?.displayName || "Qualcuno");

  let title = i18nT("Nuova attività");
  let text = "";
  let url = "/notifications.html";
  let icon = "🔔";

  const importPresentation = importNotificationPresentation(notif);
  const adminImportPresentation = adminImportStartedPresentation(notif, fromName);

  if (importPresentation) {
    ({ title, text, url, icon } = importPresentation);
  } else if (adminImportPresentation) {
    ({ title, text, url, icon } = adminImportPresentation);
  } else if (type === "recommendation") {
    icon = "🎬";
    title = i18nT("{fromName} ti ha consigliato un titolo", { fromName });
    url = notif?.data?.titleId ? `/title.html?id=${encodeURIComponent(notif.data.titleId)}` : "/notifications.html";
  } else if (type === "follow") {
    icon = "👀";
    title = `${fromName} ha iniziato a seguirti`;
    url = fromUid ? `/user.html?uid=${encodeURIComponent(fromUid)}` : "/notifications.html";
  } else if (type === "friend_request") {
    // Grafo amici dismesso (fase 1): la notifica storica resta, ma porta al
    // profilo del mittente invece che a una schermata che non esiste più.
    icon = "🤝";
    title = i18nT("{fromName} ti ha inviato una richiesta", { fromName });
    url = fromUid ? `/user.html?uid=${encodeURIComponent(fromUid)}` : "/notifications.html";
  } else if (type === "friend_accept") {
    icon = "✅";
    title = i18nT("{fromName} ha accettato la richiesta", { fromName });
    url = fromUid ? `/user.html?uid=${encodeURIComponent(fromUid)}` : "/notifications.html";
  } else if (type === "thread_message") {
    icon = "💬";
    title = i18nT("{fromName} ha scritto nel thread", { fromName });
    text = String(notif?.data?.preview || i18nT("nuovo messaggio")).slice(0, 100);
    url = notif?.data?.threadId ? `/thread.html?tid=${encodeURIComponent(notif.data.threadId)}` : "/threads.html";
  } else if (type === "thread_mention") {
    icon = "@";
    title = i18nT("{fromName} ti ha menzionato in un thread", { fromName });
    text = String(notif?.data?.preview || "").slice(0, 100);
    url = notif?.data?.threadId ? `/thread.html?tid=${encodeURIComponent(notif.data.threadId)}` : "/threads.html";
  } else if (type === "post_mention") {
    icon = "@";
    const ctx = String(notif?.data?.context || "");
    title = ctx === "rating_comment"
      ? i18nT("{fromName} ti ha menzionato su un voto", { fromName })
      : `${fromName} ti ha menzionato`;
    text = String(notif?.data?.preview || "").slice(0, 100);
    const targetPost = String(notif?.data?.postId || notif?.data?.eventId || "").trim();
    url = targetPost ? `/community.html?post=${encodeURIComponent(targetPost)}` : "/community.html";
  } else if (type === "post_like") {
    icon = "❤️";
    title = i18nT("{fromName} ha messo like al tuo post", { fromName });
    const targetPost = String(notif?.data?.postId || notif?.data?.eventId || "").trim();
    url = targetPost ? `/community.html?post=${encodeURIComponent(targetPost)}` : "/community.html";
  } else if (type === "post_comment") {
    icon = "💬";
    title = i18nT("{fromName} ha commentato il tuo post", { fromName });
    text = String(notif?.data?.preview || "").slice(0, 100);
    const targetPost = String(notif?.data?.postId || notif?.data?.eventId || "").trim();
    url = targetPost ? `/community.html?post=${encodeURIComponent(targetPost)}` : "/community.html";
  } else if (type === "comment_like") {
    const threadId = String(notif?.data?.threadId || "").trim();
    if (threadId) {
      icon = String(notif?.data?.reaction || "👍");
      title = i18nT("{fromName} ha reagito al tuo commento", { fromName });
      text = String(notif?.data?.reaction || "").trim();
      url = `/thread.html?tid=${encodeURIComponent(threadId)}`;
    } else {
      icon = "👍";
      title = i18nT("{fromName} ha messo like al tuo commento", { fromName });
      const targetPost = String(notif?.data?.postId || notif?.data?.eventId || "").trim();
      url = targetPost ? `/community.html?post=${encodeURIComponent(targetPost)}` : "/community.html";
    }
  } else if (type === "rating_like") {
    icon = "⭐";
    title = i18nT("{fromName} ha reagito al tuo voto", { fromName });
    url = notif?.data?.titleId ? `/title.html?id=${encodeURIComponent(notif.data.titleId)}` : "/";
  } else if (type === "rating_comment") {
    icon = "🗨️";
    title = i18nT("{fromName} ha commentato il tuo voto", { fromName });
    text = String(notif?.data?.preview || "").slice(0, 100);
    url = notif?.data?.titleId ? `/title.html?id=${encodeURIComponent(notif.data.titleId)}` : "/";
  } else if (type === "watched_with_tag") {
    icon = "🍿";
    const movieName = String(notif?.data?.titleName || i18nT("un titolo"));
    title = i18nT("{fromName} ti ha taggato in una visione", { fromName });
    text = i18nT("Hai visto {movieName} insieme. Ti va di votarlo?", { movieName });
    url = notif?.data?.titleId ? `/title.html?id=${encodeURIComponent(notif.data.titleId)}&focus=rating` : "/watchlist.html";
  } else if (type === "engagement_nudge") {
    icon = "✨";
    title = String(notif?.data?.message || i18nT("Nuovi titoli ti aspettano su Somto"));
    url = String(notif?.data?.ctaUrl || "/");
  } else if (type === "official_update") {
    icon = "✓";
    title = String(notif?.data?.title || i18nT("Aggiornamento Somto"));
    text = String(notif?.data?.preview || "").slice(0, 100);
    const targetPost = String(notif?.data?.postId || "").trim();
    url = targetPost ? `/community.html?post=${encodeURIComponent(targetPost)}` : String(notif?.data?.ctaUrl || "/community.html");
  } else if (type === "moderation_pending") {
    icon = "🛡️";
    title = String(notif?.data?.message || i18nT("C'è una nuova attività di moderazione"));
    url = "/moderation.html";
  } else if (type === "new_user") {
    icon = "🆕";
    title = String(notif?.data?.message || i18nT("{fromName} si è appena registrato", { fromName }));
    url = fromUid ? `/user.html?uid=${encodeURIComponent(fromUid)}` : "/notifications.html";
  } else if (type === "comment_review_pending") {
    icon = "🗨️";
    const eligible = nonNegativeInt(notif?.data?.eligible);
    const resolved = Math.min(eligible, nonNegativeInt(notif?.data?.resolved));
    title = i18nT("{count} commenti TV Time da revisionare", { count: eligible });
    text = resolved === eligible
      ? i18nT("{fromName}: tutti pronti per la revisione.", { fromName })
      : i18nT("{fromName}: {resolved} di {eligible} già associati ai titoli.", { fromName, resolved, eligible });
    url = commentReviewUrl(notif?.data);
  } else {
    const genericPresentation = genericServerNotificationPresentation(notif);
    if (genericPresentation) {
      ({ title, text, url, icon } = genericPresentation);
    }
  }

  const photo = String(fromUser?.photoURL || fromUser?.avatarURL || "").trim();
  const avatarText = icon === "@" ? "@" : (!fromUid && icon ? icon : initials(fromName));
  const avatar = photo
    ? `<img alt="" src="${escapeHtml(photo)}" loading="lazy" decoding="async">`
    : `<span class="notif-avatar-fallback">${escapeHtml(avatarText)}</span>`;

  return {
    id: String(notif?.id || ""),
    type,
    read: !!notif?.read,
    title,
    text,
    url,
    when: timeText(notif?.createdAt),
    createdMs: tsToMillis(notif?.createdAt),
    avatar,
    badge: badgeForType(type),
    context: contextForType(type, url),
  };
}

function applyViewButtons() {
  viewBtns.forEach((btn) => {
    const active = btn.dataset.view === state.view;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
}

function unreadTotal() {
  return state.items.filter((n) => !n.read).length;
}

function updateCounts() {
  const total = state.items.length;
  const unread = unreadTotal();
  if (totalCountEl) totalCountEl.textContent = String(total);
  if (unreadCountEl) unreadCountEl.textContent = String(unread);
  if (unreadDotEl) unreadDotEl.hidden = unread <= 0;
  if (markAllBtn) {
    markAllBtn.hidden = unread <= 0;
    markAllBtn.disabled = unread <= 0 || state.loading;
  }
}

// Buckets the visible rows by recency — mirrors iOS groupedNotifications (Oggi / Questa settimana / Prima).
function groupRows(rows) {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekAgo = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const today = [];
  const thisWeek = [];
  const earlier = [];
  rows.forEach((row) => {
    const ms = row.createdMs;
    if (ms && ms >= startOfDay) today.push(row);
    else if (ms && ms >= weekAgo) thisWeek.push(row);
    else earlier.push(row);
  });
  const groups = [];
  if (today.length) groups.push({ title: i18nT("Oggi"), items: today });
  if (thisWeek.length) groups.push({ title: i18nT("Questa settimana"), items: thisWeek });
  if (earlier.length) groups.push({ title: "Prima", items: earlier });
  return groups;
}

function rowHtml(v) {
  const badge = v.badge
    ? `<span class="notif-avatar-badge ${v.badge.tint}" aria-hidden="true">${v.badge.glyph}</span>`
    : "";
  const ctx = v.context
    ? `<span class="notif-row-context"><span class="notif-row-context-icon" aria-hidden="true">${CONTEXT_ICONS[v.context.icon] || ""}</span>${escapeHtml(v.context.label)}</span>`
    : "";
  return `
    <article class="notif-row ${v.read ? "is-read" : ""}">
      <a class="notif-row-main" href="${escapeHtml(v.url)}" data-open-notif="${escapeHtml(v.id)}" data-notif-type="${escapeHtml(v.type || "unknown")}">
        <span class="notif-avatar" aria-hidden="true">${v.avatar}${badge}</span>
        <span class="notif-row-body">
          <span class="notif-row-head">
            <span class="notif-row-title">${escapeHtml(v.title)}</span>
            ${v.when ? `<span class="notif-row-time">${escapeHtml(v.when)}</span>` : ""}
          </span>
          ${v.text ? `<span class="notif-row-text">${escapeHtml(v.text)}</span>` : ""}
          <span class="notif-row-foot">
            ${ctx}
            ${v.read ? "" : `<span class="notif-row-unread" aria-hidden="true"></span>`}
          </span>
        </span>
      </a>
      ${v.read ? "" : `<button class="notif-row-mark" type="button" data-mark-read="${escapeHtml(v.id)}">${i18nT("Segna come letta")}</button>`}
    </article>
  `;
}

function emptyText() {
  if (state.view === "unread") return { t: i18nT("Sei in pari"), m: i18nT("Hai letto tutte le notifiche più recenti. Torna più tardi.") };
  if (state.view === "comments") return { t: i18nT("Nessun commento"), m: i18nT("I commenti ai tuoi post o alle tue recensioni compariranno qui.") };
  return { t: i18nT("Nessuna notifica"), m: i18nT("Quando arrivano commenti, like, recommendation o thread message le trovi qui.") };
}

function renderList() {
  if (!listEl) return;
  const rows = state.items
    .map((n) => mapNotificationView(n, state.users))
    .filter((row) => {
      if (state.view === "unread") return !row.read;
      if (state.view === "comments") return COMMENT_TYPES.has(row.type);
      return true;
    });

  if (!rows.length) {
    const e = emptyText();
    listEl.innerHTML = `
      <div class="notif-empty">
        <span class="notif-empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.4a3 3 0 0 0-3 3v.4C6.5 6.7 5 9.1 5 12v3.3l-1.5 2.1c-.4.6 0 1.4.8 1.4h15.4c.8 0 1.2-.8.8-1.4L19 15.3V12c0-2.9-1.5-5.3-4-6.2v-.4a3 3 0 0 0-3-3Z"/><path d="M9.5 20a2.6 2.6 0 0 0 5 0Z"/></svg>
        </span>
        <p class="notif-empty-title">${escapeHtml(e.t)}</p>
        <p class="notif-empty-text">${escapeHtml(e.m)}</p>
      </div>
    `;
    updateCounts();
    return;
  }

  const groups = groupRows(rows);
  listEl.innerHTML = groups.map((group) => `
    <div class="notif-group">
      <p class="notif-group-title">${escapeHtml(group.title)}</p>
      <div class="notif-group-items">${group.items.map(rowHtml).join("")}</div>
    </div>
  `).join("");

  updateCounts();
}

async function hydrateUsers(items) {
  const uids = [...new Set(items.map((n) => String(n?.fromUid || "").trim()).filter(Boolean))];
  if (!uids.length) {
    state.users = new Map();
    return;
  }
  const rows = await listUsersPublicByIds(uids, { max: 200 }).catch(() => []);
  const map = new Map();
  rows.forEach((row) => {
    if (!row?.uid) return;
    map.set(String(row.uid), row);
  });
  state.users = map;
}

async function loadNotifications({ silent = false } = {}) {
  if (!state.uid || !listEl) return;
  state.loading = true;
  if (!silent) listEl.innerHTML = `<div class="notif-loading"><span class="spinner"></span>${i18nT("Carico le notifiche…")}</div>`;
  updateCounts();

  try {
    const items = await getMyNotifications(state.uid, { includeRead: true, max: 120 });
    state.items = Array.isArray(items) ? items : [];
    await hydrateUsers(state.items);
    renderList();
  } catch (err) {
    console.error("notifications load error", err);
    listEl.innerHTML = `<div class="notif-empty"><p class="notif-empty-title">${i18nT("Errore")}</p><p class="notif-empty-text">${i18nT("Non riesco a caricare le notifiche. Riprova.")}</p></div>`;
  } finally {
    state.loading = false;
    updateCounts();
  }
}

async function markOneRead(notifId, { silent = false } = {}) {
  const id = String(notifId || "").trim();
  if (!id || !state.uid) return;

  const item = state.items.find((n) => String(n?.id || "") === id);
  if (!item || item.read) return;

  try {
    await markAsRead(state.uid, id);
  } catch (err) {
    if (!silent) {
      console.error("markAsRead error", err);
      toast(i18nT("Non riesco a segnare la notifica come letta."), i18nT("Notifiche"));
    }
    return;
  }

  item.read = true;
  renderList();
}

markAllBtn?.addEventListener("click", async () => {
  if (!state.uid || state.loading) return;
  markAllBtn.disabled = true;
  const old = markAllBtn.innerHTML;
  markAllBtn.textContent = "Aggiorno…";
  try {
    await markAllAsRead(state.uid);
    state.items.forEach((n) => { n.read = true; });
    renderList();
    toast(i18nT("Tutte le notifiche segnate come lette."), i18nT("Notifiche"));
  } catch (err) {
    console.error("markAllAsRead error", err);
    toast(i18nT("Errore nel segnare le notifiche come lette."), i18nT("Notifiche"));
    markAllBtn.innerHTML = old;
  } finally {
    updateCounts();
  }
});

viewBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const next = btn.dataset.view || "all";
    if (state.view === next) return;
    state.view = next;
    applyViewButtons();
    renderList();
  });
});

listEl?.addEventListener("click", async (ev) => {
  const markBtn = ev.target.closest("[data-mark-read]");
  if (markBtn) {
    ev.preventDefault();
    const notifId = markBtn.getAttribute("data-mark-read") || "";
    await markOneRead(notifId);
    return;
  }

  const link = ev.target.closest("[data-open-notif]");
  if (!(link instanceof HTMLAnchorElement)) return;

  if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0) return;
  ev.preventDefault();

  const notifId = link.getAttribute("data-open-notif") || "";
  const notifType = link.getAttribute("data-notif-type") || "unknown";
  const href = link.getAttribute("href") || "/notifications.html";

  await markOneRead(notifId, { silent: true });
  void logEvent("notification_opened", {
    notification_type: notifType,
    destination: href,
  });

  window.location.href = href;
});

initAuthGuard({
  requireAuth: true,
  onReady: async (user) => {
    state.uid = user.uid;
    void setAnalyticsUser(user);

    applyViewButtons();
    await loadNotifications();

    // Chi apre la pagina notifiche ha gia' dichiarato l'interesse: era l'unica
    // pagina della shell dove l'invito ad attivarle non compariva.
    try {
      mountNotificationPermissionBanner({ containerSelector: "main.container", user });
    } catch (_) {}

    if (typeof state.unreadUnsub === "function") {
      state.unreadUnsub();
      state.unreadUnsub = null;
    }
    state.unreadUnsub = trackUnsub(onNotificationsChange(user.uid, () => {
      void loadNotifications({ silent: true });
    }));
  },
});
