#!/usr/bin/env node
"use strict";

/**
 * Backfill reversibile della SOLA baseline import per productTracking.
 *
 * Non inventa milestone di progresso storico: titleStates conserva soltanto
 * l'ultimo stato, quindi un backfill D1/D3/D7 sarebbe un lower-bound ambiguo.
 * Dopo questo seed, le nuove transizioni manuali sono registrate in modo esatto
 * da applyTitleStateAction.
 *
 * Uso:
 *   node scripts/backfill-product-tracking-import-cohorts.js
 *   node scripts/backfill-product-tracking-import-cohorts.js --write
 *   node scripts/backfill-product-tracking-import-cohorts.js --rollback
 */

const admin = require("firebase-admin");
const {
  buildSuccessfulImportTrackingState,
  normalizeTrackingState,
} = require("../lib/productTracking");

const WRITE = process.argv.includes("--write");
const ROLLBACK = process.argv.includes("--rollback");
const MIGRATION_VERSION = 1;

if (WRITE && ROLLBACK) {
  throw new Error("Scegli --write oppure --rollback, non entrambi.");
}

admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || "gia-visto" });
const db = admin.firestore();

function ms(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return 0;
}

function isExcluded(uid, user = {}) {
  const configured = new Set(
    `${process.env.ADMIN_UIDS || ""},${process.env.ANALYTICS_EXCLUDED_UIDS || ""}`
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  return !uid
    || configured.has(uid)
    || String(uid).startsWith("guided_")
    || user.accountType === "guided"
    || user.isSynthetic === true
    || user.isAdmin === true
    || user.deleted === true;
}

function hasRealImportedTitles(row = {}) {
  return Number(row.importedTitleCount || 0) > 0
    || (Array.isArray(row.titleStateIdsWritten) && row.titleStateIdsWritten.length > 0);
}

function firestorePayload(stateRaw) {
  const state = normalizeTrackingState(stateRaw);
  const timestamp = (value) => value > 0 ? admin.firestore.Timestamp.fromMillis(value) : null;
  return {
    schemaVersion: state.schemaVersion,
    cohortOrigin: state.cohortOrigin || "legacy_backfill",
    migrationVersion: MIGRATION_VERSION,
    firstSuccessfulImportAt: timestamp(state.firstSuccessfulImportAtMs),
    lastSuccessfulImportAt: timestamp(state.lastSuccessfulImportAtMs),
    updatedAt: timestamp(state.updatedAtMs),
    expiresAt: timestamp(state.expiresAtMs),
  };
}

async function commitInChunks(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const batch = db.batch();
    ops.slice(i, i + 400).forEach((apply) => apply(batch));
    // eslint-disable-next-line no-await-in-loop
    await batch.commit();
  }
}

(async () => {
  const [usersSnap, importsSnap] = await Promise.all([
    db.collection("users").get(),
    db.collectionGroup("imports").get(),
  ]);
  const users = new Map(usersSnap.docs.map((doc) => [doc.id, doc.data() || {}]));
  const importsByUid = new Map();

  for (const doc of importsSnap.docs) {
    const uid = doc.ref.parent.parent?.id || "";
    const row = doc.data() || {};
    if (isExcluded(uid, users.get(uid) || {})) continue;
    if (row.dryRun === true || String(row.status || "") !== "completed") continue;
    if (!hasRealImportedTitles(row)) continue;
    if (!importsByUid.has(uid)) importsByUid.set(uid, []);
    importsByUid.get(uid).push(row);
  }

  const refs = [...importsByUid.keys()]
    .map((uid) => db.collection("users").doc(uid).collection("_system").doc("productTracking"));
  const existing = new Map();
  for (let i = 0; i < refs.length; i += 300) {
    // eslint-disable-next-line no-await-in-loop
    const snaps = await db.getAll(...refs.slice(i, i + 300));
    snaps.forEach((snap) => {
      if (snap.exists) existing.set(snap.ref.parent.parent.id, snap.data() || {});
    });
  }

  const ops = [];
  let eligible = 0;
  let skippedNoTimestamp = 0;
  let skippedProspective = 0;
  let rollbackPreservedLive = 0;

  for (const [uid, rows] of importsByUid) {
    const ref = db.collection("users").doc(uid).collection("_system").doc("productTracking");
    const currentRaw = existing.get(uid) || {};
    const current = normalizeTrackingState(currentRaw);

    if (ROLLBACK) {
      if (current.cohortOrigin !== "legacy_backfill" || current.migrationVersion !== MIGRATION_VERSION) continue;
      const hasLiveProgress = current.firstManualProgressAtMs > 0;
      if (hasLiveProgress) {
        rollbackPreservedLive += 1;
        ops.push((batch) => batch.set(ref, {
          cohortOrigin: admin.firestore.FieldValue.delete(),
          migrationVersion: admin.firestore.FieldValue.delete(),
          firstSuccessfulImportAt: admin.firestore.FieldValue.delete(),
          lastSuccessfulImportAt: admin.firestore.FieldValue.delete(),
        }, { merge: true }));
      } else {
        ops.push((batch) => batch.delete(ref));
      }
      continue;
    }

    if (current.cohortOrigin === "prospective") {
      skippedProspective += 1;
      continue;
    }

    const completionTimes = rows
      .map((row) => ms(row.completedAt) || ms(row.updatedAt))
      .filter(Boolean)
      .sort((a, b) => a - b);
    if (!completionTimes.length) {
      skippedNoTimestamp += 1;
      continue;
    }
    eligible += 1;
    let next = currentRaw;
    for (const completedAtMs of completionTimes) {
      next = buildSuccessfulImportTrackingState(next, {
        completedAtMs,
        cohortOrigin: "legacy_backfill",
        migrationVersion: MIGRATION_VERSION,
      });
    }
    ops.push((batch) => batch.set(ref, firestorePayload(next), { merge: true }));
  }

  console.log(JSON.stringify({
    mode: ROLLBACK ? "rollback" : (WRITE ? "write" : "dry-run"),
    usersScanned: users.size,
    importersEligible: eligible,
    writesPlanned: ops.length,
    skippedNoTimestamp,
    skippedProspective,
    rollbackPreservedLive,
    migrationVersion: MIGRATION_VERSION,
  }, null, 2));

  if (WRITE || ROLLBACK) {
    await commitInChunks(ops);
    console.log(`Operazione completata: ${ops.length} documenti.`);
  } else {
    console.log("Dry-run: nessuna scrittura. Usa --write per applicare.");
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
