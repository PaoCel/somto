/* wl-proto.js — prototipo navigabile della Watchlist. Solo /mockups/, noindex.
   Nessuna chiamata a Firebase: shell reale dell'app + dataset statico.
   La variante (a/b/c) arriva da <body data-wl-variant>.

   Schermate: home · grid (watchlist intera / filtro / lista) · lists · list. */

import { TITLES } from "./wl-data.js";

const VARIANT = document.body.dataset.wlVariant || "a";

/* =============================== dati =============================== */

const IMG = (p, s = "w342") => `https://image.tmdb.org/t/p/${s}${p}`;

const PROV = {
  nf:  { n: "Netflix",     l: "/pbpMk2JmcoNnQwx5JGpXngfoWtp.jpg" },
  pv:  { n: "Prime Video", l: "/pvske1MyAoymrs5bguRfVqYiM9a.jpg" },
  dp:  { n: "Disney+",     l: "/97yvRBw1GzX7fXprcF80er19ot.jpg" },
  sky: { n: "Sky Go",      l: "/vDdk3LyjWkYlfCtkrhkjFKFK1Hg.jpg" },
  now: { n: "NOW",         l: "/g0E9h3JAeIwmdvxlT73jiEuxdNj.jpg" },
  at:  { n: "Apple TV+",   l: "/mcbz1LgtErU9p4UdbZ0rG6RTWHX.jpg" },
  pp:  { n: "Paramount+",  l: "/h5DcR0J2EESLitnhR8xLG1QymTE.jpg" },
};
const PROV_KEYS = ["nf", "pv", "dp", "sky", "now", "at", "pp"];
const plogo = (k) => IMG(PROV[k].l, "w92");

const INPROGRESS = [
  { n: "The Bear", ep: "S3 E4", pct: 62 },
  { n: "Scissione", ep: "S2 E2", pct: 21 },
  { n: "Shōgun", ep: "S1 E6", pct: 55 },
  { n: "Fallout", ep: "S1 E7", pct: 84 },
  { n: "The Last of Us", ep: "S2 E1", pct: 12 },
];

const byName = new Map(TITLES.map((t) => [t.n, t]));
const inProgress = INPROGRESS.map((x) => ({ ...byName.get(x.n), ...x })).filter((x) => x.p);
const inProgressNames = new Set(inProgress.map((x) => x.n));
const QUEUE = TITLES.filter((t) => !inProgressNames.has(t.n));

/* Liste: visibility e ruoli rispecchiano userLists reale
   (visibility private|shared|public, owner/editor/viewer, followersCount). */
const ME = { name: "Paolo", initial: "P", color: "#E91E63" };
const PEOPLE = {
  Anna:  { initial: "A", color: "#9C27B0" },
  Luca:  { initial: "L", color: "#F77737" },
  Marco: { initial: "M", color: "#00D9FF" },
  Giulia:{ initial: "G", color: "#00E676" },
  Dave:  { initial: "D", color: "#FFB300" },
};

const LISTS = [
  { id: "scifi",  n: "Sci-fi da recuperare", g: "Fantascienza", vis: "private", owner: null, kind: "collection", pct: 42 },
  { id: "anna",   n: "Serate con Anna",      g: "Romance",      vis: "shared",  owner: null, kind: "collection", pct: 25, editors: ["Anna"] },
  { id: "oscar",  n: "Oscar da vedere",      g: "Storico",      vis: "public",  owner: null, kind: "collection", pct: 61, followers: 34 },
  { id: "brividi", n: "Maratona horror",     g: "Horror",       vis: "private", owner: null, kind: "ordered_path", pct: 12 },
  { id: "luca",   n: "Il canone di Luca",    g: "Dramma",       vis: "shared",  owner: "Luca", kind: "collection", pct: 8, editors: ["Luca", "Marco"] },
  { id: "cinema", n: "Visti al cinema 2026", g: "Thriller",     vis: "shared",  owner: "Giulia", kind: "collection", pct: 44, editors: ["Giulia"] },
  { id: "cult",   n: "Cult che tutti citano", g: "Crime",       vis: "public",  owner: "Somto", kind: "collection", pct: 30, followers: 1280, saved: true },
  { id: "corti",  n: "Sotto i 100 minuti",   g: "Commedia",     vis: "public",  owner: "Marco", kind: "collection", pct: 0, followers: 212, saved: true },
];
// Ogni lista prende titoli suoi: senza questo due liste dello stesso genere
// finiscono con le stesse copertine nel mosaico.
const usedInList = new Set();
LISTS.forEach((l, i) => {
  let items = QUEUE.filter((t) => t.g === l.g && !usedInList.has(t.n)).slice(0, 16);
  if (items.length < 5) {
    const fill = QUEUE.filter((t) => !usedInList.has(t.n)).slice(i * 9, i * 9 + 9 - items.length);
    items = [...items, ...fill];
  }
  items.forEach((t) => usedInList.add(t.n));
  l.items = items;
  l.done = Math.round((l.items.length * l.pct) / 100);
});
const listById = (id) => LISTS.find((l) => l.id === id);
const myLists = () => LISTS.filter((l) => !l.owner);
const sharedLists = () => LISTS.filter((l) => l.owner && !l.saved);
const savedLists = () => LISTS.filter((l) => l.saved);

const VIS = {
  private: { l: "Privata", d: "La vedi solo tu", ic: "lock" },
  shared:  { l: "Con amici", d: "La vedono e modificano le persone che inviti", ic: "users" },
  public:  { l: "Pubblica", d: "Chiunque su Somto può trovarla e salvarla", ic: "globe" },
};

/* ============================== helper ============================== */

