import {
  collection,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import { db } from "../firebase.js";

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function toCursorDoc(value) {
  return value && typeof value.data === "function" ? value : null;
}

function mapPageSnapshot(snap, pageSize) {
  const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const nextCursorDoc = snap.docs.length ? snap.docs[snap.docs.length - 1] : null;
  return {
    items,
    nextCursorDoc,
    hasMore: snap.size >= pageSize,
  };
}

export async function listFeedEventsPage(uid, opts = {}) {
  const ownerUid = String(uid || "").trim();
  if (!ownerUid) throw new Error("uid mancante");

  const pageSize = clampInt(opts.pageSize ?? opts.max, 1, 80, 24);
  const cursorDoc = toCursorDoc(opts.cursorDoc || opts.cursor || null);

  const clauses = [
    where("ownerUid", "==", ownerUid),
    orderBy("createdAt", "desc"),
  ];
  if (cursorDoc) clauses.push(startAfter(cursorDoc));
  clauses.push(limit(pageSize));

  const q = query(collection(db, "feedEvents"), ...clauses);
  const snap = await getDocs(q);
  return mapPageSnapshot(snap, pageSize);
}

export async function listFeedEvents(uid, opts = {}) {
  const page = await listFeedEventsPage(uid, opts);
  return page.items;
}
