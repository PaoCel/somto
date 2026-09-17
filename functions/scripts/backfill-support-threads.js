#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

loadLocalEnv();

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "gia-visto",
});

const db = admin.firestore();
const { FieldValue } = admin.firestore;

const WRITE = process.argv.includes("--write");
const ONLY_UID = readArg("--uid");
const LIMIT = Number(readArg("--limit") || 0) || 0;
const PAGE_SIZE = 300;

const EXISTING_USER_MESSAGE = "Abbiamo aperto questa chat per l'assistenza Somto. Puoi scrivere qui per dubbi, problemi, segnalazioni o feedback: ti rispondero' appena possibile, di solito entro 24-48 ore.";

function loadLocalEnv() {
  const candidates = [
    path.join(__dirname, "..", ".env"),
    path.join(__dirname, "..", ".env.production"),
  ];

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const idx = trimmed.indexOf("=");
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key && process.env[key] == null) process.env[key] = value;
    }
  }
}

function readArg(name) {
  const prefixed = `${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefixed));
  if (!found) return "";
  return found.slice(prefixed.length).trim();
}

function adminUids() {
  return String(process.env.ADMIN_UIDS || "")
    .split(",")
    .map((uid) => uid.trim())
    .filter(Boolean);
}

function supportUid() {
  return String(process.env.SUPPORT_UID || "").trim() || adminUids()[0] || "";
}

function threadIdForUser(uid) {
  return `support_${uid}`;
}

async function ensureSupportThread(userDoc, supportUserUid) {
  const uid = userDoc.id;
  const admins = adminUids();
  if (!uid || !supportUserUid || uid === supportUserUid || admins.includes(uid)) {
    return { uid, skipped: true, reason: "admin-or-self" };
  }

  const threadRef = db.collection("threads").doc(threadIdForUser(uid));
  const threadSnap = await threadRef.get();
  if (threadSnap.exists) {
    const data = threadSnap.data() || {};
    const participants = Array.isArray(data.participants) ? data.participants : [];
    if (participants.includes(uid) && participants.includes(supportUserUid)) {
      return { uid, skipped: true, reason: "exists", threadId: threadRef.id };
    }
  }

  if (!WRITE) {
    return { uid, wouldCreate: true, threadId: threadRef.id };
  }

  const messageRef = threadRef.collection("messages").doc();
  const now = FieldValue.serverTimestamp();
  const batch = db.batch();
  batch.set(threadRef, {
    titleId: null,
    visibility: "private",
    contextType: "group",
    contextId: `support_${uid}`,
    participants: [supportUserUid, uid].sort(),
    groupName: "Assistenza Somto",
    createdBy: supportUserUid,
    createdAt: now,
    lastMessageAt: now,
    lastMessagePreview: EXISTING_USER_MESSAGE.slice(0, 100),
    lastSenderUid: supportUserUid,
    lastMessageId: messageRef.id,
  }, { merge: true });
  batch.set(messageRef, {
    uid: supportUserUid,
    displayName: "Assistenza Somto",
    text: EXISTING_USER_MESSAGE,
    type: "text",
    createdAt: now,
  });
  await batch.commit();

  return { uid, created: true, threadId: threadRef.id };
}

async function main() {
  const supportUserUid = supportUid();
  if (!supportUserUid) {
    throw new Error("SUPPORT_UID non configurato e ADMIN_UIDS vuoto.");
  }

  const results = [];
  if (ONLY_UID) {
    const doc = await db.collection("users").doc(ONLY_UID).get();
    if (!doc.exists) throw new Error(`users/${ONLY_UID} non trovato.`);
    results.push(await ensureSupportThread(doc, supportUserUid));
  } else {
    let lastDoc = null;
    let scanned = 0;

    for (;;) {
      let query = db.collection("users")
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(PAGE_SIZE);
      if (lastDoc) query = query.startAfter(lastDoc);

      const snap = await query.get();
      if (snap.empty) break;

      for (const doc of snap.docs) {
        lastDoc = doc;
        scanned += 1;
        results.push(await ensureSupportThread(doc, supportUserUid));
        if (LIMIT && scanned >= LIMIT) break;
      }

      if (snap.size < PAGE_SIZE || (LIMIT && scanned >= LIMIT)) break;
    }
  }

  const created = results.filter((row) => row.created).length;
  const wouldCreate = results.filter((row) => row.wouldCreate).length;
  const skipped = results.filter((row) => row.skipped).length;

  console.log(JSON.stringify({
    ok: true,
    dryRun: !WRITE,
    supportUid: supportUserUid,
    scanned: results.length,
    created,
    wouldCreate,
    skipped,
    sample: results.filter((row) => row.created || row.wouldCreate).slice(0, 25),
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
