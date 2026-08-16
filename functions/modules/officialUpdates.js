const {
  publishOfficialUpdate,
  publishDueOfficialUpdates,
  unpublishOfficialUpdate,
  SOMTO_OFFICIAL_UID,
} = require("../lib/officialUpdates");

const ENGAGEMENT_NOTIFICATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// I post ufficiali hanno come autore `somto_official`, un utente sintetico
// senza account Auth: like e commenti generavano notifiche che nessuno leggeva
// mai. Qui vengono girate agli admin (in-app + push, via il trigger esistente
// pushOnNotificationCreate) usando i type gia' gestiti dai client.
// Solo gli uid in ADMIN_UIDS: `users.isAdmin == true` in prod include anche
// curatori che non c'entrano con la redazione, e ritrovarsi notifiche di like
// su post editoriali sarebbe una sorpresa sgradita.
function resolveAdminUids({ getAdminUids }) {
  const configured = typeof getAdminUids === "function" ? getAdminUids() : [];
  return Array.isArray(configured) ? configured.filter(Boolean) : [];
}

async function isOfficialPost(db, postId) {
  const snap = await db.collection("posts").doc(postId).get();
  if (!snap.exists) return null;
  const post = snap.data() || {};
  if (String(post.authorUid || "") !== SOMTO_OFFICIAL_UID) return null;
  return post;
}

async function notifyAdmins({ db, admin, getAdminUids, notificationId, fromUid, type, data }) {
  const adminUids = resolveAdminUids({ getAdminUids });
  const recipients = adminUids.filter((uid) => uid && uid !== fromUid && uid !== SOMTO_OFFICIAL_UID);
  if (!recipients.length) return 0;

  const now = admin.firestore.FieldValue.serverTimestamp();
  const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + ENGAGEMENT_NOTIFICATION_TTL_MS);
  const batch = db.batch();
  for (const uid of recipients) {
    // Id deterministico: un like tolto e rimesso non genera due notifiche.
    const ref = db.collection("users").doc(uid).collection("notifications").doc(notificationId);
    batch.set(ref, {
      toUid: uid,
      fromUid,
      type,
      data,
      read: false,
      createdAt: now,
      expiresAt,
    }, { merge: false });
  }
  await batch.commit();
  return recipients.length;
}

