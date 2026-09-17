const admin = require("firebase-admin");

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeString(value, maxLength = 500) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.slice(0, maxLength);
}

function toId(value) {
  return safeString(value, 160);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueIdList(values, max = 500) {
  const out = [];
  const seen = new Set();
  for (const raw of safeArray(values)) {
    const value = toId(raw);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function positiveNumber(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, n);
}

function publicListCoverPayload(rawCover, previewTitleIds) {
  const cover = asObject(rawCover);
  const explicitFallbacks = uniqueIdList(cover.fallbackTitleIds, 12);
  return {
    imageUrl: safeString(cover.imageUrl || cover.imageURL || "", 600) || null,
    storagePath: safeString(cover.storagePath || "", 600) || null,
    fallbackTitleIds: explicitFallbacks.length
      ? explicitFallbacks
      : previewTitleIds.slice(0, 12),
    accentHex: safeString(cover.accentHex || "", 40) || null,
  };
}

function buildPublicUserListProjection({
  listId,
  listData,
  ownerUser = {},
  serverTimestamp = admin.firestore.FieldValue.serverTimestamp(),
}) {
  const data = asObject(listData);
  const owner = asObject(ownerUser);
  const ownerUid = toId(data.ownerUid);
  const itemTitleIds = uniqueIdList(data.itemTitleIds, 500);
  const explicitPreviewIds = uniqueIdList(data.previewTitleIds, 12);
  const previewTitleIds = explicitPreviewIds.length
    ? explicitPreviewIds
    : itemTitleIds.slice(0, 4);
  const ownerDisplayName = safeString(owner.displayName || owner.name || "", 120) || null;
  const ownerPhotoURL = safeString(owner.photoURL || owner.avatarURL || "", 600) || null;
  const kind = ["collection", "ordered_path"].includes(String(data.kind || ""))
    ? String(data.kind)
    : "collection";

  return {
    listId: toId(listId),
    title: safeString(data.title || "Lista", 120) || "Lista",
    description: safeString(data.description || "", 500) || null,
    visibility: "public",
    kind,
    ownerUid,
    owner: {
      uid: ownerUid,
      displayName: ownerDisplayName,
      photoURL: ownerPhotoURL,
    },
    itemTitleIds,
    previewTitleIds,
    itemCount: positiveNumber(data.itemCount, itemTitleIds.length),
    completedCount: positiveNumber(data.completedCount, 0),
    followersCount: positiveNumber(data.followersCount, 0),
    cover: publicListCoverPayload(data.cover, previewTitleIds),
    slug: safeString(data.slug || "", 180) || null,
    editorialSlug: safeString(data.editorialSlug || "", 180) || null,
    editorial: data.editorial === true,
    createdAt: data.createdAt || null,
    updatedAt: data.updatedAt || null,
    projectedAt: serverTimestamp,
  };
}

async function syncPublicUserListProjection(db, listId, listData, opts = {}) {
  const publicRef = db.collection("publicUserLists").doc(listId);
  const data = asObject(listData);
  if (!data || safeString(data.visibility || "", 20) !== "public") {
    await publicRef.delete();
    return { public: false };
  }

  const ownerUid = toId(data.ownerUid);
  let ownerUser = {};
  if (ownerUid) {
    const ownerSnap = await db.collection("users").doc(ownerUid).get().catch(() => null);
    ownerUser = ownerSnap?.exists ? (ownerSnap.data() || {}) : {};
  }

  const projection = buildPublicUserListProjection({
    listId,
    listData: data,
    ownerUser,
    serverTimestamp: opts.serverTimestamp || admin.firestore.FieldValue.serverTimestamp(),
  });
  await publicRef.set(projection, { merge: false });
  return { public: true, projection };
}

module.exports = {
  buildPublicUserListProjection,
  publicListCoverPayload,
  syncPublicUserListProjection,
};
