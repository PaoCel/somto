#!/usr/bin/env node
/**
 * rebuild-quiz-sagas.js
 *
 * Ricostruisce l'aggregato `quizMeta/sagas` (franchise giocabili: titoli con
 * quiz raggruppati per saga manuale o per titles.collectionId TMDB) a partire
 * da quizMeta/themes + i doc titles. Stessa logica di
 * rebuildQuizSagasAggregate in functions/index.js, tramite il modulo puro
 * modules/quizSagas.js (nessuna logica duplicata).
 *
 * Usage (da functions/):
 *   node scripts/rebuild-quiz-sagas.js            # dry-run (stampa, non scrive)
 *   node scripts/rebuild-quiz-sagas.js --write     # scrive quizMeta/sagas
 */
const admin = require("firebase-admin");
const { buildQuizSagas } = require("../modules/quizSagas");

const WRITE = process.argv.includes("--write");

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

(async () => {
  const themesSnap = await db.collection("quizMeta").doc("themes").get();
  const themes = (themesSnap.data() || {}).themes || [];
  if (!themes.length) {
    console.log("quizMeta/themes vuoto o assente: esegui prima node scripts/rebuild-quiz-themes.js --write.");
    return;
  }

  const titleIds = [...new Set(themes.map((t) => t && t.titleId).filter(Boolean))];
  const titlesById = new Map();
  for (let i = 0; i < titleIds.length; i += 30) {
    const chunk = titleIds.slice(i, i + 30);
    const refs = chunk.map((id) => db.collection("titles").doc(id));
    const snaps = await db.getAll(...refs, {
      fieldMask: ["collectionId", "collectionName", "name", "type"],
    });
    for (const snap of snaps) {
      if (!snap.exists) continue;
      const d = snap.data() || {};
      titlesById.set(snap.id, {
        collectionId: d.collectionId,
        collectionName: d.collectionName,
        name: d.name,
        type: d.type,
      });
    }
  }

  const sagas = buildQuizSagas({ themes, titlesById });
  const totalQuestions = sagas.reduce((sum, s) => sum + (Number(s.count) || 0), 0);

  console.log(`${themes.length} temi letti da quizMeta/themes -> ${sagas.length} saghe.\n`);
  for (const saga of sagas) {
    console.log(`[${saga.source}] ${saga.name} (${saga.sagaId}) - ${saga.titleIds.length} titoli, ${saga.count} domande`);
    console.log(`  ${saga.titles.join(", ")}`);
  }
  console.log(`\nTotale: ${sagas.length} saghe, ${totalQuestions} domande coperte.`);

  if (!WRITE) { console.log("\n[dry-run] non scritto. Rilancia con --write."); return; }

  await db.collection("quizMeta").doc("sagas").set({
    sagas,
    totalSagas: sagas.length,
    totalQuestions,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`\nScritto quizMeta/sagas: ${sagas.length} saghe, ${totalQuestions} domande.`);
})().then(() => process.exit(0)).catch((e) => { console.error("Failed:", e); process.exit(1); });
