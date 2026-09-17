"use strict";

const crypto = require("crypto");
const admin = require("firebase-admin");
const functions = require("firebase-functions/v1");

const SESSION_COLLECTION = "guestRateLimits";
const SESSION_PREFIX = "guestQuizSession_";
const SESSION_TTL_MS = 30 * 60 * 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

function normalizeQuestionIds(values) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => String(value || "").trim()).filter(Boolean);
}

function sessionRef(db, token) {
  return db.collection(SESSION_COLLECTION).doc(`${SESSION_PREFIX}${token}`);
}

async function issueGuestQuizSession(db, questionIds, nowMs = Date.now()) {
  const normalizedIds = normalizeQuestionIds(questionIds);
  if (!normalizedIds.length || new Set(normalizedIds).size !== normalizedIds.length) {
    throw new functions.https.HttpsError("internal", "Impossibile creare la sessione quiz.");
  }

  const token = crypto.randomBytes(24).toString("base64url");
  await sessionRef(db, token).set({
    kind: "guest_quiz_session",
    questionIds: normalizedIds,
    createdAt: new Date(nowMs),
    expiresAt: new Date(nowMs + SESSION_TTL_MS),
  });
  return token;
}

function millis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value.seconds === "number") return value.seconds * 1000;
  return 0;
}

async function requireGuestQuizSession(db, token, submittedQuestionIds, nowMs = Date.now()) {
  const normalizedToken = String(token || "").trim();
  if (!TOKEN_RE.test(normalizedToken)) {
    throw new functions.https.HttpsError("failed-precondition", "Sessione quiz non valida. Ricomincia la partita.");
  }

  const snap = await sessionRef(db, normalizedToken).get();
  const data = snap.exists ? (snap.data() || {}) : {};
  const issuedIds = normalizeQuestionIds(data.questionIds);
  const submittedIds = normalizeQuestionIds(submittedQuestionIds);
  const sameQuestions = issuedIds.length === submittedIds.length
    && new Set(issuedIds).size === issuedIds.length
    && new Set(submittedIds).size === submittedIds.length
    && submittedIds.every((id) => issuedIds.includes(id));

  if (data.kind !== "guest_quiz_session" || millis(data.expiresAt) <= nowMs || !sameQuestions) {
    throw new functions.https.HttpsError("failed-precondition", "Sessione quiz scaduta o non valida. Ricomincia la partita.");
  }

  return { token: normalizedToken, questionIds: issuedIds };
}

// La TTL Firestore potrebbe non essere configurata in tutti gli ambienti.
// Un campionamento opportunistico mantiene limitata la coda delle sessioni
// abbandonate senza introdurre uno scheduler o una nuova collection.
async function maybeCleanupExpiredGuestQuizSessions(db, nowMs = Date.now(), random = Math.random) {
  if (random() >= 0.1) return 0;
  const fieldPath = admin.firestore.FieldPath.documentId();
  const snap = await db.collection(SESSION_COLLECTION)
    .where(fieldPath, ">=", SESSION_PREFIX)
    .where(fieldPath, "<", `${SESSION_PREFIX}\uf8ff`)
    .limit(50)
    .get();
  const expired = snap.docs.filter((doc) => millis(doc.data()?.expiresAt) <= nowMs);
  if (!expired.length) return 0;
  const batch = db.batch();
  expired.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
  return expired.length;
}

module.exports = {
  SESSION_COLLECTION,
  SESSION_PREFIX,
  SESSION_TTL_MS,
  issueGuestQuizSession,
  requireGuestQuizSession,
  maybeCleanupExpiredGuestQuizSessions,
};
