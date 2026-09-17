#!/usr/bin/env node
//
// repair-netflix-branded-season.js — ri-parsa le righe degli import Netflix
// gia' scritti con il parser corrente e recupera la STAGIONE che il parser
// vecchio non riconosceva.
//
// Perche': Netflix etichetta alcune serie con il proprio nome piu' il numero
// di stagione invece di "Stagione N" ("Stranger Things: Stranger Things 4:
// Capitolo quattro: Caro Billy"). Quelle righe finivano `kind: "ambiguous"`
// con `seasonNumber: null`, quindi `seasonsCompletedCount` restava 0 e il
// badge del profilo non mostrava nessuna stagione anche a serie interamente
// vista. Il conteggio episodi era gia' corretto (chiave distinta sul NOME
// episodio in writeTitleStates.js), quindi le ore non cambiano: cambia la
// stagione. Misurato il 2026-09-08: 462 righe su 15 dei 19 import Netflix.
//
// Il fix a monte e' in lib/importAdapters/netflixCsv.js
// (`matchBrandedSeasonSegment`); questo script sistema lo storico.
//
// Sicuro per definizione: `buildImportTitleStateWrites` prende sempre il
// massimo fra stato esistente e stato derivato, quindi ri-applicare non puo'
// far regredire ne' progressi ne' minuti.
//
// Idempotente. Read-only finche' non passi --write.
//
// Uso:
//   cd functions
//   node scripts/repair-netflix-branded-season.js                    # dry-run
//   node scripts/repair-netflix-branded-season.js --write            # solo le righe
//   node scripts/repair-netflix-branded-season.js --write --apply-states
//   node scripts/repair-netflix-branded-season.js --uid=UID --import=ID
"use strict";

const admin = require("firebase-admin");
const { parseNetflixTitleCell } = require("../lib/importAdapters/netflixCsv");
const { buildImportTitleStateWrites } = require("../lib/importAdapters/writeTitleStates");

const args = process.argv.slice(2);
const flag = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() : "";
};
const WRITE = args.includes("--write");
// Ricalcola anche i titleStates degli import che ne hanno gia' scritti (vedi
// alreadyWroteStates in repairImport).
const APPLY_STATES = args.includes("--apply-states");
const ONLY_UID = flag("uid");
const ONLY_IMPORT = flag("import");

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

const asDate = (v) => (v && typeof v.toDate === "function" ? v.toDate() : null);

function nextFieldsFor(item) {
  const raw = String(item.rawTitle || "");
  if (!raw) return null;
  const parsed = parseNetflixTitleCell(raw);
  if (parsed.error) return null;
  const changed = {};
  if ((parsed.seasonNumber ?? null) !== (item.seasonNumber ?? null)) changed.seasonNumber = parsed.seasonNumber ?? null;
  if ((parsed.episodeNumber ?? null) !== (item.episodeNumber ?? null)) changed.episodeNumber = parsed.episodeNumber ?? null;
  if ((parsed.kind || null) !== (item.kind || null)) changed.kind = parsed.kind;
  if ((parsed.episodeNameGuess ?? null) !== (item.episodeNameGuess ?? null)) changed.episodeNameGuess = parsed.episodeNameGuess ?? null;
  return Object.keys(changed).length ? changed : null;
}

