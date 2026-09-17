import test from "node:test";
import assert from "node:assert/strict";

import { fetchFresh } from "../../scripts/smoke-production.mjs";

test("production smoke retries a transient network failure", async () => {
  let calls = 0;
  const response = await fetchFresh("https://somto.it/js/app.js", {
    attempts: 3,
    retryDelaysMs: [0, 0],
    fetchImpl: async () => {
      calls++;
      if (calls === 1) throw new TypeError("fetch failed");
      return { ok: true, status: 200 };
    },
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
});

test("production smoke retries 5xx but not a real 404", async () => {
  let transientCalls = 0;
  await fetchFresh("https://somto.it/", {
    attempts: 3,
    retryDelaysMs: [0, 0],
    fetchImpl: async () => {
      transientCalls++;
      return transientCalls < 3
        ? { ok: false, status: 503 }
        : { ok: true, status: 200 };
    },
  });
  assert.equal(transientCalls, 3);

  let permanentCalls = 0;
  await assert.rejects(() => fetchFresh("https://somto.it/missing.js", {
    attempts: 3,
    retryDelaysMs: [0, 0],
    fetchImpl: async () => {
      permanentCalls++;
      return { ok: false, status: 404 };
    },
  }), /HTTP 404/);
  assert.equal(permanentCalls, 1);
});
