"use strict";

const {
  formatPushCoverageMessage,
  summarizePushCoverage,
} = require("../lib/pushCoverage");

const SNAPSHOT_DOC = "pushCoverage";
const NOTIFICATION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Legge utenti e token e restituisce il riepilogo di copertura. Due letture
 * complete (users + collectionGroup notificationTokens): a questi volumi
 * costano pochi centesimi alla settimana, e non esiste un modo di contarli
 * senza leggerli.
 */
async function readPushCoverage({ db, nowMs = Date.now() } = {}) {
  const [userSnap, tokenSnap] = await Promise.all([
    db.collection("users").select("lastActiveAt", "isDeleted").get(),
    db.collectionGroup("notificationTokens").select("platform", "updatedAt").get(),
  ]);

  const users = userSnap.docs.map((doc) => ({
    uid: doc.id,
    lastActiveAtMs: doc.data()?.lastActiveAt || null,
    isDeleted: doc.data()?.isDeleted === true,
  }));
  const tokens = tokenSnap.docs.map((doc) => ({
    uid: doc.ref.parent.parent?.id || "",
    platform: doc.data()?.platform || "unknown",
    updatedAtMs: doc.data()?.updatedAt || null,
  }));

  return summarizePushCoverage({ users, tokens, nowMs });
}

function registerPushCoverage({ admin, logger, getAdminUids }) {
  const { onSchedule } = require("firebase-functions/v2/scheduler");

  const reportPushCoverage = onSchedule(
    {
      // Lunedì alle 9, ora di Roma.
      schedule: "0 9 * * 1",
      timeZone: "Europe/Rome",
      region: "europe-west1",
      timeoutSeconds: 300,
      memory: "512MiB",
      maxInstances: 1,
    },
    async () => {
      const db = admin.firestore();
      const nowMs = Date.now();
      const stateRef = db.collection("systemJobs").doc(SNAPSHOT_DOC);

      const [summary, stateSnap] = await Promise.all([
        readPushCoverage({ db, nowMs }),
        stateRef.get().catch(() => null),
      ]);
      const previous = stateSnap?.data()?.last || null;
      const message = formatPushCoverageMessage(summary, previous);
      logger.info("[pushCoverage] report settimanale", summary);

      const history = Array.isArray(stateSnap?.data()?.history) ? stateSnap.data().history : [];
      await stateRef.set({
        last: summary,
        // Serve la tendenza, non l'archivio: dodici settimane bastano.
        history: [...history, summary].slice(-12),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      const adminUids = typeof getAdminUids === "function" ? (getAdminUids() || []) : [];
      if (!adminUids.length) return null;

      const batch = db.batch();
      for (const adminUid of adminUids) {
        const ref = db.collection("users").doc(adminUid).collection("notifications").doc();
        batch.set(ref, {
          toUid: adminUid,
          fromUid: "system",
          type: "push_coverage_report",
          data: {
            message,
            reachable: summary.reachable,
            users: summary.users,
            reachablePercent: summary.reachablePercent,
            activeReachable: summary.activeReachable,
            activeUsers: summary.activeUsers,
            byPlatform: summary.byPlatform,
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

  return { reportPushCoverage };
}

module.exports = {
  SNAPSHOT_DOC,
  readPushCoverage,
  registerPushCoverage,
};
