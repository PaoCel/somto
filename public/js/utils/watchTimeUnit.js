// Toggle unita' tempo di visione (card "Tempo di visione", box #watchTimeDigits)
// — persistito per device via localStorage, condiviso tra profilo proprio
// (account.page.js) e profilo altrui (user.page.js). Estratto per evitare due
// implementazioni divergenti della stessa formattazione (era duplicata solo
// in account.page.js, user.page.js aveva un rendering giorni/ore/min fisso).
import { escapeHtml } from "./dom.js";
import { t as i18nT, formatNumber } from "../i18n/index.js";

const WATCH_TIME_UNIT_STORAGE_KEY = "somto_watchtime_unit";

export const WATCH_TIME_UNIT_MODES = ["dhm", "hours", "days", "months", "years", "minutes", "binary"];

// Chiavi italiane, come ovunque: la traduzione avviene al momento dell'uso
// (le etichette finiscono nel markup, quindi non si possono tradurre qui una
// volta sola — la lingua puo' cambiare senza ricaricare il modulo).
const WATCH_TIME_UNIT_LABELS = {
  dhm: "giorni:ore:min",
  hours: "ore",
  days: "giorni",
  months: "mesi",
  years: "anni",
  minutes: "minuti",
  binary: "minuti in binario",
};

export function getWatchTimeUnitMode() {
  try {
    const stored = window.localStorage?.getItem(WATCH_TIME_UNIT_STORAGE_KEY);
    return WATCH_TIME_UNIT_MODES.includes(stored) ? stored : "dhm";
  } catch (_) {
    return "dhm";
  }
}

export function setWatchTimeUnitMode(mode) {
  if (!WATCH_TIME_UNIT_MODES.includes(mode)) return;
  try { window.localStorage?.setItem(WATCH_TIME_UNIT_STORAGE_KEY, mode); } catch (_) {}
}

// Passa alla prossima modalita' (wrap-around), la persiste e la ritorna.
export function cycleWatchTimeUnitMode() {
  const idx = WATCH_TIME_UNIT_MODES.indexOf(getWatchTimeUnitMode());
  const next = WATCH_TIME_UNIT_MODES[(idx + 1) % WATCH_TIME_UNIT_MODES.length];
  setWatchTimeUnitMode(next);
  return next;
}

export function watchTimeUnitLabel(mode) {
  return i18nT(WATCH_TIME_UNIT_LABELS[mode] || WATCH_TIME_UNIT_LABELS.dhm);
}

// Il separatore decimale cambia con la lingua (8,5 -> 8.5): niente "it-IT"
// fisso, si segue il locale corrente.
function formatWatchTimeDecimal(value) {
  return formatNumber(Math.round((Number(value) || 0) * 10) / 10, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

function watchTimeSingleUnitMarkup(value, label) {
  return `
    <div class="profile-watchtime-unit">
      <div class="profile-watchtime-value">${escapeHtml(String(value))}</div>
      <div class="profile-watchtime-label">${escapeHtml(label)}</div>
    </div>
  `;
}

// Markup di #watchTimeDigits secondo la modalita' scelta. "dhm" replica la
// tripletta originale giorni:ore:min, le altre modalita' sono un singolo
// valore + etichetta (incl. la "minuti in binario" scherzosa — base sui
// MINUTI totali, non le ore: un numero binario piu' lungo e divertente).
// Nessuna delle modalita' single-unit mostra i divider.
function watchTimeDigitsMarkup(totalMinutes, mode) {
  const min = Math.max(0, Number(totalMinutes || 0) || 0);
  switch (mode) {
    case "hours":
      return watchTimeSingleUnitMarkup(formatNumber(Math.round(min / 60)), i18nT("ore"));
    case "minutes":
      return watchTimeSingleUnitMarkup(formatNumber(Math.round(min)), i18nT("minuti"));
    case "days":
      return watchTimeSingleUnitMarkup(formatWatchTimeDecimal(min / 1440), i18nT("giorni"));
    case "months":
      return watchTimeSingleUnitMarkup(formatWatchTimeDecimal(min / 43830), i18nT("mesi"));
    case "years":
      return watchTimeSingleUnitMarkup(formatWatchTimeDecimal(min / 525960), i18nT("anni"));
    case "binary":
      return watchTimeSingleUnitMarkup(Math.round(min).toString(2), i18nT("minuti in binario"));
    case "dhm":
    default: {
      const days = Math.floor(min / 1440);
      const hours = Math.floor((min % 1440) / 60);
      const minutes = Math.floor(min % 60);
      return `
        <div class="profile-watchtime-unit">
          <div class="profile-watchtime-value">${days}</div>
          <div class="profile-watchtime-label">${i18nT("giorni")}</div>
        </div>
        <div class="profile-watchtime-divider">:</div>
        <div class="profile-watchtime-unit">
          <div class="profile-watchtime-value">${hours}</div>
          <div class="profile-watchtime-label">${i18nT("ore")}</div>
        </div>
        <div class="profile-watchtime-divider">:</div>
        <div class="profile-watchtime-unit">
          <div class="profile-watchtime-value">${minutes}</div>
          <div class="profile-watchtime-label">${i18nT("min")}</div>
        </div>
      `;
    }
  }
}

// Ricostruisce il contenuto di `digitsEl` (nodo #watchTimeDigits) secondo la
// modalita' scelta (default: preferenza persistita in localStorage) e, se
// passato, aggiorna `hintEl` con l'etichetta della modalita' corrente
// (scrive dentro `.profile-watchtime-unithint-text` se presente, altrimenti
// sull'intero nodo). Usato da account.page.js (profilo proprio) e
// user.page.js (profilo altrui).
export function renderWatchTimeInto(digitsEl, totalMinutes, mode = getWatchTimeUnitMode(), hintEl = null) {
  if (!digitsEl) return;
  digitsEl.innerHTML = watchTimeDigitsMarkup(totalMinutes, mode);
  digitsEl.removeAttribute("aria-busy");
  if (hintEl) {
    const label = i18nT("{v0} · tocca per cambiare", { v0: watchTimeUnitLabel(mode) });
    const textNode = hintEl.querySelector(".profile-watchtime-unithint-text");
    if (textNode) textNode.textContent = label;
    else hintEl.textContent = label;
  }
}
