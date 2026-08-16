"use strict";

const EXPECTED_ARCHIVE_PATHS = new Set([
  "profile.csv",
  "watched.csv",
  "ratings.csv",
  "diary.csv",
  "reviews.csv",
  "watchlist.csv",
  "comments.csv",
  "deleted/diary.csv",
  "deleted/reviews.csv",
  "deleted/comments.csv",
  "orphaned/diary.csv",
  "orphaned/reviews.csv",
  "orphaned/comments.csv",
  "likes/films.csv",
  "likes/reviews.csv",
  "likes/lists.csv",
]);

const CSV_PATHS_TO_READ = Object.freeze([
  "watched.csv",
  "ratings.csv",
  "diary.csv",
  "watchlist.csv",
  "reviews.csv",
]);

const MAX_ARCHIVE_ENTRIES = 100;
const MAX_ENTRY_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;
const MAX_HTML_BYTES = 1_500_000;

function parseZipInfoListing(rawListing) {
  const entries = [];
  for (const rawLine of String(rawListing || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^[dl-][rwx-]{5}/.test(line)) continue;
    const match = line.match(/^(\S+)\s+\S+\s+\S+\s+(\d+)\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.+)$/);
    if (!match) throw new Error("Output zipinfo non riconosciuto");
    entries.push({
      mode: match[1],
      uncompressedSize: Number(match[2]),
      compressedSize: Number(match[3]),
      name: match[4],
    });
  }
  if (entries.length === 0) throw new Error("Archivio ZIP senza entry leggibili");
  return entries;
}

function validateArchiveEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("Archivio ZIP vuoto");
  if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error("Archivio ZIP con troppe entry");

  const seen = new Set();
  let totalUncompressed = 0;
  for (const entry of entries) {
    const name = String(entry?.name || "");
    const folded = name.toLocaleLowerCase("en-US");
    if (
      !name
      || name.includes("\0")
      || name.startsWith("/")
      || name.startsWith("\\")
      || /^[A-Za-z]:/.test(name)
      || name.split(/[\\/]/).includes("..")
      || name.includes("\\")
    ) throw new Error("Archivio ZIP con percorso non sicuro");
    if (seen.has(folded)) throw new Error("Archivio ZIP con entry duplicate");
    seen.add(folded);
    if (!EXPECTED_ARCHIVE_PATHS.has(name)) throw new Error(`Entry Letterboxd non riconosciuta: ${name}`);
    if (!String(entry.mode || "").startsWith("-")) throw new Error(`Entry ZIP non regolare: ${name}`);

    const uncompressed = Number(entry.uncompressedSize);
    const compressed = Number(entry.compressedSize);
    if (!Number.isSafeInteger(uncompressed) || uncompressed < 0 || uncompressed > MAX_ENTRY_BYTES) {
      throw new Error(`Entry ZIP troppo grande: ${name}`);
    }
    if (!Number.isSafeInteger(compressed) || compressed < 0) throw new Error(`Dimensione ZIP non valida: ${name}`);
    if (uncompressed > 0 && compressed === 0) throw new Error(`Compression ratio non valida: ${name}`);
    if (compressed > 0 && uncompressed / compressed > MAX_COMPRESSION_RATIO) {
      throw new Error(`Compression ratio eccessiva: ${name}`);
    }
    totalUncompressed += uncompressed;
  }
  if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) throw new Error("Archivio ZIP estratto troppo grande");
  if (!seen.has("watched.csv")) throw new Error("watched.csv mancante nell'archivio Letterboxd");

  return { entryCount: entries.length, totalUncompressedBytes: totalUncompressed };
}

function validateAllowedUrl(raw, { initial = false } = {}) {
  let url;
  try { url = new URL(String(raw || "")); } catch { throw new Error("Redirect Letterboxd non valido"); }
  const allowedHost = url.hostname === "boxd.it"
    || url.hostname === "letterboxd.com"
    || url.hostname === "www.letterboxd.com";
  if (
    url.protocol !== "https:"
    || !allowedHost
    || url.port
    || url.username
    || url.password
  ) throw new Error("Host redirect Letterboxd non ammesso");
  if (initial) {
    const code = url.pathname.replace(/^\/+|\/+$/g, "");
    if (url.hostname !== "boxd.it" || url.search || url.hash || !/^[A-Za-z0-9]{1,16}$/.test(code)) {
      throw new Error("URL boxd.it iniziale non ammesso");
    }
  }
  return url;
}

