#!/usr/bin/env node
/**
 * backfill-list-slugs.js
 *
 * Computes the `slug` field for every document in the `userLists` collection
 * that is missing one (or where the computed value has changed) and writes it
 * back via admin SDK.
 *
 * Slug rules live in functions/modules/listSlug.js (`computeListSlug`):
 *   - Editorial lists: reuse `editorialSlug` verbatim.
 *   - User lists: slugify(title) + "-" + last6(listId).
 *
 * Idempotent & re-runnable: a doc is only written when its computed slug
 * differs from the one already stored, so a no-op re-run performs zero writes.
 *
 * Usage:
 *   cd functions
 *   node scripts/backfill-list-slugs.js            # dry-run (default, no writes)
 *   node scripts/backfill-list-slugs.js --write    # apply the slug field
 *
 * Notes:
 * - Admin SDK, project `gia-visto`.
 * - Batched writes, max 500 ops per batch.
 * - Only processes public lists (visibility == "public") — private/shared lists
 *   do not get indexed pages and don't need a slug for the public URL.
 *   Remove the .where() filter below if you want slugs on all lists.
 */

const admin = require("firebase-admin");
const { computeListSlug } = require("../modules/listSlug.js");

const WRITE = process.argv.includes("--write");
const PAGE_SIZE = 300;
const MAX_BATCH_OPS = 500;

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

async function main() {
  console.log(`backfill-list-slugs — ${WRITE ? "WRITE" : "DRY-RUN"}`);

  // ---- 1) load all public userLists (id + title + editorialSlug + current slug) ----
  const lists = [];
  let lastDoc = null;
  let hasMore = true;

  while (hasMore) {
    let query = db
      .collection("userLists")
      .where("visibility", "==", "public")
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(PAGE_SIZE);
    if (lastDoc) query = query.startAfter(lastDoc);
    const snap = await query.get();
    if (snap.empty) break;
    for (const docSnap of snap.docs) {
      const data = docSnap.data() || {};
      lists.push({
        id: docSnap.id,
        ref: docSnap.ref,
        title: data.title || "",
        editorialSlug: typeof data.editorialSlug === "string" ? data.editorialSlug : "",
        currentSlug: typeof data.slug === "string" ? data.slug : "",
      });
    }
    lastDoc = snap.docs[snap.docs.length - 1];
    hasMore = snap.size === PAGE_SIZE;
    console.log(`  loaded ${lists.length} lists…`);
  }
  console.log(`Totale liste pubbliche: ${lists.length}`);

  // ---- 2) compute slugs -------------------------------------------------------
  let computed = 0;
  for (const list of lists) {
    list.slug = computeListSlug(list.id, { title: list.title, editorialSlug: list.editorialSlug });
    computed += 1;
  }
  console.log(`Slug calcolati: ${computed}`);

  // ---- 3) figure out which docs actually need a write ------------------------
  const toWrite = lists.filter((l) => l.slug !== l.currentSlug);
  console.log(`Liste da aggiornare: ${toWrite.length} (invariate: ${lists.length - toWrite.length})`);

  if (!WRITE) {
    const sample = toWrite.slice(0, 15);
    for (const l of sample) {
      console.log(`  ${l.id}: "${l.currentSlug || "∅"}" -> "${l.slug}"`);
    }
    if (toWrite.length > sample.length) {
      console.log(`  … e altre ${toWrite.length - sample.length}`);
    }
    console.log("\n[dry-run] nessuna scrittura. Riesegui con --write per applicare.");
    return;
  }

  // ---- 4) batched writes (<= 500 ops/batch) -----------------------------------
  let batch = db.batch();
  let ops = 0;
  let written = 0;
  for (const l of toWrite) {
    batch.set(
      l.ref,
      {
        slug: l.slug,
        slugUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
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

  console.log(`\nFatto. Slug scritti: ${written}.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Errore backfill list-slugs:", err);
    process.exit(1);
  });
