const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DELETION_LEASE_MS,
  acquireDeletionLease,
  authDeletionSource,
  isSelfServeDeletionInProgress,
  timestampMillis,
} = require("../../lib/accountDeletion");

function fakeTimestamp(ms) {
  return { toMillis: () => ms };
}

function fakeDb(initial = null) {
  let row = initial ? { ...initial } : null;
  const ref = { path: "accountDeletionRequests/user-1" };
  return {
    get row() { return row; },
    collection(name) {
      assert.equal(name, "accountDeletionRequests");
      return { doc: () => ref };
    },
    async runTransaction(work) {
      return work({
        async get() {
          return { exists: row !== null, data: () => row || {} };
        },
        set(_ref, patch) {
          row = { ...(row || {}), ...patch };
        },
      });
    },
  };
}

const Timestamp = { fromMillis: fakeTimestamp };

test("riconosce il cleanup self-service posseduto dalla callable", () => {
  assert.equal(isSelfServeDeletionInProgress({ source: "self-serve", status: "processing" }), true);
  assert.equal(isSelfServeDeletionInProgress({ source: "self-serve", status: "ready_for_auth_delete" }), true);
  assert.equal(isSelfServeDeletionInProgress({ source: "auth-on-delete", status: "processing" }), false);
});

test("conserva la provenienza pending-expiry nel trigger Auth", () => {
  assert.equal(authDeletionSource({ source: "pending-expiry" }), "pending-expiry");
  assert.equal(authDeletionSource({ source: "self-serve" }), "auth-on-delete");
  assert.equal(authDeletionSource({}), "auth-on-delete");
});

test("il trigger Auth non prende la lease durante il self-delete", async () => {
  const db = fakeDb({ source: "self-serve", status: "ready_for_auth_delete", operationId: "self-op" });
  const result = await acquireDeletionLease({
    db,
    uid: "user-1",
    source: "auth-on-delete",
    Timestamp,
    nowMs: 1_000,
    operationId: "trigger-op",
  });
  assert.deepEqual(result, {
    acquired: false,
    reason: "self-serve-owns-cleanup",
    operationId: "self-op",
  });
  assert.equal(timestampMillis(db.row.authDeleteObservedAt), 1_000);
});

test("una lease attiva impedisce due cleanup concorrenti", async () => {
  const db = fakeDb({
    source: "auth-on-delete",
    status: "processing",
    operationId: "first-op",
    leaseExpiresAt: fakeTimestamp(20_000),
  });
  const result = await acquireDeletionLease({
    db,
    uid: "user-1",
    source: "auth-on-delete",
    Timestamp,
    nowMs: 10_000,
    operationId: "second-op",
  });
  assert.equal(result.acquired, false);
  assert.equal(result.reason, "lease-active");
  assert.equal(result.operationId, "first-op");
});

test("una lease scaduta viene ripresa in modo idempotente", async () => {
  const db = fakeDb({
    source: "auth-on-delete",
    status: "processing",
    operationId: "stale-op",
    attemptCount: 1,
    leaseExpiresAt: fakeTimestamp(9_000),
  });
  const result = await acquireDeletionLease({
    db,
    uid: "user-1",
    source: "auth-on-delete",
    Timestamp,
    nowMs: 10_000,
    operationId: "retry-op",
  });
  assert.equal(result.acquired, true);
  assert.equal(db.row.operationId, "retry-op");
  assert.equal(db.row.attemptCount, 2);
  assert.equal(timestampMillis(db.row.leaseExpiresAt), 10_000 + DELETION_LEASE_MS);
});

test("una richiesta completata resta un no-op", async () => {
  const db = fakeDb({ status: "completed", operationId: "done-op" });
  const result = await acquireDeletionLease({
    db,
    uid: "user-1",
    source: "auth-on-delete",
    Timestamp,
    nowMs: 10_000,
    operationId: "retry-op",
  });
  assert.deepEqual(result, {
    acquired: false,
    reason: "already-completed",
    operationId: "done-op",
  });
});

// --- inventario del cleanup ------------------------------------------------
//
// Il rischio vero non e' cancellare troppo: e' dimenticare una collection e
// lasciare dati personali di un account cancellato. Questi test bloccano
// l'inventario, cosi' una collection nuova non puo' sparire dal cleanup senza
// che un test diventi rosso.

