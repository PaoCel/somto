"use strict";

const { randomUUID } = require("crypto");

const PERSONAL_SUBCOLLECTIONS = Object.freeze([
  "watchlist",
  "library",
  "savedLists",
  "listProgressEntries",
  "titleStates",
  "imports",
  "_system",
  "matchFeedback",
  "notificationTokens",
  "notifications",
  "onboardingTelemetry",
  "feedEvents",
  "signals",
  "friends",
  "following",
  "followers",
  "quizStats",
  "quizAttempts",
  "episodeViews",
  "derivedRatings",
  "tasteProfile",
  "blockedUsers",
  "reports",
  "rateLimits",
  "experiments",
]);

const STORAGE_PREFIXES = Object.freeze([
  "avatars",
  "reviewPhotos",
  "posters",
  "manualImports",
  "supportImports",
  "users",
  // L'export GDPR e' un JSON con tutto il profilo dell'utente. Senza questo
  // prefisso restava nel bucket dopo la cancellazione dell'account, con il
  // download token ancora valido.
  "dataExports",
]);

const DELETION_LEASE_MS = 15 * 60 * 1000;

function deletionRequestRef(db, uid) {
  return db.collection("accountDeletionRequests").doc(uid);
}

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function isSelfServeDeletionInProgress(row = {}) {
  return row.source === "self-serve"
    && ["processing", "ready_for_auth_delete", "completed"].includes(row.status);
}

function authDeletionSource(row = {}) {
  return row.source === "pending-expiry" ? "pending-expiry" : "auth-on-delete";
}

async function acquireDeletionLease({ db, uid, source, Timestamp, nowMs = Date.now(), operationId = randomUUID() }) {
  const ref = deletionRequestRef(db, uid);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? (snap.data() || {}) : {};

    if (source === "auth-on-delete" && isSelfServeDeletionInProgress(current)) {
      tx.set(ref, {
        authDeleteObservedAt: Timestamp.fromMillis(nowMs),
        updatedAt: Timestamp.fromMillis(nowMs),
      }, { merge: true });
      return { acquired: false, reason: "self-serve-owns-cleanup", operationId: current.operationId || null };
    }

    if (current.status === "completed") {
      return { acquired: false, reason: "already-completed", operationId: current.operationId || null };
    }

    const leaseExpiresMs = timestampMillis(current.leaseExpiresAt);
    if (current.status === "processing" && leaseExpiresMs > nowMs && current.operationId !== operationId) {
      return { acquired: false, reason: "lease-active", operationId: current.operationId || null };
    }

    tx.set(ref, {
      uid,
      source,
      status: "processing",
      operationId,
      attemptCount: Number(current.attemptCount || 0) + 1,
      requestedAt: current.requestedAt || Timestamp.fromMillis(nowMs),
      startedAt: Timestamp.fromMillis(nowMs),
      leaseExpiresAt: Timestamp.fromMillis(nowMs + DELETION_LEASE_MS),
      updatedAt: Timestamp.fromMillis(nowMs),
    }, { merge: true });
    return { acquired: true, reason: "acquired", operationId };
  });
}

// Collection con id composto `{uid}__{qualcosaAltro}`: si selezionano per
// intervallo sul document id, senza bisogno di un campo uid indicizzato.
async function deleteDocsByIdPrefix({ db, collection, prefix, dryRun }) {
  const FieldPath = db._settings ? require("firebase-admin").firestore.FieldPath : null;
  const path = FieldPath ? FieldPath.documentId() : "__name__";
  let removed = 0;
  for (;;) {
    const snap = await db.collection(collection)
      .where(path, ">=", prefix)
      .where(path, "<", `${prefix}\uf8ff`)
      .limit(200)
      .get();
    if (snap.empty) break;
    removed += snap.size;
    if (dryRun) break;
    const batch = db.batch();
    snap.docs.forEach((docSnap) => batch.delete(docSnap.ref));
    await batch.commit();
    if (snap.size < 200) break;
  }
  return removed;
}

async function deleteQueryDocs({ db, queryFactory, dryRun }) {
  let deleted = 0;
  for (;;) {
    const snap = await queryFactory().limit(200).get();
    if (snap.empty) break;
    deleted += snap.size;
    if (dryRun) break;
    const batch = db.batch();
    snap.docs.forEach((docSnap) => batch.delete(docSnap.ref));
    await batch.commit();
    if (snap.size < 200) break;
  }
  return deleted;
}

