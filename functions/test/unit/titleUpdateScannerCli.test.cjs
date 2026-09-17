const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("CLI fixture esegue un dry-run completo senza credenziali o scritture", () => {
  const functionsDir = path.resolve(__dirname, "../..");
  const result = spawnSync(process.execPath, [
    "scripts/scan-title-updates.cjs",
    "--fixture",
    "test/fixtures/title-updates-scan.json",
    "--include-candidates",
  ], {
    cwd: functionsDir,
    encoding: "utf8",
    env: { ...process.env, TMDB_KEY: "", TMDB_API_KEY: "" },
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.mode, "dry-run");
  assert.equal(output.source, "fixture");
  assert.equal(output.project, null);
  assert.equal(output.summary.readOnly, true);
  assert.equal(output.summary.titlesScanned, 1);
  assert.equal(output.summary.candidatesFound, 2);
  assert.equal(output.summary.apiCalls, 0);
  assert.deepEqual(output.candidates.map((row) => row.eventType).sort(), ["new_episode", "trailer"]);
});

test("CLI non espone accidentalmente un flag di scrittura", () => {
  const functionsDir = path.resolve(__dirname, "../..");
  const result = spawnSync(process.execPath, [
    "scripts/scan-title-updates.cjs",
    "--fixture",
    "test/fixtures/title-updates-scan.json",
    "--write",
  ], { cwd: functionsDir, encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown argument: write/);
});
