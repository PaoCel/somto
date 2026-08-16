#!/usr/bin/env node
/**
 * extract-quiz-next-titles.js
 *
 * Replays the same ranking algorithm used for quiz_top20_titles.json and
 * outputs the *next* 60 most-watched titles (rank 21..80), excluding the 20
 * already covered by existing quizzes.
 *
 * Definition of "watched": user appears in `ratings` (level=="title") OR in
 * `users/{uid}/library/{titleId}` for that title.
 *
 * Sort:
 *  1. watchedByUniqueUsers desc
 *  2. totalWatchedEvents desc
 *  3. averageRating desc
 *
 * Usage:
 *   cd functions && node scripts/extract-quiz-next-titles.js
 */

const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

const EXISTING_TOP20 = path.resolve(
  __dirname,
  "../../quiz_beta/quiz_top20_titles.json"
);
const OUT = path.resolve(
  __dirname,
  "../../quiz_beta/quiz_next60_titles.json"
);

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

async function main() {
  if (!fs.existsSync(EXISTING_TOP20)) {
    console.error("Missing existing top20 file:", EXISTING_TOP20);
    process.exit(1);
  }
  const existing = JSON.parse(fs.readFileSync(EXISTING_TOP20, "utf8"));
  const excludeIds = new Set(existing.map((t) => t.titleId));
  console.log(`Excluding ${excludeIds.size} existing titles.`);

  // 1) ratings level==title
  console.log("Reading ratings (level=title)...");
  const ratingsSnap = await db
    .collection("ratings")
    .where("level", "==", "title")
    .get();
  console.log(`  ratings docs: ${ratingsSnap.size}`);

  /** @type {Map<string, {users: Set<string>, events: number, sumRating: number, ratingsCount: number, reviewsCount: number}>} */
  const ratingsMap = new Map();
  for (const doc of ratingsSnap.docs) {
    const d = doc.data() || {};
    const titleId = d.titleId;
    const uid = d.uid;
    if (!titleId || !uid) continue;
    let m = ratingsMap.get(titleId);
    if (!m) {
      m = { users: new Set(), events: 0, sumRating: 0, ratingsCount: 0, reviewsCount: 0 };
      ratingsMap.set(titleId, m);
    }
    m.users.add(uid);
    m.events += 1;
    if (typeof d.rating === "number" && isFinite(d.rating)) {
      m.sumRating += d.rating;
      m.ratingsCount += 1;
    }
    const review = d.reviewText || d.review || "";
    if (typeof review === "string" && review.trim().length > 0) {
      m.reviewsCount += 1;
    }
  }

  // 2) library collectionGroup
  console.log("Reading collectionGroup(library)...");
  const libSnap = await db.collectionGroup("library").get();
  console.log(`  library docs: ${libSnap.size}`);

  /** @type {Map<string, {users: Set<string>, events: number}>} */
  const libMap = new Map();
  for (const doc of libSnap.docs) {
    const d = doc.data() || {};
    const titleId = doc.id;
    const parts = doc.ref.path.split("/");
    const uid = parts.length >= 2 ? parts[1] : null;
    if (!titleId || !uid) continue;
    let m = libMap.get(titleId);
    if (!m) {
      m = { users: new Set(), events: 0 };
      libMap.set(titleId, m);
    }
    m.users.add(uid);
    m.events += 1;
  }

  // 3) Merge
  const allTitleIds = new Set([...ratingsMap.keys(), ...libMap.keys()]);
  console.log(`Distinct titleIds (union): ${allTitleIds.size}`);

  const rows = [];
  for (const tid of allTitleIds) {
    const r = ratingsMap.get(tid);
    const l = libMap.get(tid);
    const uidUnion = new Set();
    if (r) for (const u of r.users) uidUnion.add(u);
    if (l) for (const u of l.users) uidUnion.add(u);
    const totalEvents = (r?.events || 0) + (l?.events || 0);
    const avg = r && r.ratingsCount > 0 ? r.sumRating / r.ratingsCount : 0;
    rows.push({
      titleId: tid,
      watchedByUniqueUsers: uidUnion.size,
      totalWatchedEvents: totalEvents,
      ratingsCount: r?.ratingsCount || 0,
      averageRating: Number(avg.toFixed(2)),
      reviewsCount: r?.reviewsCount || 0,
    });
  }
  rows.sort((a, b) => {
    if (b.watchedByUniqueUsers !== a.watchedByUniqueUsers) return b.watchedByUniqueUsers - a.watchedByUniqueUsers;
    if (b.totalWatchedEvents !== a.totalWatchedEvents) return b.totalWatchedEvents - a.totalWatchedEvents;
    return b.averageRating - a.averageRating;
  });

  // 4) Filter out existing top 20, take next 60
  const filtered = rows.filter((r) => !excludeIds.has(r.titleId));
  const next60 = filtered.slice(0, 60);
  console.log(`Filtered ${rows.length - filtered.length} excluded titles. Pool: ${filtered.length}. Taking 60.`);

  // 5) Enrich with title metadata
  console.log("Enriching with titles/{titleId}...");
  const enriched = [];
  let i = 0;
  for (const row of next60) {
    i += 1;
    const docSnap = await db.collection("titles").doc(row.titleId).get();
    if (!docSnap.exists) {
      enriched.push({
        rank: 20 + i,
        ...row,
        tmdbId: "",
        mediaType: "unknown",
        title: "(missing in titles/)",
        originalTitle: "",
        year: "",
        notes: "titles/{titleId} not found — skip or fix.",
      });
      continue;
    }
    const t = docSnap.data() || {};
    enriched.push({
      rank: 20 + i,
      titleId: row.titleId,
      tmdbId: t.tmdbId ? String(t.tmdbId) : "",
      mediaType: (t.type || "movie").toLowerCase(),
      title: t.name || t.title || "",
      originalTitle: t.originalName || t.originalTitle || "",
      year: t.year ? String(t.year) : "",
      watchedByUniqueUsers: row.watchedByUniqueUsers,
      totalWatchedEvents: row.totalWatchedEvents,
      ratingsCount: row.ratingsCount,
      averageRating: row.averageRating,
      reviewsCount: row.reviewsCount,
      sourcePathsUsed: [
        'ratings (level="title") — count utenti unici e medie voto',
        'users/{uid}/library/{titleId} (collectionGroup) — verifica presenza titolo in libreria personale (= visto)',
        'titles/{titleId} — metadati canonici (name, type, year, tmdbId)',
      ],
      notes: 'Conteggio "visto" basato su presenza in ratings/library; userLists "Da Vedere" esclusa esplicitamente.',
    });
  }

  fs.writeFileSync(OUT, JSON.stringify(enriched, null, 2));
  console.log(`\nWrote ${enriched.length} titles to ${OUT}`);
  console.log("\nTop 10 of next batch:");
  enriched.slice(0, 10).forEach((t) => {
    console.log(`  ${t.rank}. ${t.title} (${t.year}) [${t.mediaType}] users=${t.watchedByUniqueUsers} avg=${t.averageRating}`);
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Failed:", err);
    process.exit(1);
  });
