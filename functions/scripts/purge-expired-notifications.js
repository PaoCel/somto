#!/usr/bin/env node
/**
 * purge-expired-notifications.js — smaltisce l'arretrato di `notifications` e
 * `signals` oltre il TTL.
 *
 * La scheduled function `cleanupOldNotifications` fa lo stesso lavoro ma a
 * 400 doc per run, una volta al giorno: dopo mesi in cui falliva (indice
 * collection-group mancante, sistemato il 2026-07-28) l'arretrato ci
 * metterebbe settimane a scendere. Questo script cicla finche' non e' vuoto.
 *
 * Stessi TTL della scheduled function: notifiche 90 giorni, signals 120.
 *
 * Uso (dry-run di default):
 *   cd functions
 *   node scripts/purge-expired-notifications.js
 *   node scripts/purge-expired-notifications.js --write
 */

const admin = require("firebase-admin");

const WRITE = process.argv.includes("--write");
const DAY_MS = 24 * 60 * 60 * 1000;
const NOTIFICATION_TTL_MS = 90 * DAY_MS;
const SIGNAL_TTL_MS = 120 * DAY_MS;
const PAGE = 400;

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

async function purge(group, ttlMs) {
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - ttlMs);
  let deleted = 0;

  for (;;) {
    const snap = await db.collectionGroup(group)
      .where("createdAt", "<=", cutoff)
      .limit(PAGE)
      .get();
    if (snap.empty) break;

    if (!WRITE) {
      console.log(`${group}: ${snap.size} doc nella prima pagina (dry-run, mi fermo qui)`);
      const total = await db.collectionGroup(group).where("createdAt", "<=", cutoff).count().get();
      console.log(`${group}: ${total.data().count} doc oltre il TTL in totale`);
      return 0;
    }

    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deleted += snap.size;
    if (deleted % 4000 === 0) console.log(`  …${group}: ${deleted}`);
    if (snap.size < PAGE) break;
  }

  console.log(`${group}: ${deleted} doc eliminati`);
  return deleted;
}

async function main() {
  const notifications = await purge("notifications", NOTIFICATION_TTL_MS);
  const signals = await purge("signals", SIGNAL_TTL_MS);
  console.log(`\nTotale: ${notifications + signals} doc.`);
  if (!WRITE) console.log("DRY RUN — rilancia con --write per cancellare.");
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("ERRORE:", err?.message || err);
  process.exit(1);
});
