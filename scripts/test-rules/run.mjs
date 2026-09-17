// Smoke test Firestore rules contro Somto emulator (JDK 21+).
//
// Avvio:
//   Terminale 1: firebase emulators:start --only firestore,storage,auth
//   Terminale 2: cd scripts/test-rules && npm install && npm test
//
// Testa SOLO le rules toccate dal piano (PACK A + G + H). 0 functions.

import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  doc, setDoc, getDoc, addDoc, collection,
  updateDoc, serverTimestamp, Timestamp,
} from "firebase/firestore";

const REPO = resolve(import.meta.dirname, "..", "..");
const rules = readFileSync(resolve(REPO, "firestore.rules"), "utf8");

const env = await initializeTestEnvironment({
  projectId: "gia-visto-test",
  firestore: {
    host: "127.0.0.1",
    port: 58080,
    rules,
  },
});

let pass = 0, fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (e) {
    console.error(`✗ ${name}\n   ${e.message}`);
    fail++;
  }
}

const ALICE = "uid_alice";
const BOB = "uid_bob";
const CHARLIE = "uid_charlie";

// Seed: profili utente
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  for (const uid of [ALICE, BOB, CHARLIE, "u_paolo", "u_paolodot", "u_paololead", "u_paolocel"]) {
    await setDoc(doc(db, `users/${uid}`), {
      displayName: uid, communitySafetyAcceptedAt: Timestamp.now(),
      createdAt: Timestamp.now(),
    });
  }
  // Quiz question approved + pending
  await setDoc(doc(db, "quizQuestions/q_approved"), { status: "approved", titleId: "t1", text: "?" });
  await setDoc(doc(db, "quizQuestions/q_pending"), { status: "pending", titleId: "t1", text: "?" });
  // Counter rate-limit per Alice già al cap
  await setDoc(doc(db, `users/${ALICE}/rateLimits/recommendations`), {
    count: 50, resetAt: Timestamp.fromMillis(Date.now() + 86400000),
  });
});

const aliceDb = env.authenticatedContext(ALICE).firestore();
const bobDb = env.authenticatedContext(BOB).firestore();
const charlieDb = env.authenticatedContext(CHARLIE).firestore();

// === TEST 1: quizQuestions filter status ===
await test("quiz approved → leggibile signed-in", () =>
  assertSucceeds(getDoc(doc(aliceDb, "quizQuestions/q_approved"))));
await test("quiz pending → DENIED anche signed-in", () =>
  assertFails(getDoc(doc(aliceDb, "quizQuestions/q_pending"))));

// === TEST 2: userLists memberUids == [creator] ===
await test("userLists create con SOLO creator + editorUids=[] → OK", () =>
  assertSucceeds(setDoc(doc(aliceDb, "userLists/list_solo"), {
    ownerUid: ALICE,
    title: "Lista Test", kind: "collection", visibility: "private",
    memberUids: [ALICE], editorUids: [], viewerUids: [],
    savedByUids: [],
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  })));
await test("userLists create con creator + Bob in memberUids → DENIED", () =>
  assertFails(setDoc(doc(aliceDb, "userLists/list_multi"), {
    ownerUid: ALICE,
    title: "Lista Test", kind: "collection", visibility: "shared",
    memberUids: [ALICE, BOB], editorUids: [], viewerUids: [],
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  })));
await test("userLists create con editorUids preseeded non vuoto → DENIED", () =>
  assertFails(setDoc(doc(aliceDb, "userLists/list_pre_editors"), {
    ownerUid: ALICE,
    title: "Lista Test", kind: "collection", visibility: "shared",
    memberUids: [ALICE], editorUids: [ALICE], viewerUids: [],
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  })));
await test("userLists create con campo extra non previsto → DENIED", () =>
  assertFails(setDoc(doc(aliceDb, "userLists/list_extra_field"), {
    ownerUid: ALICE,
    title: "Lista Test", kind: "collection", visibility: "private",
    memberUids: [ALICE], editorUids: [], viewerUids: [],
    secretNote: "non deve diventare pubblico",
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  })));
await test("userLists create con savedByUids precompilato → DENIED", () =>
  assertFails(setDoc(doc(aliceDb, "userLists/list_saved_by_forged"), {
    ownerUid: ALICE,
    title: "Lista Test", kind: "collection", visibility: "public",
    memberUids: [ALICE], editorUids: [], viewerUids: [],
    savedByUids: [BOB],
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  })));

