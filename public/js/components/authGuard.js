// authGuard.js — Gestisce splash screen + auth state
// Importare e chiamare initAuthGuard() all'inizio di ogni page.js protetta.

import { onAuth } from "../services/auth.service.js";

/**
 * Inizializza l'auth guard con grazia per evitare flash "non loggato".
 * Fino a quando Firebase Auth non emette un risultato definitivo, lo splash resta visibile.
 *
 * @param {object} opts
 * @param {boolean} [opts.requireAuth=true] - se true, redirect a login se non loggato
 * @param {function} opts.onReady - callback con user (o null)
 * @param {number} [opts.nullGraceMs=200] - attesa prima di considerare definitivo uno stato null
 */
export function initAuthGuard({ requireAuth = true, onReady, nullGraceMs = 200 }) {
  const splash = document.getElementById("appSplash");
  let nullTimer = null;

  function hideSplash() {
    if (splash) splash.hidden = true;
  }

  function settleNull() {
    hideSplash();
    if (requireAuth) {
      const next = encodeURIComponent(location.pathname + location.search);
      location.href = `/login.html?next=${next}`;
    } else {
      onReady?.(null);
    }
  }

  onAuth((user) => {
    if (user) {
      if (nullTimer) {
        clearTimeout(nullTimer);
        nullTimer = null;
      }
      hideSplash();
      onReady?.(user);
      return;
    }

    // user === null
    if (nullTimer) return;
    nullTimer = setTimeout(() => {
      nullTimer = null;
      settleNull();
    }, nullGraceMs);
  });
}
