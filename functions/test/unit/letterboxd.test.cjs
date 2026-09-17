"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseDateOnly,
  parseLetterboxdUri,
  parseRating,
  parseLetterboxdCsvBundle,
} = require("../../lib/importAdapters/letterboxd");

const watched = [
  "Date,Name,Year,Letterboxd URI",
  "2025-01-02,Film A,2020,https://boxd.it/a1",
  "2025-02-02,Film B,2021,https://boxd.it/b22",
  "2025-03-02,Film C,2022,https://boxd.it/c333",
].join("\r\n") + "\r\n";

const ratings = [
  "Date,Name,Year,Letterboxd URI,Rating",
  "2025-01-03,Film A,2020,https://boxd.it/a1,4.5",
  "2025-02-03,Film B,2021,https://boxd.it/b22,3",
].join("\r\n") + "\r\n";

const diary = [
  "Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date",
  "2025-01-02,Film A,2020,https://boxd.it/log001,4.5,,,2025-01-01",
  "2025-04-02,Film A,2020,https://boxd.it/log002,4.5,Yes,,2025-04-01",
  "2025-02-02,Film B,2021,https://boxd.it/log003,3,Yes,,2025-02-01",
].join("\r\n") + "\r\n";

const watchlist = [
  "Date,Name,Year,Letterboxd URI",
  "2025-01-01,Film A,2020,https://boxd.it/a1",
  "2025-05-01,Film D,2023,https://boxd.it/d444",
].join("\r\n") + "\r\n";

test("normalizza cronologia, rating, overlap watchlist e rewatch", () => {
  const out = parseLetterboxdCsvBundle({
    "watched.csv": watched,
    "ratings.csv": ratings,
    "diary.csv": diary,
    "watchlist.csv": watchlist,
  });

  assert.deepEqual(out.summary, {
    watchedRows: 3,
    ratingRows: 2,
    diaryRows: 3,
    watchlistRows: 2,
    distinctFilms: 4,
    watchedFilms: 3,
    ratedFilms: 2,
    watchlistSourceFilms: 2,
    effectiveWatchlistFilms: 1,
    rewatchedFilms: 2,
    unlinkedDiaryRows: 0,
    ambiguousDiaryRows: 0,
    reviewRows: 0,
    reviewedFilms: 0,
    droppedExtraReviews: 0,
    unlinkedReviewRows: 0,
    ambiguousReviewRows: 0,
    oversizedReviewRows: 0,
  });
  const filmA = out.films.find((film) => film.name === "Film A");
  const filmB = out.films.find((film) => film.name === "Film B");
  const filmD = out.films.find((film) => film.name === "Film D");
  assert.equal(filmA.watchedDate.toISOString(), "2025-01-01T12:00:00.000Z");
  assert.equal(filmA.rewatchCount, 1);
  assert.equal(filmB.rewatchCount, 1, "Yes su una sola riga implica almeno due visioni");
  assert.equal(filmD.watched, false);
  assert.equal(out.rows.find((row) => row.rawTitle === "Film D").watchlistOnly, true);
  assert.deepEqual(out.ratingIntents.map((row) => row.rating), [9, 6]);
});

test("un rating senza watched viene comunque trattato come visto", () => {
  const out = parseLetterboxdCsvBundle({
    "watched.csv": "Date,Name,Year,Letterboxd URI\r\n",
    "ratings.csv": "Date,Name,Year,Letterboxd URI,Rating\r\n2025-01-01,Rated only,2024,https://boxd.it/ro1,5\r\n",
  });
  assert.equal(out.summary.watchedFilms, 1);
  assert.equal(out.rows[0].watchlistOnly, undefined);
  assert.equal(out.rows[0].watchedDate.toISOString(), "2025-01-01T12:00:00.000Z");
});

test("diary usa URL attività ma si collega al film per identità", () => {
  const out = parseLetterboxdCsvBundle({
    "watched.csv": watched,
    "diary.csv": "Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\r\n2025-01-02,Film A,2020,https://boxd.it/abcdef,4,,,2025-01-01\r\n",
  });
  assert.equal(out.unlinkedDiary.length, 0);
  assert.equal(out.films.find((film) => film.name === "Film A").diaryEntryCount, 1);
});

test("rifiuta URI, date e rating fuori contratto", () => {
  assert.throws(() => parseLetterboxdUri("http://boxd.it/a1", "x"), /non ammesso/);
  assert.throws(() => parseLetterboxdUri("https://boxd.it.evil/a1", "x"), /non ammesso/);
  assert.throws(() => parseLetterboxdUri("https://user@boxd.it/a1", "x"), /non ammesso/);
  assert.throws(() => parseDateOnly("2025-02-30", "x"), /impossibile/);
  assert.throws(() => parseRating("4.2", "x"), /non valido/);
  assert.equal(parseRating("0.5", "x"), 1);
  assert.equal(parseRating("5", "x"), 10);
});

