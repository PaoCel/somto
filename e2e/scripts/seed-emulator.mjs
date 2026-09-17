import admin from "firebase-admin";
import {
  emulatorHost,
  authPort,
  firestorePort,
  storagePort,
  projectId as configProjectId,
  e2eUser,
  e2eActor,
} from "../config.mjs";

function withTimeout(promise, label, ms = 15000) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`[e2e-seed] timeout: ${label}`)), ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function normalizeName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9._ -]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveProjectId() {
  return (
    process.env.GCLOUD_PROJECT
    || process.env.FIREBASE_PROJECT
    || process.env.PROJECT_ID
    || configProjectId
  );
}

function ensureEmulatorEnv() {
  if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    process.env.FIREBASE_AUTH_EMULATOR_HOST = `${emulatorHost}:${authPort}`;
  }
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    process.env.FIRESTORE_EMULATOR_HOST = `${emulatorHost}:${firestorePort}`;
  }
  if (!process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
    process.env.FIREBASE_STORAGE_EMULATOR_HOST = `${emulatorHost}:${storagePort}`;
  }
}

async function ensureAuthUser(auth, user) {
  const uid = String(user.uid || "").trim();
  const email = String(user.email || "").trim();
  if (!uid || !email) throw new Error("uid/email mancanti per seed auth user");

  let existing = null;
  try {
    console.log(`[e2e-seed] auth getUser uid=${uid}`);
    existing = await withTimeout(auth.getUser(uid), `auth.getUser(${uid})`);
  } catch (err) {
    if (err?.code !== "auth/user-not-found") throw err;
  }

  if (!existing) {
    try {
      console.log(`[e2e-seed] auth getUserByEmail email=${email}`);
      const byEmail = await withTimeout(auth.getUserByEmail(email), `auth.getUserByEmail(${email})`);
      if (byEmail?.uid && byEmail.uid !== uid) {
        console.log(`[e2e-seed] auth deleteUser uid=${byEmail.uid}`);
        await withTimeout(auth.deleteUser(byEmail.uid), `auth.deleteUser(${byEmail.uid})`);
      }
    } catch (err) {
      if (err?.code !== "auth/user-not-found") throw err;
    }

    console.log(`[e2e-seed] auth createUser uid=${uid}`);
    await withTimeout(auth.createUser({
      uid,
      email,
      password: String(user.password || "E2ePass!123"),
      displayName: String(user.displayName || "User"),
      emailVerified: true,
      disabled: false,
    }), `auth.createUser(${uid})`);
    return;
  }

  console.log(`[e2e-seed] auth updateUser uid=${uid}`);
  await withTimeout(auth.updateUser(uid, {
    email,
    password: String(user.password || "E2ePass!123"),
    displayName: String(user.displayName || existing.displayName || "User"),
    emailVerified: true,
    disabled: false,
  }), `auth.updateUser(${uid})`);
}

function buildUserPublicDoc(user, nowTs) {
  const displayName = String(user.displayName || "User").trim() || "User";
  return {
    displayName,
    displayNameLower: normalizeName(displayName),
    photoURL: "",
    avatarURL: "",
    createdAt: nowTs,
    updatedAt: nowTs,
    lastActiveAt: nowTs,
    privacyDefault: "public",
    trusted: false,
    isAdmin: false,
    level: "base",
    favoriteGenres: [],
    onboardingStatus: {
      version: 1,
      startedAt: nowTs,
      completedAt: nowTs,
      completedLevel: 3,
      lastPromptAt: nowTs,
      dismissedAt: null,
      confidenceScore: 100,
    },
    tasteProfile: {
      seedTitleIds: [],
      seedLikedTitleIds: [],
      vibe: [],
      filmVsSeries: "mix",
      mainstream: "mix",
      era: null,
      context: [],
      dislikes: [],
      favoriteTitleText: null,
      contentTolerance: null,
      updatedAt: nowTs,
    },
    stats: {
      ratingsCount: 0,
      reviewsCount: 0,
      watchedCount: 0,
    },
  };
}

