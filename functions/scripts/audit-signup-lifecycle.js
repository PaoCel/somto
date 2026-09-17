#!/usr/bin/env node
"use strict";

/**
 * Audit e cleanup mirato di un singolo lifecycle signup.
 *
 * Dry-run e UID esplicito sono obbligatori per default:
 *   node scripts/audit-signup-lifecycle.js --project gia-visto --uid <uid>
 *
 * L'esecuzione richiede due conferme separate e non accetta wildcard:
 *   node scripts/audit-signup-lifecycle.js --project gia-visto --uid <uid> \
 *     --execute --confirm-project gia-visto
 */

const admin = require("firebase-admin");
const {
  acquireDeletionLease,
  cleanupAccountData,
  markDeletionCompleted,
  markDeletionFailed,
} = require("../lib/accountDeletion");
const {
  classifySignupLifecycle,
  isReservedEmailDomain,
  providerIdsForAuthUser,
} = require("../lib/signupSecurity");

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

const projectId = argumentValue("--project");
const uid = argumentValue("--uid");
const confirmProject = argumentValue("--confirm-project");
const execute = process.argv.includes("--execute");
const deleteAuthUser = process.argv.includes("--delete-auth");
const adminUids = process.argv
  .flatMap((value, index, rows) => value === "--admin-uid" ? [String(rows[index + 1] || "").trim()] : [])
  .filter(Boolean);

if (!projectId || !uid) {
  console.error("Uso: --project <project-id> --uid <uid> [--execute --confirm-project <project-id>] [--delete-auth]");
  process.exit(2);
}
if (/[*?[\]]/.test(uid)) {
  console.error("UID non valido: wildcard e pattern non sono ammessi.");
  process.exit(2);
}
if (execute && confirmProject !== projectId) {
  console.error("Esecuzione bloccata: --confirm-project deve coincidere esattamente con --project.");
  process.exit(2);
}

admin.initializeApp({ projectId, storageBucket: `${projectId}.firebasestorage.app` });
const db = admin.firestore();

async function resolvedAdminUids() {
  const snap = await db.collection("users").where("isAdmin", "==", true).get();
  return [...new Set([...adminUids, ...snap.docs.map((doc) => doc.id)])];
}

// Ogni conteggio puo' fallire (indice mancante, permesso, rete). In quel caso
// il report deve dire "unknown", non "0": zero significa "ho guardato e non
// c'era niente", ed e' la differenza fra un account pulito e un audit cieco.
async function count(query) {
  const snap = await query.count().get();
  return Number(snap.data().count || 0);
}

const auditErrors = [];

// Il solo codice gRPC ("9") non dice niente a chi legge il report fra sei mesi.
function describeReadError(err) {
  const message = String(err?.message || err || "").replace(/\s+/g, " ").trim();
  if (/requires an index/i.test(message)) return "indice Firestore mancante per questa query";
  if (err?.code === 7 || /permission/i.test(message)) return "permesso negato con queste credenziali";
  return message.slice(0, 160) || `codice ${String(err?.code ?? "?")}`;
}

async function safeCount(label, queryFactory) {
  try {
    return await count(queryFactory());
  } catch (err) {
    auditErrors.push({ label, error: describeReadError(err) });
    return "unknown";
  }
}

async function safeIdPrefixCount(label, collection, prefix) {
  return safeCount(label, () => db.collection(collection)
    .where(admin.firestore.FieldPath.documentId(), ">=", prefix)
    .where(admin.firestore.FieldPath.documentId(), "<", `${prefix}\uf8ff`));
}

async function storageInventory() {
  const prefixes = ["avatars", "reviewPhotos", "posters", "manualImports", "supportImports", "users", "dataExports"];
  const byPrefix = {};
  let total = 0;
  try {
    for (const prefix of prefixes) {
      const [files] = await admin.storage().bucket().getFiles({ prefix: `${prefix}/${uid}/` });
      if (files.length) byPrefix[prefix] = files.length;
      total += files.length;
    }
    // checked:true + filesFound:0 vuol dire "controllato, non c'e' niente".
    // checked:false vuol dire "non lo so", e non va letto come "pulito".
    return { checked: true, filesFound: total, byPrefix };
  } catch (err) {
    auditErrors.push({ label: "storage", error: describeReadError(err) });
    return { checked: false, filesFound: "unknown", byPrefix: {} };
  }
}

async function readAuthUser() {
  try {
    return await admin.auth().getUser(uid);
  } catch (err) {
    if (err?.code === "auth/user-not-found") return null;
    throw err;
  }
}

