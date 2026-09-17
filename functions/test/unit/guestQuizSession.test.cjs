const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SESSION_PREFIX,
  SESSION_TTL_MS,
  issueGuestQuizSession,
  maybeCleanupExpiredGuestQuizSessions,
  requireGuestQuizSession,
} = require("../../lib/guestQuizSession");

function makeDb() {
  const docs = new Map();
  return {
    docs,
    collection(name) {
      assert.equal(name, "guestRateLimits");
      return {
        doc(id) {
          return {
            id,
            async set(data) { docs.set(id, data); },
            async get() {
              const data = docs.get(id);
              return { exists: Boolean(data), data: () => data };
            },
          };
        },
      };
    },
  };
}

test("guest quiz session lega il submit alle domande emesse", async () => {
  const db = makeDb();
  const now = Date.UTC(2026, 7, 29, 12, 0, 0);
  const token = await issueGuestQuizSession(db, ["q1", "q2"], now);

  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(db.docs.get(`${SESSION_PREFIX}${token}`).expiresAt.getTime(), now + SESSION_TTL_MS);
  const result = await requireGuestQuizSession(db, token, ["q2", "q1"], now + 1000);
  assert.deepEqual(result.questionIds, ["q1", "q2"]);
});

test("guest quiz session rifiuta ID arbitrari, duplicati e token mancanti", async () => {
  const db = makeDb();
  const now = Date.now();
  const token = await issueGuestQuizSession(db, ["q1", "q2"], now);

  await assert.rejects(() => requireGuestQuizSession(db, token, ["q1", "q3"], now), /scaduta o non valida/);
  await assert.rejects(() => requireGuestQuizSession(db, token, ["q1", "q1"], now), /scaduta o non valida/);
  await assert.rejects(() => requireGuestQuizSession(db, "", ["q1", "q2"], now), /Sessione quiz non valida/);
});

test("guest quiz session rifiuta una sessione scaduta", async () => {
  const db = makeDb();
  const now = Date.now();
  const token = await issueGuestQuizSession(db, ["q1"], now);

  await assert.rejects(
    () => requireGuestQuizSession(db, token, ["q1"], now + SESSION_TTL_MS + 1),
    /scaduta o non valida/
  );
});

test("cleanup sessioni guest resta un no-op quando il campionamento non scatta", async () => {
  const db = makeDb();
  assert.equal(await maybeCleanupExpiredGuestQuizSessions(db, Date.now(), () => 0.9), 0);
});
