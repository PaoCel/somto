const test = require("node:test");
const assert = require("node:assert/strict");
const { buildKnownUsersMap, collectMissingAdderProfileUids } = require("../../lib/leaderboard");

test("buildKnownUsersMap maps user docs to lightweight profile map", () => {
  const docs = [
    {
      id: "alice",
      data: () => ({
        displayName: "Alice",
        photoURL: "https://example.com/a.jpg",
        stats: { ratingsCount: 12 },
      }),
    },
    {
      id: "bob",
      data: () => ({
        displayName: "Bob",
        photoURL: "",
        stats: { ratingsCount: 0 },
      }),
    },
  ];

  const out = buildKnownUsersMap(docs);

  assert.deepEqual(out.alice, {
    displayName: "Alice",
    photoURL: "https://example.com/a.jpg",
    ratingsCount: 12,
  });
  assert.deepEqual(out.bob, {
    displayName: "Bob",
    photoURL: "",
    ratingsCount: 0,
  });
});

test("collectMissingAdderProfileUids returns only adders not present in knownUsers", () => {
  const knownUsers = {
    alice: { displayName: "Alice" },
  };
  const adderEntries = [
    ["alice", 10],
    ["charlie", 7],
    ["diana", 4],
  ];

  const missing = collectMissingAdderProfileUids(adderEntries, knownUsers);
  assert.deepEqual([...missing].sort(), ["charlie", "diana"]);
});

test("collectMissingAdderProfileUids works without post counters context (leaderboard crash regression)", () => {
  const knownUsers = { alice: { displayName: "Alice" } };
  const adderEntries = [["alice", 3], ["eve", 1]];

  assert.doesNotThrow(() => collectMissingAdderProfileUids(adderEntries, knownUsers));
  const missing = collectMissingAdderProfileUids(adderEntries, knownUsers);
  assert.equal(missing.has("eve"), true);
});