async function anonymizeQueryDocs({ db, queryFactory, patch, dryRun }) {
  let updated = 0;
  for (;;) {
    const snap = await queryFactory().limit(200).get();
    if (snap.empty) break;
    updated += snap.size;
    if (dryRun) break;
    const batch = db.batch();
    snap.docs.forEach((docSnap) => batch.update(docSnap.ref, patch));
    await batch.commit();
    if (snap.size < 200) break;
  }
  return updated;
}

async function deleteSocialMirrorDocs({ db, uid, subcollection, mirrorSubcollection, dryRun }) {
  const userRef = db.collection("users").doc(uid);
  const snap = await userRef.collection(subcollection).get().catch(() => ({ docs: [] }));
  if (!snap.docs?.length) return 0;

  let deleted = 0;
  let batch = db.batch();
  let operations = 0;
  const flush = async () => {
    if (!operations || dryRun) return;
    await batch.commit();
    batch = db.batch();
    operations = 0;
  };

  for (const docSnap of snap.docs) {
    const otherUid = String(docSnap.id || "").trim();
    if (!otherUid) continue;
    deleted += 2;
    if (dryRun) continue;
    batch.delete(docSnap.ref);
    batch.delete(db.collection("users").doc(otherUid).collection(mirrorSubcollection).doc(uid));
    operations += 2;
    if (operations >= 350) await flush();
  }
  await flush();
  return deleted;
}

async function deleteOwnedLists({ db, bucket, uid, dryRun }) {
  let deleted = 0;
  for (;;) {
    const snap = await db.collection("userLists").where("ownerUid", "==", uid).limit(100).get();
    if (snap.empty) break;
    deleted += snap.size;
    if (dryRun) break;
    for (const docSnap of snap.docs) {
      const coverPath = String(docSnap.data()?.cover?.storagePath || "").trim();
      if (coverPath.startsWith("listCovers/")) {
        await bucket.file(coverPath).delete({ ignoreNotFound: true }).catch(() => {});
      }
      await db.recursiveDelete(docSnap.ref);
    }
    if (snap.size < 100) break;
  }
  return deleted;
}

