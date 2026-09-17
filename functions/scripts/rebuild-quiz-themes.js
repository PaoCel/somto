#!/usr/bin/env node
/**
 * rebuild-quiz-themes.js
 *
 * Ricostruisce l'aggregato `quizMeta/themes` (titoli con domande giocabili +
 * conteggio) scansionando quizQuestions where status in [approved,
 * beta_pending_review]. Stessa logica di rebuildQuizThemesAggregate in
 * functions/index.js. Usare come backfill iniziale o per refresh on-demand.
 *
 * Usage (da functions/):
 *   node scripts/rebuild-quiz-themes.js            # dry-run (stampa, non scrive)
 *   node scripts/rebuild-quiz-themes.js --write     # scrive quizMeta/themes
 */
const admin = require("firebase-admin");
const WRITE = process.argv.includes("--write");
const PLAYABLE = ["approved", "beta_pending_review"];

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

(async () => {
  const snap = await db
    .collection("quizQuestions")
    .where("status", "in", PLAYABLE)
    .select("titleId", "title", "mediaType")
    .get();

  const themes = {};
  let counted = 0;
  for (const docSnap of snap.docs) {
    const d = docSnap.data() || {};
    const titleId = d.titleId;
    if (!titleId) continue;
    counted += 1;
    const e = themes[titleId];
    if (e) { e.count += 1; if (!e.title && d.title) e.title = String(d.title).slice(0, 180); }
    else themes[titleId] = { titleId, title: String(d.title || "").slice(0, 180), mediaType: String(d.mediaType || "").slice(0, 20), count: 1 };
  }
  const themeList = Object.values(themes).sort((a, b) =>
    b.count !== a.count ? b.count - a.count : String(a.title).localeCompare(String(b.title), "it"));

  console.log(`Scanned ${snap.size} playable questions → ${themeList.length} themes.`);
  console.log("Top 10:", themeList.slice(0, 10).map((t) => `${t.title}(${t.count})`).join(", "));

  if (!WRITE) { console.log("\n[dry-run] not written. Re-run with --write."); return; }

  await db.collection("quizMeta").doc("themes").set({
    themes: themeList,
    totalTitles: themeList.length,
    totalQuestions: counted,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`\nWrote quizMeta/themes: ${themeList.length} titoli, ${counted} domande.`);
})().then(() => process.exit(0)).catch((e) => { console.error("Failed:", e); process.exit(1); });
