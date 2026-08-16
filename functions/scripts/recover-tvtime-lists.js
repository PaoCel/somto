#!/usr/bin/env node
/**
 * recover-tvtime-lists.js
 *
 * Recupera le liste custom TV Time (`lists-prod-lists.csv`) per un import il
 * cui file liste non e' mai arrivato su Storage (uploadTitlesImportFiles fa
 * un solo Promise.all senza retry: se il tab va in background a meta' upload,
 * un file su N resta perso — vedi reviveStalledTitlesImports). Il `movies.csv`
 * dell'import originale (gia' su Storage) fornisce il lookup uuid->nome; serve
 * solo un nuovo upload del file liste (es. via support-import.html ->
 * supportImports/{uid}/...).
 *
 * Riusa lo stesso parser/planner della pipeline live
 * (lib/importAdapters/tvTimeListsWriter.js) e la stessa cascata di matching
 * titoli (lib/importAdapters/matching.js resolveRowMatch) — nessun re-match
 * di film/serie gia' importati, solo quanto referenziato dalle liste. Le
 * liste importano sempre PRIVATE (mai dedotto pubblico da TV Time).
 *
 * SICUREZZA: dry-run DEFAULT. --write per applicare.
 *
 * Usage (da functions/):
 *   node scripts/recover-tvtime-lists.js --uid=UID --import=IMPORT_ID --listsFile=STORAGE_PATH
 *   node scripts/recover-tvtime-lists.js --uid=UID --import=IMPORT_ID --listsFile=STORAGE_PATH --write
 */

"use strict";

const admin = require("firebase-admin");
const {
  prepareTvTimeLists,
  collectListCandidates,
  buildTvTimeListPlans,
} = require("../lib/importAdapters/tvTimeListsWriter");
const { resolveRowMatch } = require("../lib/importAdapters/matching");

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
function getArg(flag) { const h = args.find((a) => a.startsWith(`${flag}=`)); return h ? h.slice(flag.length + 1).trim() : ""; }
const ARG_UID = getArg("--uid");
const ARG_IMPORT = getArg("--import");
const ARG_LISTS_FILE = getArg("--listsFile");
if (!ARG_UID || !ARG_IMPORT || !ARG_LISTS_FILE) {
  console.error("Usage: node scripts/recover-tvtime-lists.js --uid=UID --import=IMPORT_ID --listsFile=STORAGE_PATH [--write]");
  process.exit(1);
}

const BUCKET = "gia-visto.firebasestorage.app";
admin.initializeApp({ projectId: "gia-visto", storageBucket: BUCKET });
const db = admin.firestore();
const bucket = admin.storage().bucket(BUCKET);
const CHUNK = 400;

async function commitInChunks(writeFns) {
  for (let i = 0; i < writeFns.length; i += CHUNK) {
    const batch = db.batch();
    writeFns.slice(i, i + CHUNK).forEach((fn) => fn(batch));
    // eslint-disable-next-line no-await-in-loop
    await batch.commit();
  }
}

async function downloadText(path) {
  const [exists] = await bucket.file(path).exists();
  if (!exists) return null;
  const [buf] = await bucket.file(path).download();
  return buf.toString("utf8");
}

