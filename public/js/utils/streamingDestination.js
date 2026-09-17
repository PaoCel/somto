// Dove porta "guarda su …", lato web.
//
// GEMELLO DICHIARATO di `ios/TwoWatch/Domain/Services/StreamingDestination.swift`:
// stessa catena, stessi modelli di ricerca, stessi alias. Due file perche' due
// linguaggi, non perche' due regole — se qui aggiungi una piattaforma, va
// aggiunta anche di la', se no lo stesso titolo manda l'utente in due posti
// diversi a seconda di dove ha toccato.
//
// LA CATENA, in ordine di precisione:
//  1. link diretto risolto dal server (Wikidata) — apre la scheda del titolo
//     dentro la piattaforma;
//  2. ricerca dentro il sito/app della piattaforma;
//  3. pagina "dove guardare" di TMDB, l'ultimo ripiego.

/** I nomi con cui TMDB scrive Amazon: nessuno e' la casa di un titolo se c'e' dell'altro. */
const RESELLERS = new Set([
  "amazon prime video",
  "amazon prime video with ads",
  "amazon video",
]);

// OGNI RIGA QUI DENTRO E' STATA APERTA DAVVERO (verifica dell'8/9/2026). Un
// modello di ricerca inventato non fallisce da nessuna parte: manda l'utente
// sulla pagina 404 della piattaforma, che dall'esterno e' indistinguibile da
// "il tasto di Somto non funziona". Cinque di queste righe erano cosi' —
// Disney+, NOW, Sky Go, Mediaset Infinity, discovery+ — e sono state tolte:
// quei titoli ripiegano sulla pagina "dove guardare" di TMDB, che invece porta
// sul titolo esatto in un tap in piu'.
const SEARCH_TEMPLATES = {
  "netflix": "https://www.netflix.com/search?q=",
  "amazon prime video": "https://www.primevideo.com/search/?phrase=",
  // Senza il paese Apple redirige su /us/ e mostra un catalogo che qui non si
  // puo' guardare.
  "apple tv": "https://tv.apple.com/it/search?term=",
  "apple tv+": "https://tv.apple.com/it/search?term=",
  "paramount plus": "https://www.paramountplus.com/search/?query=",
  "rai play": "https://www.raiplay.it/ricerca.html?q=",
  "raiplay": "https://www.raiplay.it/ricerca.html?q=",
  "crunchyroll": "https://www.crunchyroll.com/it/search?q=",
  "rakuten tv": "https://www.rakuten.tv/it/search?q=",
  "mubi": "https://mubi.com/it/search/films?query=",
  "plex": "https://watch.plex.tv/search?q=",
};

const SUFFIXES = [" amazon channel", " amazon channels", " apple tv channel", " with ads"];

/**
 * "Apple TV Amazon Channel" e "Apple TV" sono lo stesso servizio: il primo e'
 * solo il modo in cui lo si paga.
 */
export function providerBaseName(name) {
  const trimmed = String(name || "").trim();
  const lower = trimmed.toLowerCase();
  for (const suffix of SUFFIXES) {
    if (lower.endsWith(suffix)) return trimmed.slice(0, trimmed.length - suffix.length).trim();
  }
  return trimmed;
}

/** L'elenco ripulito: nomi collassati, doppioni via, rivenditori in fondo. */
export function rankProviders(names) {
  const seen = new Set();
  const collapsed = [];
  for (const raw of Array.isArray(names) ? names : []) {
    const name = providerBaseName(raw);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    collapsed.push(name);
  }
  const veri = collapsed.filter((n) => !RESELLERS.has(n.toLowerCase()));
  const rivenditori = collapsed.filter((n) => RESELLERS.has(n.toLowerCase()));
  return veri.length ? [...veri, ...rivenditori] : rivenditori;
}

