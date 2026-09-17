/**
 * Deduplicate titles (manual vs tmdb) preserving ratings/feed/posts/etc.
 *
 * Default is dry-run (no writes). Use --apply to perform changes.
 *
 * Usage:
 *   node scripts/dedup-titles.js --project <id> --serviceAccount <path> [--apply]
 */
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
const yargs = require("yargs/yargs");

// Manual → TMDB mapping from audit
const TITLE_PAIRS = [
  ["2K419chpVSPLd6ItI2QR", "tmdb_movie_1368166"],
  ["boots", "tmdb_tv_225647"],
  ["buen-camino-2025", "tmdb_movie_1472638"],
  ["il-rifugio-atomico", "tmdb_tv_245648"],
  ["kGUjeDkSUkPVGTH42x71", "tmdb_tv_225171"],
  ["la-sua-verita-na-tv", "tmdb_tv_259731"],
  ["man-vs-baby", "tmdb_tv_279601"],
];

const args = yargs(process.argv.slice(2))
  .option("project", { type: "string", demandOption: true })
  .option("serviceAccount", { type: "string", demandOption: true })
  .option("apply", { type: "boolean", default: false })
  .help().argv;

const saPath = path.resolve(args.serviceAccount);
if (!fs.existsSync(saPath)) {
  console.error("serviceAccount not found:", saPath);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(require(saPath)),
  projectId: args.project,
});

const db = admin.firestore();

// Helpers --------------------------------------------------
async function updateCollectionWhere(field, oldId, newId, colPath) {
  const col = db.collection(colPath);
  const snap = await col.where(field, "==", oldId).get();
  let count = 0;
  for (const doc of snap.docs) {
    count++;
    if (args.apply) {
      await doc.ref.set({ ...doc.data(), [field]: newId }, { merge: true });
    }
  }
  return count;
}

async function updateUserSubcollection(field, oldId, newId, subPath) {
  const usersSnap = await db.collection("users").get();
  let updated = 0;
  for (const u of usersSnap.docs) {
    const col = u.ref.collection(subPath);
    const snap = await col.where(field, "==", oldId).get();
    for (const doc of snap.docs) {
      updated++;
      const data = { ...doc.data(), [field]: newId };
      if (args.apply) {
        if (doc.id === oldId) {
          // recreate under canonical id to keep doc id consistent with titleId
          await col.doc(newId).set(data, { merge: true });
          await doc.ref.delete();
        } else {
          await doc.ref.set(data, { merge: true });
        }
      }
    }
  }
  return updated;
}

async function migrateRatingFeed(oldId, newId) {
  // ratingFeed doc id pattern: rating::<uid>::<titleId>
  const oldPrefix = `rating::`;
  // Find docs with suffix oldId
  const snap = await db.collection("ratingFeed").where(admin.firestore.FieldPath.documentId(), ">", "rating::").limit(5000).get();
  let moved = 0;
  for (const doc of snap.docs) {
    const id = doc.id;
    if (!id.endsWith(`::${oldId}`)) continue;
    const parts = id.split("::");
    if (parts.length < 3) continue;
    const uid = parts[1];
    const newDocId = `rating::${uid}::${newId}`;
    const data = doc.data();
    if (!args.apply) {
      moved++;
      continue;
    }
    // copy doc
    const newRef = db.collection("ratingFeed").doc(newDocId);
    await newRef.set({ ...data, titleId: newId }, { merge: true });
    // copy subcollections likes/comments
    const likes = await doc.ref.collection("likes").get();
    const comments = await doc.ref.collection("comments").get();
    const batch = db.batch();
    likes.forEach((d) => batch.set(newRef.collection("likes").doc(d.id), d.data()));
    comments.forEach((d) => batch.set(newRef.collection("comments").doc(d.id), d.data()));
    batch.delete(doc.ref);
    await batch.commit();
    moved++;
  }
  return moved;
}

