#!/usr/bin/env node
// Spot-check: quanti doc `titles` hanno posterPath legacy che inizia con "http://".
// READ-ONLY. NON modifica nulla.
//
// Uso:
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
//     node scripts/spot-check-posterpath.js
//
// In assenza di credentials: tenta ADC (gcloud auth application-default login).
// Se anche quello fallisce, esce con TODO.

import admin from "firebase-admin";

const PROJECT_ID = process.env.GCLOUD_PROJECT || "gia-visto";

function fail(msg) {
  console.error(`[spot-check] ${msg}`);
  process.exit(2);
}

try {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({ projectId: PROJECT_ID });
  } else {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: PROJECT_ID,
    });
  }
} catch (e) {
  fail(`init admin SDK fallita: ${e.message}\nTODO: richiede service account JSON o gcloud ADC.`);
}

const db = admin.firestore();

async function main() {
  console.log(`[spot-check] project: ${PROJECT_ID}`);
  console.log(`[spot-check] scanning titles for posterPath ^http:// ...`);

  // Range query: posterPath in [ "http://" , "http:0" )
  // Funziona perche' i caratteri ASCII di "/" (47) sono < "0" (48).
  const snap = await db.collection("titles")
    .where("posterPath", ">=", "http://")
    .where("posterPath", "<", "http:0")
    .get();

  const httpDocs = [];
  snap.forEach((d) => {
    const path = d.get("posterPath");
    if (typeof path === "string" && path.startsWith("http://") && !path.startsWith("https://")) {
      httpDocs.push({ id: d.id, posterPath: path });
    }
  });

  console.log(`[spot-check] titoli con posterPath http:// : ${httpDocs.length}`);
  if (httpDocs.length > 0) {
    console.log("[spot-check] primi 20:");
    httpDocs.slice(0, 20).forEach((d, i) => {
      console.log(`  ${i + 1}. ${d.id}  ${d.posterPath}`);
    });
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[spot-check] errore:", e.message);
    if (/UNAUTHENTICATED|permission|credential/i.test(e.message)) {
      console.error("TODO: richiede service account JSON o gcloud auth application-default login.");
    }
    process.exit(1);
  });
