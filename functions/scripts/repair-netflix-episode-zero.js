#!/usr/bin/env node
/**
 * repair-netflix-episode-zero.js — Ripara le serie importate da Netflix rimaste
 * a "episodio zero".
 *
 * CAUSA: l'export "Cronologia visione" di Netflix (IT) etichetta gli episodi per
 * NOME, non con "Episodio N" (~97% delle righe serie). Il parser produceva quindi
 * episodeNumber=null e buildSeriesImportState contava SOLO gli episodi numerici →
 * episodesWatchedCount=0 → la serie finiva `in_progress` a 0 episodi. Fix in
 * lib/importAdapters/writeTitleStates.js: ogni (stagione, nome-episodio) distinto
 * conta come un episodio visto.
 *
 * Questo script rilegge gli `items` degli import Netflix di ogni utente (che
 * conservano episodeNameGuess), ricalcola lo stato serie con l'algoritmo CORRETTO
 * e riscrive titleStates + proiezioni library/watchlist SOLO dove il conteggio
 * episodi aumenta o lo stato cambia (mai regressione: passa lo stato corrente a
 * buildSeriesImportState, che fa Math.max su progresso e completedCount).
 *
 * Dopo l'esecuzione con --write, rilanciare:
 *   node scripts/recompute-user-stats.js --write
 * per fissare il baseline autoritativo di stats.totalWatchMinutes ecc.
 *
 * Uso:
 *   cd functions
 *   node scripts/repair-netflix-episode-zero.js                 # dry-run, tutti gli utenti
 *   node scripts/repair-netflix-episode-zero.js --uid=UID       # dry-run, un utente
 *   node scripts/repair-netflix-episode-zero.js --write         # applica
 */
"use strict";

const admin = require("firebase-admin");
const { buildImportTitleStateWrites } = require("../lib/importAdapters/writeTitleStates");
const {
  buildLegacyLibraryProjection,
  buildLegacyWatchlistProjection,
  isMeaningfulTitleState,
} = require("../lib/titleStates");

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const ONLY_UID = (args.find((a) => a.startsWith("--uid=")) || "").split("=")[1] || null;

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

function toPositiveInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

function buildProjectionPayload(basePayload, serverTimestampField, timestampKey) {
  const payload = { ...(basePayload || {}) };
  if (!payload || !Object.keys(payload).length) return null;
  payload.updatedAt = serverTimestampField;
  if (timestampKey && !payload[timestampKey]) payload[timestampKey] = serverTimestampField;
  return payload;
}

// Union of ALL resolved rows across a user's netflix_csv imports, grouped by
// titleId. Uses the persisted `items` docs (which carry episodeNameGuess). We
// keep every resolved row — including "ambiguous" ones with no season marker
// (single-season shows Netflix doesn't label "Stagione N") — and let the title
// doc's type decide movie-vs-series routing downstream, exactly as the live
// import does. Movies produce no seriesProgress and are filtered out of the
// write plan; only series with an increased episode count are rewritten.
async function collectNetflixRowsByTitle(userRef) {
  const importsSnap = await userRef.collection("imports").get();
  const netflixImports = importsSnap.docs.filter((d) => (d.data() || {}).source === "netflix_csv");
  const byTitleId = new Map();
  for (const impDoc of netflixImports) {
    // eslint-disable-next-line no-await-in-loop
    const items = await impDoc.ref.collection("items").get();
    items.forEach((it) => {
      const d = it.data() || {};
      if (!d.resolved || !d.titleId || d.skip === true) return;
      if (!byTitleId.has(d.titleId)) byTitleId.set(d.titleId, []);
      byTitleId.get(d.titleId).push({
        seasonNumber: d.seasonNumber ?? null,
        episodeNumber: d.episodeNumber ?? null,
        episodeNameGuess: d.episodeNameGuess ?? null,
        watchedDate: d.watchedDate && d.watchedDate.toDate ? d.watchedDate.toDate() : null,
      });
    });
  }
  return byTitleId;
}

async function loadTitles(ids) {
  const map = new Map();
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    // eslint-disable-next-line no-await-in-loop
    const snaps = await Promise.all(chunk.map((id) => db.collection("titles").doc(id).get()));
    snaps.forEach((snap, idx) => { if (snap.exists) map.set(chunk[idx], snap.data() || {}); });
  }
  return map;
}

async function loadStates(userRef, ids) {
  const map = new Map();
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    // eslint-disable-next-line no-await-in-loop
    const snaps = await Promise.all(chunk.map((id) => userRef.collection("titleStates").doc(id).get()));
    snaps.forEach((snap, idx) => map.set(chunk[idx], snap.exists ? snap.data() : null));
  }
  return map;
}