function registerOfficialUpdates({ functions, admin, logger, isAdminCaller, enforceCallableRateLimit, getAdminUids }) {
  // Gen2: il database eur3 non accetta piu' trigger/funzioni Firestore gen1
  // nuove (vedi CLAUDE.md §Pending). Lo scheduler segue quindi la strada gia'
  // usata da characterVotes/episodeEmotions.
  const { onSchedule } = require("firebase-functions/v2/scheduler");
  const { onDocumentCreated } = require("firebase-functions/v2/firestore");

  return {
    notifyAdminsOnOfficialPostLike: onDocumentCreated(
      { document: "posts/{postId}/likes/{likeUid}", region: "europe-west1" },
      async (event) => {
        const { postId, likeUid } = event.params;
        const db = admin.firestore();
        const post = await isOfficialPost(db, postId);
        if (!post) return null;

        const fromSnap = await db.collection("users").doc(likeUid).get().catch(() => null);
        const fromName = String(fromSnap?.data()?.displayName || "Qualcuno").slice(0, 80);

        const written = await notifyAdmins({
          db,
          admin,
          getAdminUids,
          notificationId: `official_like_${postId}_${likeUid}`,
          fromUid: likeUid,
          type: "post_like",
          data: {
            fromName,
            postId,
            titleId: post.titleId || null,
            isOfficial: true,
          },
        });
        logger.info("[officialUpdates] like su post ufficiale", { postId, likeUid, written });
        return null;
      }
    ),

    notifyAdminsOnOfficialPostComment: onDocumentCreated(
      { document: "posts/{postId}/comments/{commentId}", region: "europe-west1" },
      async (event) => {
        const { postId, commentId } = event.params;
        const comment = event.data?.data() || {};
        const commenterUid = String(comment.uid || "").trim();
        if (!commenterUid) return null;

        const db = admin.firestore();
        const post = await isOfficialPost(db, postId);
        if (!post) return null;

        const fromName = String(comment.authorName || "").trim().slice(0, 80) || "Qualcuno";
        const written = await notifyAdmins({
          db,
          admin,
          getAdminUids,
          notificationId: `official_comment_${postId}_${commentId}`,
          fromUid: commenterUid,
          type: "post_comment",
          data: {
            fromName,
            postId,
            commentId,
            preview: String(comment.text || "").slice(0, 80),
            titleId: post.titleId || null,
            isOfficial: true,
          },
        });
        logger.info("[officialUpdates] commento su post ufficiale", { postId, commentId, written });
        return null;
      }
    ),

    // Pubblica le bozze con `scheduledAt` scaduto. Ogni 15 minuti: la
    // granularita' e' sufficiente per una programmazione editoriale a giorni
    // e tiene il costo a 96 run/giorno (1 query indicizzata a vuoto).
    publishScheduledOfficialUpdates: onSchedule(
      {
        schedule: "every 15 minutes",
        timeZone: "Europe/Rome",
        region: "europe-west1",
        timeoutSeconds: 540,
        memory: "1GiB",
      },
      async () => {
        const db = admin.firestore();
        const results = await publishDueOfficialUpdates({ db, admin });
        if (results.published.length || results.failed.length) {
          logger.info("[officialUpdates] scheduler run", {
            checked: results.checked,
            published: results.published,
            skipped: results.skipped.length,
            failed: results.failed,
          });
        }
        return null;
      }
    ),

    unpublishOfficialUpdate: functions
      .runWith({ timeoutSeconds: 300, memory: "512MB" })
      .region("europe-west1")
      .https.onCall(async (data, context) => {
        const callerUid = context.auth?.uid || "";
        if (!callerUid) {
          throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
        }

        const db = admin.firestore();
        const callerIsAdmin = await isAdminCaller(db, callerUid);
        if (!callerIsAdmin) {
          throw new functions.https.HttpsError("permission-denied", "Solo admin.");
        }

        if (typeof enforceCallableRateLimit === "function") {
          await enforceCallableRateLimit(db, callerUid, "unpublishOfficialUpdate", {
            windowSeconds: 20,
            maxInWindow: 2,
            dailyMax: 40,
          });
        }

        try {
          return await unpublishOfficialUpdate({
            db,
            admin,
            slug: data?.slug,
            requestedByUid: callerUid,
          });
        } catch (err) {
          logger.warn("[officialUpdates] unpublish failed", {
            callerUid,
            error: err?.message || String(err),
          });
          throw new functions.https.HttpsError("invalid-argument", err?.message || "Payload non valido.");
        }
      }),

    publishOfficialUpdate: functions
      .runWith({ timeoutSeconds: 540, memory: "1GB" })
      .region("europe-west1")
      .https.onCall(async (data, context) => {
        const callerUid = context.auth?.uid || "";
        if (!callerUid) {
          throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
        }

        const db = admin.firestore();
        const callerIsAdmin = await isAdminCaller(db, callerUid);
        if (!callerIsAdmin) {
          throw new functions.https.HttpsError("permission-denied", "Solo admin.");
        }

        if (typeof enforceCallableRateLimit === "function") {
          await enforceCallableRateLimit(db, callerUid, "publishOfficialUpdate", {
            windowSeconds: 20,
            maxInWindow: 2,
            dailyMax: 40,
          });
        }

        try {
          return await publishOfficialUpdate({
            db,
            admin,
            input: data || {},
            requestedByUid: callerUid,
            dryRun: data?.dryRun === true,
          });
        } catch (err) {
          logger.warn("[officialUpdates] publish failed", {
            callerUid,
            error: err?.message || String(err),
          });
          throw new functions.https.HttpsError("invalid-argument", err?.message || "Payload non valido.");
        }
      }),
  };
}

module.exports = { registerOfficialUpdates };
