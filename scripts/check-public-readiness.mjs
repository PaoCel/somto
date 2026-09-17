#!/usr/bin/env node
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const tracked = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const allowedEnvExamples = new Set([".env.example", "functions/.env.example"]);
const policyFiles = new Set([
  "scripts/check-public-readiness.mjs",
  "scripts/check-public-history.mjs",
]);
const forbiddenPathPatterns = [
  /(^|\/)\.DS_Store$/,
  /(^|\/)(?:firebase|firestore|pglite)-debug(?:\.[^.]+)?\.log$/,
  /(^|\/)service.?account/i,
  /(^|\/)app-store-screenshots\//i,
  /\.zip$/i,
  /\.(?:p8|p12|pem|key|jks|mobileprovision)$/i,
  /(^|\/)xcuserdata\//,
];
const forbiddenTextPatterns = [
  { label: "absolute macOS home path", regex: /\/Users\/[^/\s`"']+/ },
  { label: "private temporary path", regex: /\/private\/tmp\// },
  { label: "personal mailbox", regex: /@[A-Za-z0-9.-]*(?:icloud|gmail|outlook)\.com\b/i },
  { label: "real staging/review account", regex: /\b(?:staging\.qa\d*|claude\.qa|ios-review)@/i },
  { label: "billing account identifier", regex: /\b[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}\b/i },
  { label: "concrete UID in documentation", regex: /\buid\s+`[A-Za-z0-9_-]{20,40}`/i },
  { label: "concrete support thread identifier", regex: /\bsupport_[A-Za-z0-9_-]{20,40}\b/i },
];

const violations = [];
for (const file of tracked) {
  if (!fs.existsSync(file)) continue;
  const envLike = /(^|\/)\.env(?:\.|$)/.test(file);
  if (envLike && !allowedEnvExamples.has(file)) {
    violations.push(`${file}: environment file must not be tracked`);
  }
  for (const pattern of forbiddenPathPatterns) {
    if (pattern.test(file)) violations.push(`${file}: forbidden tracked path`);
  }

  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 5_000_000) continue;
  const content = fs.readFileSync(file);
  if (content.includes(0)) continue;
  if (policyFiles.has(file)) continue;
  const text = content.toString("utf8");
  for (const { label, regex } of forbiddenTextPatterns) {
    if (regex.test(text)) violations.push(`${file}: ${label}`);
  }
}

if (violations.length) {
  console.error("Public-readiness check failed:\n" + violations.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}

console.log(`Public-readiness check passed (${tracked.length} tracked files).`);
