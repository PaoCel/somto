#!/usr/bin/env node
/**
 * backfill-public-review-threads.js
 *
 * Backfill delle review title-level dentro i thread pubblici dei titoli.
 *
 * Cosa fa:
 * - legge /ratings dove level == "title" e reviewText non vuoto
 * - crea (se manca) /threads/public_<titleId>
 * - inserisce o aggiorna un messaggio in /threads/{threadId}/messages
 * - aggiorna metadata del thread (lastMessageAt, preview, participants)
 *
 * Idempotenza:
 * - usa doc id stabile `review_<ratingId>` per i messaggi backfillati
 * - se trova un messaggio già pubblicato con stesso uid + stesso testo,
 *   non duplica e collega il rating a quel messaggio
 *
 * Uso:
 *   cd functions
 *   node scripts/backfill-public-review-threads.js
 *   node scripts/backfill-public-review-threads.js --write
 *   node scripts/backfill-public-review-threads.js --write --limit 200
 *   node scripts/backfill-public-review-threads.js --write --uid <uid>
 *   node scripts/backfill-public-review-threads.js --write --titleId <titleId>
 */

const admin = require("firebase-admin");
const {initializeFirestore} = require("firebase-admin/firestore");

const WRITE = process.argv.includes("--write");
const LIMIT = getIntArg("--limit", 0);
const ONLY_UID = getStringArg("--uid", "");
const ONLY_TITLE_ID = getStringArg("--titleId", "");

const app = admin.initializeApp({projectId: "gia-visto"});
const db = initializeFirestore(app, {preferRest: true});
const Timestamp = admin.firestore.Timestamp;

function getIntArg(flag, fallback = 0) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0 || idx === process.argv.length - 1) return fallback;
  const n = Number.parseInt(process.argv[idx + 1], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getStringArg(flag, fallback = "") {
  const idx = process.argv.indexOf(flag);
  if (idx < 0 || idx === process.argv.length - 1) return fallback;
  return String(process.argv[idx + 1] || "").trim() || fallback;
}

function hasText(value) {
  return String(value || "").trim().length > 0;
}

function normalizeReviewText(value) {
  return String(value || "").trim().slice(0, 5000);
}

function formatMaskedRating(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const q = Math.round(n * 4) / 4;
  const bounded = Math.max(1, Math.min(10, q));
  const floor = Math.floor(bounded);
  const frac = Math.round((bounded - floor) * 100);
  if (frac === 0) return String(floor);
  if (frac === 25) return `${floor}+`;
  if (frac === 50) return `${floor}½`;
  if (frac === 75) return `${Math.min(10, floor + 1)}−`;
  return String(Math.round(bounded * 100) / 100);
}

function composeReviewMessage(ratingDoc) {
  const reviewText = normalizeReviewText(ratingDoc.reviewText);
  const watchedWith = Array.isArray(ratingDoc.watchedWith) ? ratingDoc.watchedWith : [];
  const names = watchedWith
    .map((row) => String(row?.displayName || row?.name || row?.uid || "").trim())
    .filter(Boolean)
    .slice(0, 3);
  const peopleSnippet = names.length ? ` · con ${names.join(", ")}` : "";
  const reviewSnippet = reviewText ? ` — ${reviewText}` : "";
  return `${formatMaskedRating(ratingDoc.rating)}/10${peopleSnippet}${reviewSnippet}`;
}

function toTimestamp(value) {
  if (!value) return Timestamp.now();
  if (value instanceof Timestamp) return value;
  if (typeof value?.toDate === "function") {
    const date = value.toDate();
    if (date instanceof Date && !Number.isNaN(date.getTime())) {
      return Timestamp.fromDate(date);
    }
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return Timestamp.fromDate(value);
  }
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return Timestamp.fromDate(date);
  }
  return Timestamp.now();
}

function timestampMs(value) {
  return toTimestamp(value).toMillis();
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size));
  }
  return out;
}

async function loadDisplayNameMap(uids) {
  const unique = Array.from(new Set(uids.map((uid) => String(uid || "").trim()).filter(Boolean)));
  const out = new Map();
  for (const group of chunk(unique, 250)) {
    const refs = group.map((uid) => db.collection("users").doc(uid));
    const docs = await db.getAll(...refs);
    docs.forEach((doc) => {
      const uid = doc.id;
      const displayName = String(doc.data()?.displayName || "").trim();
      out.set(uid, displayName || uid);
    });
  }
  unique.forEach((uid) => {
    if (!out.has(uid)) out.set(uid, uid);
  });
  return out;
}

