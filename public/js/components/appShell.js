/**
 * appShell.js — Shell condivisa Somto (web)
 * Header BrandChromeBar + bottom tabbar (Home/Match/Watchlist/Quiz/Profilo)
 * + drawer menu + overlay ricerca. Identica su ogni pagina.
 * Replica ios/TwoWatch/DesignSystem/Components/BrandWordmarkView.swift
 * e la tabbar di Features/AppShell/RootView.swift.
 */

import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { auth } from "../firebase.js";
import { logout } from "../services/auth.service.js";
import { getMyUserDoc, searchUsersByPrefix } from "../api/users.api.js";
import { onWatchlistChange } from "../api/watchlist.api.js";
import { onNotificationsChange } from "../api/notifications.api.js";
import { searchTitlesSmart } from "../api/titles.api.js";
import { searchPeopleByPrefix } from "../api/people.api.js";
import { reportClientError } from "../api/errors.api.js";
import { t as i18nT, initI18n, applyStaticTranslations } from "../i18n/index.js";
import { toast } from "./toast.js";
import { runWithButtonLoading } from "../utils/loading.js";

// La lingua va decisa PRIMA che si veda qualunque cosa, altrimenti si vede un
// lampo di italiano e poi lo swap. I dizionari sono moduli statici, quindi
// questa e' una chiamata sincrona: nessuna attesa di rete.
//
// La preferenza salvata su `usersPrivate/{uid}.language` serve solo a
// sincronizzare fra dispositivi e arriva dopo il login: qui basta
// localStorage -> lingua del browser -> italiano.
initI18n();

let shellMounted = false;
let watchlistUnsub = null;
let notificationsUnsub = null;
let authBooted = false;
let errorTrackingBound = false;

const SHELL_STYLESHEET_HREF = "/css/components/app-shell.css";
const NO_SHELL_PATHS = ["/login.html"];
const WORDMARK_SRC = "/icons/somto-wordmark.png";

const SEARCH_SCOPES = ["titles", "users", "people"];
let searchScope = "titles";
let searchTimer = null;
let searchSeq = 0;

