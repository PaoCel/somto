const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_AUTO_APPROVE_THRESHOLD,
  MIN_AUTO_APPROVE_THRESHOLD,
  resolveAutoApproveThreshold,
  unorderedPairKey,
  countDistinctProposers,
  shouldAutoApprove,
} = require("../../lib/relatedSuggestions");

test("soglia default e override via env", () => {
  assert.equal(resolveAutoApproveThreshold({}), DEFAULT_AUTO_APPROVE_THRESHOLD);
  assert.equal(resolveAutoApproveThreshold({ RELATED_SUGGESTION_AUTO_APPROVE_THRESHOLD: "5" }), 5);
  assert.equal(resolveAutoApproveThreshold({ RELATED_SUGGESTION_AUTO_APPROVE_THRESHOLD: "5.9" }), 5);
});

test("un override sotto la soglia minima torna al default", () => {
  assert.equal(resolveAutoApproveThreshold({ RELATED_SUGGESTION_AUTO_APPROVE_THRESHOLD: "1" }), DEFAULT_AUTO_APPROVE_THRESHOLD);
  assert.equal(resolveAutoApproveThreshold({ RELATED_SUGGESTION_AUTO_APPROVE_THRESHOLD: "0" }), DEFAULT_AUTO_APPROVE_THRESHOLD);
  assert.equal(resolveAutoApproveThreshold({ RELATED_SUGGESTION_AUTO_APPROVE_THRESHOLD: "abc" }), DEFAULT_AUTO_APPROVE_THRESHOLD);
  assert.equal(MIN_AUTO_APPROVE_THRESHOLD, 2);
});

test("la chiave coppia e' la stessa in entrambe le direzioni", () => {
  assert.equal(unorderedPairKey("a", "b"), unorderedPairKey("b", "a"));
  assert.notEqual(unorderedPairKey("a", "b"), unorderedPairKey("a", "c"));
});

test("conta i proponenti distinti, non i documenti", () => {
  assert.equal(countDistinctProposers([{ uid: "u1" }, { uid: "u1" }, { uid: "u2" }]), 2);
  assert.equal(countDistinctProposers([]), 0);
  assert.equal(countDistinctProposers([{ uid: "" }, { uid: null }]), 0);
});

test("shouldAutoApprove confronta contro la soglia", () => {
  assert.equal(shouldAutoApprove(3, 3), true);
  assert.equal(shouldAutoApprove(2, 3), false);
  assert.equal(shouldAutoApprove(4, 3), true);
  assert.equal(shouldAutoApprove(0, DEFAULT_AUTO_APPROVE_THRESHOLD), false);
});