const el = (sel) => document.querySelector(sel);
const fmtDur = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`);
const shortLabel = (t) => (t.t === "movie" ? fmtDur(t.r) : `${t.s} stag.`);
const metaLine = (t) => (t.t === "movie"
  ? `${t.y} · ${fmtDur(t.r)} · ${t.g}`
  : `${t.y} · ${t.s} ${t.s === 1 ? "stagione" : "stagioni"} · ${t.g}`);
const isShort = (t) => (t.t === "movie" ? t.r < 120 : t.s <= 2);
const ago = (d) => {
  if (d < 14) return `salvato ${d} giorni fa`;
  if (d < 60) return `salvato ${Math.round(d / 7)} settimane fa`;
  return `salvato ${Math.round(d / 30)} mesi fa`;
};
const esc = (s) => encodeURIComponent(s);

const ICON = {
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.7" y2="16.7"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
  play: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`,
  dice: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8.5" cy="8.5" r="1.3" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/></svg>`,
  spark: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="m12 1.5 2.4 5.4 5.6.7-4.2 4 1.1 5.6L12 14.5 7.1 17.2l1.1-5.6L4 7.6l5.6-.7L12 1.5Z"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.2 1.9"/></svg>`,
  resume: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 9 8 9"/></svg>`,
  users: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 14c2.2 0 4-1.8 4-4s-1.8-4-4-4-4 1.8-4 4 1.8 4 4 4Zm-8 0c2.2 0 4-1.8 4-4S10.2 6 8 6 4 7.8 4 10s1.8 4 4 4Zm0 2c-2.7 0-8 1.3-8 4v2h16v-2c0-2.7-5.3-4-8-4Zm8 0c-.3 0-.7 0-1.1.1 1.3 1 2.1 2.3 2.1 3.9v2h7v-2c0-2.7-5.3-4-8-4Z"/></svg>`,
  bookmark: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.5 2.6h11A1.9 1.9 0 0 1 19.4 4.5v16.1c0 .8-.9 1.3-1.6.9L12 18.1l-5.8 3.4c-.7.4-1.6-.1-1.6-.9V4.5A1.9 1.9 0 0 1 6.5 2.6Z"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M20 6 9 17l-5-5"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>`,
  folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>`,
  sliders: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h10M18 18h2"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="16" cy="18" r="2"/></svg>`,
  back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><polyline points="15 6 9 12 15 18"/></svg>`,
  chev: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><polyline points="9 6 15 12 9 18"/></svg>`,
  more: `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg>`,
  lock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7"/></svg>`,
  globe: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"/></svg>`,
  pencil: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20h4L20 8l-4-4L4 16Z"/></svg>`,
  share: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v13M8 7l4-4 4 4"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>`,
  reorder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 8h16M4 12h16M4 16h16"/><path d="M8 5 6 3 4 5M8 19l-2 2-2-2"/></svg>`,
  exit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M10 16 6 12l4-4M6 12h10"/></svg>`,
  route: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="6" cy="6" r="2.4"/><circle cx="18" cy="18" r="2.4"/><path d="M8.4 6H15a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h6.6"/></svg>`,
  bell: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 15V11a6 6 0 0 0-12 0v4l-1.6 2.2h15.2Z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>`,
};

/* ============================ shell reale ============================ */

const SHELL_ICONS = {
  menu: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`,
  search: ICON.search,
  chat: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3.2c-5.2 0-9.4 3.5-9.4 7.9 0 2.4 1.3 4.6 3.3 6-.2 1.1-.8 2.4-1.8 3.3-.3.3-.1.8.3.8 2 0 3.8-.7 5.1-1.6 1 .2 2 .4 3.2.4 5.2 0 9.4-3.6 9.4-7.9S17.2 3.2 12 3.2Z"/></svg>`,
  bell: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.4a3 3 0 0 0-3 3v.4C6.5 6.7 5 9.1 5 12v3.3l-1.5 2.1c-.4.6 0 1.4.8 1.4h15.4c.8 0 1.2-.8.8-1.4L19 15.3V12c0-2.9-1.5-5.3-4-6.2v-.4a3 3 0 0 0-3-3Z"/><path d="M9.5 20a2.6 2.6 0 0 0 5 0Z"/></svg>`,
  tabHome: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.3 3.3 3.6 9.7c-.4.3-.6.8-.6 1.3V20a1 1 0 0 0 1 1h4.4a1 1 0 0 0 1-1v-4.4a1 1 0 0 1 1-1h2.2a1 1 0 0 1 1 1V20a1 1 0 0 0 1 1H20a1 1 0 0 0 1-1v-9c0-.5-.2-1-.6-1.3l-7.7-6.4a1 1 0 0 0-1.4 0Z"/></svg>`,
  tabCommunity: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1Z"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87 1 1 0 0 0-.5 1.94A2 2 0 0 1 21 19v2a1 1 0 0 0 1 1h.02A1 1 0 0 0 23 21Z" fill-opacity="0.55"/><path d="M16 3.13a4 4 0 0 1 0 7.75 1 1 0 1 1-.5-1.94 2 2 0 0 0 0-3.87A1 1 0 1 1 16 3.13Z" fill-opacity="0.55"/></svg>`,
  tabWatchlist: ICON.bookmark,
  tabQuiz: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 16.4a1.35 1.35 0 1 1 0-2.7 1.35 1.35 0 0 1 0 2.7Zm1.8-6.3c-.8.5-1 .9-1 1.6v.3h-1.8v-.5c0-1.2.4-1.9 1.4-2.5.7-.5 1-.8 1-1.4 0-.7-.5-1.1-1.3-1.1-.8 0-1.3.4-1.5 1.3l-1.7-.6C9.1 7.3 10.3 6.4 12 6.4c2 0 3.3 1.1 3.3 2.7 0 1.2-.5 1.9-1.5 2.5Z"/></svg>`,
  tabProfile: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-6.9 17.2A7 7 0 0 1 12 15.6a7 7 0 0 1 6.9 3.6A10 10 0 0 0 12 2Zm0 11.4a3.7 3.7 0 1 1 0-7.4 3.7 3.7 0 0 1 0 7.4Z"/></svg>`,
};

