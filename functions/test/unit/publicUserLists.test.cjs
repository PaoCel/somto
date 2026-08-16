const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildPublicUserListProjection,
  syncPublicUserListProjection,
} = require("../../modules/publicUserLists");

const PUBLIC_KEYS = [
  "listId",
  "title",
  "description",
  "visibility",
  "kind",
  "ownerUid",
  "owner",
  "itemTitleIds",
  "previewTitleIds",
  "itemCount",
  "completedCount",
  "followersCount",
  "cover",
  "slug",
  "editorialSlug",
  "editorial",
  "createdAt",
  "updatedAt",
  "projectedAt",
].sort();

function mockDb() {
  const calls = { sets: [], deletes: [] };
  return {
    calls,
    collection(name) {
      return {
        doc(id) {
          if (name === "users") {
            return {
              async get() {
                return {
                  exists: id === "alice",
                  data: () => ({ displayName: "Alice Safe", photoURL: "https://img/alice.jpg" }),
                };
              },
            };
          }
          return {
            id,
            async set(data, opts) {
              calls.sets.push({ name, id, data, opts });
            },
            async delete() {
              calls.deletes.push({ name, id });
            },
          };
        },
      };
    },
  };
}

test("public projection exposes only allowlisted public fields", () => {
  const projection = buildPublicUserListProjection({
    listId: "list_public",
    ownerUser: { displayName: "Alice Safe", photoURL: "https://img/alice.jpg" },
    serverTimestamp: "SERVER_TS",
    listData: {
      title: "Lista pubblica",
      description: "Descrizione",
      visibility: "public",
      kind: "ordered_path",
      ownerUid: "alice",
      owner: { uid: "mallory", displayName: "Spoof" },
      memberUids: ["alice", "bob"],
      editorUids: ["bob"],
      viewerUids: ["charlie"],
      savedByUids: ["dave"],
      progress: { alice: true },
      itemTitleIds: ["t1", "t2", "t1"],
      previewTitleIds: ["t1"],
      itemCount: 2,
      completedCount: 1,
      followersCount: 4,
      cover: { imageUrl: "https://img/cover.jpg", storagePath: "listCovers/x.jpg", fallbackTitleIds: ["t2"] },
      slug: "lista-pubblica",
      editorialSlug: "editorial",
      editorial: true,
      createdAt: "CREATED",
      updatedAt: "UPDATED",
    },
  });

  assert.deepEqual(Object.keys(projection).sort(), PUBLIC_KEYS);
  assert.equal(projection.owner.uid, "alice");
  assert.equal(projection.owner.displayName, "Alice Safe");
  assert.equal(projection.owner.photoURL, "https://img/alice.jpg");
  assert.deepEqual(projection.itemTitleIds, ["t1", "t2"]);
  assert.deepEqual(projection.cover.fallbackTitleIds, ["t2"]);
  assert.equal(projection.projectedAt, "SERVER_TS");
  assert.equal("memberUids" in projection, false);
  assert.equal("editorUids" in projection, false);
  assert.equal("viewerUids" in projection, false);
  assert.equal("savedByUids" in projection, false);
  assert.equal("progress" in projection, false);
});

test("sync writes public projection and deletes non-public projection", async () => {
  const db = mockDb();
  await syncPublicUserListProjection(db, "list_public", {
    title: "Lista pubblica",
    visibility: "public",
    kind: "collection",
    ownerUid: "alice",
    memberUids: ["alice", "bob"],
    itemTitleIds: ["t1"],
  }, { serverTimestamp: "SERVER_TS" });

  assert.equal(db.calls.sets.length, 1);
  assert.equal(db.calls.sets[0].name, "publicUserLists");
  assert.equal(db.calls.sets[0].id, "list_public");
  assert.equal(db.calls.sets[0].opts.merge, false);
  assert.equal(db.calls.sets[0].data.owner.displayName, "Alice Safe");
  assert.equal("memberUids" in db.calls.sets[0].data, false);

  await syncPublicUserListProjection(db, "list_public", {
    title: "Privata",
    visibility: "private",
    ownerUid: "alice",
  });

  assert.deepEqual(db.calls.deletes, [{ name: "publicUserLists", id: "list_public" }]);
});
