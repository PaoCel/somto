// Rules regression tests for critical surfaces (Node test runner)
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs');
const { join } = require('path');
const {
  collection,
  doc,
  getDocs,
  query,
  orderBy,
  where,
  setDoc,
  updateDoc,
  writeBatch,
  getDoc,
  deleteDoc,
  serverTimestamp,
  arrayRemove,
  arrayUnion,
} = require('firebase/firestore');
const {
  ref,
  deleteObject,
  uploadBytes,
} = require('firebase/storage');

const projectId = 'rules-test-2watch';
const firestoreRules = readFileSync(join(__dirname, '../../firestore.rules'), 'utf8');
const storageRules = readFileSync(join(__dirname, '../../storage.rules'), 'utf8');

let testEnv;

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('FIRESTORE_EMULATOR_HOST is not set. Run tests via `npm test` which wraps firebase emulators:exec.');
}

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId,
    firestore: { rules: firestoreRules },
    storage: { rules: storageRules },
  });
});

after(async () => {
  if (testEnv) await testEnv.cleanup();
  // The Firebase emulator/test SDK stack sometimes leaves open pipes on macOS.
  // We exit explicitly after cleanup so `firebase emulators:exec` can terminate.
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
});

afterEach(async () => {
  if (!testEnv) return;
  await testEnv.clearFirestore();
  await testEnv.clearStorage();
});

async function withSeededFirestore(run) {
  return testEnv.withSecurityRulesDisabled(async (context) => run(context.firestore()));
}

async function seedDoc(path, data) {
  await withSeededFirestore(async (db) => {
    await setDoc(doc(db, path), data);
  });
}

async function seedDocs(entries) {
  await withSeededFirestore(async (db) => {
    await Promise.all(entries.map(([path, data]) => setDoc(doc(db, path), data)));
  });
}

describe('Quiz meta + questions read gating', () => {
  it('quizMeta/themes is publicly readable but not client-writable', async () => {
    await seedDoc('quizMeta/themes', {
      themes: [{ titleId: 't1', title: 'Test', mediaType: 'movie', count: 5 }],
      totalTitles: 1,
    });
    const anon = testEnv.unauthenticatedContext().firestore();
    const authed = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(getDoc(doc(anon, 'quizMeta/themes')));
    await assertSucceeds(getDoc(doc(authed, 'quizMeta/themes')));
    await assertFails(setDoc(doc(authed, 'quizMeta/themes'), { themes: [] }));
  });

  it('quizQuestions stays gated to signed-in users and playable status', async () => {
    await seedDocs([
      ['quizQuestions/q_ok', { titleId: 't1', status: 'approved', questionText: 'x', answers: ['a', 'b', 'c', 'd'], correctAnswerIndex: 0 }],
      ['quizQuestions/q_pending', { titleId: 't1', status: 'pending', questionText: 'x', answers: ['a', 'b', 'c', 'd'], correctAnswerIndex: 0 }],
    ]);
    const anon = testEnv.unauthenticatedContext().firestore();
    const authed = testEnv.authenticatedContext('alice').firestore();
    await assertFails(getDoc(doc(anon, 'quizQuestions/q_ok')));
    await assertSucceeds(getDoc(doc(authed, 'quizQuestions/q_ok')));
    await assertFails(getDoc(doc(authed, 'quizQuestions/q_pending')));
  });

  it('quizSessions V2 is server-only even for its owner and admins', async () => {
    await seedDoc('quizSessions/session-1', {
      schemaVersion: 2,
      ownerUid: 'alice',
      status: 'active',
      questions: [{ questionId: 'q1', correctAnswerIndex: 0 }],
    });
    const alice = testEnv.authenticatedContext('alice').firestore();
    const bob = testEnv.authenticatedContext('bob').firestore();
    const admin = testEnv.authenticatedContext('admin', { admin: true }).firestore();
    const anon = testEnv.unauthenticatedContext().firestore();

    await assertFails(getDoc(doc(alice, 'quizSessions/session-1')));
    await assertFails(getDoc(doc(bob, 'quizSessions/session-1')));
    await assertFails(getDoc(doc(admin, 'quizSessions/session-1')));
    await assertFails(getDoc(doc(anon, 'quizSessions/session-1')));
    await assertFails(setDoc(doc(alice, 'quizSessions/session-2'), {
      schemaVersion: 2,
      ownerUid: 'alice',
      status: 'active',
    }));
  });
});

describe('Friends state machine', () => {
  it('initiator cannot auto-accept', async () => {
    const ts = serverTimestamp();
    await seedDocs([
      ['users/alice/friends/bob', { status: 'pending', initiatedBy: 'alice', createdAt: ts }],
      ['users/bob/friends/alice', { status: 'pending', initiatedBy: 'alice', createdAt: ts }],
    ]);

    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(updateDoc(doc(aliceDb, 'users/alice/friends/bob'), {
      status: 'accepted',
      initiatedBy: 'alice',
      createdAt: ts,
      acceptedAt: serverTimestamp(),
    }));
  });

  it('recipient cannot accept only one mirror doc', async () => {
    const ts = serverTimestamp();
    await seedDocs([
      ['users/alice/friends/bob', { status: 'pending', initiatedBy: 'alice', createdAt: ts }],
      ['users/bob/friends/alice', { status: 'pending', initiatedBy: 'alice', createdAt: ts }],
    ]);

    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertFails(updateDoc(doc(bobDb, 'users/bob/friends/alice'), {
      status: 'accepted',
      initiatedBy: 'alice',
      createdAt: ts,
      acceptedAt: serverTimestamp(),
    }));
  });

  it('recipient can accept both mirror docs in one batch', async () => {
    const ts = serverTimestamp();
    await seedDocs([
      ['users/alice/friends/bob', { status: 'pending', initiatedBy: 'alice', createdAt: ts }],
      ['users/bob/friends/alice', { status: 'pending', initiatedBy: 'alice', createdAt: ts }],
    ]);

    const bobDb = testEnv.authenticatedContext('bob').firestore();
    const batch = writeBatch(bobDb);
    batch.update(doc(bobDb, 'users/bob/friends/alice'), {
      status: 'accepted',
      acceptedAt: serverTimestamp(),
    });
    batch.update(doc(bobDb, 'users/alice/friends/bob'), {
      status: 'accepted',
      acceptedAt: serverTimestamp(),
    });
    await assertSucceeds(batch.commit());
  });

  it('initiator cannot accept mirror docs in one batch', async () => {
    const ts = serverTimestamp();
    await seedDocs([
      ['users/alice/friends/bob', { status: 'pending', initiatedBy: 'alice', createdAt: ts }],
      ['users/bob/friends/alice', { status: 'pending', initiatedBy: 'alice', createdAt: ts }],
    ]);

    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    const batch = writeBatch(aliceDb);
    batch.update(doc(aliceDb, 'users/alice/friends/bob'), {
      status: 'accepted',
      acceptedAt: serverTimestamp(),
    });
    batch.update(doc(aliceDb, 'users/bob/friends/alice'), {
      status: 'accepted',
      acceptedAt: serverTimestamp(),
    });
    await assertFails(batch.commit());
  });

  it('non participant cannot read pending friendship docs', async () => {
    const ts = serverTimestamp();
    await seedDocs([
      ['users/alice/friends/bob', { status: 'pending', initiatedBy: 'alice', createdAt: ts }],
      ['users/bob/friends/alice', { status: 'pending', initiatedBy: 'alice', createdAt: ts }],
    ]);

    const carolDb = testEnv.authenticatedContext('carol').firestore();
    await assertFails(getDoc(doc(carolDb, 'users/alice/friends/bob')));
  });

  it('non participant can read accepted friendship docs', async () => {
    await seedDocs([
      ['users/alice/friends/bob', { status: 'accepted', initiatedBy: 'alice' }],
      ['users/bob/friends/alice', { status: 'accepted', initiatedBy: 'alice' }],
    ]);

    const carolDb = testEnv.authenticatedContext('carol').firestore();
    await assertSucceeds(getDoc(doc(carolDb, 'users/alice/friends/bob')));
  });

  it('non participant cannot read blocked friendship docs', async () => {
    const ts = serverTimestamp();
    await seedDocs([
      ['users/alice/friends/bob', { status: 'blocked', initiatedBy: 'alice', blockedBy: 'alice', createdAt: ts, updatedAt: ts }],
      ['users/bob/friends/alice', { status: 'blocked', initiatedBy: 'alice', blockedBy: 'alice', createdAt: ts, updatedAt: ts }],
    ]);

    const carolDb = testEnv.authenticatedContext('carol').firestore();
    await assertFails(getDoc(doc(carolDb, 'users/alice/friends/bob')));
  });
});

describe('Notifications anti-spoof', () => {
  it('cannot create friend_accept without accepted state', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, 'users/bob/notifications/x1'), {
      toUid: 'bob',
      fromUid: 'alice',
      type: 'friend_accept',
      read: false,
      createdAt: serverTimestamp(),
      data: {},
    }));
  });
});

describe('Push notification tokens', () => {
  // Regressione 2026-08-03: i client rimandano createdAt: serverTimestamp() a
  // ogni refresh. La rule pretendeva createdAt immutabile, quindi ogni refresh
  // veniva negato in silenzio e i doc token restavano fermi all'installazione.
  const tokenPath = 'users/alice/notificationTokens/tok1';
  const payload = () => ({
    token: 'tok1',
    platform: 'ios',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  it('owner can register and then refresh its own token', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(aliceDb, tokenPath), payload()));
    await assertSucceeds(setDoc(doc(aliceDb, tokenPath), {
      ...payload(),
      systemVersion: '26.2.1',
    }, { merge: true }));
  });

  it('refresh keeping the original createdAt is still allowed', async () => {
    await seedDoc(tokenPath, { token: 'tok1', platform: 'ios', createdAt: new Date('2026-03-22T18:55:00Z'), updatedAt: new Date('2026-03-22T18:55:00Z') });
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(updateDoc(doc(aliceDb, tokenPath), { updatedAt: serverTimestamp() }));
  });

  it('token value, platform and other users stay protected', async () => {
    await seedDoc(tokenPath, { token: 'tok1', platform: 'ios', createdAt: new Date('2026-03-22T18:55:00Z'), updatedAt: new Date('2026-03-22T18:55:00Z') });
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(updateDoc(doc(aliceDb, tokenPath), { token: 'stolen', updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(aliceDb, tokenPath), { updatedAt: new Date('2020-01-01T00:00:00Z') }));
    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertFails(setDoc(doc(bobDb, tokenPath), payload()));
    await assertFails(getDoc(doc(bobDb, tokenPath)));
  });
});

describe('Match feedback actions', () => {
  it('owner can save seen action', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(aliceDb, 'users/alice/matchFeedback/t1'), {
      titleId: 't1',
      action: 'seen',
      updatedAt: serverTimestamp(),
    }, { merge: true }));
  });

  it('invalid action is rejected', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, 'users/alice/matchFeedback/t2'), {
      titleId: 't2',
      action: 'maybe',
      updatedAt: serverTimestamp(),
    }, { merge: true }));
  });
});

describe('Notification prefs in _system', () => {
  it('owner can write and read notificationPrefs', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(aliceDb, 'users/alice/_system/notificationPrefs'), {
      disabledTypes: ['follow', 'thread_message'],
      updatedAt: new Date(),
    }, { merge: true }));
    await assertSucceeds(getDoc(doc(aliceDb, 'users/alice/_system/notificationPrefs')));
  });

  it('owner può disattivare gli aggiornamenti automatici ed editoriali', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(aliceDb, 'users/alice/_system/notificationPrefs'), {
      disabledTypes: ['title_update', 'official_update', 'new_season_available'],
      updatedAt: new Date(),
    }, { merge: true }));
  });

  it('non-owner cannot write or read notificationPrefs', async () => {
    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertFails(setDoc(doc(bobDb, 'users/alice/_system/notificationPrefs'), {
      disabledTypes: ['friend_request'],
      updatedAt: new Date(),
    }, { merge: true }));
    await assertFails(getDoc(doc(bobDb, 'users/alice/_system/notificationPrefs')));
  });

  it('owner cannot write invalid notificationPrefs schema', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, 'users/alice/_system/notificationPrefs'), {
      disabledTypes: 'follow',
      updatedAt: new Date(),
      extra: true,
    }, { merge: true }));
    await assertFails(setDoc(doc(aliceDb, 'users/alice/_system/notificationPrefs'), {
      disabledTypes: ['unknown_update'],
      updatedAt: new Date(),
    }, { merge: true }));
  });
});

describe('Product tracking milestones in _system', () => {
  it('sono deny-all per owner, altri utenti e admin client', async () => {
    await seedDoc('users/adm', {
      displayName: 'Adm',
      displayNameLower: 'adm',
      isAdmin: true,
      createdAt: new Date(),
    });
    await seedDoc('users/alice/_system/productTracking', {
      schemaVersion: 1,
      cohortOrigin: 'prospective',
      firstSuccessfulImportAt: new Date(),
      updatedAt: new Date(),
    });

    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    const bobDb = testEnv.authenticatedContext('bob').firestore();
    const admDb = testEnv.authenticatedContext('adm').firestore();
    const refFor = (db) => doc(db, 'users/alice/_system/productTracking');

    await assertFails(getDoc(refFor(aliceDb)));
    await assertFails(getDoc(refFor(bobDb)));
    await assertFails(getDoc(refFor(admDb)));
    await assertFails(setDoc(refFor(aliceDb), { schemaVersion: 999 }, { merge: true }));
    await assertFails(setDoc(refFor(admDb), { schemaVersion: 999 }, { merge: true }));
  });
});

describe('usersPrivate/{uid}.language (preferenza lingua)', () => {
  it('owner puo scrivere una lingua supportata', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(aliceDb, 'usersPrivate/alice'), { language: 'en' }, { merge: true }));
    await assertSucceeds(setDoc(doc(aliceDb, 'usersPrivate/alice'), { language: 'it' }, { merge: true }));
  });

  it('lingua non supportata negata', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, 'usersPrivate/alice'), { language: 'de' }, { merge: true }));
  });

  it('lingua di tipo sbagliato negata', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, 'usersPrivate/alice'), { language: 42 }, { merge: true }));
  });

  it('estraneo non puo scrivere la lingua di un altro', async () => {
    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertFails(setDoc(doc(bobDb, 'usersPrivate/alice'), { language: 'en' }, { merge: true }));
  });

  it('le altre scritture su usersPrivate continuano a funzionare (niente hasOnly)', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(aliceDb, 'usersPrivate/alice'), {
      onboardingStatus: { completedLevel: 1 },
      tasteProfile: { seedTitleIds: ['t1'] },
    }, { merge: true }));
  });
});

describe('OAuth integration tokens (usersPrivate/{uid}/integrations)', () => {
  it('owner CANNOT read or write their own integrations/trakt token doc (admin SDK only)', async () => {
    // Seed a token doc via the admin (rules-disabled) context, like a Cloud
    // Function would.
    await seedDoc('usersPrivate/alice/integrations/trakt', {
      status: 'connected',
      accessToken: 'secret-token',
      refreshToken: 'secret-refresh',
      connectedAt: new Date(),
    });

    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    // The OWNER of usersPrivate/alice must still be denied on the integrations
    // subcollection (tokens are secrets).
    await assertFails(getDoc(doc(aliceDb, 'usersPrivate/alice/integrations/trakt')));
    await assertFails(setDoc(doc(aliceDb, 'usersPrivate/alice/integrations/trakt'), {
      status: 'connected',
      accessToken: 'forged',
    }, { merge: true }));
    await assertFails(deleteDoc(doc(aliceDb, 'usersPrivate/alice/integrations/trakt')));
  });

  it('a stranger CANNOT read or write another user integrations token doc', async () => {
    await seedDoc('usersPrivate/alice/integrations/trakt', { status: 'pending', deviceCode: 'dc' });
    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertFails(getDoc(doc(bobDb, 'usersPrivate/alice/integrations/trakt')));
    await assertFails(setDoc(doc(bobDb, 'usersPrivate/alice/integrations/trakt'), { status: 'connected' }, { merge: true }));
  });
});

