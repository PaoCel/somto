"use strict";

// Da un id TMDB al link che apre il titolo DENTRO l'app della piattaforma.
//
// LA FONTE — Wikidata. Ogni film/serie ha un item, e su quell'item stanno sia
// l'id TMDB (che noi abbiamo gia') sia gli id delle piattaforme. Il collegamento
// e' quindi una query sola, senza cercare per nome e senza indovinare.
//
// PERCHE' NON SI RASCHIA JUSTWATCH — quei deep link sono il prodotto che
// JustWatch vende, e le loro condizioni vietano la raccolta automatica. Wikidata
// e' l'opposto: dato pubblico, licenza CC0, endpoint pensato per essere
// interrogato.
//
// COSA SI E' MISURATO (2026-08-15, 296 titoli del catalogo con provider italiani
// dichiarati da TMDB): almeno un link diretto per il 74% dei titoli. Per
// piattaforma: Netflix 90%, Disney+ 80%, Apple TV 83%, HBO Max 50%,
// Paramount+ 17%, Prime Video 20%.
//
// PRIME VIDEO E' ESCLUSO DI PROPOSITO, e non per la copertura bassa: gli id su
// Wikidata sono ASIN del catalogo statunitense. `amazon.com/gp/video/detail/<asin>`
// risponde 200, ma lo stesso id su `primevideo.com` e su `amazon.it` da' 404 —
// mandare un utente italiano li' sarebbe peggio del comportamento attuale.
//
// ATTENZIONE AL CONFINE — un id Netflix esiste per un titolo anche dove Netflix
// non lo ha in catalogo. Questo modulo dice DOVE porta il bottone, non SU COSA
// il titolo e' disponibile: quello resta compito dei watch provider TMDB, che
// sono per regione. Chi consuma questi link deve incrociare le due cose.

const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";

// Il contatto nello user agent e' richiesto dalle regole di Wikimedia: senza,
// le richieste vengono rifiutate.
const USER_AGENT = "SomtoStreamingLinks/1.0 (https://somto.it; support@somto.it)";

const TMDB_PROPERTY = { movie: "P4947", tv: "P4983" };

/**
 * Le proprieta' che sappiamo trasformare in un link.
 *
 * `formatter` non e' inventato: e' il valore di P1630 sulla proprieta' stessa
 * (verificato il 2026-08-15). Tenerlo qui invece di leggerlo a ogni giro evita
 * una query in piu' per un dato che cambia una volta ogni mai; se cambiasse, il
 * test `wikidataStreamingLinks.test.cjs` e' il posto dove accorgersene.
 */
const PROPERTIES = [
  { key: "netflix", pid: "P1874", provider: "Netflix", url: (id) => `https://www.netflix.com/title/${id}` },
  { key: "disneySeries", pid: "P7596", provider: "Disney Plus", url: (id) => `https://www.disneyplus.com/series/wp/${id}` },
  { key: "disneyMovie", pid: "P7595", provider: "Disney Plus", url: (id) => `https://www.disneyplus.com/movies/wd/${id}` },
  { key: "disneyBrowse", pid: "P13902", provider: "Disney Plus", url: (id) => `https://www.disneyplus.com/browse/${id}` },
  { key: "appleShow", pid: "P9751", provider: "Apple TV", url: (id) => `https://tv.apple.com/show/${id}` },
  { key: "appleMovie", pid: "P9586", provider: "Apple TV", url: (id) => `https://tv.apple.com/movie/${id}` },
  // Il formatter di P8298 punta ancora a `play.hbomax.com`, che redirige su Max.
  // Si scrive il dominio nuovo: un redirect in meno prima di aprire l'app.
  { key: "hboMax", pid: "P8298", provider: "HBO Max", url: (id) => `https://play.max.com/${id}` },
  { key: "paramount", pid: "P13147", provider: "Paramount Plus", url: (id) => `https://www.paramountplus.com/shows/video/${id}/` },
];

/**
 * Come si chiama la stessa piattaforma per TMDB.
 *
 * TMDB scrive "Disney Plus", non "Disney+", e per l'Italia "HBO Max" convive con
 * "Max": si mappano tutti sullo stesso link. La chiave e' minuscola perche' e'
 * cosi' che si confronta.
 */
const PROVIDER_ALIASES = {
  netflix: "Netflix",
  "netflix basic with ads": "Netflix",
  "netflix standard with ads": "Netflix",
  "disney plus": "Disney Plus",
  "disney+": "Disney Plus",
  "apple tv": "Apple TV",
  "apple tv+": "Apple TV",
  "apple tv plus": "Apple TV",
  "hbo max": "HBO Max",
  max: "HBO Max",
  "paramount plus": "Paramount Plus",
  "paramount+": "Paramount Plus",
};

