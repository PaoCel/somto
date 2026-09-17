#!/usr/bin/env node
//
// report-push-permission.js — dice PERCHE' gli utenti non hanno le push,
// incrociando lo stato del permesso riportato dall'app
// (`usersPrivate/{uid}.notificationPermission`, scritto da
// PushNotificationsCoordinator dalla build 1.10.x in poi) con i token
// effettivamente registrati.
//
// Il numero che serve non e' "quanti hanno le push": e' come si dividono
// quelli che non le hanno, perche' i rimedi sono opposti.
//   - denied         -> il prompt di sistema NON si ripresenta piu': l'unica
//                       strada e' un banner che porta alle Impostazioni iOS.
//                       Altri prompt in app sono fiato sprecato.
//   - notDetermined  -> non ha mai visto il prompt: qui i banner funzionano.
//   - authorized ma senza token -> difetto di registrazione APNs/FCM, nessun
//                       lavoro di UX lo sistema.
//
// Read-only.
//
// Uso:
//   cd functions
//   GCLOUD_PROJECT=gia-visto node scripts/report-push-permission.js
"use strict";

const admin = require("firebase-admin");
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || "gia-visto" });
const db = admin.firestore();

const asDate = (v) => { try { return v && v.toDate ? v.toDate() : null; } catch { return null; } };
const pct = (n, tot) => (tot ? `${((100 * n) / tot).toFixed(0)}%` : "-");

(async () => {
  const [users, privates, tokens] = await Promise.all([
    db.collection("users").select("platform", "lastActiveAt").get(),
    db.collection("usersPrivate").select("notificationPermission").get(),
    db.collectionGroup("notificationTokens").select("platform").get(),
  ]);

  const withToken = new Set();
  tokens.forEach((d) => { const uid = d.ref.parent.parent?.id; if (uid) withToken.add(uid); });

  const perm = new Map();
  privates.forEach((d) => {
    const p = d.get("notificationPermission");
    if (p && p.status) perm.set(d.id, p);
  });

  const now = Date.now();
  const rows = { denied: 0, notDetermined: 0, authorized: 0, provisional: 0, ephemeral: 0, unknown: 0, "(non riportato)": 0 };
  const authorizedNoToken = [];
  let attivi = 0, attiviConToken = 0, reported = 0;

  users.forEach((d) => {
    const x = d.data();
    const la = asDate(x.lastActiveAt);
    const attivo = la && (now - la.getTime()) / 86400000 <= 30;
    if (attivo) { attivi += 1; if (withToken.has(d.id)) attiviConToken += 1; }
    const p = perm.get(d.id);
    if (!p) { rows["(non riportato)"] += 1; return; }
    reported += 1;
    const key = rows[p.status] !== undefined ? p.status : "unknown";
    rows[key] += 1;
    if (p.status === "authorized" && !withToken.has(d.id)) {
      authorizedNoToken.push({ uid: d.id, appVersion: p.appVersion || "?", updatedAt: asDate(p.updatedAt) });
    }
  });

  const tot = users.size;
  console.log(`\nutenti: ${tot} · con token: ${withToken.size} (${pct(withToken.size, tot)})`);
  console.log(`attivi ultimi 30gg: ${attivi} · di cui con token: ${attiviConToken} (${pct(attiviConToken, attivi)})\n`);

  console.log("stato del permesso riportato dall'app:");
  for (const [k, v] of Object.entries(rows)) {
    if (!v) continue;
    console.log(`  ${k.padEnd(16)} ${String(v).padStart(5)}  ${pct(v, tot)}`);
  }

  if (!reported) {
    console.log("\nNessuno stato ancora riportato: il dato arriva con la prima build che");
    console.log("include PushNotificationsCoordinator.reportAuthorizationStatus, e solo");
    console.log("dopo che l'utente ha aperto l'app almeno una volta.");
    process.exit(0);
  }

  console.log("\ncosa farne:");
  if (rows.denied) {
    console.log(`  ${rows.denied} hanno NEGATO: il prompt di sistema non torna. Serve un banner`);
    console.log("    che apra le Impostazioni iOS (UIApplication.openSettingsURLString).");
  }
  if (rows.notDetermined) {
    console.log(`  ${rows.notDetermined} non hanno MAI visto il prompt: qui i banner contestuali servono.`);
  }
  if (authorizedNoToken.length) {
    console.log(`  ${authorizedNoToken.length} hanno CONCESSO ma non hanno token: difetto di registrazione,`);
    console.log("    non un problema di UX. Primi casi:");
    authorizedNoToken.slice(0, 10).forEach((r) => {
      console.log(`      ${r.uid} · app ${r.appVersion} · ${r.updatedAt ? r.updatedAt.toISOString().slice(0, 10) : "?"}`);
    });
  }
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