describe('Legacy user docs compatibility', () => {
  it('owner can update lastActiveAt even if trusted/admin/level fields are missing', async () => {
    await seedDoc('users/alice', {
      displayName: 'Alice',
      displayNameLower: 'alice',
      createdAt: new Date(),
      stats: { ratingsCount: 0, reviewsCount: 0, watchedCount: 0 },
    });

    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(aliceDb, 'users/alice'), {
      lastActiveAt: serverTimestamp(),
    }, { merge: true }));
  });

  it('owner can submit a first title rating batch even if legacy admin flags are missing', async () => {
    await seedDoc('users/alice', {
      displayName: 'Alice',
      displayNameLower: 'alice',
      createdAt: new Date(),
      stats: { ratingsCount: 0, reviewsCount: 0, watchedCount: 0 },
    });

    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    const batch = writeBatch(aliceDb);

    batch.set(doc(aliceDb, 'ratings/alice__title1__title__0__0'), {
      uid: 'alice',
      titleId: 'title1',
      level: 'title',
      season: null,
      episode: null,
      rating: 8,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true });

    batch.set(doc(aliceDb, 'users/alice/library/title1'), {
      titleId: 'title1',
      lastRating: 8,
      ratedAt: serverTimestamp(),
      seenAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
    }, { merge: true });

    // NB: stats.ratingsCount NON viene piu' scritto dal client. I contatori in
    // users/{uid}.stats sono server-owned (trigger recomputeUserStats*, admin SDK)
    // e congelati dalle rules via userServerCountersUnchanged: un client che li
    // incrementa prende PERMISSION_DENIED. Il batch legittimo e' solo
    // rating + proiezione library.

    await assertSucceeds(batch.commit());
  });

  it('owner can submit a season rating with social extras', async () => {
    await seedDoc('users/alice', {
      displayName: 'Alice',
      displayNameLower: 'alice',
      createdAt: new Date(),
      stats: { ratingsCount: 0, reviewsCount: 0, watchedCount: 0 },
    });

    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(aliceDb, 'ratings/alice__title1__season__2__0'), {
      uid: 'alice',
      titleId: 'title1',
      level: 'season',
      season: 2,
      episode: null,
      rating: 8.5,
      reviewText: 'Ottima stagione.',
      watchedWith: [{ id: 'bob', displayName: 'Bob' }],
      watchedWithGroup: { threadId: 'thread1', groupName: 'Amici' },
      mediaUrls: ['https://example.com/photo.jpg'],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true }));
  });

  it('owner can migrate an old title rating to a season rating preserving createdAt', async () => {
    const oldCreatedAt = new Date('2026-05-01T12:00:00.000Z');
    await seedDocs([
      ['users/alice', {
        displayName: 'Alice',
        displayNameLower: 'alice',
        createdAt: new Date(),
        stats: { ratingsCount: 0, reviewsCount: 0, watchedCount: 0 },
      }],
      ['ratings/alice__title1__title__0__0', {
        uid: 'alice',
        titleId: 'title1',
        level: 'title',
        season: null,
        episode: null,
        rating: 9,
        reviewText: 'Voto storico.',
        createdAt: oldCreatedAt,
        updatedAt: oldCreatedAt,
      }],
    ]);

    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(aliceDb, 'ratings/alice__title1__season__3__0'), {
      uid: 'alice',
      titleId: 'title1',
      level: 'season',
      season: 3,
      episode: null,
      rating: 9,
      reviewText: 'Voto storico.',
      createdAt: oldCreatedAt,
      updatedAt: serverTimestamp(),
    }, { merge: false }));
  });

  it('season rating without a season number is rejected', async () => {
    await seedDoc('users/alice', {
      displayName: 'Alice',
      displayNameLower: 'alice',
      createdAt: new Date(),
      stats: { ratingsCount: 0, reviewsCount: 0, watchedCount: 0 },
    });

    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, 'ratings/alice__title1__season__0__0'), {
      uid: 'alice',
      titleId: 'title1',
      level: 'season',
      season: null,
      episode: null,
      rating: 8,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true }));
  });
});

describe('Blocked users subcollection', () => {
  it('owner can block another user', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(aliceDb, 'users/alice/blockedUsers/bob'), {
      blockedUid: 'bob',
      source: 'ios_chat',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
  });

  it('non-owner cannot write another user blocklist', async () => {
    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertFails(setDoc(doc(bobDb, 'users/alice/blockedUsers/charlie'), {
      blockedUid: 'charlie',
      source: 'ios_chat',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
  });
});

describe('Threads invariants', () => {
  it('cannot drop participants on update', async () => {
    const createdAt = serverTimestamp();
    await seedDoc('threads/t1', {
      visibility: 'private',
      createdBy: 'alice',
      participants: ['alice', 'bob'],
      titleId: 'm1',
      contextType: 'dm',
      contextId: 'x',
      groupName: '',
      createdAt,
      lastMessageAt: createdAt,
      lastMessagePreview: '',
      lastSenderUid: 'alice',
      lastMessageId: 'm0',
    });

    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(updateDoc(doc(aliceDb, 'threads/t1'), {
      visibility: 'private',
      createdBy: 'alice',
      participants: ['alice'],
      titleId: 'm1',
      contextType: 'dm',
      contextId: 'x',
      groupName: '',
      createdAt,
      lastMessageAt: createdAt,
      lastMessagePreview: '',
      lastSenderUid: 'alice',
      lastMessageId: 'm0',
    }));
  });

  it('participant can send a message and update thread metadata in one batch', async () => {
    await seedDoc('threads/t_dm', {
      visibility: 'private',
      createdBy: 'alice',
      participants: ['alice', 'bob'],
      titleId: 'm1',
      contextType: 'dm',
      contextId: 'alice_bob',
      groupName: '',
      createdAt: new Date('2026-03-24T10:00:00.000Z'),
      lastMessageAt: null,
      lastMessagePreview: '',
      lastSenderUid: null,
    });

    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    const batch = writeBatch(aliceDb);
    batch.set(doc(aliceDb, 'threads/t_dm/messages/m1'), {
      uid: 'alice',
      displayName: 'Alice',
      text: 'Ciao Bob',
      type: 'text',
      createdAt: serverTimestamp(),
    });
    batch.update(doc(aliceDb, 'threads/t_dm'), {
      lastMessageId: 'm1',
      lastMessageAt: serverTimestamp(),
      lastMessagePreview: 'Ciao Bob',
      lastSenderUid: 'alice',
    });

    await assertSucceeds(batch.commit());
  });

  async function seedGifThread(id) {
    await seedDoc(`threads/${id}`, {
      visibility: 'private',
      createdBy: 'alice',
      participants: ['alice', 'bob'],
      titleId: 'm1',
      contextType: 'dm',
      contextId: 'alice_bob',
      groupName: '',
      createdAt: new Date('2026-03-24T10:00:00.000Z'),
      lastMessageAt: null,
      lastMessagePreview: '',
      lastSenderUid: null,
    });
  }

  it('participant can send a GIF message (type gif, giphy url, empty text)', async () => {
    await seedGifThread('t_gif_ok');
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    const batch = writeBatch(aliceDb);
    batch.set(doc(aliceDb, 'threads/t_gif_ok/messages/m1'), {
      uid: 'alice',
      displayName: 'Alice',
      text: '',
      type: 'gif',
      gifUrl: 'https://media3.giphy.com/media/abc123/giphy.gif',
      createdAt: serverTimestamp(),
    });
    batch.update(doc(aliceDb, 'threads/t_gif_ok'), {
      lastMessageId: 'm1',
      lastMessageAt: serverTimestamp(),
      lastMessagePreview: 'GIF',
      lastSenderUid: 'alice',
    });
    await assertSucceeds(batch.commit());
  });

  it('rejects a GIF message whose url is not on giphy.com', async () => {
    await seedGifThread('t_gif_badhost');
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    const batch = writeBatch(aliceDb);
    batch.set(doc(aliceDb, 'threads/t_gif_badhost/messages/m1'), {
      uid: 'alice',
      displayName: 'Alice',
      text: '',
      type: 'gif',
      gifUrl: 'https://evil.example.com/track.gif',
      createdAt: serverTimestamp(),
    });
    batch.update(doc(aliceDb, 'threads/t_gif_badhost'), {
      lastMessageId: 'm1',
      lastMessageAt: serverTimestamp(),
      lastMessagePreview: 'GIF',
      lastSenderUid: 'alice',
    });
    await assertFails(batch.commit());
  });

  it('rejects a gif-type message without a gifUrl', async () => {
    await seedGifThread('t_gif_missing');
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    const batch = writeBatch(aliceDb);
    batch.set(doc(aliceDb, 'threads/t_gif_missing/messages/m1'), {
      uid: 'alice',
      displayName: 'Alice',
      text: '',
      type: 'gif',
      createdAt: serverTimestamp(),
    });
    batch.update(doc(aliceDb, 'threads/t_gif_missing'), {
      lastMessageId: 'm1',
      lastMessageAt: serverTimestamp(),
      lastMessagePreview: 'GIF',
      lastSenderUid: 'alice',
    });
    await assertFails(batch.commit());
  });

  it('rejects a text-type message carrying a gifUrl', async () => {
    await seedGifThread('t_gif_ontext');
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    const batch = writeBatch(aliceDb);
    batch.set(doc(aliceDb, 'threads/t_gif_ontext/messages/m1'), {
      uid: 'alice',
      displayName: 'Alice',
      text: 'Ciao',
      type: 'text',
      gifUrl: 'https://media3.giphy.com/media/abc123/giphy.gif',
      createdAt: serverTimestamp(),
    });
    batch.update(doc(aliceDb, 'threads/t_gif_ontext'), {
      lastMessageId: 'm1',
      lastMessageAt: serverTimestamp(),
      lastMessagePreview: 'Ciao',
      lastSenderUid: 'alice',
    });
    await assertFails(batch.commit());
  });

  it('participant can read private thread messages', async () => {
    await seedDocs([
      ['threads/t_dm_read', {
        visibility: 'private',
        createdBy: 'alice',
        participants: ['alice', 'bob'],
        titleId: 'm1',
        contextType: 'dm',
        contextId: 'alice_bob',
        groupName: '',
        createdAt: new Date('2026-03-24T10:00:00.000Z'),
        lastMessageAt: new Date('2026-03-24T10:01:00.000Z'),
        lastMessagePreview: 'Ciao',
        lastSenderUid: 'bob',
        lastMessageId: 'm1',
      }],
      ['threads/t_dm_read/messages/m1', {
        uid: 'bob',
        displayName: 'Bob',
        text: 'Ciao',
        type: 'text',
        createdAt: new Date('2026-03-24T10:01:00.000Z'),
      }],
    ]);

    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(getDocs(query(
      collection(aliceDb, 'threads/t_dm_read/messages'),
      orderBy('createdAt', 'asc')
    )));
  });

  it('participant can list own threads from root collection', async () => {
    await seedDocs([
      ['threads/t_list_my', {
        visibility: 'private',
        createdBy: 'alice',
        participants: ['alice', 'bob'],
        titleId: 'm1',
        contextType: 'dm',
        contextId: 'alice_bob',
        groupName: '',
        createdAt: new Date('2026-03-24T10:00:00.000Z'),
        lastMessageAt: new Date('2026-03-24T10:01:00.000Z'),
        lastMessagePreview: 'Ciao',
        lastSenderUid: 'bob',
        lastMessageId: 'm1',
      }],
    ]);

    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(getDocs(query(
      collection(aliceDb, 'threads'),
      where('participants', 'array-contains', 'alice'),
      orderBy('lastMessageAt', 'desc')
    )));
  });

  it('signed-in user can read legacy public thread docs and messages', async () => {
    await seedDocs([
      ['threads/public_legacy_title_1', {
        createdBy: 'alice',
        participants: [],
        titleId: 'm1',
        contextType: 'public',
        contextId: 'global',
        groupName: 'Discussione pubblica',
        createdAt: new Date('2026-03-24T10:00:00.000Z'),
        lastMessageAt: new Date('2026-03-24T10:01:00.000Z'),
        lastMessagePreview: 'Ciao a tutti',
        lastSenderUid: 'alice',
        lastMessageId: 'm1',
      }],
      ['threads/public_legacy_title_1/messages/m1', {
        uid: 'alice',
        displayName: 'Alice',
        text: 'Ciao a tutti',
        type: 'text',
        createdAt: new Date('2026-03-24T10:01:00.000Z'),
      }],
    ]);

    const charlieDb = testEnv.authenticatedContext('charlie').firestore();
    await assertSucceeds(getDoc(doc(charlieDb, 'threads/public_legacy_title_1')));
    await assertSucceeds(getDocs(query(
      collection(charlieDb, 'threads/public_legacy_title_1/messages'),
      orderBy('createdAt', 'asc')
    )));
  });

  it('signed-in user can list public threads from root collection', async () => {
    await seedDocs([
      ['threads/public_list_title_1', {
        visibility: 'public',
        createdBy: 'alice',
        participants: [],
        titleId: 'm1',
        contextType: 'public',
        contextId: 'global',
        groupName: 'Discussione pubblica',
        createdAt: new Date('2026-03-24T10:00:00.000Z'),
        lastMessageAt: new Date('2026-03-24T10:01:00.000Z'),
        lastMessagePreview: 'Ciao a tutti',
        lastSenderUid: 'alice',
        lastMessageId: 'm1',
      }],
    ]);

    const charlieDb = testEnv.authenticatedContext('charlie').firestore();
    await assertSucceeds(getDocs(query(
      collection(charlieDb, 'threads'),
      where('visibility', '==', 'public'),
      orderBy('lastMessageAt', 'desc')
    )));
  });

  it('signed-in user can create season and episode scoped public threads', async () => {
    // Le discussioni di stagione (`public_<titleId>_s<n>`, contextId "s<n>")
    // sono nuove: verifichiamo che le rules le accettino senza modifiche,
    // esattamente come quelle di episodio ("s<n>e<m>") già in produzione.
    const aliceDb = testEnv.authenticatedContext('alice').firestore();

    const seasonThread = {
      visibility: 'public',
      createdBy: 'alice',
      participants: [],
      titleId: 'm1',
      contextType: 'public',
      contextId: 's2',
      groupName: 'Discussione stagione',
      createdAt: serverTimestamp(),
      lastMessageAt: null,
      lastMessagePreview: '',
      lastSenderUid: null,
      lastMessageId: null,
    };

    await assertSucceeds(setDoc(doc(aliceDb, 'threads/public_m1_s2'), seasonThread));
    await assertSucceeds(setDoc(doc(aliceDb, 'threads/public_m1_s2e7'), {
      ...seasonThread,
      contextId: 's2e7',
      groupName: 'Discussione episodio',
    }));

    // Un id fuori dal namespace pubblico resta rifiutato.
    await assertFails(setDoc(doc(aliceDb, 'threads/season_m1_s2'), seasonThread));

    // E chiunque sia loggato può leggerle.
    const charlieDb = testEnv.authenticatedContext('charlie').firestore();
    await assertSucceeds(getDoc(doc(charlieDb, 'threads/public_m1_s2')));
  });

  it('participant cannot rewrite thread metadata without the matching message write', async () => {
    await seedDoc('threads/t_dm_metadata', {
      visibility: 'private',
      createdBy: 'alice',
      participants: ['alice', 'bob'],
      titleId: 'm1',
      contextType: 'dm',
      contextId: 'alice_bob',
      groupName: '',
      createdAt: new Date('2026-03-24T10:00:00.000Z'),
      lastMessageAt: null,
      lastMessagePreview: '',
      lastSenderUid: null,
    });

    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(updateDoc(doc(aliceDb, 'threads/t_dm_metadata'), {
      lastMessageId: 'm1',
      lastMessageAt: serverTimestamp(),
      lastMessagePreview: 'Messaggio fake',
      lastSenderUid: 'alice',
    }));
  });

  it('non participant cannot read or write typing in a private thread', async () => {
    await seedDocs([
      ['threads/t_typing', {
        visibility: 'private',
        createdBy: 'alice',
        participants: ['alice', 'bob'],
        titleId: 'm1',
        contextType: 'dm',
        contextId: 'alice_bob',
        groupName: '',
        createdAt: new Date('2026-03-24T10:00:00.000Z'),
        lastMessageAt: null,
        lastMessagePreview: '',
        lastSenderUid: null,
      }],
      ['threads/t_typing/typing/alice', {
        displayName: 'Alice',
        timestamp: new Date('2026-03-24T10:05:00.000Z'),
      }],
    ]);

    const charlieDb = testEnv.authenticatedContext('charlie').firestore();
    await assertFails(getDoc(doc(charlieDb, 'threads/t_typing/typing/alice')));
    await assertFails(setDoc(doc(charlieDb, 'threads/t_typing/typing/charlie'), {
      displayName: 'Charlie',
      timestamp: serverTimestamp(),
    }));
  });

  it('participant can write typing in a private thread', async () => {
    await seedDoc('threads/t_typing_ok', {
      visibility: 'private',
      createdBy: 'alice',
      participants: ['alice', 'bob'],
      titleId: 'm1',
      contextType: 'dm',
      contextId: 'alice_bob',
      groupName: '',
      createdAt: new Date('2026-03-24T10:00:00.000Z'),
      lastMessageAt: null,
      lastMessagePreview: '',
      lastSenderUid: null,
    });

    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(aliceDb, 'threads/t_typing_ok/typing/alice'), {
      displayName: 'Alice',
      timestamp: serverTimestamp(),
    }));
  });

  it('participant can add a reaction without editing message content', async () => {
    await seedDocs([
      ['threads/t_reactions', {
        visibility: 'private',
        createdBy: 'alice',
        participants: ['alice', 'bob'],
        titleId: 'm1',
        contextType: 'dm',
        contextId: 'alice_bob',
        groupName: '',
        createdAt: new Date('2026-03-24T10:00:00.000Z'),
        lastMessageAt: new Date('2026-03-24T10:01:00.000Z'),
        lastMessagePreview: 'Ciao',
        lastSenderUid: 'bob',
      }],
      ['threads/t_reactions/messages/m1', {
        uid: 'bob',
        displayName: 'Bob',
        text: 'Ciao',
        type: 'text',
        createdAt: new Date('2026-03-24T10:01:00.000Z'),
      }],
    ]);

    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(updateDoc(doc(aliceDb, 'threads/t_reactions/messages/m1'), {
      'reactions.👍': arrayUnion('alice'),
    }));
    await assertSucceeds(updateDoc(doc(aliceDb, 'threads/t_reactions/messages/m1'), {
      'reactions.👍': arrayRemove('alice'),
    }));
  });

  it('participant cannot add or remove another user reaction or change two emojis', async () => {
    await seedDocs([
      ['threads/t_reactions_guarded', {
        visibility: 'private',
        createdBy: 'alice',
        participants: ['alice', 'bob'],
        titleId: 'm1',
        contextType: 'dm',
        contextId: 'alice_bob',
        groupName: '',
        createdAt: new Date('2026-03-24T10:00:00.000Z'),
        lastMessageAt: new Date('2026-03-24T10:01:00.000Z'),
        lastMessagePreview: 'Ciao',
        lastSenderUid: 'alice',
      }],
      ['threads/t_reactions_guarded/messages/m1', {
        uid: 'alice',
        displayName: 'Alice',
        text: 'Ciao',
        type: 'text',
        createdAt: new Date('2026-03-24T10:01:00.000Z'),
        reactions: { '👍': ['alice'], '❤️': [] },
      }],
    ]);

    const bobDb = testEnv.authenticatedContext('bob').firestore();
    const messageRef = doc(bobDb, 'threads/t_reactions_guarded/messages/m1');
    await assertFails(updateDoc(messageRef, {
      'reactions.👍': arrayUnion('charlie'),
    }));
    await assertFails(updateDoc(messageRef, {
      'reactions.👍': arrayRemove('alice'),
    }));
    await assertFails(updateDoc(messageRef, {
      'reactions.👍': arrayUnion('bob'),
      'reactions.❤️': arrayUnion('bob'),
    }));
  });

  it('participant cannot edit another user message body or identity', async () => {
    await seedDocs([
      ['threads/t_messages_lock', {
        visibility: 'private',
        createdBy: 'alice',
        participants: ['alice', 'bob'],
        titleId: 'm1',
        contextType: 'dm',
        contextId: 'alice_bob',
        groupName: '',
        createdAt: new Date('2026-03-24T10:00:00.000Z'),
        lastMessageAt: new Date('2026-03-24T10:01:00.000Z'),
        lastMessagePreview: 'Ciao',
        lastSenderUid: 'bob',
      }],
      ['threads/t_messages_lock/messages/m1', {
        uid: 'bob',
        displayName: 'Bob',
        text: 'Ciao',
        type: 'text',
        createdAt: new Date('2026-03-24T10:01:00.000Z'),
      }],
    ]);

    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(updateDoc(doc(aliceDb, 'threads/t_messages_lock/messages/m1'), {
      displayName: 'Mallory',
    }));
    await assertFails(updateDoc(doc(aliceDb, 'threads/t_messages_lock/messages/m1'), {
      text: 'Messaggio alterato',
    }));
  });
});

describe('Storage peopleAvatars delete', () => {
  it('signed-in user cannot delete', async () => {
    const s = testEnv.authenticatedContext('u1').storage();
    const objRef = ref(s, 'peopleAvatars/p1.jpg');
    await assertFails(deleteObject(objRef));
  });
});

// La library ("Visti") e' contenuto PUBBLICO del profilo: read consentita a
// chiunque sia loggato (firestore.rules library read: isSignedIn). Non e' piu'
// friends-only — la sezione "Visti" e i watchers serie sono visibili in app a
// ogni utente autenticato. Resta negata agli utenti non autenticati.
describe('Library visibility (public to signed-in)', () => {
  it('friend can read library entry', async () => {
    await seedDocs([
      ['users/alice', { displayName: 'Alice' }],
      ['users/bob', { displayName: 'Bob' }],
      ['users/alice/friends/bob', { status: 'accepted', initiatedBy: 'alice' }],
      ['users/bob/friends/alice', { status: 'accepted', initiatedBy: 'alice' }],
      ['users/alice/library/t1', { titleId: 't1', status: 'watched' }],
    ]);

    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertSucceeds(getDoc(doc(bobDb, 'users/alice/library/t1')));
  });

  it('signed-in non-friend can read library entry (public profile content)', async () => {
    await seedDocs([
      ['users/alice', { displayName: 'Alice' }],
      ['users/charlie', { displayName: 'Charlie' }],
      ['users/alice/library/t2', { titleId: 't2', status: 'watched' }],
    ]);

    const charlieDb = testEnv.authenticatedContext('charlie').firestore();
    await assertSucceeds(getDoc(doc(charlieDb, 'users/alice/library/t2')));
  });

  it('unauthenticated user cannot read library entry', async () => {
    await seedDocs([
      ['users/alice', { displayName: 'Alice' }],
      ['users/alice/library/t3', { titleId: 't3', status: 'watched' }],
    ]);

    const anonDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anonDb, 'users/alice/library/t3')));
  });
});

