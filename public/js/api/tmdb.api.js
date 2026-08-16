// tmdb.api.js — Client-side TMDB API integration
// Preferisce callable backend con cache TTL; fallback diretto solo se necessario.

import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";
import { t as i18nT } from "../i18n/index.js";
import { app } from "../firebase.js";

const BASE  = () => window.tmdbConfig?.baseUrl  || "https://api.themoviedb.org/3";
const KEY   = () => window.tmdbConfig?.apiKey    || "";
const IMG   = () => window.tmdbConfig?.imageBaseUrl || "https://image.tmdb.org/t/p";
const functions = getFunctions(app, "europe-west1");
const tmdbProxyCallable = httpsCallable(functions, "tmdbProxy");

function tmdbUrl(path, params = {}) {
  const url = new URL(`${BASE()}${path}`);
  url.searchParams.set("api_key", KEY());
  url.searchParams.set("language", "it-IT");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  return url.toString();
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(i18nT("TMDB {status}", { status: res.status }));
  return res.json();
}

async function callTmdbProxy(action, payload = {}, fallback = null) {
  try {
    const res = await tmdbProxyCallable({ action, ...payload });
    const data = res?.data;
    if (data && typeof data === "object") {
      // Compat: backend may return either { payload, cache } or { data, cache }.
      if ("payload" in data) return data.payload;
      if ("data" in data) return data.data;
    }
    return data || {};
  } catch (err) {
    if (typeof fallback === "function" && KEY()) {
      console.warn(`[tmdb.api] callable fallback (${action})`, err?.message || err);
      return fallback();
    }
    throw err;
  }
}

// --------------- Public helpers ---------------

/**
 * Full TMDB image URL.
 * @param {string|null} path  e.g. "/kqjL17yufvn9OVLy.jpg"
 * @param {string} size  w92 | w154 | w185 | w342 | w500 | original
 */
export function getTmdbImageUrl(path, size = "w185") {
  if (!path) return "";
  return `${IMG()}/${size}${path}`;
}

// --------------- Search ---------------

/**
 * Multi-search (movies + TV).
 * Returns lightweight result objects for listing.
 */
export async function searchTmdb(query) {
  if (!query || !query.trim()) return [];

  const trimmed = query.trim();
  const data = await callTmdbProxy(
    "searchMulti",
    { query: trimmed, language: "it-IT", page: 1 },
    () => fetchJson(tmdbUrl("/search/multi", { query: trimmed, include_adult: false }))
  );
  const results = (data.results || [])
    .filter(r => r.media_type === "movie" || r.media_type === "tv")
    .slice(0, 20);

  return results.map(r => {
    const isTV = r.media_type === "tv";
    const dateStr = isTV ? r.first_air_date : r.release_date;
    return {
      tmdbId:        r.id,
      mediaType:     isTV ? "tv" : "movie",
      title:         isTV ? (r.name || "") : (r.title || ""),
      originalTitle: isTV ? (r.original_name || "") : (r.original_title || ""),
      year:          dateStr ? dateStr.substring(0, 4) : "",
      overview:      r.overview || "",
      posterPath:    r.poster_path || null,
      genreIds:      r.genre_ids || [],
    };
  });
}

// --------------- Details ---------------

async function fetchMovieDetails(tmdbId, { language = "it-IT" } = {}) {
  return callTmdbProxy(
    "details",
    { tmdbId, mediaType: "movie", language },
    () => fetchJson(tmdbUrl(`/movie/${tmdbId}`, { append_to_response: "credits", language }))
  );
}

async function fetchTvDetails(tmdbId, { language = "it-IT" } = {}) {
  return callTmdbProxy(
    "details",
    { tmdbId, mediaType: "tv", language },
    () => fetchJson(tmdbUrl(`/tv/${tmdbId}`, { append_to_response: "credits", language }))
  );
}

async function fetchVideos(tmdbId, mediaType) {
  const path = mediaType === "tv" ? `/tv/${tmdbId}/videos` : `/movie/${tmdbId}/videos`;
  const data = await callTmdbProxy(
    "videos",
    { tmdbId, mediaType, language: "it-IT" },
    () => fetchJson(tmdbUrl(path))
  );
  return Array.isArray(data.results) ? data.results : [];
}

/**
 * Tendenze reali della settimana (TMDB /trending/all/week): film+serie con
 * l'id TMDB, per la sezione "Tendenze" della Home. Se il backend non espone
 * ancora l'azione (deploy in coda), ritorna [] e la Home usa il fallback.
 */
