/**
 * import.page.js — Import cronologia visioni (Netflix CSV / TV Time GDPR /
 * TV Time Refract).
 * URL: /import.html (autenticazione richiesta, come le altre pagine in-app).
 *
 * Sorgenti supportate:
 *   - "tvtime_gdpr" (default, in evidenza — TV Time chiude il 15/07): l'export
 *     "Richiedi i tuoi dati" di TV Time è uno ZIP con ~20 CSV. Somto estrae
 *     SOLO i 2 file che servono (tracking-prod-records.csv film,
 *     tracking-prod-records-v2.csv serie) interamente nel browser
 *     (tvTimeZip.js) — tutto il resto (email, hash password, IP, ...) non
 *     lascia mai il device.
 *   - "tvtime_refract": export dell'estensione opensource Refract ("TV Time
 *     Out"), ZIP con 3 JSON (film/serie/liste) + 1 HTML riepilogo. STESSO
 *     dropzone della sorgente TV Time sopra (autodetect: se lo ZIP non
 *     contiene i 2 CSV GDPR, si prova il pattern Refract — nome file con
 *     data variabile, es. "tvtime-movies-2026-07-06.json"). Matching
 *     automatico identico a tvtime_gdpr (stessa pipeline parse->match->write,
 *     vedi finalizeImportResults in functions/index.js); l'UNICA differenza è
 *     il trasporto — upload diretto a Storage (createTitlesImportUploadSession
 *     + uploadTitlesImportJsonFiles + finalizeTitlesImportUpload) invece del
 *     body della callable, perché i JSON Refract possono superare 1MB
 *     (limite doc Firestore) su librerie grandi. Nessun voto/recensione in
 *     questo formato (Refract non li esporta).
 *     Se l'estrazione ZIP fallisce per uno dei due formati (browser senza
 *     DecompressionStream, formato inatteso), fallback: carica i file
 *     singoli (CSV per GDPR, JSON per Refract).
 *   - "netflix_csv": export "Attività di visualizzazione" di Netflix.
 *
 * Flusso:
 *   1) selettore sorgente -> file picker -> preview client best-effort
 *      (conteggi, NON autorevole)
 *   2) invio a startTitlesImport (netflix_csv/tvtime_gdpr, dryRun:false) o
 *      alla sessione di upload Storage (tvtime_refract) -> progress via
 *      onSnapshot su users/{uid}/imports/{importId}
 *   3) riepilogo automatico (match alta confidenza già scritti)
 *   4) coda di conferma per le righe non risolte (ricerca titolo + skip)
 *   5) riepilogo finale + link watchlist
 *
 * Il parsing/matching autorevole avviene SEMPRE server-side per tutte e 3 le
 * sorgenti; il client non decide nulla.
 */

import { initAuthGuard } from "../components/authGuard.js";
import { t as i18nT } from "../i18n/index.js";
import { escapeHtml } from "../utils/dom.js";
import { toast } from "../components/toast.js";
import { previewNetflixCsv } from "../utils/netflixCsvPreview.js";
import { previewTvTimeCsvs } from "../utils/tvTimeCsvPreview.js";
import { extractZipEntries, extractZipEntriesByPattern } from "../utils/tvTimeZip.js";
import { searchTitlesSmart } from "../api/titles.api.js";
import { registerPushToken } from "../pushTokens.js";
import { ensureMySupportThread } from "../api/threads.api.js";
import { mountNotificationPermissionBanner } from "../components/notifyPermissionBanner.js";
import {
  startTitlesImport,
  createTitlesImportUploadSession,
  uploadTitlesImportJsonFiles,
  uploadTitlesImportFiles,
  finalizeTitlesImportUpload,
  onImportJobChange,
  getActiveImport,
  retryTitlesImport,
  listUnresolvedImportItems,
  confirmTitlesImport,
  startTraktConnect,
  pollTraktConnect,
  startTraktImport,
} from "../api/imports.api.js?v=138-2026-07-27-safe-confirmation";
import { logEvent } from "../analytics.js";
import { trackProductEvent } from "../api/productAnalytics.js";

// Oltre questa soglia (byte UTF-8 del payload grezzo) il body callable non
// regge (doc Firestore 1MB) → si passa al trasporto via Storage. Tenuto sotto
// la guardia server (900KB su startTitlesImport) con margine per l'overhead di
// JSON-stringify della callable.
const IMPORT_INLINE_MAX_BYTES = 700 * 1024;
function utf8Bytes(str) {
  return str ? new TextEncoder().encode(str).length : 0;
}

/* ═══════════════════ state ═══════════════════ */

let currentUid = null;
let currentUser = null;
let currentImportId = null;
let jobUnsub = null;
let unresolvedItems = [];
// itemId -> { titleId, titleName } | { skip: true }
const resolutionsPicked = new Map();
let searchSeq = 0;
// "tvtime_gdpr" in evidenza: TV Time chiude il 15/07/2026, priorità massima.
// L'onboarding v2 arriva qui con la sorgente gia' scelta nella schermata
// d'ingresso (?source=), cosi' l'utente non la ripete (docs/ONBOARDING_V2.md).
const IMPORT_PAGE_PARAMS = new URLSearchParams(location.search || "");
const VALID_SOURCES = ["tvtime_gdpr", "netflix_csv", "trakt", "letterboxd"];
const REQUESTED_SOURCE = String(IMPORT_PAGE_PARAMS.get("source") || "").trim();
/** True quando si arriva dal funnel onboarding: il rientro torna in Home,
 *  dove il flusso riprende dagli step invece di lasciare l'utente qui. */
const FROM_ONBOARDING = IMPORT_PAGE_PARAMS.get("onboarding") === "1";
let selectedSource = VALID_SOURCES.includes(REQUESTED_SOURCE) ? REQUESTED_SOURCE : "tvtime_gdpr";
// Tracks which ACTUAL source a running/last-started TV Time import used —
// distinct from `selectedSource` (the tab), since the TV Time tab autodetects
// between "tvtime_gdpr" and "tvtime_refract" from the uploaded file. Used to
// gate copy that only applies to one of the two (e.g. the ratings-conversion
// note: Refract carries no votes/reviews at all).
let startedImportSource = null;

// Stato del collegamento Trakt (OAuth device flow) per la tab "Trakt". Vive
// solo in memoria: se l'utente lascia la pagina a metà collegamento, ricomincia
// (nessun dato sensibile lato client, il device_code resta server-side).
let traktPollTimer = null;
let traktPollDeadline = 0; // Date.now() oltre il quale fermarsi (expiresIn)

const TV_TIME_MOVIES_FILENAME = "tracking-prod-records.csv";
const TV_TIME_SERIES_FILENAME = "tracking-prod-records-v2.csv";
// Optional (votes + reviews) — absence never blocks the core import.
const TV_TIME_EPISODE_VOTES_FILENAME = "ratings-3-prod-episode_votes.csv";
// TV Time "emotions" per i film (contento/annoiato/…): il server le tratta
// come EMOZIONI, non come voti stellati (stashate a parte).
const TV_TIME_MOVIE_VOTES_FILENAME = "emotions-live-votes.csv";
// I voti stellati veri dei film (le stelle TV Time → decimi Somto) stanno qui,
// in un file separato dalle emozioni sopra.
const TV_TIME_MOVIE_RATINGS_FILENAME = "ratings-live-votes.csv";
const TV_TIME_MOVIE_COMMENTS_FILENAME = "comments-prod-comments.csv";
const TV_TIME_EPISODE_COMMENTS_FILENAME = "episode_comment.csv";
const TV_TIME_LISTS_FILENAME = "lists-prod-lists.csv";
// I voti dati alle SERIE (stelle TV Time). Su un account vecchio e' l'unico
// voto presente: i voti per episodio sono arrivati dopo.
const TV_TIME_SHOW_RATINGS_FILENAME = "tv_show_rate.csv";
const TV_TIME_ALL_TARGET_FILENAMES = [
  TV_TIME_MOVIES_FILENAME,
  TV_TIME_SERIES_FILENAME,
  TV_TIME_EPISODE_VOTES_FILENAME,
  TV_TIME_MOVIE_VOTES_FILENAME,
  TV_TIME_MOVIE_RATINGS_FILENAME,
  TV_TIME_MOVIE_COMMENTS_FILENAME,
  TV_TIME_EPISODE_COMMENTS_FILENAME,
  TV_TIME_LISTS_FILENAME,
  TV_TIME_SHOW_RATINGS_FILENAME,
];

// Refract ("TV Time Out") export file names embed the export date
// (tvtime-movies-2026-07-06.json), so — unlike the GDPR CSVs above — these
// are matched by prefix/suffix, not exact name (see extractZipEntriesByPattern).
const REFRACT_ZIP_PATTERNS = [
  { key: "movies", prefix: "tvtime-movies-", suffix: ".json" },
  { key: "series", prefix: "tvtime-series-", suffix: ".json" },
];

const root = document.getElementById("importRoot");

/* ═══════════════════ helpers ═══════════════════ */

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (v == null) return;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  });
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c == null) return;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  });
  return node;
}

function formatRowLabel(item) {
  const kindLabel = item.kind === "movie" ? i18nT("Film") : item.kind === "tv_episode" ? i18nT("Serie") : "Da verificare";
  const detail = item.seriesNameGuess || item.movieNameGuess || item.rawTitle;
  return { kindLabel, detail };
}

// Bucketizza un conteggio per l'analytics (PII-free, niente numeri esatti che
// potrebbero identificare una libreria specifica).
function bucketCount(n) {
  const num = Number(n) || 0;
  if (num <= 0) return "0";
  if (num < 10) return "1_9";
  if (num < 50) return "10_49";
  if (num < 200) return "50_199";
  if (num < 1000) return "200_999";
  return "1000_plus";
}

