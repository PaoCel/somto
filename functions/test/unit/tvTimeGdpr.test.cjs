const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseTvTimeGdprCsvs,
  parseTvTimeMoviesCsv,
  parseTvTimeSeriesCsv,
  parseTvTimeDateTime,
} = require("../../lib/importAdapters/tvTimeGdpr");

/* ============================= parseTvTimeDateTime ============================= */

test("parseTvTimeDateTime parses 'YYYY-MM-DD HH:MM:SS' as noon UTC of that day", () => {
  const d = parseTvTimeDateTime("2026-07-05 18:47:38");
  assert.ok(d instanceof Date);
  assert.equal(d.getUTCFullYear(), 2026);
  assert.equal(d.getUTCMonth(), 6); // 0-indexed -> July
  assert.equal(d.getUTCDate(), 5);
  assert.equal(d.getUTCHours(), 12);
});

test("parseTvTimeDateTime accepts date-only (no time part)", () => {
  const d = parseTvTimeDateTime("2026-05-27");
  assert.ok(d instanceof Date);
  assert.equal(d.getUTCFullYear(), 2026);
  assert.equal(d.getUTCMonth(), 4);
  assert.equal(d.getUTCDate(), 27);
});

test("parseTvTimeDateTime rejects malformed input", () => {
  assert.equal(parseTvTimeDateTime(""), null);
  assert.equal(parseTvTimeDateTime("not-a-date"), null);
  assert.equal(parseTvTimeDateTime("07/05/2026"), null);
  assert.equal(parseTvTimeDateTime("2026-13-40"), null);
});

/* ============================= parseTvTimeMoviesCsv (v1) ============================= */

const MOVIES_HEADER = "user_id,type-uuid-n,watch_count,watches,type,uuid,updated_at,alpha_range_key,movie_name,release_date_range_key,follow_date_range_key,release_date,runtime,created_at,entity_type,total_movies_runtime,country,watch_date_range_key";

test("parseTvTimeMoviesCsv: watch row -> movie, watched, with releaseYear + runtimeMinutes", () => {
  const csv = [
    MOVIES_HEADER,
    '105409833,watch-uuid1-0,,,watch,uuid1,2026-07-05 18:48:28,watch-alpha-interstellar,Interstellar,watch-release-date-2014-11-06,,2014-11-06 00:00:00,10140,2026-07-05 18:48:28,movie,,IT,watch-date-1783277308',
  ].join("\n");
  const { rows, errors } = parseTvTimeMoviesCsv(csv);
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.kind, "movie");
  assert.equal(row.rawTitle, "Interstellar");
  assert.equal(row.movieNameGuess, "Interstellar");
  assert.equal(row.releaseYear, 2014);
  assert.equal(row.runtimeMinutes, 169); // 10140s / 60 = 169
  assert.equal(row.tvtimeUuid, "uuid1");
  assert.equal(row.watchlistOnly, undefined);
  assert.ok(row.watchedDate instanceof Date);
});

test("parseTvTimeMoviesCsv: follow row -> movie, watchlistOnly:true", () => {
  const csv = [
    MOVIES_HEADER,
    '105409833,follow-uuid1-0,,,follow,uuid1,2026-07-05 18:47:38,follow-alpha-backrooms,Backrooms,follow-release-date-2026-05-27,follow-follow-date-1783277258,2026-05-27 00:00:00,6600,2026-07-05 18:47:38,movie,,,',
  ].join("\n");
  const { rows, errors } = parseTvTimeMoviesCsv(csv);
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].watchlistOnly, true);
  assert.equal(rows[0].movieNameGuess, "Backrooms");
  assert.equal(rows[0].runtimeMinutes, 110);
});

