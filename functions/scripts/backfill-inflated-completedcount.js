#!/usr/bin/env node
//
// Censimento + mini-backfill dei titleStates gonfiati dal bug completedCount
// (fix 2026-07-05 in lib/titleStates.js normalizeStateForTitle): una serie
// `in_progress` con `seenAt` valorizzato riceveva completedCount=1 come se un
// run completo fosse finito, gonfiando watchMinutesContribution di un run
// intero (episodi_totali × durata_episodio) a ogni progress update, oltre a
// contare la serie come "vista" (watchedCount) e a proiettarla in library.
//
// Doc gonfiato = mediaType tv AND state in_progress AND completedCount>=1
// AND completedAt assente (un run completato vero stampa sempre completedAt;
// il catch-up post-completamento lo preserva — quei doc sono legittimi).
//
// Per ogni doc gonfiato: completedCount -> 0, watchMinutesContribution
// ricalcolato con la STESSA funzione condivisa del runtime, delete della
// proiezione library/{titleId} spuria (buildLegacyLibraryProjection torna
// null a completedCount 0 + non-completed). Poi recomputeUserStatsForUid
// (stessa funzione di reconcileUserStats) per gli utenti toccati.
//
// Usage:
//   cd functions
//   node scripts/backfill-inflated-completedcount.js            # dry-run (censimento)
//   node scripts/backfill-inflated-completedcount.js --write    # applica

const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const {
  computeWatchMinutesContribution,
  buildLegacyLibraryProjection,
} = require("../lib/titleStates");
const { recomputeUserStatsForUid } = require("../lib/userStats");

const WRITE = process.argv.includes("--write");

initializeApp();
const db = getFirestore();

const titleCache = new Map();

async function getTitle(titleId) {
  if (titleCache.has(titleId)) return titleCache.get(titleId);
  const snap = await db.collection("titles").doc(titleId).get().catch(() => null);
  const data = snap?.exists ? { id: titleId, ...(snap.data() || {}) } : null;
  titleCache.set(titleId, data);
  return data;
}

function toPositiveInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

function isInflated(state) {
  return String(state.mediaType || "").toLowerCase() === "tv"
    && String(state.state || "").trim().toLowerCase() === "in_progress"
    && toPositiveInt(state.completedCount) >= 1
    && !state.completedAt;
}

async function main() {
  console.log(`\nInflated completedCount backfill - ${WRITE ? "WRITE" : "DRY RUN (censimento)"}\n`);
  const usersSnap = await db.collection("users").get();
  let inflatedDocs = 0;
  let minutesDelta = 0;
  const affectedUids = [];

  for (const userDoc of usersSnap.docs) {
    const uid = userDoc.id;
    const statesSnap = await userDoc.ref.collection("titleStates").get().catch(() => ({ docs: [] }));
    const hits = statesSnap.docs.filter((d) => isInflated(d.data() || {}));
    if (!hits.length) continue;

    affectedUids.push(uid);
    for (const docSnap of hits) {
      const state = docSnap.data() || {};
      const titleId = String(state.titleId || docSnap.id || "").trim();
      const title = await getTitle(titleId);
      const repaired = { ...state, completedCount: 0 };
      repaired.watchMinutesContribution = computeWatchMinutesContribution(
        title || { id: titleId, type: "tv" },
        repaired
      );
      const oldMinutes = toPositiveInt(state.watchMinutesContribution);
      const delta = oldMinutes - repaired.watchMinutesContribution;
      inflatedDocs += 1;
      minutesDelta += delta;

      const librarySnap = await userDoc.ref.collection("library").doc(titleId).get().catch(() => null);
      const spuriousLibrary = Boolean(librarySnap?.exists) && !buildLegacyLibraryProjection(repaired);

      console.log(
        `  ${uid} / ${titleId}: completedCount ${state.completedCount} -> 0, `
        + `minuti ${oldMinutes} -> ${repaired.watchMinutesContribution} (delta -${delta})`
        + (spuriousLibrary ? ", library spuria da rimuovere" : "")
      );

      if (WRITE) {
        await docSnap.ref.set({
          completedCount: 0,
          watchMinutesContribution: repaired.watchMinutesContribution,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        if (spuriousLibrary) {
          await librarySnap.ref.delete();
        }
      }
    }
  }

  if (WRITE) {
    for (const uid of affectedUids) {
      const stats = await recomputeUserStatsForUid(db, uid);
      console.log(`  stats ricomputate ${uid}: watched ${stats.watchedCount}, min ${stats.totalWatchMinutes}`);
    }
  }

  console.log(`\nTotale: ${inflatedDocs} doc gonfiati su ${affectedUids.length} utenti, ${minutesDelta} minuti in eccesso.`);
  if (!WRITE && inflatedDocs > 0) console.log("Rilancia con --write per applicare.\n");
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