function previewRefractArray(rawText) {
  if (!rawText || !rawText.trim()) return [];
  try {
    const parsed = JSON.parse(rawText);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function previewTvTimeRefractStandby({ moviesJson, seriesJson }) {
  const movies = previewRefractArray(moviesJson);
  const series = previewRefractArray(seriesJson);
  let moviesWatched = 0;
  let moviesWatchlist = 0;
  let episodesWatched = 0;
  let seriesWatchlist = 0;

  movies.forEach((entry) => {
    if (!String(entry?.title || "").trim()) return;
    if (entry?.is_watched === true) moviesWatched += 1;
    else moviesWatchlist += 1;
  });
  series.forEach((show) => {
    if (!String(show?.title || "").trim()) return;
    const seasons = Array.isArray(show?.seasons) ? show.seasons : [];
    let hasWatched = false;
    seasons.forEach((season) => {
      const episodes = Array.isArray(season?.episodes) ? season.episodes : [];
      episodes.forEach((episode) => {
        if (episode?.is_watched === true) {
          episodesWatched += 1;
          hasWatched = true;
        }
      });
    });
    if (!hasWatched) seriesWatchlist += 1;
  });

  const total = moviesWatched + moviesWatchlist + episodesWatched + seriesWatchlist;
  return { moviesWatched, moviesWatchlist, episodesWatched, seriesWatchlist, total };
}

/* ═══════════════════ step 1: selettore sorgente + file picker + preview ═══════════════════ */

// Loghi brand delle sorgenti import: chip SVG inline (nessun hotlink esterno),
// colore ufficiale del brand + monogramma bianco → riconoscibili a colpo
// d'occhio nei tab del selettore (come i loghi provider nella watchlist).
// Marchi delle sorgenti import, disegnati inline: nessun hotlink e nessun file
// di terzi nel repo. Servono a far riconoscere il servizio a colpo d'occhio —
// il monogramma generico di prima sembrava un bottone rotto.
const IMPORT_SOURCE_BRANDS = {
  tvtime_gdpr: { label: "TV Time" },
  netflix_csv: { label: "Netflix" },
  trakt: { label: "Trakt" },
  letterboxd: { label: "Letterboxd" },
};

function sourceLogoSvg(sourceKey) {
  const open = (label) => `<svg viewBox="0 0 40 40" width="26" height="26" role="img" aria-label="${label}" focusable="false">`;

  if (sourceKey === "tvtime_gdpr") {
    return `${open("TV Time")}<rect width="40" height="40" rx="9" fill="#F0264B"/>`
      + `<text x="20" y="21" text-anchor="middle" dominant-baseline="central"`
      + ` font-family="'Helvetica Neue',Arial,sans-serif" font-weight="800" font-size="17" fill="#fff">tv</text>`
      + `</svg>`;
  }

  if (sourceKey === "netflix_csv") {
    // La "N" a nastro: due montanti e la diagonale che li unisce.
    return `${open("Netflix")}<rect width="40" height="40" rx="9" fill="#000"/>`
      + `<path d="M11.5 7h5.4l7.6 20.4V7h5.4v26h-5.4L16.9 12.4V33h-5.4Z" fill="#E50914"/>`
      + `<path d="M11.5 7h5.4l7.6 20.4V7h1.1v26h-1.1L16.9 12.4V33h-5.4Z" fill="#B1060F" opacity=".55"/>`
      + `</svg>`;
  }

  if (sourceKey === "trakt") {
    return `${open("Trakt")}<circle cx="20" cy="20" r="20" fill="#ED1C24"/>`
      + `<path d="M11.6 27.7 24.2 15.1l-2.3-2.3L9.3 25.4a11.7 11.7 0 0 1-.9-3.1l11-11a11.6 11.6 0 0 1 3.6.2L8.9 26.6a11.6 11.6 0 0 1-.5-1"`
      + ` fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round"/>`
      + `<path d="m17.8 20.9 9.6 9.6" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round"/>`
      + `<path d="m21.1 17.6 9.6 9.6" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round"/>`
      + `</svg>`;
  }

  if (sourceKey === "letterboxd") {
    // I tre pallini sovrapposti: arancio, verde, blu su fondo notte.
    return `${open("Letterboxd")}<rect width="40" height="40" rx="9" fill="#14181C"/>`
      + `<circle cx="13" cy="20" r="7.4" fill="#FF8000"/>`
      + `<circle cx="27" cy="20" r="7.4" fill="#40BCF4"/>`
      + `<circle cx="20" cy="20" r="7.4" fill="#00E054"/>`
      + `<circle cx="16.5" cy="20" r="3.6" fill="#8AA33F"/>`
      + `<circle cx="23.5" cy="20" r="3.6" fill="#20CE9A"/>`
      + `</svg>`;
  }

  return "";
}

function brandLogoEl(sourceKey) {
  return el("span", { class: "imp-source-logo", html: sourceLogoSvg(sourceKey), "aria-hidden": "true" });
}

function renderSourceSelector() {
  const wrap = el("div", { class: "imp-source-selector", role: "tablist", "aria-label": "Sorgente import" });

  const tvTimeBtn = el("button", {
    type: "button",
    class: `imp-source-tab${selectedSource === "tvtime_gdpr" ? " is-active" : ""}`,
    role: "tab",
    "aria-selected": selectedSource === "tvtime_gdpr" ? "true" : "false",
  }, [
    brandLogoEl("tvtime_gdpr"),
    el("strong", {}, "TV Time"),
  ]);
  const netflixBtn = el("button", {
    type: "button",
    class: `imp-source-tab${selectedSource === "netflix_csv" ? " is-active" : ""}`,
    role: "tab",
    "aria-selected": selectedSource === "netflix_csv" ? "true" : "false",
  }, [
    brandLogoEl("netflix_csv"),
    el("strong", {}, "Netflix"),
  ]);
  const traktBtn = el("button", {
    type: "button",
    class: `imp-source-tab${selectedSource === "trakt" ? " is-active" : ""}`,
    role: "tab",
    "aria-selected": selectedSource === "trakt" ? "true" : "false",
  }, [
    brandLogoEl("trakt"),
    el("strong", {}, "Trakt"),
  ]);
  const letterboxdBtn = el("button", {
    type: "button",
    class: `imp-source-tab${selectedSource === "letterboxd" ? " is-active" : ""}`,
    role: "tab",
    "aria-selected": selectedSource === "letterboxd" ? "true" : "false",
  }, [
    brandLogoEl("letterboxd"),
    el("strong", {}, "Letterboxd"),
  ]);

  tvTimeBtn.addEventListener("click", () => {
    if (selectedSource === "tvtime_gdpr") return;
    stopTraktPolling();
    selectedSource = "tvtime_gdpr";
    renderPickerStep();
  });
  netflixBtn.addEventListener("click", () => {
    if (selectedSource === "netflix_csv") return;
    stopTraktPolling();
    selectedSource = "netflix_csv";
    renderPickerStep();
  });
  traktBtn.addEventListener("click", () => {
    if (selectedSource === "trakt") return;
    selectedSource = "trakt";
    renderPickerStep();
  });
  letterboxdBtn.addEventListener("click", () => {
    if (selectedSource === "letterboxd") return;
    stopTraktPolling();
    selectedSource = "letterboxd";
    renderPickerStep();
  });

  wrap.appendChild(tvTimeBtn);
  wrap.appendChild(netflixBtn);
  wrap.appendChild(traktBtn);
  wrap.appendChild(letterboxdBtn);
  return wrap;
}

function renderPrivacyNote() {
  return el("div", { class: "imp-privacy-note" }, [
    el("span", { class: "imp-privacy-icon", "aria-hidden": "true" }, "🔒"),
    el("p", {}, [
      el("strong", {}, i18nT("Leggiamo solo la cronologia: ")),
      i18nT("email, password e altri dati personali non lasciano il tuo dispositivo."),
    ]),
  ]);
}

function renderLetterboxdPrivacyNote() {
  return el("div", { class: "imp-privacy-note" }, [
    el("span", { class: "imp-privacy-icon", "aria-hidden": "true" }, "🔒"),
    el("p", {}, [
      el("strong", {}, i18nT("Il tuo ZIP completo viene caricato su Somto.")),
      " ",
      i18nT("Usiamo solo film visti, voti, watchlist, date e rewatch."),
      " ",
      i18nT("Non importiamo recensioni, commenti o dati del profilo."),
      " ",
      i18nT("Eliminiamo il file dopo che l'import è riuscito."),
    ]),
  ]);
}

/* --------------------------- step numerati riusabili --------------------------- */

function buildStepRow(number, textOrNode, extraNode) {
  const row = el("div", { class: "imp-step-row" }, [
    el("span", { class: "imp-step-number", "aria-hidden": "true" }, String(number)),
    el("div", { class: "imp-step-copy" }, [
      typeof textOrNode === "string" ? el("p", {}, textOrNode) : textOrNode,
      extraNode || null,
    ]),
  ]);
  return row;
}

function buildStepsList(rows) {
  return el("div", { class: "imp-steps" }, rows);
}

function renderSupportChatLink(uid) {
  const link = el("a", {
    class: "imp-support-link",
    href: `/thread.html?id=support_${encodeURIComponent(uid)}`,
  }, [
    el("span", { "aria-hidden": "true" }, "💬"),
    i18nT("Problemi con l'export? Scrivici in chat, ti aiutiamo noi."),
  ]);
  link.addEventListener("click", async (event) => {
    event.preventDefault();
    link.setAttribute("aria-busy", "true");
    const originalText = link.textContent;
    link.textContent = i18nT("Apro la chat di assistenza…");
    try {
      const res = await ensureMySupportThread();
      const threadId = res?.threadId || `support_${uid}`;
      window.location.href = `/thread.html?id=${encodeURIComponent(threadId)}`;
    } catch (err) {
      console.error("[import] ensure support thread failed", err);
      toast(i18nT("Non riesco ad aprire la chat adesso. Puoi scriverci da support@somto.it."), "Assistenza", { timeout: 5000 });
      link.textContent = originalText;
      link.removeAttribute("aria-busy");
    }
  });
  return link;
}

function renderTvTimeRatingConversionNote() {
  return el("div", { class: "imp-rating-note" }, [
    el("span", { "aria-hidden": "true" }, "⭐"),
    el("p", {}, [
      i18nT("Su Somto i voti sono in decimi: quello che su TV Time era "),
      el("strong", {}, "«Bello»"),
      " diventa 7, ",
      el("strong", {}, "«Super»"),
      " 9, ",
      el("strong", {}, "«Wow»"),
      " 10, ",
      el("strong", {}, "«Ok»"),
      " 6, ",
      el("strong", {}, "«Brutto»"),
      i18nT(" 4. Potrai sempre modificarli. Importiamo anche recensioni, rewatch e watchlist."),
    ]),
  ]);
}

function renderPickerStep() {
  if (selectedSource === "tvtime_gdpr") {
    renderTvTimePickerStep();
  } else if (selectedSource === "trakt") {
    renderTraktPickerStep();
  } else if (selectedSource === "letterboxd") {
    renderLetterboxdPickerStep();
  } else {
    renderNetflixPickerStep();
  }
}

function buildOptionsBox(rewatchCopy) {
  return el("div", { class: "imp-options" }, [
    el("label", { class: "imp-toggle" }, [
      el("input", { type: "checkbox", id: "impCountExistingAsRewatch" }),
      el("span", { class: "imp-toggle-ui", "aria-hidden": "true" }),
      el("span", { class: "imp-toggle-copy" }, [
        el("strong", {}, i18nT("Conta come rewatch anche i titoli già visti su Somto")),
        el("small", {}, i18nT("Lascia spento se li avevi già segnati a mano e vuoi evitare doppi conteggi.")),
      ]),
    ]),
    el("p", { class: "imp-options-note" }, rewatchCopy),
  ]);
}

// Nota informativa (solo TV Time): i commenti-episodio fanno parte dell'export
// e li importiamo insieme al resto (niente più toggle di consenso → meno
// attrito). La ripubblicazione come discussioni resta comunque dietro revisione
// manuale: non è automatica né garantita, quindi la disclosure è doverosa.
function buildCommentConsentBox() {
  return el("div", { class: "imp-options" }, [
    el("div", { class: "imp-toggle-copy imp-note" }, [
      el("strong", {}, i18nT("Importiamo anche i tuoi commenti")),
      el("small", {}, i18nT("Se avevi scritto commenti sugli episodi, li importiamo e proviamo a riportarli su Somto come tue discussioni. Non è automatico né garantito: passano da una revisione prima di essere pubblicati.")),
    ]),
  ]);
}

/* --------------------------- TV Time (GDPR export) --------------------------- */

function renderTvTimePickerStep() {
  root.innerHTML = "";
  root.appendChild(el("header", { class: "imp-page-header" }, [
    el("h1", {}, "Importa da TV Time"),
    el("p", {}, i18nT("TV Time chiude il 15 luglio: importa ora la tua cronologia film e serie, watchlist inclusa.")),
  ]));

  const card = el("section", { class: "imp-card" });
  card.appendChild(renderSourceSelector());
  card.appendChild(renderPrivacyNote());

  card.appendChild(buildStepsList([
    buildStepRow(1, el("p", {}, [
      i18nT("Apri "),
      el("a", { class: "imp-step-inline-link", href: "https://gdpr.tvtime.com/gdpr/self-service", target: "_blank", rel: "noopener" }, "gdpr.tvtime.com/gdpr/self-service"),
      i18nT(" e richiedi l'export. Riceverai una mail con lo ZIP."),
    ])),
    buildStepRow(2, el("div", { class: "imp-social-account-note" }, [
      el("span", { "aria-hidden": "true" }, "ℹ️"),
      el("p", {}, [
        el("strong", {}, i18nT("Account TV Time creato con Google o Apple? ")),
        i18nT("Per scaricare l'export ti serve una password: nella stessa pagina della richiesta dati inserisci la tua email nel campo in fondo — ricevi una mail per impostarla, poi puoi scaricare i file."),
      ]),
    ])),
    buildStepRow(3, i18nT("Carica qui lo ZIP ricevuto: lo riconosciamo automaticamente.")),
  ]));

  const dropzone = el("label", { class: "imp-dropzone", for: "importZipInput" }, [
    el("div", { class: "imp-dropzone-icon" }, "⬆"),
    el("strong", {}, i18nT("Carica l'export dei tuoi dati (.zip)")),
    el("small", {}, i18nT("TV Time: gdpr.tvtime.com/gdpr/self-service (o l'estensione Refract \"TV Time Out\") → scarica lo ZIP ricevuto")),
  ]);
  const zipInput = el("input", {
    type: "file",
    id: "importZipInput",
    accept: ".zip,application/zip",
    style: "display:none",
  });
  dropzone.appendChild(zipInput);
  card.appendChild(dropzone);

  const fallbackToggle = el("button", { type: "button", class: "imp-fallback-link" }, i18nT("Hai già i 2 CSV singoli (export GDPR)? Caricali qui"));
  card.appendChild(fallbackToggle);

  const fallbackBox = el("div", { class: "imp-fallback-box", hidden: true });
  const v1Row = el("label", { class: "imp-fallback-row" }, [
    el("span", {}, "tracking-prod-records.csv (film)"),
    el("input", { type: "file", id: "importCsvV1Input", accept: ".csv,text/csv" }),
  ]);
  const v2Row = el("label", { class: "imp-fallback-row" }, [
    el("span", {}, i18nT("tracking-prod-records-v2.csv (serie)")),
    el("input", { type: "file", id: "importCsvV2Input", accept: ".csv,text/csv" }),
  ]);
  fallbackBox.appendChild(v1Row);
  fallbackBox.appendChild(v2Row);
  card.appendChild(fallbackBox);

  fallbackToggle.addEventListener("click", () => {
    fallbackBox.hidden = !fallbackBox.hidden;
    fallbackToggle.textContent = fallbackBox.hidden
      ? i18nT("Hai già i 2 CSV singoli (export GDPR)? Caricali qui")
      : i18nT("Nascondi il caricamento manuale (CSV)");
  });

  // Fallback dedicato per l'export Refract (JSON), indipendente dal fallback
  // CSV sopra — l'utente potrebbe avere solo i file JSON estratti a mano.
  const refractFallbackToggle = el("button", { type: "button", class: "imp-fallback-link" }, i18nT("Hai già i file JSON di Refract? Caricali qui"));
  card.appendChild(refractFallbackToggle);

  const refractFallbackBox = el("div", { class: "imp-fallback-box", hidden: true });
  const jsonMoviesRow = el("label", { class: "imp-fallback-row" }, [
    el("span", {}, "tvtime-movies-*.json (film)"),
    el("input", { type: "file", id: "importJsonMoviesInput", accept: ".json,application/json" }),
  ]);
  const jsonSeriesRow = el("label", { class: "imp-fallback-row" }, [
    el("span", {}, i18nT("tvtime-series-*.json (serie)")),
    el("input", { type: "file", id: "importJsonSeriesInput", accept: ".json,application/json" }),
  ]);
  refractFallbackBox.appendChild(jsonMoviesRow);
  refractFallbackBox.appendChild(jsonSeriesRow);
  card.appendChild(refractFallbackBox);

  refractFallbackToggle.addEventListener("click", () => {
    refractFallbackBox.hidden = !refractFallbackBox.hidden;
    refractFallbackToggle.textContent = refractFallbackBox.hidden
      ? i18nT("Hai già i file JSON di Refract? Caricali qui")
      : i18nT("Nascondi il caricamento manuale (JSON)");
  });

  const previewBox = el("div", { class: "imp-preview", id: "impPreviewBox", hidden: true });
  card.appendChild(previewBox);

  card.appendChild(buildOptionsBox(i18nT("I rewatch presenti più volte nella cronologia TV Time vengono sempre rilevati automaticamente.")));
  card.appendChild(buildCommentConsentBox());

  const actions = el("div", { class: "imp-actions" });
  const startBtn = el("button", { class: "imp-btn imp-btn-primary", type: "button", disabled: true }, "Avvia importazione");
  actions.appendChild(startBtn);
  card.appendChild(actions);

  if (currentUid) card.appendChild(renderSupportChatLink(currentUid));

  root.appendChild(card);

  // `detectedFormat`: null | "gdpr" | "refract" — decides which preview/
  // startTitlesImport call fires. Set as soon as either format's data is
  // populated (zip autodetect or either manual fallback), never both at once
  // (the 2 export formats are mutually exclusive per file).
  let detectedFormat = null;
  let csvV1 = "";
  let csvV2 = "";
  // Optional (votes + reviews) — populated when the GDPR ZIP contains them;
  // absence never blocks the core import (see startTitlesImport call below).
  // Refract has no equivalent — this format carries no votes/comments.
  let csvEpisodeVotes = "";
  let csvMovieVotes = "";
  let csvMovieRatings = "";
  let csvMovieComments = "";
  let csvEpisodeComments = "";
  let csvLists = "";
  let csvShowRatings = "";
  let jsonMovies = "";
  let jsonSeries = "";

  function updatePreview() {
    if (detectedFormat === "refract") {
      if (!jsonMovies && !jsonSeries) {
        previewBox.hidden = true;
        startBtn.disabled = true;
        return;
      }
      const stats = previewTvTimeRefractStandby({ moviesJson: jsonMovies, seriesJson: jsonSeries });
      previewBox.hidden = false;
      if (stats.total === 0) {
        previewBox.innerHTML = `<p class="imp-preview-error">${i18nT("Non riesco a leggere questi file: verifica che siano i JSON \"tvtime-movies-*.json\" / \"tvtime-series-*.json\" dell'export Refract.")}</p>`;
        startBtn.disabled = true;
        return;
      }
      previewBox.innerHTML = `
        <p><strong>Export Refract riconosciuto: ${stats.total} voci trovate.</strong></p>
        <p>${stats.moviesWatched} film visti, ${stats.episodesWatched} episodi visti, ${stats.moviesWatchlist + stats.seriesWatchlist} in watchlist.</p>
        <p class="imp-preview-hint">${i18nT("Questa è solo una stima: l'analisi definitiva avviene durante l'importazione. Questo export non include voti o recensioni.")}</p>
      `;
      startBtn.textContent = "Avvia importazione";
      startBtn.disabled = false;
      return;
    }

    startBtn.textContent = "Avvia importazione";
    if (!csvV1 && !csvV2) {
      previewBox.hidden = true;
      startBtn.disabled = true;
      return;
    }
    const stats = previewTvTimeCsvs({ moviesCsv: csvV1, seriesCsv: csvV2 });
    previewBox.hidden = false;
    if (stats.total === 0) {
      previewBox.innerHTML = `<p class="imp-preview-error">${i18nT("Non riesco a leggere questi file: verifica che siano i CSV \"tracking-prod-records.csv\" / \"tracking-prod-records-v2.csv\" dell'export TV Time.")}</p>`;
      startBtn.disabled = true;
      return;
    }
    const hasVotesOrReviews = Boolean(csvEpisodeVotes || csvMovieVotes || csvMovieRatings || csvMovieComments || csvEpisodeComments);
    previewBox.innerHTML = `
      <p><strong>${stats.total} voci trovate</strong> ${i18nT("nella cronologia.")}</p>
      <p>${stats.moviesWatched} film visti, ${stats.episodesWatched} episodi visti, ${stats.moviesWatchlist + stats.seriesWatchlist} in watchlist.</p>
      ${hasVotesOrReviews ? `<p>${i18nT("Importiamo anche i tuoi voti (convertiti in decimi) e le recensioni, dove presenti.")}</p>` : ""}
      ${csvLists ? `<p>${i18nT("Importiamo anche le liste personalizzate, inizialmente private su Somto.")}</p>` : ""}
      <p class="imp-preview-hint">${i18nT("Questa è solo una stima: l'analisi definitiva avviene durante l'importazione.")}</p>
    `;
    startBtn.disabled = false;
  }

  zipInput.addEventListener("change", async () => {
    const file = zipInput.files?.[0];
    if (!file) return;
    previewBox.hidden = false;
    previewBox.innerHTML = `<p class="imp-preview-hint">Estrazione in corso…</p>`;
    try {
      // Try the GDPR shape first (exact CSV names): the far more common
      // export today. Only fall through to the Refract pattern match if
      // neither CSV is present — the 2 formats never coexist in one ZIP.
      const entries = await extractZipEntries(file, TV_TIME_ALL_TARGET_FILENAMES);
      csvV1 = entries[TV_TIME_MOVIES_FILENAME] || "";
      csvV2 = entries[TV_TIME_SERIES_FILENAME] || "";
      csvEpisodeVotes = entries[TV_TIME_EPISODE_VOTES_FILENAME] || "";
      csvMovieVotes = entries[TV_TIME_MOVIE_VOTES_FILENAME] || "";
      csvMovieRatings = entries[TV_TIME_MOVIE_RATINGS_FILENAME] || "";
      csvMovieComments = entries[TV_TIME_MOVIE_COMMENTS_FILENAME] || "";
      csvEpisodeComments = entries[TV_TIME_EPISODE_COMMENTS_FILENAME] || "";
      csvLists = entries[TV_TIME_LISTS_FILENAME] || "";
      csvShowRatings = entries[TV_TIME_SHOW_RATINGS_FILENAME] || "";
      if (csvV1 || csvV2) {
        detectedFormat = "gdpr";
        updatePreview();
        return;
      }

      const refractEntries = await extractZipEntriesByPattern(file, REFRACT_ZIP_PATTERNS);
      jsonMovies = refractEntries.movies || "";
      jsonSeries = refractEntries.series || "";
      if (!jsonMovies && !jsonSeries) {
        throw new Error(i18nT("File non trovati nello ZIP."));
      }
      detectedFormat = "refract";
      updatePreview();
    } catch (err) {
      console.error("extractZipEntries error", err);
      previewBox.innerHTML = `<p class="imp-preview-error">${i18nT("Non riesco a leggere questo ZIP automaticamente. Usa uno dei caricamenti manuali qui sotto (CSV per l'export GDPR, JSON per Refract).")}</p>`;
      startBtn.disabled = true;
      fallbackBox.hidden = false;
      fallbackToggle.textContent = i18nT("Nascondi il caricamento manuale (CSV)");
      refractFallbackBox.hidden = false;
      refractFallbackToggle.textContent = i18nT("Nascondi il caricamento manuale (JSON)");
    }
  });

  // I caricamenti manuali qui sotto sono divisi per formato (CSV = GDPR,
  // JSON = Refract), ma niente impedisce di mettere il file nella casella
  // sbagliata — ed è successo davvero: JSON di Refract nelle caselle CSV,
  // import a zero titoli. Il primo carattere utile dice il formato senza
  // parsare nulla: `[`/`{` = JSON, tutto il resto = riga di header CSV.
  const looksLikeJson = (text) => /^\s*[[{]/.test(String(text || ""));

  v1Row.querySelector("input").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    if (looksLikeJson(text)) {
      detectedFormat = "refract";
      jsonMovies = text;
    } else {
      detectedFormat = "gdpr";
      csvV1 = text;
    }
    updatePreview();
  });
  v2Row.querySelector("input").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    if (looksLikeJson(text)) {
      detectedFormat = "refract";
      jsonSeries = text;
    } else {
      detectedFormat = "gdpr";
      csvV2 = text;
    }
    updatePreview();
  });
  jsonMoviesRow.querySelector("input").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    if (looksLikeJson(text)) {
      detectedFormat = "refract";
      jsonMovies = text;
    } else {
      detectedFormat = "gdpr";
      csvV1 = text;
    }
    updatePreview();
  });
  jsonSeriesRow.querySelector("input").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    if (looksLikeJson(text)) {
      detectedFormat = "refract";
      jsonSeries = text;
    } else {
      detectedFormat = "gdpr";
      csvV2 = text;
    }
    updatePreview();
  });

  startBtn.addEventListener("click", async () => {
    if (detectedFormat === "refract" ? (!jsonMovies && !jsonSeries) : (!csvV1 && !csvV2)) return;
    trackProductEvent("import_started");
    void logEvent("import_started", { source: detectedFormat });
    startBtn.disabled = true;
    startBtn.textContent = "Avvio in corso…";
    try {
      if (detectedFormat === "refract") {
        startedImportSource = "tvtime_refract";
        const totalRowsHint = previewTvTimeRefractStandby({ moviesJson: jsonMovies, seriesJson: jsonSeries }).total;
        renderStartingStep({ totalRowsHint });
        const session = await createTitlesImportUploadSession({
          source: "tvtime_refract",
          hasMovies: Boolean(jsonMovies && jsonMovies.trim()),
          hasSeries: Boolean(jsonSeries && jsonSeries.trim()),
        });
        if (!session?.importId || !session?.storagePaths) throw new Error(i18nT("Sessione upload non valida."));
        currentImportId = session.importId;
        const label = document.getElementById("impProgressLabel");
        if (label) label.textContent = i18nT("Caricamento file in corso...");
        await uploadTitlesImportJsonFiles({
          storagePaths: session.storagePaths,
          moviesJson: jsonMovies,
          seriesJson: jsonSeries,
        });
        if (label) label.textContent = "Finalizzazione in corso...";
        const res = await finalizeTitlesImportUpload({ importId: session.importId });
        if (!res?.importId) throw new Error(i18nT("Risposta import non valida."));
        // finalizeTitlesImportUpload now enqueues the resumable matcher and
        // returns {status:"queued"} — follow the terminal state via the
        // listener, same as every other transport. (completed/awaiting are
        // kept as defensive fast-paths in case a tiny file lands terminal.)
        currentImportId = res.importId;
        if (res.status === "completed") {
          renderFinalSummary(res);
        } else if (res.status === "awaiting_confirmation") {
          void openConfirmationQueue(res.importId, res);
        } else {
          renderProgressStep(res);
          watchImportJob(res.importId);
        }
        return;
      }

      startedImportSource = "tvtime_gdpr";
      const totalRowsHint = previewTvTimeCsvs({ moviesCsv: csvV1, seriesCsv: csvV2 }).total;
      renderStartingStep({ totalRowsHint });
      const gdprOptions = {
        countDuplicateRewatches: true,
        countExistingAsRewatch: Boolean(document.getElementById("impCountExistingAsRewatch")?.checked),
        importComments: true, // sempre on: i commenti fanno parte dell'import (niente più toggle); publish resta dietro revisione
      };
      const gdprTexts = {
        movies: csvV1,
        series: csvV2,
        episodeVotes: csvEpisodeVotes,
        movieVotes: csvMovieVotes,
        movieRatings: csvMovieRatings,
        movieComments: csvMovieComments,
        episodeComments: csvEpisodeComments,
        lists: csvLists,
        showRatings: csvShowRatings,
      };
      const gdprBytes = Object.values(gdprTexts).reduce((sum, t) => sum + utf8Bytes(t), 0);

      let res;
      if (gdprBytes > IMPORT_INLINE_MAX_BYTES) {
        // Libreria grande: trasporto via Storage (il body callable
        // sfonderebbe il limite 1MB del doc Firestore).
        const session = await createTitlesImportUploadSession({
          source: "tvtime_gdpr",
          hasMovies: Boolean(csvV1 && csvV1.trim()),
          hasSeries: Boolean(csvV2 && csvV2.trim()),
          hasEpisodeVotes: Boolean(csvEpisodeVotes && csvEpisodeVotes.trim()),
          hasMovieVotes: Boolean(csvMovieVotes && csvMovieVotes.trim()),
          hasMovieRatings: Boolean(csvMovieRatings && csvMovieRatings.trim()),
          hasMovieComments: Boolean(csvMovieComments && csvMovieComments.trim()),
          hasEpisodeComments: Boolean(csvEpisodeComments && csvEpisodeComments.trim()),
          hasLists: Boolean(csvLists && csvLists.trim()),
          hasShowRatings: Boolean(csvShowRatings && csvShowRatings.trim()),
          options: gdprOptions,
        });
        if (!session?.importId || !session?.storagePaths) throw new Error(i18nT("Sessione upload non valida."));
        currentImportId = session.importId;
        const label = document.getElementById("impProgressLabel");
        if (label) label.textContent = i18nT("Caricamento file in corso...");
        await uploadTitlesImportFiles({ storagePaths: session.storagePaths, texts: gdprTexts });
        if (label) label.textContent = "Finalizzazione in corso...";
        res = await finalizeTitlesImportUpload({ importId: session.importId });
      } else {
        res = await startTitlesImport({
          source: "tvtime_gdpr",
          rawCsvV1: csvV1,
          rawCsvV2: csvV2,
          rawCsvEpisodeVotes: csvEpisodeVotes,
          rawCsvMovieVotes: csvMovieVotes,
          rawCsvMovieRatings: csvMovieRatings,
          rawCsvMovieComments: csvMovieComments,
          rawCsvEpisodeComments: csvEpisodeComments,
          rawCsvLists: csvLists,
          rawCsvShowRatings: csvShowRatings,
          dryRun: false,
          options: gdprOptions,
        });
      }
      if (!res?.importId) throw new Error(i18nT("Risposta import non valida."));
      currentImportId = res.importId;
      renderProgressStep(res);
      watchImportJob(res.importId);
    } catch (err) {
      console.error("startTitlesImport error", err);
      toast(friendlyImportError(err), i18nT("Errore"), { timeout: 5000 });
      renderPickerStep();
    }
  });
}

