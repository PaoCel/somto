#!/usr/bin/env node
"use strict";

/**
 * Avvisa gli account password non verificati che c'e' una finestra per
 * verificare l'email, senza bloccare nessuno.
 *
 * Chi riceve la notifica: solo provider `password`, email non verificata,
 * profilo gia' esistente. Google e Apple sono esclusi per definizione: il
 * provider porta gia' un'email verificata.
 *
 * L'id della notifica contiene la scadenza, quindi rilanciare lo script non
 * manda due volte lo stesso avviso.
 *
 *   node scripts/notify-email-verification-window.js --project gia-visto --deadline 2026-09-28
 *   node scripts/notify-email-verification-window.js --project gia-visto --deadline 2026-09-28 --execute --confirm-project gia-visto
 */

const admin = require("firebase-admin");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] || "").trim() : "";
}

const projectId = arg("--project");
const deadline = arg("--deadline");
const confirmProject = arg("--confirm-project");
const execute = process.argv.includes("--execute");

if (!projectId || !deadline) {
  console.error("Uso: --project <id> --deadline <YYYY-MM-DD> [--execute --confirm-project <id>]");
  process.exit(2);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
  console.error("La scadenza va scritta come YYYY-MM-DD.");
  process.exit(2);
}
if (execute && confirmProject !== projectId) {
  console.error("Esecuzione bloccata: --confirm-project deve coincidere con --project.");
  process.exit(2);
}

admin.initializeApp({ projectId });
const db = admin.firestore();

const NOTIFICATION_ID = `verify_email_${deadline.replace(/-/g, "")}`;
const TTL_MS = 90 * 24 * 60 * 60 * 1000;

function deadlineLabel(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const mesi = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno",
    "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
  return `${d} ${mesi[m - 1]}`;
}

async function listCandidates() {
  const out = [];
  let pageToken;
  do {
    // eslint-disable-next-line no-await-in-loop
    const page = await admin.auth().listUsers(1000, pageToken);
    for (const user of page.users) {
      if (user.emailVerified) continue;
      const providers = (user.providerData || []).map((p) => p.providerId);
      const isPassword = providers.includes("password") || providers.length === 0;
      if (!isPassword) continue;
      if (user.customClaims?.admin === true || user.customClaims?.isAdmin === true) continue;
      out.push(user);
    }
    pageToken = page.pageToken;
  } while (pageToken);
  return out;
}

async function main() {
  const candidates = await listCandidates();
  const targets = [];
  let senzaProfilo = 0;
  let sintetici = 0;

  for (const user of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const snap = await db.collection("users").doc(user.uid).get();
    if (!snap.exists) { senzaProfilo += 1; continue; }
    const data = snap.data() || {};
    if (data.isSynthetic === true || data.accountType === "guided_profile" || data.isAdmin === true) {
      sintetici += 1;
      continue;
    }
    targets.push(user.uid);
  }

  console.log(JSON.stringify({
    projectId,
    deadline,
    mode: execute ? "execute" : "dry-run",
    passwordNonVerificati: candidates.length,
    esclusiSenzaProfilo: senzaProfilo,
    esclusiSinteticiOAdmin: sintetici,
    riceveranoLaNotifica: targets.length,
    notificationId: NOTIFICATION_ID,
  }, null, 2));

  if (!execute) return;

  const message = `Verifica la tua email entro il ${deadlineLabel(deadline)}: serve a proteggere il tuo account.`;
  let written = 0;
  for (let i = 0; i < targets.length; i += 400) {
    const chunk = targets.slice(i, i + 400);
    const batch = db.batch();
    for (const uid of chunk) {
      batch.set(
        db.collection("users").doc(uid).collection("notifications").doc(NOTIFICATION_ID),
        {
          toUid: uid,
          fromUid: "somto_official",
          // Tipo gia' gestito da web e iOS distribuiti: un tipo nuovo non
          // verrebbe disegnato dalle build in giro e la riga resterebbe vuota.
          type: "engagement_nudge",
          data: { fromName: "Somto", message, ctaUrl: "/account.html" },
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + TTL_MS),
        },
        { merge: true }
      );
    }
    // eslint-disable-next-line no-await-in-loop
    await batch.commit();
    written += chunk.length;
    console.log(`  scritte ${written}/${targets.length}`);
  }
  console.log(JSON.stringify({ notificheScritte: written, testo: message }, null, 2));
}

main().catch((err) => {
  console.error("ERRORE:", String(err?.message || err).slice(0, 200));
  process.exitCode = 1;
});
