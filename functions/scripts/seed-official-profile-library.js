#!/usr/bin/env node
/**
 * seed-official-profile-library.js — segna tutto il catalogo come visto sul
 * profilo ufficiale `somto_official`.
 *
 * E' una facciata: l'account ufficiale non e' un utente reale (nessun account
 * Auth), ma un profilo che deve sembrare "uno che ha visto tutto". Non tocca
 * nessun dato di utenti veri e non entra in nessuna metrica community:
 * `collectInterestedUserUids` esclude gia' questo uid, quindi gli aggiornamenti
 * ufficiali non finiscono per targettare se stessi.
 *
 * Scrive SOLO la proiezione `library` + `users/{uid}.stats`, che sono le due
 * cose che i client leggono davvero per la griglia "Visti" e per i contatori
 * del profilo (web `listMyLibrary`, iOS `fetchLibrary`, entrambe read
 * `isSignedIn`). Volutamente NON scrive `titleStates`:
 *   - ogni titleState farebbe partire `recomputeUserStatsFromTitleStates`, cioe'
 *     20k `FieldValue.increment` sullo stesso documento utente — contesa
 *     garantita — e servirebbe una guardia nei trigger, cioe' un redeploy gen1
 *     (che su questo progetto puo' essere rifiutato);
 *   - senza titleStates il profilo ufficiale non compare tra i "watchers" di
 *     ogni serie e non entra in `getPublicProfileSeriesProgress`, che e' quello
 *     che vogliamo: e' una facciata, non deve sporcare feature reali.
 * I payload sono costruiti con gli stessi helper del server
 * (`functions/lib/titleStates.js`) per non divergere dallo schema.
 *
 * Uso (dry-run di default):
 *   cd functions
 *   node scripts/seed-official-profile-library.js --limit 25
 *   node scripts/seed-official-profile-library.js --limit 25 --write
 *   node scripts/seed-official-profile-library.js --write
 *   node scripts/seed-official-profile-library.js --clear --write   # rimuove tutto
 */

const admin = require("firebase-admin");
const {
  buildNextTitleState,
  buildLegacyLibraryProjection,
  computeUserStatsContribution,
  deriveContentCategory,
  emptyStatsByCategory,
  normalizeContentCategory,
  fallbackCategoryForMediaType,
} = require("../lib/titleStates");
const { SOMTO_OFFICIAL_UID } = require("../lib/officialUpdates");

const WRITE = process.argv.includes("--write");
const CLEAR = process.argv.includes("--clear");
const LIMIT = (() => {
  const i = process.argv.indexOf("--limit");
  if (i < 0 || !process.argv[i + 1]) return 0;
  return Number(process.argv[i + 1]) || 0;
})();

const BATCH_TITLES = 400; // 1 scrittura per titolo

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

const userRef = db.collection("users").doc(SOMTO_OFFICIAL_UID);

async function clearAll() {
  let removed = 0;
  for (const sub of ["library"]) {
    for (;;) {
      const snap = await userRef.collection(sub).limit(400).get();
      if (snap.empty) break;
      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      if (WRITE) await batch.commit();
      removed += snap.size;
      if (!WRITE) break; // in dry-run non cancella: eviterebbe di uscire dal loop
    }
  }
  if (WRITE) {
    await userRef.set({ stats: { watchedCount: 0, ratingsCount: 0, totalWatchMinutes: 0, rewatchCount: 0, byCategory: emptyStatsByCategory() } }, { merge: true });
  }
  console.log(`${WRITE ? "Rimossi" : "Da rimuovere"}: ${removed} doc.`);
}

async function main() {
  if (CLEAR) return clearAll();

  const now = new Date();
  const totals = { watchedCount: 0, ratingsCount: 0, totalWatchMinutes: 0, rewatchCount: 0 };
  const byCategory = emptyStatsByCategory();

  let query = db.collection("titles").where("status", "==", "approved").orderBy("__name__");
  if (LIMIT) query = query.limit(LIMIT);

  let processed = 0;
  let skipped = 0;
  let batch = db.batch();
  let ops = 0;
  let cursor = null;
  const pageSize = LIMIT ? Math.min(LIMIT, 500) : 500;

  for (;;) {
    let page = query.limit(pageSize);
    if (cursor) page = page.startAfter(cursor);
    const snap = await page.get();
    if (snap.empty) break;
    cursor = snap.docs[snap.docs.length - 1];

    for (const docSnap of snap.docs) {
      const title = { id: docSnap.id, ...(docSnap.data() || {}) };
      const isTv = String(title.type || "").trim().toLowerCase() === "tv";

      const state = buildNextTitleState(
        null,
        { type: isTv ? "mark_series_completed" : "mark_movie_seen", source: "official_profile" },
        title,
        { now }
      );
      state.titleId = title.id;

      const libraryPayload = buildLegacyLibraryProjection(state);
      if (!libraryPayload) {
        // Serie senza struttura stagioni: "completata" non e' rappresentabile.
        skipped++;
        continue;
      }

      const contribution = computeUserStatsContribution(state);
      totals.watchedCount += contribution.watchedCount;
      totals.ratingsCount += contribution.ratingsCount;
      totals.totalWatchMinutes += contribution.totalWatchMinutes;
      totals.rewatchCount += contribution.rewatchCount;
      const category = normalizeContentCategory(deriveContentCategory(title))
        || fallbackCategoryForMediaType(state.mediaType);
      const bucket = byCategory[category];
      bucket.watchedCount += contribution.watchedCount;
      bucket.ratingsCount += contribution.ratingsCount;
      bucket.totalWatchMinutes += contribution.totalWatchMinutes;
      bucket.rewatchCount += contribution.rewatchCount;

      batch.set(userRef.collection("library").doc(title.id), libraryPayload, { merge: true });
      ops += 1;
      processed++;

      if (ops >= BATCH_TITLES) {
        if (WRITE) await batch.commit();
        batch = db.batch();
        ops = 0;
        if (processed % 2000 === 0) console.log(`  …${processed} titoli`);
      }
    }

    if (LIMIT && processed >= LIMIT) break;
    if (snap.size < pageSize) break;
  }

  if (ops > 0 && WRITE) await batch.commit();

  const stats = { ...totals, byCategory };
  if (WRITE) {
    await userRef.set({ stats, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  }

  console.log(JSON.stringify({
    titoliProcessati: processed,
    saltati: skipped,
    stats: {
      watchedCount: stats.watchedCount,
      totalWatchMinutes: stats.totalWatchMinutes,
      ore: Math.round(stats.totalWatchMinutes / 60),
    },
  }, null, 2));
  if (!WRITE) console.log("DRY RUN — rilancia con --write per applicare.");
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("ERRORE:", err?.message || err);
  process.exit(1);
});