// L'inventario e' diviso per significato, non per collection: un profilo e una
// chat di benvenuto li ha creati il backend, un voto lo ha lasciato la persona,
// un follower lo ha deciso qualcun altro. Confonderli fa sembrare "attivo" un
// account che non ha mai fatto niente — l'errore che ha reso confuso il caso
// gcpmap_*.
// Le notifiche automatiche di signup stanno sotto gli admin, non sotto
// l'utente: si leggono per uid admin noto, senza collection group (che
// richiederebbe un indice dedicato solo per l'audit).
async function countAdminSignupNotifications() {
  try {
    const admins = await resolvedAdminUids();
    let total = 0;
    for (const adminUid of admins) {
      const snap = await db.collection("users").doc(adminUid).collection("notifications")
        .where("data.uid", "==", uid).count().get();
      total += Number(snap.data().count || 0);
    }
    return total;
  } catch (err) {
    auditErrors.push({ label: "adminSignupNotifications", error: describeReadError(err) });
    return "unknown";
  }
}

async function buildInventory() {
  const userRef = db.collection("users").doc(uid);

  const automaticArtifacts = {
    publicProfile: undefined,
    privateProfile: undefined,
    supportThread: undefined,
    signupNotificationsOnAdmins: await countAdminSignupNotifications(),
  };

  const userActions = {
    titleStates: await safeCount("titleStates", () => userRef.collection("titleStates")),
    ratings: await safeCount("ratings", () => db.collection("ratings").where("uid", "==", uid)),
    posts: await safeCount("posts", () => db.collection("posts").where("authorUid", "==", uid)),
    comments: await safeCount("comments", () => db.collectionGroup("comments").where("uid", "==", uid)),
    messagesSent: await safeCount("messages", () => db.collectionGroup("messages").where("uid", "==", uid)),
    likes: await safeCount("likes", () => db.collectionGroup("likes").where("uid", "==", uid)),
    shares: await safeCount("shares", () => db.collectionGroup("shares").where("uid", "==", uid)),
    following: await safeCount("following", () => userRef.collection("following")),
    titleEmotions: await safeCount("titleEmotions", () => db.collection("titleEmotions").where("uid", "==", uid)),
    episodeEmotions: await safeCount("episodeEmotions", () => db.collection("episodeEmotions").where("uid", "==", uid)),
    characterVotes: await safeCount("characterVotes", () => db.collection("characterVotes").where("uid", "==", uid)),
    listsOwned: await safeCount("listsOwned", () => db.collection("userLists").where("ownerUid", "==", uid)),
    listMemberships: await safeCount("listMemberships", () => db.collection("userLists").where("memberUids", "array-contains", uid)),
    quizAttempts: await safeCount("quizAttempts", () => userRef.collection("quizAttempts")),
    quizInvitesCreated: await safeCount("quizInvites", () => db.collection("quizInvites").where("createdByUid", "==", uid)),
    quizChallengesSent: await safeCount("quizChallenges", () => db.collection("quizChallenges").where("fromUid", "==", uid)),
    imports: await safeCount("imports", () => userRef.collection("imports")),
    reportsFiled: await safeCount("reports", () => db.collection("reports").where("fromUid", "==", uid)),
    metadataIssues: await safeIdPrefixCount("metadataIssues", "metadataIssues", `${uid}__`),
    titlesCreated: await safeCount("titlesCreated", () => db.collection("titles").where("createdBy", "==", uid)),
  };

  const receivedFromOthers = {
    followers: await safeCount("followers", () => userRef.collection("followers")),
    recommendationsReceived: await safeCount("recommendationsReceived", () =>
      db.collection("recommendations").where("toUid", "==", uid)),
    quizChallengesReceived: await safeCount("quizChallengesReceived", () =>
      db.collection("quizChallenges").where("toUid", "==", uid)),
    feedEventsDelivered: await safeCount("feedEventsDelivered", () =>
      db.collection("feedEvents").where("ownerUid", "==", uid)),
    notifications: await safeCount("notifications", () => userRef.collection("notifications")),
  };

  return { automaticArtifacts, userActions, receivedFromOthers, storage: await storageInventory() };
}