async function findExistingMessage(messagesRef, ratingDoc, messageText) {
  const stableRef = messagesRef.doc(`review_${ratingDoc.id}`);
  const stableSnap = await stableRef.get();
  if (stableSnap.exists) {
    return { ref: stableRef, snap: stableSnap, kind: "stable" };
  }

  const bySourceSnap = await messagesRef
    .where("sourceRatingId", "==", ratingDoc.id)
    .limit(1)
    .get();
  if (!bySourceSnap.empty) {
    const snap = bySourceSnap.docs[0];
    return { ref: snap.ref, snap, kind: "source" };
  }

  const byUidSnap = await messagesRef
    .where("uid", "==", ratingDoc.uid)
    .limit(30)
    .get();
  const exactTextMatch = byUidSnap.docs.find((doc) => String(doc.data()?.text || "").trim() === messageText);
  if (exactTextMatch) {
    return { ref: exactTextMatch.ref, snap: exactTextMatch, kind: "text" };
  }

  return { ref: stableRef, snap: stableSnap, kind: "new" };
}

function sameMessagePayload(existing, next) {
  return String(existing?.uid || "") === String(next.uid || "")
    && String(existing?.displayName || "") === String(next.displayName || "")
    && String(existing?.text || "") === String(next.text || "")
    && String(existing?.type || "") === String(next.type || "")
    && String(existing?.sourceRatingId || "") === String(next.sourceRatingId || "")
    && existing?.backfill === next.backfill
    && String(existing?.titleId || "") === String(next.titleId || "")
    && timestampMs(existing?.createdAt) === timestampMs(next.createdAt);
}

