const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveTvEpisodeRuntime } = require("../../lib/tmdbDurations");

test("resolveTvEpisodeRuntime falls back to last_episode_to_air.runtime when episode_run_time is empty", () => {
  const detailsIt = {
    episode_run_time: [],
    last_episode_to_air: { runtime: 42 },
  };
  const result = resolveTvEpisodeRuntime(detailsIt);
  assert.equal(result.value, 42);
  assert.equal(result.source, "last_episode_to_air");
});

test("resolveTvEpisodeRuntime falls back to next_episode_to_air.runtime when episode_run_time and last_episode_to_air are both missing", () => {
  const detailsIt = {
    episode_run_time: [],
    last_episode_to_air: null,
    next_episode_to_air: { runtime: 38 },
  };
  const result = resolveTvEpisodeRuntime(detailsIt);
  assert.equal(result.value, 38);
  assert.equal(result.source, "next_episode_to_air");
});

test("resolveTvEpisodeRuntime returns null value when no source has a positive runtime", () => {
  const detailsIt = {
    episode_run_time: [],
    last_episode_to_air: { runtime: 0 },
    next_episode_to_air: null,
  };
  const result = resolveTvEpisodeRuntime(detailsIt);
  assert.equal(result.value, null);
  assert.equal(result.source, null);
});

test("resolveTvEpisodeRuntime prefers episode_run_time (show-level) when present and positive", () => {
  const detailsIt = {
    episode_run_time: [55],
    last_episode_to_air: { runtime: 42 },
  };
  const result = resolveTvEpisodeRuntime(detailsIt);
  assert.equal(result.value, 55);
  assert.equal(result.source, "episode_run_time");
});

test("resolveTvEpisodeRuntime accepts a scalar (non-array) episode_run_time", () => {
  const detailsIt = { episode_run_time: 45 };
  const result = resolveTvEpisodeRuntime(detailsIt);
  assert.equal(result.value, 45);
  assert.equal(result.source, "episode_run_time");
});

test("resolveTvEpisodeRuntime handles a completely missing/undefined details payload", () => {
  const result = resolveTvEpisodeRuntime(undefined);
  assert.equal(result.value, null);
  assert.equal(result.source, null);
});