async function readBodyCapped(response, maxBytes = MAX_HTML_BYTES) {
  const length = Number(response.headers?.get?.("content-length") || 0);
  if (Number.isFinite(length) && length > maxBytes) throw new Error("Pagina Letterboxd troppo grande");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error("Pagina Letterboxd troppo grande");
  return buffer.toString("utf8");
}

async function resolveLetterboxdFilm(rawUri, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  maxRedirects = 3,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch non disponibile");
  let current = validateAllowedUrl(rawUri, { initial: true });

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await fetchImpl(current, {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "Somto-Letterboxd-Import/1.0 (+https://somto.it)",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (hop >= maxRedirects) throw new Error("Troppi redirect Letterboxd");
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirect Letterboxd senza destinazione");
      current = validateAllowedUrl(new URL(location, current).toString());
      continue;
    }
    if (response.status !== 200) throw new Error(`Letterboxd HTTP ${response.status}`);
    if (!/^\/(?:film)\/[^/]+\/?$/.test(current.pathname)) {
      throw new Error("La URI canonica non porta a una pagina film");
    }
    const html = await readBodyCapped(response);
    const idMatch = html.match(/data-tmdb-id=["'](\d+)["']/i);
    const linkMatch = html.match(/themoviedb\.org\/(movie|tv)\/(\d+)/i);
    if (!idMatch && !linkMatch) throw new Error("TMDB id assente dalla pagina Letterboxd");
    const tmdbId = Number(idMatch?.[1] || linkMatch?.[2]);
    if (!linkMatch) throw new Error("Tipo TMDB assente dalla pagina Letterboxd");
    const linkedId = Number(linkMatch[2]);
    if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0 || tmdbId !== linkedId) {
      throw new Error("TMDB id incoerente nella pagina Letterboxd");
    }
    return {
      tmdbId,
      mediaType: linkMatch[1].toLocaleLowerCase("en-US") === "tv" ? "tv" : "movie",
      canonicalPath: current.pathname,
    };
  }
  throw new Error("Risoluzione Letterboxd incompleta");
}

function normalizeTitle(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

async function resolveTmdbMovieByExactNameYear(name, year, {
  apiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
} = {}) {
  const cleanName = String(name || "").trim();
  const numericYear = Number(year);
  if (!cleanName || !/^\d{4}$/.test(String(numericYear))) throw new Error("Fallback TMDB senza nome/anno valido");
  if (!apiKey) throw new Error("TMDB_KEY mancante");
  const url = new URL("https://api.themoviedb.org/3/search/movie");
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("query", cleanName);
  url.searchParams.set("year", String(numericYear));
  url.searchParams.set("language", "it-IT");
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "error",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status !== 200) throw new Error(`Fallback TMDB HTTP ${response.status}`);
  const body = await readBodyCapped(response);
  let payload;
  try { payload = JSON.parse(body); } catch { throw new Error("Fallback TMDB JSON non valido"); }
  const wanted = normalizeTitle(cleanName);
  const exact = (Array.isArray(payload?.results) ? payload.results : []).filter((row) => {
    const releaseYear = String(row?.release_date || "").slice(0, 4);
    const names = [row?.title, row?.original_title].map(normalizeTitle).filter(Boolean);
    return releaseYear === String(numericYear) && names.includes(wanted) && Number(row?.id) > 0;
  });
  const ids = [...new Set(exact.map((row) => Number(row.id)))];
  if (ids.length !== 1) throw new Error(`Fallback TMDB non univoco (${ids.length})`);
  return { tmdbId: ids[0], mediaType: "movie", resolutionStrategy: "tmdb_exact_name_year" };
}

module.exports = {
  EXPECTED_ARCHIVE_PATHS,
  CSV_PATHS_TO_READ,
  MAX_ARCHIVE_ENTRIES,
  MAX_ENTRY_BYTES,
  MAX_TOTAL_UNCOMPRESSED_BYTES,
  MAX_COMPRESSION_RATIO,
  MAX_HTML_BYTES,
  parseZipInfoListing,
  validateArchiveEntries,
  validateAllowedUrl,
  resolveLetterboxdFilm,
  resolveTmdbMovieByExactNameYear,
};
