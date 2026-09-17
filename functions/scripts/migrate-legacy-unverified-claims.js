#!/usr/bin/env node
"use strict";

/**
 * Migrazione reversibile del claim legacyEmailUnverified.
 *
 * Dry-run aggregato (default):
 *   node scripts/migrate-legacy-unverified-claims.js \
 *     --project gia-visto --cutoff 2026-08-22T00:00:00Z
 *
 * Apply (gate esplicito, manifest obbligatorio fuori dal repository):
 *   ... --execute --confirm-project gia-visto --manifest /secure/path/manifest.json
 *
 * Rollback dal manifest:
 *   node scripts/migrate-legacy-unverified-claims.js --project gia-visto \
 *     --rollback-manifest /secure/path/manifest.json --execute --confirm-project gia-visto
 */

const { readFileSync, writeFileSync } = require("fs");
const path = require("path");
const admin = require("firebase-admin");
const { providerIdsForAuthUser } = require("../lib/signupSecurity");

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

const projectId = argumentValue("--project");
const cutoffRaw = argumentValue("--cutoff");
const confirmProject = argumentValue("--confirm-project");
const manifestPath = argumentValue("--manifest");
const rollbackManifestPath = argumentValue("--rollback-manifest");
const execute = process.argv.includes("--execute");
const batchSize = Math.min(50, Math.max(1, Number(argumentValue("--batch-size") || 25)));
const repoRoot = path.resolve(__dirname, "../..");

if (!projectId) {
  console.error("Uso: --project <id> --cutoff <ISO> oppure --rollback-manifest <file>");
  process.exit(2);
}
if (execute && confirmProject !== projectId) {
  console.error("Esecuzione bloccata: --confirm-project deve coincidere esattamente con --project.");
  process.exit(2);
}
if (!rollbackManifestPath && !cutoffRaw) {
  console.error("Dry-run/apply richiede --cutoff <timestamp ISO>.");
  process.exit(2);
}

const cutoffMs = cutoffRaw ? Date.parse(cutoffRaw) : 0;
if (!rollbackManifestPath && (!Number.isFinite(cutoffMs) || cutoffMs <= 0 || cutoffMs >= Date.now())) {
  console.error("--cutoff deve essere un timestamp ISO valido e nel passato.");
  process.exit(2);
}

function assertManifestOutsideRepo(value, label) {
  const resolved = path.resolve(value || "");
  if (!value || resolved === repoRoot || resolved.startsWith(`${repoRoot}${path.sep}`)) {
    console.error(`${label} deve essere un percorso esplicito fuori dal repository.`);
    process.exit(2);
  }
  return resolved;
}

const resolvedManifestPath = execute && !rollbackManifestPath
  ? assertManifestOutsideRepo(manifestPath, "--manifest")
  : null;
const resolvedRollbackPath = rollbackManifestPath
  ? assertManifestOutsideRepo(rollbackManifestPath, "--rollback-manifest")
  : null;

admin.initializeApp({ projectId });
const db = admin.firestore();

async function listAllUsers() {
  const users = [];
  let pageToken;
  do {
    // eslint-disable-next-line no-await-in-loop
    const page = await admin.auth().listUsers(1000, pageToken);
    users.push(...page.users);
    pageToken = page.pageToken;
  } while (pageToken);
  return users;
}

async function existingProfileUids(users) {
  const result = new Set();
  for (let offset = 0; offset < users.length; offset += 100) {
    const refs = users.slice(offset, offset + 100).map((user) => db.collection("users").doc(user.uid));
    // eslint-disable-next-line no-await-in-loop
    const snapshots = refs.length ? await db.getAll(...refs) : [];
    snapshots.filter((snap) => snap.exists).forEach((snap) => result.add(snap.id));
  }
  return result;
}

