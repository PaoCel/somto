const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildClientErrorAlert,
  isAlreadyExistsError,
  safePagePath,
} = require("../../lib/clientErrorAlert");

test("client error alert strips query data and never copies the raw error", () => {
  const plan = buildClientErrorAlert({
    errorId: "err_1",
    error: {
      message: "token segreto nel messaggio",
      source: "https://somto.it/js/app.js?uid=alice",
      page: "/title.html?id=private-title&token=secret",
    },
    nowMs: Date.parse("2026-08-22T12:00:00Z"),
  });

  assert.equal(plan.pagePath, "/title.html");
  assert.match(plan.notificationId, /^client_error_20260822_[a-f0-9]{16}$/);
  assert.equal(plan.data.message, "Errore web rilevato su /title.html");
  assert.equal(plan.data.clientErrorId, "err_1");
  assert.equal(JSON.stringify(plan.data).includes("segreto"), false);
  assert.equal(JSON.stringify(plan.data).includes("private-title"), false);
});

test("client error alert deduplicates the same fingerprint within a UTC day", () => {
  const input = { errorId: "a", error: { message: "boom", source: "/app.js", page: "/home.html" } };
  const first = buildClientErrorAlert({ ...input, nowMs: Date.parse("2026-08-22T01:00:00Z") });
  const second = buildClientErrorAlert({ ...input, errorId: "b", nowMs: Date.parse("2026-08-22T22:00:00Z") });
  const nextDay = buildClientErrorAlert({ ...input, nowMs: Date.parse("2026-08-23T01:00:00Z") });

  assert.equal(first.notificationId, second.notificationId);
  assert.notEqual(first.notificationId, nextDay.notificationId);
});

test("client error alert helpers fail closed", () => {
  assert.equal(safePagePath("https://evil.example/path?secret=1"), "/path");
  assert.equal(isAlreadyExistsError({ code: 6 }), true);
  assert.equal(isAlreadyExistsError({ code: "already-exists" }), true);
  assert.equal(isAlreadyExistsError(new Error("ALREADY EXISTS")), true);
  assert.equal(isAlreadyExistsError(new Error("permission denied")), false);
});
