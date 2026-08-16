// Test Firestore rules — security fix pre-lancio (5 vulnerabilità gravi).
//
// Avvio (JDK 21+):
//   firebase emulators:exec --only firestore "node scripts/test-rules/run-security-fixes.mjs"
//
// Copre, per ogni fix: l'EXPLOIT deve fallire (assertFails) e la scrittura
// LEGITTIMA deve passare (assertSucceeds).
//   1. quizStats/agg — delta per-scrittura limitato (no forge leaderboard)
//   2. titles/{id}   — ratingAggregate/slug/mergedTmdbIds server-owned
//   3. users/{uid}   — stats/followersCount/friendsCount congelati
//   4. rateLimits    — finestra minima 12h (no reset a 1ms)

import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  doc, setDoc, updateDoc, getDoc, collection, query, where, getDocs,
  serverTimestamp, Timestamp,
} from "firebase/firestore";

const REPO = resolve(import.meta.dirname, "..", "..");
const rules = readFileSync(resolve(REPO, "firestore.rules"), "utf8");

const env = await initializeTestEnvironment({
  projectId: "gia-visto-test",
  firestore: { host: "127.0.0.1", port: 58080, rules },
});

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`✓ ${name}`); pass++; }
  catch (e) { console.error(`✗ ${name}\n   ${e.message}`); fail++; }
}

const NOW = Date.now();
const future24h = Timestamp.fromMillis(NOW + 24 * 3600 * 1000);
const future1min = Timestamp.fromMillis(NOW + 60 * 1000);
const past = Timestamp.fromMillis(NOW - 1000);

// ---- SEED (rules disabilitate) ----
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  const baseUser = (extra = {}) => ({
    displayName: "seed", communitySafetyAcceptedAt: Timestamp.now(),
    createdAt: Timestamp.now(), ...extra,
  });
  await setDoc(doc(db, "users/alice"), baseUser());
  await setDoc(doc(db, "users/bob"), baseUser());
  await setDoc(doc(db, "users/trusty"), baseUser({ trusted: true }));
  await setDoc(doc(db, "users/admin"), baseUser({ isAdmin: true }));
  await setDoc(doc(db, "users/carol"), baseUser({
    displayName: "carol1", displayNameLower: "carol1",
    stats: { watchedCount: 5, ratingsCount: 2, totalWatchMinutes: 120, titlesCreated: 1 },
    followersCount: 3, friendsCount: 1,
  }));
  await setDoc(doc(db, "users/mallory"), baseUser());

  // quizStats baseline per alice
  await setDoc(doc(db, "users/alice/quizStats/agg"), {
    totalScore: 100, weeklyScore: 30, xp: 200, attemptsCount: 10,
    correctCount: 40, wrongCount: 5, skippedCount: 5,
    dailyStreak: 3, bestDailyStreak: 3, dailyBonusGames: 1, weekKey: "2026-W24",
  });

  // titolo approvato con aggregate + slug server-owned
  await setDoc(doc(db, "titles/t1"), {
    status: "approved", name: "X", slug: "x-2020", description: "old",
    mergedTmdbIds: [], ratingAggregate: { combined: 7, titleLevel: { sum: 70, count: 10, avg: 7 } },
  });

  // counter rate-limit scaduto (per test ramo nuova-finestra)
  await setDoc(doc(db, "users/mallory/rateLimits/reports"), { count: 20, resetAt: past });

  // rating con watchedWith (per test read anonimo)
  await setDoc(doc(db, "ratings/r1"), {
    uid: "alice", titleId: "t1", level: "title", value: 8,
    watchedWith: ["bob"], reviewText: "bello",
  });

  // blog: un pubblicato + una bozza (per test leak bozze)
  await setDoc(doc(db, "blogPosts/pub"), { status: "published", title: "Pub", body: "x", publishedAt: Timestamp.now() });
  await setDoc(doc(db, "blogPosts/draft"), { status: "draft", title: "Bozza", body: "segreto", publishedAt: Timestamp.now() });
});

const aliceDb = env.authenticatedContext("alice").firestore();
const trustyDb = env.authenticatedContext("trusty").firestore();
const adminDb = env.authenticatedContext("admin").firestore();
const bobDb = env.authenticatedContext("bob").firestore();
const carolDb = env.authenticatedContext("carol").firestore();
const malloryDb = env.authenticatedContext("mallory").firestore();

// ============ FIX 1 — quizStats ============
const aggA = doc(aliceDb, "users/alice/quizStats/agg");
await test("quizStats EXPLOIT totalScore=9999999 → DENIED", () =>
  assertFails(setDoc(aggA, { totalScore: 9999999 }, { merge: true })));
await test("quizStats EXPLOIT xp=9999999 → DENIED", () =>
  assertFails(setDoc(aggA, { xp: 9999999 }, { merge: true })));
await test("quizStats EXPLOIT dailyStreak=365 → DENIED", () =>
  assertFails(setDoc(aggA, { dailyStreak: 365 }, { merge: true })));
await test("quizStats LEGIT partita (delta nei cap) → OK", () =>
  assertSucceeds(setDoc(aggA, {
    totalScore: 108, weeklyScore: 38, attemptsCount: 11,
    correctCount: 48, xp: 226, dailyStreak: 4, bestDailyStreak: 4,
  }, { merge: true })));
await test("quizStats LEGIT reset weeklyScore=0 (week drift) → OK", () =>
  assertSucceeds(setDoc(aggA, { weeklyScore: 0, weekKey: "2026-W25" }, { merge: true })));
