"use strict";

// Pure helpers backing scripts/backfill-title-states-metrics.js, split out so
// they can be unit-tested without booting a real (or emulated) Firestore app
// (the script calls admin `initializeApp()` + `main()` at module load).

const {
  computeUserStatsFromStateSet,
  deriveContentCategory,
} = require("./titleStates");

function toPositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Dry-run preview of a user's recomputed `stats`, from already-enriched
 * titleStates rows (in-memory, not yet written) plus listProgressEntries rows
 * read from Firestore. Mirrors functions/lib/userStats.js#recomputeUserStatsForUid
 * exactly, but takes plain data instead of Firestore refs so it can run before
 * the titleStates fixes are committed (dry-run mode never writes).
 *
 * @param {Array<object>} enrichedStates - titleStates rows with corrected
 *   completedCount/watchMinutesContribution already applied in-memory.
 * @param {Array<object>} listProgressRows - raw listProgressEntries docs.
 * @param {(titleId: string) => object|null} getTitle - sync title lookup
 *   (caller pre-fetches/caches titles; the resulting map is passed in).
 */
function previewUserStatsFromEnrichedStates(enrichedStates, listProgressRows, titleMap) {
  const resolveTitle = (titleId) => (titleMap instanceof Map ? titleMap.get(titleId) : undefined);

  const categoryForState = (row) => deriveContentCategory(
    resolveTitle(String(row.titleId || row.id || "").trim()) || { type: row.mediaType }
  );
  const baseStats = computeUserStatsFromStateSet(enrichedStates, categoryForState);

  let listProgressMinutes = 0;
  for (const row of listProgressRows || []) {
    const minutes = toPositiveNumber(row?.watchMinutesContribution);
    if (!minutes) continue;
    listProgressMinutes += minutes;
    const titleId = String(row?.titleId || "").trim();
    const category = deriveContentCategory(resolveTitle(titleId) || { type: row?.mediaType });
    if (baseStats.byCategory[category]) {
      baseStats.byCategory[category].totalWatchMinutes += minutes;
    }
  }

  return {
    watchedCount: baseStats.watchedCount,
    ratingsCount: baseStats.ratingsCount,
    totalWatchMinutes: baseStats.totalWatchMinutes + listProgressMinutes,
    rewatchCount: baseStats.rewatchCount,
    byCategory: baseStats.byCategory,
  };
}

module.exports = {
  previewUserStatsFromEnrichedStates,
};
