// spoilerGate.js — Anti-spoiler gate condiviso PWA.
//
// 1) `wrapSpoiler(htmlContent, item, viewerCompletedSet)` → string HTML.
//    Restituisce `htmlContent` invariato se l'item non è spoiler o se
//    il viewer ha completato TUTTI gli spoilerTitleIds; altrimenti
//    incapsula in un overlay blur cliccabile.
// 2) `attachSpoilerHandlers(rootEl, { onMarkSeen })` → wire dei click
//    sui bottoni "Tocca per mostrare" / "Ho visto X" generati da (1).
// 3) `isSpoilerHidden(item, viewerCompletedSet)` → bool puro.
//
// `viewerCompletedSet` è un `Set<string>` di titleIds che il viewer ha
// completato (vedi `titleStates.api.js#listCompletedTitleIDs`).

import { escapeHtml } from "../utils/dom.js";
import { t as i18nT } from "../i18n/index.js";

export function isSpoilerHidden(item, viewerCompletedSet) {
  if (!item || item.containsSpoiler !== true) return false;
  const ids = Array.isArray(item.spoilerTitleIds) ? item.spoilerTitleIds : [];
  if (!ids.length) {
    // Flaggato ma senza titoli: gate aperto per default (autore non ha
    // specificato cosa nascondere, lo trattiamo come avviso generico).
    return false;
  }
  return !ids.every((tid) => viewerCompletedSet.has(String(tid)));
}

/**
 * Avvolge `htmlContent` in un wrapper `.spoiler-gate` cliccabile.
 *
 * @param {string} htmlContent — HTML già escaped/safe del contenuto sensibile.
 * @param {Object} item — record con `containsSpoiler` + `spoilerTitleIds`.
 * @param {Set<string>} viewerCompletedSet — completati dal viewer.
 * @param {Object} [titleNames] — mappa opzionale `titleId -> nome`.
 * @returns {string} HTML.
 */
export function wrapSpoiler(htmlContent, item, viewerCompletedSet, titleNames = {}) {
  if (!isSpoilerHidden(item, viewerCompletedSet)) {
    return htmlContent;
  }
  const ids = Array.isArray(item.spoilerTitleIds) ? item.spoilerTitleIds : [];
  const missing = ids.filter((tid) => !viewerCompletedSet.has(String(tid)));
  const buttons = missing
    .slice(0, 3)
    .map((tid) => {
      const label = titleNames[tid] || tid;
      return `<button class="spoiler-mark-seen-btn" type="button" data-action="mark-seen" data-title-id="${escapeHtml(String(tid))}">Ho visto: ${escapeHtml(label)}</button>`;
    })
    .join("");
  const extra = missing.length > 3 ? `<div class="spoiler-overlay-extra">+${missing.length - 3} altri titoli</div>` : "";
  const subtitle = missing.length === 1
    ? i18nT("Su 1 titolo che non hai ancora visto.")
    : i18nT("Su {length} titoli che non hai ancora visto.", { length: missing.length });

  return `
    <div class="spoiler-gate" data-spoiler-gate>
      <div class="spoiler-content">${htmlContent}</div>
      <div class="spoiler-overlay">
        <div class="spoiler-overlay-icon">🚫</div>
        <div class="spoiler-overlay-title">${i18nT("Contiene spoiler")}</div>
        <div class="spoiler-overlay-subtitle">${escapeHtml(subtitle)}</div>
        <button class="spoiler-reveal-btn" type="button" data-action="reveal">${i18nT("Tocca per mostrare")}</button>
        ${buttons ? `<div class="spoiler-mark-seen-row">${buttons}</div>` : ""}
        ${extra}
      </div>
    </div>
  `;
}

/**
 * Wira i click sui bottoni generati da wrapSpoiler. Idempotente: usa
 * delegation, quindi chiamabile più volte sullo stesso root.
 *
 * @param {HTMLElement} rootEl
 * @param {Object} [opts]
 * @param {(titleID: string) => Promise<void>} [opts.onMarkSeen]
 */
export function attachSpoilerHandlers(rootEl, opts = {}) {
  if (!rootEl || rootEl.__spoilerHandlersAttached) return;
  rootEl.__spoilerHandlersAttached = true;
  rootEl.addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    const gate = btn.closest(".spoiler-gate");
    if (!gate) return;

    if (action === "reveal") {
      gate.classList.add("revealed");
      return;
    }
    if (action === "mark-seen") {
      const titleID = btn.getAttribute("data-title-id");
      if (!titleID) return;
      if (typeof opts.onMarkSeen === "function") {
        btn.disabled = true;
        try {
          await opts.onMarkSeen(titleID);
        } catch (err) {
          // Lascia il bottone abilitato per retry.
          btn.disabled = false;
          console.warn("[spoilerGate] markSeen failed", err);
          return;
        }
        // Sblocca solo il gate corrente (se tutti i missing ora sono visti).
        gate.classList.add("revealed");
      }
    }
  });
}
