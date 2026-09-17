#!/usr/bin/env node
/**
 * seed-title-update-notified-marks.js — marca come "gia' notificati" gli eventi
 * `new_episode` che il vecchio trigger aveva gia' fatto partire.
 *
 * Contesto (2026-08-13): fino a oggi un `new_episode` notificava alla
 * SCOPERTA, cioe' 5-6 giorni prima dell'uscita, perche' TMDB sposta
 * `next_episode_to_air` appena il precedente va in onda. Ora il fanout aspetta
 * il giorno d'onda e lo fa la sweep `notifyDueTitleUpdates`.
 *
 * Senza questo seed, al primo giro la sweep troverebbe l'arretrato di eventi
 * gia' notificati dal vecchio trigger e li rifarebbe tutti: nessuna notifica
 * doppia (l'id `title_update_{eventId}` e' deterministico), ma decine di
 * scansioni collection-group inutili, e con la query ordinata per data
 * crescente il tetto si riempirebbe di ieri lasciando fuori oggi.
 *
 * Marca solo gli eventi la cui data e' passata o e' oggi: quelli futuri li
 * gestira' la sweep il giorno giusto.
 *
 * Uso:
 *   node scripts/seed-title-update-notified-marks.js                 # dry-run
 *   node scripts/seed-title-update-notified-marks.js --apply --confirm=gia-visto
 */
"use strict";

const admin = require("firebase-admin");

const args = process.argv.slice(2);
const flag = (name) => {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1).trim() : "";
};
const APPLY = args.includes("--apply");
const CONFIRM = flag("--confirm");

const projectId = process.env.GCLOUD_PROJECT
  || process.env.GOOGLE_CLOUD_PROJECT
  || "gia-visto";

if (APPLY && CONFIRM !== projectId) {
  console.error(`Scrittura rifiutata: serve --confirm=${projectId}`);
  process.exit(1);
}

if (!admin.apps.length) admin.initializeApp({ projectId });
const db = admin.firestore();

const { dayKeyForMs } = require("../lib/titleUpdateNotifications");

async function main() {
  const nowMs = Date.now();
  const todayKey = Number(dayKeyForMs(nowMs));
  console.log(`progetto=${projectId} modalita=${APPLY ? "APPLY" : "dry-run"} oggi=${todayKey}`);

  const snapshot = await db.collection("titleUpdateEvents")
    .where("eventType", "==", "new_episode")
    .where("status", "==", "published")
    .where("effectiveAt", "<=", admin.firestore.Timestamp.fromMillis(nowMs + (24 * 60 * 60 * 1000)))
    .get();

  let alreadyMarked = 0;
  let future = 0;
  const pending = [];
  snapshot.docs.forEach((docSnap) => {
    const data = docSnap.data() || {};
    if (Number(data.notifiedAtMs) > 0) {
      alreadyMarked += 1;
      return;
    }
    const airMs = Number(data.effectiveAt?.toMillis?.() ?? NaN);
    if (!Number.isFinite(airMs)) return;
    if (Number(dayKeyForMs(airMs)) > todayKey) {
      future += 1;
      return;
    }
    pending.push(docSnap.ref);
  });

  console.log(`eventi new_episode pubblicati fino a domani: ${snapshot.size}`);
  console.log(`  gia' marcati: ${alreadyMarked}`);
  console.log(`  futuri (li fara' la sweep): ${future}`);
  console.log(`  da marcare:   ${pending.length}`);

  if (!APPLY || !pending.length) {
    console.log(APPLY ? "Niente da fare." : "Dry-run: nessuna scrittura.");
    return;
  }

  let written = 0;
  for (let i = 0; i < pending.length; i += 400) {
    const chunk = pending.slice(i, i + 400);
    const batch = db.batch();
    chunk.forEach((ref) => batch.set(ref, { notifiedAtMs: nowMs }, { merge: true }));
    await batch.commit();
    written += chunk.length;
    console.log(`  scritti ${written}/${pending.length}`);
  }

  console.log(`Fatto: ${written} eventi non verranno rifatti dalla sweep.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal:", err.message);
    process.exit(1);
  });
