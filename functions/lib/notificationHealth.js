"use strict";

/**
 * Guardia giornaliera delle notifiche, in funzioni pure. L'I/O sta in
 * modules/notificationHealth.js (job) e scripts/notification-health-report.js
 * (la stessa misura a mano, senza scrivere niente).
 *
 * Perche' esiste. La misura del 2026-09-10 (30 giorni di log) ha trovato la
 * catena sana: ogni follow, messaggio, commento e like aveva prodotto la sua
 * notifica, zero crash, nessun errore FCM che non fosse un token morto. Ma se
 * si fosse rotta non se ne sarebbe accorto nessuno: un trigger che smette di
 * scrivere, un deploy che rompe la push o una chiave APNs scaduta lasciano la
 * campanella vuota in silenzio, e "arrivano a singhiozzo" resta l'unico
 * segnale. Qui si confrontano le cose che devono andare insieme.
 *
 * Il volume sociale e' basso (qualche interazione al giorno), quindi i
 * controlli sociali guardano 72 ore e scattano solo sopra una soglia: nel mese
 * misurato 17 messaggi su 65 non avevano nessun destinatario (thread di
 * supporto, thread senza altri partecipanti), e "nessuna notifica" dopo due
 * messaggi e' normale.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DELIVERY_WINDOW_MS = DAY_MS;
const SILENCE_WINDOW_MS = 3 * DAY_MS;
// La push parte in pochi secondi dalla creazione del doc: oltre questo
// margine un doc senza esito non e' "in corso", e' stato saltato.
const PUSH_GRACE_MS = 15 * 60 * 1000;
// Un guasto che dura si ricorda ogni tre giorni, non ogni mattina.
const REMIND_AFTER_MS = 3 * DAY_MS;

const SOCIAL_TYPES = new Set([
  "follow",
  "friend_request",
  "friend_accept",
  "friend_post",
  "thread_message",
  "thread_mention",
  "post_mention",
  "post_like",
  "post_comment",
  "comment_reply",
  "comment_like",
  "rating_like",
  "rating_comment",
  "watched_with_tag",
  "recommendation",
  "quiz_challenge",
  "quiz_challenge_completed",
]);

const RELEASE_TYPES = new Set([
  "title_update",
  "official_update",
  "weekly_digest",
  "new_season_available",
]);

const ADMIN_TYPES = new Set([
  "new_user",
  "admin_activity",
  "admin_import_started",
  "moderation_pending",
  "client_error_alert",
  "push_coverage_report",
  "official_source_report",
  "import_health_alert",
  "comment_review_pending",
  "notification_health_alert",
]);

const STATUS_KEYS = ["delivered", "failed", "no_token", "cooldown", "prefs_off"];

// Interazione sorgente -> notifiche che deve produrre.
const SOCIAL_CHECKS = [
  { key: "follow", label: "nuovi follower", types: ["follow"], minSources: 3 },
  { key: "message", label: "messaggi nei thread", types: ["thread_message", "thread_mention"], minSources: 8 },
  { key: "comment", label: "commenti", types: ["post_comment", "rating_comment", "comment_reply", "post_mention"], minSources: 3 },
  { key: "like", label: "like", types: ["post_like", "rating_like", "comment_like"], minSources: 3 },
];

const ALERT_LABELS = {
  push_trigger_silent: "esito push mancante",
  delivery_broken: "consegna push",
  fcm_errors: "errori FCM",
  token_drop: "calo dei token",
  release_silent: "notifiche di uscite",
  social_silent_follow: "notifiche di follow",
  social_silent_message: "notifiche dei messaggi",
  social_silent_comment: "notifiche dei commenti",
  social_silent_like: "notifiche dei like",
};

function nonNegativeInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function percent(part, total) {
  if (!total) return 0;
  return Math.round((1000 * part) / total) / 10;
}

function notificationCategory(type) {
  const value = String(type || "");
  if (SOCIAL_TYPES.has(value)) return "social";
  if (RELEASE_TYPES.has(value)) return "release";
  if (value.startsWith("engagement_")) return "engagement";
  if (value.startsWith("titles_import_")) return "import";
  if (ADMIN_TYPES.has(value)) return "admin";
  return "other";
}

function emptyCounts() {
  return { created: 0, delivered: 0, failed: 0, no_token: 0, cooldown: 0, prefs_off: 0, missing: 0 };
}

/**
 * @param {object} input
 * @param {Array<{type: string, createdAtMs: number, pushStatus?: string|null, errorCodes?: string[]}>} input.notifications
 *   notifiche delle ultime 72 ore (bastano: le finestre sono 24 e 72 ore)
 * @param {{follow?: number, message?: number, comment?: number, like?: number}} input.sources
 *   interazioni fra utenti nelle ultime 72 ore
 * @param {number|null} input.tokenCount token push esistenti adesso
 * @param {{tokenCount?: number}|null} input.previous riepilogo del giro prima
 * @param {number|null} input.trackingSinceMs da quando pushOnNotificationCreate
 *   scrive `pushDelivery`: le notifiche piu' vecchie non hanno l'esito e non
 *   devono sembrare saltate
 */
