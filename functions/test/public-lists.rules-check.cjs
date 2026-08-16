const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs');
const { join } = require('path');
const { doc, setDoc, writeBatch, serverTimestamp } = require('firebase/firestore');

const projectId = 'rules-public-lists-check';
const firestoreRules = readFileSync(join(__dirname, '../../firestore.rules'), 'utf8');
const storageRules = readFileSync(join(__dirname, '../../storage.rules'), 'utf8');

async function main() {
  console.log('PUBLIC_RULES_CHECK_START');
  const testEnv = await initializeTestEnvironment({
    projectId,
    firestore: { rules: firestoreRules },
    storage: { rules: storageRules }
  });

  try {
    console.log('PUBLIC_RULES_CHECK_SEED');
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await Promise.all([
        setDoc(doc(db, 'users/alice'), { displayName: 'Alice' }),
        setDoc(doc(db, 'users/charlie'), { displayName: 'Charlie' }),
        setDoc(doc(db, 'userLists/list_public_pin'), {
          title: 'Saga Skywalker',
          ownerUid: 'alice',
          visibility: 'public',
          kind: 'ordered_path',
          memberUids: ['alice'],
          editorUids: [],
          viewerUids: [],
          itemTitleIds: ['ironman'],
          previewTitleIds: ['ironman'],
          itemCount: 1,
          createdAt: new Date(),
          updatedAt: new Date()
        }),
        setDoc(doc(db, 'userLists/list_private_progress'), {
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
          createdAt: new Date(),
          updatedAt: new Date()
        })
      ]);
    });

    console.log('PUBLIC_RULES_CHECK_BATCH_CREATE');
    const aliceDb = testEnv.authenticatedContext('alice').firestore();
    const createBatch = writeBatch(aliceDb);
    createBatch.set(doc(aliceDb, 'userLists/list_batch_public'), {
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
      updatedAt: serverTimestamp()
    });
    createBatch.set(doc(aliceDb, 'userLists/list_batch_public/items/ironman'), {
      titleId: 'ironman',
      orderIndex: 1000,
      addedByUid: 'alice',
      addedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    createBatch.set(doc(aliceDb, 'userLists/list_batch_public/members/alice'), {
      uid: 'alice',
      role: 'owner',
      displayName: 'Alice',
      joinedAt: serverTimestamp()
    });
    await assertSucceeds(createBatch.commit());

    console.log('PUBLIC_RULES_CHECK_PIN');
    const charlieDb = testEnv.authenticatedContext('charlie').firestore();
    await assertSucceeds(setDoc(doc(charlieDb, 'users/charlie/savedLists/list_public_pin'), {
      listId: 'list_public_pin',
      isPinned: true,
      pinnedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }));

    console.log('PUBLIC_RULES_CHECK_PROGRESS_PUBLIC');
    await assertSucceeds(setDoc(doc(charlieDb, 'users/charlie/listProgressEntries/list_public_pin__ironman'), {
      listId: 'list_public_pin',
      titleId: 'ironman',
      mediaType: 'movie',
      state: 'completed',
      completedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      lastInteractionAt: serverTimestamp(),
      watchMinutesContribution: 126
    }));

    console.log('PUBLIC_RULES_CHECK_PROGRESS_PRIVATE');
    await assertFails(setDoc(doc(charlieDb, 'users/charlie/listProgressEntries/list_private_progress__ironman'), {
      listId: 'list_private_progress',
      titleId: 'ironman',
      mediaType: 'movie',
      state: 'completed',
      completedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      lastInteractionAt: serverTimestamp(),
      watchMinutesContribution: 126
    }));

    console.log('PUBLIC_RULES_CHECK_OK');
  } finally {
    console.log('PUBLIC_RULES_CHECK_CLEANUP');
    await testEnv.cleanup();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