/* --------------------------- Netflix --------------------------- */

function renderNetflixPickerStep() {
  root.innerHTML = "";
  root.appendChild(el("header", { class: "imp-page-header" }, [
    el("h1", {}, "Importa cronologia"),
    el("p", {}, i18nT("Carica il CSV di Netflix. Somto lo elabora in background e aggiorna la libreria del tuo profilo.")),
  ]));

  const card = el("section", { class: "imp-card" });
  card.appendChild(renderSourceSelector());
  card.appendChild(renderPrivacyNote());

  card.appendChild(buildStepsList([
    buildStepRow(1, i18nT("Apri la cronologia Netflix."), el("a", {
      class: "imp-step-link",
      href: "https://www.netflix.com/settings/viewing-history",
      target: "_blank",
      rel: "noopener",
    }, i18nT("Apri netflix.com/settings/viewing-history ↗"))),
    buildStepRow(2, i18nT("Seleziona in alto il profilo giusto, poi in fondo alla pagina tocca «Scarica tutto».")),
    buildStepRow(3, i18nT("Torna qui e carica il CSV scaricato.")),
  ]));

  const dropzone = el("label", { class: "imp-dropzone", for: "importFileInput" }, [
    el("div", { class: "imp-dropzone-icon" }, "⬆"),
    el("strong", {}, i18nT("Scegli il file CSV")),
    el("small", {}, i18nT("Netflix: Account → Profilo → Attività di visualizzazione → Scarica tutto")),
  ]);
  const fileInput = el("input", {
    type: "file",
    id: "importFileInput",
    accept: ".csv,text/csv",
    style: "display:none",
  });
  dropzone.appendChild(fileInput);
  card.appendChild(dropzone);

  const previewBox = el("div", { class: "imp-preview", id: "impPreviewBox", hidden: true });
  card.appendChild(previewBox);

  card.appendChild(buildOptionsBox(i18nT("I rewatch presenti più volte nel file Netflix vengono sempre rilevati automaticamente.")));

  const actions = el("div", { class: "imp-actions" });
  const startBtn = el("button", { class: "imp-btn imp-btn-primary", type: "button", disabled: true }, "Avvia importazione");
  actions.appendChild(startBtn);
  card.appendChild(actions);

  if (currentUid) card.appendChild(renderSupportChatLink(currentUid));

  root.appendChild(card);

  let selectedText = "";

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    selectedText = await file.text();

    const stats = previewNetflixCsv(selectedText);
    previewBox.hidden = false;
    if (stats.total === 0) {
      previewBox.innerHTML = `<p class="imp-preview-error">${i18nT("Non riesco a leggere questo file: verifica che sia l'export \"Attività di visualizzazione\" di Netflix (CSV con colonne Title,Date).")}</p>`;
      startBtn.disabled = true;
      return;
    }
    previewBox.innerHTML = `
      <p><strong>${stats.total} voci trovate</strong> ${i18nT("nel file.")}</p>
      <p>~${stats.recognizable} riconoscibili automaticamente, ~${stats.ambiguous} da verificare dopo l'import.${stats.malformed ? i18nT(" {malformed} righe scartate (formato non valido).", { malformed: stats.malformed }) : ""}</p>
      <p class="imp-preview-hint">${i18nT("Questa è solo una stima: l'analisi definitiva avviene durante l'importazione.")}</p>
    `;
    startBtn.disabled = false;
  });

  startBtn.addEventListener("click", async () => {
    if (!selectedText) return;
    startBtn.disabled = true;
    startBtn.textContent = "Avvio in corso…";
    try {
      startedImportSource = "netflix_csv";
      renderStartingStep({ totalRowsHint: previewNetflixCsv(selectedText).total });
      const netflixOptions = {
        countDuplicateRewatches: true,
        countExistingAsRewatch: Boolean(document.getElementById("impCountExistingAsRewatch")?.checked),
      };

      let res;
      if (utf8Bytes(selectedText) > IMPORT_INLINE_MAX_BYTES) {
        // Cronologia Netflix grande: trasporto via Storage.
        const session = await createTitlesImportUploadSession({
          source: "netflix_csv",
          hasNetflix: Boolean(selectedText && selectedText.trim()),
          options: netflixOptions,
        });
        if (!session?.importId || !session?.storagePaths) throw new Error(i18nT("Sessione upload non valida."));
        currentImportId = session.importId;
        const label = document.getElementById("impProgressLabel");
        if (label) label.textContent = i18nT("Caricamento file in corso...");
        await uploadTitlesImportFiles({ storagePaths: session.storagePaths, texts: { netflix: selectedText } });
        if (label) label.textContent = "Finalizzazione in corso...";
        res = await finalizeTitlesImportUpload({ importId: session.importId });
      } else {
        res = await startTitlesImport({
          source: "netflix_csv",
          rawCsv: selectedText,
          dryRun: false,
          options: netflixOptions,
        });
      }
      if (!res?.importId) throw new Error(i18nT("Risposta import non valida."));
      currentImportId = res.importId;
      renderProgressStep(res);
      watchImportJob(res.importId);
    } catch (err) {
      console.error("startTitlesImport error", err);
      toast(friendlyImportError(err), i18nT("Errore"), { timeout: 5000 });
      renderPickerStep();
    }
  });
}

