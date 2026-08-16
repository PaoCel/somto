import {
  collection,
  query,
  where,
  orderBy,
  limit,
  getDoc,
  getDocs,
  getCountFromServer,
  onSnapshot,
  doc,
  updateDoc,
  setDoc,
  writeBatch,
  addDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import { db } from "../firebase.js";

// ============================
// Helpers
// ============================

function notifCol(uid) {
  return collection(db, "users", uid, "notifications");
}

// ============================
// Badge count
// ============================

export async function getUnreadCount(uid) {
  const q = query(notifCol(uid), where("read", "==", false));
  const snap = await getCountFromServer(q);
  return snap.data().count || 0;
}

// ============================
// Realtime badge
// ============================

export function onNotificationsChange(uid, cb) {
  const q = query(
    notifCol(uid),
    where("read", "==", false)
  );
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}

// ============================
// List notifications
// ============================

export async function getMyNotifications(
  uid,
  { includeRead = false, max = 20 } = {}
) {
  let q = query(
    notifCol(uid),
    orderBy("createdAt", "desc"),
    limit(max)
  );

  if (!includeRead) {
    q = query(
      notifCol(uid),
      where("read", "==", false),
      orderBy("createdAt", "desc"),
      limit(max)
    );
  }

  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ============================
// Mark single as read
// ============================

export async function markAsRead(uid, notificationId) {
  const ref = doc(db, "users", uid, "notifications", notificationId);
  await updateDoc(ref, { read: true });
}

// ============================
// Mark all as read
// ============================

export async function markAllAsRead(uid) {
  const q = query(
    notifCol(uid),
    where("read", "==", false)
  );
  const snap = await getDocs(q);
  const batch = writeBatch(db);
  snap.docs.forEach(d => {
    batch.update(d.ref, { read: true });
  });
  await batch.commit();
}

// ============================
// Notification preferences
// ============================

const prefsRef = (uid) => doc(db, "users", uid, "_system", "notificationPrefs");

export async function getNotificationPrefs(uid) {
  if (!uid) return { disabledTypes: [] };
  const ref = prefsRef(uid);
  const snap = await getDoc(ref).catch(() => null);
  const data = snap?.exists() ? (snap.data() || {}) : {};
  return {
    disabledTypes: Array.isArray(data.disabledTypes) ? data.disabledTypes : [],
    updatedAt: data.updatedAt || null,
  };
}

export async function setNotificationPrefs(uid, disabledTypes = []) {
  if (!uid) return;
  const ref = prefsRef(uid);
  const arr = Array.isArray(disabledTypes) ? disabledTypes : [];
  await setDoc(ref, {
    disabledTypes: arr,
    updatedAt: serverTimestamp(),
  }, { merge: true });
  return { disabledTypes: arr };
}

// ============================
// Create notifications (client)
// Compatible with BOTH call styles:
//  - notifyX({ toUid, fromUid, fromName, ... })
//  - notifyX(toUid, fromUid, fromName, extra)
// ============================

// Notifiche lato client sono state migrate a Cloud Functions (server-side).
// Manteniamo le API come no-op per retrocompatibilità del codice che le invoca.
function noopPromise() {
  return Promise.resolve();
}

export async function notifyFollow(a, b, c) {
  return noopPromise();
}

export function extractMentionUids(text) {
  const regex = /@\{[^}]+\}\(([^)]+)\)/g;
  const uids = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    uids.push(match[1]);
  }
  return [...new Set(uids)];
}

export async function notifyPostMention({ toUid, fromUid, fromName, postId, preview }) {
  return noopPromise();
}

export async function notifyRecommendation(a, b, c, d) {
  return noopPromise();
}
