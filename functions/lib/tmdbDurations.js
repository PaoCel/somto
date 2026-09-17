"use strict";

// Shared helper to derive episode-runtime for a TV title from a TMDB
// `/tv/{id}` details payload, with fallbacks for the (very common, ~86% of
// series) case where `episode_run_time` comes back empty from TMDB.
//
// Root cause fixed here: functions/index.js's buildTmdbTitleRefreshPatch only
// read `episode_run_time` (show-level average), which TMDB frequently omits
// for ongoing/newer series. That left `meta.durationEpisode` unset, which in
// turn made `computeWatchMinutesContribution` (functions/lib/titleStates.js)
// return 0 for every "visto" state on that title.
//
// Fallback order (all fields already present in the same `/tv/{id}` details
// response, so this never triggers extra TMDB calls):
//   1. average of the REAL per-episode runtimes, when the caller appended the
//      season payloads (`season/N` keys, see collectAppendedSeasonRuntimes)
//   2. episode_run_time[0] (or scalar) if > 0
//   3. last_episode_to_air.runtime if > 0
//   4. next_episode_to_air.runtime if > 0
//   5. null (no fallback left; caller must leave the field unset)
//
// Perche' la media reale viene PRIMA: `episode_run_time` e' vuoto su ~86%
// delle serie e i due fallback per-episodio prendono UN solo episodio — quasi
// sempre il finale, che le serie moderne fanno lungo il doppio. Su un campione
// di 70 serie popolari del catalogo, 20 avevano la durata episodio sbagliata
// oltre il 20%: Stranger Things 129' invece di 65' (+45h sulla serie intera),
// Il Trono di Spade 80' invece di 58', Friends 48' invece di 24'. Quel numero
// moltiplica ogni episodio visto in `computeWatchMinutesContribution`, quindi
// l'errore finisce dritto sulle ore viste del profilo. Anche quando
// `episode_run_time` c'e' puo' essere sbagliato (Don Matteo: 45' dichiarati,
// 62' reali), quindi i runtime veri degli episodi vincono su tutto.

function toPositiveIntOrNull(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  return rounded > 0 ? rounded : null;
}

// Minimo di episodi con runtime prima di fidarsi della media: sotto questa
// soglia il campione e' piccolo quanto il singolo episodio dei fallback, e non
// vale la pena scavalcare `episode_run_time`.
const MIN_EPISODE_RUNTIME_SAMPLES = 3;

/**
 * Raccoglie i runtime dei singoli episodi dalle stagioni che il chiamante ha
 * chiesto in `append_to_response` (`season/1,season/2,...`). TMDB le espone
 * come chiavi letterali "season/N" sul payload dei details, quindi questa
 * funzione non fa I/O: legge solo quello che c'e' gia'. Salta la stagione 0
 * (speciali: durate fuori scala) e gli episodi senza runtime.
 *
 * @param {object} details - payload `/tv/{id}` eventualmente con le stagioni.
 * @returns {number[]} runtime in minuti, uno per episodio.
 */
function collectAppendedSeasonRuntimes(details) {
  const payload = details && typeof details === "object" ? details : {};
  const runtimes = [];
  for (const key of Object.keys(payload)) {
    const m = key.match(/^season\/(\d+)$/);
    if (!m || Number(m[1]) <= 0) continue;
    const episodes = payload[key] && Array.isArray(payload[key].episodes) ? payload[key].episodes : [];
    for (const episode of episodes) {
      const runtime = toPositiveIntOrNull(episode?.runtime);
      if (runtime) runtimes.push(runtime);
    }
  }
  return runtimes;
}

/**
 * @param {object} detailsIt - raw TMDB `/tv/{id}` details payload (any language).
 * @returns {{ value: number|null, source: string|null }}
 */
function resolveTvEpisodeRuntime(detailsIt) {
  const details = detailsIt && typeof detailsIt === "object" ? detailsIt : {};

  // Media (non mediana) sui runtime reali: il valore serve a stimare i MINUTI
  // TOTALI visti, e la media e' l'unico stimatore che ricostruisce la somma
  // esatta quando l'utente ha visto tutta la serie.
  const episodeRuntimes = collectAppendedSeasonRuntimes(details);
  if (episodeRuntimes.length >= MIN_EPISODE_RUNTIME_SAMPLES) {
    const sum = episodeRuntimes.reduce((acc, n) => acc + n, 0);
    const average = toPositiveIntOrNull(sum / episodeRuntimes.length);
    if (average) return { value: average, source: "season_episodes" };
  }

  const showLevel = toPositiveIntOrNull(
    Array.isArray(details.episode_run_time)
      ? details.episode_run_time[0]
      : details.episode_run_time
  );
  if (showLevel) return { value: showLevel, source: "episode_run_time" };

  const lastEpisode = toPositiveIntOrNull(details.last_episode_to_air?.runtime);
  if (lastEpisode) return { value: lastEpisode, source: "last_episode_to_air" };

  const nextEpisode = toPositiveIntOrNull(details.next_episode_to_air?.runtime);
  if (nextEpisode) return { value: nextEpisode, source: "next_episode_to_air" };

  return { value: null, source: null };
}

function toPositiveInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

function normalizeMediaType(value) {
  return String(value || "").trim().toLowerCase() === "tv" ? "tv" : "movie";
}

