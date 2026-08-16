const { createHash } = require("crypto");

const FEED_EVENTS_BATCH_SIZE = 350;
// Allineato al tetto di posts.text nelle rules: il feed legge questa copia,
// non il doc del post, quindi un limite piu' basso tagliava la coda dei post
// lunghi (link finale compreso) senza che si vedesse da nessuna parte.
const MAX_FEED_TEXT_LEN = 2000;
const MAX_FEED_SNIPPET_LEN = 240;
const MAX_ID_LEN = 120;

function toUid(value) {
  return String(value || "").trim();
}

function uniqueUids(values) {
  const out = [];
  const seen = new Set();
  for (const raw of values || []) {
    const uid = toUid(raw);
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    out.push(uid);
  }
  return out;
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

function clampOptionalNumber(value, min, max) {
  if (value === null || value === undefined || value === "") return null;
  return clampNumber(value, min, max);
}

function truncateText(value, maxLen) {
  const s = String(value || "").trim();
  if (!s) return "";
  return s.slice(0, Math.max(0, Number(maxLen || 0)));
}

function sanitizeId(value) {
  const id = String(value || "").trim();
  if (!id) return null;
  return id.slice(0, MAX_ID_LEN);
}

function normalizeWatchedWith(list, { max = 12 } = {}) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const uid = sanitizeId(row.uid);
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    out.push({
      uid,
      displayName: truncateText(row.displayName, 80) || "Amico",
    });
    if (out.length >= max) break;
  }
  return out;
}

function normalizeMediaUrls(list, { max = 2 } = {}) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const url = truncateText(raw, 600);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeSharedPost(sharedPost) {
  if (!sharedPost || typeof sharedPost !== "object") return null;
  const postId = sanitizeId(sharedPost.postId);
  const authorUid = sanitizeId(sharedPost.authorUid);
  if (!postId || !authorUid) return null;
  return {
    postId,
    authorUid,
    authorName: truncateText(sharedPost.authorName, 80) || "User",
    text: truncateText(sharedPost.text, MAX_FEED_TEXT_LEN),
    titleId: sanitizeId(sharedPost.titleId) || null,
  };
}

function normalizeFeedEventPayload(input = {}) {
  const eventType = String(input.eventType || "").trim();
  const actorUid = toUid(input.actorUid);
  const ownerUid = toUid(input.ownerUid);
  if (!eventType || !actorUid || !ownerUid) return null;

  const normalized = {
    ownerUid,
    actorUid,
    eventType,
    eventKey: sanitizeId(input.eventKey) || null,
    sourceId: sanitizeId(input.sourceId) || null,
    sourcePath: truncateText(input.sourcePath, 300),
    createdAt: input.createdAt || null,
    titleId: sanitizeId(input.titleId) || null,
    postId: sanitizeId(input.postId) || null,
    recommendationId: sanitizeId(input.recommendationId) || null,
    targetUid: sanitizeId(input.targetUid) || null,
    rating: clampNumber(input.rating, 1, 10),
    previousRating: clampNumber(input.previousRating, 1, 10),
    level: ["title", "season", "episode"].includes(String(input.level || "").trim())
      ? String(input.level || "").trim()
      : "",
    season: clampOptionalNumber(input.season, 1, 999),
    episode: clampOptionalNumber(input.episode, 1, 999),
    text: truncateText(input.text, MAX_FEED_TEXT_LEN),
    snippet: truncateText(input.snippet, MAX_FEED_SNIPPET_LEN),
    reviewText: truncateText(input.reviewText, MAX_FEED_TEXT_LEN),
    mediaUrl: truncateText(input.mediaUrl, 600),
    mediaUrls: normalizeMediaUrls(input.mediaUrls),
    watchedWith: normalizeWatchedWith(input.watchedWith),
    watchedWithGroup: input.watchedWithGroup && typeof input.watchedWithGroup === "object"
      ? {
          threadId: sanitizeId(input.watchedWithGroup.threadId) || "",
          groupName: truncateText(input.watchedWithGroup.groupName, 80) || "Gruppo",
        }
      : null,
    postKind: input.postKind === "share" ? "share" : (input.postKind === "post" ? "post" : ""),
    sharedPost: normalizeSharedPost(input.sharedPost),
  };

  if (!normalized.mediaUrls.length && normalized.mediaUrl) {
    normalized.mediaUrls = [normalized.mediaUrl];
  }
  if (normalized.mediaUrls.length && !normalized.mediaUrl) {
    normalized.mediaUrl = normalized.mediaUrls[0];
  }
  if (!normalized.watchedWithGroup?.threadId) {
    normalized.watchedWithGroup = null;
  }

  if (!normalized.sourcePath) normalized.sourcePath = "";
  if (!normalized.text && normalized.eventType === "post_comment" && normalized.snippet) {
    normalized.text = normalized.snippet;
  }

  return normalized;
}

