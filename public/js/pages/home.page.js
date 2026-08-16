// home.page.js - Home = launchpad personale (hero suggerimento + righe discovery).
// Il feed sociale + composer sono stati spostati su community.page.js
// (community-nav, vedi CLAUDE.md). Questo file mantiene solo: onboarding nuovo
// utente, disclaimer "progetto giovane", badge/dropdown notifiche (stessa UX
// pre-esistente), hero suggerimento personale, e le 3 righe discovery
// (blog / tendenze / novità) — prima erano l'empty-state del feed, ora sono il
// contenuto primario della Home.

import { initAuthGuard } from "../components/authGuard.js";
import { t as i18nT } from "../i18n/index.js";
import { initTabbar } from "../utils/tabbar.js";
import { ensureUserDoc, getUserPublic } from "../api/users.api.js";
import { listMyLibrary } from "../api/library.api.js";
import { listMyTitleRatings } from "../api/ratings.api.js";
import { listMyTitleStates } from "../api/titleStates.api.js";
import { getTitlesByIds, listPopularTitles, listRecentApprovedTitles, listTitlesByTmdbIds } from "../api/titles.api.js";
import { fetchTrendingTitles, getTmdbImageUrl } from "../api/tmdb.api.js";
import { listRecentBlogPosts } from "../api/blogPosts.api.js";
import { listRecommendationsForMe } from "../api/recommendations.api.js";
import { getMatchQueue } from "../api/match.api.js";
import { getUnreadCount, onNotificationsChange, getMyNotifications, markAsRead, markAllAsRead } from "../api/notifications.api.js";
import { mountNotificationPermissionBanner } from "../components/notifyPermissionBanner.js";
import { mountDismissBanner } from "../components/dismissBanner.js";
import { getActiveImport, getLastCompletedImport } from "../api/imports.api.js";
import { initOnboardingV2 } from "../components/onboardingV2.js";
import { toast } from "../components/toast.js";
import { qs, escapeHtml } from "../utils/dom.js";
import { runWithButtonLoading } from "../utils/loading.js";
import { logEvent, setAnalyticsUser } from "../analytics.js";
import { getPostCommentCount } from "../api/posts.api.js";

initTabbar();

// ==============================
// DOM
// ==============================

const btnReload = qs("#btnReload");
const homeHeroEl = qs("#homeHero");

const notificationLink = qs("#notificationLink");
const notificationBadge = qs("#notificationBadge");
const notificationDropdown = qs("#notificationDropdown");
const notificationDropdownList = qs("#notificationDropdownList");
const notifMarkAll = qs("#notifMarkAll");

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

const state = {
  me: null,
  userMap: new Map(),
  titleMap: new Map(),
};

