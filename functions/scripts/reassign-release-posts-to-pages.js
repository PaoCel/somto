#!/usr/bin/env node
/**
 * reassign-release-posts-to-pages.js
 *
 * Sposta i post "uscita" gia' pubblicati dall'account Somto alla pagina
 * editoriale giusta per tema. Serve una volta sola: dal 2026-08-20 i post nuovi
 * nascono gia' con l'autore giusto (`pageForRelease` in
 * `lib/releaseConversationPosts.js`), ma quelli creati prima restano di Somto —
 * e una pagina senza un solo post non ha motivo di essere seguita.
 *
 * Tocca due campi e basta: `authorUid`/`authorName` sul post e `authorUid` sul
 * registro. NON rifa' il fan-out: i feedEvents gia' scritti restano com'erano
 * (portano ancora `actorUid: somto_official`), e rifarli consumerebbe i tetti
 * giornalieri del pubblico per affinita' senza mostrare niente di nuovo a
 * nessuno.
 *
 * Uso:
 *   cd functions
 *   node scripts/reassign-release-posts-to-pages.js          # dry-run
 *   node scripts/reassign-release-posts-to-pages.js --write
 */

const admin = require("firebase-admin");
const { pageForRelease } = require("../lib/releaseConversationPosts");

const PROJECT_ID = "gia-visto";
const WRITE = process.argv.includes("--write");
const SOMTO_OFFICIAL_UID = "somto_official";

async function main() {
  admin.initializeApp({ projectId: PROJECT_ID });
  const db = admin.firestore();

  const snap = await db.collection("officialUpdates").get();
  const rows = snap.docs
    .map((docSnap) => ({ slug: docSnap.id, data: docSnap.data() || {} }))
    .filter((row) => row.data.status === "published"
      && row.data.sourceEventId
      && (row.data.authorUid || SOMTO_OFFICIAL_UID) === SOMTO_OFFICIAL_UID);

  console.log(`post uscita pubblicati a nome Somto: ${rows.length}`);

  // Le pagine esistenti: se una manca, quel post resta dov'e'.
  const pagesSnap = await db.collection("users").where("accountType", "==", "page").get();
  const pages = new Map(pagesSnap.docs.map((docSnap) => [docSnap.id, String(docSnap.data()?.displayName || docSnap.id)]));

  const counts = {};
  let moved = 0;

  for (const row of rows) {
    const titleId = row.data.linkedTitleIds?.[0];
    if (!titleId) continue;
    const titleSnap = await db.collection("titles").doc(titleId).get();
    if (!titleSnap.exists) continue;
    const title = titleSnap.data() || {};

    const target = pageForRelease(title, title.type === "tv" ? "tv" : "movie");
    const pageName = pages.get(target);
    if (!pageName) {
      console.log(`  pagina ${target} assente → ${row.data.title} resta a Somto`);
      continue;
    }

    counts[target] = (counts[target] || 0) + 1;
    moved += 1;
    if (moved <= 8) console.log(`  ${row.data.title} → ${pageName}`);

    if (!WRITE) continue;

    const postId = row.data.postId || `official_${row.slug}`;
    await db.collection("posts").doc(postId).set(
      { authorUid: target, authorName: pageName },
      { merge: true }
    );
    await db.collection("officialUpdates").doc(row.slug).set({ authorUid: target }, { merge: true });
  }

  console.log(`\n${WRITE ? "spostati" : "da spostare"}: ${moved}`);
  Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([page, n]) => console.log(`  ${page}: ${n}`));
  if (!WRITE) console.log("nessuna scrittura: rilancia con --write");
  process.exit(0);
}

main().catch((err) => {
  console.error("errore:", err?.message || err);
  process.exit(1);
});