/**
 * Il nome "vero" di un servizio, tolto il modo in cui lo si paga.
 *
 * TMDB elenca "Apple TV Amazon Channel" accanto ad "Apple TV": e' lo stesso
 * servizio comprato dentro Amazon. Senza questo, un titolo disponibile solo
 * come canale non trovava mai il suo link — e Prime Video sembrava la casa di
 * serie che sono di altri (Ted Lasso, constatato il 2026-08-15).
 */
function baseProviderName(name) {
  const trimmed = String(name || "").trim();
  const lower = trimmed.toLowerCase();
  for (const suffix of [" amazon channel", " amazon channels", " apple tv channel", " with ads"]) {
    if (lower.endsWith(suffix)) return trimmed.slice(0, trimmed.length - suffix.length).trim();
  }
  return trimmed;
}

function canonicalProvider(name) {
  const key = String(name || "").trim().toLowerCase();
  if (PROVIDER_ALIASES[key]) return PROVIDER_ALIASES[key];
  const base = baseProviderName(name).toLowerCase();
  return PROVIDER_ALIASES[base] || null;
}

function normalizeMediaType(value) {
  return String(value || "").toLowerCase() === "tv" ? "tv" : "movie";
}

/**
 * La query: un id TMDB alla volta o a gruppi, e tutte le proprieta' in
 * `OPTIONAL` — un titolo che non ha l'id Netflix deve comunque tornare, con
 * quello che ha.
 */
function buildQuery(tmdbIds, mediaType) {
  const ids = [...new Set((Array.isArray(tmdbIds) ? tmdbIds : [tmdbIds])
    .map((id) => Math.floor(Number(id)))
    .filter((id) => Number.isFinite(id) && id > 0))];
  if (!ids.length) return null;

  const property = TMDB_PROPERTY[normalizeMediaType(mediaType)];
  const select = PROPERTIES.map((p) => `?${p.key}`).join(" ");
  const optionals = PROPERTIES.map((p) => `  OPTIONAL { ?item wdt:${p.pid} ?${p.key} . }`).join("\n");

  return `SELECT ?tmdb ${select} WHERE {
  VALUES ?tmdb { ${ids.map((id) => `"${id}"`).join(" ")} }
  ?item wdt:${property} ?tmdb .
${optionals}
}`;
}

/**
 * Dalle righe SPARQL alla mappa `{ "Netflix": "https://...", … }`.
 *
 * Quando la stessa piattaforma ha piu' proprieta' (Disney+ ne ha tre) vince la
 * prima dell'elenco: sono in ordine di quanto sono specifiche.
 */
function buildLinksFromBindings(bindings) {
  const byTmdb = new Map();
  for (const row of Array.isArray(bindings) ? bindings : []) {
    const tmdb = row?.tmdb?.value;
    if (!tmdb) continue;
    const links = byTmdb.get(tmdb) || {};
    for (const property of PROPERTIES) {
      const value = row?.[property.key]?.value;
      if (!value || links[property.provider]) continue;
      links[property.provider] = property.url(value);
    }
    byTmdb.set(tmdb, links);
  }
  return byTmdb;
}

/**
 * Interroga Wikidata. `fetchImpl` iniettabile per i test.
 *
 * Il 429 esiste ed e' facile prenderselo (misurato: al terzo gruppo consecutivo
 * di 40 id). Chi chiama deve trattarlo come "riprovo dopo", non come errore:
 * qui si torna `null` invece di lanciare, cosi' un titolo senza link diretto
 * resta semplicemente un titolo senza link diretto.
 */
async function queryWikidata({ tmdbIds, mediaType, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const query = buildQuery(tmdbIds, mediaType);
  if (!query) return null;

  const url = `${WIKIDATA_SPARQL}?format=json&query=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/sparql-results+json" },
      signal: controller.signal,
    });
    if (!response || !response.ok) return null;
    const payload = await response.json();
    return buildLinksFromBindings(payload?.results?.bindings);
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * I link diretti di UN titolo, gia' filtrati su cio' che ha senso mostrare.
 *
 * @param {string[]} availableProviders i nomi TMDB dei provider disponibili
 *   nella regione dell'utente. Un link a una piattaforma che li' non ha il
 *   titolo non deve nemmeno essere salvato: e' il confine fra "dove si vede" e
 *   "dove porta il bottone".
 */
function filterByAvailability(links, availableProviders) {
  const canonical = new Set(
    (Array.isArray(availableProviders) ? availableProviders : [])
      .map(canonicalProvider)
      .filter(Boolean)
  );
  if (!canonical.size) return {};
  const out = {};
  for (const [provider, url] of Object.entries(links || {})) {
    if (canonical.has(provider)) out[provider] = url;
  }
  return out;
}

module.exports = {
  PROPERTIES,
  baseProviderName,
  PROVIDER_ALIASES,
  USER_AGENT,
  buildQuery,
  buildLinksFromBindings,
  canonicalProvider,
  filterByAvailability,
  queryWikidata,
};
