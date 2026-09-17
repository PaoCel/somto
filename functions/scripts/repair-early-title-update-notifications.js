#!/usr/bin/env node
/**
 * repair-early-title-update-notifications.js
 *
 * Ripara il residuo del bug "notifica anticipata" (incidente Ted Lasso S4E3,
 * 2026-08-13): fino a quel giorno un episodio scoperto in anticipo veniva
 * notificato al momento della scoperta invece che il giorno dell'uscita. La
 * guardia `titleUpdateWaitsForAirDate` ha chiuso il buco per gli eventi nuovi,
 * ma quelli gia' notificati restano muti il giorno in cui escono davvero: l'id
 * della notifica e' deterministico, quindi la sweep trova il lavoro fatto.
 *
 * Cosa fa, per ogni evento con notifica scritta PRIMA del giorno di uscita:
 *   1. cancella i doc notifica prematuri dei destinatari;
 *   2. azzera `notifiedAtMs` sull'evento;
 *   3. per gli episodi GIA' usciti (--resend) rifa' subito il fan-out.
 * Per gli episodi futuri non serve altro: ci pensa `notifyDueTitleUpdates`
 * la mattina dell'uscita.
 *
 * Uso:
 *   cd functions
 *   node scripts/repair-early-title-update-notifications.js            # dry-run
 *   node scripts/repair-early-title-update-notifications.js --write
 *   node scripts/repair-early-title-update-notifications.js --write --resend
 *   ... --days=3        quanti giorni indietro guardare (default 3)
 */

const admin = require("firebase-admin");
const {
  fanOutTitleUpdate,
  titleUpdateNotificationId,
  dayKeyForMs,
} = require("../lib/titleUpdateNotifications");

const PROJECT_ID = "gia-visto";
const WRITE = process.argv.includes("--write");
const RESEND = process.argv.includes("--resend");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) || "").split("=")[1]) || 3;
// Quanto indietro ha senso rimandare una notifica: "nuovo episodio" tre giorni
// dopo non e' una notizia, e' rumore. Due giorni e' il limite.
const RESEND_MAX_AGE_DAYS = Number((process.argv.find((a) => a.startsWith("--resend-days=")) || "").split("=")[1]) || 2;
// Tetto di destinatari ispezionati per evento: sopra questo numero il residuo
// non e' piu' un residuo ed e' meglio fermarsi e guardarlo a mano.
const MAX_RECIPIENTS_PER_EVENT = 600;

function log(...args) {
  console.log(...args);
}

async function recipientsForTitle(db, titleId) {
  const snap = await db.collectionGroup("titleStates")
    .where("titleId", "==", titleId)
    .limit(MAX_RECIPIENTS_PER_EVENT)
    .get();
  const uids = new Set();
  snap.docs.forEach((docSnap) => {
    const uid = docSnap.ref?.parent?.parent?.id;
    if (uid) uids.add(uid);
  });
  return [...uids];
}

async function main() {
  admin.initializeApp({ projectId: PROJECT_ID });
  const db = admin.firestore();
  const nowMs = Date.now();
  const fromMs = nowMs - DAYS * 24 * 60 * 60 * 1000;
  const todayKey = Number(dayKeyForMs(nowMs));

  const snap = await db.collection("titleUpdateEvents")
    .where("eventType", "==", "new_episode")
    .where("status", "==", "published")
    .where("effectiveAt", ">=", admin.firestore.Timestamp.fromMillis(fromMs))
    .orderBy("effectiveAt", "asc")
    .limit(400)
    .get();

  log(`eventi nella finestra (${DAYS} giorni indietro → futuro): ${snap.size}`);

  let affected = 0;
  let deleted = 0;
  let resent = 0;

  for (const docSnap of snap.docs) {
    const event = docSnap.data() || {};
    if (event.acquisitionMode !== "live" || event.notificationEligible !== true) continue;

    const airMs = event.effectiveAt?.toDate?.()?.getTime?.();
    if (!airMs) continue;
    const airKey = Number(dayKeyForMs(airMs));
    const notificationId = titleUpdateNotificationId(docSnap.id);

    const uids = await recipientsForTitle(db, event.titleId);
    if (!uids.length) continue;

    // Una lettura campione dice se l'evento e' fra quelli anticipati: se la
    // notifica del primo destinatario e' nata prima del giorno di uscita, lo
    // sono tutte (sono state scritte nello stesso fan-out).
    const refs = uids.map((uid) => db.collection("users").doc(uid).collection("notifications").doc(notificationId));
    const docs = await db.getAll(...refs);
    const early = docs.filter((snapshot) => {
      if (!snapshot.exists) return false;
      const createdMs = snapshot.data()?.createdAt?.toDate?.()?.getTime?.();
      return Boolean(createdMs) && Number(dayKeyForMs(createdMs)) < airKey;
    });
    if (!early.length) continue;

    affected += 1;
    const airLabel = new Date(airMs).toISOString().slice(0, 10);
    const isPast = airKey <= todayKey;
    const ageDays = Math.round((nowMs - airMs) / (24 * 60 * 60 * 1000));
    const resendable = isPast && RESEND && ageDays <= RESEND_MAX_AGE_DAYS;
    // Un episodio uscito da giorni non si rimanda (sarebbe rumore) e non si
    // ripulisce: quella notifica e' stata comunque consegnata, ed e' storia
    // dell'utente. Cancellarla toglierebbe qualcosa senza dare niente.
    const skip = isPast && !resendable;
    const action = skip
      ? `lasciata com'e' (uscito ${ageDays}gg fa)`
      : !isPast
        ? "cancella (la sweep rifara' il giorno giusto)"
        : "cancella e rimanda";
    log(`  ${airLabel} | ${docSnap.id} | ${early.length} notifiche premature → ${action}`);

    if (skip || !WRITE) continue;

    for (let i = 0; i < early.length; i += 400) {
      const batch = db.batch();
      early.slice(i, i + 400).forEach((snapshot) => batch.delete(snapshot.ref));
      await batch.commit();
    }
    deleted += early.length;
    await docSnap.ref.set({ notifiedAtMs: admin.firestore.FieldValue.delete() }, { merge: true });

    if (resendable) {
      const result = await fanOutTitleUpdate({
        db,
        admin,
        eventId: docSnap.id,
        before: null,
        after: event,
        nowMs,
      });
      if (result?.written) resent += Number(result.written);
      await docSnap.ref.set({ notifiedAtMs: nowMs }, { merge: true });
      log(`    rimandata a ${result?.written || 0} destinatari`);
    }
  }

  log(`\neventi con notifiche premature: ${affected}`);
  if (WRITE) log(`notifiche cancellate: ${deleted} | notifiche rimandate: ${resent}`);
  else log("nessuna scrittura: rilancia con --write (aggiungi --resend per rimandare quelle gia' uscite)");
  process.exit(0);
}

main().catch((err) => {
  console.error("errore:", err?.message || err);
  process.exit(1);
});