await test("quizStats LEGIT create (eve, valori iniziali plausibili) → OK", () =>
  assertSucceeds(setDoc(doc(env.authenticatedContext("eve").firestore(), "users/eve/quizStats/agg"), {
    totalScore: 8, weeklyScore: 8, xp: 26, attemptsCount: 1,
    correctCount: 8, wrongCount: 1, skippedCount: 1, dailyStreak: 1, bestDailyStreak: 1,
  })));
await test("quizStats EXPLOIT create totalScore=9999 → DENIED", () =>
  assertFails(setDoc(doc(env.authenticatedContext("mal2").firestore(), "users/mal2/quizStats/agg"), {
    totalScore: 9999,
  })));

// ============ FIX 2 — titles ============
const t1Trusty = doc(trustyDb, "titles/t1");
await test("titles EXPLOIT trusty forge ratingAggregate → DENIED", () =>
  assertFails(setDoc(t1Trusty, {
    ratingAggregate: { combined: 10, titleLevel: { sum: 1000, count: 100, avg: 10 } },
  }, { merge: true })));
await test("titles EXPLOIT trusty cambia slug → DENIED", () =>
  assertFails(setDoc(t1Trusty, { slug: "hacked" }, { merge: true })));
await test("titles LEGIT trusty edita description → OK", () =>
  assertSucceeds(setDoc(t1Trusty, { description: "new" }, { merge: true })));
await test("titles LEGIT admin aggiorna ratingAggregate → OK", () =>
  assertSucceeds(setDoc(doc(adminDb, "titles/t1"), {
    ratingAggregate: { combined: 9, titleLevel: { sum: 90, count: 10, avg: 9 } },
  }, { merge: true })));
await test("titles non-trusted (bob) update → DENIED", () =>
  assertFails(setDoc(doc(bobDb, "titles/t1"), { description: "z" }, { merge: true })));

// ============ FIX 3 — users counters ============
const carolSelf = doc(carolDb, "users/carol");
await test("users EXPLOIT carol gonfia stats.watchedCount → DENIED", () =>
  assertFails(setDoc(carolSelf, { stats: { watchedCount: 99999 } }, { merge: true })));
await test("users EXPLOIT carol gonfia followersCount → DENIED", () =>
  assertFails(setDoc(carolSelf, { followersCount: 99999 }, { merge: true })));
await test("users LEGIT carol aggiorna lastActiveAt → OK", () =>
  assertSucceeds(setDoc(carolSelf, { lastActiveAt: serverTimestamp() }, { merge: true })));
await test("users LEGIT create (dave) stats azzerate → OK", () =>
  assertSucceeds(setDoc(doc(env.authenticatedContext("dave").firestore(), "users/dave"), {
    displayName: "dave1", displayNameLower: "dave1",
    stats: { watchedCount: 0, ratingsCount: 0, totalWatchMinutes: 0, rewatchCount: 0 },
    createdAt: serverTimestamp(),
  })));
await test("users EXPLOIT create (frank) followersCount gonfiato → DENIED", () =>
  assertFails(setDoc(doc(env.authenticatedContext("frank").firestore(), "users/frank"), {
    displayName: "frank1", displayNameLower: "frank1", followersCount: 99999,
    createdAt: serverTimestamp(),
  })));
await test("users EXPLOIT create (grace) stats gonfiate → DENIED", () =>
  assertFails(setDoc(doc(env.authenticatedContext("grace").firestore(), "users/grace"), {
    displayName: "grace1", displayNameLower: "grace1",
    stats: { watchedCount: 5000 }, createdAt: serverTimestamp(),
  })));

// ============ FIX 4 — rate-limit finestra minima ============
await test("rateLimit LEGIT create finestra 24h → OK", () =>
  assertSucceeds(setDoc(doc(bobDb, "users/bob/rateLimits/reports"), { count: 1, resetAt: future24h })));
await test("rateLimit EXPLOIT create finestra 1min → DENIED", () =>
  assertFails(setDoc(doc(env.authenticatedContext("eve").firestore(), "users/eve/rateLimits/reports"), {
    count: 1, resetAt: future1min,
  })));
await test("rateLimit EXPLOIT nuova-finestra reset a 1min → DENIED", () =>
  assertFails(updateDoc(doc(malloryDb, "users/mallory/rateLimits/reports"), { count: 1, resetAt: future1min })));
await test("rateLimit LEGIT nuova-finestra 24h → OK", () =>
  assertSucceeds(updateDoc(doc(malloryDb, "users/mallory/rateLimits/reports"), { count: 1, resetAt: future24h })));

// ============ FIX 5 — ratings read solo loggati ============
const anonDb = env.unauthenticatedContext().firestore();
await test("ratings read ANONIMO → DENIED (no leak watchedWith)", () =>
  assertFails(getDoc(doc(anonDb, "ratings/r1"))));
await test("ratings read loggato → OK", () =>
  assertSucceeds(getDoc(doc(bobDb, "ratings/r1"))));

// ============ FIX 6 — blogPosts list non espone bozze ============
await test("blogPosts get bozza ANONIMO → DENIED", () =>
  assertFails(getDoc(doc(anonDb, "blogPosts/draft"))));
await test("blogPosts get pubblicato ANONIMO → OK", () =>
  assertSucceeds(getDoc(doc(anonDb, "blogPosts/pub"))));
await test("blogPosts list where status==published → OK", () =>
  assertSucceeds(getDocs(query(collection(bobDb, "blogPosts"), where("status", "==", "published")))));
await test("blogPosts list SENZA filtro (espone bozze) → DENIED", () =>
  assertFails(getDocs(collection(bobDb, "blogPosts"))));

await env.cleanup();
console.log(`\n=== ${pass} pass / ${fail} fail ===`);
process.exit(fail > 0 ? 1 : 0);
