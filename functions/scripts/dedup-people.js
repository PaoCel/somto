/**
 * Deduplicate people docs while preserving references.
 * Default: dry-run. Use --apply to write.
 *
 * Rules (safer merge):
 * - If a group has a doc with tmdbId => canonical = that doc.
 * - Else canonical = doc con più referenze nei titles (castIds/directorIds/writerIds).
 *   In caso di parità, usa profilePath/bio/gender come punteggio, poi id alfabetico.
 * - Se TUTTI hanno usage 0 e senza tmdbId => gruppo marcato come ambiguous (nessuna modifica).
 *
 * Usage:
 *   node scripts/dedup-people.js --project <id> --serviceAccount <path> [--apply]
 */
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
const yargs = require("yargs/yargs");

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
function scoreDoc(p) {
  let s = 0;
  if (p.tmdbId) s += 5;
  if (p.profilePath) s += 2;
  if (p.bio) s += 1;
  if (p.gender) s += 1;
  return s;
}

async function countUsage(personId) {
  const fields = ["castIds", "directorIds", "writerIds"];
  let usage = 0;
  for (const f of fields) {
    const snap = await db.collection("titles").where(f, "array-contains", personId).limit(1).get();
    if (!snap.empty) usage += 1;
  }
  return usage;
}

async function fetchPeople() {
  const snap = await db.collection("people").get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function updateTitleRefs(oldId, newId) {
  const updates = { castIds: 0, directorIds: 0, writerIds: 0 };
  const queries = [
    { field: "castIds", key: "castIds" },
    { field: "directorIds", key: "directorIds" },
    { field: "writerIds", key: "writerIds" },
  ];
  for (const q of queries) {
    const snap = await db.collection("titles")
      .where(q.field, "array-contains", oldId)
      .get();
    for (const d of snap.docs) {
      const data = d.data() || {};
      const arr = Array.from(new Set((data[q.field] || []).map((x) => (x === oldId ? newId : x))));
      if (args.apply) await d.ref.set({ [q.field]: arr }, { merge: true });
      updates[q.key]++;
    }
  }
  return updates;
}

function pickCanonical(group, usageMap) {
  const withTmdb = group.filter((p) => p.tmdbId);
  if (withTmdb.length) {
    return withTmdb.sort((a, b) => scoreDoc(b) - scoreDoc(a))[0];
  }
  const sorted = [...group].sort((a, b) => {
    const ua = usageMap.get(a.id) || 0;
    const ub = usageMap.get(b.id) || 0;
    if (ua !== ub) return ub - ua; // più referenze prima
    const sa = scoreDoc(a);
    const sb = scoreDoc(b);
    if (sa !== sb) return sb - sa;
    return a.id.localeCompare(b.id);
  });
  return sorted[0];
}

// Main -----------------------------------------------------
(async () => {
  const people = await fetchPeople();
  const usageMap = new Map();
  const groups = new Map();
  for (const p of people) {
    const name = String(p.nameLower || p.name || "").trim();
    const key = `${name}|${Number(p.birthYear || 0) || 0}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  // precompute usage only for duplicate groups
  for (const [, arr] of groups.entries()) {
    if (arr.length < 2) continue;
    for (const p of arr) {
      if (!usageMap.has(p.id)) {
        usageMap.set(p.id, await countUsage(p.id));
      }
    }
  }

  const ambiguous = [];
  const actions = [];

  for (const [key, arr] of groups.entries()) {
    if (arr.length < 2) continue; // not duplicate
    const canonical = pickCanonical(arr, usageMap);
    const duplicates = arr.filter((p) => p.id !== canonical.id);
    const totalUsage = arr.reduce((s, p) => s + (usageMap.get(p.id) || 0), 0);

    // If no tmdbId and zero usage, leave for manual review
    if (!canonical.tmdbId && totalUsage === 0) {
      ambiguous.push({ key, ids: arr.map((p) => p.id), reason: "zero_usage" });
      continue;
    }

    actions.push({ key, canonical: canonical.id, dupCount: duplicates.length, duplicates: duplicates.map((d) => d.id) });

    for (const dup of duplicates) {
      const updates = await updateTitleRefs(dup.id, canonical.id);
      if (args.apply) {
        await db.collection("people").doc(dup.id).delete();
      }
      console.log(`dedup ${dup.id} -> ${canonical.id}`, updates);
    }
  }

  const out = {
    apply: args.apply,
    actions,
    ambiguous,
  };
  const outPath = path.join("/tmp", `dedup-people-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  if (ambiguous.length) {
    const csv = ambiguous.map((a) => `${a.key},"${a.ids.join("|")}"`).join("\n");
    fs.writeFileSync(outPath.replace(".json", ".csv"), csv);
  }
  console.log("Report:", outPath, "ambiguous:", ambiguous.length);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
