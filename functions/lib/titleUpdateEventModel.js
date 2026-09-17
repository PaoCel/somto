const EVENT_TYPES = new Set(["trailer", "teaser", "release_date", "new_episode"]);
const ACQUISITION_MODES = new Set(["live", "backfill", "manual"]);

// Campi che una persona puo' fissare a mano, rendendoli immuni allo scanner.
//
// PERCHE' ESISTE — l'id di un evento release_date e' `tmdb_release_movie_<id>`:
// la data NON entra nell'id, quindi c'e' un documento solo per titolo e lo
// scanner, che ripassa su ogni titolo ogni ~2,5 giorni, riscrive `effectiveAt`
// col valore TMDB. Senza questa lista una correzione editoriale durerebbe al
// massimo un paio di giorni.
//
// `sortAt` e' qui perche' e' DERIVATO da `effectiveAt` (vedi document.sortAt):
// fissare la data senza fissare l'ordinamento lascerebbe l'evento ordinato
// sulla data vecchia. Chi corregge la data blocca entrambi.
const LOCKABLE_FIELDS = new Set(["effectiveAt", "sortAt", "region", "releaseType"]);
const SOURCE_URL_HOSTS = new Set(["youtube.com", "www.youtube.com", "youtu.be", "themoviedb.org", "www.themoviedb.org"]);
const LOCALES = ["it-IT", "en-US", "und"];

