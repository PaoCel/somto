/**
 * Backfill: le serie "in corso" (state == "in_progress") che avevano perso il
 * flag `generalWatchlist` per il bug lato server (functions/lib/titleStates.js
 * azzerava generalWatchlist a QUALSIASI progresso, non solo al completamento —
 * risolto dal commit 82ea25e) sparivano dalla watchlist "Da vedere". Il fix
 * server preserva il flag solo per i NUOVI progressi; questo script ripristina
 * i dati già sporchi mettendo `generalWatchlist: true` sulle serie in corso.
 *
 * Una serie che stai guardando appartiene alla watchlist (richiesta prodotto).
 *
 * SICUREZZA trigger (verificata): flippare solo `generalWatchlist` su un doc già
 * `in_progress` NON genera eventi feed (onSeriesStartedFeedEvent esce se
 * before.state === "in_progress") e NON tocca le watch-stats (delta 0); aggiorna
 * solo la proiezione library per includere la serie — comportamento voluto.
 *
 * Index-free: itera gli utenti e interroga la subcollection titleStates di
 * ciascuno (indice single-field automatico), niente collectionGroup index.
 * Salta i profili sintetici/guidati.
 *
 * Uso:
 *   node functions/scripts/backfill-inprogress-watchlist.js            (DRY-RUN)
 *   node functions/scripts/backfill-inprogress-watchlist.js --write    (ESEGUE)
 *   node functions/scripts/backfill-inprogress-watchlist.js --write --uid=<UID>  (solo un utente)
 */
const admin = require("firebase-admin");

admin.initializeApp({ projectId: "gia-visto", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const WRITE = process.argv.includes("--write");
const uidArg = (process.argv.find((a) => a.startsWith("--uid=")) || "").split("=")[1] || null;

(async () => {
  const userDocs = uidArg
    ? [await db.collection("users").doc(uidArg).get()]
    : (await db.collection("users").get()).docs;

  let users = 0;
  let skippedSynthetic = 0;
  let totalInProgress = 0;
  let candidates = 0;
  let flipped = 0;
  let usersAffected = 0;
  const sample = [];

  for (const userDoc of userDocs) {
    if (!userDoc.exists) continue;
    const u = userDoc.data() || {};
    if (u.isSynthetic === true || u.accountType === "guided_profile") {
      skippedSynthetic += 1;
      continue;
    }
    users += 1;

    const tsSnap = await userDoc.ref
      .collection("titleStates")
      .where("state", "==", "in_progress")
      .get();

    let batch = db.batch();
    let ops = 0;
    let userFlipped = 0;

    for (const doc of tsSnap.docs) {
      const d = doc.data() || {};
      totalInProgress += 1;
      // in_progress è uno stato SOLO serie, ma difendiamoci comunque.
      if (String(d.mediaType || "").toLowerCase() !== "tv") continue;
      if (d.generalWatchlist === true) continue;

      candidates += 1;
      if (sample.length < 8) sample.push(`${userDoc.id}/${doc.id}`);

      if (WRITE) {
        // merge del solo campo: NON tocca updatedAt (preserva l'ordinamento) né source.
        batch.set(doc.ref, { generalWatchlist: true }, { merge: true });
        ops += 1;
        flipped += 1;
        userFlipped += 1;
        if (ops >= 400) {
          await batch.commit();
          batch = db.batch();
          ops = 0;
        }
      }
    }

    if (WRITE && ops > 0) await batch.commit();
    if (userFlipped > 0) usersAffected += 1;
  }

  console.log(JSON.stringify({
    mode: WRITE ? "WRITE" : "DRY-RUN",
    scope: uidArg ? `uid=${uidArg}` : "all users",
    usersScanned: users,
    skippedSynthetic,
    totalInProgressSeries: totalInProgress,
    candidatesToFlip: candidates,
    flipped,
    usersAffected,
    sample,
  }, null, 2));
  process.exit(0);
})().catch((e) => {
  console.error("ERR", e && e.message ? e.message : e);
  process.exit(1);
});