function mountShell() {
  document.body.insertAdjacentHTML("afterbegin", `
    <header id="twHeader" class="tw-header">
      <div class="tw-headerbar">
        <div class="tw-chrome-group">
          <button class="tw-chrome-btn" type="button" aria-label="Apri menu">${SHELL_ICONS.menu}</button>
          <button class="tw-chrome-btn" type="button" aria-label="Apri ricerca">${SHELL_ICONS.search}</button>
        </div>
        <a class="tw-wordmark" href="#" aria-label="Vai alla Home"><img src="/icons/somto-wordmark.png" alt="Somto"></a>
        <div class="tw-chrome-group">
          <a class="tw-chrome-btn" href="#" aria-label="Apri chat">${SHELL_ICONS.chat}<span class="tw-chrome-badge dot"></span></a>
          <a class="tw-chrome-btn" href="#" aria-label="Notifiche">${SHELL_ICONS.bell}<span class="tw-chrome-badge">3</span></a>
        </div>
      </div>
    </header>`);

  const tabs = [
    ["home", "Home", SHELL_ICONS.tabHome],
    ["community", "Community", SHELL_ICONS.tabCommunity],
    ["watchlist", "Watchlist", SHELL_ICONS.tabWatchlist],
    ["quiz", "Quiz", SHELL_ICONS.tabQuiz, "Beta"],
    ["profile", "Profilo", SHELL_ICONS.tabProfile],
  ];
  document.body.insertAdjacentHTML("beforeend", `
    <nav id="twTabbar" class="tw-tabbar" aria-label="Navigazione">
      ${tabs.map(([id, label, icon, badge]) => `
        <a class="tw-tab${id === "watchlist" ? " is-active" : ""}" href="#" data-tab="${id}" aria-label="${label}">
          <span class="tw-tab-icon">${icon}${badge ? `<span class="tw-tab-badge is-text">${badge}</span>` : ""}</span>
          <span class="tw-tab-label">${label}</span>
        </a>`).join("")}
    </nav>
    <div class="wlp-sheet-layer" id="wlpSheetLayer">
      <div class="wlp-backdrop" data-close></div>
      <div class="wlp-sheet" id="wlpSheet"></div>
    </div>
    <div class="wlp-toast" id="wlpToast"></div>`);
}

/* =============================== stato =============================== */

const state = {
  screen: "home",       // home | grid | lists | list
  filter: "all",
  sort: "recent",
  listId: null,
  query: "",
  removed: new Set(),
  seen: new Set(),
  tonight: 0,
};

const pool = () => QUEUE.filter((t) => !state.removed.has(t.n) && !state.seen.has(t.n));

function applyFilter(list, filter) {
  if (filter === "movie") return list.filter((t) => t.t === "movie");
  if (filter === "tv") return list.filter((t) => t.t === "tv");
  if (filter === "short") return list.filter(isShort);
  if (filter === "friends") return list.filter((t) => t.f);
  if (filter.startsWith("prov:")) return list.filter((t) => t.pr === filter.slice(5));
  if (filter.startsWith("list:")) {
    const names = new Set((listById(filter.slice(5))?.items || []).map((x) => x.n));
    return list.filter((t) => names.has(t.n));
  }
  return list;
}

function sorted(list) {
  const out = list.slice();
  if (state.sort === "az") out.sort((a, b) => a.n.localeCompare(b.n, "it"));
  else if (state.sort === "short") out.sort((a, b) => (a.t === "movie" ? a.r : a.s * 400) - (b.t === "movie" ? b.r : b.s * 400));
  else if (state.sort === "rating") out.sort((a, b) => (b.v || 0) - (a.v || 0));
  else out.sort((a, b) => a.d - b.d);
  return out;
}

function visible() {
  let list = applyFilter(pool(), state.filter);
  if (state.query) {
    const q = state.query.toLowerCase();
    list = list.filter((t) => t.n.toLowerCase().includes(q));
  }
  return sorted(list);
}
const countFor = (f) => applyFilter(pool(), f).length;

function filterLabel(f) {
  if (f === "all") return "Tutta la watchlist";
  if (f === "movie") return "Film";
  if (f === "tv") return "Serie";
  if (f === "short") return "Stasera ci sta";
  if (f === "friends") return "Dai tuoi amici";
  if (f.startsWith("prov:")) return PROV[f.slice(5)].n;
  if (f.startsWith("list:")) return listById(f.slice(5))?.n || "Lista";
  return "Watchlist";
}

/* ============================= componenti ============================= */

function cellHTML(t, opt = {}) {
  return `<button class="wlp-cell${opt.done ? " is-done" : ""}" data-title="${esc(t.n)}" type="button" aria-label="${t.n}">
    <img src="${IMG(t.p)}" alt="${t.n}" loading="lazy">
    <span class="wlp-prov"><img src="${plogo(t.pr)}" alt="${PROV[t.pr].n}"></span>
    ${t.f ? `<span class="wlp-friend" title="${t.f.join(", ")}">${t.f[0][0]}</span>` : ""}
    ${opt.done ? `<span class="wlp-done">${ICON.check}</span>` : `<span class="wlp-dur">${shortLabel(t)}</span>`}
  </button>`;
}

const gridHTML = (list, opt) => (list.length
  ? `<div class="wlp-grid">${list.map((t, i) => cellHTML(t, { done: opt?.doneCount > i })).join("")}</div>`
  : `<p class="wlp-none">Nessun titolo con questo filtro.</p>`);

