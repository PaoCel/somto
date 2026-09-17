// tvTimeCsvPreview.js — Stima client-side best-effort dei 2 CSV TV Time
// (film + serie) PRIMA di inviarli al server. Serve solo per la preview
// ("N voci trovate, ~M film, ~K episodi serie") — il parsing autorevole
// (identico pattern-per-pattern) avviene server-side in
// functions/lib/importAdapters/tvTimeGdpr.js, che ri-parsa sempre i CSV da
// zero. Non fidarsi di questo conteggio client per le scritture.

// RFC4180-ish CSV parser minimale (quote, virgole, doppio-quote escape) —
// stessa implementazione di netflixCsvPreview.js.
function parseCsvRows(rawText) {
  const text = String(rawText || "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };

  while (i < len) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"') { inQuotes = true; i += 1; continue; }
    if (ch === ',') { pushField(); i += 1; continue; }
    if (ch === '\r') { if (text[i + 1] === '\n') i += 1; pushRow(); i += 1; continue; }
    if (ch === '\n') { pushRow(); i += 1; continue; }
    field += ch; i += 1;
  }
  if (field.length > 0 || row.length > 0) pushRow();
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

const V1_IGNORED_TYPES = new Set(["count-watch-movie", "time-count"]);

function previewMoviesCsv(rawText) {
  const table = parseCsvRows(rawText);
  if (table.length === 0) return { watched: 0, watchlist: 0 };
  const header = table[0].map((h) => String(h || "").trim().toLowerCase());
  const typeUuidNIdx = header.indexOf("type-uuid-n");
  const typeIdx = header.indexOf("type");
  const nameIdx = header.indexOf("movie_name");
  if (typeIdx === -1 || nameIdx === -1) return { watched: 0, watchlist: 0 };

  let watched = 0;
  let watchlist = 0;
  for (let i = 1; i < table.length; i += 1) {
    const record = table[i];
    if (!record || record.length === 0) continue;
    const typeUuidN = typeUuidNIdx !== -1 ? String(record[typeUuidNIdx] || "").trim().toLowerCase() : "";
    if (V1_IGNORED_TYPES.has(typeUuidN)) continue;
    const type = String(record[typeIdx] || "").trim().toLowerCase();
    if (V1_IGNORED_TYPES.has(type)) continue;
    if (!String(record[nameIdx] || "").trim()) continue;
    if (type === "watch") watched += 1;
    else if (type === "follow") watchlist += 1;
  }
  return { watched, watchlist };
}

function previewSeriesCsv(rawText) {
  const table = parseCsvRows(rawText);
  if (table.length === 0) return { episodesWatched: 0, seriesWatchlist: 0 };
  const header = table[0].map((h) => String(h || "").trim().toLowerCase());
  const keyIdx = header.indexOf("key");
  const isForLaterIdx = header.indexOf("is_for_later");
  const seriesNameIdx = header.indexOf("series_name");
  if (keyIdx === -1) return { episodesWatched: 0, seriesWatchlist: 0 };

  let episodesWatched = 0;
  let seriesWatchlist = 0;
  for (let i = 1; i < table.length; i += 1) {
    const record = table[i];
    if (!record || record.length === 0) continue;
    const key = String(record[keyIdx] || "").trim();
    if (key === "tracking-stats") continue;
    if (/^watch-episode-/.test(key)) {
      episodesWatched += 1;
    } else if (/^user-series-/.test(key)) {
      const isForLater = isForLaterIdx !== -1 && String(record[isForLaterIdx] || "").trim().toLowerCase() === "true";
      const hasName = seriesNameIdx !== -1 && String(record[seriesNameIdx] || "").trim().length > 0;
      if (isForLater && hasName) seriesWatchlist += 1;
    }
  }
  return { episodesWatched, seriesWatchlist };
}

/**
 * Stima grezza sui 2 CSV TV Time. Ritorna
 * { moviesWatched, moviesWatchlist, episodesWatched, seriesWatchlist, total }.
 * `total` è la somma di tutte le voci riconosciute (film + episodi + serie
 * in watchlist) — usata solo per il messaggio "N voci trovate" della UI.
 */
export function previewTvTimeCsvs({ moviesCsv, seriesCsv }) {
  const movies = previewMoviesCsv(moviesCsv || "");
  const series = previewSeriesCsv(seriesCsv || "");
  const total = movies.watched + movies.watchlist + series.episodesWatched + series.seriesWatchlist;
  return {
    moviesWatched: movies.watched,
    moviesWatchlist: movies.watchlist,
    episodesWatched: series.episodesWatched,
    seriesWatchlist: series.seriesWatchlist,
    total,
  };
}
