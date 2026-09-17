/**
 * quizUI.js — Kit visivo gaming condiviso per le pagine Quiz (web).
 * Helper DOM/HTML che replicano i componenti di QuizGamingKit.swift e
 * QuizHubComponents.swift: glow card, status pill, stat tile, XP badge,
 * streak chip, progress bar, podio, segmented control. Niente stato:
 * sono solo builder di markup riusati dai 6 controller Quiz.
 */

import { escapeHtml } from "../utils/dom.js";
import { t as i18nT } from "../i18n/index.js";

/* ===== Icone SVG (mappate dalle SF Symbols iOS) ===== */
export const ICONS = {
  controller: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 7h10a5 5 0 0 1 5 5v.4a4 4 0 0 1-7.2 2.4l-.5-.7a2 2 0 0 0-1.6-.8h-.4a2 2 0 0 0-1.6.8l-.5.7A4 4 0 0 1 2 12.4V12a5 5 0 0 1 5-5Zm.2 3.1v1.4H5.8v1.5h1.4v1.4h1.5V13h1.4v-1.5H8.7v-1.4H7.2Zm8.3.2a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm2 2.6a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z"/></svg>`,
  bolt: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"/></svg>`,
  flame: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c1.5 3 1 5-1 7-1.4 1.4-3 3-3 6a5 5 0 0 0 10 0c0-2-1-3.5-2-5 .3 2-1 3-2 3 .8-2 0-4-2-6 .5 3-1 4-2 5 0-3 3-7 4-10Z"/></svg>`,
  star: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="m12 2 3 6.3 6.9.9-5 4.8 1.3 6.9L12 17.8 5.8 21l1.3-6.9-5-4.8 6.9-.9L12 2Z"/></svg>`,
  scope: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/></svg>`,
  calendar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4.5" width="18" height="16" rx="2.5"/><line x1="3" y1="9.5" x2="21" y2="9.5"/><line x1="8" y1="2.5" x2="8" y2="6.5"/><line x1="16" y1="2.5" x2="16" y2="6.5"/></svg>`,
  trophy: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 3h12v3h3v2a4 4 0 0 1-4 4h-.3A6 6 0 0 1 13 17v2h3v2H8v-2h3v-2a6 6 0 0 1-3.7-2H7a4 4 0 0 1-4-4V6h3V3Zm0 5H5a2 2 0 0 0 1 1.7V8Zm12 0v1.7A2 2 0 0 0 19 8h-1Z"/></svg>`,
  crown: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="m3 7 4 4 5-7 5 7 4-4-2 12H5L3 7Zm2 14h14v2H5v-2Z"/></svg>`,
  medal: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 2h8l-2.5 7h-3L8 2Zm4 7a6 6 0 1 0 0 12 6 6 0 0 0 0-12Zm0 3.2 1.1 2.3 2.5.3-1.8 1.7.5 2.5L12 17.9l-2.3 1.2.5-2.5-1.8-1.7 2.5-.3L12 12.2Z"/></svg>`,
  people: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-8 1.6c-3 0-6 1.5-6 4.4V20h12v-3c0-2.9-3-4.4-6-4.4Zm8 .4c-.6 0-1.2.1-1.7.2 1 1 1.7 2.3 1.7 4.2V20h6v-2.6c0-2.5-3-4.4-6-4.4Z"/></svg>`,
  list: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3.5" cy="6" r="1.4" fill="currentColor"/><circle cx="3.5" cy="12" r="1.4" fill="currentColor"/><circle cx="3.5" cy="18" r="1.4" fill="currentColor"/></svg>`,
  timer: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="13" r="8"/><line x1="12" y1="13" x2="12" y2="8.5"/><line x1="9" y1="2.5" x2="15" y2="2.5"/></svg>`,
  shuffle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="M4 4l5 5"/></svg>`,
  play: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5 19 12 7 19.5v-15Z"/></svg>`,
  chevron: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 5 16 12 9 19"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  checkCircle: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1.2 14.3-4-4 1.4-1.4 2.6 2.6 5.6-5.6 1.4 1.4-7 7Z"/></svg>`,
  xCircle: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm3.5 12.1-1.4 1.4L12 13.4l-2.1 2.1-1.4-1.4L10.6 12 8.5 9.9l1.4-1.4L12 10.6l2.1-2.1 1.4 1.4L13.4 12l2.1 2.1Z"/></svg>`,
  forward: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-3 6 5 4-5 4V8Zm6 0h1.6v8H15V8Z"/></svg>`,
  minusCircle: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-5 9h10v2H7v-2Z"/></svg>`,
  gift: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 7h-2.2A3 3 0 0 0 12 3.5 3 3 0 0 0 6.2 7H4a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1h7V7h2v5h7a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1ZM9 7a1 1 0 1 1 2 0H9Zm4 0a1 1 0 1 1 2 0h-2ZM5 14v6a1 1 0 0 0 1 1h5v-7H5Zm8 7h5a1 1 0 0 0 1-1v-6h-6v7Z"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2 4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5l-8-3Z"/></svg>`,
  film: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm1 3v2h2V6H5Zm12 0v2h2V6h-2ZM5 11v2h2v-2H5Zm12 0v2h2v-2h-2ZM5 16v2h2v-2H5Zm12 0v2h2v-2h-2Z"/></svg>`,
  tv: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 5h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm5 14h8v2H8v-2Z"/></svg>`,
  filmStack: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 4h14a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm-1 16h16v-1.5H4V20Z"/></svg>`,
  warn: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2 1 21h22L12 2Zm0 6 .9 8h-1.8L12 8Zm0 10a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6Z"/></svg>`,
  hourglass: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 2h12v2c0 3-2 5-4 6 2 1 4 3 4 6v2H6v-2c0-3 2-5 4-6-2-1-4-3-4-6V2Z"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 16 14"/></svg>`,
  link: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>`,
  paperplane: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 11 21 3l-8 18-2.5-7L3 11Z"/></svg>`,
  share: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  plusCircle: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 9h4v2h-4v4h-2v-4H7v-2h4V7h2v4Z"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.7" y2="16.7"/></svg>`,
  back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 5 8 12 15 19"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>`,
  equal: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="5" y1="9" x2="19" y2="9"/><line x1="5" y1="15" x2="19" y2="15"/></svg>`,
  speedometer: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 18a8 8 0 1 1 16 0"/><line x1="12" y1="18" x2="16" y2="11"/></svg>`,
  flag: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 3v18H3.4V3H5Zm1.5 1h13l-2.5 4 2.5 4h-13V4Z"/></svg>`,
  reportBubble: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11 7.4L3 21l1.6-7A8 8 0 1 1 21 12Z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="15.5" x2="12" y2="15.6"/></svg>`,
  inbox: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13l3.5 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6Z"/></svg>`,
  popcorn: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 9h12l-1.4 12H7.4L6 9Zm.5-2a2.5 2.5 0 0 1 4.7-1.2A2.5 2.5 0 0 1 16 5a2.5 2.5 0 0 1 2 4H6.2A2.4 2.4 0 0 1 6.5 7Z"/></svg>`,
  bulb: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a7 7 0 0 0-4 12.7V17a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-2.3A7 7 0 0 0 12 2ZM9.5 21h5v.5a1.5 1.5 0 0 1-1.5 1.5h-2a1.5 1.5 0 0 1-1.5-1.5V21Z"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  seal: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="m12 2 2.4 1.7 2.9-.4 1.1 2.7 2.6 1.3-.4 2.9L22 16l-1.8 2.3.4 2.9-2.6 1.3-1.1 2.4-2.9-.4L12 26l-2-1.8-2.9.4-1.1-2.4L3.4 21l.4-2.9L2 16l1.8-2.6-.4-2.9 2.6-1.3 1.1-2.7 2.9.4L12 2Zm-1 13.4 5-5-1.4-1.4-3.6 3.6L9.4 13 8 14.4l3 3Z"/></svg>`,
  qmark: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 16.4a1.35 1.35 0 1 1 0-2.7 1.35 1.35 0 0 1 0 2.7Zm1.8-6.3c-.8.5-1 .9-1 1.6v.3h-1.8v-.5c0-1.2.4-1.9 1.4-2.5.7-.5 1-.8 1-1.4 0-.7-.5-1.1-1.3-1.1-.8 0-1.3.4-1.5 1.3l-1.7-.6C9.1 7.3 10.3 6.4 12 6.4c2 0 3.3 1.1 3.3 2.7 0 1.2-.5 1.9-1.5 2.5Z"/></svg>`,
  person2plus: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm0 1.6c-3 0-6 1.5-6 4.4V20h12v-3c0-2.9-3-4.4-6-4.4ZM18 8V5.5h2V8h2.5v2H20v2.5h-2V10h-2.5V8H18Z"/></svg>`,
  wifiOff: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12.5a10 10 0 0 1 14 0"/><path d="M8.5 16a5 5 0 0 1 7 0"/><line x1="12" y1="20" x2="12" y2="20.1" stroke-width="3"/><line x1="3" y1="3" x2="21" y2="21"/></svg>`,
};

