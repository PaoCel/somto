#!/usr/bin/env node
/**
 * dedupe-notification-tokens.js — un token FCM (= un dispositivo) registrato
 * su piu' account significa che quel telefono riceve la stessa notifica N
 * volte, una per account destinatario.
 *
 * Succede quando dallo stesso device si fa login con account diversi: la
 * registrazione vecchia resta. Il trigger `cleanupDuplicateNotificationToken`
 * dovrebbe ripulire da solo, ma la sua query collection-group su `token`
 * falliva per indice mancante (aggiunto in firestore.indexes.json il
 * 2026-07-28) e l'errore veniva ingoiato: da qui l'arretrato.
 *
 * Tiene la registrazione piu' recente (updatedAt, fallback createdAt) e
 * cancella le altre: e' l'account con cui il device ha fatto login per ultimo.
 *
 * Uso (dry-run di default):
 *   cd functions
 *   node scripts/dedupe-notification-tokens.js
 *   node scripts/dedupe-notification-tokens.js --write
 *   node scripts/dedupe-notification-tokens.js --write --prefer uid1,uid2
 */

const admin = require("firebase-admin");

const WRITE = process.argv.includes("--write");
// uid che vincono se presenti fra i duplicati. Serve perche' `updatedAt` non e'
// un buon segnale di "ultimo login": l'app riscrive il doc solo quando il token
// cambia, non a ogni avvio.
const PREFER = (() => {
  const i = process.argv.indexOf("--prefer");
  if (i < 0 || !process.argv[i + 1]) return [];
  return String(process.argv[i + 1]).split(",").map((s) => s.trim()).filter(Boolean);
})();

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

function timeOf(data = {}) {
  const value = data.updatedAt || data.createdAt || null;
  if (value?.toMillis) return value.toMillis();
  return 0;
}

async function main() {
  const snap = await db.collectionGroup("notificationTokens").get();
  const byToken = new Map();
  for (const docSnap of snap.docs) {
    const token = String(docSnap.data()?.token || "").trim();
    if (!token) continue;
    if (!byToken.has(token)) byToken.set(token, []);
    byToken.get(token).push(docSnap);
  }

  const names = new Map();
  const nameOf = async (uid) => {
    if (!names.has(uid)) {
      const u = await db.collection("users").doc(uid).get();
      names.set(uid, u.data()?.displayName || uid);
    }
    return names.get(uid);
  };

  let deleted = 0;
  for (const [token, docs] of byToken) {
    if (docs.length < 2) continue;
    const sorted = [...docs].sort((a, b) => timeOf(b.data()) - timeOf(a.data()));
    const preferred = sorted.find((d) => PREFER.includes(d.ref.parent.parent.id));
    const keep = preferred || sorted[0];
    const drop = sorted.filter((d) => d !== keep);

    console.log(`\ntoken ${token.slice(0, 16)}… su ${docs.length} account`);
    console.log(`  tengo   ${await nameOf(keep.ref.parent.parent.id)} (${keep.ref.parent.parent.id})`);
    for (const docSnap of drop) {
      const uid = docSnap.ref.parent.parent.id;
      console.log(`  elimino ${await nameOf(uid)} (${uid})`);
      if (WRITE) await docSnap.ref.delete();
      deleted++;
    }
  }

  console.log(`\ndevice distinti: ${byToken.size} · registrazioni rimosse: ${deleted}`);
  if (!WRITE) console.log("DRY RUN — rilancia con --write per applicare.");
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("ERRORE:", err?.message || err);
  process.exit(1);
});