async function buildPlan() {
  const [users, adminProfiles] = await Promise.all([
    listAllUsers(),
    db.collection("users").where("isAdmin", "==", true).get(),
  ]);
  const profiles = await existingProfileUids(users);
  const adminUids = new Set(adminProfiles.docs.map((snap) => snap.id));
  const candidates = [];
  const skipped = {
    afterCutoff: 0,
    verified: 0,
    nonPassword: 0,
    noProfile: 0,
    admin: 0,
    synthetic: 0,
    alreadyClaimed: 0,
    invalidCreatedAt: 0,
  };

  for (const user of users) {
    const claims = user.customClaims || {};
    const createdAtMs = Date.parse(user.metadata?.creationTime || "");
    if (!Number.isFinite(createdAtMs)) { skipped.invalidCreatedAt += 1; continue; }
    if (createdAtMs > cutoffMs) { skipped.afterCutoff += 1; continue; }
    if (!providerIdsForAuthUser(user).includes("password")) { skipped.nonPassword += 1; continue; }
    if (user.emailVerified === true) { skipped.verified += 1; continue; }
    if (user.uid.startsWith("guided_") || claims.synthetic === true) { skipped.synthetic += 1; continue; }
    if (adminUids.has(user.uid) || claims.admin === true || claims.isAdmin === true) { skipped.admin += 1; continue; }
    if (!profiles.has(user.uid)) { skipped.noProfile += 1; continue; }
    if (claims.legacyEmailUnverified === true) { skipped.alreadyClaimed += 1; continue; }
    candidates.push({
      uid: user.uid,
      createdAt: new Date(createdAtMs).toISOString(),
      previousClaims: user.customClaims || {},
      nextClaims: { ...(user.customClaims || {}), legacyEmailUnverified: true },
    });
  }
  return { population: users.length, candidates, skipped, adminCount: adminUids.size };
}

async function applyPlan(plan) {
  const manifest = {
    schemaVersion: 1,
    projectId,
    cutoff: new Date(cutoffMs).toISOString(),
    createdAt: new Date().toISOString(),
    entries: plan.candidates.map(({ uid, previousClaims }) => ({ uid, previousClaims })),
  };
  writeFileSync(resolvedManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  let applied = 0;
  for (let offset = 0; offset < plan.candidates.length; offset += batchSize) {
    const batch = plan.candidates.slice(offset, offset + batchSize);
    // SetCustomUserClaims non offre transazioni: il manifest viene scritto
    // prima e ogni entry conserva l'intera mappa precedente per il rollback.
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(batch.map((row) => admin.auth().setCustomUserClaims(row.uid, row.nextClaims)));
    applied += batch.length;
  }
  return applied;
}

async function rollback() {
  const manifest = JSON.parse(readFileSync(resolvedRollbackPath, "utf8"));
  if (manifest.projectId !== projectId || !Array.isArray(manifest.entries)) {
    throw new Error("Manifest non valido o appartenente a un altro progetto.");
  }
  if (!execute) {
    return { mode: "rollback-dry-run", projectId, candidateCount: manifest.entries.length };
  }
  let restored = 0;
  for (let offset = 0; offset < manifest.entries.length; offset += batchSize) {
    const batch = manifest.entries.slice(offset, offset + batchSize);
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(batch.map((row) => admin.auth().setCustomUserClaims(row.uid, row.previousClaims || {})));
    restored += batch.length;
  }
  return { mode: "rollback-execute", projectId, restored };
}

async function main() {
  if (resolvedRollbackPath) {
    console.log(JSON.stringify(await rollback(), null, 2));
    return;
  }
  const plan = await buildPlan();
  const summary = {
    mode: execute ? "execute" : "dry-run",
    projectId,
    cutoff: new Date(cutoffMs).toISOString(),
    population: plan.population,
    adminCount: plan.adminCount,
    candidateCount: plan.candidates.length,
    skipped: plan.skipped,
    batchSize,
  };
  if (!execute) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const applied = await applyPlan(plan);
  console.log(JSON.stringify({ ...summary, applied, manifestPath: resolvedManifestPath }, null, 2));
}

main().catch((error) => {
  console.error("ERRORE:", String(error?.code || error?.message || error));
  process.exitCode = 1;
});
