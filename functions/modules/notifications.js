const { bumpDailyMetric } = require("../lib/productMetrics");
const { extractMentionUids } = require("../lib/mentions");
const {
  commentReviewPresentation,
  titleUpdatePresentation,
} = require("../lib/notificationPresentation");
const {
  collectPriorParticipantUids,
  isImportedCommentMessageId,
  isMessageCreatedNearEvent,
  notificationDocumentId,
  planFanoutDecision,
  verifiedAddedReaction,
} = require("../lib/threadNotificationPolicy");

module.exports = ({
  functions,
  functionsV2Firestore,
  admin,
  logger,
  adminUids = [],
  getAdminUids = null,
}) => {
  const firestoreV2 = functionsV2Firestore || require("firebase-functions/v2/firestore");
  const BOOT_ADMIN_UIDS = Array.isArray(adminUids) ? adminUids.filter(Boolean) : [];
  const NOTIF_TTL_MS = 90 * 24 * 60 * 60 * 1000;
  const expiresAtValue = () => admin.firestore.Timestamp.fromMillis(Date.now() + NOTIF_TTL_MS);

  function resolveAdminUids() {
    if (typeof getAdminUids === "function") {
      try {
        const dynamic = getAdminUids();
        if (Array.isArray(dynamic)) return dynamic.filter(Boolean);
      } catch (err) {
        logger.warn("[notifyAdmin] getAdminUids failed", { error: err?.message || String(err) });
      }
    }
    return BOOT_ADMIN_UIDS;
  }

  function toMillis(ts) {
    if (!ts) return 0;
    if (typeof ts === "number") return ts;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.seconds === "number") return (ts.seconds * 1000) + Math.floor((ts.nanoseconds || 0) / 1e6);
    return 0;
  }

  // ============================================
  // Helpers
  // ============================================
  async function notifyAdminsModeration(payload) {
    const adminUids = resolveAdminUids();
    if (!adminUids.length) return;
    const db = admin.firestore();
    const batch = db.batch();
    for (const adminUid of adminUids) {
      const notifRef = db
        .collection("users")
        .doc(adminUid)
        .collection("notifications")
        .doc();
      batch.set(notifRef, {
        toUid: adminUid,
        fromUid: payload.fromUid || "system",
        type: "moderation_pending",
        data: payload.data || {},
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: expiresAtValue(),
      });
    }
    await batch.commit();
  }

  // Notifies every admin uid when a user KICKS OFF a titles import (TV Time
  // GDPR / Netflix CSV / TV Time Refract standby) — separate from
  // createTitlesImportNotification (functions/index.js), which notifies the
  // IMPORTING USER once their own job finishes. This one is for monitoring
  // the "ondata TV Time" in real time (how many people are importing, how
  // big). Best-effort only: never throws, so a failure here can never break
  // the import flow for the user. Skipped entirely on dryRun (callers must
  // check that before calling).
  async function notifyAdminsImportStarted({ fromUid, fromName, source, totalRows, importUid, importId } = {}) {
    try {
      const adminUids = resolveAdminUids();
      if (!adminUids.length) return;

      const db = admin.firestore();
      const batch = db.batch();
      for (const adminUid of adminUids) {
        // Don't notify an admin about their own import (e.g. testing).
        if (adminUid === importUid) continue;
        const notifRef = db
          .collection("users")
          .doc(adminUid)
          .collection("notifications")
          .doc();
        batch.set(notifRef, {
          toUid: adminUid,
          fromUid: fromUid || importUid || "system",
          type: "admin_import_started",
          data: {
            fromName: fromName || "Un utente",
            source: String(source || "").trim(),
            totalRows: (totalRows === null || totalRows === undefined || !Number.isFinite(Number(totalRows))) ? null : Number(totalRows),
            importUid: importUid || null,
            importId: importId || null,
          },
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          expiresAt: expiresAtValue(),
        });
      }
      await batch.commit();
    } catch (err) {
      logger.warn("[notifyAdminsImportStarted] failed", {
        importUid,
        importId,
        error: err?.message || String(err),
      });
    }
  }

  // Notifies followers + friends when a user publishes a MANUAL post (composer),
  // NOT the auto activity that comes from ratings (those never write to /posts —
  // they are rating feed events). Caller passes the same recipientUids used for
  // the feed fan-out (collectFeedRecipientUids: [actor, friends, followers]); we
  // drop the actor and any blanks. Best-effort: never throws, so a failure here
  // can't break post creation. Private posts and shares are excluded by the
  // caller. fromName is looked up here so index.js doesn't need an extra read.
  async function notifyFollowersOnManualPost({ recipientUids, actorUid, postId, titleId = null, preview = "" } = {}) {
    try {
      const actor = String(actorUid || "").trim();
      const pid = String(postId || "").trim();
      if (!actor || !pid) return;
      const uids = Array.isArray(recipientUids)
        ? [...new Set(recipientUids.map((u) => String(u || "").trim()).filter((u) => u && u !== actor))]
        : [];
      if (!uids.length) return;

      const db = admin.firestore();
      const fromName = await getUserDisplayName(db, actor);
      // Cap fan-out so a very-followed account can't spawn an unbounded batch.
      const capped = uids.slice(0, 500);
      const data = {
        fromName,
        postId: pid,
        titleId: String(titleId || "").trim() || null,
        preview: String(preview || "").slice(0, 200),
      };

      let batch = db.batch();
      let ops = 0;
      for (const uid of capped) {
        const ref = db.collection("users").doc(uid).collection("notifications").doc();
        batch.set(ref, {
          toUid: uid,
          fromUid: actor,
          type: "friend_post",
          data,
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          expiresAt: expiresAtValue(),
        });
        ops += 1;
        if (ops >= 450) {
          await batch.commit();
          batch = db.batch();
          ops = 0;
        }
      }
      if (ops > 0) await batch.commit();
    } catch (err) {
      logger.warn("[notifyFollowersOnManualPost] failed", {
        postId,
        error: err?.message || String(err),
      });
    }
  }

  // Gli uid menzionati, con il tetto di `lib/mentions.js` applicato.
  //
  // PERCHE' UN TETTO — la PWA scrive i commenti DIRETTAMENTE su Firestore
  // (`addPostComment`), senza callable e quindi senza rate limit: un solo
  // commento con cinquanta token produceva cinquanta notifiche in un batch.
  //
  // Il troncamento non e' silenzioso: si logga cosa e' stato scartato, se no
  // si legge come "ho notificato tutti".
  function extractMentionUidsFromText(text, context = {}) {
    const { uids, total } = extractMentionUids(text);
    if (total > uids.length) {
      logger.warn("[mentions] troppe menzioni in un testo, troncate", {
        ...context,
        notified: uids.length,
        requested: total,
      });
    }
    return uids;
  }

  function parseRatingEventId(eventId) {
    const raw = String(eventId || "");
    if (!raw.startsWith("rating::")) return null;
    const parts = raw.split("::");
    if (parts.length < 3) return null;
    const actorUid = String(parts[1] || "").trim();
    const markerIndex = parts.findIndex((part, index) => index >= 2 && (part === "season" || part === "episode"));
    const titleParts = markerIndex >= 0 ? parts.slice(2, markerIndex) : parts.slice(2);
    const titleId = String(titleParts.join("::") || "").trim();
    if (!actorUid || !titleId) return null;
    return { actorUid, titleId };
  }

  async function getUserDisplayName(db, uid) {
    const id = String(uid || "").trim();
    if (!id) return "Qualcuno";
    try {
      const snap = await db.collection("users").doc(id).get();
      const name = String(snap.data()?.displayName || "").trim();
      if (name) return name;
    } catch (err) {
      logger.warn("getUserDisplayName failed", { uid: id, error: err.message });
    }
    return "Qualcuno";
  }

  async function usersAreBlocked(db, leftUid, rightUid) {
    const left = String(leftUid || "").trim();
    const right = String(rightUid || "").trim();
    if (!left || !right || left === right) return false;

    try {
      const [leftBlocksRight, rightBlocksLeft] = await Promise.all([
        db.collection("users").doc(left).collection("blockedUsers").doc(right).get(),
        db.collection("users").doc(right).collection("blockedUsers").doc(left).get(),
      ]);
      return leftBlocksRight.exists || rightBlocksLeft.exists;
    } catch (err) {
      logger.warn("[notify] usersAreBlocked failed", {
        left,
        right,
        error: err?.message || String(err),
      });
      // Privacy-safe default: if the block relationship cannot be verified,
      // skip the notification instead of risking cross-block disclosure.
      return true;
    }
  }

  // Versione per i fan-out a più destinatari (menzioni): stessa regola, un
  // controllo per destinatario. Un blocco vale in entrambe le direzioni, quindi
  // toglie sia chi ha bloccato l'autore sia chi è stato bloccato da lui.
  async function recipientsNotBlockedBy(db, actorUid, uids) {
    const unique = [...new Set((Array.isArray(uids) ? uids : [...uids])
      .map((uid) => String(uid || "").trim())
      .filter(Boolean))];
    const rows = await Promise.all(unique.map(async (uid) => ({
      uid,
      blocked: await usersAreBlocked(db, actorUid, uid),
    })));
    return rows.filter((row) => !row.blocked).map((row) => row.uid);
  }

  function notificationPayload({ toUid, fromUid, type, data = {} }) {
    const to = String(toUid || "").trim();
    const from = String(fromUid || "").trim();
    if (!to || !from || to === from) return null;
    const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + NOTIF_TTL_MS);

    return {
      toUid: to,
      fromUid: from,
      type: String(type || "").trim(),
      data: data || {},
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt,
    };
  }

  async function createInAppNotification({ toUid, fromUid, type, data = {}, notificationId = null }) {
    const payload = notificationPayload({ toUid, fromUid, type, data });
    if (!payload) return false;
    const notifications = admin.firestore()
      .collection("users")
      .doc(payload.toUid)
      .collection("notifications");
    const ref = notificationId ? notifications.doc(notificationId) : notifications.doc();

    if (!notificationId) {
      await ref.set(payload);
      return true;
    }

    try {
      await ref.create(payload);
      return true;
    } catch (err) {
      // Firestore code 6 / "already-exists": expected on event retries.
      if (Number(err?.code) === 6 || String(err?.code || "") === "already-exists") {
        return false;
      }
      throw err;
    }
  }

  async function acquirePublicThreadFanout({
    db,
    senderUid,
    threadId,
    messageId,
    eventId,
    eventTimestamp,
  }) {
    const eventMs = Date.parse(String(eventTimestamp || ""));
    if (!Number.isFinite(eventMs)) return false;
    const ref = db.collection("users").doc(senderUid)
      .collection("_system").doc("publicThreadFanout");
    const decisionKey = notificationDocumentId([
      "public_thread_fanout",
      threadId,
      messageId,
      eventId || eventTimestamp,
    ]);

    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const row = snap.data() || {};
      const plan = planFanoutDecision(row, {
        decisionKey,
        eventMs,
        threadId,
        messageId,
      }, {
        cooldownMs: 30_000,
        maxDecisions: 100,
      });
      if (plan.replay || !plan.state) return plan.allowed;

      const update = {
        decisions: plan.state.decisions,
        decisionOrder: plan.state.decisionOrder,
        lastEventKey: plan.state.lastEventKey,
        lastThreadId: plan.state.lastThreadId,
        lastMessageId: plan.state.lastMessageId,
        updatedAt: admin.firestore.Timestamp.fromMillis(plan.state.updatedAtMs),
      };
      if (plan.state.lastFanoutAtMs) {
        update.lastFanoutAt = admin.firestore.Timestamp.fromMillis(plan.state.lastFanoutAtMs);
      }
      // This internal document is owned exclusively by this limiter. Replace
      // it so pruned decision keys do not accumulate forever.
      tx.set(ref, update);
      return plan.allowed;
    });
  }

  function getPushCooldownMs(type) {
    if (type === "thread_message") return 60 * 1000;
    if (type === "thread_mention") return 25 * 1000;
    if (type === "recommendation") return 30 * 1000;
    if (type === "post_mention") return 20 * 1000;
    if (type === "post_like" || type === "comment_like" || type === "rating_like") return 20 * 1000;
    if (type === "post_comment" || type === "rating_comment" || type === "comment_reply") return 18 * 1000;
    if (type === "watched_with_tag") return 25 * 1000;
    if (type === "engagement_nudge") return 6 * 60 * 60 * 1000;
    if (type === "engagement_friend_watched") return 4 * 60 * 60 * 1000;
    if (type === "engagement_watchlist_reminder") return 24 * 60 * 60 * 1000;
    if (type === "engagement_friend_activity") return 24 * 60 * 60 * 1000;
    if (type === "new_season_available") return 60 * 60 * 1000;
    if (type === "official_update") return 60 * 60 * 1000;
    if (type === "title_update") return 60 * 60 * 1000;
    // Post di chi segui: 1 push per finestra così più autori nello stesso arco
    // non spammano il destinatario (la campanella in-app resta comunque piena).
    if (type === "friend_post") return 20 * 60 * 1000;
    return 0;
  }

  async function acquirePushCooldownWindow(db, userId, notifType) {
    const cooldownMs = getPushCooldownMs(notifType);
    if (!cooldownMs) return { allowed: true, cooldownRef: null, remainingMs: 0 };

    const cooldownRef = db.collection("users").doc(userId)
      .collection("_system").doc(`pushCooldown_${notifType}`);

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(cooldownRef);
      const lastPushMs = toMillis(snap.data()?.lastPushAt);
      const nowMs = Date.now();

      if (lastPushMs && (nowMs - lastPushMs) < cooldownMs) {
        return { allowed: false, remainingMs: cooldownMs - (nowMs - lastPushMs) };
      }

      tx.set(cooldownRef, { lastPushAt: admin.firestore.Timestamp.now() }, { merge: true });
      return { allowed: true, remainingMs: 0 };
    });

    return { ...result, cooldownRef };
  }

  // ============================================
  // Event-driven functions
  // ============================================
  const notifyOnFollow = functions
    .region("europe-west1")
    .firestore
    .document("users/{userId}/followers/{followerUid}")
    .onCreate(async (snap, context) => {
      const { userId, followerUid } = context.params;
      if (!userId || !followerUid || userId === followerUid) return null;
      if (await usersAreBlocked(admin.firestore(), followerUid, userId)) return null;
      await createInAppNotification({
        toUid: userId,
        fromUid: followerUid,
        type: "follow",
        data: { fromName: await getUserDisplayName(admin.firestore(), followerUid) },
      });
      return null;
    });

  const notifyOnFriendRequest = functions
    .region("europe-west1")
    .firestore
    .document("users/{userId}/friends/{friendUid}")
    .onCreate(async (snap, context) => {
      const row = snap.data() || {};
      const { userId, friendUid } = context.params;
      if (!userId || !friendUid || userId === friendUid) return null;
      // send only to recipient copy (initiatedBy != userId)
      if (row.status === "pending" && row.initiatedBy && row.initiatedBy !== userId) {
        await createInAppNotification({
          toUid: userId,
          fromUid: row.initiatedBy,
          type: "friend_request",
          data: { fromName: await getUserDisplayName(admin.firestore(), row.initiatedBy) },
        });
      }
      return null;
    });

  const notifyOnFriendAccept = functions
    .region("europe-west1")
    .firestore
    .document("users/{userId}/friends/{friendUid}")
    .onUpdate(async (change, context) => {
      const before = change.before.data() || {};
      const after = change.after.data() || {};
      const { userId, friendUid } = context.params;
      if (!userId || !friendUid || userId === friendUid) return null;

      const becameAccepted = before.status !== "accepted" && after.status === "accepted";
      if (!becameAccepted) return null;

      const requester = after.initiatedBy || friendUid;
      // notifier: accepter (userId), recipient: requester
      if (requester && requester !== userId) {
        await createInAppNotification({
          toUid: requester,
          fromUid: userId,
          type: "friend_accept",
          data: { fromName: await getUserDisplayName(admin.firestore(), userId) },
        });
      }
      return null;
    });

  const notifyOnRecommendation = functions
    .region("europe-west1")
    .firestore
    .document("recommendations/{recId}")
    .onCreate(async (snap, context) => {
      const rec = snap.data() || {};
      const toUid = String(rec.toUid || "").trim();
      const fromUid = String(rec.fromUid || "").trim();
      if (!toUid || !fromUid || toUid === fromUid) return null;
      if (await usersAreBlocked(admin.firestore(), fromUid, toUid)) return null;
      await createInAppNotification({
        toUid,
        fromUid,
        type: "recommendation",
        data: {
          fromName: await getUserDisplayName(admin.firestore(), fromUid),
          titleId: rec.titleId || null,
          postId: rec.postId || null,
        },
      });
      return null;
    });

  const notifyAdminOnUserSignup = functions
    .region("europe-west1")
    .firestore
    .document("users/{newUid}")
    .onCreate(async (snap, context) => {
      const newUid = context.params.newUid;
      const u = snap.data() || {};
      const adminUids = resolveAdminUids();

      // Profili guidati (sintetici): non sono signup reali, niente notifica admin
      // e niente conteggio "nuovo utente".
      if (String(newUid).startsWith("guided_") || u.accountType === "guided_profile" || u.isSynthetic === true) {
        logger.info(`[notifyAdmin] guided/synthetic profile (${newUid}), skip.`);
        return null;
      }

      // Metrica funnel: nuovo utente reale (contatore aggregato, anonimo).
      void bumpDailyMetric("signups");

      // Evita di notificare quando si crea il profilo di un admin (es. migrazioni/test)
      if (adminUids.includes(newUid)) {
        logger.info(`[notifyAdmin] new user is admin (${newUid}), skip.`);
        return null;
      }

      // "nome utente" → provo displayName, poi username, poi fallback da Auth/email
      let displayName = (u.displayName || u.username || "").trim();
      if (!displayName && u.email) {
        displayName = u.email.split("@")[0];
      }
      if (!displayName) displayName = "Nuovo utente";

      if (!adminUids.length) {
        logger.warn("[notifyAdmin] ADMIN_UIDS vuoto, skip.");
        return null;
      }

      const db = admin.firestore();
      const batch = db.batch();
      for (const adminUid of adminUids) {
        const notifRef = db
          .collection("users")
          .doc(adminUid)
          .collection("notifications")
          .doc();
        batch.set(notifRef, {
          toUid: adminUid,
          fromUid: newUid,
          type: "new_user",
          data: {
            fromName: displayName, // così la push mostra il nome
            newUserUid: newUid,
          },
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          expiresAt: expiresAtValue(),
        });
      }

      await batch.commit();
      logger.info(`[notifyAdmin] New user=${newUid} (${displayName}) notified to admins=${adminUids.length}`);
      return null;
    });

  const notifyPendingTitle = functions
    .region("europe-west1")
    .firestore
    .document("titles/{titleId}")
    .onCreate(async (snap, context) => {
      const t = snap.data() || {};
      if (t.status !== "pending") return null;
      await notifyAdminsModeration({
        data: {
          kind: "title",
          titleId: context.params.titleId,
          titleName: t.name || "",
          createdBy: t.createdBy || "",
        },
      });
      return null;
    });

  const notifyPendingEdit = functions
    .region("europe-west1")
    .firestore
    .document("titleEdits/{editId}")
    .onCreate(async (snap, context) => {
      const e = snap.data() || {};
      if (e.status !== "pending") return null;
      await notifyAdminsModeration({
        data: {
          kind: "edit",
          editId: context.params.editId,
          titleId: e.targetTitleId || e.titleId || "",
          requestedBy: e.requestedBy || e.proposedBy || "",
        },
      });
      return null;
    });

  const notifyOnQuizChallengeCreate = functions
    .region("europe-west1")
    .firestore
    .document("quizChallenges/{challengeId}")
    .onCreate(async (snap, context) => {
      const db = admin.firestore();
      const challengeId = context.params.challengeId;
      const ch = snap.data() || {};
      const fromUid = String(ch.fromUid || "").trim();
      const toUid = String(ch.toUid || "").trim();
      if (!fromUid || !toUid || fromUid === toUid) {
        return null;
      }
      if (await usersAreBlocked(db, fromUid, toUid)) {
        logger.info(`[notifyQuizChallenge] blocked pair from=${fromUid} to=${toUid}, skip`);
        return null;
      }
      const fromName = await getUserDisplayName(db, fromUid);
      const numQuestions = Array.isArray(ch.questionIds) ? ch.questionIds.length : Number(ch.numQuestions || 0);
      await admin.firestore()
        .collection("users")
        .doc(toUid)
        .collection("notifications")
        .doc()
        .set({
          toUid,
          fromUid,
          type: "quiz_challenge",
          data: {
            fromName,
            challengeId,
            numQuestions,
          },
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          expiresAt: expiresAtValue(),
        });
      logger.info(`[notifyQuizChallenge] created for to=${toUid} from=${fromUid} (challenge=${challengeId})`);
      return null;
    });

  // Fires when a quiz challenge gets its second score, i.e. both players
  // have played. Flips status to "played" and notifies whoever was waiting
  // (the player who did NOT just finish).
  const notifyOnQuizChallengeComplete = functions
    .region("europe-west1")
    .firestore
    .document("quizChallenges/{challengeId}")
    .onUpdate(async (change, context) => {
      const db = admin.firestore();
      const challengeId = context.params.challengeId;
      const before = change.before.data() || {};
      const after = change.after.data() || {};

      const beforeBoth = before.fromScore != null && before.toScore != null;
      const afterBoth = after.fromScore != null && after.toScore != null;
      // Only act on the transition into "both scores present".
      if (beforeBoth || !afterBoth) return null;

      const fromUid = String(after.fromUid || "").trim();
      const toUid = String(after.toUid || "").trim();
      if (!fromUid || !toUid || fromUid === toUid) return null;

      if (after.status !== "played") {
        try {
          await change.after.ref.update({ status: "played" });
        } catch (err) {
          logger.warn(`[notifyQuizComplete] status flip failed challenge=${challengeId}`, {
            error: err?.message || String(err),
          });
        }
      }

      if (await usersAreBlocked(db, fromUid, toUid)) return null;

      // The side whose score went null -> value is the one who just finished.
      const senderJustPlayed = before.fromScore == null && after.fromScore != null;
      const receiverJustPlayed = before.toScore == null && after.toScore != null;
      let recipientUid = null;
      let finisherUid = null;
      if (receiverJustPlayed) {
        recipientUid = fromUid;
        finisherUid = toUid;
      } else if (senderJustPlayed) {
        recipientUid = toUid;
        finisherUid = fromUid;
      }
      if (!recipientUid || !finisherUid) return null;

      const finisherName = await getUserDisplayName(db, finisherUid);
      await createInAppNotification({
        toUid: recipientUid,
        fromUid: finisherUid,
        type: "quiz_challenge_completed",
        data: { fromName: finisherName, challengeId },
      });
      logger.info(`[notifyQuizComplete] notified to=${recipientUid} finisher=${finisherUid} (challenge=${challengeId})`);
      return null;
    });

  const notifyOnReportCreate = functions
    .region("europe-west1")
    .firestore
    .document("reports/{reportId}")
    .onCreate(async (snap, context) => {
      const report = snap.data() || {};
      await notifyAdminsModeration({
        fromUid: String(report.fromUid || "").trim() || "system",
        data: {
          kind: "report",
          reportId: context.params.reportId,
          reportType: String(report.type || "").trim(),
          targetId: String(report.targetId || "").trim(),
          reason: String(report.reason || "").trim().slice(0, 160),
          threadId: String(report.threadId || "").trim(),
          messageId: String(report.messageId || "").trim(),
          reportedUid: String(report.reportedUid || "").trim(),
        },
      });
      return null;
    });

  // Guideline 1.2 (App Review, rejection 1.5.0): il blocco di un utente deve
  // anche avvisare il developer del contenuto inappropriato, non solo
  // nascondere i contenuti al bloccante. Trigger su
  // `users/{uid}/blockedUsers/{blockedUid}` — copre iOS e PWA senza
  // modifiche client, incluse le build vecchie. Gen2 obbligatorio: i trigger
  // gen1 NUOVI non sono più creabili sul progetto (Firestore eur3).
  const notifyOnUserBlocked = firestoreV2.onDocumentCreated(
    {
      document: "users/{uid}/blockedUsers/{blockedUid}",
      region: "europe-west1",
    },
    async (event) => {
      const data = event.data?.data() || {};
      await notifyAdminsModeration({
        fromUid: event.params.uid,
        data: {
          kind: "user_blocked",
          blockerUid: event.params.uid,
          blockedUid: event.params.blockedUid,
          source: String(data.source || "").trim(),
        },
      });
      return null;
    });

  async function isPushAllowed(userId, type) {
    try {
      const snap = await admin.firestore()
        .collection("users")
        .doc(userId)
        .collection("_system")
        .doc("notificationPrefs")
        .get();
      const disabled = Array.isArray(snap.data()?.disabledTypes) ? snap.data().disabledTypes : [];
      return !disabled.includes(type);
    } catch (err) {
      logger.warn(`[push] prefs check failed for uid=${userId}: ${err.message}`);
      return true;
    }
  }

  const pushOnNotificationCreate = functions
    .region("europe-west1")
    .firestore
    .document("users/{userId}/notifications/{notificationId}")
    .onCreate(async (snap, context) => {
      const userId = context.params.userId;
      const notificationId = context.params.notificationId;
      const notif = snap.data() || {};

      const type = String(notif.type || "");
      const allowed = await isPushAllowed(userId, type);
      if (!allowed) {
        logger.info(`[push] Skipped by prefs for user=${userId} type=${type}`);
        return null;
      }

      logger.info(`[push] Trigger for user=${userId} notif=${notificationId} type=${notif.type}`);

      const db = admin.firestore();
      const cooldownCheck = await acquirePushCooldownWindow(db, userId, notif.type);
      if (!cooldownCheck.allowed) {
        logger.info(
          `[push] Cooldown active for user=${userId} type=${notif.type} remainingMs=${cooldownCheck.remainingMs}`
        );
        return null;
      }

      // Prendo token
      const tokensSnap = await admin.firestore()
        .collection("users")
        .doc(userId)
        .collection("notificationTokens")
        .get();

      const tokens = tokensSnap.docs.map(d => d.data().token).filter(Boolean);
      if (!tokens.length) {
        logger.warn(`[push] Nessun token FCM per user=${userId}, skip push.`);
        return null;
      }

      logger.info(`[push] Found ${tokens.length} token(s) for user=${userId}`);

      // Messaggio push (evito il titolo "Somto" duplicato su alcuni client)
      const fromName = notif.data?.fromName || "Qualcuno";
      const preview = String(notif.data?.preview || "").slice(0, 80);

      // Human-readable label for an import "source" enum value — used by the
      // admin_import_started push body. Mirrors createTitlesImportNotification's
      // sourceLabel in functions/index.js (kept separate: that one has only
      // 2 labels for the IMPORTING USER's own notification; admins get the
      // full breakdown so they know exactly which pipeline is under load).
      function importSourceLabel(source) {
        const s = String(source || "").trim();
        if (s === "tvtime_gdpr") return "TV Time (export dati)";
        if (s === "tvtime_refract") return "TV Time (Refract)";
        if (s === "netflix_csv") return "Netflix";
        return s || "un servizio";
      }

      // Etichetta breve per il titolo della push di import (source-aware),
      // allineata a createTitlesImportNotification (index.js): il body porta
      // già il messaggio per-fonte, ma il titolo restava hardcoded "Netflix".
      const importLabel = (() => {
        const s = String(notif.data?.source || "").trim().toLowerCase();
        if (s === "netflix_csv") return "Import Netflix";
        if (s === "tvtime_gdpr" || s === "tvtime_refract") return "Import TV Time";
        if (s === "trakt") return "Import Trakt";
        return "Import";
      })();
      const commentReview = commentReviewPresentation(notif.data || {});
      let titleUpdateLanguage = "it";
      if (type === "title_update") {
        try {
          const languageSnap = await db.collection("usersPrivate").doc(userId).get();
          titleUpdateLanguage = String(languageSnap.data()?.language || "it").trim().toLowerCase();
        } catch (err) {
          logger.warn(`[push] title update language lookup failed for uid=${userId}: ${err.message}`);
        }
      }
      const titleUpdate = titleUpdatePresentation(notif.data || {}, titleUpdateLanguage);

      const title =
        type === "thread_message" ? fromName :
        type === "thread_mention" ? fromName :
        type === "recommendation" ? "Nuovo consiglio" :
        type === "follow" ? fromName :
        type === "friend_request" ? fromName :
        type === "friend_accept" ? fromName :
        type === "post_mention" ? fromName :
        type === "post_like" ? fromName :
        type === "post_comment" ? fromName :
        type === "comment_reply" ? fromName :
        type === "comment_like" ? fromName :
        type === "rating_like" ? fromName :
        type === "rating_comment" ? fromName :
        type === "watched_with_tag" ? fromName :
        type === "quiz_challenge_completed" ? "Sfida quiz completata" :
        type === "new_user" ? "Nuovo iscritto" :
        type === "moderation_pending" ? "Moderazione" :
        type === "engagement_nudge" ? "Somto" :
        type === "engagement_friend_watched" ? fromName :
        type === "engagement_watchlist_reminder" ? "Somto" :
        type === "engagement_friend_activity" ? "Somto" :
        type === "new_season_available" ? "Nuova stagione disponibile" :
        type === "official_update" ? "Aggiornamento Somto" :
        type === "title_update" ? titleUpdate.title :
        type === "titles_import_completed" ? `${importLabel} completato` :
        type === "titles_import_needs_review" ? `${importLabel} da controllare` :
        type === "titles_import_failed" ? `${importLabel} non riuscito` :
        type === "admin_import_started" ? "Nuovo import" :
        type === "push_coverage_report" ? "Copertura notifiche" :
        type === "import_health_alert" ? "Import da controllare" :
        type === "comment_review_pending" ? commentReview.title :
        type === "friend_post" ? fromName :
        "Nuova notifica";

      const newSeasonTitleName = String(notif.data?.titleName || "una serie che segui");
      const newSeasonNumber = Number(notif.data?.latestSeasonNumber || 0);
      const newSeasonBody = newSeasonNumber > 0
        ? `Stagione ${newSeasonNumber} di ${newSeasonTitleName} disponibile`
        : `${newSeasonTitleName} ha nuovi episodi`;
      const body =
        type === "new_user" ? `${fromName} si è appena iscritto` :
        type === "recommendation" ? `${fromName} ti ha consigliato un titolo` :
        type === "follow" ? `ha iniziato a seguirti` :
        type === "friend_request" ? `ti ha inviato una richiesta` :
        type === "friend_accept" ? `ha accettato la richiesta` :
        type === "thread_message" ? (preview || "nuovo messaggio") :
        type === "thread_mention" ? `ti ha menzionato in un thread` :
        type === "post_mention"
          ? (String(notif.data?.context || "") === "rating_comment"
            ? `ti ha menzionato su un voto`
            : `ti ha menzionato in un commento/post`)
          :
        type === "post_like" ? `ha messo like al tuo post` :
        type === "post_comment" ? `ha commentato il tuo post` :
        type === "comment_reply" ? `ha risposto al tuo commento` :
        type === "comment_like"
          ? (notif.data?.threadId
            ? `ha reagito ${String(notif.data?.reaction || "").trim()} al tuo commento`.replace(/\s+/g, " ").trim()
            : `ha messo like al tuo commento`)
          :
        type === "rating_like" ? `ha reagito al tuo voto` :
        type === "rating_comment" ? `ha commentato la tua recensione` :
        type === "watched_with_tag" ? `ti ha taggato in una visione insieme` :
        type === "quiz_challenge_completed" ? `${fromName} ha finito la sfida — vedi chi ha vinto` :
        type === "moderation_pending" ? `Nuovo elemento da approvare` :
        type === "engagement_nudge" ? (notif.data?.message || "Torna su Somto: ci sono nuovi titoli per te") :
        type === "engagement_friend_watched" ? (notif.data?.message || `ha visto un nuovo titolo`) :
        type === "engagement_watchlist_reminder" ? (notif.data?.message || "Hai titoli in watchlist da recuperare") :
        type === "engagement_friend_activity" ? (notif.data?.message || "I tuoi amici sono stati attivi questa settimana") :
        type === "new_season_available" ? newSeasonBody :
        type === "official_update" ? (notif.data?.preview || notif.data?.title || "C'e' un aggiornamento ufficiale su Somto") :
        type === "title_update" ? titleUpdate.body :
        type === "titles_import_completed" ? (notif.data?.message || "I risultati sono nella tua libreria") :
        type === "titles_import_needs_review" ? (notif.data?.message || "Apri Somto per confermare alcuni titoli") :
        type === "titles_import_failed" ? (notif.data?.message || "Puoi riprovare quando vuoi") :
        type === "push_coverage_report" ? (notif.data?.message || "Report settimanale della copertura push") :
        type === "import_health_alert" ? (notif.data?.message || "Ci sono import da controllare") :
        type === "admin_import_started" ? (() => {
          const rows = Number(notif.data?.totalRows || 0);
          const rowsPart = rows > 0 ? ` (${rows} righe)` : "";
          return `${fromName} ha avviato un import ${importSourceLabel(notif.data?.source)}${rowsPart}`;
        })() :
        type === "comment_review_pending" ? commentReview.body :
        type === "friend_post" ? (preview || "ha pubblicato un post") :
        "Hai una nuova notifica";

      // Link dinamico in base al tipo di notifica
      let url = "/account.html?tab=activity";

      if (type === "thread_message" && notif.data?.threadId) {
        url = `/thread.html?tid=${notif.data.threadId}`;
      } else if (type === "thread_mention" && notif.data?.threadId) {
        url = `/thread.html?tid=${notif.data.threadId}`;
      } else if (type === "recommendation" && notif.data?.titleId) {
        url = `/title.html?id=${notif.data.titleId}`;
      } else if (type === "friend_request" && notif.fromUid) {
        url = `/user.html?uid=${notif.fromUid}`;
      } else if (type === "friend_accept" && notif.fromUid) {
        url = `/user.html?uid=${notif.fromUid}`;
      } else if (type === "follow" && notif.fromUid) {
        url = `/user.html?uid=${notif.fromUid}`;
      } else if (type === "new_user" && notif.fromUid) {
        url = `/user.html?uid=${notif.fromUid}`;
      } else if (type === "moderation_pending") {
        url = "/moderation.html";
      } else if (type === "comment_like" && notif.data?.threadId) {
        url = `/thread.html?tid=${encodeURIComponent(String(notif.data.threadId))}`;
      } else if (type === "post_mention" || type === "post_like" || type === "post_comment" || type === "comment_like" || type === "comment_reply") {
        const targetPost = String(notif.data?.postId || notif.data?.eventId || "").trim();
        if (targetPost) {
          // Il deep-link ?post= e' gestito da community.page.js (home.page.js non lo legge).
          url = `/community.html?post=${encodeURIComponent(targetPost)}`;
        }
      } else if ((type === "rating_like" || type === "rating_comment") && notif.data?.titleId) {
        url = `/title.html?id=${encodeURIComponent(String(notif.data.titleId))}`;
      } else if (type === "watched_with_tag" && notif.data?.titleId) {
        url = `/title.html?id=${encodeURIComponent(String(notif.data.titleId))}&focus=rating`;
      } else if (type === "engagement_nudge") {
        url = String(notif.data?.ctaUrl || "/");
      } else if (type === "engagement_friend_watched" && notif.data?.titleId) {
        url = `/title.html?id=${encodeURIComponent(String(notif.data.titleId))}`;
      } else if (type === "engagement_watchlist_reminder") {
        url = String(notif.data?.ctaUrl || "/watchlist.html");
      } else if (type === "engagement_friend_activity") {
        url = String(notif.data?.ctaUrl || "/");
      } else if (type === "new_season_available" && notif.data?.titleId) {
        url = `/title.html?id=${encodeURIComponent(String(notif.data.titleId))}`;
      } else if (type === "official_update") {
        const targetPost = String(notif.data?.postId || "").trim();
        url = targetPost ? `/community.html?post=${encodeURIComponent(targetPost)}` : String(notif.data?.ctaUrl || "/community.html");
      } else if (type === "title_update") {
        url = titleUpdate.url;
      } else if (type === "titles_import_needs_review") {
        url = String(notif.data?.ctaUrl || "/import.html");
      } else if (type === "titles_import_completed") {
        url = String(notif.data?.ctaUrl || "/account.html?tab=watched");
      } else if (type === "titles_import_failed") {
        url = String(notif.data?.ctaUrl || "/import.html");
      } else if (type === "push_coverage_report" || type === "import_health_alert") {
        url = String(notif.data?.ctaUrl || "/admin-analytics.html");
      } else if (type === "admin_import_started") {
        // Tap → profilo di chi ha importato (era /admin-analytics.html).
        const importUid = String(notif.data?.importUid || notif.fromUid || "").trim();
        url = importUid ? `/user.html?uid=${encodeURIComponent(importUid)}` : "/admin-analytics.html";
      } else if (type === "comment_review_pending") {
        url = commentReview.url;
      } else if (type === "friend_post") {
        const targetPost = String(notif.data?.postId || "").trim();
        url = targetPost ? `/community.html?post=${encodeURIComponent(targetPost)}` : "/community.html";
      }

      const link = `https://somto.it${url}`;

      let successCount = 0;

      const dataPayload = {
        type,
        fromUid: String(notif.fromUid || ""),
        url,
        threadId: String(notif.data?.threadId || ""),
        titleId: String(notif.data?.titleId || ""),
        postId: String(notif.data?.postId || ""),
        commentId: String(notif.data?.commentId || ""),
        messageId: String(notif.data?.messageId || ""),
        reaction: String(notif.data?.reaction || ""),
        eventId: String(notif.data?.eventId || ""),
        importId: String(notif.data?.importId || ""),
        importUid: String(notif.data?.importUid || ""),
        newUserUid: String(notif.data?.newUserUid || ""),
        kind: String(notif.data?.kind || ""),
        editId: String(notif.data?.editId || ""),
        ctaUrl: String(notif.data?.ctaUrl || ""),
      };

      const webpushConfig = {
        fcmOptions: { link },
        headers: {
          Urgency: "high",
        },
        notification: {
          icon: notif.data?.avatar || "/icons/icon-192.png",
          badge: "/icons/favicon-32.png",
          vibrate: [100, 50, 50],
          renotify: false,
          silent: false,
          actions: [
            { action: "open", title: "Apri" },
          ],
        },
      };

      const apnsConfig = {
        headers: {
          "apns-priority": "10",
        },
        payload: {
          aps: {
            alert: { title, body },
            sound: "default",
          },
        },
      };

      const messages = tokens.map((token) => ({
        token,
        notification: { title, body },
        data: dataPayload,
        webpush: webpushConfig,
        apns: apnsConfig,
      }));

      const BATCH_SIZE = 500;
      const invalidTokens = [];

      for (let i = 0; i < messages.length; i += BATCH_SIZE) {
        const batch = messages.slice(i, i + BATCH_SIZE);
        const response = await admin.messaging().sendEach(batch);
        response.responses.forEach((resp, idx) => {
          if (resp.success) {
            successCount++;
          } else {
            const code = resp.error?.code || "";
            logger.warn(`[push] Token[${i + idx}] failed: code=${code} msg=${resp.error?.message}`);
            if (
              code === "messaging/registration-token-not-registered" ||
              code === "messaging/invalid-registration-token" ||
              code === "messaging/invalid-argument"
            ) {
              invalidTokens.push(batch[idx].token);
            }
          }
        });
      }

      logger.info(`[push] Results: success=${successCount} failure=${tokens.length - successCount}`);

      if (successCount > 0 && cooldownCheck.cooldownRef) {
        await cooldownCheck.cooldownRef.set(
          {
            lastPushAt: admin.firestore.FieldValue.serverTimestamp(),
            type: String(notif.type || "generic"),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }

      // Pulizia token invalidi
      if (invalidTokens.length) {
        logger.info(`[push] Cleaning ${invalidTokens.length} invalid token(s)`);
        const batch = admin.firestore().batch();
        tokensSnap.docs.forEach(docSnap => {
          if (invalidTokens.includes(docSnap.data().token)) batch.delete(docSnap.ref);
        });
        await batch.commit();
      }

      return null;
    });

  // Firestore is hosted in the eur3 multi-region. A 1st-gen trigger update can
  // be rejected because its Eventarc resource region is not supported; 2nd gen
  // resolves the database/event routing while keeping the function in
  // europe-west1, as already done for reaction notifications below.
  const notifyOnThreadMessageV2 = firestoreV2.onDocumentCreated(
    {
      document: "threads/{threadId}/messages/{messageId}",
      region: "europe-west1",
      retry: true,
    },
    async (event) => {
      const snap = event.data;
      if (!snap) return;
      const context = {
        params: event.params || {},
        timestamp: event.time,
        eventId: event.id,
      };
      const db = admin.firestore();
      const threadId = context.params.threadId;
      const messageId = context.params.messageId;
      const msg = snap.data() || {};
      const senderUid = msg.uid;

      if (!senderUid) {
        logger.warn(`[notifyThread] Message ${messageId} in ${threadId} has no uid, skip.`);
        return null;
      }

      const threadSnap = await db.collection("threads").doc(threadId).get();

      if (!threadSnap.exists) {
        logger.warn(`[notifyThread] Thread doc ${threadId} NOT FOUND — cannot notify.`);
        return null;
      }

      const thread = threadSnap.data();
      const mentionedUids = new Set(extractMentionUidsFromText(msg.text));
      let recipients = [];

      if (thread.visibility === "public") {
        // Native clients are forced by rules to use request.time. Historical
        // server-side imports keep their original date and must not create a
        // notification burst. Compare with the immutable event timestamp so
        // retries make the same decision.
        const createdNearEvent = isMessageCreatedNearEvent(
          msg.createdAt,
          context.timestamp,
          2 * 60 * 1000
        );
        if (isImportedCommentMessageId(messageId) || !createdNearEvent) {
          logger.info("[notifyThread] Historical public message, skip fan-out.", {
            threadId,
            messageId,
            importedId: isImportedCommentMessageId(messageId),
          });
          return null;
        }

        if (!(await acquirePublicThreadFanout({
          db,
          senderUid,
          threadId,
          messageId,
          eventId: context.eventId,
          eventTimestamp: context.timestamp,
        }))) {
          logger.warn("[notifyThread] Public fan-out throttled.", { threadId, messageId, senderUid });
          return null;
        }

        // Public title threads do not keep an ever-growing participants array.
        // Derive a bounded audience from recent message authors instead.
        const priorSnap = await db.collection("threads").doc(threadId)
          .collection("messages")
          .orderBy("createdAt", "desc")
          .limit(301)
          .get();
        recipients = collectPriorParticipantUids(
          priorSnap.docs.map((docSnap) => docSnap.data() || {}),
          senderUid,
          {
            excludedUids: mentionedUids,
            maxRecipients: 50,
          }
        );
      } else {
        recipients = collectPriorParticipantUids(
          (thread.participants || []).map((uid) => ({ uid })),
          senderUid,
          {
            excludedUids: mentionedUids,
            maxRecipients: 50,
          }
        );
      }

      if (!recipients.length) {
        logger.info(`[notifyThread] No recipients for thread=${threadId} (sender=${senderUid})`);
        return null;
      }

      // Message displayName and text are client-authored. Resolve identity
      // server-side and never leak spoiler text into the notification/push.
      const senderName = await getUserDisplayName(db, senderUid);
      const preview = msg.containsSpoiler === true
        ? "Nuovo commento con spoiler"
        : String(msg.text || "").slice(0, 80);

      logger.info(`[notifyThread] Creating ${recipients.length} notification(s) for thread=${threadId} from=${senderName}`);
      const blockResults = await Promise.all(
        recipients.map(async (recipientUid) => ({
          recipientUid,
          blocked: await usersAreBlocked(db, senderUid, recipientUid),
        }))
      );
      const allowedRecipients = blockResults
        .filter(({ blocked }) => !blocked)
        .map(({ recipientUid }) => recipientUid);

      const results = await Promise.all(allowedRecipients.map((recipientUid) =>
        createInAppNotification({
          toUid: recipientUid,
          fromUid: senderUid,
          type: "thread_message",
          notificationId: notificationDocumentId([
            "thread_message",
            threadId,
            messageId,
            recipientUid,
          ]),
          data: {
            fromName: senderName,
            threadId,
            messageId,
            preview,
            titleId: thread.titleId || null,
          },
        })
      ));
      const writes = results.filter(Boolean).length;
      logger.info(`[notifyThread] Created ${writes} notification(s) for thread=${threadId}`);

      return null;
    }
  );

  const notifyOnThreadReaction = firestoreV2.onDocumentUpdatedWithAuthContext(
    {
      document: "threads/{threadId}/messages/{messageId}",
      region: "europe-west1",
      retry: true,
    },
    async (event) => {
      const before = event.data?.before?.data() || {};
      const after = event.data?.after?.data() || {};
      if (
        !event.authId
        || event.authType === "service_account"
        || event.authType === "system"
        || event.authType === "unauthenticated"
      ) return;
      const reaction = verifiedAddedReaction(before, after, event.authId);
      if (!reaction) return;

      const threadId = String(event.params.threadId || "").trim();
      const messageId = String(event.params.messageId || "").trim();
      const ownerUid = String(after.uid || "").trim();
      const { actorUid, emoji } = reaction;
      if (!threadId || !messageId || !ownerUid || ownerUid === actorUid) return;

      const db = admin.firestore();
      if (await usersAreBlocked(db, actorUid, ownerUid)) return;

      const threadSnap = await db.collection("threads").doc(threadId).get();
      if (!threadSnap.exists) return;
      const thread = threadSnap.data() || {};
      const fromName = await getUserDisplayName(db, actorUid);

      await createInAppNotification({
        toUid: ownerUid,
        fromUid: actorUid,
        type: "comment_like",
        notificationId: notificationDocumentId([
          "thread_reaction",
          threadId,
          messageId,
          actorUid,
          emoji,
        ]),
        data: {
          fromName,
          threadId,
          messageId,
          titleId: thread.titleId || null,
          reaction: emoji,
          preview: after.containsSpoiler === true
            ? "Commento con spoiler"
            : String(after.text || "").slice(0, 80),
        },
      });
    }
  );

  const notifyOnPostCreateMentions = functions
    .region("europe-west1")
    .firestore
    .document("posts/{postId}")
    .onCreate(async (snap, context) => {
      const postId = context.params.postId;
      const post = snap.data() || {};
      const authorUid = String(post.authorUid || "").trim();
      if (!authorUid) return null;

      const fromName = String(post.authorName || "").trim() || await getUserDisplayName(admin.firestore(), authorUid);
      const preview = String(post.text || "").slice(0, 80);
      const mentionedRaw = extractMentionUidsFromText(post.text);
      if (!mentionedRaw.length) return null;
      const mentioned = await recipientsNotBlockedBy(admin.firestore(), authorUid, mentionedRaw);
      if (!mentioned.length) return null;

      const batch = admin.firestore().batch();
      let writes = 0;
      for (const uid of mentioned) {
        if (!uid || uid === authorUid) continue;
        const ref = admin.firestore()
          .collection("users")
          .doc(uid)
          .collection("notifications")
          .doc();
        batch.set(ref, {
          toUid: uid,
          fromUid: authorUid,
          type: "post_mention",
          data: {
            fromName,
            postId,
            preview,
            context: "post",
          },
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          expiresAt: expiresAtValue(),
        });
        writes++;
      }

      if (writes > 0) {
        await batch.commit();
      }
      return null;
    });

  const notifyOnPostLike = functions
    .region("europe-west1")
    .firestore
    .document("posts/{postId}/likes/{likeUid}")
    .onCreate(async (snap, context) => {
      const db = admin.firestore();
      const postId = context.params.postId;
      const likeUid = context.params.likeUid;

      const postSnap = await db.collection("posts").doc(postId).get();
      if (!postSnap.exists) return null;
      const post = postSnap.data() || {};
      const authorUid = String(post.authorUid || "").trim();
      if (!authorUid || authorUid === likeUid) return null;
      if (await usersAreBlocked(db, likeUid, authorUid)) return null;

      const fromName = await getUserDisplayName(db, likeUid);
      await createInAppNotification({
        toUid: authorUid,
        fromUid: likeUid,
        type: "post_like",
        data: {
          fromName,
          postId,
          titleId: post.titleId || null,
        },
      });
      return null;
    });

  const notifyOnPostComment = functions
    .region("europe-west1")
    .firestore
    .document("posts/{postId}/comments/{commentId}")
    .onCreate(async (snap, context) => {
      const db = admin.firestore();
      const postId = context.params.postId;
      const commentId = context.params.commentId;
      const comment = snap.data() || {};
      const commenterUid = String(comment.uid || "").trim();
      if (!commenterUid) return null;

      const postSnap = await db.collection("posts").doc(postId).get();
      if (!postSnap.exists) return null;
      const post = postSnap.data() || {};
      const authorUid = String(post.authorUid || "").trim();
      const fromName = String(comment.authorName || "").trim() || await getUserDisplayName(db, commenterUid);
      const preview = String(comment.text || "").slice(0, 80);

      if (authorUid && authorUid !== commenterUid
        && !(await usersAreBlocked(db, commenterUid, authorUid))) {
        await createInAppNotification({
          toUid: authorUid,
          fromUid: commenterUid,
          type: "post_comment",
          data: {
            fromName,
            postId,
            commentId,
            preview,
            titleId: post.titleId || null,
          },
        });
      }

      // Reply to a specific comment: notify the parent comment's author.
      // Skipped when the parent author is the commenter or the post author
      // (the latter already got a post_comment notification).
      const parentCommentId = String(comment.parentCommentId || "").trim();
      const parentUid = String(comment.parentUid || "").trim();
      if (parentCommentId && parentUid
        && parentUid !== commenterUid
        && parentUid !== authorUid
        && !(await usersAreBlocked(db, commenterUid, parentUid))) {
        await createInAppNotification({
          toUid: parentUid,
          fromUid: commenterUid,
          type: "comment_reply",
          data: {
            fromName,
            postId,
            commentId,
            parentCommentId,
            preview,
            titleId: post.titleId || null,
          },
        });
      }

      const mentionedRaw = new Set(extractMentionUidsFromText(comment.text));
      if (authorUid) mentionedRaw.delete(authorUid);
      mentionedRaw.delete(commenterUid);
      // The reply auto-tags the parent author; don't double-notify them.
      if (parentUid) mentionedRaw.delete(parentUid);
      if (!mentionedRaw.size) return null;
      const mentioned = await recipientsNotBlockedBy(db, commenterUid, mentionedRaw);
      if (!mentioned.length) return null;

      const batch = db.batch();
      for (const uid of mentioned) {
        const ref = db.collection("users").doc(uid).collection("notifications").doc();
        batch.set(ref, {
          toUid: uid,
          fromUid: commenterUid,
          type: "post_mention",
          data: {
            fromName,
            postId,
            commentId,
            preview,
            context: "comment",
          },
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          expiresAt: expiresAtValue(),
        });
      }
      await batch.commit();
      return null;
    });

  const notifyOnPostCommentLike = functions
    .region("europe-west1")
    .firestore
    .document("posts/{postId}/comments/{commentId}/likes/{likeUid}")
    .onCreate(async (snap, context) => {
      const db = admin.firestore();
      const postId = context.params.postId;
      const commentId = context.params.commentId;
      const likeUid = context.params.likeUid;

      const commentSnap = await db.collection("posts").doc(postId).collection("comments").doc(commentId).get();
      if (!commentSnap.exists) return null;
      const comment = commentSnap.data() || {};
      const ownerUid = String(comment.uid || "").trim();
      if (!ownerUid || ownerUid === likeUid) return null;
      if (await usersAreBlocked(db, likeUid, ownerUid)) return null;

      const fromName = await getUserDisplayName(db, likeUid);
      await createInAppNotification({
        toUid: ownerUid,
        fromUid: likeUid,
        type: "comment_like",
        data: {
          fromName,
          postId,
          commentId,
        },
      });
      return null;
    });

  const notifyOnRatingLike = functions
    .region("europe-west1")
    .firestore
    .document("ratingFeed/{eventId}/likes/{likeUid}")
    .onCreate(async (snap, context) => {
      const db = admin.firestore();
      const eventId = context.params.eventId;
      const likeUid = context.params.likeUid;
      const parsed = parseRatingEventId(eventId);
      if (!parsed) return null;
      const { actorUid, titleId } = parsed;
      if (!actorUid || actorUid === likeUid) return null;
      if (await usersAreBlocked(db, likeUid, actorUid)) return null;

      const fromName = await getUserDisplayName(db, likeUid);
      await createInAppNotification({
        toUid: actorUid,
        fromUid: likeUid,
        type: "rating_like",
        data: {
          fromName,
          eventId,
          titleId,
        },
      });
      return null;
    });

  const notifyOnRatingComment = functions
    .region("europe-west1")
    .firestore
    .document("ratingFeed/{eventId}/comments/{commentId}")
    .onCreate(async (snap, context) => {
      const db = admin.firestore();
      const eventId = context.params.eventId;
      const commentId = context.params.commentId;
      const comment = snap.data() || {};
      const commenterUid = String(comment.uid || "").trim();
      if (!commenterUid) return null;

      const parsed = parseRatingEventId(eventId);
      if (!parsed) return null;
      const { actorUid, titleId } = parsed;

      const fromName = String(comment.authorName || "").trim() || await getUserDisplayName(db, commenterUid);
      const preview = String(comment.text || "").slice(0, 80);

      if (actorUid && actorUid !== commenterUid
        && !(await usersAreBlocked(db, commenterUid, actorUid))) {
        await createInAppNotification({
          toUid: actorUid,
          fromUid: commenterUid,
          type: "rating_comment",
          data: {
            fromName,
            eventId,
            titleId,
            commentId,
            preview,
          },
        });
      }

      // Reply to a specific comment on a rating: notify the parent author.
      const parentCommentId = String(comment.parentCommentId || "").trim();
      const parentUid = String(comment.parentUid || "").trim();
      if (parentCommentId && parentUid
        && parentUid !== commenterUid
        && parentUid !== actorUid
        && !(await usersAreBlocked(db, commenterUid, parentUid))) {
        await createInAppNotification({
          toUid: parentUid,
          fromUid: commenterUid,
          type: "comment_reply",
          data: {
            fromName,
            eventId,
            titleId,
            commentId,
            parentCommentId,
            preview,
          },
        });
      }

      const mentionedRaw = new Set(extractMentionUidsFromText(comment.text));
      mentionedRaw.delete(commenterUid);
      mentionedRaw.delete(actorUid);
      if (parentUid) mentionedRaw.delete(parentUid);
      if (!mentionedRaw.size) return null;
      const mentioned = await recipientsNotBlockedBy(db, commenterUid, mentionedRaw);
      if (!mentioned.length) return null;

      const batch = db.batch();
      for (const uid of mentioned) {
        const ref = db.collection("users").doc(uid).collection("notifications").doc();
        batch.set(ref, {
          toUid: uid,
          fromUid: commenterUid,
          type: "post_mention",
          data: {
            fromName,
            eventId,
            titleId,
            commentId,
            preview,
            context: "rating_comment",
          },
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          expiresAt: expiresAtValue(),
        });
      }
      await batch.commit();
      return null;
    });

  const notifyOnThreadMentions = functions
    .region("europe-west1")
    .firestore
    .document("threads/{threadId}/messages/{messageId}")
    .onCreate(async (snap, context) => {
      const db = admin.firestore();
      const threadId = context.params.threadId;
      const messageId = context.params.messageId;
      const msg = snap.data() || {};
      const senderUid = String(msg.uid || "").trim();
      if (!senderUid) return null;

      const mentioned = extractMentionUidsFromText(msg.text);
      if (!mentioned.length) return null;

      const threadSnap = await db.collection("threads").doc(threadId).get();
      const thread = threadSnap.exists ? (threadSnap.data() || {}) : {};
      if (
        thread.visibility === "public" &&
        (
          isImportedCommentMessageId(messageId) ||
          !isMessageCreatedNearEvent(msg.createdAt, context.timestamp, 2 * 60 * 1000)
        )
      ) {
        logger.info("[notifyThreadMention] Historical public message, skip.", {
          threadId,
          messageId,
        });
        return null;
      }
      const fromName = await getUserDisplayName(db, senderUid);
      const preview = msg.containsSpoiler === true
        ? "Ha menzionato te in un commento con spoiler."
        : String(msg.text || "").slice(0, 80);

      const uniq = new Set(mentioned.filter((uid) => uid && uid !== senderUid));
      if (!uniq.size) return null;

      const batch = db.batch();
      let writes = 0;
      for (const uid of uniq) {
        if (await usersAreBlocked(db, senderUid, uid)) {
          continue;
        }

        const ref = db.collection("users").doc(uid).collection("notifications").doc();
        batch.set(ref, {
          toUid: uid,
          fromUid: senderUid,
          type: "thread_mention",
          data: {
            fromName,
            threadId,
            titleId: thread.titleId || null,
            preview,
          },
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          expiresAt: expiresAtValue(),
        });
        writes++;
      }
      if (writes > 0) {
        await batch.commit();
      }
      return null;
    });

  const cleanupDuplicateNotificationToken = functions
    .region("europe-west1")
    .firestore
    .document("users/{userId}/notificationTokens/{tokenId}")
    .onWrite(async (change, context) => {
      if (!change.after.exists) return null;

      const userId = String(context.params.userId || "").trim();
      const tokenId = String(context.params.tokenId || "").trim();
      const row = change.after.data() || {};
      const token = String(row.token || tokenId || "").trim();
      if (!userId || !token) return null;

      const db = admin.firestore();
      const dupesSnap = await db.collectionGroup("notificationTokens")
        .where("token", "==", token)
        .get()
        .catch((err) => {
          logger.warn("[push] duplicate token lookup failed", {
            userId,
            tokenPrefix: token.slice(0, 12),
            error: err?.message || String(err),
          });
          return null;
        });
      if (!dupesSnap || dupesSnap.size <= 1) return null;

      const batch = db.batch();
      let deletes = 0;
      dupesSnap.docs.forEach((docSnap) => {
        const ownerUid = docSnap.ref.parent.parent?.id || "";
        if (!ownerUid || ownerUid === userId) return;
        batch.delete(docSnap.ref);
        deletes++;
      });

      if (deletes > 0) {
        await batch.commit();
        logger.info("[push] duplicate token cleanup", {
          userId,
          tokenPrefix: token.slice(0, 12),
          deletes,
        });
      }
      return null;
    });

  return {
    notifyOnFollow,
    notifyOnFriendRequest,
    notifyOnFriendAccept,
    notifyOnRecommendation,
    notifyAdminOnUserSignup,
    notifyPendingTitle,
    notifyPendingEdit,
    notifyOnReportCreate,
    notifyOnUserBlocked,
    notifyOnQuizChallengeCreate,
    notifyOnQuizChallengeComplete,
    pushOnNotificationCreate,
    notifyOnThreadMessageV2,
    notifyOnThreadReaction,
    notifyOnPostCreateMentions,
    notifyOnPostLike,
    notifyOnPostComment,
    notifyOnPostCommentLike,
    notifyOnRatingLike,
    notifyOnRatingComment,
    notifyOnThreadMentions,
    cleanupDuplicateNotificationToken,
    // Not a Cloud Function (no __trigger/__endpoint) — a plain async helper
    // that functions/index.js calls directly from startTitlesImport /
    // createTitlesImportUploadSession. Safe to sit alongside the real
    // exports.* triggers: firebase-tools' function discovery only picks up
    // objects shaped like CloudFunction, so this is a silent no-op for
    // deploy purposes.
    notifyAdminsImportStarted,
    notifyFollowersOnManualPost,
    // Helper puro (non CloudFunction): usato da index.js per avvisare gli
    // admin dei sospetti abuso trovati dal filtro automatico (Guideline 1.2).
    notifyAdminsModeration,
  };
};
