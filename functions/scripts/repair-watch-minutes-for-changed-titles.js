#!/usr/bin/env node
//
// repair-watch-minutes-for-changed-titles.js — ricalcola i minuti visti dei
// SOLI titleStates che puntano a titoli la cui durata episodio e' cambiata,
// poi rifa' le statistiche dei soli utenti toccati.
//
// Perche' non `backfill-title-states-metrics.js --write`: quello scorre tutti
// i 411 utenti e ricalcola ogni cosa — ore di lavoro per correggere una
// frazione dei documenti. Qui si parte dai titoli riparati
// (`tmdbSync.durationEpisodeSource == "season_episodes"`), si passa UNA volta
// sul collection group `titleStates` e si tocca solo cio' che cambia davvero.
//
// Il calcolo passa da `computeWatchMinutesContribution` (lib/titleStates.js) e
// `recomputeUserStatsForUid` (lib/userStats.js), le stesse funzioni della
// produzione: nessuna logica duplicata.
//
// Due fasi, entrambe riprendibili — servono perche' un run lungo qui viene
// interrotto, e una fase che accumula tutto in memoria per scrivere alla fine
// non lascerebbe mai progressi:
//   1. scansione + correzione minuti, cursore su file (--scan-cursor),
//      uid toccati appesi a --uids-file mentre si va;
//   2. --stats-only: ricalcola le statistiche degli uid raccolti, con il
//      proprio checkpoint (--stats-cursor).
//
// Idempotente. Read-only finche' non passi --write.
//
// Uso:
//   cd functions
//   export GCLOUD_PROJECT=gia-visto
//   node scripts/repair-watch-minutes-for-changed-titles.js --scan-cursor=/tmp/s.cur --uids-file=/tmp/uids.txt
//   node scripts/repair-watch-minutes-for-changed-titles.js --write --scan-cursor=/tmp/s.cur --uids-file=/tmp/uids.txt
//   node scripts/repair-watch-minutes-for-changed-titles.js --write --stats-only --uids-file=/tmp/uids.txt --stats-cursor=/tmp/st.cur
"use strict";

const fs = require("node:fs");
const admin = require("firebase-admin");
const { computeWatchMinutesContribution } = require("../lib/titleStates");
const { recomputeUserStatsForUid } = require("../lib/userStats");

const args = process.argv.slice(2);
const argOf = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() : "";
};
const WRITE = args.includes("--write");
const STATS_ONLY = args.includes("--stats-only");
const SCAN_CURSOR = argOf("scan-cursor");
const STATS_CURSOR = argOf("stats-cursor");
const UIDS_FILE = argOf("uids-file");
const PAGE = Number(argOf("page")) || 3000;

admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || "gia-visto" });
const db = admin.firestore();

const toInt = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : 0; };
const readFile = (p) => { try { return p && fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""; } catch { return ""; } };
const save = (p, v) => { if (!p) return; try { fs.writeFileSync(p, v); } catch { /* best effort */ } };

async function scanAndFix() {
  const titlesSnap = await db.collection("titles")
    .where("tmdbSync.durationEpisodeSource", "==", "season_episodes")
    .select("name", "type", "meta").get();
  const titles = new Map();
  titlesSnap.forEach((d) => titles.set(d.id, { id: d.id, ...(d.data() || {}) }));
  console.log(`titoli con durata riparata: ${titles.size}`);

  const seenUids = new Set(readFile(UIDS_FILE).split("\n").map((l) => l.trim()).filter(Boolean));
  let cursor = readFile(SCAN_CURSOR).trim();
  let scanned = 0, changed = 0, deltaTot = 0;

  for (;;) {
    let q = db.collectionGroup("titleStates")
      .orderBy(admin.firestore.FieldPath.documentId()).limit(PAGE);
    // Su un collection group `documentId()` confronta i PATH COMPLETI: il
    // cursore va passato come DocumentReference, non come stringa.
    if (cursor) q = q.startAfter(db.doc(cursor));
    // eslint-disable-next-line no-await-in-loop
    const snap = await q.get();
    if (snap.empty) break;

    const writes = [];
    snap.forEach((d) => {
      scanned += 1;
      const titleId = d.get("titleId") || d.id;
      const title = titles.get(titleId);
      if (!title) return;
      const state = d.data() || {};
      const before = toInt(state.watchMinutesContribution);
      const after = toInt(computeWatchMinutesContribution(title, state));
      if (before === after) return;
      changed += 1;
      deltaTot += after - before;
      const uid = d.ref.parent.parent?.id;
      if (uid) seenUids.add(uid);
      writes.push({ ref: d.ref, after, before, name: title.name || titleId });
      if (changed <= 20) console.log(`  ${before} -> ${after} min · ${title.name || titleId}`);
    });

    if (WRITE && writes.length) {
      for (let i = 0; i < writes.length; i += 400) {
        const batch = db.batch();
        writes.slice(i, i + 400).forEach((w) => batch.set(w.ref, {
          watchMinutesContribution: w.after,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true }));
        // eslint-disable-next-line no-await-in-loop
        await batch.commit();
      }
      save(UIDS_FILE, [...seenUids].join("\n"));
    }

    cursor = snap.docs[snap.docs.length - 1].ref.path;
    save(SCAN_CURSOR, cursor);
    console.log(`  ...scansionati ${scanned} · corretti ${changed} · utenti ${seenUids.size}`);
    if (snap.size < PAGE) break;
  }

  if (!WRITE) save(UIDS_FILE, [...seenUids].join("\n"));
  console.log(`\nSCANSIONE FINITA · titleStates corretti ${changed} · delta ${deltaTot} min (${(deltaTot / 60).toFixed(0)} h) · utenti ${seenUids.size}`);
}

async function recomputeStats() {
  const uids = readFile(UIDS_FILE).split("\n").map((l) => l.trim()).filter(Boolean);
  const done = new Set(readFile(STATS_CURSOR).split("\n").map((l) => l.trim()).filter(Boolean));
  console.log(`utenti da ricalcolare: ${uids.length} (gia' fatti ${done.size})`);
  let n = 0;
  for (const uid of uids) {
    if (done.has(uid)) continue;
    if (WRITE) {
      // eslint-disable-next-line no-await-in-loop
      await recomputeUserStatsForUid(db, uid).catch((err) => {
        console.error(`  stats KO ${uid}: ${err?.message || err}`);
      });
    }
    done.add(uid);
    save(STATS_CURSOR, [...done].join("\n"));
    n += 1;
    if (n % 10 === 0) console.log(`  ...${done.size}/${uids.length}`);
  }
  console.log(`\nSTATISTICHE FINITE · ${done.size}/${uids.length}`);
}

(async () => {
  console.log(`\nMinuti visti sui titoli con durata cambiata — ${WRITE ? "WRITE" : "DRY RUN"}${STATS_ONLY ? " (solo statistiche)" : ""}\n`);
  if (STATS_ONLY) await recomputeStats();
  else await scanAndFix();
})().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
