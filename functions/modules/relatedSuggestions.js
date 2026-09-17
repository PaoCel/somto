"use strict";

// Suggerimenti community di "titoli collegati" (saghe/sequel non gia' uniti da
// TMDB `collectionId`, o collegamenti editoriali che TMDB non modella).
//
// Flusso: un utente propone `titleRelatedSuggestions/{uid}__{titleId}__{suggestedTitleId}`
// (rules in firestore.rules, sezione "TITLE RELATED SUGGESTIONS"). Quando la
// STESSA coppia (in una direzione o nell'altra) raccoglie abbastanza
// proponenti distinti, il trigger gen2 la auto-approva e collega i due titoli
// (`titles.related`, gia' letto da recommendationEngine.js/recoBenchmark.js
// per seedare i consigli). Un admin puo' anche decidere a mano via callable,
// con la stessa logica di collegamento.
//
// Gen2 (europe-west1): vedi CLAUDE.md "Trigger Firestore gen1 non creabili" —
// il database eur3 rifiuta trigger Firestore gen1 nuovi.

const {
  resolveAutoApproveThreshold,
  unorderedPairKey,
  countDistinctProposers,
  shouldAutoApprove,
} = require("../lib/relatedSuggestions");

const PENDING_OR_APPROVED = ["pending", "approved"];

function safeText(value, maxLength = 240) {
  return String(value || "").trim().slice(0, maxLength);
}

// Tutti i suggerimenti (pending o approved) per QUESTA coppia non ordinata, in
// entrambe le direzioni. Ogni query e' solo uguaglianze (`==`/`in`): Firestore
// le serve con index merging automatico, nessun indice composito dedicato.
async function fetchPairSuggestions(db, titleIdA, titleIdB) {
  const [forward, backward] = await Promise.all([
    db.collection("titleRelatedSuggestions")
      .where("titleId", "==", titleIdA)
      .where("suggestedTitleId", "==", titleIdB)
      .where("status", "in", PENDING_OR_APPROVED)
      .get(),
    db.collection("titleRelatedSuggestions")
      .where("titleId", "==", titleIdB)
      .where("suggestedTitleId", "==", titleIdA)
      .where("status", "in", PENDING_OR_APPROVED)
      .get(),
  ]);
  const docs = [...(forward.docs || []), ...(backward.docs || [])];
  return docs.map((docSnap) => ({ ref: docSnap.ref, id: docSnap.id, data: docSnap.data() || {} }));
}

// Collega due titoli (arrayUnion su entrambi) SOLO se esistono e sono
// entrambi approvati: un `related` verso una bozza o un titolo cancellato
// sarebbe un consiglio rotto in home.
async function linkTitlesIfApproved(db, admin, titleIdA, titleIdB) {
  const [snapA, snapB] = await Promise.all([
    db.collection("titles").doc(titleIdA).get(),
    db.collection("titles").doc(titleIdB).get(),
  ]);
  const approvedA = snapA.exists && snapA.data()?.status === "approved";
  const approvedB = snapB.exists && snapB.data()?.status === "approved";
  if (!approvedA || !approvedB) {
    return { applied: false, reason: "titles_not_both_approved" };
  }

  const batch = db.batch();
  batch.update(db.collection("titles").doc(titleIdA), {
    related: admin.firestore.FieldValue.arrayUnion(titleIdB),
  });
  batch.update(db.collection("titles").doc(titleIdB), {
    related: admin.firestore.FieldValue.arrayUnion(titleIdA),
  });
  await batch.commit();
  return { applied: true };
}

function registerRelatedSuggestions({ functions, admin, logger, isAdminCaller, enforceCallableRateLimit }) {
  const { onDocumentCreated } = require("firebase-functions/v2/firestore");

  return {
    onTitleRelatedSuggestionCreated: onDocumentCreated(
      { document: "titleRelatedSuggestions/{suggestionId}", region: "europe-west1" },
      async (event) => {
        const suggestion = event.data?.data() || {};
        const titleId = safeText(suggestion.titleId, 160);
        const suggestedTitleId = safeText(suggestion.suggestedTitleId, 160);
        if (!titleId || !suggestedTitleId || suggestion.status !== "pending") return null;

        const db = admin.firestore();
        const pairKey = unorderedPairKey(titleId, suggestedTitleId);
        const rows = await fetchPairSuggestions(db, titleId, suggestedTitleId);
        const threshold = resolveAutoApproveThreshold();
        const distinctProposers = countDistinctProposers(rows.map((row) => row.data));

        if (!shouldAutoApprove(distinctProposers, threshold)) {
          logger.info("[relatedSuggestions] sotto soglia", { pairKey, distinctProposers, threshold });
          return null;
        }

        const link = await linkTitlesIfApproved(db, admin, titleId, suggestedTitleId);
        if (!link.applied) {
          logger.info("[relatedSuggestions] soglia raggiunta ma titoli non collegabili", {
            pairKey,
            distinctProposers,
            reason: link.reason,
          });
          return null;
        }

        const pending = rows.filter((row) => row.data.status === "pending");
        if (pending.length) {
          const batch = db.batch();
          const reviewedAt = admin.firestore.FieldValue.serverTimestamp();
          for (const row of pending) {
            batch.update(row.ref, { status: "approved", reviewedAt, reviewedBy: "auto" });
          }
          await batch.commit();
        }

        logger.info("[relatedSuggestions] auto-approvato", { pairKey, distinctProposers, threshold, approved: pending.length });
        return null;
      }
    ),

    reviewTitleRelatedSuggestion: functions
      .runWith({ timeoutSeconds: 60, memory: "256MB" })
      .region("europe-west1")
      .https.onCall(async (data, context) => {
        const callerUid = context.auth?.uid || "";
        if (!callerUid) {
          throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
        }

        const db = admin.firestore();
        if (!(await isAdminCaller(db, callerUid))) {
          throw new functions.https.HttpsError("permission-denied", "Solo admin.");
        }

        if (typeof enforceCallableRateLimit === "function") {
          await enforceCallableRateLimit(db, callerUid, "reviewTitleRelatedSuggestion", {
            windowSeconds: 20,
            maxInWindow: 10,
            dailyMax: 300,
          });
        }

        const id = safeText(data?.id, 400);
        const decision = safeText(data?.decision, 20);
        if (!id || !["approve", "reject"].includes(decision)) {
          throw new functions.https.HttpsError("invalid-argument", "id/decision non validi.");
        }

        const ref = db.collection("titleRelatedSuggestions").doc(id);
        const snap = await ref.get();
        if (!snap.exists) {
          throw new functions.https.HttpsError("not-found", "Suggerimento non trovato.");
        }
        const suggestion = snap.data() || {};
        const titleId = safeText(suggestion.titleId, 160);
        const suggestedTitleId = safeText(suggestion.suggestedTitleId, 160);

        if (decision === "reject") {
          await ref.update({
            status: "rejected",
            reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
            reviewedBy: callerUid,
          });
          return { id, status: "rejected" };
        }

        const link = await linkTitlesIfApproved(db, admin, titleId, suggestedTitleId);
        if (!link.applied) {
          throw new functions.https.HttpsError("failed-precondition", "Entrambi i titoli devono esistere ed essere approvati.");
        }
        await ref.update({
          status: "approved",
          reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
          reviewedBy: callerUid,
        });
        return { id, status: "approved" };
      }),
  };
}

module.exports = { registerRelatedSuggestions };