describe('Watchlist titleStates privacy', () => {
  it('owner can write and read personal title state', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(aliceDb, 'users/alice/titleStates/t_movie'), {
      titleId: 't_movie',
      mediaType: 'movie',
      state: 'seen_unrated',
      generalWatchlist: false,
      hasTitleRating: false,
      completedCount: 1,
      watchMinutesContribution: 120,
      schemaVersion: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastInteractionAt: new Date(),
      reminders: {
        ratingReminderEligible: true,
        resumeReminderEligible: false,
      },
      titleSnapshot: {
        titleId: 't_movie',
        name: 'Test Movie',
        mediaType: 'movie',
      },
    }, { merge: true }));

    await assertSucceeds(getDoc(doc(aliceDb, 'users/alice/titleStates/t_movie')));
  });

  it('rejects invalid metrics types on personal title state', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, 'users/alice/titleStates/t_invalid'), {
      titleId: 't_invalid',
      mediaType: 'movie',
      state: 'seen_unrated',
      completedCount: '1',
      watchMinutesContribution: '120',
      schemaVersion: '3',
      updatedAt: new Date(),
    }, { merge: true }));
  });

  it('non-owner cannot read another user title state', async () => {
    await seedDoc('users/alice/titleStates/t_series', {
      titleId: 't_series',
      mediaType: 'tv',
      state: 'in_progress',
      generalWatchlist: true,
    });

    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertFails(getDoc(doc(bobDb, 'users/alice/titleStates/t_series')));
  });
});

describe('Title update preferences', () => {
  it('owner può seguire o silenziare un titolo e leggere la preferenza', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    const ref = doc(aliceDb, 'users/alice/titleUpdatePrefs/ted-lasso');
    await assertSucceeds(setDoc(ref, {
      titleId: 'ted-lasso',
      mode: 'follow',
      updatedAt: new Date(),
    }));
    await assertSucceeds(getDoc(ref));
    await assertSucceeds(setDoc(ref, {
      titleId: 'ted-lasso',
      mode: 'muted',
      updatedAt: new Date(),
    }));
  });

  it('preferenze altrui e payload non validi sono negati', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertFails(setDoc(doc(bobDb, 'users/alice/titleUpdatePrefs/ted-lasso'), {
      titleId: 'ted-lasso', mode: 'follow', updatedAt: new Date(),
    }));
    await assertFails(getDoc(doc(bobDb, 'users/alice/titleUpdatePrefs/ted-lasso')));
    await assertFails(setDoc(doc(aliceDb, 'users/alice/titleUpdatePrefs/ted-lasso'), {
      titleId: 'altro', mode: 'follow', updatedAt: new Date(),
    }));
    await assertFails(setDoc(doc(aliceDb, 'users/alice/titleUpdatePrefs/ted-lasso'), {
      titleId: 'ted-lasso', mode: 'all', updatedAt: new Date(), extra: true,
    }));
  });
});

describe('Viewing history imports (users/{uid}/imports)', () => {
  it('owner can read their own import job doc', async () => {
    await seedDoc('users/alice/imports/imp1', {
      source: 'netflix_csv',
      status: 'completed',
      totalRows: 10,
      processedCount: 10,
    });
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(getDoc(doc(aliceDb, 'users/alice/imports/imp1')));
  });

  it('non-owner cannot read another user import job doc', async () => {
    await seedDoc('users/alice/imports/imp1', {
      source: 'netflix_csv',
      status: 'completed',
    });
    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertFails(getDoc(doc(bobDb, 'users/alice/imports/imp1')));
  });

  it('client cannot write an import job doc directly (server-only, admin SDK)', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, 'users/alice/imports/imp1'), {
      source: 'netflix_csv',
      status: 'completed',
      totalRows: 999999,
    }));
  });

  it('client cannot update an existing import job doc (e.g. forge titleStateIdsWritten)', async () => {
    await seedDoc('users/alice/imports/imp1', {
      source: 'netflix_csv',
      status: 'awaiting_confirmation',
      titleStateIdsWritten: [],
    });
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(updateDoc(doc(aliceDb, 'users/alice/imports/imp1'), {
      status: 'completed',
      titleStateIdsWritten: ['fake_title_id'],
    }));
  });

  it('owner can read import item rows, non-owner cannot', async () => {
    await seedDoc('users/alice/imports/imp1/items/item1', {
      rawTitle: 'Interstellar',
      kind: 'movie',
      resolved: true,
      titleId: 't_movie',
    });
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertSucceeds(getDoc(doc(aliceDb, 'users/alice/imports/imp1/items/item1')));
    await assertFails(getDoc(doc(bobDb, 'users/alice/imports/imp1/items/item1')));
  });

  it('client cannot write import item rows directly (e.g. self-confirm without the callable)', async () => {
    await seedDoc('users/alice/imports/imp1/items/item1', {
      rawTitle: 'Interstellar',
      kind: 'movie',
      resolved: false,
      titleId: null,
    });
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(updateDoc(doc(aliceDb, 'users/alice/imports/imp1/items/item1'), {
      resolved: true,
      titleId: 't_movie',
    }));
  });

  it('owner cannot read or write temporary import payload', async () => {
    await seedDoc('users/alice/imports/imp1/payload/raw', {
      rawCsv: 'Title,Date\nInterstellar,1/1/26',
    });
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(getDoc(doc(aliceDb, 'users/alice/imports/imp1/payload/raw')));
    await assertFails(setDoc(doc(aliceDb, 'users/alice/imports/imp1/payload/raw'), {
      rawCsv: 'Title,Date\nDark,1/1/26',
    }));
  });

  it('no client can read or write server-only previous-state snapshots', async () => {
    await seedDocs([
      ['users/alice/imports/imp1/previousStates/title1', {
        titleId: 'title1',
        existed: true,
        state: { state: 'rated', ratingValue: 8 },
        schemaVersion: 1,
      }],
      ['users/admin', { isAdmin: true }],
    ]);
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    const bobDb = testEnv.authenticatedContext('bob').firestore();
    const adminDb = testEnv.authenticatedContext('admin').firestore();
    const path = 'users/alice/imports/imp1/previousStates/title1';
    await assertFails(getDoc(doc(aliceDb, path)));
    await assertFails(getDoc(doc(bobDb, path)));
    await assertFails(getDoc(doc(adminDb, path)));
    await assertFails(setDoc(doc(aliceDb, path), {
      titleId: 'title1',
      existed: false,
      state: null,
      schemaVersion: 1,
    }));
  });
});

describe('Imported episode views (users/{uid}/episodeViews)', () => {
  const extraEpisode = {
    source: 'tvtime_gdpr',
    importId: 'imp1',
    titleId: 'title1',
    tvdbSeriesId: 401003,
    tvdbEpisodeId: 123456,
    seasonNumber: 0,
    episodeNumber: 1,
    classification: 'special',
    countsTowardProgress: false,
  };

  it('owner can read a server-imported extra episode', async () => {
    await seedDoc('users/alice/episodeViews/extra1', extraEpisode);
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(getDoc(doc(aliceDb, 'users/alice/episodeViews/extra1')));
  });

  it('another user cannot read personal extra episodes', async () => {
    await seedDoc('users/alice/episodeViews/extra1', extraEpisode);
    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertFails(getDoc(doc(bobDb, 'users/alice/episodeViews/extra1')));
  });

  it('clients cannot create, update, or delete extra episode records', async () => {
    await seedDoc('users/alice/episodeViews/extra1', extraEpisode);
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, 'users/alice/episodeViews/extra2'), extraEpisode));
    await assertFails(updateDoc(doc(aliceDb, 'users/alice/episodeViews/extra1'), { countsTowardProgress: true }));
    await assertFails(deleteDoc(doc(aliceDb, 'users/alice/episodeViews/extra1')));
  });
});

