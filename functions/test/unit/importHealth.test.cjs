const test = require("node:test");
const assert = require("node:assert/strict");

const {
  diagnoseImportDoc,
  titlesWrittenFromDoc,
  importFailureErrorCount,
  computeParseErrorRatio,
} = require("../../lib/importHealth");

const NOW = new Date("2026-07-22T20:00:00Z").getTime();
const stamp = (ms) => ({ toMillis: () => ms });

test("import sano: nessun sintomo", () => {
  assert.deepEqual(diagnoseImportDoc({
    status: "completed", totalRows: 3138, matchedCount: 3121, importedTitleCount: 215,
  }, NOW), []);
});

test("completato con zero righe: e' il fallimento travestito da successo", () => {
  const s = diagnoseImportDoc({ status: "completed", totalRows: 0, importedTitleCount: 0 }, NOW);
  assert.deepEqual(s, ["zero righe lette"]);
});

test("righe lette ma nessun titolo scritto", () => {
  const s = diagnoseImportDoc({ status: "completed", totalRows: 500, matchedCount: 480, importedTitleCount: 0 }, NOW);
  assert.ok(s.includes("nessun titolo scritto"));
});

test("import vecchio senza importedTitleCount non viene dato per fallito", () => {
  // Il campo non esisteva: senza il ripiego, questo import (riuscito) sarebbe
  // stato segnalato come rotto — successo davvero, sul primo giro dello scan.
  const s = diagnoseImportDoc({
    status: "completed", totalRows: 5399, matchedCount: 5100,
  }, NOW);
  assert.deepEqual(s, []);
  assert.equal(titlesWrittenFromDoc({ status: "completed" }), null);
  assert.equal(titlesWrittenFromDoc({ titleStateIdsWritten: ["a", "b"] }), 2);
});

test("non terminale e fermo da oltre un'ora", () => {
  const s = diagnoseImportDoc({ status: "matching", totalRows: 100, updatedAt: stamp(NOW - 2 * 60 * 60 * 1000) }, NOW);
  assert.deepEqual(s, ["fermo da oltre un'ora"]);
});

test("non terminale ma appena aggiornato: sta lavorando, non e' un problema", () => {
  const s = diagnoseImportDoc({ status: "matching", totalRows: 100, updatedAt: stamp(NOW - 60 * 1000) }, NOW);
  assert.deepEqual(s, []);
});

test("match sotto meta' delle righe", () => {
  const s = diagnoseImportDoc({
    status: "awaiting_confirmation", totalRows: 1027, matchedCount: 341, importedTitleCount: 328,
  }, NOW);
  assert.equal(s.length, 1);
  assert.match(s[0], /33% delle righe risolte/);
});

test("import piccolo con match parziale non fa rumore", () => {
  const s = diagnoseImportDoc({ status: "completed", totalRows: 15, matchedCount: 5, importedTitleCount: 5 }, NOW);
  assert.deepEqual(s, []);
});

test("un fallimento conta sempre almeno un errore e conserva il massimo noto", () => {
  assert.equal(importFailureErrorCount([]), 1);
  assert.equal(importFailureErrorCount([{ reason: "a" }, { reason: "b" }]), 2);
  assert.equal(importFailureErrorCount([{ reason: "a" }], 7), 7);
});

test("parse error ratio gestisce zero, soglia 20% e input corrotti", () => {
  assert.equal(computeParseErrorRatio(0, []), 0);
  assert.equal(computeParseErrorRatio(4, [{ reason: "x" }]), 0.2);
  assert.equal(computeParseErrorRatio("bad", [{ reason: "x" }]), 1);
});
