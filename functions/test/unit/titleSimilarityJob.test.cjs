"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { collectSimilarityInteractions } = require("../../lib/titleSimilarityJob");

function snapshot(docs) {
  return { docs, size: docs.length, empty: docs.length === 0 };
}

function pagedQuery(pages) {
  let page = 0;
  const query = {
    orderBy() { return query; },
    limit() { return query; },
    startAfter() { return query; },
    async get() { return pages[page++] || snapshot([]); },
  };
  return query;
}

test("collectSimilarityInteractions conserva il timestamp piu recente per utente e titolo", async () => {
  const titleState = {
    id: "ted-lasso",
    ref: { path: "users/u1/titleStates/ted-lasso" },
    data: () => ({ titleId: "ted-lasso", state: "in_progress", createdAt: 100 }),
  };
  const rating = {
    id: "u1__ted-lasso",
    data: () => ({ uid: "u1", titleId: "ted-lasso", rating: 9, createdAt: 200 }),
  };
  const statesQuery = pagedQuery([snapshot([titleState])]);
  const ratingsQuery = pagedQuery([snapshot([rating])]);
  const db = {
    collectionGroup(name) {
      assert.strictEqual(name, "titleStates");
      return statesQuery;
    },
    collection(name) {
      assert.strictEqual(name, "ratings");
      return ratingsQuery;
    },
  };

  const result = await collectSimilarityInteractions(db, { maxRows: 10 });
  assert.deepStrictEqual(result.rows, [{ uid: "u1", titleId: "ted-lasso", atMs: 200 }]);
});