describe('Derived ratings (users/{uid}/derivedRatings) — private, server-only', () => {
  const derivedDoc = {
    uid: 'alice',
    titleId: 't_series',
    episodeAgg: { bySeason: { '1': { sum: 16, count: 2 } } },
    season: { '1': { avg: 8, count: 2 } },
    series: { avg: 8, seasonCount: 1, episodeCount: 2 },
  };

  it('owner can read their own derived rating (feeds profile/taste)', async () => {
    await seedDoc('users/alice/derivedRatings/t_series', derivedDoc);
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(getDoc(doc(aliceDb, 'users/alice/derivedRatings/t_series')));
  });

  it('non-owner cannot read another user derived rating', async () => {
    await seedDoc('users/alice/derivedRatings/t_series', derivedDoc);
    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertFails(getDoc(doc(bobDb, 'users/alice/derivedRatings/t_series')));
  });

  it('client cannot create a derived rating (server-only, admin SDK)', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, 'users/alice/derivedRatings/t_series'), derivedDoc));
  });

  it('client cannot update an existing derived rating (no forging a series score)', async () => {
    await seedDoc('users/alice/derivedRatings/t_series', derivedDoc);
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(updateDoc(doc(aliceDb, 'users/alice/derivedRatings/t_series'), {
      series: { avg: 10, seasonCount: 1, episodeCount: 2 },
    }));
  });

  it('client cannot delete a derived rating', async () => {
    await seedDoc('users/alice/derivedRatings/t_series', derivedDoc);
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(deleteDoc(doc(aliceDb, 'users/alice/derivedRatings/t_series')));
  });

  it('signup cannot inflate stats.derivedRatingsCount (must be zero on create)', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, 'users/alice'), {
      displayName: 'Alice',
      displayNameLower: 'alice',
      createdAt: serverTimestamp(),
      stats: { ratingsCount: 0, watchedCount: 0, derivedRatingsCount: 99 },
    }));
  });

  it('signup with derivedRatingsCount zero is accepted', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(aliceDb, 'users/alice'), {
      displayName: 'Alice',
      displayNameLower: 'alice',
      createdAt: serverTimestamp(),
      stats: { ratingsCount: 0, watchedCount: 0, derivedRatingsCount: 0 },
    }));
  });
});

describe('Global import match cache (importMatchCache) — deny-all client', () => {
  it('signed-in user cannot read a cache entry (server-only, admin SDK)', async () => {
    await seedDoc('importMatchCache/abc123', {
      titleId: 't_movie',
      resolvedAsType: 'movie',
      confidence: 1,
      strategy: 'tvdb_id',
      hitCount: 1,
    });
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(getDoc(doc(aliceDb, 'importMatchCache/abc123')));
  });

  it('signed-in user cannot create a cache entry', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, 'importMatchCache/abc123'), {
      titleId: 't_movie',
      resolvedAsType: 'movie',
      confidence: 1,
      strategy: 'tvdb_id',
      hitCount: 1,
    }));
  });

  it('signed-in user cannot update an existing cache entry (e.g. forge titleId)', async () => {
    await seedDoc('importMatchCache/abc123', {
      titleId: 't_movie',
      resolvedAsType: 'movie',
      confidence: 1,
      strategy: 'tvdb_id',
      hitCount: 1,
    });
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(updateDoc(doc(aliceDb, 'importMatchCache/abc123'), {
      titleId: 't_someone_elses_title',
    }));
  });

  it('unauthenticated user cannot read a cache entry', async () => {
    await seedDoc('importMatchCache/abc123', {
      titleId: 't_movie',
      resolvedAsType: 'movie',
      confidence: 1,
      strategy: 'tvdb_id',
      hitCount: 1,
    });
    const anonDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anonDb, 'importMatchCache/abc123')));
  });
});

