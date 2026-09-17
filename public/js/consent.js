import { t as i18nT } from "./i18n/index.js";
const CONSENT_KEY = "somto_consent_v1";
const CONSENT_EVENT = "somto:consent-changed";
const POLICY_PAGES = new Set([
  "/privacy.html",
  "/cookies.html",
  "/consent.html",
  "/terms.html",
  "/support.html",
]);

const DEFAULT_CONSENT = Object.freeze({
  version: 1,
  necessary: true,
  functional: true,
  analytics: false,
  marketing: false,
  source: "unset",
  updatedAt: null,
});

let cachedConsent = null;
const listeners = new Set();

function safeReadStorage(key) {
  try {
    return window.localStorage?.getItem(key) || "";
  } catch (_) {
    return "";
  }
}

function safeWriteStorage(key, value) {
  try {
    window.localStorage?.setItem(key, value);
  } catch (_) {}
}

function normalizeConsent(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    version: 1,
    necessary: true,
    functional: true,
    analytics: src.analytics === true,
    marketing: false,
    source: String(src.source || "unset").trim() || "unset",
    updatedAt: src.updatedAt || null,
  };
}

function readConsent() {
  if (cachedConsent) return cachedConsent;
  const raw = safeReadStorage(CONSENT_KEY);
  if (!raw) {
    cachedConsent = { ...DEFAULT_CONSENT };
    return cachedConsent;
  }
  try {
    cachedConsent = normalizeConsent(JSON.parse(raw));
  } catch (_) {
    cachedConsent = { ...DEFAULT_CONSENT };
  }
  return cachedConsent;
}

function emitConsentChanged() {
  const next = getConsentState();
  listeners.forEach((cb) => {
    try {
      cb(next);
    } catch (_) {}
  });
  window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: next }));
}

function saveConsent(next) {
  cachedConsent = normalizeConsent({
    ...readConsent(),
    ...next,
    updatedAt: new Date().toISOString(),
  });
  safeWriteStorage(CONSENT_KEY, JSON.stringify(cachedConsent));
  emitConsentChanged();
  return getConsentState();
}

function ensureConsentBannerStyles() {
  if (document.getElementById("somtoConsentStyles")) return;
  const style = document.createElement("style");
  style.id = "somtoConsentStyles";
  style.textContent = `
    .somto-consent-banner {
      position: fixed;
      left: 16px;
      right: 16px;
      bottom: max(16px, env(safe-area-inset-bottom));
      z-index: 1200;
      border-radius: 20px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(11,12,15,0.96);
      box-shadow: 0 18px 60px rgba(0,0,0,0.35);
      color: #f7f7f5;
      padding: 16px;
      backdrop-filter: blur(18px);
    }
    .somto-consent-banner p {
      margin: 0 0 12px;
      line-height: 1.45;
      font-size: 14px;
    }
    .somto-consent-banner a {
      color: #f7f7f5;
      text-decoration: underline;
    }
    .somto-consent-banner-actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .somto-consent-status {
      margin-top: 10px;
      font-size: 12px;
      opacity: 0.76;
    }
    @media (min-width: 720px) {
      .somto-consent-banner {
        left: auto;
        width: min(460px, calc(100vw - 32px));
      }
    }
  `;
  document.head.appendChild(style);
}

function buildBannerNode() {
  const banner = document.createElement("aside");
  banner.id = "somtoConsentBanner";
  banner.className = "somto-consent-banner";
  banner.setAttribute("role", "dialog");
  banner.setAttribute("aria-live", "polite");
  banner.innerHTML = `
    <p>
      ${i18nT("SOMTO usa strumenti tecnici necessari e, solo se li abiliti, analytics di prodotto per capire cosa funziona meglio.\n      Nessuna profilazione pubblicitaria è attiva su Somto.")}
      <a href="/cookies.html">Cookie policy</a>
    </p>
    <div class="somto-consent-banner-actions">
      <button id="somtoConsentAccept" class="btn small primary" type="button">${i18nT("Accetta analytics")}</button>
      <button id="somtoConsentReject" class="btn small" type="button">${i18nT("Solo necessari")}</button>
      <a class="btn small" href="/consent.html">${i18nT("Gestisci")}</a>
    </div>
    <div class="somto-consent-status">${i18nT("Puoi cambiare idea in qualsiasi momento da Impostazioni.")}</div>
  `;
  banner.querySelector("#somtoConsentAccept")?.addEventListener("click", () => {
    grantAnalyticsConsent("banner");
    banner.remove();
  });
  banner.querySelector("#somtoConsentReject")?.addEventListener("click", () => {
    denyOptionalConsent("banner");
    banner.remove();
  });
  return banner;
}

export function getConsentState() {
  return { ...readConsent() };
}

export function hasConsentDecision() {
  return readConsent().source !== "unset";
}

export function canUseAnalytics() {
  return readConsent().analytics === true;
}

export function grantAnalyticsConsent(source = "settings") {
  return saveConsent({
    analytics: true,
    source,
  });
}

export function denyOptionalConsent(source = "settings") {
  return saveConsent({
    analytics: false,
    source,
  });
}

export function onConsentChange(cb) {
  if (typeof cb !== "function") return () => {};
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function mountConsentBannerIfNeeded() {
  if (typeof document === "undefined") return;
  const pathname = String(window.location.pathname || "").trim();
  if (POLICY_PAGES.has(pathname)) return;
  if (hasConsentDecision()) return;
  const mount = () => {
    if (!document.body || document.getElementById("somtoConsentBanner")) return;
    ensureConsentBannerStyles();
    document.body.appendChild(buildBannerNode());
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
    return;
  }
  mount();
}

window.addEventListener("storage", (event) => {
  if (event.key !== CONSENT_KEY) return;
  cachedConsent = null;
  emitConsentChanged();
});