test("parseTvTimeMoviesCsv: aggregate rows (count-watch-movie, time-count) are silently ignored, not errors", () => {
  const csv = [
    MOVIES_HEADER,
    '105409833,count-watch-movie,6,[uuid1 uuid2],,,,,,,,,,,,,,',
    '105409833,time-count,,,time-count,,2026-07-05 18:48:28,,,,,,,2026-07-05 18:47:55,,42300,,',
  ].join("\n");
  const { rows, errors } = parseTvTimeMoviesCsv(csv);
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 0);
});

test("parseTvTimeMoviesCsv: missing movie_name is an explicit error, not a silent skip", () => {
  const csv = [
    MOVIES_HEADER,
    '105409833,watch-uuid1-0,,,watch,uuid1,2026-07-05 18:48:28,watch-alpha-x,,watch-release-date-x,,2014-11-06 00:00:00,6000,2026-07-05 18:48:28,movie,,IT,watch-date-x',
  ].join("\n");
  const { rows, errors } = parseTvTimeMoviesCsv(csv);
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /mancante/i);
});

test("parseTvTimeMoviesCsv: invalid date is an explicit error", () => {
  const csv = [
    MOVIES_HEADER,
    '105409833,watch-uuid1-0,,,watch,uuid1,2026-07-05 18:48:28,watch-alpha-x,SomeMovie,watch-release-date-x,,2014-11-06 00:00:00,6000,not-a-date,movie,,IT,watch-date-x',
  ].join("\n");
  const { rows, errors } = parseTvTimeMoviesCsv(csv);
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /Data non valida/);
});

/* --- second real export snapshot: different column order + rewatch_count + towatch --- */

const MOVIES_HEADER_V2 = "type-uuid-n,watch_count,watches,user_id,entity_type,movie_name,uuid,rewatch_count,follow_date_range_key,release_date,created_at,alpha_range_key,updated_at,release_date_range_key,type,total_movies_runtime,runtime,watch_date_range_key,country";

test("parseTvTimeMoviesCsv: resolves rewatch_count by header name even with a totally different column order", () => {
  const csv = [
    MOVIES_HEADER_V2,
    "watch-uuid1-0,,,109813159,movie,Avengers: Endgame,uuid1,3,,2019-04-24 00:00:00,2026-07-05 19:17:02,watch-alpha-x,2026-07-05 19:17:02,watch-release-date-x,watch,,10860,,IT",
  ].join("\n");
  const { rows, errors } = parseTvTimeMoviesCsv(csv);
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].movieNameGuess, "Avengers: Endgame");
  assert.equal(rows[0].rewatchCount, 3);
  assert.equal(rows[0].runtimeMinutes, 181);
});

test("parseTvTimeMoviesCsv: rewatch_count column absent -> rewatchCount is null, not an error", () => {
  // MOVIES_HEADER (first demo) has no rewatch_count column at all.
  const csv = [
    MOVIES_HEADER,
    '105409833,watch-uuid1-0,,,watch,uuid1,2026-07-05 18:48:28,watch-alpha-interstellar,Interstellar,watch-release-date-2014-11-06,,2014-11-06 00:00:00,10140,2026-07-05 18:48:28,movie,,IT,watch-date-1783277308',
  ].join("\n");
  const { rows, errors } = parseTvTimeMoviesCsv(csv);
  assert.equal(errors.length, 0);
  assert.equal(rows[0].rewatchCount, null);
});

test("parseTvTimeMoviesCsv: rewatch_count of 0 normalizes to null (toPositiveIntOrNull semantics)", () => {
  const csv = [
    MOVIES_HEADER_V2,
    "watch-uuid1-0,,,109813159,movie,Deadpool,uuid1,0,,2016-02-09 00:00:00,2026-07-05 19:17:02,watch-alpha-x,2026-07-05 19:17:02,watch-release-date-x,watch,,6480,,IT",
  ].join("\n");
  const { rows } = parseTvTimeMoviesCsv(csv);
  assert.equal(rows[0].rewatchCount, null);
});

