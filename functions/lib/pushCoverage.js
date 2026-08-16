"use strict";

/**
 * Copertura push: quanti utenti sono effettivamente raggiungibili.
 *
 * È la metrica che governa tutte le notifiche: senza un token FCM la push muore
 * in pushOnNotificationCreate e resta solo la campanella in-app. Il 2026-08-03
 * erano 50 utenti su 361 (13,9%), tutti iOS, zero web — non un bug di logica,
 * un buco di copertura. Vedi docs/context/NOTIFICATIONS.md.
 *
 * Questo file contiene solo funzioni pure: l'I/O sta in
 * modules/pushCoverage.js (job settimanale) e scripts/push-coverage-report.js.
 */

const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const FRESH_TOKEN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function toMillis(value) {
  if (!value) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value._seconds === "number") return value._seconds * 1000;
  if (typeof value.seconds === "number") return value.seconds * 1000;
  return null;
}

function percent(part, total) {
  if (!total) return 0;
  return Math.round((1000 * part) / total) / 10;
}

/**
 * @param {Array<{uid: string, lastActiveAtMs: number|null, isDeleted?: boolean}>} users
 * @param {Array<{uid: string, platform: string, updatedAtMs: number|null}>} tokens
 */
function summarizePushCoverage({ users = [], tokens = [], nowMs = Date.now() } = {}) {
  const liveUsers = users.filter((row) => row && row.uid && row.isDeleted !== true);
  const uidsWithToken = new Set();
  const byPlatform = {};
  let freshTokens = 0;

  for (const token of tokens) {
    const uid = String(token?.uid || "").trim();
    if (!uid) continue;
    uidsWithToken.add(uid);
    const platform = String(token?.platform || "unknown").trim().toLowerCase() || "unknown";
    byPlatform[platform] = (byPlatform[platform] || 0) + 1;
    const updated = toMillis(token?.updatedAtMs);
    if (updated !== null && (nowMs - updated) <= FRESH_TOKEN_WINDOW_MS) freshTokens += 1;
  }

  const activeUsers = liveUsers.filter((row) => {
    const last = toMillis(row.lastActiveAtMs);
    return last !== null && (nowMs - last) <= ACTIVE_WINDOW_MS;
  });
  const activeReachable = activeUsers.filter((row) => uidsWithToken.has(row.uid));
  const reachable = liveUsers.filter((row) => uidsWithToken.has(row.uid));

  return {
    measuredAtMs: nowMs,
    users: liveUsers.length,
    reachable: reachable.length,
    reachablePercent: percent(reachable.length, liveUsers.length),
    activeUsers: activeUsers.length,
    activeReachable: activeReachable.length,
    activeReachablePercent: percent(activeReachable.length, activeUsers.length),
    tokens: tokens.length,
    freshTokens,
    byPlatform,
  };
}

function signed(delta) {
  if (!delta) return "invariato";
  return delta > 0 ? `+${delta}` : String(delta);
}

/**
 * Testo della notifica settimanale. `previous` è lo snapshot della settimana
 * prima (può mancare al primo giro).
 */
function formatPushCoverageMessage(summary, previous = null) {
  const platforms = Object.entries(summary.byPlatform || {})
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} ${count}`)
    .join(", ") || "nessun token";

  const parts = [
    `${summary.reachable} utenti su ${summary.users} raggiungibili (${summary.reachablePercent}%)`,
  ];
  if (previous && Number.isFinite(Number(previous.reachable))) {
    parts.push(`${signed(summary.reachable - Number(previous.reachable))} rispetto a 7 giorni fa`);
  }
  parts.push(`attivi negli ultimi 7 giorni: ${summary.activeReachable}/${summary.activeUsers} (${summary.activeReachablePercent}%)`);
  parts.push(`token: ${platforms}`);
  return parts.join(" · ");
}

module.exports = {
  ACTIVE_WINDOW_MS,
  FRESH_TOKEN_WINDOW_MS,
  formatPushCoverageMessage,
  summarizePushCoverage,
  toMillis,
};