/* ===== Icone ===== */
// stessi SVG delle icone reali, mai duplicati altrove.
export const ICONS = {
  menu: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.7" y2="16.7"/></svg>`,
  chat: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3.2c-5.2 0-9.4 3.5-9.4 7.9 0 2.4 1.3 4.6 3.3 6-.2 1.1-.8 2.4-1.8 3.3-.3.3-.1.8.3.8 2 0 3.8-.7 5.1-1.6 1 .2 2 .4 3.2.4 5.2 0 9.4-3.6 9.4-7.9S17.2 3.2 12 3.2Z"/></svg>`,
  bell: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.4a3 3 0 0 0-3 3v.4C6.5 6.7 5 9.1 5 12v3.3l-1.5 2.1c-.4.6 0 1.4.8 1.4h15.4c.8 0 1.2-.8.8-1.4L19 15.3V12c0-2.9-1.5-5.3-4-6.2v-.4a3 3 0 0 0-3-3Z"/><path d="M9.5 20a2.6 2.6 0 0 0 5 0Z"/></svg>`,
  newspaper: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h13a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><path d="M19 8h2v10a2 2 0 0 1-2 2"/><line x1="7" y1="8" x2="14" y2="8"/><line x1="7" y1="12" x2="14" y2="12"/><line x1="7" y1="16" x2="11" y2="16"/></svg>`,
  tutorial: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 8l10 5 10-5-10-5Z"/><path d="M6 10.5V16c0 1.4 2.7 3 6 3s6-1.6 6-3v-5.5"/><path d="M22 8v6"/></svg>`,
  invite: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7Z"/></svg>`,
  tabHome: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.3 3.3 3.6 9.7c-.4.3-.6.8-.6 1.3V20a1 1 0 0 0 1 1h4.4a1 1 0 0 0 1-1v-4.4a1 1 0 0 1 1-1h2.2a1 1 0 0 1 1 1V20a1 1 0 0 0 1 1H20a1 1 0 0 0 1-1v-9c0-.5-.2-1-.6-1.3l-7.7-6.4a1 1 0 0 0-1.4 0Z"/></svg>`,
  tabMatch: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="3.2" y="6.6" width="12" height="14.2" rx="3"/><rect x="8.8" y="3.2" width="12" height="14.2" rx="3" fill-opacity="0.55"/></svg>`,
  tabCommunity: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1Z"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87 1 1 0 0 0-.5 1.94A2 2 0 0 1 21 19v2a1 1 0 0 0 1 1h.02A1 1 0 0 0 23 21Z" fill-opacity="0.55"/><path d="M16 3.13a4 4 0 0 1 0 7.75 1 1 0 1 1-.5-1.94 2 2 0 0 0 0-3.87A1 1 0 1 1 16 3.13Z" fill-opacity="0.55"/></svg>`,
  tabWatchlist: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.5 2.6h11A1.9 1.9 0 0 1 19.4 4.5v16.1c0 .8-.9 1.3-1.6.9L12 18.1l-5.8 3.4c-.7.4-1.6-.1-1.6-.9V4.5A1.9 1.9 0 0 1 6.5 2.6Z"/></svg>`,
  tabQuiz: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 16.4a1.35 1.35 0 1 1 0-2.7 1.35 1.35 0 0 1 0 2.7Zm1.8-6.3c-.8.5-1 .9-1 1.6v.3h-1.8v-.5c0-1.2.4-1.9 1.4-2.5.7-.5 1-.8 1-1.4 0-.7-.5-1.1-1.3-1.1-.8 0-1.3.4-1.5 1.3l-1.7-.6C9.1 7.3 10.3 6.4 12 6.4c2 0 3.3 1.1 3.3 2.7 0 1.2-.5 1.9-1.5 2.5Z"/></svg>`,
  tabProfile: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-6.9 17.2A7 7 0 0 1 12 15.6a7 7 0 0 1 6.9 3.6A10 10 0 0 0 12 2Zm0 11.4a3.7 3.7 0 1 1 0-7.4 3.7 3.7 0 0 1 0 7.4Z"/></svg>`,
};

/* ===== Config tab ===== */
export const TABS = [
  { id: "home", href: "/home.html", label: i18nT("Home"), icon: ICONS.tabHome },
  { id: "community", href: "/community.html", label: i18nT("Community"), icon: ICONS.tabCommunity },
  { id: "watchlist", href: "/watchlist.html", label: i18nT("Watchlist"), icon: ICONS.tabWatchlist },
  { id: "quiz", href: "/quiz.html", label: i18nT("Quiz"), icon: ICONS.tabQuiz, badgeText: "Beta" },
  { id: "profile", href: "/account.html", label: i18nT("Profilo"), icon: ICONS.tabProfile, avatar: true },
];

function q(id) { return document.getElementById(id); }

function shellDisabled() {
  if (document.body?.hasAttribute("data-no-shell")) return true;
  const path = String(window.location.pathname || "").toLowerCase();
  return NO_SHELL_PATHS.some((p) => path === p || path.endsWith(p));
}

function ensureShellStyles() {
  if (!document.head) return;
  const has = Array.from(document.querySelectorAll("link[rel='stylesheet']"))
    .some((n) => String(n.getAttribute("href") || "").includes(SHELL_STYLESHEET_HREF));
  if (has) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = SHELL_STYLESHEET_HREF;
  document.head.appendChild(link);
}

function injectSpeculationRules() {
  if (document.querySelector("script[type='speculationrules']")) return;
  try {
    const script = document.createElement("script");
    script.type = "speculationrules";
    script.textContent = JSON.stringify({
      prefetch: [{ where: { href_matches: "/*" }, eagerness: "moderate" }],
    });
    document.head.appendChild(script);
  } catch (_) { /* noop */ }
}