async function removeListMemberships({ db, uid, FieldValue, dryRun }) {
  let updated = 0;
  for (;;) {
    const snap = await db.collection("userLists").where("memberUids", "array-contains", uid).limit(100).get();
    if (snap.empty) break;
    updated += snap.size;
    if (dryRun) break;
    for (const docSnap of snap.docs) {
      const data = docSnap.data() || {};
      const patch = {
        memberUids: FieldValue.arrayRemove(uid),
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (Array.isArray(data.editorUids) && data.editorUids.includes(uid)) patch.editorUids = FieldValue.arrayRemove(uid);
      if (Array.isArray(data.viewerUids) && data.viewerUids.includes(uid)) patch.viewerUids = FieldValue.arrayRemove(uid);
      await docSnap.ref.update(patch);
      await docSnap.ref.collection("members").doc(uid).delete().catch(() => {});
      await docSnap.ref.collection("progress").doc(uid).delete().catch(() => {});
    }
    if (snap.size < 100) break;
  }
  return updated;
}

async function reconcileSharedThreads({ db, uid, FieldValue, dryRun }) {
  const supportThreadId = `support_${uid}`;
  const supportRef = db.collection("threads").doc(supportThreadId);
  const supportSnap = await supportRef.get().catch(() => null);
  const supportDeleted = supportSnap?.exists ? 1 : 0;
  if (supportDeleted && !dryRun) await db.recursiveDelete(supportRef);

  let updated = 0;
  for (;;) {
    const snap = await db.collection("threads").where("participants", "array-contains", uid).limit(100).get();
    if (snap.empty) break;
    const docs = snap.docs.filter((docSnap) => docSnap.id !== supportThreadId);
    updated += docs.length;
    if (dryRun) break;
    for (const docSnap of docs) {
      const data = docSnap.data() || {};
      const patch = { participants: FieldValue.arrayRemove(uid) };
      if (data.createdBy === uid) patch.createdBy = "deleted-user";
      if (data.lastSenderUid === uid) patch.lastSenderUid = "deleted-user";
      await docSnap.ref.update(patch);
    }
    if (snap.size < 100) break;
  }

  updated += await anonymizeQueryDocs({
    db,
    queryFactory: () => db.collection("threads").where("createdBy", "==", uid),
    patch: { createdBy: "deleted-user" },
    dryRun,
  });
  return { supportThreadDeleted: supportDeleted, sharedThreadsUpdated: updated };
}

async function deleteSignupArtifacts({ db, uid, adminUids, dryRun }) {
  let notificationsDeleted = 0;
  for (const adminUid of [...new Set(adminUids || [])]) {
    const snap = await db.collection("users").doc(adminUid).collection("notifications")
      .where("fromUid", "==", uid).get();
    const matching = snap.docs.filter((docSnap) => {
      const row = docSnap.data() || {};
      return row.type === "new_user" && String(row.data?.newUserUid || "") === uid;
    });
    notificationsDeleted += matching.length;
    if (!dryRun && matching.length) {
      const batch = db.batch();
      matching.forEach((docSnap) => batch.delete(docSnap.ref));
      await batch.commit();
    }
  }
  return { notificationsDeleted };
}

async function cleanupAccountData({
  db,
  auth,
  bucket,
  uid,
  source,
  userData = null,
  adminUids = [],
  FieldValue,
  Timestamp,
  logger = console,
  dryRun = false,
  deleteAuthUser = false,
}) {
  const userRef = db.collection("users").doc(uid);
  const privateRef = db.collection("usersPrivate").doc(uid);
  const deletionRef = deletionRequestRef(db, uid);
  const snapshot = userData ? null : await userRef.get().catch(() => null);
  const currentUserData = userData || snapshot?.data?.() || {};
  const counts = {
    deletedRatings: 0,
    deletedRecommendations: 0,
    deletedSocialEdges: 0,
    deletedPosts: 0,
    anonymizedMessages: 0,
    anonymizedComments: 0,
    deletedFeed: 0,
    deletedChallenges: 0,
    deletedLists: 0,
    removedListMemberships: 0,
    supportThreadDeleted: 0,
    sharedThreadsUpdated: 0,
    signupNotificationsDeleted: 0,
    deletedPendingSignup: 0,
    deletedFeedEvents: 0,
    deletedCharacterVotes: 0,
    deletedClientErrors: 0,
    deletedImportCommentReviews: 0,
    deletedMetadataIssues: 0,
    deletedPublicListProjections: 0,
    // Storage: conteggi reali, non un booleano. `storageFilesDeleted: 0` con
    // `storageChecked: true` significa "controllato, non c'era niente";
    // `storageChecked: false` significa "non lo sappiamo".
    storageChecked: false,
    storageFilesFound: 0,
    storageFilesDeleted: 0,
    usernameReleased: false,
  };

  counts.deletedSocialEdges += await deleteSocialMirrorDocs({ db, uid, subcollection: "friends", mirrorSubcollection: "friends", dryRun });
  counts.deletedSocialEdges += await deleteSocialMirrorDocs({ db, uid, subcollection: "following", mirrorSubcollection: "followers", dryRun });
  counts.deletedSocialEdges += await deleteSocialMirrorDocs({ db, uid, subcollection: "followers", mirrorSubcollection: "following", dryRun });
  counts.deletedRatings = await deleteQueryDocs({ db, queryFactory: () => db.collection("ratings").where("uid", "==", uid), dryRun });
  counts.deletedRecommendations += await deleteQueryDocs({ db, queryFactory: () => db.collection("recommendations").where("fromUid", "==", uid), dryRun });
  counts.deletedRecommendations += await deleteQueryDocs({ db, queryFactory: () => db.collection("recommendations").where("toUid", "==", uid), dryRun });

  for (const subcollection of PERSONAL_SUBCOLLECTIONS) {
    if (!dryRun) await db.recursiveDelete(userRef.collection(subcollection));
  }

  for (;;) {
    const snap = await db.collection("posts").where("authorUid", "==", uid).limit(100).get();
    if (snap.empty) break;
    counts.deletedPosts += snap.size;
    if (dryRun) break;
    for (const docSnap of snap.docs) await db.recursiveDelete(docSnap.ref);
    if (snap.size < 100) break;
  }

  counts.anonymizedMessages = await anonymizeQueryDocs({
    db,
    queryFactory: () => db.collectionGroup("messages").where("uid", "==", uid),
    patch: { uid: "deleted-user", displayName: "Utente eliminato" },
    dryRun,
  });
  counts.anonymizedComments = await anonymizeQueryDocs({
    db,
    queryFactory: () => db.collectionGroup("comments").where("uid", "==", uid),
    patch: { uid: "deleted-user", authorName: "Utente eliminato" },
    dryRun,
  });

  await deleteQueryDocs({ db, queryFactory: () => db.collectionGroup("likes").where("uid", "==", uid), dryRun });
  await deleteQueryDocs({ db, queryFactory: () => db.collectionGroup("shares").where("uid", "==", uid), dryRun });
  await deleteQueryDocs({ db, queryFactory: () => db.collection("titleEmotions").where("uid", "==", uid), dryRun });
  await deleteQueryDocs({ db, queryFactory: () => db.collection("episodeEmotions").where("uid", "==", uid), dryRun });
  await anonymizeQueryDocs({ db, queryFactory: () => db.collection("reports").where("fromUid", "==", uid), patch: { fromUid: "deleted-user" }, dryRun });
  await anonymizeQueryDocs({ db, queryFactory: () => db.collection("quizQuestionReports").where("reportedBy", "==", uid), patch: { reportedBy: "deleted-user" }, dryRun });

  counts.deletedFeed = await deleteQueryDocs({ db, queryFactory: () => db.collection("ratingFeed").where("uid", "==", uid), dryRun });
  counts.deletedChallenges += await deleteQueryDocs({ db, queryFactory: () => db.collection("quizChallenges").where("fromUid", "==", uid), dryRun });
  counts.deletedChallenges += await deleteQueryDocs({ db, queryFactory: () => db.collection("quizChallenges").where("toUid", "==", uid), dryRun });
  counts.deletedLists = await deleteOwnedLists({ db, bucket, uid, dryRun });
  counts.removedListMemberships = await removeListMemberships({ db, uid, FieldValue, dryRun });

  const threadCounts = await reconcileSharedThreads({ db, uid, FieldValue, dryRun });
  Object.assign(counts, threadCounts);
  await anonymizeQueryDocs({
    db,
    queryFactory: () => db.collection("posts").where("sharedPost.authorUid", "==", uid),
    patch: { "sharedPost.authorUid": "deleted-user", "sharedPost.authorName": "Utente eliminato" },
    dryRun,
  });
  await anonymizeQueryDocs({
    db,
    queryFactory: () => db.collection("quizInvites").where("createdByUid", "==", uid),
    patch: { createdByUid: "deleted-user", inviterDisplayName: "Utente eliminato" },
    dryRun,
  });
  await anonymizeQueryDocs({
    db,
    queryFactory: () => db.collection("quizInvites").where("claimedByUid", "==", uid),
    patch: { claimedByUid: "deleted-user" },
    dryRun,
  });

  // Registrazione in sospeso: senza questa riga il documento sopravviveva alla
  // cancellazione dell'account (verificato in prod il 2026-08-28).
  counts.deletedPendingSignup = await deleteQueryDocs({
    db,
    queryFactory: () => db.collection("pendingSignups").where(
      require("firebase-admin").firestore.FieldPath.documentId(), "==", uid
    ),
    dryRun,
  });

  // Feed globale: sia le righe recapitate a questo utente sia quelle in cui e'
  // lui l'autore dentro il feed di altri. Contengono testo, recensioni e media.
  counts.deletedFeedEvents += await deleteQueryDocs({ db, queryFactory: () => db.collection("feedEvents").where("ownerUid", "==", uid), dryRun });
  counts.deletedFeedEvents += await deleteQueryDocs({ db, queryFactory: () => db.collection("feedEvents").where("actorUid", "==", uid), dryRun });

  counts.deletedCharacterVotes = await deleteQueryDocs({ db, queryFactory: () => db.collection("characterVotes").where("uid", "==", uid), dryRun });
  // clientErrors ha gia' un TTL, ma nel frattempo contiene uid, user-agent e
  // pagina: alla cancellazione va via subito, non alla scadenza.
  counts.deletedClientErrors = await deleteQueryDocs({ db, queryFactory: () => db.collection("clientErrors").where("uid", "==", uid), dryRun });
  counts.deletedImportCommentReviews = await deleteDocsByIdPrefix({ db, collection: "importCommentReview", prefix: `${uid}__`, dryRun });
  counts.deletedMetadataIssues = await deleteDocsByIdPrefix({ db, collection: "metadataIssues", prefix: `${uid}__`, dryRun });
  // La proiezione pubblica delle liste la cancella gia' il trigger di sync:
  // questa e' la rete di sicurezza se il trigger non gira o fallisce.
  counts.deletedPublicListProjections = await deleteQueryDocs({ db, queryFactory: () => db.collection("publicUserLists").where("ownerUid", "==", uid), dryRun });

  const handle = String(currentUserData.displayNameLower || "").trim();
  if (handle) {
    const usernameSnap = await db.collection("usernames").doc(handle).get().catch(() => null);
    const ownedByUser = usernameSnap?.exists && String(usernameSnap.data()?.uid || "") === uid;
    if (ownedByUser) {
      counts.usernameReleased = true;
      if (!dryRun) await usernameSnap.ref.delete();
    }
  }

  if (!dryRun) {
    await db.collection("leaderboard_weekly").doc(uid).delete().catch(() => {});
    await db.collection("leaderboard_allTime").doc(uid).delete().catch(() => {});
  }
  await deleteQueryDocs({ db, queryFactory: () => db.collection("guidedDmAttempts").where("fromUid", "==", uid), dryRun });
  await deleteQueryDocs({ db, queryFactory: () => db.collection("moderationQueue").where("authorUid", "==", uid), dryRun });

  const artifacts = await deleteSignupArtifacts({ db, uid, adminUids, dryRun });
  counts.signupNotificationsDeleted = artifacts.notificationsDeleted;

  // Si elencano i file prima di cancellarli: cosi' il report dice quanti ce
  // n'erano davvero, e il dry-run non deve fingere di saperlo.
  if (bucket) {
    try {
      for (const prefix of STORAGE_PREFIXES) {
        const [files] = await bucket.getFiles({ prefix: `${prefix}/${uid}/` });
        counts.storageFilesFound += files.length;
        if (!dryRun && files.length) {
          await Promise.all(files.map((file) => file.delete().catch(() => null)));
          counts.storageFilesDeleted += files.length;
        }
      }
      counts.storageChecked = true;
    } catch (err) {
      // Storage irraggiungibile: si dichiara "non controllato", non "pulito".
      counts.storageChecked = false;
      logger.warn?.("[account-delete] storage non verificabile", { uid, message: String(err?.message || err) });
    }
  }

  if (!dryRun) {
    await db.recursiveDelete(privateRef);
    await db.recursiveDelete(userRef);

    if (deleteAuthUser) {
      try {
        await auth.deleteUser(uid);
      } catch (err) {
        if (err?.code !== "auth/user-not-found") throw err;
      }
    }
  }

  logger.info?.("[account-delete] cleanup completed", {
    uid,
    source,
    dryRun,
    ...counts,
  });
  return counts;
}

async function markDeletionCompleted({ db, uid, source, operationId, counts, FieldValue, dryRun = false }) {
  if (dryRun) return;
  await deletionRequestRef(db, uid).set({
    uid,
    source,
    status: "completed",
    operationId,
    completedAt: FieldValue.serverTimestamp(),
    leaseExpiresAt: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
    ...counts,
  }, { merge: true });
}

async function markDeletionFailed({ db, uid, source, operationId, error, FieldValue }) {
  await deletionRequestRef(db, uid).set({
    uid,
    source,
    status: "failed",
    operationId,
    errorCode: String(error?.code || "unknown").slice(0, 80),
    leaseExpiresAt: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

module.exports = {
  DELETION_LEASE_MS,
  PERSONAL_SUBCOLLECTIONS,
  STORAGE_PREFIXES,
  acquireDeletionLease,
  authDeletionSource,
  cleanupAccountData,
  deletionRequestRef,
  isSelfServeDeletionInProgress,
  markDeletionCompleted,
  markDeletionFailed,
  timestampMillis,
};
