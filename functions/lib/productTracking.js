"use strict";

const PRODUCT_TRACKING_SCHEMA_VERSION = 1;
const PRODUCT_TRACKING_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const MANUAL_PROGRESS_ACTIONS = new Set([
  "mark_movie_seen",
  "mark_series_episode",
  "mark_series_season",
  "mark_series_completed",
  "set_series_progress",
]);

function timestampMs(value) {
  if (!value) return 0;
  if (Number.isFinite(Number(value))) return Number(value);
  if (value instanceof Date) return value.getTime();
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function numberOrZero(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function progressSignature(state = {}) {
  const progress = state?.seriesProgress || {};
  return JSON.stringify({
    mediaType: String(state?.mediaType || ""),
    state: String(state?.state || ""),
    completedCount: numberOrZero(state?.completedCount),
    episodesWatchedCount: numberOrZero(progress.episodesWatchedCount),
    seasonsCompletedCount: numberOrZero(progress.seasonsCompletedCount),
    lastWatchedSeasonNumber: numberOrZero(progress.lastWatchedSeasonNumber),
    lastWatchedEpisodeNumber: numberOrZero(progress.lastWatchedEpisodeNumber),
  });
}

function isManualProgressTransition(beforeState, afterState, actionType) {
  const action = String(actionType || "").trim().toLowerCase();
  if (!MANUAL_PROGRESS_ACTIONS.has(action) || !afterState) return false;
  if (progressSignature(beforeState || {}) === progressSignature(afterState || {})) return false;

  if (action === "mark_movie_seen") {
    return String(afterState.mediaType || "") === "movie"
      && ["seen_unrated", "rated"].includes(String(afterState.state || ""));
  }

  const before = beforeState?.seriesProgress || {};
  const after = afterState?.seriesProgress || {};
  const episodesIncreased = numberOrZero(after.episodesWatchedCount)
    > numberOrZero(before.episodesWatchedCount);
  const seasonsIncreased = numberOrZero(after.seasonsCompletedCount)
    > numberOrZero(before.seasonsCompletedCount);
  const completedNow = !["completed_unrated", "rated"].includes(String(beforeState?.state || ""))
    && ["completed_unrated", "rated"].includes(String(afterState?.state || ""));

  // Correzioni verso il basso, reset, no-op e soli cambi timestamp non sono
  // adozione del tracker: restano nel titleState, ma non nelle metriche.
  return episodesIncreased || seasonsIncreased || completedNow;
}

function normalizeTrackingState(raw = {}) {
  return {
    schemaVersion: Number(raw.schemaVersion || PRODUCT_TRACKING_SCHEMA_VERSION),
    cohortOrigin: String(raw.cohortOrigin || ""),
    migrationVersion: Number(raw.migrationVersion || 0) || null,
    firstSuccessfulImportAtMs: timestampMs(raw.firstSuccessfulImportAtMs || raw.firstSuccessfulImportAt),
    lastSuccessfulImportAtMs: timestampMs(raw.lastSuccessfulImportAtMs || raw.lastSuccessfulImportAt),
    firstManualProgressAtMs: timestampMs(raw.firstManualProgressAtMs || raw.firstManualProgressAt),
    lastManualProgressAtMs: timestampMs(raw.lastManualProgressAtMs || raw.lastManualProgressAt),
    firstManualProgressAfterImportAtMs: timestampMs(
      raw.firstManualProgressAfterImportAtMs || raw.firstManualProgressAfterImportAt
    ),
    firstManualProgressAtOrAfterD1Ms: timestampMs(
      raw.firstManualProgressAtOrAfterD1Ms || raw.firstManualProgressAtOrAfterD1
    ),
    firstManualProgressAtOrAfterD3Ms: timestampMs(
      raw.firstManualProgressAtOrAfterD3Ms || raw.firstManualProgressAtOrAfterD3
    ),
    firstManualProgressAtOrAfterD7Ms: timestampMs(
      raw.firstManualProgressAtOrAfterD7Ms || raw.firstManualProgressAtOrAfterD7
    ),
    updatedAtMs: timestampMs(raw.updatedAtMs || raw.updatedAt),
    expiresAtMs: timestampMs(raw.expiresAtMs || raw.expiresAt),
  };
}

function earliestPositive(current, candidate) {
  if (!(candidate > 0)) return current || 0;
  if (!(current > 0)) return candidate;
  return Math.min(current, candidate);
}

function buildSuccessfulImportTrackingState(currentRaw, {
  completedAtMs,
  cohortOrigin = "prospective",
  migrationVersion = null,
} = {}) {
  const current = normalizeTrackingState(currentRaw);
  const completed = timestampMs(completedAtMs);
  if (!completed) throw new Error("Timestamp import completato mancante.");
  const first = earliestPositive(current.firstSuccessfulImportAtMs, completed);
  const last = Math.max(current.lastSuccessfulImportAtMs, completed);

  const next = {
    ...current,
    schemaVersion: PRODUCT_TRACKING_SCHEMA_VERSION,
    cohortOrigin: current.cohortOrigin || cohortOrigin,
    migrationVersion: current.migrationVersion || migrationVersion,
    firstSuccessfulImportAtMs: first,
    lastSuccessfulImportAtMs: last,
    updatedAtMs: Math.max(current.updatedAtMs, completed),
    expiresAtMs: Math.max(current.expiresAtMs, completed + PRODUCT_TRACKING_RETENTION_MS),
  };

  // Recupera in modo deterministico un evento manuale arrivato dopo l'import
  // qualora il marker dell'import sia stato scritto in ritardo. Non inventa
  // eventi storici: usa solo timestamp manuali già registrati nel marker.
  const firstManual = current.firstManualProgressAtMs;
  const lastManual = current.lastManualProgressAtMs;
  const knownManualAfterImport = firstManual > first ? firstManual : (lastManual > first ? lastManual : 0);
  if (knownManualAfterImport > 0) {
    next.firstManualProgressAfterImportAtMs = earliestPositive(
      current.firstManualProgressAfterImportAtMs,
      knownManualAfterImport
    );
    const lagMs = lastManual - first;
    if (lagMs >= DAY_MS) {
      next.firstManualProgressAtOrAfterD1Ms = earliestPositive(
        current.firstManualProgressAtOrAfterD1Ms,
        lastManual
      );
    }
    if (lagMs >= 3 * DAY_MS) {
      next.firstManualProgressAtOrAfterD3Ms = earliestPositive(
        current.firstManualProgressAtOrAfterD3Ms,
        lastManual
      );
    }
    if (lagMs >= 7 * DAY_MS) {
      next.firstManualProgressAtOrAfterD7Ms = earliestPositive(
        current.firstManualProgressAtOrAfterD7Ms,
        lastManual
      );
    }
  }

  return next;
}

function buildManualProgressTrackingState(currentRaw, { occurredAtMs } = {}) {
  const current = normalizeTrackingState(currentRaw);
  const occurred = timestampMs(occurredAtMs);
  if (!occurred) throw new Error("Timestamp progresso manuale mancante.");
  const importAt = current.firstSuccessfulImportAtMs;
  const next = {
    ...current,
    schemaVersion: PRODUCT_TRACKING_SCHEMA_VERSION,
    firstManualProgressAtMs: earliestPositive(current.firstManualProgressAtMs, occurred),
    lastManualProgressAtMs: Math.max(current.lastManualProgressAtMs, occurred),
    updatedAtMs: Math.max(current.updatedAtMs, occurred),
    expiresAtMs: Math.max(current.expiresAtMs, occurred + PRODUCT_TRACKING_RETENTION_MS),
  };

  if (importAt > 0 && occurred > importAt) {
    const lagMs = occurred - importAt;
    next.firstManualProgressAfterImportAtMs = earliestPositive(
      current.firstManualProgressAfterImportAtMs,
      occurred
    );
    if (lagMs >= DAY_MS) {
      next.firstManualProgressAtOrAfterD1Ms = earliestPositive(
        current.firstManualProgressAtOrAfterD1Ms,
        occurred
      );
    }
    if (lagMs >= 3 * DAY_MS) {
      next.firstManualProgressAtOrAfterD3Ms = earliestPositive(
        current.firstManualProgressAtOrAfterD3Ms,
        occurred
      );
    }
    if (lagMs >= 7 * DAY_MS) {
      next.firstManualProgressAtOrAfterD7Ms = earliestPositive(
        current.firstManualProgressAtOrAfterD7Ms,
        occurred
      );
    }
  }

  return next;
}

function computeManualProgressSnapshot({
  nowMs = Date.now(),
  consumerUids = [],
  trackingByUid = new Map(),
} = {}) {
  const emptyCohort = () => ({
    successfulImporters: 0,
    trackedAfterImport: 0,
    eligibleD1: 0,
    trackedD1: 0,
    eligibleD3: 0,
    trackedD3: 0,
    eligibleD7: 0,
    trackedD7: 0,
  });
  const uids = consumerUids instanceof Set ? [...consumerUids] : [...consumerUids];
  const out = {
    schemaVersion: PRODUCT_TRACKING_SCHEMA_VERSION,
    manualProgressUsersAllTime: 0,
    manualProgressUsers24h: 0,
    manualProgressUsers7d: 0,
    successfulImporters: 0,
    prospectiveImporters: 0,
    legacyImporters: 0,
    trackedAfterImport: 0,
    eligibleD1: 0,
    trackedD1: 0,
    eligibleD3: 0,
    trackedD3: 0,
    eligibleD7: 0,
    trackedD7: 0,
    prospective: emptyCohort(),
    legacyLowerBound: emptyCohort(),
  };

  for (const uid of uids) {
    const marker = normalizeTrackingState(trackingByUid.get(uid) || {});
    if (marker.firstManualProgressAtMs > 0) out.manualProgressUsersAllTime += 1;
    if (marker.lastManualProgressAtMs >= nowMs - DAY_MS) out.manualProgressUsers24h += 1;
    if (marker.lastManualProgressAtMs >= nowMs - 7 * DAY_MS) out.manualProgressUsers7d += 1;

    const importAt = marker.firstSuccessfulImportAtMs;
    if (!importAt) continue;
    const cohort = marker.cohortOrigin === "prospective"
      ? out.prospective
      : out.legacyLowerBound;
    out.successfulImporters += 1;
    cohort.successfulImporters += 1;
    if (marker.cohortOrigin === "prospective") out.prospectiveImporters += 1;
    else out.legacyImporters += 1;
    if (marker.firstManualProgressAfterImportAtMs > importAt) {
      out.trackedAfterImport += 1;
      cohort.trackedAfterImport += 1;
    }

    if (nowMs >= importAt + DAY_MS) {
      out.eligibleD1 += 1;
      cohort.eligibleD1 += 1;
      if (marker.firstManualProgressAtOrAfterD1Ms >= importAt + DAY_MS) {
        out.trackedD1 += 1;
        cohort.trackedD1 += 1;
      }
    }
    if (nowMs >= importAt + 3 * DAY_MS) {
      out.eligibleD3 += 1;
      cohort.eligibleD3 += 1;
      if (marker.firstManualProgressAtOrAfterD3Ms >= importAt + 3 * DAY_MS) {
        out.trackedD3 += 1;
        cohort.trackedD3 += 1;
      }
    }
    if (nowMs >= importAt + 7 * DAY_MS) {
      out.eligibleD7 += 1;
      cohort.eligibleD7 += 1;
      if (marker.firstManualProgressAtOrAfterD7Ms >= importAt + 7 * DAY_MS) {
        out.trackedD7 += 1;
        cohort.trackedD7 += 1;
      }
    }
  }

  return out;
}

module.exports = {
  PRODUCT_TRACKING_SCHEMA_VERSION,
  PRODUCT_TRACKING_RETENTION_MS,
  DAY_MS,
  MANUAL_PROGRESS_ACTIONS,
  timestampMs,
  progressSignature,
  isManualProgressTransition,
  normalizeTrackingState,
  buildSuccessfulImportTrackingState,
  buildManualProgressTrackingState,
  computeManualProgressSnapshot,
};
