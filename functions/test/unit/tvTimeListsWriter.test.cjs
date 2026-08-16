const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_ITEMS_PER_LIST,
  candidateKey,
  candidateRow,
  deterministicListId,
  buildTvTimeListPlans,
} = require("../../lib/importAdapters/tvTimeListsWriter");

test("candidate helpers preserve the stable TV Time identifiers", () => {
  assert.equal(candidateKey({ mediaTypeGuess: "tv", tvdbSeriesId: 401003 }), "tv|401003");
  assert.equal(candidateKey({ mediaTypeGuess: "movie", uuid: "ABC-123" }), "movie|abc-123");

  const row = candidateRow({ mediaTypeGuess: "tv", tvdbSeriesId: 469187 });
  assert.equal(row.kind, "tv_episode");
  assert.equal(row.tvdbSeriesId, 469187);
  assert.equal(row.seriesNameGuess, "TVDB Series 469187");
});

test("deterministicListId is stable per owner, source list, and chunk", () => {
  const first = deterministicListId("alice", "source-key", 0);
  assert.equal(first, deterministicListId("alice", "source-key", 0));
  assert.notEqual(first, deterministicListId("bob", "source-key", 0));
  assert.notEqual(first, deterministicListId("alice", "source-key", 1));
});

test("list plans stay private, preserve order, and deduplicate title ids", () => {
  const createdAt = new Date("2026-07-05T19:20:05Z");
  const now = new Date("2026-07-10T12:00:00Z");
  const lists = [{
    name: "Preferiti",
    description: "La mia lista",
    isPublic: true,
    sKey: "favorite-series",
    createdAt,
    items: [
      { mediaTypeGuess: "tv", tvdbSeriesId: 1, createdAt },
      { mediaTypeGuess: "movie", uuid: "movie-a", createdAt },
      { mediaTypeGuess: "tv", tvdbSeriesId: 1, createdAt },
      { mediaTypeGuess: "movie", uuid: "missing", createdAt },
    ],
  }];
  const resolutions = new Map([
    ["tv|1", "title-tv"],
    ["movie|movie-a", "title-movie"],
  ]);

  const result = buildTvTimeListPlans({
    uid: "alice",
    lists,
    titleIdByCandidateKey: resolutions,
    owner: { displayName: "Alice" },
    now,
  });

  assert.equal(result.plans.length, 1);
  assert.equal(result.originalPublicLists, 1);
  assert.equal(result.unresolvedItems, 1);
  assert.equal(result.plans[0].root.visibility, "private");
  assert.deepEqual(result.plans[0].root.itemTitleIds, ["title-tv", "title-movie"]);
  assert.deepEqual(result.plans[0].items.map((item) => item.orderIndex), [0, 1000]);
});

test("lists larger than the Somto limit are split without losing items", () => {
  const items = [];
  const resolutions = new Map();
  for (let i = 0; i < MAX_ITEMS_PER_LIST + 1; i += 1) {
    const uuid = `movie-${i}`;
    items.push({ mediaTypeGuess: "movie", uuid });
    resolutions.set(`movie|${uuid}`, `title-${i}`);
  }

  const result = buildTvTimeListPlans({
    uid: "alice",
    lists: [{ name: "Lunghissima", sKey: "long", isPublic: false, items }],
    titleIdByCandidateKey: resolutions,
  });

  assert.equal(result.plans.length, 2);
  assert.equal(result.plans[0].items.length, MAX_ITEMS_PER_LIST);
  assert.equal(result.plans[1].items.length, 1);
  assert.equal(result.plans[0].root.title, "Lunghissima (1/2)");
  assert.equal(result.plans[1].root.title, "Lunghissima (2/2)");
});
