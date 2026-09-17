#!/usr/bin/env node
/**
 * test-push.js — Invia una push di test a un token FCM specifico.
 *
 * USO:
 *   cd functions
 *   node scripts/test-push.js <FCM_TOKEN>
 *
 * Oppure con un UID Firestore (legge i token dal DB):
 *   node scripts/test-push.js --uid <USER_UID>
 *
 * Prerequisiti:
 *   - GOOGLE_APPLICATION_CREDENTIALS puntato al service account JSON
 *     oppure eseguito da una macchina con credenziali Firebase implicite
 *   - npm install (dalla dir functions/)
 */

const admin = require("firebase-admin");

// Inizializza Firebase Admin (usa Application Default Credentials)
if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

async function sendTestPush(token) {
  const message = {
    token,
    notification: {
      title: "Somto - Test Push",
      body: "Se vedi questa notifica, le push funzionano!",
    },
    data: {
      type: "test",
      url: "/account.html?tab=activity",
    },
    webpush: {
      notification: {
        title: "Somto - Test Push",
        body: "Se vedi questa notifica, le push funzionano!",
        icon: "/icons/icon-192.png",
      },
      fcmOptions: {
        link: "https://somto.it/account.html?tab=activity",
      },
    },
  };

  try {
    const response = await admin.messaging().send(message);
    console.log("✅ Push inviata con successo! Message ID:", response);
    return true;
  } catch (err) {
    console.error("❌ Errore nell'invio push:", err.code, err.message);
    if (err.code === "messaging/registration-token-not-registered") {
      console.error("   → Il token non è più valido (utente ha disinstallato o revocato permessi).");
    }
    if (err.code === "messaging/invalid-argument") {
      console.error("   → Token malformato o argomento non valido.");
    }
    return false;
  }
}

async function getTokensForUser(uid) {
  const snap = await db.collection("users").doc(uid).collection("notificationTokens").get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("Uso:");
    console.log("  node scripts/test-push.js <FCM_TOKEN>");
    console.log("  node scripts/test-push.js --uid <USER_UID>");
    console.log("");
    console.log("Esempio:");
    console.log("  node scripts/test-push.js dXyz123...");
    console.log("  node scripts/test-push.js --uid abc123def456");
    process.exit(1);
  }

  if (args[0] === "--uid") {
    const uid = args[1];
    if (!uid) {
      console.error("Specifica un UID: --uid <USER_UID>");
      process.exit(1);
    }

    console.log(`📋 Cercando token per utente ${uid}...`);
    const tokenDocs = await getTokensForUser(uid);

    if (!tokenDocs.length) {
      console.error(`❌ Nessun token FCM trovato per utente ${uid}`);
      console.error("   L'utente deve prima abilitare le notifiche nell'app.");
      process.exit(1);
    }

    console.log(`📱 Trovati ${tokenDocs.length} token(s):`);
    tokenDocs.forEach((t, i) => {
      console.log(`   [${i}] platform=${t.platform || "?"} token=${(t.token || "").slice(0, 30)}...`);
    });

    let ok = 0;
    for (const t of tokenDocs) {
      if (t.token) {
        const success = await sendTestPush(t.token);
        if (success) ok++;
      }
    }

    console.log(`\nRisultato: ${ok}/${tokenDocs.length} push inviate con successo.`);
  } else {
    // Token diretto
    const token = args[0];
    console.log(`📲 Invio push di test al token: ${token.slice(0, 30)}...`);
    await sendTestPush(token);
  }

  process.exit(0);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