function resolveActiveTab() {
  const path = String(window.location.pathname || "").toLowerCase();
  const params = new URLSearchParams(window.location.search || "");
  if (path === "/home.html") return "home";
  if (path.startsWith("/community")) return "community";
  if (path.startsWith("/match")) return "watchlist";
  if (path.startsWith("/watchlist") || path.startsWith("/watched")) return "watchlist";
  if (path.startsWith("/quiz")) return "quiz";
  if (path.startsWith("/account")) {
    const tab = String(params.get("tab") || "").toLowerCase();
    if (tab === "watchlist") return "watchlist";
    return "profile";
  }
  if (path.startsWith("/user") || path.startsWith("/settings")) return "profile";
  return "";
}

function applyActiveTab() {
  const active = resolveActiveTab();
  document.querySelectorAll(".tw-tab").forEach((link) => {
    const isActive = !!active && link.dataset.tab === active;
    link.classList.toggle("is-active", isActive);
    link.setAttribute("aria-current", isActive ? "page" : "false");
  });
}

function updateBadge(kind, count) {
  const safe = Math.max(0, Number(count) || 0);
  document.querySelectorAll(`[data-badge-kind="${kind}"]`).forEach((node) => {
    if (!(node instanceof HTMLElement)) return;
    node.hidden = safe <= 0;
    node.textContent = safe > 99 ? "99+" : String(safe);
  });
}

/* ===== Markup ===== */
function buildHeader() {
  const header = document.createElement("header");
  header.id = "twHeader";
  header.className = "tw-header";
  header.innerHTML = `
    <div class="tw-headerbar">
      <div class="tw-chrome-group">
        <button id="appShellMenuBtn" class="tw-chrome-btn" type="button" aria-label="${i18nT("Apri menu")}" aria-expanded="false">${ICONS.menu}</button>
        <button id="appShellSearchBtn" class="tw-chrome-btn" type="button" aria-label="${i18nT("Apri ricerca")}" aria-expanded="false">${ICONS.search}</button>
      </div>
      <a class="tw-wordmark" href="/home.html" aria-label="${i18nT("Vai alla Home")}">
        <img src="${WORDMARK_SRC}" alt="${i18nT("Somto")}">
      </a>
      <div class="tw-chrome-group">
        <a id="appShellChatBtn" class="tw-chrome-btn" href="/threads.html" aria-label="${i18nT("Apri chat")}">
          ${ICONS.chat}
          <span class="tw-chrome-badge dot" data-badge-kind="threads" hidden></span>
        </a>
        <a id="appShellBellBtn" class="tw-chrome-btn" href="/notifications.html" aria-label="${i18nT("Notifiche")}">
          ${ICONS.bell}
          <span class="tw-chrome-badge" data-badge-kind="notifications" hidden>0</span>
        </a>
      </div>
    </div>
  `;
  return header;
}

function buildTabbar() {
  const nav = document.createElement("nav");
  nav.id = "twTabbar";
  nav.className = "tw-tabbar";
  nav.setAttribute("aria-label", "Navigazione");
  nav.innerHTML = TABS.map((t) => `
    <a class="tw-tab" href="${t.href}" data-tab="${t.id}" aria-label="${t.label}">
      <span class="tw-tab-icon">
        ${t.icon}
        ${t.avatar ? `<img class="tw-tab-avatar" alt="" hidden>` : ""}
        ${t.badgeText ? `<span class="tw-tab-badge is-text">${t.badgeText}</span>` : ""}
      </span>
      <span class="tw-tab-label">${t.label}</span>
    </a>
  `).join("");
  return nav;
}