function buildFeedEventDocId(ownerUid, eventKey) {
  const owner = toUid(ownerUid);
  const key = String(eventKey || "").trim();
  if (!owner || !key) throw new Error("ownerUid and eventKey are required");
  const hash = createHash("sha1").update(`${owner}::${key}`).digest("hex").slice(0, 24);
  return `${owner}_${hash}`;
}

function chunkArray(values, chunkSize = FEED_EVENTS_BATCH_SIZE) {
  const out = [];
  const size = Math.max(1, Number(chunkSize || FEED_EVENTS_BATCH_SIZE));
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
}

function buildFeedEventWriteModels({ recipientUids, eventKey, payload }) {
  const recipients = uniqueUids(recipientUids);
  if (!recipients.length) return [];

  const out = [];
  for (const ownerUid of recipients) {
    const data = normalizeFeedEventPayload({
      ...payload,
      ownerUid,
      eventKey,
    });
    if (!data) continue;
    out.push({
      ownerUid,
      docId: buildFeedEventDocId(ownerUid, eventKey),
      data,
    });
  }
  return out;
}

async function writeFeedEvents({
  db,
  recipientUids,
  eventKey,
  payload,
  serverTimestamp,
}) {
  if (!db || typeof db.batch !== "function") {
    throw new Error("Firestore db is required");
  }
  const models = buildFeedEventWriteModels({ recipientUids, eventKey, payload });
  if (!models.length) return 0;

  const batches = chunkArray(models, FEED_EVENTS_BATCH_SIZE);
  for (const rows of batches) {
    const batch = db.batch();
    rows.forEach((row) => {
      const ref = db.collection("feedEvents").doc(row.docId);
      batch.set(ref, {
        ...row.data,
        createdAt: row.data.createdAt || serverTimestamp,
        ingestedAt: serverTimestamp,
      }, { merge: true });
    });
    await batch.commit();
  }
  return models.length;
}

async function deleteFeedEvents({
  db,
  recipientUids,
  eventKey,
}) {
  if (!db || typeof db.batch !== "function") {
    throw new Error("Firestore db is required");
  }
  const recipients = uniqueUids(recipientUids);
  const key = String(eventKey || "").trim();
  if (!recipients.length || !key) return 0;

  const chunks = chunkArray(
    recipients.map((ownerUid) => ({ ownerUid, docId: buildFeedEventDocId(ownerUid, key) })),
    FEED_EVENTS_BATCH_SIZE
  );

  for (const rows of chunks) {
    const batch = db.batch();
    rows.forEach((row) => {
      batch.delete(db.collection("feedEvents").doc(row.docId));
    });
    await batch.commit();
  }

  return recipients.length;
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

async function collectFeedRecipientUids(db, actorUid, opts = {}) {
  const actor = toUid(actorUid);
  const extras = uniqueUids(opts.extraUids || []);
  if (!actor) return extras;

  const limitPerGroup = toPositiveInt(opts.limitPerGroup, 250);
  const friendsRef = db.collection("users").doc(actor).collection("friends");
  const followersRef = db.collection("users").doc(actor).collection("followers");

  const [friendsSnap, followersSnap] = await Promise.all([
    friendsRef.where("status", "==", "accepted").limit(limitPerGroup).get().catch(() => null),
    followersRef.limit(limitPerGroup).get().catch(() => null),
  ]);

  const friendUids = friendsSnap?.docs?.map((docSnap) => docSnap.id) || [];
  const followerUids = followersSnap?.docs?.map((docSnap) => docSnap.id) || [];

  return uniqueUids([actor, ...extras, ...friendUids, ...followerUids]);
}

module.exports = {
  FEED_EVENTS_BATCH_SIZE,
  MAX_FEED_TEXT_LEN,
  MAX_FEED_SNIPPET_LEN,
  toUid,
  uniqueUids,
  truncateText,
  normalizeSharedPost,
  normalizeMediaUrls,
  normalizeFeedEventPayload,
  buildFeedEventDocId,
  buildFeedEventWriteModels,
  writeFeedEvents,
  deleteFeedEvents,
  collectFeedRecipientUids,
};
