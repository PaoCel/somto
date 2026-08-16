// events.api.js - Evento temporaneo (singolo documento events/current)

import {
  doc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import { db } from "../firebase.js";

/**
 * Legge l'evento corrente (events/current).
 * Ritorna l'oggetto evento se esiste ed è attivo (now tra startAt e endAt),
 * altrimenti null.
 * Costo: 1 read Firestore per chiamata.
 */
export async function getCurrentEvent() {
  try {
    const snap = await getDoc(doc(db, "events", "current"));
    if (!snap.exists()) return null;

    const data = snap.data();
    if (!data.startAt || !data.endAt) return null;

    const now = Date.now();
    const start = typeof data.startAt.toMillis === "function" ? data.startAt.toMillis() : (data.startAt.seconds || 0) * 1000;
    const end = typeof data.endAt.toMillis === "function" ? data.endAt.toMillis() : (data.endAt.seconds || 0) * 1000;

    if (now < start || now > end) return null;

    return {
      title: data.title || "",
      description: data.description || "",
      type: data.type || "tema",
      threadId: data.threadId || null,
      titleIds: Array.isArray(data.titleIds) ? data.titleIds : [],
      startAt: start,
      endAt: end,
    };
  } catch (err) {
    console.error("getCurrentEvent error:", err);
    return null;
  }
}
