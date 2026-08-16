#!/usr/bin/env node
/**
 * backfill-title-slugs.js
 *
 * Computes a human-readable `slug` for every document in the `titles`
 * collection and writes it back. The slug powers the public SSR URLs
 *   /film/{slug}   and   /serie/{slug}
 * served by the `titlePage` Cloud Function.
 *
 * Slug rules live in functions/modules/titleSlug.js (`slugify`).
 *
 * Collisions: when two titles produce the same base slug, the documents are
 * ordered by their Firestore document id and get "-2", "-3", … appended in
 * that order. The first (lowest docId) keeps the bare base slug.
 *
 * Idempotent & re-runnable: a full run is deterministic, so re-running yields
 * the same slugs. A doc is only written when its computed slug differs from
 * the one already stored, so a no-op re-run performs zero writes.
 *
 * Usage:
 *   cd functions
 *   node scripts/backfill-title-slugs.js            # dry-run (default, no writes)
 *   node scripts/backfill-title-slugs.js --write    # apply the slug field
 *
 * Notes:
 * - Admin SDK, project `gia-visto` — same init pattern as the other scripts.
 * - Batched writes, max 500 ops per batch.
 */

const admin = require("firebase-admin");
const { slugify, resolveUniqueSlug } = require("../modules/titleSlug.js");

const WRITE = process.argv.includes("--write");
const PAGE_SIZE = 400;
const MAX_BATCH_OPS = 500;

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

async function main() {
  console.log(`backfill-title-slugs — ${WRITE ? "WRITE" : "DRY-RUN"}`);

  // ---- 1) load every title (id + name + year + current slug) --------------
  // Documents are streamed in document-id order so the collision tie-break is
  // fully deterministic and stable across runs.
  const titles = [];
  let lastDoc = null;
  let hasMore = true;
  while (hasMore) {
    let query = db
      .collection("titles")
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(PAGE_SIZE);
    if (lastDoc) query = query.startAfter(lastDoc);
    const snap = await query.get();
    if (snap.empty) break;
    for (const docSnap of snap.docs) {
      const data = docSnap.data() || {};
      titles.push({
        id: docSnap.id,
        ref: docSnap.ref,
        name: data.name || data.originalName || "",
        year: data.year,
        currentSlug: typeof data.slug === "string" ? data.slug : "",
      });
    }
    lastDoc = snap.docs[snap.docs.length - 1];
    hasMore = snap.size === PAGE_SIZE;
    console.log(`  loaded ${titles.length} titles…`);
  }
  console.log(`Totale titoli: ${titles.length}`);

  // ---- 2) assign collision-free slugs deterministically -------------------
  // titles[] is already ordered by docId from the paginated read above.
  const takenSlugs = new Set();
  let computed = 0;
  let emptyBase = 0;
  for (const title of titles) {
    const base = slugify(title.name, title.year);
    if (!base) {
      // No alphanumeric name and no positive year — fall back to the docId,
      // which is unique by construction. Keeps the URL resolvable.
      title.slug = title.id;
      emptyBase += 1;
    } else {
      title.slug = resolveUniqueSlug(base, takenSlugs);
    }
    takenSlugs.add(title.slug);
    computed += 1;
  }
  console.log(`Slug calcolati: ${computed} (fallback su docId: ${emptyBase})`);

  // ---- 3) figure out which docs actually need a write ---------------------
  const toWrite = titles.filter((t) => t.slug !== t.currentSlug);
  console.log(`Titoli da aggiornare: ${toWrite.length} (invariati: ${titles.length - toWrite.length})`);

  if (!WRITE) {
    const sample = toWrite.slice(0, 15);
    for (const t of sample) {
      console.log(`  ${t.id}: ${t.currentSlug || "∅"} -> ${t.slug}`);
    }
    if (toWrite.length > sample.length) {
      console.log(`  … e altri ${toWrite.length - sample.length}`);
    }
    console.log("\n[dry-run] nessuna scrittura. Riesegui con --write per applicare.");
    return;
  }

  // ---- 4) batched writes (<=500 ops/batch) --------------------------------
  let batch = db.batch();
  let ops = 0;
  let written = 0;
  for (const t of toWrite) {
    batch.set(
      t.ref,
      {
        slug: t.slug,
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
    console.error("Errore backfill slug:", err);
    process.exit(1);
  });
