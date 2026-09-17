/**
 * Trova i "titoli fantasma": doc in `titles` senza `name`.
 *
 * PERCHE' — le denormalizzazioni sul doc titolo (provider, deep link, meta
 * durate) sono scritte con `set(..., { merge: true })`, che CREA il documento
 * se non esiste. Su un id cancellato (un doppione gia' accorpato) rinasce cosi'
 * un documento senza `name`, `type` ne' `posterPath`: i client lo mostrano come
 * "Senza titolo" e il gate anti-spoiler lo blocca per chiunque, perche' il
 * progresso del viewer sta sul titolo canonico e non su quell'id.
 * Incidente 2026-09-09: `titles/tmdb_tv_308014`, doppione di `berlino`.
 *
 * COME LI TROVA — Firestore non sa interrogare "campo assente": un doc senza
 * `name` non entra nell'indice di `name`. Quindi si confrontano gli id di
 * `titles` con quelli di `titles.orderBy("name")`. Due letture per documento,
 * niente payload (`select()`): sui ~21k titoli attuali sono spiccioli.
 *
 * Uso:
 *   node scripts/scan-ghost-titles.js [--project gia-visto] [--refs]
 *
 * Con `--refs` conta anche cosa punta a ogni fantasma (libreria utenti, voti,
 * post, thread, eventi feed): serve a decidere se basta cancellarlo o se prima
 * vanno migrati i riferimenti (`repair-ghost-title.js`).
 */
const admin = require("firebase-admin");
const yargs = require("yargs/yargs");

const args = yargs(process.argv.slice(2))
  .option("project", { type: "string", default: "gia-visto" })
  .option("refs", { type: "boolean", default: false, describe: "conta i riferimenti a ogni fantasma" })
  .help().argv;

const FLAT_REFERENCES = ["ratings", "posts", "threads", "characterVotes", "titleEmotions", "recommendations", "feedEvents"];
const GROUP_REFERENCES = ["titleStates"];

async function countReferences(db, titleId) {
  const found = {};
  const failed = {};

  for (const col of FLAT_REFERENCES) {
    // eslint-disable-next-line no-await-in-loop
    const snap = await db.collection(col).where("titleId", "==", titleId).get()
      .catch((err) => ({ error: err.message }));
    if (snap.error) failed[col] = snap.error.slice(0, 80);
    else if (snap.size > 0) found[col] = snap.size;
  }
  for (const col of GROUP_REFERENCES) {
    // eslint-disable-next-line no-await-in-loop
    const snap = await db.collectionGroup(col).where("titleId", "==", titleId).get()
      .catch((err) => ({ error: err.message }));
    if (snap.error) failed[col] = snap.error.slice(0, 80);
    else if (snap.size > 0) found[col] = snap.size;
  }
  return { found, failed };
}

// Prova a indovinare il titolo canonico: per un id `tmdb_<type>_<n>` e' il doc
// che dichiara quel tmdbId, direttamente o via `mergedTmdbIds`. Solo un
// suggerimento: la scelta resta di chi lancia la riparazione.
async function guessCanonical(db, ghostId) {
  const match = /^tmdb_(movie|tv)_(\d+)$/.exec(ghostId);
  if (!match) return null;
  const tmdbId = Number(match[2]);
  for (const q of [
    db.collection("titles").where("tmdbId", "==", tmdbId).limit(5),
    db.collection("titles").where("mergedTmdbIds", "array-contains", tmdbId).limit(5),
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const snap = await q.get().catch(() => null);
    const doc = snap?.docs.find((d) => d.id !== ghostId && d.get("name"));
    if (doc) return { id: doc.id, name: doc.get("name") };
  }
  return null;
}

(async () => {
  admin.initializeApp({ projectId: args.project });
  const db = admin.firestore();

  const [all, named] = await Promise.all([
    db.collection("titles").select().get(),
    db.collection("titles").orderBy("name").select().get(),
  ]);

  const namedIds = new Set(named.docs.map((d) => d.id));
  const ghosts = all.docs.map((d) => d.id).filter((id) => !namedIds.has(id));

  console.log(`titoli: ${all.size} · con name: ${named.size} · fantasma: ${ghosts.length}`);
  if (!ghosts.length) {
    process.exit(0);
  }

  for (const id of ghosts) {
    // eslint-disable-next-line no-await-in-loop
    const snap = await db.collection("titles").doc(id).get();
    const keys = Object.keys(snap.data() || {}).sort().join(", ");
    // eslint-disable-next-line no-await-in-loop
    const canonical = await guessCanonical(db, id);
    console.log(`\n${id}`);
    console.log(`  campi: ${keys || "(nessuno)"}`);
    console.log(`  canonico probabile: ${canonical ? `${canonical.id} ("${canonical.name}")` : "sconosciuto"}`);
    if (args.refs) {
      // eslint-disable-next-line no-await-in-loop
      const { found, failed } = await countReferences(db, id);
      console.log(`  riferimenti: ${Object.keys(found).length ? JSON.stringify(found) : "nessuno"}`);
      if (Object.keys(failed).length) console.log(`  controlli falliti: ${JSON.stringify(failed)}`);
    }
  }

  process.exit(ghosts.length ? 1 : 0);
})().catch((err) => {
  console.error("errore:", err.message);
  process.exit(1);
});
