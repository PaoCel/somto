#!/usr/bin/env node

const admin = require("firebase-admin");

admin.initializeApp();

const db = admin.firestore();
const auth = admin.auth();
const { FieldValue, Timestamp } = admin.firestore;

const args = new Set(process.argv.slice(2));
const WRITE = args.has("--write");
const ONLY_UID = readArg("--uid");
const PAGE_SIZE = 1000;

function readArg(name) {
  const prefixed = `${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefixed));
  if (!found) return "";
  return found.slice(prefixed.length).trim();
}

function sanitizeDisplayName(value) {
  const normalized = String(value || "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/[._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24)
    .replace(/^_+|_+$/g, "");

  if (normalized.length >= 3) return normalized;
  if (!normalized) return "User";
  return `${normalized}000`.slice(0, 3);
}

function displayNameForAuthUser(userRecord) {
  const emailLocalPart = String(userRecord.email || "").split("@")[0] || "";
  return sanitizeDisplayName(userRecord.displayName || emailLocalPart || "User");
}

function authCreatedAt(userRecord) {
  const raw = userRecord.metadata?.creationTime;
  const date = raw ? new Date(raw) : null;
  return date && Number.isFinite(date.getTime()) ? Timestamp.fromDate(date) : FieldValue.serverTimestamp();
}

function buildPublicDoc(userRecord) {
  const displayName = displayNameForAuthUser(userRecord);
  const photoURL = userRecord.photoURL || "";
  return {
    displayName,
    displayNameLower: displayName.toLowerCase(),
    photoURL,
    avatarURL: photoURL,
    createdAt: authCreatedAt(userRecord),
    lastActiveAt: FieldValue.serverTimestamp(),
    privacyDefault: "public",
    trusted: false,
    isAdmin: false,
    level: "base",
    favoriteGenres: [],
    stats: {
      ratingsCount: 0,
      reviewsCount: 0,
      watchedCount: 0,
      totalWatchMinutes: 0,
      rewatchCount: 0,
    },
  };
}

function buildPrivateDoc(userRecord) {
  return {
    ...(userRecord.email ? { email: userRecord.email } : {}),
    onboardingStatus: {
      version: 1,
      startedAt: null,
      completedAt: null,
      completedLevel: 0,
      lastPromptAt: null,
      dismissedAt: null,
      confidenceScore: 0,
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
      updatedAt: FieldValue.serverTimestamp(),
    },
    updatedAt: FieldValue.serverTimestamp(),
  };
}

async function repairUserRecord(userRecord) {
  const uid = userRecord.uid;
  const userRef = db.collection("users").doc(uid);
  const privateRef = db.collection("usersPrivate").doc(uid);
  const [userSnap, privateSnap] = await Promise.all([
    userRef.get(),
    privateRef.get().catch(() => null),
  ]);

  const missingPublic = !userSnap.exists;
  const missingPrivate = !privateSnap?.exists;
  if (!missingPublic && !missingPrivate) {
    return { uid, skipped: true, missingPublic, missingPrivate };
  }

  if (WRITE) {
    const batch = db.batch();
    if (missingPublic) {
      batch.set(userRef, buildPublicDoc(userRecord), { merge: true });
    }
    if (missingPrivate) {
      batch.set(privateRef, buildPrivateDoc(userRecord), { merge: true });
    }
    await batch.commit();
  }

  return {
    uid,
    email: userRecord.email || "",
    displayName: displayNameForAuthUser(userRecord),
    repaired: WRITE,
    missingPublic,
    missingPrivate,
  };
}

async function listAllUsers() {
  const rows = [];
  let pageToken;
  do {
    const page = await auth.listUsers(PAGE_SIZE, pageToken);
    rows.push(...page.users);
    pageToken = page.pageToken;
  } while (pageToken);
  return rows;
}

async function main() {
  const userRecords = ONLY_UID
    ? [await auth.getUser(ONLY_UID)]
    : await listAllUsers();

  const results = [];
  for (const userRecord of userRecords) {
    results.push(await repairUserRecord(userRecord));
  }

  const actionable = results.filter((row) => !row.skipped);
  console.log(JSON.stringify({
    ok: true,
    dryRun: !WRITE,
    scanned: results.length,
    missingOrRepaired: actionable.length,
    results: actionable,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
