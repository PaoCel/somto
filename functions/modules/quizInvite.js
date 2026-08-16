// External quiz invites: share-link challenges between a registered Somto
// user and someone who is not (yet) on Somto.
//
// Flow:
//   createQuizExternalInvite  -> creates the challenge + a tokenised invite
//   claimQuizExternalInvite   -> binds a freshly-signed-in user to the invite
//   finalizeQuizExternalChallenge -> builds the question pool once the invitee
//                                    confirms which titles they have seen
//   quizInvitePreview         -> HTTP landing page for the share link
//
// Security notes:
//  * The raw token is only ever returned to the inviter. Firestore stores a
//    SHA-256 hash, and the `quizInvites` collection is fully denied to clients
//    by the security rules — only these functions (admin SDK) touch it.
//  * Tokens are 24 random bytes (base64url) so the link is non-enumerable.

const functions = require("firebase-functions/v1");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const crypto = require("crypto");
const { enforceCallableRateLimit } = require("../lib/rateLimiter");

const REGION = "europe-west1";
const SITE_URL = "https://somto.it";
const APP_STORE_URL = "https://apps.apple.com/it/app/somto/id6760966564";
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const MIN_POOL_QUESTIONS = 5;
const MAX_TITLES = 80;
const PLAYABLE_STATUSES = new Set(["approved", "beta_pending_review"]);

// Duplicato locale di COMMUNITY_SAFETY_VERSION + hasAcceptedCommunitySafety
// (da functions/index.js): tenuti in sync via comment.
// Tenere allineato a functions/index.js se la versione viene bumpata.
const COMMUNITY_SAFETY_VERSION = 1;

function toMillisCommunity(ts) {
  if (!ts) return 0;
  if (typeof ts === "number") return ts;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.seconds === "number") return (ts.seconds * 1000) + Math.floor((ts.nanoseconds || 0) / 1e6);
  return 0;
}

