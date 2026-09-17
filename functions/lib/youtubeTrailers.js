"use strict";

// Trailer dai canali ufficiali delle piattaforme.
//
// PERCHE' ESISTE — TMDB `/videos` non ha i trailer dei ritorni di stagione.
// Misurato il 2026-08-29 sulle 134 premiere dei 60 giorni successivi: 18 (13%)
// avevano un video TMDB degli ultimi 90 giorni, e **erano tutti debutti di
// serie nuove**. Fra i 103 ritorni con stagione >= 2: zero. TMDB /videos e' di
// fatto un dataset di lanci; quando una serie torna, il trailer sta sul canale
// del broadcaster. Il caso che ha fatto scattare tutto e' "The Diplomat 4":
// teaser di Netflix Italia l'11 agosto, su TMDB nemmeno una riga.
//
// Le DATE restano a TMDB, che su quelle e' giusto e strutturato
// (`next_episode_to_air` aveva il 15 ottobre prima degli articoli). Qui si
// prendono solo i video.
//
// QUOTA — 10.000 unita' al giorno, gratis. Il prezzo dipende dall'endpoint:
// `search.list` costa 100 unita' e **non si usa mai**; `channels.list` e
// `playlistItems.list` ne costano 1. Si risolve una volta la playlist "uploads"
// di ogni canale (e la si tiene in cache) e poi si legge solo quella: ~8 unita'
// a giro, anche ogni 30 minuti sono ~400 al giorno.

const { makeTmdbVideoCandidateId } = require("./titleUpdateCandidates");
const { normalizeText } = require("./pureUtils");

const YOUTUBE_API_ORIGIN = "https://www.googleapis.com/youtube/v3";
const MAX_UPLOADS_PER_CHANNEL = 50;
const MAX_QUOTA_UNITS_PER_RUN = 60;
const MAX_PENDING_ROWS = 100;
// Un canale che pubblica il teaser di una stagione lo fa una volta: guardare
// indietro piu' di cosi' significherebbe solo ripescare video gia' scartati.
const DEFAULT_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

// I canali da cui vale la pena leggere: quelli che distribuiscono in Italia.
// Si parte dagli handle e non dagli id perche' un handle si legge, si verifica
// a occhio e non scade; l'id opaco (`UC...`) e la playlist uploads si risolvono
// una volta sola e finiscono in cache su systemJobs.
const CHANNELS = Object.freeze([
  { key: "netflix_it", handle: "@NetflixItalia", platform: "Netflix" },
  { key: "primevideo_it", handle: "@PrimeVideoIT", platform: "Amazon Prime Video" },
  { key: "disneyplus_it", handle: "@DisneyPlusIT", platform: "Disney Plus" },
  { key: "skyitalia", handle: "@SkyItalia", platform: "Sky" },
  { key: "appletv", handle: "@AppleTV", platform: "Apple TV" },
  { key: "paramountplus_it", handle: "@ParamountPlusIT", platform: "Paramount Plus" },
  { key: "hbomax_it", handle: "@HBOMaxIT", platform: "HBO Max" },
  { key: "warnerbros_it", handle: "@WarnerBrosItalia", platform: "Warner Bros." },
]);

// Un canale ripubblica il nome di un'opera vecchia per annunciarne una nuova:
// "HARRY POTTER E LA PIETRA FILOSOFALE | TEASER TRAILER | HBO Max" e' la serie
// del 2026, ma in catalogo quel nome ce l'ha il film del 2001, da solo, con un
// match esatto. Attaccarcelo sarebbe il caso peggiore: il trailer di un'opera
// finisce sulla scheda di un'altra, e chi lo vede non ha modo di accorgersene.
//
// Sopra questa distanza il match esatto non basta piu' e la riga va in coda di
// revisione. I trailer di riedizione ("ora disponibile su...") ci finiscono
// dentro anche loro: sono pochi, e li conferma la routine editoriale.
const MAX_TITLE_AGE_YEARS_FOR_TRAILER = 3;

function titleTooOldForNewTrailer(title, publishedAtMs, maxAgeYears = MAX_TITLE_AGE_YEARS_FOR_TRAILER) {
  const titleYear = Math.floor(Number(title?.year));
  if (!Number.isFinite(titleYear) || titleYear <= 0) return false;
  const publishedMs = Number(publishedAtMs);
  if (!Number.isFinite(publishedMs)) return false;
  const videoYear = new Date(publishedMs).getUTCFullYear();
  return videoYear - titleYear > maxAgeYears;
}

