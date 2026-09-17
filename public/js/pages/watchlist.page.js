// watchlist.page.js — Watchlist vNext: una schermata sola, niente sotto-tab.
//
// Struttura (spec C, approvata 2026-08-04):
//   home  → cerca + scaffali per intenzione + "Tutta la watchlist" + le tue liste
//   all   → griglia poster di tutta la coda, con chip filtro e ordinamento
//   lists → le mie liste / condivise con me / liste salvate, con visibilità
//
// Le liste si aprono su /lista.html (dettaglio esistente); creazione e modifica
// restano in lists-editor.page.js. Data layer invariato: watchlistDashboard.api.

import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { t as i18nT } from "../i18n/index.js";
import { auth } from "../firebase.js";

import {
  fetchWatchlistDashboard,
  seriesProgressLabel,
  seriesProgressRatio,
} from "../api/watchlistDashboard.api.js";
import { listRecommendationsForMe } from "../api/recommendations.api.js";
import { getTitlesByIds } from "../api/titles.api.js";
import { markTitleCompleted } from "../api/titleStates.api.js";
import { removeFromWatchlist } from "../api/watchlist.api.js";
import { openListEditor } from "./lists-editor.page.js?v=78-2026-08-04-watchlist-vnext";
import { toast } from "../components/toast.js";
import { runWithButtonLoading } from "../utils/loading.js";
import { logEvent } from "../analytics.js";
import { trackProductEvent } from "../api/productAnalytics.js";

/* ============================== costanti ============================== */

// "Corto" = sotto le 2 ore per i film, serie fino a 2 stagioni. Stessa soglia
// per la chip "Sotto 2h" e per lo scaffale "Stasera ci sta".
const SHORT_MOVIE_MINUTES = 120;
const SHORT_SERIES_SEASONS = 2;
const SHELF_MAX = 12;

const VISIBILITY = {
  private: { label: i18nT("Privata"), icon: "lock" },
  shared: { label: i18nT("Con amici"), icon: "users" },
  public: { label: i18nT("Pubblica"), icon: "globe" },
};

/* ================================ stato ================================ */

let currentUid = null;
let dashboard = null;
let recommended = [];
let filter = "all";     // all | movie | tv | short | prov:<nome> | list:<id>
let sort = "recent";    // recent | az | short | rating
let query = "";
// La coda intera spingeva le liste fuori schermo: si parte da un blocco e si
// espande su richiesta. Stessa soglia di iOS.
const QUEUE_PREVIEW_LIMIT = 12;
let showsAllQueue = false;
// nome piattaforma -> logoUrl, unione su tutti i titoli caricati (copertura
// graduale di titles.watchProviderLogos). Fallback sempre sul testo.
const providerLogos = new Map();

/* =============================== helper =============================== */

const $ = (id) => document.getElementById(id);
const root = () => $("wlRoot");

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (v == null) return;
    if (k === "class") node.className = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  });
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c == null || c === false) return;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  });
  return node;
}

function icon(path, size = 18) {
  const span = el("span", { class: "wlv-svg" });
  span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  return span;
}
function iconFilled(path, size = 18) {
  const span = el("span", { class: "wlv-svg" });
  span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true">${path}</svg>`;
  return span;
}