async function repairUser(uid) {
  const userRef = db.collection("users").doc(uid);
  const user = (await userRef.get()).data() || {};
  const rowsByTitle = await collectNetflixRowsByTitle(userRef);
  const titleIds = [...rowsByTitle.keys()];
  if (!titleIds.length) {
    console.log(`  ${uid} (${user.displayName || "?"}): nessuna riga Netflix risolta.`);
    return { uid, planned: 0, wrote: 0 };
  }
  const titleById = await loadTitles(titleIds);
  const currentStates = await loadStates(userRef, titleIds);

  const matchedRows = [];
  rowsByTitle.forEach((rows, titleId) => {
    const title = titleById.get(titleId);
    if (!title) return;
    rows.forEach((row) => matchedRows.push({ titleId, title, row }));
  });

  const writes = buildImportTitleStateWrites(matchedRows, currentStates, {
    now: new Date(),
    source: "netflix_csv",
  });

  const plan = [];
  for (const { titleId, next } of writes) {
    if (!next || !next.seriesProgress) continue;
    const cur = currentStates.get(titleId) || {};
    const curEp = toPositiveInt(cur.seriesProgress && cur.seriesProgress.episodesWatchedCount);
    const nextEp = toPositiveInt(next.seriesProgress.episodesWatchedCount);
    const changed = nextEp > curEp || String(next.state) !== String(cur.state);
    if (!changed) continue;
    plan.push({
      titleId,
      name: (titleById.get(titleId) || {}).name || titleId,
      from: `${cur.state || "-"}/ep${curEp}/min${toPositiveInt(cur.watchMinutesContribution)}`,
      to: `${next.state}/ep${nextEp}/min${toPositiveInt(next.watchMinutesContribution)}`,
      next,
    });
  }

  console.log(`\n== ${user.displayName || uid} (${uid}) — ${plan.length} serie da correggere (su ${titleIds.length} titoli Netflix risolti)`);
  plan.slice(0, 12).forEach((p) => console.log(`   ${p.name}: ${p.from} -> ${p.to}`));
  if (plan.length > 12) console.log(`   … +${plan.length - 12} altre`);

  if (!WRITE || !plan.length) return { uid, planned: plan.length, wrote: 0 };

  const writeFns = [];
  for (const p of plan) {
    const stateRef = userRef.collection("titleStates").doc(p.titleId);
    writeFns.push((batch) => batch.set(stateRef, p.next, { merge: true }));
    if (isMeaningfulTitleState(p.next)) {
      const lib = buildProjectionPayload(buildLegacyLibraryProjection(p.next), FieldValue.serverTimestamp(), "createdAt");
      const wl = buildProjectionPayload(buildLegacyWatchlistProjection(p.next), FieldValue.serverTimestamp(), "addedAt");
      if (lib) writeFns.push((batch) => batch.set(userRef.collection("library").doc(p.titleId), lib, { merge: true }));
      if (wl) writeFns.push((batch) => batch.set(userRef.collection("watchlist").doc(p.titleId), wl, { merge: true }));
    }
  }
  // commit in chunks of ~200 ops
  for (let i = 0; i < writeFns.length; i += 200) {
    const batch = db.batch();
    writeFns.slice(i, i + 200).forEach((fn) => fn(batch));
    // eslint-disable-next-line no-await-in-loop
    await batch.commit();
  }
  console.log(`   ✔ scritte ${plan.length} serie (${writeFns.length} op).`);
  return { uid, planned: plan.length, wrote: plan.length };
}

(async () => {
  let uids;
  if (ONLY_UID) {
    uids = [ONLY_UID];
  } else {
    const imps = await db.collectionGroup("imports").get();
    const set = new Set();
    imps.forEach((d) => { if ((d.data() || {}).source === "netflix_csv") set.add(d.ref.parent.parent.id); });
    uids = [...set];
  }
  console.log(`Modalità: ${WRITE ? "WRITE" : "DRY-RUN"} — utenti: ${uids.length}`);
  let totalPlanned = 0, totalWrote = 0;
  for (const uid of uids) {
    // eslint-disable-next-line no-await-in-loop
    const r = await repairUser(uid);
    totalPlanned += r.planned; totalWrote += r.wrote;
  }
  console.log(`\n===== ${WRITE ? "SCRITTE" : "DA CORREGGERE"}: ${WRITE ? totalWrote : totalPlanned} serie su ${uids.length} utenti =====`);
  if (WRITE) console.log("Ora esegui: node scripts/recompute-user-stats.js --write");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
