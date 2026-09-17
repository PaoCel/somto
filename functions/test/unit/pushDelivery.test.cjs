const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildPushDelivery,
  isDeadTokenError,
  pushCooldownScope,
  summarizeSendResults,
} = require("../../lib/pushDelivery");

test("sulle uscite il cooldown e' per titolo, sul resto per tipo", () => {
  assert.equal(pushCooldownScope("title_update", { titleId: "tmdb_tv_1" }), "tmdb_tv_1");
  assert.equal(pushCooldownScope("official_update", { titleId: "tmdb_movie_2" }), "tmdb_movie_2");
  assert.equal(pushCooldownScope("new_season_available", { titleId: "x" }), "x");
  assert.equal(pushCooldownScope("official_update", {}), null, "un post ufficiale senza titolo resta nella finestra del tipo");
  assert.equal(pushCooldownScope("thread_message", { titleId: "tmdb_tv_1" }), null);
  assert.equal(pushCooldownScope("title_update", null), null);
});

test("un token disabilitato da APNs e' morto anche se FCM dice invalid-argument", () => {
  assert.equal(isDeadTokenError("messaging/invalid-argument", "APNs device token is disabled."), true);
  assert.equal(isDeadTokenError("messaging/registration-token-not-registered", "NotRegistered"), true);
  assert.equal(isDeadTokenError("messaging/invalid-registration-token", ""), true);
});

test("un messaggio malformato non costa il token a chi lo riceve", () => {
  // Stesso codice, causa opposta: il payload e' sbagliato, il device e' vivo.
  assert.equal(isDeadTokenError("messaging/invalid-argument", "Message is too big"), false);
  assert.equal(isDeadTokenError("messaging/invalid-argument", "Invalid value at 'message.data[0].value'"), false);
  assert.equal(isDeadTokenError("messaging/third-party-auth-error", "Auth error from APNS or Web Push Service"), false);
  assert.equal(isDeadTokenError("", ""), false);
});

test("il riepilogo separa i token morti dagli errori nostri", () => {
  const summary = summarizeSendResults([
    { success: true },
    { success: false, error: { code: "messaging/registration-token-not-registered", message: "NotRegistered" } },
    { success: false, error: { code: "messaging/invalid-argument", message: "Message is too big" } },
    { success: false, error: { code: "messaging/invalid-argument", message: "Message is too big" } },
  ], ["t0", "t1", "t2", "t3"]);

  assert.equal(summary.success, 1);
  assert.equal(summary.failure, 3);
  assert.deepEqual(summary.deadTokens, ["t1"], "solo il token davvero morto va cancellato");
  assert.deepEqual(summary.errorCodes, ["messaging/invalid-argument"], "codici unici, e solo quelli non da token morto");
});

test("pushDelivery ha numeri puliti e al massimo cinque codici", () => {
  const row = buildPushDelivery({
    status: "failed",
    tokens: "2",
    success: -1,
    failure: 2.7,
    errorCodes: ["a", "b", "c", "d", "e", "f"],
  });
  assert.deepEqual(row, {
    status: "failed",
    tokens: 2,
    success: 0,
    failure: 2,
    deadTokens: 0,
    errorCodes: ["a", "b", "c", "d", "e"],
  });
});
