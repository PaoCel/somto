// profile-tabs.page.js — Tab Community + Taste per Profile (replica/estensione
// iOS ProfileReviewsSection + ProfileTasteSection). Il vecchio tab "Review"
// (solo recensioni title-level) è stato sostituito dal tab "Community": un
// timeline unificato del contributo dell'utente (recensioni a ogni livello +
// emozioni + post pubblici).
// Funziona affianco a account.page.js che gestisce ancora il tab Visti.

import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { t as i18nT, formatTimeAgo } from "../i18n/index.js";
import { auth } from "../firebase.js";
import { listMyRatingsAnyLevel } from "../api/ratings.api.js";
import { listMyEmotions, EMOTION_META } from "../api/emotions.api.js";
import { listPublicPostsByAuthor } from "../api/posts.api.js";
import { listMyTitleStates } from "../api/titleStates.api.js";
import { getMyUserDoc } from "../api/users.api.js";
import { getTitleById, getTitlesByIds } from "../api/titles.api.js";
import { listGenres } from "../api/genres.api.js";

let currentUid = null;
let communityLoaded = false;
let tasteLoaded = false;
let genreLookup = new Map();

/* ============================= helpers ============================= */
function $(id) { return document.getElementById(id); }
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (v == null) return;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  });
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c == null) return;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  });
  return node;
}
function clearChildren(n) { if (!n) return; while (n.firstChild) n.removeChild(n.firstChild); }