const I = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.2 1.9"/>',
  resume: '<path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 9 8 9"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h10M18 18h2"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
  back: '<polyline points="15 6 9 12 15 18"/>',
  chev: '<polyline points="9 6 15 12 9 18"/>',
  chevDown: '<polyline points="6 9 12 15 18 9"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"/>',
  route: '<circle cx="6" cy="6" r="2.4"/><circle cx="18" cy="18" r="2.4"/><path d="M8.4 6H15a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h6.6"/>',
  tv: '<rect x="2.5" y="6" width="19" height="12.5" rx="2.5"/><path d="m8 3 4 3 4-3"/>',
};
const IF = {
  star: '<path d="m12 1.5 2.4 5.4 5.6.7-4.2 4 1.1 5.6L12 14.5 7.1 17.2l1.1-5.6L4 7.6l5.6-.7L12 1.5Z"/>',
  bookmark: '<path d="M6.5 2.6h11A1.9 1.9 0 0 1 19.4 4.5v16.1c0 .8-.9 1.3-1.6.9L12 18.1l-5.8 3.4c-.7.4-1.6-.1-1.6-.9V4.5A1.9 1.9 0 0 1 6.5 2.6Z"/>',
  users: '<path d="M16 14c2.2 0 4-1.8 4-4s-1.8-4-4-4-4 1.8-4 4 1.8 4 4 4Zm-8 0c2.2 0 4-1.8 4-4S10.2 6 8 6 4 7.8 4 10s1.8 4 4 4Zm0 2c-2.7 0-8 1.3-8 4v2h16v-2c0-2.7-5.3-4-8-4Zm8 0c-.3 0-.7 0-1.1.1 1.3 1 2.1 2.3 2.1 3.9v2h7v-2c0-2.7-5.3-4-8-4Z"/>',
  more: '<circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/>',
};
const VIS_ICON = { lock: I.lock, users: I.folder, globe: I.globe };

/* ---------- lettura sicura dei campi titolo ---------- */

const titleOf = (state) => state?.title || {};
const posterUrl = (state) => titleOf(state).posterPath || titleOf(state).posterURL || null;

