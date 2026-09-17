#!/usr/bin/env node
/**
 * Backfill server-owned public projections for userLists.
 *
 * Dry-run by default:
 *   node scripts/backfill-public-user-lists.js
 *   node scripts/backfill-public-user-lists.js --write
 *   node scripts/backfill-public-user-lists.js --write --limit 200
 */
const admin = require("firebase-admin");
const { buildPublicUserListProjection } = require("../modules/publicUserLists");

const WRITE = process.argv.includes("--write");
const LIMIT = readNumberArg("--limit", 0);
const PROJECT_ID = readStringArg("--project")
  || process.env.GCLOUD_PROJECT
  || process.env.GOOGLE_CLOUD_PROJECT
  || "gia-visto";

admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();

function readStringArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return "";
  return String(process.argv[idx + 1] || "").trim();
}

function readNumberArg(name, fallback) {
  const raw = readStringArg(name);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

async function ownerUserFor(ownerUid) {
  const uid = String(ownerUid || "").trim();
  if (!uid) return {};
  const snap = await db.collection("users").doc(uid).get().catch(() => null);
  return snap?.exists ? (snap.data() || {}) : {};
}

function publicRef(listId) {
  return db.collection("publicUserLists").doc(listId);
}

async function writeOps(ops) {
  if (!WRITE || !ops.length) return;
  for (let i = 0; i < ops.length; i += 450) {
    const batch = db.batch();
    for (const op of ops.slice(i, i + 450)) {
      if (op.type === "set") batch.set(op.ref, op.data, { merge: false });
      if (op.type === "delete") batch.delete(op.ref);
    }
    await batch.commit();
  }
}

async function backfillPublicRoots() {
  let query = db.collection("userLists")
    .where("visibility", "==", "public")
    .orderBy(admin.firestore.FieldPath.documentId())
    .limit(250);
  let processed = 0;
  let written = 0;
  let lastDoc = null;

  while (true) {
    const snap = await (lastDoc ? query.startAfter(lastDoc).get() : query.get());
    if (snap.empty) break;
    const ops = [];
    for (const docSnap of snap.docs) {
      if (LIMIT && processed >= LIMIT) break;
      processed += 1;
      const listData = docSnap.data() || {};
      const ownerUser = await ownerUserFor(listData.ownerUid);
      const projection = buildPublicUserListProjection({
        listId: docSnap.id,
        listData,
        ownerUser,
        serverTimestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
      ops.push({ type: "set", ref: publicRef(docSnap.id), data: projection });
      written += 1;
    }
    await writeOps(ops);
    if ((LIMIT && processed >= LIMIT) || snap.docs.length < 250) break;
    lastDoc = snap.docs[snap.docs.length - 1];
  }

  return { processed, written };
}

async function cleanupStalePublicProjections() {
  let query = db.collection("publicUserLists")
    .orderBy(admin.firestore.FieldPath.documentId())
    .limit(250);
  let scanned = 0;
  let deleted = 0;
  let lastDoc = null;

  while (true) {
    const snap = await (lastDoc ? query.startAfter(lastDoc).get() : query.get());
    if (snap.empty) break;
    const rootRefs = snap.docs.map((docSnap) => db.collection("userLists").doc(docSnap.id));
    const rootSnaps = rootRefs.length ? await db.getAll(...rootRefs) : [];
    const ops = [];
    for (let i = 0; i < snap.docs.length; i += 1) {
      if (LIMIT && scanned >= LIMIT) break;
      scanned += 1;
      const rootSnap = rootSnaps[i];
      const rootData = rootSnap?.exists ? (rootSnap.data() || {}) : null;
      if (!rootData || rootData.visibility !== "public") {
        ops.push({ type: "delete", ref: snap.docs[i].ref });
        deleted += 1;
      }
    }
    await writeOps(ops);
    if ((LIMIT && scanned >= LIMIT) || snap.docs.length < 250) break;
    lastDoc = snap.docs[snap.docs.length - 1];
  }

  return { scanned, deleted };
}

async function main() {
  console.log(`backfill-public-user-lists - ${WRITE ? "WRITE" : "DRY-RUN"} - project ${PROJECT_ID}`);
  const publicRoots = await backfillPublicRoots();
  const cleanup = await cleanupStalePublicProjections();
  console.log(`public roots scanned: ${publicRoots.processed}, projections ${WRITE ? "written" : "to write"}: ${publicRoots.written}`);
  console.log(`public projections scanned: ${cleanup.scanned}, stale ${WRITE ? "deleted" : "to delete"}: ${cleanup.deleted}`);
  if (!WRITE) console.log("[dry-run] no writes. Re-run with --write after reviewing counts.");
}

main().catch((err) => {
  console.error("Errore backfill public user lists:", err);
  process.exitCode = 1;
});
