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
    return { title: null, candidates: [], errors: [{ request: "input", message: "Titolo o tmdbId non valido" }] };
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

  return {
    title,
    candidates: buildTmdbTitleUpdateCandidates({
      titleId: title.id,
      tmdbId: title.tmdbId,
      mediaType: title.mediaType,
      ...payloads,
    }),
    errors,
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
  filterCandidatesByWindow,
  normalizeTitleForUpdateScan,
  scanTitleForUpdateCandidates,
  summarizeTitleUpdateScan,
};