test("parseTvTimeMoviesCsv: 'towatch' is an alias for 'follow' (watchlistOnly:true, seen in a later export snapshot)", () => {
  const csv = [
    MOVIES_HEADER_V2,
    "towatch-uuid1-0,,,109813159,movie,Enola Holmes 3,uuid1,0,towatch-follow-date-x,2026-07-01 00:00:00,2026-07-05 19:17:02,towatch-alpha-x,2026-07-05 19:17:02,towatch-release-date-x,towatch,,,,",
  ].join("\n");
  const { rows, errors } = parseTvTimeMoviesCsv(csv);
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].watchlistOnly, true);
  assert.equal(rows[0].movieNameGuess, "Enola Holmes 3");
});

test("parseTvTimeMoviesCsv: unrecognized row type is surfaced as an error", () => {
  const csv = [
    MOVIES_HEADER,
    '105409833,mystery-uuid1-0,,,mystery,uuid1,2026-07-05 18:48:28,,SomeMovie,,,,,2026-07-05 18:48:28,movie,,,',
  ].join("\n");
  const { rows, errors } = parseTvTimeMoviesCsv(csv);
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /non riconosciuto/);
});

test("parseTvTimeMoviesCsv: empty file reports an explicit error", () => {
  const { rows, errors } = parseTvTimeMoviesCsv("");
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 1);
});

test("parseTvTimeMoviesCsv: unexpected header reports an explicit error", () => {
  const { rows, errors } = parseTvTimeMoviesCsv("foo,bar\n1,2");
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /Header/);
});

/* ============================= parseTvTimeSeriesCsv (v2) ============================= */

const SERIES_HEADER = "key,updated_at,user_id,series_follow_count,ep_watch_count,created_at,movie_watch_count,total_movies_runtime,total_series_runtime,is_followed,s_id,followed_at,uuid,is_for_later,is_archived,series_name,most_recent_ep_watched,runtime,is_unitary,ep_id,episode_id,gsi,season_number,s_no,ep_no,episode_number";

test("parseTvTimeSeriesCsv: watch-episode row -> tv_episode with explicit season/episode + tvdbSeriesId + runtimeMinutes", () => {
  const csv = [
    SERIES_HEADER,
    'watch-episode-suuid-euuid,2026-07-05 18:52:11,105409833,,,2026-07-05 18:52:11,,,,,385925,,,,,Avatar: The Last Airbender (2024),,3480,true,7860486,7860486,watch-episode-1783277526,1,1,2,2',
  ].join("\n");
  const { rows, errors } = parseTvTimeSeriesCsv(csv);
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.kind, "tv_episode");
  assert.equal(row.seriesNameGuess, "Avatar: The Last Airbender (2024)");
  assert.equal(row.seasonNumber, 1);
  assert.equal(row.episodeNumber, 2);
  assert.equal(row.tvdbSeriesId, 385925);
  assert.equal(row.runtimeMinutes, 58); // 3480s / 60 = 58
  assert.equal(row.watchlistOnly, undefined);
});

test("parseTvTimeSeriesCsv: user-series row with is_for_later=true -> tv_episode watchlistOnly:true", () => {
  const csv = [
    SERIES_HEADER,
    'user-series-uuid1,2026-07-05 18:47:39,105409833,,0,2026-07-05 18:47:39,,,,true,471105,1783277259326943,uuid1,true,false,Some Show,,,,,,,,,,',
  ].join("\n");
  const { rows, errors } = parseTvTimeSeriesCsv(csv);
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "tv_episode");
  assert.equal(rows[0].watchlistOnly, true);
  assert.equal(rows[0].tvdbSeriesId, 471105);
  assert.equal(rows[0].seasonNumber, null);
});

