#!/usr/bin/env node

// Backfill dell'accettazione termini community per gli utenti ESISTENTI.
//
// Contesto: la web app non ha mai persistito l'accettazione dei termini
// community (`communitySafetyAcceptedAt` / `communitySafetyVersion`) — la
// checkbox al signup e' sempre stata richiesta ma il flag non veniva scritto
// (solo iOS lo scriveva). Da questa release i NUOVI utenti web ricevono il
// flag; questo script "grandfather-a" gli utenti gia' registrati (che al
// signup avevano comunque accettato i termini) impostando il flag.
//
// SERVE prima di poter abilitare una regola Firestore che gatinga la chat
// sull'accettazione: senza questo backfill una regola simile bloccherebbe il
// 100% degli utenti web esistenti.
//
// Dry-run di default. Usa `--write` per applicare. Salta chi ha gia' il flag
// alla versione corrente e i profili sintetici (guided).
//
//   node scripts/backfill-community-safety.js            # dry-run
//   node scripts/backfill-community-safety.js --write     # applica

const admin = require("firebase-admin");

admin.initializeApp();

const db = admin.firestore();
const { FieldValue } = admin.firestore;

const COMMUNITY_SAFETY_VERSION = 1;
const WRITE = process.argv.includes("--write");
const PAGE_SIZE = 300;

function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return 0;
}

function alreadyAccepted(data) {
  return toMillis(data.communitySafetyAcceptedAt) > 0
    && Number(data.communitySafetyVersion || 0) >= COMMUNITY_SAFETY_VERSION;
}

async function main() {
  let lastDoc = null;
  let scanned = 0;
  let updated = 0;
  let skippedAccepted = 0;
  let skippedSynthetic = 0;

  for (;;) {
    let query = db.collection("users")
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(PAGE_SIZE);
    if (lastDoc) query = query.startAfter(lastDoc);

    const snap = await query.get();
    if (snap.empty) break;

    let batch = db.batch();
    let ops = 0;
    const flush = async () => {
      if (!ops) return;
      if (WRITE) await batch.commit();
      batch = db.batch();
      ops = 0;
    };

    for (const docSnap of snap.docs) {
      scanned += 1;
      lastDoc = docSnap;
      const data = docSnap.data() || {};

      if (data.isSynthetic === true || data.accountType === "guided_profile") {
        skippedSynthetic += 1;
        continue;
      }
      if (alreadyAccepted(data)) {
        skippedAccepted += 1;
        continue;
      }

      batch.set(docSnap.ref, {
        communitySafetyAcceptedAt: FieldValue.serverTimestamp(),
        communitySafetyVersion: COMMUNITY_SAFETY_VERSION,
        communitySafetyAcceptedSource: "backfill_2026_07",
      }, { merge: true });
      ops += 1;
      updated += 1;
      if (ops >= 400) await flush();
    }
    await flush();
  }

  console.log(JSON.stringify({
    mode: WRITE ? "write" : "dry-run",
    scanned,
    updated,
    skippedAccepted,
    skippedSynthetic,
  }, null, 2));
  if (!WRITE) console.log("Dry-run: nessuna scrittura. Rilancia con --write per applicare.");
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
