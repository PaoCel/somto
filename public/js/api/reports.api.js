import {
  collection,
  doc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { db } from "../firebase.js";
import { t as i18nT } from "../i18n/index.js";
import { rateLimitedCreate, RateLimitExceededError } from "./_rateLimitedCreate.js";

const ALLOWED_TYPES = new Set(["user", "post", "comment", "thread"]);

/**
 * Crea un report passando per il rate-limit helper: le rules richiedono che
 * `users/{uid}/rateLimits/reports` sia incrementato atomicamente con la
 * create (cap 20/24h). La rule impone anche `createdAt == request.time`:
 * serve il transform `serverTimestamp()` (nel check rules vale request.time;
 * un Timestamp client non lo eguaglia mai → permission denied).
 */
export async function sendReport({ type, targetId, reason, fromUid }) {
  const t = String(type || "").trim();
  const target = String(targetId || "").trim();
  const r = String(reason || "").trim();
  const f = String(fromUid || "").trim();

  if (!ALLOWED_TYPES.has(t)) throw new Error(i18nT("Tipo segnalazione non valido"));
  if (!target) throw new Error("Target mancante");
  if (!r) throw new Error("Motivo mancante");
  if (!f) throw new Error("fromUid mancante");

  const ref = doc(collection(db, "reports"));
  const payload = {
    type: t,
    targetId: target,
    reason: r,
    fromUid: f,
    createdAt: serverTimestamp(),
  };

  try {
    await rateLimitedCreate({ action: "reports", targetRef: ref, payload });
  } catch (err) {
    if (err instanceof RateLimitExceededError) {
      throw new Error(i18nT("Hai raggiunto il limite giornaliero di segnalazioni (20/giorno)."));
    }
    throw err;
  }

  return { id: ref.id };
}
