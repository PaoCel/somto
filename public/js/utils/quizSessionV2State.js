const STORAGE_PREFIX = "somto.quizSessionV2.pending.";
const VERSION = 2;
const MAX_ANSWER_TIME_MS = 20 * 60 * 1000;

function safeId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : "";
}

function safeUserId(value) {
  const uid = typeof value === "string" ? value.trim() : "";
  return uid && uid.length <= 128 ? uid : "";
}

function safeUuid(value) {
  const uuid = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid) ? uuid : "";
}

function validAnswer(answer) {
  return answer
    && safeId(answer.questionId)
    && (answer.selectedIndex === null
      || (Number.isInteger(answer.selectedIndex) && answer.selectedIndex >= 0 && answer.selectedIndex <= 3))
    && Number.isInteger(answer.timeMs)
    && answer.timeMs >= 0
    && answer.timeMs <= MAX_ANSWER_TIME_MS;
}

export function shouldUseQuizSessionV2({ buildEnabled, environment, challengeId }) {
  return buildEnabled === true && environment === "staging" && !challengeId;
}

export function pendingQuizSessionV2Key(uid) {
  const safeUid = safeUserId(uid);
  return safeUid ? `${STORAGE_PREFIX}${encodeURIComponent(safeUid)}` : "";
}

export function createPendingQuizSessionV2({ uid, sessionId, expiresAt, idempotencyKey, answers }) {
  const ownerUid = safeUserId(uid);
  const safeSessionId = safeId(sessionId);
  const safeIdempotencyKey = safeUuid(idempotencyKey);
  const expiryMs = Date.parse(expiresAt);
  if (!ownerUid || !safeSessionId || !safeIdempotencyKey || !Number.isFinite(expiryMs)) return null;
  if (!Array.isArray(answers) || !answers.length || answers.length > 10 || !answers.every(validAnswer)) return null;
  if (new Set(answers.map((answer) => answer.questionId)).size !== answers.length) return null;
  return {
    version: VERSION,
    ownerUid,
    sessionId: safeSessionId,
    expiresAt: new Date(expiryMs).toISOString(),
    idempotencyKey: safeIdempotencyKey,
    answers: answers.map(({ questionId, selectedIndex, timeMs }) => ({ questionId, selectedIndex, timeMs })),
    savedAt: new Date().toISOString(),
  };
}

export function savePendingQuizSessionV2(storage, pending) {
  const key = pendingQuizSessionV2Key(pending?.ownerUid);
  if (!storage || !key || !pending) return false;
  try {
    storage.setItem(key, JSON.stringify(pending));
    return true;
  } catch (_) {
    return false;
  }
}

export function loadPendingQuizSessionV2(storage, uid, nowMs = Date.now()) {
  const key = pendingQuizSessionV2Key(uid);
  if (!storage || !key) return null;
  try {
    const raw = JSON.parse(storage.getItem(key) || "null");
    const pending = createPendingQuizSessionV2({ ...raw, uid: raw?.ownerUid });
    if (!pending || raw.version !== VERSION || pending.ownerUid !== safeUserId(uid) || Date.parse(pending.expiresAt) <= nowMs) {
      storage.removeItem(key);
      return null;
    }
    return pending;
  } catch (_) {
    try { storage.removeItem(key); } catch (_) {}
    return null;
  }
}

export function clearPendingQuizSessionV2(storage, uid) {
  const key = pendingQuizSessionV2Key(uid);
  if (!storage || !key) return;
  try { storage.removeItem(key); } catch (_) {}
}

export function canonicalAnswersFromQuizSessionV2(result) {
  if (!Array.isArray(result?.results)) return [];
  return result.results.map(({ questionId, selectedIndex, outcome }) => ({
    questionId,
    selectedIndex,
    outcome,
  }));
}
