"use strict";

// Netflix "Viewing history" CSV adapter — parses the raw export
// (`Title,Date` RFC4180 CSV) into a generic NormalizedRow[] shape shared with
// future import sources (e.g. TV Time). This module is a PURE parser: no
// Firestore, no TMDB, no I/O. Matching/writing happen downstream.
//
// NormalizedRow = {
//   rawTitle: string,
//   rawDate: string,
//   kind: "movie" | "tv_episode" | "ambiguous",
//   seriesNameGuess: string | null,
//   movieNameGuess: string | null,
//   seasonNumber: number | null,
//   episodeNumber: number | null,
//   episodeNameGuess: string | null,
//   watchedDate: Date,          // noon UTC of the watched day
// }
//
// Malformed rows produce an entry in `errors` (never a silent skip).

const { parseCsv } = require("./csv");

const HEADER_TITLE = "title";
const HEADER_DATE = "date";

function safeString(value, maxLen = 500) {
  return String(value ?? "").trim().slice(0, maxLen);
}

// Netflix export dates are always M/D/YY (US order), always 20YY.
function parseNetflixDate(rawDate) {
  const trimmed = safeString(rawDate, 20);
  const m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = 2000 + Number(m[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  // Noon UTC avoids the date shifting a calendar day when later rendered in
  // a non-UTC timezone.
  const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return d;
}

// Extracts a leading season number from a segment like "Stagione 2" or
// "Stagione 2 (Part 2)". Netflix localises this marker to the title's own
// metadata language, so an Italian account can still get English "Season 11"
// (e.g. "Don Matteo: Season 11: ...") — accept both spellings. Returns null if
// the segment isn't a season marker.
function matchSeasonSegment(segment) {
  const m = String(segment || "").trim().match(/^(?:Stagione|Season)\s+(\d+)/i);
  if (!m) return null;
  // "Stagione 0" non è una stagione reale: trattala come non-marker, il
  // segmento scenderà nel ramo nome-episodio (mai numeri 0 nelle righe).
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

function matchMiniseriesSegment(segment) {
  const s = String(segment || "").trim().toLowerCase();
  return s === "miniserie" || s === "limited series";
}

// "Episodio N" / "Episode N" (whole segment, optionally with trailing junk we
// ignore). Bilingue per lo stesso motivo di `matchSeasonSegment`: senza la
// variante inglese un export da account EN passa il match stagione e fallisce
// qui, e "Episode 4" viene preso per NOME dell'episodio invece che per numero.
function matchEpisodioNumberSegment(segment) {
  const m = String(segment || "").trim().match(/^(?:Episodio|Episode)\s+(\d+)$/i);
  if (!m) return null;
  // "Episodio 0" → nessun numero: il testo resta come nome episodio, che
  // conta comunque come 1 visto distinto (mai 0 nei campi numerici).
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

// "Parte N" as the FIRST segment after the series name (Lupin case: an
// alternate-season marker, not a sub-part suffix). Distinguish from the
// suffix case by position — caller only calls this on segments[1].
function matchPartAsSeasonSegment(segment) {
  const m = String(segment || "").trim().match(/^(?:Parte|Part)\s+(\d+)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

// "Capitolo N" / "Episodio N" used as the episode number under a
// Parte-as-season marker (Lupin: "Lupin: Parte 3: Capitolo 7").
function matchChapterOrEpisodeNumberSegment(segment) {
  const m = String(segment || "").trim().match(/^(?:Capitolo|Episodio|Chapter|Episode)\s+(\d+)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

// LAST-segment sub-part suffix: "Parte 1", "Parte 1 e 2", "Parti 1 e 2",
// "Parte 1 / ... Parte 2" etc, e le forme inglesi "Part 1", "Parts 1 and 2".
// When present, it's a sub-part of the SAME episode, not a separate event —
// the caller should strip it and treat the remaining name as the episode name.
const PART_SUFFIX_RE = /\s*[-–:]?\s*(?:Parte|Parti|Part|Parts)\s+\d+(?:\s*(?:e|and|\/|,)\s*\d+)*\s*$/i;

function stripTrailingPartSuffix(segment) {
  const s = String(segment || "").trim();
  return s.replace(PART_SUFFIX_RE, "").trim();
}

function hasTrailingPartSuffix(segment) {
  return PART_SUFFIX_RE.test(String(segment || "").trim());
}

// Applies the trailing sub-part-suffix strip to the LAST segment of an
// episode-name segment array. If stripping empties that segment entirely
// (the whole segment WAS the suffix, e.g. a lone "Parte 2"), the segment is
// dropped rather than restored — it carried no episode-name information.
function stripTrailingPartSuffixFromSegments(segments) {
  if (!segments.length || !hasTrailingPartSuffix(segments[segments.length - 1])) {
    return segments;
  }
  const lastIdx = segments.length - 1;
  const stripped = stripTrailingPartSuffix(segments[lastIdx]);
  const head = segments.slice(0, lastIdx);
  return stripped ? head.concat(stripped) : head;
}

// "Parte N" come UNICO segmento dopo il marker di stagione/miniserie: alcune
// miniserie Netflix etichettano proprio così i loro episodi ("L'altra Grace:
// Miniserie: Parte 5", "When They See Us: Stagione 1: Parte 4" — una riga per
// parte). Lì "Parte N" È l'episodio, non un suffisso sub-parte di un nome che
// non c'è: N diventa il numero episodio. Le forme multiple ("Parte 1 e 2")
// non matchano e restano come nome episodio.
// Senza questo, lo strip del suffisso svuotava il segmento e la riga finiva
// senza numero E senza nome → invisibile al conteggio episodi → serie
// "in corso a 0 episodi" sul profilo (caso reale: Alias Grace, 6 parti).
function matchLoneParteEpisodeSegment(segment) {
  const m = String(segment || "").trim().match(/^(?:Parte|Part)\s+(\d+)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

function buildRow(rawTitle, rawDate, watchedDate, fields) {
  return {
    rawTitle,
    rawDate,
    kind: fields.kind,
    seriesNameGuess: fields.seriesNameGuess ?? null,
    movieNameGuess: fields.movieNameGuess ?? null,
    seasonNumber: fields.seasonNumber ?? null,
    episodeNumber: fields.episodeNumber ?? null,
    episodeNameGuess: fields.episodeNameGuess ?? null,
    watchedDate,
  };
}

// Parses a single Netflix "Title" cell into NormalizedRow fields (everything
// but rawTitle/rawDate/watchedDate, which the caller attaches).
function parseNetflixTitleCell(rawTitle) {
  const title = safeString(rawTitle, 500);
  const segments = title.split(": ").map((s) => s.trim()).filter((s) => s.length > 0);

  if (segments.length === 0) {
    return { error: "Titolo vuoto." };
  }

  // 1 segment, no markers anywhere -> could be a movie OR a single-word/no-colon
  // episode title (11% of real data, e.g. "The Big Bang Theory: Pilot" is 2
  // segments but "Interstellar" is 1). A genuinely single-segment row with no
  // series/season marker is ambiguous only when it could plausibly be an
  // episode name too — but with zero structural signal we can't tell a movie
  // from a one-off episode reference. Per spec: 0 extra segments = movie.
  if (segments.length === 1) {
    return {
      kind: "movie",
      movieNameGuess: segments[0],
      seriesNameGuess: null,
      seasonNumber: null,
      episodeNumber: null,
      episodeNameGuess: null,
    };
  }

  const seriesName = segments[0];
  const rest = segments.slice(1);

  // --- Miniserie / Limited Series -> season 1 ---
  if (matchMiniseriesSegment(rest[0])) {
    const after = rest.slice(1);
    if (after.length === 0) {
      return { error: "Miniserie senza episodio." };
    }
    // Sub-part suffix on the last segment: same episode, strip suffix.
    const episodeSegments = stripTrailingPartSuffixFromSegments(after);
    if (episodeSegments.length === 0) {
      // Lo strip ha consumato tutto: il segmento ERA solo "Parte N" →
      // miniserie a parti, N = numero episodio (vedi matchLoneParteEpisodeSegment).
      const parteEpisode = matchLoneParteEpisodeSegment(after[after.length - 1]);
      return {
        kind: "tv_episode",
        seriesNameGuess: seriesName,
        movieNameGuess: null,
        seasonNumber: 1,
        episodeNumber: parteEpisode,
        episodeNameGuess: parteEpisode != null ? null : (after.join(": ") || null),
      };
    }
    const lastSeg = episodeSegments[episodeSegments.length - 1];
    const epNumber = episodeSegments.length === 1 ? matchEpisodioNumberSegment(lastSeg) : null;
    return {
      kind: "tv_episode",
      seriesNameGuess: seriesName,
      movieNameGuess: null,
      seasonNumber: 1,
      episodeNumber: epNumber,
      episodeNameGuess: epNumber != null ? null : (episodeSegments.join(": ") || null),
    };
  }

  // --- "Parte N" immediately after series name, followed by
  //     Capitolo/Episodio M -> alternate-season marker (Lupin case) ---
  const partAsSeason = matchPartAsSeasonSegment(rest[0]);
  if (partAsSeason != null && rest.length >= 2) {
    const chapterNum = matchChapterOrEpisodeNumberSegment(rest[1]);
    if (chapterNum != null && rest.length === 2) {
      return {
        kind: "tv_episode",
        seriesNameGuess: seriesName,
        movieNameGuess: null,
        seasonNumber: partAsSeason,
        episodeNumber: chapterNum,
        episodeNameGuess: null,
      };
    }
    // "Parte N" as season but the remainder isn't a clean Capitolo/Episodio
    // number segment — fall through to generic episode-name handling below,
    // still anchored on partAsSeason as the season number.
    const remainder = rest.slice(1);
    const episodeSegments = stripTrailingPartSuffixFromSegments(remainder);
    return {
      kind: "tv_episode",
      seriesNameGuess: seriesName,
      movieNameGuess: null,
      seasonNumber: partAsSeason,
      episodeNumber: null,
      episodeNameGuess: episodeSegments.join(": ") || null,
    };
  }

  // --- Explicit "Stagione N" ---
  const seasonNumber = matchSeasonSegment(rest[0]);
  if (seasonNumber != null) {
    const after = rest.slice(1);
    if (after.length === 0) {
      return { error: "Stagione senza episodio." };
    }
    // Sub-part suffix ("Parte N [e M]") as the LAST segment: strip it, same
    // episode/event, don't treat as a separate row.
    const episodeSegments = stripTrailingPartSuffixFromSegments(after);
    if (episodeSegments.length === 0) {
      // "Show: Stagione S: Parte N" senza altro: N è l'episodio della
      // stagione a parti (caso reale: When They See Us, 4 parti).
      const parteEpisode = matchLoneParteEpisodeSegment(after[after.length - 1]);
      return {
        kind: "tv_episode",
        seriesNameGuess: seriesName,
        movieNameGuess: null,
        seasonNumber,
        episodeNumber: parteEpisode,
        episodeNameGuess: parteEpisode != null ? null : (after.join(": ") || null),
      };
    }
    const lastSeg = episodeSegments[episodeSegments.length - 1];
    const epNumber = episodeSegments.length === 1 ? matchEpisodioNumberSegment(lastSeg) : null;
    return {
      kind: "tv_episode",
      seriesNameGuess: seriesName,
      movieNameGuess: null,
      seasonNumber,
      episodeNumber: epNumber,
      episodeNameGuess: epNumber != null ? null : (episodeSegments.join(": ") || null),
    };
  }

  // --- 2 segments, no season/miniserie/parte-as-season marker: e.g.
  //     "Bocciato: Incastrato", "Man Vs Baby: Capitolo 4",
  //     "The Big Bang Theory: Pilot" ---
  // These are single-season shows Netflix doesn't label with "Stagione 1" in
  // the export, OR a genuinely ambiguous single-clause title. Per spec, only
  // a true 1-segment row (no colon at all) is unambiguously a movie; a
  // 2-segment row with no structural season/episode marker is ambiguous
  // (could be "Series: Episode" or a movie with a subtitle after a colon).
  if (rest.length >= 1) {
    const episodeSegments = stripTrailingPartSuffixFromSegments(rest);
    return {
      kind: "ambiguous",
      seriesNameGuess: seriesName,
      movieNameGuess: title,
      seasonNumber: null,
      episodeNumber: null,
      episodeNameGuess: episodeSegments.join(": ") || null,
    };
  }

  return { error: "Formato titolo non riconosciuto." };
}

/**
 * Parses a raw Netflix "Viewing history" CSV export.
 * Returns { rows: NormalizedRow[], errors: Array<{ line, rawTitle, rawDate, reason }> }.
 * Malformed rows are reported in `errors`, never silently dropped.
 */
function parseNetflixCsv(rawText) {
  const table = parseCsv(rawText);
  const rows = [];
  const errors = [];

  if (table.length === 0) {
    return { rows, errors: [{ line: 0, rawTitle: "", rawDate: "", reason: "File CSV vuoto." }] };
  }

  const header = table[0].map((h) => safeString(h, 40).toLowerCase());
  const titleIdx = header.indexOf(HEADER_TITLE);
  const dateIdx = header.indexOf(HEADER_DATE);

  if (titleIdx === -1 || dateIdx === -1) {
    return {
      rows,
      errors: [{ line: 1, rawTitle: "", rawDate: "", reason: "Header CSV inatteso (attese colonne Title,Date)." }],
    };
  }

  for (let i = 1; i < table.length; i += 1) {
    const line = i + 1; // 1-indexed, header is line 1
    const record = table[i];
    if (!record || record.length === 0) continue;

    const rawTitle = safeString(record[titleIdx], 500);
    const rawDate = safeString(record[dateIdx], 20);

    if (!rawTitle) {
      errors.push({ line, rawTitle, rawDate, reason: "Titolo mancante." });
      continue;
    }

    const watchedDate = parseNetflixDate(rawDate);
    if (!watchedDate) {
      errors.push({ line, rawTitle, rawDate, reason: `Data non valida: "${rawDate}".` });
      continue;
    }

    const parsed = parseNetflixTitleCell(rawTitle);
    if (parsed.error) {
      errors.push({ line, rawTitle, rawDate, reason: parsed.error });
      continue;
    }

    rows.push(buildRow(rawTitle, rawDate, watchedDate, parsed));
  }

  return { rows, errors };
}

module.exports = {
  parseNetflixCsv,
  parseNetflixTitleCell,
  parseNetflixDate,
};