// Season rows as stored on `meta.seasons` — { season, episodes, air_date? }.
// Mirrors index.js's normalizeTmdbSeasons so `estimateTitleTotals`
// (functions/lib/titleStates.js) reads a shape it already understands.
function normalizeTmdbSeasons(details) {
  const seasons = details && Array.isArray(details.seasons) ? details.seasons : [];
  return seasons
    .map((row) => {
      const airDate = String(row?.air_date || "").slice(0, 24).trim();
      return {
        season: toPositiveInt(row?.season_number),
        episodes: toPositiveInt(row?.episode_count),
        ...(airDate ? { air_date: airDate } : {}),
      };
    })
    .filter((row) => row.season > 0)
    .sort((a, b) => a.season - b.season);
}

function uniformEpisodesForSeasons(seasons) {
  const rows = Array.isArray(seasons) ? seasons : [];
  if (!rows.length) return 0;
  const first = toPositiveInt(rows[0]?.episodes);
  if (!first) return 0;
  for (const row of rows) {
    if (toPositiveInt(row?.episodes) !== first) return 0;
  }
  return first;
}

// Pure builder for the DURATION + EPISODE-COUNT meta fields that the watch-time
// / completion math depends on (`estimateTitleTotals` in
// functions/lib/titleStates.js). Given a title doc's existing `meta` and a raw
// TMDB `/tv/{id}` or `/movie/{id}` details payload, returns { nextMeta,
// changedFields } patching only the missing/changed fields:
//   - movie: durationMovie
//   - tv:    seasons, seasonsCount, episodesPerSeason, durationEpisode
//
// This is the single source of truth for these fields — index.js's
// buildTmdbTitleRefreshPatch delegates here (so the full refresh and the import
// enrichment pass can never drift), and the import enrichment tick calls it
// directly. NEVER overwrites an already-present positive value: the object
// spread copies existing meta, and every set only fires when the value actually
// changes, so it's idempotent and safe to re-run.
//
// @param {object} currentMeta - the title doc's existing `meta` object.
// @param {object} details - raw TMDB `/tv/{id}` or `/movie/{id}` details.
// @param {"tv"|"movie"} mediaType.
// @returns {{ nextMeta: object, changedFields: string[] }}
function buildTitleDurationMetaPatch(currentMeta, details, mediaType) {
  const meta = currentMeta && typeof currentMeta === "object" ? currentMeta : {};
  const payload = details && typeof details === "object" ? details : {};
  const isTv = normalizeMediaType(mediaType) === "tv";
  const nextMeta = { ...meta };
  const changedFields = [];

  const setMeta = (field, value, { allowEmpty = false } = {}) => {
    if (value === undefined) return;
    if (!allowEmpty && (value === null || value === "")) return;
    const prev = meta[field];
    const same = (typeof value === "object" && value !== null)
      ? JSON.stringify(prev) === JSON.stringify(value)
      : prev === value;
    if (same) return;
    nextMeta[field] = value;
    changedFields.push(`meta.${field}`);
  };

  if (isTv) {
    const seasons = normalizeTmdbSeasons(payload);
    if (seasons.length) {
      setMeta("seasons", seasons, { allowEmpty: true });
      setMeta("seasonsCount", seasons.length);
    } else {
      const sc = toPositiveInt(payload.number_of_seasons);
      if (sc > 0) setMeta("seasonsCount", sc);
    }

    const uniformEpisodes = uniformEpisodesForSeasons(seasons);
    if (uniformEpisodes > 0) {
      setMeta("episodesPerSeason", uniformEpisodes);
    } else {
      const totalSeasons = toPositiveInt(payload.number_of_seasons);
      const totalEpisodes = toPositiveInt(payload.number_of_episodes);
      if (totalSeasons > 0 && totalEpisodes > 0 && totalEpisodes % totalSeasons === 0) {
        const eps = Math.round(totalEpisodes / totalSeasons);
        if (eps > 0) setMeta("episodesPerSeason", eps);
      }
    }

    const episodeRuntime = resolveTvEpisodeRuntime(payload).value;
    if (episodeRuntime > 0) setMeta("durationEpisode", episodeRuntime);
  } else {
    const runtime = toPositiveInt(payload.runtime);
    if (runtime > 0) setMeta("durationMovie", runtime);
  }

  return { nextMeta, changedFields };
}

// True when a title doc is MISSING the metadata the stats math needs, i.e. the
// import enrichment pass should fetch TMDB for it:
//   - movie: no meta.durationMovie -> 0 watch minutes.
//   - tv:    no meta.durationEpisode (-> 0 minutes) OR no episode-count signal
//            (no meta.seasons and no meta.seasonsCount+episodesPerSeason ->
//            totalEpisodeCount 0 -> series can never be marked completed).
// A title already carrying the needed fields is skipped (no TMDB call).
function titleNeedsDurationEnrichment(title) {
  const data = title && typeof title === "object" ? title : {};
  const meta = data.meta && typeof data.meta === "object" ? data.meta : {};
  const mediaType = normalizeMediaType(data.type || meta.mediaType || "movie");
  if (mediaType === "tv") {
    const hasEpisodeDuration = toPositiveInt(meta.durationEpisode) > 0;
    const hasSeasonRows = Array.isArray(meta.seasons)
      && meta.seasons.some((row) => toPositiveInt(row?.episodes) > 0);
    const hasEpisodeCountSignal = hasSeasonRows
      || (toPositiveInt(meta.seasonsCount) > 0 && toPositiveInt(meta.episodesPerSeason) > 0);
    return !hasEpisodeDuration || !hasEpisodeCountSignal;
  }
  return toPositiveInt(meta.durationMovie) <= 0;
}

module.exports = {
  collectAppendedSeasonRuntimes,
  resolveTvEpisodeRuntime,
  buildTitleDurationMetaPatch,
  titleNeedsDurationEnrichment,
  normalizeTmdbSeasons,
  uniformEpisodesForSeasons,
};
