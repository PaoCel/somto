const test = require("node:test");
const assert = require("node:assert/strict");

const registerNotifications = require("../../modules/notifications");

// Firestore in memoria, quanto basta a pushOnNotificationCreate e ai trigger
// sociali: doc, sottocollection, transazioni e batch.
function createStore() {
  const docs = new Map();
  let autoId = 0;

  function notFound() {
    const error = new Error("not found");
    error.code = 5;
    return error;
  }

  function docRef(path) {
    return {
      path,
      id: path.split("/").pop(),
      collection(name) { return collectionRef(`${path}/${name}`); },
      async get() {
        const data = docs.get(path);
        return {
          exists: data !== undefined,
          id: path.split("/").pop(),
          ref: docRef(path),
          data: () => (data === undefined ? undefined : { ...data }),
        };
      },
      async set(data, options = {}) {
        const merge = options.merge || Array.isArray(options.mergeFields);
        docs.set(path, merge ? { ...(docs.get(path) || {}), ...data } : { ...data });
      },
      async update(data) {
        if (!docs.has(path)) throw notFound();
        docs.set(path, { ...docs.get(path), ...data });
      },
      async create(data) {
        if (docs.has(path)) {
          const error = new Error("already exists");
          error.code = 6;
          throw error;
        }
        docs.set(path, { ...data });
      },
      async delete() { docs.delete(path); },
    };
  }

  function collectionRef(path) {
    return {
      path,
      doc(id) { return docRef(`${path}/${id || `auto_${++autoId}`}`); },
      async get() {
        const prefix = `${path}/`;
        const keys = [...docs.keys()].filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"));
        const snaps = await Promise.all(keys.map((key) => docRef(key).get()));
        return { docs: snaps, size: snaps.length, empty: snaps.length === 0 };
      },
    };
  }

  const db = {
    collection: (name) => collectionRef(name),
    doc: (path) => docRef(path),
    async runTransaction(run) {
      return run({ get: (ref) => ref.get(), set: (ref, data, options) => ref.set(data, options) });
    },
    batch() {
      const ops = [];
      return {
        set(ref, data, options) { ops.push(() => ref.set(data, options)); },
        update(ref, data) { ops.push(() => ref.update(data)); },
        delete(ref) { ops.push(() => ref.delete()); },
        async commit() { for (const op of ops) await op(); },
      };
    },
  };

  return { docs, db, docRef };
}

function buildHarness({ responses = null } = {}) {
  const store = createStore();
  const sent = [];
  const admin = {
    firestore: Object.assign(() => store.db, {
      // Come in Firestore: il valore salvato e' un istante, non una stringa.
      // Il blocco "consegnata" riscrive lastPushAt con serverTimestamp(), e il
      // cooldown per tipo deve continuare a vederlo.
      FieldValue: {
        serverTimestamp: () => {
          const ms = Date.now();
          return { toMillis: () => ms };
        },
      },
      Timestamp: {
        now: () => {
          const ms = Date.now();
          return { toMillis: () => ms };
        },
        fromMillis: (ms) => ({ toMillis: () => ms }),
      },
    }),
    messaging: () => ({
      async sendEach(messages) {
        sent.push(messages);
        return { responses: messages.map((_, index) => (responses ? responses[index] : { success: true })) };
      },
    }),
  };
  const functions = {
    region() { return this; },
    firestore: {
      document() {
        return {
          onCreate(handler) { return handler; },
          onUpdate(handler) { return handler; },
          onWrite(handler) { return handler; },
        };
      },
    },
    https: { onCall: (handler) => handler, HttpsError: class HttpsError extends Error {} },
  };
  const functionsV2Firestore = {
    onDocumentCreated: (_options, handler) => handler,
    onDocumentUpdatedWithAuthContext: (_options, handler) => handler,
  };
  const logger = { info() {}, warn() {}, error() {} };

  const triggers = registerNotifications({ functions, functionsV2Firestore, admin, logger, adminUids: ["admin_1"] });
  return { store, sent, triggers };
}

const NOTIF_PATH = "users/u1/notifications/n1";

async function runPush(harness, notif, { deleted = false, id = "n1" } = {}) {
  const path = `users/u1/notifications/${id}`;
  if (!deleted) await harness.store.docRef(path).set(notif);
  await harness.triggers.pushOnNotificationCreate(
    { data: () => notif, ref: harness.store.docRef(path) },
    { params: { userId: "u1", notificationId: id } }
  );
  return harness.store.docs.get(path)?.pushDelivery;
}

const threadMessage = () => ({ type: "thread_message", toUid: "u1", fromUid: "u2", data: { fromName: "Ada", preview: "ciao" } });
const titleUpdate = (titleId) => ({
  type: "title_update",
  toUid: "u1",
  fromUid: "system",
  data: { titleId, titleName: titleId, eventId: `ev_${titleId}`, eventType: "new_season" },
});

test("uscite di due titoli diversi nella stessa ora: arrivano tutte e due", async () => {
  const harness = buildHarness();
  await harness.store.docRef("users/u1/notificationTokens/t1").set({ token: "t1" });

  assert.equal((await runPush(harness, titleUpdate("tmdb_tv_1"), { id: "a" })).status, "delivered");
  assert.equal((await runPush(harness, titleUpdate("tmdb_tv_2"), { id: "b" })).status, "delivered");
  assert.equal(harness.sent.length, 2);
});