describe('User lists visibility and editing', () => {
  it('public projection is readable while root membership doc is hidden from strangers', async () => {
    await seedDocs([
      ['users/alice', { displayName: 'Alice' }],
      ['users/charlie', { displayName: 'Charlie' }],
      ['userLists/list_public', {
        title: 'Marvel ordine cronologico',
        ownerUid: 'alice',
        visibility: 'public',
        kind: 'ordered_path',
        memberUids: ['alice'],
        editorUids: [],
        itemTitleIds: ['t1'],
        previewTitleIds: ['t1'],
        itemCount: 1,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }],
      ['publicUserLists/list_public', {
        listId: 'list_public',
        title: 'Marvel ordine cronologico',
        ownerUid: 'alice',
        owner: { uid: 'alice', displayName: 'Alice', photoURL: null },
        visibility: 'public',
        kind: 'ordered_path',
        itemTitleIds: ['t1'],
        previewTitleIds: ['t1'],
        itemCount: 1,
        completedCount: 0,
        followersCount: 0,
        cover: { imageUrl: null, storagePath: null, fallbackTitleIds: ['t1'], accentHex: null },
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }],
      ['userLists/list_public/items/t1', {
        titleId: 't1',
        orderIndex: 1000,
        addedByUid: 'alice',
        addedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }],
    ]);

    const charlieDb = testEnv.authenticatedContext('charlie').firestore();
    await assertFails(getDoc(doc(charlieDb, 'userLists/list_public')));
    await assertSucceeds(getDoc(doc(charlieDb, 'publicUserLists/list_public')));
    await assertSucceeds(getDoc(doc(charlieDb, 'userLists/list_public/items/t1')));
    await assertFails(getDoc(doc(charlieDb, 'userLists/list_public/members/alice')));
    await assertFails(getDoc(doc(charlieDb, 'userLists/list_public/progress/alice')));
    await assertFails(setDoc(doc(charlieDb, 'publicUserLists/list_public'), {
      title: 'hacked',
      visibility: 'public',
    }, { merge: true }));
  });

  it('signed-in user can query public lists from the root collection (legacy iOS <= 1.2.11 compat)', async () => {
    await seedDocs([
      ['userLists/list_public_query', {
        title: 'Liste pubbliche legacy',
        ownerUid: 'alice',
        visibility: 'public',
        kind: 'collection',
        memberUids: ['alice'],
        editorUids: [],
        itemTitleIds: ['t1'],
        previewTitleIds: ['t1'],
        itemCount: 1,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }],
    ]);

    const charlieDb = testEnv.authenticatedContext('charlie').firestore();
    // Query legacy della dashboard watchlist (build <= 1.2.11): deve passare.
    await assertSucceeds(getDocs(query(
      collection(charlieDb, 'userLists'),
      where('visibility', '==', 'public')
    )));
    // Senza filtro visibility la root resta non listabile.
    await assertFails(getDocs(query(collection(charlieDb, 'userLists'))));
    // Le liste shared/private non diventano listabili.
    await assertFails(getDocs(query(
      collection(charlieDb, 'userLists'),
      where('visibility', '==', 'shared')
    )));
    // Non autenticati fuori anche dalla query pubblica.
    const anonDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDocs(query(
      collection(anonDb, 'userLists'),
      where('visibility', '==', 'public')
    )));
  });

  it('private list is hidden from strangers', async () => {
    await seedDocs([
      ['users/alice', { displayName: 'Alice' }],
      ['users/charlie', { displayName: 'Charlie' }],
      ['userLists/list_private', {
        title: 'Sherlock Holmes',
        ownerUid: 'alice',
        visibility: 'private',
        kind: 'collection',
        memberUids: ['alice'],
        editorUids: [],
        itemTitleIds: ['t1'],
        previewTitleIds: ['t1'],
        itemCount: 1,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }],
    ]);

    const charlieDb = testEnv.authenticatedContext('charlie').firestore();
    await assertFails(getDoc(doc(charlieDb, 'userLists/list_private')));
    await assertFails(updateDoc(doc(charlieDb, 'userLists/list_private'), {
      title: 'hacked',
      updatedAt: serverTimestamp(),
    }));
    await assertFails(setDoc(doc(charlieDb, 'userLists/list_private/items/t1'), {
      titleId: 't1',
      orderIndex: 1000,
      addedByUid: 'charlie',
      addedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
  });

  it('owner can change visibility but cannot force membership without accepted invite flow', async () => {
    await seedDocs([
      ['users/alice', { displayName: 'Alice' }],
      ['users/bob', { displayName: 'Bob' }],
      ['userLists/list_owner_visibility', {
        title: 'Owner visibility',
        ownerUid: 'alice',
        visibility: 'private',
        kind: 'collection',
        memberUids: ['alice'],
        editorUids: [],
        viewerUids: [],
        itemTitleIds: [],
        previewTitleIds: [],
        itemCount: 0,
        createdAt: new Date('2026-03-24T10:00:00.000Z'),
        updatedAt: new Date('2026-03-24T10:00:00.000Z'),
      }],
    ]);

    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(updateDoc(doc(aliceDb, 'userLists/list_owner_visibility'), {
      visibility: 'public',
      updatedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(doc(aliceDb, 'userLists/list_owner_visibility'), {
      itemCount: 99,
      itemTitleIds: ['fake'],
      previewTitleIds: ['fake'],
      updatedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(doc(aliceDb, 'userLists/list_owner_visibility'), {
      memberUids: ['alice', 'bob'],
      editorUids: ['bob'],
      updatedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(doc(aliceDb, 'userLists/list_owner_visibility'), {
      title: 'Timestamp forge',
      updatedAt: new Date('2030-01-01T00:00:00.000Z'),
    }));
  });

  it('client cannot create userList with unsupported public fields', async () => {
    await seedDocs([['users/alice', { displayName: 'Alice' }]]);
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, 'userLists/list_secret_field'), {
      title: 'Lista con segreto',
      ownerUid: 'alice',
      visibility: 'public',
      kind: 'collection',
      memberUids: ['alice'],
      editorUids: [],
      viewerUids: [],
      secretNote: 'non pubblico',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
    await assertFails(setDoc(doc(aliceDb, 'userLists/list_slug_forge'), {
      title: 'Lista slug forge',
      ownerUid: 'alice',
      visibility: 'public',
      kind: 'collection',
      memberUids: ['alice'],
      editorUids: [],
      viewerUids: [],
      slug: 'hacked',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
    await assertFails(setDoc(doc(aliceDb, 'userLists/list_saved_by_forge'), {
      title: 'Lista saved forge',
      ownerUid: 'alice',
      visibility: 'public',
      kind: 'collection',
      memberUids: ['alice'],
      editorUids: [],
      viewerUids: [],
      savedByUids: ['bob'],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
  });

  it('editor can update safe shared-list metadata and items, not privacy or summary fields', async () => {
    await seedDocs([
      ['users/alice', { displayName: 'Alice' }],
      ['users/bob', { displayName: 'Bob' }],
      ['userLists/list_shared', {
        title: 'Rewatch con amici',
        ownerUid: 'alice',
        ownerDisplayName: 'Alice',
        visibility: 'shared',
        kind: 'collection',
        memberUids: ['alice', 'bob'],
        editorUids: ['bob'],
        viewerUids: [],
        itemTitleIds: ['t1'],
        previewTitleIds: ['t1'],
        itemCount: 1,
        createdAt: new Date('2026-03-24T10:00:00.000Z'),
        updatedAt: new Date('2026-03-24T10:00:00.000Z'),
      }],
    ]);

    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertSucceeds(updateDoc(doc(bobDb, 'userLists/list_shared'), {
      title: 'Rewatch con amici 2026',
      updatedAt: serverTimestamp(),
    }));
    await assertSucceeds(setDoc(doc(bobDb, 'userLists/list_shared/items/t2'), {
      titleId: 't2',
      orderIndex: 2,
      addedByUid: 'bob',
      addedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
    await assertFails(setDoc(doc(bobDb, 'userLists/list_shared/items/t3'), {
      titleId: 't3',
      orderIndex: 3,
      addedByUid: 'alice',
      addedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(doc(bobDb, 'userLists/list_shared'), {
      visibility: 'public',
      updatedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(doc(bobDb, 'userLists/list_shared'), {
      itemCount: 2,
      itemTitleIds: ['t1', 't2'],
      previewTitleIds: ['t1', 't2'],
      updatedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(doc(bobDb, 'userLists/list_shared'), {
      ownerUid: 'bob',
      updatedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(doc(bobDb, 'userLists/list_shared'), {
      memberUids: ['alice', 'bob', 'charlie'],
      editorUids: ['bob', 'charlie'],
      updatedAt: serverTimestamp(),
    }));
    await assertFails(setDoc(doc(bobDb, 'userLists/list_shared/members/charlie'), {
      uid: 'charlie',
      role: 'editor',
      joinedAt: serverTimestamp(),
    }));
  });

  it('owner can create a public list with items and members in one batch', async () => {
    await seedDoc('users/alice', { displayName: 'Alice' });

    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    const batch = writeBatch(aliceDb);
    batch.set(doc(aliceDb, 'userLists/list_batch_public'), {
      title: 'MCU cronologico',
      ownerUid: 'alice',
      ownerDisplayName: 'Alice',
      visibility: 'public',
      kind: 'ordered_path',
      memberUids: ['alice'],
      editorUids: [],
      viewerUids: [],
      itemTitleIds: [],
      previewTitleIds: [],
      itemCount: 0,
      completedCount: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    batch.set(doc(aliceDb, 'userLists/list_batch_public/items/ironman'), {
      titleId: 'ironman',
      orderIndex: 1000,
      addedByUid: 'alice',
      addedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    batch.set(doc(aliceDb, 'userLists/list_batch_public/members/alice'), {
      uid: 'alice',
      role: 'owner',
      displayName: 'Alice',
      joinedAt: serverTimestamp(),
    });

    await assertSucceeds(batch.commit());
  });

  it('user can pin a public list in own namespace', async () => {
    await seedDocs([
      ['users/alice', { displayName: 'Alice' }],
      ['users/charlie', { displayName: 'Charlie' }],
      ['userLists/list_public_pin', {
        title: 'Saga Skywalker',
        ownerUid: 'alice',
        visibility: 'public',
        kind: 'ordered_path',
        memberUids: ['alice'],
        editorUids: [],
        viewerUids: [],
        itemTitleIds: ['t1'],
        previewTitleIds: ['t1'],
        itemCount: 1,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }],
    ]);

    const charlieDb = testEnv.authenticatedContext('charlie').firestore();
    await assertSucceeds(setDoc(doc(charlieDb, 'users/charlie/savedLists/list_public_pin'), {
      listId: 'list_public_pin',
      isPinned: true,
      pinnedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
  });

  it('user can save personal progress for public lists or lists they are a member of', async () => {
    await seedDocs([
      ['users/alice', { displayName: 'Alice' }],
      ['users/charlie', { displayName: 'Charlie' }],
      ['userLists/list_public_progress', {
        title: 'Marvel order',
        ownerUid: 'alice',
        visibility: 'public',
        kind: 'ordered_path',
        memberUids: ['alice'],
        editorUids: [],
        viewerUids: [],
        itemTitleIds: ['ironman'],
        previewTitleIds: ['ironman'],
        itemCount: 1,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }],
      ['userLists/list_private_progress', {
        title: 'Private order',
        ownerUid: 'alice',
        visibility: 'private',
        kind: 'ordered_path',
        memberUids: ['alice'],
        editorUids: [],
        viewerUids: [],
        itemTitleIds: ['ironman'],
        previewTitleIds: ['ironman'],
        itemCount: 1,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }],
      ['userLists/list_shared_progress', {
        title: 'Shared order',
        ownerUid: 'alice',
        visibility: 'shared',
        kind: 'ordered_path',
        memberUids: ['alice', 'charlie'],
        editorUids: [],
        viewerUids: [],
        itemTitleIds: ['ironman'],
        previewTitleIds: ['ironman'],
        itemCount: 1,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }],
    ]);

    const charlieDb = testEnv.authenticatedContext('charlie').firestore();
    await assertSucceeds(setDoc(doc(charlieDb, 'users/charlie/listProgressEntries/list_public_progress__ironman'), {
      listId: 'list_public_progress',
      titleId: 'ironman',
      mediaType: 'movie',
      state: 'completed',
      completedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      lastInteractionAt: serverTimestamp(),
      watchMinutesContribution: 126,
    }));

    await assertFails(setDoc(doc(charlieDb, 'users/charlie/listProgressEntries/list_private_progress__ironman'), {
      listId: 'list_private_progress',
      titleId: 'ironman',
      mediaType: 'movie',
      state: 'completed',
      completedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      lastInteractionAt: serverTimestamp(),
      watchMinutesContribution: 126,
    }));

    // ...but a MEMBER of a shared/private list CAN track progress on it.
    await assertSucceeds(setDoc(doc(charlieDb, 'users/charlie/listProgressEntries/list_shared_progress__ironman'), {
      listId: 'list_shared_progress',
      titleId: 'ironman',
      mediaType: 'movie',
      state: 'completed',
      completedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      lastInteractionAt: serverTimestamp(),
      watchMinutesContribution: 126,
    }));
  });

  it('cannot create a list with a non-zero followersCount', async () => {
    await seedDocs([['users/alice', { displayName: 'Alice' }]]);
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    const base = {
      title: 'Nuova lista',
      ownerUid: 'alice',
      visibility: 'public',
      kind: 'collection',
      memberUids: ['alice'],
      editorUids: [],
      viewerUids: [],
      itemTitleIds: [],
      previewTitleIds: [],
      itemCount: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    // followersCount inflato in creazione → rifiutato.
    await assertFails(setDoc(doc(aliceDb, 'userLists/list_fc_create_bad'), { ...base, followersCount: 999 }));
    // followersCount == 0 → ok.
    await assertSucceeds(setDoc(doc(aliceDb, 'userLists/list_fc_create_ok'), { ...base, followersCount: 0 }));
  });

  it('non-admin editor cannot bump followersCount on update', async () => {
    // Setup: alice owns a public list, bob is an editor.
    await seedDocs([
      ['users/alice', { displayName: 'Alice' }],
      ['users/bob', { displayName: 'Bob' }],
      ['userLists/list_fc_test', {
        title: 'Lista followersCount test',
        ownerUid: 'alice',
        visibility: 'public',
        kind: 'collection',
        memberUids: ['alice', 'bob'],
        editorUids: ['bob'],
        viewerUids: [],
        itemTitleIds: [],
        previewTitleIds: [],
        itemCount: 0,
        followersCount: 5,
        createdAt: new Date('2026-03-24T10:00:00.000Z'),
        updatedAt: new Date('2026-03-24T10:00:00.000Z'),
      }],
    ]);

    const bobDb = testEnv.authenticatedContext('bob').firestore();

    // Editor can update other fields but CANNOT change followersCount.
    await assertFails(updateDoc(doc(bobDb, 'userLists/list_fc_test'), {
      title: 'Lista followersCount test',
      ownerUid: 'alice',
      visibility: 'public',
      kind: 'collection',
      memberUids: ['alice', 'bob'],
      editorUids: ['bob'],
      viewerUids: [],
      itemTitleIds: ['t1'],
      previewTitleIds: ['t1'],
      itemCount: 1,
      // Trying to bump followersCount from 5 to 6 — must be rejected.
      followersCount: 6,
      createdAt: new Date('2026-03-24T10:00:00.000Z'),
      updatedAt: serverTimestamp(),
    }));
  });

  // Incidente 2026-07-02: le rules deployate imponevano itemTitleIds/
  // previewTitleIds/itemCount/cover tutti vuoti al create, ma l'app iOS
  // v1.2.11 (in TestFlight, live) manda questi campi GIA' POPOLATI quando
  // l'utente crea una lista con titoli gia' selezionati o con una cover ->
  // create bloccata, "errore permessi mancanti" per gli utenti reali.
  // Fix: il contratto stretto (tutto vuoto) resta valido, ma ora e' accettato
  // anche il contratto "legacy" iOS con contenuto popolato dal creatore
  // stesso, purche' internamente coerente (itemCount == itemTitleIds.size(),
  // cap dimensionale, previewTitleIds <= itemTitleIds).
  it('accepts iOS v1.2.11 payload with pre-selected titles at create', async () => {
    await seedDocs([['users/alice', { displayName: 'Alice' }]]);
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(aliceDb, 'userLists/list_ios_with_titles'), {
      title: 'La mia lista serie TV',
      description: null,
      ownerUid: 'alice',
      ownerDisplayName: 'Alice',
      visibility: 'private',
      kind: 'collection',
      memberUids: ['alice'],
      editorUids: [],
      viewerUids: [],
      itemTitleIds: ['title_1', 'title_2'],
      previewTitleIds: ['title_1', 'title_2'],
      itemCount: 2,
      followersCount: 0,
      savedByUids: [],
      cover: { imageUrl: null, storagePath: null, fallbackTitleIds: [], accentHex: null },
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
  });

  it('accepts iOS v1.2.11 payload with a cover image at create', async () => {
    await seedDocs([['users/alice', { displayName: 'Alice' }]]);
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(aliceDb, 'userLists/list_ios_with_cover'), {
      title: 'La mia lista serie TV',
      description: null,
      ownerUid: 'alice',
      ownerDisplayName: 'Alice',
      visibility: 'private',
      kind: 'collection',
      memberUids: ['alice'],
      editorUids: [],
      viewerUids: [],
      itemTitleIds: [],
      previewTitleIds: [],
      itemCount: 0,
      followersCount: 0,
      savedByUids: [],
      cover: {
        imageUrl: 'https://image.tmdb.org/cover.jpg',
        storagePath: null,
        fallbackTitleIds: [],
        accentHex: null,
      },
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
  });

  it('still accepts the strict empty contract at create (regression)', async () => {
    await seedDocs([['users/alice', { displayName: 'Alice' }]]);
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(aliceDb, 'userLists/list_strict_contract'), {
      title: 'Lista vuota',
      description: null,
      ownerUid: 'alice',
      ownerDisplayName: 'Alice',
      visibility: 'private',
      kind: 'collection',
      memberUids: ['alice'],
      editorUids: [],
      viewerUids: [],
      itemTitleIds: [],
      previewTitleIds: [],
      itemCount: 0,
      followersCount: 0,
      savedByUids: [],
      cover: { imageUrl: null, storagePath: null, fallbackTitleIds: [], accentHex: null },
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
  });

  it('rejects create with itemCount inconsistent with itemTitleIds.size()', async () => {
    await seedDocs([['users/alice', { displayName: 'Alice' }]]);
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, 'userLists/list_bad_itemcount'), {
      title: 'Lista incoerente',
      ownerUid: 'alice',
      visibility: 'private',
      kind: 'collection',
      memberUids: ['alice'],
      editorUids: [],
      viewerUids: [],
      itemTitleIds: ['title_1', 'title_2'],
      previewTitleIds: ['title_1'],
      itemCount: 99,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
  });

  it('rejects create with followersCount > 0 even with populated titles', async () => {
    await seedDocs([['users/alice', { displayName: 'Alice' }]]);
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, 'userLists/list_bad_followers'), {
      title: 'Lista con followers forzati',
      ownerUid: 'alice',
      visibility: 'private',
      kind: 'collection',
      memberUids: ['alice'],
      editorUids: [],
      viewerUids: [],
      itemTitleIds: ['title_1'],
      previewTitleIds: ['title_1'],
      itemCount: 1,
      followersCount: 42,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
  });

  it('rejects create with a client-set slug', async () => {
    await seedDocs([['users/alice', { displayName: 'Alice' }]]);
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, 'userLists/list_bad_slug'), {
      title: 'Lista con slug forgiato',
      ownerUid: 'alice',
      visibility: 'private',
      kind: 'collection',
      memberUids: ['alice'],
      editorUids: [],
      viewerUids: [],
      itemTitleIds: ['title_1'],
      previewTitleIds: ['title_1'],
      itemCount: 1,
      slug: 'hacked-slug',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
  });

  it('rejects create with editorial=true set by the client', async () => {
    await seedDocs([['users/alice', { displayName: 'Alice' }]]);
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, 'userLists/list_bad_editorial'), {
      title: 'Lista editoriale forgiata',
      ownerUid: 'alice',
      visibility: 'private',
      kind: 'collection',
      memberUids: ['alice'],
      editorUids: [],
      viewerUids: [],
      itemTitleIds: ['title_1'],
      previewTitleIds: ['title_1'],
      itemCount: 1,
      editorial: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
  });
});

describe('List covers storage', () => {
  it('editor cannot upload cover directly because list covers are backend-managed', async () => {
    await seedDocs([
      ['users/alice', { displayName: 'Alice' }],
      ['users/bob', { displayName: 'Bob' }],
      ['userLists/list_cover_shared', {
        title: 'Star Wars',
        ownerUid: 'alice',
        visibility: 'shared',
        kind: 'collection',
        memberUids: ['alice', 'bob'],
        editorUids: ['bob'],
        itemTitleIds: [],
        previewTitleIds: [],
        itemCount: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }],
    ]);

    const s = testEnv.authenticatedContext('bob').storage();
    const objRef = ref(s, 'listCovers/list_cover_shared/cover.jpg');
    await assertFails(uploadBytes(
      objRef,
      Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
      { contentType: 'image/jpeg' }
    ));
  });

  it('stranger cannot upload cover for someone else list', async () => {
    await seedDocs([
      ['users/alice', { displayName: 'Alice' }],
      ['users/charlie', { displayName: 'Charlie' }],
      ['userLists/list_cover_private', {
        title: 'LOTR',
        ownerUid: 'alice',
        visibility: 'private',
        kind: 'collection',
        memberUids: ['alice'],
        editorUids: [],
        itemTitleIds: [],
        previewTitleIds: [],
        itemCount: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }],
    ]);

    const s = testEnv.authenticatedContext('charlie').storage();
    const objRef = ref(s, 'listCovers/list_cover_private/cover.jpg');
    await assertFails(uploadBytes(
      objRef,
      Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
      { contentType: 'image/jpeg' }
    ));
  });
});

describe('Recommendations visibility', () => {
  it('only sender/recipient can read', async () => {
    await seedDoc('recommendations/r1', {
      fromUid: 'alice',
      toUid: 'bob',
      titleId: 't1',
      status: 'unread',
      createdAt: serverTimestamp(),
    });

    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertSucceeds(getDoc(doc(bobDb, 'recommendations/r1')));

    const charlieDb = testEnv.authenticatedContext('charlie').firestore();
    await assertFails(getDoc(doc(charlieDb, 'recommendations/r1')));
  });

  it('sender can link a thread but cannot tamper recommendation payload', async () => {
    await seedDoc('recommendations/r2', {
      fromUid: 'alice',
      toUid: 'bob',
      titleId: 't1',
      message: 'Guardalo',
      status: 'unread',
      threadId: null,
      viewedAt: null,
      createdAt: new Date('2026-03-24T10:00:00.000Z'),
    });

    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(updateDoc(doc(aliceDb, 'recommendations/r2'), {
      threadId: 'dm_t1_alice_bob',
    }));
    await assertFails(updateDoc(doc(aliceDb, 'recommendations/r2'), {
      titleId: 't999',
    }));
  });

  it('recipient can mark recommendation as seen but cannot change titleId', async () => {
    await seedDoc('recommendations/r3', {
      fromUid: 'alice',
      toUid: 'bob',
      titleId: 't1',
      message: 'Guardalo',
      status: 'unread',
      threadId: 'dm_t1_alice_bob',
      viewedAt: null,
      createdAt: new Date('2026-03-24T10:00:00.000Z'),
    });

    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertSucceeds(updateDoc(doc(bobDb, 'recommendations/r3'), {
      status: 'seen',
      viewedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(doc(bobDb, 'recommendations/r3'), {
      titleId: 't999',
    }));
  });
});

describe('Ratings create (iOS v1.2.11 payload compatibility)', () => {
  // Verifica dell'incidente 2026-07-02: oltre a userLists (fixato sopra), era
  // stato ipotizzato che anche submitRating() dell'app iOS v1.2.11 fosse
  // bloccato dalle rules live. Verificato in emulatore: il payload esatto di
  // TitleRepository.submitRating (incl. reviewText/foto/watchedWith/
  // watchedWithGroup) passa senza modifiche alle rules. Questo test blocca
  // eventuali regressioni future su questo percorso.
  it('accepts a simple title-level rating with no review', async () => {
    await seedDocs([['users/alice', { displayName: 'Alice' }]]);
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(aliceDb, 'ratings/alice__title_1__title__0__0'), {
      uid: 'alice',
      titleId: 'title_1',
      level: 'title',
      season: null,
      episode: null,
      rating: 8,
      updatedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
    }));
  });

  it('accepts a full season-level rating with review, photo, watchedWith and group', async () => {
    await seedDocs([
      ['users/alice', { displayName: 'Alice' }],
      ['users/bob', { displayName: 'Bob' }],
    ]);
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(aliceDb, 'ratings/alice__title_2__season__2__0'), {
      uid: 'alice',
      titleId: 'title_2',
      level: 'season',
      season: 2,
      episode: null,
      rating: 9,
      reviewText: 'Bellissima stagione, i personaggi sono cresciuti tantissimo.',
      reviewPhotoUrl: 'https://firebasestorage.googleapis.com/reviewPhotos/alice/title_2/123_0_abc.jpg',
      mediaUrls: ['https://firebasestorage.googleapis.com/reviewPhotos/alice/title_2/123_0_abc.jpg'],
      watchedWith: [{ uid: 'bob', displayName: 'Bob' }],
      watchedWithGroup: { threadId: 'thread_1', groupName: 'Serata amici' },
      updatedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
    }));
  });
});

describe('Rating feed thread invariants', () => {
  it('clients cannot create ratingFeed root docs directly', async () => {
    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertFails(setDoc(doc(bobDb, 'ratingFeed/rating::alice::t1'), {
      eventId: 'rating::alice::t1',
      ratingId: 'r1',
      actorUid: 'alice',
      titleId: 't1',
      level: 'title',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
  });

  it('signed-in users can like and comment only when the ratingFeed parent exists', async () => {
    await seedDoc('ratingFeed/rating::alice::t1', {
      eventId: 'rating::alice::t1',
      ratingId: 'r1',
      actorUid: 'alice',
      titleId: 't1',
      level: 'title',
      createdAt: new Date('2026-03-24T10:00:00.000Z'),
      updatedAt: new Date('2026-03-24T10:00:00.000Z'),
    });

    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertSucceeds(setDoc(doc(bobDb, 'ratingFeed/rating::alice::t1/likes/bob'), {
      uid: 'bob',
      createdAt: serverTimestamp(),
    }));
    await assertSucceeds(setDoc(doc(bobDb, 'ratingFeed/rating::alice::t1/comments/c1'), {
      uid: 'bob',
      authorName: 'Bob',
      text: 'Gran titolo',
      createdAt: serverTimestamp(),
    }));
  });

  it('ratingFeed comments accept optional authorAvatarURL for review threads', async () => {
    await seedDoc('ratingFeed/rating::alice::t1b', {
      eventId: 'rating::alice::t1b',
      ratingId: 'r1b',
      actorUid: 'alice',
      titleId: 't1b',
      level: 'title',
      createdAt: new Date('2026-03-24T10:00:00.000Z'),
      updatedAt: new Date('2026-03-24T10:00:00.000Z'),
    });

    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertSucceeds(setDoc(doc(bobDb, 'ratingFeed/rating::alice::t1b/comments/c1'), {
      uid: 'bob',
      authorName: 'Bob',
      authorAvatarURL: 'https://example.com/avatar.png',
      text: 'Commento dalla recensione',
      createdAt: serverTimestamp(),
    }));
  });

  it('orphaned ratingFeed likes and comments are hidden and immutable', async () => {
    await seedDocs([
      ['ratingFeed/rating::alice::t2/comments/c1', {
        uid: 'alice',
        authorName: 'Alice',
        text: 'Legacy rating comment',
        createdAt: new Date('2026-03-24T10:00:00.000Z'),
      }],
      ['ratingFeed/rating::alice::t2/likes/alice', {
        uid: 'alice',
        createdAt: new Date('2026-03-24T10:00:00.000Z'),
      }],
    ]);

    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertFails(getDocs(collection(bobDb, 'ratingFeed', 'rating::alice::t2', 'comments')));
    await assertFails(getDoc(doc(bobDb, 'ratingFeed/rating::alice::t2/likes/alice')));
    await assertFails(setDoc(doc(bobDb, 'ratingFeed/rating::alice::t2/likes/bob'), {
      uid: 'bob',
      createdAt: serverTimestamp(),
    }));
  });

  it('malformed ratingFeed comments are rejected even when the parent exists', async () => {
    await seedDoc('ratingFeed/rating::alice::t3', {
      eventId: 'rating::alice::t3',
      ratingId: 'r3',
      actorUid: 'alice',
      titleId: 't3',
      level: 'title',
      createdAt: new Date('2026-03-24T10:00:00.000Z'),
      updatedAt: new Date('2026-03-24T10:00:00.000Z'),
    });

    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertFails(setDoc(doc(bobDb, 'ratingFeed/rating::alice::t3/comments/c1'), {
      uid: 'bob',
      authorName: 'Bob',
      text: 'ok',
      createdAt: serverTimestamp(),
      extra: true,
    }));
  });
});

describe('Experiments flags', () => {
  it('anyone can read experiments/global', async () => {
    await seedDoc('experiments/global', {
      flags: { match_hide_guide: true },
      experiments: { match_deck_variant: { enabled: true, variant: 'dense', rollout: 50 } },
    });

    const anonDb = testEnv.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(anonDb, 'experiments/global')));
  });

  it('non-admin cannot write experiments/global', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, 'experiments/global'), {
      flags: { onboarding_new: true },
    }, { merge: true }));
  });

  it('admin can write experiments/global', async () => {
    await seedDoc('users/admin', {
      displayName: 'Admin',
      isAdmin: true,
      trusted: true,
    });

    const adminUserDb = testEnv.authenticatedContext('admin').firestore();
    await assertSucceeds(setDoc(doc(adminUserDb, 'experiments/global'), {
      flags: { onboarding_new: true },
      experiments: { match_deck_variant: { enabled: true, variant: 'lean', rollout: 100 } },
    }, { merge: true }));
  });
});

describe('Feed events visibility', () => {
  it('owner can read own feed event', async () => {
    await seedDoc('feedEvents/e1', {
      ownerUid: 'alice',
      actorUid: 'bob',
      eventType: 'post',
      createdAt: serverTimestamp(),
    });

    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(getDoc(doc(aliceDb, 'feedEvents/e1')));
  });

  it('non-owner cannot read feed event', async () => {
    await seedDoc('feedEvents/e2', {
      ownerUid: 'alice',
      actorUid: 'bob',
      eventType: 'post',
      createdAt: serverTimestamp(),
    });

    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertFails(getDoc(doc(bobDb, 'feedEvents/e2')));
  });
});

describe('Posts comments visibility', () => {
  it('signed-in users can query only public official posts linked to a title', async () => {
    await seedDocs([
      ['posts/official_public', {
        authorUid: 'somto_official', authorName: 'Somto', kind: 'post', text: 'Trailer',
        visibility: 'public', isOfficialUpdate: true, linkedTitleIds: ['ted-lasso'],
        createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      }],
      ['posts/official_private', {
        authorUid: 'somto_official', authorName: 'Somto', kind: 'post', text: 'Bozza',
        visibility: 'private', isOfficialUpdate: true, linkedTitleIds: ['ted-lasso'],
        createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      }],
    ]);
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    const snap = await assertSucceeds(getDocs(query(
      collection(aliceDb, 'posts'),
      where('linkedTitleIds', 'array-contains', 'ted-lasso'),
      where('visibility', '==', 'public'),
    )));
    assert.equal(snap.size, 1);
  });

  it('regular clients cannot spoof official update fields on posts', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, 'posts/spoof_official'), {
      authorUid: 'alice',
      authorName: 'Alice',
      kind: 'post',
      text: 'Finto aggiornamento ufficiale',
      visibility: 'public',
      isOfficialUpdate: true,
      officialUpdate: { slug: 'fake', updateType: 'announcement' },
      linkedTitleIds: ['title_1'],
      skipAutoFeedFanout: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
  });

  it('regular clients cannot forge comment-echo posts', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, 'posts/tm_fake'), {
      authorUid: 'alice',
      authorName: 'Alice',
      kind: 'post',
      text: 'Finto commento su un episodio',
      visibility: 'public',
      titleId: 'ted-lasso',
      sourceKind: 'thread_message',
      sourceThreadId: 'public_ted-lasso_s3e7',
      sourceMessageId: 'm1',
      spoilerScope: { titleId: 'ted-lasso', level: 'episode', season: 3, episode: 7 },
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
  });

  it('clients cannot create posts with the reserved "comment" visibility', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, 'posts/fake_comment_vis'), {
      authorUid: 'alice',
      authorName: 'Alice',
      kind: 'post',
      text: 'Provo a passare per un commento',
      visibility: 'comment',
      titleId: 'ted-lasso',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
  });

  it('post authors cannot strip the server fields off a comment-echo post', async () => {
    await seedDocs([
      ['posts/tm_echo', {
        authorUid: 'alice', authorName: 'Alice', kind: 'post', text: 'Che episodio',
        visibility: 'comment', titleId: 'ted-lasso',
        sourceKind: 'thread_message', sourceThreadId: 'public_ted-lasso_s3e7', sourceMessageId: 'm1',
        spoilerScope: { titleId: 'ted-lasso', level: 'episode', season: 3, episode: 7 },
        skipAutoFeedFanout: true,
        createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      }],
    ]);
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    // Update che rimuove i campi server (setDoc senza merge) → deve fallire.
    await assertFails(setDoc(doc(aliceDb, 'posts/tm_echo'), {
      authorUid: 'alice',
      authorName: 'Alice',
      kind: 'post',
      text: 'Testo riscritto',
      visibility: 'public',
      titleId: 'ted-lasso',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
  });

  it('signed-in users can read comment-echo posts and query them by title', async () => {
    await seedDocs([
      ['posts/tm_echo_public', {
        authorUid: 'alice', authorName: 'Alice', kind: 'post', text: 'Che episodio',
        visibility: 'comment', titleId: 'ted-lasso',
        sourceKind: 'thread_message', sourceThreadId: 'public_ted-lasso_s3e7', sourceMessageId: 'm1',
        spoilerScope: { titleId: 'ted-lasso', level: 'episode', season: 3, episode: 7 },
        skipAutoFeedFanout: true,
        createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      }],
    ]);
    const bobDb = testEnv.authenticatedContext('bob').firestore();
    const snap = await assertSucceeds(getDocs(query(
      collection(bobDb, 'posts'),
      where('visibility', '==', 'comment'),
      where('titleId', 'in', ['ted-lasso']),
    )));
    assert.equal(snap.size, 1);

    // I client vecchi (iOS sullo Store) interrogano "public": gli eco non
    // devono comparire lì, altrimenti li mostrerebbero senza gate.
    const publicSnap = await assertSucceeds(getDocs(query(
      collection(bobDb, 'posts'),
      where('visibility', '==', 'public'),
      where('titleId', 'in', ['ted-lasso']),
    )));
    assert.equal(publicSnap.size, 0);
  });

  it('comments and likes inherit private post visibility', async () => {
    await seedDocs([
      ['posts/p1', {
        authorUid: 'alice',
        authorName: 'Alice',
        kind: 'post',
        text: 'Secret post',
        visibility: 'private',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }],
      ['posts/p1/likes/alice', {
        uid: 'alice',
        createdAt: serverTimestamp(),
      }],
      ['posts/p1/comments/c1', {
        uid: 'alice',
        authorName: 'Alice',
        text: 'Hidden thread',
        createdAt: serverTimestamp(),
      }],
      ['posts/p1/comments/c1/likes/bob', {
        uid: 'bob',
        createdAt: serverTimestamp(),
      }],
    ]);

    const anonDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDocs(collection(anonDb, 'posts', 'p1', 'comments')));
    await assertFails(getDoc(doc(anonDb, 'posts/p1/likes/alice')));
    await assertFails(getDoc(doc(anonDb, 'posts/p1/comments/c1/likes/bob')));
  });

  it('orphaned post comments are hidden without the parent post document', async () => {
    await seedDocs([
      ['posts/orphan/comments/c1', {
        uid: 'alice',
        authorName: 'Alice',
        text: 'Legacy comment',
        createdAt: serverTimestamp(),
      }],
      ['posts/orphan/comments/c1/likes/alice', {
        uid: 'alice',
        createdAt: serverTimestamp(),
      }],
    ]);

    const anonDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDocs(collection(anonDb, 'posts', 'orphan', 'comments')));
    await assertFails(getDoc(doc(anonDb, 'posts/orphan/comments/c1/likes/alice')));
  });
});

describe('Guided profiles', () => {
  async function seedRealUser(uid) {
    await seedDoc(`users/${uid}`, {
      displayName: uid,
      displayNameLower: uid,
      photoURL: '',
      avatarURL: '',
      trusted: false,
      isAdmin: false,
      level: 'base',
      createdAt: new Date(),
      stats: { ratingsCount: 0, reviewsCount: 0, watchedCount: 0 },
    });
  }

  it('owner cannot self-promote to guided_profile', async () => {
    await seedRealUser('alice');
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, 'users/alice'), {
      accountType: 'guided_profile',
    }, { merge: true }));
  });

  it('owner cannot set isSynthetic on own doc', async () => {
    await seedRealUser('alice');
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, 'users/alice'), {
      isSynthetic: true,
    }, { merge: true }));
  });

  it('client cannot create own user doc as guided_profile', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, 'users/alice'), {
      displayName: 'Alice',
      displayNameLower: 'alice',
      trusted: false,
      isAdmin: false,
      level: 'base',
      accountType: 'guided_profile',
      isSynthetic: true,
      stats: { ratingsCount: 0, reviewsCount: 0, watchedCount: 0 },
    }));
  });

  it('owner can still update own doc when guided fields stay default', async () => {
    await seedRealUser('alice');
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(aliceDb, 'users/alice'), {
      lastActiveAt: serverTimestamp(),
    }, { merge: true }));
  });

  it('guided control/config collections are not client-readable', async () => {
    await seedDocs([
      ['guidedProfiles/guided_x', { uid: 'guided_x', status: 'active' }],
      ['appConfig/guidedProfiles', { enableGuidedProfiles: false }],
      ['guidedContentDrafts/d1', { status: 'draft' }],
      ['guidedProfileRuns/r1', { dryRun: true }],
      ['guidedDmAttempts/a1', { threadId: 't1' }],
    ]);
    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertFails(getDoc(doc(bobDb, 'guidedProfiles/guided_x')));
    await assertFails(getDoc(doc(bobDb, 'appConfig/guidedProfiles')));
    await assertFails(getDoc(doc(bobDb, 'guidedContentDrafts/d1')));
    await assertFails(getDoc(doc(bobDb, 'guidedProfileRuns/r1')));
    await assertFails(getDoc(doc(bobDb, 'guidedDmAttempts/a1')));
  });

  it('clients cannot write guided control collections', async () => {
    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertFails(setDoc(doc(bobDb, 'guidedProfiles/guided_x'), { status: 'active' }));
    await assertFails(setDoc(doc(bobDb, 'appConfig/guidedProfiles'), { killSwitch: false }));
  });

  it('admin can read guided control docs but still cannot write them', async () => {
    await seedDoc('users/admin', {
      displayName: 'Admin', displayNameLower: 'admin', isAdmin: true, trusted: true,
      level: 'doctor', createdAt: new Date(),
      stats: { ratingsCount: 0, reviewsCount: 0, watchedCount: 0 },
    });
    await seedDoc('guidedProfiles/guided_x', { uid: 'guided_x', status: 'active' });
    const adminDb = testEnv.authenticatedContext('admin').firestore();
    await assertSucceeds(getDoc(doc(adminDb, 'guidedProfiles/guided_x')));
    // write resta server-only anche per admin (allow write: if false)
    await assertFails(setDoc(doc(adminDb, 'guidedProfiles/guided_x'), { status: 'paused' }, { merge: true }));
  });
});

describe('Official updates (sistema editoriale)', () => {
  it('admin can read officialUpdates, nobody can write client-side', async () => {
    await seedDoc('users/admin', {
      displayName: 'Admin', displayNameLower: 'admin', isAdmin: true, trusted: true,
      level: 'doctor', createdAt: new Date(),
      stats: { ratingsCount: 0, reviewsCount: 0, watchedCount: 0 },
    });
    await seedDoc('officialUpdates/test-update', {
      slug: 'test-update', title: 'Test', status: 'published', authorUid: 'somto_official',
    });

    const adminDb = testEnv.authenticatedContext('admin').firestore();
    await assertSucceeds(getDoc(doc(adminDb, 'officialUpdates/test-update')));
    await assertFails(setDoc(doc(adminDb, 'officialUpdates/test-update'), { status: 'draft' }, { merge: true }));

    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertFails(getDoc(doc(bobDb, 'officialUpdates/test-update')));
    await assertFails(setDoc(doc(bobDb, 'officialUpdates/nuovo'), { title: 'x' }));

    const anonDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anonDb, 'officialUpdates/test-update')));
  });
});

describe('Title update events (timeline pubblica)', () => {
  const publishedEvent = {
    schemaVersion: 1,
    titleId: 'ted-lasso',
    eventType: 'trailer',
    status: 'published',
    source: 'tmdb',
    sourceId: 'youtube-1',
    sortAt: new Date('2026-08-01T10:00:00Z'),
  };

  it('published è pubblico, draft e retired restano privati', async () => {
    await seedDocs([
      ['titleUpdateEvents/published', publishedEvent],
      ['titleUpdateEvents/draft', { ...publishedEvent, status: 'draft', sourceId: 'youtube-2' }],
      ['titleUpdateEvents/retired', { ...publishedEvent, status: 'retired', sourceId: 'youtube-3' }],
    ]);

    const anonDb = testEnv.unauthenticatedContext().firestore();
    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertSucceeds(getDoc(doc(anonDb, 'titleUpdateEvents/published')));
    await assertSucceeds(getDoc(doc(bobDb, 'titleUpdateEvents/published')));
    await assertFails(getDoc(doc(anonDb, 'titleUpdateEvents/draft')));
    await assertFails(getDoc(doc(bobDb, 'titleUpdateEvents/retired')));
  });

  it('query pubblica deve vincolare status published', async () => {
    await seedDocs([
      ['titleUpdateEvents/published', publishedEvent],
      ['titleUpdateEvents/draft', { ...publishedEvent, status: 'draft', sourceId: 'youtube-2' }],
    ]);
    const anonDb = testEnv.unauthenticatedContext().firestore();

    await assertSucceeds(getDocs(query(
      collection(anonDb, 'titleUpdateEvents'),
      where('titleId', '==', 'ted-lasso'),
      where('status', '==', 'published'),
      orderBy('sortAt', 'desc')
    )));
    await assertFails(getDocs(query(
      collection(anonDb, 'titleUpdateEvents'),
      where('titleId', '==', 'ted-lasso'),
      orderBy('sortAt', 'desc')
    )));
  });

  it('admin legge le bozze ma nessun client può scrivere', async () => {
    await seedDocs([
      ['users/admin', {
        displayName: 'Admin', displayNameLower: 'admin', isAdmin: true, trusted: true,
        level: 'doctor', createdAt: new Date(),
        stats: { ratingsCount: 0, reviewsCount: 0, watchedCount: 0 },
      }],
      ['titleUpdateEvents/draft', { ...publishedEvent, status: 'draft' }],
    ]);
    const adminDb = testEnv.authenticatedContext('admin').firestore();
    const bobDb = testEnv.authenticatedContext('bob').firestore();
    const anonDb = testEnv.unauthenticatedContext().firestore();

    await assertSucceeds(getDoc(doc(adminDb, 'titleUpdateEvents/draft')));
    await assertSucceeds(getDocs(query(collection(adminDb, 'titleUpdateEvents'))));
    await assertFails(setDoc(doc(adminDb, 'titleUpdateEvents/new'), publishedEvent));
    await assertFails(setDoc(doc(bobDb, 'titleUpdateEvents/new'), publishedEvent));
    await assertFails(setDoc(doc(anonDb, 'titleUpdateEvents/new'), publishedEvent));
    await assertFails(updateDoc(doc(adminDb, 'titleUpdateEvents/draft'), { status: 'published' }));
    await assertFails(deleteDoc(doc(adminDb, 'titleUpdateEvents/draft')));
  });
});

describe('Client errors (osservabilità web minima)', () => {
  const validClientErrorDoc = (uid) => ({
    uid,
    message: 'TypeError: something failed',
    source: '/js/pages/home.page.js',
    line: 42,
    col: 7,
    stack: 'TypeError: something failed\n  at foo (home.page.js:42:7)',
    page: '/home.html?foo=bar',
    ua: 'Mozilla/5.0 (test)',
    createdAt: serverTimestamp(),
    expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
  });

  it('signed-in user can create own clientErrors doc', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(aliceDb, 'clientErrors/e1'), validClientErrorDoc('alice')));
  });

  it('create fails when uid does not match the caller', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, 'clientErrors/e2'), validClientErrorDoc('bob')));
  });

  it('create fails with an unknown extra field', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, 'clientErrors/e3'), {
      ...validClientErrorDoc('alice'),
      extra: 'not allowed',
    }));
  });

  it('create fails with an oversized message', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, 'clientErrors/e4'), {
      ...validClientErrorDoc('alice'),
      message: 'x'.repeat(501),
    }));
  });

  it('non-admin signed-in user cannot read clientErrors', async () => {
    await seedDoc('clientErrors/e5', validClientErrorDoc('alice'));
    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertFails(getDoc(doc(bobDb, 'clientErrors/e5')));
    // owner is not exempt either — read is admin-only
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(getDoc(doc(aliceDb, 'clientErrors/e5')));
  });

  it('admin can read clientErrors', async () => {
    await seedDoc('users/admin', {
      displayName: 'Admin', displayNameLower: 'admin', isAdmin: true, trusted: true,
      level: 'doctor', createdAt: new Date(),
      stats: { ratingsCount: 0, reviewsCount: 0, watchedCount: 0 },
    });
    await seedDoc('clientErrors/e6', validClientErrorDoc('alice'));
    const adminDb = testEnv.authenticatedContext('admin').firestore();
    await assertSucceeds(getDoc(doc(adminDb, 'clientErrors/e6')));
  });

  it('unauthenticated user cannot create clientErrors', async () => {
    const anonDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(anonDb, 'clientErrors/e7'), validClientErrorDoc('anon')));
  });

  it('nobody can update or delete a clientErrors doc client-side', async () => {
    await seedDoc('clientErrors/e8', validClientErrorDoc('alice'));
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, 'clientErrors/e8'), { message: 'edited' }, { merge: true }));
    await assertFails(deleteDoc(doc(aliceDb, 'clientErrors/e8')));
  });
});