function timestampMs(v) {
  if (!v) return 0;
  if (typeof v?.toMillis === "function") return v.toMillis();
  if (typeof v?.seconds === "number") return (v.seconds * 1000) + Math.floor((v.nanoseconds || 0) / 1e6);
  const d = new Date(v); return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function formatRelativeDate(value) {
  return formatTimeAgo(timestampMs(value), { minUnit: "day", beyondWeek: "relative" });
}

function genreLabel(rawId) {
  if (!rawId) return "";
  const key = String(rawId).startsWith("tmdb_") ? String(rawId).slice(5) : String(rawId);
  return genreLookup.get(key) || (Number.isFinite(Number(rawId)) ? "" : String(rawId));
}

/* ============================= COMMUNITY ============================= */
// Timeline unificato reverse-chronological del contributo dell'utente alla
// community: recensioni (ogni livello title/season/episode), emozioni
// post-visione, post pubblici. Sostituisce il vecchio tab "Review" (solo
// recensioni title-level).

function levelChipLabel(item) {
  if (item.level === "season" && item.season) return i18nT("Stagione {season}", { season: item.season });
  if (item.level === "episode" && item.season && item.episode) return `S${item.season}·E${item.episode}`;
  return null;
}

function truncatedTextBlock(text, { max = 240, bodyClass = "profile-community-body" } = {}) {
  const full = String(text || "").trim();
  const long = full.length > max;
  const initial = long ? full.slice(0, max).trim() + "…" : full;
  const body = el("p", { class: bodyClass }, [initial]);
  let toggleBtn = null;
  if (long) {
    let expanded = false;
    toggleBtn = el("button", {
      class: "profile-community-toggle",
      type: "button",
      onclick: (e) => {
        e.preventDefault();
        expanded = !expanded;
        body.textContent = expanded ? full : initial;
        toggleBtn.textContent = expanded ? i18nT("Mostra meno") : i18nT("Mostra di più");
      },
    }, [i18nT("Mostra di più")]);
  }
  return { body, toggleBtn };
}

function typeChip(type) {
  const labels = { review: "Recensione", emotion: "Emozione", post: i18nT("Post") };
  return el("span", { class: `profile-community-typechip type-${type}` }, [labels[type] || type]);
}

function communityPosterNode(title) {
  const poster = title?.posterPath || title?.backdropPath || null;
  return poster
    ? el("img", { class: "profile-community-poster", src: poster, alt: title.name || "" })
    : el("div", { class: "profile-community-poster placeholder" });
}

function renderReviewItem(item) {
  const title = item.title || {};
  const ratingTxt = Number(item.rating).toFixed(1);
  const ratingBadge = Number.isFinite(Number(item.rating))
    ? el("span", { class: "profile-community-rating" }, [
        el("svg", { viewBox: "0 0 24 24", html: '<polygon points="12 2 15 8.5 22 9.3 17 14 18.2 21 12 17.8 5.8 21 7 14 2 9.3 9 8.5" fill="currentColor"/>' }),
        el("span", {}, [ratingTxt]),
      ])
    : null;

  const lvlChip = levelChipLabel(item);
  const { body, toggleBtn } = truncatedTextBlock(item.reviewText);

  return el("a", { class: "profile-community-card", href: `/title.html?id=${encodeURIComponent(item.titleId)}` }, [
    communityPosterNode(title),
    el("div", { class: "profile-community-main" }, [
      el("div", { class: "profile-community-head" }, [
        typeChip("review"),
        lvlChip ? el("span", { class: "profile-community-levelchip" }, [lvlChip]) : null,
        ratingBadge,
      ]),
      el("h4", { class: "profile-community-title" }, [title.name || item.titleId]),
      el("div", { class: "profile-community-meta" }, [
        title.year ? el("span", {}, [String(title.year)]) : null,
        title.type ? el("span", {}, [title.type === "tv" ? i18nT("Serie") : i18nT("Film")]) : null,
        el("span", {}, [formatRelativeDate(item.timestamp)]),
      ]),
      body,
      toggleBtn,
    ]),
  ]);
}

function renderEmotionItem(item) {
  const title = item.title || {};
  const keys = Array.isArray(item.emotions) ? item.emotions : [];
  const chips = keys.map((k) => {
    const meta = EMOTION_META[k];
    if (!meta) return null;
    return el("span", { class: "profile-community-emotion" }, [
      el("span", { class: "emoji" }, [meta.emoji]),
      el("span", {}, [meta.label]),
    ]);
  }).filter(Boolean);

  return el("a", { class: "profile-community-card", href: `/title.html?id=${encodeURIComponent(item.titleId)}` }, [
    communityPosterNode(title),
    el("div", { class: "profile-community-main" }, [
      el("div", { class: "profile-community-head" }, [typeChip("emotion")]),
      el("h4", { class: "profile-community-title" }, [title.name || item.titleId]),
      el("div", { class: "profile-community-meta" }, [
        title.year ? el("span", {}, [String(title.year)]) : null,
        title.type ? el("span", {}, [title.type === "tv" ? i18nT("Serie") : i18nT("Film")]) : null,
        el("span", {}, [formatRelativeDate(item.timestamp)]),
      ]),
      el("div", { class: "profile-community-emotions" }, chips),
    ]),
  ]);
}

function renderPostItem(item) {
  const title = item.title || {};
  const hasTitle = !!item.titleId;
  const { body, toggleBtn } = truncatedTextBlock(item.text, { max: 200 });

  const inner = [
    hasTitle ? communityPosterNode(title) : el("div", { class: "profile-community-poster placeholder post-icon" }, [
      el("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", html: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' }),
    ]),
    el("div", { class: "profile-community-main" }, [
      el("div", { class: "profile-community-head" }, [
        typeChip("post"),
        hasTitle ? el("span", { class: "profile-community-levelchip" }, [title.name || item.titleId]) : null,
      ]),
      el("div", { class: "profile-community-meta" }, [
        el("span", {}, [formatRelativeDate(item.timestamp)]),
      ]),
      body,
      toggleBtn,
    ]),
  ];

  return hasTitle
    ? el("a", { class: "profile-community-card", href: `/title.html?id=${encodeURIComponent(item.titleId)}` }, inner)
    : el("div", { class: "profile-community-card is-static" }, inner);
}

function renderCommunityItem(item) {
  if (item.type === "review") return renderReviewItem(item);
  if (item.type === "emotion") return renderEmotionItem(item);
  return renderPostItem(item);
}

async function loadCommunity() {
  if (communityLoaded || !currentUid) return;
  communityLoaded = true;

  const root = $("communityList");
  const empty = $("communityEmpty");
  if (!root) return;
  root.innerHTML = `<div class="profile-skeleton">${i18nT("Caricamento community…")}</div>`;

  const [ratings, emotions, posts] = await Promise.all([
    listMyRatingsAnyLevel(currentUid, { max: 300 }).catch(() => []),
    listMyEmotions(currentUid, { max: 300 }).catch(() => []),
    // L'indice composito (authorUid+visibility+createdAt) potrebbe non essere
    // ancora deployato: se manca, Firestore rifiuta la query — trattiamo i
    // post come vuoti e mostriamo comunque review+emozioni.
    listPublicPostsByAuthor(currentUid, { max: 100 }).catch(() => []),
  ]);

  const reviewItems = ratings
    .filter((r) => String(r.reviewText || "").trim().length > 0)
    .map((r) => ({
      type: "review",
      titleId: r.titleId,
      timestamp: r.updatedAt,
      level: r.level,
      season: r.season,
      episode: r.episode,
      rating: r.rating,
      reviewText: r.reviewText,
    }));

  const emotionItems = emotions
    .filter((e) => Array.isArray(e.emotions) && e.emotions.length > 0)
    .map((e) => ({
      type: "emotion",
      titleId: e.titleId,
      timestamp: e.updatedAt,
      emotions: e.emotions,
    }));

  const postItems = posts.map((p) => ({
    type: "post",
    titleId: p.titleId || null,
    timestamp: p.createdAt,
    text: p.text,
  }));

  const merged = [...reviewItems, ...emotionItems, ...postItems]
    .sort((a, b) => timestampMs(b.timestamp) - timestampMs(a.timestamp));

  if (merged.length === 0) {
    clearChildren(root);
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  // Batched read unica per tutti gli id titolo di tutte le fonti (1 query/30
  // id, cache 60s) — vedi getTitlesByIds in titles.api.js.
  const ids = merged.map((it) => it.titleId).filter(Boolean);
  const titlesMap = await getTitlesByIds(ids).catch(() => new Map());
  clearChildren(root);
  merged.forEach((it) => {
    if (it.titleId) it.title = titlesMap.get(it.titleId);
    root.appendChild(renderCommunityItem(it));
  });
}

/* ============================= TASTE ============================= */

function renderTopPickCard(state) {
  const title = state.title || {};
  const poster = title.posterPath || title.backdropPath || null;
  const posterNode = poster
    ? el("img", { class: "profile-taste-poster", src: poster, alt: title.name || "" })
    : el("div", { class: "profile-taste-poster placeholder" });
  const ratingTxt = state.ratingValue ? Number(state.ratingValue).toFixed(1) : null;
  const genres = (title.genres || []).map(genreLabel).filter(Boolean).slice(0, 2).join(", ");

  return el("a", { class: "profile-taste-card", href: `/title.html?id=${encodeURIComponent(state.titleId)}` }, [
    posterNode,
    el("div", { class: "profile-taste-info" }, [
      el("h5", {}, [title.name || state.titleId]),
      genres ? el("span", { class: "profile-taste-genres" }, [genres]) : null,
      ratingTxt
        ? el("span", { class: "profile-taste-rating" }, [
            el("svg", { viewBox: "0 0 24 24", html: '<polygon points="12 2 15 8.5 22 9.3 17 14 18.2 21 12 17.8 5.8 21 7 14 2 9.3 9 8.5" fill="currentColor"/>' }),
            el("span", {}, [ratingTxt]),
          ])
        : null,
    ]),
  ]);
}

function renderRecentPoster(state) {
  const title = state.title || {};
  const poster = title.posterPath || title.backdropPath || null;
  const posterNode = poster
    ? el("img", { class: "profile-recent-poster-img", src: poster, alt: title.name || "" })
    : el("div", { class: "profile-recent-poster-img placeholder" });
  const date = state.lastInteractionAt || state.completedAt || state.ratedAt;
  return el("a", { class: "profile-recent-poster", href: `/title.html?id=${encodeURIComponent(state.titleId)}` }, [
    posterNode,
    el("strong", {}, [title.name || state.titleId]),
    date ? el("small", {}, [formatRelativeDate(date)]) : null,
  ]);
}

async function loadTaste() {
  if (tasteLoaded || !currentUid) return;
  tasteLoaded = true;

  const root = $("tasteContent");
  const empty = $("tasteEmpty");
  if (!root) return;
  root.innerHTML = `<div class="profile-skeleton">${i18nT("Caricamento taste…")}</div>`;

  const [profile, states] = await Promise.all([
    getMyUserDoc(currentUid).catch(() => null),
    listMyTitleStates(currentUid, { max: 500 }).catch(() => []),
  ]);

  const favoriteGenres = Array.isArray(profile?.favoriteGenres) ? profile.favoriteGenres : [];

  // Batched read solo per gli stati senza snapshot (1 query/30 id, cache 60s).
  const idsToFetch = states
    .filter((s) => !s.titleSnapshot?.name)
    .map((s) => s.titleId)
    .filter(Boolean);
  const tasteTitlesMap = idsToFetch.length
    ? await getTitlesByIds(idsToFetch).catch(() => new Map())
    : new Map();
  const enriched = states.map((s) => {
    if (s.titleSnapshot?.name) { s.title = { id: s.titleId, ...s.titleSnapshot }; return s; }
    const t = tasteTitlesMap.get(s.titleId);
    if (t) s.title = t;
    return s;
  });

  const topRated = enriched
    .filter((s) => Number(s.ratingValue || 0) > 0)
    .sort((a, b) => Number(b.ratingValue) - Number(a.ratingValue))
    .slice(0, 4);

  const recent = enriched
    .filter((s) => s.title)
    .sort((a, b) => Number(b._sortTime || 0) - Number(a._sortTime || 0))
    .slice(0, 6);

  const allEmpty = favoriteGenres.length === 0 && topRated.length === 0 && recent.length === 0;
  if (allEmpty) {
    clearChildren(root);
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  clearChildren(root);

  if (favoriteGenres.length > 0) {
    const section = el("section", { class: "profile-taste-section" }, [
      el("h3", {}, [i18nT("Generi chiave")]),
      el("div", { class: "profile-taste-chips" },
        favoriteGenres.map((g) => el("span", { class: "profile-taste-chip" }, [genreLabel(g) || g]))),
    ]);
    root.appendChild(section);
  }

  if (topRated.length > 0) {
    const grid = el("div", { class: "profile-taste-grid" }, topRated.map(renderTopPickCard));
    const section = el("section", { class: "profile-taste-section" }, [
      el("h3", {}, [i18nT("Top pick")]),
      grid,
    ]);
    root.appendChild(section);
  }

  if (recent.length > 0) {
    const scroll = el("div", { class: "profile-recent-scroll" }, recent.map(renderRecentPoster));
    const section = el("section", { class: "profile-taste-section" }, [
      el("h3", {}, [i18nT("Visti di recente")]),
      scroll,
    ]);
    root.appendChild(section);
  }
}

/* ============================= Tab switching ============================= */

function activateProfileTab(name) {
  const tabs = [
    { key: "votes", btn: $("tabMyVotes"), panel: $("panelVotes") },
    { key: "community", btn: $("tabCommunity"), panel: $("panelCommunity") },
    { key: "taste", btn: $("tabTaste"), panel: $("panelTaste") },
  ];
  tabs.forEach((t) => {
    if (!t.btn || !t.panel) return;
    const active = t.key === name;
    t.btn.classList.toggle("active", active);
    t.btn.setAttribute("aria-selected", active ? "true" : "false");
    t.panel.style.display = active ? "" : "none";
    t.panel.classList.toggle("active", active);
  });
  if (name === "community") loadCommunity();
  if (name === "taste") loadTaste();
}

function bind() {
  $("tabCommunity")?.addEventListener("click", () => activateProfileTab("community"));
  $("tabTaste")?.addEventListener("click", () => activateProfileTab("taste"));
  $("tabMyVotes")?.addEventListener("click", () => activateProfileTab("votes"));
}

async function loadGenres() {
  try {
    const list = await listGenres(400);
    list.forEach((g) => {
      const id = String(g.id || g.tmdbId || "").replace(/^tmdb_/, "");
      genreLookup.set(id, String(g.name || g.label || ""));
    });
  } catch (_) { /* noop */ }
}

function init() {
  bind();
  onAuthStateChanged(auth, async (user) => {
    if (!user?.uid) return;
    currentUid = user.uid;
    await loadGenres();
    // Carica community/taste lazy quando si attiva il tab.
    // Deep-link via ?tab=community / ?tab=taste
    const params = new URLSearchParams(window.location.search || "");
    const tab = String(params.get("tab") || "").toLowerCase();
    if (tab === "community" || tab === "taste") activateProfileTab(tab);
  });
}

init();