export async function fetchTrendingTitles() {
  try {
    const data = await callTmdbProxy(
      "trending",
      { language: "it-IT" },
      () => fetchJson(tmdbUrl("/trending/all/week", {}))
    );
    return (Array.isArray(data.results) ? data.results : [])
      .filter((r) => (r.media_type === "movie" || r.media_type === "tv") && r.id)
      .map((r) => ({
        tmdbId: r.id,
        mediaType: r.media_type,
        name: r.title || r.name || "",
        year: parseInt(String(r.release_date || r.first_air_date || "").slice(0, 4), 10) || null,
        posterPath: r.poster_path || null,
      }));
  } catch (e) {
    console.warn("fetchTrendingTitles error", e);
    return [];
  }
}

/**
 * Tutti i video YouTube (trailer/teaser) di un titolo con data di
 * pubblicazione, dal più recente. Alimenta la sezione "Novità" della scheda.
 */
export async function getTitleVideos({ tmdbId, mediaType }) {
  if (!tmdbId) return [];
  try {
    const raw = await fetchVideos(tmdbId, mediaType === "tv" ? "tv" : "movie");
    return raw
      .filter((v) => (v.site || "").toLowerCase() === "youtube" && v.key)
      .filter((v) => ["trailer", "teaser"].includes((v.type || "").toLowerCase()))
      .map((v) => ({
        key: v.key,
        name: v.name || "",
        type: (v.type || "").toLowerCase() === "teaser" ? "teaser" : "trailer",
        official: v.official === true,
        publishedAt: v.published_at ? new Date(v.published_at) : null,
      }))
      .sort((a, b) => (b.publishedAt?.getTime() || 0) - (a.publishedAt?.getTime() || 0));
  } catch (e) {
    console.warn("getTitleVideos error", e);
    return [];
  }
}

/**
 * Info di uscita dal payload details TMDB (cache server 7g): prossimo
 * episodio per le serie, data di uscita per i film.
 */
export async function getTitleReleaseInfo({ tmdbId, mediaType }) {
  if (!tmdbId) return null;
  try {
    if (mediaType === "tv") {
      const d = await fetchTvDetails(tmdbId);
      const next = d?.next_episode_to_air || null;
      return {
        mediaType: "tv",
        status: d?.status || null,
        nextEpisode: next
          ? {
              airDate: next.air_date || null,
              season: Number(next.season_number) || null,
              episode: Number(next.episode_number) || null,
              name: next.name || "",
            }
          : null,
      };
    }
    const d = await fetchMovieDetails(tmdbId);
    return { mediaType: "movie", status: d?.status || null, releaseDate: d?.release_date || null };
  } catch (e) {
    console.warn("getTitleReleaseInfo error", e);
    return null;
  }
}

