#!/usr/bin/env node
/**
 * backfill-list-followers.js
 *
 * Recomputes `followersCount` on every `userLists/{listId}` document by
 * counting the number of `users/{uid}/savedLists/{listId}` sub-documents that
 * exist across all users.
 *
 * This is a one-shot repair script. Going forward the `syncListFollowersCount`
 * Firestore trigger maintains the counter incrementally.
 *
 * Usage:
 *   cd functions
 *   node scripts/backfill-list-followers.js            # dry-run (default)
 *   node scripts/backfill-list-followers.js --write    # apply followersCount
 *
 * Strategy:
 *   1. Scan `users/{uid}/savedLists` via collectionGroup query — reads the
 *      `listId` field to build a map { listId -> count }.
 *   2. Read each unique listId to compare the stored followersCount.
 *   3. Write only where the count has changed.
 *
 * Notes:
 * - Admin SDK, project `gia-visto`.
 * - Batched writes, max 500 ops per batch.
 * - collectionGroup("savedLists") requires a single-field index on `listId`
 *   OR we can simply scan all savedLists docs and count by doc id (the doc id
 *   IS the listId in users/{uid}/savedLists/{listId}). We use the doc-id
 *   approach to avoid needing a new index.
 */

const admin = require("firebase-admin");

const WRITE = process.argv.includes("--write");
const PAGE_SIZE = 500;
const MAX_BATCH_OPS = 400;

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

async function main() {
  console.log(`backfill-list-followers — ${WRITE ? "WRITE" : "DRY-RUN"}`);

  // ---- 1) Scan users/{uid}/savedLists collectionGroup ----------------------
  // The document id of each savedLists doc IS the listId — no extra field read.
  const countsMap = new Map(); // listId -> number
  let lastDoc = null;
  let hasMore = true;
  let totalScanned = 0;

  console.log("Scansione collectionGroup savedLists…");
  while (hasMore) {
    let query = db
      .collectionGroup("savedLists")
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(PAGE_SIZE);
    if (lastDoc) query = query.startAfter(lastDoc);
    const snap = await query.get();
    if (snap.empty) break;

    for (const docSnap of snap.docs) {
      // doc path: users/{uid}/savedLists/{listId}
      // The listId is either the doc id or the `listId` field (if present).
      const data = docSnap.data() || {};
      const listId = String(data.listId || docSnap.id || "").trim();
      if (!listId) continue;
      countsMap.set(listId, (countsMap.get(listId) || 0) + 1);
      totalScanned += 1;
    }

    lastDoc = snap.docs[snap.docs.length - 1];
    hasMore = snap.size === PAGE_SIZE;
    console.log(`  scansionati ${totalScanned} savedLists…`);
  }
  console.log(`Totale savedLists trovati: ${totalScanned}`);
  console.log(`Liste uniche con follower: ${countsMap.size}`);

  if (countsMap.size === 0) {
    console.log("Nessuna lista con follower trovata. Niente da fare.");
    return;
  }

  // ---- 2) Read current followersCount for each list ------------------------
  const listIds = [...countsMap.keys()];
  const toWrite = []; // { ref, newCount, currentCount }

  console.log(`Lettura followersCount per ${listIds.length} liste…`);
  // Process in chunks of 30 (admin getAll limit).
  for (let i = 0; i < listIds.length; i += 30) {
    const chunk = listIds.slice(i, i + 30);
    const refs = chunk.map((id) => db.collection("userLists").doc(id));
    const snaps = await db.getAll(...refs);
    for (let j = 0; j < snaps.length; j++) {
      const s = snaps[j];
      const listId = chunk[j];
      const expectedCount = countsMap.get(listId) || 0;
      if (!s.exists) {
        // List was deleted — skip.
        console.log(`  [skip] lista ${listId} non trovata (probabilmente cancellata)`);
        continue;
      }
      const currentCount = Number((s.data() || {}).followersCount) || 0;
      if (currentCount !== expectedCount) {
        toWrite.push({ ref: s.ref, newCount: expectedCount, currentCount, listId });
      }
    }
    console.log(`  verificate ${Math.min(i + 30, listIds.length)}/${listIds.length} liste…`);
  }

  console.log(`Liste da aggiornare: ${toWrite.length}`);

  if (!WRITE) {
    const sample = toWrite.slice(0, 15);
    for (const l of sample) {
      console.log(`  ${l.listId}: followersCount ${l.currentCount} -> ${l.newCount}`);
    }
    if (toWrite.length > sample.length) {
      console.log(`  … e altre ${toWrite.length - sample.length}`);
    }
    console.log("\n[dry-run] nessuna scrittura. Riesegui con --write per applicare.");
    return;
  }

  // ---- 3) Batched writes ---------------------------------------------------
  let batch = db.batch();
  let ops = 0;
  let written = 0;
  for (const l of toWrite) {
    batch.set(
      l.ref,
      {
        followersCount: l.newCount,
        followersCountUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    ops += 1;
    written += 1;
    if (ops >= MAX_BATCH_OPS) {
      await batch.commit();
      console.log(`  committed ${written}/${toWrite.length}`);
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) {
    await batch.commit();
    console.log(`  committed ${written}/${toWrite.length}`);
  }

  console.log(`\nFatto. followersCount aggiornati: ${written}.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Errore backfill list-followers:", err);
    process.exit(1);
  });
