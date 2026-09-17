#!/usr/bin/env node
/**
 * Scanner read-only per candidati aggiornamento titolo.
 *
 * Non contiene opzioni di scrittura, non usa la cache Firestore TMDB e non
 * pubblica eventi/notifiche. Il progetto predefinito è staging.
 *
 * Esempi:
 *   TMDB_KEY=... node scripts/scan-title-updates.cjs --fixture ./titles.json --include-candidates
 *   TMDB_KEY=... node scripts/scan-title-updates.cjs --project somto-staging --title-id ted-lasso
 */

const fs = require("fs");
const path = require("path");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { fetchTmdbCachedJson, getTmdbApiKey } = require("../modules/tmdb");
const {
  filterCandidatesByWindow,
  normalizeTitleForUpdateScan,
  scanTitleForUpdateCandidates,
  summarizeTitleUpdateScan,
} = require("../lib/titleUpdateScanner");

const args = yargs(hideBin(process.argv))
  .strict()
  .option("project", { type: "string", default: "somto-staging", describe: "Firebase project (sole letture titles)" })
  .option("fixture", { type: "string", describe: "JSON locale con array titles; evita Firestore" })
  .option("title-id", { type: "array", string: true, default: [], describe: "Uno o più document ID da leggere" })
  .option("limit", { type: "number", default: 10, describe: "Massimo titoli (1-50)" })
  .option("since-days", { type: "number", default: 180, describe: "Finestra recente per il report (1-365)" })
  .option("future-days", { type: "number", default: 365, describe: "Orizzonte uscite future nel report (1-730)" })
  .option("max-api-calls", { type: "number", default: 60, describe: "Circuit breaker locale (6-300)" })
  .option("include-candidates", { type: "boolean", default: false, describe: "Include i candidati nel JSON finale" })
  .help()
  .parseSync();

function clampInteger(value, min, max) {
  return Math.max(min, Math.min(max, Math.floor(Number(value) || min)));
}

function readFixture(filePath) {
  const resolved = path.resolve(String(filePath));
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  const rows = Array.isArray(parsed) ? parsed : parsed?.titles;
  if (!Array.isArray(rows)) throw new Error("La fixture deve essere un array o { titles: [...] }");
  const responses = (!Array.isArray(parsed) && parsed?.responses && typeof parsed.responses === "object")
    ? parsed.responses
    : null;
  return { titles: rows.map(normalizeTitleForUpdateScan).filter(Boolean), responses };
}

function fixtureResponseKey(tmdbPath, params = {}) {
  return `${tmdbPath}|${params.language || "global"}`;
}

async function readFirestoreTitles({ projectId, titleIds, limit }) {
  initializeApp({ projectId });
  const db = getFirestore();
  if (titleIds.length) {
    const snapshots = await Promise.all(titleIds.slice(0, limit).map((id) => db.collection("titles").doc(String(id)).get()));
    return snapshots.filter((snap) => snap.exists).map((snap) => normalizeTitleForUpdateScan({ id: snap.id, ...snap.data() })).filter(Boolean);
  }
  const snap = await db.collection("titles").where("tmdbId", ">", 0).orderBy("tmdbId").limit(limit).get();
  return snap.docs.map((doc) => normalizeTitleForUpdateScan({ id: doc.id, ...doc.data() })).filter(Boolean);
}

async function main() {
  const limit = clampInteger(args.limit, 1, 50);
  const sinceDays = clampInteger(args.sinceDays, 1, 365);
  const futureDays = clampInteger(args.futureDays, 1, 730);
  const maxApiCalls = clampInteger(args.maxApiCalls, 6, 300);
  const projectId = String(args.project || "somto-staging").trim() || "somto-staging";
  const titleIds = args.titleId.map((value) => String(value).trim()).filter(Boolean);
  const fixture = args.fixture ? readFixture(args.fixture) : null;
  if (!fixture?.responses && !getTmdbApiKey()) {
    throw new Error("TMDB_KEY/TMDB_API_KEY mancante (oppure usa una fixture con responses)");
  }
  const titles = fixture
    ? fixture.titles.slice(0, limit)
    : await readFirestoreTitles({ projectId, titleIds, limit });

  const state = { maxApiCalls: Math.max(20, maxApiCalls), maxAttempts: 3 };
  let localApiCalls = 0;
  const fetchJson = async (tmdbPath, params) => {
    if (fixture?.responses) {
      const key = fixtureResponseKey(tmdbPath, params);
      if (!Object.prototype.hasOwnProperty.call(fixture.responses, key)) {
        throw new Error(`Risposta fixture mancante: ${key}`);
      }
      return fixture.responses[key] || {};
    }
    if (localApiCalls >= maxApiCalls) throw new Error(`Limite locale TMDB raggiunto (${maxApiCalls})`);
    localApiCalls += 1;
    const result = await fetchTmdbCachedJson(tmdbPath, params, {
      ttlSeconds: 0,
      allowStaleOnError: false,
      state,
      cacheScope: "titleUpdateDryRun",
    });
    return result?.data || {};
  };

  const results = [];
  for (const title of titles) {
    results.push(await scanTitleForUpdateCandidates({ title, fetchJson }));
  }

  const nowMs = Date.now();
  const sinceMs = nowMs - sinceDays * 24 * 60 * 60 * 1000;
  const untilMs = nowMs + futureDays * 24 * 60 * 60 * 1000;
  const summary = summarizeTitleUpdateScan(results, { sinceMs, untilMs, apiCalls: localApiCalls });
  const output = {
    mode: "dry-run",
    source: fixture?.responses ? "fixture" : "tmdb",
    project: args.fixture ? null : projectId,
    fixture: args.fixture ? path.resolve(String(args.fixture)) : null,
    generatedAt: new Date(nowMs).toISOString(),
    window: { since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString() },
    summary,
    errors: results.flatMap((row) => row.errors.map((error) => ({ titleId: row.title?.id || null, ...error }))),
  };

  if (args.includeCandidates) {
    output.candidates = results.flatMap((row) => row.candidates);
    output.candidateIdsInWindow = filterCandidatesByWindow(output.candidates, { sinceMs, untilMs }).map((row) => row.id);
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`scan-title-updates fallito: ${err?.message || err}\n`);
  process.exitCode = 1;
});
