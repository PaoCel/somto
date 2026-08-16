const test = require("node:test");
const assert = require("node:assert/strict");

const registerNotifications = require("../../modules/notifications");

// Minimal fake Firestore: only what notifyAdminsImportStarted touches —
// db.collection(...).doc(...).collection(...).doc() to mint a ref, plus a
// batch() that records every .set() call so assertions can inspect the
// written payloads without a real Firestore/emulator.
function makeFakeDb() {
  const writes = [];
  function makeDocRef(path) {
    return {
      path,
      collection(name) {
        return makeCollectionRef(`${path}/${name}`);
      },
    };
  }
  function makeCollectionRef(path) {
    let autoId = 0;
    return {
      doc(id) {
        const docId = id || `auto${autoId++}`;
        return makeDocRef(`${path}/${docId}`);
      },
    };
  }
  return {
    collection(name) {
      return makeCollectionRef(name);
    },
    batch() {
      return {
        set(ref, data) {
          writes.push({ path: ref.path, data });
        },
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
  return {
    info() {},
    warn(msg, meta) { warnings.push({ msg, meta }); },
    error() {},
    _warnings: warnings,
  };
}

function buildModule({ adminUids = ["admin_1", "admin_2"] } = {}) {
  const db = makeFakeDb();
  const admin = makeFakeAdmin(db);
  const logger = makeLogger();
  const functionsStub = {
    region() { return this; },
    firestore: { document() { return { onCreate: () => null, onUpdate: () => null, onWrite: () => null }; } },
    https: { onCall: () => null, HttpsError: class HttpsError extends Error {} },
  };
  const mod = registerNotifications({ functions: functionsStub, admin, logger, adminUids, getAdminUids: null });
  return { mod, db, logger };
}

test("notifyAdminsImportStarted: fans out one notification doc per admin uid", async () => {
  const { mod, db } = buildModule();
  await mod.notifyAdminsImportStarted({
    fromUid: "user_1",
    fromName: "Faberillo",
    source: "tvtime_gdpr",
    totalRows: 2829,
    importUid: "user_1",
    importId: "import_abc",
  });

  assert.equal(db._writes.length, 2, "one write per admin uid");
  const paths = db._writes.map((w) => w.path).sort();
  assert.deepEqual(paths, [
    "users/admin_1/notifications/auto0",
    "users/admin_2/notifications/auto0",
  ].sort());

  for (const write of db._writes) {
    assert.equal(write.data.type, "admin_import_started");
    assert.equal(write.data.read, false);
    assert.equal(write.data.fromUid, "user_1");
    assert.equal(write.data.data.fromName, "Faberillo");
    assert.equal(write.data.data.source, "tvtime_gdpr");
    assert.equal(write.data.data.totalRows, 2829);
    assert.equal(write.data.data.importUid, "user_1");
    assert.equal(write.data.data.importId, "import_abc");
  }
});

test("notifyAdminsImportStarted: skips notifying an admin about their own import", async () => {
  const { mod, db } = buildModule({ adminUids: ["admin_1", "user_1"] });
  await mod.notifyAdminsImportStarted({
    fromUid: "user_1",
    fromName: "Faberillo",
    source: "netflix_csv",
    totalRows: 100,
    importUid: "user_1",
    importId: "import_xyz",
  });

  assert.equal(db._writes.length, 1);
  assert.equal(db._writes[0].path, "users/admin_1/notifications/auto0");
});

test("notifyAdminsImportStarted: no admin uids configured -> no-op, no throw", async () => {
  const { mod, db } = buildModule({ adminUids: [] });
  await assert.doesNotReject(mod.notifyAdminsImportStarted({
    fromUid: "user_1",
    fromName: "Faberillo",
    source: "netflix_csv",
    totalRows: 100,
    importUid: "user_1",
    importId: "import_xyz",
  }));
  assert.equal(db._writes.length, 0);
});

test("notifyAdminsImportStarted: totalRows null (refract standby, not parsed yet) is preserved as null, not coerced to 0", async () => {
  const { mod, db } = buildModule({ adminUids: ["admin_1"] });
  await mod.notifyAdminsImportStarted({
    fromUid: "user_1",
    fromName: "Faberillo",
    source: "tvtime_refract",
    totalRows: null,
    importUid: "user_1",
    importId: "import_refract1",
  });
  assert.equal(db._writes.length, 1);
  assert.equal(db._writes[0].data.data.totalRows, null);
});

test("notifyAdminsImportStarted: never throws even if resolveAdminUids blows up (best-effort)", async () => {
  const db = makeFakeDb();
  const admin = makeFakeAdmin(db);
  const logger = makeLogger();
  const functionsStub = {
    region() { return this; },
    firestore: { document() { return { onCreate: () => null, onUpdate: () => null, onWrite: () => null }; } },
    https: { onCall: () => null, HttpsError: class HttpsError extends Error {} },
  };
  const getAdminUids = () => { throw new Error("boom"); };
  const mod = registerNotifications({ functions: functionsStub, admin, logger, adminUids: ["admin_1"], getAdminUids });

  await assert.doesNotReject(mod.notifyAdminsImportStarted({
    fromUid: "user_1",
    fromName: "Faberillo",
    source: "netflix_csv",
    totalRows: 10,
    importUid: "user_1",
    importId: "import_1",
  }));
  // getAdminUids threw -> resolveAdminUids logs a warning and falls back to
  // BOOT_ADMIN_UIDS ("admin_1"), so the notification should still go out.
  assert.equal(db._writes.length, 1);
});
