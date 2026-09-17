#!/usr/bin/env node
/**
 * backfill-user-platform.js — scrive `users/{uid}.platform` sugli account che
 * esistevano prima che i client lo registrassero da soli.
 *
 * Contesto: fino al 2026-08-24 il doc utente non diceva da dove nascesse
 * l'account. Le coorti si potevano solo indovinare, e il funnel prodotto
 * risultava vuoto perche' gli eventi arrivavano solo dalla PWA mentre la base
 * utenti e' quasi tutta iOS. Ora web e iOS scrivono `platform` alla creazione;
 * questo script copre lo storico usando due indizi, in ordine:
 *
 *   1. `communitySafetyAcceptedSource` — "ios_*" o "web_*": dice dove e' stato
 *      accettato il regolamento, che per gli account veri coincide col client;
 *   2. la piattaforma dei token push registrati (`notificationTokens`).
 *
 * Chi non ha nessuno dei due resta **senza campo**: "sconosciuta" e' un dato
 * onesto, un valore inventato no.
 *
 * Uso (dry-run di default):
 *   cd functions
 *   node scripts/backfill-user-platform.js
 *   node scripts/backfill-user-platform.js --write
 */

const admin = require("firebase-admin");

const WRITE = process.argv.includes("--write");

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

function platformFromSafetySource(value) {
  const source = String(value || "").toLowerCase();
  if (source.startsWith("ios")) return "ios";
  if (source.startsWith("web")) return "web";
  return null;
}

async function platformFromPushTokens(userRef) {
  const snap = await userRef.collection("notificationTokens").limit(5).get().catch(() => null);
  if (!snap || snap.empty) return null;
  const platforms = new Set(
    snap.docs.map((doc) => String(doc.data()?.platform || "").toLowerCase()).filter(Boolean)
  );
  if (platforms.size !== 1) return null; // due piattaforme = nessuna certezza
  const only = [...platforms][0];
  return only === "ios" || only === "web" ? only : null;
}

(async () => {
  const users = await db.collection("users").get();
  const counts = { ios: 0, web: 0, gia_presente: 0, sconosciuta: 0 };
  let pending = [];

  for (const doc of users.docs) {
    const data = doc.data() || {};
    if (data.platform) {
      counts.gia_presente += 1;
      continue;
    }

    const platform = platformFromSafetySource(data.communitySafetyAcceptedSource)
      // eslint-disable-next-line no-await-in-loop
      || await platformFromPushTokens(doc.ref);

    if (!platform) {
      counts.sconosciuta += 1;
      continue;
    }

    counts[platform] += 1;
    pending.push({ ref: doc.ref, platform });

    if (WRITE && pending.length >= 400) {
      // eslint-disable-next-line no-await-in-loop
      await commit(pending);
      pending = [];
    }
  }

  if (WRITE && pending.length) await commit(pending);

  console.log(`utenti letti: ${users.size}`);
  console.log(`  ios:          ${counts.ios}`);
  console.log(`  web:          ${counts.web}`);
  console.log(`  sconosciuta:  ${counts.sconosciuta} (nessun campo scritto)`);
  console.log(`  gia' presente: ${counts.gia_presente}`);
  if (!WRITE) console.log("\nDRY RUN — rilancia con --write per applicare.");
})().catch((error) => {
  console.error("ERRORE", error.message);
  process.exit(1);
});

async function commit(rows) {
  const batch = db.batch();
  rows.forEach(({ ref, platform }) => {
    batch.set(ref, { platform, platformSource: "backfill-2026-08" }, { merge: true });
  });
  await batch.commit();
}
