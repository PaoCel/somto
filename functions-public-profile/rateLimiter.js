// VENDORED from functions/lib/rateLimiter.js — separate Firebase codebase can't cross-import at deploy; keep in sync.
const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");

const DEFAULTS = {
  windowSeconds: 12,
  maxInWindow: 4,
  dailyMax: 160,
};

/**
 * Generic per-user rate limiter for callable functions.
 * Stores counters under users/{uid}/_system/rateLimits/{bucket}
 */
async function enforceCallableRateLimit(db, uid, bucket, opts = {}) {
  const key = String(bucket || "generic").trim() || "generic";
  const windowMs = Math.max(1000, Number(opts.windowSeconds ?? DEFAULTS.windowSeconds) * 1000);
  const maxInWindow = Math.max(1, Number(opts.maxInWindow ?? DEFAULTS.maxInWindow));
  const dailyMax = Math.max(0, Number(opts.dailyMax ?? DEFAULTS.dailyMax));
  const nowMs = Date.now();
  const dayKey = new Date(nowMs).toISOString().slice(0, 10); // YYYY-MM-DD

  const ref = db.collection("users").doc(uid).collection("_system").doc(`rateLimit_${key}`);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? (snap.data() || {}) : {};

    const prevWindowStart = Number(data.windowStartMs || 0);
    const prevWindowCount = Number(data.windowCount || 0);
    const prevDayKey = String(data.dayKey || "");
    const prevDayCount = Number(data.dayCount || 0);

    const windowExpired = !prevWindowStart || (nowMs - prevWindowStart) > windowMs;
    const windowStartMs = windowExpired ? nowMs : prevWindowStart;
    const windowCount = (windowExpired ? 0 : prevWindowCount) + 1;
    const dayCount = (prevDayKey === dayKey ? prevDayCount : 0) + 1;

    if (windowCount > maxInWindow) {
      throw new functions.https.HttpsError(
        "resource-exhausted",
        "Stai facendo troppe richieste ravvicinate. Riprova tra pochi secondi."
      );
    }

    if (dailyMax > 0 && dayCount > dailyMax) {
      throw new functions.https.HttpsError(
        "resource-exhausted",
        "Hai raggiunto il limite giornaliero per questa azione."
      );
    }

    tx.set(ref, {
      windowStartMs,
      windowCount,
      dayKey,
      dayCount,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastCallAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  });
}

const GUEST_DEFAULTS = {
  windowSeconds: 60,
  maxInWindow: 10,
  dailyMax: 120,
};

// TTL suggerito per i doc contatore guest (campo expiresAt: abilitare una
// TTL policy Firestore su guestRateLimits.expiresAt per la pulizia).
const GUEST_DOC_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Rate limiter per callable PUBBLICHE (senza auth), chiavato sull'IP.
 * L'IP non viene mai salvato in chiaro: si usa solo un hash sha256
 * troncato. Contatori in guestRateLimits/{bucket}_{ipHash} (deny-all
 * lato client). IP mancante → bucket condiviso "unknown" (limite comune,
 * non un bypass).
 */
async function enforceGuestCallableRateLimit(db, rawIp, bucket, opts = {}) {
  const { createHash } = require("crypto");
  const key = String(bucket || "guest").trim() || "guest";
  const ip = String(rawIp || "").trim();
  const ipHash = ip
    ? createHash("sha256").update(`somto-guest:${ip}`).digest("hex").slice(0, 24)
    : "unknown";

  const windowMs = Math.max(1000, Number(opts.windowSeconds ?? GUEST_DEFAULTS.windowSeconds) * 1000);
  const maxInWindow = Math.max(1, Number(opts.maxInWindow ?? GUEST_DEFAULTS.maxInWindow));
  const dailyMax = Math.max(0, Number(opts.dailyMax ?? GUEST_DEFAULTS.dailyMax));
  const nowMs = Date.now();
  const dayKey = new Date(nowMs).toISOString().slice(0, 10);

  const ref = db.collection("guestRateLimits").doc(`${key}_${ipHash}`);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? (snap.data() || {}) : {};

    const prevWindowStart = Number(data.windowStartMs || 0);
    const prevWindowCount = Number(data.windowCount || 0);
    const prevDayKey = String(data.dayKey || "");
    const prevDayCount = Number(data.dayCount || 0);

    const windowExpired = !prevWindowStart || (nowMs - prevWindowStart) > windowMs;
    const windowStartMs = windowExpired ? nowMs : prevWindowStart;
    const windowCount = (windowExpired ? 0 : prevWindowCount) + 1;
    const dayCount = (prevDayKey === dayKey ? prevDayCount : 0) + 1;

    if (windowCount > maxInWindow) {
      throw new functions.https.HttpsError(
        "resource-exhausted",
        "Troppe richieste ravvicinate. Riprova tra qualche secondo."
      );
    }

    if (dailyMax > 0 && dayCount > dailyMax) {
      throw new functions.https.HttpsError(
        "resource-exhausted",
        "Limite giornaliero raggiunto. Registrati per continuare a giocare."
      );
    }

    tx.set(ref, {
      windowStartMs,
      windowCount,
      dayKey,
      dayCount,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + GUEST_DOC_TTL_MS),
    }, { merge: true });
  });
}

module.exports = {
  enforceCallableRateLimit,
  enforceGuestCallableRateLimit,
};