/* --------------------------- Trakt (OAuth device flow) --------------------------- */

function stopTraktPolling() {
  if (traktPollTimer) {
    clearTimeout(traktPollTimer);
    traktPollTimer = null;
  }
}

function friendlyTraktError(err) {
  const code = err?.code || "";
  if (code.includes("resource-exhausted")) {
    return i18nT("Hai raggiunto il limite di tentativi per oggi. Riprova più tardi.");
  }
  if (code.includes("failed-precondition")) {
    return err?.message || i18nT("Collega prima il tuo account Trakt.");
  }
  return i18nT("Non sono riuscito a collegarmi a Trakt. Riprova.");
}

/* ------------------------------- Letterboxd -------------------------------
 * Fase 1 (questa): raccogliamo lo ZIP grezzo dell'export Letterboxd su Storage
 * (`supportImports/{uid}/`, stesso path della pagina di rescue) e lo lavoriamo
 * a mano entro 24 ore. Serve a vedere file veri prima di scrivere il parser:
 * l'export contiene diary/ratings/reviews/watchlist/liste, ma i nomi esatti dei
 * file e le colonne cambiano nel tempo e non li vogliamo indovinare.
 * Fase 2 (dopo N export raccolti): parser server-side come le altre sorgenti.
 * ------------------------------------------------------------------------- */

const LETTERBOXD_MAX_BYTES = 30 * 1024 * 1024; // allineato a storage.rules

