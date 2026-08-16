#!/usr/bin/env node
/**
 * dm-operator.cjs — canale DM fra un account operativo configurato e un
 * utente Somto, via admin SDK.
 *
 * Usage (da functions/):
 *   OPERATOR_EMAIL=operator@example.com node scripts/dm-operator.cjs --to user --read [N]
 *   OPERATOR_EMAIL=operator@example.com node scripts/dm-operator.cjs --to user --send "testo"
 *
 * Il thread è il DM esistente più recente fra i due utenti; se non esiste ne
 * crea uno (doc shape identica a ensureDMThread della PWA). La scrittura del
 * messaggio replica la shape del callable sendThreadMessage, così il trigger
 * notifyOnThreadMessage manda la push al destinatario.
 */
const admin = require("firebase-admin");

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

const args = process.argv.slice(2);
function argVal(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}
const TO = String(argVal("--to") || "").trim();
const SEND = argVal("--send");
const READ = args.includes("--read");
const READ_N = Number(argVal("--read")) || 10;
const OPERATOR_EMAIL = String(process.env.OPERATOR_EMAIL || "").trim();
if (!TO) throw new Error("--to mancante");
if (!OPERATOR_EMAIL) throw new Error("OPERATOR_EMAIL mancante");
// Titolo di fallback se fra i due utenti non esiste ancora un thread DM
// (i DM di Somto sono agganciati a un titolo).
const FALLBACK_TITLE_ID = argVal("--title") || "berlino";

async function findUidByDisplayName(name) {
  const lower = String(name).toLowerCase();
  for (const field of ["displayNameLower", "displayName"]) {
    const q = await db.collection("users").where(field, "==", field.endsWith("Lower") ? lower : name).limit(2).get();
    if (q.size) return q.docs[0].id;
  }
  throw new Error(`utente "${name}" non trovato in users`);
}

async function findDmThread(uidA, uidB) {
  const q = await db.collection("threads")
    .where("contextType", "==", "dm")
    .where("participants", "array-contains", uidA)
    .get();
  const both = q.docs.filter((d) => (d.data().participants || []).includes(uidB));
  both.sort((a, b) => {
    const ta = a.data().lastMessageAt?.toMillis?.() || 0;
    const tb = b.data().lastMessageAt?.toMillis?.() || 0;
    return tb - ta;
  });
  return both[0] || null;
}

(async () => {
  const operator = await admin.auth().getUserByEmail(OPERATOR_EMAIL);
  const qaUid = operator.uid;
  const toUid = await findUidByDisplayName(TO);
  console.log(`operatore=${qaUid} destinatario(${TO})=${toUid}`);

  let threadSnap = await findDmThread(qaUid, toUid);
  let threadId;
  if (threadSnap) {
    threadId = threadSnap.id;
    console.log(`thread esistente: ${threadId}`);
  } else if (SEND) {
    const [a, b] = [qaUid, toUid].sort();
    threadId = `dm_${FALLBACK_TITLE_ID}_${a}_${b}`;
    await db.collection("threads").doc(threadId).set({
      titleId: FALLBACK_TITLE_ID,
      visibility: "private",
      contextType: "dm",
      contextId: `${a}_${b}`,
      participants: [a, b],
      groupName: "",
      createdBy: qaUid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      lastMessageAt: null,
      lastMessagePreview: "",
      lastSenderUid: null,
      lastMessageId: null,
    }, { merge: true });
    console.log(`thread creato: ${threadId}`);
  } else {
    console.log("nessun thread DM esistente e niente da inviare.");
    process.exit(0);
  }

  if (SEND) {
    const userDoc = await db.collection("users").doc(qaUid).get();
    const displayName = (userDoc.data()?.displayName || "Claude QA").slice(0, 80);
    const threadRef = db.collection("threads").doc(threadId);
    const messageRef = threadRef.collection("messages").doc();
    const now = admin.firestore.FieldValue.serverTimestamp();
    const batch = db.batch();
    batch.set(messageRef, {
      uid: qaUid,
      displayName,
      text: SEND,
      type: "text",
      createdAt: now,
      containsSpoiler: false,
      spoilerTitleIds: [],
    });
    batch.set(threadRef, {
      lastMessageId: messageRef.id,
      lastMessageAt: now,
      lastMessagePreview: SEND.replace(/\s+/g, " ").slice(0, 100),
      lastSenderUid: qaUid,
    }, { merge: true });
    await batch.commit();
    console.log(`inviato: ${messageRef.id}`);
  }

  if (READ || !SEND) {
    const msgs = await db.collection("threads").doc(threadId)
      .collection("messages").orderBy("createdAt", "desc").limit(READ_N).get();
    console.log(`--- ultimi ${msgs.size} messaggi (dal più recente) ---`);
    for (const m of msgs.docs) {
      const d = m.data();
      const when = d.createdAt?.toDate?.()?.toISOString?.() || "?";
      console.log(`[${when}] ${d.displayName || d.uid}: ${String(d.text || "").slice(0, 500)}`);
    }
  }
  process.exit(0);
})().catch((e) => { console.error("ERRORE:", e.message); process.exit(1); });