/**
 * La coda si accumula, non si sostituisce.
 *
 * PERCHE' — ogni giro guarda solo i video piu' recenti del watermark, quindi un
 * video non riconosciuto lo si vede UNA volta sola. Scrivendo `pending` come
 * fotografia dell'ultimo giro, il giro dopo (che di nuovo non trova niente) la
 * azzerava e quei video sparivano per sempre. Successo davvero il 2026-08-29:
 * 24 righe raccolte alle 11:19, coda vuota alle 12:19, e la routine editoriale
 * si e' trovata niente da fare.
 *
 * Le righe nuove stanno davanti: se la coda e' piena, a cadere e' la roba
 * vecchia, che ha gia' avuto le sue occasioni di essere riconosciuta.
 */
function mergePendingRows(existing, incoming, max = MAX_PENDING_ROWS) {
  const out = [];
  const seen = new Set();
  for (const row of [...(Array.isArray(incoming) ? incoming : []), ...(Array.isArray(existing) ? existing : [])]) {
    const videoId = String(row?.videoId || "").trim();
    if (!videoId || seen.has(videoId)) continue;
    seen.add(videoId);
    out.push(row);
    if (out.length >= max) break;
  }
  return out;
}

function safeText(value, max = 240) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
}

function toMillis(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

// Le piattaforme confezionano il titolo del video sempre allo stesso modo:
//   "The Diplomat - Stagione 4 | Teaser ufficiale | Netflix Italia"
//   "Nome serie: Season 2 | Official Trailer | Prime Video"
// I segmenti dopo la prima barra dicono COSA e' il video; il primo dice di
// quale titolo parla. Tutto il resto che un canale pubblica (clip, interviste,
// "I 10 migliori...", dietro le quinte) non ha il marcatore e viene scartato:
// e' il filtro che tiene il rumore fuori dalla scheda titolo.
const TEASER_RE = /\bteaser\b/i;
const TRAILER_RE = /\btrailer\b/i;
const SEASON_RE = /(?:stagione|season|temporada|staffel)\s*0*(\d{1,2})\b/i;
// Sky e Paramount+ scrivono la stagione così: "The Gilded Age S4", "MobLand S02".
const SEASON_SHORT_RE = /\bs0*(\d{1,2})\b/i;
const SEASON_SUFFIX_RE = /[\s\-–—:,]+(?:(?:stagione|season|temporada|staffel)\s*0*\d{1,2}|s0*\d{1,2})\s*$/i;
// "Slow Horses — Season 6 Official Trailer | Apple TV", "Neagley Trailer
// Ufficiale": il marcatore sta DENTRO il primo segmento, non su un segmento
// suo. Va tolto dalla coda, non usato per saltare al segmento dopo.
const MARKER_SUFFIX_RE = new RegExp(
  "[\\s\\-–—:,]*(?:(?:official|ufficiale|ufficale|oficial)\\s+)?(?:teaser|trailer)"
  + "(?:\\s+(?:ufficiale|ufficale|official|oficial|ita))*"
  + "(?:\\s*\\((?:sub\\s+)?ita\\))?\\s*$",
  "i"
);
// "FX's The Shards" è come Disney+ etichetta i suoi canali, non parte del nome.
const NETWORK_PREFIX_RE = /^[A-Z]{2,4}'s\s+/;
// Boilerplate di Paramount+ Italia: "Titolo: Golden Axe".
const LABEL_PREFIX_RE = /^titolo:\s*/i;

function stripVideoTitleNoise(value) {
  let out = safeText(value, 220);
  out = out.replace(LABEL_PREFIX_RE, "").replace(NETWORK_PREFIX_RE, "");
  // Marcatore prima, stagione dopo: in "Slow Horses — Season 6 Official
  // Trailer" la stagione resta scoperta solo quando il trailer se n'è andato.
  out = out.replace(MARKER_SUFFIX_RE, "");
  out = out.replace(SEASON_SUFFIX_RE, "");
  return safeText(out, 200);
}

/**
 * I nomi alternativi da provare quando il primo segmento non e' il titolo.
 *
 * "South America | Trailer ufficiale | Paramount+ | South Park s29": il primo
 * segmento e' il nome dell'EPISODIO, la serie sta in fondo insieme alla
 * stagione. Il marcatore di stagione e' il segnale: un segmento che lo porta
 * parla della serie, non del video. Sono nomi di riserva, non sostituti — il
 * primo segmento resta la scelta principale.
 */
function seasonBearingNames(segments, primaryName) {
  const seen = new Set([normalizeText(primaryName)]);
  const out = [];
  for (const segment of segments) {
    if (!SEASON_RE.test(segment) && !SEASON_SHORT_RE.test(segment)) continue;
    const candidate = stripVideoTitleNoise(segment);
    // "Trailer stagione 2" si svuota fino al marcatore: non e' un nome.
    if (!candidate || TEASER_RE.test(candidate) || TRAILER_RE.test(candidate)) continue;
    const key = normalizeText(candidate);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

/**
 * Da titolo YouTube a fatto strutturato, o `null` se non e' un trailer.
 *
 * Restituisce `kind` (trailer/teaser), il nome del titolo ripulito dal suffisso
 * di stagione e la stagione quando c'e'. La stagione si cerca in TUTTO il
 * titolo, non solo nel primo segmento: "Trailer stagione 2 | Netflix" la mette
 * dall'altra parte della barra.
 */
function parseYouTubeVideoTitle(rawTitle) {
  const raw = safeText(rawTitle, 300);
  if (!raw) return null;
  const isTeaser = TEASER_RE.test(raw);
  const isTrailer = TRAILER_RE.test(raw);
  if (!isTeaser && !isTrailer) return null;

  const segments = raw.split("|").map((part) => safeText(part, 200)).filter(Boolean);
  const head = segments[0] || raw;

  const seasonMatch = raw.match(SEASON_RE) || raw.match(SEASON_SHORT_RE);
  const season = seasonMatch ? Math.floor(Number(seasonMatch[1])) : null;

  // Solo se ripulendo il primo segmento non resta niente ("Trailer ufficiale |
  // Nome serie") il nome sta nel segmento dopo.
  const name = stripVideoTitleNoise(head) || stripVideoTitleNoise(segments[1] || "");
  if (!name) return null;

  const altNames = seasonBearingNames(segments, name);

  return {
    name,
    altNames,
    normalizedName: normalizeText(name),
    season: Number.isFinite(season) && season > 0 ? season : null,
    // Un teaser dichiarato tale resta un teaser anche se la parola "trailer"
    // compare piu' avanti ("Teaser trailer"): e' il termine piu' specifico.
    kind: isTeaser ? "teaser" : "trailer",
  };
}

/** Solo i video nuovi: watermark per canale, piu' una finestra di sicurezza. */
function selectNewVideos(items, { sinceMs, nowMs = Date.now() } = {}) {
  const floor = Number.isFinite(Number(sinceMs))
    ? Number(sinceMs)
    : nowMs - DEFAULT_LOOKBACK_MS;
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      videoId: safeText(item?.snippet?.resourceId?.videoId || item?.contentDetails?.videoId, 40),
      title: safeText(item?.snippet?.title, 300),
      publishedAt: safeText(item?.snippet?.publishedAt, 40),
      publishedAtMs: toMillis(item?.snippet?.publishedAt),
    }))
    .filter((row) => row.videoId && row.title && Number.isFinite(row.publishedAtMs))
    .filter((row) => row.publishedAtMs > floor && row.publishedAtMs <= nowMs)
    .sort((left, right) => right.publishedAtMs - left.publishedAtMs);
}

