"use strict";

const TITLE_STATE_SCHEMA_VERSION = 4;

function safeString(value, maxLen = 200) {
  return String(value ?? "").slice(0, maxLen);
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function toPositiveInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

function toNullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normalizeMediaType(value) {
  return String(value || "").trim().toLowerCase() === "tv" ? "tv" : "movie";
}

function normalizeMovieState(value) {
  const state = String(value || "").trim().toLowerCase();
  return ["unseen", "seen_unrated", "rated"].includes(state) ? state : "unseen";
}

function normalizeSeriesState(value) {
  const state = String(value || "").trim().toLowerCase();
  return ["not_started", "in_progress", "completed_unrated", "rated"].includes(state)
    ? state
    : "not_started";
}

function isCompletedState(stateData) {
  const mediaType = normalizeMediaType(stateData?.mediaType);
  const state = String(stateData?.state || "").trim().toLowerCase();
  return mediaType === "movie"
    ? (state === "seen_unrated" || state === "rated")
    : (state === "completed_unrated" || state === "rated");
}

function hasStartedWatching(stateData) {
  const mediaType = normalizeMediaType(stateData?.mediaType);
  const state = String(stateData?.state || "").trim().toLowerCase();
  return mediaType === "movie"
    ? (state === "seen_unrated" || state === "rated")
    : (state === "in_progress" || state === "completed_unrated" || state === "rated");
}

function isAwaitingRating(stateData) {
  const mediaType = normalizeMediaType(stateData?.mediaType);
  const state = String(stateData?.state || "").trim().toLowerCase();
  return mediaType === "movie" ? state === "seen_unrated" : state === "completed_unrated";
}

function seasonRowsFromMeta(meta) {
  const rows = safeArray(meta?.seasons)
    .map((row) => ({
      season: toPositiveInt(row?.season || row?.season_number),
      episodes: toPositiveInt(row?.episodes || row?.episode_count),
    }))
    .filter((row) => row.season > 0);

  return rows.sort((a, b) => a.season - b.season);
}

function uniformEpisodesPerSeason(rows) {
  if (!rows.length) return 0;
  const first = toPositiveInt(rows[0]?.episodes);
  if (!first) return 0;
  return rows.every((row) => toPositiveInt(row?.episodes) === first) ? first : 0;
}

function estimateTitleTotals(title) {
  const titleData = asObject(title);
  const meta = asObject(titleData.meta);
  const mediaType = normalizeMediaType(titleData.type || meta.mediaType || "movie");
  const seasons = seasonRowsFromMeta(meta);
  const totalSeasonCount = toPositiveInt(meta.seasonsCount) || seasons.length || 0;
  const uniformEpisodes = uniformEpisodesPerSeason(seasons);
  const episodesPerSeason = toPositiveInt(meta.episodesPerSeason) || uniformEpisodes || 0;
  const totalEpisodeCount = seasons.length
    ? seasons.reduce((sum, row) => sum + toPositiveInt(row.episodes), 0)
    : (totalSeasonCount && episodesPerSeason ? totalSeasonCount * episodesPerSeason : 0);

  return {
    mediaType,
    durationMovie: toPositiveInt(meta.durationMovie || titleData.durationMinutes),
    durationEpisode: toPositiveInt(meta.durationEpisode || (mediaType === "tv" ? titleData.durationMinutes : 0)),
    totalSeasonCount: totalSeasonCount || null,
    episodesPerSeason: episodesPerSeason || null,
    totalEpisodeCount: totalEpisodeCount || null,
    seasons,
  };
}

function computePercent(progress, totals) {
  const watchedEpisodes = toPositiveInt(progress?.episodesWatchedCount);
  const completedSeasons = toPositiveInt(progress?.seasonsCompletedCount);
  if (toPositiveInt(totals?.totalEpisodeCount) > 0) {
    return clamp(watchedEpisodes / totals.totalEpisodeCount, 0, 1);
  }
  if (toPositiveInt(totals?.totalSeasonCount) > 0) {
    return clamp(completedSeasons / totals.totalSeasonCount, 0, 1);
  }
  return watchedEpisodes > 0 || completedSeasons > 0 ? null : 0;
}

function buildTitleSnapshot(titleId, title, mediaType, previous = null) {
  const prev = asObject(previous);
  const titleData = asObject(title);
  return {
    titleId,
    name: safeString(titleData.name || prev.name || "Titolo", 180) || "Titolo",
    posterPath: safeString(titleData.posterPath || prev.posterPath || "", 500) || null,
    mediaType,
  };
}

function defaultSeriesProgress(totals) {
  return {
    episodesWatchedCount: 0,
    seasonsCompletedCount: 0,
    totalEpisodeCount: totals.totalEpisodeCount,
    totalSeasonCount: totals.totalSeasonCount,
    lastWatchedEpisodeId: null,
    lastWatchedEpisodeName: null,
    lastWatchedSeasonNumber: null,
    lastWatchedEpisodeNumber: null,
    lastWatchedAt: null,
    percentComplete: computePercent({
      episodesWatchedCount: 0,
      seasonsCompletedCount: 0,
    }, totals),
  };
}

function normalizeSeriesProgress(progress, totals) {
  const base = asObject(progress);
  const normalized = {
    episodesWatchedCount: toPositiveInt(base.episodesWatchedCount),
    seasonsCompletedCount: toPositiveInt(base.seasonsCompletedCount),
    totalEpisodeCount: toPositiveInt(base.totalEpisodeCount) || totals.totalEpisodeCount,
    totalSeasonCount: toPositiveInt(base.totalSeasonCount) || totals.totalSeasonCount,
    lastWatchedEpisodeId: safeString(base.lastWatchedEpisodeId || "", 120) || null,
    lastWatchedEpisodeName: safeString(base.lastWatchedEpisodeName || "", 180) || null,
    lastWatchedSeasonNumber: toPositiveInt(base.lastWatchedSeasonNumber) || null,
    lastWatchedEpisodeNumber: toPositiveInt(base.lastWatchedEpisodeNumber) || null,
    lastWatchedAt: base.lastWatchedAt || null,
    percentComplete: null,
  };

  if (normalized.totalEpisodeCount) {
    normalized.episodesWatchedCount = Math.min(normalized.totalEpisodeCount, normalized.episodesWatchedCount);
  }
  if (normalized.totalSeasonCount) {
    normalized.seasonsCompletedCount = Math.min(normalized.totalSeasonCount, normalized.seasonsCompletedCount);
  }

  normalized.percentComplete = computePercent(normalized, totals);
  return normalized;
}

function buildReminderHintsData(stateData) {
  const state = String(stateData?.state || "").trim().toLowerCase();
  const mediaType = normalizeMediaType(stateData?.mediaType);
  const generalWatchlist = Boolean(stateData?.generalWatchlist);
  const progress = asObject(stateData?.seriesProgress);
  const lastProgressAt = progress.lastWatchedAt || stateData?.completedAt || stateData?.seenAt || stateData?.updatedAt || null;
  const ratingReminderEligible = !Boolean(stateData?.hasTitleRating) && isAwaitingRating(stateData);
  const resumeReminderEligible = mediaType === "tv" && generalWatchlist && state === "in_progress";
  return {
    ratingReminderEligible,
    resumeReminderEligible,
    lastProgressAt,
    suggestedReminderAt: null,
  };
}

function hasNewContentVsSnapshot(stateData, totals) {
  const snapshotEpisodes = toPositiveInt(stateData?.completedAtTotalEpisodes);
  const currentEpisodes = toPositiveInt(totals?.totalEpisodeCount);
  if (snapshotEpisodes && currentEpisodes && currentEpisodes > snapshotEpisodes) return true;
  const snapshotSeasons = toPositiveInt(stateData?.completedAtTotalSeasons);
  const currentSeasons = toPositiveInt(totals?.totalSeasonCount);
  if (snapshotSeasons && currentSeasons && currentSeasons > snapshotSeasons) return true;
  return false;
}

function snapshotCompletedTotals(currentState, totals) {
  const fallbackEpisodes = toPositiveInt(currentState?.completedAtTotalEpisodes);
  const fallbackSeasons = toPositiveInt(currentState?.completedAtTotalSeasons);
  return {
    completedAtTotalEpisodes: toPositiveInt(totals?.totalEpisodeCount) || fallbackEpisodes || null,
    completedAtTotalSeasons: toPositiveInt(totals?.totalSeasonCount) || fallbackSeasons || null,
  };
}

function normalizeStateForTitle(currentState, title, options = {}) {
  const now = options.now || new Date();
  const stateData = asObject(currentState);
  const titleData = asObject(title);
  const mediaType = normalizeMediaType(titleData.type || stateData.mediaType || titleData?.meta?.mediaType || "movie");
  const titleId = safeString(stateData.titleId || titleData.id || stateData.id || "", 200);
  const totals = estimateTitleTotals({ ...titleData, type: mediaType });
  const baseState = mediaType === "movie"
    ? normalizeMovieState(stateData.state)
    : normalizeSeriesState(stateData.state);
  const hasTitleRating = Boolean(stateData.hasTitleRating) || toNullableNumber(stateData.ratingValue) != null || baseState === "rated";
  let completedCount = toPositiveInt(stateData.completedCount);
  if (!completedCount) {
    // Legacy fallback for docs predating `completedCount`. `seenAt` implies a
    // full run only for movies: on series it's stamped at the FIRST episode,
    // so an in_progress series must not be credited with a completed run
    // (computeWatchMinutesContribution would add a full-run worth of minutes
    // on every progress update). `completedAt` is only ever set by a real
    // completion, so it stays a valid signal for both media types.
    const legacyRunSignal = mediaType === "movie"
      ? Boolean(stateData.seenAt || stateData.completedAt)
      : Boolean(stateData.completedAt);
    if (isCompletedState({ mediaType, state: baseState }) || legacyRunSignal) {
      completedCount = 1;
    }
  }

  let seriesProgress = null;
  if (mediaType === "tv") {
    seriesProgress = normalizeSeriesProgress(
      stateData.seriesProgress || defaultSeriesProgress(totals),
      totals
    );
    if (baseState === "rated" || baseState === "completed_unrated") {
      seriesProgress = {
        ...seriesProgress,
        episodesWatchedCount: totals.totalEpisodeCount || seriesProgress.episodesWatchedCount,
        seasonsCompletedCount: totals.totalSeasonCount || seriesProgress.seasonsCompletedCount,
        totalEpisodeCount: totals.totalEpisodeCount || seriesProgress.totalEpisodeCount,
        totalSeasonCount: totals.totalSeasonCount || seriesProgress.totalSeasonCount,
        lastWatchedSeasonNumber: totals.totalSeasonCount || seriesProgress.lastWatchedSeasonNumber,
        lastWatchedEpisodeNumber: totals.episodesPerSeason || seriesProgress.lastWatchedEpisodeNumber,
        percentComplete: 1,
      };
    }
  }

  const normalized = {
    titleId,
    mediaType,
    state: baseState,
    generalWatchlist: Boolean(stateData.generalWatchlist),
    rewatchIntent: Boolean(stateData.rewatchIntent),
    hasTitleRating,
    ratingValue: toNullableNumber(stateData.ratingValue),
    seenAt: stateData.seenAt || null,
    completedAt: stateData.completedAt || null,
    ratedAt: stateData.ratedAt || null,
    rewatchAddedAt: stateData.rewatchAddedAt || null,
    createdAt: stateData.createdAt || now,
    updatedAt: stateData.updatedAt || now,
    lastInteractionAt: stateData.lastInteractionAt || stateData.updatedAt || now,
    source: safeString(stateData.source || options.source || "", 80) || null,
    seriesProgress,
    titleSnapshot: buildTitleSnapshot(titleId, titleData, mediaType, stateData.titleSnapshot),
    completedCount,
    completedAtTotalEpisodes: toPositiveInt(stateData.completedAtTotalEpisodes) || null,
    completedAtTotalSeasons: toPositiveInt(stateData.completedAtTotalSeasons) || null,
    hasNewContent: Boolean(stateData.hasNewContent),
    latestSeasonNumber: toPositiveInt(stateData.latestSeasonNumber) || null,
    latestSeasonAirDate: stateData.latestSeasonAirDate || null,
    newContentDetectedAt: stateData.newContentDetectedAt || null,
    watchMinutesContribution: toPositiveInt(stateData.watchMinutesContribution),
    schemaVersion: TITLE_STATE_SCHEMA_VERSION,
  };

  normalized.watchMinutesContribution = computeWatchMinutesContribution(titleData, normalized);
  normalized.reminders = buildReminderHintsData(normalized);
  return normalized;
}

function currentRunCompletedCount(nextState) {
  return toPositiveInt(nextState?.completedCount);
}

function computeWatchMinutesContribution(title, state) {
  const titleData = asObject(title);
  const rawState = asObject(state);
  const normalized = {
    mediaType: normalizeMediaType(rawState.mediaType || titleData.type || titleData?.meta?.mediaType || "movie"),
    state: normalizeMediaType(rawState.mediaType || titleData.type || titleData?.meta?.mediaType || "movie") === "tv"
      ? normalizeSeriesState(rawState.state)
      : normalizeMovieState(rawState.state),
    completedCount: toPositiveInt(rawState.completedCount),
    seriesProgress: asObject(rawState.seriesProgress),
    completedAtTotalEpisodes: toPositiveInt(rawState.completedAtTotalEpisodes),
  };
  if (!normalized.completedCount && isCompletedState(normalized)) {
    normalized.completedCount = 1;
  }
  const totals = estimateTitleTotals(titleData);

  if (normalized.mediaType === "movie") {
    if (!totals.durationMovie) return 0;
    return totals.durationMovie * currentRunCompletedCount(normalized);
  }

  const durationEpisode = toPositiveInt(totals.durationEpisode);
  if (!durationEpisode) return 0;

  const completedRuns = toPositiveInt(normalized.completedCount);
  // Use historical snapshot if present so new TMDB seasons don't retroactively inflate minutes.
  const fullRunEpisodes = toPositiveInt(normalized.completedAtTotalEpisodes) || toPositiveInt(totals.totalEpisodeCount);
  const fullRunMinutes = fullRunEpisodes ? fullRunEpisodes * durationEpisode : 0;
  const progressEpisodes = toPositiveInt(normalized.seriesProgress?.episodesWatchedCount);

  if (normalized.state === "in_progress") {
    const completedMinutes = fullRunMinutes ? completedRuns * fullRunMinutes : 0;
    return completedMinutes + (progressEpisodes * durationEpisode);
  }

  if (isCompletedState(normalized)) {
    return fullRunMinutes ? completedRuns * fullRunMinutes : 0;
  }

  return 0;
}

function nextCompletedCount(currentState, completingNow) {
  const currentCount = toPositiveInt(currentState?.completedCount);
  if (!completingNow) return currentCount;
  if (currentCount <= 0) return 1;
  return currentState?.rewatchIntent ? currentCount + 1 : currentCount;
}

function buildEpisodeIdentity(seasonNumber, episodeNumber) {
  if (!toPositiveInt(seasonNumber) || !toPositiveInt(episodeNumber)) {
    return { lastWatchedEpisodeId: null, lastWatchedEpisodeName: null };
  }
  return {
    lastWatchedEpisodeId: `s${seasonNumber}e${episodeNumber}`,
    lastWatchedEpisodeName: `S${seasonNumber} · E${episodeNumber}`,
  };
}

function buildCompletedSeriesProgress(currentProgress, totals, now) {
  const progress = normalizeSeriesProgress(currentProgress, totals);
  return {
    ...progress,
    episodesWatchedCount: totals.totalEpisodeCount || progress.episodesWatchedCount,
    seasonsCompletedCount: totals.totalSeasonCount || progress.seasonsCompletedCount,
    totalEpisodeCount: totals.totalEpisodeCount || progress.totalEpisodeCount,
    totalSeasonCount: totals.totalSeasonCount || progress.totalSeasonCount,
    lastWatchedSeasonNumber: totals.totalSeasonCount || progress.lastWatchedSeasonNumber,
    lastWatchedEpisodeNumber: totals.episodesPerSeason || progress.lastWatchedEpisodeNumber,
    lastWatchedAt: now,
    percentComplete: 1,
  };
}

function shouldRestartSeriesForRewatch(currentState) {
  return normalizeMediaType(currentState?.mediaType) === "tv"
    && toPositiveInt(currentState?.completedCount) > 0
    && Boolean(currentState?.rewatchIntent)
    && currentState?.state !== "in_progress";
}

function shouldCatchUpFromCompletion(currentState, totals) {
  return normalizeMediaType(currentState?.mediaType) === "tv"
    && isCompletedState(currentState)
    && !currentState?.rewatchIntent
    && hasNewContentVsSnapshot(currentState, totals);
}

function catchUpSeriesProgress(currentState, totals) {
  const snapshotEpisodes = toPositiveInt(currentState?.completedAtTotalEpisodes);
  const snapshotSeasons = toPositiveInt(currentState?.completedAtTotalSeasons);
  return {
    episodesWatchedCount: snapshotEpisodes || 0,
    seasonsCompletedCount: snapshotSeasons || 0,
    totalEpisodeCount: totals.totalEpisodeCount,
    totalSeasonCount: totals.totalSeasonCount,
    lastWatchedEpisodeId: null,
    lastWatchedEpisodeName: null,
    lastWatchedSeasonNumber: snapshotSeasons || null,
    lastWatchedEpisodeNumber: null,
    lastWatchedAt: null,
    percentComplete: computePercent({
      episodesWatchedCount: snapshotEpisodes || 0,
      seasonsCompletedCount: snapshotSeasons || 0,
    }, totals),
  };
}

function buildInProgressSeriesState(currentState, action, title, options = {}) {
  const now = options.now || new Date();
  const current = normalizeStateForTitle(currentState, title, { now, source: action?.source });
  const totals = estimateTitleTotals(title);
  const restarting = shouldRestartSeriesForRewatch(current);
  const catchingUp = !restarting && shouldCatchUpFromCompletion(current, totals);
  let baseProgress;
  if (restarting) {
    baseProgress = defaultSeriesProgress(totals);
  } else if (catchingUp) {
    baseProgress = catchUpSeriesProgress(current, totals);
  } else {
    baseProgress = normalizeSeriesProgress(current.seriesProgress, totals);
  }
  const next = { ...current };
  let progress = { ...baseProgress };

  if (action.type === "mark_series_episode") {
    const nextEpisodes = Math.max(1, progress.episodesWatchedCount + 1);
    progress.episodesWatchedCount = totals.totalEpisodeCount
      ? Math.min(totals.totalEpisodeCount, nextEpisodes)
      : nextEpisodes;
    if (totals.episodesPerSeason) {
      progress.seasonsCompletedCount = Math.max(
        progress.seasonsCompletedCount,
        Math.floor(progress.episodesWatchedCount / totals.episodesPerSeason)
      );
    }
    const lastSeasonNumber = totals.episodesPerSeason
      ? Math.max(1, Math.ceil(progress.episodesWatchedCount / totals.episodesPerSeason))
      : progress.lastWatchedSeasonNumber;
    const lastEpisodeNumber = totals.episodesPerSeason
      ? Math.max(1, ((progress.episodesWatchedCount - 1) % totals.episodesPerSeason) + 1)
      : progress.episodesWatchedCount;
    progress.lastWatchedSeasonNumber = lastSeasonNumber || null;
    progress.lastWatchedEpisodeNumber = lastEpisodeNumber || null;
    Object.assign(progress, buildEpisodeIdentity(lastSeasonNumber, lastEpisodeNumber));
  } else if (action.type === "mark_series_season") {
    const nextSeasons = Math.max(1, progress.seasonsCompletedCount + 1);
    progress.seasonsCompletedCount = totals.totalSeasonCount
      ? Math.min(totals.totalSeasonCount, nextSeasons)
      : nextSeasons;
    if (totals.episodesPerSeason) {
      progress.episodesWatchedCount = Math.max(
        progress.episodesWatchedCount,
        progress.seasonsCompletedCount * totals.episodesPerSeason
      );
      if (totals.totalEpisodeCount) {
        progress.episodesWatchedCount = Math.min(totals.totalEpisodeCount, progress.episodesWatchedCount);
      }
    }
    const lastSeasonNumber = progress.seasonsCompletedCount || null;
    const lastEpisodeNumber = totals.episodesPerSeason || null;
    progress.lastWatchedSeasonNumber = lastSeasonNumber;
    progress.lastWatchedEpisodeNumber = lastEpisodeNumber;
    Object.assign(progress, buildEpisodeIdentity(lastSeasonNumber, lastEpisodeNumber));
  } else {
    const explicitEpisodes = toPositiveInt(action.episodesWatchedCount);
    const explicitSeasons = toPositiveInt(action.seasonsCompletedCount);
    progress.episodesWatchedCount = totals.totalEpisodeCount
      ? Math.min(totals.totalEpisodeCount, explicitEpisodes)
      : explicitEpisodes;
    progress.seasonsCompletedCount = totals.totalSeasonCount
      ? Math.min(totals.totalSeasonCount, explicitSeasons)
      : explicitSeasons;
    progress.lastWatchedSeasonNumber = toPositiveInt(action.lastWatchedSeasonNumber) || null;
    progress.lastWatchedEpisodeNumber = toPositiveInt(action.lastWatchedEpisodeNumber) || null;
    Object.assign(progress, buildEpisodeIdentity(progress.lastWatchedSeasonNumber, progress.lastWatchedEpisodeNumber));
  }

  progress.totalEpisodeCount = totals.totalEpisodeCount || progress.totalEpisodeCount;
  progress.totalSeasonCount = totals.totalSeasonCount || progress.totalSeasonCount;
  progress.lastWatchedAt = now;
  progress.percentComplete = computePercent(progress, totals);

  const reachedEpisodeEnd = totals.totalEpisodeCount && progress.episodesWatchedCount >= totals.totalEpisodeCount;
  const reachedSeasonEnd = totals.totalSeasonCount && progress.seasonsCompletedCount >= totals.totalSeasonCount;
  const completed = Boolean(reachedEpisodeEnd || reachedSeasonEnd);

  // A series in progress stays in the "da vedere" watchlist: only clear
  // generalWatchlist on actual completion. `next` inherited current.generalWatchlist
  // via { ...current }, so leave it untouched while !completed.
  next.seenAt = current.seenAt || now;
  next.seriesProgress = completed
    ? buildCompletedSeriesProgress(progress, totals, now)
    : progress;
  next.completedCount = nextCompletedCount(current, completed);
  next.completedAt = completed ? now : current.completedAt || null;
  next.state = completed
    ? (current.hasTitleRating ? "rated" : "completed_unrated")
    : "in_progress";
  if (completed) {
    next.generalWatchlist = false;
    next.rewatchIntent = false;
    next.rewatchAddedAt = null;
    const snapshot = snapshotCompletedTotals(current, totals);
    next.completedAtTotalEpisodes = snapshot.completedAtTotalEpisodes;
    next.completedAtTotalSeasons = snapshot.completedAtTotalSeasons;
    next.hasNewContent = false;
    next.newContentDetectedAt = null;
  }
  return next;
}

function buildNextTitleState(currentState, action, title, options = {}) {
  const now = options.now || new Date();
  const actionType = safeString(action?.type || action?.action || "", 80).trim().toLowerCase();
  const source = safeString(action?.source || actionType || "title_state_action", 80) || "title_state_action";
  const current = normalizeStateForTitle(currentState, title, { now, source });
  const mediaType = current.mediaType;
  const totals = estimateTitleTotals(title);
  let next = {
    ...current,
    source,
    updatedAt: now,
    lastInteractionAt: now,
  };

  switch (actionType) {
    case "toggle_watchlist": {
      const enabled = typeof action?.enabled === "boolean" ? action.enabled : !current.generalWatchlist;
      if (enabled) {
        // Allow re-adding an in-progress series to "da vedere"; only a fully
        // completed/seen title is barred from going back to the watchlist.
        if (!isCompletedState(current)) {
          next.generalWatchlist = true;
        }
      } else {
        next.generalWatchlist = false;
      }
      break;
    }
    case "mark_movie_seen": {
      if (mediaType !== "movie") break;
      next.state = current.hasTitleRating ? "rated" : "seen_unrated";
      next.generalWatchlist = false;
      next.rewatchIntent = false;
      next.rewatchAddedAt = null;
      next.seenAt = now;
      next.completedCount = nextCompletedCount(current, true);
      break;
    }
    case "mark_movie_unseen": {
      if (mediaType !== "movie") break;
      // Toggle off: revert to unseen, drop completion + rating-derived state.
      next.state = "unseen";
      next.seenAt = null;
      next.completedAt = null;
      next.completedCount = 0;
      next.rewatchIntent = false;
      next.rewatchAddedAt = null;
      next.hasTitleRating = false;
      next.ratingValue = null;
      next.ratedAt = null;
      break;
    }
    case "mark_series_episode":
    case "mark_series_season":
    case "set_series_progress": {
      if (mediaType !== "tv") break;
      const catchUp = shouldCatchUpFromCompletion(current, totals);
      if (isCompletedState(current) && !current.rewatchIntent && actionType !== "set_series_progress" && !catchUp) {
        break;
      }
      next = buildInProgressSeriesState(current, { ...action, type: actionType, source }, title, { now });
      break;
    }
    case "mark_series_completed": {
      if (mediaType !== "tv") break;
      next.state = current.hasTitleRating ? "rated" : "completed_unrated";
      next.generalWatchlist = false;
      next.rewatchIntent = false;
      next.rewatchAddedAt = null;
      next.seenAt = current.seenAt || now;
      next.completedAt = now;
      next.completedCount = nextCompletedCount(current, true);
      next.seriesProgress = buildCompletedSeriesProgress(current.seriesProgress, totals, now);
      const snapshot = snapshotCompletedTotals(current, totals);
      next.completedAtTotalEpisodes = snapshot.completedAtTotalEpisodes;
      next.completedAtTotalSeasons = snapshot.completedAtTotalSeasons;
      next.hasNewContent = false;
      next.newContentDetectedAt = null;
      break;
    }
    case "mark_series_unstarted": {
      if (mediaType !== "tv") break;
      // Reset progress entirely, keep rating intact (rating is a separate signal).
      next.state = "not_started";
      next.seenAt = null;
      next.completedAt = null;
      next.completedCount = 0;
      next.rewatchIntent = false;
      next.rewatchAddedAt = null;
      next.seriesProgress = defaultSeriesProgress(totals);
      next.completedAtTotalEpisodes = null;
      next.completedAtTotalSeasons = null;
      next.hasNewContent = false;
      next.newContentDetectedAt = null;
      break;
    }
    case "set_rewatch_intent": {
      if (hasStartedWatching(current) || current.completedCount > 0) {
        next.generalWatchlist = false;
        next.rewatchIntent = true;
        next.rewatchAddedAt = now;
      }
      break;
    }
    case "clear_rewatch_intent": {
      next.rewatchIntent = false;
      next.rewatchAddedAt = null;
      break;
    }
    case "acknowledge_new_content": {
      // Dismisses the "new season available" indicator without changing watch state.
      next.hasNewContent = false;
      next.newContentDetectedAt = null;
      break;
    }
    default:
      break;
  }

  next.titleSnapshot = buildTitleSnapshot(next.titleId, title, next.mediaType, current.titleSnapshot);
  next.watchMinutesContribution = computeWatchMinutesContribution(title, next);
  next.schemaVersion = TITLE_STATE_SCHEMA_VERSION;
  next.reminders = buildReminderHintsData(next);
  return next;
}

// Un voto scritto da un import storico (source `import_*`) non e' un gesto
// fatto ora nell'app: non porta con se' l'implicazione "l'ho appena finita".
function isBulkImportRating(rating) {
  return typeof rating?.source === "string" && rating.source.startsWith("import_");
}

// "Serie gia' conclusa per l'utente" secondo lo stato attuale, prima che il
// voto lo tocchi.
function hasFinishedSeries(current) {
  return Boolean(current?.completedAt) || toPositiveInt(current?.completedCount) > 0;
}

function applyTitleRatingToState(currentState, ratingDoc, title, options = {}) {
  const now = options.now || ratingDoc?.updatedAt || ratingDoc?.createdAt || new Date();
  const current = normalizeStateForTitle(currentState, title, { now, source: "rating_sync" });
  const rating = asObject(ratingDoc);
  const next = {
    ...current,
    source: "rating_sync",
    updatedAt: now,
    lastInteractionAt: now,
  };

  if (ratingDoc) {
    next.hasTitleRating = true;
    next.ratingValue = toNullableNumber(rating.rating);
    next.ratedAt = rating.updatedAt || rating.createdAt || now;
    next.generalWatchlist = false;

    if (next.mediaType === "movie") {
      next.state = "rated";
      next.seenAt = current.seenAt || next.ratedAt || now;
      next.completedCount = current.completedCount > 0 ? current.completedCount : 1;
    } else if (isBulkImportRating(rating) && !hasFinishedSeries(current)) {
      // Voto di serie che arriva da un import storico su una serie che
      // l'utente NON ha finito. Votare in-app implica "l'ho vista" ed e'
      // giusto che completi; un voto importato no: su TV Time si vota una
      // serie anche a meta'. Trattarlo come gli altri accrediterebbe TUTTI
      // gli episodi (buildCompletedSeriesProgress) e gonfierebbe le ore
      // esattamente come faceva la numerazione delle stagioni sfasata.
      // Il voto si attacca, il progresso resta quello vero.
      next.state = toPositiveInt(next.seriesProgress?.episodesWatchedCount) > 0 ? "in_progress" : "not_started";
    } else {
      const totals = estimateTitleTotals(title);
      next.state = "rated";
      next.seenAt = current.seenAt || current.completedAt || next.ratedAt || now;
      next.completedAt = current.completedAt || next.ratedAt || now;
      next.completedCount = current.completedCount > 0 ? current.completedCount : 1;
      next.seriesProgress = buildCompletedSeriesProgress(current.seriesProgress, totals, now);
      const snapshot = snapshotCompletedTotals(current, totals);
      next.completedAtTotalEpisodes = snapshot.completedAtTotalEpisodes;
      next.completedAtTotalSeasons = snapshot.completedAtTotalSeasons;
      next.hasNewContent = false;
      next.newContentDetectedAt = null;
    }
  } else {
    next.hasTitleRating = false;
    next.ratingValue = null;
    next.ratedAt = null;

    if (next.mediaType === "movie") {
      next.state = next.completedCount > 0 || next.seenAt ? "seen_unrated" : "unseen";
    } else if (next.completedCount > 0 || next.completedAt) {
      next.state = "completed_unrated";
    } else if (toPositiveInt(next.seriesProgress?.episodesWatchedCount) > 0) {
      next.state = "in_progress";
    } else {
      next.state = "not_started";
    }
  }

  next.watchMinutesContribution = computeWatchMinutesContribution(title, next);
  next.schemaVersion = TITLE_STATE_SCHEMA_VERSION;
  next.reminders = buildReminderHintsData(next);
  return next;
}

function buildLegacyLibraryProjection(nextState) {
  const state = asObject(nextState);
  const completedCount = toPositiveInt(state.completedCount);
  // La proiezione "library" alimenta la griglia "Visti" del profilo (web + iOS):
  // deve includere anche le serie iniziate ma non finite (in_progress), non solo
  // i titoli completati/votati, altrimenti un utente con una sola serie in corso
  // vede la libreria vuota. `hasStartedWatching` copre completed/rated (film e
  // serie) più `in_progress` (solo serie con episodi visti).
  if (completedCount <= 0 && !isCompletedState(state) && !hasStartedWatching(state)) {
    return null;
  }

  return {
    titleId: safeString(state.titleId || "", 200),
    mediaType: normalizeMediaType(state.mediaType),
    state: normalizeMediaType(state.mediaType) === "tv"
      ? normalizeSeriesState(state.state)
      : normalizeMovieState(state.state),
    lastRating: state.hasTitleRating ? toNullableNumber(state.ratingValue) : null,
    ratedAt: state.ratedAt || null,
    seenAt: state.mediaType === "tv"
      ? (state.completedAt || state.seenAt || state.updatedAt || null)
      : (state.seenAt || state.updatedAt || null),
    updatedAt: state.lastInteractionAt || state.updatedAt || null,
    createdAt: state.createdAt || state.seenAt || state.completedAt || state.updatedAt || null,
    completedCount,
    watchMinutesContribution: toPositiveInt(state.watchMinutesContribution),
  };
}

function buildLegacyWatchlistProjection(nextState) {
  const state = asObject(nextState);
  const watchState = isAwaitingRating(state)
    ? "to_rate"
    : ((state.generalWatchlist || state.rewatchIntent) ? "to_watch" : "");

  if (!watchState) return null;

  return {
    titleId: safeString(state.titleId || "", 200),
    mediaType: normalizeMediaType(state.mediaType),
    pendingTitle: null,
    notes: null,
    priority: watchState === "to_rate" ? "low" : "normal",
    watchState,
    rewatchIntent: Boolean(state.rewatchIntent),
    generalWatchlist: Boolean(state.generalWatchlist),
    addedAt: state.rewatchIntent
      ? (state.rewatchAddedAt || state.createdAt || state.updatedAt || null)
      : (state.createdAt || state.updatedAt || null),
    addedFrom: safeString(state.source || "title_states_projection", 80) || "title_states_projection",
    updatedAt: state.lastInteractionAt || state.updatedAt || null,
  };
}

// ---------------------------------------------------------------------------
// Content category — every title maps to exactly one of these (mutually
// exclusive, no double counting). Derived from the title doc only.
// Animation wins over media type: an animated movie is `cartoni_animati` /
// `anime`, never `film`. A title is `anime` when animated AND of Japanese
// origin; any other animated title is `cartoni_animati`.
// ---------------------------------------------------------------------------
const CONTENT_CATEGORIES = ["film", "serie_tv", "cartoni_animati", "anime"];

function isAnimationGenreToken(value) {
  const token = String(value || "").trim().toLowerCase();
  if (!token) return false;
  if (token === "tmdb_16" || token === "16") return true;
  return token === "animation" || token === "animazione" || token === "anime"
    || token === "cartoon" || token === "cartoons" || token === "cartoni"
    || token === "cartoni animati" || token === "cartone animato" || token === "animated";
}

function titleHasAnimationGenre(title) {
  return safeArray(asObject(title).genres).some(isAnimationGenreToken);
}

function isJapaneseOriginTitle(title) {
  const titleData = asObject(title);
  const meta = asObject(titleData.meta);
  const isoLanguage = String(meta.originalLanguage || titleData.originalLanguage || "")
    .trim()
    .toLowerCase();
  if (isoLanguage === "ja" || isoLanguage === "jpn") return true;
  const languageName = String(meta.language || "").trim().toLowerCase();
  if (languageName === "giapponese" || languageName === "japanese") return true;
  const countryName = String(meta.country || "").trim().toLowerCase();
  if (countryName === "giappone" || countryName === "japan") return true;
  const countryCodes = []
    .concat(meta.originCountry || [])
    .concat(titleData.originCountry || [])
    .concat(titleData.origin_country || []);
  if (countryCodes.some((code) => String(code || "").trim().toUpperCase() === "JP")) {
    return true;
  }
  return safeArray(titleData.keywords)
    .some((keyword) => String(keyword || "").trim().toLowerCase() === "anime");
}

// Resolves the single content category for a title document.
function deriveContentCategory(title) {
  const titleData = asObject(title);
  if (titleHasAnimationGenre(titleData)) {
    return isJapaneseOriginTitle(titleData) ? "anime" : "cartoni_animati";
  }
  return normalizeMediaType(titleData.type || titleData?.meta?.mediaType) === "tv"
    ? "serie_tv"
    : "film";
}

function normalizeContentCategory(value) {
  const candidate = String(value || "").trim().toLowerCase();
  return CONTENT_CATEGORIES.includes(candidate) ? candidate : null;
}

// Category bucket when the title doc can't be resolved: fall back to media type
// so the title still lands in `film` / `serie_tv` instead of being dropped.
function fallbackCategoryForMediaType(mediaType) {
  return normalizeMediaType(mediaType) === "tv" ? "serie_tv" : "film";
}

function emptyCategoryStats() {
  return { watchedCount: 0, ratingsCount: 0, totalWatchMinutes: 0, rewatchCount: 0 };
}

function emptyStatsByCategory() {
  const out = {};
  for (const category of CONTENT_CATEGORIES) {
    out[category] = emptyCategoryStats();
  }
  return out;
}

// Per-state contribution to the cached user stats counters.
// Single source of truth for the stats formula: both the full-set recompute
// and the incremental onWrite trigger derive their numbers from here.
function computeUserStatsContribution(stateData) {
  const row = asObject(stateData);
  const completedCount = toPositiveInt(row.completedCount);
  const hasRating = Boolean(row.hasTitleRating)
    || String(row.state || "").trim().toLowerCase() === "rated";
  return {
    watchedCount: (completedCount > 0 || isCompletedState(row)) ? 1 : 0,
    ratingsCount: hasRating ? 1 : 0,
    totalWatchMinutes: toPositiveInt(row.watchMinutesContribution),
    rewatchCount: Math.max(0, completedCount - 1),
  };
}

// `resolveCategory(row)` returns the content category for a titleState row.
// When omitted, rows are bucketed by media type only (film / serie_tv).
function computeUserStatsFromStateSet(titleStates, resolveCategory) {
  const byCategory = emptyStatsByCategory();
  const totals = safeArray(titleStates).reduce((acc, row) => {
    const part = computeUserStatsContribution(row);
    acc.watchedCount += part.watchedCount;
    acc.ratingsCount += part.ratingsCount;
    acc.totalWatchMinutes += part.totalWatchMinutes;
    acc.rewatchCount += part.rewatchCount;

    const resolved = typeof resolveCategory === "function"
      ? normalizeContentCategory(resolveCategory(row))
      : null;
    const category = resolved || fallbackCategoryForMediaType(asObject(row).mediaType);
    const bucket = byCategory[category];
    bucket.watchedCount += part.watchedCount;
    bucket.ratingsCount += part.ratingsCount;
    bucket.totalWatchMinutes += part.totalWatchMinutes;
    bucket.rewatchCount += part.rewatchCount;
    return acc;
  }, {
    watchedCount: 0,
    ratingsCount: 0,
    totalWatchMinutes: 0,
    rewatchCount: 0,
  });
  return { ...totals, byCategory };
}

function isMeaningfulTitleState(stateData) {
  const state = asObject(stateData);
  return Boolean(
    state.generalWatchlist
    || state.rewatchIntent
    || state.hasTitleRating
    || toPositiveInt(state.completedCount) > 0
    || (normalizeMediaType(state.mediaType) === "tv" && toPositiveInt(state.seriesProgress?.episodesWatchedCount) > 0)
  );
}

module.exports = {
  TITLE_STATE_SCHEMA_VERSION,
  estimateTitleTotals,
  computeWatchMinutesContribution,
  buildNextTitleState,
  buildLegacyLibraryProjection,
  buildLegacyWatchlistProjection,
  computeUserStatsFromStateSet,
  computeUserStatsContribution,
  applyTitleRatingToState,
  normalizeStateForTitle,
  isMeaningfulTitleState,
  hasNewContentVsSnapshot,
  snapshotCompletedTotals,
  CONTENT_CATEGORIES,
  deriveContentCategory,
  normalizeContentCategory,
  fallbackCategoryForMediaType,
  emptyStatsByCategory,
};
