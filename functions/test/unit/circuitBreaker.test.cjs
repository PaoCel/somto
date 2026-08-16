const test = require("node:test");
const assert = require("node:assert/strict");
const { withCircuitBreaker } = require("../../lib/circuitBreaker");

test("circuit closes after success", async () => {
  let calls = 0;
  const result = await withCircuitBreaker("ok", async () => {
    calls += 1;
    return 42;
  }, { failureThreshold: 2, coolDownMs: 2000 });
  assert.equal(result, 42);
  assert.equal(calls, 1);
});

test("circuit opens after consecutive failures", async () => {
  let attempts = 0;
  const key = "fail-key";
  await assert.rejects(() =>
    withCircuitBreaker(key, async () => {
      attempts += 1;
      throw new Error("boom");
    }, { failureThreshold: 2, coolDownMs: 5000 })
  );
  await assert.rejects(() =>
    withCircuitBreaker(key, async () => {
      attempts += 1;
      throw new Error("boom");
    }, { failureThreshold: 2, coolDownMs: 5000 })
  );
  await assert.rejects(() =>
    withCircuitBreaker(key, async () => 1)
  , /Circuit open/);
  assert.equal(attempts, 2);
});

test("expected errors do not open the circuit", async () => {
  const key = "not-counted-key";
  const opts = {
    failureThreshold: 2,
    coolDownMs: 5000,
    shouldCountFailure: (err) => err.code !== "EXPECTED",
  };
  const expected = () => {
    const err = new Error("nope");
    err.code = "EXPECTED";
    throw err;
  };

  for (let i = 0; i < 5; i++) {
    await assert.rejects(() => withCircuitBreaker(key, expected, opts), /nope/);
  }
  // Il circuito resta chiuso: i 404 attesi non devono bloccare gli altri consumatori.
  assert.equal(await withCircuitBreaker(key, async () => 9, opts), 9);
});

test("a real failure still counts when a predicate is set", async () => {
  const key = "mixed-key";
  const opts = {
    failureThreshold: 2,
    coolDownMs: 5000,
    shouldCountFailure: (err) => err.code !== "EXPECTED",
  };
  const expected = () => {
    const err = new Error("nope");
    err.code = "EXPECTED";
    throw err;
  };

  await assert.rejects(() => withCircuitBreaker(key, expected, opts));
  await assert.rejects(() => withCircuitBreaker(key, async () => { throw new Error("boom"); }, opts));
  await assert.rejects(() => withCircuitBreaker(key, expected, opts));
  await assert.rejects(() => withCircuitBreaker(key, async () => { throw new Error("boom"); }, opts));
  await assert.rejects(() => withCircuitBreaker(key, async () => 1, opts), /Circuit open/);
});

test("a throwing predicate counts the failure", async () => {
  const key = "bad-predicate-key";
  const opts = {
    failureThreshold: 1,
    coolDownMs: 5000,
    shouldCountFailure: () => { throw new Error("predicate exploded"); },
  };
  await assert.rejects(() => withCircuitBreaker(key, async () => { throw new Error("boom"); }, opts), /boom/);
  await assert.rejects(() => withCircuitBreaker(key, async () => 1, opts), /Circuit open/);
});

test("circuit allows again after cooldown", async () => {
  const key = "cooldown-key";
  await assert.rejects(() => withCircuitBreaker(key, async () => { throw new Error("fail"); }, { failureThreshold: 1, coolDownMs: 1200 }));
  // wait slightly longer than cooldown
  await new Promise((r) => setTimeout(r, 1300));
  const val = await withCircuitBreaker(key, async () => 7, { failureThreshold: 1, coolDownMs: 1200 });
  assert.equal(val, 7);
});
