#!/usr/bin/env node
/**
 * repair-series-progress-zero.js — ripara le serie rimaste "in corso a 0
 * episodi" (state=in_progress con episodesWatchedCount=0 e
 * seasonsCompletedCount=0, fonte import_*). Censimento col gemello read-only
 * scan-series-progress-zero.js.
 *
 * Due cause reali (2026-07-31):
 *   1. righe kind "movie" mis-matchate a un titolo TV (fallback AniList:
 *      film "My Fault" → anime WataMote) → il writer fabbricava una serie
 *      in corso senza episodi. Rimedio: NESSUNO stato → il doc va eliminato.
 *   2. parser Netflix: "Miniserie/Stagione N: Parte M" perdeva numero e nome
 *      episodio (Alias Grace, When They See Us). Rimedio: re-parse del
 *      rawTitle con il parser corretto → progresso/completamento reale.
 *
 * Per ogni doc incriminato ricostruisce lo stato DA ZERO dagli items di tutti
 * gli import dell'utente (con la logica corretta di writeTitleStates):
 *   - righe episodio contabili   → riscrive lo stato ricostruito
 *   - solo righe watchlistOnly   → stato watchlist ("da vedere")
 *   - solo righe kind movie      → elimina titleState + proiezioni
 *   - nessun item trovato        → salta e segnala (non ripara alla cieca)
 * Se l'utente ha un VOTO sul titolo il doc non viene mai eliminato.
 * Le stats si riallineano da sole via trigger incrementale.
 *
 * Uso:
 *   cd functions
 *   node scripts/repair-series-progress-zero.js              # dry-run, tutti
 *   node scripts/repair-series-progress-zero.js --uid=UID    # dry-run, uno
 *   node scripts/repair-series-progress-zero.js --write      # applica
 */
"use strict";

const admin = require("firebase-admin");
const { buildImportTitleStateWrites } = require("../lib/importAdapters/writeTitleStates");
const { buildNextTitleState } = require("../lib/titleStates");
const { parseNetflixTitleCell } = require("../lib/importAdapters/netflixCsv");

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const ONLY_UID = (args.find((a) => a.startsWith("--uid=")) || "").split("=")[1] || null;

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

const toDate = (v) => (v && typeof v.toDate === "function" ? v.toDate() : (v instanceof Date ? v : null));
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function isZeroProgressDoc(state) {
  if (state?.state !== "in_progress") return false;
  if (!String(state?.source || "").startsWith("import_")) return false;
  const p = state?.seriesProgress || {};
  return n(p.episodesWatchedCount) === 0 && n(p.seasonsCompletedCount) === 0;
}

// Ricostruisce la riga dagli item persistiti; per gli import Netflix
// ri-parsa il rawTitle così il fix "Parte N = episodio" agisce anche sulle
// righe già importate (gli item conservano i campi PARSATI col vecchio codice).
function rowFromItem(item, importSource) {
  if (importSource === "netflix_csv" && item.rawTitle) {
    const parsed = parseNetflixTitleCell(item.rawTitle);
    if (!parsed.error) {
      return { ...parsed, watchedDate: toDate(item.watchedDate) };
    }
  }
  return {
    kind: item.kind ?? null,
    seasonNumber: item.seasonNumber ?? null,
    episodeNumber: item.episodeNumber ?? null,
    episodeNameGuess: item.episodeNameGuess ?? null,
    watchedDate: toDate(item.watchedDate),
  };
}

async function hasTitleRating(uid, titleId) {
  const ratingId = `${uid}__${titleId}__title__0__0`;
  const snap = await db.collection("ratings").doc(ratingId).get();
  return snap.exists;
}

