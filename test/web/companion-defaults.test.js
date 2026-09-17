import assert from "node:assert/strict";
import test from "node:test";

import {
  computeCompanionDefaults,
  MIN_SAMPLES,
  ALONE_SHARE_THRESHOLD,
  MAX_FREQUENT_COMPANIONS,
} from "../../public/js/utils/companionDefaults.js";

function ratingAt(daysAgo, { watchedWith = [], type = "movie" } = {}) {
  return {
    type,
    watchedWith,
    createdAt: { seconds: Math.floor(Date.now() / 1000) - daysAgo * 86400 },
  };
}

test("no data preselects nothing", () => {
  assert.deepEqual(computeCompanionDefaults([]), { preselectAlone: false, frequentCompanions: [] });
  assert.deepEqual(computeCompanionDefaults(null), { preselectAlone: false, frequentCompanions: [] });
});

test("below MIN_SAMPLES never preselects alone even if all solo", () => {
  const ratings = Array.from({ length: MIN_SAMPLES - 1 }, (_, i) => ratingAt(i));
  const result = computeCompanionDefaults(ratings);
  assert.equal(result.preselectAlone, false);
});

test("preselects alone once the solo share reaches the threshold with enough samples", () => {
  // 5 solo + 1 with a companion => 5/6 = 0.833 >= 0.7
  const ratings = [
    ...Array.from({ length: 5 }, (_, i) => ratingAt(i)),
    ratingAt(5, { watchedWith: [{ uid: "u1", displayName: "Anna" }] }),
  ];
  const result = computeCompanionDefaults(ratings);
  assert.equal(result.preselectAlone, true);
});

test("does not preselect alone below the share threshold", () => {
  // 3 solo + 3 with companions => 0.5 < ALONE_SHARE_THRESHOLD
  assert.ok(ALONE_SHARE_THRESHOLD > 0.5);
  const ratings = [
    ...Array.from({ length: 3 }, (_, i) => ratingAt(i)),
    ...Array.from({ length: 3 }, (_, i) => ratingAt(i + 3, { watchedWith: [{ uid: "u1", displayName: "Anna" }] })),
  ];
  const result = computeCompanionDefaults(ratings);
  assert.equal(result.preselectAlone, false);
});

test("ranks frequent companions by recency-weighted count, capped to MAX_FREQUENT_COMPANIONS", () => {
  const ratings = [
    ratingAt(0, { watchedWith: [{ uid: "u1", displayName: "Anna" }] }),
    ratingAt(1, { watchedWith: [{ uid: "u1", displayName: "Anna" }] }),
    ratingAt(2, { watchedWith: [{ uid: "u2", displayName: "Bruno" }] }),
    ratingAt(3, { watchedWith: [{ uid: "u3", displayName: "Carla" }] }),
    ratingAt(4, { watchedWith: [{ uid: "u4", displayName: "Dario" }] }),
    ratingAt(5, { watchedWith: [{ uid: "u5", displayName: "Elisa" }] }),
  ];
  const result = computeCompanionDefaults(ratings);
  assert.ok(result.frequentCompanions.length <= MAX_FREQUENT_COMPANIONS);
  assert.equal(result.frequentCompanions[0].uid, "u1");
});

test("uses per-media-type samples when there are at least MIN_SAMPLES of that type", () => {
  const movieRatings = Array.from({ length: 5 }, (_, i) => ratingAt(i, { type: "movie" }));
  const tvRatings = Array.from({ length: 5 }, (_, i) =>
    ratingAt(i + 10, { type: "tv", watchedWith: [{ uid: "u9", displayName: "Fede" }] }));

  const movieResult = computeCompanionDefaults([...movieRatings, ...tvRatings], { mediaType: "movie" });
  // All movie samples are solo => preselect alone for movie scope.
  assert.equal(movieResult.preselectAlone, true);
  assert.equal(movieResult.frequentCompanions.length, 0);

  const tvResult = computeCompanionDefaults([...movieRatings, ...tvRatings], { mediaType: "tv" });
  // All tv samples have a companion => never alone for tv scope.
  assert.equal(tvResult.preselectAlone, false);
  assert.equal(tvResult.frequentCompanions[0].uid, "u9");
});

test("falls back to overall samples when the requested media type is too thin", () => {
  const movieRatings = Array.from({ length: 5 }, (_, i) => ratingAt(i, { type: "movie" }));
  const tvRatings = [ratingAt(10, { type: "tv" })]; // only 1 tv sample, below MIN_SAMPLES
  const result = computeCompanionDefaults([...movieRatings, ...tvRatings], { mediaType: "tv" });
  // Falls back to the full pool (5 movie + 1 tv = 6 samples, all solo).
  assert.equal(result.preselectAlone, true);
});

test("caps the sample window to RECENT_SAMPLE_MAX regardless of how much history is passed", () => {
  // 100 old ratings with companions, then a recent burst of solo ratings that
  // alone crosses MIN_SAMPLES within the RECENT_SAMPLE_MAX window.
  const old = Array.from({ length: 100 }, (_, i) =>
    ratingAt(200 + i, { watchedWith: [{ uid: "uold", displayName: "Old" }] }));
  const recentSolo = Array.from({ length: MIN_SAMPLES }, (_, i) => ratingAt(i));
  const result = computeCompanionDefaults([...old, ...recentSolo]);
  assert.equal(result.preselectAlone, false); // old companions still dominate the 60-window
  assert.ok(result.frequentCompanions.some((c) => c.uid === "uold"));
});