describe('Title emotions (post-visione)', () => {
  const validEmotionDoc = () => ({
    uid: 'alice',
    titleId: 'title1',
    level: 'title',
    season: null,
    episode: null,
    emotions: ['touched', 'thrilled'],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  it('owner can create, update and delete own emotion doc', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    const path = 'titleEmotions/alice__title1__title__0__0';
    await assertSucceeds(setDoc(doc(aliceDb, path), validEmotionDoc()));
    await assertSucceeds(setDoc(doc(aliceDb, path), {
      ...validEmotionDoc(),
      emotions: ['amused'],
    }, { merge: true }));
    await assertSucceeds(deleteDoc(doc(aliceDb, path)));
  });

  it('signed-in stranger can read, guest cannot', async () => {
    await seedDoc('titleEmotions/alice__title1__title__0__0', validEmotionDoc());
    const bobDb = testEnv.authenticatedContext('bob').firestore();
    const anonDb = testEnv.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(bobDb, 'titleEmotions/alice__title1__title__0__0')));
    await assertFails(getDoc(doc(anonDb, 'titleEmotions/alice__title1__title__0__0')));
  });

  it('cannot spoof another user uid or write to a foreign doc id', async () => {
    const bobDb = testEnv.authenticatedContext('bob').firestore();
    // uid altrui nel payload
    await assertFails(setDoc(doc(bobDb, 'titleEmotions/alice__title1__title__0__0'), validEmotionDoc()));
    // uid proprio ma doc id di un altro utente
    await assertFails(setDoc(doc(bobDb, 'titleEmotions/alice__title1__title__0__0'), {
      ...validEmotionDoc(),
      uid: 'bob',
    }));
  });

  it('doc id must match {uid}__{titleId}__title__0__0 (no multi-doc spam per title)', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    // suffisso diverso -> stesso utente non puo' creare doc extra per lo stesso titolo
    await assertFails(setDoc(doc(aliceDb, 'titleEmotions/alice__title1__title__0__1'), validEmotionDoc()));
    // titleId nel payload diverso da quello nell'id
    await assertFails(setDoc(doc(aliceDb, 'titleEmotions/alice__title1__title__0__0'), {
      ...validEmotionDoc(),
      titleId: 'title2',
    }));
  });

  it('emotions list is validated: size 1..3, whitelist, no duplicates', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    const path = 'titleEmotions/alice__title1__title__0__0';
    await assertFails(setDoc(doc(aliceDb, path), { ...validEmotionDoc(), emotions: [] }));
    await assertFails(setDoc(doc(aliceDb, path), {
      ...validEmotionDoc(),
      emotions: ['touched', 'thrilled', 'amused', 'sad'],
    }));
    await assertFails(setDoc(doc(aliceDb, path), { ...validEmotionDoc(), emotions: ['epic_win'] }));
    await assertFails(setDoc(doc(aliceDb, path), {
      ...validEmotionDoc(),
      emotions: ['touched', 'touched', 'touched'],
    }));
    await assertFails(setDoc(doc(aliceDb, path), { ...validEmotionDoc(), emotions: 'touched' }));
  });

  it('level is locked to title in v1 and extra fields are rejected', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, 'titleEmotions/alice__title1__season__2__0'), {
      ...validEmotionDoc(),
      level: 'season',
      season: 2,
    }));
    await assertFails(setDoc(doc(aliceDb, 'titleEmotions/alice__title1__title__0__0'), {
      ...validEmotionDoc(),
      isSynthetic: true,
    }));
    await assertFails(setDoc(doc(aliceDb, 'titleEmotions/alice__title1__title__0__0'), {
      ...validEmotionDoc(),
      rating: 10,
    }));
  });

  it('update cannot change titleId and updatedAt must be request.time', async () => {
    await seedDoc('titleEmotions/alice__title1__title__0__0', {
      ...validEmotionDoc(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, 'titleEmotions/alice__title1__title__0__0'), {
      ...validEmotionDoc(),
      titleId: 'title2',
    }, { merge: true }));
    await assertFails(setDoc(doc(aliceDb, 'titleEmotions/alice__title1__title__0__0'), {
      ...validEmotionDoc(),
      updatedAt: new Date('2020-01-01T00:00:00Z'),
    }, { merge: true }));
    // stranger non puo' toccare il doc altrui
    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertFails(deleteDoc(doc(bobDb, 'titleEmotions/alice__title1__title__0__0')));
  });

  it('titles.emotionAggregate is frozen for trusted editors (server-owned)', async () => {
    await seedDoc('users/trusty', {
      displayName: 'Trusty', displayNameLower: 'trusty', trusted: true,
      createdAt: new Date(),
      stats: { ratingsCount: 0, reviewsCount: 0, watchedCount: 0 },
    });
    await seedDoc('titles/title1', {
      name: 'Title 1',
      status: 'approved',
      emotionAggregate: { counts: { touched: 2 }, totalSelections: 2, totalUsers: 2 },
    });
    const trustyDb = testEnv.authenticatedContext('trusty').firestore();
    // edit metadati senza toccare l'aggregato: ok
    await assertSucceeds(updateDoc(doc(trustyDb, 'titles/title1'), { name: 'Title Uno' }));
    // manomissione dell'aggregato: negata
    await assertFails(updateDoc(doc(trustyDb, 'titles/title1'), {
      emotionAggregate: { counts: { touched: 999 }, totalSelections: 999, totalUsers: 999 },
    }));
  });

  it('any signed-in user (non-trusted) can create a title; invalid status or anon denied', async () => {
    // Policy 2026-07-10: aggiungere un titolo mancante (import da TMDB) e'
    // un'azione base per ogni utente loggato, non un privilegio da curatore.
    const carolDb = testEnv.authenticatedContext('carol').firestore();
    await assertSucceeds(setDoc(doc(carolDb, 'titles/tmdb_movie_555'), {
      type: 'movie', name: 'Nuovo Titolo', nameLower: 'nuovo titolo',
      status: 'approved', tmdbId: 555, createdBy: 'carol',
      createdAt: new Date(), updatedAt: new Date(),
    }));
    // status fuori dalla whitelist: negato
    await assertFails(setDoc(doc(carolDb, 'titles/tmdb_movie_556'), {
      type: 'movie', name: 'Titolo Ko', status: 'rejected', tmdbId: 556, createdBy: 'carol',
    }));
    // non loggato: negato
    const anonDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(anonDb, 'titles/tmdb_movie_557'), {
      type: 'movie', name: 'Titolo Anon', status: 'approved', tmdbId: 557,
    }));
  });

  it('titles.create rejects forged server-owned fields (ratingAggregate/slug/mergedTmdbIds/emotionAggregate)', async () => {
    // R6: senza validazione su create un utente loggato potrebbe forgiare
    // ratingAggregate (AggregateRating JSON-LD falso) o slug (URL squatting
    // sulle pagine SSR indicizzate). Questi campi sono assegnati solo da
    // trigger/CF; su create devono essere assenti o vuoti.
    const carolDb = testEnv.authenticatedContext('carol').firestore();
    await assertFails(setDoc(doc(carolDb, 'titles/forge_agg'), {
      type: 'movie', name: 'Forge Agg', status: 'approved', tmdbId: 900, createdBy: 'carol',
      ratingAggregate: { combined: 9.9, titleLevel: { sum: 999, count: 100, avg: 9.99 } },
    }));
    await assertFails(setDoc(doc(carolDb, 'titles/forge_slug'), {
      type: 'movie', name: 'Forge Slug', status: 'approved', tmdbId: 901, createdBy: 'carol',
      slug: 'the-batman-2022',
    }));
    await assertFails(setDoc(doc(carolDb, 'titles/forge_merged'), {
      type: 'movie', name: 'Forge Merged', status: 'approved', tmdbId: 902, createdBy: 'carol',
      mergedTmdbIds: [123, 456],
    }));
    await assertFails(setDoc(doc(carolDb, 'titles/forge_emo'), {
      type: 'movie', name: 'Forge Emo', status: 'approved', tmdbId: 903, createdBy: 'carol',
      emotionAggregate: { counts: { touched: 999 }, totalSelections: 999, totalUsers: 999 },
    }));
    // campi server-owned vuoti/di default: consentiti (import legittimo)
    await assertSucceeds(setDoc(doc(carolDb, 'titles/clean_ok'), {
      type: 'movie', name: 'Clean Ok', nameLower: 'clean ok',
      status: 'approved', tmdbId: 904, createdBy: 'carol',
      mergedTmdbIds: [], slug: '',
      createdAt: new Date(), updatedAt: new Date(),
    }));
  });
});