function evaluateNotificationHealth({
  notifications = [],
  sources = {},
  tokenCount = null,
  previous = null,
  trackingSinceMs = null,
  nowMs = Date.now(),
} = {}) {
  const rows = (Array.isArray(notifications) ? notifications : [])
    .filter((row) => row && Number.isFinite(row.createdAtMs));
  const dayStartMs = nowMs - DELIVERY_WINDOW_MS;
  const silenceStartMs = nowMs - SILENCE_WINDOW_MS;
  const expectStatusSinceMs = finiteNumber(trackingSinceMs);

  const totals = emptyCounts();
  const byCategory = {};
  const unexpectedErrors = {};
  let trackable = 0;

  for (const row of rows) {
    if (row.createdAtMs < dayStartMs) continue;
    const category = notificationCategory(row.type);
    const counts = byCategory[category] || (byCategory[category] = emptyCounts());
    counts.created += 1;
    totals.created += 1;

    const status = STATUS_KEYS.includes(row.pushStatus) ? row.pushStatus : null;
    const expectsStatus = expectStatusSinceMs !== null &&
      row.createdAtMs >= expectStatusSinceMs &&
      row.createdAtMs <= nowMs - PUSH_GRACE_MS;
    if (expectsStatus) trackable += 1;
    if (status) {
      counts[status] += 1;
      totals[status] += 1;
    } else if (expectsStatus) {
      counts.missing += 1;
      totals.missing += 1;
    }
    for (const code of Array.isArray(row.errorCodes) ? row.errorCodes : []) {
      const key = String(code || "unknown");
      unexpectedErrors[key] = (unexpectedErrors[key] || 0) + 1;
    }
  }

  const alerts = [];
  if (totals.missing >= 3 && totals.missing * 10 >= trackable) {
    alerts.push({
      key: "push_trigger_silent",
      message: `${totals.missing} notifiche su ${trackable} delle ultime 24 ore sono rimaste senza esito: ` +
        "pushOnNotificationCreate non le ha processate.",
    });
  }

  const reachableAttempts = totals.delivered + totals.failed;
  const codes = Object.keys(unexpectedErrors).sort((a, b) => unexpectedErrors[b] - unexpectedErrors[a]);
  if (reachableAttempts >= 5 && totals.delivered === 0) {
    alerts.push({
      key: "delivery_broken",
      message: `Nessuna push consegnata su ${reachableAttempts} tentativi verso chi ha un token` +
        `${codes.length ? ` (${codes.join(", ")})` : ""}.`,
    });
  }
  const errorTotal = Object.values(unexpectedErrors).reduce((sum, count) => sum + count, 0);
  if (errorTotal >= 3) {
    alerts.push({
      key: "fcm_errors",
      message: `${errorTotal} push rifiutate da FCM per un motivo che non e' un token morto: ${codes.join(", ")}.`,
    });
  }

  const currentTokens = finiteNumber(tokenCount);
  const previousTokens = finiteNumber(previous && previous.tokenCount);
  if (currentTokens !== null && previousTokens !== null && previousTokens >= 5 &&
      previousTokens - currentTokens >= 3 && currentTokens <= previousTokens * 0.8) {
    alerts.push({
      key: "token_drop",
      message: `I token push sono scesi da ${previousTokens} a ${currentTokens} dall'ultimo controllo.`,
    });
  }

  const recentRows = rows.filter((row) => row.createdAtMs >= silenceStartMs);
  const social72h = {};
  for (const check of SOCIAL_CHECKS) {
    const sourceCount = nonNegativeInt(sources && sources[check.key]);
    const produced = recentRows.filter((row) => check.types.includes(row.type)).length;
    social72h[check.key] = { sources: sourceCount, notifications: produced };
    if (sourceCount >= check.minSources && produced === 0) {
      alerts.push({
        key: `social_silent_${check.key}`,
        message: `Ultime 72 ore: ${sourceCount} ${check.label} e nessuna notifica creata.`,
      });
    }
  }

  const releases72h = recentRows.filter((row) => RELEASE_TYPES.has(row.type)).length;
  if (releases72h === 0) {
    alerts.push({
      key: "release_silent",
      message: "Ultime 72 ore: nessuna notifica di uscite (aggiornamenti titolo, post ufficiali, digest).",
    });
  }

  return {
    summary: {
      atMs: nowMs,
      totals,
      byCategory,
      reachableAttempts,
      deliveredPercent: percent(totals.delivered, reachableAttempts),
      unexpectedErrors,
      tokenCount: currentTokens,
      previousTokenCount: previousTokens,
      social72h,
      releases72h,
    },
    alerts,
  };
}

