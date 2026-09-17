#!/usr/bin/env node
/**
 * repair-import-season-mismatch.js — ricalcola i titleStates di serie che
 * l'import ha marcato "completate" per colpa della numerazione di stagione
 * della sorgente (TV Time numera gli archi degli anime come stagioni: Dragon
 * Ball Super = 1 stagione TMDB da 131 episodi, ma l'export dice "stagione 4"
 * → `nextSeasonsCompleted >= totalSeasonCount` → serie intera accreditata).
 *
 * Vedi il guard `seasonNumberingLooksCompatible` in
 * functions/lib/importAdapters/writeTitleStates.js: questo script riapplica la
 * stessa logica CORRETTA alle righe già importate (gli items dell'import, che
 * conservano seasonNumber/episodeNumber/watchedDate) e riscrive lo stato.
 *
 * Ricostruisce lo stato da zero dalle righe dell'import, quindi va usato solo
 * su titoli la cui unica fonte è quell'import (`state.source` = import_*):
 * lo verifica e salta gli altri.
 *
 * Uso:
 *   node scripts/repair-import-season-mismatch.js --uid=UID --import=IMPORT_ID [--titleId=ID] [--write]
 * Senza --write è un dry-run (default).
 */
"use strict";

const admin = require("firebase-admin");
const { buildImportTitleStateWrites } = require("../lib/importAdapters/writeTitleStates");
const { estimateTitleTotals } = require("../lib/titleStates");

const args = process.argv.slice(2);
const flag = (name) => {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1).trim() : "";
};
const UID = flag("--uid");
const IMPORT_ID = flag("--import");
const ONLY_TITLE = flag("--titleId");
const WRITE = args.includes("--write");

if (!UID) {
  console.error("Uso: --uid=UID [--import=IMPORT_ID] [--titleId=ID] [--write]");
  console.error("Senza --import usa le righe di TUTTI gli import dell'utente (consigliato).");
  process.exit(1);
}

admin.initializeApp({ projectId: "gia-visto", storageBucket: "gia-visto.firebasestorage.app" });
const db = admin.firestore();

const toDate = (v) => (v && typeof v.toDate === "function" ? v.toDate() : (v instanceof Date ? v : null));

(async () => {
  // Le righe vanno prese da TUTTI gli import dell'utente, non da uno solo:
  // chi ha importato due volte (o da due sorgenti) ha gli episodi di uno
  // stesso titolo spalmati su piu' import, e ricostruire da uno solo
  // FAREBBE REGREDIRE il progresso invece di correggerlo.
  const importsSnap = IMPORT_ID
    ? [await db.collection("users").doc(UID).collection("imports").doc(IMPORT_ID).get()]
    : (await db.collection("users").doc(UID).collection("imports").get()).docs;

  const usable = importsSnap.filter((s) => s.exists);
  if (!usable.length) {
    console.error(`Nessun import trovato per ${UID}.`);
    process.exit(1);
  }

  const source = usable[0].data()?.source || "tvtime_gdpr";
  const options = usable[0].data()?.importOptions || {};

  // Gli items conservano season/episode/data: sono la stessa materia prima
  // delle righe originali del CSV/JSON.
  const rowsByTitle = new Map();
  for (const importSnap of usable) {
    const itemsSnap = await importSnap.ref.collection("items").get();
    itemsSnap.forEach((doc) => {
      const item = doc.data() || {};
      if (!item.resolved || item.skip || !item.titleId) return;
      if (item.watchlistOnly) return;
      if (ONLY_TITLE && item.titleId !== ONLY_TITLE) return;
      if (!rowsByTitle.has(item.titleId)) rowsByTitle.set(item.titleId, []);
      rowsByTitle.get(item.titleId).push({
        seasonNumber: item.seasonNumber ?? null,
        episodeNumber: item.episodeNumber ?? null,
        episodeNameGuess: item.episodeNameGuess ?? null,
        watchedDate: toDate(item.watchedDate),
      });
    });
  }

  console.log(`${usable.length} import (${source}) — ${rowsByTitle.size} titoli con righe di visione.\n`);

  let repaired = 0;
  for (const [titleId, rows] of rowsByTitle.entries()) {
    const [titleSnap, stateSnap] = await Promise.all([
      db.collection("titles").doc(titleId).get(),
      db.collection("users").doc(UID).collection("titleStates").doc(titleId).get(),
    ]);
    if (!titleSnap.exists || !stateSnap.exists) continue;

    const title = { id: titleId, ...(titleSnap.data() || {}) };
    if (title.type !== "tv") continue;
    const state = stateSnap.data() || {};

    if (!String(state.source || "").startsWith("import_")) {
      console.log(`- ${titleId}: salto, stato toccato anche fuori dall'import (source=${state.source})`);
      continue;
    }

    const totals = estimateTitleTotals(title);
    const maxSeason = rows.reduce((max, r) => Math.max(max, Number(r.seasonNumber) || 0), 0);
    const totalSeasonCount = Number(totals.totalSeasonCount) || 0;
    if (!(totalSeasonCount > 0 && maxSeason > totalSeasonCount)) continue; // numerazione compatibile: niente da riparare

    // Ricostruzione da zero (currentState = null): l'unica fonte è l'import.
    const [write] = buildImportTitleStateWrites(
      rows.map((row) => ({ titleId, title, row })),
      new Map(),
      { now: new Date(), source, ...options }
    );
    if (!write) continue;

    const before = `${state.state} · ${state.watchMinutesContribution} min · ep=${state.seriesProgress?.episodesWatchedCount ?? "?"}`;
    const after = `${write.next.state} · ${write.next.watchMinutesContribution} min · ep=${write.next.seriesProgress?.episodesWatchedCount ?? "?"}`;
    if (before === after) continue;

    console.log(`- ${titleId} (${title.name}): stagione max ${maxSeason} vs ${totalSeasonCount} nel catalogo`);
    console.log(`    prima: ${before}`);
    console.log(`    dopo:  ${after}`);
    repaired += 1;

    if (WRITE) {
      const payload = { ...write.next, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
      // Lo stato ricostruito non è più "completato": i marcatori di
      // completamento vanno rimossi, non lasciati a mentire.
      if (write.next.state !== "completed_unrated" && write.next.state !== "rated") {
        payload.completedAt = null;
        payload.completedAtTotalEpisodes = null;
      }
      await db.collection("users").doc(UID).collection("titleStates").doc(titleId).set(payload, { merge: true });
      console.log("    scritto.");
    }
  }

  console.log(`\n${repaired} titoli ${WRITE ? "riparati" : "da riparare (dry-run, aggiungi --write)"}.`);
  if (WRITE && repaired > 0) {
    console.log("Ricorda: node scripts/recompute-user-stats.js --uid=" + UID + " --write  (per riallineare ore/contatori)");
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