async function searchForMatch({ name, year, mediaType }) {
  if (!name) return null;
  const q = name.trim();
  const data = await callTmdbProxy(
    "searchMulti",
    { query: q, language: "it-IT", page: 1 },
    () => fetchJson(tmdbUrl("/search/multi", { query: q, include_adult: false }))
  );
  const norm = (s) => s?.toLowerCase?.().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim() || "";
  const target = norm(q);

  const candidates = (data.results || [])
    .filter(r => r.media_type === "movie" || r.media_type === "tv");

  const scored = candidates.map(r => {
    const title = r.media_type === "tv" ? r.name : r.title;
    const normTitle = norm(title);
    const scoreName = normTitle === target ? 3 : (normTitle.includes(target) ? 1 : 0);
    const dateStr = r.media_type === "tv" ? r.first_air_date : r.release_date;
    const y = dateStr ? Number(dateStr.slice(0, 4)) : null;
    const scoreYear = (year && y) ? (Math.abs(y - year) <= 1 ? 1 : 0) : 0;
    const scoreType = mediaType ? (r.media_type === mediaType ? 1 : 0) : 0;
    const score = scoreName * 2 + scoreYear + scoreType;
    return { r, score, y };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score <= 0) return null;
  return { tmdbId: best.r.id, mediaType: best.r.media_type === "tv" ? "tv" : "movie" };
}

// --------------- Mapping to app format ---------------

function mapToAppFormat(d, mediaType) {
  const isTV = mediaType === "tv";

  const name         = isTV ? (d.name || "") : (d.title || "");
  const originalName = isTV ? (d.original_name || "") : (d.original_title || "");

  const dateStr = isTV ? d.first_air_date : d.release_date;
  const year    = dateStr ? parseInt(dateStr.substring(0, 4), 10) : null;

  // Genres — already localised via language=it-IT
  const genreLabels = (d.genres || []).map(g => g.name).filter(Boolean);

  // Credits
  const crew = d.credits?.crew || [];
  const cast = d.credits?.cast || [];

  const directors = crew
    .filter(p => p.job === "Director")
    .map(p => p.name)
    .filter(Boolean);

  const castNames = cast
    .slice(0, 10)
    .map(p => p.name)
    .filter(Boolean);

  // Duration
  const durationMinutes = isTV ? null : (d.runtime || null);
  const durationEpisode = isTV
    ? (Array.isArray(d.episode_run_time) && d.episode_run_time.length
        ? d.episode_run_time[0]
        : null)
    : null;

  // Seasons
  let numSeasons       = isTV ? (d.number_of_seasons || null) : null;
  let numEpisodes      = isTV ? (d.number_of_episodes || null) : null;
  let seasonsMeta      = null;
  let episodesPerSeason = null;

  if (isTV && Array.isArray(d.seasons)) {
    seasonsMeta = d.seasons
      .filter(s => s.season_number > 0)
      .map(s => ({
        season: s.season_number,
        episodes: s.episode_count || 0,
        ...(s.air_date ? { air_date: s.air_date } : {}),
      }));

    if (seasonsMeta.length) {
      const first = seasonsMeta[0].episodes;
      const allSame = seasonsMeta.every(s => s.episodes === first);
      if (allSame && first > 0) episodesPerSeason = first;
    }
  }

  // Language & country
  const language = (d.spoken_languages && d.spoken_languages.length)
    ? (d.spoken_languages[0].italian_name || d.spoken_languages[0].english_name || d.spoken_languages[0].name || "")
    : "";
  const country = (d.production_countries && d.production_countries.length)
    ? (d.production_countries[0].name || "")
    : "";

  // Network (TV only)
  const network = (isTV && d.networks && d.networks.length)
    ? d.networks[0].name
    : "";

  // Description (NEW)
  const description = d.overview || "";

  // Poster URL (w500 for storage download, compressed by uploadPoster)
  const posterUrl = d.poster_path ? getTmdbImageUrl(d.poster_path, "w500") : "";
  const backdropUrl = d.backdrop_path ? getTmdbImageUrl(d.backdrop_path, "w780") : "";

  const meta = {
    tmdbId: Number(d.id) || null,
    mediaType,
  };

  if (language) meta.language = language;
  if (country) meta.country = country;
  if (network) meta.network = network;

  if (isTV) {
    if (durationEpisode) meta.durationEpisode = durationEpisode;
    if (numSeasons) meta.seasonsCount = numSeasons;
    if (Array.isArray(seasonsMeta) && seasonsMeta.length) {
      meta.seasons = seasonsMeta;
      meta.seasonsCount = seasonsMeta.length;
    }
    if (episodesPerSeason) {
      meta.episodesPerSeason = episodesPerSeason;
    } else if (!meta.seasons && numSeasons && numEpisodes && (numEpisodes % numSeasons === 0)) {
      const uniformEpisodes = Math.round(numEpisodes / numSeasons);
      if (uniformEpisodes > 0) {
        meta.episodesPerSeason = uniformEpisodes;
        meta.seasons = Array.from({ length: numSeasons }, (_, i) => ({ season: i + 1, episodes: uniformEpisodes }));
      }
    }
  } else if (durationMinutes) {
    meta.durationMovie = durationMinutes;
  }

  return {
    name,
    type: isTV ? "tv" : "movie",
    year,
    originalName,
    directors,
    cast: castNames,
    genreLabels,
    language,
    country,
    network,
    durationMinutes: durationMinutes || durationEpisode,
    durationEpisode,
    numSeasons,
    numEpisodes,
    episodesPerSeason,
    seasonsMeta,
    posterUrl,
    backdropUrl,
    posterFilename: null,
    wikidataId: null,
    description,
    meta,
    sourceTmdb: { tmdbId: d.id, mediaType },
  };
}

/**
 * Get first YouTube trailer key (official prioritized).
 */
export async function getTmdbTrailer({ tmdbId, mediaType }) {
  try {
    const videos = await fetchVideos(tmdbId, mediaType);
    const sorted = videos
      .filter(v => (v.site || "").toLowerCase() === "youtube")
      .sort((a, b) => {
        const score = (v) => {
          let s = 0;
          if ((v.type || "").toLowerCase() === "trailer") s += 2;
          if (v.official) s += 2;
          const name = String(v.name || "").toLowerCase();
          if (name.includes("trailer")) s += 1;
          return s;
        };
        return score(b) - score(a);
      });
    const best = sorted[0];
    if (!best) return null;
    return {
      key: best.key,
      url: `https://www.youtube.com/watch?v=${best.key}`,
      embed: `https://www.youtube.com/embed/${best.key}`,
    };
  } catch (e) {
    console.warn("tmdb trailer fetch error", e);
    return null;
  }
}

/**
 * Trova e ritorna trailer YouTube partendo dal nome, con fallback a TMDB id già noto.
 */
export async function getTrailerByName({ name, year = null, mediaType = null, tmdbId = null }) {
  try {
    let target = tmdbId ? { tmdbId, mediaType: mediaType || "movie" } : null;
    if (!target) {
      target = await searchForMatch({ name, year, mediaType });
    }
    if (!target) return null;
    return await getTmdbTrailer(target);
  } catch (err) {
    console.warn("getTrailerByName error", err);
    return null;
  }
}

// --------------- Season episodes (lista episodi scheda titolo) ---------------

// Cache in memoria per (tmdbId, stagione): la lista episodi non cambia entro
// la sessione, il backend ha già una cache 7g. Evita refetch a ogni cambio
// stagione o re-render della scheda.
const _seasonEpisodesCache = new Map();
function _seasonEpisodesKey(tmdbId, season) {
  return `${Number(tmdbId) || 0}:${Number(season)}`;
}

/**
 * Episodi (nome + data messa in onda + overview) di UNA stagione TV, dalla
 * callable `tmdbProxy` (action `seasonEpisodes`, richiede login).
 * @param {number} tmdbId  id TMDB del titolo
 * @param {number} season  numero stagione (>0)
 * @returns {Promise<Array<{episode_number:number,name:string,air_date:string|null,overview:string,still_path:string|null,vote_average:number,runtime:number|null}>>}
 *   Array vuoto se tmdbId/season invalidi o in caso di errore (es. guest non
 *   loggato): il chiamante deve degradare a "Episodio N".
 */
export async function fetchSeasonEpisodes(tmdbId, season, { language = "it-IT" } = {}) {
  const id = Number(tmdbId) || 0;
  const s = Number(season);
  if (!id || !Number.isFinite(s) || s < 0) return [];
  const key = _seasonEpisodesKey(id, s);
  if (_seasonEpisodesCache.has(key)) return _seasonEpisodesCache.get(key);
  try {
    const payload = await callTmdbProxy("seasonEpisodes", { tmdbId: id, season: s, language });
    const episodes = Array.isArray(payload?.episodes) ? payload.episodes : [];
    _seasonEpisodesCache.set(key, episodes);
    return episodes;
  } catch (err) {
    console.warn("[tmdb.api] fetchSeasonEpisodes error", err?.message || err);
    return [];
  }
}

/**
 * Legge la cache in memoria SENZA fare rete: ritorna gli episodi già scaricati
 * per (tmdbId, stagione) o null se non ancora fetchati. Usato per arricchire in
 * modo opportunistico label (nudge, sheet) senza forzare una chiamata.
 */
export function peekSeasonEpisodes(tmdbId, season) {
  const key = _seasonEpisodesKey(tmdbId, season);
  return _seasonEpisodesCache.has(key) ? _seasonEpisodesCache.get(key) : null;
}

// --------------- Full import pipeline ---------------

/**
 * Fetch full TMDB details and map to app import format.
 * Compatible with applyWikiImport() in add_title.page.js.
 *
 * @param {{ tmdbId: number, mediaType: 'movie'|'tv' }} result
 */
export async function importFromTmdbResult(result) {
  const detailsIt = result.mediaType === "tv"
    ? await fetchTvDetails(result.tmdbId, { language: "it-IT" })
    : await fetchMovieDetails(result.tmdbId, { language: "it-IT" });

  const mapped = mapToAppFormat(detailsIt, result.mediaType);
  if (String(mapped.description || "").trim()) return mapped;

  try {
    const detailsEn = result.mediaType === "tv"
      ? await fetchTvDetails(result.tmdbId, { language: "en-US" })
      : await fetchMovieDetails(result.tmdbId, { language: "en-US" });
    const fallback = String(detailsEn?.overview || "").trim();
    if (fallback) mapped.description = fallback;
  } catch (err) {
    console.warn("tmdb description fallback error", err);
  }

  return mapped;
}
