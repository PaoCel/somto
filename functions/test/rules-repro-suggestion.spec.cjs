// Repro mirato: flusso "invia suggerimento" iOS (ensureDMThread + transazione
// rate-limit + create recommendation). Usato per diagnosticare il
// "Missing or insufficient permissions" del 2026-07-30. NON parte del suite
// standard (file separato).
const { describe, it, before, after } = require('node:test');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs');
const { join } = require('path');
const {
  doc,
  setDoc,
  serverTimestamp,
  runTransaction,
  Timestamp,
} = require('firebase/firestore');

const projectId = 'rules-repro-suggestion';
const firestoreRules = readFileSync(join(__dirname, '../../firestore.rules'), 'utf8');

let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId,
    firestore: { rules: firestoreRules },
  });
});

after(async () => {
  if (testEnv) await testEnv.cleanup();
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
});

describe('iOS suggestion flow', () => {
  it('DM thread create with iOS payload succeeds', async () => {
    const qa = testEnv.authenticatedContext('qauser').firestore();
    await assertSucceeds(setDoc(doc(qa, 'threads/dm_t1_qauser_target'), {
      titleId: 't1',
      visibility: 'private',
      contextType: 'dm',
      contextId: 'qauser_target',
      participants: ['qauser', 'target'],
      groupName: '',
      createdBy: 'qauser',
      createdAt: serverTimestamp(),
      lastMessageAt: null,
      lastMessagePreview: '',
      lastSenderUid: null,
      lastMessageId: null,
    }));
  });

  it('rate-limited recommendation create FAILS with client-side Timestamp (iOS attuale)', async () => {
    const qa = testEnv.authenticatedContext('qauser').firestore();
    await assertFails(runTransaction(qa, async (txn) => {
      txn.set(doc(qa, 'users/qauser/rateLimits/recommendations'), {
        count: 1,
        resetAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000),
      });
      txn.set(doc(qa, 'recommendations/repro1'), {
        fromUid: 'qauser',
        toUid: 'target',
        titleId: 't1',
        message: 'test',
        createdAt: Timestamp.now(), // <-- come iOS: Timestamp(date: Date())
        status: 'unread',
        threadId: null,
        viewedAt: null,
      });
    }));
  });

  it('rate-limited recommendation create SUCCEEDS with serverTimestamp transform', async () => {
    const qa = testEnv.authenticatedContext('qauser').firestore();
    await assertSucceeds(runTransaction(qa, async (txn) => {
      txn.set(doc(qa, 'users/qauser/rateLimits/recommendations'), {
        count: 1,
        resetAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000),
      });
      txn.set(doc(qa, 'recommendations/repro2'), {
        fromUid: 'qauser',
        toUid: 'target',
        titleId: 't1',
        message: 'test',
        createdAt: serverTimestamp(), // <-- transform: in rules vale request.time
        status: 'unread',
        threadId: null,
        viewedAt: null,
      });
    }));
  });

  it('report create: client Timestamp fails, serverTimestamp passes', async () => {
    const qa = testEnv.authenticatedContext('qauser').firestore();
    await assertFails(runTransaction(qa, async (txn) => {
      txn.set(doc(qa, 'users/qauser/rateLimits/reports'), {
        count: 1,
        resetAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000),
      });
      txn.set(doc(qa, 'reports/repro3'), {
        fromUid: 'qauser',
        type: 'post',
        targetId: 'p1',
        reason: 'test',
        status: 'pending',
        createdAt: Timestamp.now(),
        updatedAt: serverTimestamp(),
      });
    }));
    await assertSucceeds(runTransaction(qa, async (txn) => {
      txn.set(doc(qa, 'users/qauser/rateLimits/reports'), {
        count: 1,
        resetAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000),
      });
      txn.set(doc(qa, 'reports/repro4'), {
        fromUid: 'qauser',
        type: 'post',
        targetId: 'p1',
        reason: 'test',
        status: 'pending',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }));
  });
});
