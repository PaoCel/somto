const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const functionsDir = path.resolve(__dirname, "../..");

function run(args) {
  return spawnSync(process.execPath, ["scripts/apply-title-update-events.cjs", ...args], {
    cwd: functionsDir,
    encoding: "utf8",
  });
}

test("applicatore è dry-run di default e non richiede credenziali", () => {
  const result = run(["--input", "test/fixtures/title-update-candidates.json", "--publish-eligible"]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.mode, "dry-run");
  assert.equal(output.project, null);
  assert.equal(output.notificationFanout, false);
  assert.equal(output.selection, "candidateIdsInWindow");
  assert.equal(output.selectedCandidates, 1);
  assert.equal(output.report.previewed, 1);
  assert.equal(output.report.results[0].document.status, "published");
  assert.equal(output.report.results[0].document.notificationEligible, false);
});

test("applicatore rispetta una finestra vuota e non importa lo storico", () => {
  const result = run(["--input", "test/fixtures/title-update-candidates.json", "--publish-eligible", "--limit", "1"]);
  assert.equal(result.status, 0, result.stderr);
  const baseline = JSON.parse(result.stdout);
  assert.equal(baseline.report.previewed, 1);

  const emptyWindowPath = path.resolve(functionsDir, "test/fixtures/title-update-candidates-empty-window.json");
  const empty = run(["--input", emptyWindowPath, "--publish-eligible"]);
  assert.equal(empty.status, 0, empty.stderr);
  const output = JSON.parse(empty.stdout);
  assert.equal(output.selection, "candidateIdsInWindow");
  assert.equal(output.inputCandidates, 1);
  assert.equal(output.selectedCandidates, 0);
  assert.equal(output.report.previewed, 0);
});

test("applicatore rifiuta produzione prima di inizializzare Firebase", () => {
  const result = run([
    "--input", "test/fixtures/title-update-candidates.json",
    "--project", "gia-visto",
    "--apply",
    "--confirm", "gia-visto",
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /consente solo somto-staging/);
});

test("scrittura staging richiede conferma testuale esatta", () => {
  const result = run([
    "--input", "test/fixtures/title-update-candidates.json",
    "--project", "somto-staging",
    "--apply",
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Conferma mancante/);
});
