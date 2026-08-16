"use strict";

// Pure Letterboxd CSV adapter. No Firestore, Storage or network access lives
// here: the operational script owns ZIP validation and boxd.it -> TMDB
// enrichment. This module reads the user's own reviews (reviews.csv) but
// deliberately ignores comments/profile, likes, tags, deleted and orphaned
// content.

const { parseCsv } = require("./csv");

const PARSER_VERSION = 2;

// Somto caps reviewText at 5000 chars (firestore.rules, iOS submitRating,
// PWA upsertRating). Letterboxd has no cap, so long reviews are rejected
// rather than silently truncated.
const MAX_REVIEW_LENGTH = 5000;

const FILE_HEADERS = Object.freeze({
  "watched.csv": ["Date", "Name", "Year", "Letterboxd URI"],
  "ratings.csv": ["Date", "Name", "Year", "Letterboxd URI", "Rating"],
  "diary.csv": ["Date", "Name", "Year", "Letterboxd URI", "Rating", "Rewatch", "Tags", "Watched Date"],
  "watchlist.csv": ["Date", "Name", "Year", "Letterboxd URI"],
  "reviews.csv": ["Date", "Name", "Year", "Letterboxd URI", "Rating", "Rewatch", "Review", "Watched Date"],
});

function safeString(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizeIdentityName(value) {
  return safeString(value, 500)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ");
}

function identityKey(name, year) {
  return `${normalizeIdentityName(name)}\u0000${String(year || "")}`;
}

function parseYear(value, context) {
  const raw = safeString(value, 8);
  if (!/^\d{4}$/.test(raw)) throw new Error(`${context}: anno non valido`);
  const year = Number(raw);
  if (year < 1870 || year > 2200) throw new Error(`${context}: anno fuori intervallo`);
  return year;
}

// Date-only source values become noon UTC. Noon avoids date shifts when a
// Firestore Timestamp is rendered in time zones west/east of UTC.
function parseDateOnly(value, context) {
  const raw = safeString(value, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error(`${context}: data non valida`);
  const date = new Date(`${raw}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) {
    throw new Error(`${context}: data impossibile`);
  }
  return date;
}

function parseLetterboxdUri(value, context) {
  const raw = safeString(value, 300);
  let url;
  try { url = new URL(raw); } catch { throw new Error(`${context}: URL Letterboxd non valido`); }
  const code = url.pathname.replace(/^\/+|\/+$/g, "");
  if (
    url.protocol !== "https:"
    || url.hostname !== "boxd.it"
    || url.port
    || url.username
    || url.password
    || url.search
    || url.hash
    || !/^[A-Za-z0-9]{1,16}$/.test(code)
  ) {
    throw new Error(`${context}: URL Letterboxd non ammesso`);
  }
  return `https://boxd.it/${code}`;
}

function parseRating(value, context, { optional = false } = {}) {
  const raw = safeString(value, 12);
  if (!raw && optional) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0.5 || n > 5 || Math.round(n * 2) !== n * 2) {
    throw new Error(`${context}: voto Letterboxd non valido`);
  }
  return n * 2;
}

// Review bodies are free text: normalize line endings, collapse runs of blank
// lines and drop control characters, then keep the rest verbatim.
function normalizeReviewText(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// One Somto rating holds one reviewText, so a film reviewed more than once
// (rewatch) keeps the most recent entry; ties go to the longer text.
function pickPrimaryReview(entries) {
  return [...entries].sort((a, b) => (
    (b.watchedDate - a.watchedDate)
    || (b.loggedDate - a.loggedDate)
    || (b.text.length - a.text.length)
  ))[0] || null;
}

function parseFile(name, rawText, { required = false } = {}) {
  const raw = String(rawText ?? "");
  if (!raw.trim()) {
    if (required) throw new Error(`${name}: file obbligatorio assente o vuoto`);
    return [];
  }
  const table = parseCsv(raw.replace(/^\uFEFF/, ""));
  if (table.length === 0) {
    if (required) throw new Error(`${name}: CSV vuoto`);
    return [];
  }
  const header = table[0].map((cell) => safeString(cell, 100));
  if (new Set(header).size !== header.length) throw new Error(`${name}: header duplicato`);
  for (const expected of FILE_HEADERS[name]) {
    if (!header.includes(expected)) throw new Error(`${name}: colonna obbligatoria mancante: ${expected}`);
  }
  const index = new Map(header.map((column, i) => [column, i]));
  return table.slice(1).map((record, rowIndex) => {
    if (record.length !== header.length) throw new Error(`${name}: riga ${rowIndex + 2} malformata`);
    return Object.fromEntries(header.map((column) => [column, record[index.get(column)] ?? ""]));
  });
}

function mergeCanonicalRow(registry, row, source, rowIndex) {
  const context = `${source}: riga ${rowIndex + 2}`;
  const uri = parseLetterboxdUri(row["Letterboxd URI"], context);
  const name = safeString(row.Name, 500);
  if (!name) throw new Error(`${context}: titolo vuoto`);
  const year = parseYear(row.Year, context);
  const current = registry.get(uri);
  if (current && (current.name !== name || current.year !== year)) {
    throw new Error(`${context}: lo stesso URL identifica titoli diversi`);
  }
  const film = current || {
    letterboxdUri: uri,
    name,
    year,
    identityKey: identityKey(name, year),
    watchedSourceDate: null,
    rating: null,
    ratingDate: null,
    watchlistDate: null,
    diaryEntries: [],
    reviewEntries: [],
  };
  registry.set(uri, film);
  return film;
}

function earliestDate(values) {
  return values.filter(Boolean).reduce((min, value) => (!min || value < min ? value : min), null);
}

function diaryMinimumRuns(entries) {
  if (!entries.length) return 1;
  const sorted = [...entries].sort((a, b) => a.watchedDate - b.watchedDate || a.loggedDate - b.loggedDate);
  return sorted.length + (sorted[0].rewatch ? 1 : 0);
}

function parseLetterboxdCsvBundle(files = {}) {
  const watched = parseFile("watched.csv", files["watched.csv"], { required: true });
  const ratings = parseFile("ratings.csv", files["ratings.csv"]);
  const diary = parseFile("diary.csv", files["diary.csv"]);
  const watchlist = parseFile("watchlist.csv", files["watchlist.csv"]);
  const reviews = parseFile("reviews.csv", files["reviews.csv"]);
  const registry = new Map();

  watched.forEach((row, i) => {
    const film = mergeCanonicalRow(registry, row, "watched.csv", i);
    film.watchedSourceDate = parseDateOnly(row.Date, `watched.csv: riga ${i + 2}`);
  });

  ratings.forEach((row, i) => {
    const film = mergeCanonicalRow(registry, row, "ratings.csv", i);
    const context = `ratings.csv: riga ${i + 2}`;
    film.rating = parseRating(row.Rating, context);
    film.ratingDate = parseDateOnly(row.Date, context);
  });

  watchlist.forEach((row, i) => {
    const film = mergeCanonicalRow(registry, row, "watchlist.csv", i);
    film.watchlistDate = parseDateOnly(row.Date, `watchlist.csv: riga ${i + 2}`);
  });

  const byIdentity = new Map();
  for (const film of registry.values()) {
    if (!byIdentity.has(film.identityKey)) byIdentity.set(film.identityKey, []);
    byIdentity.get(film.identityKey).push(film);
  }

  const unlinkedDiary = [];
  const ambiguousDiary = [];
  diary.forEach((row, i) => {
    const context = `diary.csv: riga ${i + 2}`;
    const name = safeString(row.Name, 500);
    if (!name) throw new Error(`${context}: titolo vuoto`);
    const year = parseYear(row.Year, context);
    // Validate but do not retain the activity URI: it identifies the user's
    // diary/review page, not the canonical film.
    parseLetterboxdUri(row["Letterboxd URI"], context);
    const candidates = byIdentity.get(identityKey(name, year)) || [];
    const entry = {
      loggedDate: parseDateOnly(row.Date, context),
      watchedDate: parseDateOnly(row["Watched Date"], context),
      rewatch: safeString(row.Rewatch, 20).toLocaleLowerCase("en-US") === "yes",
      rating: parseRating(row.Rating, context, { optional: true }),
    };
    if (candidates.length === 1) candidates[0].diaryEntries.push(entry);
    else if (candidates.length === 0) unlinkedDiary.push({ name, year });
    else ambiguousDiary.push({ name, year, candidateCount: candidates.length });
  });

  // reviews.csv carries the diary columns plus the review body. Rows link to
  // the canonical film by name+year like diary rows do: their URI points at
  // the review page, not the film. A review that cannot be linked, is empty
  // or exceeds Somto's reviewText cap is reported and skipped — never a hard
  // failure, since watched/ratings/watchlist must import regardless.
  const unlinkedReviews = [];
  const ambiguousReviews = [];
  const oversizedReviews = [];
  reviews.forEach((row, i) => {
    const context = `reviews.csv: riga ${i + 2}`;
    const name = safeString(row.Name, 500);
    if (!name) throw new Error(`${context}: titolo vuoto`);
    const year = parseYear(row.Year, context);
    parseLetterboxdUri(row["Letterboxd URI"], context);
    const text = normalizeReviewText(row.Review);
    if (!text) return;
    if (text.length > MAX_REVIEW_LENGTH) {
      oversizedReviews.push({ name, year, length: text.length });
      return;
    }
    const candidates = byIdentity.get(identityKey(name, year)) || [];
    const entry = {
      text,
      loggedDate: parseDateOnly(row.Date, context),
      watchedDate: parseDateOnly(safeString(row["Watched Date"], 20) || row.Date, context),
      rewatch: safeString(row.Rewatch, 20).toLocaleLowerCase("en-US") === "yes",
      rating: parseRating(row.Rating, context, { optional: true }),
    };
    if (candidates.length === 1) candidates[0].reviewEntries.push(entry);
    else if (candidates.length === 0) unlinkedReviews.push({ name, year });
    else ambiguousReviews.push({ name, year, candidateCount: candidates.length });
  });

  const films = Array.from(registry.values()).map((film) => {
    const diaryWatchedDate = earliestDate(film.diaryEntries.map((entry) => entry.watchedDate));
    const watched = Boolean(film.watchedSourceDate || film.ratingDate || film.diaryEntries.length);
    const watchedDate = diaryWatchedDate || film.watchedSourceDate || film.ratingDate || film.watchlistDate;
    const minimumRuns = watched ? diaryMinimumRuns(film.diaryEntries) : 0;
    const primaryReview = pickPrimaryReview(film.reviewEntries);
    return {
      letterboxdUri: film.letterboxdUri,
      name: film.name,
      year: film.year,
      watched,
      watchedDate,
      watchlist: Boolean(film.watchlistDate),
      watchlistDate: film.watchlistDate,
      rating: film.rating,
      ratingDate: film.ratingDate,
      diaryEntryCount: film.diaryEntries.length,
      rewatchCount: Math.max(0, minimumRuns - 1),
      reviewText: primaryReview?.text || null,
      reviewedAt: primaryReview?.watchedDate || null,
      reviewLoggedAt: primaryReview?.loggedDate || null,
      reviewRating: primaryReview?.rating ?? null,
      reviewEntryCount: film.reviewEntries.length,
    };
  }).sort((a, b) => a.letterboxdUri.localeCompare(b.letterboxdUri));

  const rows = films.map((film) => ({
    rawTitle: film.name,
    kind: "movie",
    seriesNameGuess: null,
    movieNameGuess: film.name,
    seasonNumber: null,
    episodeNumber: null,
    episodeNameGuess: null,
    watchedDate: film.watchedDate,
    releaseYear: film.year,
    runtimeMinutes: null,
    rewatchCount: film.rewatchCount || null,
    letterboxdUri: film.letterboxdUri,
    ...(film.watched ? {} : { watchlistOnly: true }),
  }));

  const ratingIntents = films.filter((film) => film.rating != null).map((film) => ({
    letterboxdUri: film.letterboxdUri,
    name: film.name,
    year: film.year,
    rating: film.rating,
    ratedAt: film.ratingDate,
  }));

  const reviewIntents = films.filter((film) => film.reviewText).map((film) => ({
    letterboxdUri: film.letterboxdUri,
    name: film.name,
    year: film.year,
    text: film.reviewText,
    reviewedAt: film.reviewedAt,
    reviewLoggedAt: film.reviewLoggedAt,
    rating: film.reviewRating,
    droppedEntries: Math.max(0, film.reviewEntryCount - 1),
  }));

  return {
    parserVersion: PARSER_VERSION,
    films,
    rows,
    ratingIntents,
    reviewIntents,
    unlinkedDiary,
    ambiguousDiary,
    unlinkedReviews,
    ambiguousReviews,
    oversizedReviews,
    summary: {
      watchedRows: watched.length,
      ratingRows: ratings.length,
      diaryRows: diary.length,
      watchlistRows: watchlist.length,
      distinctFilms: films.length,
      watchedFilms: films.filter((film) => film.watched).length,
      ratedFilms: ratingIntents.length,
      watchlistSourceFilms: films.filter((film) => film.watchlist).length,
      effectiveWatchlistFilms: films.filter((film) => !film.watched && film.watchlist).length,
      rewatchedFilms: films.filter((film) => film.rewatchCount > 0).length,
      unlinkedDiaryRows: unlinkedDiary.length,
      ambiguousDiaryRows: ambiguousDiary.length,
      reviewRows: reviews.length,
      reviewedFilms: reviewIntents.length,
      droppedExtraReviews: reviewIntents.reduce((total, intent) => total + intent.droppedEntries, 0),
      unlinkedReviewRows: unlinkedReviews.length,
      ambiguousReviewRows: ambiguousReviews.length,
      oversizedReviewRows: oversizedReviews.length,
    },
  };
}

module.exports = {
  PARSER_VERSION,
  MAX_REVIEW_LENGTH,
  FILE_HEADERS,
  parseDateOnly,
  parseLetterboxdUri,
  parseRating,
  parseLetterboxdCsvBundle,
};
