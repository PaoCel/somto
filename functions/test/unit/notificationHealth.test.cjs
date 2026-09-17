const test = require("node:test");
const assert = require("node:assert/strict");
const {
  evaluateNotificationHealth,
  formatHealthAlertMessage,
  notificationCategory,
  planHealthAlerts,
} = require("../../lib/notificationHealth");

const NOW_MS = Date.parse("2026-09-10T09:30:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function row(type, hoursAgo, pushStatus = "delivered", errorCodes = []) {
  return { type, createdAtMs: NOW_MS - (hoursAgo * HOUR), pushStatus, errorCodes };
}

function healthyDay() {
  return [
    row("title_update", 2),
    row("official_update", 3, "no_token"),
    row("follow", 5),
    row("thread_message", 6, "no_token"),
    row("engagement_nudge", 7, "no_token"),
    row("title_update", 1, "cooldown"),
  ];
}

function keys(result) {
  return result.alerts.map((alert) => alert.key).sort();
}

test("una giornata normale non alza nessuna mano", () => {
  const result = evaluateNotificationHealth({
    notifications: healthyDay(),
    sources: { follow: 1, message: 4, comment: 0, like: 1 },
    tokenCount: 46,
    previous: { tokenCount: 47 },
    trackingSinceMs: NOW_MS - (2 * DAY),
    nowMs: NOW_MS,
  });
  assert.deepEqual(result.alerts, []);
  assert.equal(result.summary.totals.created, 6);
  assert.equal(result.summary.byCategory.release.cooldown, 1);
  // Una push trattenuta dal cooldown non e' mai arrivata a FCM: non conta fra i tentativi.
  assert.equal(result.summary.reachableAttempts, 2);
  assert.equal(result.summary.deliveredPercent, 100);
});

test("notifiche senza esito dopo il margine: la push non e' partita", () => {
  const notifications = [
    ...healthyDay(),
    row("follow", 2, null),
    row("title_update", 3, null),
    row("official_update", 4, null),
    // Troppo fresca: la push puo' essere ancora in corso.
    { type: "follow", createdAtMs: NOW_MS - (5 * 60 * 1000), pushStatus: null },
  ];
  const result = evaluateNotificationHealth({
    notifications,
    tokenCount: 47,
    trackingSinceMs: NOW_MS - (2 * DAY),
    nowMs: NOW_MS,
  });
  assert.deepEqual(keys(result), ["push_trigger_silent"]);
  assert.equal(result.summary.totals.missing, 3);
});

test("prima del tracciamento l'esito mancante non e' un guasto", () => {
  const result = evaluateNotificationHealth({
    notifications: [row("title_update", 3, null), row("follow", 4, null), row("follow", 5, null)],
    trackingSinceMs: NOW_MS - HOUR,
    nowMs: NOW_MS,
  });
  assert.deepEqual(keys(result), []);
});

test("nessuna consegna verso chi ha un token: FCM o APNs rifiutano tutto", () => {
  const failing = Array.from({ length: 6 }, (_, i) => row("title_update", i + 1, "failed", ["messaging/third-party-auth-error"]));
  const result = evaluateNotificationHealth({ notifications: failing, nowMs: NOW_MS });
  assert.deepEqual(keys(result), ["delivery_broken", "fcm_errors"]);
  assert.match(result.alerts[0].message, /third-party-auth-error/);
});

test("un token morto ogni tanto non e' un guasto", () => {
  const result = evaluateNotificationHealth({
    notifications: [...healthyDay(), row("follow", 3, "failed"), row("title_update", 4, "failed")],
    nowMs: NOW_MS,
  });
  assert.deepEqual(keys(result), []);
});

test("il calo dei token scatta solo se e' vero", () => {
  const base = { notifications: healthyDay(), nowMs: NOW_MS };
  assert.deepEqual(keys(evaluateNotificationHealth({ ...base, tokenCount: 30, previous: { tokenCount: 47 } })), ["token_drop"]);
  assert.deepEqual(keys(evaluateNotificationHealth({ ...base, tokenCount: 45, previous: { tokenCount: 47 } })), []);
  assert.deepEqual(keys(evaluateNotificationHealth({ ...base, tokenCount: 1, previous: { tokenCount: 4 } })), []);
  assert.deepEqual(keys(evaluateNotificationHealth({ ...base, tokenCount: 0, previous: null })), []);
});

test("interazioni fra utenti senza notifica: il trigger sociale e' fermo", () => {
  const result = evaluateNotificationHealth({
    notifications: [row("title_update", 2)],
    sources: { follow: 4, message: 5, like: 3 },
    nowMs: NOW_MS,
  });
  // 5 messaggi senza notifica sono sotto soglia: molti thread non hanno altri partecipanti.
  assert.deepEqual(keys(result), ["social_silent_follow", "social_silent_like"]);
  assert.match(result.alerts[0].message, /4 nuovi follower/);
});

test("le interazioni di due giorni fa contano ancora", () => {
  const result = evaluateNotificationHealth({
    notifications: [row("title_update", 2), row("follow", 50)],
    sources: { follow: 4 },
    nowMs: NOW_MS,
  });
  assert.deepEqual(keys(result), []);
});

test("72 ore senza notifiche di uscite", () => {
  const silent = evaluateNotificationHealth({ notifications: [row("follow", 2), row("title_update", 80)], nowMs: NOW_MS });
  assert.deepEqual(keys(silent), ["release_silent"]);
  const ok = evaluateNotificationHealth({ notifications: [row("follow", 2), row("weekly_digest", 60)], nowMs: NOW_MS });
  assert.deepEqual(keys(ok), []);
});

test("categorie dei tipi", () => {
  assert.equal(notificationCategory("rating_comment"), "social");
  assert.equal(notificationCategory("weekly_digest"), "release");
  assert.equal(notificationCategory("engagement_nudge"), "engagement");
  assert.equal(notificationCategory("titles_import_failed"), "import");
  assert.equal(notificationCategory("notification_health_alert"), "admin");
  assert.equal(notificationCategory("qualcosa_di_nuovo"), "other");
});

test("un guasto si segnala subito, si ricorda dopo tre giorni e si chiude una volta", () => {
  const alert = { key: "social_silent_follow", message: "Ultime 72 ore: 4 nuovi follower e nessuna notifica creata." };

  const day1 = planHealthAlerts({ alerts: [alert], openAlerts: {}, nowMs: NOW_MS });
  assert.equal(day1.notify.length, 1);

  const day2 = planHealthAlerts({ alerts: [alert], openAlerts: day1.openAlerts, nowMs: NOW_MS + DAY });
  assert.equal(day2.notify.length, 0, "il giorno dopo non si ripete");

  const day4 = planHealthAlerts({ alerts: [alert], openAlerts: day2.openAlerts, nowMs: NOW_MS + (3 * DAY) });
  assert.equal(day4.notify.length, 1, "dopo tre giorni si ricorda");
  assert.equal(day4.openAlerts.social_silent_follow.firstSeenMs, NOW_MS);

  const day5 = planHealthAlerts({ alerts: [], openAlerts: day4.openAlerts, nowMs: NOW_MS + (4 * DAY) });
  assert.deepEqual(day5.recovered, ["social_silent_follow"]);
  assert.deepEqual(day5.openAlerts, {});
  assert.equal(formatHealthAlertMessage(day5), "Di nuovo regolare: notifiche di follow.");
});
