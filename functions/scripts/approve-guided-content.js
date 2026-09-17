#!/usr/bin/env node
/**
 * approve-guided-content.js
 *
 * Human review batch dei contenuti generati dai profili guidati quando
 * `requireHumanReview` e' attivo. I draft vivono in `guidedContentDrafts`
 * (status: draft|approved|rejected|published).
 *
 * Senza flag: dry-run, elenca i draft pendenti.
 * --approve : pubblica i draft (scrive rating/post/comment reali, marca published).
 * --reject  : marca i draft come rejected (niente pubblicazione).
 * --limit=N : quanti draft processare (default 50).
 *
 * Usage:
 *   cd functions
 *   node scripts/approve-guided-content.js                 # elenca i pendenti
 *   node scripts/approve-guided-content.js --approve
 *   node scripts/approve-guided-content.js --reject --limit=10
 */

const admin = require("firebase-admin");
const { CONTENT_STATUS, COLLECTIONS } = require("../modules/guidedProfiles/constants");
const { makeRatingId } = require("../modules/guidedProfiles/activity");

const APPROVE = process.argv.includes("--approve");
const REJECT = process.argv.includes("--reject");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = Math.max(1, Math.min(500, Number((limitArg || "").split("=")[1]) || 50));

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

async function publishDraft(draft) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  const uid = draft.guidedUid;
  if (draft.actionType === "review") {
    const ref = db.collection("ratings").doc(makeRatingId(uid, draft.titleId));
    await ref.set({
      uid, titleId: draft.titleId, level: "title", season: null, episode: null,
      rating: Number(draft.rating) || 7,
      ...(draft.text ? { reviewText: draft.text } : {}),
      isSynthetic: true, createdAt: now, updatedAt: now,
    }, { merge: true });
    return `ratings/${ref.id}`;
  }
  if (draft.actionType === "post") {
    const ref = db.collection("posts").doc();
    await ref.set({
      authorUid: uid, authorName: draft.authorName || "Profilo guidato",
      text: draft.text, titleId: draft.titleId || null,
      kind: "post", visibility: "public",
      containsSpoiler: false, spoilerTitleIds: [],
      isSynthetic: true, createdAt: now, updatedAt: now,
    });
    return `posts/${ref.id}`;
  }
  if (draft.actionType === "comment") {
    const ref = db.collection("posts").doc(draft.postId).collection("comments").doc();
    await ref.set({
      uid, authorName: draft.authorName || "Profilo guidato", text: draft.text,
      containsSpoiler: false, spoilerTitleIds: [],
      isSynthetic: true, createdAt: now,
    });
    return `posts/${draft.postId}/comments/${ref.id}`;
  }
  throw new Error(`unknown actionType: ${draft.actionType}`);
}

async function main() {
  const mode = APPROVE ? "APPROVE" : REJECT ? "REJECT" : "DRY-RUN (list)";
  console.log(`approve-guided-content — ${mode} — limit=${LIMIT}`);

  const snap = await db.collection(COLLECTIONS.CONTENT_DRAFTS)
    .where("status", "==", CONTENT_STATUS.DRAFT)
    .limit(LIMIT)
    .get();

  if (snap.empty) { console.log("Nessun draft pendente."); return; }
  console.log(`${snap.size} draft pendenti:\n`);

  let processed = 0;
  for (const d of snap.docs) {
    const draft = d.data() || {};
    const preview = String(draft.text || "").slice(0, 70);
    console.log(`  [${draft.actionType}] ${draft.guidedUid} -> "${preview}"`);

    if (APPROVE) {
      const path = await publishDraft(draft);
      await d.ref.set({
        status: CONTENT_STATUS.PUBLISHED,
        publishedPath: path,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      processed++;
    } else if (REJECT) {
      await d.ref.set({
        status: CONTENT_STATUS.REJECTED,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      processed++;
    }
  }

  console.log(`\nDone. ${APPROVE ? `${processed} pubblicati` : REJECT ? `${processed} rifiutati` : "dry-run (nessuna modifica)"}.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
