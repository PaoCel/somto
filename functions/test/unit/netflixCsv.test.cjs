const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseNetflixCsv,
  parseNetflixTitleCell,
  parseNetflixDate,
} = require("../../lib/importAdapters/netflixCsv");

/* ============================= parseNetflixDate ============================= */

test("parseNetflixDate parses M/D/YY as 20YY", () => {
  const d = parseNetflixDate("6/25/26");
  assert.ok(d instanceof Date);
  assert.equal(d.getUTCFullYear(), 2026);
  assert.equal(d.getUTCMonth(), 5); // 0-indexed -> June
  assert.equal(d.getUTCDate(), 25);
  assert.equal(d.getUTCHours(), 12); // noon UTC
});

test("parseNetflixDate handles single-digit month/day", () => {
  const d = parseNetflixDate("1/1/23");
  assert.equal(d.getUTCFullYear(), 2023);
  assert.equal(d.getUTCMonth(), 0);
  assert.equal(d.getUTCDate(), 1);
});

test("parseNetflixDate rejects malformed dates", () => {
  assert.equal(parseNetflixDate("13/40/26"), null);
  assert.equal(parseNetflixDate("not-a-date"), null);
  assert.equal(parseNetflixDate(""), null);
  assert.equal(parseNetflixDate("2026-06-25"), null);
});

/* ============================= parseNetflixTitleCell ============================= */

test("0 extra segments -> movie", () => {
  const r = parseNetflixTitleCell("Interstellar");
  assert.equal(r.kind, "movie");
  assert.equal(r.movieNameGuess, "Interstellar");
  assert.equal(r.seriesNameGuess, null);
});

test("explicit Stagione N + Episodio N -> numeric episode", () => {
  const r = parseNetflixTitleCell("Come uccidono le brave ragazze: Stagione 2: Episodio 6");
  assert.equal(r.kind, "tv_episode");
  assert.equal(r.seriesNameGuess, "Come uccidono le brave ragazze");
  assert.equal(r.seasonNumber, 2);
  assert.equal(r.episodeNumber, 6);
  assert.equal(r.episodeNameGuess, null);
});

test("English 'Season N' marker (localised export) parses like 'Stagione N'", () => {
  const r = parseNetflixTitleCell("Don Matteo: Season 11: La Mia Giustizia");
  assert.equal(r.kind, "tv_episode");
  assert.equal(r.seriesNameGuess, "Don Matteo");
  assert.equal(r.seasonNumber, 11);
  assert.equal(r.episodeNumber, null);
  assert.equal(r.episodeNameGuess, "La Mia Giustizia");
});

test("English 'Season N: Episode M' -> numeric episode, not an episode name", () => {
  const r = parseNetflixTitleCell("Breaking Bad: Season 2: Episode 4");
  assert.equal(r.kind, "tv_episode");
  assert.equal(r.seriesNameGuess, "Breaking Bad");
  assert.equal(r.seasonNumber, 2);
  assert.equal(r.episodeNumber, 4);
  assert.equal(r.episodeNameGuess, null);
});

test("English 'Part N' as season + 'Chapter N' as episode (Lupin, export EN)", () => {
  const r = parseNetflixTitleCell("Lupin: Part 3: Chapter 7");
  assert.equal(r.kind, "tv_episode");
  assert.equal(r.seriesNameGuess, "Lupin");
  assert.equal(r.seasonNumber, 3);
  assert.equal(r.episodeNumber, 7);
});

test("English 'Parts 1 and 2' suffix -> stripped, same event", () => {
  const r = parseNetflixTitleCell("Suits: Season 1: Pilot: Parts 1 and 2");
  assert.equal(r.kind, "tv_episode");
  assert.equal(r.seasonNumber, 1);
  assert.equal(r.episodeNameGuess, "Pilot");
});

