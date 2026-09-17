/**
 * Accorpa un titolo duplicato dentro quello canonico.
 *
 * Caso tipico: TMDB ha DUE record per la stessa opera e noi ne abbiamo creato
 * un documento per ciascuno — di solito il secondo è uno stub di
 * `linkPersonToTitles` (`source: "tmdb_person_link"`, cast vuoto, zero voti).
 * All'utente arrivano due schede identiche.
 *
 * Il rimedio è quello già previsto dal modello dati (docs/context/TMDB.md):
 * l'id TMDB del doppione entra in `mergedTmdbIds` del titolo canonico, così
 * `linkPersonToTitles` e gli importer risolvono il proprietario e non
 * ricreano lo stub. Poi il documento duplicato si cancella.
 *
 * Dry-run di default: senza `--apply` non scrive niente.
 *
 * Uso:
 *   node scripts/merge-duplicate-title.js --canonical tmdb_tv_296285 \
 *     --duplicate tmdb_tv_325890 [--project gia-visto] [--apply]
 */
const admin = require("firebase-admin");
const yargs = require("yargs/yargs");

const args = yargs(process.argv.slice(2))
  .option("canonical", { type: "string", demandOption: true, describe: "id del titolo da tenere" })
  .option("duplicate", { type: "string", demandOption: true, describe: "id del titolo da assorbire" })
  .option("project", { type: "string", default: "gia-visto" })
  .option("apply", { type: "boolean", default: false })
  .option("force", { type: "boolean", default: false, describe: "procedi anche se il duplicato ha riferimenti" })
  .help().argv;

// Collection flat che puntano a un titolo con un campo `titleId`. Se una di
// queste ha righe sul duplicato, cancellarlo lascerebbe dati orfani: si ferma
// e lo dice, invece di far sparire il titolo sotto i piedi a qualcuno.
const FLAT_REFERENCES = [
  "ratings",
  "posts",
  "threads",
  "characterVotes",
  "titleEmotions",
  "recommendations",
];

// Sottocollezioni per-utente, interrogate in collection group.
const GROUP_REFERENCES = ["titleStates", "library"];

// PERCHE' UN CONTROLLO FALLITO E' BLOCCANTE QUANTO UN RIFERIMENTO TROVATO —
// prima un errore di query (indice mancante, permessi) finiva in `found` come
// stringa "non verificabile", e il filtro sui soli valori numerici la lasciava
// passare: il duplicato si cancellava con i dati utente ancora attaccati.
// E' cosi' che `tmdb_tv_308014` (doppione di `berlino`) ha lasciato in giro due
// librerie, un voto, un post e un thread appesi a un id morto, poi resuscitato
// come titolo fantasma senza nome (incidente 2026-09-09). Non sapere e' un
// motivo per fermarsi, non per procedere.
async function countReferences(db, titleId) {
  const found = {};
  const failed = {};

  for (const col of FLAT_REFERENCES) {
    const snap = await db.collection(col).where("titleId", "==", titleId).limit(5).get()
      .catch((err) => ({ error: err.message }));
    if (snap.error) {
      failed[col] = snap.error.slice(0, 80);
    } else if (snap.size > 0) {
      found[col] = snap.size;
    }
  }

  for (const col of GROUP_REFERENCES) {
    const snap = await db.collectionGroup(col).where("titleId", "==", titleId).limit(5).get()
      .catch((err) => ({ error: err.message }));
    if (snap.error) {
      failed[col] = snap.error.slice(0, 80);
    } else if (snap.size > 0) {
      found[col] = snap.size;
    }
  }

  return { found, failed };
}

(async () => {
  admin.initializeApp({ projectId: args.project });
  const db = admin.firestore();

  const canonicalRef = db.collection("titles").doc(args.canonical);
  const duplicateRef = db.collection("titles").doc(args.duplicate);
  const [canonicalSnap, duplicateSnap] = await Promise.all([canonicalRef.get(), duplicateRef.get()]);

  if (!canonicalSnap.exists) throw new Error(`titolo canonico inesistente: ${args.canonical}`);
  if (!duplicateSnap.exists) throw new Error(`titolo duplicato inesistente: ${args.duplicate}`);

  const canonical = canonicalSnap.data();
  const duplicate = duplicateSnap.data();
  const duplicateTmdbId = Number(duplicate.tmdbId || 0);
  if (!duplicateTmdbId) throw new Error(`il duplicato non ha tmdbId: ${args.duplicate}`);

  console.log(`canonico  ${args.canonical}  "${canonical.name}"  tmdbId=${canonical.tmdbId}  source=${canonical.source || "-"}`);
  console.log(`duplicato ${args.duplicate}  "${duplicate.name}"  tmdbId=${duplicateTmdbId}  source=${duplicate.source || "-"}`);

  const { found: refs, failed: refChecks } = await countReferences(db, args.duplicate);
  const subcollections = await duplicateRef.listCollections();

  if (Object.keys(refs).length) {
    console.log("riferimenti al duplicato:", JSON.stringify(refs));
  } else {
    console.log("riferimenti al duplicato: nessuno");
  }
  if (Object.keys(refChecks).length) {
    console.log("controlli NON riusciti:", JSON.stringify(refChecks));
  }
  console.log("sottocollezioni del duplicato:", subcollections.map((c) => c.id).join(", ") || "(nessuna)");

  if (Object.keys(refs).length && !args.force) {
    console.error("\nSTOP: il duplicato ha dati collegati. Vanno migrati prima, oppure --force.");
    process.exit(2);
  }
  if (Object.keys(refChecks).length && !args.force) {
    console.error("\nSTOP: non ho potuto verificare tutti i riferimenti (vedi sopra).");
    console.error("Sistema la query/l'indice e rilancia: cancellare alla cieca lascia dati orfani.");
    process.exit(2);
  }

  if (!args.apply) {
    console.log("\n(dry-run) con --apply farei:");
    console.log(`  1. ${args.canonical}.mergedTmdbIds += ${duplicateTmdbId}`);
    console.log(`  2. cancellazione di ${args.duplicate}${subcollections.length ? " e delle sue sottocollezioni" : ""}`);
    process.exit(0);
  }

  await canonicalRef.set({
    mergedTmdbIds: admin.firestore.FieldValue.arrayUnion(duplicateTmdbId),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  console.log(`\nok  ${args.canonical}.mergedTmdbIds += ${duplicateTmdbId}`);

  for (const sub of subcollections) {
    await db.recursiveDelete(sub);
    console.log(`ok  cancellata sottocollezione ${sub.id}`);
  }
  await duplicateRef.delete();
  console.log(`ok  cancellato ${args.duplicate}`);

  process.exit(0);
})().catch((err) => {
  console.error("errore:", err.message);
  process.exit(1);
});