async function main() {
  console.log(`\n=== BACKFILL PUBLIC REVIEW THREADS ===${WRITE ? " [WRITE MODE]" : " [DRY-RUN]"}\n`);
  if (!WRITE) {
    console.log("⚡ Usa --write per applicare davvero le modifiche.\n");
  }

  let query = db.collection("ratings").where("level", "==", "title");
  if (ONLY_UID) query = query.where("uid", "==", ONLY_UID);
  if (ONLY_TITLE_ID) query = query.where("titleId", "==", ONLY_TITLE_ID);

  const ratingsSnap = await query.get();
  let ratings = ratingsSnap.docs
    .map((doc) => ({ id: doc.id, ref: doc.ref, ...doc.data() }))
    .filter((row) => hasText(row.reviewText) && hasText(row.uid) && hasText(row.titleId));

  ratings.sort((a, b) => timestampMs(a.updatedAt || a.createdAt) - timestampMs(b.updatedAt || b.createdAt));
  if (LIMIT) {
    ratings = ratings.slice(0, LIMIT);
  }

  console.log(`Ratings title-level trovati: ${ratingsSnap.size}`);
  console.log(`Ratings con review valida: ${ratings.length}\n`);

  if (!ratings.length) {
    console.log("Nessuna review da backfillare.");
    return;
  }

  const displayNameMap = await loadDisplayNameMap(ratings.map((row) => row.uid));
  const grouped = new Map();
  ratings.forEach((row) => {
    const threadId = `public_${row.titleId}`;
    if (!grouped.has(threadId)) grouped.set(threadId, []);
    grouped.get(threadId).push(row);
  });

  const stats = {
    threadsScanned: 0,
    threadsCreated: 0,
    messagesCreated: 0,
    messagesUpdated: 0,
    messagesLinked: 0,
    messagesSkipped: 0,
    threadDocsUpdated: 0,
  };

  for (const [threadId, group] of grouped.entries()) {
    stats.threadsScanned += 1;
    const threadRef = db.collection("threads").doc(threadId);
    const messagesRef = threadRef.collection("messages");
    const threadSnap = await threadRef.get();
    const threadData = threadSnap.data() || null;

    if (threadSnap.exists && String(threadData?.visibility || "").trim() && threadData.visibility !== "public") {
      console.warn(`SKIP ${threadId}: doc esistente ma non pubblico.`);
      continue;
    }

    const sortedGroup = [...group].sort((a, b) => timestampMs(a.updatedAt || a.createdAt) - timestampMs(b.updatedAt || b.createdAt));
    const firstRating = sortedGroup[0];

    const threadState = {
      createdAt: threadData?.createdAt || toTimestamp(firstRating.createdAt || firstRating.updatedAt),
      createdBy: String(threadData?.createdBy || firstRating.uid || "").trim() || "backfill",
      lastMessageAt: threadData?.lastMessageAt || null,
      lastMessagePreview: String(threadData?.lastMessagePreview || ""),
      lastSenderUid: threadData?.lastSenderUid || null,
      participants: new Set(Array.isArray(threadData?.participants) ? threadData.participants.map((uid) => String(uid || "").trim()).filter(Boolean) : []),
      titleId: String(threadData?.titleId || firstRating.titleId || "").trim(),
      groupName: String(threadData?.groupName || "Discussione pubblica").trim() || "Discussione pubblica",
    };

    if (!threadSnap.exists) {
      stats.threadsCreated += 1;
    }

    for (const ratingDoc of sortedGroup) {
      const messageText = composeReviewMessage(ratingDoc);
      const displayName = displayNameMap.get(ratingDoc.uid) || ratingDoc.uid;
      const createdAt = toTimestamp(ratingDoc.updatedAt || ratingDoc.createdAt);
      const fullPayload = {
        uid: ratingDoc.uid,
        displayName,
        text: messageText,
        type: "text",
        createdAt,
        sourceRatingId: ratingDoc.id,
        sourceType: "rating_review",
        backfill: true,
        titleId: ratingDoc.titleId,
      };

      const found = await findExistingMessage(messagesRef, ratingDoc, messageText);

      const isLinkedExistingPost =
        found.ref.id !== `review_${ratingDoc.id}` &&
        (found.kind === "text" || found.kind === "source");

      if (found.kind === "new") {
        if (WRITE) {
          await found.ref.set(fullPayload, { merge: true });
        }
        stats.messagesCreated += 1;
      } else if (isLinkedExistingPost) {
        const metadataPatch = {
          sourceRatingId: ratingDoc.id,
          sourceType: "rating_review",
          backfill: true,
          titleId: ratingDoc.titleId,
        };
        const needsUpdate = String(found.snap.data()?.sourceRatingId || "") !== ratingDoc.id
          || found.snap.data()?.backfill !== true
          || String(found.snap.data()?.titleId || "") !== String(ratingDoc.titleId || "");
        if (needsUpdate) {
          if (WRITE) {
            await found.ref.set(metadataPatch, { merge: true });
          }
          stats.messagesLinked += 1;
        } else {
          stats.messagesSkipped += 1;
        }
      } else {
        const existingData = found.snap.data() || {};
        if (!sameMessagePayload(existingData, fullPayload)) {
          if (WRITE) {
            await found.ref.set(fullPayload, { merge: true });
          }
          stats.messagesUpdated += 1;
        } else {
          stats.messagesSkipped += 1;
        }
      }

      threadState.participants.add(ratingDoc.uid);
      if (!threadState.lastMessageAt || timestampMs(createdAt) >= timestampMs(threadState.lastMessageAt)) {
        threadState.lastMessageAt = createdAt;
        threadState.lastMessagePreview = messageText.slice(0, 100);
        threadState.lastSenderUid = ratingDoc.uid;
      }
    }

    const threadPayload = {
      titleId: threadState.titleId,
      visibility: "public",
      contextType: "public",
      contextId: "global",
      participants: Array.from(threadState.participants),
      groupName: threadState.groupName,
      createdBy: threadState.createdBy,
      createdAt: threadState.createdAt,
      lastMessageAt: threadState.lastMessageAt || threadState.createdAt,
      lastMessagePreview: threadState.lastMessagePreview,
      lastSenderUid: threadState.lastSenderUid,
    };

    if (WRITE) {
      await threadRef.set(threadPayload, { merge: true });
    }
    stats.threadDocsUpdated += 1;
  }

  console.log("Risultato:");
  console.log(`- Thread scansionati: ${stats.threadsScanned}`);
  console.log(`- Thread creati: ${stats.threadsCreated}`);
  console.log(`- Messaggi creati: ${stats.messagesCreated}`);
  console.log(`- Messaggi aggiornati: ${stats.messagesUpdated}`);
  console.log(`- Messaggi collegati a post gia esistenti: ${stats.messagesLinked}`);
  console.log(`- Messaggi gia allineati/skippati: ${stats.messagesSkipped}`);
  console.log(`- Thread metadata aggiornati: ${stats.threadDocsUpdated}`);
  console.log("\nDone.");
}

async function shutdown(exitCode) {
  try {
    if (typeof db.terminate === "function") {
      await db.terminate();
    }
  } catch (err) {
    console.warn("Warn terminate firestore:", err?.message || err);
  }
  process.exit(exitCode);
}

main()
  .then(() => shutdown(0))
  .catch(async (err) => {
    console.error("\nErrore nel backfill:", err);
    await shutdown(1);
  });
