export function decidePostEpisodeFlow({
  beforeEpisodes,
  afterEpisodes,
  isCompleted,
  hasTitleRating,
  entryAllowsPostEpisode = true,
} = {}) {
  const before = Number(beforeEpisodes);
  const after = Number(afterEpisodes);
  const isAtomicAdvance = Boolean(entryAllowsPostEpisode)
    && Number.isFinite(before)
    && Number.isFinite(after)
    && after === before + 1;

  return {
    openEpisodeSheet: isAtomicAdvance,
    openTitleReviewAfterEpisode: isAtomicAdvance
      && Boolean(isCompleted)
      && !Boolean(hasTitleRating),
  };
}