/**
 * Decide chi avvisare: un problema nuovo subito, uno che dura di nuovo dopo
 * tre giorni, e una volta sola quando rientra. Senza, un guasto di una
 * settimana manderebbe sette notifiche identiche.
 *
 * @param {Array<{key: string, message: string}>} alerts allarmi di oggi
 * @param {Object<string, {firstSeenMs: number, lastNotifiedMs: number}>} openAlerts
 */
function planHealthAlerts({ alerts = [], openAlerts = {}, nowMs = Date.now() } = {}) {
  const previous = openAlerts && typeof openAlerts === "object" ? openAlerts : {};
  const nextOpen = {};
  const notify = [];
  for (const alert of alerts) {
    const known = previous[alert.key];
    if (!known) {
      notify.push(alert);
      nextOpen[alert.key] = { firstSeenMs: nowMs, lastNotifiedMs: nowMs };
      continue;
    }
    const lastNotifiedMs = finiteNumber(known.lastNotifiedMs);
    const due = lastNotifiedMs === null || nowMs - lastNotifiedMs >= REMIND_AFTER_MS;
    if (due) notify.push(alert);
    nextOpen[alert.key] = {
      firstSeenMs: finiteNumber(known.firstSeenMs) ?? nowMs,
      lastNotifiedMs: due ? nowMs : lastNotifiedMs,
    };
  }
  const recovered = Object.keys(previous).filter((key) => !nextOpen[key]);
  return { notify, recovered, openAlerts: nextOpen };
}

function formatHealthAlertMessage({ notify = [], recovered = [] } = {}) {
  const parts = notify.map((alert) => alert.message);
  if (recovered.length) {
    parts.push(`Di nuovo regolare: ${recovered.map((key) => ALERT_LABELS[key] || key).join(", ")}.`);
  }
  return parts.join(" ");
}

module.exports = {
  PUSH_GRACE_MS,
  SILENCE_WINDOW_MS,
  evaluateNotificationHealth,
  formatHealthAlertMessage,
  notificationCategory,
  planHealthAlerts,
};
