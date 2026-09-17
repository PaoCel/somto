#!/usr/bin/env node
/**
 * publish-release-drafts.js — pubblica in blocco i draft `release_date`.
 *
 * PERCHE' ESISTE — gli eventi di uscita senza data italiana confermata nascono
 * `draft` e fino al 2026-08-12 non li poteva pubblicare nessuno: si sono
 * accumulati per mesi. La console `/admin-title-updates.html` ora li sblocca,
 * ma uno per uno; questo script fa lo stesso lavoro in blocco.
 *
 * Usa la STESSA logica della console (`lib/titleUpdateEditorial.js`), quindi
 * finestra di notifica e blocchi editoriali si comportano identicamente.
 *
 * DRY-RUN DI DEFAULT. Pubblicare un evento la cui uscita cade entro due
 * settimane manda una push a chi ha il titolo in watchlist, e non si annulla:
 * il conteggio va letto PRIMA.
 *
 *   node scripts/publish-release-drafts.js                 # elenco, niente scritture
 *   node scripts/publish-release-drafts.js --as=<uid> --write
 *
 *   --as=<uid>       chi risulta autore della pubblicazione (deve essere admin)
 *   --write          scrive davvero
 *   --max-notify=N   si ferma se partirebbero piu' di N notifiche (default 5)
 *   --skip-notify    pubblica SOLO quelli che non notificano
 */
"use strict";

const admin = require("firebase-admin");
const { buildEditorialPatch } = require("../lib/titleUpdateEditorial");

const args = process.argv.slice(2);
const flag = (name) => args.some((a) => a === `--${name}`);
const value = (name) => (args.find((a) => a.startsWith(`--${name}=`)) || "").split("=")[1] || null;

const WRITE = flag("write");
const SKIP_NOTIFY = flag("skip-notify");
const MAX_NOTIFY = Number(value("max-notify") ?? 5);
const AS_UID = value("as");

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

async function resolveEditor() {
  if (AS_UID) {
    const snap = await db.collection("users").doc(AS_UID).get();
    if (!snap.exists || snap.data()?.isAdmin !== true) {
      throw new Error(`${AS_UID} non e' un admin`);
    }
    return AS_UID;
  }
  const admins = await db.collection("users").where("isAdmin", "==", true).limit(1).get();
  if (admins.empty) throw new Error("nessun admin trovato: passa --as=<uid>");
  return admins.docs[0].id;
}

(async () => {
  const editedBy = await resolveEditor();
  const now = new Date();

  const snap = await db.collection("titleUpdateEvents")
    .where("eventType", "==", "release_date")
    .where("status", "==", "draft")
    .get();

  const rows = [];
  for (const doc of snap.docs) {
    const data = doc.data();
    const effectiveAt = data.effectiveAt?.toDate?.();
    if (!effectiveAt || effectiveAt <= now) continue; // uscite passate: non si pubblicano

    let built;
    try {
      built = buildEditorialPatch({ existing: data, publish: true, editedBy, now });
    } catch (err) {
      rows.push({ id: doc.id, error: err.message });
      continue;
    }

    const titleSnap = await db.collection("titles").doc(data.titleId).get();
    rows.push({
      id: doc.id,
      name: titleSnap.data()?.name || data.titleId,
      date: effectiveAt.toISOString().slice(0, 10),
      days: Math.round((effectiveAt - now) / 86_400_000),
      willNotify: built.willNotify,
      patch: built.patch,
    });
  }

  rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const notifying = rows.filter((r) => r.willNotify);
  const quiet = rows.filter((r) => !r.willNotify && !r.error);
  const errors = rows.filter((r) => r.error);

  console.log(`\ndraft release_date con uscita futura: ${rows.length}\n`);
  for (const r of rows) {
    if (r.error) { console.log(`  [errore] ${r.id}: ${r.error}`); continue; }
    console.log(`  ${r.willNotify ? "🔔" : "  "} ${r.date} (fra ${r.days}gg)  ${r.name}`);
  }
  console.log(`\n  notificherebbero: ${notifying.length}   silenziosi: ${quiet.length}   errori: ${errors.length}`);
  console.log(`  autore: ${editedBy}`);

  const target = SKIP_NOTIFY ? quiet : [...quiet, ...notifying];

  if (!WRITE) {
    console.log(`\nDRY-RUN: nessuna scrittura. Con --write ne pubblicherebbe ${target.length}.`);
    process.exit(0);
  }

  if (!SKIP_NOTIFY && notifying.length > MAX_NOTIFY) {
    console.error(`\nBLOCCATO: partirebbero ${notifying.length} notifiche, il tetto e' ${MAX_NOTIFY}.`);
    console.error(`Alza con --max-notify=${notifying.length}, oppure usa --skip-notify per i soli silenziosi.`);
    process.exit(1);
  }

  let done = 0;
  for (const r of target) {
    await db.collection("titleUpdateEvents").doc(r.id).set(r.patch, { merge: true });
    done += 1;
    console.log(`  pubblicato ${r.id}${r.willNotify ? " (notifica inviata)" : ""}`);
  }
  console.log(`\nfatto: ${done} pubblicati.`);
  process.exit(0);
})().catch((err) => { console.error("ERRORE:", err.message); process.exit(1); });
