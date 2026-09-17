import { toast } from "./toast.js";
import { t as i18nT } from "../i18n/index.js";
import { registerPushToken } from "../pushTokens.js";

/**
 * notifyPermissionBanner.js — banner per attivare le notifiche push (FCM),
 * v2 (2026-07-06). Sostituisce la v1 che usava solo `Notification.requestPermission()`
 * (permesso browser ma NESSUN token FCM registrato — l'utente restava senza push
 * reali). Ora chiama `registerPushToken` (pushTokens.js), la stessa funzione usata
 * dal bottone dedicato in account.html.
 *
 * Autosufficiente sullo stile: riusa lo scaffold CSS `.notification-banner.dismiss-banner`
 * (definito in css/components/app-shell.css, pensato apposta per funzionare anche su
 * pagine che non caricano account.css/main.css per intero — es. home.html) e inietta
 * il proprio stylesheet se assente, cosi' il banner e' sempre visibile ovunque venga
 * montato (home.html, account.html, import.html).
 *
 * Dismiss persistito con TIMESTAMP (non boolean): `notifyBannerDismissed_v2` in
 * localStorage. Se l'utente chiude il banner, ricompare comunque dopo 14 giorni
 * (non e' un "mai piu'" definitivo come i banner one-shot) perche' la mancanza di
 * notifiche attive e' il problema che stiamo risolvendo (solo 4/94 utenti le avevano
 * attive) e un dismiss permanente vanificherebbe il fix.
 *
 * Caso iOS Safari NON installato come PWA: le push web non funzionano finche' il
 * sito non e' aggiunto alla Home (Add to Home Screen) - su iOS <16.4 non funzionano
 * proprio. In quel caso il banner mostra un CTA diverso: suggerisce l'app nativa
 * (link App Store) invece del bottone "Attiva" (che fallirebbe silenziosamente).
 */

const DISMISS_KEY = "notifyBannerDismissed_v2";
// Prompt contestuali (import appena finito, primo voto): a differenza del
// banner generico non seguono il TTL di 14 giorni — arrivano nel momento in cui
// il valore è appena stato consegnato — ma si mostrano UNA volta per innesco.
// Stesso modello del PushPromptService su iOS.
const PROMPT_SEEN_PREFIX = "notifyPrompt_v1_";
const DISMISS_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 giorni
const SHELL_STYLESHEET_HREF = "/css/components/app-shell.css";
const APP_STORE_URL = "https://apps.apple.com/it/app/somto/id6760966564";

function ensureBannerStyles() {
  if (!document.head) return;
  const has = Array.from(document.querySelectorAll("link[rel='stylesheet']"))
    .some((n) => String(n.getAttribute("href") || "").includes(SHELL_STYLESHEET_HREF));
  if (has) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = SHELL_STYLESHEET_HREF;
  document.head.appendChild(link);
}

function isDismissedRecently() {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    const ts = Number(raw);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts < DISMISS_TTL_MS;
  } catch (_) {
    return false;
  }
}

function promptAlreadySeen(trigger) {
  try {
    return localStorage.getItem(PROMPT_SEEN_PREFIX + trigger) !== null;
  } catch (_) {
    return false;
  }
}

function markPromptSeen(trigger) {
  try {
    localStorage.setItem(PROMPT_SEEN_PREFIX + trigger, String(Date.now()));
  } catch (_) {
    // storage non disponibile: al massimo il prompt ricompare, non blocca nulla.
  }
}

function persistDismiss() {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  } catch (_) {
    // storage non disponibile: il dismiss non persiste, ma non blocca la UI.
  }
}

/** iOS Safari NON in modalita' standalone (PWA non installata): le web push
 * non sono utilizzabili finche' l'utente non aggiunge il sito alla Home. */
