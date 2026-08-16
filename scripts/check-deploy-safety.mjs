#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PROD_PROJECT_ID = "gia-visto";

function fail(message) {
  console.error(`[deploy-safety] BLOCKED: ${message}`);
  process.exit(1);
}

function info(message) {
  console.log(`[deploy-safety] ${message}`);
}

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function readMode() {
  const mode = String(process.argv[2] || "").trim().toLowerCase();
  if (!["staging", "prod", "production"].includes(mode)) {
    fail("uso: node scripts/check-deploy-safety.mjs <staging|prod>");
  }
  return mode === "production" ? "prod" : mode;
}

function requireGitRepo() {
  try {
    git(["rev-parse", "--show-toplevel"]);
  } catch {
    fail("non sono dentro una repo git.");
  }
}

function currentBranch() {
  return git(["branch", "--show-current"]);
}

function statusPorcelain() {
  return git(["status", "--porcelain"]);
}

function expectedProjectFor(mode) {
  if (mode === "prod") return PROD_PROJECT_ID;
  const fromEnv = String(process.env.FIREBASE_STAGING_PROJECT || "").trim();
  if (fromEnv) return fromEnv;
  // Fallback: alias "staging" in .firebaserc (fonte unica di verità).
  try {
    const raw = readFileSync(new URL("../.firebaserc", import.meta.url), "utf8");
    return String(JSON.parse(raw)?.projects?.staging || "").trim();
  } catch {
    return "";
  }
}

function validateStaging(projectId) {
  if (!projectId) {
    fail("FIREBASE_STAGING_PROJECT mancante. Crea prima il progetto Firebase staging e imposta questa variabile.");
  }
  if (projectId === PROD_PROJECT_ID) {
    fail("FIREBASE_STAGING_PROJECT punta a prod. Staging deve essere un progetto Firebase separato.");
  }
  if (projectId.startsWith("demo-")) {
    fail("staging non deve essere un project id demo/emulatore.");
  }
}

function validateProd(projectId) {
  if (projectId !== PROD_PROJECT_ID) {
    fail(`project prod atteso ${PROD_PROJECT_ID}, ricevuto ${projectId || "(vuoto)"}.`);
  }

  const branch = currentBranch();
  if (branch !== "main" && process.env.ALLOW_NON_MAIN_PROD !== "1") {
    fail(`prod si deploya da main. Branch attuale: ${branch || "(detached)"}.`);
  }

  const dirty = statusPorcelain();
  if (dirty && process.env.ALLOW_DIRTY_PROD !== "1") {
    fail("working tree sporco. Commit/stash prima di deployare prod.");
  }

  if (process.env.CONFIRM_PROD !== PROD_PROJECT_ID) {
    fail(`per prod serve conferma esplicita: CONFIRM_PROD=${PROD_PROJECT_ID}.`);
  }
}

function main() {
  const mode = readMode();
  requireGitRepo();

  const projectId = expectedProjectFor(mode);
  if (mode === "staging") validateStaging(projectId);
  if (mode === "prod") validateProd(projectId);

  const dirty = statusPorcelain();
  if (mode === "staging" && dirty && process.env.ALLOW_DIRTY_STAGING !== "1") {
    fail("working tree sporco. Per staging usa ALLOW_DIRTY_STAGING=1 solo se sai cosa stai testando.");
  }

  info(`${mode} ok: project=${projectId}`);
}

main();