/**
 * Fra piu' titoli con lo stesso nome, quale intendeva il canale.
 *
 * "The Diplomat" su TMDB sono due serie diverse. Si sceglie solo quando la
 * scelta e' motivata; nel dubbio si restituisce `null` e la riga finisce in
 * coda di revisione. Un trailer attaccato alla serie sbagliata e' peggio di un
 * trailer mancante: quello lo vedono in scheda le persone sbagliate.
 */
function pickMatchingTitle(candidates, { parsed, platform }) {
  const rows = (Array.isArray(candidates) ? candidates : []).filter(Boolean);
  if (!rows.length) return null;
  if (rows.length === 1) return rows[0];

  // Una stagione nel titolo del video vuol dire serie, non film.
  const byType = parsed?.season ? rows.filter((row) => row.type === "tv") : rows;
  if (byType.length === 1) return byType[0];

  const wanted = normalizeText(platform);
  const byPlatform = byType.filter((row) => (Array.isArray(row.watchProviderNames) ? row.watchProviderNames : [])
    .some((name) => normalizeText(name) === wanted));
  if (byPlatform.length === 1) return byPlatform[0];

  return null;
}

/**
 * Candidato evento a partire da un video del canale.
 *
 * L'ID DEL DOCUMENTO E' QUELLO DELLA PIPELINE TMDB, di proposito. Un evento e'
 * "questo video su questo titolo": se domani TMDB indicizza lo stesso video,
 * `writeTitleUpdateEvents` deve aggiornare la riga che c'e' gia' invece di
 * creargliene una seconda accanto. Il prefisso `tmdb_video_` e' quindi storico,
 * non una dichiarazione di provenienza: quella sta in `source`.
 */
