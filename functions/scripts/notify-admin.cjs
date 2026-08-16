#!/usr/bin/env node
// Send a one-shot push notification to a configured Somto admin.
// Resolves email → uid via Firebase Auth, then writes a Firestore notification doc
// at users/{uid}/notifications/. The existing onCreate trigger picks it up and
// dispatches the FCM/APNs push to all the user's registered tokens.
//
// Usage:
//   ADMIN_NOTIFICATION_EMAIL=admin@example.com \
//     node functions/scripts/notify-admin.cjs "Title text" "Body text" [admin@email]
//
// Defaults: title = "Somto build", body = "Aggiornamento pronto".
// Uses Application Default Credentials (gcloud auth application-default login).

const admin = require("firebase-admin");

const projectId = process.env.GCLOUD_PROJECT || "gia-visto";

if (!admin.apps || admin.apps.length === 0) {
  try {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId,
    });
  } catch (err) {
    if (err.code !== "app/duplicate-app") throw err;
  }
}

const db = admin.firestore();

async function main() {
  const [, , titleArg, bodyArg, emailArg] = process.argv;
  const title = titleArg || "Somto build";
  const body = bodyArg || "Aggiornamento pronto.";
  const email = emailArg || String(process.env.ADMIN_NOTIFICATION_EMAIL || "").trim();
  if (!email) throw new Error("ADMIN_NOTIFICATION_EMAIL mancante");

  console.log(`[notify-admin] target email=${email} project=${projectId}`);

  const user = await admin.auth().getUserByEmail(email);
  if (!user || !user.uid) {
    throw new Error(`No Firebase Auth user for ${email}`);
  }
  console.log(`[notify-admin] resolved uid=${user.uid}`);

  if (process.env.DRY_RUN === "1") {
    console.log("[notify-admin] DRY_RUN — skipping Firestore write & FCM send");
    return;
  }

  // Use a non-self fromUid so any future helper guards do not skip it.
  // We pick the same uid here; if you have a system uid you can override via env.
  const fromUid = process.env.NOTIFY_FROM_UID || `system_${Date.now().toString(36)}`;

  const NOTIF_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days, matches functions module
  const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + NOTIF_TTL_MS);

  const docRef = await db
    .collection("users")
    .doc(user.uid)
    .collection("notifications")
    .add({
      toUid: user.uid,
      fromUid,
      type: "engagement_nudge",
      data: {
        message: body,
        title,
        ctaUrl: "/account.html?tab=activity",
      },
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt,
    });

  console.log(`[notify-admin] created notification doc id=${docRef.id}`);

  // Also write the same doc directly with FCM fan-out, so we don't depend
  // on the cooldown logic of the Cloud Function trigger (engagement_nudge has
  // a 6h cooldown which would suppress repeat notifications during testing).
  if (process.env.NOTIFY_DIRECT_FCM === "1") {
    const tokensSnap = await db
      .collection("users")
      .doc(user.uid)
      .collection("notificationTokens")
      .get();
    const tokens = tokensSnap.docs.map((d) => d.data().token).filter(Boolean);
    console.log(`[notify-admin] direct FCM tokens=${tokens.length}`);
    if (tokens.length) {
      const messages = tokens.map((token) => ({
        token,
        notification: { title, body },
        apns: {
          headers: { "apns-priority": "10" },
          payload: {
            aps: {
              alert: { title, body },
              sound: "default",
            },
          },
        },
        webpush: {
          fcmOptions: { link: "https://somto.it/account.html?tab=activity" },
          headers: { Urgency: "high" },
          notification: {
            icon: "/icons/icon-192.png",
            badge: "/icons/favicon-32.png",
            vibrate: [100, 50, 50],
          },
        },
        data: {
          type: "engagement_nudge",
          source: "notify-admin-script",
        },
      }));
      const resp = await admin.messaging().sendEach(messages);
      console.log(`[notify-admin] direct FCM sent successCount=${resp.successCount} failureCount=${resp.failureCount}`);
      resp.responses.forEach((r, i) => {
        if (!r.success) {
          console.log(`  token[${i}] err=${r.error?.code} msg=${r.error?.message}`);
        }
      });
    }
  }

  console.log("[notify-admin] done");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[notify-admin] FATAL", err);
    process.exit(1);
  });