describe('Episode emotions (post-episodio)', () => {
  const episodePath = 'episodeEmotions/alice__title1__episode__1__5';

  const validEpisodeEmotion = () => ({
    uid: 'alice',
    titleId: 'title1',
    level: 'episode',
    season: 1,
    episode: 5,
    emotions: ['touched', 'thrilled'],
    source: 'post_seen',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  it('owner can create, update and delete the canonical episode emotion doc', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(aliceDb, episodePath), validEpisodeEmotion()));
    await assertSucceeds(updateDoc(doc(aliceDb, episodePath), {
      emotions: ['amused'],
      updatedAt: serverTimestamp(),
    }));
    await assertSucceeds(deleteDoc(doc(aliceDb, episodePath)));
  });

  it('signed-in users can read episode emotions; guests cannot', async () => {
    await seedDoc(episodePath, {
      ...validEpisodeEmotion(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const bobDb = testEnv.authenticatedContext('bob').firestore();
    const anonDb = testEnv.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(bobDb, episodePath)));
    await assertFails(getDoc(doc(anonDb, episodePath)));
  });

  it('cannot spoof uid or write an owner payload into a foreign doc id', async () => {
    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertFails(setDoc(doc(bobDb, episodePath), validEpisodeEmotion()));
    await assertFails(setDoc(doc(bobDb, episodePath), {
      ...validEpisodeEmotion(),
      uid: 'bob',
    }));
  });

  it('doc id must exactly match uid__titleId__episode__season__episode', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(
      doc(aliceDb, 'episodeEmotions/alice__title1__episode__2__5'),
      validEpisodeEmotion(),
    ));
    await assertFails(setDoc(
      doc(aliceDb, 'episodeEmotions/alice__title1__episode__1__6'),
      validEpisodeEmotion(),
    ));
    await assertFails(setDoc(
      doc(aliceDb, 'episodeEmotions/alice__title2__episode__1__5'),
      validEpisodeEmotion(),
    ));
    await assertFails(setDoc(
      doc(aliceDb, 'episodeEmotions/alice__title1__title__1__5'),
      validEpisodeEmotion(),
    ));
    // Anche un eventuale doc legacy/admin con id arbitrario non diventa un
    // secondo voto aggiornabile dal client.
    await seedDoc('episodeEmotions/legacy-arbitrary-id', {
      ...validEpisodeEmotion(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await assertFails(updateDoc(doc(aliceDb, 'episodeEmotions/legacy-arbitrary-id'), {
      emotions: ['sad'],
      updatedAt: serverTimestamp(),
    }));
  });

  it('titleId must be canonical and coordinates positive integers at episode level', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(
      doc(aliceDb, 'episodeEmotions/alice__show.one__episode__1__5'),
      { ...validEpisodeEmotion(), titleId: 'show.one' },
    ));
    await assertFails(setDoc(doc(aliceDb, episodePath), {
      ...validEpisodeEmotion(),
      season: 0,
    }));
    await assertFails(setDoc(doc(aliceDb, episodePath), {
      ...validEpisodeEmotion(),
      episode: 1.5,
    }));
    await assertFails(setDoc(doc(aliceDb, episodePath), {
      ...validEpisodeEmotion(),
      level: 'title',
    }));
  });

  it('emotions are limited to 1..3 canonical unique keys', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, episodePath), {
      ...validEpisodeEmotion(),
      emotions: [],
    }));
    await assertFails(setDoc(doc(aliceDb, episodePath), {
      ...validEpisodeEmotion(),
      emotions: ['touched', 'sad', 'amused', 'tense'],
    }));
    await assertFails(setDoc(doc(aliceDb, episodePath), {
      ...validEpisodeEmotion(),
      emotions: ['touched', 'touched'],
    }));
    await assertFails(setDoc(doc(aliceDb, episodePath), {
      ...validEpisodeEmotion(),
      emotions: ['epic_win'],
    }));
    await assertSucceeds(setDoc(doc(aliceDb, episodePath), {
      ...validEpisodeEmotion(),
      emotions: ['touched', 'sad', 'tense'],
    }));
  });

  it('strict schema rejects extra fields and client-authored isSynthetic', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, episodePath), {
      ...validEpisodeEmotion(),
      isSynthetic: true,
    }));
    await assertFails(setDoc(doc(aliceDb, episodePath), {
      ...validEpisodeEmotion(),
      rating: 10,
    }));
  });

  it('update keeps uid, title and episode coordinates plus createdAt immutable', async () => {
    const createdAt = new Date('2026-07-27T10:00:00Z');
    await seedDoc(episodePath, {
      ...validEpisodeEmotion(),
      createdAt,
      updatedAt: new Date(),
    });
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(updateDoc(doc(aliceDb, episodePath), {
      titleId: 'title2',
      updatedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(doc(aliceDb, episodePath), {
      season: 2,
      updatedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(doc(aliceDb, episodePath), {
      createdAt: new Date('2026-07-28T10:00:00Z'),
      updatedAt: serverTimestamp(),
    }));
    await assertSucceeds(updateDoc(doc(aliceDb, episodePath), {
      emotions: ['sad'],
      updatedAt: serverTimestamp(),
    }));
  });

  it('updatedAt must be the server request time', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, episodePath), {
      ...validEpisodeEmotion(),
      updatedAt: new Date('2020-01-01T00:00:00Z'),
    }));
  });

  it('only owner can delete', async () => {
    await seedDoc(episodePath, {
      ...validEpisodeEmotion(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertFails(deleteDoc(doc(bobDb, episodePath)));
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(deleteDoc(doc(aliceDb, episodePath)));
  });

  it('episode aggregate is signed-in readable and server-write-only', async () => {
    const aggregatePath = 'titles/title1/episodeEmotionAggregates/1_5';
    await seedDoc(aggregatePath, {
      counts: { touched: 3, tense: 1 },
      totalSelections: 4,
      totalUsers: 3,
      updatedAt: new Date(),
    });
    const bobDb = testEnv.authenticatedContext('bob').firestore();
    const anonDb = testEnv.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(bobDb, aggregatePath)));
    await assertFails(getDoc(doc(anonDb, aggregatePath)));
    await assertFails(setDoc(doc(bobDb, aggregatePath), {
      counts: { touched: 999 },
      totalSelections: 999,
      totalUsers: 999,
    }));
    await assertFails(deleteDoc(doc(bobDb, aggregatePath)));
  });
});

