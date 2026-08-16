// officialUpdates.api.js — Console editoriale admin: aggiornamenti ufficiali
// Somto (annunci, nuove stagioni, trailer, ecc.). Wrapper client per le
// callable `publishOfficialUpdate` / `unpublishOfficialUpdate` (europe-west1,
// admin-only lato server) + lettura del registro `officialUpdates/{slug}`
// (rules: read isAdmin() — non ancora deployate al momento in cui questo file
// e' stato scritto, quindi le chiamate di lettura possono tornare
// permission-denied finche' il deploy non avviene; il chiamante gestisce
// l'errore mostrando un messaggio dedicato, la pagina resta comunque
// utilizzabile per comporre/anteprima/pubblicare).
import {
  collection,
  query,
  orderBy,
  limit as fbLimit,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";

import { app, db } from "../firebase.js";

const functions = getFunctions(app, "europe-west1");
// publishOfficialUpdate puo' fare fan-out su una collectionGroup di
// titleStates (audience calcolata dai titoli collegati) + scritture batch di
// feed/notifiche: timeout client generoso, come le altre callable pesanti di
// import (vedi imports.api.js finalizeTitlesImportUploadCallable).
const publishOfficialUpdateCallable = httpsCallable(functions, "publishOfficialUpdate", { timeout: 120000 });
// unpublishOfficialUpdate NON e' ancora deployata al momento in cui questo
// file e' stato scritto: la callable puo' non esistere in prod, il chiamante
// intercetta functions/not-found (o internal) e mostra un messaggio dedicato.
const unpublishOfficialUpdateCallable = httpsCallable(functions, "unpublishOfficialUpdate", { timeout: 120000 });

/**
 * Compone/pubblica un aggiornamento ufficiale. Con `dryRun:true` non scrive
 * nulla e ritorna solo la stima di audience `{ slug, postId, recipientCount, ... }`.
 * Con `status:"draft"` scrive solo il registro `officialUpdates/{slug}`.
 * Con `status:"published"` (default) crea il post pubblico + fan-out
 * feed/notifiche. Ritorna
 * `{ slug, status, postId, linkedTitleIds, recipientCount, feedEventsWritten, notificationsWritten, dryRun }`.
 */
export async function publishOfficialUpdate({
  title,
  slug,
  text,
  summary,
  updateType,
  linkedTitleIds,
  sourceUrls,
  audienceUids,
  scheduledAt,
  status = "published",
  dryRun = false,
} = {}) {
  const payload = { title, slug, text, updateType, linkedTitleIds, status, dryRun };
  if (summary) payload.summary = summary;
  // Solo sulle bozze: la pubblicazione automatica e' gestita dallo scheduler
  // `publishScheduledOfficialUpdates` (ogni 15 min).
  if (scheduledAt && status === "draft") payload.scheduledAt = scheduledAt;
  if (Array.isArray(sourceUrls) && sourceUrls.length) payload.sourceUrls = sourceUrls;
  if (Array.isArray(audienceUids) && audienceUids.length) payload.audienceUids = audienceUids;
  const res = await publishOfficialUpdateCallable(payload);
  return res?.data || null;
}

/**
 * Ritira un aggiornamento pubblicato: elimina il post pubblico + i feedEvents
 * e le notifiche fan-out corrispondenti, marca il registro `status:"retired"`.
 * Ritorna `{ slug, postId, status, feedEventsDeleted, notificationsDeleted }`.
 */
export async function unpublishOfficialUpdate({ slug } = {}) {
  const res = await unpublishOfficialUpdateCallable({ slug });
  return res?.data || null;
}

/**
 * Elenca il registro `officialUpdates` (draft + published + retired), piu'
 * recenti prima. Richiede le rules admin aggiornate (non ancora deployate al
 * momento in cui questo file e' stato scritto) — il chiamante intercetta
 * permission-denied.
 */
export async function listOfficialUpdates({ max = 30 } = {}) {
  const q = query(
    collection(db, "officialUpdates"),
    orderBy("updatedAt", "desc"),
    fbLimit(max)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
