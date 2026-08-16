import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { db } from "../firebase.js";
import { t as i18nT } from "../i18n/index.js";

export async function isUserBlocked(myUid, targetUid) {
  if (!myUid || !targetUid) return false;
  return (await getDoc(doc(db, "users", myUid, "blockedUsers", targetUid))).exists();
}

export async function blockUser(myUid, targetUid, source = "web_profile") {
  if (!myUid || !targetUid || myUid === targetUid) throw new Error(i18nT("Utente non valido"));
  // Bloccare deve anche sciogliere il legame, come fa gia' iOS: finora sul web
  // restava il follow, quindi la persona bloccata continuava a vedere i post e
  // a comparire nel feed.
  const batch = writeBatch(db);
  batch.set(doc(db, "users", myUid, "blockedUsers", targetUid), {
    blockedUid: targetUid,
    source,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  batch.delete(doc(db, "users", myUid, "following", targetUid));
  batch.delete(doc(db, "users", targetUid, "followers", myUid));
  await batch.commit();
}

export async function unblockUser(myUid, targetUid) {
  if (!myUid || !targetUid) return;
  await deleteDoc(doc(db, "users", myUid, "blockedUsers", targetUid));
}

export async function listBlockedUserIds(myUid) {
  if (!myUid) return new Set();
  const snap = await getDocs(collection(db, "users", myUid, "blockedUsers"));
  return new Set(snap.docs.map((row) => row.id));
}
