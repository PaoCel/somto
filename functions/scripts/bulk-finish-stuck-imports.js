#!/usr/bin/env node
/**
 * bulk-finish-stuck-imports.js
 *
 * Completa server-side gli import rimasti in `awaiting_confirmation`: replica
 * ESATTAMENTE il ramo `skipRemaining` della callable deployata
 * `confirmTitlesImport` (functions/index.js) — i match sicuri sono GIÀ in
 * libreria dal finalize, quindi qui non si importa nulla di nuovo: si saltano
 * in blocco le righe ancora irrisolte, si porta il job a `completed` con
 * conteggi esatti e (default) si crea la notifica "titles_import_completed".
 * Quella notifica fa scattare il trigger deployato `pushOnNotificationCreate`
 * → push all'utente (rispettando le sue preferenze push + cooldown).
 *
 * SICUREZZA:
 *   - DRY-RUN di DEFAULT. Serve `--write` per toccare qualcosa.
 *   - Idempotente: interroga solo `awaiting_confirmation`, quindi un job già
 *     completato non viene ritoccato; lo sweep skip è un merge idempotente.
 *   - NON scrive titleStates, NON reimporta: solo skip righe + status + notifica
 *     (stesso effetto di un utente che tocca "Importa i titoli trovati").
 *   - Le snapshot precedenti e i titleState esistenti restano intatti.
 *
 * Usage (da functions/):
 *   node scripts/bulk-finish-stuck-imports.js                 # DRY-RUN tutti
 *   node scripts/bulk-finish-stuck-imports.js --uid=UID       # DRY-RUN un utente
 *   node scripts/bulk-finish-stuck-imports.js --uid=UID --import=IMPORT_ID
 *   node scripts/bulk-finish-stuck-imports.js --write --uid=UID --import=IMPORT_ID
 *   node scripts/bulk-finish-stuck-imports.js --write             # applica a tutti
 *   node scripts/bulk-finish-stuck-imports.js --write --no-notify # applica senza notifiche
 *   flag extra: --limit=N (cap job processati), --min-age-hours=H (solo job più vecchi di H)
 */

"use strict";

const admin = require("firebase-admin");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => {
  const hit = args.find((a) => a.startsWith(`${f}=`));
  return hit ? hit.slice(f.length + 1).trim() : "";
};

const WRITE = has("--write");
const NOTIFY = !has("--no-notify");
const ONLY_UID = val("--uid");
const ONLY_IMPORT = val("--import");
const LIMIT = Number(val("--limit") || "0") || 0;
const MIN_AGE_HOURS = Number(val("--min-age-hours") || "0") || 0;

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const ms = (v) => { try { return v && v.toMillis ? v.toMillis() : 0; } catch { return 0; } };
const ageHours = (v) => { const t = ms(v); return t ? ((Date.now() - t) / 3_600_000) : null; };

function importSourceLabel(source) {
  const s = String(source || "").trim().toLowerCase();
  if (s === "netflix_csv") return "Import Netflix";
  if (s === "tvtime_gdpr" || s === "tvtime_refract") return "Import TV Time";
  if (s === "trakt") return "Import Trakt";
  return "Import";
}

// Sweep paginato delle righe ancora irrisolte -> skip:true. Ritorna il numero
// di righe saltate in questo run. Identico al ramo skipRemaining della callable.
async function sweepUnresolved(importRef, apply) {
  const PAGE = 400;
  let swept = 0;
  for (let iter = 0; iter < 200; iter++) {
    // eslint-disable-next-line no-await-in-loop
    const page = await importRef.collection("items")
      .where("resolved", "==", false)
      .where("skip", "==", false)
      .limit(PAGE)
      .get();
    if (page.empty) break;
    swept += page.size;
    if (apply) {
      const batch = db.batch();
      page.docs.forEach((d) => batch.set(d.ref, {
        skip: true, resolved: false, updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true }));
      // eslint-disable-next-line no-await-in-loop
      await batch.commit();
    }
    // In dry-run non scriviamo, quindi la query resterebbe identica -> conta una
    // sola pagina e stima dal doc (evita loop infinito).
    if (!apply) break;
    if (page.size < PAGE) break;
  }
  return swept;
}

async function countItems(importRef, where) {
  let q = importRef.collection("items");
  for (const [f, op, v] of where) q = q.where(f, op, v);
  const agg = await q.count().get();
  return Number(agg.data().count || 0);
}

