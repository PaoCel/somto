"use strict";

// Pure planning helpers for TV Time custom-list imports. Firestore I/O and
// title matching stay in index.js; this module owns deterministic IDs,
// privacy-safe Somto payloads, ordering, dedupe, and >500-item splitting.

const { createHash } = require("crypto");
const {
  parseTvTimeListsCsv,
  buildMovieUuidNameLookup,
  resolveListItemNames,
} = require("./tvTimeLists");

const MAX_ITEMS_PER_LIST = 500;

function safeString(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function candidateKey(item = {}) {
  if (item.mediaTypeGuess === "tv" && Number(item.tvdbSeriesId) > 0) {
    return `tv|${Number(item.tvdbSeriesId)}`;
  }
  const uuid = safeString(item.uuid, 80).toLowerCase();
  return uuid ? `movie|${uuid}` : "";
}

function candidateRow(item = {}, fallbackDate = null) {
  const watchedDate = item.createdAt instanceof Date
    ? item.createdAt
    : (fallbackDate instanceof Date ? fallbackDate : new Date(0));
  if (item.mediaTypeGuess === "tv" && Number(item.tvdbSeriesId) > 0) {
    const name = safeString(item.nameGuess, 500) || `TVDB Series ${Number(item.tvdbSeriesId)}`;
    return {
      rawTitle: name,
      kind: "tv_episode",
      seriesNameGuess: name,
      movieNameGuess: null,
      seasonNumber: null,
      episodeNumber: null,
      episodeNameGuess: null,
      watchedDate,
      tvdbSeriesId: Number(item.tvdbSeriesId),
      watchlistOnly: true,
    };
  }
  const name = safeString(item.nameGuess, 500);
  if (!name) return null;
  return {
    rawTitle: name,
    kind: "movie",
    seriesNameGuess: null,
    movieNameGuess: name,
    seasonNumber: null,
    episodeNumber: null,
    episodeNameGuess: null,
    watchedDate,
    tvtimeUuid: safeString(item.uuid, 80) || null,
    watchlistOnly: true,
  };
}

function prepareTvTimeLists(listsCsv, moviesCsv) {
  const parsed = parseTvTimeListsCsv(listsCsv || "");
  const lookup = buildMovieUuidNameLookup(moviesCsv || "");
  return {
    lists: resolveListItemNames(parsed.lists, lookup),
    errors: parsed.errors,
  };
}

function collectListCandidates(lists = []) {
  const unique = new Map();
  for (const list of lists) {
    for (const item of list.items || []) {
      const key = candidateKey(item);
      if (!key || unique.has(key)) continue;
      unique.set(key, { key, item, row: candidateRow(item, list.createdAt) });
    }
  }
  return Array.from(unique.values());
}

function deterministicListId(uid, sourceKey, chunkIndex = 0) {
  const digest = createHash("sha256")
    .update(`${safeString(uid, 200)}|${safeString(sourceKey, 500)}|${chunkIndex}`)
    .digest("hex")
    .slice(0, 24);
  return `tvtime_${digest}`;
}

function safeListTitle(raw, chunkIndex, chunkCount) {
  const base = safeString(raw, 80) || "Lista TV Time";
  const suffix = chunkCount > 1 ? ` (${chunkIndex + 1}/${chunkCount})` : "";
  const room = Math.max(2, 80 - suffix.length);
  const title = `${base.slice(0, room)}${suffix}`.trim();
  return title.length >= 2 ? title : "Lista TV Time";
}

function uniqueResolvedItems(list, titleIdByCandidateKey) {
  const seen = new Set();
  const resolved = [];
  let unresolved = 0;
  for (const item of list.items || []) {
    const key = candidateKey(item);
    const titleId = key ? titleIdByCandidateKey.get(key) : null;
    if (!titleId) { unresolved += 1; continue; }
    if (seen.has(titleId)) continue;
    seen.add(titleId);
    resolved.push({ titleId, item });
  }
  return { resolved, unresolved };
}

function buildTvTimeListPlans({ uid, lists = [], titleIdByCandidateKey, owner = {}, now = new Date() } = {}) {
  const plans = [];
  let unresolvedItems = 0;
  let originalPublicLists = 0;

  for (const list of lists) {
    const { resolved, unresolved } = uniqueResolvedItems(list, titleIdByCandidateKey || new Map());
    unresolvedItems += unresolved;
    if (list.isPublic) originalPublicLists += 1;
    const chunks = [];
    for (let i = 0; i < resolved.length; i += MAX_ITEMS_PER_LIST) {
      chunks.push(resolved.slice(i, i + MAX_ITEMS_PER_LIST));
    }
    if (chunks.length === 0) chunks.push([]);

    chunks.forEach((chunk, chunkIndex) => {
      const sourceKey = safeString(list.sKey, 160)
        || `${safeString(list.name, 200)}|${list.createdAt instanceof Date ? list.createdAt.toISOString() : ""}`;
      const listId = deterministicListId(uid, sourceKey, chunkIndex);
      const titleIds = chunk.map((entry) => entry.titleId);
      const createdAt = list.createdAt instanceof Date ? list.createdAt : now;
      const ownerSummary = {
        uid,
        displayName: safeString(owner.displayName, 80) || "Utente",
        photoURL: owner.photoURL || owner.avatarURL || null,
      };
      plans.push({
        listId,
        root: {
          ownerUid: uid,
          title: safeListTitle(list.name, chunkIndex, chunks.length),
          description: safeString(list.description, 280) || null,
          visibility: "private",
          kind: "collection",
          memberUids: [uid],
          editorUids: [],
          viewerUids: [],
          cover: { imageUrl: null, storagePath: null, fallbackTitleIds: titleIds.slice(0, 4), accentHex: null },
          owner: ownerSummary,
          itemTitleIds: titleIds,
          previewTitleIds: titleIds.slice(0, 4),
          itemCount: titleIds.length,
          completedCount: 0,
          followersCount: 0,
          createdAt,
          updatedAt: now,
        },
        member: { uid, displayName: ownerSummary.displayName, photoURL: ownerSummary.photoURL, role: "owner", joinedAt: createdAt },
        items: chunk.map(({ titleId, item }, index) => ({
          titleId,
          orderIndex: index * 1000,
          addedByUid: uid,
          note: null,
          addedAt: item.createdAt instanceof Date ? item.createdAt : createdAt,
          updatedAt: now,
        })),
        originalWasPublic: Boolean(list.isPublic),
        sourceKey,
      });
    });
  }

  return { plans, unresolvedItems, originalPublicLists };
}

module.exports = {
  MAX_ITEMS_PER_LIST,
  candidateKey,
  candidateRow,
  prepareTvTimeLists,
  collectListCandidates,
  deterministicListId,
  buildTvTimeListPlans,
};