test("parseTvTimeSeriesCsv: followed user-series with no watched episodes -> watchlistOnly even when is_for_later=false", () => {
  const csv = [
    SERIES_HEADER,
    'user-series-uuid1,2026-07-05 18:47:39,105409833,,0,2026-07-05 18:47:39,,,,true,471105,1783277259326943,uuid1,false,false,Prison Break,,,,,,,,,,',
  ].join("\n");
  const { rows, errors } = parseTvTimeSeriesCsv(csv);
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rawTitle, "Prison Break");
  assert.equal(rows[0].watchlistOnly, true);
  assert.equal(rows[0].tvdbSeriesId, 471105);
});

test("parseTvTimeSeriesCsv: followed user-series with watched sibling episodes does not add watchlist duplicate", () => {
  const csv = [
    SERIES_HEADER,
    'user-series-uuid1,2026-07-05 18:47:39,105409833,,1,2026-07-05 18:47:39,,,,true,385925,1783277259326943,uuid1,false,false,Avatar: The Last Airbender (2024),,,,,,,,,,',
    'watch-episode-suuid-euuid,2026-07-05 18:52:11,105409833,,,2026-07-05 18:52:11,,,,,385925,,,,,Avatar: The Last Airbender (2024),,3480,true,7860486,7860486,watch-episode-1783277526,1,1,2,2',
  ].join("\n");
  const { rows, errors } = parseTvTimeSeriesCsv(csv);
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].watchlistOnly, undefined);
  assert.equal(rows[0].seasonNumber, 1);
  assert.equal(rows[0].episodeNumber, 2);
});

test("parseTvTimeSeriesCsv: followed user-series with missing name but s_id is kept as watchlistOnly placeholder", () => {
  const csv = [
    SERIES_HEADER,
    'user-series-uuid1,2026-07-05 18:47:39,105409833,,0,2026-07-05 18:47:39,,,,true,435400,1690917704981897,uuid1,false,false,,,,,,,,,,,',
  ].join("\n");
  const { rows, errors } = parseTvTimeSeriesCsv(csv);
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rawTitle, "TVDB Series 435400");
  assert.equal(rows[0].seriesNameGuess, "TVDB Series 435400");
  assert.equal(rows[0].watchlistOnly, true);
  assert.equal(rows[0].tvdbSeriesId, 435400);
});

test("parseTvTimeSeriesCsv: tracking-stats aggregate row is silently ignored", () => {
  const csv = [
    SERIES_HEADER,
    'tracking-stats,2026-07-05 18:52:11,105409833,7,5,2026-03-23 21:07:31,0,0,15420,,,,,,,,,,,,,,,,,',
  ].join("\n");
  const { rows, errors } = parseTvTimeSeriesCsv(csv);
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 0);
});

test("parseTvTimeSeriesCsv: most_recent_ep_watched Go map dump is ignored; no sibling episodes falls back to watchlist", () => {
  const csv = [
    SERIES_HEADER,
    'user-series-uuid1,2026-07-05 18:52:05,105409833,,1,2026-03-23 21:07:31,,,,true,450633,1774300051240548,uuid1,false,false,Young Sherlock (2026),map[ep_id:1.0518975e+07 ep_no:1 s_no:1 uuid:d11747b2-af81-4448-b30b-75bc08d3ee30 watch_date:1.783277525345514e+15],,,,,,,,,',
  ].join("\n");
  // The Go-map garbage is not a reliable episode signal; without a sibling
  // watch-episode row, the series is preserved as watchlistOnly.
  const { rows, errors } = parseTvTimeSeriesCsv(csv);
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].watchlistOnly, true);
  assert.equal(rows[0].seasonNumber, null);
  assert.equal(rows[0].episodeNumber, null);
});

test("parseTvTimeSeriesCsv: watch-episode row missing season/episode numbers is an explicit error", () => {
  const csv = [
    SERIES_HEADER,
    'watch-episode-suuid-euuid,2026-07-05 18:52:11,105409833,,,2026-07-05 18:52:11,,,,,385925,,,,,Some Show,,3480,true,7860486,7860486,watch-episode-1783277526,,,,',
  ].join("\n");
  const { rows, extraEpisodes, errors } = parseTvTimeSeriesCsv(csv);
  assert.equal(rows.length, 0);
  assert.equal(extraEpisodes.length, 1);
  assert.equal(extraEpisodes[0].classification, "unnumbered");
  assert.equal(extraEpisodes[0].tvdbEpisodeId, 7860486);
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /stagione\/episodio/i);
});