function searchBarHTML(placeholder) {
  return `<button class="wlp-searchbar" type="button" data-sheet="search">
    ${ICON.search}<span>${placeholder}</span>
  </button>`;
}

function chipsHTML() {
  const items = [
    { f: "all", l: "Tutto" },
    { f: "movie", l: "Film" },
    { f: "tv", l: "Serie" },
    { f: "short", l: "Sotto 2h", ic: ICON.clock },
    { f: "friends", l: "Dagli amici", ic: ICON.users },
    ...PROV_KEYS.map((k) => ({ f: `prov:${k}`, l: PROV[k].n, img: plogo(k) })),
    ...myLists().map((l) => ({ f: `list:${l.id}`, l: l.n, ic: ICON.folder })),
  ].map((c) => ({ ...c, n: countFor(c.f) })).filter((c) => c.n > 0 || c.f === state.filter);

  const active = items.findIndex((c) => c.f === state.filter);
  if (active > 0) items.unshift(items.splice(active, 1)[0]);

  return `<div class="wlp-chips">
    <button class="wlp-chip is-icon" type="button" data-sheet="filters" aria-label="Filtri">${ICON.sliders}</button>
    ${items.map((c) => `<button class="wlp-chip${c.f === state.filter ? " is-on" : ""}" type="button" data-filter="${c.f}">
      ${c.img ? `<img src="${c.img}" alt="">` : c.ic || ""}${c.l}<span class="wlp-n">${c.n}</span>
    </button>`).join("")}
  </div>`;
}

function tonightHTML() {
  const list = pool().filter((t) => t.b);
  if (!list.length) return "";
  const t = list[state.tonight % list.length];
  const reason = t.t === "movie" && t.r < 110 ? `${fmtDur(t.r)}, ci sta prima di dormire`
    : t.f ? `${t.f.join(" e ")} l'${t.f.length > 1 ? "hanno" : "ha"} salvato`
    : t.v >= 8 ? `${t.v.toFixed(1)} di media, uno dei più alti in coda`
    : ago(t.d);
  return `<section class="wlp-tonight" id="wlpTonight">
    <img class="wlp-tonight-bg" src="${IMG(t.b, "w780")}" alt="">
    <div class="wlp-tonight-scrim"></div>
    <span class="wlp-tonight-tag">${ICON.spark} Stasera</span>
    <div class="wlp-tonight-body">
      <h2>${t.n}</h2>
      <p class="wlp-tonight-meta">${metaLine(t)}${t.v ? ` · ★ ${t.v.toFixed(1)}` : ""}</p>
      <span class="wlp-reason">${ICON.clock} ${reason} · su ${PROV[t.pr].n}</span>
      <div class="wlp-tonight-btns">
        <button class="wlp-btn is-primary" type="button" data-watch="1">${ICON.play} Guardo questo</button>
        <button class="wlp-btn is-ghost" type="button" data-shuffle>${ICON.dice} Un altro</button>
      </div>
    </div>
  </section>`;
}

function shelfHTML(icon, title, note, list, filter) {
  if (!list.length) return "";
  return `<section class="wlp-sec">
    <div class="wlp-sec-head">
      <h2>${icon} ${title}</h2>
      ${filter ? `<button class="wlp-link" type="button" data-open-grid="${filter}">Vedi tutti</button>` : ""}
    </div>
    ${note ? `<p class="wlp-sec-note">${note}</p>` : ""}
    <div class="wlp-hrow">
      ${list.map((t) => `<button class="wlp-tile" type="button" data-title="${esc(t.n)}">
        <span class="wlp-pw">
          <img src="${IMG(t.p, "w185")}" alt="${t.n}" loading="lazy">
          <span class="wlp-prov"><img src="${plogo(t.pr)}" alt=""></span>
          ${t.ep ? `<span class="wlp-ep">${t.ep}</span>` : ""}
          ${t.pct ? `<span class="wlp-bar"><i style="width:${t.pct}%"></i></span>` : ""}
        </span>
        <span class="wlp-nm">${t.n}</span>
        <span class="wlp-sb">${t.pct ? `${t.pct}% · ${PROV[t.pr].n}` : `${shortLabel(t)} · ${PROV[t.pr].n}`}</span>
      </button>`).join("")}
    </div>
  </section>`;
}

/* Entrata esplicita alla watchlist intera: risolve il "dove sta la lista di
   tutto quello che ho salvato" che gli scaffali da soli non dicono. */
function allEntryHTML() {
  const p = pool();
  const strip = sorted(p).slice(0, 7);
  return `<button class="wlp-allcard" type="button" data-open-grid="all">
    <span class="wlp-allcard-strip">${strip.map((t, i) => `<img src="${IMG(t.p, "w92")}" alt="" style="z-index:${9 - i}" loading="lazy">`).join("")}</span>
    <span class="wlp-allcard-body">
      <span class="wlp-allcard-t">${ICON.bookmark} Tutta la watchlist</span>
      <span class="wlp-allcard-s">${p.length} titoli salvati · cerca, filtra, ordina</span>
    </span>
    <span class="wlp-allcard-chev">${ICON.chev}</span>
  </button>`;
}

const visPill = (l) => `<span class="wlp-vis is-${l.vis}">${ICON[VIS[l.vis].ic]}${VIS[l.vis].l}</span>`;

function listCardHTML(l) {
  return `<button class="wlp-listcard" type="button" data-open-list="${l.id}">
    <span class="wlp-mosaic">${l.items.slice(0, 4).map((t) => `<img src="${IMG(t.p, "w185")}" alt="" loading="lazy">`).join("")}</span>
    <span class="wlp-nm">${l.n}</span>
    <span class="wlp-sb">${l.items.length} titoli · ${VIS[l.vis].l}</span>
    <span class="wlp-prog"><i style="width:${l.pct}%"></i></span>
  </button>`;
}

