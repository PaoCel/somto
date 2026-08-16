// pwa.js - registra Service Worker + update banner
//
// NON e' un modulo ES: 36 pagine lo caricano come `<script defer>` classico.
// Un `import` qui e' un SyntaxError, il file non parte, e con lui salta la
// registrazione del service worker su tutto il sito. Quindi le stringhe non
// possono passare da `t()`: il banner ha un mini-dizionario locale (PWA_STRINGS)
// che legge la stessa lingua decisa da js/i18n/index.js — chiave `somto.locale`
// in localStorage, piu' il `lang` della pagina per le gemelle statiche /en/.
// Duplicare tre stringhe costa meno che rendere modulo un file da cui dipende
// la registrazione del SW su tutto il sito.
(() => {
  if (!("serviceWorker" in navigator)) return;

  // Inietta CSS per il banner di aggiornamento
  const style = document.createElement("style");
  style.textContent = `
    .pwa-update-banner {
      position: fixed;
      bottom: calc(var(--tabbar-height, 4.5rem) + var(--space-sm, 0.5rem));
      left: 50%;
      transform: translateX(-50%);
      z-index: var(--z-toast, 110);
      width: min(420px, calc(100% - 2rem));
      display: flex;
      align-items: center;
      gap: var(--space-sm, 0.5rem);
      padding: var(--space-sm, 0.5rem) var(--space-md, 1rem);
      border-radius: var(--radius-lg, 16px);
      background: rgba(30, 30, 30, 0.95);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      animation: pwaSlideIn 0.35s cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    @keyframes pwaSlideIn {
      from { opacity: 0; transform: translateX(-50%) translateY(16px); }
      to   { opacity: 1; transform: translateX(-50%) translateY(0); }
    }
    .pwa-update-banner.removing {
      animation: pwaSlideOut 0.25s ease-in forwards;
    }
    @keyframes pwaSlideOut {
      from { opacity: 1; transform: translateX(-50%) translateY(0); }
      to   { opacity: 0; transform: translateX(-50%) translateY(16px); }
    }
    .pwa-update-text {
      flex: 1;
      font-size: var(--text-sm, 0.875rem);
      font-weight: var(--weight-semibold, 600);
      color: var(--text, #fff);
    }
    .pwa-update-btn {
      padding: 0.4rem 0.85rem;
      border: none;
      border-radius: var(--radius-full, 9999px);
      background: var(--brand-gradient, linear-gradient(135deg, #E91E63, #9C27B0));
      color: #fff;
      font-size: var(--text-sm, 0.875rem);
      font-weight: var(--weight-bold, 700);
      cursor: pointer;
      white-space: nowrap;
      font-family: inherit;
    }
    .pwa-update-close {
      background: none;
      border: none;
      color: var(--text-muted, #888);
      cursor: pointer;
      padding: 0.25rem;
      font-size: 1.2rem;
      line-height: 1;
    }
    @media (prefers-color-scheme: light) {
      .pwa-update-banner {
        background: rgba(255, 255, 255, 0.95);
        border-color: rgba(0, 0, 0, 0.06);
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
      }
      .pwa-update-text {
        color: #1a1a1a;
      }
      .pwa-update-close {
        color: #666;
      }
    }
  `;
  document.head.appendChild(style);

  const PWA_STRINGS = {
    it: { update: "Nuova versione disponibile", refresh: "Aggiorna", close: "Chiudi" },
    en: { update: "New version available", refresh: "Update", close: "Close" },
  };

  // Risolta quando il banner compare, non al load: la lingua puo' essere
  // impostata dopo (setLocale scrive lang sull'html), e il banner arriva molto
  // dopo, all'evento del service worker.
  function pwaStrings() {
    const pageLang = (document.documentElement.getAttribute("lang") || "").toLowerCase();
    if (pageLang.startsWith("en")) return PWA_STRINGS.en;
    let saved = "";
    try {
      saved = localStorage.getItem("somto.locale") || "";
    } catch {
      // Safari in navigazione privata: si ripiega sulla lingua del browser.
    }
    const raw = (saved || navigator.language || "").toLowerCase();
    return raw.startsWith("en") ? PWA_STRINGS.en : PWA_STRINGS.it;
  }

  function showUpdateBanner(waitingSW) {
    if (document.getElementById("pwaBannerUpdate")) return;

    const s = pwaStrings();
    const banner = document.createElement("div");
    banner.id = "pwaBannerUpdate";
    banner.className = "pwa-update-banner";
    banner.innerHTML = `
      <span class="pwa-update-text">${s.update}</span>
      <button class="pwa-update-btn" type="button">${s.refresh}</button>
      <button class="pwa-update-close" type="button" aria-label="${s.close}">&times;</button>
    `;
    document.body.appendChild(banner);

    banner.querySelector(".pwa-update-btn").addEventListener("click", () => {
      waitingSW.postMessage({ type: "SKIP_WAITING" });
    });

    banner.querySelector(".pwa-update-close").addEventListener("click", () => {
      banner.classList.add("removing");
      setTimeout(() => banner.remove(), 300);
    });
  }

  // Ricarica quando il nuovo SW prende il controllo
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });

  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("/service-worker.js", { scope: "/" });

      // Se c'è già un SW in attesa
      if (reg.waiting) {
        showUpdateBanner(reg.waiting);
      }

      reg.addEventListener("updatefound", () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener("statechange", () => {
          if (sw.state === "installed" && navigator.serviceWorker.controller) {
            showUpdateBanner(sw);
          }
        });
      });
    } catch (e) {
      console.warn("[PWA] SW registration failed", e);
    }
  });
})();
