"use strict";

// Wraps `buildNextTitleState` (functions/lib/titleStates.js) to derive the
// title-state writes for an imported viewing history, WITHOUT reinventing
// the minutes/progress calculation. This module only:
//   - groups matched rows by titleId
//   - picks the right action (mark_movie_seen / set_series_progress /
//     mark_series_completed) per title
//   - takes the max(existing, derived) for episode/season progress so a
//     re-import (or an import that covers less ground than what's already
//     tracked) can never regress progress or inflate minutes
//   - overwrites `seenAt` on movies with the CSV-derived watch date (the
//     shared function stamps `now`; the import wants the historical date)
//
// It NEVER touches ratings and NEVER retroactively lowers progress.

const { buildNextTitleState, estimateTitleTotals, computeWatchMinutesContribution } = require("../titleStates");

function toPositiveInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

function importRewatchOptions(options = {}) {
  return {
    countDuplicateRewatches: options.countDuplicateRewatches !== false,
    countExistingAsRewatch: Boolean(options.countExistingAsRewatch),
  };
}

function importActionSource(options = {}) {
  const source = String(options.source || "netflix_csv").trim().toLowerCase();
  return `import_${source.replace(/[^a-z0-9_]+/g, "_") || "netflix_csv"}`;
}

function earliestDate(dates) {
  return dates.reduce((min, d) => (!min || d < min ? d : min), null);
}

// Netflix's "Viewing history" CSV export logs one row per CALENDAR DAY a
// title was watched (Title,Date — date only, no time-of-day). A single
// viewing that spans midnight (watched half a movie at 23:50, finished at
// 00:10 the next day) produces TWO date rows for the same movie — that is
// NOT a rewatch. Netflix does not log per-session start/stop, so we can't
// distinguish "resumed the same sitting" from "watched again weeks later"
// by date alone. As a deliberate, conservative proxy: rows less than
// REWATCH_GAP_DAYS apart are treated as the SAME viewing (clustered
// together); a gap of REWATCH_GAP_DAYS or more starts a new viewing/rewatch.
// This trades some false negatives (a genuine same-week rewatch might not
// count) for avoiding false positives (pause/resume never inflates counts),
// which matches the "never inflate minutes" guarantee the rest of this
// module already upholds for re-imports.
const REWATCH_GAP_DAYS = 7;
const REWATCH_GAP_MS = REWATCH_GAP_DAYS * 24 * 60 * 60 * 1000;

// Given a list of Date values (may be unsorted, may contain duplicates),
// returns the number of distinct "viewing clusters" — consecutive dates
// less than REWATCH_GAP_MS apart collapse into a single cluster.
function countDateClusters(dates) {
  const valid = dates.filter(Boolean).map((d) => d.getTime()).sort((a, b) => a - b);
  if (valid.length === 0) return 0;
  let clusters = 1;
  for (let i = 1; i < valid.length; i += 1) {
    if (valid[i] - valid[i - 1] >= REWATCH_GAP_MS) {
      clusters += 1;
    }
  }
  return clusters;
}

function targetCompletedCountFromCsvEvents(currentState, csvCompletedRuns, options = {}) {
  const opts = importRewatchOptions(options);
  const currentCount = toPositiveInt(currentState?.completedCount);
  const normalizedCsvRuns = Math.max(1, toPositiveInt(csvCompletedRuns));
  if (!opts.countDuplicateRewatches) {
    return Math.max(currentCount, 1);
  }
  const existingBonus = opts.countExistingAsRewatch && currentCount > 0 ? 1 : 0;
  return Math.max(currentCount, normalizedCsvRuns + existingBonus);
}

function recomputeMinutes(title, state, completedCount) {
  const next = { ...state, completedCount };
  next.watchMinutesContribution = computeWatchMinutesContribution(title, next);
  return next;
}

function rowEpisodeKey(row) {
  const season = toPositiveInt(row?.seasonNumber);
  const episode = toPositiveInt(row?.episodeNumber);
  return season > 0 && episode > 0 ? `${season}:${episode}` : null;
}