function durationMinutes(state) {
  const n = Number((titleOf(state).metadata || {}).durationMovie || 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function seasonsCount(state) {
  const n = Number((titleOf(state).metadata || {}).seasonsCount || 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function isShort(state) {
  if (state.mediaType === "tv") {
    const s = seasonsCount(state);
    return s != null && s <= SHORT_SERIES_SEASONS;
  }
  const d = durationMinutes(state);
  return d != null && d < SHORT_MOVIE_MINUTES;
}
function fmtMinutes(m) {
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return h > 0 ? `${h}h ${String(rest).padStart(2, "0")}m` : `${rest}m`;
}
function shortLabel(state) {
  if (state.mediaType === "tv") {
    const s = seasonsCount(state);
    return s ? i18nT("{count} stag.", { count: s }) : null;
  }
  const d = durationMinutes(state);
  return d ? fmtMinutes(d) : null;
}
function metaLine(state) {
  const t = titleOf(state);
  const parts = [];
  if (t.year) parts.push(String(t.year));
  if (state.mediaType === "tv") {
    const s = seasonsCount(state);
    if (s) parts.push(i18nT("{count} stagioni", { count: s }));
  } else {
    const d = durationMinutes(state);
    if (d) parts.push(fmtMinutes(d));
  }
  return parts.join(" · ");
}
function providersOf(state) {
  const logos = titleOf(state).watchProviderLogos;
  if (Array.isArray(logos) && logos.length) return logos.filter((p) => p?.name);
  const names = titleOf(state).watchProviderNames;
  if (Array.isArray(names)) return names.filter(Boolean).map((n) => ({ name: n, logoUrl: providerLogos.get(n) || null }));
  return [];
}
function firstProvider(state) {
  const p = providersOf(state)[0];
  if (!p) return null;
  return { name: p.name, logoUrl: p.logoUrl || providerLogos.get(p.name) || null };
}
function collectProviderLogos(states) {
  states.forEach((s) => {
    const logos = titleOf(s).watchProviderLogos;
    if (!Array.isArray(logos)) return;
    logos.forEach((p) => { if (p?.name && p?.logoUrl && !providerLogos.has(p.name)) providerLogos.set(p.name, p.logoUrl); });
  });
}

const titleHref = (state) => `/title.html?id=${encodeURIComponent(state.titleId)}`;
const listHref = (list) => `/lista.html?id=${encodeURIComponent(list.id)}`;

/* ============================ selezione dati ============================ */

const queue = () => (dashboard?.generalWatchlist || []);
const myLists = () => (dashboard?.myLists || []).filter((l) => !l.isDefault);

function providerNamesInQueue() {
  const counts = new Map();
  queue().forEach((s) => providersOf(s).forEach((p) => counts.set(p.name, (counts.get(p.name) || 0) + 1)));
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
}

function listTitleIds(list) {
  if (Array.isArray(list?.itemTitleIds) && list.itemTitleIds.length) return new Set(list.itemTitleIds);
  return new Set((list?.previewTitles || []).map((t) => t?.id).filter(Boolean));
}

function applyFilter(list, f) {
  if (f === "movie") return list.filter((s) => s.mediaType !== "tv");
  if (f === "tv") return list.filter((s) => s.mediaType === "tv");
  if (f === "short") return list.filter(isShort);
  if (f.startsWith("prov:")) {
    const name = f.slice(5);
    return list.filter((s) => providersOf(s).some((p) => p.name === name));
  }
  if (f.startsWith("list:")) {
    const ids = listTitleIds(myLists().find((x) => x.id === f.slice(5)));
    return list.filter((s) => ids.has(s.titleId));
  }
  return list;
}

function applySort(list) {
  const out = list.slice();
  if (sort === "az") out.sort((a, b) => String(titleOf(a).name || "").localeCompare(String(titleOf(b).name || ""), "it"));
  else if (sort === "short") {
    const weight = (s) => (s.mediaType === "tv" ? (seasonsCount(s) || 9) * 400 : (durationMinutes(s) || 9999));
    out.sort((a, b) => weight(a) - weight(b));
  } else if (sort === "rating") out.sort((a, b) => Number(titleOf(b).ratingAvg || 0) - Number(titleOf(a).ratingAvg || 0));
  return out;
}

function visibleStates() {
  let list = applyFilter(queue(), filter);
  if (query) {
    const q = query.toLowerCase();
    list = list.filter((s) => String(titleOf(s).name || "").toLowerCase().includes(q));
  }
  return applySort(list);
}
const countFor = (f) => applyFilter(queue(), f).length;

/* ============================== componenti ============================== */

function posterNode(state, size) {
  const url = posterUrl(state);
  const wrap = el("span", { class: `wlv-pw wlv-pw--${size}` }, [
    url ? el("img", { src: url, alt: "", loading: "lazy" }) : el("span", { class: "wlv-poster-ph" }),
  ]);
  const prov = firstProvider(state);
  if (prov?.logoUrl) {
    wrap.appendChild(el("span", { class: "wlv-prov", title: prov.name }, [el("img", { src: prov.logoUrl, alt: "", loading: "lazy" })]));
  } else if (prov?.name) {
    wrap.appendChild(el("span", { class: "wlv-prov wlv-prov--text", title: prov.name }, [prov.name.slice(0, 2)]));
  }
  return wrap;
}

function gridCell(state) {
  const wrap = posterNode(state, "grid");
  const label = shortLabel(state);
  if (label) wrap.appendChild(el("span", { class: "wlv-dur" }, [label]));

  return el("div", { class: "wlv-cell" }, [
    el("a", { class: "wlv-cell-link", href: titleHref(state), "aria-label": titleOf(state).name || i18nT("Titolo") }, [wrap]),
    el("button", {
      class: "wlv-cell-more",
      type: "button",
      "aria-label": i18nT("Azioni rapide"),
      onclick: (e) => { e.preventDefault(); openTitleSheet(state); },
    }, [iconFilled(IF.more, 15)]),
  ]);
}

const grid = (states) => (states.length
  ? el("div", { class: "wlv-grid" }, states.map(gridCell))
  : el("p", { class: "wlv-none" }, [i18nT("Nessun titolo con questo filtro.")]));

function shelfTile(state, opts = {}) {
  const wrap = posterNode(state, "tile");
  if (opts.badge) wrap.appendChild(el("span", { class: "wlv-ep" }, [opts.badge]));
  if (opts.ratio != null) wrap.appendChild(el("span", { class: "wlv-bar" }, [el("i", { style: `width:${Math.round(opts.ratio * 100)}%` })]));
  const sub = opts.subtitle || [shortLabel(state), firstProvider(state)?.name].filter(Boolean).join(" · ");
  return el("a", { class: "wlv-tile", href: titleHref(state) }, [
    wrap,
    el("span", { class: "wlv-nm" }, [titleOf(state).name || ""]),
    sub ? el("span", { class: "wlv-sb" }, [sub]) : null,
  ]);
}

const searchBar = () => el("button", { class: "wlv-searchbar", type: "button", onclick: openSearchSheet }, [
  icon(I.search, 17),
  el("span", {}, [query || i18nT("Cerca nei tuoi titoli")]),
]);

function chipsRow() {
  const items = [
    { f: "all", label: i18nT("Tutto") },
    { f: "movie", label: i18nT("Film") },
    { f: "tv", label: i18nT("Serie") },
    { f: "short", label: i18nT("Sotto 2h"), iconPath: I.clock },
    ...providerNamesInQueue().map(([name]) => ({ f: `prov:${name}`, label: name, logo: providerLogos.get(name) })),
    ...myLists().map((l) => ({ f: `list:${l.id}`, label: l.title, iconPath: I.folder })),
  ]
    .map((c) => ({ ...c, n: countFor(c.f) }))
    .filter((c) => c.n > 0 || c.f === filter);

  // Il chip attivo va in testa: la riga scrolla, altrimenti resta fuori campo.
  const activeIdx = items.findIndex((c) => c.f === filter);
  if (activeIdx > 0) items.unshift(items.splice(activeIdx, 1)[0]);

  const row = el("div", { class: "wlv-chips" }, [
    el("button", { class: "wlv-chip wlv-chip--icon", type: "button", "aria-label": i18nT("Filtri"), onclick: openFiltersSheet }, [icon(I.sliders, 15)]),
  ]);
  items.forEach((c) => row.appendChild(el("button", {
    class: `wlv-chip${c.f === filter ? " is-on" : ""}`,
    type: "button",
    onclick: () => { filter = c.f; showsAllQueue = false; syncUrl(); render(); },
  }, [
    c.logo ? el("img", { src: c.logo, alt: "", loading: "lazy" }) : (c.iconPath ? icon(c.iconPath, 14) : null),
    c.label,
    el("span", { class: "wlv-n" }, [String(c.n)]),
  ])));
  row.appendChild(el("button", {
    class: "wlv-chip wlv-chip--ghost",
    type: "button",
    onclick: openListsSheet,
  }, [icon(I.folder, 14), i18nT("Le tue liste")]));
  return row;
}

function visibilityPill(list) {
  const key = VISIBILITY[list.visibility] ? list.visibility : "private";
  const v = VISIBILITY[key];
  return el("span", { class: `wlv-vis is-${key}` }, [icon(VIS_ICON[v.icon], 12), v.label]);
}

function listMosaic(list, cls = "wlv-mosaic") {
  const node = el("span", { class: cls });
  const previews = (list.previewTitles || []).slice(0, 4);
  previews.forEach((t) => {
    const url = t?.posterPath || t?.posterURL || null;
    node.appendChild(url ? el("img", { src: url, alt: "", loading: "lazy" }) : el("span", { class: "wlv-poster-ph" }));
  });
  for (let i = previews.length; i < 4; i += 1) node.appendChild(el("span", { class: "wlv-poster-ph" }));
  return node;
}

function listProgressRatio(list) {
  const total = Number(list.itemCount || 0);
  if (!total) return 0;
  return Math.max(0, Math.min(1, Number(list.completedCount || 0) / total));
}

function listCard(list) {
  return el("a", { class: "wlv-listcard", href: listHref(list) }, [
    listMosaic(list),
    el("span", { class: "wlv-nm" }, [list.title || i18nT("Lista")]),
    el("span", { class: "wlv-sb" }, [
      `${i18nT("{count} titoli", { count: Number(list.itemCount || 0) })} · ${(VISIBILITY[list.visibility] || VISIBILITY.private).label}`,
    ]),
    el("span", { class: "wlv-prog" }, [el("i", { style: `width:${Math.round(listProgressRatio(list) * 100)}%` })]),
  ]);
}

function listRow(list) {
  const total = Number(list.itemCount || 0);
  const done = Number(list.completedCount || 0);
  const meta = el("span", { class: "wlv-listrow-meta" }, [visibilityPill(list)]);
  if (!list.isOwnedByCurrentUser && list.owner?.displayName) {
    meta.appendChild(el("span", { class: "wlv-owner" }, [i18nT("di {name}", { name: list.owner.displayName })]));
  }
  if (Number(list.followersCount || 0) > 0) {
    meta.appendChild(el("span", { class: "wlv-owner" }, [i18nT("{count} follower", { count: Number(list.followersCount) })]));
  }

  return el("a", { class: "wlv-listrow", href: listHref(list) }, [
    listMosaic(list, "wlv-mosaic wlv-mosaic--sm"),
    el("span", { class: "wlv-listrow-body" }, [
      el("span", { class: "wlv-listrow-t" }, [
        list.title || i18nT("Lista"),
        list.kind === "ordered_path" ? el("span", { class: "wlv-kind" }, [icon(I.route, 12), i18nT("in ordine")]) : null,
      ]),
      el("span", { class: "wlv-listrow-s" }, [
        total ? `${i18nT("{count} titoli", { count: total })} · ${i18nT("{done}/{total} visti", { done, total })}` : i18nT("Vuota"),
      ]),
      meta,
      el("span", { class: "wlv-prog" }, [el("i", { style: `width:${Math.round(listProgressRatio(list) * 100)}%` })]),
    ]),
    el("span", { class: "wlv-listrow-chev" }, [icon(I.chev, 17)]),
  ]);
}

function pageHead() {
  const movies = queue().filter((s) => s.mediaType !== "tv").length;
  return el("header", { class: "wlv-head" }, [
    el("div", {}, [
      el("h1", {}, [i18nT("Watchlist")]),
      el("p", { class: "wlv-sub" }, [i18nT("{count} da vedere · {movies} film, {series} serie", {
        count: queue().length, movies, series: queue().length - movies,
      })]),
    ]),
    el("div", { class: "wlv-head-acts" }, [
      el("button", { class: "wlv-ic is-primary", type: "button", "aria-label": i18nT("Nuova lista"), onclick: createList }, [icon(I.plus, 17)]),
    ]),
  ]);
}

/* =============================== schermata ===============================
 * Una sola. Niente sotto-schermate, niente card che porta "da un'altra
 * parte": si apre la watchlist e c'e' la watchlist. Le liste vivono come
 * chip in mezzo agli altri filtri, la loro gestione e' uno sheet.
 * ------------------------------------------------------------------------ */

/** Serie aperte: strip in cima, una riga sola. E' l'unica cosa che merita di
 *  stare sopra la griglia, perche' e' l'azione piu' frequente. */
function continueStrip() {
  const states = dashboard?.inProgress || [];
  if (!states.length) return null;
  return el("section", { class: "wlv-sec wlv-sec--continue" }, [
    el("div", { class: "wlv-sec-head" }, [
      el("h2", {}, [icon(I.resume, 16), i18nT("Continua")]),
    ]),
    el("div", { class: "wlv-hrow" }, states.slice(0, SHELF_MAX).map((s) => shelfTile(s, {
      badge: seriesProgressLabel(s),
      ratio: seriesProgressRatio(s),
      // Il badge sul poster dice gia' S4·E3: qui basta dove si guarda.
      subtitle: firstProvider(s)?.name || null,
    }))),
  ]);
}

function render() {
  const node = root();
  if (!node) return;

  const frag = document.createDocumentFragment();
  frag.appendChild(pageHead());

  const inProgress = dashboard?.inProgress || [];
  if (!queue().length && !inProgress.length && !myLists().length) {
    frag.appendChild(emptyState());
    node.replaceChildren(frag);
    return;
  }

  frag.appendChild(searchBar());
  const strip = continueStrip();
  if (strip) frag.appendChild(strip);
  frag.appendChild(chipsRow());

  const all = visibleStates();
  const isCapped = !showsAllQueue && all.length > QUEUE_PREVIEW_LIMIT;
  frag.appendChild(grid(isCapped ? all.slice(0, QUEUE_PREVIEW_LIMIT) : all));
  if (isCapped) {
    frag.appendChild(el("button", {
      class: "wlv-seeall",
      type: "button",
      onclick: () => { showsAllQueue = true; render(); },
    }, [
      i18nT("Vedi tutti"),
      el("span", { class: "wlv-seeall-n" }, [String(all.length)]),
      icon(I.chevDown, 15),
    ]));
  }

  node.replaceChildren(frag);
}

function syncUrl() {
  const params = new URLSearchParams(window.location.search || "");
  if (filter !== "all") params.set("filter", filter); else params.delete("filter");
  const qs = params.toString();
  window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
}

/* ================================= sheet ================================= */

function openSheet(nodes) {
  const layer = $("wlSheetLayer");
  const sheet = $("wlSheet");
  if (!layer || !sheet) return;
  sheet.replaceChildren(el("div", { class: "wlv-grab" }), ...(Array.isArray(nodes) ? nodes.filter(Boolean) : [nodes]));
  layer.hidden = false;
  requestAnimationFrame(() => layer.classList.add("is-open"));
}
function closeSheet() {
  const layer = $("wlSheetLayer");
  if (!layer || layer.hidden) return;
  layer.classList.remove("is-open");
  setTimeout(() => { layer.hidden = true; }, 220);
}

const sheetAction = (iconPath, label, onclick, danger = false) =>
  el("button", { class: `wlv-act${danger ? " is-danger" : ""}`, type: "button", onclick }, [icon(iconPath, 19), label]);

function openTitleSheet(state) {
  const prov = firstProvider(state);
  openSheet([
    el("div", { class: "wlv-preview" }, [
      posterUrl(state) ? el("img", { src: posterUrl(state), alt: "" }) : el("span", { class: "wlv-poster-ph" }),
      el("div", {}, [
        el("h3", {}, [titleOf(state).name || i18nT("Titolo")]),
        el("p", { class: "wlv-sheet-sub" }, [[metaLine(state), prov?.name].filter(Boolean).join(" · ")]),
      ]),
    ]),
    sheetAction(I.check, i18nT("Segna come visto"), (event) => markSeen(state, event.currentTarget)),
    sheetAction(I.chev, i18nT("Vai al titolo"), () => { window.location.href = titleHref(state); }),
    sheetAction(I.trash, i18nT("Rimuovi dalla watchlist"), (event) => removeFromQueue(state, event.currentTarget), true),
  ]);
}

function openFiltersSheet() {
  const chip = (f, label, extra) => el("button", {
    class: `wlv-chip${filter === f ? " is-on" : ""}`,
    type: "button",
    onclick: () => { filter = f; syncUrl(); render(); openFiltersSheet(); },
  }, [extra || null, label, el("span", { class: "wlv-n" }, [String(countFor(f))])]);

  const sortChip = (s, label) => el("button", {
    class: `wlv-chip${sort === s ? " is-on" : ""}`,
    type: "button",
    onclick: () => { sort = s; render(); openFiltersSheet(); },
  }, [label]);

  const group = (label, children) => el("div", { class: "wlv-grp" }, [
    el("span", {}, [label]),
    el("div", { class: "wlv-grp-row" }, children),
  ]);

  const provChips = providerNamesInQueue().map(([name]) => chip(
    `prov:${name}`, name,
    providerLogos.get(name) ? el("img", { src: providerLogos.get(name), alt: "", loading: "lazy" }) : null,
  ));
  const listChips = myLists().map((l) => chip(`list:${l.id}`, l.title, icon(I.folder, 14)));

  const nodes = [
    el("h3", {}, [i18nT("Filtra la watchlist")]),
    el("p", { class: "wlv-sheet-sub" }, [i18nT("{shown} titoli su {total}", { shown: visibleStates().length, total: queue().length })]),
    group(i18nT("Tipo"), [chip("all", i18nT("Tutto")), chip("movie", i18nT("Film")), chip("tv", i18nT("Serie"))]),
    group(i18nT("Durata"), [chip("short", i18nT("Sotto 2h"), icon(I.clock, 14))]),
    provChips.length ? group(i18nT("Dove si guarda"), provChips) : null,
    listChips.length ? group(i18nT("Le tue liste"), listChips) : null,
    group(i18nT("Ordina"), [
      sortChip("recent", i18nT("Salvati di recente")),
      sortChip("az", i18nT("A–Z")),
      sortChip("short", i18nT("Più corti")),
      sortChip("rating", i18nT("Voto community")),
    ]),
    el("button", {
      class: "wlv-btn is-primary",
      type: "button",
      onclick: () => { closeSheet(); },
    }, [i18nT("Mostra {count} titoli", { count: visibleStates().length })]),
  ];
  openSheet(nodes);
}

function openListsSheet() {
  const mine = myLists();
  const shared = dashboard?.sharedLists || [];
  const saved = (dashboard?.publicLists || []).filter((l) => l.isSavedByCurrentUser);

  const group = (label, arr) => (arr.length ? el("div", { class: "wlv-grp" }, [
    el("span", {}, [label]),
    el("div", { class: "wlv-rows" }, arr.map(listRow)),
  ]) : null);

  openSheet([
    el("h3", {}, [i18nT("Le tue liste")]),
    el("p", { class: "wlv-sheet-sub" }, [i18nT("{mine} tue · {shared} condivise · {saved} salvate", {
      mine: mine.length, shared: shared.length, saved: saved.length,
    })]),
    el("button", { class: "wlv-cta", type: "button", onclick: () => { closeSheet(); createList(); } },
      [icon(I.plus, 17), i18nT("Crea una lista")]),
    group(i18nT("Le mie liste"), mine),
    group(i18nT("Condivise con me"), shared),
    group(i18nT("Liste salvate"), saved),
    (mine.length || shared.length || saved.length)
      ? null
      : el("p", { class: "wlv-none" }, [i18nT("Non hai ancora liste. Creane una per organizzare i titoli.")]),
  ]);
}

function openSearchSheet() {
  const results = el("div", { class: "wlv-results" });
  const input = el("input", { type: "search", placeholder: i18nT("Titolo, genere, piattaforma"), autocomplete: "off", value: query });

  const run = () => {
    const q = input.value.trim().toLowerCase();
    const found = q ? queue().filter((s) => String(titleOf(s).name || "").toLowerCase().includes(q)).slice(0, 10) : [];
    results.replaceChildren(...(found.length
      ? found.map((s) => el("a", { class: "wlv-result", href: titleHref(s) }, [
        posterUrl(s) ? el("img", { src: posterUrl(s), alt: "", loading: "lazy" }) : el("span", { class: "wlv-poster-ph" }),
        el("span", {}, [
          el("b", {}, [titleOf(s).name || ""]),
          el("small", {}, [[metaLine(s), firstProvider(s)?.name].filter(Boolean).join(" · ")]),
        ]),
      ]))
      : (q ? [el("p", { class: "wlv-none" }, [i18nT("Nessun titolo trovato.")])] : [])));
  };
  input.addEventListener("input", run);

  openSheet([
    el("h3", {}, [i18nT("Cerca nella watchlist")]),
    el("p", { class: "wlv-sheet-sub" }, [i18nT("{count} titoli salvati", { count: queue().length })]),
    el("div", { class: "wlv-field wlv-field--search" }, [icon(I.search, 17), input]),
    el("button", {
      class: "wlv-btn is-ghost",
      type: "button",
      onclick: () => { query = input.value.trim(); syncUrl(); closeSheet(); render(); },
    }, [i18nT("Filtra la griglia")]),
    results,
  ]);
  setTimeout(() => input.focus(), 60);
}

/* ================================ azioni ================================ */

async function markSeen(state, button) {
  await runWithButtonLoading(button, async () => {
    try {
      await markTitleCompleted(state.titleId, state.mediaType);
      toast(i18nT("Segnato come visto"));
      logEvent("watchlist_mark_seen", { titleId: state.titleId });
      closeSheet();
      await reload();
    } catch (_) {
      toast(i18nT("Non è riuscito. Riprova."), i18nT("Errore"), { type: "error" });
    }
  }, { loadingLabel: i18nT("Salvataggio...") });
}

async function removeFromQueue(state, button) {
  await runWithButtonLoading(button, async () => {
    try {
      await removeFromWatchlist(currentUid, state.titleId);
      toast(i18nT("Rimosso dalla watchlist"));
      logEvent("watchlist_remove", { titleId: state.titleId });
      closeSheet();
      await reload();
    } catch (_) {
      toast(i18nT("Non è riuscito. Riprova."), i18nT("Errore"), { type: "error" });
    }
  }, { loadingLabel: i18nT("Rimozione...") });
}

function createList() {
  openListEditor({ mode: "create", onSaved: () => reload() });
}

/* ================================= dati ================================= */

/** Consigli ricevuti → righe "stato" con il solo titolo, per riusare le tessere. */
async function loadRecommendations(uid) {
  const recs = await listRecommendationsForMe(uid, { max: 12 }).catch(() => []);
  const ids = [...new Set((recs || []).map((r) => r?.titleId).filter(Boolean))];
  if (!ids.length) return [];
  const titles = await getTitlesByIds(ids).catch(() => new Map());
  return ids.map((id) => {
    const title = titles.get(id);
    if (!title) return null;
    return { titleId: id, mediaType: title.type === "tv" ? "tv" : "movie", title };
  }).filter(Boolean);
}

async function reload() {
  dashboard = await fetchWatchlistDashboard(currentUid);
  collectProviderLogos([...(dashboard.generalWatchlist || []), ...(dashboard.inProgress || [])]);
  render();
}

async function boot(uid) {
  currentUid = uid;
  const params = new URLSearchParams(window.location.search || "");
  // I vecchi deep link (?view=all|lists, ?area=toWatch|shared) puntavano a
  // schermate che non esistono piu': arrivano tutti sulla stessa pagina.
  const requestedFilter = params.get("filter");
  if (requestedFilter) filter = requestedFilter;

  await reload();
  $("appSplash")?.remove();

  // I consigli sono un extra: arrivano dopo, senza bloccare la prima pittura.
  recommended = await loadRecommendations(uid);
  if (recommended.length) render();
}

/* ================================= avvio ================================= */

document.addEventListener("click", (e) => { if (e.target.closest("[data-wlv-close]")) closeSheet(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });

onAuthStateChanged(auth, (user) => {
  if (!user?.uid) { window.location.href = "/login.html"; return; }
  boot(user.uid).catch((err) => {
    console.error("[watchlist] boot", err);
    $("appSplash")?.remove();
    root()?.replaceChildren(el("p", { class: "wlv-none" }, [i18nT("Non è riuscito. Riprova.")]));
  });
});
