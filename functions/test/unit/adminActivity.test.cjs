const test = require("node:test");
const assert = require("node:assert/strict");

const registerAdminActivity = require("../../modules/adminActivity");

// Fake Firestore ridotto a cio' che tocca recordAdminActivity: un doc per
// path, e una runTransaction che legge e scrive in memoria. Basta per
// verificare la parte che conta davvero — il raggruppamento a finestra.
function makeFakeDb() {
  const docs = new Map();

  function makeDocRef(path) {
    return {
      path,
      id: path.split("/").pop(),
      collection(name) {
        return makeCollectionRef(`${path}/${name}`);
      },
    };
  }
  function makeCollectionRef(path) {
    let autoId = 0;
    return {
      doc(id) {
        return makeDocRef(`${path}/${id || `auto${autoId++}`}`);
      },
    };
  }

  return {
    collection(name) {
      return makeCollectionRef(name);
    },
    async runTransaction(fn) {
      return fn({
        async get(ref) {
          const data = docs.get(ref.path);
          return { exists: data !== undefined, data: () => data };
        },
        set(ref, payload, options) {
          const previous = options?.merge ? (docs.get(ref.path) || {}) : {};
          docs.set(ref.path, { ...previous, ...payload });
        },
      });
    },
    _docs: docs,
  };
}

function makeAdmin(db) {
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
    debug() {},
    info() {},
    warn(msg, meta) { warnings.push({ msg, meta }); },
    error() {},
    _warnings: warnings,
  };
}

function setup({ adminUids = ["admin1"] } = {}) {
  const db = makeFakeDb();
  const logger = makeLogger();
  const api = registerAdminActivity({
    admin: makeAdmin(db),
    logger,
    resolveAdminUids: () => adminUids,
  });
  return { db, logger, ...api };
}

function writtenDocs(db) {
  return [...db._docs.entries()].map(([path, data]) => ({ path, data }));
}

test("una raffica dentro la finestra diventa una notifica sola che conta", async () => {
  const { db, recordAdminActivity } = setup();

  for (let i = 0; i < 4; i += 1) {
    await recordAdminActivity({
      kind: "library",
      actorUid: "u1",
      actorName: "Mario",
      detail: { titleId: `t${i}` },
    });
  }

  const docs = writtenDocs(db);
  assert.equal(docs.length, 1, "una finestra = un documento");
  assert.equal(docs[0].data.data.count, 4);
  assert.equal(docs[0].data.data.message, "Mario ha aggiunto 4 titoli alla libreria");
  assert.equal(docs[0].data.type, "admin_activity");
  assert.equal(docs[0].data.fromUid, "u1");
});

test("attivita' diverse dello stesso utente restano separate", async () => {
  const { db, recordAdminActivity } = setup();

  await recordAdminActivity({ kind: "library", actorUid: "u1", actorName: "Mario" });
  await recordAdminActivity({ kind: "rating", actorUid: "u1", actorName: "Mario" });

  assert.equal(writtenDocs(db).length, 2);
});

test("gli eventi non raggruppati fanno un documento per evento", async () => {
  const { db, recordAdminActivity } = setup();

  await recordAdminActivity({ kind: "post", actorUid: "u1", actorName: "Mario", eventId: "p1" });
  await recordAdminActivity({ kind: "post", actorUid: "u1", actorName: "Mario", eventId: "p2" });

  assert.equal(writtenDocs(db).length, 2);
});

test("stesso evento consegnato due volte non duplica (retry del trigger)", async () => {
  const { db, recordAdminActivity } = setup();

  await recordAdminActivity({ kind: "post", actorUid: "u1", actorName: "Mario", eventId: "p1" });
  await recordAdminActivity({ kind: "post", actorUid: "u1", actorName: "Mario", eventId: "p1" });

  assert.equal(writtenDocs(db).length, 1);
});

test("l'attivita' di un admin non notifica l'admin stesso", async () => {
  const { db, recordAdminActivity } = setup({ adminUids: ["admin1"] });

  await recordAdminActivity({ kind: "post", actorUid: "admin1", eventId: "p1" });

  assert.equal(writtenDocs(db).length, 0);
});

test("i profili guidati non sono attivita' di persone vere", async () => {
  const { db, recordAdminActivity } = setup();

  await recordAdminActivity({ kind: "post", actorUid: "guided_abc", eventId: "p1" });

  assert.equal(writtenDocs(db).length, 0);
});

test("ogni admin riceve la sua copia", async () => {
  const { db, recordAdminActivity } = setup({ adminUids: ["admin1", "admin2"] });

  await recordAdminActivity({ kind: "follow", actorUid: "u1", actorName: "Mario", eventId: "u1_u2" });

  const docs = writtenDocs(db);
  assert.equal(docs.length, 2);
  assert.ok(docs.some((d) => d.path.startsWith("users/admin1/")));
  assert.ok(docs.some((d) => d.path.startsWith("users/admin2/")));
});

test("un errore di scrittura non propaga: la notifica non deve rompere il trigger", async () => {
  const db = makeFakeDb();
  db.runTransaction = async () => { throw new Error("firestore down"); };
  const logger = makeLogger();
  const { recordAdminActivity } = registerAdminActivity({
    admin: makeAdmin(db),
    logger,
    resolveAdminUids: () => ["admin1"],
  });

  await recordAdminActivity({ kind: "post", actorUid: "u1", eventId: "p1" });

  assert.equal(logger._warnings.length, 1);
});

test("le frasi al singolare e al plurale sono quelle attese", () => {
  const { activityMessage } = registerAdminActivity;

  assert.equal(
    activityMessage({ kind: "watchlist", name: "Ada", count: 1, detail: { what: "Dune" } }),
    "Ada ha messo un titolo in watchlist — Dune"
  );
  assert.equal(
    activityMessage({ kind: "watchlist", name: "Ada", count: 3, detail: {} }),
    "Ada ha messo 3 titoli in watchlist"
  );
  assert.equal(
    activityMessage({ kind: "account_deleted", name: "Ada", count: 1, detail: {} }),
    "Ada ha cancellato il suo account"
  );
  assert.equal(
    activityMessage({ kind: "follow", name: "Ada", count: 1, detail: { what: "Bruno" } }),
    "Ada ha iniziato a seguire Bruno"
  );
  assert.equal(
    activityMessage({ kind: "post", name: "", count: 1, detail: {} }),
    "Un utente ha pubblicato un post"
  );
});
