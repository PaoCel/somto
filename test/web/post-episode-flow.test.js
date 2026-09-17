import assert from "node:assert/strict";
import test from "node:test";

import { decidePostEpisodeFlow } from "../../public/js/utils/postEpisodeFlow.js";

test("every atomic +1 opens the episode sheet", () => {
  const entryPoints = [
    "quick add",
    "episode row",
    "episode action sheet",
    "first episode of a new season",
  ];

  for (const entryPoint of entryPoints) {
    const result = decidePostEpisodeFlow({
      beforeEpisodes: 6,
      afterEpisodes: 7,
      isCompleted: false,
      hasTitleRating: false,
      entryAllowsPostEpisode: true,
    });
    assert.equal(result.openEpisodeSheet, true, entryPoint);
    assert.equal(result.openTitleReviewAfterEpisode, false, entryPoint);
  }
});

test("the final atomic episode queues the title review after the episode sheet", () => {
  assert.deepEqual(decidePostEpisodeFlow({
    beforeEpisodes: 9,
    afterEpisodes: 10,
    isCompleted: true,
    hasTitleRating: false,
    entryAllowsPostEpisode: true,
  }), {
    openEpisodeSheet: true,
    openTitleReviewAfterEpisode: true,
  });
});

test("an existing title rating suppresses the final title review", () => {
  assert.deepEqual(decidePostEpisodeFlow({
    beforeEpisodes: 9,
    afterEpisodes: 10,
    isCompleted: true,
    hasTitleRating: true,
    entryAllowsPostEpisode: true,
  }), {
    openEpisodeSheet: true,
    openTitleReviewAfterEpisode: false,
  });
});

test("bulk alignment, no-op and step-back never open the episode sheet", () => {
  const transitions = [
    { before: 2, after: 8, entryAllowsPostEpisode: false },
    // Anche se resta un solo episodio, "completa stagione" è un'azione bulk.
    { before: 7, after: 8, entryAllowsPostEpisode: false },
    { before: 4, after: 4, entryAllowsPostEpisode: true },
    { before: 7, after: 6, entryAllowsPostEpisode: false },
  ];

  for (const { before, after, entryAllowsPostEpisode } of transitions) {
    assert.deepEqual(decidePostEpisodeFlow({
      beforeEpisodes: before,
      afterEpisodes: after,
      isCompleted: after === 8,
      hasTitleRating: false,
      entryAllowsPostEpisode,
    }), {
      openEpisodeSheet: false,
      openTitleReviewAfterEpisode: false,
    });
  }
});
