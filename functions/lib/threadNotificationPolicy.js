"use strict";

const { createHash } = require("crypto");

const IMPORTED_COMMENT_MESSAGE_ID = /^[a-f0-9]{40}$/;

function normalizeUid(value) {
  return String(value || "").trim();
}

function isImportedCommentMessageId(messageId) {
  return IMPORTED_COMMENT_MESSAGE_ID.test(String(messageId || "").trim());
}

function isMessageCreatedNearEvent(createdAt, eventTimestamp, maxSkewMs = 10 * 60 * 1000) {
  const createdAtMs = toMillis(createdAt);
  const eventMs = toMillis(eventTimestamp) || Date.parse(String(eventTimestamp || ""));
  if (!createdAtMs || !Number.isFinite(eventMs)) return false;
  return Math.abs(eventMs - createdAtMs) <= maxSkewMs;
}

function collectPriorParticipantUids(rows, senderUid, options = {}) {
  const sender = normalizeUid(senderUid);
  const excluded = new Set(
    Array.from(options.excludedUids || [], normalizeUid).filter(Boolean)
  );
  const maxRecipients = Math.max(0, Number(options.maxRecipients) || 0);
  const recipients = [];
  const seen = new Set([sender, ...excluded]);

  for (const row of Array.isArray(rows) ? rows : []) {
    if (recipients.length >= maxRecipients) break;
    const uid = normalizeUid(row?.uid);
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    recipients.push(uid);
  }

  return recipients;
}

function verifiedAddedReaction(before, after, authenticatedUid) {
  const beforeData = before && typeof before === "object" ? before : {};
  const afterData = after && typeof after === "object" ? after : {};
  const actorUid = normalizeUid(authenticatedUid);
  if (!actorUid) return null;

  const beforeReactions = beforeData.reactions && typeof beforeData.reactions === "object"
    ? beforeData.reactions
    : {};
  const afterReactions = afterData.reactions && typeof afterData.reactions === "object"
    ? afterData.reactions
    : {};
  const allEmojis = new Set([...Object.keys(beforeReactions), ...Object.keys(afterReactions)]);
  const changed = [];

  for (const emoji of allEmojis) {
    const beforeActors = Array.isArray(beforeReactions[emoji])
      ? beforeReactions[emoji].map(normalizeUid).filter(Boolean)
      : [];
    const afterActors = Array.isArray(afterReactions[emoji])
      ? afterReactions[emoji].map(normalizeUid).filter(Boolean)
      : [];
    const same = beforeActors.length === afterActors.length
      && beforeActors.every((uid) => afterActors.includes(uid));
    if (!same) changed.push({ emoji, beforeActors, afterActors });
  }

  if (changed.length !== 1) return null;
  const [{ emoji, beforeActors, afterActors }] = changed;
  if (beforeActors.includes(actorUid) || !afterActors.includes(actorUid)) return null;
  if (afterActors.length !== beforeActors.length + 1) return null;
  if (!beforeActors.every((uid) => afterActors.includes(uid))) return null;
  return { actorUid, emoji };
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value === "number") return value;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.seconds === "number") {
    return (value.seconds * 1000) + Math.floor((value.nanoseconds || 0) / 1e6);
  }
  return 0;
}

function notificationDocumentId(parts) {
  return `evt_${createHash("sha256")
    .update(JSON.stringify((Array.isArray(parts) ? parts : [parts]).map((part) => String(part || ""))))
    .digest("hex")
    .slice(0, 32)}`;
}

function planFanoutDecision(row, decision, options = {}) {
  const source = row && typeof row === "object" ? row : {};
  const decisionKey = String(decision?.decisionKey || "").trim();
  const eventMs = Number(decision?.eventMs);
  if (!decisionKey || !Number.isFinite(eventMs)) {
    return { allowed: false, replay: false, state: null };
  }

  const decisions = source.decisions && typeof source.decisions === "object"
    ? source.decisions
    : {};
  if (Object.prototype.hasOwnProperty.call(decisions, decisionKey)) {
    return { allowed: decisions[decisionKey] === true, replay: true, state: null };
  }

  const cooldownMs = Math.max(0, Number(options.cooldownMs) || 0);
  const maxDecisions = Math.max(1, Number(options.maxDecisions) || 100);
  const lastFanoutAtMs = toMillis(source.lastFanoutAt);
  const allowed = !(lastFanoutAtMs && eventMs <= lastFanoutAtMs + cooldownMs);
  const previousOrder = Array.isArray(source.decisionOrder) ? source.decisionOrder : [];
  const decisionOrder = [
    ...previousOrder.filter((key) => key !== decisionKey),
    decisionKey,
  ].slice(-maxDecisions);
  const nextDecisions = {};
  for (const key of decisionOrder) {
    nextDecisions[key] = key === decisionKey ? allowed : decisions[key] === true;
  }

  return {
    allowed,
    replay: false,
    state: {
      decisions: nextDecisions,
      decisionOrder,
      updatedAtMs: eventMs,
      lastEventKey: allowed ? decisionKey : String(source.lastEventKey || ""),
      lastThreadId: allowed ? String(decision.threadId || "") : String(source.lastThreadId || ""),
      lastMessageId: allowed ? String(decision.messageId || "") : String(source.lastMessageId || ""),
      lastFanoutAtMs: allowed ? eventMs : lastFanoutAtMs,
    },
  };
}

module.exports = {
  collectPriorParticipantUids,
  isImportedCommentMessageId,
  isMessageCreatedNearEvent,
  notificationDocumentId,
  planFanoutDecision,
  verifiedAddedReaction,
};
