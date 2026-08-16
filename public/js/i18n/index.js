// Motore i18n della PWA.
//
// Vincolo del progetto: niente framework, niente bundler, ES modules serviti
// cosi' come sono. Quindi niente librerie: il dizionario e' un oggetto piatto
// con chiavi puntate e `t()` fa interpolazione e plurali con le API native.
//
// Architettura (docs/I18N-ANALYSIS-2026-07-29.md, "Architettura: ibrido"):
// le pagine app private usano QUESTO dizionario a runtime, mentre le 14 pagine
// pubbliche indicizzabili vengono generate staticamente sotto /en/ — la' un
// dizionario runtime sarebbe un problema SEO (stessa URL per due lingue, testo
// che compare solo dopo il JS).
//
// Glossario e regole di traduzione: docs/I18N_GLOSSARY.md

import { it } from "./it.js";
import { en } from "./en.js";

const DICTS = { it, en };
export const SUPPORTED_LOCALES = ["it", "en"];
export const DEFAULT_LOCALE = "it";
const STORAGE_KEY = "somto.locale";

let currentLocale = DEFAULT_LOCALE;
const warned = new Set();

/** Normalizza "en-US" / "EN" / "en_GB" -> "en"; null se non supportata. */
function normalizeLocale(raw) {
  const base = String(raw || "").toLowerCase().replace("_", "-").split("-")[0];
  return SUPPORTED_LOCALES.includes(base) ? base : null;
}

/**
 * Sceglie la lingua: preferenza salvata > lingua del browser > italiano.
 * La preferenza dell'utente loggato vive su `usersPrivate/{uid}.language` e va
 * passata qui esplicitamente da chi ha la sessione: questo modulo non conosce
 * Firebase e non deve conoscerlo.
 */
export function resolveInitialLocale(preferred = null) {
  return (
    normalizeLocale(preferred) ||
    normalizeLocale(localStorage.getItem(STORAGE_KEY)) ||
    normalizeLocale(navigator.language) ||
    DEFAULT_LOCALE
  );
}

export function getLocale() {
  return currentLocale;
}

/** Imposta la lingua e la persiste. Non ri-renderizza: pensaci tu. */
export function setLocale(locale) {
  const next = normalizeLocale(locale) || DEFAULT_LOCALE;
  currentLocale = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Safari in navigazione privata: la lingua resta valida per la sessione.
  }
  document.documentElement.lang = next;
  return next;
}

/**
 * Va chiamato PRIMA di togliere `#appSplash`, altrimenti si vede un lampo di
 * italiano prima dello swap. Lo splash e' gia' su ogni pagina e fa da gate.
 */
export function initI18n(preferred = null) {
  // Le gemelle statiche sotto /en/ dichiarano lang="en" nel markup: lì la UI
  // iniettata a runtime (consent banner, toast) deve seguire la lingua della
  // PAGINA — un banner italiano su un URL che l'hreflang dichiara inglese è
  // mixed language. Forzatura SENZA persistenza: visitare /en/ non deve
  // cambiare la preferenza salvata per l'app. Le pagine app hanno lang="it"
  // statico, quindi all'init non passano mai da questo ramo.
  const pageLang = (document.documentElement.getAttribute("lang") || "").toLowerCase();
  if (pageLang.startsWith("en")) {
    currentLocale = "en";
    return "en";
  }
  return setLocale(resolveInitialLocale(preferred));
}

// Auto-inizializzazione all'import.
//
// Prima la lingua veniva decisa da `appShell.js`, ma NON tutte le pagine lo
// caricano — login.html, le landing, le admin, la 404 — e li' `t()` restava
// sull'italiano anche con la preferenza salvata su "en". Legare l'init a un
// componente e' fragile: qualunque modulo importi `t` deve trovare la lingua
// gia' decisa. Qui e' sincrono, quindi succede prima di qualunque render.
try {
  initI18n();
  // Stessa ragione per il markup statico: la traduzione dell'HTML era legata a
  // `appShell.js`, quindi 404, offline, login e le landing restavano italiane.
  // E' idempotente (vedi `applyStaticTranslations`), quindi chi la richiama
  // dopo un render proprio non fa danni.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => applyStaticTranslations(), { once: true });
  } else {
    applyStaticTranslations();
  }
} catch {
  // Ambienti senza DOM (test in Node): resta il default, nessun crash.
}

/**
 * Traduce.
 *
 * **La chiave e' la stringa italiana.** Stessa scelta del String Catalog su
 * iOS, e non e' una scorciatoia: il codice resta leggibile (`t("Salva")`
 * invece di `t("common.save")`), nessuno deve inventare e ricordare una
 * tassonomia di chiavi, e soprattutto **l'italiano non ha bisogno di
 * dizionario** — se la traduzione manca si mostra la chiave, che gia' e' il
 * testo giusto. Va popolato solo `en.js`.
 *
 * Il costo, dichiarato: ritoccare il copy italiano invalida la traduzione
 * perche' la chiave cambia. Accettabile, e si vede subito — la stringa torna
 * in italiano invece di sparire.
 *
 *   t("Salva")
 *   t("{count} voti", { count: 3 })         // plurale automatico su `count`
 *   t("{name} ti ha menzionato", { name })  // interpolazione
 */