async function main() {
  if (ONLY_IMPORT && !ONLY_UID) {
    throw new Error("--import richiede anche --uid per evitare target non intenzionali.");
  }
  console.log(`\n=== bulk-finish-stuck-imports — ${WRITE ? "WRITE" : "DRY-RUN"} ${ONLY_UID ? `(uid=${ONLY_UID}${ONLY_IMPORT ? ` import=${ONLY_IMPORT}` : ""})` : "(tutti)"} notify=${NOTIFY} ===\n`);

  // orderBy("updatedAt") allinea la query all'indice collectionGroup composito
  // già presente (status ASC, updatedAt ASC) → nessun indice nuovo da creare.
  // (I job in awaiting_confirmation hanno sempre updatedAt: lo scrive finalize.)
  const q = db.collectionGroup("imports")
    .where("status", "==", "awaiting_confirmation")
    .orderBy("updatedAt", "asc");
  const snap = await q.get();

  let jobs = snap.docs.map((d) => ({
    ref: d.ref,
    uid: d.ref.parent.parent.id,
    id: d.id,
    data: d.data() || {},
  }));

  if (ONLY_UID) jobs = jobs.filter((j) => j.uid === ONLY_UID);
  if (ONLY_IMPORT) jobs = jobs.filter((j) => j.id === ONLY_IMPORT);
  if (MIN_AGE_HOURS > 0) jobs = jobs.filter((j) => (ageHours(j.data.updatedAt) ?? 0) >= MIN_AGE_HOURS);
  if (WRITE && ONLY_IMPORT && jobs.length === 0) {
    throw new Error(`Target users/${ONLY_UID}/imports/${ONLY_IMPORT} non trovato o non in awaiting_confirmation.`);
  }
  // Più recente prima: così, deduplicando le notifiche per utente, quella che
  // parte è relativa all'import più recente dell'utente.
  jobs.sort((a, b) => ms(b.data.updatedAt) - ms(a.data.updatedAt));
  if (LIMIT > 0) jobs = jobs.slice(0, LIMIT);

  // Una sola notifica/push per utente, anche se ha più import da chiudere.
  const notifiedUids = new Set();

  console.log(`Job in awaiting_confirmation da processare: ${jobs.length}\n`);

  let totalUnresolved = 0, totalMatched = 0, over24 = 0, over48 = 0, done = 0;

  for (const job of jobs) {
    const x = job.data;
    const uid = job.uid;
    const source = String(x.source || "").toLowerCase();
    const matched = Number(x.matchedCount || 0);
    const importedTitleCount = Array.isArray(x.titleStateIdsWritten) ? x.titleStateIdsWritten.length : matched;
    const age = ageHours(x.updatedAt);

    // Conteggio irrisolti reale (il campo unresolvedCount può essere stantio).
    // eslint-disable-next-line no-await-in-loop
    const unresolvedNow = await countItems(job.ref, [["resolved", "==", false], ["skip", "==", false]]);
    totalUnresolved += unresolvedNow;
    totalMatched += importedTitleCount;
    if (age != null && age >= 24) over24++;
    if (age != null && age >= 48) over48++;

    console.log(`- uid=${uid} import=${job.id} src=${source || "?"} matched(imported)=${importedTitleCount} irrisolti=${unresolvedNow} età=${age != null ? age.toFixed(1) + "h" : "?"}`);

    if (!WRITE) continue;

    // 1) Sweep skip righe irrisolte.
    // eslint-disable-next-line no-await-in-loop
    await sweepUnresolved(job.ref, true);

    // 2) Conteggi esatti post-sweep.
    // eslint-disable-next-line no-await-in-loop
    const remaining = await countItems(job.ref, [["resolved", "==", false], ["skip", "==", false]]);
    // eslint-disable-next-line no-await-in-loop
    const skippedCount = await countItems(job.ref, [["skip", "==", true]]);
    const nextStatus = remaining > 0 ? "awaiting_confirmation" : "completed";

    // 3) Marca completed con conteggi.
    // eslint-disable-next-line no-await-in-loop
    await job.ref.set({
      status: nextStatus,
      unresolvedCount: remaining,
      skippedCount,
      importedTitleCount,
      updatedAt: FieldValue.serverTimestamp(),
      completedAt: nextStatus === "completed" ? FieldValue.serverTimestamp() : null,
      bulkFinishedByAdmin: true, // marker audit: chiuso dallo sweep ops, non dall'utente
    }, { merge: true });

    // 4) Notifica "completato" (fa scattare pushOnNotificationCreate -> push).
    // Una sola per utente: se ne ha già ricevuta una in questo run, salto.
    let notified = false;
    if (NOTIFY && nextStatus === "completed" && !notifiedUids.has(uid)) {
      notifiedUids.add(uid);
      notified = true;
      const label = importSourceLabel(source);
      const message = `${label} completato: ${importedTitleCount} titoli aggiornati nella tua libreria.`;
      // eslint-disable-next-line no-await-in-loop
      await db.collection("users").doc(uid).collection("notifications").add({
        type: "titles_import_completed",
        fromUid: null,
        toUid: uid,
        read: false,
        createdAt: FieldValue.serverTimestamp(),
        data: {
          importId: job.id,
          source: source || "netflix_csv",
          matchedCount: importedTitleCount,
          unresolvedCount: 0,
          message,
          ctaUrl: "/account.html?tab=watched",
        },
      });
    }

    done++;
    console.log(`  -> ${WRITE ? "FATTO" : ""} status=${nextStatus} skipped=${skippedCount}${notified ? " + notifica" : ""}`);
  }

  console.log(`\n=== Riepilogo ===`);
  console.log(`Job: ${jobs.length}  (>24h: ${over24}, >48h: ${over48})`);
  console.log(`Titoli già importati (somma): ${totalMatched}`);
  console.log(`Righe irrisolte che verrebbero saltate (somma): ${totalUnresolved}`);
  if (WRITE) console.log(`Job completati in questo run: ${done}${NOTIFY ? " (con notifica+push)" : " (senza notifica)"}`);
  else {
    // Stima R/W approssimativa per il go/no-go.
    const estWrites = totalUnresolved /*skip*/ + jobs.length /*job doc*/ + (NOTIFY ? jobs.length : 0) /*notif*/;
    console.log(`[DRY-RUN] nessuna scrittura eseguita. Stima scritture con --write: ~${estWrites} (skip righe + job + notifiche).`);
    console.log(`[DRY-RUN] Rilancia con --write per applicare (o --write --uid=UID per testare su uno).`);
  }
  console.log("");
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERRORE:", e); process.exit(1); });
