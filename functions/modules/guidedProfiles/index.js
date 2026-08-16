/**
 * Guided Profiles — registrazione Cloud Functions.
 *
 * Pattern factory come notifications.js:
 *   const exportsObj = registerGuidedProfiles({ functions, admin, logger, getAdminUids });
 *   Object.assign(exports, exportsObj);
 *
 * Espone:
 *  - runGuidedProfileActivity      (scheduled 2x/giorno)
 *  - runGuidedProfileActivityNow   (callable admin: dry-run / run manuale)
 *  - setGuidedProfilesConfig       (callable admin: config + kill switch)
 *  - guidedProfileDmAutoResponder  (trigger DM auto-reply)
 */

const { getGuidedConfig, setGuidedConfig } = require("./config");
const { runGuidedActivity } = require("./activity");
const { handleThreadMessageForGuidedDm } = require("./dmResponder");

const REGION = "europe-west1";

function isEmulator() {
  return String(process.env.FUNCTIONS_EMULATOR || "").toLowerCase() === "true";
}

function registerGuidedProfiles({ functions, admin, logger, getAdminUids }) {
  const resolveAdminUids = typeof getAdminUids === "function" ? getAdminUids : () => [];

  async function assertAdmin(db, uid) {
    if (!uid) throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
    if (resolveAdminUids().includes(uid)) return true;
    const snap = await db.collection("users").doc(uid).get().catch(() => null);
    if (snap && snap.exists && snap.data()?.isAdmin === true) return true;
    throw new functions.https.HttpsError("permission-denied", "Solo admin.");
  }

  // --- Scheduler: 11:00 e 19:00 Europe/Rome ---------------------------------
  const runGuidedProfileActivity = functions
    .region(REGION)
    .runWith({ timeoutSeconds: 540, memory: "512MB" })
    .pubsub.schedule("0 11,19 * * *")
    .timeZone("Europe/Rome")
    .onRun(async () => {
      const db = admin.firestore();
      const config = await getGuidedConfig(db);
      const nowMs = Date.now();
      const report = await runGuidedActivity({ db, admin, logger }, {
        config,
        isEmulator: isEmulator(),
        adminUids: resolveAdminUids(),
        runId: `sched_${nowMs}`,
        nowMs,
      });
      logger.info("[guided] scheduled run", {
        runId: report.runId,
        skipped: report.skipped === true,
        gate: report.gate,
        actions: report.actions.length,
        feedEvents: report.feedEventsWritten,
        drafts: report.drafts,
        errors: report.errors.length,
      });
      return null;
    });

  // --- Callable admin: run manuale / dry-run --------------------------------
  const runGuidedProfileActivityNow = functions
    .region(REGION)
    .runWith({ timeoutSeconds: 540, memory: "512MB" })
    .https.onCall(async (data, context) => {
      const db = admin.firestore();
      const uid = context.auth?.uid || "";
      await assertAdmin(db, uid);

      const config = await getGuidedConfig(db);
      const dryRunOverride = data?.dryRun === true;
      const nowMs = Date.now();
      const report = await runGuidedActivity({ db, admin, logger }, {
        config,
        dryRunOverride,
        isEmulator: isEmulator(),
        adminUids: resolveAdminUids(),
        runId: `manual_${nowMs}`,
        nowMs,
      });
      logger.info("[guided] manual run", { uid, dryRun: report.dryRun, actions: report.actions.length });
      return { ok: true, report };
    });

  // --- Callable admin: aggiorna config (incl. kill switch) ------------------
  const setGuidedProfilesConfig = functions
    .region(REGION)
    .https.onCall(async (data, context) => {
      const db = admin.firestore();
      const uid = context.auth?.uid || "";
      await assertAdmin(db, uid);

      const patch = (data && typeof data === "object") ? data : {};
      const next = await setGuidedConfig(db, patch, admin.firestore.FieldValue.serverTimestamp());
      logger.info("[guided] config updated", { uid, next });
      return { ok: true, config: next };
    });

  // --- Trigger: DM auto-reply -----------------------------------------------
  const guidedProfileDmAutoResponder = functions
    .region(REGION)
    .firestore
    .document("threads/{threadId}/messages/{messageId}")
    .onCreate(async (snap, context) => {
      const db = admin.firestore();
      try {
        return await handleThreadMessageForGuidedDm({ db, admin, logger }, snap, context);
      } catch (err) {
        logger.warn("[guidedDm] handler error", { error: err?.message || String(err) });
        return null;
      }
    });

  return {
    runGuidedProfileActivity,
    runGuidedProfileActivityNow,
    setGuidedProfilesConfig,
    guidedProfileDmAutoResponder,
  };
}

module.exports = { registerGuidedProfiles };
