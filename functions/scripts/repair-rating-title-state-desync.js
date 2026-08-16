#!/usr/bin/env node
//
// Ripara il disallineamento tra i doc `ratings` (livello titolo) e i
// `users/{uid}/titleStates/{titleId}` che dovrebbero rifletterli.
//
// Due difetti distinti, entrambi visibili come "il contatore voti non torna":
//
//  1) DUPLICATI — due doc rating per lo stesso (uid, titolo). Succede quando un
//     titolo viene accorpato: il campo `titleId` viene aggiornato ma resta un
//     doc con il vecchio id nel nome. Gonfia il conteggio dei doc e conta due
//     volte lo stesso utente nell'aggregato pubblico del titolo.
//     → si tiene il doc canonico (`{uid}__{titleId}__{level}__0__0`), o il più
//       recente, e si cancellano gli altri.
//
//  2) DESYNC — il voto esiste ma il titleState non lo sa (`hasTitleRating`
//     false, o titleState assente del tutto). Il voto sparisce da libreria e
//     contatori pur essendo stato dato davvero.
//     → si ricostruisce lo state con `applyTitleRatingToState`, la STESSA
//       funzione usata dal trigger `syncTitleStateFromTitleRating`.
//
// La scrittura del titleState fa scattare `recomputeUserStatsFromTitleStates`,
// che aggiorna da solo proiezioni legacy e `users/{uid}.stats`.
//
// ATTENZIONE all'ordine: cancellare un rating fa partire il trigger che
// PULISCE il titleState di quel titolo — anche se sopravvive un altro rating
// per lo stesso titolo. Per questo il ripristino dello state viene dopo la
// cancellazione, e attende che il trigger abbia fatto il suo giro.
//
// Uso:
//   node scripts/repair-rating-title-state-desync.js              # dry-run
//   node scripts/repair-rating-title-state-desync.js --write
//   node scripts/repair-rating-title-state-desync.js --write --uid=<uid>
//   node scripts/repair-rating-title-state-desync.js --write --settle-ms=20000

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const { applyTitleRatingToState } = require("../lib/titleStates");

loadLocalEnv();

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "gia-visto",
});

const db = admin.firestore();

const WRITE = process.argv.includes("--write");
const ONLY_UID = readArg("--uid");
const SETTLE_MS = Number(readArg("--settle-ms") || 15000) || 15000;

function loadLocalEnv() {
  const candidates = [
    path.join(__dirname, "..", ".env"),
    path.join(__dirname, "..", ".env.production"),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const idx = trimmed.indexOf("=");
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key && process.env[key] == null) process.env[key] = value;
    }
  }
}