async function audit() {
  const [authUser, profileSnap, privateSnap, pendingSnap, deletionSnap, supportSnap, inventory] = await Promise.all([
    readAuthUser(),
    db.collection("users").doc(uid).get(),
    db.collection("usersPrivate").doc(uid).get(),
    db.collection("pendingSignups").doc(uid).get(),
    db.collection("accountDeletionRequests").doc(uid).get(),
    db.collection("threads").doc(`support_${uid}`).get(),
    buildInventory(),
  ]);
  inventory.automaticArtifacts.publicProfile = profileSnap.exists;
  inventory.automaticArtifacts.privateProfile = privateSnap.exists;
  inventory.automaticArtifacts.supportThread = supportSnap.exists;
  const profile = profileSnap.data() || {};
  const privateData = privateSnap.data() || {};
  const pending = pendingSnap.data() || {};
  const deletion = deletionSnap.data() || {};
  const providerIds = providerIdsForAuthUser(authUser);
  const lifecycleStatus = classifySignupLifecycle({
    authPresent: Boolean(authUser),
    profilePresent: profileSnap.exists,
    providerIds,
    emailVerified: authUser?.emailVerified === true,
    isSynthetic: profile.accountType === "guided_profile" || profile.isSynthetic === true || uid.startsWith("guided_"),
    pendingStatus: pending.status || null,
    deletionStatus: deletion.status || null,
  });

  return {
    projectId,
    uid,
    mode: execute ? "execute" : "dry-run",
    lifecycleStatus,
    auth: {
      present: Boolean(authUser),
      providerIds,
      emailVerified: authUser?.emailVerified === true,
      reservedEmailDomain: isReservedEmailDomain(authUser?.email || privateData.email || ""),
      createdAt: authUser?.metadata?.creationTime || null,
      lastSignInAt: authUser?.metadata?.lastSignInTime || null,
    },
    firestore: {
      profilePresent: profileSnap.exists,
      privatePresent: privateSnap.exists,
      pendingStatus: pending.status || null,
      deletionStatus: deletion.status || null,
      supportThreadPresent: supportSnap.exists,
    },
    inventory,
    // Un conteggio a 0 vale solo se la lettura e' riuscita: qui sotto ci sono
    // le letture che NON sono disponibili, cosi' il report non si legge come
    // "non e' successo niente" quando in realta' non abbiamo guardato.
    unavailableReads: [
      {
        what: "letture Firestore effettuate dall'account",
        reason: "Data Access audit logs (DATA_READ) non abilitati sul progetto",
        recoverable: false,
        note: "non ricostruibile a posteriori nemmeno abilitandoli ora",
      },
      {
        what: "IP, client e sessioni di login",
        reason: "activity logging Identity Platform non attivo (progetto in subtype FIREBASE_AUTH)",
        recoverable: false,
      },
    ],
    incompleteReads: auditErrors,
    dataComplete: auditErrors.length === 0,
  };
}

async function main() {
  const report = await audit();
  const effectiveAdminUids = await resolvedAdminUids();
  if (!execute) {
    const cleanupPreview = await cleanupAccountData({
      db,
      auth: admin.auth(),
      bucket: admin.storage().bucket(),
      uid,
      source: "ops-cleanup",
      userData: (await db.collection("users").doc(uid).get()).data() || {},
      adminUids: effectiveAdminUids,
      FieldValue: admin.firestore.FieldValue,
      Timestamp: admin.firestore.Timestamp,
      logger: { info() {} },
      dryRun: true,
      deleteAuthUser,
    });
    console.log(JSON.stringify({ ...report, cleanupPreview }, null, 2));
    return;
  }

  const lease = await acquireDeletionLease({
    db,
    uid,
    source: "ops-cleanup",
    Timestamp: admin.firestore.Timestamp,
  });
  if (!lease.acquired) throw new Error(`cleanup non acquisito: ${lease.reason}`);

  try {
    const counts = await cleanupAccountData({
      db,
      auth: admin.auth(),
      bucket: admin.storage().bucket(),
      uid,
      source: "ops-cleanup",
      adminUids: effectiveAdminUids,
      FieldValue: admin.firestore.FieldValue,
      Timestamp: admin.firestore.Timestamp,
      logger: console,
      deleteAuthUser,
    });
    await markDeletionCompleted({
      db,
      uid,
      source: "ops-cleanup",
      operationId: lease.operationId,
      counts,
      FieldValue: admin.firestore.FieldValue,
    });
    console.log(JSON.stringify({ ...report, cleanupResult: counts }, null, 2));
  } catch (err) {
    await markDeletionFailed({
      db,
      uid,
      source: "ops-cleanup",
      operationId: lease.operationId,
      error: err,
      FieldValue: admin.firestore.FieldValue,
    });
    throw err;
  }
}

main().catch((err) => {
  // Il solo codice gRPC non basta a capire cosa manca: si stampa anche il
  // messaggio, che per gli indici contiene il link per crearli.
  console.error("ERRORE:", describeReadError(err));
  const raw = String(err?.message || "").replace(/\s+/g, " ").trim();
  if (raw) console.error("dettaglio:", raw.slice(0, 400));
  process.exitCode = 1;
});