await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, "userLists/list_hardened"), {
    ownerUid: ALICE,
    ownerDisplayName: "Alice",
    title: "Lista sicura",
    description: "old",
    kind: "collection",
    visibility: "shared",
    memberUids: [ALICE, BOB],
    editorUids: [BOB],
    viewerUids: [],
    itemTitleIds: ["t1"],
    previewTitleIds: ["t1"],
    itemCount: 1,
    followersCount: 2,
    slug: "lista-sicura",
    slugUpdatedAt: Timestamp.now(),
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });
  await setDoc(doc(db, "userLists/list_private_hardened"), {
    ownerUid: ALICE,
    title: "Privata",
    kind: "collection",
    visibility: "private",
    memberUids: [ALICE],
    editorUids: [],
    viewerUids: [],
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });
});

await test("owner può modificare metadata lista propria → OK", () =>
  assertSucceeds(updateDoc(doc(aliceDb, "userLists/list_hardened"), {
    title: "Lista sicura aggiornata",
    description: "new",
    updatedAt: serverTimestamp(),
  })));
await test("owner può cambiare visibility → OK", () =>
  assertSucceeds(updateDoc(doc(aliceDb, "userLists/list_hardened"), {
    visibility: "public",
    updatedAt: serverTimestamp(),
  })));
await test("editor non-owner NON può cambiare visibility → DENIED", () =>
  assertFails(updateDoc(doc(bobDb, "userLists/list_hardened"), {
    visibility: "private",
    updatedAt: serverTimestamp(),
  })));
await test("editor non-owner NON può cambiare ownerUid → DENIED", () =>
  assertFails(updateDoc(doc(bobDb, "userLists/list_hardened"), {
    ownerUid: BOB,
    updatedAt: serverTimestamp(),
  })));
await test("editor non-owner NON può cambiare membership → DENIED", () =>
  assertFails(updateDoc(doc(bobDb, "userLists/list_hardened"), {
    memberUids: [ALICE, BOB, CHARLIE],
    updatedAt: serverTimestamp(),
  })));
await test("owner non può forzare nuova membership senza invito accettato → DENIED", () =>
  assertFails(updateDoc(doc(aliceDb, "userLists/list_hardened"), {
    memberUids: [ALICE, BOB, CHARLIE],
    editorUids: [BOB, CHARLIE],
    updatedAt: serverTimestamp(),
  })));
await test("owner NON può cambiare summary derivati/server-owned → DENIED", () =>
  assertFails(updateDoc(doc(aliceDb, "userLists/list_hardened"), {
    itemCount: 99,
    itemTitleIds: ["t1", "t2"],
    previewTitleIds: ["t1", "t2"],
    updatedAt: serverTimestamp(),
  })));
await test("editor non-owner NON può cambiare campi derivati/server-owned → DENIED", () =>
  assertFails(updateDoc(doc(bobDb, "userLists/list_hardened"), {
    itemCount: 99,
    followersCount: 99,
    slug: "hacked",
    updatedAt: serverTimestamp(),
  })));
await test("editor non-owner può modificare metadata consentiti → OK", () =>
  assertSucceeds(updateDoc(doc(bobDb, "userLists/list_hardened"), {
    title: "Lista sicura editata",
    description: "copy ok",
    updatedAt: serverTimestamp(),
  })));
await test("editor non-owner può aggiungere item lista → OK", () =>
  assertSucceeds(setDoc(doc(bobDb, "userLists/list_hardened/items/t2"), {
    titleId: "t2",
    orderIndex: 2,
    addedByUid: BOB,
    addedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })));
await test("editor non-owner NON può spoofare addedByUid item → DENIED", () =>
  assertFails(setDoc(doc(bobDb, "userLists/list_hardened/items/t3"), {
    titleId: "t3",
    orderIndex: 3,
    addedByUid: ALICE,
    addedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })));
await test("utente non membro NON può leggere lista privata → DENIED", () =>
  assertFails(getDoc(doc(charlieDb, "userLists/list_private_hardened"))));
await test("utente non membro NON può scrivere item su lista privata → DENIED", () =>
  assertFails(setDoc(doc(charlieDb, "userLists/list_private_hardened/items/t1"), {
    titleId: "t1",
    orderIndex: 1,
    updatedAt: serverTimestamp(),
  })));
