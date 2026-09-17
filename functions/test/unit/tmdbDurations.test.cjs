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

// --- media dai runtime reali degli episodi (append_to_response=season/N) ---
// Regressione: il fallback last_episode_to_air prendeva UN episodio (quasi
// sempre il finale, lungo il doppio) e lo spacciava per la durata media.
// Stranger Things: 129' invece di 65' reali, +45h sulla serie intera.

const { collectAppendedSeasonRuntimes } = require("../../lib/tmdbDurations");

test("resolveTvEpisodeRuntime prefers the average of real episode runtimes over last_episode_to_air", () => {
  const detailsIt = {
    episode_run_time: [],
    last_episode_to_air: { runtime: 129 },
    "season/1": { episodes: [{ runtime: 48 }, { runtime: 55 }, { runtime: 51 }, { runtime: 50 }] },
    "season/2": { episodes: [{ runtime: 62 }, { runtime: 58 }] },
  };
  const result = resolveTvEpisodeRuntime(detailsIt);
  assert.equal(result.source, "season_episodes");
  assert.equal(result.value, 54); // (48+55+51+50+62+58)/6 = 54
});

test("resolveTvEpisodeRuntime prefers real episode runtimes even over a present episode_run_time", () => {
  // Don Matteo: TMDB dichiara 45', gli episodi reali stanno sui 62'.
  const detailsIt = {
    episode_run_time: [45],
    "season/1": { episodes: [{ runtime: 60 }, { runtime: 62 }, { runtime: 64 }] },
  };
  const result = resolveTvEpisodeRuntime(detailsIt);
  assert.equal(result.source, "season_episodes");
  assert.equal(result.value, 62);
});

test("resolveTvEpisodeRuntime ignores season 0 specials when averaging", () => {
  const detailsIt = {
    episode_run_time: [],
    last_episode_to_air: { runtime: 50 },
    "season/0": { episodes: [{ runtime: 5 }, { runtime: 6 }, { runtime: 4 }] },
  };
  const result = resolveTvEpisodeRuntime(detailsIt);
  assert.equal(result.source, "last_episode_to_air");
  assert.equal(result.value, 50);
});

test("resolveTvEpisodeRuntime falls back when the appended seasons carry too few runtimes", () => {
  const detailsIt = {
    episode_run_time: [45],
    "season/1": { episodes: [{ runtime: 90 }, { runtime: null }, { runtime: 0 }] },
  };
  const result = resolveTvEpisodeRuntime(detailsIt);
  assert.equal(result.source, "episode_run_time");
  assert.equal(result.value, 45);
});

test("collectAppendedSeasonRuntimes returns only positive runtimes of real seasons", () => {
  const runtimes = collectAppendedSeasonRuntimes({
    "season/0": { episodes: [{ runtime: 5 }] },
    "season/1": { episodes: [{ runtime: 42 }, { runtime: 0 }, { runtime: null }, {}] },
    "season/2": { episodes: [{ runtime: 44 }] },
    seasons: [{ season_number: 1 }],
  });
  assert.deepEqual(runtimes.sort((a, b) => a - b), [42, 44]);
});
