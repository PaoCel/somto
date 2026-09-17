const { buildTmdbTitleUpdateCandidates } = require("./titleUpdateCandidates");

const REQUEST_LOCALES = ["it-IT", "en-US", null];

function safeText(value, maxLength = 240) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeTitleForUpdateScan(input = {}) {
  const tmdbId = Math.floor(Number(input.tmdbId || input.meta?.tmdbId || input.sourceTmdb?.tmdbId));
  const id = safeText(input.id || input.titleId, 160);
  if (!id || !Number.isFinite(tmdbId) || tmdbId <= 0) return null;
  return {
    id,
    name: safeText(input.name || input.title, 240),
    tmdbId,
    mediaType: String(input.type || input.mediaType || input.meta?.mediaType).toLowerCase() === "tv" ? "tv" : "movie",
  };
}

function buildTmdbUpdateRequestPlan(titleInput) {
  const title = normalizeTitleForUpdateScan(titleInput);
  if (!title) return [];
  const basePath = `/${title.mediaType}/${title.tmdbId}`;
  const plan = [];
  for (const locale of REQUEST_LOCALES) {
    const suffix = locale === "it-IT" ? "localized" : locale === "en-US" ? "english" : "fallback";
    plan.push({ key: `${suffix}Payload`, path: `${basePath}/videos`, params: locale ? { language: locale } : {} });
  }
  for (const locale of REQUEST_LOCALES) {
    const suffix = locale === "it-IT" ? "localized" : locale === "en-US" ? "english" : "fallback";
    plan.push({ key: `${suffix}Details`, path: basePath, params: locale ? { language: locale } : {} });
  }
  if (title.mediaType === "movie") {
    plan.push({ key: "releaseDatesPayload", path: `${basePath}/release_dates`, params: {} });
  }
  return plan;
}

async function scanTitleForUpdateCandidates({ title: titleInput, fetchJson }) {
  const title = normalizeTitleForUpdateScan(titleInput);
  if (!title) {
    return { title: null, candidates: [], errors: [{ request: "input", message: "Titolo o tmdbId non valido" }], sourceSnapshot: null };
  }
  if (typeof fetchJson !== "function") throw new Error("fetchJson obbligatorio");

  const payloads = {};
  const errors = [];
  await Promise.all(buildTmdbUpdateRequestPlan(title).map(async (request) => {
    try {
      payloads[request.key] = await fetchJson(request.path, request.params);
    } catch (err) {
      payloads[request.key] = {};
      errors.push({ request: request.key, message: safeText(err?.message || err, 240) });
    }
  }));

  const details = [payloads.localizedDetails, payloads.englishDetails, payloads.fallbackDetails]
    .find((row) => row && typeof row === "object" && Object.keys(row).length) || {};
  const nextEpisode = details?.next_episode_to_air || null;
  return {
    title,
    candidates: buildTmdbTitleUpdateCandidates({
      titleId: title.id,
      tmdbId: title.tmdbId,
      mediaType: title.mediaType,
      ...payloads,
    }),
    errors,
    // Segnale debole per l'audit editoriale: non pubblica niente. Serve a
    // trovare serie che TMDB chiama "Returning Series" ma per cui non esiste
    // ancora un prossimo episodio o un aggiornamento ufficiale Somto.
    sourceSnapshot: title.mediaType === "tv" ? {
      seriesStatus: safeText(details?.status, 80) || null,
      seasonsCount: Math.max(0, Math.floor(Number(details?.number_of_seasons) || 0)),
      nextEpisodeAirDate: safeText(nextEpisode?.air_date, 10) || null,
    } : null,
  };
}

function candidateTimestampMs(candidate) {
  const raw = candidate?.publishedAt || candidate?.effectiveDate;
  if (!raw) return null;
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : null;
}

function filterCandidatesByWindow(candidates, { sinceMs, untilMs = Date.now() } = {}) {
  const lower = Number.isFinite(Number(sinceMs)) ? Number(sinceMs) : 0;
  const upper = Number.isFinite(Number(untilMs)) ? Number(untilMs) : Date.now();
  return (Array.isArray(candidates) ? candidates : []).filter((candidate) => {
    const timestamp = candidateTimestampMs(candidate);
    return timestamp !== null && timestamp >= lower && timestamp <= upper;
  });
}

/**
 * Divide i candidati fra quelli con data ancora da venire e gli altri.
 *
 * PERCHE' SERVE — il gate backfill esiste per un motivo preciso: alla prima
 * scansione di un titolo TMDB ci restituisce tutto lo storico e non sapremmo
 * distinguere una novita' da una cosa di tre anni fa. Ma un evento datato
 * DOMANI non puo' essere storia: quel dubbio non esiste.
 *
 * Senza questa distinzione un titolo che entra in catalogo poco prima della sua
 * uscita non puo' notificare nessuno, mai: l'episodio 1 viene scoperto al primo
 * scan, nasce backfill e `mergeExistingEvent` lo tiene non notificabile per
 * sempre. E' esattamente il caso di ogni uscita che vogliamo promuovere.
 *
 * Il confronto e' per GIORNO di calendario a Roma, come
 * `titleUpdateWaitsForAirDate`: un episodio che va in onda oggi non e' "futuro",
 * e non deve scavalcare il gate solo perche' mancano tre ore.
 */
function splitFutureCandidates(candidates, nowMs = Date.now()) {
  const today = romeDayKey(nowMs);
  const future = [];
  const past = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const timestamp = candidateTimestampMs(candidate);
    if (timestamp !== null && romeDayKey(timestamp) > today) future.push(candidate);
    else past.push(candidate);
  }
  return { future, past };
}

/** `YYYYMMDD` a Roma, come i contatori delle notifiche. */
function romeDayKey(ms) {
  return Number(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Number(ms))).replaceAll("-", ""));
}

function increment(counter, key) {
  const normalized = safeText(key, 80) || "unknown";
  counter[normalized] = Number(counter[normalized] || 0) + 1;
}

function summarizeTitleUpdateScan(results, { sinceMs, untilMs = Date.now(), apiCalls = 0 } = {}) {
  const rows = Array.isArray(results) ? results : [];
  const candidates = rows.flatMap((row) => Array.isArray(row?.candidates) ? row.candidates : []);
  const recent = filterCandidatesByWindow(candidates, { sinceMs, untilMs });
  const byType = {};
  const byLocale = {};
  for (const candidate of candidates) {
    increment(byType, candidate.eventType);
    for (const locale of Array.isArray(candidate.availableLocales) ? candidate.availableLocales : []) {
      increment(byLocale, locale);
    }
  }

  return {
    readOnly: true,
    titlesScanned: rows.filter((row) => row?.title).length,
    candidatesFound: candidates.length,
    recentCandidates: recent.length,
    autoPublishEligible: candidates.filter((row) => row.autoPublishEligible === true).length,
    reviewRequired: candidates.filter((row) => row.autoPublishEligible !== true).length,
    requestErrors: rows.reduce((sum, row) => sum + (Array.isArray(row?.errors) ? row.errors.length : 0), 0),
    apiCalls: Math.max(0, Math.floor(Number(apiCalls) || 0)),
    byType,
    byLocale,
  };
}

module.exports = {
  REQUEST_LOCALES,
  buildTmdbUpdateRequestPlan,
  candidateTimestampMs,
  splitFutureCandidates,
  filterCandidatesByWindow,
  normalizeTitleForUpdateScan,
  scanTitleForUpdateCandidates,
  summarizeTitleUpdateScan,
};
