#!/usr/bin/env node
/**
 * Blast one-off "aggiorna l'app" — notifica in-app `engagement_nudge`
 * NON bloccante a tutti gli utenti reali, con push automatico ai token holder
 * (via il fan-out trigger esistente su users/{uid}/notifications).
 *
 * Esclude: admin (ADMIN_UIDS), profili sintetici/guidati (isSynthetic /
 * accountType==="guided_profile"). Idempotente: salta chi ha già ricevuto il
 * nudge per lo stesso build target (marker engagement.appUpdateNudgeBuild).
 *
 * Auth: Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS o
 * gcloud auth application-default login) oppure --serviceAccount <path>.
 *
 * Esempi:
 *   node functions/scripts/blast-app-update.cjs --build 2026070605           # dry-run (default)
 *   node functions/scripts/blast-app-update.cjs --build 2026070605 --write   # invia davvero
 *   node functions/scripts/blast-app-update.cjs --build 2026070605 --limit 5 --write
 */

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) { out[key] = true; continue; }
    out[key] = next; i++;
  }
  return out;
}

// Carica ADMIN_UIDS da functions/.env se non già in ambiente.
function loadEnvAdminUids() {
  if (process.env.ADMIN_UIDS) return;
  const candidates = [
    path.resolve(__dirname, "../.env"),
    path.resolve(__dirname, "../.env.gia-visto"),
  ];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    const line = fs.readFileSync(f, "utf8").split(/\r?\n/).find((l) => l.startsWith("ADMIN_UIDS="));
    if (line) { process.env.ADMIN_UIDS = line.slice("ADMIN_UIDS=".length).trim(); return; }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const write = args.write === true;
  const buildTarget = Number(args.build || 0);
  if (!buildTarget) throw new Error("--build <numero> obbligatorio (es. 2026070605)");
  const limit = args.limit ? Number(args.limit) : Infinity;

  const message = String(
    args.message ||
    "È disponibile la nuova versione dell'app Somto. Aggiornala dall'App Store per le ultime novità."
  );
  const ctaUrl = String(args.ctaUrl || "/aggiorna.html");

  loadEnvAdminUids();
  const excludeUids = new Set(
    String(process.env.ADMIN_UIDS || "")
      .split(",").map((s) => s.trim()).filter(Boolean)
  );

  const projectId = String(args.project || process.env.GCLOUD_PROJECT || "gia-visto");
  if (args.serviceAccount) {
    admin.initializeApp({
      projectId,
      credential: admin.credential.cert(require(path.resolve(String(args.serviceAccount)))),
    });
  } else {
    admin.initializeApp({ projectId, credential: admin.credential.applicationDefault() });
  }
  const db = admin.firestore();
  const NOTIF_TTL_MS = 90 * 24 * 60 * 60 * 1000;

  const usersSnap = await db.collection("users").get();

  let eligible = 0, skippedAdmin = 0, skippedSynthetic = 0, skippedAlready = 0, sent = 0;
  const sample = [];
  let batch = db.batch();
  let ops = 0;

  for (const docSnap of usersSnap.docs) {
    const uid = docSnap.id;
    const u = docSnap.data() || {};

    if (u.isAdmin === true || excludeUids.has(uid)) { skippedAdmin++; continue; }
    if (u.isSynthetic === true || u.accountType === "guided_profile" || String(uid).startsWith("guided_")) {
      skippedSynthetic++; continue;
    }
    if (Number(u.engagement?.appUpdateNudgeBuild || 0) >= buildTarget) { skippedAlready++; continue; }

    eligible++;
    if (sample.length < 8) sample.push(u.displayName || uid);
    if (eligible > limit) continue;

    if (write) {
      const notifRef = db.collection("users").doc(uid).collection("notifications").doc();
      batch.set(notifRef, {
        toUid: uid,
        fromUid: "system",
        type: "engagement_nudge",
        data: { fromName: "Somto", message, ctaUrl },
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + NOTIF_TTL_MS),
      });
      ops++;
      batch.set(docSnap.ref, {
        "engagement.appUpdateNudgeBuild": buildTarget,
        "engagement.appUpdateNudgeAt": admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      ops++;
      sent++;
      if (ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
    }
  }

  if (write && ops > 0) await batch.commit();

  console.log(JSON.stringify({
    mode: write ? "WRITE" : "DRY-RUN",
    buildTarget, ctaUrl, message,
    totalUsers: usersSnap.size,
    eligible, sent,
    skippedAdmin, skippedSynthetic, skippedAlready,
    sampleEligible: sample,
  }, null, 2));
  if (!write) console.log("\nDry-run. Aggiungi --write per inviare le notifiche.");
}

main().catch((err) => { console.error("Errore:", err?.message || err); process.exit(1); });