function readArg(name) {
  const prefixed = `${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefixed));
  return found ? found.slice(prefixed.length).trim() : "";
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.seconds === "number") return value.seconds * 1000;
  return 0;
}

function canonicalDocId(row) {
  return `${row.uid}__${row.titleId}__title__0__0`;
}

/** Il doc da tenere: quello con l'id canonico, altrimenti il più recente. */
function pickSurvivor(rows) {
  const canonical = rows.find((r) => r.id === canonicalDocId(r));
  if (canonical) return canonical;
  return rows.slice().sort((a, b) => toMillis(b.updatedAt || b.createdAt) - toMillis(a.updatedAt || a.createdAt))[0];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log(`[repair-ratings] mode=${WRITE ? "WRITE" : "DRY-RUN"}${ONLY_UID ? ` uid=${ONLY_UID}` : ""}`);

  let query = db.collection("ratings").where("level", "==", "title");
  if (ONLY_UID) query = query.where("uid", "==", ONLY_UID);
  const snap = await query.get();

  const byKey = new Map();
  for (const docSnap of snap.docs) {
    const data = docSnap.data() || {};
    const uid = String(data.uid || "").trim();
    const titleId = String(data.titleId || "").trim();
    if (!uid || !titleId) continue;
    const key = `${uid}::${titleId}`;
    byKey.set(key, [...(byKey.get(key) || []), { id: docSnap.id, ref: docSnap.ref, uid, titleId, ...data }]);
  }

  const duplicates = [...byKey.values()].filter((rows) => rows.length > 1);
  const toDelete = [];
  for (const rows of duplicates) {
    const survivor = pickSurvivor(rows);
    for (const row of rows) {
      if (row.id !== survivor.id) toDelete.push({ row, survivor });
    }
  }

  // Desync: per ogni (uid, titolo) con un voto, lo state deve avere il flag.
  const desynced = [];
  const uids = [...new Set([...byKey.values()].map((rows) => rows[0].uid))];
  for (const uid of uids) {
    const titleIds = [...byKey.entries()]
      .filter(([key]) => key.startsWith(`${uid}::`))
      .map(([, rows]) => rows[0].titleId);

    for (let i = 0; i < titleIds.length; i += 30) {
      const chunk = titleIds.slice(i, i + 30);
      const statesSnap = await db.collection("users").doc(uid).collection("titleStates")
        .where(admin.firestore.FieldPath.documentId(), "in", chunk)
        .get();
      const states = new Map(statesSnap.docs.map((d) => [d.id, d.data() || {}]));
      for (const titleId of chunk) {
        const state = states.get(titleId) || null;
        if (state && state.hasTitleRating === true) continue;
        const rows = byKey.get(`${uid}::${titleId}`) || [];
        const survivor = pickSurvivor(rows);
        if (!survivor) continue;
        desynced.push({ uid, titleId, survivor, hasState: Boolean(state) });
      }
    }
  }

  console.log(`\n  voti (livello titolo) letti : ${snap.size}`);
  console.log(`  gruppi con duplicati        : ${duplicates.length} (doc da cancellare: ${toDelete.length})`);
  toDelete.forEach(({ row, survivor }) => {
    console.log(`    - cancella ${row.id} (voto ${row.rating}) — tiene ${survivor.id} (voto ${survivor.rating})`);
  });
  console.log(`  voti senza titleState votato : ${desynced.length}`);
  desynced.forEach((d) => {
    console.log(`    - ${d.uid.slice(0, 8)} ${d.titleId} (voto ${d.survivor.rating})${d.hasState ? "" : " [titleState assente]"}`);
  });

  if (!WRITE) {
    console.log("\n  DRY-RUN: nessuna scrittura. Rilancia con --write.");
    return;
  }

  // 1) Duplicati.
  for (const { row } of toDelete) {
    await row.ref.delete();
    console.log(`  [write] cancellato ${row.id}`);
  }

  // 2) Attende il trigger di sync (che sulla cancellazione azzera il flag sul
  // titleState anche quando un altro voto sopravvive) prima di ricostruire.
  const targets = new Map();
  for (const { survivor } of toDelete) targets.set(`${survivor.uid}::${survivor.titleId}`, survivor);
  for (const d of desynced) targets.set(`${d.uid}::${d.titleId}`, d.survivor);

  if (toDelete.length) {
    console.log(`  [write] attendo ${SETTLE_MS}ms che i trigger di cancellazione finiscano...`);
    await sleep(SETTLE_MS);
  }

  // 3) Ricostruisce lo state dal voto sopravvissuto (stessa funzione del trigger).
  for (const survivor of targets.values()) {
    const stateRef = db.collection("users").doc(survivor.uid).collection("titleStates").doc(survivor.titleId);
    const [stateSnap, titleSnap] = await Promise.all([
      stateRef.get(),
      db.collection("titles").doc(survivor.titleId).get(),
    ]);
    if (!titleSnap.exists) {
      console.log(`  [write] SALTATO ${survivor.titleId}: il titolo non esiste più`);
      continue;
    }
    const title = { id: survivor.titleId, ...(titleSnap.data() || {}) };
    const nextState = applyTitleRatingToState(
      stateSnap.exists ? (stateSnap.data() || {}) : null,
      survivor,
      title,
      { now: survivor.updatedAt || survivor.createdAt || admin.firestore.Timestamp.now() }
    );
    await stateRef.set(nextState, { merge: true });
    console.log(`  [write] titleState risincronizzato ${survivor.uid.slice(0, 8)} ${survivor.titleId} → voto ${nextState.ratingValue}`);
  }

  console.log("\n  Fatto. `recomputeUserStatsFromTitleStates` aggiorna proiezioni e stats da solo.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[repair-ratings] errore", err);
    process.exit(1);
  });