function mergeTitleData(manual, canonical) {
  const merged = { ...canonical };
  const copyIfEmpty = (field) => {
    if (!merged[field] && manual[field]) merged[field] = manual[field];
  };
  copyIfEmpty("description");
  copyIfEmpty("posterPath");
  copyIfEmpty("backdropPath");
  // merge related
  const rel = new Set();
  (canonical.related || []).forEach((x) => rel.add(String(x)));
  (manual.related || []).forEach((x) => rel.add(String(x)));
  merged.related = Array.from(rel);
  return merged;
}

async function processPair(manualId, canonicalId) {
  const out = { manualId, canonicalId, steps: [] };
  const manSnap = await db.collection("titles").doc(manualId).get();
  const canSnap = await db.collection("titles").doc(canonicalId).get();
  if (!manSnap.exists || !canSnap.exists) {
    out.error = "doc missing";
    return out;
  }
  const manual = manSnap.data();
  const canonical = canSnap.data();

  // Merge data (non-destructive)
  const merged = mergeTitleData(manual, canonical);
  if (args.apply) {
    await db.collection("titles").doc(canonicalId).set(merged, { merge: true });
  }
  out.steps.push("merge_title_fields");

  // Ratings
  out.ratings = await updateCollectionWhere("titleId", manualId, canonicalId, "ratings");
  // ratingFeed threads
  out.ratingFeedMoved = await migrateRatingFeed(manualId, canonicalId);
  // Library & watchlist
  out.library = await updateUserSubcollection("titleId", manualId, canonicalId, "library");
  out.watchlist = await updateUserSubcollection("titleId", manualId, canonicalId, "watchlist");

  // Recommendations
  out.recsFrom = await updateCollectionWhere("titleId", manualId, canonicalId, "recommendations");
  // Posts
  out.posts = await updateCollectionWhere("titleId", manualId, canonicalId, "posts");
  // Threads
  out.threads = await updateCollectionWhere("titleId", manualId, canonicalId, "threads");
  // Signals
  out.signals = await updateCollectionWhere("titleId", manualId, canonicalId, "signals");

  // related references inside titles
  const relSnap = await db.collection("titles").where("related", "array-contains", manualId).get();
  let relUpdates = 0;
  for (const d of relSnap.docs) {
    const data = d.data() || {};
    const related = Array.from(new Set((data.related || []).map((x) => (x === manualId ? canonicalId : x))));
    if (args.apply) {
      await d.ref.set({ related }, { merge: true });
    }
    relUpdates++;
  }
  out.relatedUpdates = relUpdates;

  // Taste profile seeds (sampled via users collection; limited for safety)
  const userSnap = await db.collection("users").limit(800).get();
  let tasteUpdates = 0;
  for (const u of userSnap.docs) {
    const tp = u.data()?.tasteProfile;
    if (!tp) continue;
    let changed = false;
    const fields = ["seedTitleIds", "seedLikedTitleIds"];
    for (const f of fields) {
      if (Array.isArray(tp[f]) && tp[f].includes(manualId)) {
        tp[f] = Array.from(new Set(tp[f].map((x) => (x === manualId ? canonicalId : x))));
        changed = true;
      }
    }
    if (changed) {
      tasteUpdates++;
      if (args.apply) await u.ref.set({ tasteProfile: tp }, { merge: true });
    }
  }
  out.tasteUpdates = tasteUpdates;

  // Finally delete manual doc
  if (args.apply) {
    await db.collection("titles").doc(manualId).delete();
    out.steps.push("deleted_manual");
  } else {
    out.steps.push("dry_run_no_delete");
  }
  return out;
}

// Main -----------------------------------------------------
(async () => {
  console.log(`Dedup titles (apply=${args.apply}) project=${args.project}`);
  const results = [];
  for (const [manualId, canonicalId] of TITLE_PAIRS) {
    const r = await processPair(manualId, canonicalId);
    results.push(r);
    console.log(r);
  }
  const outPath = path.join("/tmp", `dedup-titles-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ apply: args.apply, results }, null, 2));
  console.log("Report:", outPath);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