function renderLetterboxdPickerStep() {
  root.innerHTML = "";
  root.appendChild(el("header", { class: "imp-page-header" }, [
    el("h1", {}, i18nT("Importa da Letterboxd")),
    el("p", {}, i18nT("Porta su Somto i film che hai visto, i voti e la watchlist.")),
  ]));

  const card = el("section", { class: "imp-card" });
  card.appendChild(renderSourceSelector());
  card.appendChild(renderLetterboxdPrivacyNote());

  const settingsLink = el("a", {
    href: "https://letterboxd.com/settings/data/",
    target: "_blank",
    rel: "noopener noreferrer",
    class: "imp-inline-link",
  }, "letterboxd.com/settings/data");

  card.appendChild(buildStepsList([
    buildStepRow(1, i18nT("Apri Letterboxd dal browser e accedi al tuo account. L'export si fa solo dal sito, non dall'app.")),
    buildStepRow(2, el("p", {}, [
      i18nT("Vai su Settings → Data, oppure direttamente a "),
      settingsLink,
      ".",
    ])),
    buildStepRow(3, i18nT("Tocca «Export your data»: Letterboxd prepara un file .zip e lo scarica.")),
    buildStepRow(4, i18nT("Torna qui e carica lo zip così com'è, senza aprirlo.")),
  ]));

  card.appendChild(el("div", { class: "imp-options" }, [
    el("div", { class: "imp-toggle-copy imp-note" }, [
      el("strong", {}, i18nT("Controlliamo noi l'import da Letterboxd")),
      el("small", {}, i18nT("Elaboriamo l'import entro 24 ore. Ti scriviamo in chat quando la cronologia è sul tuo profilo.")),
    ]),
  ]));

  const dropzone = el("label", { class: "imp-dropzone", for: "impLetterboxdFile" }, [
    el("div", { class: "imp-dropzone-icon" }, "⬆"),
    el("strong", {}, i18nT("Carica l'export dei tuoi dati (.zip)")),
    el("small", {}, i18nT("Lo zip che scarica Letterboxd, senza aprirlo né rinominarlo.")),
  ]);
  const fileInput = el("input", {
    type: "file",
    id: "impLetterboxdFile",
    accept: ".zip,application/zip",
    style: "display:none",
  });
  dropzone.appendChild(fileInput);

  const fileChip = el("p", { class: "imp-lbx-chip", hidden: true });
  const errBox = el("p", { class: "imp-lbx-error", hidden: true });
  const progress = el("div", { class: "imp-progress-bar", hidden: true }, [
    el("div", { class: "imp-progress-fill", style: "width:4%" }),
  ]);
  const sendBtn = el("button", { class: "imp-btn imp-btn-primary", type: "button", disabled: true }, i18nT("Invia lo zip"));

  let picked = null;

  const showError = (msg) => {
    errBox.textContent = msg;
    errBox.hidden = false;
  };

  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0] || null;
    errBox.hidden = true;
    fileChip.hidden = true;
    picked = null;
    sendBtn.disabled = true;
    if (!f) return;
    if (!/\.zip$/i.test(f.name)) {
      showError(i18nT("Serve il file .zip che scarica Letterboxd, non i singoli csv."));
      return;
    }
    if (f.size > LETTERBOXD_MAX_BYTES) {
      showError(i18nT("Il file supera i 30 MB. Scrivici in chat, troviamo un'altra strada."));
      return;
    }
    picked = f;
    fileChip.textContent = `${f.name} · ${(f.size / (1024 * 1024)).toFixed(1)} MB`;
    fileChip.hidden = false;
    sendBtn.disabled = false;
  });

  sendBtn.addEventListener("click", () => {
    if (!picked || !currentUid) return;
    void sendLetterboxdArchive({ file: picked, card, sendBtn, progress, showError });
  });

  card.appendChild(dropzone);
  card.appendChild(fileChip);
  card.appendChild(errBox);
  card.appendChild(progress);
  card.appendChild(sendBtn);

  if (currentUid) card.appendChild(renderSupportChatLink(currentUid));

  root.appendChild(card);
  logEvent("import_source_selected", { source: "letterboxd" });
}

async function sendLetterboxdArchive({ file, card, sendBtn, progress, showError }) {
  sendBtn.disabled = true;
  sendBtn.textContent = i18nT("Carico…");
  progress.hidden = false;

  try {
    const [{ storage }, { ref, uploadBytesResumable }] = await Promise.all([
      import("../firebase.js"),
      import("https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js"),
    ]);

    const safeName = String(file.name || "letterboxd.zip").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
    const path = `supportImports/${currentUid}/letterboxd-${Date.now()}-${safeName}`;
    const task = uploadBytesResumable(ref(storage, path), file, {
      contentType: file.type || "application/zip",
      customMetadata: {
        source: "letterboxd_zip",
        originalName: String(file.name || ""),
        uploadedAt: new Date().toISOString(),
      },
    });

    await new Promise((resolve, reject) => {
      task.on("state_changed",
        (snap) => {
          const pct = snap.totalBytes ? Math.round((snap.bytesTransferred / snap.totalBytes) * 100) : 0;
          progress.querySelector(".imp-progress-fill").style.width = `${Math.max(4, pct)}%`;
        },
        reject,
        resolve);
    });

    logEvent("import_letterboxd_uploaded", { bytes: file.size });
    renderLetterboxdDone(card);
  } catch (err) {
    console.error("[import] letterboxd upload", err);
    const code = String(err?.code || "");
    showError(code.includes("unauthorized") || code.includes("permission")
      ? i18nT("Permesso negato: prova a uscire e rientrare, poi riprova.")
      : i18nT("Caricamento non riuscito. Riprova tra poco."));
    progress.hidden = true;
    sendBtn.disabled = false;
    sendBtn.textContent = i18nT("Invia lo zip");
  }
}

function renderLetterboxdDone(card) {
  card.innerHTML = "";
  card.appendChild(renderSourceSelector());
  card.appendChild(el("div", { class: "imp-done" }, [
    el("h2", {}, i18nT("Zip ricevuto")),
    el("p", {}, i18nT("Elaboriamo l'import entro 24 ore. Ti scriviamo in chat quando la cronologia Letterboxd è sul tuo profilo. Non serve caricare di nuovo il file.")),
  ]));
  if (currentUid) card.appendChild(renderSupportChatLink(currentUid));
}

function renderTraktPickerStep() {
  root.innerHTML = "";
  root.appendChild(el("header", { class: "imp-page-header" }, [
    el("h1", {}, i18nT("Importa da Trakt")),
    el("p", {}, i18nT("Collega il tuo account Trakt.tv: importiamo film e serie visti, voti e watchlist.")),
  ]));

  const card = el("section", { class: "imp-card" });
  card.appendChild(renderSourceSelector());
  card.appendChild(renderPrivacyNote());

  card.appendChild(buildStepsList([
    buildStepRow(1, i18nT("Tocca «Connetti Trakt»: ti mostriamo un codice da inserire sul sito Trakt.")),
    buildStepRow(2, i18nT("Apri la pagina Trakt (si apre in un'altra scheda), inserisci il codice e autorizza Somto.")),
    buildStepRow(3, "Torna qui: appena confermato, potrai avviare l'importazione."),
  ]));

  const connectBox = el("div", { class: "imp-trakt-box", id: "traktConnectBox" });
  card.appendChild(connectBox);

  if (currentUid) card.appendChild(renderSupportChatLink(currentUid));

  root.appendChild(card);

  renderTraktConnectIdle(connectBox);
}

function renderTraktConnectIdle(container) {
  container.innerHTML = "";
  const connectBtn = el("button", { class: "imp-btn imp-btn-primary", type: "button" }, i18nT("Connetti Trakt"));
  connectBtn.addEventListener("click", () => void beginTraktConnect(container, connectBtn));
  container.appendChild(el("div", { class: "imp-actions" }, [connectBtn]));
}

async function beginTraktConnect(container, triggerBtn) {
  if (triggerBtn) {
    triggerBtn.disabled = true;
    triggerBtn.textContent = "Collegamento in corso…";
  }
  try {
    // Se l'utente è già collegato (token valido lato server da una sessione
    // precedente), salta il device code e vai dritto all'import.
    try {
      const existing = await pollTraktConnect();
      if (existing?.status === "connected") {
        renderTraktConnectedStep(container);
        return;
      }
    } catch (_) { /* ignora: procedi col device flow normale */ }
    const res = await startTraktConnect();
    if (!res?.userCode || !res?.verificationUrl) throw new Error(i18nT("Risposta non valida."));
    renderTraktCodeStep(container, res);
    scheduleTraktPoll(container, res.interval || 5, res.expiresIn || 600);
  } catch (err) {
    console.error("startTraktConnect error", err);
    toast(friendlyTraktError(err), i18nT("Errore"), { timeout: 5000 });
    renderTraktConnectIdle(container);
  }
}

const TRAKT_COPY_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
const TRAKT_CHECK_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>';

// Copies the Trakt user_code to the clipboard with a brief checkmark feedback.
// Falls back to a hidden-textarea + execCommand path for browsers without the
// async Clipboard API (older iOS Safari) or non-secure contexts.
async function copyTraktCode(code, btn) {
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(code);
      ok = true;
    }
  } catch (_) { /* fall through to legacy path */ }
  if (!ok) {
    try {
      const ta = document.createElement("textarea");
      ta.value = code;
      ta.setAttribute("readonly", "");
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      ok = true;
    } catch (_) { /* clipboard unavailable */ }
  }
  if (!ok || !btn) return;
  btn.classList.add("is-copied");
  btn.innerHTML = TRAKT_CHECK_ICON;
  btn.setAttribute("title", i18nT("Copiato!"));
  window.clearTimeout(btn._copyResetTimer);
  btn._copyResetTimer = window.setTimeout(() => {
    btn.classList.remove("is-copied");
    btn.innerHTML = TRAKT_COPY_ICON;
    btn.setAttribute("title", i18nT("Copia codice"));
  }, 1600);
}

function renderTraktCodeStep(container, { userCode, verificationUrl }) {
  container.innerHTML = "";
  const box = el("div", { class: "imp-trakt-code-card" }, [
    el("p", { class: "imp-trakt-code-label" }, i18nT("Il tuo codice Trakt")),
    el("div", { class: "imp-trakt-code-row" }, [
      el("span", { class: "imp-trakt-code", id: "traktUserCode" }, userCode),
      el("button", {
        class: "imp-trakt-copy",
        type: "button",
        title: i18nT("Copia codice"),
        "aria-label": i18nT("Copia codice"),
        html: TRAKT_COPY_ICON,
        onClick: (e) => copyTraktCode(userCode, e.currentTarget),
      }),
    ]),
    el("a", {
      class: "imp-btn imp-btn-primary",
      href: verificationUrl,
      target: "_blank",
      rel: "noopener",
    }, i18nT("Apri trakt.tv/activate ↗")),
    el("p", { class: "imp-trakt-hint" }, i18nT("Inserisci il codice sul sito Trakt e autorizza l'accesso. Questa pagina si aggiorna da sola appena confermi.")),
    el("p", { class: "imp-trakt-status", id: "traktStatusLine" }, i18nT("In attesa della tua conferma su Trakt…")),
  ]);
  const retryBtn = el("button", { class: "imp-btn imp-btn-ghost", type: "button" }, i18nT("Genera un nuovo codice"));
  retryBtn.addEventListener("click", () => {
    stopTraktPolling();
    renderTraktConnectIdle(container);
  });
  box.appendChild(el("div", { class: "imp-actions" }, [retryBtn]));
  container.appendChild(box);
}

function scheduleTraktPoll(container, intervalSeconds, expiresInSeconds) {
  stopTraktPolling();
  traktPollDeadline = Date.now() + Math.max(1, expiresInSeconds) * 1000;
  const tick = async () => {
    if (Date.now() > traktPollDeadline) {
      renderTraktExpiredStep(container, "expired");
      return;
    }
    try {
      const res = await pollTraktConnect();
      const status = res?.status || "none";
      if (status === "connected") {
        renderTraktConnectedStep(container);
        return;
      }
      if (status === "expired" || status === "denied") {
        renderTraktExpiredStep(container, status);
        return;
      }
      // "pending" o "none": continua a interrogare finché non scade.
      const statusLine = document.getElementById("traktStatusLine");
      if (statusLine) statusLine.textContent = i18nT("In attesa della tua conferma su Trakt…");
      traktPollTimer = setTimeout(() => void tick(), Math.max(1, intervalSeconds) * 1000);
    } catch (err) {
      console.error("pollTraktConnect error", err);
      // Errore transitorio: riprova comunque, non interrompere il polling per
      // un singolo fallimento di rete.
      traktPollTimer = setTimeout(() => void tick(), Math.max(1, intervalSeconds) * 1000);
    }
  };
  traktPollTimer = setTimeout(() => void tick(), Math.max(1, intervalSeconds) * 1000);
}