function listsShelfHTML() {
  return `<section class="wlp-sec">
    <div class="wlp-sec-head">
      <h2>${ICON.folder} Le tue liste</h2>
      <button class="wlp-link" type="button" data-open-lists>Gestisci</button>
    </div>
    <div class="wlp-hrow">
      ${myLists().map(listCardHTML).join("")}
      <button class="wlp-listcard wlp-listcard--new" type="button" data-sheet="newlist">
        <span class="wlp-newlist"><span class="wlp-newlist-ic">${ICON.plus}</span></span>
        <span class="wlp-nm">Nuova lista</span>
        <span class="wlp-sb">Maratona, serata, tema</span>
      </button>
    </div>
  </section>`;
}

function headHTML() {
  const p = pool();
  const movies = p.filter((t) => t.t === "movie").length;
  return `<header class="wlp-head">
    <div>
      <h1>Watchlist</h1>
      <p class="wlp-sub">${p.length} da vedere · ${movies} film, ${p.length - movies} serie</p>
    </div>
    <div class="wlp-head-acts">
      <button class="wlp-ic is-primary" type="button" data-sheet="newlist" aria-label="Nuova lista">${ICON.plus}</button>
    </div>
  </header>`;
}

/* ============================== schermate ============================== */

function screenHome() {
  const short = pool().filter(isShort).slice(0, 10);
  const friends = pool().filter((t) => t.f).slice(0, 10);

  if (VARIANT === "b") return `${headHTML()}${searchBarHTML("Cerca nei tuoi titoli")}${chipsHTML()}${gridHTML(visible())}`;

  if (VARIANT === "a") {
    return `${headHTML()}${tonightHTML()}
      ${shelfHTML(ICON.resume, "Continua", "", inProgress, "tv")}
      ${searchBarHTML("Cerca nei tuoi titoli")}
      ${chipsHTML()}${gridHTML(visible())}
      <div style="height:1.25rem"></div>${listsShelfHTML()}`;
  }

  return `${headHTML()}
    ${searchBarHTML("Cerca nei tuoi titoli")}
    ${shelfHTML(ICON.resume, "Sto guardando", `${inProgress.length} serie aperte`, inProgress, "tv")}
    ${shelfHTML(ICON.clock, "Stasera ci sta", "Sotto le 2 ore, su una piattaforma che hai", short, "short")}
    ${shelfHTML(ICON.users, "Dai tuoi amici", "Salvati anche da chi segui", friends, "friends")}
    ${allEntryHTML()}
    ${listsShelfHTML()}`;
}

function screenGrid() {
  const list = visible();
  const title = state.query ? `"${state.query}"` : filterLabel(state.filter);
  return `
    <button class="wlp-back" type="button" data-back="home">${ICON.back} Watchlist</button>
    <header class="wlp-head">
      <div>
        <h1>${title}</h1>
        <p class="wlp-sub">${list.length} titoli</p>
      </div>
    </header>
    ${searchBarHTML(state.query || "Cerca nei tuoi titoli")}
    ${chipsHTML()}
    ${gridHTML(list)}`;
}

function listRowHTML(l) {
  const people = l.editors || [];
  return `<button class="wlp-listrow" type="button" data-open-list="${l.id}">
    <span class="wlp-mosaic wlp-mosaic--sm">${l.items.slice(0, 4).map((t) => `<img src="${IMG(t.p, "w92")}" alt="" loading="lazy">`).join("")}</span>
    <span class="wlp-listrow-body">
      <span class="wlp-listrow-t">${l.n}${l.kind === "ordered_path" ? `<span class="wlp-kind">${ICON.route} in ordine</span>` : ""}</span>
      <span class="wlp-listrow-s">${l.items.length} titoli · ${l.done}/${l.items.length} visti</span>
      <span class="wlp-listrow-meta">
        ${visPill(l)}
        ${l.owner ? `<span class="wlp-owner">di ${l.owner}</span>` : ""}
        ${people.length ? `<span class="wlp-avatars">${people.map((p) => `<span style="background:${PEOPLE[p]?.color || "#666"}">${PEOPLE[p]?.initial || p[0]}</span>`).join("")}</span>` : ""}
        ${l.followers ? `<span class="wlp-owner">${l.followers} follower</span>` : ""}
      </span>
      <span class="wlp-prog"><i style="width:${l.pct}%"></i></span>
    </span>
    <span class="wlp-listrow-chev">${ICON.chev}</span>
  </button>`;
}

function screenLists() {
  const mine = myLists(); const shared = sharedLists(); const saved = savedLists();
  const group = (title, note, arr) => (arr.length ? `<section class="wlp-sec">
    <div class="wlp-sec-head"><h2>${title}</h2><span class="wlp-count">${arr.length}</span></div>
    ${note ? `<p class="wlp-sec-note">${note}</p>` : ""}
    <div class="wlp-rows">${arr.map(listRowHTML).join("")}</div>
  </section>` : "");

  return `
    <button class="wlp-back" type="button" data-back="home">${ICON.back} Watchlist</button>
    <header class="wlp-head">
      <div>
        <h1>Le tue liste</h1>
        <p class="wlp-sub">${mine.length} tue · ${shared.length} condivise · ${saved.length} salvate</p>
      </div>
    </header>
    <button class="wlp-cta" type="button" data-sheet="newlist">${ICON.plus} Crea una lista</button>
    ${group("Le mie liste", "Solo tu decidi chi le vede", mine)}
    ${group("Condivise con me", "Ti hanno invitato: puoi aggiungere titoli", shared)}
    ${group("Liste salvate", "Liste pubbliche che segui", saved)}`;
}

