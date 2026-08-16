const MAX_VIDEO_CANDIDATES = 50;

function safeText(value, maxLength = 240) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeMediaType(value) {
  return String(value || "").toLowerCase() === "tv" ? "tv" : "movie";
}

function normalizeDate(value) {
  const raw = safeText(value, 40);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function normalizeCalendarDate(value) {
  const raw = safeText(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = Date.parse(`${raw}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? raw : null;
}

function localizedMap(entries) {
  const out = {};
  for (const [locale, value] of entries) {
    const text = safeText(value, 240);
    if (text) out[locale] = text;
  }
  return out;
}

function pickRegionalMovieRelease(payload, region = "IT") {
  const regionCode = safeText(region, 2).toUpperCase();
  const bundle = (Array.isArray(payload?.results) ? payload.results : [])
    .find((row) => safeText(row?.iso_3166_1, 2).toUpperCase() === regionCode);
  const priorities = new Map([[3, 0], [2, 1], [4, 2], [6, 3], [1, 4], [5, 5]]);
  const candidates = (Array.isArray(bundle?.release_dates) ? bundle.release_dates : [])
    .map((row) => ({
      date: normalizeDate(row?.release_date)?.slice(0, 10) || null,
      type: Math.floor(Number(row?.type)),
      note: safeText(row?.note, 160),
    }))
    .filter((row) => row.date && priorities.has(row.type))
    .sort((a, b) => {
      const typeDiff = priorities.get(a.type) - priorities.get(b.type);
      return typeDiff || a.date.localeCompare(b.date);
    });
  return candidates[0] || null;
}

function videoRows(payload) {
  return Array.isArray(payload?.results) ? payload.results : [];
}

function normalizeTmdbVideo(row, requestedLocale) {
  const site = safeText(row?.site, 40).toLowerCase();
  const key = safeText(row?.key, 120);
  const type = safeText(row?.type, 40).toLowerCase();
  if (site !== "youtube" || !key || (type !== "trailer" && type !== "teaser")) {
    return null;
  }
  const declaredLanguage = safeText(row?.iso_639_1, 12).toLowerCase();
  const locale = requestedLocale === "default"
    ? (declaredLanguage === "it" ? "it-IT" : declaredLanguage === "en" ? "en-US" : "und")
    : requestedLocale;

  return {
    key,
    name: safeText(row?.name, 240) || (type === "teaser" ? "Teaser" : "Trailer"),
    type,
    official: row?.official === true,
    publishedAt: normalizeDate(row?.published_at),
    locale,
    localizedNames: { [locale]: safeText(row?.name, 240) || (type === "teaser" ? "Teaser" : "Trailer") },
  };
}

// TMDB localizza anche l'elenco video: la risposta it-IT può essere vuota o
// parziale. Uniamo quindi it-IT, en-US e risposta senza lingua, conservando
// tutte le label note quando lo stesso video compare in più risposte.
function mergeTmdbVideoPayloads({
  localizedPayload,
  englishPayload,
  fallbackPayload,
  max = MAX_VIDEO_CANDIDATES,
} = {}) {
  const merged = new Map();
  const sources = [
    { payload: localizedPayload, locale: "it-IT" },
    { payload: englishPayload, locale: "en-US" },
    { payload: fallbackPayload, locale: "default" },
  ];

  for (const source of sources) {
    for (const row of videoRows(source.payload)) {
      const normalized = normalizeTmdbVideo(row, source.locale);
      if (!normalized) continue;
      const existing = merged.get(normalized.key);
      if (existing) {
        existing.localizedNames = {
          ...normalized.localizedNames,
          ...existing.localizedNames,
        };
        existing.official = existing.official || normalized.official;
        existing.publishedAt = existing.publishedAt || normalized.publishedAt;
        continue;
      }
      merged.set(normalized.key, normalized);
      if (merged.size >= Math.max(1, Math.min(Number(max) || MAX_VIDEO_CANDIDATES, MAX_VIDEO_CANDIDATES))) break;
    }
  }

  const localePriority = { "it-IT": 0, "en-US": 1, und: 2 };
  return [...merged.values()].sort((a, b) => {
    const dateDiff = (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0);
    if (dateDiff !== 0) return dateDiff;
    const localeDiff = (localePriority[a.locale] ?? 9) - (localePriority[b.locale] ?? 9);
    if (localeDiff !== 0) return localeDiff;
    if (a.official !== b.official) return a.official ? -1 : 1;
    return a.key.localeCompare(b.key);
  });
}

function makeTmdbVideoCandidateId({ mediaType, tmdbId, videoKey }) {
  const numericTmdbId = Math.floor(Number(tmdbId));
  const safeVideoKey = safeText(videoKey, 120).replace(/[^a-zA-Z0-9_-]/g, "");
  if (!Number.isFinite(numericTmdbId) || numericTmdbId <= 0 || !safeVideoKey) return null;
  return `tmdb_video_${normalizeMediaType(mediaType)}_${numericTmdbId}_${safeVideoKey}`;
}

// Produce candidati puri: nessuna scrittura e nessuna decisione di fanout.
// Solo i video marcati official da TMDB sono eleggibili per l'auto-publish;
// gli altri potranno essere salvati come bozza dal futuro scanner.
function buildTmdbVideoCandidates({
  titleId,
  tmdbId,
  mediaType,
  localizedPayload,
  englishPayload,
  fallbackPayload,
} = {}) {
  const cleanTitleId = safeText(titleId, 160);
  if (!cleanTitleId) return [];

  return mergeTmdbVideoPayloads({ localizedPayload, englishPayload, fallbackPayload }).flatMap((video) => {
    const id = makeTmdbVideoCandidateId({ mediaType, tmdbId, videoKey: video.key });
    if (!id) return [];
    return [{
      id,
      titleId: cleanTitleId,
      tmdbId: Math.floor(Number(tmdbId)),
      mediaType: normalizeMediaType(mediaType),
      eventType: video.type,
      source: "tmdb",
      sourceId: video.key,
      sourceUrl: `https://www.youtube.com/watch?v=${video.key}`,
      headline: video.name,
      publishedAt: video.publishedAt,
      sourceLocale: video.locale,
      localizedNames: video.localizedNames,
      headlineByLocale: { ...video.localizedNames },
      availableLocales: Object.keys(video.localizedNames),
      official: video.official,
      autoPublishEligible: video.official,
      confidence: video.official ? 1 : 0.7,
    }];
  });
}

