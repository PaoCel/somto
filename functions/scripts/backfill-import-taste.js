#!/usr/bin/env node
/**
 * backfill-import-taste.js
 *
 * Alimenta il taste profile (users/{uid}/tasteProfile/agg) dei titoli GIÀ visti
 * dall'utente — pensato per chi ha importato PRIMA che l'import scrivesse il
 * taste profile (il fold in finalizeImportResults è arrivato dopo). Riusa la
 * STESSA matematica del trigger via lib/tasteProfileAggregate.
 *
 * Fonte "visto" = users/{uid}/library (identica a loadUserSeenTitleIds del match
 * engine: gli stessi titoli che il recommender esclude dai suggerimenti sono
 * quelli che ne plasmano il gusto). Voto = /ratings level=title (delta reale,
 * anche negativo). Titolo visto senza voto → import_seen (positivo debole).
 *
 * UNA transazione per utente, additiva sul featureSums esistente. Idempotente:
 * marker tasteBackfill.at su tasteProfile/agg → un utente già fatto è saltato
 * (a meno di --force).
 *
 * Usage (da functions/):
 *   node scripts/backfill-import-taste.js --uid=<uid>           # dry-run 1 utente
 *   node scripts/backfill-import-taste.js --uid=<uid> --write
 *   node scripts/backfill-import-taste.js --all                 # dry-run tutti
 *   node scripts/backfill-import-taste.js --all --write
 *   node scripts/backfill-import-taste.js --uid=<uid> --write --force  # re-fold
 */
const admin = require("firebase-admin");
const {
  extractTitleFeatures,
  buildImportTasteInputs,
  foldTitleDeltas,
  pruneFeatureSums,
  computeConfidenceScore,
} = require("../lib/tasteProfileAggregate");

const WRITE = process.argv.includes("--write");
const ALL = process.argv.includes("--all");
const FORCE = process.argv.includes("--force");
const uidArg = (process.argv.find((a) => a.startsWith("--uid=")) || "").split("=")[1] || null;
const LIMIT_USERS = Number((process.argv.find((a) => a.startsWith("--limit=")) || "").split("=")[1] || 0) || Infinity;

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

const toId = (v) => (v === null || v === undefined ? "" : String(v).trim());

// Legge i doc titolo (feature) per un set di id, a blocchi con getAll.
async function loadTitleFeatures(titleIds) {
  const out = new Map();
  const ids = Array.from(new Set(titleIds.filter(Boolean)));
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300);
    const refs = chunk.map((id) => db.collection("titles").doc(id));
    // eslint-disable-next-line no-await-in-loop
    const snaps = await db.getAll(...refs);
    snaps.forEach((snap) => {
      if (snap.exists) out.set(snap.id, extractTitleFeatures(snap.data() || {}));
    });
  }
  return out;
}