async function seedFirestore(db) {
  const nowTs = admin.firestore.Timestamp.now();
  const reviewImportId = "e2e-import-review";

  console.log("[e2e-seed] firestore seed users");
  await withTimeout(Promise.all([
    db.collection("users").doc(e2eUser.uid).set(buildUserPublicDoc(e2eUser, nowTs), { merge: true }),
    db.collection("users").doc(e2eActor.uid).set(buildUserPublicDoc(e2eActor, nowTs), { merge: true }),
    db.collection("usersPrivate").doc(e2eUser.uid).set({
      email: e2eUser.email,
      updatedAt: nowTs,
    }, { merge: true }),
    db.collection("usersPrivate").doc(e2eActor.uid).set({
      email: e2eActor.email,
      updatedAt: nowTs,
    }, { merge: true }),
  ]), "firestore.seedUsers");

  console.log("[e2e-seed] firestore seed follows");
  await withTimeout(Promise.all([
    db.collection("users").doc(e2eUser.uid).collection("following").doc(e2eActor.uid).set({
      createdAt: nowTs,
    }, { merge: true }),
    db.collection("users").doc(e2eActor.uid).collection("followers").doc(e2eUser.uid).set({
      createdAt: nowTs,
    }, { merge: true }),
  ]), "firestore.seedFollows");

  console.log("[e2e-seed] firestore seed feedEvents");
  await withTimeout(db.collection("feedEvents").doc("e2e_follow_event").set({
    ownerUid: e2eUser.uid,
    actorUid: e2eActor.uid,
    eventType: "follow",
    targetUid: e2eUser.uid,
    createdAt: nowTs,
    ingestedAt: nowTs,
    eventKey: "e2e-follow-event",
    sourceId: `${e2eActor.uid}:${e2eUser.uid}`,
    sourcePath: `users/${e2eActor.uid}/following/${e2eUser.uid}`,
  }, { merge: true }), "firestore.seedFeedEvent");

  console.log("[e2e-seed] firestore seed import review notification");
  const importRef = db.collection("users").doc(e2eUser.uid).collection("imports").doc(reviewImportId);
  await withTimeout(Promise.all([
    importRef.set({
      status: "awaiting_confirmation",
      source: "tvtime_gdpr",
      totalRows: 43,
      processedCount: 43,
      matchedCount: 41,
      unresolvedCount: 2,
      importedTitleCount: 41,
      skippedCount: 0,
      errorCount: 0,
      updatedAt: nowTs,
      createdAt: nowTs,
    }, { merge: true }),
    importRef.collection("items").doc("unresolved-1").set({
      itemId: "unresolved-1",
      rawTitle: "Example Show",
      refKind: "tv",
      seriesNameGuess: "Example Show",
      seasonNumber: 1,
      episodeNumber: 1,
      resolved: false,
      skip: false,
      confidence: 0.71,
      suggestion: {
        tmdbId: 101,
        name: "Example Show",
        year: 2025,
        mediaType: "tv",
      },
    }, { merge: true }),
    importRef.collection("items").doc("unresolved-2").set({
      itemId: "unresolved-2",
      rawTitle: "Unknown Movie",
      refKind: "movie",
      movieNameGuess: "Unknown Movie",
      resolved: false,
      skip: false,
      confidence: 0,
      suggestion: null,
    }, { merge: true }),
    db.collection("users").doc(e2eUser.uid).collection("notifications").doc("e2e-import-review-notification").set({
      type: "titles_import_needs_review",
      fromUid: null,
      toUid: e2eUser.uid,
      read: false,
      createdAt: nowTs,
      data: {
        importId: reviewImportId,
        source: "tvtime_gdpr",
        matchedCount: 41,
        unresolvedCount: 2,
        message: "Import TV Time quasi pronto: 41 titoli aggiornati, 2 da controllare.",
        ctaUrl: `/import.html?id=${reviewImportId}`,
      },
    }, { merge: true }),
  ]), "firestore.seedImportReview");

  console.log("[e2e-seed] firestore seed thread notifications");
  const threadId = "public_e2e-title";
  await withTimeout(Promise.all([
    db.collection("threads").doc(threadId).set({
      titleId: "e2e-title",
      visibility: "public",
      contextType: "public",
      contextId: "title",
      participants: [],
      groupName: "Discussione titolo",
      createdBy: e2eUser.uid,
      createdAt: nowTs,
      lastMessageAt: nowTs,
      lastMessagePreview: "Sono d'accordo",
      lastSenderUid: e2eActor.uid,
      lastMessageId: "actor-message",
    }, { merge: true }),
    db.collection("threads").doc(threadId).collection("messages").doc("user-message").set({
      uid: e2eUser.uid,
      displayName: e2eUser.displayName,
      text: "Mi è piaciuto molto",
      type: "text",
      createdAt: nowTs,
      reactions: { "❤️": [e2eActor.uid] },
    }, { merge: true }),
    db.collection("threads").doc(threadId).collection("messages").doc("actor-message").set({
      uid: e2eActor.uid,
      displayName: e2eActor.displayName,
      text: "Sono d'accordo",
      type: "text",
      createdAt: nowTs,
    }, { merge: true }),
    db.collection("users").doc(e2eUser.uid).collection("notifications").doc("e2e-thread-comment-notification").set({
      type: "thread_message",
      fromUid: e2eActor.uid,
      toUid: e2eUser.uid,
      read: false,
      createdAt: nowTs,
      data: {
        fromName: e2eActor.displayName,
        threadId,
        messageId: "actor-message",
        titleId: "e2e-title",
        preview: "Sono d'accordo",
      },
    }, { merge: true }),
    db.collection("users").doc(e2eUser.uid).collection("notifications").doc("e2e-thread-reaction-notification").set({
      type: "comment_like",
      fromUid: e2eActor.uid,
      toUid: e2eUser.uid,
      read: false,
      createdAt: nowTs,
      data: {
        fromName: e2eActor.displayName,
        threadId,
        messageId: "user-message",
        titleId: "e2e-title",
        reaction: "❤️",
        preview: "Mi è piaciuto molto",
      },
    }, { merge: true }),
  ]), "firestore.seedThreadNotifications");
}

async function main() {
  ensureEmulatorEnv();
  const projectId = resolveProjectId();

  if (!admin.apps.length) {
    admin.initializeApp({ projectId });
  }

  const auth = admin.auth();
  const db = admin.firestore();

  console.log(`[e2e-seed] start project=${projectId}`);
  await ensureAuthUser(auth, e2eUser);
  await ensureAuthUser(auth, e2eActor);
  await seedFirestore(db);

  console.log(`[e2e-seed] done project=${projectId} user=${e2eUser.email} actor=${e2eActor.email}`);
}

main()
  .catch((err) => {
    console.error("[e2e-seed] failed", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.all(admin.apps.map((app) => app.delete()));
  });