function renderTraktExpiredStep(container, reason) {
  stopTraktPolling();
  container.innerHTML = "";
  const message = reason === "denied"
    ? i18nT("Hai rifiutato l'autorizzazione su Trakt.")
    : i18nT("Il codice è scaduto prima di essere confermato.");
  const box = el("div", { class: "imp-trakt-code-card" }, [
    el("p", { class: "imp-trakt-status is-error" }, message),
  ]);
  const retryBtn = el("button", { class: "imp-btn imp-btn-primary", type: "button" }, i18nT("Riprova"));
  retryBtn.addEventListener("click", () => void beginTraktConnect(container, retryBtn));
  box.appendChild(el("div", { class: "imp-actions" }, [retryBtn]));
  container.appendChild(box);
}

function renderTraktConnectedStep(container) {
  stopTraktPolling();
  container.innerHTML = "";
  container.appendChild(el("div", { class: "imp-trakt-code-card" }, [
    el("p", { class: "imp-trakt-status is-success" }, "Trakt collegato ✓"),
    el("p", { class: "imp-trakt-hint" }, i18nT("Avvio dell'import della tua libreria…")),
  ]));
  // Nessun secondo pulsante: collegare Trakt E' la richiesta di import, quindi
  // parte da solo (breve pausa per far leggere l'esito della connessione).
  setTimeout(() => void beginTraktImport(), 700);
}

async function beginTraktImport(triggerBtn) {
  if (triggerBtn) {
    triggerBtn.disabled = true;
    triggerBtn.textContent = "Avvio in corso…";
  }
  try {
    startedImportSource = "trakt";
    renderStartingStep({ totalRowsHint: 0 });
    const res = await startTraktImport({ dryRun: false });
    if (!res?.importId) throw new Error(i18nT("Risposta import non valida."));
    currentImportId = res.importId;
    renderProgressStep(res);
    watchImportJob(res.importId);
  } catch (err) {
    console.error("startTraktImport error", err);
    toast(friendlyImportError(err), i18nT("Errore"), { timeout: 5000 });
    renderPickerStep();
  }
}

function friendlyImportError(err) {
  const code = err?.code || "";
  if (code.includes("resource-exhausted")) {
    return i18nT("Hai raggiunto il limite di importazioni per oggi. Riprova più tardi.");
  }
  if (code.includes("invalid-argument")) {
    return err?.message || i18nT("File non valido.");
  }
  if (code.includes("storage/unauthorized") || code.includes("permission-denied")) {
    return i18nT("Non sono riuscito a caricare il file in modo sicuro. Aggiorna la pagina e riprova.");
  }
  if (code.includes("storage/quota-exceeded") || code.includes("storage/retry-limit-exceeded")) {
    return i18nT("Upload interrotto o troppo pesante. Riprova con una connessione stabile.");
  }
  return i18nT("Import non riuscito. Riprova tra qualche minuto.");
}

/* ═══════════════════ step 2: progress ═══════════════════ */

function renderStartingStep({ totalRowsHint = 0 } = {}) {
  root.innerHTML = "";
  root.appendChild(el("header", { class: "imp-page-header" }, [
    el("h1", {}, "Prepariamo l'import"),
    el("p", {}, i18nT("Stiamo creando il job. Tra poco potrai lasciare questa schermata e ricevere una notifica a elaborazione finita.")),
  ]));

  const card = el("section", { class: "imp-card imp-progress-card" });
  const bar = el("div", { class: "imp-progress-bar" }, [el("div", { class: "imp-progress-fill", id: "impProgressFill", style: "width:2%" })]);
  const label = el("p", { class: "imp-progress-label", id: "impProgressLabel" }, totalRowsHint ? `${totalRowsHint} righe ricevute` : "Avvio…");
  card.appendChild(bar);
  card.appendChild(label);
  root.appendChild(card);
}

// Traduce l'errore tecnico del server in una frase comprensibile. Il dettaglio
// grezzo (job.error) NON va mostrato all'utente — l'assistenza lo ritrova sul
// doc import; qui conta solo che l'utente capisca e sappia cosa fare.
function friendlyFailureMessage(job = {}) {
  const raw = String(job?.error || "").toLowerCase();
  if (raw.includes("mancant")) return i18nT("Non siamo riusciti a leggere i file caricati.");
  if (raw.includes("cicli") || raw.includes("troppo grand")) return i18nT("La libreria era troppo grande e l'elaborazione si è interrotta.");
  if (raw.includes("voci utili") || raw.includes(i18nT("non riesco a leggere"))) return i18nT("Non siamo riusciti a riconoscere i dati nel file.");
  return i18nT("Qualcosa è andato storto durante l'importazione.");
}

// Apre (o crea) il thread di assistenza dell'utente e ci naviga. Condiviso tra
// il link passivo del picker e il bottone in evidenza della schermata errore.
async function openSupportChat(triggerEl) {
  const uid = currentUid;
  if (!uid) return;
  const original = triggerEl ? triggerEl.textContent : null;
  if (triggerEl) {
    triggerEl.setAttribute("aria-busy", "true");
    triggerEl.textContent = i18nT("Apro la chat di assistenza…");
  }
  try {
    const res = await ensureMySupportThread();
    const threadId = res?.threadId || `support_${uid}`;
    window.location.href = `/thread.html?id=${encodeURIComponent(threadId)}`;
  } catch (err) {
    console.error("[import] ensure support thread failed", err);
    toast(i18nT("Non riesco ad aprire la chat adesso. Puoi scriverci da support@somto.it."), "Assistenza", { timeout: 5000 });
    if (triggerEl && original != null) {
      triggerEl.textContent = original;
      triggerEl.removeAttribute("aria-busy");
    }
  }
}

// Schermata di fallimento. Il grezzo caricato resta salvato server-side finché
// l'import non riesce, quindi l'azione PRIMARIA è "Riprova elaborazione" — che
// riparte dal file che abbiamo già, SENZA ricaricare nulla. Il re-upload viene
// proposto SOLO se il server risponde che il file non c'è più
// (needsReupload) — è l'unico caso in cui è fisicamente necessario, ed è anche
// la causa n.1 del carico Firestore (ogni re-upload rifà l'intero match).
function renderImportFailedStep(job = {}) {
  root.innerHTML = "";
  root.appendChild(el("header", { class: "imp-page-header" }, [
    el("h1", {}, "Import in pausa"),
    el("p", {}, i18nT("{v0} Abbiamo ancora i tuoi file: non serve ricaricare nulla, riproviamo l'elaborazione.", { v0: friendlyFailureMessage(job) })),
  ]));

  const card = el("section", { class: "imp-card" });
  card.appendChild(el("p", { class: "imp-preview-hint" }, i18nT("Riprova l'elaborazione qui sotto. Se non riparte, scrivici in chat: vediamo il tuo import e lo completiamo insieme.")));

  const retryBtn = el("button", { class: "imp-btn imp-btn-primary", type: "button" }, i18nT("↻ Riprova elaborazione"));
  const chatBtn = el("button", { class: "imp-btn imp-btn-ghost", type: "button" }, "💬 Scrivici in chat");
  chatBtn.addEventListener("click", () => { void openSupportChat(chatBtn); });

  retryBtn.addEventListener("click", async () => {
    const importId = job?.id || currentImportId;
    if (!importId) { renderPickerStep(); return; }
    retryBtn.disabled = true;
    retryBtn.setAttribute("aria-busy", "true");
    retryBtn.textContent = "Riavvio l'elaborazione…";
    try {
      const res = await retryTitlesImport(importId);
      if (res?.needsReupload) {
        // L'UNICO caso in cui il re-upload è davvero necessario: il file non è
        // più disponibile (upload interrotto a metà, o scaduto). Diciamolo
        // chiaro e SOLO ora mandiamo al picker.
        toast(i18nT("Il file caricato non è più disponibile (scaduto o caricamento interrotto): ricaricalo per completare l'import."), i18nT("Serve il file"), { timeout: 6000 });
        renderPickerStep();
        return;
      }
      // Riprocesso avviato: torna alla progress e segui il job in realtime.
      currentImportId = importId;
      renderProgressStep({ ...job, status: "queued" });
      watchImportJob(importId);
    } catch (err) {
      console.error("[import] retry failed", err);
      retryBtn.disabled = false;
      retryBtn.removeAttribute("aria-busy");
      retryBtn.textContent = i18nT("↻ Riprova elaborazione");
      toast(i18nT("Non sono riuscito a riavviare l'elaborazione adesso. Riprova tra poco o scrivici in chat."), i18nT("Riprova"), { timeout: 5000 });
    }
  });

  card.appendChild(el("div", { class: "imp-actions imp-actions-wrap" }, [retryBtn, chatBtn]));
  root.appendChild(card);
}

function renderProgressStep(job = {}) {
  const isManualProcessing = job.status === "manual_processing";
  root.innerHTML = "";
  root.appendChild(el("header", { class: "imp-page-header" }, [
    el("h1", {}, isManualProcessing ? "File ricevuti" : (job.status === "queued" ? "Import in coda" : "Importazione in corso")),
    el("p", {}, isManualProcessing
      ? i18nT("Abbiamo riconosciuto l'export Refract di TV Time. Lo stiamo elaborando manualmente: puoi chiudere questa pagina, ti avviseremo appena il profilo è aggiornato.")
      : i18nT("In questi giorni stiamo ricevendo molte richieste: l'elaborazione può richiedere più del solito. Puoi chiudere questa pagina; ti avviseremo con una notifica e troverai i risultati nella libreria del profilo.")),
  ]));

  const card = el("section", { class: "imp-card imp-progress-card" });
  const bar = el("div", { class: "imp-progress-bar" }, [el("div", { class: "imp-progress-fill", id: "impProgressFill", style: `width:${isManualProcessing ? 35 : 5}%` })]);
  const label = el("p", { class: "imp-progress-label", id: "impProgressLabel" }, isManualProcessing ? "Elaborazione manuale in corso" : "Import in coda");
  card.appendChild(bar);
  card.appendChild(label);
  if (isManualProcessing) {
    card.appendChild(el("p", { class: "imp-preview-hint" }, i18nT("Il formato generato dall'estensione Refract non viene ancora importato automaticamente. Abbiamo salvato i file necessari e completeremo noi l'import.")));
  }

  // Prefer the ACTUAL started source (autodetected within the TV Time tab)
  // over the tab selector — Refract carries no votes/reviews, so it must
  // never show this note. Falls back to `selectedSource` only on a page
  // reload with `?id=`, where the in-memory format tracking is gone.
  if ((startedImportSource || selectedSource) === "tvtime_gdpr") {
    card.appendChild(renderTvTimeRatingConversionNote());
  }

  card.appendChild(el("p", { class: "imp-preview-hint", id: "impNoReuploadHint" },
    i18nT("L'import è già in corso: non serve ricaricare il file, ci pensiamo noi. Puoi seguire da qui o chiudere la pagina.")));

  // Dal funnel onboarding l'azione primaria non e' "vai al profilo" (che e'
  // ancora vuoto: l'import sta macinando) ma tornare agli step, che e' il
  // senso dell'import-first — docs/ONBOARDING_V2.md.
  const actions = FROM_ONBOARDING
    ? el("div", { class: "imp-actions imp-actions-wrap" }, [
        el("a", { class: "imp-btn imp-btn-primary", href: "/home.html" }, i18nT("Continua a preparare Somto")),
        el("button", { class: "imp-btn imp-btn-ghost", type: "button", id: "impEnablePushBtn" }, i18nT("Attiva notifiche")),
      ])
    : el("div", { class: "imp-actions imp-actions-wrap" }, [
        el("a", { class: "imp-btn imp-btn-primary", href: "/account.html?tab=watched" }, i18nT("Vai al profilo")),
        el("button", { class: "imp-btn imp-btn-ghost", type: "button", id: "impEnablePushBtn" }, i18nT("Attiva notifiche")),
        el("button", { class: "imp-btn imp-btn-ghost", type: "button", id: "impStartAnotherBtn" }, i18nT("Importa un'altra fonte")),
      ]);
  card.appendChild(actions);
  root.appendChild(card);

  updateProgressUi(job);
  setupPushButton();

  const anotherBtn = document.getElementById("impStartAnotherBtn");
  if (anotherBtn) {
    anotherBtn.addEventListener("click", () => {
      if (jobUnsub) { jobUnsub(); jobUnsub = null; }
      currentImportId = null;
      renderPickerStep();
    }, { once: true });
  }
}