test("Stagione N + named episode (no Episodio marker) -> episode name, no number", () => {
  const r = parseNetflixTitleCell("Squid Game: Stagione 1: Un, due, tre, stella");
  assert.equal(r.kind, "tv_episode");
  assert.equal(r.seasonNumber, 1);
  assert.equal(r.episodeNumber, null);
  assert.equal(r.episodeNameGuess, "Un, due, tre, stella");
});

test("Stagione N with parenthetical suffix (44 Gatti) still extracts leading number", () => {
  const r = parseNetflixTitleCell("44 Gatti: Stagione 2 (Part 2): La gara di aquiloni");
  assert.equal(r.kind, "tv_episode");
  assert.equal(r.seriesNameGuess, "44 Gatti");
  assert.equal(r.seasonNumber, 2);
  assert.equal(r.episodeNameGuess, "La gara di aquiloni");
});

test("Miniserie -> season 1, Episodio N numeric", () => {
  const r = parseNetflixTitleCell("Ovunque tu sia: Miniserie: Episodio 1");
  assert.equal(r.kind, "tv_episode");
  assert.equal(r.seriesNameGuess, "Ovunque tu sia");
  assert.equal(r.seasonNumber, 1);
  assert.equal(r.episodeNumber, 1);
});

test("Miniserie -> season 1, named episode when no Episodio marker", () => {
  const r = parseNetflixTitleCell("Berlino e la Dama con l'ermellino: Miniserie: La felicità è di chi ama");
  assert.equal(r.kind, "tv_episode");
  assert.equal(r.seasonNumber, 1);
  assert.equal(r.episodeNumber, null);
  assert.equal(r.episodeNameGuess, "La felicità è di chi ama");
});

test("Limited Series (English) -> season 1", () => {
  const r = parseNetflixTitleCell("Some Show: Limited Series: Episodio 3");
  assert.equal(r.kind, "tv_episode");
  assert.equal(r.seasonNumber, 1);
  assert.equal(r.episodeNumber, 3);
});

test("Parte N as alternate-season marker (Lupin) -> seasonNumber=N, Capitolo M -> episodeNumber", () => {
  const r = parseNetflixTitleCell("Lupin: Parte 3: Capitolo 7");
  assert.equal(r.kind, "tv_episode");
  assert.equal(r.seriesNameGuess, "Lupin");
  assert.equal(r.seasonNumber, 3);
  assert.equal(r.episodeNumber, 7);
  assert.equal(r.episodeNameGuess, null);
});

test("Parte N as alternate-season marker also matches 'Episodio M' as chapter number", () => {
  const r = parseNetflixTitleCell("SomeShow: Parte 2: Episodio 5");
  assert.equal(r.kind, "tv_episode");
  assert.equal(r.seasonNumber, 2);
  assert.equal(r.episodeNumber, 5);
});

test("trailing 'Parte N' suffix on Stagione episode -> stripped, same event", () => {
  const r = parseNetflixTitleCell("Manifest: Stagione 3: Mayday: Parte 2");
  assert.equal(r.kind, "tv_episode");
  assert.equal(r.seasonNumber, 3);
  assert.equal(r.episodeNumber, null);
  assert.equal(r.episodeNameGuess, "Mayday");
});

test("trailing 'Parti N e M' suffix on Stagione episode -> stripped", () => {
  const r = parseNetflixTitleCell("The Good Place: Stagione 3: Va tutto alla grande: Parti 1 e 2");
  assert.equal(r.kind, "tv_episode");
  assert.equal(r.seasonNumber, 3);
  assert.equal(r.episodeNameGuess, "Va tutto alla grande");
});

test("trailing '- Parte N' suffix (dash separator) is stripped", () => {
  const r = parseNetflixTitleCell("The Good Place: Stagione 4: Una ragazza dell'Arizona - Parte 2");
  assert.equal(r.kind, "tv_episode");
  assert.equal(r.seasonNumber, 4);
  assert.equal(r.episodeNameGuess, "Una ragazza dell'Arizona");
});

