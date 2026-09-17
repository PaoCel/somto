#!/usr/bin/env node

import { build } from "esbuild";
import { pathToFileURL } from "node:url";

const target = new URL(process.argv[2] || "https://somto.it");
const origin = target.origin;
const isProduction = origin === "https://somto.it";
const REQUEST_TIMEOUT_MS = 15_000;
const REQUEST_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [300, 1_200];
const MAX_MODULE_BYTES = 2 * 1024 * 1024;

const criticalPages = [
  "/",
  "/login.html",
  "/home.html",
  "/community.html",
  "/search.html",
  "/title.html",
  "/watchlist.html",
  "/quiz.html",
  "/service-worker.js",
];

const criticalEntries = [
  "/js/pages/login.page.js",
  "/js/pages/home.page.js",
  "/js/pages/community.page.js",
  "/js/pages/search.page.js",
  "/js/pages/title.page.js",
  "/js/pages/watchlist.page.js",
  "/js/pages/quiz.page.js",
];

function fail(message) {
  throw new Error(`[production-smoke] ${message}`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryableStatus(status) {
  const code = Number(status || 0);
  return code === 408 || code === 425 || code === 429 || code >= 500;
}

export async function fetchFresh(url, {
  fetchImpl = globalThis.fetch,
  attempts = REQUEST_ATTEMPTS,
  timeoutMs = REQUEST_TIMEOUT_MS,
  retryDelaysMs = RETRY_DELAYS_MS,
} = {}) {
  let lastError = null;
  const cappedAttempts = Math.max(1, Math.min(5, Number(attempts) || REQUEST_ATTEMPTS));
  for (let attempt = 1; attempt <= cappedAttempts; attempt++) {
    try {
      const response = await fetchImpl(url, {
        redirect: "follow",
        headers: {
          "cache-control": "no-cache",
          pragma: "no-cache",
          "user-agent": "SomtoProductionSmoke/1.0",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return response;
      const error = new Error(`${url} ha risposto HTTP ${response.status}`);
      error.status = response.status;
      if (!retryableStatus(response.status)) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (error?.status && !retryableStatus(error.status)) throw error;
    }
    if (attempt < cappedAttempts) {
      await wait(Number(retryDelaysMs[attempt - 1] || 0));
    }
  }
  throw lastError || new Error(`${url} fetch fallita`);
}

async function checkPages() {
  let homeHeaders = null;
  for (const path of criticalPages) {
    const url = new URL(path, origin);
    const response = await fetchFresh(url);
    const body = await response.text();
    if (!body.trim()) fail(`${url} ha restituito un body vuoto`);
    if (path === "/home.html") homeHeaders = response.headers;
  }

  if (!isProduction) return;
  const csp = homeHeaders?.get("content-security-policy") || "";
  const reportOnly = homeHeaders?.get("content-security-policy-report-only") || "";
  for (const directive of ["object-src 'none'", "base-uri 'self'", "frame-ancestors 'self'"]) {
    if (!csp.includes(directive)) fail(`header CSP enforcing privo di: ${directive}`);
  }
  if (reportOnly) fail("la vecchia CSP Report-Only e' ancora servita");
  if (!homeHeaders?.get("strict-transport-security")) fail("header HSTS mancante");
  if (homeHeaders?.get("x-content-type-options") !== "nosniff") fail("header nosniff mancante");
}

function remoteModulesPlugin() {
  const loaded = new Set();
  return {
    name: "somto-remote-modules",
    setup(builder) {
      function resolveRemote(raw, importer = origin) {
        const resolved = new URL(raw, importer);
        if (resolved.origin !== origin) return { path: resolved.href, external: true };
        resolved.search = "";
        resolved.hash = "";
        return { path: resolved.href, namespace: "somto-http" };
      }

      builder.onResolve({ filter: /^https?:\/\// }, (args) => resolveRemote(args.path));
      builder.onResolve({ filter: /.*/, namespace: "somto-http" }, (args) => {
        if (/^(?:data|blob):/.test(args.path)) return { path: args.path, external: true };
        return resolveRemote(args.path, args.importer);
      });

      builder.onLoad({ filter: /.*/, namespace: "somto-http" }, async (args) => {
        const response = await fetchFresh(args.path);
        const contents = await response.text();
        if (Buffer.byteLength(contents, "utf8") > MAX_MODULE_BYTES) {
          fail(`modulo troppo grande: ${args.path}`);
        }
        loaded.add(args.path);
        const pathname = new URL(args.path).pathname;
        const loader = pathname.endsWith(".json") ? "json" : pathname.endsWith(".css") ? "css" : "js";
        return { contents, loader };
      });

      builder.onEnd(() => {
        console.log(`[production-smoke] grafo remoto valido: ${loaded.size} moduli`);
      });
    },
  };
}

async function checkRemoteModuleGraph() {
  await build({
    entryPoints: criticalEntries.map((path) => new URL(path, origin).href),
    bundle: true,
    write: false,
    outdir: "smoke-out",
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "warning",
    logOverride: { "duplicate-object-key": "error" },
    plugins: [remoteModulesPlugin()],
  });
}

export async function runProductionSmoke() {
  await checkPages();
  await checkRemoteModuleGraph();
  console.log(`[production-smoke] PASS ${origin}`);
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await runProductionSmoke();