function buildDrawer() {
  const drawer = document.createElement("div");
  drawer.id = "appShellDrawerLayer";
  drawer.className = "app-shell-layer";
  drawer.innerHTML = `
    <div id="appShellBackdrop" class="app-shell-backdrop" data-action="close-menu"></div>
    <aside id="appShellDrawer" class="app-shell-drawer" aria-label="Menu app">
      <header class="app-shell-drawer-head">
        <div class="identity">
          <div class="avatar" id="appShellAvatar">
            <img id="appShellAvatarImg" alt="" hidden>
            <span id="appShellAvatarFallback">S</span>
          </div>
          <div class="meta">
            <strong id="appShellName">${i18nT("Somto")}</strong>
            <small id="appShellHandle">Navigazione</small>
          </div>
        </div>
        <button class="app-shell-close" type="button" aria-label="${i18nT("Chiudi menu")}" data-action="close-menu">&times;</button>
      </header>
      <div class="app-shell-drawer-body">
        <section class="app-shell-shortcuts" aria-label="Scorciatoie">
          ${shortcut("/quiz.html", i18nT("Quiz"), ICONS.tabQuiz)}
          ${shortcut("/match.html", i18nT("Match"), ICONS.tabMatch)}
          ${shortcut("/watchlist.html", i18nT("Watchlist"), ICONS.tabWatchlist)}
          ${shortcut("/threads.html", "Chat", ICONS.chat)}
        </section>
        <section class="app-shell-section">
          <h3>Scopri</h3>
          <div class="app-shell-grid">
            <a class="app-shell-link app-shell-link-with-sub" href="/blog/">
              <span class="app-shell-link-head">
                <span class="app-shell-icon" aria-hidden="true">${ICONS.newspaper}</span>
                <span class="app-shell-link-text"><strong>Blog</strong><small>${i18nT("Guide e consigli su cosa guardare")}</small></span>
              </span>
            </a>
            <button id="appShellInviteBtn" class="app-shell-link app-shell-link-with-sub app-shell-link-button" type="button">
              <span class="app-shell-link-head">
                <span class="app-shell-icon" aria-hidden="true">${ICONS.invite}</span>
                <span class="app-shell-link-text"><strong>${i18nT("Invita un amico")}</strong><small>${i18nT("Condividi Somto con chi vuoi")}</small></span>
              </span>
            </button>
          </div>
        </section>
        <section class="app-shell-section">
          <h3>${i18nT("Community")}</h3>
          <div class="app-shell-grid">
            ${drawerLink("/threads.html", "Thread seguiti")}
          </div>
        </section>
        <section class="app-shell-section">
          <h3>${i18nT("Account")}</h3>
          <div class="app-shell-grid">
            ${drawerLink("/account.html", i18nT("Profilo"))}
            ${drawerLink("/watchlist.html?state=to_rate", "Da votare", "watchlist_to_rate")}
            ${drawerLink("/notifications.html", i18nT("Notifiche"), "notifications")}
            ${drawerLink("/import.html", i18nT("Importa i tuoi dati"))}
            ${drawerLink("/settings.html", i18nT("Impostazioni"))}
            ${drawerLink("/support.html", i18nT("Segnala un problema"))}
          </div>
        </section>
        <section class="app-shell-section">
          <h3>${i18nT("Privacy e dati")}</h3>
          <div class="app-shell-grid">
            ${drawerLink("/consent.html", "Gestione consenso")}
            ${drawerLink("/privacy.html", "Privacy policy")}
            ${drawerLink("/cookies.html", "Cookie policy")}
            <button id="appShellLogoutBtn" class="app-shell-link app-shell-link-button" type="button">
              <span class="app-shell-link-head"><span>${i18nT("Logout")}</span></span>
            </button>
          </div>
        </section>
        <section id="appShellModerationSection" class="app-shell-section" hidden>
          <h3>${i18nT("Moderazione")}</h3>
          <div class="app-shell-grid">
            ${drawerLink("/moderation.html", "Moderazione titoli")}
          </div>
        </section>
      </div>
    </aside>
  `;
  return drawer;
}

function shortcut(href, label, icon) {
  return `<a class="app-shell-shortcut" href="${href}"><span class="app-shell-icon" aria-hidden="true">${icon}</span><span>${label}</span></a>`;
}

function drawerLink(href, label, badgeKind) {
  const badge = badgeKind
    ? `<span class="app-shell-badge" data-badge-kind="${badgeKind}" hidden>0</span>`
    : "";
  return `<a class="app-shell-link" href="${href}"><span class="app-shell-link-head"><span>${label}</span></span>${badge}</a>`;
}