async function main() {
  console.log(`[recover-tvtime-lists] uid=${ARG_UID} import=${ARG_IMPORT} listsFile=${ARG_LISTS_FILE} mode=${WRITE ? "WRITE" : "DRY-RUN"}`);

  const importRef = db.collection("users").doc(ARG_UID).collection("imports").doc(ARG_IMPORT);
  const importSnap = await importRef.get();
  if (!importSnap.exists) { console.error("ABORT: import non trovato."); process.exit(1); }
  const importData = importSnap.data() || {};
  if (importData.startedBy !== ARG_UID) { console.error("ABORT: import non appartiene a questo uid."); process.exit(1); }
  const moviesPath = importData.storagePaths?.movies;
  if (!moviesPath) { console.error("ABORT: import senza storagePaths.movies (niente lookup uuid->nome)."); process.exit(1); }

  const [moviesCsv, listsCsv] = await Promise.all([downloadText(moviesPath), downloadText(ARG_LISTS_FILE)]);
  if (!moviesCsv) { console.error(`ABORT: movies.csv non trovato su Storage (${moviesPath}).`); process.exit(1); }
  if (!listsCsv) { console.error(`ABORT: file liste non trovato su Storage (${ARG_LISTS_FILE}).`); process.exit(1); }
  console.log(`  movies.csv: ${moviesCsv.length} byte | file liste: ${listsCsv.length} byte`);

  const prepared = prepareTvTimeLists(listsCsv, moviesCsv);
  console.log(`  parse: ${prepared.lists.length} liste, ${prepared.errors.length} errori`);
  if (prepared.errors.length) prepared.errors.slice(0, 10).forEach((e) => console.log("    parse error:", JSON.stringify(e)));
  prepared.lists.forEach((l) => console.log(`    - "${l.name}" (${l.items.length} item, public=${l.isPublic})`));

  const candidates = collectListCandidates(prepared.lists);
  console.log(`  candidati unici da matchare: ${candidates.length}`);

  const titleIdByCandidateKey = new Map();
  const logicalDupCache = new Map();
  let matched = 0;
  let unmatched = 0;
  for (const candidate of candidates) {
    if (!candidate.row) { unmatched += 1; continue; }
    // eslint-disable-next-line no-await-in-loop
    const match = await resolveRowMatch(db, bucket, candidate.row, { logicalDupCache }).catch((err) => {
      console.warn("  match error:", candidate.row.rawTitle, err?.message || err);
      return null;
    });
    if (match?.resolved && match?.titleId) {
      titleIdByCandidateKey.set(candidate.key, match.titleId);
      matched += 1;
    } else {
      unmatched += 1;
    }
  }
  console.log(`  match: ${matched}/${candidates.length} risolti (${unmatched} non trovati)`);

  const userSnap = await db.collection("users").doc(ARG_UID).get();
  const owner = userSnap.data() || {};
  const now = new Date();
  const planned = buildTvTimeListPlans({ uid: ARG_UID, lists: prepared.lists, titleIdByCandidateKey, owner, now });
  console.log(`\n  piano: ${planned.plans.length} liste da creare (private), ${planned.unresolvedItems} item non risolti, ${planned.originalPublicLists} erano pubbliche su TV Time (resteranno private)`);
  planned.plans.forEach((p) => console.log(`    - "${p.root.title}": ${p.items.length} item, id=${p.listId}`));

  if (!WRITE) {
    console.log("\n  DRY-RUN: nessuna scrittura. Rilancia con --write per applicare.");
    return;
  }

  let created = 0;
  let alreadyImported = 0;
  for (const plan of planned.plans) {
    const listRef = db.collection("userLists").doc(plan.listId);
    // eslint-disable-next-line no-await-in-loop
    const existing = await listRef.get();
    if (existing.exists) { alreadyImported += 1; continue; }
    const rootBatch = db.batch();
    rootBatch.set(listRef, plan.root);
    rootBatch.set(listRef.collection("members").doc(ARG_UID), plan.member);
    // eslint-disable-next-line no-await-in-loop
    await rootBatch.commit();
    const itemFns = plan.items.map((item) => (batch) => batch.set(listRef.collection("items").doc(item.titleId), item));
    // eslint-disable-next-line no-await-in-loop
    if (itemFns.length) await commitInChunks(itemFns);
    created += 1;
  }
  console.log(`\n  Fatto: ${created} liste create, ${alreadyImported} gia' esistenti (idempotente).`);
}

main().then(() => process.exit(0)).catch((err) => { console.error("[recover-tvtime-lists] errore:", err); process.exit(1); });