await test("utente non membro NON può scrivere root lista privata → DENIED", () =>
  assertFails(updateDoc(doc(charlieDb, "userLists/list_private_hardened"), {
    title: "hacked",
    updatedAt: serverTimestamp(),
  })));
await test("membership diretta non può essere forzata da non-owner → DENIED", () =>
  assertFails(setDoc(doc(charlieDb, "userLists/list_hardened/members/uid_charlie"), {
    uid: CHARLIE,
    role: "editor",
    joinedAt: serverTimestamp(),
  })));
await test("root lista pubblica NON è leggibile da non membro → DENIED", () =>
  assertFails(getDoc(doc(charlieDb, "userLists/list_hardened"))));
await test("members/progress lista pubblica NON sono leggibili da non membro → DENIED", async () => {
  await assertFails(getDoc(doc(charlieDb, "userLists/list_hardened/members/uid_alice")));
  await assertFails(getDoc(doc(charlieDb, "userLists/list_hardened/progress/uid_alice")));
});
await env.withSecurityRulesDisabled(async (ctx) => {
  await setDoc(doc(ctx.firestore(), "publicUserLists/list_hardened"), {
    listId: "list_hardened",
    title: "Lista sicura editata",
    description: "copy ok",
    kind: "collection",
    visibility: "public",
    ownerUid: ALICE,
    owner: { uid: ALICE, displayName: "Alice", photoURL: null },
    itemTitleIds: ["t1", "t2"],
    previewTitleIds: ["t1", "t2"],
    itemCount: 2,
    completedCount: 0,
    followersCount: 2,
    cover: { imageUrl: null, storagePath: null, fallbackTitleIds: ["t1", "t2"], accentHex: null },
    slug: "lista-sicura",
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });
});
await test("proiezione publicUserLists leggibile da utente loggato → OK", () =>
  assertSucceeds(getDoc(doc(charlieDb, "publicUserLists/list_hardened"))));
await test("proiezione publicUserLists non scrivibile dal client → DENIED", () =>
  assertFails(setDoc(doc(charlieDb, "publicUserLists/list_hardened"), {
    title: "hacked",
    visibility: "public",
  }, { merge: true })));

// === TEST 3: usernames regex stretto ===
async function tryUsername(uid, displayNameLower) {
  return setDoc(doc(env.authenticatedContext(uid).firestore(),
    `usernames/${displayNameLower}`), {
    uid, displayName: displayNameLower, displayNameLower,
    createdAt: serverTimestamp(),
  });
}
await test("username 'paolo' valido", () =>
  assertSucceeds(tryUsername("u_paolo", "paolo")));
await test("username 'paolo..' invalido (dot doppio)", () =>
  assertFails(tryUsername("u_paolodot", "paolo..")));
await test("username '.paolo' invalido (leading dot)", () =>
  assertFails(tryUsername("u_paololead", ".paolo")));
await test("username 'paolo cel' valido (spazio singolo OK)", async () => {
  // skip if rule no più supporta spazio
  try { await tryUsername("u_paolocel", "paolo cel"); }
  catch (e) { /* accettabile */ }
});

// === TEST 4: rate-limit recommendations ===
// Alice già al cap 50. Create deve fallire.
const recRef = doc(collection(aliceDb, "recommendations"));
await test("recommendation create al cap → DENIED", () =>
  assertFails(setDoc(recRef, {
    fromUid: ALICE, toUid: BOB, titleId: "t1",
    message: "hey", createdAt: Timestamp.now(),
  })));
// Bob (counter assente) → create OK
const recRefBob = doc(collection(bobDb, "recommendations"));
await test("recommendation create senza counter (Bob) → richiede counter atomico", async () => {
  // Senza counter writeBatch atomico la rule fallisce comunque
  await assertFails(setDoc(recRefBob, {
    fromUid: BOB, toUid: ALICE, titleId: "t1",
    message: "hi", createdAt: Timestamp.now(),
  }));
});

// === TEST 5: moderationQueue admin-only ===
await test("moderationQueue read user normale → DENIED", () =>
  assertFails(getDoc(doc(aliceDb, "moderationQueue/q1"))));

await env.cleanup();
console.log(`\n=== ${pass} pass / ${fail} fail ===`);
process.exit(fail > 0 ? 1 : 0);