function buildSearch() {
  const search = document.createElement("div");
  search.id = "appShellSearchLayer";
  search.className = "app-shell-search-layer";
  search.innerHTML = `
    <div id="appShellSearchBackdrop" class="app-shell-search-backdrop" data-action="close-search"></div>
    <section class="app-shell-search-panel" aria-label="${i18nT("Ricerca globale")}">
      <header class="app-shell-search-head">
        <strong>${i18nT("Cerca in Somto")}</strong>
        <button class="app-shell-close" type="button" aria-label="${i18nT("Chiudi ricerca")}" data-action="close-search">&times;</button>
      </header>
      <form id="appShellSearchForm" class="app-shell-search-form">
        <input id="appShellSearchInput" type="search" placeholder=i18nT("Titoli, utenti, persone...") autocomplete="off" enterkeyhint="search">
        <button type="submit">${i18nT("Apri")}</button>
      </form>
      <div id="appShellSearchScopes" class="app-shell-search-scopes" role="tablist" aria-label=i18nT("Filtri ricerca")>
        <button type="button" class="scope-pill active" data-scope="titles">${i18nT("Titoli")}</button>
        <button type="button" class="scope-pill" data-scope="users">${i18nT("Utenti")}</button>
        <button type="button" class="scope-pill" data-scope="people">${i18nT("Persone")}</button>
      </div>
      <div id="appShellSearchResults" class="app-shell-search-results">
        <div class="hint">${i18nT("Digita almeno 2 caratteri per vedere risultati rapidi.")}</div>
      </div>
      <a id="appShellSearchAdvanced" class="app-shell-search-advanced" href="/search.html?scope=titles">${i18nT("Vai alla ricerca completa &rsaquo;")}</a>
    </section>
  `;
  return search;
}

function mountMarkup() {
  // Rimuovi shell legacy (tabbar HTML hardcoded, vecchia topbar, FAB)
  document.querySelectorAll("nav.tabbar, .app-shell-topbar, a.fab, .fab").forEach((n) => n.remove());
  if (q("twHeader")) return;
  document.body.appendChild(buildHeader());
  document.body.appendChild(buildTabbar());
  document.body.appendChild(buildDrawer());
  document.body.appendChild(buildSearch());
}

/* ===== Apri/chiudi overlay ===== */
function closeMenu() {
  document.body.classList.remove("app-shell-menu-open");
  q("appShellMenuBtn")?.setAttribute("aria-expanded", "false");
}
function openMenu() {
  document.body.classList.add("app-shell-menu-open");
  q("appShellMenuBtn")?.setAttribute("aria-expanded", "true");
}
function closeSearch() {
  document.body.classList.remove("app-shell-search-open");
  q("appShellSearchBtn")?.setAttribute("aria-expanded", "false");
}
function openSearch() {
  document.body.classList.add("app-shell-search-open");
  q("appShellSearchBtn")?.setAttribute("aria-expanded", "true");
  window.setTimeout(() => {
    q("appShellSearchInput")?.focus();
    void runOverlaySearch(q("appShellSearchInput")?.value || "");
  }, 60);
}

/* ===== Header compatto allo scroll ===== */
function bindScrollCompact() {
  const header = q("twHeader");
  if (!header) return;
  let ticking = false;
  const apply = () => {
    header.classList.toggle("is-compact", window.scrollY > 18);
    ticking = false;
  };
  apply();
  window.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(apply);
  }, { passive: true });
}

/* ===== Avatar ===== */
function setMenuAvatar(photoUrl, fallback = "S") {
  const img = q("appShellAvatarImg");
  const fb = q("appShellAvatarFallback");
  if (!(img instanceof HTMLImageElement) || !(fb instanceof HTMLElement)) return;
  const url = String(photoUrl || "").trim();
  if (url) {
    img.src = url; img.hidden = false; fb.hidden = true;
  } else {
    img.hidden = true; img.removeAttribute("src"); fb.hidden = false; fb.textContent = fallback;
  }
}

function setProfileTabAvatar(photoUrl) {
  const url = String(photoUrl || "").trim();
  document.querySelectorAll('.tw-tab[data-tab="profile"]').forEach((link) => {
    const img = link.querySelector(".tw-tab-avatar");
    const icon = link.querySelector("svg");
    if (!(img instanceof HTMLImageElement)) return;
    if (url) {
      img.src = url; img.hidden = false;
      if (icon) icon.style.display = "none";
    } else {
      img.hidden = true; img.removeAttribute("src");
      if (icon) icon.style.display = "";
    }
  });
}