/** Gli alias con cui TMDB scrive la stessa piattaforma, allineati al server. */
function canonicalName(name) {
  switch (String(name || "").toLowerCase()) {
    case "netflix":
    case "netflix basic with ads":
    case "netflix standard with ads": return "Netflix";
    case "disney plus":
    case "disney+": return "Disney Plus";
    case "apple tv":
    case "apple tv+":
    case "apple tv plus": return "Apple TV";
    case "hbo max":
    case "max": return "HBO Max";
    case "paramount plus":
    case "paramount+": return "Paramount Plus";
    default: return "";
  }
}

function searchTemplate(providerName) {
  const lower = String(providerName || "").toLowerCase();
  if (SEARCH_TEMPLATES[lower]) return SEARCH_TEMPLATES[lower];
  const base = providerBaseName(providerName).toLowerCase();
  if (SEARCH_TEMPLATES[base]) return SEARCH_TEMPLATES[base];
  // I canali di marchi che non sappiamo aprire (MGM+, Midnight Factory) si
  // guardano davvero dentro Prime Video.
  if (lower.endsWith("amazon channel")) return SEARCH_TEMPLATES["amazon prime video"];
  return "";
}

export function tmdbWatchPage({ tmdbId, isSeries, locale = "IT" } = {}) {
  const id = Math.floor(Number(tmdbId));
  if (!Number.isFinite(id) || id <= 0) return "";
  return `https://www.themoviedb.org/${isSeries ? "tv" : "movie"}/${id}/watch?locale=${locale}`;
}

/**
 * Dove mandare chi tocca il bottone di UNA piattaforma.
 * Torna `{ providerName, url, source, isExact }` oppure `null`.
 */
export function streamingDestination({ providerName, deepLinks = {}, titleName = "", tmdbId, isSeries = false } = {}) {
  const trimmed = String(providerName || "").trim();
  if (!trimmed) return null;

  // Si RISOLVE sul nome cosi' com'e' (li' sopravvive il suffisso "Amazon
  // Channel", l'unica traccia del fatto che quel marchio si guarda dentro Prime
  // Video) ma si MOSTRA quello collassato.
  const base = providerBaseName(trimmed);
  const display = base || trimmed;

  const direct = deepLinks[trimmed] || deepLinks[base] || deepLinks[canonicalName(base) || base];
  if (direct) {
    return { providerName: display, url: String(direct), source: "direct", isExact: true };
  }

  const template = searchTemplate(trimmed);
  if (template && titleName) {
    return {
      providerName: display,
      url: template + encodeURIComponent(titleName),
      source: "providerSearch",
      isExact: false,
    };
  }

  const page = tmdbWatchPage({ tmdbId, isSeries });
  if (page) return { providerName: display, url: page, source: "tmdbWatchPage", isExact: false };

  return null;
}

/**
 * La destinazione migliore fra le piattaforme disponibili: si seguono i
 * provider nell'ordine di `rankProviders`, ma un link diretto batte l'ordine —
 * meglio la seconda piattaforma sulla scheda esatta che la prima su una ricerca.
 */
export function bestStreamingDestination({ providerNames = [], deepLinks = {}, titleName = "", tmdbId, isSeries = false } = {}) {
  // `rankProviders` decide l'ORDINE, ma la risoluzione parte dal nome originale:
  // collassato, "MGM Plus Amazon Channel" diventa "MGM Plus", che non e' fra i
  // modelli di ricerca — e un marchio che si guarda dentro Prime Video finiva
  // sulla pagina TMDB invece che dentro l'app.
  const originalByBase = new Map();
  for (const name of Array.isArray(providerNames) ? providerNames : []) {
    const key = providerBaseName(name).toLowerCase();
    if (key && !originalByBase.has(key)) originalByBase.set(key, name);
  }
  const candidates = rankProviders(providerNames)
    .map((name) => streamingDestination({
      providerName: originalByBase.get(name.toLowerCase()) || name,
      deepLinks,
      titleName,
      tmdbId,
      isSeries,
    }))
    .filter(Boolean);
  return candidates.find((c) => c.source === "direct")
    || candidates.find((c) => c.source === "providerSearch")
    || candidates[0]
    || null;
}