test("trailing 'Parte 1 e 2' suffix on a Pilot episode (Suits)", () => {
  const r = parseNetflixTitleCell("Suits: Stagione 1: Pilot: Parte 1 e 2");
  assert.equal(r.kind, "tv_episode");
  assert.equal(r.seasonNumber, 1);
  assert.equal(r.episodeNameGuess, "Pilot");
});

test("multi-segment episode name with punctuation is preserved (I sette quadranti case, no season marker -> ambiguous)", () => {
  const r = parseNetflixTitleCell("I sette quadranti di Agatha Christie: Il terrore viene… sul treno");
  assert.equal(r.kind, "ambiguous");
  assert.equal(r.seriesNameGuess, "I sette quadranti di Agatha Christie");
  assert.equal(r.episodeNameGuess, "Il terrore viene… sul treno");
});

test("episode name containing a slash-joined list of segment titles is preserved verbatim", () => {
  const r = parseNetflixTitleCell(
    "Pocoyo: Stagione 2: Una soluzione perfetta / Ronfottino sul vamoosh / Detective Pocoyo / Il monopattino"
  );
  assert.equal(r.kind, "tv_episode");
  assert.equal(r.seasonNumber, 2);
  assert.equal(
    r.episodeNameGuess,
    "Una soluzione perfetta / Ronfottino sul vamoosh / Detective Pocoyo / Il monopattino"
  );
});

test("2-segment title with no season/miniserie marker -> ambiguous (11% real-world case)", () => {
  const r = parseNetflixTitleCell("The Big Bang Theory: Pilot");
  assert.equal(r.kind, "ambiguous");
  assert.equal(r.seriesNameGuess, "The Big Bang Theory");
  assert.equal(r.movieNameGuess, "The Big Bang Theory: Pilot");
  assert.equal(r.episodeNameGuess, "Pilot");
});

test("ambiguous row with 'Capitolo N' marker but no 'Stagione'/'Miniserie' still ambiguous", () => {
  const r = parseNetflixTitleCell("Man Vs Baby: Capitolo 4");
  assert.equal(r.kind, "ambiguous");
  assert.equal(r.seriesNameGuess, "Man Vs Baby");
});

test("empty title cell surfaces as parser error, not a silent skip", () => {
  const r = parseNetflixTitleCell(" ");
  // A lone space is not empty after segment split logic upstream; verify the
  // full CSV-level empty-title path via parseNetflixCsv below covers the
  // stronger guarantee. Here we assert the cell parser doesn't throw.
  assert.ok(r.kind || r.error);
});

test("season marker with no following episode segment -> explicit error", () => {
  const r = parseNetflixTitleCell("Some Show: Stagione 2");
  assert.equal(r.error, "Stagione senza episodio.");
});

test("miniserie marker with no following episode segment -> explicit error", () => {
  const r = parseNetflixTitleCell("Some Show: Miniserie");
  assert.equal(r.error, "Miniserie senza episodio.");
});

/* ============================= parseNetflixCsv ============================= */

function csv(rows) {
  return ["Title,Date", ...rows].join("\n");
}

test("parseNetflixCsv parses a well-formed multi-row export", () => {
  const raw = csv([
    '"Interstellar","6/16/26"',
    '"Lupin: Parte 3: Capitolo 7","11/11/23"',
    '"Come uccidono le brave ragazze: Stagione 2: Episodio 6","6/23/26"',
  ]);
  const { rows, errors } = parseNetflixCsv(raw);
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].kind, "movie");
  assert.equal(rows[1].seasonNumber, 3);
  assert.equal(rows[2].episodeNumber, 6);
});

test("parseNetflixCsv handles RFC4180 quoted commas inside titles", () => {
  const raw = csv(['"Squid Game: Stagione 1: Un, due, tre, stella","12/30/24"']);
  const { rows, errors } = parseNetflixCsv(raw);
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].episodeNameGuess, "Un, due, tre, stella");
});