/* ===== Ricerca overlay ===== */
function scopeLabel(scope) {
  if (scope === "users") return "users";
  if (scope === "people") return "people";
  return "titles";
}
function buildAdvancedHref(query) {
  const base = `/search.html?scope=${encodeURIComponent(scopeLabel(searchScope))}`;
  const t = String(query || "").trim();
  return t ? `${base}&q=${encodeURIComponent(t)}` : base;
}
function setSearchScope(next) {
  searchScope = SEARCH_SCOPES.includes(next) ? next : "titles";
  q("appShellSearchScopes")?.querySelectorAll("[data-scope]").forEach((node) => {
    const active = node.getAttribute("data-scope") === searchScope;
    node.classList.toggle("active", active);
    node.setAttribute("aria-selected", active ? "true" : "false");
  });
  q("appShellSearchAdvanced")?.setAttribute("href", buildAdvancedHref(q("appShellSearchInput")?.value || ""));
}
function renderSearchResults(items, query) {
  const root = q("appShellSearchResults");
  if (!root) return;
  if (!items.length) {
    root.innerHTML = `<div class="hint">${i18nT("Nessun risultato rapido per \"{query}\".", { query })}</div>`;
    return;
  }
  root.innerHTML = items.map((item) => `
    <a class="result-row" href="${item.href}">
      <div class="copy"><strong>${item.title}</strong>${item.sub ? `<small>${item.sub}</small>` : ""}</div>
      <span class="arrow">&rsaquo;</span>
    </a>
  `).join("");
}
async function runOverlaySearch(rawValue) {
  const root = q("appShellSearchResults");
  if (!root) return;
  const query = String(rawValue || "").trim();
  q("appShellSearchAdvanced")?.setAttribute("href", buildAdvancedHref(query));
  if (query.length < 2) {
    root.innerHTML = `<div class="hint">${i18nT("Digita almeno 2 caratteri per vedere risultati rapidi.")}</div>`;
    return;
  }
  const runId = ++searchSeq;
  root.innerHTML = `<div class="hint">${i18nT("Ricerca in corso...")}</div>`;
  try {
    let items = [];
    if (searchScope === "users") {
      const rows = await searchUsersByPrefix(query, { max: 8 }).catch(() => []);
      items = rows.map((row) => ({
        href: `/user.html?uid=${encodeURIComponent(row.uid)}`,
        title: String(row.displayName || row.uid || i18nT("Utente")),
        sub: row.uid ? `@${row.uid}` : "",
      }));
    } else if (searchScope === "people") {
      const rows = await searchPeopleByPrefix(query, { max: 8 }).catch(() => []);
      items = rows.map((row) => ({
        href: `/search.html?scope=people&q=${encodeURIComponent(row.name || query)}`,
        title: String(row.name || i18nT("Persona")),
        sub: Array.isArray(row.roles) ? row.roles.join(" · ") : "",
      }));
    } else {
      const rows = await searchTitlesSmart(query, 8).catch(() => []);
      items = rows.map((row) => ({
        href: `/title.html?id=${encodeURIComponent(row.id)}`,
        title: String(row.name || i18nT("Titolo")),
        sub: `${row.type === "tv" ? i18nT("Serie") : i18nT("Film")}${row.year ? ` · ${row.year}` : ""}`,
      }));
    }
    if (runId !== searchSeq) return;
    renderSearchResults(items, query);
  } catch (err) {
    if (runId !== searchSeq) return;
    console.error("app shell search error", err);
    root.innerHTML = `<div class="hint">${i18nT("Errore nella ricerca rapida.")}</div>`;
  }
}