function updateProgressUi(job) {
  const fill = document.getElementById("impProgressFill");
  const label = document.getElementById("impProgressLabel");
  if (!fill || !label) return;
  if (job?.status === "manual_processing") {
    fill.style.width = "35%";
    label.textContent = "File ricevuti · elaborazione manuale in corso";
    return;
  }
  const total = Number(job?.totalRows || 0);
  const processed = Number(job?.processedCount || 0);
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 5;
  fill.style.width = `${Math.max(5, pct)}%`;
  if (job?.status === "queued") {
    label.textContent = total > 0 ? `In coda · ${total} righe ricevute` : "Import in coda";
  } else {
    label.textContent = total > 0 ? `${processed} / ${total} righe analizzate` : "Avvio…";
  }
}

function setupPushButton() {
  const btn = document.getElementById("impEnablePushBtn");
  if (!btn) return;
  if (!("Notification" in window) || Notification.permission === "granted") {
    btn.hidden = true;
    return;
  }
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = i18nT("Attivazione…");
    const res = await registerPushToken(currentUser);
    if (res?.ok) {
      btn.textContent = i18nT("Notifiche attive");
      toast(i18nT("Ti avviseremo quando l'import sarà pronto."), i18nT("Notifiche attive"));
    } else {
      btn.disabled = false;
      btn.textContent = i18nT("Attiva notifiche");
      toast(i18nT("Non sono riuscito ad attivare le notifiche da questo browser."), i18nT("Notifiche"));
    }
  }, { once: true });
}

function watchImportJob(importId) {
  if (jobUnsub) jobUnsub();
  jobUnsub = onImportJobChange(currentUid, importId, (job) => {
    if (!job) return;
    if (job.status === "failed") {
      if (jobUnsub) { jobUnsub(); jobUnsub = null; }
      void logEvent("import_failed", { source: job?.source });
      renderImportFailedStep(job);
      return;
    }
    if (job.status === "manual_processing") {
      if (jobUnsub) { jobUnsub(); jobUnsub = null; }
      renderProgressStep(job);
      return;
    }
    if (job.status === "queued" || job.status === "pending" || job.status === "matching") {
      if (!document.getElementById("impProgressFill")) renderProgressStep(job);
      updateProgressUi(job);
      return;
    }
    if (job.status === "awaiting_confirmation") {
      if (jobUnsub) { jobUnsub(); jobUnsub = null; }
      void openConfirmationQueue(importId, job);
      return;
    }
    if (job.status === "completed") {
      if (jobUnsub) { jobUnsub(); jobUnsub = null; }
      // import_completed è loggato dentro renderFinalSummary (un solo punto
      // per tutti i percorsi che arrivano alla Schermata C — quick confirm,
      // bulk in coda, submit manuale, o direttamente da qui).
      renderFinalSummary(job);
    }
  });
}

/* ═══════════════════ step 3: riepilogo automatico + coda conferma ═══════════════════ */

async function openConfirmationQueue(importId, job) {
  const unresolvedCount = Number(job?.unresolvedCount || 0);
  if (unresolvedCount === 0) {
    // Niente da caricare: risparmia la query items (vedi renderSummaryStep
    // per la chiusura automatica del job in questo caso).
    unresolvedItems = [];
    resolutionsPicked.clear();
    renderSummaryStep(job, unresolvedItems);
    return;
  }
  unresolvedItems = await listUnresolvedImportItems(currentUid, importId).catch(() => []);
  resolutionsPicked.clear();
  renderSummaryStep(job, unresolvedItems);
}

function importAnalyticsSource(job) {
  return job?.source || startedImportSource || selectedSource;
}

function renderSummaryStep(job, items) {
  const matchedCount = Number(job?.matchedCount || 0);
  const unresolvedCount = Number(job?.unresolvedCount || 0);
  const source = importAnalyticsSource(job);

  const readyProps = { source, platform: "web", matched: bucketCount(matchedCount), unresolved: bucketCount(unresolvedCount) };
  void logEvent("import_ready_for_confirmation", readyProps);
  void logEvent("import_confirmation_opened", readyProps);

  root.innerHTML = "";
  root.appendChild(el("header", { class: "imp-page-header" }, [
    el("h1", {}, i18nT("Quasi fatto")),
    el("p", {}, i18nT("{matchedCount} titoli sono già nel tuo profilo.", { matchedCount })),
    unresolvedCount > 0
      ? el("p", {}, i18nT("{unresolvedCount} voci non siamo riusciti ad abbinarle in automatico.", { unresolvedCount }))
      : null,
  ]));

  if (unresolvedCount === 0) {
    // Difensivo: il job non dovrebbe mai restare "awaiting_confirmation" con
    // 0 righe da confermare (finalizeImportResults lo marca "completed"), ma
    // se capita chiudiamo qui il job invece di lasciare l'utente su una
    // schermata senza uscita.
    const card = el("section", { class: "imp-card" });
    card.appendChild(el("p", { class: "imp-summary-line" }, "Finalizzo l'importazione…"));
    root.appendChild(card);
    void logEvent("import_quick_confirmed", { source, platform: "web", confirmation_mode: "quick", skipped: bucketCount(0) });
    confirmTitlesImport({ importId: currentImportId, skipRemaining: true })
      .then((res) => renderFinalSummary({ ...res, source }))
      .catch((err) => {
        console.error("[import] auto-finish confirm failed", err);
        toast(i18nT("Non sono riuscito a chiudere l'importazione. Riprova."), i18nT("Errore"), { timeout: 5000 });
      });
    return;
  }

  const card = el("section", { class: "imp-card" });
  const primaryBtn = el("button", { class: "imp-btn imp-btn-primary", type: "button", id: "impQuickConfirmBtn" }, i18nT("Importa i titoli trovati"));
  card.appendChild(el("div", { class: "imp-actions" }, [primaryBtn]));
  card.appendChild(el("p", { class: "imp-help-text" }, i18nT("Aggiunge i titoli riconosciuti e salta le {unresolvedCount} voci dubbie.", { unresolvedCount })));

  const reviewBtn = el("button", { class: "imp-btn imp-btn-ghost", type: "button" }, i18nT("Controlla i titoli dubbi ({count})", { count: unresolvedCount }));
  const anotherBtn = el("button", { class: "imp-btn imp-btn-ghost", type: "button" }, i18nT("Importa un'altra fonte"));
  card.appendChild(el("div", { class: "imp-actions imp-actions-wrap" }, [reviewBtn, anotherBtn]));

  root.appendChild(card);

  primaryBtn.addEventListener("click", async () => {
    primaryBtn.disabled = true;
    primaryBtn.textContent = "Import in corso…";
    void logEvent("import_quick_confirmed", { source, platform: "web", confirmation_mode: "quick", skipped: bucketCount(unresolvedCount) });
    try {
      const res = await confirmTitlesImport({ importId: currentImportId, skipRemaining: true });
      if (res?.status === "completed") {
        renderFinalSummary({ ...res, source });
      } else {
        // Non dovrebbe accadere (skipRemaining chiude sempre il job).
        toast(i18nT("Import non completato del tutto. Riprova."), "Attenzione", { timeout: 4000 });
        primaryBtn.disabled = false;
        primaryBtn.textContent = i18nT("Importa i titoli trovati");
      }
    } catch (err) {
      console.error("[import] quick confirm failed", err);
      toast(i18nT("Non sono riuscito a completare l'import. Riprova."), i18nT("Errore"), { timeout: 5000 });
      primaryBtn.disabled = false;
      primaryBtn.textContent = i18nT("Importa i titoli trovati");
    }
  });

  reviewBtn.addEventListener("click", () => {
    if (reviewBtn.disabled) return;
    reviewBtn.disabled = true;
    card.hidden = true;
    void logEvent("import_manual_review_opened", { source, platform: "web", unresolved: bucketCount(unresolvedCount) });
    root.appendChild(buildConfirmationQueueSection(items, { source, unresolvedCount }));
  });

  anotherBtn.addEventListener("click", () => { currentImportId = null; renderPickerStep(); });
}

function buildConfirmationQueueSection(items, { source, unresolvedCount = 0 } = {}) {
  const section = el("section", { class: "imp-card imp-queue" });
  section.appendChild(el("h2", {}, "Da confermare"));
  section.appendChild(el("p", { class: "imp-queue-hint" }, i18nT("Il testo sotto è solo il tentativo di Somto: cancellalo e cerca il titolo corretto, oppure salta la voce.")));
  section.appendChild(el("p", { class: "imp-queue-hint" }, i18nT("Quando chiudi l'import, le voci ancora da decidere vengono saltate e non aggiunte alla libreria.")));

  const toolbar = el("div", { class: "imp-queue-toolbar" });
  const skipAllBtn = el("button", { class: "imp-btn imp-btn-ghost imp-btn-small", type: "button" }, i18nT("Salta tutti"));
  toolbar.appendChild(skipAllBtn);
  section.appendChild(toolbar);

  const tallyLine = el("p", { class: "imp-queue-tally" }, "");
  section.appendChild(tallyLine);
  let submitBtn = null;

  function updateTally() {
    let accepted = 0;
    let skipped = 0;
    items.forEach((it) => {
      const choice = resolutionsPicked.get(it.id);
      if (!choice) return;
      if (choice.skip) skipped += 1;
      else accepted += 1;
    });
    const toDecide = Math.max(0, items.length - accepted - skipped);
    tallyLine.textContent = `Accettati ${accepted} · Saltati ${skipped} · Da decidere ${toDecide}`;
    if (submitBtn) {
      submitBtn.textContent = toDecide > 0
        ? i18nT("Conferma e salta {count}", { count: toDecide })
        : i18nT("Conferma e chiudi");
    }
  }

  const list = el("div", { class: "imp-queue-list", id: "impQueueList" });
  items.forEach((item) => list.appendChild(buildQueueRow(item, { onChange: updateTally })));
  section.appendChild(list);

  const actions = el("div", { class: "imp-actions imp-actions-wrap" });
  submitBtn = el("button", { class: "imp-btn imp-btn-primary", type: "button", id: "impSubmitResolutions" }, i18nT("Conferma e chiudi"));
  actions.appendChild(submitBtn);
  const anotherBtn = el("button", { class: "imp-btn imp-btn-ghost", type: "button" }, i18nT("Importa un'altra fonte"));
  anotherBtn.addEventListener("click", () => { currentImportId = null; renderPickerStep(); });
  actions.appendChild(anotherBtn);
  section.appendChild(actions);
  updateTally();

  submitBtn.addEventListener("click", () => void submitResolutions({ source, unresolvedCount }));
  skipAllBtn.addEventListener("click", () => void bulkSkipAll({ source, unresolvedCount }, skipAllBtn));

  return section;
}

