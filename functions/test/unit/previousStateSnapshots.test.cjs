"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildPreviousStateSnapshot,
  isAlreadyExistsError,
  persistPreviousTitleStates,
} = require("../../lib/importAdapters/previousStateSnapshots");

function fakeFirestore({ existing = new Set(), failId = null } = {}) {
  const docs = new Map();
  const parentWrites = [];
  const importRef = {
    collection: () => ({
      doc: (id) => ({ id }),
      count: () => ({ get: async () => ({ data: () => ({ count: docs.size + existing.size }) }) }),
    }),
    set: async (data) => parentWrites.push(data),
  };
  const db = {
    bulkWriter: () => ({
      create: async (ref, data) => {
        if (ref.id === failId) throw Object.assign(new Error("write failed"), { code: 13 });
        if (existing.has(ref.id) || docs.has(ref.id)) {
          throw Object.assign(new Error("already exists"), { code: 6 });
        }
        docs.set(ref.id, data);
      },
      close: async () => {},
    }),
  };
  return { db, importRef, docs, parentWrites };
}

test("snapshot represents existing and absent states", () => {
  const at = { server: true };
  assert.deepEqual(buildPreviousStateSnapshot("a", { state: "rated" }, at), {
    titleId: "a", existed: true, state: { state: "rated" }, capturedAt: at, schemaVersion: 1,
  });
  assert.deepEqual(buildPreviousStateSnapshot("b", null, at), {
    titleId: "b", existed: false, state: null, capturedAt: at, schemaVersion: 1,
  });
});

test("already-exists errors are idempotent success", () => {
  assert.equal(isAlreadyExistsError({ code: 6 }), true);
  assert.equal(isAlreadyExistsError({ code: "already-exists" }), true);
  assert.equal(isAlreadyExistsError({ code: 13 }), false);
});

test("persists create-only snapshots and a ready marker", async () => {
  const fake = fakeFirestore({ existing: new Set(["old"]) });
  const result = await persistPreviousTitleStates({
    db: fake.db,
    importRef: fake.importRef,
    currentStatesByTitleId: new Map([["old", { state: "rated" }], ["new", null]]),
    capturedAt: "now",
  });
  assert.deepEqual(result, { expected: 2, created: 1, reused: 1, count: 2 });
  assert.equal(fake.docs.get("new").existed, false);
  assert.equal(fake.parentWrites[0].previousStateSnapshot.status, "ready");
});

test("a partial failure rejects and never writes the ready marker", async () => {
  const fake = fakeFirestore({ failId: "bad" });
  await assert.rejects(() => persistPreviousTitleStates({
    db: fake.db,
    importRef: fake.importRef,
    currentStatesByTitleId: new Map([["ok", null], ["bad", { state: "rated" }]]),
    capturedAt: "now",
  }), /write failed/);
  assert.equal(fake.parentWrites.length, 0);
});

test("handles more than one Firestore batch worth of titles", async () => {
  const fake = fakeFirestore();
  const states = new Map(Array.from({ length: 600 }, (_, index) => [`title-${index}`, null]));
  const result = await persistPreviousTitleStates({
    db: fake.db,
    importRef: fake.importRef,
    currentStatesByTitleId: states,
    capturedAt: "now",
  });
  assert.equal(result.created, 600);
  assert.equal(result.count, 600);
  assert.equal(fake.parentWrites.length, 1);
});

test("retry preserves the original marker capture time", async () => {
  const fake = fakeFirestore({ existing: new Set(["old"]) });
  await persistPreviousTitleStates({
    db: fake.db,
    importRef: fake.importRef,
    currentStatesByTitleId: new Map([["old", { state: "rated" }]]),
    capturedAt: "retry-time",
    markerCapturedAt: "first-time",
  });
  const marker = fake.parentWrites[0].previousStateSnapshot;
  assert.equal(marker.capturedAt, "first-time");
  assert.equal(marker.verifiedAt, "retry-time");
});