/* ===== Wiring ===== */
function bindUi() {
  q("appShellMenuBtn")?.addEventListener("click", () => {
    document.body.classList.contains("app-shell-menu-open") ? closeMenu() : openMenu();
  });
  q("appShellSearchBtn")?.addEventListener("click", () => {
    document.body.classList.contains("app-shell-search-open") ? closeSearch() : openSearch();
  });
  document.querySelectorAll("[data-action='close-menu']").forEach((n) => n.addEventListener("click", closeMenu));
  document.querySelectorAll("[data-action='close-search']").forEach((n) => n.addEventListener("click", closeSearch));

  q("appShellSearchScopes")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-scope]");
    if (!btn) return;
    setSearchScope(String(btn.getAttribute("data-scope") || "titles"));
    void runOverlaySearch(q("appShellSearchInput")?.value || "");
  });
  q("appShellSearchInput")?.addEventListener("input", (e) => {
    const value = e.target?.value || "";
    if (searchTimer) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void runOverlaySearch(value), 170);
  });
  q("appShellSearchForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    window.location.href = buildAdvancedHref(q("appShellSearchInput")?.value || "");
  });
  q("appShellLogoutBtn")?.addEventListener("click", async (event) => {
    await runWithButtonLoading(event.currentTarget, async () => {
      try {
        await logout();
        window.location.href = "/login.html";
      } catch (err) {
        console.error("logout error", err);
        toast(i18nT("Logout non riuscito. Riprova."), i18nT("Errore"), { type: "error" });
      }
    }, { loadingLabel: i18nT("Uscita...") });
  });
  q("appShellInviteBtn")?.addEventListener("click", async () => {
    closeMenu();
    const { shareSomtoInvite } = await import("../utils/inviteShare.js");
    await shareSomtoInvite();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    closeSearch();
    closeMenu();
  });
}

function cleanupRealtime() {
  [watchlistUnsub, notificationsUnsub].forEach((fn) => {
    if (typeof fn === "function") fn();
  });
  watchlistUnsub = notificationsUnsub = null;
}

function resolveWatchState(entry) {
  const raw = String(entry?.watchState || entry?.state || "").trim().toLowerCase();
  return raw === "to_rate" ? "to_rate" : "to_watch";
}
function countToRate(items) {
  return (Array.isArray(items) ? items : [])
    .filter((e) => !e?.pendingTitle && resolveWatchState(e) === "to_rate").length;
}

const PROFILE_CACHE_KEY = "somto_appshell_profile_v1";
const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;

function readCachedProfile(uid) {
  try {
    const raw = sessionStorage.getItem(PROFILE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.uid !== uid) return null;
    if (Date.now() - Number(parsed.savedAt || 0) > PROFILE_CACHE_TTL_MS) return null;
    return parsed.profile || null;
  } catch (_e) {
    return null;
  }
}
function writeCachedProfile(uid, profile) {
  try {
    sessionStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify({ uid, profile, savedAt: Date.now() }));
  } catch (_e) { /* quota, ignore */ }
}

function applyProfileUI(user, profile) {
  const displayName = String(profile?.displayName || user?.displayName || i18nT("Utente")).trim();
  const handle = String(profile?.displayNameLower || user?.uid || "").slice(0, 20);
  const initials = displayName.split(/\s+/).filter(Boolean).slice(0, 2)
    .map((p) => p[0] || "").join("").toUpperCase() || "U";
  const photoUrl = String(profile?.photoURL || profile?.avatarURL || user?.photoURL || "").trim();

  if (q("appShellName")) q("appShellName").textContent = displayName;
  if (q("appShellHandle")) q("appShellHandle").textContent = handle ? `@${handle}` : i18nT("Somto");
  setMenuAvatar(photoUrl, initials);
  setProfileTabAvatar(photoUrl);

  const canModerate = !!profile?.isAdmin || !!profile?.trusted;
  if (q("appShellModerationSection")) q("appShellModerationSection").hidden = !canModerate;
}

