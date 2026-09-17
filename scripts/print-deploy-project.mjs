#!/usr/bin/env node

import { readFileSync } from "node:fs";

const PROD_PROJECT_ID = "gia-visto";

const mode = String(process.argv[2] || "").trim().toLowerCase();

if (mode === "prod" || mode === "production") {
  process.stdout.write(PROD_PROJECT_ID);
  process.exit(0);
}

if (mode === "staging") {
  let projectId = String(process.env.FIREBASE_STAGING_PROJECT || "").trim();
  if (!projectId) {
    // Fallback: alias "staging" in .firebaserc (fonte unica di verità).
    try {
      const rc = JSON.parse(readFileSync(new URL("../.firebaserc", import.meta.url), "utf8"));
      projectId = String(rc?.projects?.staging || "").trim();
    } catch {}
  }
  if (!projectId) {
    console.error("FIREBASE_STAGING_PROJECT mancante e nessun alias 'staging' in .firebaserc.");
    process.exit(1);
  }
  process.stdout.write(projectId);
  process.exit(0);
}

console.error("uso: node scripts/print-deploy-project.mjs <staging|prod>");
process.exit(1);