describe('Character votes ("Chi ti ha conquistato?")', () => {
  const episodePath = 'characterVotes/alice__title1__episode__1__5';
  const titlePath = 'characterVotes/alice__title1__title__0__0';

  const validEpisodeVote = () => ({
    uid: 'alice',
    titleId: 'title1',
    level: 'episode',
    season: 1,
    episode: 5,
    picks: [{ personId: '1253360', character: 'Joel Miller', reaction: 'touched' }],
    source: 'post_seen',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  const validTitleVote = () => ({
    uid: 'alice',
    titleId: 'title1',
    level: 'title',
    season: 0,
    episode: 0,
    picks: [{ personId: '42', character: 'Neo' }],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  it('owner can create a valid episode-level vote', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(aliceDb, episodePath), validEpisodeVote()));
  });

  it('owner can create a valid title-level (film) vote with season/episode 0', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(aliceDb, titlePath), validTitleVote()));
  });

  it('doc id must match uid__titleId__level__season__episode exactly', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    // season nell'id non combacia col payload (2 vs 1)
    await assertFails(setDoc(doc(aliceDb, 'characterVotes/alice__title1__episode__2__5'), validEpisodeVote()));
    // episode nell'id non combacia col payload (6 vs 5)
    await assertFails(setDoc(doc(aliceDb, 'characterVotes/alice__title1__episode__1__6'), validEpisodeVote()));
    // titleId nell'id diverso da quello nel payload
    await assertFails(setDoc(doc(aliceDb, 'characterVotes/alice__title2__episode__1__5'), validEpisodeVote()));
    // level nell'id diverso da quello nel payload
    await assertFails(setDoc(doc(aliceDb, 'characterVotes/alice__title1__title__1__5'), validEpisodeVote()));
  });

  it('titleId must already be sanitized ([A-Za-z0-9_-]+) so client and rules never diverge', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    // titleId grezzo (con punti) concatenato cosi' com'e' nel doc id -> deny,
    // anche se la concatenazione "combacia" carattere per carattere: il campo
    // stesso non e' nella forma sanitizzata richiesta.
    await assertFails(setDoc(
      doc(aliceDb, 'characterVotes/alice__the.last.of.us__episode__1__5'),
      { ...validEpisodeVote(), titleId: 'the.last.of.us' },
    ));
    // stesso titleId non sanitizzato nel payload, ma doc id gia' sanitizzato
    // (come lo costruirebbe il client con makeCharacterVoteId): deny lo
    // stesso, perche' il campo titleId mentirebbe sulla propria forma.
    await assertFails(setDoc(
      doc(aliceDb, 'characterVotes/alice__the_last_of_us__episode__1__5'),
      { ...validEpisodeVote(), titleId: 'the.last.of.us' },
    ));
    // titleId gia' valido (solo [A-Za-z0-9_-]): non-regressione, deve passare.
    await assertSucceeds(setDoc(
      doc(aliceDb, 'characterVotes/alice__the-last-of-us__episode__1__5'),
      { ...validEpisodeVote(), titleId: 'the-last-of-us' },
    ));
  });

  it('cannot spoof another user uid or write to a foreign doc id', async () => {
    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertFails(setDoc(doc(bobDb, episodePath), validEpisodeVote()));
    await assertFails(setDoc(doc(bobDb, episodePath), { ...validEpisodeVote(), uid: 'bob' }));
  });

  it('picks: max 3 rejected at 4, min 1 rejected at 0, 3 distinct accepted', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, episodePath), { ...validEpisodeVote(), picks: [] }));
    await assertFails(setDoc(doc(aliceDb, episodePath), {
      ...validEpisodeVote(),
      picks: [{ personId: '1' }, { personId: '2' }, { personId: '3' }, { personId: '4' }],
    }));
    await assertSucceeds(setDoc(doc(aliceDb, episodePath), {
      ...validEpisodeVote(),
      picks: [{ personId: '1' }, { personId: '2' }, { personId: '3' }],
    }));
  });

  it('picks: duplicate personId rejected (2 and 3 pick combos)', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, episodePath), {
      ...validEpisodeVote(),
      picks: [{ personId: '1' }, { personId: '1' }],
    }));
    await assertFails(setDoc(doc(aliceDb, episodePath), {
      ...validEpisodeVote(),
      picks: [{ personId: '1' }, { personId: '2' }, { personId: '1' }],
    }));
  });

  it('rejects an extra field not in hasOnly', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, episodePath), { ...validEpisodeVote(), extra: 'nope' }));
  });

  it('rejects isSynthetic from client (server-only, admin SDK)', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, episodePath), { ...validEpisodeVote(), isSynthetic: true }));
  });

  it('rejects a reaction outside the shared emotion whitelist', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, episodePath), {
      ...validEpisodeVote(),
      picks: [{ personId: '1', reaction: 'epic_win' }],
    }));
  });

  it('character name capped at 120 chars', async () => {
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, episodePath), {
      ...validEpisodeVote(),
      picks: [{ personId: '1', character: 'x'.repeat(121) }],
    }));
    await assertSucceeds(setDoc(doc(aliceDb, episodePath), {
      ...validEpisodeVote(),
      picks: [{ personId: '1', character: 'x'.repeat(120) }],
    }));
  });

  it('update cannot change level/season/episode (immutable coordinates)', async () => {
    await seedDoc(episodePath, { ...validEpisodeVote(), createdAt: new Date(), updatedAt: new Date() });
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(aliceDb, episodePath), {
      ...validEpisodeVote(),
      level: 'title',
      season: 0,
      episode: 0,
    }, { merge: true }));
    await assertSucceeds(setDoc(doc(aliceDb, episodePath), {
      ...validEpisodeVote(),
      picks: [{ personId: '999' }],
    }, { merge: true }));
  });

  it('delete: owner allowed, stranger denied', async () => {
    await seedDoc(episodePath, validEpisodeVote());
    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertFails(deleteDoc(doc(bobDb, episodePath)));
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(deleteDoc(doc(aliceDb, episodePath)));
  });

  it('episode volume aggregate: signed-in read, guest denied, no client write', async () => {
    await seedDoc('titles/title1/characterVotes/1_5', { counts: { '1253360': 3 }, totalPicks: 3, totalUsers: 3 });
    const bobDb = testEnv.authenticatedContext('bob').firestore();
    const anonDb = testEnv.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(bobDb, 'titles/title1/characterVotes/1_5')));
    await assertFails(getDoc(doc(anonDb, 'titles/title1/characterVotes/1_5')));
    await assertFails(setDoc(doc(bobDb, 'titles/title1/characterVotes/1_5'), { counts: {} }));
  });

  it('unique-user aggregate (series/season/direct): signed-in read, no client write', async () => {
    await seedDoc('titles/title1/aggregates/characters', {
      series: { counts: { '1253360': 128 }, totalUsers: 210 },
    });
    const bobDb = testEnv.authenticatedContext('bob').firestore();
    const anonDb = testEnv.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(bobDb, 'titles/title1/aggregates/characters')));
    await assertFails(getDoc(doc(anonDb, 'titles/title1/aggregates/characters')));
    await assertFails(setDoc(doc(bobDb, 'titles/title1/aggregates/characters'), { series: {} }));
  });

  it('similarity index (titles/{id}/aggregates/similar): signed-in read, no client write', async () => {
    // L'indice collaborativo precalcolato vive nella stessa sottocollezione
    // server-owned degli altri aggregati: nessuna regola nuova, ma il contratto
    // va pinnato — un client che potesse scriverlo deciderebbe cosa consigliare
    // a tutti gli altri.
    await seedDoc('titles/title1/aggregates/similar', {
      titleId: 'title1',
      neighbors: [{ id: 'title2', score: 0.42 }],
      version: 1,
      source: 'cooccurrence',
    });
    const bobDb = testEnv.authenticatedContext('bob').firestore();
    const anonDb = testEnv.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(bobDb, 'titles/title1/aggregates/similar')));
    await assertFails(getDoc(doc(anonDb, 'titles/title1/aggregates/similar')));
    await assertFails(setDoc(doc(bobDb, 'titles/title1/aggregates/similar'), {
      titleId: 'title1',
      neighbors: [{ id: 'spam', score: 99 }],
      version: 1,
    }));
  });

  it('personal rollup (users/{uid}/characterPicks): owner-only read, no client write', async () => {
    await seedDoc('users/alice/characterPicks/title1', {
      series: { '1253360': 12 },
      top: { personId: '1253360', character: 'Joel Miller', count: 12 },
    });
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    const bobDb = testEnv.authenticatedContext('bob').firestore();
    await assertSucceeds(getDoc(doc(aliceDb, 'users/alice/characterPicks/title1')));
    await assertFails(getDoc(doc(bobDb, 'users/alice/characterPicks/title1')));
    await assertFails(setDoc(doc(aliceDb, 'users/alice/characterPicks/title1'), { series: {} }));
  });
});

// Import via Storage (payload troppo grande per il body callable): l'utente
// carica i CSV/JSON grezzi sotto manualImports/{uid}/{importId}/ mentre il
// job doc è in stato 'uploading'. storage.rules whitelista i filename per
// sorgente e vincola il content-type (json vs csv).
// NOTE — emulator limitation: the POSITIVE path (owner uploading a valid
// file) can't be asserted here. canWriteManualImportUpload does a cross-service
// firestore.get on users/{uid}/imports/{importId}; in PRODUCTION that read
// bypasses Firestore rules, but the Storage EMULATOR performs it WITHOUT the
// caller's auth, so the isOwner-gated `imports` read returns nothing and the
// function is always false in-emulator. (The identical pattern for the Refract
// .json files is live in prod, which is the real validation.) We therefore
// only assert the deny cases that DON'T depend on that cross-service read
// resolving true — i.e. the isOwner short-circuit — plus the whole
// manualImports namespace still isn't a client free-for-all.
describe('Storage manualImports upload', () => {
  const csvBytes = () => new TextEncoder().encode('type,movie_name\nwatch,X\n');

  it('non-owner cannot upload to another user\'s import (isOwner short-circuit)', async () => {
    await seedDocs([['users/u1/imports/impD', { status: 'uploading', startedBy: 'u1' }]]);
    const s = testEnv.authenticatedContext('u2').storage();
    await assertFails(uploadBytes(ref(s, 'manualImports/u1/impD/movies.csv'), csvBytes(), { contentType: 'text/csv' }));
  });

  it('unauthenticated user cannot upload', async () => {
    const s = testEnv.unauthenticatedContext().storage();
    await assertFails(uploadBytes(ref(s, 'manualImports/u1/impD/movies.csv'), csvBytes(), { contentType: 'text/csv' }));
  });
});

// Matching-tick continuation docs are server-only (admin SDK). Deny-all client.
describe('importMatchTicks deny-all', () => {
  it('signed-in user cannot read or write a tick doc', async () => {
    const dbU = testEnv.authenticatedContext('u1').firestore();
    await assertFails(getDoc(doc(dbU, 'importMatchTicks/tick1')));
    await assertFails(setDoc(doc(dbU, 'importMatchTicks/tick1'), { uid: 'u1', importId: 'i1', cursor: 0 }));
  });
});

// Product metrics: contatori funnel aggregati, admin-read, server-write only.
describe('productMetrics (funnel aggregato)', () => {
  it('solo admin legge; nessun client scrive', async () => {
    await seedDoc('users/adm', { displayName: 'Adm', displayNameLower: 'adm', isAdmin: true, createdAt: new Date() });
    await seedDoc('productMetrics/2026-07-13', { signups: 5, imports_completed: 2 });
    const admDb = testEnv.authenticatedContext('adm').firestore();
    const userDb = testEnv.authenticatedContext('u9').firestore();
    await assertSucceeds(getDoc(doc(admDb, 'productMetrics/2026-07-13')));
    await assertFails(getDoc(doc(userDb, 'productMetrics/2026-07-13')));
    await assertFails(setDoc(doc(admDb, 'productMetrics/2026-07-14'), { signups: 999 }));
    await assertFails(updateDoc(doc(admDb, 'productMetrics/2026-07-13'), { signups: 999 }));
  });
});

// Import comment review: coda ripubblicazione commenti TV Time. Admin-read,
// server-write only (nemmeno l'owner dell'import può leggere/scrivere).
describe('importCommentReview (ripubblicazione commenti TV Time)', () => {
  it('solo admin legge il doc riepilogo; nessun client (nemmeno owner) legge/scrive', async () => {
    await seedDoc('users/adm', { displayName: 'Adm', displayNameLower: 'adm', isAdmin: true, createdAt: new Date() });
    await seedDoc('importCommentReview/alice__imp1', { uid: 'alice', importId: 'imp1', eligible: 3, status: 'pending' });
    const admDb = testEnv.authenticatedContext('adm').firestore();
    const aliceDb = testEnv.authenticatedContext('alice').firestore(); // owner dell'import
    await assertSucceeds(getDoc(doc(admDb, 'importCommentReview/alice__imp1')));
    await assertFails(getDoc(doc(aliceDb, 'importCommentReview/alice__imp1')));
    await assertFails(setDoc(doc(admDb, 'importCommentReview/alice__imp2'), { uid: 'alice', status: 'pending' }));
    await assertFails(setDoc(doc(aliceDb, 'importCommentReview/alice__imp1'), { status: 'approved' }, { merge: true }));
    await assertFails(updateDoc(doc(admDb, 'importCommentReview/alice__imp1'), { status: 'approved' }));
  });

  it('sottocollezione comments: admin legge, client non legge/scrive', async () => {
    await seedDoc('users/adm', { displayName: 'Adm', displayNameLower: 'adm', isAdmin: true, createdAt: new Date() });
    await seedDoc('importCommentReview/alice__imp1', { uid: 'alice', importId: 'imp1' });
    await seedDoc('importCommentReview/alice__imp1/comments/c1', { uid: 'alice', text: 'ciao', status: 'pending', published: false });
    const admDb = testEnv.authenticatedContext('adm').firestore();
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(getDoc(doc(admDb, 'importCommentReview/alice__imp1/comments/c1')));
    await assertFails(getDoc(doc(aliceDb, 'importCommentReview/alice__imp1/comments/c1')));
    await assertFails(setDoc(doc(aliceDb, 'importCommentReview/alice__imp1/comments/c2'), { uid: 'alice', text: 'x' }));
    await assertFails(updateDoc(doc(aliceDb, 'importCommentReview/alice__imp1/comments/c1'), { status: 'approved' }));
  });
});