const { cleanupAccountData } = require("../../lib/accountDeletion");

function recordingDb({ storageFiles = [] } = {}) {
  const touched = { queries: [], recursiveDeletes: [], batchDeletes: 0 };
  const emptySnap = { empty: true, size: 0, docs: [] };
  const makeQuery = (collection) => {
    const q = {
      collection,
      where(field, op, value) {
        touched.queries.push(`${collection}|${String(field?.toString?.() ?? field)}${op === "==" ? "==" : op}${typeof value === "string" ? value : "?"}`);
        return q;
      },
      limit: () => q,
      orderBy: () => q,
      async get() { return emptySnap; },
      async count() { return { get: async () => ({ data: () => ({ count: 0 }) }) }; },
    };
    return q;
  };
  return {
    touched,
    collection(name) {
      const q = makeQuery(name);
      q.doc = () => ({
        path: `${name}/uid-1`,
        collection: () => makeQuery(`${name}/sub`),
        async get() { return { exists: false, data: () => ({}) }; },
        async delete() { return null; },
      });
      return q;
    },
    collectionGroup: (name) => makeQuery(name),
    batch: () => ({ delete() {}, set() {}, async commit() {} }),
    async recursiveDelete(ref) { touched.recursiveDeletes.push(ref.path); },
  };
}

function fakeBucket(files) {
  return { async getFiles({ prefix }) { return [files.filter((f) => f.name.startsWith(prefix))]; } };
}

test("il cleanup copre le collection che tenevano dati dopo la cancellazione", async () => {
  const db = recordingDb();
  const counts = await cleanupAccountData({
    db,
    auth: { async deleteUser() {} },
    bucket: fakeBucket([]),
    uid: "uid-1",
    source: "test",
    userData: {},
    adminUids: [],
    FieldValue: { serverTimestamp: () => "ts", delete: () => "del" },
    Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) },
    logger: { info() {}, warn() {} },
    dryRun: true,
  });

  const queried = db.touched.queries.join("\n");
  // Le sei falle trovate il 2026-08-28 ispezionando la produzione.
  for (const expected of [
    "pendingSignups",     // sopravviveva alla cancellazione (verificato in prod)
    "feedEvents|ownerUid",// righe di feed recapitate all'utente
    "feedEvents|actorUid",// righe dell'utente dentro il feed di altri
    "characterVotes",
    "clientErrors",
    "publicUserLists",
  ]) {
    assert.ok(queried.includes(expected), `il cleanup non tocca ${expected}`);
  }
  assert.equal(typeof counts.deletedFeedEvents, "number");
  assert.equal(typeof counts.deletedPendingSignup, "number");
});

test("Storage riporta conteggi reali, non un booleano ottimista", async () => {
  const base = {
    auth: { async deleteUser() {} },
    uid: "uid-1",
    source: "test",
    userData: {},
    adminUids: [],
    FieldValue: { serverTimestamp: () => "ts", delete: () => "del" },
    Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) },
    logger: { info() {}, warn() {} },
    dryRun: true,
  };

  // Bucket vuoto: controllato, zero file. Non e' "non lo so".
  const empty = await cleanupAccountData({ ...base, db: recordingDb(), bucket: fakeBucket([]) });
  assert.equal(empty.storageChecked, true);
  assert.equal(empty.storageFilesFound, 0);
  assert.equal(empty.storageFilesDeleted, 0);

  // Con file presenti il dry-run li conta senza cancellarli.
  const withFiles = await cleanupAccountData({
    ...base,
    db: recordingDb(),
    bucket: fakeBucket([
      { name: "avatars/uid-1/a.jpg", async delete() {} },
      { name: "dataExports/uid-1/export-1.json", async delete() {} },
    ]),
  });
  assert.equal(withFiles.storageFilesFound, 2, "l'export GDPR deve rientrare nei prefissi controllati");
  assert.equal(withFiles.storageFilesDeleted, 0, "il dry-run non cancella");

  // Storage irraggiungibile: si dichiara non controllato.
  const broken = await cleanupAccountData({
    ...base,
    db: recordingDb(),
    bucket: { async getFiles() { throw new Error("bucket offline"); } },
  });
  assert.equal(broken.storageChecked, false);
});