async function backfillUser(uid) {
  const userRef = db.collection("users").doc(uid);
  const tpRef = userRef.collection("tasteProfile").doc("agg");

  // Skip se già fatto (marker), a meno di --force.
  if (!FORCE) {
    const tpSnap = await tpRef.get().catch(() => null);
    if (tpSnap && tpSnap.exists && tpSnap.data() && tpSnap.data().tasteBackfill && tpSnap.data().tasteBackfill.at) {
      return { uid, skipped: "already_backfilled" };
    }
  }

  // Set "visto" = library. Voti a livello titolo = /ratings level=title.
  const [libSnap, ratingsSnap] = await Promise.all([
    userRef.collection("library").limit(5000).get().catch(() => ({ docs: [] })),
    db.collection("ratings").where("uid", "==", uid).limit(5000).get().catch(() => ({ docs: [] })),
  ]);

  const watchedIds = Array.from(new Set(libSnap.docs.map((d) => toId(d.id)).filter(Boolean)));
  if (watchedIds.length === 0) return { uid, skipped: "no_library" };

  const ratingByTitleId = new Map();
  ratingsSnap.docs.forEach((doc) => {
    const r = doc.data() || {};
    if (r.level !== "title") return;
    const tId = toId(r.titleId);
    const val = Number(r.rating);
    if (tId && Number.isFinite(val) && val > 0) ratingByTitleId.set(tId, val);
  });

  const featuresByTitleId = await loadTitleFeatures(
    Array.from(new Set([...watchedIds, ...ratingByTitleId.keys()]))
  );

  const now = new Date();
  const inputs = buildImportTasteInputs({ watchedTitleIds: watchedIds, featuresByTitleId, ratingByTitleId })
    .map((it) => ({ ...it, createdAt: now }));
  if (inputs.length === 0) return { uid, skipped: "no_inputs" };

  if (!WRITE) {
    return { uid, dryRun: true, watched: watchedIds.length, rated: ratingByTitleId.size, wouldFold: inputs.length };
  }

  const privateUserRef = db.collection("usersPrivate").doc(uid);
  await db.runTransaction(async (tx) => {
    const [tpSnap, userSnap, privSnap] = await Promise.all([
      tx.get(tpRef), tx.get(userRef), tx.get(privateUserRef),
    ]);
    const current = tpSnap.exists ? (tpSnap.data() || {}) : {};
    const merged = {
      ...(userSnap.exists ? userSnap.data() || {} : {}),
      ...(privSnap.exists ? privSnap.data() || {} : {}),
    };
    const featureSums = current.featureSums || {};
    foldTitleDeltas(featureSums, inputs);
    pruneFeatureSums(featureSums);
    const completedLevel = Number(merged && merged.onboardingStatus && merged.onboardingStatus.completedLevel || 0);
    const confidenceScore = computeConfidenceScore(featureSums, completedLevel);
    tx.set(tpRef, {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      featureSums,
      confidenceScore,
      seed: {
        onboardingCompletedLevel: completedLevel,
        seedTitleIds: Array.isArray(merged && merged.tasteProfile && merged.tasteProfile.seedTitleIds)
          ? merged.tasteProfile.seedTitleIds
          : [],
      },
      tasteBackfill: {
        at: admin.firestore.FieldValue.serverTimestamp(),
        titlesFolded: inputs.length,
        ratedTitles: ratingByTitleId.size,
      },
    }, { merge: true });
  });

  return { uid, written: true, watched: watchedIds.length, rated: ratingByTitleId.size, folded: inputs.length };
}

(async () => {
  if (!ALL && !uidArg) {
    console.error("Specificare --uid=<uid> oppure --all.");
    process.exit(1);
  }

  if (uidArg) {
    const res = await backfillUser(uidArg);
    console.log(JSON.stringify(res));
    if (!WRITE) console.log("[dry-run] nulla scritto. Ri-lancia con --write.");
    return;
  }

  // --all: pagina gli utenti per document id.
  let startAfter = null;
  let done = 0;
  let written = 0;
  const summary = { written: 0, skipped: 0, dryRun: 0 };
  for (;;) {
    let q = db.collection("users").orderBy(admin.firestore.FieldPath.documentId()).limit(200);
    if (startAfter) q = q.startAfter(startAfter);
    // eslint-disable-next-line no-await-in-loop
    const snap = await q.get();
    if (snap.empty) break;
    for (const docSnap of snap.docs) {
      if (done >= LIMIT_USERS) break;
      // eslint-disable-next-line no-await-in-loop
      const res = await backfillUser(docSnap.id).catch((err) => ({ uid: docSnap.id, error: err.message }));
      done += 1;
      if (res.written) { written += 1; summary.written += 1; console.log(JSON.stringify(res)); }
      else if (res.dryRun) { summary.dryRun += 1; if (res.wouldFold) console.log(JSON.stringify(res)); }
      else if (res.error) console.warn("ERR", res.uid, res.error);
      else summary.skipped += 1;
    }
    startAfter = snap.docs[snap.docs.length - 1].id;
    if (done >= LIMIT_USERS) break;
  }
  console.log(`\nProcessati ${done} utenti. ${JSON.stringify(summary)}`);
  if (!WRITE) console.log("[dry-run] nulla scritto. Ri-lancia con --write.");
})().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