function makeTmdbReleaseCandidateId({ mediaType, tmdbId, season, episode }) {
  const numericTmdbId = Math.floor(Number(tmdbId));
  if (!Number.isFinite(numericTmdbId) || numericTmdbId <= 0) return null;
  const normalizedType = normalizeMediaType(mediaType);
  if (normalizedType === "movie") return `tmdb_release_movie_${numericTmdbId}`;

  const seasonNumber = Math.floor(Number(season));
  const episodeNumber = Math.floor(Number(episode));
  if (seasonNumber < 0 || episodeNumber <= 0) return null;
  return `tmdb_release_tv_${numericTmdbId}_s${seasonNumber}_e${episodeNumber}`;
}

function episodeLabel(row) {
  const season = Math.floor(Number(row?.season_number));
  const episode = Math.floor(Number(row?.episode_number));
  if (season < 0 || episode <= 0) return "";
  return `S${season}E${episode}`;
}

function buildTmdbReleaseCandidates({
  titleId,
  tmdbId,
  mediaType,
  localizedDetails,
  englishDetails,
  fallbackDetails,
  releaseDatesPayload,
} = {}) {
  const cleanTitleId = safeText(titleId, 160);
  const normalizedType = normalizeMediaType(mediaType);
  const numericTmdbId = Math.floor(Number(tmdbId));
  if (!cleanTitleId || !Number.isFinite(numericTmdbId) || numericTmdbId <= 0) return [];

  if (normalizedType === "movie") {
    const regionalRelease = pickRegionalMovieRelease(releaseDatesPayload, "IT");
    const fallbackDate = normalizeCalendarDate(
      localizedDetails?.release_date || englishDetails?.release_date || fallbackDetails?.release_date
    );
    const effectiveDate = regionalRelease?.date || fallbackDate;
    if (!effectiveDate) return [];
    const regionConfirmed = Boolean(regionalRelease);
    return [{
      id: makeTmdbReleaseCandidateId({ mediaType: normalizedType, tmdbId: numericTmdbId }),
      titleId: cleanTitleId,
      tmdbId: numericTmdbId,
      mediaType: normalizedType,
      eventType: "release_date",
      source: "tmdb",
      sourceId: `movie:${numericTmdbId}:release`,
      sourceUrl: `https://www.themoviedb.org/movie/${numericTmdbId}`,
      effectiveDate,
      region: regionConfirmed ? "IT" : null,
      releaseType: regionalRelease?.type || null,
      headlineByLocale: localizedMap([
        ["it-IT", regionConfirmed ? "Data di uscita in Italia aggiornata" : "Data di uscita da verificare"],
        ["en-US", regionConfirmed ? "Italian release date updated" : "Release date requires review"],
      ]),
      availableLocales: ["it-IT", "en-US"],
      official: false,
      autoPublishEligible: regionConfirmed,
      confidence: regionConfirmed ? 1 : 0.6,
      reviewReason: regionConfirmed ? null : "missing_it_release_date",
    }];
  }

  const localizedEpisode = localizedDetails?.next_episode_to_air || null;
  const englishEpisode = englishDetails?.next_episode_to_air || null;
  const fallbackEpisode = fallbackDetails?.next_episode_to_air || null;
  const primary = localizedEpisode || englishEpisode || fallbackEpisode;
  const season = Math.floor(Number(primary?.season_number));
  const episode = Math.floor(Number(primary?.episode_number));
  const effectiveDate = normalizeCalendarDate(primary?.air_date);
  const id = makeTmdbReleaseCandidateId({ mediaType: normalizedType, tmdbId: numericTmdbId, season, episode });
  if (!id || !effectiveDate) return [];

  const label = episodeLabel(primary);
  const matchesPrimary = (row) => (
    row
    && Math.floor(Number(row.season_number)) === season
    && Math.floor(Number(row.episode_number)) === episode
  );
  const itName = matchesPrimary(localizedEpisode) ? safeText(localizedEpisode.name, 180) : "";
  const enName = matchesPrimary(englishEpisode) ? safeText(englishEpisode.name, 180) : "";

  return [{
    id,
    titleId: cleanTitleId,
    tmdbId: numericTmdbId,
    mediaType: normalizedType,
    eventType: "new_episode",
    source: "tmdb",
    sourceId: `tv:${numericTmdbId}:s${season}:e${episode}`,
    sourceUrl: `https://www.themoviedb.org/tv/${numericTmdbId}/season/${season}/episode/${episode}`,
    effectiveDate,
    season,
    episode,
    entityNameByLocale: localizedMap([
      ["it-IT", itName],
      ["en-US", enName],
    ]),
    headlineByLocale: localizedMap([
      ["it-IT", `Nuovo episodio: ${itName || label}`],
      ["en-US", `New episode: ${enName || label}`],
    ]),
    availableLocales: ["it-IT", "en-US"],
    official: false,
    autoPublishEligible: true,
    confidence: 1,
  }];
}

function buildTmdbTitleUpdateCandidates(input = {}) {
  return [
    ...buildTmdbVideoCandidates(input),
    ...buildTmdbReleaseCandidates(input),
  ];
}

module.exports = {
  MAX_VIDEO_CANDIDATES,
  buildTmdbReleaseCandidates,
  buildTmdbTitleUpdateCandidates,
  buildTmdbVideoCandidates,
  makeTmdbReleaseCandidateId,
  makeTmdbVideoCandidateId,
  mergeTmdbVideoPayloads,
  normalizeCalendarDate,
  normalizeTmdbVideo,
  pickRegionalMovieRelease,
};