function bindUserData() {
  if (authBooted) return;
  authBooted = true;
  onAuthStateChanged(auth, async (user) => {
    cleanupRealtime();
    if (!user?.uid) {
      if (q("appShellName")) q("appShellName").textContent = i18nT("Somto");
      if (q("appShellHandle")) q("appShellHandle").textContent = "Navigazione";
      setMenuAvatar("", "S");
      setProfileTabAvatar("");
      if (q("appShellModerationSection")) q("appShellModerationSection").hidden = true;
      updateBadge("notifications", 0);
      updateBadge("watchlist_to_rate", 0);
      try { sessionStorage.removeItem(PROFILE_CACHE_KEY); } catch (_e) {}
      return;
    }

    // 1) Render istantaneo da cache sessionStorage se presente (no round-trip Firestore).
    const cached = readCachedProfile(user.uid);
    if (cached) {
      applyProfileUI(user, cached);
    } else {
      applyProfileUI(user, null);
    }

    // 2) Refresh asincrono del profilo (non bloccante per UI).
    (async () => {
      const fresh = await getMyUserDoc(user.uid).catch(() => null);
      if (fresh) {
        writeCachedProfile(user.uid, fresh);
        applyProfileUI(user, fresh);
      }
    })();

    // 3) Defer Firestore listeners reali (badge notifiche/watchlist/richieste) per non bloccare il render.
    //    Le badge restano a 0 per ~600ms, poi appaiono. Non bloccante.
    const deferStart = (cb, ms = 600) => {
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(() => cb(), { timeout: ms });
      } else {
        setTimeout(cb, ms);
      }
    };
    deferStart(() => {
      // Se nel frattempo l'utente è cambiato (signout/switch), saltiamo per evitare listener orfani.
      if (auth.currentUser?.uid !== user.uid) return;
      notificationsUnsub = onNotificationsChange(user.uid, (rows) => {
        updateBadge("notifications", Array.isArray(rows) ? rows.length : 0);
      });
      watchlistUnsub = onWatchlistChange(user.uid, (items) => {
        updateBadge("watchlist_to_rate", countToRate(items));
      });
    });

    // 4) Token push: finora si registrava SOLO al click sul banner, e il banner
    //    non ricompare piu' una volta dato il permesso. Chi cambiava browser,
    //    puliva i dati del sito o perdeva il token (rotazione FCM, cleanup dei
    //    token invalidi) restava senza push per sempre, senza accorgersene.
    //    Se il permesso c'e' gia', la registrazione va rifatta a ogni sessione.
    deferStart(async () => {
      if (auth.currentUser?.uid !== user.uid) return;
      if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
      try {
        const { registerPushToken } = await import("../pushTokens.js");
        await registerPushToken(user);
      } catch (err) {
        console.warn("[push] re-registrazione token fallita", err);
      }
    }, 2000);
  });
}

/**
 * Osservabilità minima (review risk R1): intercetta errori JS non gestiti
 * SOLO sulle pagine dove monta la shell (app/auth, autenticate) — mai sulle
 * landing pubbliche, che impostano `data-no-shell` e non arrivano qui
 * (`initAppShell` ritorna prima, vedi `shellDisabled()` sopra). Il
 * doppio guard (`errorTrackingBound` qui + `shellMounted` sull'intera
 * funzione) evita registrazioni multiple dei listener globali.
 * `reportClientError` è comunque no-op se l'utente non è autenticato,
 * quindi anche un'eventuale pagina shell raggiunta da guest non scrive nulla.
 */
function bindErrorTracking() {
  if (errorTrackingBound) return;
  errorTrackingBound = true;

  window.addEventListener("error", (e) => {
    reportClientError({
      message: e.message,
      source: e.filename,
      line: e.lineno,
      col: e.colno,
      stack: e.error?.stack,
    });
  });

  window.addEventListener("unhandledrejection", (e) => {
    reportClientError({
      message: String(e.reason?.message || e.reason),
      stack: e.reason?.stack,
    });
  });
}

export function initAppShell() {
  if (shellMounted) return;
  if (shellDisabled()) return;
  shellMounted = true;

  ensureShellStyles();
  document.body.classList.add("has-app-shell");
  mountMarkup();
  // Dopo il mount: traduce sia il markup dello shell sia quello statico della
  // pagina ospite (elementi con data-i18n / data-i18n-attr).
  applyStaticTranslations();
  applyActiveTab();
  setSearchScope("titles");
  bindUi();
  bindScrollCompact();
  bindUserData();
  bindErrorTracking();
  injectSpeculationRules();
}

/* Compat: vecchio entry point */
export function initTabbar() { initAppShell(); }
