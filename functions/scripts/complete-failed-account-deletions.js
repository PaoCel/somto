#!/usr/bin/env node
/**
 * complete-failed-account-deletions.js — porta a termine le cancellazioni
 * account rimaste a meta'.
 *
 * Contesto: da quando `deleteMyAccount` ha iniziato a usare query
 * collection-group su comments/likes/shares, l'indice mancante le faceva
 * fallire con FAILED_PRECONDITION. La funzione abortiva a meta': le
 * subcollection dell'utente, i voti, i post e i messaggi erano gia' stati
 * cancellati o anonimizzati, ma tombstone e `auth.deleteUser` no. Risultato:
 * account svuotati che pero' esistono ancora, e la persona ha visto un errore.
 * Indice sistemato il 2026-07-28; questo script chiude l'arretrato.
 *
 * Ripete tutti i passi (sono idempotenti) e non solo la coda, cosi' copre
 * anche eventuali dati ricreati dopo il tentativo fallito.
 *
 * SALTA gli account che sembrano tornati in uso dopo il fallimento (attivita'
 * successiva o contenuti presenti): li segnala e basta, la decisione e' umana.
 * Con `--only <uid>` si lavora su un singolo account.
 *
 * Uso (dry-run di default):
 *   cd functions
 *   node scripts/complete-failed-account-deletions.js
 *   node scripts/complete-failed-account-deletions.js --write
 *   node scripts/complete-failed-account-deletions.js --only <uid> --write
 */

const admin = require("firebase-admin");

const WRITE = process.argv.includes("--write");
const ONLY = (() => {
  const i = process.argv.indexOf("--only");
  return i >= 0 ? String(process.argv[i + 1] || "").trim() : "";
})();

admin.initializeApp({ projectId: "gia-visto", storageBucket: "gia-visto.firebasestorage.app" });
const db = admin.firestore();
const logger = { warn: (...a) => console.warn("  ⚠", ...a) };