// Canonical form of a Netflix episode NAME for distinct-episode counting:
// trimmed, lowercased, whitespace collapsed. Two rows that differ only by
// casing/spacing (or a re-watch of the same episode on another day) collapse
// to one key so they aren't miscounted as two episodes.
function normalizeEpisodeName(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Number of distinct completed runs through the whole series implied by the
// CSV: for every known episode, cluster its watch dates (see
// countDateClusters) so a same-sitting resume doesn't look like a rewatch,
// then take the MINIMUM cluster count across all episodes — a full rewatch
// requires every episode to have been watched again, so the least-repeated
// episode is the bottleneck.
// Explicit per-episode rewatch runs from a TV Time export (Refract only):
// watched_count is the total number of views of the episode, rewatch_count
// the extra views beyond the first. Either implies how many full passes
// through this episode happened. 0 when the source carries no such signal
// (Netflix, TV Time GDPR episodes) — the caller then relies on date-clusters.
function episodeExplicitRuns(row) {
  const watched = toPositiveInt(row?.watchedCount);
  const rewatch = toPositiveInt(row?.rewatchCount);
  return Math.max(watched, rewatch > 0 ? rewatch + 1 : 0);
}

function csvCompletedRunsForSeries(rows, totalEpisodeCount) {
  const total = toPositiveInt(totalEpisodeCount);
  if (!total) return 1;
  // Per episode: keep both the watch dates AND the explicit rewatch count.
  // Refract emits a single row (one watched_at) per episode, so date-cluster
  // rewatch detection is blind to replays — the explicit count is the only
  // signal there; GDPR/Netflix have the dates but no count. Take the max of
  // the two per episode, then the MIN across episodes (a full series rewatch
  // requires every episode watched again — the least-repeated episode caps it).
  const byEpisode = new Map();
  for (const row of rows) {
    const key = rowEpisodeKey(row);
    if (!key) continue;
    if (!byEpisode.has(key)) byEpisode.set(key, { dates: [], explicitRuns: 0 });
    const entry = byEpisode.get(key);
    if (row.watchedDate) entry.dates.push(row.watchedDate);
    entry.explicitRuns = Math.max(entry.explicitRuns, episodeExplicitRuns(row));
  }
  if (byEpisode.size < total) return 1;
  let minRuns = Infinity;
  byEpisode.forEach(({ dates, explicitRuns }) => {
    minRuns = Math.min(minRuns, Math.max(countDateClusters(dates), explicitRuns, 1));
  });
  return Number.isFinite(minRuns) ? Math.max(1, minRuns) : 1;
}

/**
 * Groups resolved+matched rows by titleId, separating movies from series.
 * `matchedRows` = Array<{ titleId, title (doc data), row (NormalizedRow) }>.
 */
function groupMatchedRows(matchedRows) {
  const byTitleId = new Map();
  for (const entry of matchedRows) {
    if (!entry?.titleId) continue;
    if (!byTitleId.has(entry.titleId)) {
      byTitleId.set(entry.titleId, { title: entry.title, rows: [] });
    }
    byTitleId.get(entry.titleId).rows.push(entry.row);
  }
  return byTitleId;
}

/**
 * Builds the next title-state doc for a movie import: mark_movie_seen, then
 * stamp seenAt with the CSV watch date (earliest occurrence, in case of
 * duplicate rows) rather than "now". Never regresses a state that's already
 * further along (e.g. already rated) — buildNextTitleState's own
 * mark_movie_seen action already upgrades unseen->seen_unrated without
 * touching an existing rating, so this is safe to call unconditionally on
 * re-import (idempotent: same csvDate in, same seenAt out).
 */
function buildMovieImportState(currentState, title, rows, options = {}) {
  const now = options.now || new Date();
  const csvDate = earliestDate(rows.map((r) => r.watchedDate).filter(Boolean)) || now;
  const source = importActionSource(options);

  const next = buildNextTitleState(currentState, {
    type: "mark_movie_seen",
    source,
  }, title, { now });

  // Per spec: seenAt chosen manually is NOT overwritten if the state was
  // already "seen" (movie already watched before the import ran) —
  // buildNextTitleState's mark_movie_seen action always stamps seenAt=now,
  // so we must restore the prior value ourselves. Only stamp the CSV date
  // when this import is what caused the seen transition (row was previously
  // unseen), or when there was no prior seenAt at all.
  const wasAlreadySeen = Boolean(currentState?.seenAt) &&
    (currentState?.state === "seen_unrated" || currentState?.state === "rated");
  next.seenAt = wasAlreadySeen ? currentState.seenAt : csvDate;

  // Distinct rewatches implied by the CSV: cluster the watch dates (see
  // countDateClusters) instead of using the raw row count, so a movie
  // resumed across a day boundary (2 date rows, 1 real viewing) is not
  // miscounted as a rewatch.
  const csvViewingClusters = countDateClusters(rows.map((r) => r.watchedDate));
  // TV Time (only) supplies an EXPLICIT `rewatchCount` per movie (extra
  // views beyond the first) — a more direct signal than date-clustering
  // when present. rewatchCount N means N rewatches on top of the first
  // viewing, i.e. N+1 total completed runs. Take the max against the
  // date-cluster estimate: either signal can under-count (date clustering
  // collapses same-week rewatches by design; rewatchCount could be stale on
  // an old export), so the higher of the two is the safer floor — never
  // regress, same principle as targetCompletedCountFromCsvEvents itself.
  const rewatchCountSignal = rows.reduce((max, r) => {
    const n = Number(r?.rewatchCount);
    return Number.isFinite(n) && n > 0 ? Math.max(max, n + 1) : max;
  }, 0);
  const csvCompletedRuns = Math.max(csvViewingClusters, rewatchCountSignal);
  const targetCompletedCount = targetCompletedCountFromCsvEvents(currentState, csvCompletedRuns, options);
  if (targetCompletedCount !== toPositiveInt(next.completedCount)) {
    return recomputeMinutes(title, next, targetCompletedCount);
  }

  return next;
}

/**
 * Builds the next title-state doc for a series import: aggregates all rows
 * for the series to a maxSeason/maxEpisode watermark, then takes
 * Math.max(existing, derived) episode count before calling
 * set_series_progress — buildNextTitleState/buildInProgressSeriesState treat
 * `set_series_progress` progress numbers as authoritative explicit values
 * (no max-with-existing on their own), so the max must happen here.
 *
 * If the derived progress covers the full known series (maxSeason >=
 * totalSeasonCount, or per-season episode math reaches totalEpisodeCount),
 * uses mark_series_completed instead so the state lands on
 * completed_unrated/rated rather than a numerically-full in_progress.
 */
function buildSeriesImportState(currentState, title, rows, options = {}) {
  const now = options.now || new Date();
  const source = importActionSource(options);
  const totals = estimateTitleTotals(title);

  // Letterboxd registra film e limited/TV series come titoli interi, non
  // espone gli episodi. Quando il resolver TMDB conferma che il titolo è TV,
  // `wholeTitleCompleted` è quindi un segnale esplicito di completamento,
  // diverso dalle righe episodiche ambigue degli altri import.
  const wholeTitleRows = rows.filter((row) => row?.wholeTitleCompleted === true);
  if (wholeTitleRows.length) {
    const next = buildNextTitleState(currentState, {
      type: "mark_series_completed",
      source,
    }, title, { now });
    const dateRuns = countDateClusters(wholeTitleRows.map((row) => row.watchedDate));
    const explicitRuns = wholeTitleRows.reduce((max, row) => {
      const rewatches = toPositiveInt(row?.rewatchCount);
      return Math.max(max, rewatches + 1);
    }, 1);
    const targetCompletedCount = targetCompletedCountFromCsvEvents(
      currentState,
      Math.max(dateRuns, explicitRuns),
      options
    );
    return targetCompletedCount === toPositiveInt(next.completedCount)
      ? next
      : recomputeMinutes(title, next, targetCompletedCount);
  }

  // Highest season explicitly present, and — within that season — the
  // highest explicit episode number seen. Rows without an episode number
  // (name-only episodes) still bump the season watermark but can't
  // contribute an exact episode count for that season.
  let maxSeason = 0;
  let maxEpisodeInMaxSeason = 0;
  let sawNamedEpisodeWithoutNumber = false;

  for (const row of rows) {
    const season = toPositiveInt(row.seasonNumber);
    if (season <= 0) continue;
    if (season > maxSeason) {
      maxSeason = season;
      maxEpisodeInMaxSeason = 0;
      sawNamedEpisodeWithoutNumber = false;
    }
    if (season === maxSeason) {
      const ep = toPositiveInt(row.episodeNumber);
      if (ep > 0) {
        maxEpisodeInMaxSeason = Math.max(maxEpisodeInMaxSeason, ep);
      } else {
        sawNamedEpisodeWithoutNumber = true;
      }
    }
  }

  const episodesPerSeason = toPositiveInt(totals.episodesPerSeason);

  // Everything derived from season NUMBERS below assumes the source numbers
  // its seasons the way our catalog (TMDB) does. TV Time splits long-running
  // anime into arcs and numbers them as seasons: Dragon Ball Super is ONE TMDB
  // season of 131 episodes, but the export labels the watched episodes
  // "season 4". A maxSeason above the catalog's season count is proof the two
  // numberings disagree — "3 full prior seasons" would then credit 393
  // episodes never watched, and the season-completeness check below would
  // declare the whole series done. Observed live (Francesco, import
  // JBdHrjjX5g5Izd6GmLm5): 24 episodes watched, 131 credited, 3013 minutes.
  //
  // When the numbering disagrees we drop every season-derived signal and keep
  // only the DISTINCT episode count, which is exact whenever the export lists
  // episodes individually (it always does for TV Time).
  const totalSeasonCountForCheck = toPositiveInt(totals.totalSeasonCount);
  const seasonNumberingLooksCompatible = totalSeasonCountForCheck === 0
    || maxSeason <= totalSeasonCountForCheck;

  // Derived episodesWatchedCount watermark: full prior seasons (season-1)
  // worth of episodes, plus the max episode number reached in the current
  // season. When we only have episode NAMES (no numbers) for the top season,
  // we can't derive an exact per-episode count — fall back to crediting the
  // prior seasons only, and let the season-name rows at least advance
  // lastWatchedSeasonNumber via the season completeness check below.
  let derivedEpisodes = 0;
  if (!seasonNumberingLooksCompatible) {
    derivedEpisodes = 0;
  } else if (episodesPerSeason > 0) {
    derivedEpisodes = Math.max(0, maxSeason - 1) * episodesPerSeason + maxEpisodeInMaxSeason;
  } else {
    derivedEpisodes = maxEpisodeInMaxSeason;
  }

  const existingProgress = currentState?.seriesProgress || {};
  const existingEpisodes = toPositiveInt(existingProgress.episodesWatchedCount);
  const existingSeasons = toPositiveInt(existingProgress.seasonsCompletedCount);

  // Explicit per-episode imports (TV Time GDPR) give one row per watched
  // episode with an exact season+episode — count the DISTINCT episodes
  // directly. The linear watermark above assumes CONTIGUOUS viewing and
  // catastrophically undercounts a sampler who watched scattered episodes
  // across many seasons; worse, when TMDB's episodes-per-season is unknown
  // it collapses to a single episode number (e.g. Doraemon: 1163 episodes
  // watched -> watermark 10). The distinct count can only be the true number
  // of episodes actually watched, so it is a safe floor.
  //
  // Netflix's Italian "Viewing history" export labels episodes by NAME, not
  // "Episodio N" (~97% of TV rows: "Squid Game: Stagione 1: Un, due, tre,
  // stella"), so episodeNumber is null for almost every series row. Without
  // counting the named episodes, derivedEpisodes/explicit both collapse to 0
  // and a fully-watched series lands as `in_progress` at 0 episodes ("episodio
  // zero"). Each DISTINCT (season, episodeName) is still exactly one watched
  // episode, so it belongs in the same distinct-count floor as numbered rows.
  const explicitEpisodeKeys = new Set();
  for (const row of rows) {
    const s = toPositiveInt(row.seasonNumber);
    const e = toPositiveInt(row.episodeNumber);
    if (e > 0) {
      // TV Time Refract può emettere numeri di episodio SENZA stagione: sono
      // comunque episodi distinti (chiave season-agnostica, stesso principio
      // delle righe con solo nome). Senza, una serie interamente vista così
      // restava a 0 episodi ("in corso a zero" sul profilo).
      explicitEpisodeKeys.add(s > 0 ? `${s}e${e}` : `?e${e}`);
      continue;
    }
    const name = normalizeEpisodeName(row.episodeNameGuess);
    if (!name) continue;
    // Single-season Netflix shows aren't labelled "Stagione N" in the export
    // ("Spinning Out: Due per 40 dollari") — the parser can't assign a season,
    // so seasonNumber is null. The row is still a resolved episode of THIS
    // series (mediaType is tv here), so its distinct name counts. Key it
    // season-agnostically when the season is unknown.
    explicitEpisodeKeys.add(s > 0 ? `${s}n:${name}` : `n:${name}`);
  }
  const explicitEpisodeCount = explicitEpisodeKeys.size;

  // Math.max(existing, derived, explicit) — never regress. `explicit` is the
  // authoritative count when the export lists episodes individually;
  // `derived` still wins when contiguous viewing implies episodes the export
  // didn't enumerate row-by-row.
  const nextEpisodes = Math.max(existingEpisodes, derivedEpisodes, explicitEpisodeCount);
  // Same reasoning as derivedEpisodes: an arc number ("season 4" of a
  // one-season series) says nothing about how many real seasons are done.
  const derivedSeasonsCompleted = !seasonNumberingLooksCompatible
    ? 0
    : sawNamedEpisodeWithoutNumber
      ? Math.max(0, maxSeason - 1)
      : maxSeason;
  const nextSeasonsCompleted = Math.max(existingSeasons, derivedSeasonsCompleted);

  const totalEpisodeCount = toPositiveInt(totals.totalEpisodeCount);
  const totalSeasonCount = toPositiveInt(totals.totalSeasonCount);
  const reachedFullSeries = Boolean(
    (totalEpisodeCount > 0 && nextEpisodes >= totalEpisodeCount) ||
    (totalSeasonCount > 0 && seasonNumberingLooksCompatible
      && nextSeasonsCompleted >= totalSeasonCount && !sawNamedEpisodeWithoutNumber)
  );

  if (reachedFullSeries) {
    const next = buildNextTitleState(currentState, {
      type: "mark_series_completed",
      source,
    }, title, { now });
    const csvRuns = csvCompletedRunsForSeries(rows, totalEpisodeCount);
    const targetCompletedCount = targetCompletedCountFromCsvEvents(currentState, csvRuns, options);
    if (targetCompletedCount !== toPositiveInt(next.completedCount)) {
      return recomputeMinutes(title, next, targetCompletedCount);
    }
    return next;
  }

  // Zero segnale contabile (righe TV senza numeri né nomi episodio): mai
  // fabbricare una serie "in corso a 0 episodi" — è il nonsense "episodio
  // zero" che finisce sul profilo. Il titolo resta/va in "da vedere":
  // toggle_watchlist è un no-op se la serie è già iniziata, quindi non
  // regredisce mai uno stato esistente.
  if (nextEpisodes === 0 && nextSeasonsCompleted === 0) {
    return buildNextTitleState(currentState, {
      type: "toggle_watchlist",
      enabled: true,
      source,
    }, title, { now });
  }

  const lastRow = rows.reduce((latest, r) => (
    !latest || (r.watchedDate && r.watchedDate > latest.watchedDate) ? r : latest
  ), null);

  const lastWatchedSeasonNumber = toPositiveInt(lastRow?.seasonNumber) || maxSeason || null;
  const next = buildNextTitleState(currentState, {
    type: "set_series_progress",
    source,
    episodesWatchedCount: nextEpisodes,
    seasonsCompletedCount: nextSeasonsCompleted,
    lastWatchedSeasonNumber,
    // Un numero di episodio senza stagione non individua nulla ("E12" di
    // quale stagione?): meglio null, il badge cade sul percento.
    lastWatchedEpisodeNumber: lastWatchedSeasonNumber
      ? (toPositiveInt(lastRow?.episodeNumber) || null)
      : null,
  }, title, { now });

  return next;
}

/**
 * Top-level entry point: given matchedRows (grouped by titleId, each with
 * the title doc + its NormalizedRow[]), and a map of current title-state
 * docs (titleId -> current state or null), returns the next-state doc for
 * each titleId. Callers persist these via a batched Firestore write.
 */
function buildImportTitleStateWrites(matchedRows, currentStatesByTitleId, options = {}) {
  const now = options.now || new Date();
  const grouped = groupMatchedRows(matchedRows);
  const writes = [];

  for (const [titleId, { title, rows }] of grouped.entries()) {
    const currentState = currentStatesByTitleId.get(titleId) || null;
    const titleForState = { ...(title || {}), id: titleId };
    const mediaType = titleForState?.type === "tv" || titleForState?.meta?.mediaType === "tv" ? "tv" : "movie";

    let next;
    if (mediaType === "tv") {
      // Righe kind "movie" abbinate a un titolo TV non portano nessuna
      // coordinata episodio e sono quasi sempre un mis-match del matching
      // (caso reale: film "My Fault" → anime WataMote via fallback AniList,
      // 28 serie "in corso a 0 episodi" su prod). Meglio NESSUNO stato che
      // una serie fabbricata sul profilo; le righe restano negli items,
      // riparabili se il match era giusto.
      const episodeRows = rows.filter((row) => row?.kind !== "movie" || row?.wholeTitleCompleted === true);
      if (!episodeRows.length) continue;
      next = buildSeriesImportState(currentState, titleForState, episodeRows, { ...options, now });
    } else {
      next = buildMovieImportState(currentState, titleForState, rows, { ...options, now });
    }

    writes.push({ titleId, next, rowCount: rows.length });
  }

  return writes;
}

module.exports = {
  groupMatchedRows,
  buildMovieImportState,
  buildSeriesImportState,
  buildImportTitleStateWrites,
  countDateClusters,
  REWATCH_GAP_DAYS,
};
