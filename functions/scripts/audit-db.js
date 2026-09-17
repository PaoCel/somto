/**
 * Read-only Firestore audit for 2watch.
 *
 * Usage:
 *   node scripts/audit-db.js --project <projectId> --serviceAccount /path/to/serviceAccount.json [--limitTitles 8000] [--limitPeople 8000] [--sampleUsers 400]
 *
 * All checks are best-effort and non-destructive. Outputs a JSON report in /tmp/audit-report-<timestamp>.json.
 */

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

// ---------------- CLI ----------------
const args = require("yargs/yargs")(process.argv.slice(2))
  .usage("$0 --project <id> --serviceAccount <path> [options]")
  .option("project", { type: "string", demandOption: true, describe: "Firebase project id" })
  .option("serviceAccount", { type: "string", demandOption: true, describe: "Path to serviceAccount.json" })
  .option("limitTitles", { type: "number", default: 8000, describe: "Max titles to scan (0 = no limit)" })
  .option("limitPeople", { type: "number", default: 8000, describe: "Max people to scan (0 = no limit)" })
  .option("sampleUsers", { type: "number", default: 300, describe: "Sample size of users for followers/notifications checks (0 = no user sampling check)" })
  .help().argv;

const saPath = path.resolve(args.serviceAccount);
if (!fs.existsSync(saPath)) {
  console.error(`serviceAccount not found: ${saPath}`);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(require(saPath)),
  projectId: args.project,
});

const db = admin.firestore();

// ---------------- Helpers ----------------
async function fetchCollection(colRef, { limit = 0 } = {}) {
  let q = colRef;
  if (limit > 0) q = q.limit(limit);
  const snap = await q.get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function logicalTitleKey(t) {
  const type = (t.type || "movie").toLowerCase();
  const name = String(t.nameLower || t.name || "").trim();
  const year = Number(t.year || 0) || 0;
  return `${type}|${name}|${year}`;
}

function logicalPersonKey(p) {
  const name = String(p.nameLower || p.name || "").trim();
  const year = Number(p.birthYear || 0) || 0;
  return `${name}|${year}`;
}

// ---------------- Checks ----------------
async function checkTitles(limit) {
  const titles = await fetchCollection(db.collection("titles"), { limit });
  const dupByKey = new Map();
  const missingGenres = [];
  for (const t of titles) {
    const key = logicalTitleKey(t);
    const arr = dupByKey.get(key) || [];
    arr.push(t.id);
    dupByKey.set(key, arr);
  }
  const duplicates = [];
  for (const [k, ids] of dupByKey.entries()) {
    if (ids.length > 1) duplicates.push({ key: k, count: ids.length, ids: ids.slice(0, 10) });
  }

  // genre orphans
  const genres = await fetchCollection(db.collection("genres"));
  const genreSet = new Set(genres.map((g) => g.id));
  for (const t of titles) {
    const gids = Array.isArray(t.genreIds) ? t.genreIds : [];
    const missing = gids.filter((g) => !genreSet.has(String(g)));
    if (missing.length) missingGenres.push({ titleId: t.id, missing });
  }

  return { scanned: titles.length, duplicates, missingGenres };
}

async function checkPeople(limit) {
  const people = await fetchCollection(db.collection("people"), { limit });
  const dupTmdb = new Map();
  const dupLogical = new Map();
  for (const p of people) {
    const tmdb = p.tmdbId ? String(p.tmdbId) : null;
    if (tmdb) {
      const arr = dupTmdb.get(tmdb) || [];
      arr.push(p.id);
      dupTmdb.set(tmdb, arr);
    }
    const key = logicalPersonKey(p);
    const arr2 = dupLogical.get(key) || [];
    arr2.push(p.id);
    dupLogical.set(key, arr2);
  }
  const dupByTmdb = [];
  for (const [k, ids] of dupTmdb.entries()) {
    if (ids.length > 1) dupByTmdb.push({ tmdbId: k, count: ids.length, ids: ids.slice(0, 10) });
  }
  const dupByNameYear = [];
  for (const [k, ids] of dupLogical.entries()) {
    if (ids.length > 1) dupByNameYear.push({ key: k, count: ids.length, ids: ids.slice(0, 10) });
  }
  return { scanned: people.length, dupByTmdb, dupByNameYear };
}

async function checkUsersSample(sampleSize) {
  if (sampleSize <= 0) return { sampled: 0, followerMismatches: [], notificationOrphans: [] };
  const usersSnap = await db.collection("users").limit(sampleSize).get();
  const users = usersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const userSet = new Set(users.map((u) => u.id));

  const followerMismatches = [];
  const notificationOrphans = [];

  for (const u of users) {
    // following reciprocity
    const following = await db.collection("users").doc(u.id).collection("following").get();
    for (const f of following.docs) {
      const target = f.id;
      const back = await db.collection("users").doc(target).collection("followers").doc(u.id).get();
      if (!back.exists) {
        followerMismatches.push({ user: u.id, target });
      }
    }

    // notifications orphan check
    const notifSnap = await db.collection("users").doc(u.id).collection("notifications").limit(200).get();
    for (const n of notifSnap.docs) {
      const data = n.data() || {};
      const toUid = data.toUid;
      const fromUid = data.fromUid;
      if (toUid && !userSet.has(toUid)) {
        notificationOrphans.push({ user: u.id, notif: n.id, field: "toUid", value: toUid });
      }
      if (fromUid && !userSet.has(fromUid)) {
        notificationOrphans.push({ user: u.id, notif: n.id, field: "fromUid", value: fromUid });
      }
    }
  }
  return {
    sampled: users.length,
    followerMismatches,
    notificationOrphans,
  };
}

// ---------------- Main ----------------
(async () => {
  console.log("Running audit (read-only)...");
  const report = {
    project: args.project,
    limits: {
      titles: args.limitTitles,
      people: args.limitPeople,
      sampleUsers: args.sampleUsers,
    },
    startedAt: new Date().toISOString(),
    titles: await checkTitles(args.limitTitles),
    people: await checkPeople(args.limitPeople),
    usersSample: await checkUsersSample(args.sampleUsers),
    finishedAt: new Date().toISOString(),
  };

  const outPath = path.join("/tmp", `audit-report-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`Audit completed. Report: ${outPath}`);
  console.log(`Summary:
  - titles scanned: ${report.titles.scanned}, duplicates: ${report.titles.duplicates.length}, missingGenres: ${report.titles.missingGenres.length}
  - people scanned: ${report.people.scanned}, dupTmdb: ${report.people.dupByTmdb.length}, dupNameYear: ${report.people.dupByNameYear.length}
  - users sampled: ${report.usersSample.sampled}, follower mismatches: ${report.usersSample.followerMismatches.length}, notification orphans: ${report.usersSample.notificationOrphans.length}
  `);
  process.exit(0);
})().catch((err) => {
  console.error("Audit failed:", err);
  process.exit(1);
});