/** Punteggio formattato: intero se .0, altrimenti 1 decimale (come iOS formatScore). */
export function formatScore(score) {
  const n = Number(score) || 0;
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** Iniziale maiuscola di un nome (fallback avatar). */
export function initial(name) {
  const raw = String(name || "").trim();
  return raw ? raw[0].toUpperCase() : "?";
}

/* ===== Builder componenti gaming ===== */

/** XP badge "+N XP" / "N XP". (QuizXPBadge) */
export function xpBadge(xp, { showsPlus = true, regular = false, pop = false } = {}) {
  const cls = ["quiz-xp-badge"];
  if (regular) cls.push("is-regular");
  if (pop) cls.push("is-pop");
  const label = showsPlus ? `+${xp} XP` : `${xp} XP`;
  return `<span class="${cls.join(" ")}">${ICONS.bolt}<span>${escapeHtml(label)}</span></span>`;
}

/** Streak chip fiamma. (QuizStreakChip) */
export function streakChip(count, { isDaily = true } = {}) {
  const text = isDaily
    ? i18nT("{count} {v0} di fila", { count, v0: count === 1 ? "giorno" : "giorni" })
    : i18nT("{count} di fila", { count });
  return `<span class="quiz-streak-chip">${ICONS.flame}<span>${escapeHtml(text)}</span></span>`;
}

/** Status pill colorata. (QuizStatusPill) */
export function statusPill(label, { tint = "var(--accent)", icon = null, filled = false } = {}) {
  const cls = ["quiz-status-pill"];
  if (filled) cls.push("is-filled");
  const glyph = icon ? ICONS[icon] || "" : "";
  return `<span class="${cls.join(" ")}" style="--quiz-pill-tint:${tint}">${glyph}<span>${escapeHtml(label)}</span></span>`;
}

/** Progress bar premium. (QuizProgressBar) */
export function progressBar(value, { slim = false, variant = "" } = {}) {
  const pct = Math.min(100, Math.max(0, Number(value) || 0) * 100);
  const fillCls = ["quiz-progress-fill"];
  if (pct <= 0) fillCls.push("is-zero");
  if (variant === "success") fillCls.push("fill-success");
  if (variant === "warm") fillCls.push("fill-warm");
  return `<div class="quiz-progress${slim ? " is-slim" : ""}"><div class="${fillCls.join(" ")}" style="width:${pct}%"></div></div>`;
}

/** Stat tile icona+valore+label. (QuizStatTile) */
export function statTile({ label, value, icon, accent = "var(--accent)", sublabel = "" }) {
  return `
    <div class="quiz-stat-tile" style="--quiz-tile-accent:${accent}">
      <span class="quiz-stat-icon">${ICONS[icon] || ""}</span>
      <div>
        <div class="quiz-stat-value">${escapeHtml(String(value))}</div>
        <div class="quiz-stat-label">${escapeHtml(label)}</div>
        ${sublabel ? `<div class="quiz-stat-sublabel">${escapeHtml(sublabel)}</div>` : ""}
      </div>
    </div>`;
}

/** Markup avatar circolare con fallback iniziale. */
export function avatarMarkup(photoURL, name, { className = "", gradientFallback = false } = {}) {
  const url = String(photoURL || "").trim();
  if (url) {
    return `<img class="${className}" src="${escapeHtml(url)}" alt="" loading="lazy">`;
  }
  return `<span class="${className} quiz-avatar-fallback${gradientFallback ? " is-gradient" : ""}">${escapeHtml(initial(name))}</span>`;
}

/** Stato di caricamento centrato. */
export function loadingState(text = "Carico…") {
  return `<div class="quiz-loading"><div class="quiz-spinner"></div><div class="quiz-loading-text">${escapeHtml(text)}</div></div>`;
}

/** Stato vuoto con icona + titolo + messaggio + azione opzionale. */
export function emptyState({ icon = "inbox", title, message, actionLabel = "", actionId = "" }) {
  const action = actionLabel
    ? `<button type="button" class="btn primary small" id="${escapeHtml(actionId)}">${escapeHtml(actionLabel)}</button>`
    : "";
  return `
    <div class="quiz-empty">
      ${ICONS[icon] || ICONS.inbox}
      <div class="title">${escapeHtml(title)}</div>
      ${message ? `<div class="desc">${escapeHtml(message)}</div>` : ""}
      ${action}
    </div>`;
}

/** Stato di errore con retry. */
export function errorState({ title = i18nT("Qualcosa è andato storto"), message = "", retryId = "quizRetry" }) {
  return `
    <div class="quiz-error">
      ${ICONS.warn}
      <div class="title">${escapeHtml(title)}</div>
      ${message ? `<div class="desc">${escapeHtml(message)}</div>` : ""}
      <button type="button" class="btn primary small" id="${escapeHtml(retryId)}">${i18nT("Riprova")}</button>
    </div>`;
}