test("parseTvTimeSeriesCsv: unnamed watched series with s_id stays matchable via TVDB", () => {
  const csv = [
    SERIES_HEADER,
    'watch-episode-suuid-euuid,2026-07-05 18:52:11,105409833,,,2026-07-05 18:52:11,,,,,469187,,,,,,,3360,true,11393732,11393732,watch-episode-1783277526,1,1,1,1',
  ].join("\n");
  const { rows, extraEpisodes, errors } = parseTvTimeSeriesCsv(csv);
  assert.equal(errors.length, 0);
  assert.equal(extraEpisodes.length, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].seriesNameGuess, "TVDB Series 469187");
  assert.equal(rows[0].tvdbSeriesId, 469187);
  assert.equal(rows[0].seasonNumber, 1);
  assert.equal(rows[0].episodeNumber, 1);
});

test("parseTvTimeSeriesCsv: season zero episode is preserved as a special", () => {
  const csv = [
    SERIES_HEADER,
    'watch-episode-suuid-euuid,2026-07-05 18:52:11,105409833,,,2026-07-05 18:52:11,,,,,385925,,,,,Some Show,,1500,true,5744959,5744959,watch-episode-1783277526,0,0,3,3',
  ].join("\n");
  const { rows, extraEpisodes, errors } = parseTvTimeSeriesCsv(csv);
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(extraEpisodes.length, 1);
  assert.equal(extraEpisodes[0].classification, "special");
  assert.equal(extraEpisodes[0].seasonNumber, 0);
  assert.equal(extraEpisodes[0].episodeNumber, 3);
});

test("parseTvTimeSeriesCsv: unrecognized key is surfaced as an error", () => {
  const csv = [
    SERIES_HEADER,
    'mystery-row-xyz,2026-07-05 18:52:11,105409833,,,,,,,,,,,,,SomeShow,,,,,,,,,,',
  ].join("\n");
  const { rows, errors } = parseTvTimeSeriesCsv(csv);
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /non riconosciuta/);
});

test("parseTvTimeSeriesCsv: empty file reports an explicit error", () => {
  const { rows, errors } = parseTvTimeSeriesCsv("");
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 1);
});

/* ============================= parseTvTimeGdprCsvs (merged) ============================= */

test("parseTvTimeGdprCsvs merges movies + series rows and concatenates errors", () => {
  const moviesCsv = [
    MOVIES_HEADER,
    '105409833,watch-uuid1-0,,,watch,uuid1,2026-07-05 18:48:28,watch-alpha-interstellar,Interstellar,watch-release-date-2014-11-06,,2014-11-06 00:00:00,10140,2026-07-05 18:48:28,movie,,IT,watch-date-1783277308',
  ].join("\n");
  const seriesCsv = [
    SERIES_HEADER,
    'watch-episode-suuid-euuid,2026-07-05 18:52:11,105409833,,,2026-07-05 18:52:11,,,,,385925,,,,,The Bear,,2100,true,8442804,8442804,watch-episode-1783277528,1,1,1,1',
  ].join("\n");
  const { rows, errors } = parseTvTimeGdprCsvs({ moviesCsv, seriesCsv });
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((r) => r.kind === "movie").length, 1);
  assert.equal(rows.filter((r) => r.kind === "tv_episode").length, 1);
});

test("parseTvTimeGdprCsvs tolerates missing/empty CSV strings without throwing", () => {
  const { rows, errors } = parseTvTimeGdprCsvs({});
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 2); // both "file vuoto"
});