function hasAcceptedCommunitySafety(userDoc) {
  const data = userDoc && typeof userDoc === "object" ? userDoc : {};
  return toMillisCommunity(data.communitySafetyAcceptedAt) > 0
    && Number(data.communitySafetyVersion || 0) >= COMMUNITY_SAFETY_VERSION;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function safeString(value, max = 200) {
  return String(value == null ? "" : value).slice(0, max);
}

function sanitizeName(value) {
  return safeString(value, 80).replace(/\s+/g, " ").trim();
}

function sanitizeIdList(value, max = 200) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    const id = safeString(raw, 128).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

function uniqueStrings(list) {
  return Array.from(new Set(list.filter(Boolean)));
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function isExpired(expiresAt) {
  if (!expiresAt) return false;
  const ms = typeof expiresAt.toMillis === "function"
    ? expiresAt.toMillis()
    : (typeof expiresAt === "number" ? expiresAt : 0);
  return ms > 0 && ms < Date.now();
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Builds the question pool for an external challenge. Heavy-spoiler questions
// are only included for titles BOTH players confirmed having seen.
async function fetchQuestionPool(db, allTitles, sharedTitles) {
  const sharedSet = new Set(sharedTitles);
  const ids = [];
  const seen = new Set();
  for (const chunk of chunkArray(allTitles.slice(0, MAX_TITLES), 10)) {
    if (chunk.length === 0) continue;
    const snap = await db.collection("quizQuestions")
      .where("titleId", "in", chunk)
      .get();
    snap.forEach((doc) => {
      const q = doc.data() || {};
      if (!PLAYABLE_STATUSES.has(String(q.status))) return;
      const spoiler = String(q.spoilerLevel || "none");
      if (spoiler === "heavy" && !sharedSet.has(String(q.titleId))) return;
      if (seen.has(doc.id)) return;
      seen.add(doc.id);
      ids.push(doc.id);
    });
  }
  return ids;
}

function renderInvitePage({ valid, inviterName, numQuestions, token }) {
  const name = escapeHtml(inviterName || "Un amico");
  const count = Number(numQuestions) || 10;
  const heading = valid
    ? `${name} ti ha sfidato su Somto Quiz`
    : "Invito non più disponibile";
  const sub = valid
    ? `Una sfida da ${count} domande su film e serie TV. Scarica Somto, accedi e riapri questo link per giocare.`
    : "Questo invito è scaduto o non è valido. Chiedi al tuo amico di inviartene uno nuovo.";
  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <title>Somto Quiz — Sfida</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${escapeHtml(heading)}">
  <meta property="og:description" content="Sfida su film e serie TV. Gioca su Somto.">
  <meta property="og:image" content="${SITE_URL}/icons/icon-512.png">
  <meta property="og:site_name" content="Somto">
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, system-ui, "Segoe UI", sans-serif;
      background: radial-gradient(120% 80% at 20% 0%, #2A1430 0%, #0A0A0A 55%, #070707 100%);
      color: #F5F5F5; min-height: 100vh;
      display: flex; align-items: center; justify-content: center; padding: 24px;
    }
    .card {
      max-width: 420px; width: 100%; text-align: center;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.09);
      border-radius: 28px; padding: 36px 28px;
      box-shadow: 0 24px 70px rgba(233,30,99,0.22);
    }
    .logo {
      width: 76px; height: 76px; border-radius: 20px; margin: 0 auto 20px;
      box-shadow: 0 10px 30px rgba(233,30,99,0.35);
    }
    .badge {
      display: inline-block; font-size: 12px; font-weight: 800; letter-spacing: 1.5px;
      text-transform: uppercase; padding: 6px 14px; border-radius: 999px; margin-bottom: 18px;
      background: linear-gradient(120deg, #F77737, #E91E63, #9C27B0); color: #fff;
    }
    h1 { font-size: 23px; line-height: 1.3; font-weight: 800; margin-bottom: 12px; }
    p { font-size: 15px; line-height: 1.5; color: #A8A8A8; margin-bottom: 26px; }
    .cta {
      display: block; text-decoration: none; font-weight: 700; font-size: 16px;
      padding: 16px; border-radius: 16px; margin-bottom: 12px;
      background: linear-gradient(120deg, #F77737, #E91E63, #9C27B0); color: #fff;
    }
    .ghost { color: #A8A8A8; font-size: 13px; }
  </style>
</head>
<body>
  <div class="card">
    <img class="logo" src="${SITE_URL}/icons/icon-512.png" alt="Somto">
    <div class="badge">Somto Quiz</div>
    <h1>${escapeHtml(heading)}</h1>
    <p>${escapeHtml(sub)}</p>
    ${valid ? `<a class="cta" href="${APP_STORE_URL}">Scarica Somto</a>` : `<a class="cta" href="${SITE_URL}">Vai su Somto</a>`}
    ${valid ? `<div class="ghost">Hai già l'app? Riapri questo link da iPhone per accettare la sfida.</div>` : ""}
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function registerQuizInvite(exports) {
  // -- createQuizExternalInvite ---------------------------------------------
  exports.createQuizExternalInvite = functions
    .region(REGION)
    .https.onCall(async (data, context) => {
      const uid = context.auth?.uid;
      if (!uid) {
        throw new functions.https.HttpsError(
          "unauthenticated", "Devi accedere per creare un invito."
        );
      }
      const db = admin.firestore();
      await enforceCallableRateLimit(db, uid, "createQuizExternalInvite", {
        windowSeconds: 20, maxInWindow: 5, dailyMax: 60,
      });

      const numQuestions = Number(data?.numQuestions) === 5 ? 5 : 10;
      const placeholderName = sanitizeName(data?.placeholderName);
      const inviterSeenTitleIds = sanitizeIdList(data?.inviterSeenTitleIds, 200);

      const userSnap = await db.collection("users").doc(uid).get();
      const inviterName = sanitizeName(
        userSnap.exists ? (userSnap.data() || {}).displayName : ""
      ) || "Un amico";

      const token = crypto.randomBytes(24).toString("base64url");
      const tokenHash = sha256(token);
      const now = admin.firestore.FieldValue.serverTimestamp();
      const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + INVITE_TTL_MS);

      const challengeRef = db.collection("quizChallenges").doc();
      const inviteRef = db.collection("quizInvites").doc();

      const batch = db.batch();
      batch.set(challengeRef, {
        fromUid: uid,
        toUid: null,
        inviteType: "external",
        questionIds: [],
        numQuestions,
        status: "pending_external_signup",
        fromScore: null,
        toScore: null,
        fromAnswers: [],
        toAnswers: [],
        sharedTitleIds: [],
        inviterSeenTitleIds,
        opponentConfirmedSeenTitleIds: [],
        opponentDisplayName: null,
        opponentPlaceholderName: placeholderName || null,
        createdAt: now,
        completedAt: null,
        expiresAt,
      });
      batch.set(inviteRef, {
        challengeId: challengeRef.id,
        createdByUid: uid,
        inviterDisplayName: inviterName,
        tokenHash,
        placeholderName: placeholderName || null,
        numQuestions,
        status: "pending",
        claimedByUid: null,
        claimedAt: null,
        createdAt: now,
        expiresAt,
      });
      await batch.commit();

      return {
        challengeId: challengeRef.id,
        inviteToken: token,
        inviteUrl: `${SITE_URL}/quiz/invite/${token}`,
      };
    });

  // -- claimQuizExternalInvite ----------------------------------------------
  exports.claimQuizExternalInvite = functions
    .region(REGION)
    .https.onCall(async (data, context) => {
      const uid = context.auth?.uid;
      if (!uid) {
        throw new functions.https.HttpsError(
          "unauthenticated", "Devi accedere per accettare la sfida."
        );
      }
      const db = admin.firestore();
      await enforceCallableRateLimit(db, uid, "claimQuizExternalInvite", {
        windowSeconds: 20, maxInWindow: 8, dailyMax: 80,
      });

      const token = safeString(data?.token, 200).trim();
      if (!token) {
        throw new functions.https.HttpsError("invalid-argument", "Token non valido.");
      }
      const tokenHash = sha256(token);

      const inviteQuery = await db.collection("quizInvites")
        .where("tokenHash", "==", tokenHash)
        .limit(1)
        .get();
      if (inviteQuery.empty) {
        throw new functions.https.HttpsError("not-found", "Invito non trovato o scaduto.");
      }
      const inviteRef = inviteQuery.docs[0].ref;
      const inviteInitial = inviteQuery.docs[0].data() || {};
      if (isExpired(inviteInitial.expiresAt)) {
        throw new functions.https.HttpsError("failed-precondition", "Questo invito è scaduto.");
      }
      if (inviteInitial.createdByUid === uid) {
        throw new functions.https.HttpsError("failed-precondition", "Non puoi accettare un tuo invito.");
      }

      const challengeRef = db.collection("quizChallenges").doc(String(inviteInitial.challengeId));
      const userRef = db.collection("users").doc(uid);

      const result = await db.runTransaction(async (tx) => {
        const [challengeSnap, inviteSnap, userSnap] = await Promise.all([
          tx.get(challengeRef), tx.get(inviteRef), tx.get(userRef),
        ]);
        if (!challengeSnap.exists) {
          throw new functions.https.HttpsError("not-found", "Sfida non trovata.");
        }
        const challenge = challengeSnap.data() || {};
        const invite = inviteSnap.data() || {};

        // Community-safety gate: l'invitato deve aver accettato le linee guida
        // prima di poter accettare sfide quiz (vector anti-harassment).
        if (!hasAcceptedCommunitySafety(userSnap.exists ? userSnap.data() : null)) {
          throw new functions.https.HttpsError(
            "failed-precondition",
            "Devi accettare le linee guida della community prima di accettare sfide quiz."
          );
        }

        const alreadyMine = invite.claimedByUid === uid && challenge.toUid === uid;
        if (!alreadyMine) {
          if (invite.claimedByUid || invite.status === "claimed") {
            throw new functions.https.HttpsError(
              "failed-precondition", "Questo invito è già stato accettato."
            );
          }
          if (challenge.fromUid === uid) {
            throw new functions.https.HttpsError(
              "failed-precondition", "Non puoi accettare un tuo invito."
            );
          }
          const claimerName = sanitizeName(
            userSnap.exists ? (userSnap.data() || {}).displayName : ""
          ) || "Sfidante";
          tx.update(challengeRef, {
            toUid: uid,
            opponentDisplayName: claimerName,
            status: "pending_opponent_titles",
          });
          tx.update(inviteRef, {
            status: "claimed",
            claimedByUid: uid,
            claimedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
        return {
          challengeId: challengeRef.id,
          inviterUid: String(challenge.fromUid || ""),
          inviterDisplayName: safeString(invite.inviterDisplayName || "Un amico", 80),
          inviterSeenTitleIds: Array.isArray(challenge.inviterSeenTitleIds)
            ? challenge.inviterSeenTitleIds : [],
          numQuestions: Number(challenge.numQuestions) || 10,
          claimerName: sanitizeName(userSnap.exists ? (userSnap.data() || {}).displayName : "") || "Sfidante",
        };
      });

      // Best-effort: tell the inviter their invite was accepted.
      if (result.inviterUid) {
        try {
          await db.collection("users").doc(result.inviterUid)
            .collection("notifications").doc().set({
              type: "quiz_challenge",
              fromUid: uid,
              toUid: result.inviterUid,
              read: false,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              data: {
                fromName: result.claimerName,
                context: "external_invite_claimed",
                challengeId: result.challengeId,
              },
            });
        } catch (e) {
          logger.warn("[claimQuizExternalInvite] notify failed", e);
        }
      }

      return {
        challengeId: result.challengeId,
        inviterUid: result.inviterUid,
        inviterDisplayName: result.inviterDisplayName,
        inviterSeenTitleIds: result.inviterSeenTitleIds,
        numQuestions: result.numQuestions,
      };
    });

  // -- finalizeQuizExternalChallenge ----------------------------------------
  exports.finalizeQuizExternalChallenge = functions
    .region(REGION)
    .https.onCall(async (data, context) => {
      const uid = context.auth?.uid;
      if (!uid) {
        throw new functions.https.HttpsError("unauthenticated", "Devi accedere.");
      }
      const db = admin.firestore();
      await enforceCallableRateLimit(db, uid, "finalizeQuizExternalChallenge", {
        windowSeconds: 15, maxInWindow: 10, dailyMax: 120,
      });

      const challengeId = safeString(data?.challengeId, 128).trim();
      if (!challengeId) {
        throw new functions.https.HttpsError("invalid-argument", "challengeId mancante.");
      }
      const confirmedTitleIds = sanitizeIdList(data?.opponentConfirmedSeenTitleIds, 200);

      const challengeRef = db.collection("quizChallenges").doc(challengeId);
      const challengeSnap = await challengeRef.get();
      if (!challengeSnap.exists) {
        throw new functions.https.HttpsError("not-found", "Sfida non trovata.");
      }
      const challenge = challengeSnap.data() || {};
      if (challenge.toUid !== uid) {
        throw new functions.https.HttpsError(
          "permission-denied", "Non sei l'avversario di questa sfida."
        );
      }
      if (challenge.inviteType !== "external") {
        throw new functions.https.HttpsError("failed-precondition", "Sfida non valida.");
      }
      if (challenge.fromScore != null || challenge.toScore != null) {
        throw new functions.https.HttpsError(
          "failed-precondition", "La sfida è già iniziata."
        );
      }

      const numQuestions = Number(challenge.numQuestions) || 10;
      const inviterTitles = Array.isArray(challenge.inviterSeenTitleIds)
        ? challenge.inviterSeenTitleIds.map((t) => safeString(t, 128)) : [];
      const allTitles = uniqueStrings([...inviterTitles, ...confirmedTitleIds]);
      const sharedTitles = inviterTitles.filter((t) => confirmedTitleIds.includes(t));

      if (allTitles.length === 0) {
        return { ok: false, reason: "need_more_titles", available: 0 };
      }

      const pool = await fetchQuestionPool(db, allTitles, sharedTitles);
      if (pool.length < MIN_POOL_QUESTIONS) {
        return { ok: false, reason: "need_more_titles", available: pool.length };
      }
      const finalCount = Math.min(numQuestions, pool.length);
      const questionIds = shuffle(pool).slice(0, finalCount);

      await challengeRef.update({
        questionIds,
        numQuestions: finalCount,
        opponentConfirmedSeenTitleIds: confirmedTitleIds,
        sharedTitleIds: sharedTitles,
        status: "in_progress",
      });

      return { ok: true, questionCount: finalCount };
    });

  // -- quizInvitePreview (HTTP landing) -------------------------------------
  exports.quizInvitePreview = functions
    .region(REGION)
    .https.onRequest(async (req, res) => {
      try {
        const pathParts = String(req.path || "").split("/").filter(Boolean);
        const token = safeString(req.query.token || pathParts[pathParts.length - 1] || "", 200);

        let valid = false;
        let inviterName = "Un amico";
        let numQuestions = 10;

        if (token) {
          const db = admin.firestore();
          const snap = await db.collection("quizInvites")
            .where("tokenHash", "==", sha256(token))
            .limit(1)
            .get();
          if (!snap.empty) {
            const invite = snap.docs[0].data() || {};
            if (!isExpired(invite.expiresAt)) {
              valid = true;
              inviterName = safeString(invite.inviterDisplayName || "Un amico", 80);
              numQuestions = Number(invite.numQuestions) || 10;
            }
          }
        }

        const html = renderInvitePage({ valid, inviterName, numQuestions, token });
        res.set("Cache-Control", "no-store");
        res.status(200).send(html);
      } catch (err) {
        logger.error("[quizInvitePreview] error", err);
        res.status(500).send("Internal error");
      }
    });
}

module.exports = { registerQuizInvite };