function buildQueueRow(item, { onChange } = {}) {
  const notifyChange = typeof onChange === "function" ? onChange : () => {};
  const { kindLabel, detail } = formatRowLabel(item);
  const row = el("div", { class: "imp-queue-row", "data-item-id": item.id });

  const head = el("div", { class: "imp-queue-row-head" }, [
    el("span", { class: "imp-queue-kind" }, kindLabel),
    el("strong", {}, escapeHtml(detail)),
    item.episodeNameGuess ? el("small", {}, escapeHtml(item.episodeNameGuess)) : null,
  ]);
  row.appendChild(head);

  row.appendChild(el("p", { class: "imp-queue-not-found" }, [
    i18nT("Non trovato: «"),
    el("strong", {}, escapeHtml(detail)),
    i18nT("» — cerca il titolo giusto"),
  ]));

  const searchWrap = el("div", { class: "imp-queue-search" });
  const input = el("input", {
    type: "search",
    class: "imp-queue-input",
    placeholder: i18nT("Cerca: {what}", { what: detail || "" }),
  });
  const clearBtn = el("button", {
    type: "button",
    class: "imp-queue-clear",
    "aria-label": i18nT("Svuota la ricerca"),
    hidden: true,
  }, "✕");
  const results = el("div", { class: "imp-queue-results", hidden: true });
  const pickedLabel = el("div", { class: "imp-queue-picked", hidden: true });
  searchWrap.appendChild(input);
  searchWrap.appendChild(clearBtn);
  searchWrap.appendChild(results);
  searchWrap.appendChild(pickedLabel);

  // Suggestion chip: accetta in un tap il miglior tentativo del matcher. Il
  // server ri-valida comunque confidence>=0.6 + suggestion.tmdbId; qui
  // marchiamo solo la riga come risolta localmente per contatore/submit.
  const suggestion = item.suggestion;
  if (suggestion && suggestion.name) {
    const yearSuffix = suggestion.year ? ` (${suggestion.year})` : "";
    const suggestionChip = el("button", {
      type: "button",
      class: "imp-queue-suggestion-chip",
    }, `Usa: ${suggestion.name}${yearSuffix}`);
    suggestionChip.addEventListener("click", () => {
      resolutionsPicked.set(item.id, { acceptSuggestion: true, titleName: suggestion.name });
      row.classList.add("is-resolved");
      row.classList.remove("is-skipped");
      input.value = "";
      clearBtn.hidden = true;
      results.hidden = true;
      results.innerHTML = "";
      pickedLabel.hidden = false;
      pickedLabel.textContent = `Confermato: ${suggestion.name}`;
      notifyChange();
    });
    row.appendChild(suggestionChip);
  }

  row.appendChild(searchWrap);

  const rowActions = el("div", { class: "imp-queue-row-actions" });
  const skipBtn = el("button", { class: "imp-btn-link imp-btn-small", type: "button" }, i18nT("Salta questa voce"));
  rowActions.appendChild(skipBtn);
  row.appendChild(rowActions);

  let debounceTimer = null;
  input.addEventListener("input", () => {
    pickedLabel.hidden = true;
    clearBtn.hidden = input.value.length === 0;
    resolutionsPicked.delete(item.id);
    row.classList.remove("is-resolved", "is-skipped");
    notifyChange();
    const term = input.value.trim();
    if (debounceTimer) clearTimeout(debounceTimer);
    if (term.length < 2) {
      results.hidden = true;
      results.innerHTML = "";
      return;
    }
    debounceTimer = setTimeout(() => void runRowSearch(term, results, item, row, input, pickedLabel, notifyChange), 200);
  });

  clearBtn.addEventListener("click", () => {
    input.value = "";
    clearBtn.hidden = true;
    results.hidden = true;
    results.innerHTML = "";
    pickedLabel.hidden = true;
    resolutionsPicked.delete(item.id);
    row.classList.remove("is-resolved", "is-skipped");
    notifyChange();
    input.focus();
  });

  skipBtn.addEventListener("click", () => {
    resolutionsPicked.set(item.id, { skip: true });
    row.classList.add("is-skipped");
    row.classList.remove("is-resolved");
    results.hidden = true;
    pickedLabel.hidden = true;
    notifyChange();
  });

  return row;
}

async function runRowSearch(term, resultsNode, item, rowNode, inputNode, pickedLabel, notifyChange) {
  const runId = ++searchSeq;
  resultsNode.hidden = false;
  resultsNode.innerHTML = `<div class="imp-queue-result-hint">${i18nT("Ricerca…")}</div>`;
  const rows = await searchTitlesSmart(term, 6).catch(() => []);
  if (runId !== searchSeq) return;
  if (rows.length === 0) {
    resultsNode.innerHTML = `<div class="imp-queue-result-hint">${i18nT("Nessun risultato per \"{term}\".", { term: escapeHtml(term) })}</div>`;
    return;
  }
  resultsNode.innerHTML = "";
  rows.forEach((titleRow) => {
    const optionEl = el("button", { class: "imp-queue-result", type: "button" }, [
      el("span", {}, escapeHtml(titleRow.name || i18nT("Titolo"))),
      el("small", {}, `${titleRow.type === "tv" ? i18nT("Serie") : i18nT("Film")}${titleRow.year ? ` · ${titleRow.year}` : ""}`),
    ]);
    optionEl.addEventListener("click", () => {
      resolutionsPicked.set(item.id, { titleId: titleRow.id, titleName: titleRow.name });
      rowNode.classList.add("is-resolved");
      rowNode.classList.remove("is-skipped");
      pickedLabel.hidden = false;
      pickedLabel.textContent = `Confermato: ${titleRow.name}`;
      resultsNode.hidden = true;
      inputNode.value = titleRow.name || inputNode.value;
      if (typeof notifyChange === "function") notifyChange();
    });
    resultsNode.appendChild(optionEl);
  });
}

async function bulkSkipAll({ source, unresolvedCount }, triggerBtn) {
  if (triggerBtn) {
    triggerBtn.disabled = true;
    triggerBtn.textContent = "Salto in corso…";
  }
  void logEvent("import_quick_confirmed", { source, platform: "web", confirmation_mode: "manual", skipped: bucketCount(unresolvedCount) });
  try {
    const res = await confirmTitlesImport({ importId: currentImportId, skipRemaining: true });
    renderFinalSummary({ ...res, source });
  } catch (err) {
    console.error("[import] bulk skip-all failed", err);
    toast(i18nT("Non sono riuscito a completare l'import. Riprova."), i18nT("Errore"), { timeout: 5000 });
    if (triggerBtn) {
      triggerBtn.disabled = false;
      triggerBtn.textContent = i18nT("Salta tutti");
    }
  }
}

async function submitResolutions({ source, unresolvedCount } = {}) {
  // (source viene inoltrato a renderFinalSummary sotto: confirmTitlesImport
  // non ritorna un campo `source`, quindi va portato dal job doc reale.)
  const submitBtn = document.getElementById("impSubmitResolutions");
  const idleSubmitLabel = submitBtn?.textContent || i18nT("Conferma e chiudi");
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = i18nT("Conferma in corso…");
  }
  void logEvent("import_quick_confirmed", { source, platform: "web", confirmation_mode: "manual", skipped: bucketCount(unresolvedCount) });
  try {
    const resolutions = Array.from(resolutionsPicked.entries()).map(([itemId, choice]) => {
      if (choice.skip) return { itemId, skip: true };
      if (choice.acceptSuggestion) return { itemId, acceptSuggestion: true };
      return { itemId, titleId: choice.titleId };
    });
    // skipRemaining:true SEMPRE — le righe non decise vengono saltate, il job
    // si chiude in ogni caso (niente più stato intermedio da questa schermata).
    const res = await confirmTitlesImport({ importId: currentImportId, resolutions, skipRemaining: true });
    renderFinalSummary({ ...res, source });
  } catch (err) {
    console.error("confirmTitlesImport error", err);
    toast(i18nT("Non sono riuscito a salvare le conferme. Riprova."), i18nT("Errore"), { timeout: 5000 });
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = idleSubmitLabel;
    }
  }
}

/* ═══════════════════ step 4: riepilogo finale ═══════════════════ */

function renderFinalSummary(job) {
  let importedTitleCount = job?.importedTitleCount;
  if (importedTitleCount == null) {
    importedTitleCount = Array.isArray(job?.titleStateIdsWritten) ? job.titleStateIdsWritten.length : null;
  }
  if (importedTitleCount == null) importedTitleCount = Number(job?.matchedCount || 0);
  importedTitleCount = Number(importedTitleCount || 0);
  const skippedCount = Number(job?.skippedCount || 0);
  const errorCount = Number(job?.errorCount || 0);
  const source = importAnalyticsSource(job);

  // Unico punto in cui import_completed viene loggato — tutti i percorsi che
  // portano alla Schermata C (quick confirm, bulk in coda, submit manuale,
  // o direttamente dal listener del job) passano da qui.
  void logEvent("import_completed", { source, platform: "web", matched: bucketCount(importedTitleCount), skipped: bucketCount(skippedCount) });

  // Il momento migliore per chiedere le notifiche è questo: la libreria si è
  // appena riempita, quindi "ti avviso sulle tue serie" ha un significato
  // concreto. Prima l'unico invito era prima dell'import, quando ancora non
  // c'era niente da seguire. One-shot: se lo ignora non lo rivede.
  try {
    mountNotificationPermissionBanner({
      containerSelector: "main.container",
      user: currentUser,
      subtitleText: i18nT("Ti avvisiamo quando escono nuovi episodi delle serie che segui."),
      trigger: "post_import",
    });
  } catch (_) {}

  root.innerHTML = "";
  root.appendChild(el("header", { class: "imp-page-header" }, [
    el("h1", {}, i18nT("Importazione completata")),
  ]));
  const card = el("section", { class: "imp-card imp-final" });
  let headline = i18nT("Importati {count} titoli", { count: importedTitleCount });
  if (skippedCount > 0) headline += ` · ${skippedCount} saltati`;
  if (errorCount > 0) headline += ` · ${errorCount} errori`;
  card.appendChild(el("p", { class: "imp-final-headline" }, headline));
  card.appendChild(el("p", {}, i18nT("Li trovi già nel tuo profilo e nella watchlist, con il progresso delle serie aggiornato.")));

  // Cosa NON e' arrivato (film assenti dall'export, titoli non riconosciuti):
  // scritto dal backend in `warnings`. Senza, un import che ha lasciato fuori
  // meta' della libreria si presenta come un successo pieno.
  const warnings = Array.isArray(job?.warnings) ? job.warnings : [];
  for (const w of warnings) {
    if (!w?.message) continue;
    card.appendChild(el("p", { class: "imp-final-warning" }, w.message));
  }

  const actions = el("div", { class: "imp-actions imp-actions-wrap" });
  const libraryBtn = el("a", { class: "imp-btn imp-btn-primary", href: "/watchlist.html" }, i18nT("Vai alla mia libreria"));
  const markWatchingBtn = el("a", { class: "imp-btn imp-btn-ghost", href: "/watchlist.html" }, i18nT("Segna cosa stai guardando"));
  libraryBtn.addEventListener("click", () => { void logEvent("import_post_action_clicked", { platform: "web", action: "library" }); });
  markWatchingBtn.addEventListener("click", () => { void logEvent("import_post_action_clicked", { platform: "web", action: "mark_watching" }); });
  actions.appendChild(libraryBtn);
  actions.appendChild(markWatchingBtn);
  card.appendChild(actions);
  root.appendChild(card);
}

/* ═══════════════════ boot ═══════════════════ */

initAuthGuard({
  requireAuth: true,
  onReady: async (user) => {
    currentUid = user.uid;
    currentUser = user;

    try { mountNotificationPermissionBanner({ containerSelector: "main.container", user }); } catch (_) {}

    const importId = new URLSearchParams(window.location.search).get("id");
    if (importId) {
      currentImportId = importId;
      renderProgressStep({ status: "queued" });
      watchImportJob(importId);
      return;
    }

    // Riprendi un import gia' avviato invece di mostrare un form vuoto: un form
    // vuoto fa credere che il caricamento precedente non sia riuscito -> l'utente
    // ricarica lo stesso file (causa n.1 del carico Firestore). Se c'e' un import
    // in corso o pronto da confermare, mostriamo il suo stato.
    try {
      const active = await getActiveImport(currentUid);
      if (active) {
        currentImportId = active.id;
        if (active.status === "awaiting_confirmation") {
          void openConfirmationQueue(active.id, active);
        } else if (active.status === "failed") {
          // Non mandare al picker (= invito implicito a ricaricare): mostra la
          // schermata "in pausa" con Riprova elaborazione dal file salvato.
          renderImportFailedStep(active);
        } else {
          renderProgressStep(active);
          watchImportJob(active.id);
        }
        return;
      }
    } catch (_) { /* fail-open: mostra comunque il picker */ }

    renderPickerStep();
  },
});

window.addEventListener("pagehide", () => {
  if (jobUnsub) jobUnsub();
  stopTraktPolling();
});