export function t(key, vars = null) {
  // Anche l'italiano consulta il dizionario, ma solo perche' li' vivono le sue
  // forme plurali: "{count} voti" da solo renderebbe "1 voti". Per tutto il
  // resto il dizionario italiano e' vuoto e si cade sulla chiave.
  let entry = (DICTS[currentLocale] || {})[key];

  if (entry == null) {
    if (currentLocale !== DEFAULT_LOCALE && !warned.has(key)) {
      warned.add(key);
      console.warn(`[i18n] non tradotta in "${currentLocale}": ${JSON.stringify(key)}`);
    }
    return vars ? interpolate(key, vars) : key;
  }

  // Forma plurale: { one: "...", other: "..." } selezionata da `vars.count`.
  if (typeof entry === "object") {
    const count = Number(vars && vars.count);
    const rule = Number.isFinite(count)
      ? new Intl.PluralRules(currentLocale).select(count)
      : "other";
    entry = entry[rule] ?? entry.other ?? "";
  }

  return vars ? interpolate(entry, vars) : entry;
}

/** Sostituisce {segnaposto}. Lascia intatto cio' che non trova. */
function interpolate(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole
  );
}

// --- formattazione ---------------------------------------------------------
// Esistono perche' oggi ci sono 26 chiamate con "it-IT" hardcoded sparse nel
// codice: vanno sostituite con queste, che seguono la lingua corrente.

export function formatDate(date, options = { dateStyle: "medium" }) {
  return new Intl.DateTimeFormat(currentLocale, options).format(date);
}

export function formatNumber(value, options = undefined) {
  return new Intl.NumberFormat(currentLocale, options).format(value);
}

export function formatRelativeTime(value, unit, options = { numeric: "auto", style: "short" }) {
  return new Intl.RelativeTimeFormat(currentLocale, options).format(value, unit);
}

/** Timestamp Firestore, Date, numero o stringa -> millisecondi. 0 se non e' una data. */
function toMillis(value) {
  if (!value) return 0;
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  if (typeof value.seconds === "number") return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

/**
 * "5 min fa" / "5 min ago" — l'etichetta relativa di chat, notifiche e attivita'.
 *
 * Esiste perche' era scritta a mano in tre pagine diverse, con le parole
 * italiane dentro il codice ("min fa", "ieri", "sett fa"): con l'app in inglese
 * restavano italiane. Qui la fa `Intl.RelativeTimeFormat` sulla lingua corrente,
 * quindi ogni lingua futura arriva gratis.
 *
 * - `minUnit: "day"` parte dal giorno ("oggi" invece di "3 h fa"), per le liste
 *   di attivita' dove l'ora esatta non serve.
 * - `beyondWeek: "date"` dopo una settimana passa alla data breve (chat,
 *   notifiche); `"relative"` continua con settimane/mesi/anni.
 */
export function formatTimeAgo(value, { minUnit = "minute", beyondWeek = "date" } = {}) {
  const ms = toMillis(value);
  if (!ms) return "";
  const diff = Date.now() - ms;
  const days = Math.floor(diff / 86_400_000);

  if (minUnit !== "day") {
    if (diff < 60_000) return formatRelativeTime(0, "second");
    if (diff < 3_600_000) return formatRelativeTime(-Math.round(diff / 60_000), "minute");
    if (days < 1) return formatRelativeTime(-Math.round(diff / 3_600_000), "hour");
  } else if (days < 1) {
    return formatRelativeTime(0, "day");
  }

  if (days < 7) return formatRelativeTime(-days, "day");

  if (beyondWeek === "relative") {
    if (days < 30) return formatRelativeTime(-Math.floor(days / 7), "week");
    if (days < 365) return formatRelativeTime(-Math.floor(days / 30), "month");
    return formatRelativeTime(-Math.floor(days / 365), "year");
  }
  return formatDate(new Date(ms), { day: "numeric", month: "short" });
}

/**
 * Traduce il markup statico delle pagine.
 *
 * La chiave e' il testo italiano gia' presente nell'HTML, come nel JS:
 *
 *   <h1 data-i18n>Accedi</h1>
 *   <input data-i18n-attr="placeholder" placeholder="Cerca un titolo">
 *
 * Cosi' l'HTML resta leggibile, non c'e' una chiave da tenere allineata al
 * testo, e se la traduzione manca l'italiano e' gia' a schermo.
 *
 * Idempotente: la chiave originale viene memorizzata in `dataset.i18nSrc` al
 * primo passaggio, quindi ri-applicare dopo un cambio lingua non traduce una
 * traduzione.
 */
export function applyStaticTranslations(root = document) {
  const scope = root === document ? document.body || document : root;
  if (!scope || !scope.querySelectorAll) return;

  scope.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18nSrc ?? el.textContent.trim();
    if (!key) return;
    el.dataset.i18nSrc = key;
    el.textContent = t(key);
  });

  scope.querySelectorAll("[data-i18n-attr]").forEach((el) => {
    for (const attr of el.getAttribute("data-i18n-attr").split(",")) {
      const name = attr.trim();
      if (!name) continue;
      const stash = `i18nSrc_${name.replace(/-/g, "_")}`;
      const key = el.dataset[stash] ?? el.getAttribute(name);
      if (!key) continue;
      el.dataset[stash] = key;
      el.setAttribute(name, t(key));
    }
  });

  // Il <title> non e' nel body e non puo' portare attributi utili: si traduce
  // per chiave esplicita, memorizzata alla prima passata.
  if (root === document && document.title) {
    const el = document.documentElement;
    const key = el.dataset.i18nTitle ?? document.title;
    el.dataset.i18nTitle = key;
    document.title = t(key);
  }
}
