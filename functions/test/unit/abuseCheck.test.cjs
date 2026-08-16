const test = require("node:test");
const assert = require("node:assert/strict");

const { looksLikeAbuse, ABUSE_PATTERNS } = require("../../lib/abuseCheck");

test("pattern ids are unique", () => {
  const ids = ABUSE_PATTERNS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("flags direct threats (IT)", () => {
  const hit = looksLikeAbuse("Se lo ridici ti ammazzo, capito?");
  assert.ok(hit);
  assert.equal(hit.pattern, "it_threat_kill");
});

test("flags self-harm incitement (IT + EN)", () => {
  assert.ok(looksLikeAbuse("ammazzati e basta"));
  assert.ok(looksLikeAbuse("kys loser"));
  assert.ok(looksLikeAbuse("Kill  yourself"));
});

test("flags directed insults (IT)", () => {
  assert.ok(looksLikeAbuse("sei una merda, smettila di postare"));
  assert.ok(looksLikeAbuse("Sei un pezzo di merda"));
});

test("flags slurs", () => {
  assert.ok(looksLikeAbuse("stai zitto frocio"));
  assert.ok(looksLikeAbuse("you are a piece of shit"));
});

test("does NOT flag generic profanity about titles", () => {
  assert.equal(looksLikeAbuse("che film di merda, due ore buttate"), null);
  assert.equal(looksLikeAbuse("cavolo che finale pazzesco!"), null);
  assert.equal(looksLikeAbuse("il cattivo muore alla fine"), null);
});

test("does NOT flag innocent words containing substrings", () => {
  // "trota", "essei", parole che contengono sottostringhe di insulti
  assert.equal(looksLikeAbuse("una trota gigante nel documentario"), null);
  assert.equal(looksLikeAbuse("La serie è ambientata a Chinatown"), null);
});

test("handles empty/non-string input", () => {
  assert.equal(looksLikeAbuse(""), null);
  assert.equal(looksLikeAbuse(null), null);
  assert.equal(looksLikeAbuse(undefined), null);
  assert.equal(looksLikeAbuse(42), null);
});

test("match preview is capped at 80 chars", () => {
  const hit = looksLikeAbuse("ti ammazzo" + " davvero".repeat(50));
  assert.ok(hit);
  assert.ok(hit.match.length <= 80);
});
