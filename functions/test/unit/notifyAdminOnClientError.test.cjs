const test = require("node:test");
const assert = require("node:assert/strict");

const registerNotifications = require("../../modules/notifications");

function buildHarness() {
  const handlers = new Map();
  const created = new Map();

  function docRef(path) {
    return {
      path,
      collection(name) { return collectionRef(`${path}/${name}`); },
      async create(data) {
        if (created.has(path)) {
          const error = new Error("already exists");
          error.code = 6;
          throw error;
        }
        created.set(path, data);
      },
    };
  }

  function collectionRef(path) {
    return { doc(id = "auto") { return docRef(`${path}/${id}`); } };
  }

  const db = { collection(name) { return collectionRef(name); } };
  const admin = {
    firestore: Object.assign(() => db, {
      FieldValue: { serverTimestamp: () => "SERVER_TIMESTAMP" },
      Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) },
    }),
  };
  const functions = {
    region() { return this; },
    firestore: {
      document(path) {
        return {
          onCreate(handler) { handlers.set(`create:${path}`, handler); return handler; },
          onUpdate(handler) { return handler; },
          onWrite(handler) { return handler; },
        };
      },
    },
    https: { onCall: (handler) => handler, HttpsError: class HttpsError extends Error {} },
  };
  const functionsV2Firestore = {
    onDocumentCreated: (_path, handler) => handler,
    onDocumentUpdatedWithAuthContext: (_path, handler) => handler,
  };
  const logs = [];
  const logger = {
    info() {},
    warn(message, data) { logs.push({ level: "warn", message, data }); },
    error(message, data) { logs.push({ level: "error", message, data }); },
  };

  registerNotifications({
    functions,
    functionsV2Firestore,
    admin,
    logger,
    adminUids: ["admin_1"],
  });

  return { handlers, created, logs };
}

test("clientErrors trigger sends one privacy-safe daily admin notification", async () => {
  const { handlers, created, logs } = buildHarness();
  const handler = handlers.get("create:clientErrors/{errorId}");
  assert.equal(typeof handler, "function");

  const raw = {
    message: "secret token in stack",
    source: "https://somto.it/js/app.js?uid=alice",
    page: "/home.html?private=1",
    stack: "private stack",
    ua: "private ua",
  };
  await handler({ data: () => raw }, { params: { errorId: "error_1" } });
  await handler({ data: () => raw }, { params: { errorId: "error_2" } });

  assert.equal(created.size, 1, "same daily fingerprint must be deduplicated");
  const [path, notification] = [...created.entries()][0];
  assert.match(path, /^users\/admin_1\/notifications\/client_error_\d{8}_[a-f0-9]{16}$/);
  assert.equal(notification.type, "client_error_alert");
  assert.equal(notification.data.pagePath, "/home.html");
  assert.equal(notification.data.message, "Errore web rilevato su /home.html");
  assert.equal(JSON.stringify(notification).includes("secret"), false);
  assert.equal(JSON.stringify(notification).includes("private"), false);
  assert.equal(logs.filter((entry) => entry.level === "error").length, 2);
});

test("clientErrors trigger ignora il rumore delle estensioni del browser", async () => {
  const { handlers, created, logs } = buildHarness();
  const handler = handlers.get("create:clientErrors/{errorId}");

  await handler(
    { data: () => ({ message: "Invalid call to runtime.sendMessage(). Tab not found.", page: "/community.html" }) },
    { params: { errorId: "error_noise" } }
  );

  assert.equal(created.size, 0, "il rumore di terze parti non deve svegliare gli admin");
  assert.equal(logs.filter((entry) => entry.level === "error").length, 0);
});
