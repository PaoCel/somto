const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FEED_EVENTS_BATCH_SIZE,
  uniqueUids,
  buildFeedEventDocId,
  buildFeedEventWriteModels,
  writeFeedEvents,
} = require("../../lib/feedEvents");

function buildMockDb() {
  const commits = [];
  return {
    commits,
    collection(name) {
      return {
        doc(id) {
          return { id, path: `${name}/${id}` };
        },
      };
    },
    batch() {
      const ops = [];
      return {
        set(ref, data, opts) {
          ops.push({ ref, data, opts });
        },
        async commit() {
          commits.push(ops.slice());
        },
      };
    },
  };
}

test("uniqueUids dedupes and trims", () => {
  const out = uniqueUids([" alice ", "bob", "", null, "alice", "bob"]);
  assert.deepEqual(out, ["alice", "bob"]);
});

test("buildFeedEventDocId is deterministic and owner-scoped", () => {
  const key = "post:evt_1";
  const one = buildFeedEventDocId("alice", key);
  const oneAgain = buildFeedEventDocId("alice", key);
  const two = buildFeedEventDocId("bob", key);

  assert.equal(one, oneAgain);
  assert.notEqual(one, two);
});

test("buildFeedEventWriteModels dedupes recipients and normalizes payload", () => {
  const models = buildFeedEventWriteModels({
    recipientUids: [" alice ", "bob", "alice"],
    eventKey: "post:evt_2",
    payload: {
      actorUid: "author",
      eventType: "post",
      postKind: "invalid-kind",
      text: "x".repeat(2500),
      snippet: "hello",
      sourcePath: "/a/b",
      mediaUrl: "https://example.com/x.jpg",
      watchedWith: [{ uid: "u1", displayName: "Mario" }, { uid: "u1", displayName: "Dup" }],
    },
  });

  assert.equal(models.length, 2);
  assert.equal(models[0].data.eventType, "post");
  assert.equal(models[0].data.postKind, "");
  // MAX_FEED_TEXT_LEN allineato al tetto di posts.text (2000): il feed legge
  // questa copia, non il doc del post.
  assert.equal(models[0].data.text.length, 2000);
  assert.equal(models[0].data.snippet, "hello");
  assert.equal(models[0].data.mediaUrl, "https://example.com/x.jpg");
  assert.deepEqual(models[0].data.watchedWith, [{ uid: "u1", displayName: "Mario" }]);
});

test("buildFeedEventWriteModels preserves season rating context", () => {
  const models = buildFeedEventWriteModels({
    recipientUids: ["alice"],
    eventKey: "rating:evt_season",
    payload: {
      actorUid: "author",
      eventType: "rating",
      titleId: "shrinking",
      rating: 8,
      level: "season",
      season: 3,
      episode: null,
      postId: "rating::author::shrinking::season::3",
      reviewText: "Gran finale.",
    },
  });

  assert.equal(models.length, 1);
  assert.equal(models[0].data.level, "season");
  assert.equal(models[0].data.season, 3);
  assert.equal(models[0].data.episode, null);
  assert.equal(models[0].data.postId, "rating::author::shrinking::season::3");
});

test("writeFeedEvents chunks writes and sets fallback timestamps", async () => {
  const db = buildMockDb();
  const recipients = Array.from({ length: FEED_EVENTS_BATCH_SIZE + 5 }, (_, idx) => `u${idx}`);
  const tsSentinel = { __serverTimestamp: true };

  const written = await writeFeedEvents({
    db,
    recipientUids: recipients,
    eventKey: "rating:evt_3",
    payload: {
      actorUid: "actor",
      eventType: "rating",
      titleId: "t1",
      rating: 8,
    },
    serverTimestamp: tsSentinel,
  });

  assert.equal(written, recipients.length);
  assert.equal(db.commits.length, 2);
  const totalOps = db.commits.reduce((sum, rows) => sum + rows.length, 0);
  assert.equal(totalOps, recipients.length);
  const sample = db.commits[0][0];
  assert.equal(sample.data.createdAt, tsSentinel);
  assert.equal(sample.data.ingestedAt, tsSentinel);
});
