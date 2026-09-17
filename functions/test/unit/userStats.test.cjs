const test = require("node:test");
const assert = require("node:assert/strict");

const { recomputeUserStatsForUid } = require("../../lib/userStats");

// Minimal in-memory Firestore fake supporting exactly what
// recomputeUserStatsForUid needs: per-user titleStates/listProgressEntries
// subcollections, a top-level titles collection (with a documentId "in"
// query), and set(..., {merge:true}) on the user doc.
function makeFakeDb({ titles = {}, users = {} } = {}) {
  const writes = new Map(); // uid -> last payload passed to users/{uid}.set(...)

  function titlesCollection() {
    return {
      where(field, op, values) {
        assert.equal(op, "in");
        return {
          async get() {
            const docs = values
              .filter((id) => Object.prototype.hasOwnProperty.call(titles, id))
              .map((id) => ({ id, data: () => titles[id] }));
            return { docs };
          },
        };
      },
    };
  }

  function subcollection(rows) {
    return {
      async get() {
        const docs = rows.map((row, idx) => ({
          id: row.id || String(idx),
          data: () => row,
        }));
        return { docs };
      },
    };
  }

  function userDocRef(uid) {
    const userData = users[uid] || {};
    return {
      collection(name) {
        if (name === "titleStates") return subcollection(userData.titleStates || []);
        if (name === "listProgressEntries") return subcollection(userData.listProgressEntries || []);
        if (name === "derivedRatings") return subcollection(userData.derivedRatings || []);
        throw new Error(`unexpected subcollection ${name}`);
      },
      async set(payload, opts) {
        assert.deepEqual(opts, { merge: true });
        writes.set(uid, payload);
      },
    };
  }

  return {
    collection(name) {
      if (name === "titles") return titlesCollection();
      if (name === "users") {
        return {
          doc(uid) {
            return userDocRef(uid);
          },
        };
      }
      throw new Error(`unexpected collection ${name}`);
    },
    _writes: writes,
  };
}

test("recomputeUserStatsForUid sums listProgressEntries minutes into totalWatchMinutes and byCategory", async () => {
  const db = makeFakeDb({
    titles: {
      movie1: { type: "movie", name: "Film Visto" },
      tv1: { type: "tv", name: "Serie Vista" },
    },
    users: {
      u1: {
        titleStates: [
          {
            id: "movie1",
            titleId: "movie1",
            mediaType: "movie",
            state: "seen_unrated",
            completedCount: 1,
            watchMinutesContribution: 120,
          },
        ],
        listProgressEntries: [
          { titleId: "tv1", mediaType: "tv", watchMinutesContribution: 300 },
        ],
      },
    },
  });

  const stats = await recomputeUserStatsForUid(db, "u1");

  assert.equal(stats.watchedCount, 1);
  assert.equal(stats.totalWatchMinutes, 420); // 120 (titleStates) + 300 (listProgressEntries)
  assert.equal(stats.byCategory.film.totalWatchMinutes, 120);
  assert.equal(stats.byCategory.serie_tv.totalWatchMinutes, 300);

  assert.deepEqual(db._writes.get("u1"), { stats });
});

test("recomputeUserStatsForUid writes stats.byCategory even with zero listProgressEntries", async () => {
  const db = makeFakeDb({
    titles: {
      tv2: { type: "tv", name: "Anime", genres: ["anime"], meta: { originalLanguage: "ja" } },
    },
    users: {
      u2: {
        titleStates: [
          {
            id: "tv2",
            titleId: "tv2",
            mediaType: "tv",
            state: "completed_unrated",
            completedCount: 1,
            watchMinutesContribution: 240,
          },
        ],
        listProgressEntries: [],
      },
    },
  });

  const stats = await recomputeUserStatsForUid(db, "u2");

  assert.equal(stats.totalWatchMinutes, 240);
  assert.ok(stats.byCategory.anime);
  assert.equal(stats.byCategory.anime.totalWatchMinutes, 240);
  assert.equal(stats.byCategory.film.totalWatchMinutes, 0);
  assert.equal(stats.derivedRatingsCount, 0);
});

test("recomputeUserStatsForUid counts derivedRatings docs with a series rating", async () => {
  const db = makeFakeDb({
    titles: {
      tv3: { type: "tv", name: "Serie A" },
      tv4: { type: "tv", name: "Serie B" },
    },
    users: {
      u3: {
        titleStates: [],
        listProgressEntries: [],
        derivedRatings: [
          { id: "tv3", titleId: "tv3", series: { avg: 8, seasonCount: 2, episodeCount: 20 } },
          { id: "tv4", titleId: "tv4", series: { avg: 7, seasonCount: 1, episodeCount: 5 } },
          // no `series` -> not counted (e.g. mid-recompute / empty)
          { id: "tv5", titleId: "tv5", series: null },
        ],
      },
    },
  });

  const stats = await recomputeUserStatsForUid(db, "u3");

  assert.equal(stats.ratingsCount, 0); // derived non conta in ratingsCount
  assert.equal(stats.derivedRatingsCount, 2);
});
