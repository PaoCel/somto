#!/usr/bin/env node
import { execFileSync } from "node:child_process";

function gitLogFilesMatching(regex) {
  const output = execFileSync(
    "git",
    ["log", "--all", "--pretty=format:", "--name-only", "-G", regex],
    { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 },
  );
  return [...new Set(output.split("\n").map((line) => line.trim()).filter(Boolean))].sort();
}

const checks = [
  {
    label: "personal mailbox",
    regex: "[A-Za-z0-9._%+-]+@(gmail|icloud|outlook|yahoo)\\.[A-Za-z]{2,}",
  },
  {
    label: "real staging or review account",
    regex: "(staging\\.qa[0-9]*|claude\\.qa|ios-review)@",
  },
  { label: "absolute macOS home path", regex: "/Users/[^/[:space:]`\\\"']+" },
  { label: "private temporary path", regex: "/private/tmp/" },
  {
    label: "billing account identifier",
    regex: "[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}",
  },
  {
    label: "concrete UID in documentation or scripts",
    regex: "uid[[:space:]]+`?[A-Za-z0-9_-]{20,40}`?",
  },
  {
    label: "identifier assignment in an operational script",
    regex: "[A-Za-z_]*[Uu][Ii][Dd][[:space:]]*[:=][[:space:]]*[\\\"'`][A-Za-z0-9_-]{20,40}",
    path: /^(?:functions\/scripts|scripts)\//,
  },
  {
    label: "concrete support thread identifier",
    regex: "support_[A-Za-z0-9_-]{20,40}",
  },
];

const violations = [];
for (const check of checks) {
  const files = gitLogFilesMatching(check.regex).filter((file) => !check.path || check.path.test(file));
  if (files.length) violations.push({ ...check, files });
}

if (violations.length) {
  console.error("Public-history check failed. Rewrite is required before changing visibility:");
  for (const violation of violations) {
    const shown = violation.files.slice(0, 12).join(", ");
    const suffix = violation.files.length > 12 ? ` (+${violation.files.length - 12} more)` : "";
    console.error(`- ${violation.label}: ${shown}${suffix}`);
  }
  console.error("See docs/PUBLIC_HISTORY_REWRITE.md. No matching values were printed.");
  process.exit(1);
}

console.log("Public-history check passed: no known PII patterns found in Git diffs.");