async function repairUser(uid, displayName) {
  const userRef = db.collection("users").doc(uid);
  const statesSnap = await userRef.collection("titleStates").get();
  const victims = statesSnap.docs.filter((d) => isZeroProgressDoc(d.data()));
  if (!victims.length) return { planned: 0, wrote: 0 };

  // Items di TUTTI gli import dell'utente, indicizzati per titleId.
  const importsSnap = await userRef.collection("imports").get();
  const watchRowsByTitle = new Map();
  const watchlistOnlyTitles = new Set();
  for (const imp of importsSnap.docs) {
    const importSource = imp.data()?.source || "";
    // eslint-disable-next-line no-await-in-loop
    const itemsSnap = await imp.ref.collection("items").get();
    itemsSnap.forEach((doc) => {
      const item = doc.data() || {};
      if (!item.resolved || item.skip === true || !item.titleId) return;
      if (item.watchlistOnly === true) {
        watchlistOnlyTitles.add(item.titleId);
        return;
      }
      if (!watchRowsByTitle.has(item.titleId)) watchRowsByTitle.set(item.titleId, []);
      watchRowsByTitle.get(item.titleId).push(rowFromItem(item, importSource));
    });
  }

  console.log(`\n== ${displayName} (${uid}) — ${victims.length} serie a zero`);
  let planned = 0;
  let wrote = 0;

  for (const stateDoc of victims) {
    const titleId = stateDoc.id;
    const state = stateDoc.data() || {};
    // eslint-disable-next-line no-await-in-loop
    const titleSnap = await db.collection("titles").doc(titleId).get();
    if (!titleSnap.exists) {
      console.log(`  - ${titleId}: titolo assente dal catalogo, salto.`);
      continue;
    }
    const title = { id: titleId, ...(titleSnap.data() || {}) };
    const rows = watchRowsByTitle.get(titleId) || [];
    const sourceLabel = String(state.source || "").replace(/^import_/, "");

    let action = null; // { type: "set"|"watchlist"|"delete", next? }
    if (rows.length) {
      const [write] = buildImportTitleStateWrites(
        rows.map((row) => ({ titleId, title, row })),
        new Map(),
        { now: new Date(), source: sourceLabel }
      );
      if (write && write.next?.state && write.next.state !== "not_started") {
        action = { type: "set", next: write.next };
      } else if (write) {
        // Ricostruzione = watchlist (righe TV senza segnale contabile).
        action = { type: "watchlist", next: write.next };
      } else {
        // Tutte righe kind "movie" → mis-match: nessuno stato legittimo.
        action = { type: "delete" };
      }
    } else if (watchlistOnlyTitles.has(titleId)) {
      action = {
        type: "watchlist",
        next: buildNextTitleState(null, { type: "toggle_watchlist", enabled: true, source: state.source }, title, { now: new Date() }),
      };
    } else {
      console.log(`  - ${title.name} [${titleId}]: NESSUN item negli import, salto (verificare a mano).`);
      continue;
    }

    if (action.type === "delete") {
      // eslint-disable-next-line no-await-in-loop
      if (await hasTitleRating(uid, titleId)) {
        console.log(`  - ${title.name} [${titleId}]: da eliminare ma HA UN VOTO → salto (verificare a mano).`);
        continue;
      }
    }

    planned += 1;
    const before = `${state.state} · ep=${n(state.seriesProgress?.episodesWatchedCount)} · min=${n(state.watchMinutesContribution)}`;
    const after = action.type === "delete"
      ? "ELIMINATO (mis-match righe film)"
      : `${action.next.state}${action.next.generalWatchlist ? " · watchlist" : ""} · ep=${n(action.next.seriesProgress?.episodesWatchedCount)} · min=${n(action.next.watchMinutesContribution)}`;
    console.log(`  - ${title.name} [${titleId}] (${sourceLabel})`);
    console.log(`      prima: ${before}`);
    console.log(`      dopo:  ${after}`);

    if (!WRITE) continue;

    if (action.type === "delete") {
      // eslint-disable-next-line no-await-in-loop
      await Promise.all([
        userRef.collection("titleStates").doc(titleId).delete(),
        userRef.collection("library").doc(titleId).delete(),
        userRef.collection("watchlist").doc(titleId).delete(),
      ]);
    } else {
      const payload = { ...action.next, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
      if (payload.state !== "completed_unrated" && payload.state !== "rated") {
        payload.completedAt = null;
        payload.completedAtTotalEpisodes = null;
      }
      // eslint-disable-next-line no-await-in-loop
      await userRef.collection("titleStates").doc(titleId).set(payload, { merge: true });
    }
    wrote += 1;
    console.log("      scritto.");
  }

  return { planned, wrote };
}

(async () => {
  const usersSnap = ONLY_UID
    ? { docs: [await db.collection("users").doc(ONLY_UID).get()] }
    : await db.collection("users").get();

  console.log(`Modalità: ${WRITE ? "WRITE" : "DRY-RUN"}`);
  let totalPlanned = 0;
  let totalWrote = 0;
  for (const userDoc of usersSnap.docs) {
    if (!userDoc.exists) continue;
    // Pre-filtro economico: la scansione titleStates avviene solo dentro
    // repairUser; qui si evita di caricare items per utenti senza vittime.
    // eslint-disable-next-line no-await-in-loop
    const quick = await db.collection("users").doc(userDoc.id).collection("titleStates")
      .where("state", "==", "in_progress").get();
    if (!quick.docs.some((d) => isZeroProgressDoc(d.data()))) continue;
    // eslint-disable-next-line no-await-in-loop
    const r = await repairUser(userDoc.id, userDoc.data()?.displayName || userDoc.id);
    totalPlanned += r.planned;
    totalWrote += r.wrote;
  }
  console.log(`\n===== ${WRITE ? `RIPARATE ${totalWrote}` : `DA RIPARARE ${totalPlanned} (dry-run, aggiungi --write)`} =====`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
