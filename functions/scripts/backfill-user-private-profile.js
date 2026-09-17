#!/usr/bin/env node

const admin = require("firebase-admin");

admin.initializeApp();

const db = admin.firestore();
const { FieldValue } = admin.firestore;

const STRIP_PUBLIC = process.argv.includes("--strip-public");
const PAGE_SIZE = 200;

async function main() {
  let lastDoc = null;
  let scanned = 0;
  let migrated = 0;
  let stripped = 0;

  for (;;) {
    let query = db.collection("users").orderBy(admin.firestore.FieldPath.documentId()).limit(PAGE_SIZE);
    if (lastDoc) {
      query = query.startAfter(lastDoc);
    }

    const snap = await query.get();
    if (snap.empty) break;

    let batch = db.batch();
    let ops = 0;
    const flush = async () => {
      if (!ops) return;
      await batch.commit();
      batch = db.batch();
      ops = 0;
    };

    for (const docSnap of snap.docs) {
      scanned += 1;
      lastDoc = docSnap;
      const data = docSnap.data() || {};
      const privatePatch = {};

      if (data.onboardingStatus && typeof data.onboardingStatus === "object") {
        privatePatch.onboardingStatus = data.onboardingStatus;
      }
      if (data.tasteProfile && typeof data.tasteProfile === "object") {
        privatePatch.tasteProfile = data.tasteProfile;
      }
      if (data.onboardingMeta && typeof data.onboardingMeta === "object") {
        privatePatch.onboardingMeta = data.onboardingMeta;
      }

      if (!Object.keys(privatePatch).length) {
        continue;
      }

      batch.set(db.collection("usersPrivate").doc(docSnap.id), {
        ...privatePatch,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      ops += 1;
      migrated += 1;

      if (STRIP_PUBLIC) {
        batch.set(docSnap.ref, {
          onboardingStatus: FieldValue.delete(),
          tasteProfile: FieldValue.delete(),
          onboardingMeta: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        ops += 1;
        stripped += 1;
      }

      if (ops >= 350) {
        await flush();
      }
    }

    await flush();

    if (snap.size < PAGE_SIZE) break;
  }

  console.log(JSON.stringify({
    ok: true,
    stripPublic: STRIP_PUBLIC,
    scanned,
    migrated,
    stripped,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