function isIOSSafariNotInstalled() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const isIOSDevice = /iPhone|iPad|iPod/.test(ua)
    // iPadOS 13+ si presenta come Mac ma ha touch support
    || (/Macintosh/.test(ua) && "ontouchend" in document);
  if (!isIOSDevice) return false;
  const isStandalone = ("standalone" in navigator && navigator.standalone === true)
    || (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches);
  return !isStandalone;
}

/**
 * Monta il banner notifiche se: Notification permission === 'default',
 * non dismissato di recente (14gg), e non gia' presente in pagina.
 */
export function mountNotificationPermissionBanner({ containerSelector = "body", user = null, titleText = null, subtitleText = null, trigger = null } = {}) {
  if (typeof window === "undefined" || typeof Notification === "undefined") return null;
  if (Notification.permission !== "default") return null;
  if (trigger) {
    if (promptAlreadySeen(trigger)) return null;
  } else if (isDismissedRecently()) {
    return null;
  }

  const host = document.querySelector(containerSelector);
  if (!host) return null;

  // evita duplicati
  if (document.getElementById("notifPermBanner")) return null;

  ensureBannerStyles();

  const iosNeedsInstall = isIOSSafariNotInstalled();

  const wrap = document.createElement("div");
  wrap.id = "notifPermBanner";
  wrap.className = "notification-banner dismiss-banner";
  wrap.setAttribute("role", "status");

  const title = iosNeedsInstall
    ? i18nT("Installa Somto per le notifiche")
    : (titleText || i18nT("🔔 Attiva le notifiche"));
  const subtitle = iosNeedsInstall
    ? i18nT("Su iPhone le notifiche via browser non funzionano: installa l'app da App Store, oppure aggiungi Somto alla schermata Home da Safari (condividi → \"Aggiungi a Home\").")
    : (subtitleText || i18nT("Ti avvisiamo quando l'import è pronto e per le sfide degli amici."));

  const ctaMarkup = iosNeedsInstall
    ? `<a class="btn small primary dismiss-banner-cta" id="notifBannerInstallLink" href="${APP_STORE_URL}" target="_blank" rel="noopener">${i18nT("Apri App Store")}</a>`
    : `<button id="btnEnableNotifs" class="btn small primary dismiss-banner-cta" type="button">${i18nT("Attiva")}</button>`;

  wrap.innerHTML = `
    <div class="notification-content">
      <div class="notification-icon">${iosNeedsInstall ? "📲" : "🔔"}</div>
      <div class="notification-text">
        <div class="notification-title">${title}</div>
        <div class="notification-subtitle">${subtitle}</div>
      </div>
    </div>
    <div class="dismiss-banner-actions">
      ${ctaMarkup}
      <button class="dismiss-banner-close" type="button" aria-label="${i18nT("Chiudi avviso")}">&times;</button>
    </div>
  `;

  host.prepend(wrap);
  if (trigger) markPromptSeen(trigger);

  const dismiss = () => {
    persistDismiss();
    wrap.remove();
  };

  wrap.querySelector(".dismiss-banner-close")?.addEventListener("click", dismiss);

  if (!iosNeedsInstall) {
    const btn = wrap.querySelector("#btnEnableNotifs");
    btn?.addEventListener("click", async () => {
      btn.disabled = true;
      const previousLabel = btn.textContent;
      btn.textContent = "Attivazione…";
      try {
        const res = await registerPushToken(user);
        if (res?.ok) {
          toast("Notifiche attivate. Ti avviseremo qui.", i18nT("Notifiche"));
          persistDismiss();
          wrap.remove();
        } else {
          toast(i18nT("Permesso non concesso o non disponibile su questo browser."), i18nT("Notifiche"));
          btn.disabled = false;
          btn.textContent = previousLabel;
        }
      } catch (e) {
        console.error("[push] banner registerPushToken error", e);
        toast("Impossibile attivare notifiche", i18nT("Notifiche"));
        btn.disabled = false;
        btn.textContent = previousLabel;
      }
    });
  }

  return { element: wrap, dismiss };
}
