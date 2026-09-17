#!/usr/bin/env node
/**
 * check-collection-group-indexes.js — verifica che ogni query collection-group
 * usata dal backend abbia il suo indice in prod.
 *
 * Perche' esiste: una query collection-group senza indice non fallisce a
 * deploy-time, fallisce a runtime con FAILED_PRECONDITION. Se il chiamante ha
 * un `.catch()` l'errore sparisce e la feature semplicemente non fa niente.
 * Il 2026-07-28 ne sono state trovate 7 rotte da tempo: il fan-out degli
 * aggiornamenti ufficiali, la deduplica dei token push, la potatura di
 * notifications/signals e tre query di deleteMyAccount.
 *
 * Sola lettura, nessuna scrittura. Uscita 1 se manca almeno un indice.
 *
 * Uso:
 *   cd functions && node scripts/check-collection-group-indexes.js
 */

const admin = require("firebase-admin");

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

const OLD_DATE = new Date(Date.now() - 24 * 60 * 60 * 1000);

// Ogni voce rispecchia una query realmente presente nel codice.
const QUERIES = [
  { group: "titleStates", field: "titleId", op: "in", value: ["x"], usedBy: "publishOfficialUpdate (fan-out)" },
  { group: "notificationTokens", field: "token", op: "==", value: "x", usedBy: "cleanupDuplicateNotificationToken" },
  { group: "notifications", field: "createdAt", op: "<=", value: OLD_DATE, usedBy: "cleanupOldNotifications" },
  { group: "signals", field: "createdAt", op: "<=", value: OLD_DATE, usedBy: "cleanupOldNotifications" },
  { group: "comments", field: "uid", op: "==", value: "x", usedBy: "deleteMyAccount (anonimizzazione)" },
  { group: "likes", field: "uid", op: "==", value: "x", usedBy: "deleteMyAccount" },
  { group: "shares", field: "uid", op: "==", value: "x", usedBy: "deleteMyAccount" },
  { group: "messages", field: "uid", op: "==", value: "x", usedBy: "deleteMyAccount (anonimizzazione)" },
  { group: "savedLists", field: "listId", op: "==", value: "x", usedBy: "liste salvate" },
  { group: "imports", field: "createdAt", op: ">=", value: OLD_DATE, usedBy: "scanImportHealth" },
  { group: "quizStats", field: "totalScore", op: ">", value: 0, usedBy: "leaderboard quiz" },
];

async function main() {
  const missing = [];
  for (const q of QUERIES) {
    try {
      await db.collectionGroup(q.group).where(q.field, q.op, q.value).limit(1).get();
      console.log(`ok      ${q.group}.${q.field}`);
    } catch (err) {
      const building = /FAILED_PRECONDITION/.test(String(err?.message || ""));
      console.log(`MANCA   ${q.group}.${q.field}  → ${q.usedBy}`);
      if (building) missing.push(q);
    }
  }

  console.log("");
  if (!missing.length) {
    console.log("Tutte le query collection-group hanno il loro indice.");
    return;
  }
  console.log(`${missing.length} query senza indice (o con indice ancora in build).`);
  console.log("Aggiungi un fieldOverride in firestore.indexes.json e lancia:");
  console.log("  firebase deploy --only firestore:indexes --project gia-visto");
  process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode || 0)).catch((err) => {
  console.error("ERRORE:", err?.message || err);
  process.exit(2);
});
