// Ground-truth check: can a brand-new signed-in user (no trusted, no admin)
// run the exact queries the Watchlist dashboard fires? Run via:
//   firebase emulators:exec --only firestore "node test/watchlist-rules-check.cjs"
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs');
const { join } = require('path');
const {
  doc, setDoc, collection, query, where, orderBy, limit, getDocs, documentId,
} = require('firebase/firestore');

const projectId = 'rules-watchlist-check';
const firestoreRules = readFileSync(join(__dirname, '../../firestore.rules'), 'utf8');

async function tryQuery(label, run) {
  try {
    const snap = await run();
    console.log(`PASS  ${label}  (docs: ${snap.size})`);
  } catch (e) {
    console.log(`FAIL  ${label}  -> ${e.code || e.message}`);
  }
}

async function main() {
  console.log('WATCHLIST_RULES_CHECK_START');
  const testEnv = await initializeTestEnvironment({
    projectId,
    firestore: { rules: firestoreRules },
  });

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await Promise.all([
      setDoc(doc(db, 'users/owner1'), { displayName: 'Owner' }),
      setDoc(doc(db, 'users/newbie'), { displayName: 'Newbie' }),
      setDoc(doc(db, 'userLists/pub1'), {
        title: 'Public list', ownerUid: 'owner1', visibility: 'public', kind: 'collection',
        memberUids: ['owner1'], editorUids: [], viewerUids: [],
        previewTitleIds: [], itemTitleIds: [], createdAt: new Date(), updatedAt: new Date(),
      }),
      setDoc(doc(db, 'publicUserLists/pub1'), {
        listId: 'pub1', title: 'Public list', ownerUid: 'owner1', visibility: 'public', kind: 'collection',
        owner: { uid: 'owner1', displayName: 'Owner', photoURL: null },
        previewTitleIds: [], itemTitleIds: [], itemCount: 0, completedCount: 0, followersCount: 0,
        cover: { imageUrl: null, storagePath: null, fallbackTitleIds: [], accentHex: null },
        createdAt: new Date(), updatedAt: new Date(),
      }),
      setDoc(doc(db, 'userLists/priv1'), {
        title: 'Private list', ownerUid: 'owner1', visibility: 'private', kind: 'collection',
        memberUids: ['owner1'], editorUids: [], viewerUids: [],
        previewTitleIds: [], itemTitleIds: [], createdAt: new Date(), updatedAt: new Date(),
      }),
      setDoc(doc(db, 'userLists/mem1'), {
        title: 'Shared with newbie', ownerUid: 'owner1', visibility: 'shared', kind: 'collection',
        memberUids: ['owner1', 'newbie'], editorUids: [], viewerUids: [],
        previewTitleIds: [], itemTitleIds: [], createdAt: new Date(), updatedAt: new Date(),
      }),
      setDoc(doc(db, 'users/newbie/titleStates/t1'), {
        titleId: 't1', mediaType: 'movie', state: 'unseen', updatedAt: new Date(),
      }),
      setDoc(doc(db, 'users/newbie/savedLists/pub1'), {
        listId: 'pub1', isPinned: true, updatedAt: new Date(),
      }),
      setDoc(doc(db, 'users/newbie/listProgressEntries/e1'), {
        listId: 'pub1', titleId: 't1', mediaType: 'movie', state: 'not_started',
      }),
      setDoc(doc(db, 'users/owner1/library/t1'), { titleId: 't1', updatedAt: new Date() }),
      setDoc(doc(db, 'titles/t1'), { status: 'approved', name: 'Title 1' }),
      setDoc(doc(db, 'ratings/r1'), {
        uid: 'owner1', level: 'title', rating: 8, titleId: 't1', reviewText: 'great',
      }),
    ]);
  });

  const db = testEnv.authenticatedContext('newbie').firestore();

  await tryQuery('fetchPublicLists  publicUserLists + orderBy updatedAt', () =>
    getDocs(query(collection(db, 'publicUserLists'), orderBy('updatedAt', 'desc'), limit(120))));
  await tryQuery('fetchPublicLists  publicUserLists (no orderBy)', () =>
    getDocs(query(collection(db, 'publicUserLists'), limit(120))));
  await tryQuery('fetchMemberLists  userLists where memberUids array-contains newbie + orderBy', () =>
    getDocs(query(collection(db, 'userLists'), where('memberUids', 'array-contains', 'newbie'), orderBy('updatedAt', 'desc'), limit(80))));
  await tryQuery('fetchMemberLists  (no orderBy)', () =>
    getDocs(query(collection(db, 'userLists'), where('memberUids', 'array-contains', 'newbie'), limit(80))));
  await tryQuery('fetchTitleStates  users/newbie/titleStates', () =>
    getDocs(query(collection(db, 'users/newbie/titleStates'), orderBy('updatedAt', 'desc'), limit(400))));
  await tryQuery('fetchPinnedPublicListIDs  users/newbie/savedLists where isPinned==true', () =>
    getDocs(query(collection(db, 'users/newbie/savedLists'), where('isPinned', '==', true))));
  await tryQuery('fetchPublicListProgressEntries  users/newbie/listProgressEntries', () =>
    getDocs(collection(db, 'users/newbie/listProgressEntries')));
  await tryQuery('listTitles  titles where documentId in [...]', () =>
    getDocs(query(collection(db, 'titles'), where(documentId(), 'in', ['t1']))));
  await tryQuery('profile library  users/owner1/library (altrui, non amico)', () =>
    getDocs(collection(db, 'users/owner1/library')));
  await tryQuery('profile reviews  ratings where uid==owner1 && level==title', () =>
    getDocs(query(collection(db, 'ratings'), where('uid', '==', 'owner1'), where('level', '==', 'title'))));

  await testEnv.cleanup();
  console.log('WATCHLIST_RULES_CHECK_DONE');
}

main().catch((e) => { console.error(e); process.exit(1); });