function safeText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function parseDate(value, { calendarDate = false } = {}) {
  if (!value) return null;
  const raw = String(value).trim();
  const parsed = Date.parse(calendarDate && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T12:00:00.000Z` : raw);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function normalizeSourceUrl(value) {
  const raw = safeText(value, 600);
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    return null;
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.port
    || !SOURCE_URL_HOSTS.has(url.hostname.toLowerCase())
  ) return null;
  return url.toString().slice(0, 600);
}

function normalizeLocalizedText(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const out = {};
  for (const locale of LOCALES) {
    const text = safeText(input[locale], 240);
    if (text) out[locale] = text;
  }
  return out;
}

function pickLocalizedText(value, requestedLocale) {
  const map = normalizeLocalizedText(value);
  const requested = safeText(requestedLocale, 20);
  const candidates = [];
  if (requested) candidates.push(requested);
  if (requested.toLowerCase().startsWith("en")) candidates.push("en-US");
  if (requested.toLowerCase().startsWith("it")) candidates.push("it-IT");
  candidates.push("en-US", "it-IT", "und");
  for (const locale of [...new Set(candidates)]) {
    if (map[locale]) return { locale, text: map[locale] };
  }
  return null;
}

function sourceTrustForCandidate(candidate) {
  if (candidate?.official === true) return "official";
  if (candidate?.source === "tmdb" && Number(candidate?.confidence) >= 1) return "structured";
  return "unverified";
}

function buildTitleUpdateEventDocument(candidate, options = {}) {
  const id = safeText(candidate?.id, 240);
  const titleId = safeText(candidate?.titleId, 160);
  const eventType = safeText(candidate?.eventType, 40);
  const source = safeText(candidate?.source, 40);
  const sourceId = safeText(candidate?.sourceId, 180);
  const mediaType = candidate?.mediaType === "tv" ? "tv" : "movie";
  const tmdbId = Math.floor(Number(candidate?.tmdbId));
  const sourceUrl = normalizeSourceUrl(candidate?.sourceUrl);
  const headlineByLocale = normalizeLocalizedText(candidate?.headlineByLocale || candidate?.localizedNames);
  const entityNameByLocale = normalizeLocalizedText(candidate?.entityNameByLocale);
  const acquisitionMode = ACQUISITION_MODES.has(options.acquisitionMode) ? options.acquisitionMode : "backfill";
  const now = parseDate(options.now || new Date()) || new Date();

  if (!id || !titleId || !source || !sourceId) throw new Error("Identità evento incompleta");
  if (!EVENT_TYPES.has(eventType)) throw new Error(`Tipo evento non consentito: ${eventType || "missing"}`);
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) throw new Error("tmdbId non valido");
  if (!sourceUrl) throw new Error("sourceUrl non consentito");
  if (!Object.keys(headlineByLocale).length) throw new Error("headlineByLocale vuoto");

  const sourcePublishedAt = parseDate(candidate?.publishedAt);
  const effectiveAt = parseDate(candidate?.effectiveDate, { calendarDate: true });
  if (!sourcePublishedAt && !effectiveAt) throw new Error("Evento senza data valida");

  const sourceTrust = sourceTrustForCandidate(candidate);
  const publishRequested = options.publishEligible === true;
  const status = publishRequested && candidate?.autoPublishEligible === true && sourceTrust !== "unverified"
    ? "published"
    : "draft";
  const notificationEligible = acquisitionMode === "live" && status === "published";
  const availableLocales = Object.keys(headlineByLocale);

  const document = {
    schemaVersion: 1,
    titleId,
    tmdbId,
    mediaType,
    eventType,
    status,
    source,
    sourceId,
    sourceUrl,
    sourceTrust,
    official: candidate?.official === true,
    confidence: Math.max(0, Math.min(1, Number(candidate?.confidence) || 0)),
    headlineByLocale,
    entityNameByLocale,
    availableLocales,
    acquisitionMode,
    notificationEligible,
    discoveredAt: now,
    updatedAt: now,
    sortAt: sourcePublishedAt || effectiveAt || now,
    sourcePublishedAt,
    effectiveAt,
    region: null,
    releaseType: null,
    season: null,
    episode: null,
    reviewReason: null,
  };

  if (status === "published") document.firstPublishedAt = now;

  const region = safeText(candidate?.region, 2).toUpperCase();
  if (region) document.region = region;
  const releaseType = Math.floor(Number(candidate?.releaseType));
  if (releaseType > 0 && releaseType <= 6) document.releaseType = releaseType;
  const season = Math.floor(Number(candidate?.season));
  const episode = Math.floor(Number(candidate?.episode));
  if (mediaType === "tv" && season >= 0) document.season = season;
  if (eventType === "new_episode" && episode > 0) document.episode = episode;
  const reviewReason = safeText(candidate?.reviewReason, 120);
  if (reviewReason) document.reviewReason = reviewReason;

  return { id, document };
}

/**
 * Costruisce il blocco `editorial` da salvare quando una persona corregge un
 * evento a mano. Lo scrive SOLO la callable admin: lo scanner non lo produce
 * mai, ed e' proprio per questo che `set(..., {merge:true})` lo lascia intatto.
 *
 * Non contiene i valori corretti: quelli finiscono nei campi veri del
 * documento (`effectiveAt`, …). Qui c'e' solo *chi* ha deciso, *quando*, e
 * *quali campi* non vanno piu' toccati.
 */
function buildEditorialOverride({ lockedFields, editedBy, note, now = new Date() } = {}) {
  const fields = [...new Set(
    (Array.isArray(lockedFields) ? lockedFields : [])
      .map((field) => safeText(field, 40))
      .filter((field) => LOCKABLE_FIELDS.has(field))
  )].sort();

  if (!fields.length) throw new Error("Nessun campo bloccabile valido");

  const uid = safeText(editedBy, 128);
  if (!uid) throw new Error("editedBy obbligatorio");

  const editedAt = parseDate(now) || new Date();

  return {
    lockedFields: fields,
    editedBy: uid,
    editedAt,
    note: safeText(note, 240) || null,
    // Lo riempie lo SCANNER quando la fonte propone un valore diverso da
    // quello fissato. Una correzione nuova azzera il conflitto precedente:
    // la persona ha appena guardato il caso.
    sourceConflict: null,
  };
}

module.exports = {
  ACQUISITION_MODES,
  EVENT_TYPES,
  LOCALES,
  LOCKABLE_FIELDS,
  SOURCE_URL_HOSTS,
  buildEditorialOverride,
  buildTitleUpdateEventDocument,
  normalizeLocalizedText,
  normalizeSourceUrl,
  pickLocalizedText,
  sourceTrustForCandidate,
};
