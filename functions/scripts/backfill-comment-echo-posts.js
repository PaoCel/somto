#!/usr/bin/env node
//
// Backfill dei post-eco per i commenti già esistenti nei thread pubblici
// (film / serie / episodi), così lo storico compare nel feed Community come
// le nuove risposte. Vedi functions/lib/commentEcho.js per la shape del doc.
//
// Idempotente: l'id del post è deterministico (`tm_<hash(threadId:messageId)>`),
// rilanciare lo script non crea doppioni. `createdAt` resta quello del
// messaggio originale — niente date finte: i commenti vecchi emergono grazie
// alla query per titolo del feed (listPublicPostsByTitleIds), non per recency.
//
// Uso:
//   node scripts/backfill-comment-echo-posts.js                 # dry-run
//   node scripts/backfill-comment-echo-posts.js --write
//   node scripts/backfill-comment-echo-posts.js --write --thread=public_xyz
//   node scripts/backfill-comment-echo-posts.js --write --since=2025-01-01
//   node scripts/backfill-comment-echo-posts.js --write --limit=500
//   node scripts/backfill-comment-echo-posts.js --write --skip-existing=false
//
// Default: DRY-RUN (nessuna scrittura), tutti i thread pubblici, tutto lo storico.

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const {
  buildEchoPostId,
  buildEchoPostData,
  parsePublicThreadId,
} = require("../lib/commentEcho");

loadLocalEnv();

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "gia-visto",
});

const db = admin.firestore();

const WRITE = process.argv.includes("--write");
const ONLY_THREAD = readArg("--thread");
const SINCE = parseSince(readArg("--since"));
const LIMIT = Number(readArg("--limit") || 0) || 0;
const SKIP_EXISTING = readArg("--skip-existing") !== "false";
const THREAD_PAGE_SIZE = 200;
const MESSAGE_PAGE_SIZE = 400;
const BATCH_SIZE = 400;

function loadLocalEnv() {
  const candidates = [
    path.join(__dirname, "..", ".env"),
    path.join(__dirname, "..", ".env.production"),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
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

function parseSince(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    console.error(`--since non valido: ${value} (usa YYYY-MM-DD)`);
    process.exit(1);
  }
  return admin.firestore.Timestamp.fromDate(d);
}

function toMillis(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.seconds === "number") return ts.seconds * 1000;
  return 0;
}

/** Tutti i thread pubblici (o solo quello passato con --thread). */
async function* iterPublicThreads() {
  if (ONLY_THREAD) {
    const snap = await db.collection("threads").doc(ONLY_THREAD).get();
    if (snap.exists) yield snap;
    return;
  }

  let cursor = null;
  for (;;) {
    let q = db.collection("threads")
      .where("visibility", "==", "public")
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(THREAD_PAGE_SIZE);
    if (cursor) q = q.startAfter(cursor);

    const snap = await q.get();
    if (snap.empty) return;
    for (const doc of snap.docs) yield doc;
    if (snap.size < THREAD_PAGE_SIZE) return;
    cursor = snap.docs[snap.docs.length - 1].id;
  }
}

async function* iterThreadMessages(threadRef) {
  let cursor = null;
  for (;;) {
    let q = threadRef.collection("messages")
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(MESSAGE_PAGE_SIZE);
    if (cursor) q = q.startAfter(cursor);

    const snap = await q.get();
    if (snap.empty) return;
    for (const doc of snap.docs) yield doc;
    if (snap.size < MESSAGE_PAGE_SIZE) return;
    cursor = snap.docs[snap.docs.length - 1].id;
  }
}

async function main() {
  console.log(`[backfill-comment-echo] mode=${WRITE ? "WRITE" : "DRY-RUN"}`
    + `${ONLY_THREAD ? ` thread=${ONLY_THREAD}` : ""}`
    + `${SINCE ? ` since=${SINCE.toDate().toISOString().slice(0, 10)}` : ""}`
    + `${LIMIT ? ` limit=${LIMIT}` : ""}`);

  const stats = {
    threads: 0,
    messages: 0,
    skippedNotEchoable: 0,
    skippedTooOld: 0,
    skippedExisting: 0,
    written: 0,
  };

  let pending = [];
  const flush = async () => {
    if (!pending.length) return;
    if (WRITE) {
      const batch = db.batch();
      pending.forEach(({ ref, data }) => batch.set(ref, data, { merge: true }));
      await batch.commit();
    }
    stats.written += pending.length;
    pending = [];
  };

  for await (const threadSnap of iterPublicThreads()) {
    const threadId = threadSnap.id;
    const threadData = threadSnap.data() || {};
    if (!parsePublicThreadId(threadId)) continue;
    stats.threads += 1;

    for await (const msgSnap of iterThreadMessages(threadSnap.ref)) {
      stats.messages += 1;
      const message = msgSnap.data() || {};

      if (SINCE && toMillis(message.createdAt) < SINCE.toMillis()) {
        stats.skippedTooOld += 1;
        continue;
      }

      const data = buildEchoPostData({
        threadId,
        messageId: msgSnap.id,
        message,
        threadData,
        now: admin.firestore.FieldValue.serverTimestamp(),
      });
      if (!data) {
        stats.skippedNotEchoable += 1;
        continue;
      }

      const postRef = db.collection("posts").doc(buildEchoPostId(threadId, msgSnap.id));
      if (SKIP_EXISTING) {
        const existing = await postRef.get();
        if (existing.exists) {
          stats.skippedExisting += 1;
          continue;
        }
      }

      pending.push({
        ref: postRef,
        data: {
          ...data,
          createdAt: data.createdAt || admin.firestore.FieldValue.serverTimestamp(),
        },
      });
      if (pending.length >= BATCH_SIZE) await flush();
      if (LIMIT && (stats.written + pending.length) >= LIMIT) {
        await flush();
        console.log(`[backfill-comment-echo] limite ${LIMIT} raggiunto, stop.`);
        return report(stats);
      }
    }
  }

  await flush();
  return report(stats);
}

function report(stats) {
  console.log("\n[backfill-comment-echo] risultato");
  console.log(`  thread pubblici visitati : ${stats.threads}`);
  console.log(`  messaggi letti           : ${stats.messages}`);
  console.log(`  post-eco ${WRITE ? "scritti " : "da scrivere"}      : ${stats.written}`);
  console.log(`  saltati (già presenti)   : ${stats.skippedExisting}`);
  console.log(`  saltati (non eco-abili)  : ${stats.skippedNotEchoable}`);
  console.log(`  saltati (prima di since) : ${stats.skippedTooOld}`);
  if (!WRITE) console.log("\n  DRY-RUN: nessuna scrittura. Rilancia con --write.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill-comment-echo] errore", err);
    process.exit(1);
  });