function timeText(ts) {
  const ms = (() => {
    if (!ts) return 0;
    if (typeof ts === "number") return ts;
    try {
      if (typeof ts.toMillis === "function") return ts.toMillis();
      if (ts.seconds) return (ts.seconds * 1000) + Math.floor((ts.nanoseconds || 0) / 1e6);
    } catch (_) {}
    return 0;
  })();
  if (!ms) return "";
  try {
    const d = new Date(ms);
    return d.toLocaleString("it-IT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function initials(name) {
  const s = String(name || "").trim();
  if (!s) return "?";
  const parts = s.split(/\s+/).filter(Boolean);
  const a = (parts[0] || "?").slice(0, 1);
  const b = parts.length > 1 ? (parts[parts.length - 1] || "").slice(0, 1) : "";
  return (a + b).toUpperCase();
}

async function ensureUsersCached(uids) {
  await Promise.all((uids || []).map(async uid => {
    if (!uid || state.userMap.has(uid)) return;
    const u = await getUserPublic(uid).catch(() => null);
    if (u) state.userMap.set(uid, u);
  }));
}

// ==============================
// Notifiche badge + dropdown
// (invariato rispetto a prima: stessa UX, nessun DOM su home.html oggi —
// appShell.js gestisce già il badge globale nell'header; questo cluster resta
// qui pronto se in futuro home.html monta di nuovo un link/dropdown dedicato.)
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
  notificationDropdownList.innerHTML = `<div class="hint">Caricamento…</div>`;

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
        title = i18nT("{fromName} ha scritto nel thread", { fromName });
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
// Hero suggerimento personale
// ==============================

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

function renderHeroCard(t) {
  if (!homeHeroEl) return;
  if (!t) { homeHeroEl.innerHTML = ""; return; }
  const poster = t.posterPath || t.backdropPath || "";
  const subtype = t.type === "tv" ? i18nT("Serie") : i18nT("Film");
  const year = t.year ? ` · ${t.year}` : "";
  homeHeroEl.innerHTML = `
    <a class="home-hero-card" href="/title.html?id=${encodeURIComponent(t.id)}">
      ${poster
        ? `<img class="home-hero-poster" src="${escapeHtml(poster)}" alt="${escapeHtml(t.name || "")}" loading="lazy">`
        : `<div class="home-hero-poster placeholder"></div>`}
      <div class="home-hero-body">
        <span class="home-hero-eyebrow">${i18nT("Suggerito per te")}</span>
        <h2 class="home-hero-title">${escapeHtml(t.name || "")}</h2>
        <span class="home-hero-meta">${subtype}${year}</span>
        <span class="home-hero-cta">${i18nT("Vai al titolo")} &rsaquo;</span>
      </div>
    </a>
  `;
}

// ==============================
// Righe discovery (blog / tendenze / novità)
// ==============================

// Fallback statici (articoli Eleventy esistenti in public/blog/*/) usato quando
// il collection Firestore blogPosts è ancora vuoto.
const FALLBACK_BLOG_POSTS = [
  { slug: "come-organizzare-watchlist-film-serie-tv", title: i18nT("Come organizzare la watchlist di film e serie TV"), excerpt: i18nT("Metodo concreto per organizzare la watchlist e usarla davvero."), href: "/blog/come-organizzare-watchlist-film-serie-tv/" },
  { slug: "migliori-app-tenere-traccia-film-serie-tv", title: i18nT("Le migliori app per tenere traccia di film e serie TV"), excerpt: i18nT("Confronto delle app più usate per organizzare cosa hai visto."), href: "/blog/migliori-app-tenere-traccia-film-serie-tv/" },
  { slug: "migliori-serie-tv-2026", title: i18nT("Le migliori serie TV del 2026"), excerpt: i18nT("Le serie più discusse e premiate dell'anno."), href: "/blog/migliori-serie-tv-2026/" },
  { slug: "cosa-guardare-su-netflix-italia", title: i18nT("Cosa guardare su Netflix in Italia"), excerpt: i18nT("Guida ai titoli più popolari del catalogo italiano."), href: "/blog/cosa-guardare-su-netflix-italia/" },
];

function renderTitlePoster(t) {
  const poster = t.posterPath || t.backdropPath || "";
  const subtype = t.type === "tv" ? i18nT("Serie") : i18nT("Film");
  const year = t.year ? ` · ${t.year}` : "";
  return `
    <a class="home-disc-card" href="/title.html?id=${encodeURIComponent(t.id)}" data-discovery="title">
      ${poster
        ? `<img class="home-disc-poster" src="${escapeHtml(poster)}" alt="${escapeHtml(t.name || "")}" loading="lazy">`
        : `<div class="home-disc-poster placeholder"></div>`}
      <strong class="home-disc-title">${escapeHtml(t.name || "")}</strong>
      <small class="home-disc-meta">${subtype}${year}</small>
    </a>
  `;
}

/**
 * Tile per una tendenza TMDB: se il titolo è già a catalogo usa la tile
 * normale (link diretto alla scheda), altrimenti manda al flusso
 * import-on-tap della ricerca (`?tmdbOpen=`), che crea il titolo e apre
 * la scheda — stesso percorso già collaudato dei risultati TMDB in search.
 */
function renderTrendingPoster(item, localTitle) {
  if (localTitle) return renderTitlePoster(localTitle);
  const poster = item.posterPath ? getTmdbImageUrl(item.posterPath, "w342") : "";
  const subtype = item.mediaType === "tv" ? i18nT("Serie") : i18nT("Film");
  const year = item.year ? ` · ${item.year}` : "";
  const href = `/search.html?tmdbOpen=${encodeURIComponent(`${item.mediaType}:${item.tmdbId}`)}` +
    `&title=${encodeURIComponent(item.name)}` +
    (item.year ? `&year=${encodeURIComponent(item.year)}` : "");
  return `
    <a class="home-disc-card" href="${href}" data-discovery="title">
      ${poster
        ? `<img class="home-disc-poster" src="${escapeHtml(poster)}" alt="${escapeHtml(item.name || "")}" loading="lazy">`
        : `<div class="home-disc-poster placeholder"></div>`}
      <strong class="home-disc-title">${escapeHtml(item.name || "")}</strong>
      <small class="home-disc-meta">${subtype}${year}</small>
    </a>
  `;
}

/**
 * Etichetta compatta "a che punto è" per una serie in corso, specchio di
 * `TitleSeriesProgress.progressBadgeLabel(state:)` (iOS): S{stagione}·E{episodio}
 * → fallback {percent}% → fallback "Riprendi" se non c'è nessun dato pulito
 * (mai numeri inventati).
 */
function resumeProgressLabel(stateRow) {
  const sp = stateRow?.seriesProgress;
  if (sp) {
    const season = Number(sp.lastWatchedSeasonNumber);
    const episode = Number(sp.lastWatchedEpisodeNumber);
    if (Number.isFinite(season) && season > 0 && Number.isFinite(episode) && episode > 0) {
      return `S${season}·E${episode}`;
    }
    const percent = Number(sp.percentComplete);
    if (Number.isFinite(percent) && percent > 0) {
      const clamped = Math.max(0, Math.min(1, percent));
      return `${Math.round(clamped * 100)}%`;
    }
    if (Number.isFinite(season) && season > 0) {
      return `S${season}`;
    }
  }
  return i18nT("Riprendi");
}

function renderContinueWatchingCard(t, stateRow) {
  const poster = t.posterPath || t.backdropPath || "";
  const label = resumeProgressLabel(stateRow);
  return `
    <a class="home-disc-card" href="/title.html?id=${encodeURIComponent(t.id)}" data-discovery="continue">
      <div class="home-disc-poster-wrap">
        ${poster
          ? `<img class="home-disc-poster" src="${escapeHtml(poster)}" alt="${escapeHtml(t.name || "")}" loading="lazy">`
          : `<div class="home-disc-poster placeholder"></div>`}
        <span class="home-disc-progress-badge">${escapeHtml(label)}</span>
      </div>
      <strong class="home-disc-title">${escapeHtml(t.name || "")}</strong>
    </a>
  `;
}

function renderNewContentCard(t) {
  const poster = t.posterPath || t.backdropPath || "";
  return `
    <a class="home-disc-card" href="/title.html?id=${encodeURIComponent(t.id)}" data-discovery="new-content">
      <div class="home-disc-poster-wrap">
        ${poster
          ? `<img class="home-disc-poster" src="${escapeHtml(poster)}" alt="${escapeHtml(t.name || "")}" loading="lazy">`
          : `<div class="home-disc-poster placeholder"></div>`}
        <span class="home-disc-new-badge">Nuovi episodi</span>
      </div>
      <strong class="home-disc-title">${escapeHtml(t.name || "")}</strong>
    </a>
  `;
}

function upcomingDateLabel(value) {
  const date = new Date(String(value || ""));
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleDateString("it-IT", { day: "numeric", month: "long" });
}

function upcomingOccasionLabel(item) {
  if (item?.occasion === "season_premiere") {
    if (Number(item.season) === 1) return i18nT("Nuova serie");
    if (Number(item.season) > 1) return i18nT("Stagione {n}", { n: Number(item.season) });
    return i18nT("Nuova stagione");
  }
  if (item?.releaseKind === "cinema") return i18nT("Al cinema");
  if (item?.releaseKind === "streaming") return i18nT("In streaming");
  if (item?.releaseKind === "tv") return i18nT("In TV");
  return item?.type === "tv" ? i18nT("Serie") : i18nT("Film");
}

async function loadUpcomingReleases() {
  const response = await fetch("/prossime-uscite.json", { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`upcoming releases ${response.status}`);
  const payload = await response.json();
  return Array.isArray(payload?.items) ? payload.items.slice(0, 10) : [];
}

async function renderUpcomingReleases(items) {
  const section = document.getElementById("homeUpcomingSection");
  const scroll = document.getElementById("homeUpcomingScroll");
  if (!section || !scroll) return;
  if (!items.length) {
    scroll.innerHTML = "";
    section.style.display = "none";
    return;
  }

  const counts = await Promise.all(items.map((item) => (
    item?.postId
      ? getPostCommentCount(item.postId).catch(() => 0)
      : Promise.resolve(0)
  )));
  scroll.innerHTML = items.map((item, index) => {
    const poster = item.posterUrl
      ? `<img class="home-upcoming-poster" src="${escapeHtml(item.posterUrl)}" alt="${escapeHtml(item.name || "")}" loading="lazy">`
      : `<div class="home-upcoming-poster placeholder"></div>`;
    const comments = Math.max(0, Number(counts[index] || 0));
    const conversation = comments > 0
      ? i18nT("{count} commenti", { count: comments })
      : i18nT("Commenta");
    const postHref = item.postId
      ? `/community.html?post=${encodeURIComponent(item.postId)}`
      : String(item.path || "/community.html");
    const provider = item.provider?.name
      ? `<small class="home-upcoming-provider">${escapeHtml(item.provider.name)}</small>`
      : "";
    return `
      <article class="home-upcoming-card">
        <a class="home-upcoming-main" href="${escapeHtml(item.path || "#")}">
          ${poster}
          <span class="home-upcoming-body">
            <small class="home-upcoming-date">${escapeHtml(upcomingDateLabel(item.releaseDate))}</small>
            <strong>${escapeHtml(item.name || "")}</strong>
            <small>${escapeHtml(upcomingOccasionLabel(item))}</small>
            ${provider}
          </span>
        </a>
        <a class="home-upcoming-conversation" href="${escapeHtml(postHref)}">
          <span aria-hidden="true">💬</span>${escapeHtml(conversation)}<span aria-hidden="true">›</span>
        </a>
      </article>`;
  }).join("");
  section.style.display = "";
}

function renderBlogCard(post) {
  const href = post.href || `/blog/post.html?slug=${encodeURIComponent(post.slug)}`;
  const cover = post.coverImage ? `<img class="home-blog-cover" src="${escapeHtml(post.coverImage)}" alt="" loading="lazy">` : `<div class="home-blog-cover placeholder"></div>`;
  return `
    <a class="home-blog-card" href="${escapeHtml(href)}" data-discovery="blog">
      ${cover}
      <div class="home-blog-meta">
        <strong>${escapeHtml(post.title || "")}</strong>
        ${post.excerpt ? `<p>${escapeHtml(post.excerpt)}</p>` : ""}
      </div>
    </a>
  `;
}

// ==============================
// Home content loader (hero + discovery) — ex renderEmpty(), ora contenuto
// primario della Home invece che empty-state del feed.
// ==============================

/**
 * Continua a guardare: serie TV in corso (state === "in_progress"), più
 * recentemente toccate prima. `listMyTitleStates` ordina già per
 * `lastInteractionAt desc` (con fallback `_sortTime` se manca l'indice),
 * quindi qui basta filtrare e cappare.
 */
function pickContinueWatchingRows(states) {
  return states
    .filter((s) => s.mediaType === "tv" && s.state === "in_progress")
    .slice(0, 12);
}

/**
 * Novità per te: titoli (di qualunque tipo seguito/visto) con nuovi episodi/
 * stagioni rispetto all'ultimo completamento registrato dall'utente —
 * stesso segnale server-side di `canResumeFromNewContent`
 * (watchlistDashboard.api.js): `hasNewContent === true` su una serie che
 * l'utente ha già completato (`completed_unrated`/`rated`).
 */
function pickNewContentRows(states) {
  return states
    .filter((s) => s.mediaType === "tv" && s.hasNewContent === true && (s.state === "completed_unrated" || s.state === "rated"))
    .slice(0, 12);
}

async function renderHome(myUid) {
  try {
    const [suggestion, blogPosts, popular, recent, myStates, trending, matchPayload, upcoming] = await Promise.all([
      myUid ? getSuggestionForMe(myUid).catch(() => null) : Promise.resolve(null),
      listRecentBlogPosts(4).catch(() => []),
      listPopularTitles(10).catch(() => []),
      listRecentApprovedTitles(10).catch(() => []),
      myUid ? listMyTitleStates(myUid, { max: 250 }).catch(() => []) : Promise.resolve([]),
      fetchTrendingTitles().catch(() => []),
      myUid ? getMatchQueue({ max: 18, fastStart: true }).catch(() => null) : Promise.resolve(null),
      loadUpcomingReleases().catch(() => []),
    ]);

    if (suggestion) state.titleMap.set(suggestion.id, suggestion);
    renderHeroCard(suggestion);
    await renderUpcomingReleases(upcoming);

    // ── Continua a guardare + Novità per te: una sola listMyTitleStates,
    //    due filtri, un solo getTitlesByIds per entrambe le sezioni.
    const continueRows = pickContinueWatchingRows(myStates);
    const newContentRows = pickNewContentRows(myStates);
    const personalTileIds = [...new Set([
      ...continueRows.map((s) => s.titleId),
      ...newContentRows.map((s) => s.titleId),
    ].filter(Boolean))];
    const personalTitleMap = personalTileIds.length
      ? await getTitlesByIds(personalTileIds).catch(() => new Map())
      : new Map();
    for (const [id, t] of personalTitleMap) state.titleMap.set(id, t);

    const continueSection = document.getElementById("homeContinueSection");
    const continueScroll = document.getElementById("homeContinueScroll");
    const continueCards = continueRows
      .map((s) => {
        const t = personalTitleMap.get(s.titleId);
        return t ? renderContinueWatchingCard(t, s) : "";
      })
      .filter(Boolean);
    if (continueSection && continueScroll) {
      if (continueCards.length) {
        continueScroll.innerHTML = continueCards.join("");
        continueSection.style.display = "";
      } else {
        continueScroll.innerHTML = "";
        continueSection.style.display = "none";
      }
    }

    const newContentSection = document.getElementById("homeNewContentSection");
    const newContentScroll = document.getElementById("homeNewContentScroll");
    const newContentCards = newContentRows
      .map((s) => {
        const t = personalTitleMap.get(s.titleId);
        return t ? renderNewContentCard(t) : "";
      })
      .filter(Boolean);
    if (newContentSection && newContentScroll) {
      if (newContentCards.length) {
        newContentScroll.innerHTML = newContentCards.join("");
        newContentSection.style.display = "";
      } else {
        newContentScroll.innerHTML = "";
        newContentSection.style.display = "none";
      }
    }

    // Affinità piattaforma: inferenza prudente da almeno due titoli-seed. Non
    // equivale a dichiarare che l'utente possieda un abbonamento.
    const providerSection = document.getElementById("homeProviderSection");
    const providerScroll = document.getElementById("homeProviderScroll");
    const providerTitle = document.getElementById("homeProviderTitle");
    const providerLane = matchPayload?.providerLane || null;
    if (providerSection && providerScroll && providerTitle) {
      if (providerLane?.providerName && providerLane.items?.length) {
        providerTitle.textContent = i18nT("Potrebbe piacerti su {provider}", { provider: providerLane.providerName });
        providerScroll.innerHTML = providerLane.items.map(renderTitlePoster).join("");
        providerSection.style.display = "";
      } else {
        providerTitle.textContent = "";
        providerScroll.innerHTML = "";
        providerSection.style.display = "none";
      }
    }

    const blogScroll = document.getElementById("discBlogScroll");
    const blogList = blogPosts.length ? blogPosts : FALLBACK_BLOG_POSTS;
    if (blogScroll) blogScroll.innerHTML = blogList.map(renderBlogCard).join("");

    // Tendenze REALI (TMDB, settimana corrente): i titoli già a catalogo
    // linkano la scheda, gli altri passano dal flusso import-on-tap della
    // ricerca. Se l'azione trending non è ancora deployata (lista vuota),
    // fallback ai popolari interni come prima.
    const trendingScroll = document.getElementById("discTrendingScroll");
    if (trendingScroll) {
      if (trending.length) {
        const localByTmdbId = await listTitlesByTmdbIds(trending.map((x) => x.tmdbId)).catch(() => new Map());
        for (const t of localByTmdbId.values()) state.titleMap.set(t.id, t);
        trendingScroll.innerHTML = trending
          .slice(0, 12)
          .map((item) => renderTrendingPoster(item, localByTmdbId.get(item.tmdbId)))
          .join("");
      } else if (popular.length === 0) {
        document.getElementById("discTrendingSection")?.remove();
      } else {
        trendingScroll.innerHTML = popular.map(renderTitlePoster).join("");
      }
    }

    const freshScroll = document.getElementById("discFreshScroll");
    if (freshScroll) {
      if (recent.length === 0) { document.getElementById("discFreshSection")?.remove(); }
      else freshScroll.innerHTML = recent.map(renderTitlePoster).join("");
    }
  } catch (err) {
    console.warn("renderHome discovery sections failed", err);
  }
}

/** Suggerimento installazione PWA per Android LOGGATO in browser: prima del
 * login lo mostrano landing/login.page, ma chi entra e resta nel browser non
 * lo incontrava più. Stessa storageKey delle altre pagine: un dismiss vale
 * ovunque. Skip se l'app è già installata (display-mode standalone). */
function maybeShowAndroidInstallBanner() {
  try {
    if (!/Android/i.test(navigator.userAgent)) return;
    if (window.matchMedia?.("(display-mode: standalone)")?.matches) return;
    mountDismissBanner({
      id: "androidNoticeBanner",
      storageKey: "somto_android_notice_v2",
      icon: "🤖",
      text: i18nT("Usa Somto come un'app: apri il menu ⋮ di Chrome e tocca «Aggiungi a schermata Home» (o «Installa app»). Un attimo e ce l'hai tra le tue app."),
      containerSelector: "main.container",
    });
  } catch (err) {
    console.warn("android install banner mount error", err);
  }
}

/**
 * Stato dell'import in Home (docs/ONBOARDING_V2.md, fase 6).
 *
 * Il momento in cui si perdono gli utenti che arrivano da TV Time/Trakt non e'
 * l'onboarding: e' l'attesa dopo. Chi importa esce dal funnel e trova una Home
 * che non gli dice niente, mentre il job macina. Qui gli si dice.
 *
 * Due stati, mai insieme: import in corso, oppure il reveal una-tantum di un
 * import appena finito. La push di fine import esiste gia' lato server
 * (`titles_import_completed`): questo e' il corrispettivo per chi l'app ce
 * l'ha aperta o non ha dato il permesso.
 */
async function maybeShowImportStatus(uid) {
  if (!uid) return;
  try {
    const active = await getActiveImport(uid).catch(() => null);
    if (active && ["queued", "matching", "uploading"].includes(active.status)) {
      mountDismissBanner({
        id: "importRunningBanner",
        storageKey: `somto_import_running_${active.id}`,
        icon: "⏳",
        title: i18nT("Stiamo importando la tua cronologia"),
        text: i18nT("Ci pensiamo noi: ti avvisiamo appena la tua libreria è pronta."),
        ctaLabel: i18nT("Vedi"),
        ctaHref: `/import.html?id=${encodeURIComponent(active.id)}`,
        containerSelector: "main.container",
      });
      return;
    }

    // Nessun import in corso: se l'ultimo e' finito e non l'ha ancora visto,
    // il reveal. La chiave e' per importId, quindi vale una volta sola.
    const done = await getLastCompletedImport(uid).catch(() => null);
    if (!done) return;
    const matched = Number(done.matchedCount || 0);
    if (!matched) return;

    mountDismissBanner({
      id: "importDoneBanner",
      storageKey: `somto_import_done_${done.id}`,
      icon: "🎉",
      title: i18nT("La tua libreria è pronta"),
      text: i18nT("{n} titoli sono nei tuoi Visti.", { n: matched }),
      ctaLabel: i18nT("Guarda"),
      ctaHref: "/account.html?tab=watched",
      containerSelector: "main.container",
    });
  } catch (err) {
    console.warn("import status banner error", err);
  }
}

/** Disclaimer "progetto giovane": non invadente, solo loggati. La card nudge
 * dell'onboarding v1 non esiste piu' (docs/ONBOARDING_V2.md), quindi non c'e'
 * piu' niente con cui accavallarsi. */
function maybeShowYoungProjectBanner() {
  try {
    const uid = state.me?.uid;
    mountDismissBanner({
      id: "youngProjectBanner",
      storageKey: "somto_young_banner_v1",
      icon: "🚀",
      text: i18nT("Somto è giovane e ambizioso. Qualcosa può ancora incepparsi: noi sistemiamo in fretta. Se trovi un bug, scrivici in chat: ti rispondiamo direttamente lì."),
      ctaLabel: i18nT("Segnala"),
      ctaHref: uid ? `/thread.html?id=support_${encodeURIComponent(uid)}` : "/support.html",
      containerSelector: "main.container",
    });
  } catch (err) {
    console.warn("young project banner mount error", err);
  }
}

// ==============================
// INIT
// ==============================

initAuthGuard({ requireAuth: true, onReady: async (user) => {
  state.me = user;
  void setAnalyticsUser(user);

  await ensureUserDoc(user).catch(() => {});
  try {
    await initOnboardingV2({
      uid: user.uid,
      onCompleted: async () => {
        await renderHome(user.uid).catch(() => {});
      },
    });
  } catch (err) {
    console.warn("onboarding init error (home)", err);
  }

  // Prima dei banner generici: se c'e' un import in ballo e' l'unica cosa
  // che l'utente vuole sapere.
  await maybeShowImportStatus(user.uid);
  maybeShowAndroidInstallBanner();
  maybeShowYoungProjectBanner();

  const u = await getUserPublic(user.uid).catch(() => null);
  if (u) state.userMap.set(user.uid, u);

  // notifiche (badge/dropdown — vedi nota sopra su initNotificationsBadge)
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

  await renderHome(user.uid);
  btnReload?.addEventListener("click", () => renderHome(user.uid));

  try { mountNotificationPermissionBanner({ containerSelector: "main.container", user }); } catch (_) {}
}});