function buildYouTubeVideoCandidate({ video, title, channel, parsed }) {
  const titleId = safeText(title?.id, 160);
  const tmdbId = Math.floor(Number(title?.tmdbId ?? title?.meta?.tmdbId));
  const videoId = safeText(video?.videoId, 40);
  if (!titleId || !videoId || !Number.isFinite(tmdbId) || tmdbId <= 0) return null;

  const mediaType = String(title?.type || "").toLowerCase() === "tv" ? "tv" : "movie";
  const id = makeTmdbVideoCandidateId({ mediaType, tmdbId, videoKey: videoId });
  if (!id) return null;

  const headline = safeText(video.title, 240);
  return {
    id,
    titleId,
    tmdbId,
    mediaType,
    eventType: parsed.kind,
    source: "youtube",
    sourceId: videoId,
    sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
    headline,
    publishedAt: video.publishedAt,
    sourceLocale: "it-IT",
    localizedNames: { "it-IT": headline },
    headlineByLocale: { "it-IT": headline },
    availableLocales: ["it-IT"],
    ...(mediaType === "tv" && parsed.season ? { season: parsed.season } : {}),
    // Il canale E' la piattaforma: non c'e' fonte piu' ufficiale di cosi'.
    official: true,
    autoPublishEligible: true,
    confidence: 1,
    channelKey: channel?.key || null,
  };
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function buildApiUrl(path, params, apiKey) {
  const url = new URL(`${YOUTUBE_API_ORIGIN}/${path}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  url.searchParams.set("key", apiKey);
  return url.toString();
}

/** Playlist "uploads" del canale: 1 unita', e si fa una volta sola per canale. */
async function fetchUploadsPlaylistId({ handle, apiKey, fetchJson }) {
  const payload = await fetchJson(buildApiUrl("channels", {
    part: "contentDetails",
    forHandle: handle,
  }, apiKey));
  const item = (Array.isArray(payload?.items) ? payload.items : [])[0];
  return safeText(item?.contentDetails?.relatedPlaylists?.uploads, 60) || null;
}

/** Ultimi caricamenti: 1 unita' ogni 50 video. */
async function fetchChannelUploads({ playlistId, apiKey, fetchJson, max = MAX_UPLOADS_PER_CHANNEL }) {
  const payload = await fetchJson(buildApiUrl("playlistItems", {
    part: "snippet",
    playlistId,
    maxResults: Math.max(1, Math.min(50, Math.floor(Number(max) || MAX_UPLOADS_PER_CHANNEL))),
  }, apiKey));
  return Array.isArray(payload?.items) ? payload.items : [];
}

/** I titoli approvati che si chiamano cosi'. L'indice status+nameLower esiste. */
async function findTitlesByName({ db, name }) {
  const needle = safeText(name, 200).toLowerCase();
  if (!needle) return [];
  const snap = await db.collection("titles")
    .where("status", "==", "approved")
    .where("nameLower", "==", needle)
    .limit(5)
    .get();
  return (snap.docs || []).map((doc) => ({ id: doc.id, ...(doc.data() || {}) }))
    .map((row) => ({ ...row, tmdbId: row.tmdbId ?? row.meta?.tmdbId }));
}

/**
 * Un giro completo: per ogni canale legge i caricamenti nuovi, tiene solo i
 * trailer, li aggancia al catalogo e restituisce i candidati pronti per
 * `writeTitleUpdateEvents`.
 *
 * Non scrive gli eventi: quello lo fa il chiamante, con la stessa funzione che
 * usa lo scanner TMDB, cosi' le regole di pubblicazione restano una sola.
 */
async function collectYouTubeTrailerCandidates({
  db,
  apiKey,
  fetchJson,
  state = {},
  channels = CHANNELS,
  nowMs = Date.now(),
  maxQuotaUnits = MAX_QUOTA_UNITS_PER_RUN,
}) {
  if (!apiKey) throw new Error("YOUTUBE_API_KEY mancante");
  if (typeof fetchJson !== "function") throw new Error("fetchJson obbligatorio");

  const channelState = { ...(state.channels || {}) };
  const candidates = [];
  const pending = [];
  const errors = [];
  let quotaUsed = 0;

  for (const channel of channels) {
    if (quotaUsed >= maxQuotaUnits) break;
    const saved = channelState[channel.key] || {};
    try {
      let playlistId = safeText(saved.uploadsPlaylistId, 60);
      if (!playlistId) {
        playlistId = await fetchUploadsPlaylistId({ handle: channel.handle, apiKey, fetchJson });
        quotaUsed += 1;
        if (!playlistId) {
          // Handle sbagliato o canale rinominato: si segnala e si va avanti,
          // un canale non deve fermare gli altri.
          errors.push({ channel: channel.key, message: `handle non risolto: ${channel.handle}` });
          continue;
        }
      }

      const items = await fetchChannelUploads({ playlistId, apiKey, fetchJson });
      quotaUsed += 1;
      const videos = selectNewVideos(items, { sinceMs: toMillis(saved.lastPublishedAt), nowMs });

      for (const video of videos) {
        const parsed = parseYouTubeVideoTitle(video.title);
        if (!parsed) continue;
        // Prima il primo segmento, poi i nomi che portano la stagione: e'
        // l'ordine giusto perche' il primo segmento e' quasi sempre il titolo,
        // e solo quando non lo e' (episodio speciale, South Park s29) il nome
        // vero sta piu' avanti.
        let matchedAny = false;
        let picked = null;
        for (const name of [parsed.name, ...(parsed.altNames || [])]) {
          const found = await findTitlesByName({ db, name });
          if (found.length) matchedAny = true;
          picked = pickMatchingTitle(found, { parsed, platform: channel.platform });
          if (picked) break;
        }
        const tooOld = picked ? titleTooOldForNewTrailer(picked, video.publishedAtMs) : false;
        const title = tooOld ? null : picked;
        if (!title) {
          pending.push({
            channel: channel.key,
            platform: channel.platform,
            videoId: video.videoId,
            videoTitle: video.title,
            parsedName: parsed.name,
            // La routine editoriale cerca i candidati di catalogo su questi
            // nomi oltre che sul primo segmento.
            ...(parsed.altNames?.length ? { altNames: parsed.altNames } : {}),
            season: parsed.season,
            kind: parsed.kind,
            // Serve alla routine editoriale: senza data non si puo' costruire
            // l'evento quando il titolo viene finalmente riconosciuto.
            publishedAt: video.publishedAt,
            reason: tooOld
              ? "il match esatto e' un titolo molto piu' vecchio del video"
              : (matchedAny ? "ambiguo" : "titolo non in catalogo"),
          });
          continue;
        }
        const candidate = buildYouTubeVideoCandidate({ video, title, channel, parsed });
        // Al primo giro di un canale si legge tutta la finestra di sicurezza:
        // sono video anche di due settimane fa, non notizie di oggi. Entrano
        // come backfill, cioe' in scheda ma senza svegliare nessuno.
        if (candidate) candidates.push({ ...candidate, acquisition: saved.lastPublishedAt ? "live" : "backfill" });
      }

      channelState[channel.key] = {
        uploadsPlaylistId: playlistId,
        lastPublishedAt: videos[0]?.publishedAt || saved.lastPublishedAt || null,
        lastRunAtMs: nowMs,
      };
    } catch (err) {
      errors.push({ channel: channel.key, message: safeText(err?.message || err, 240) });
    }
  }

  return {
    candidates,
    // La coda di revisione e' anche il materiale su cui gira la routine locale:
    // e' li' che un nome ambiguo diventa una decisione.
    pending: pending.slice(0, MAX_PENDING_ROWS),
    errors,
    quotaUsed,
    channelState,
  };
}

module.exports = {
  CHANNELS,
  DEFAULT_LOOKBACK_MS,
  MAX_QUOTA_UNITS_PER_RUN,
  buildApiUrl,
  buildYouTubeVideoCandidate,
  mergePendingRows,
  collectYouTubeTrailerCandidates,
  fetchChannelUploads,
  fetchUploadsPlaylistId,
  findTitlesByName,
  parseYouTubeVideoTitle,
  pickMatchingTitle,
  selectNewVideos,
  titleTooOldForNewTrailer,
  MAX_TITLE_AGE_YEARS_FOR_TRAILER,
};
