// Rules test per lo step "Segui qualcuno" dell'onboarding v2
// (docs/ONBOARDING_V2.md): la query collection-group su `library`.
//
// Avvio:
//   Terminale 1: firebase emulators:start --only firestore
//   Terminale 2: cd scripts/test-rules && node run-onboarding-follow.mjs

import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  doc, setDoc, getDocs, collectionGroup, query, where, limit,
} from "firebase/firestore";

const REPO = resolve(import.meta.dirname, "..", "..");
const rules = readFileSync(resolve(REPO, "firestore.rules"), "utf8");

const env = await initializeTestEnvironment({
  projectId: "gia-visto-test",
  firestore: { host: "127.0.0.1", port: 58080, rules },
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

await env.clearFirestore();

// Seed: due profili con lo stesso titolo in libreria.
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, "users/alice/library/title-1"), { titleId: "title-1" });
  await setDoc(doc(db, "users/bob/library/title-1"), { titleId: "title-1" });
  await setDoc(doc(db, "users/bob/library/title-2"), { titleId: "title-2" });
});

const libraryByTitle = (db, titleId) =>
  query(collectionGroup(db, "library"), where("titleId", "==", titleId), limit(30));

await test("loggato: collection-group su library per titleId", async () => {
  const db = env.authenticatedContext("carol").firestore();
  const snap = await assertSucceeds(getDocs(libraryByTitle(db, "title-1")));
  if (snap.size !== 2) throw new Error(`attesi 2 doc, trovati ${snap.size}`);
  const owners = snap.docs.map((d) => d.ref.parent.parent.id).sort();
  if (owners.join(",") !== "alice,bob") {
    throw new Error(`owner attesi alice,bob — trovati ${owners.join(",")}`);
  }
});

await test("non loggato: collection-group su library negata", async () => {
  const db = env.unauthenticatedContext().firestore();
  await assertFails(getDocs(libraryByTitle(db, "title-1")));
});

await test("loggato: la lettura diretta della libreria altrui resta aperta", async () => {
  const db = env.authenticatedContext("carol").firestore();
  await assertSucceeds(getDocs(libraryByTitle(db, "title-2")));
});

await test("non loggato: nessun accesso ai doc library", async () => {
  const db = env.unauthenticatedContext().firestore();
  await assertFails(getDocs(libraryByTitle(db, "title-2")));
});

await env.cleanup();
console.log(`\n${pass} passati, ${fail} falliti`);
process.exit(fail === 0 ? 0 : 1);
