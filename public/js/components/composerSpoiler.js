// composerSpoiler.js — Sezione "Contiene spoiler" per i composer della PWA
// (post, comment, message thread, recommendation).
//
// Uso minimale:
//   const ctrl = mountSpoilerComposer(parentEl, {
//     candidateTitles: [{ id: "berlino", name: "Berlino" }, ...],
//     maxSelection: 5,
//   });
//   // poi nel send:
//   const { containsSpoiler, spoilerTitleIds } = ctrl.getState();
//   // reset post invio:
//   ctrl.reset();

import { escapeHtml, qs } from "../utils/dom.js";
import { t as i18nT } from "../i18n/index.js";

const MAX_SELECTION_HARD_CAP = 5; // allineato alle Firestore rules

/**
 * @param {HTMLElement} parentEl — container vuoto in cui montare la sezione.
 * @param {Object} opts
 * @param {Array<{id:string, name:string}>} [opts.candidateTitles]
 * @param {number} [opts.maxSelection=5]
 * @returns {{ getState: () => {containsSpoiler:boolean, spoilerTitleIds:string[]}, reset: () => void, setCandidateTitles: (titles) => void }}
 */
export function mountSpoilerComposer(parentEl, opts = {}) {
  if (!parentEl) throw new Error("parentEl mancante");
  const maxSelection = Math.min(MAX_SELECTION_HARD_CAP, Math.max(1, Number(opts.maxSelection || MAX_SELECTION_HARD_CAP)));
  let candidates = Array.isArray(opts.candidateTitles) ? [...opts.candidateTitles] : [];
  const selected = new Set();
  let containsSpoiler = false;

  parentEl.classList.add("spoiler-composer");
  parentEl.innerHTML = `
    <label class="spoiler-composer-toggle">
      <input type="checkbox" data-role="spoiler-toggle"/>
      <span>${i18nT("Contiene spoiler")}</span>
    </label>
    <div class="spoiler-composer-body" hidden>
      <div class="spoiler-composer-pickers" data-role="spoiler-pickers"></div>
      <div class="spoiler-composer-hint">${i18nT("Massimo {count} titoli. Verrà mostrato in chiaro solo a chi li ha completati.", { count: maxSelection })}</div>
    </div>
  `;

  const toggleInput = qs("[data-role='spoiler-toggle']", parentEl);
  const body = qs(".spoiler-composer-body", parentEl);
  const pickers = qs("[data-role='spoiler-pickers']", parentEl);

  function renderPickers() {
    if (!candidates.length) {
      pickers.innerHTML = `<div class="spoiler-composer-hint">${i18nT("Nessun titolo selezionabile. Verrà mostrato come spoiler a chi non l'ha visto.")}</div>`;
      return;
    }
    pickers.innerHTML = candidates
      .map((t) => {
        const id = String(t.id || "").trim();
        if (!id) return "";
        const isSelected = selected.has(id);
        const atCap = !isSelected && selected.size >= maxSelection;
        return `<button type="button" class="spoiler-composer-pick${isSelected ? " selected" : ""}"
            data-title-id="${escapeHtml(id)}"${atCap ? " disabled" : ""}>${escapeHtml(t.name || id)}</button>`;
      })
      .join("");
  }

  toggleInput.addEventListener("change", () => {
    containsSpoiler = !!toggleInput.checked;
    body.hidden = !containsSpoiler;
    if (containsSpoiler) renderPickers();
  });

  pickers.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-title-id]");
    if (!btn) return;
    const id = btn.getAttribute("data-title-id");
    if (!id) return;
    if (selected.has(id)) {
      selected.delete(id);
    } else if (selected.size < maxSelection) {
      selected.add(id);
    }
    renderPickers();
  });

  return {
    getState() {
      return {
        containsSpoiler,
        spoilerTitleIds: containsSpoiler ? Array.from(selected) : [],
      };
    },
    reset() {
      containsSpoiler = false;
      selected.clear();
      toggleInput.checked = false;
      body.hidden = true;
    },
    setCandidateTitles(titles) {
      candidates = Array.isArray(titles) ? titles : [];
      if (containsSpoiler) renderPickers();
    },
  };
}