async function repairImport(importRef, importData) {
  const uid = importRef.parent.parent.id;
  const items = await importRef.collection("items").get();
  const updates = [];
  items.forEach((doc) => {
    const item = doc.data() || {};
    const changed = nextFieldsFor(item);
    if (changed) updates.push({ ref: doc.ref, changed, item });
  });
  if (!updates.length) return { uid, importId: importRef.id, rows: 0, states: 0 };

  if (WRITE) {
    for (let i = 0; i < updates.length; i += 400) {
      const batch = db.batch();
      updates.slice(i, i + 400).forEach((u) => batch.set(u.ref, u.changed, { merge: true }));
      // eslint-disable-next-line no-await-in-loop
      await batch.commit();
    }
  }

  // Il flusso Netflix scrive i titleStates gia' al primo giro di match: lo
  // stato `awaiting_confirmation` riguarda solo le righe rimaste irrisolte, non
  // il resto dell'import. Quindi non basta guardare `status`: si ricalcola
  // ovunque siano gia' stati scritti degli stati.
  const alreadyWroteStates = Array.isArray(importData.titleStateIdsWritten)
    ? importData.titleStateIdsWritten.length > 0
    : Number(importData.importedTitleCount || 0) > 0;

  let stateWrites = 0;
  if (APPLY_STATES && (String(importData.status || "") === "completed" || alreadyWroteStates)) {
    // Rilegge gli items DOPO la correzione (o li simula in dry-run).
    const patched = new Map(updates.map((u) => [u.ref.id, u.changed]));
    const matchedRows = [];
    const titleIds = new Set();
    items.forEach((doc) => {
      const item = { ...(doc.data() || {}), ...(patched.get(doc.id) || {}) };
      if (!item.resolved || !item.titleId || item.skip) return;
      titleIds.add(item.titleId);
      matchedRows.push({ titleId: item.titleId, item });
    });
    const titles = new Map();
    const ids = [...titleIds];
    for (let i = 0; i < ids.length; i += 10) {
      // eslint-disable-next-line no-await-in-loop
      const snaps = await Promise.all(ids.slice(i, i + 10).map((id) => db.collection("titles").doc(id).get()));
      snaps.forEach((s) => titles.set(s.id, s.exists ? s.data() : null));
    }
    const currentStates = new Map();
    for (let i = 0; i < ids.length; i += 10) {
      // eslint-disable-next-line no-await-in-loop
      const snaps = await Promise.all(ids.slice(i, i + 10)
        .map((id) => db.collection("users").doc(uid).collection("titleStates").doc(id).get()));
      snaps.forEach((s) => currentStates.set(s.id, s.exists ? s.data() : null));
    }

    const rows = matchedRows.map(({ titleId, item }) => ({
      titleId,
      title: titles.get(titleId),
      row: {
        rawTitle: item.rawTitle, rawDate: item.rawDate, kind: item.kind,
        seriesNameGuess: item.seriesNameGuess, movieNameGuess: item.movieNameGuess,
        seasonNumber: item.seasonNumber ?? null, episodeNumber: item.episodeNumber ?? null,
        episodeNameGuess: item.episodeNameGuess ?? null,
        watchedDate: asDate(item.watchedDate),
        watchedCount: item.watchedCount, rewatchCount: item.rewatchCount,
        wholeTitleCompleted: item.wholeTitleCompleted,
      },
    })).filter((r) => r.title);

    const writes = buildImportTitleStateWrites(rows, currentStates, {
      source: String(importData.source || "netflix_csv"),
      ...(importData.importOptions || {}),
      now: new Date(),
    });
    for (const w of writes) {
      const before = currentStates.get(w.titleId) || {};
      const beforeSeasons = Number(before?.seriesProgress?.seasonsCompletedCount || 0);
      const afterSeasons = Number(w.next?.seriesProgress?.seasonsCompletedCount || 0);
      const beforeLast = before?.seriesProgress?.lastWatchedSeasonNumber ?? null;
      const afterLast = w.next?.seriesProgress?.lastWatchedSeasonNumber ?? null;
      if (afterSeasons === beforeSeasons && afterLast === beforeLast) continue;
      stateWrites += 1;
      if (WRITE) {
        // eslint-disable-next-line no-await-in-loop
        await db.collection("users").doc(uid).collection("titleStates").doc(w.titleId)
          .set({ ...w.next, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      }
    }
  }

  return { uid, importId: importRef.id, rows: updates.length, states: stateWrites, status: importData.status };
}

async function run() {
  console.log(`modalita': ${WRITE ? "WRITE" : "DRY-RUN"}${APPLY_STATES ? " + ricalcolo titleStates" : ""}\n`);
  let docs;
  if (ONLY_UID && ONLY_IMPORT) {
    const snap = await db.collection("users").doc(ONLY_UID).collection("imports").doc(ONLY_IMPORT).get();
    docs = snap.exists ? [snap] : [];
  } else {
    // Nessuna esenzione collectionGroup su `imports.source`: si filtra a valle.
    const all = await db.collectionGroup("imports").get();
    docs = all.docs.filter((d) => String(d.data().source || "") === "netflix_csv");
  }
  console.log(`import Netflix da controllare: ${docs.length}\n`);

  let totalRows = 0, totalStates = 0, touched = 0;
  for (const doc of docs) {
    // eslint-disable-next-line no-await-in-loop
    const res = await repairImport(doc.ref, doc.data() || {});
    if (!res.rows) continue;
    touched += 1;
    totalRows += res.rows;
    totalStates += res.states;
    console.log(`  ${String(res.rows).padStart(4)} righe · ${res.states} stati · ${res.status} · users/${res.uid}/imports/${res.importId}`);
  }
  console.log(`\nimport toccati ${touched}/${docs.length} · righe ${totalRows} · titleStates ${totalStates}`);
  if (!WRITE) console.log("\nDRY-RUN: nessuna scrittura. Rilancia con --write (aggiungi --apply-states per gli import gia' completati).");
}

run().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