function screenList() {
  const l = listById(state.listId);
  if (!l) return screenLists();
  const canEdit = !l.owner || (l.editors || []).length > 0;
  const people = [...(l.owner ? [l.owner] : [ME.name]), ...(l.editors || []).filter((p) => p !== l.owner)];
  return `
    <button class="wlp-back" type="button" data-back="lists">${ICON.back} Le tue liste</button>
    <section class="wlp-listhero">
      <span class="wlp-listhero-cover">${l.items.slice(0, 4).map((t) => `<img src="${IMG(t.p, "w185")}" alt="" loading="lazy">`).join("")}</span>
      <span class="wlp-listhero-scrim"></span>
      <span class="wlp-listhero-body">
        <span class="wlp-listhero-meta">${visPill(l)}${l.kind === "ordered_path" ? `<span class="wlp-kind">${ICON.route} in ordine</span>` : ""}</span>
        <h1>${l.n}</h1>
        <span class="wlp-listhero-sub">${l.items.length} titoli · ${l.done} visti · ${l.pct}%${l.followers ? ` · ${l.followers} follower` : ""}</span>
      </span>
      <button class="wlp-listhero-more" type="button" data-sheet="manage" aria-label="Gestisci lista">${ICON.more}</button>
    </section>
    <div class="wlp-people">
      <span class="wlp-avatars">${people.map((p) => {
        const d = p === ME.name ? ME : (PEOPLE[p] || { initial: p[0], color: "#666" });
        return `<span style="background:${d.color}">${d.initial}</span>`;
      }).join("")}</span>
      <span>${l.owner ? `Creata da ${l.owner}` : "Creata da te"}${(l.editors || []).length ? ` · ${(l.editors || []).length} ${((l.editors || []).length === 1 ? "collaboratore" : "collaboratori")}` : ""}</span>
    </div>
    <div class="wlp-listactions">
      <button class="wlp-btn is-primary" type="button" data-watch="1">${ICON.play} Riprendi</button>
      ${canEdit ? `<button class="wlp-btn is-ghost" type="button" data-toast="Cerca un titolo da aggiungere">${ICON.plus} Aggiungi</button>`
        : `<button class="wlp-btn is-ghost" type="button" data-toast="Lista salvata">${ICON.bookmark} Salva</button>`}
    </div>
    ${gridHTML(l.items.filter((t) => !state.removed.has(t.n)), { doneCount: l.done })}`;
}

function render() {
  const app = el("#wlpApp");
  app.innerHTML = state.screen === "grid" ? screenGrid()
    : state.screen === "lists" ? screenLists()
    : state.screen === "list" ? screenList()
    : screenHome();
  const fab = el("#wlpFab");
  if (fab) fab.hidden = VARIANT !== "b" || state.screen !== "home";
}

function go(screen, opts = {}) {
  state.screen = screen;
  if (opts.filter !== undefined) state.filter = opts.filter;
  if (opts.listId !== undefined) state.listId = opts.listId;
  if (opts.query !== undefined) state.query = opts.query;
  if (screen === "home") { state.filter = "all"; state.query = ""; }
  render();
  window.scrollTo({ top: 0, behavior: "instant" });
}

/* ============================== sheet ============================== */

const layer = () => el("#wlpSheetLayer");
function openSheet(html) {
  el("#wlpSheet").innerHTML = `<div class="wlp-grab"></div>${html}`;
  layer().classList.add("is-open");
}
function closeSheet() { layer().classList.remove("is-open"); }

function sheetTitle(name) {
  const t = byName.get(name);
  if (!t) return;
  openSheet(`
    <div class="wlp-preview">
      <img src="${IMG(t.p, "w185")}" alt="">
      <div><h3>${t.n}</h3><p class="wlp-sheet-sub">${metaLine(t)} · su ${PROV[t.pr].n}</p></div>
    </div>
    <button class="wlp-act" type="button" data-act="seen" data-n="${esc(t.n)}">${ICON.check} Segna come visto</button>
    <button class="wlp-act" type="button" data-act="watch" data-n="${esc(t.n)}">${ICON.play} Guarda ora su ${PROV[t.pr].n}</button>
    <button class="wlp-act" type="button" data-act="list" data-n="${esc(t.n)}">${ICON.folder} Sposta in una lista</button>
    <button class="wlp-act" type="button" data-act="propose" data-n="${esc(t.n)}">${ICON.users} Proponi a un amico</button>
    <button class="wlp-act is-danger" type="button" data-act="remove" data-n="${esc(t.n)}">${ICON.trash} Rimuovi dalla watchlist</button>`);
}

function sheetFilters() {
  const chip = (f, label, extra = "") =>
    `<button class="wlp-chip${state.filter === f ? " is-on" : ""}" type="button" data-filter="${f}">${extra}${label}<span class="wlp-n">${countFor(f)}</span></button>`;
  const sortChip = (s, label) =>
    `<button class="wlp-chip${state.sort === s ? " is-on" : ""}" type="button" data-sort="${s}">${label}</button>`;
  openSheet(`
    <h3>Filtra la watchlist</h3>
    <p class="wlp-sheet-sub">${visible().length} titoli su ${pool().length}</p>
    <div class="wlp-grp"><span>Tipo</span><div class="wlp-grp-row">${chip("all", "Tutto")}${chip("movie", "Film")}${chip("tv", "Serie")}</div></div>
    <div class="wlp-grp"><span>Durata</span><div class="wlp-grp-row">${chip("short", "Sotto 2h", ICON.clock)}</div></div>
    <div class="wlp-grp"><span>Dove si guarda</span><div class="wlp-grp-row">
      ${PROV_KEYS.map((k) => chip(`prov:${k}`, PROV[k].n, `<img src="${plogo(k)}" alt="">`)).join("")}
    </div></div>
    <div class="wlp-grp"><span>Le tue liste</span><div class="wlp-grp-row">
      ${myLists().map((l) => chip(`list:${l.id}`, l.n, ICON.folder)).join("")}
    </div></div>
    <div class="wlp-grp"><span>Ordina</span><div class="wlp-grp-row">
      ${sortChip("recent", "Salvati di recente")}${sortChip("az", "A–Z")}${sortChip("short", "Più corti")}${sortChip("rating", "Voto community")}
    </div></div>
    <button class="wlp-btn is-primary" type="button" data-apply-filters>Mostra ${visible().length} titoli</button>`);
}

