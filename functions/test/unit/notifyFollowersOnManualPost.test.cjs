const test = require("node:test");
const assert = require("node:assert/strict");

const registerNotifications = require("../../modules/notifications");

// Fake Firestore: supports the doc().get() used by getUserDisplayName (actor
// displayName lookup) plus the collection/doc/batch chain used by the fan-out.
function makeFakeDb({ users = {} } = {}) {
  const writes = [];
  function makeDocRef(path, id) {
    return {
      path,
      id,
      collection(name) {
        return makeCollectionRef(`${path}/${name}`);
      },
      async get() {
        return {
          exists: Object.prototype.hasOwnProperty.call(users, id),
          data: () => users[id] || undefined,
        };
      },
    };
  }
  function makeCollectionRef(path) {
    let autoId = 0;
    return {
      doc(id) {
        const docId = id || `auto${autoId++}`;
        return makeDocRef(`${path}/${docId}`, docId);
      },
    };
  }
  return {
    collection(name) {
      return makeCollectionRef(name);
    },
    batch() {
      return {
        set(ref, data) { writes.push({ path: ref.path, data }); },
        async commit() {},
      };
    },
    _writes: writes,
  };
}

function makeFakeAdmin(db) {
  return {
    firestore: Object.assign(() => db, {
      FieldValue: { serverTimestamp: () => "SERVER_TIMESTAMP" },
      Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) },
    }),
  };
}

function makeLogger() {
  const warnings = [];
  return { info() {}, warn(msg, meta) { warnings.push({ msg, meta }); }, error() {}, _warnings: warnings };
}

function buildModule({ users = {} } = {}) {
  const db = makeFakeDb({ users });
  const admin = makeFakeAdmin(db);
  const logger = makeLogger();
  const functionsStub = {
    region() { return this; },
    firestore: { document() { return { onCreate: () => null, onUpdate: () => null, onWrite: () => null }; } },
    https: { onCall: () => null, HttpsError: class HttpsError extends Error {} },
  };
  const mod = registerNotifications({ functions: functionsStub, admin, logger, adminUids: [], getAdminUids: null });
  return { mod, db, logger };
}

test("notifyFollowersOnManualPost: one notif per recipient, actor excluded, fromName resolved", async () => {
  const { mod, db } = buildModule({ users: { author_1: { displayName: "Ruspa" } } });
  await mod.notifyFollowersOnManualPost({
    recipientUids: ["author_1", "follower_a", "follower_b"], // author must be dropped
    actorUid: "author_1",
    postId: "post_123",
    titleId: "the-batman",
    preview: "che film pazzesco",
  });

  assert.equal(db._writes.length, 2, "actor dropped, 2 followers notified");
  const paths = db._writes.map((w) => w.path).sort();
  assert.deepEqual(paths, [
    "users/follower_a/notifications/auto0",
    "users/follower_b/notifications/auto0",
  ]);
  for (const w of db._writes) {
    assert.equal(w.data.type, "friend_post");
    assert.equal(w.data.read, false);
    assert.equal(w.data.fromUid, "author_1");
    assert.equal(w.data.data.fromName, "Ruspa");
    assert.equal(w.data.data.postId, "post_123");
    assert.equal(w.data.data.titleId, "the-batman");
    assert.equal(w.data.data.preview, "che film pazzesco");
  }
});

test("notifyFollowersOnManualPost: de-dupes recipients and blank uids", async () => {
  const { mod, db } = buildModule({ users: { a: { displayName: "A" } } });
  await mod.notifyFollowersOnManualPost({
    recipientUids: ["b", "b", "", "  ", "c"],
    actorUid: "a",
    postId: "p1",
  });
  assert.equal(db._writes.length, 2);
});

test("notifyFollowersOnManualPost: no recipients (only actor) -> no-op", async () => {
  const { mod, db } = buildModule({ users: { a: { displayName: "A" } } });
  await mod.notifyFollowersOnManualPost({ recipientUids: ["a"], actorUid: "a", postId: "p1" });
  assert.equal(db._writes.length, 0);
});

test("notifyFollowersOnManualPost: missing postId or actor -> no-op, no throw", async () => {
  const { mod, db } = buildModule();
  await assert.doesNotReject(mod.notifyFollowersOnManualPost({ recipientUids: ["b"], actorUid: "", postId: "p1" }));
  await assert.doesNotReject(mod.notifyFollowersOnManualPost({ recipientUids: ["b"], actorUid: "a", postId: "" }));
  assert.equal(db._writes.length, 0);
});

test("notifyFollowersOnManualPost: fromName falls back to Qualcuno when user missing", async () => {
  const { mod, db } = buildModule({ users: {} });
  await mod.notifyFollowersOnManualPost({ recipientUids: ["b"], actorUid: "ghost", postId: "p1" });
  assert.equal(db._writes.length, 1);
  assert.equal(db._writes[0].data.data.fromName, "Qualcuno");
  assert.equal(db._writes[0].data.data.titleId, null);
});
