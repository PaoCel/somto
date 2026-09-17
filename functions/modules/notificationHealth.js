"use strict";

const {
  SILENCE_WINDOW_MS,
  evaluateNotificationHealth,
  formatHealthAlertMessage,
  planHealthAlerts,
} = require("../lib/notificationHealth");

const STATE_DOC = "notificationHealth";
const NOTIFICATION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const HISTORY_LENGTH = 30;

// Interazioni fra utenti: gruppo di collection -> path che hanno un trigger di
// notifica. Il gruppo `comments` contiene anche la coda di revisione degli
// import (importCommentReview), che non notifica nessuno e resta fuori.
const SOURCE_GROUPS = [
  { key: "follow", group: "followers", paths: [/^users\/[^/]+\/followers\/[^/]+$/] },
  { key: "message", group: "messages", paths: [/^threads\/[^/]+\/messages\/[^/]+$/] },
  {
    key: "comment",
    group: "comments",
    paths: [/^posts\/[^/]+\/comments\/[^/]+$/, /^ratingFeed\/[^/]+\/comments\/[^/]+$/],
  },
  {
    key: "like",
    group: "likes",
    paths: [/^(posts|ratingFeed)\/[^/]+\/likes\/[^/]+$/, /^(posts|ratingFeed)\/[^/]+\/comments\/[^/]+\/likes\/[^/]+$/],
  },
];

function toMillis(value) {
  if (!value) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value.toMillis === "function") return value.toMillis();
  return null;
}

/**
 * Tutto quello che serve alla guardia, in letture: notifiche e interazioni
 * delle ultime 72 ore, piu' il conteggio dei token. Le query su
 * followers/messages/comments/likes usano gli indici collection-group su
 * `createdAt` dichiarati in firestore.indexes.json.
 */
async function readNotificationHealthInputs({ admin, db, nowMs = Date.now() }) {
  const since = admin.firestore.Timestamp.fromMillis(nowMs - SILENCE_WINDOW_MS);
  const [notificationSnap, tokenCountSnap, ...sourceSnaps] = await Promise.all([
    db.collectionGroup("notifications")
      .where("createdAt", ">=", since)
      .select("type", "createdAt", "pushDelivery")
      .get(),
    db.collectionGroup("notificationTokens").count().get(),
    ...SOURCE_GROUPS.map((source) => db.collectionGroup(source.group)
      .where("createdAt", ">=", since)
      .select()
      .get()),
  ]);

  const notifications = notificationSnap.docs.map((doc) => {
    const data = doc.data() || {};
    const delivery = data.pushDelivery && typeof data.pushDelivery === "object" ? data.pushDelivery : null;
    return {
      type: String(data.type || ""),
      createdAtMs: toMillis(data.createdAt),
      pushStatus: delivery ? (String(delivery.status || "") || null) : null,
      errorCodes: Array.isArray(delivery?.errorCodes) ? delivery.errorCodes : [],
    };
  });

  const sources = {};
  SOURCE_GROUPS.forEach((source, index) => {
    sources[source.key] = sourceSnaps[index].docs
      .filter((doc) => source.paths.some((pattern) => pattern.test(doc.ref.path)))
      .length;
  });

  return { notifications, sources, tokenCount: Number(tokenCountSnap.data().count) };
}

function registerNotificationHealth({ admin, logger, getAdminUids }) {
  const { onSchedule } = require("firebase-functions/v2/scheduler");

  const checkNotificationHealth = onSchedule(
    {
      // Dopo il giro del mattino (episodi del giorno alle 9, post ufficiali):
      // e' li' che si concentra il grosso delle notifiche.
      schedule: "30 11 * * *",
      timeZone: "Europe/Rome",
      region: "europe-west1",
      timeoutSeconds: 300,
      memory: "512MiB",
      maxInstances: 1,
    },
    async () => {
      const db = admin.firestore();
      const nowMs = Date.now();
      const stateRef = db.collection("systemJobs").doc(STATE_DOC);
      const stateSnap = await stateRef.get().catch(() => null);
      const state = stateSnap?.data() || {};
      // Al primo giro parte il conto: le notifiche nate prima che
      // pushOnNotificationCreate scrivesse l'esito non devono sembrare saltate.
      const trackingSinceMs = Number.isFinite(state.trackingSinceMs) ? state.trackingSinceMs : nowMs;

      const inputs = await readNotificationHealthInputs({ admin, db, nowMs });
      const { summary, alerts } = evaluateNotificationHealth({
        ...inputs,
        previous: state.last || null,
        trackingSinceMs,
        nowMs,
      });
      const plan = planHealthAlerts({ alerts, openAlerts: state.openAlerts || {}, nowMs });

      // Livello error: resta visibile nei log anche quando la cosa rotta e'
      // proprio la push che dovrebbe avvisare gli admin.
      if (alerts.length) logger.error("[notificationHealth] problemi", { alerts, summary });
      else logger.info("[notificationHealth] regolare", summary);

      const history = Array.isArray(state.history) ? state.history : [];
      // set senza merge: con merge un allarme chiuso resterebbe dentro
      // openAlerts per sempre (le mappe si fondono, non si sostituiscono).
      await stateRef.set({
        last: summary,
        history: [...history, summary].slice(-HISTORY_LENGTH),
        openAlerts: plan.openAlerts,
        trackingSinceMs,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      if (!plan.notify.length && !plan.recovered.length) return null;
      const adminUids = typeof getAdminUids === "function" ? (getAdminUids() || []) : [];
      if (!adminUids.length) return null;

      const message = formatHealthAlertMessage(plan);
      const batch = db.batch();
      for (const adminUid of adminUids) {
        const ref = db.collection("users").doc(adminUid).collection("notifications").doc();
        batch.set(ref, {
          toUid: adminUid,
          fromUid: "system",
          type: "notification_health_alert",
          data: {
            message,
            state: plan.notify.length ? "alert" : "recovered",
            alerts: plan.notify.map((alert) => alert.key),
            recovered: plan.recovered,
            ctaUrl: "/admin-analytics.html",
          },
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + NOTIFICATION_TTL_MS),
        });
      }
      await batch.commit();
      return null;
    }
  );

  return { checkNotificationHealth };
}

module.exports = {
  STATE_DOC,
  readNotificationHealthInputs,
  registerNotificationHealth,
};
