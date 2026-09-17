const test = require("node:test");
const assert = require("node:assert/strict");

const { engagementMillis, engagementNumber } = require("../../lib/pureUtils");

const ts = (ms) => ({ toMillis: () => ms });

test("il contatore annidato vince su quello letterale", () => {
  const user = { engagement: { nudgeCount: 2 }, "engagement.nudgeCount": 40 };
  assert.equal(engagementNumber(user, "nudgeCount"), 2);
});

test("i doc scritti dalla versione buggata valgono ancora", () => {
  // `batch.set()` con chiave puntata: il punto finisce nel nome del campo.
  const legacy = { "engagement.nudgeCount": 40, "engagement.lastNudgeAt": ts(1000) };
  assert.equal(engagementNumber(legacy, "nudgeCount"), 40);
  assert.equal(engagementMillis(legacy, "lastNudgeAt"), 1000);
});

test("il timestamp annidato viene letto", () => {
  assert.equal(engagementMillis({ engagement: { lastNudgeAt: ts(555) } }, "lastNudgeAt"), 555);
});

test("senza contatore si parte da zero, mai da NaN o undefined", () => {
  assert.equal(engagementNumber({}, "nudgeCount"), 0);
  assert.equal(engagementNumber(undefined, "nudgeCount"), 0);
  assert.equal(engagementNumber({ engagement: { nudgeCount: "boh" } }, "nudgeCount"), 0);
  assert.equal(engagementMillis({}, "lastNudgeAt"), 0);
  assert.equal(engagementMillis(undefined, "lastNudgeAt"), 0);
});