function sheetSearch() {
  openSheet(`
    <h3>Cerca nella watchlist</h3>
    <p class="wlp-sheet-sub">${pool().length} titoli salvati</p>
    <div class="wlp-field wlp-field--search">
      ${ICON.search}<input id="wlpQ" type="search" placeholder="Titolo, genere, piattaforma" autocomplete="off" value="${state.query}">
    </div>
    <div class="wlp-suggest" id="wlpQSug">
      <button class="wlp-chip" type="button" data-search-quick="Dune">Dune</button>
      <button class="wlp-chip" type="button" data-search-quick="the">the</button>
      <button class="wlp-chip" type="button" data-search-quick="2024">2024</button>
    </div>
    <div id="wlpQRes"></div>`);
  const input = el("#wlpQ");
  const run = () => {
    const q = input.value.trim().toLowerCase();
    const res = q ? pool().filter((t) => t.n.toLowerCase().includes(q)).slice(0, 8) : [];
    el("#wlpQSug").hidden = !!q;
    el("#wlpQRes").innerHTML = res.length
      ? res.map((t) => `<button class="wlp-result" type="button" data-title="${esc(t.n)}">
          <img src="${IMG(t.p, "w92")}" alt="">
          <span><b>${t.n}</b><small>${metaLine(t)} · ${PROV[t.pr].n}</small></span>
        </button>`).join("")
      : (q ? `<p class="wlp-none">Nessun titolo trovato.</p>` : "");
  };
  input?.addEventListener("input", run);
  input?.focus();
  run();
}

function sheetNewList() {
  const preset = (id, ic, t, s) => `<button class="wlp-preset" type="button" data-preset="${id}">
    <span class="wlp-preset-ic">${ic}</span><span class="wlp-preset-t">${t}</span><span class="wlp-preset-s">${s}</span>
  </button>`;
  openSheet(`
    <h3>Nuova lista</h3>
    <p class="wlp-sheet-sub">Da dove parti</p>
    <div class="wlp-presets">
      ${preset("path", ICON.route, "Maratona", "Titoli in ordine, con progresso")}
      ${preset("night", ICON.users, "Serata con amici", "Modificabile da chi inviti")}
      ${preset("theme", ICON.folder, "Per tema", "Genere, regista, saga")}
      ${preset("blank", ICON.plus, "Parti da zero", "Solo il nome")}
    </div>
    <div class="wlp-grp"><span>Nome</span>
      <div class="wlp-field"><input type="text" placeholder="Es. Maratona horror" autocomplete="off"></div>
    </div>
    <div class="wlp-grp"><span>Chi la vede</span>${visPickerHTML("private")}</div>
    <button class="wlp-btn is-primary" type="button" data-toast="Lista creata">Crea lista</button>`);
}

function visPickerHTML(current, disabled = false) {
  return `<div class="wlp-vispicker${disabled ? " is-disabled" : ""}">
    ${Object.entries(VIS).map(([k, v]) => `<button class="wlp-visopt${k === current ? " is-on" : ""}" type="button" data-vis="${k}"${disabled ? " disabled" : ""}>
      <span class="wlp-visopt-ic">${ICON[v.ic]}</span>
      <span class="wlp-visopt-t">${v.l}</span>
      <span class="wlp-visopt-d">${v.d}</span>
    </button>`).join("")}
  </div>`;
}

function sheetManage() {
  const l = listById(state.listId);
  if (!l) return;
  const isOwner = !l.owner;
  openSheet(`
    <h3>${l.n}</h3>
    <p class="wlp-sheet-sub">${l.items.length} titoli · ${isOwner ? "sei tu il proprietario" : `di ${l.owner}, tu puoi modificare`}</p>

    <div class="wlp-grp"><span>Chi la vede</span>
      ${visPickerHTML(l.vis, !isOwner)}
      ${isOwner ? "" : `<p class="wlp-hint">${ICON.lock} Solo ${l.owner} può cambiare la visibilità.</p>`}
    </div>

    <div class="wlp-grp"><span>Collaboratori</span>
      <div class="wlp-members">
        <span class="wlp-member">
          <span class="wlp-avatars"><span style="background:${ME.color}">${ME.initial}</span></span>
          <span class="wlp-member-t">Tu<small>${isOwner ? "Proprietario" : "Può modificare"}</small></span>
        </span>
        ${(l.editors || []).map((p) => `<span class="wlp-member">
          <span class="wlp-avatars"><span style="background:${PEOPLE[p]?.color || "#666"}">${PEOPLE[p]?.initial || p[0]}</span></span>
          <span class="wlp-member-t">${p}<small>${p === l.owner ? "Proprietario" : "Può modificare"}</small></span>
        </span>`).join("")}
        <button class="wlp-member wlp-member--add" type="button" data-toast="Invito da condividere">
          <span class="wlp-member-add-ic">${ICON.plus}</span>
          <span class="wlp-member-t">Invita<small>Con un link</small></span>
        </button>
      </div>
    </div>

    <div class="wlp-grp"><span>Lista</span>
      <button class="wlp-act" type="button" data-toast="Rinomina">${ICON.pencil} Rinomina e descrizione</button>
      <button class="wlp-act" type="button" data-toast="Trascina per riordinare">${ICON.reorder} Riordina i titoli</button>
      <button class="wlp-act" type="button" data-toast="Link copiato">${ICON.share} Condividi</button>
      ${l.vis === "public" ? `<button class="wlp-act" type="button" data-toast="Avvisi attivi">${ICON.bell} Avvisami sui nuovi titoli</button>` : ""}
      ${isOwner
        ? `<button class="wlp-act is-danger" type="button" data-toast="Lista eliminata">${ICON.trash} Elimina lista</button>`
        : `<button class="wlp-act is-danger" type="button" data-toast="Uscito dalla lista">${ICON.exit} Esci dalla lista</button>`}
    </div>`);
}