test("lo stesso titolo due volte nell'ora: la seconda resta in campanella", async () => {
  const harness = buildHarness();
  await harness.store.docRef("users/u1/notificationTokens/t1").set({ token: "t1" });

  assert.equal((await runPush(harness, titleUpdate("tmdb_tv_1"), { id: "a" })).status, "delivered");
  assert.equal((await runPush(harness, titleUpdate("tmdb_tv_1"), { id: "b" })).status, "cooldown");
});

test("un post ufficiale senza titolo resta nella finestra del tipo", async () => {
  const harness = buildHarness();
  await harness.store.docRef("users/u1/notificationTokens/t1").set({ token: "t1" });
  const official = () => ({ type: "official_update", toUid: "u1", fromUid: "system", data: { preview: "Novita' su Somto" } });

  assert.equal((await runPush(harness, official(), { id: "a" })).status, "delivered");
  assert.equal((await runPush(harness, official(), { id: "b" })).status, "cooldown");
});

test("senza token: esito no_token e nessuna finestra di cooldown bruciata", async () => {
  const harness = buildHarness();
  const delivery = await runPush(harness, threadMessage());

  assert.equal(delivery.status, "no_token");
  assert.equal(harness.sent.length, 0);
  assert.equal(harness.store.docs.has("users/u1/_system/pushCooldown_thread_message"), false);
});

test("consegnata: l'esito dice quanti device l'hanno ricevuta", async () => {
  const harness = buildHarness();
  await harness.store.docRef("users/u1/notificationTokens/t1").set({ token: "t1" });
  await harness.store.docRef("users/u1/notificationTokens/t2").set({ token: "t2" });
  const delivery = await runPush(harness, threadMessage());

  assert.equal(delivery.status, "delivered");
  assert.equal(delivery.tokens, 2);
  assert.equal(delivery.success, 2);
  assert.equal(typeof delivery.at?.toMillis, "function", "l'istante lo mette il server");
});

test("un payload malformato non costa il token a chi lo riceve", async () => {
  const harness = buildHarness({
    responses: [{ success: false, error: { code: "messaging/invalid-argument", message: "Message is too big" } }],
  });
  await harness.store.docRef("users/u1/notificationTokens/t1").set({ token: "t1" });
  const delivery = await runPush(harness, threadMessage());

  assert.equal(delivery.status, "failed");
  assert.deepEqual(delivery.errorCodes, ["messaging/invalid-argument"]);
  assert.equal(harness.store.docs.has("users/u1/notificationTokens/t1"), true, "il token sano resta");
});

test("un token disabilitato da APNs viene tolto", async () => {
  const harness = buildHarness({
    responses: [{ success: false, error: { code: "messaging/invalid-argument", message: "APNs device token is disabled." } }],
  });
  await harness.store.docRef("users/u1/notificationTokens/t1").set({ token: "t1" });
  const delivery = await runPush(harness, threadMessage());

  assert.equal(delivery.status, "failed");
  assert.equal(delivery.deadTokens, 1);
  assert.deepEqual(delivery.errorCodes, []);
  assert.equal(harness.store.docs.has("users/u1/notificationTokens/t1"), false);
});

test("cooldown: raggiungibile ma trattenuta, e lo dice", async () => {
  const harness = buildHarness();
  await harness.store.docRef("users/u1/notificationTokens/t1").set({ token: "t1" });
  await harness.store.docRef("users/u1/_system/pushCooldown_thread_message").set({ lastPushAt: { toMillis: () => Date.now() } });
  const delivery = await runPush(harness, threadMessage());

  assert.equal(delivery.status, "cooldown");
  assert.equal(delivery.tokens, 1);
  assert.equal(harness.sent.length, 0);
});

test("una notifica gia' cancellata non viene resuscitata dall'esito", async () => {
  const harness = buildHarness();
  const delivery = await runPush(harness, threadMessage(), { deleted: true });

  assert.equal(delivery, undefined);
  assert.equal(harness.store.docs.has(NOTIF_PATH), false);
});

test("un like a un commento sotto un voto avvisa chi l'ha scritto, una volta sola", async () => {
  const harness = buildHarness();
  const eventId = "rating::owner::tmdb_movie_1";
  await harness.store.docRef(`ratingFeed/${eventId}/comments/c1`).set({ uid: "author", text: "bello" });
  await harness.store.docRef("users/liker").set({ displayName: "Bea" });
  const event = { params: { eventId, commentId: "c1", likeUid: "liker" } };

  await harness.triggers.notifyOnRatingCommentLike(event);
  await harness.triggers.notifyOnRatingCommentLike(event);

  const created = [...harness.store.docs.entries()].filter(([path]) => path.startsWith("users/author/notifications/"));
  assert.equal(created.length, 1, "un retry non raddoppia la notifica");
  const [, notification] = created[0];
  assert.equal(notification.type, "comment_like");
  assert.equal(notification.fromUid, "liker");
  assert.deepEqual(notification.data, { fromName: "Bea", eventId, titleId: "tmdb_movie_1", commentId: "c1" });
});

test("mettersi like da soli non notifica", async () => {
  const harness = buildHarness();
  const eventId = "rating::owner::tmdb_movie_1";
  await harness.store.docRef(`ratingFeed/${eventId}/comments/c1`).set({ uid: "author" });

  await harness.triggers.notifyOnRatingCommentLike({ params: { eventId, commentId: "c1", likeUid: "author" } });

  assert.equal([...harness.store.docs.keys()].some((path) => path.startsWith("users/author/notifications/")), false);
});
