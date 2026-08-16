// Smoke test trigger Firestore (Somto).
//
// Avvio:
//   Terminale 1: firebase emulators:start --only functions,auth,firestore --project gia-visto
//   Terminale 2: cd scripts/test-functions && npm install && node triggers.mjs
//
// Copre:
//   - flagSuspectedSpoilerPost -> moderationQueue entry creata
//   - recomputeTitleRatingAggregate -> aggregate scritto correttamente
//
// =================================================================
// LIMITAZIONE NOTA (2026-05-21):
//
// L'emulator functions di firebase-tools wrappa `admin` con un Proxy che,
// quando accede a `admin.firestore` (function), restituisce
// `value.bind(target)`. Il bind PERDE le proprieta' statiche attaccate al
// getter `firestore`, fra cui `FieldValue` (vedi
// node_modules/firebase-admin/lib/app/firebase-namespace.js:139 e
// /opt/homebrew/lib/node_modules/firebase-tools/lib/emulator/
// functionsEmulatorRuntime.js:42 `Proxied.getOriginal`).
//
// Risultato: dentro l'emulator, `admin.firestore.FieldValue` e' undefined
// per TUTTI i trigger Somto (e per tutte le callable con rate limit).
// In produzione (Cloud Functions runtime) NON c'e' il Proxy -> funziona.
//
// I trigger NON sono testabili in questo env senza modificare prod code
// (OFF-LIMITS). I test sotto sono lasciati come scheletro: se in futuro
// firebase-admin migra a modular API (`require("firebase-admin/firestore")
// .FieldValue`) o firebase-tools fix il Proxy stub, i test gireranno.
//
// TODO: vedi github.com/firebase/firebase-tools/issues per il bug del
// Proxy stub su firebase-admin v13.
// =================================================================

import admin from "firebase-admin";

const HOST = "127.0.0.1";
const FIRESTORE_PORT = 58080;
const PROJECT_ID = "gia-visto";
const SKIP_REASON = "emulator Proxy stub + firebase-admin v13 incompat - vedi header";

process.env.FIRESTORE_EMULATOR_HOST = `${HOST}:${FIRESTORE_PORT}`;
process.env.GCLOUD_PROJECT = PROJECT_ID;

admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();

let pass = 0, fail = 0, skip = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
    pass++;
  } catch (e) {
    console.error(`FAIL ${name}\n   ${e?.message || e}`);
    fail++;
  }
}
function testSkip(name, reason) {
  console.log(`SKIP ${name} (${reason})`);
  skip++;
}

async function waitForCondition(check, { timeoutMs = 20000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await check();
      if (r) return r;
    } catch (_) { /* keep polling */ }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  throw new Error(`condition not satisfied within ${timeoutMs}ms`);
}

// Permette CI di forzare l'esecuzione anche se i trigger sono noti broken.
const FORCE_RUN = String(process.env.SOMTO_FORCE_TRIGGER_TESTS || "") === "1";

if (!FORCE_RUN) {
  testSkip("flagSuspectedSpoilerPost trigger", SKIP_REASON);
  testSkip("recomputeTitleRatingAggregate title-level", SKIP_REASON);
  testSkip("recomputeTitleRatingAggregate season-level + combined", SKIP_REASON);
} else {
  // =============================================================
  // 1) flagSuspectedSpoilerPost
  // =============================================================
  await test("flagSuspectedSpoilerPost: posts/{id} con spoiler -> moderationQueue", async () => {
    const existing = await db.collection("moderationQueue")
      .where("docPath", "==", "posts/test_spoiler_post_1")
      .get();
    await Promise.all(existing.docs.map((d) => d.ref.delete()));

    await db.collection("posts").doc("test_spoiler_post_1").set({
      authorUid: "uid_alice",
      text: "Devastante: nel finale Walter muore. Episodio epico, ma che dolore.",
      titleId: "title_breaking_bad_test",
      containsSpoiler: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const found = await waitForCondition(async () => {
      const snap = await db.collection("moderationQueue")
        .where("docPath", "==", "posts/test_spoiler_post_1")
        .get();
      return snap.empty ? null : snap.docs[0].data();
    });

    if (!found.matchedPattern) throw new Error("missing matchedPattern");
    if (found.source !== "posts") throw new Error(`source mismatch: ${found.source}`);
    if (found.status !== "pending") throw new Error(`status mismatch: ${found.status}`);
  });

  // =============================================================
  // 2) recomputeTitleRatingAggregate
  // =============================================================
  const TID = "title_rating_agg_test";

  await test("recomputeTitleRatingAggregate: rating title-level seeded e aggregato corretto", async () => {
    await db.collection("titles").doc(TID).set({
      name: "Rating Agg Test Title",
      status: "approved",
    });
    const oldR = await db.collection("ratings").where("titleId", "==", TID).get();
    await Promise.all(oldR.docs.map((d) => d.ref.delete()));
    await db.collection("titles").doc(TID).update({
      ratingAggregate: admin.firestore.FieldValue.delete(),
    });

    await db.collection("ratings").doc("r_test_title_1").set({
      titleId: TID,
      level: "title",
      rating: 8,
      uid: "uid_u1",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const agg = await waitForCondition(async () => {
      const snap = await db.collection("titles").doc(TID).get();
      const a = snap.data()?.ratingAggregate;
      return a?.titleLevel?.count === 1 ? a : null;
    });

    if (agg.titleLevel.sum !== 8) throw new Error(`sum mismatch: ${agg.titleLevel.sum}`);
    if (agg.titleLevel.count !== 1) throw new Error(`count mismatch: ${agg.titleLevel.count}`);
    if (Math.abs(agg.titleLevel.avg - 8) > 0.01) throw new Error(`avg mismatch: ${agg.titleLevel.avg}`);
    if (Math.abs(agg.combined - 8) > 0.01) throw new Error(`combined mismatch: ${agg.combined}`);
  });

  await test("recomputeTitleRatingAggregate: aggiunta rating season-level -> bySeason + combined media pesata", async () => {
    await db.collection("ratings").doc("r_test_title_2").set({
      titleId: TID,
      level: "season",
      season: 1,
      rating: 7,
      uid: "uid_u1",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const agg = await waitForCondition(async () => {
      const snap = await db.collection("titles").doc(TID).get();
      const a = snap.data()?.ratingAggregate;
      return a?.bySeason?.["1"]?.count === 1 ? a : null;
    });

    if (agg.bySeason["1"].sum !== 7) throw new Error(`bySeason[1].sum mismatch: ${agg.bySeason["1"].sum}`);
    if (agg.bySeason["1"].count !== 1) throw new Error(`bySeason[1].count mismatch: ${agg.bySeason["1"].count}`);
    if (Math.abs(agg.bySeason["1"].avg - 7) > 0.01) throw new Error(`bySeason[1].avg mismatch: ${agg.bySeason["1"].avg}`);
    // combined: (8 + 7) / 2 = 7.5
    if (Math.abs(agg.combined - 7.5) > 0.01) throw new Error(`combined mismatch: ${agg.combined} (expected 7.5)`);
  });
}

console.log(`\n=== ${pass} pass / ${fail} fail / ${skip} skip ===`);
process.exit(fail > 0 ? 1 : 0);
