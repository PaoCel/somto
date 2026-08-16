const test = require("node:test");
const assert = require("node:assert/strict");

// firebase-admin serve solo per FieldValue/Timestamp: mock via require cache
// non necessario, il modulo li usa dentro la transazione — passiamo un db mock
// e verifichiamo la logica finestra/giorno.
const { enforceGuestCallableRateLimit } = require("../../lib/rateLimiter");

function makeDb(existingData) {
  const writes = [];
  let stored = existingData;
  return {
    writes,
    get stored() { return stored; },
    collection(name) {
      assert.equal(name, "guestRateLimits");
      return {
        doc(id) {
          return { id };
        },
      };
    },
    async runTransaction(fn) {
      await fn({
        async get() {
          return { exists: stored != null, data: () => stored };
        },
        set(ref, data, opts) {
          writes.push({ ref, data, opts });
          stored = { ...(stored || {}), ...data };
        },
      });
    },
  };
}

test("guest rate limit: prima chiamata passa e scrive contatori", async () => {
  const db = makeDb(null);
  await enforceGuestCallableRateLimit(db, "203.0.113.9", "getGuestQuiz", {
    windowSeconds: 60, maxInWindow: 2, dailyMax: 5,
  });
  assert.equal(db.writes.length, 1);
  const w = db.writes[0];
  assert.equal(w.data.windowCount, 1);
  assert.equal(w.data.dayCount, 1);
  // l'id doc NON contiene l'IP in chiaro
  assert.ok(!w.ref.id.includes("203.0.113.9"));
  assert.match(w.ref.id, /^getGuestQuiz_[0-9a-f]{24}$/);
});

test("guest rate limit: oltre la finestra → resource-exhausted", async () => {
  const db = makeDb({
    windowStartMs: Date.now(),
    windowCount: 2,
    dayKey: new Date().toISOString().slice(0, 10),
    dayCount: 2,
  });
  await assert.rejects(
    () => enforceGuestCallableRateLimit(db, "203.0.113.9", "getGuestQuiz", {
      windowSeconds: 60, maxInWindow: 2, dailyMax: 100,
    }),
    (err) => /Troppe richieste/.test(err.message)
  );
});

test("guest rate limit: oltre il tetto giornaliero → resource-exhausted", async () => {
  const db = makeDb({
    windowStartMs: Date.now() - 120000, // finestra scaduta
    windowCount: 9,
    dayKey: new Date().toISOString().slice(0, 10),
    dayCount: 120,
  });
  await assert.rejects(
    () => enforceGuestCallableRateLimit(db, "203.0.113.9", "getGuestQuiz", {
      windowSeconds: 60, maxInWindow: 10, dailyMax: 120,
    }),
    (err) => /giornaliero/.test(err.message)
  );
});

test("guest rate limit: IP mancante usa bucket condiviso 'unknown'", async () => {
  const db = makeDb(null);
  await enforceGuestCallableRateLimit(db, "", "submitGuestQuiz", {});
  assert.equal(db.writes[0].ref.id, "submitGuestQuiz_unknown");
});

test("guest rate limit: stesso IP → stesso doc, IP diverso → doc diverso", async () => {
  const db1 = makeDb(null); const db2 = makeDb(null); const db3 = makeDb(null);
  await enforceGuestCallableRateLimit(db1, "1.2.3.4", "b", {});
  await enforceGuestCallableRateLimit(db2, "1.2.3.4", "b", {});
  await enforceGuestCallableRateLimit(db3, "5.6.7.8", "b", {});
  assert.equal(db1.writes[0].ref.id, db2.writes[0].ref.id);
  assert.notEqual(db1.writes[0].ref.id, db3.writes[0].ref.id);
});
