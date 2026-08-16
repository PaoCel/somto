const test = require("node:test");
const assert = require("node:assert/strict");
const {
  formatPushCoverageMessage,
  summarizePushCoverage,
} = require("../../lib/pushCoverage");

const NOW_MS = Date.parse("2026-08-03T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function users() {
  return [
    { uid: "a", lastActiveAtMs: NOW_MS - (2 * DAY) },
    { uid: "b", lastActiveAtMs: NOW_MS - (20 * DAY) },
    { uid: "c", lastActiveAtMs: NOW_MS - DAY },
    { uid: "d", lastActiveAtMs: null },
    { uid: "zombie", lastActiveAtMs: NOW_MS, isDeleted: true },
  ];
}

test("la copertura conta gli utenti, non i token", () => {
  const summary = summarizePushCoverage({
    users: users(),
    tokens: [
      { uid: "a", platform: "ios", updatedAtMs: NOW_MS - DAY },
      // Due device della stessa persona non la contano due volte.
      { uid: "a", platform: "ios", updatedAtMs: NOW_MS - (2 * DAY) },
      { uid: "b", platform: "web", updatedAtMs: NOW_MS - (200 * DAY) },
    ],
    nowMs: NOW_MS,
  });

  assert.equal(summary.users, 4, "gli account cancellati non entrano nel totale");
  assert.equal(summary.reachable, 2);
  assert.equal(summary.reachablePercent, 50);
  assert.equal(summary.tokens, 3);
  assert.equal(summary.freshTokens, 2, "un token fermo da 200 giorni non è fresco");
  assert.deepEqual(summary.byPlatform, { ios: 2, web: 1 });
});

test("gli attivi degli ultimi 7 giorni sono contati a parte", () => {
  const summary = summarizePushCoverage({
    users: users(),
    tokens: [{ uid: "a", platform: "ios", updatedAtMs: NOW_MS }],
    nowMs: NOW_MS,
  });
  assert.equal(summary.activeUsers, 2, "a e c");
  assert.equal(summary.activeReachable, 1, "solo a ha un token");
  assert.equal(summary.activeReachablePercent, 50);
});

test("senza utenti non si divide per zero", () => {
  const summary = summarizePushCoverage({ users: [], tokens: [], nowMs: NOW_MS });
  assert.equal(summary.reachablePercent, 0);
  assert.equal(summary.activeReachablePercent, 0);
  assert.equal(formatPushCoverageMessage(summary).startsWith("0 utenti su 0 raggiungibili"), true);
});

test("il messaggio mostra la differenza con la settimana prima", () => {
  const summary = summarizePushCoverage({
    users: users(),
    tokens: [
      { uid: "a", platform: "ios", updatedAtMs: NOW_MS },
      { uid: "c", platform: "web", updatedAtMs: NOW_MS },
    ],
    nowMs: NOW_MS,
  });
  const message = formatPushCoverageMessage(summary, { reachable: 1 });
  assert.match(message, /2 utenti su 4 raggiungibili \(50%\)/);
  assert.match(message, /\+1 rispetto a 7 giorni fa/);
  assert.match(message, /ios 1, web 1/);
  assert.match(formatPushCoverageMessage(summary, { reachable: 2 }), /invariato/);
});