test("rifiuta header mancanti, duplicati e righe malformate", () => {
  assert.throws(() => parseLetterboxdCsvBundle({
    "watched.csv": "Date,Name,Year\r\n2025-01-01,X,2020\r\n",
  }), /colonna obbligatoria mancante/);
  assert.throws(() => parseLetterboxdCsvBundle({
    "watched.csv": "Date,Name,Year,Letterboxd URI,Name\r\n",
  }), /header duplicato/);
  assert.throws(() => parseLetterboxdCsvBundle({
    "watched.csv": "Date,Name,Year,Letterboxd URI\r\n2025-01-01,X,2020\r\n",
  }), /malformata/);
});

const reviewHeader = "Date,Name,Year,Letterboxd URI,Rating,Rewatch,Review,Tags,Watched Date";

test("le recensioni si collegano al film per identità e tengono la più recente", () => {
  const out = parseLetterboxdCsvBundle({
    "watched.csv": watched,
    "ratings.csv": ratings,
    "reviews.csv": [
      reviewHeader,
      "2025-01-02,Film A,2020,https://boxd.it/rev001,4.5,,Prima visione,,2025-01-01",
      "2025-04-02,Film A,2020,https://boxd.it/rev002,4.5,Yes,Rivisto e regge,,2025-04-01",
      "2025-02-02,Film B,2021,https://boxd.it/rev003,3,,\"Riga uno\r\n\r\n\r\nRiga due\",,2025-02-01",
    ].join("\r\n") + "\r\n",
  });

  assert.equal(out.summary.reviewRows, 3);
  assert.equal(out.summary.reviewedFilms, 2);
  assert.equal(out.summary.droppedExtraReviews, 1);
  const filmA = out.films.find((film) => film.name === "Film A");
  assert.equal(filmA.reviewText, "Rivisto e regge");
  assert.equal(filmA.reviewedAt.toISOString(), "2025-04-01T12:00:00.000Z");
  assert.equal(filmA.reviewEntryCount, 2);
  const intentB = out.reviewIntents.find((intent) => intent.name === "Film B");
  assert.equal(intentB.text, "Riga uno\n\nRiga due", "righe vuote di troppo collassate");
  assert.equal(intentB.rating, 6);
});

test("recensioni vuote, troppo lunghe o non collegabili non entrano", () => {
  const out = parseLetterboxdCsvBundle({
    "watched.csv": watched,
    "reviews.csv": [
      reviewHeader,
      "2025-01-02,Film A,2020,https://boxd.it/rev010,,,   ,,2025-01-01",
      `2025-01-02,Film B,2021,https://boxd.it/rev011,,,${"x".repeat(5001)},,2025-01-01`,
      "2025-01-02,Mai visto,1999,https://boxd.it/rev012,,,Testo orfano,,2025-01-01",
    ].join("\r\n") + "\r\n",
  });

  assert.equal(out.reviewIntents.length, 0);
  assert.equal(out.summary.oversizedReviewRows, 1);
  assert.equal(out.summary.unlinkedReviewRows, 1);
  assert.deepEqual(out.unlinkedReviews, [{ name: "Mai visto", year: 1999 }]);
});

test("se Name+Year è ambiguo la recensione non viene associata", () => {
  const out = parseLetterboxdCsvBundle({
    "watched.csv": [
      "Date,Name,Year,Letterboxd URI",
      "2025-01-01,Same,2020,https://boxd.it/s1",
      "2025-01-01,Same,2020,https://boxd.it/s2",
    ].join("\r\n") + "\r\n",
    "reviews.csv": `${reviewHeader}\r\n2025-01-02,Same,2020,https://boxd.it/rev999,4,,Testo,,2025-01-01\r\n`,
  });
  assert.equal(out.ambiguousReviews.length, 1);
  assert.equal(out.reviewIntents.length, 0);
});

test("se Name+Year è ambiguo il diary non viene associato", () => {
  const out = parseLetterboxdCsvBundle({
    "watched.csv": [
      "Date,Name,Year,Letterboxd URI",
      "2025-01-01,Same,2020,https://boxd.it/s1",
      "2025-01-01,Same,2020,https://boxd.it/s2",
    ].join("\r\n") + "\r\n",
    "diary.csv": "Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\r\n2025-01-02,Same,2020,https://boxd.it/log999,4,,,2025-01-01\r\n",
  });
  assert.equal(out.ambiguousDiary.length, 1);
  assert.equal(out.films.every((film) => film.diaryEntryCount === 0), true);
});