/* ============================== eventi ============================== */

let toastTimer = null;
function toast(msg) {
  const node = el("#wlpToast");
  node.textContent = msg;
  node.classList.add("is-on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("is-on"), 1900);
}

document.addEventListener("click", (e) => {
  const hit = (sel) => e.target.closest(sel);

  if (hit("[data-close]")) { closeSheet(); return; }
  if (hit("[data-apply-filters]")) { closeSheet(); if (state.screen === "home") go("grid"); else render(); return; }

  const sheet = hit("[data-sheet]");
  if (sheet) {
    const k = sheet.dataset.sheet;
    if (k === "filters") sheetFilters();
    else if (k === "search") sheetSearch();
    else if (k === "newlist") sheetNewList();
    else if (k === "manage") sheetManage();
    return;
  }

  const openGrid = hit("[data-open-grid]");
  if (openGrid) { go("grid", { filter: openGrid.dataset.openGrid, query: "" }); return; }
  if (hit("[data-open-lists]")) { go("lists"); return; }

  const openList = hit("[data-open-list]");
  if (openList) { go("list", { listId: openList.dataset.openList }); return; }

  const back = hit("[data-back]");
  if (back) { go(back.dataset.back); return; }

  const filter = hit("[data-filter]");
  if (filter) {
    state.filter = filter.dataset.filter;
    if (filter.closest(".wlp-sheet")) sheetFilters();
    else if (state.screen === "home") { go("grid"); return; }
    render();
    return;
  }

  const sort = hit("[data-sort]");
  if (sort) { state.sort = sort.dataset.sort; sheetFilters(); render(); return; }

  const quick = hit("[data-search-quick]");
  if (quick) { const i = el("#wlpQ"); i.value = quick.dataset.searchQuick; i.dispatchEvent(new Event("input")); return; }

  const vis = hit("[data-vis]");
  if (vis) {
    const picker = vis.closest(".wlp-vispicker");
    picker.querySelectorAll(".wlp-visopt").forEach((n) => n.classList.toggle("is-on", n === vis));
    const l = listById(state.listId);
    if (l && vis.closest(".wlp-sheet") && state.screen === "list") { l.vis = vis.dataset.vis; render(); toast(`Ora è ${VIS[l.vis].l.toLowerCase()}`); }
    return;
  }

  const preset = hit("[data-preset]");
  if (preset) { preset.closest(".wlp-presets").querySelectorAll(".wlp-preset").forEach((n) => n.classList.toggle("is-on", n === preset)); return; }

  if (hit("[data-shuffle]")) {
    state.tonight += 1;
    const node = el("#wlpTonight");
    if (node) node.outerHTML = tonightHTML();
    return;
  }

  if (hit("[data-watch]")) { toast("Buona visione"); return; }

  const act = hit("[data-act]");
  if (act && act.dataset.n) {
    const name = decodeURIComponent(act.dataset.n);
    const kind = act.dataset.act;
    if (kind === "seen") { state.seen.add(name); toast("Segnato come visto"); }
    else if (kind === "remove") { state.removed.add(name); toast("Rimosso dalla watchlist"); }
    else if (kind === "watch") toast("Apro l'app della piattaforma");
    else if (kind === "list") toast("Scegli la lista");
    else if (kind === "propose") toast("Proposto");
    closeSheet(); render();
    return;
  }

  const title = hit("[data-title]");
  if (title) { closeSheet(); sheetTitle(decodeURIComponent(title.dataset.title)); return; }

  const t = hit("[data-toast]");
  if (t) { toast(t.dataset.toast); closeSheet(); return; }

  if (hit(".tw-tab")) { e.preventDefault(); toast("Prototipo: solo la Watchlist è navigabile"); }
});

/* ============================== avvio ============================== */

mountShell();
if (VARIANT === "b") {
  document.body.insertAdjacentHTML("beforeend", `<button class="wlp-fab" id="wlpFab" type="button">${ICON.dice} Scegli tu</button>`);
}
render();

function pickRandom() {
  const list = pool();
  const t = list[Math.floor(Math.random() * list.length)];
  if (!t) return;
  openSheet(`
    <div class="wlp-preview">
      <img src="${IMG(t.p, "w185")}" alt="">
      <div><h3>${t.n}</h3><p class="wlp-sheet-sub">${metaLine(t)} · su ${PROV[t.pr].n}</p></div>
    </div>
    <button class="wlp-btn is-primary" type="button" data-watch="1">${ICON.play} Guardo questo</button>
    <button class="wlp-act" type="button" data-again style="justify-content:center;margin-top:.6rem">${ICON.dice} Un altro</button>`);
}
el("#wlpFab")?.addEventListener("click", pickRandom);
document.addEventListener("click", (e) => { if (e.target.closest("[data-again]")) pickRandom(); });
