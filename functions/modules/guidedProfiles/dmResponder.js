/**
 * Guided Profiles — risposta automatica ai DM.
 *
 * Se un utente reale scrive in un thread privato dove un partecipante e' un
 * profilo guidato:
 *  - NON si apre una conversazione normale;
 *  - si invia UNA risposta automatica chiara (disclosure), una sola volta;
 *  - il profilo guidato non risponde mai fingendo una persona;
 *  - l'evento viene loggato in `guidedDmAttempts`.
 *
 * I profili guidati NON iniziano mai DM verso utenti reali (la routine non lo fa).
 */

const { COLLECTIONS, DM_AUTO_REPLY } = require("./constants");
const { isGuidedUid } = require("./guards");

/**
 * Handler del trigger onCreate su threads/{threadId}/messages/{messageId}.
 * @param {object} deps { db, admin, logger }
 */
async function handleThreadMessageForGuidedDm({ db, admin, logger }, snap, context) {
  const threadId = context.params.threadId;
  const msg = snap.data() || {};
  const senderUid = String(msg.uid || "").trim();
  if (!senderUid) return null;

  // Un profilo guidato che "parla" (anche l'auto-reply stessa) non innesca nulla.
  if (isGuidedUid(senderUid)) return null;

  const threadRef = db.collection("threads").doc(threadId);
  const threadSnap = await threadRef.get().catch(() => null);
  if (!threadSnap || !threadSnap.exists) return null;
  const thread = threadSnap.data() || {};

  // Solo thread privati 1:1/gruppo, mai discussioni pubbliche.
  if (thread.visibility === "public") return null;

  const participants = Array.isArray(thread.participants) ? thread.participants : [];
  const guidedRecipients = participants.filter((p) => p !== senderUid && isGuidedUid(p));
  if (!guidedRecipients.length) return null;

  // Logga sempre il tentativo (per debug), senza PII oltre al preview troncato.
  const preview = String(msg.text || "").slice(0, 120);
  try {
    await db.collection(COLLECTIONS.DM_ATTEMPTS).doc().set({
      threadId,
      fromUid: senderUid,
      guidedUids: guidedRecipients,
      preview,
      alreadyLocked: thread.guidedLocked === true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    logger.warn("[guidedDm] attempt log failed", { threadId, error: err?.message || String(err) });
  }

  // Auto-reply una sola volta per thread (evita spam ad ogni messaggio).
  if (thread.guidedLocked === true) {
    logger.info("[guidedDm] thread already locked, no second auto-reply", { threadId });
    return null;
  }

  const guidedUid = guidedRecipients[0];
  // Nome del profilo guidato per il messaggio (best-effort).
  let guidedName = "Profilo guidato";
  try {
    const gSnap = await db.collection("users").doc(guidedUid).get();
    if (gSnap.exists) guidedName = gSnap.data()?.displayName || guidedName;
  } catch (_) { /* noop */ }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const replyRef = threadRef.collection("messages").doc();
  const batch = db.batch();
  batch.set(replyRef, {
    uid: guidedUid,
    displayName: guidedName,
    text: DM_AUTO_REPLY,
    type: "text",
    isSynthetic: true,
    autoReply: true,
    createdAt: now,
  });
  batch.set(threadRef, {
    guidedLocked: true,
    guidedAutoReplyAt: now,
    lastMessageAt: now,
    lastMessagePreview: DM_AUTO_REPLY.slice(0, 100),
    lastSenderUid: guidedUid,
    lastMessageId: replyRef.id,
  }, { merge: true });

  await batch.commit();
  logger.info("[guidedDm] auto-reply sent", { threadId, guidedUid, fromUid: senderUid });
  return null;
}

module.exports = { handleThreadMessageForGuidedDm };
