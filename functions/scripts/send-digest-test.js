#!/usr/bin/env node
/**
 * send-digest-test.js — manda il digest settimanale a UN account solo, per
 * guardarlo su un telefono vero prima che lo veda tutta la base utenti.
 *
 * Usa la stessa selezione e lo stesso documento della funzione schedulata
 * (`lib/weeklyDigest.js`), con una sola differenza: la chiave di settimana
 * porta un suffisso (`2026-W35-test`), quindi **non consuma il digest della
 * settimana** — il run di giovedì partirà lo stesso per quella persona.
 *
 * Uso (dry-run di default):
 *   cd functions
 *   node scripts/send-digest-test.js --uid <uid>
 *   node scripts/send-digest-test.js --uid <uid> --write
 */

const admin = require("firebase-admin");

const {
  buildWeeklyDigestNotification,
  digestNotificationId,
  digestWeekKey,
  selectDigestItems,
} = require("../lib/weeklyDigest");

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] || "").trim() : "";
};
const UID = arg("--uid");
const WRITE = process.argv.includes("--write");

if (!UID) {
  console.error("serve --uid <uid>");
  process.exit(1);
}

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const WINDOW_BACK_MS = 7 * DAY;
const WINDOW_FORWARD_MS = 14 * DAY;

(async () => {
  const userRef = db.collection("users").doc(UID);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw new Error(`utente ${UID} inesistente`);

  const eventsSnap = await db.collection("titleUpdateEvents")
    .where("effectiveAt", ">=", admin.firestore.Timestamp.fromMillis(NOW - WINDOW_BACK_MS))
    .where("effectiveAt", "<=", admin.firestore.Timestamp.fromMillis(NOW + WINDOW_FORWARD_MS))
    .orderBy("effectiveAt", "asc")
    .get();

  const events = [];
  const titleIds = new Set();
  eventsSnap.forEach((doc) => {
    const data = doc.data() || {};
    if (data.status && data.status !== "published") return;
    if (!data.titleId) return;
    events.push({ id: doc.id, data });
    titleIds.add(data.titleId);
  });

  const ids = [...titleIds];
  const names = new Map();
  for (let i = 0; i < ids.length; i += 250) {
    const refs = ids.slice(i, i + 250).map((id) => db.collection("titles").doc(id));
    // eslint-disable-next-line no-await-in-loop
    const docs = await db.getAll(...refs);
    docs.forEach((doc) => { if (doc.exists) names.set(doc.id, String(doc.data()?.name || "")); });
  }
  events.forEach((row) => { row.titleName = names.get(row.data.titleId) || ""; });

  const states = {};
  const prefs = {};
  for (let i = 0; i < ids.length; i += 250) {
    const chunk = ids.slice(i, i + 250);
    // eslint-disable-next-line no-await-in-loop
    const [stateDocs, prefDocs] = await Promise.all([
      db.getAll(...chunk.map((id) => userRef.collection("titleStates").doc(id))),
      db.getAll(...chunk.map((id) => userRef.collection("titleUpdatePrefs").doc(id))),
    ]);
    stateDocs.forEach((doc) => { if (doc.exists) states[doc.id] = doc.data() || {}; });
    prefDocs.forEach((doc) => { if (doc.exists) prefs[doc.id] = doc.data() || {}; });
  }

  const items = selectDigestItems({
    events,
    statesByTitleId: states,
    prefsByTitleId: prefs,
    nowMs: NOW,
  });

  if (!items.length) {
    console.log("nessuna novità per questo account: niente da mandare.");
    return;
  }

  const weekKey = `${digestWeekKey(NOW)}-test`;
  const notification = buildWeeklyDigestNotification({
    admin, uid: UID, items, weekKey, nowMs: NOW,
  });

  console.log(`destinatario: ${userSnap.data()?.displayName || UID}`);
  console.log(`id notifica:  ${digestNotificationId(weekKey)}`);
  console.log(`push/titolo:  "Novità sui tuoi titoli"`);
  console.log(`push/corpo:   "${notification.data.message}"`);
  console.log(`seconda riga: "${notification.data.preview}"`);
  console.log(`tap porta a:  ${notification.data.ctaUrl}`);
  items.forEach((row) => console.log(`  · ${row.messageByLocale["it-IT"]}`));

  if (!WRITE) {
    console.log("\nDRY RUN — rilancia con --write per mandarla davvero.");
    return;
  }

  await userRef.collection("notifications").doc(digestNotificationId(weekKey)).create(notification);
  console.log("\nMANDATA.");
})().catch((error) => {
  console.error("ERRORE", error.message);
  process.exit(1);
});
