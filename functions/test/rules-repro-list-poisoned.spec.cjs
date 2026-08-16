// Repro mirato: incidente "Marvel cronologico" 2026-07-31. Lo script ops
// backfill-list-followers.js scrive `followersCountUpdatedAt` sul root di
// userLists via admin SDK; il campo NON era nella hasOnly di validUserListDoc,
// quindi da quel momento OGNI update client del root (owner incluso, batch
// "aggiungi a una lista" di iOS) falliva con permission-denied. Idem il campo
// `isTestSeed` presente su una lista storica. Il fix ammette la PRESENZA dei
// due campi e li blinda come server-owned (immutabili dal client, vietati in
// create). NON parte della suite standard (file separato, registrato in
// package.json#test:rules).
const { describe, it, before, after } = require('node:test');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs');
const { join } = require('path');
const {
  doc,
  setDoc,
  writeBatch,
  serverTimestamp,
  Timestamp,
} = require('firebase/firestore');

const projectId = 'rules-repro-list-poisoned';
const firestoreRules = readFileSync(join(__dirname, '../../firestore.rules'), 'utf8');

let testEnv;

const LIST_ID = 'plist_marvel';
const seededAt = Timestamp.fromMillis(1753900000000);

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId,
    firestore: { rules: firestoreRules },
  });
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    // Lista come quella reale: root con i due campi server-only fuori
    // allowlist + item esistente con audit fields completi.
    await setDoc(doc(db, `userLists/${LIST_ID}`), {
      title: 'Marvel cronologico',
      description: null,
      ownerUid: 'alice',
      ownerDisplayName: 'Alice',
      visibility: 'public',
      kind: 'collection',
      memberUids: ['alice'],
      editorUids: [],
      viewerUids: [],
      itemTitleIds: ['tmdb_movie_1'],
      previewTitleIds: ['tmdb_movie_1'],
      itemCount: 1,
      completedCount: 0,
      followersCount: 1,
      followersCountUpdatedAt: seededAt, // <- scritto dallo script ops
      isTestSeed: true,                  // <- presente su una lista storica
      savedByUids: [],
      slug: 'marvel-cronologico-x',
      slugUpdatedAt: seededAt,
      cover: { imageUrl: null, storagePath: null, fallbackTitleIds: [], accentHex: null },
      createdAt: seededAt,
      updatedAt: seededAt,
    });
    await setDoc(doc(db, `userLists/${LIST_ID}/items/tmdb_movie_1`), {
      titleId: 'tmdb_movie_1',
      orderIndex: 1000,
      addedByUid: 'alice',
      addedAt: seededAt,
      updatedAt: seededAt,
    });
  });
});

after(async () => {
  if (testEnv) await testEnv.cleanup();
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
});

describe('userLists con campi server-only sul root (lista "avvelenata")', () => {
  it('il batch iOS "aggiungi a una lista" dell\'owner PASSA (root merge + item update + item create)', async () => {
    const db = testEnv.authenticatedContext('alice').firestore();
    const batch = writeBatch(db);
    // Specchio esatto di WatchlistRepository.upsertList (update path).
    batch.set(doc(db, `userLists/${LIST_ID}`), {
      title: 'Marvel cronologico',
      description: null,
      visibility: 'public',
      kind: 'collection',
      updatedAt: serverTimestamp(),
    }, { merge: true });
    batch.set(doc(db, `userLists/${LIST_ID}/items/tmdb_movie_1`), {
      titleId: 'tmdb_movie_1',
      orderIndex: 1000,
      updatedAt: serverTimestamp(),
    }, { merge: true });
    batch.set(doc(db, `userLists/${LIST_ID}/items/tmdb_tv_89387`), {
      titleId: 'tmdb_tv_89387',
      orderIndex: 2000,
      updatedAt: serverTimestamp(),
      addedByUid: 'alice',
      addedAt: serverTimestamp(),
    }, { merge: true });
    await assertSucceeds(batch.commit());
  });

  it('il client NON può cambiare followersCountUpdatedAt', async () => {
    const db = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(db, `userLists/${LIST_ID}`), {
      followersCountUpdatedAt: Timestamp.fromMillis(1753999999000),
      updatedAt: serverTimestamp(),
    }, { merge: true }));
  });

  it('il client NON può cambiare isTestSeed', async () => {
    const db = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(db, `userLists/${LIST_ID}`), {
      isTestSeed: false,
      updatedAt: serverTimestamp(),
    }, { merge: true }));
  });

  it('create con isTestSeed/followersCountUpdatedAt resta vietata', async () => {
    const db = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(db, 'userLists/nuova_seed'), {
      title: 'Prova',
      ownerUid: 'alice',
      visibility: 'private',
      kind: 'collection',
      memberUids: ['alice'],
      editorUids: [],
      viewerUids: [],
      isTestSeed: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
  });
});
