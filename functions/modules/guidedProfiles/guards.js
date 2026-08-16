/**
 * Guided Profiles — guardie di riconoscimento.
 *
 * Usate sia dal modulo guided sia dai trigger esistenti (leaderboard, signup
 * notify, rating aggregate) per ESCLUDERE i profili guidati e i contenuti
 * sintetici dalle metriche reali.
 */

const { GUIDED_UID_PREFIX, ACCOUNT_TYPE } = require("./constants");

/** True se l'uid e' un profilo guidato (prefisso `guided_`). */
function isGuidedUid(uid) {
  return String(uid || "").startsWith(GUIDED_UID_PREFIX);
}

/** True se il doc `users/{uid}` rappresenta un profilo guidato. */
function isGuidedUserData(data) {
  if (!data || typeof data !== "object") return false;
  return data.accountType === ACCOUNT_TYPE.GUIDED || data.isSynthetic === true;
}

/**
 * True se un doc di contenuto (rating/post/comment/feedEvent/...) e' sintetico.
 * I contenuti scritti dalla routine guidata sono sempre marcati `isSynthetic`.
 */
function isSyntheticDoc(data) {
  return Boolean(data && data.isSynthetic === true);
}

module.exports = {
  isGuidedUid,
  isGuidedUserData,
  isSyntheticDoc,
};