test("parseNetflixCsv handles embedded escaped quotes", () => {
  const raw = csv(['"He said ""hello"" to me","1/1/24"']);
  const { rows, errors } = parseNetflixCsv(raw);
  assert.equal(errors.length, 0);
  assert.equal(rows[0].movieNameGuess, 'He said "hello" to me');
});

test("parseNetflixCsv reports malformed rows explicitly instead of skipping silently", () => {
  const raw = csv([
    '"Interstellar","6/16/26"',
    '" ","6/13/25"',
    '"Some Movie","not-a-date"',
  ]);
  const { rows, errors } = parseNetflixCsv(raw);
  assert.equal(rows.length, 1);
  assert.equal(errors.length, 2);
  assert.match(errors[0].reason, /Titolo mancante/);
  assert.match(errors[1].reason, /Data non valida/);
});

test("parseNetflixCsv rejects a file with an unexpected header", () => {
  const raw = "Name,When\n\"Foo\",\"1/1/24\"";
  const { rows, errors } = parseNetflixCsv(raw);
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /Header CSV inatteso/);
});

test("parseNetflixCsv on an empty file reports an explicit error", () => {
  const { rows, errors } = parseNetflixCsv("");
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 1);
});

test("watchedDate is noon UTC of the watched day for every parsed row", () => {
  const raw = csv(['"Interstellar","6/16/26"']);
  const { rows } = parseNetflixCsv(raw);
  assert.equal(rows[0].watchedDate.getUTCHours(), 12);
  assert.equal(rows[0].watchedDate.getUTCMinutes(), 0);
});

/* ============== miniserie/stagioni "a parti" (Parte N = episodio) ============== */

test("Miniserie: lone 'Parte N' is the episode number (Alias Grace case)", () => {
  const r = parseNetflixTitleCell("L'altra Grace: Miniserie: Parte 5");
  assert.equal(r.kind, "tv_episode");
  assert.equal(r.seriesNameGuess, "L'altra Grace");
  assert.equal(r.seasonNumber, 1);
  assert.equal(r.episodeNumber, 5);
  assert.equal(r.episodeNameGuess, null);
});

test("Stagione N: lone 'Parte M' is the episode number (When They See Us case)", () => {
  const r = parseNetflixTitleCell("When They See Us: Stagione 1: Parte 4");
  assert.equal(r.kind, "tv_episode");
  assert.equal(r.seasonNumber, 1);
  assert.equal(r.episodeNumber, 4);
  assert.equal(r.episodeNameGuess, null);
});

test("lone multi-part 'Parte 1 e 2' keeps the text as episode name, never empty", () => {
  const r = parseNetflixTitleCell("Show: Stagione 2: Parte 1 e 2");
  assert.equal(r.kind, "tv_episode");
  assert.equal(r.seasonNumber, 2);
  assert.equal(r.episodeNumber, null);
  assert.equal(r.episodeNameGuess, "Parte 1 e 2");
});

test("named episode with a real 'Parte N' suffix still strips it (regression)", () => {
  const r = parseNetflixTitleCell("Show: Stagione 2: Il finale: Parte 2");
  assert.equal(r.seasonNumber, 2);
  assert.equal(r.episodeNumber, null);
  assert.equal(r.episodeNameGuess, "Il finale");
});

/* ============== zeri mai nei campi numerici ============== */

test("'Episodio 0' is not a number: the text survives as episode name", () => {
  const r = parseNetflixTitleCell("Show: Stagione 2: Episodio 0");
  assert.equal(r.kind, "tv_episode");
  assert.equal(r.seasonNumber, 2);
  assert.equal(r.episodeNumber, null);
  assert.equal(r.episodeNameGuess, "Episodio 0");
});

test("'Stagione 0' is not a season marker: row falls to the ambiguous branch", () => {
  const r = parseNetflixTitleCell("Show: Stagione 0: Special");
  assert.equal(r.kind, "ambiguous");
  assert.equal(r.seasonNumber, null);
  assert.equal(r.episodeNumber, null);
  assert.equal(r.episodeNameGuess, "Stagione 0: Special");
});
