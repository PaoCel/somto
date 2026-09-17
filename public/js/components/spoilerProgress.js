// spoilerProgress.js — gate anti-spoiler basato sul PROGRESSO del viewer.
//
// Diverso da `spoilerGate.js` (flag manuale dell'autore + titoli completati):
// qui il contenuto porta con sé delle coordinate (`spoilerScope`: titolo,
// stagione, episodio) e il gate confronta quelle coordinate con quanto il
// viewer ha effettivamente visto (`users/{uid}/titleStates`).
//
// Regola (identica su iOS, vedi docs/context/SOCIAL_MODERATION.md):
// - film            → sbloccato se visto (`seen_unrated` / `rated`)
// - serie, episodio → sbloccato se la serie è completata, oppure se il
//                     watermark `seriesProgress` è >= (stagione, episodio)
// - serie, stagione → sbloccato se il viewer ha superato quella stagione
// - serie, titolo   → sbloccato se la serie è iniziata (in corso o finita)
// - titolo assente dalla libreria → BLOCCATO (default richiesto dal prodotto)
//
// Il gate è cortesia UX lato client, non un permesso: il testo resta pubblico
// in Firestore, esattamente come per il gate manuale già esistente.

import { escapeHtml } from "../utils/dom.js";
import { t as i18nT } from "../i18n/index.js";

const SEEN_MOVIE_STATES = new Set(["seen_unrated", "rated"]);
const COMPLETED_SERIES_STATES = new Set(["completed_unrated", "rated"]);
const STARTED_SERIES_STATES = new Set(["in_progress", "completed_unrated", "rated"]);

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * Normalizza un doc `users/{uid}/titleStates/{titleId}` nella forma minima che
 * serve al gate. Ritorna null se il titolo non è nella libreria del viewer.
 */
export function normalizeProgressEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const progress = raw.seriesProgress && typeof raw.seriesProgress === "object" ? raw.seriesProgress : {};
  return {
    mediaType: String(raw.mediaType || "").toLowerCase() === "tv" ? "tv" : "movie",
    state: String(raw.state || "").trim().toLowerCase(),
    lastSeason: toInt(progress.lastWatchedSeasonNumber),
    lastEpisode: toInt(progress.lastWatchedEpisodeNumber),
  };
}

/** `spoilerScope` del post-eco → forma normalizzata (o null). */
export function normalizeSpoilerScope(raw) {
  if (!raw || typeof raw !== "object") return null;
  const titleId = String(raw.titleId || "").trim();
  if (!titleId) return null;
  const level = ["title", "season", "episode"].includes(String(raw.level || "").trim())
    ? String(raw.level).trim()
    : "title";
  return {
    titleId,
    level,
    season: toInt(raw.season) || null,
    episode: toInt(raw.episode) || null,
  };
}

/**
 * Il viewer può leggere in chiaro?
 *
 * @param {Object|null} scope  coordinate del contenuto (normalizeSpoilerScope)
 * @param {Object|null} entry  progresso del viewer (normalizeProgressEntry)
 * @returns {boolean}
 */
export function isUnlockedByProgress(scope, entry) {
  if (!scope) return true;              // nessuna coordinata = niente da nascondere
  if (!entry) return false;             // titolo non in libreria = bloccato

  if (entry.mediaType === "movie") {
    return SEEN_MOVIE_STATES.has(entry.state);
  }

  if (COMPLETED_SERIES_STATES.has(entry.state)) return true;

  if (scope.level === "episode" && scope.season && scope.episode) {
    if (!entry.lastSeason) return false;
    if (entry.lastSeason > scope.season) return true;
    if (entry.lastSeason < scope.season) return false;
    return entry.lastEpisode >= scope.episode;
  }

  if (scope.level === "season" && scope.season) {
    // Serve aver superato la stagione: dentro la stagione stessa un commento
    // "di stagione" può bruciare il finale.
    return entry.lastSeason > scope.season;
  }

  // Livello titolo: basta aver iniziato la serie.
  return STARTED_SERIES_STATES.has(entry.state);
}

/** Etichetta breve del punto coperto dal commento ("S3·E7", "Stagione 3"). */
export function scopeLabel(scope) {
  if (!scope) return "";
  if (scope.level === "episode" && scope.season && scope.episode) {
    return `S${scope.season}·E${scope.episode}`;
  }
  if (scope.level === "season" && scope.season) {
    return i18nT("Stagione {season}", { season: scope.season });
  }
  return "";
}

/**
 * Avvolge `htmlContent` nello stesso markup di `spoilerGate.js` (`.spoiler-gate`
 * + `[data-action="reveal"]`), così `attachSpoilerHandlers` continua a gestire
 * lo sblocco per-item senza codice nuovo.
 *
 * Nessun bottone "Ho visto X": marcare un titolo completato per leggere un
 * commento falsificherebbe la libreria. Si sblocca solo il singolo contenuto.
 *
 * @param {string} htmlContent  HTML già safe del contenuto sensibile
 * @param {Object} opts
 * @param {Object|null} opts.scope
 * @param {Object|null} opts.entry
 * @param {string} [opts.titleName]
 * @returns {string} HTML
 */
export function wrapProgressSpoiler(htmlContent, { scope, entry, titleName = "" } = {}) {
  if (isUnlockedByProgress(scope, entry)) return htmlContent;

  // Con coordinate precise (episodio/stagione) si dice a che punto ci si
  // riferisce; senza, vale il caso generale "questo titolo non l'hai visto"
  // — che copre sia il film mai visto sia la serie mai iniziata sia il titolo
  // fuori libreria.
  const label = scopeLabel(scope);
  const subtitle = label
    ? i18nT("Commento su {label}: non sei ancora arrivato qui.", { label })
    : i18nT("Non hai ancora visto questo titolo.");

  const name = String(titleName || "").trim();

  return `
    <div class="spoiler-gate spoiler-gate--progress" data-spoiler-gate data-spoiler-progress="1">
      <div class="spoiler-content">${htmlContent}</div>
      <div class="spoiler-overlay">
        <div class="spoiler-overlay-icon" aria-hidden="true">🙈</div>
        <div class="spoiler-overlay-title">${i18nT("Contiene spoiler")}</div>
        <div class="spoiler-overlay-subtitle">${escapeHtml(name ? `${name} · ${subtitle}` : subtitle)}</div>
        <button class="spoiler-reveal-btn" type="button" data-action="reveal">${i18nT("Tocca per mostrare")}</button>
      </div>
    </div>
  `;
}
