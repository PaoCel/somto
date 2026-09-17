#!/usr/bin/env node
/**
 * backfill-rating-feed-thread-docs.js
 *
 * Backfill dei parent doc in /ratingFeed per i thread social dei rating title-level.
 *
 * Perché serve:
 * - i like/commenti vivono in sottocollezioni di /ratingFeed/{eventId}
 * - dopo l'hardening delle rules, queste sottocollezioni sono accessibili solo
 *   se esiste il parent doc del thread
 * - questo script riallinea i rating già esistenti senza toccare likes/commenti
 *
 * Uso:
 *   cd functions
 *   node scripts/backfill-rating-feed-thread-docs.js
 *   node scripts/backfill-rating-feed-thread-docs.js --write
 *   node scripts/backfill-rating-feed-thread-docs.js --write --limit 200
 *   node scripts/backfill-rating-feed-thread-docs.js --write --uid <uid>
 *   node scripts/backfill-rating-feed-thread-docs.js --write --titleId <titleId>
 */

const admin = require("firebase-admin");
const { initializeFirestore } = require("firebase-admin/firestore");

const WRITE = process.argv.includes("--write");
const LIMIT = getIntArg("--limit", 0);
const ONLY_UID = getStringArg("--uid", "");
const ONLY_TITLE_ID = getStringArg("--titleId", "");

const app = admin.initializeApp({ projectId: "gia-visto" });
const db = initializeFirestore(app, { preferRest: true });

function getIntArg(flag, fallback = 0) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0 || idx === process.argv.length - 1) return fallback;
  const n = Number.parseInt(process.argv[idx + 1], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getStringArg(flag, fallback = "") {
  const idx = process.argv.indexOf(flag);
  if (idx < 0 || idx === process.argv.length - 1) return fallback;
  return String(process.argv[idx + 1] || "").trim() || fallback;
}

function toId(value) {
  return String(value || "").trim();
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function ratingThreadId(actorUid, titleId) {
  return `rating::${actorUid}::${titleId}`;
}

function buildRatingFeedThreadDoc(ratingId, rating) {
  const actorUid = toId(rating?.uid);
  const titleId = toId(rating?.titleId);
  const level = toId(rating?.level || "title");
  if (!actorUid || !titleId || level !== "title") return null;

  const eventId = ratingThreadId(actorUid, titleId);
  return {
    eventId,
    sortMs: Math.max(toMillis(rating?.updatedAt), toMillis(rating?.createdAt)),
    data: {
      eventId,
      ratingId: toId(ratingId),
      actorUid,
      titleId,
      level: "title",
      createdAt: rating?.createdAt || admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: rating?.updatedAt || rating?.createdAt || admin.firestore.FieldValue.serverTimestamp(),
    },
  };
}

async function main() {
  console.log(`\n=== BACKFILL RATING FEED THREAD DOCS ===${WRITE ? " [WRITE MODE]" : " [DRY-RUN]"}\n`);
  if (!WRITE) {
    console.log("Usa --write per applicare davvero le modifiche.\n");
  }

  let query = db.collection("ratings").where("level", "==", "title");
  if (ONLY_UID) query = query.where("uid", "==", ONLY_UID);
  if (ONLY_TITLE_ID) query = query.where("titleId", "==", ONLY_TITLE_ID);

  const ratingsSnap = await query.get();
  const dedupedByEventId = new Map();

  ratingsSnap.docs
    .map((docSnap) => buildRatingFeedThreadDoc(docSnap.id, docSnap.data() || {}))
    .filter(Boolean)
    .sort((a, b) => a.sortMs - b.sortMs)
    .forEach((entry) => {
      dedupedByEventId.set(entry.eventId, entry);
    });

  let targets = [...dedupedByEventId.values()];
  if (LIMIT) targets = targets.slice(0, LIMIT);

  console.log(`Rating title-level letti: ${ratingsSnap.size}`);
  console.log(`Thread ratingFeed unici da sincronizzare: ${targets.length}`);
  if (ONLY_UID) console.log(`Filtro uid: ${ONLY_UID}`);
  if (ONLY_TITLE_ID) console.log(`Filtro titleId: ${ONLY_TITLE_ID}`);
  console.log("");

  if (!targets.length) {
    console.log("Nessun thread ratingFeed da sincronizzare.");
    return;
  }

  targets.slice(0, 10).forEach((entry) => {
    console.log(`- ${entry.eventId} <- rating ${entry.data.ratingId}`);
  });
  if (targets.length > 10) {
    console.log(`- ... altri ${targets.length - 10}`);
  }
  console.log("");

  if (!WRITE) return;

  let batch = db.batch();
  let pending = 0;
  let written = 0;

  for (const entry of targets) {
    batch.set(db.collection("ratingFeed").doc(entry.eventId), entry.data, { merge: true });
    pending++;
    written++;

    if (pending >= 400) {
      await batch.commit();
      batch = db.batch();
      pending = 0;
    }
  }

  if (pending > 0) {
    await batch.commit();
  }

  console.log(`Sincronizzati ${written} parent doc in /ratingFeed.`);
}

main()
  .catch((err) => {
    console.error("\nErrore backfill ratingFeed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await app.delete().catch(() => null);
  });