async function deleteQueryDocs(queryFactory) {
  let deleted = 0;
  for (;;) {
    const snap = await queryFactory().limit(200).get();
    if (snap.empty) break;
    if (WRITE) {
      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
    deleted += snap.size;
    if (!WRITE || snap.size < 200) break;
  }
  return deleted;
}

async function anonymizeQueryDocs(queryFactory, patch) {
  let updated = 0;
  for (;;) {
    const snap = await queryFactory().limit(200).get();
    if (snap.empty) break;
    if (WRITE) {
      const batch = db.batch();
      snap.docs.forEach((d) => batch.update(d.ref, patch));
      await batch.commit();
    }
    updated += snap.size;
    if (!WRITE || snap.size < 200) break;
  }
  return updated;
}

async function deleteSocialMirrorDocs(uid, subcollection, mirrorSubcollection) {
  const snap = await db.collection("users").doc(uid).collection(subcollection).limit(400).get();
  if (!snap.docs.length) return 0;
  let deleted = 0;
  const batch = db.batch();
  for (const docSnap of snap.docs) {
    const otherUid = String(docSnap.id || "").trim();
    if (!otherUid) continue;
    batch.delete(docSnap.ref);
    batch.delete(db.collection("users").doc(otherUid).collection(mirrorSubcollection).doc(uid));
    deleted += 2;
  }
  if (WRITE) await batch.commit();
  return deleted;
}

// L'account e' "tornato in uso" se si e' fatto vivo dopo il tentativo fallito
// o se ha di nuovo contenuti: in quel caso cancellarlo adesso sarebbe un danno.
async function looksResumed(uid, failedAtMs) {
  const userSnap = await db.collection("users").doc(uid).get();
  const data = userSnap.data() || {};
  const lastActiveMs = data.lastActiveAt?.toMillis?.() || 0;
  const [library, ratings, posts] = await Promise.all([
    db.collection("users").doc(uid).collection("library").count().get(),
    db.collection("ratings").where("uid", "==", uid).count().get(),
    db.collection("posts").where("authorUid", "==", uid).count().get(),
  ]);
  const counts = {
    library: library.data().count,
    ratings: ratings.data().count,
    posts: posts.data().count,
  };
  const contentBack = counts.library > 0 || counts.ratings > 0 || counts.posts > 0;
  // 5 minuti di margine: il lastActiveAt viene toccato dalla richiesta stessa.
  const activeAfter = lastActiveMs > failedAtMs + 5 * 60 * 1000;
  return { resumed: contentBack || activeAfter, counts, lastActiveMs, data };
}

async function completeDeletion(uid, userData) {
  const userRef = db.collection("users").doc(uid);
  const privateRef = db.collection("usersPrivate").doc(uid);
  const deletionRef = db.collection("accountDeletionRequests").doc(uid);
  const now = admin.firestore.FieldValue.serverTimestamp();

  await deleteSocialMirrorDocs(uid, "friends", "friends");
  await deleteSocialMirrorDocs(uid, "following", "followers");
  await deleteSocialMirrorDocs(uid, "followers", "following");

  await deleteQueryDocs(() => db.collection("ratings").where("uid", "==", uid));
  await deleteQueryDocs(() => db.collection("recommendations").where("fromUid", "==", uid));
  await deleteQueryDocs(() => db.collection("recommendations").where("toUid", "==", uid));

  for (const sub of [
    "watchlist", "library", "savedLists", "listProgressEntries", "titleStates", "imports",
    "_system", "matchFeedback", "notificationTokens", "notifications", "onboardingTelemetry",
    "feedEvents", "signals", "friends", "following", "followers", "quizStats", "quizAttempts",
    "episodeViews", "derivedRatings", "tasteProfile", "blockedUsers", "reports", "rateLimits",
    "experiments",
  ]) {
    if (WRITE) await db.recursiveDelete(userRef.collection(sub));
  }

  for (;;) {
    const snap = await db.collection("posts").where("authorUid", "==", uid).limit(100).get();
    if (snap.empty) break;
    if (WRITE) for (const d of snap.docs) await db.recursiveDelete(d.ref);
    if (!WRITE || snap.size < 100) break;
  }

  // I passi da qui in giu' sono quelli che non erano MAI stati eseguiti.
  const anonymizedMessages = await anonymizeQueryDocs(
    () => db.collectionGroup("messages").where("uid", "==", uid),
    { uid: "deleted-user", displayName: "Utente eliminato" }
  );
  const anonymizedComments = await anonymizeQueryDocs(
    () => db.collectionGroup("comments").where("uid", "==", uid),
    { uid: "deleted-user", authorName: "Utente eliminato" }
  );
  const deletedLikes = await deleteQueryDocs(() => db.collectionGroup("likes").where("uid", "==", uid));
  const deletedShares = await deleteQueryDocs(() => db.collectionGroup("shares").where("uid", "==", uid));
  const deletedEmotions =
    await deleteQueryDocs(() => db.collection("titleEmotions").where("uid", "==", uid))
    + await deleteQueryDocs(() => db.collection("episodeEmotions").where("uid", "==", uid));

  await anonymizeQueryDocs(() => db.collection("reports").where("fromUid", "==", uid), { fromUid: "deleted-user" });
  await anonymizeQueryDocs(() => db.collection("quizQuestionReports").where("reportedBy", "==", uid), { reportedBy: "deleted-user" });

  const deletedFeed = await deleteQueryDocs(() => db.collection("ratingFeed").where("uid", "==", uid));
  const deletedChallenges =
    await deleteQueryDocs(() => db.collection("quizChallenges").where("fromUid", "==", uid))
    + await deleteQueryDocs(() => db.collection("quizChallenges").where("toUid", "==", uid));

  let deletedLists = 0;
  for (;;) {
    const snap = await db.collection("userLists").where("ownerUid", "==", uid).limit(100).get();
    if (snap.empty) break;
    if (WRITE) {
      for (const d of snap.docs) {
        const coverPath = String(d.data()?.cover?.storagePath || "").trim();
        if (coverPath.startsWith("listCovers/")) {
          await admin.storage().bucket().file(coverPath).delete({ ignoreNotFound: true }).catch(() => {});
        }
        await db.recursiveDelete(d.ref);
      }
    }
    deletedLists += snap.size;
    if (!WRITE || snap.size < 100) break;
  }

  for (;;) {
    const snap = await db.collection("userLists").where("memberUids", "array-contains", uid).limit(100).get();
    if (snap.empty) break;
    if (WRITE) {
      for (const d of snap.docs) {
        const data = d.data() || {};
        const patch = {
          memberUids: admin.firestore.FieldValue.arrayRemove(uid),
          updatedAt: now,
        };
        if (Array.isArray(data.editorUids) && data.editorUids.includes(uid)) {
          patch.editorUids = admin.firestore.FieldValue.arrayRemove(uid);
        }
        if (Array.isArray(data.viewerUids) && data.viewerUids.includes(uid)) {
          patch.viewerUids = admin.firestore.FieldValue.arrayRemove(uid);
        }
        await d.ref.update(patch);
        await d.ref.collection("members").doc(uid).delete().catch(() => {});
      }
    }
    if (!WRITE || snap.size < 100) break;
  }

  for (;;) {
    const snap = await db.collection("threads").where("participants", "array-contains", uid).limit(100).get();
    if (snap.empty) break;
    if (WRITE) {
      for (const d of snap.docs) {
        const data = d.data() || {};
        const patch = { participants: admin.firestore.FieldValue.arrayRemove(uid) };
        if (data.createdBy === uid) patch.createdBy = "deleted-user";
        if (data.lastSenderUid === uid) patch.lastSenderUid = "deleted-user";
        await d.ref.update(patch);
      }
    }
    if (!WRITE || snap.size < 100) break;
  }
  await anonymizeQueryDocs(() => db.collection("threads").where("createdBy", "==", uid), { createdBy: "deleted-user" });
  await anonymizeQueryDocs(
    () => db.collection("posts").where("sharedPost.authorUid", "==", uid),
    { "sharedPost.authorUid": "deleted-user", "sharedPost.authorName": "Utente eliminato" }
  );
  await anonymizeQueryDocs(
    () => db.collection("quizInvites").where("createdByUid", "==", uid),
    { createdByUid: "deleted-user", inviterDisplayName: "Utente eliminato" }
  );
  await anonymizeQueryDocs(
    () => db.collection("quizInvites").where("claimedByUid", "==", uid),
    { claimedByUid: "deleted-user" }
  );

  try {
    const handle = String(userData.displayNameLower || "").trim();
    if (handle && WRITE) await db.collection("usernames").doc(handle).delete();
  } catch (e) { logger.warn("username", e?.message); }

  if (WRITE) {
    await db.collection("leaderboard_weekly").doc(uid).delete().catch(() => {});
    await db.collection("leaderboard_allTime").doc(uid).delete().catch(() => {});
  }
  await deleteQueryDocs(() => db.collection("guidedDmAttempts").where("fromUid", "==", uid));
  await deleteQueryDocs(() => db.collection("moderationQueue").where("authorUid", "==", uid));

  if (WRITE) {
    const bucket = admin.storage().bucket();
    for (const prefix of [
      `avatars/${uid}/`, `reviewPhotos/${uid}/`, `posters/${uid}/`,
      `manualImports/${uid}/`, `supportImports/${uid}/`, `users/${uid}/`,
    ]) {
      await bucket.deleteFiles({ prefix, force: true }).catch(() => {});
    }

    await userRef.set({
      displayName: "Deleted user",
      displayNameLower: "deleted user",
      photoURL: "",
      avatarURL: "",
      createdAt: userData.createdAt || now,
      lastActiveAt: now,
      privacyDefault: "private",
      trusted: false,
      isAdmin: false,
      isDeleted: true,
      deletedAt: now,
      level: "base",
      favoriteGenres: [],
      stats: { ratingsCount: 0, reviewsCount: 0, watchedCount: 0, totalWatchMinutes: 0, rewatchCount: 0 },
    });
    await db.recursiveDelete(privateRef);

    await deletionRef.set({ status: "ready_for_auth_delete", updatedAt: now }, { merge: true });
    try {
      await admin.auth().deleteUser(uid);
    } catch (e) {
      if (e?.code !== "auth/user-not-found") throw e;
    }
    await deletionRef.set({
      status: "completed",
      completedAt: now,
      updatedAt: now,
      repairedBy: "complete-failed-account-deletions",
      anonymizedMessages,
      anonymizedComments,
    }, { merge: true });
  }

  return { anonymizedMessages, anonymizedComments, deletedLikes, deletedShares, deletedEmotions, deletedFeed, deletedChallenges, deletedLists };
}

async function main() {
  let reqs = await db.collection("accountDeletionRequests").where("status", "==", "failed").get();
  let docs = reqs.docs;
  if (ONLY) docs = docs.filter((d) => d.id === ONLY);
  console.log(`Richieste fallite da chiudere: ${docs.length}${ONLY ? ` (filtro --only ${ONLY})` : ""}\n`);

  const skipped = [];
  let completed = 0;

  for (const reqDoc of docs) {
    const uid = reqDoc.id;
    const failedAtMs = reqDoc.data().updatedAt?.toMillis?.() || 0;
    const { resumed, counts, data } = await looksResumed(uid, failedAtMs);
    const name = data.displayName || uid;

    if (resumed && uid !== ONLY) {
      skipped.push({ uid, name, counts });
      console.log(`SALTO   ${name} (${uid}) — sembra tornato in uso: library ${counts.library}, voti ${counts.ratings}, post ${counts.posts}`);
      continue;
    }

    const result = await completeDeletion(uid, data);
    completed++;
    console.log(`${WRITE ? "CHIUSA " : "DA FARE"} ${name} (${uid}) — ${JSON.stringify(result)}`);
  }

  console.log(`\n${WRITE ? "Completate" : "Da completare"}: ${completed} · saltate: ${skipped.length}`);
  if (skipped.length) {
    console.log("Le saltate vanno decise a mano (con --only <uid> --write si forza la singola).");
  }
  if (!WRITE) console.log("DRY RUN — rilancia con --write per applicare.");
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("ERRORE:", err?.message || err);
  process.exit(1);
});
