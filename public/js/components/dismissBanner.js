import { escapeHtml } from "../utils/dom.js";
import { t as i18nT } from "../i18n/index.js";

/**
 * dismissBanner.js — banner dismissibile generico (web).
 * Scheletro condiviso ricalcato su notifyPermissionBanner.js (classi
 * `.notification-banner`/`.dismiss-banner` stilate in css/components/app-shell.css).
 * Usato per avvisi "soft" (disclaimer, notice piattaforma) con dismiss
 * persistito in localStorage: una volta chiuso, non ricompare più su quel device.
 *
 * Autosufficiente sullo stile: pagine come index.html/login.html non caricano
 * app-shell.css via <link>, quindi il mount inietta lo stylesheet se assente.
 *
 * API: mountDismissBanner({ id, storageKey, icon, title, text, ctaLabel, ctaHref, containerSelector })
 */
const SHELL_STYLESHEET_HREF = "/css/components/app-shell.css";

function ensureDismissBannerStyles() {
  if (!document.head) return;
  const has = Array.from(document.querySelectorAll("link[rel='stylesheet']"))
    .some((n) => String(n.getAttribute("href") || "").includes(SHELL_STYLESHEET_HREF));
  if (has) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = SHELL_STYLESHEET_HREF;
  document.head.appendChild(link);
}

export function mountDismissBanner({
  id,
  storageKey,
  icon = "💡",
  title = "",
  text = "",
  ctaLabel = "",
  ctaHref = "",
  containerSelector = "body",
} = {}) {
  if (typeof window === "undefined") return null;
  if (!id || !storageKey) return null;

  try {
    if (localStorage.getItem(storageKey)) return null;
  } catch (_) {
    // storage non disponibile: mostriamo comunque il banner, ma il dismiss non persisterà.
  }

  if (document.getElementById(id)) return null;

  const host = document.querySelector(containerSelector);
  if (!host) return null;

  ensureDismissBannerStyles();

  const wrap = document.createElement("div");
  wrap.id = id;
  wrap.className = "notification-banner dismiss-banner";
  wrap.setAttribute("role", "status");

  const ctaMarkup = ctaLabel && ctaHref
    ? `<a class="btn small primary dismiss-banner-cta" href="${escapeHtml(ctaHref)}">${escapeHtml(ctaLabel)}</a>`
    : "";

  wrap.innerHTML = `
    <div class="notification-content">
      <div class="notification-icon">${icon}</div>
      <div class="notification-text">
        ${title ? `<div class="notification-title">${escapeHtml(title)}</div>` : ""}
        <div class="notification-subtitle">${escapeHtml(text)}</div>
      </div>
    </div>
    <div class="dismiss-banner-actions">
      ${ctaMarkup}
      <button class="dismiss-banner-close" type="button" aria-label="${i18nT("Chiudi avviso")}">&times;</button>
    </div>
  `;

  host.prepend(wrap);

  const dismiss = () => {
    try {
      localStorage.setItem(storageKey, "1");
    } catch (_) { /* quota o storage disabilitato, ignora */ }
    wrap.remove();
  };

  wrap.querySelector(".dismiss-banner-close")?.addEventListener("click", dismiss);

  return { element: wrap, dismiss };
}
