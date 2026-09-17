#!/usr/bin/env node
/**
 * backfill-taste-people.js
 *
 * Ricalcola `featureSums.people` e `featureSums.directors` su
 * `users/{uid}/tasteProfile/agg` usando i titoli COME SONO ADESSO.
 *
 * PERCHE' — quei due bucket sono stati costruiti quando `castIds` stava sul 16%
 * dei titoli e `directorIds` sul 7,2%: un titolo senza quei campi non
 * contribuiva niente. Dopo `backfill-title-cast.js` (2026-08-26) i titoli in
 * libreria sono al 94,3% e 64,7%, ma i profili non si aggiornano da soli —
 * il fold e' avvenuto una volta sola, al momento del segnale o dell'import.
 *
 * FEDELE, NON NUOVO — usa le stesse DUE sorgenti della produzione, senza
 * inventare semantica:
 *   1. replay segnali — i doc `users/{uid}/signals/*` con `delta` e `createdAt`
 *      gia' salvati. E' quello che fa `updateTasteProfileOnSignal`.
 *   2. voti — la collection `ratings`, qualunque sia la source del titleState.
 *      I segnali partono dal 2026-05-15 e per tutto quello che c'era prima la
 *      traccia e' andata, ma il voto c'e' ancora: rifarlo da li' ricostruisce
 *      cio' che la produzione aveva gia' applicato.
 *   3. import senza voto — i `titleStates` consumati con `source` che inizia
 *      per `import_`, con `import_seen`. E' quello che fa
 *      `applyImportTasteProfile`.
 * Un titolo marcato visto in app SENZA voto non scriveva nessun segnale, quindi
 * non entra nemmeno adesso.
 *
 * COSA NON TOCCA — `genres` e `countries` (non dipendono dal cast) e
 * `confidenceScore`. Quest'ultimo di proposito: misura quanto sappiamo della
 * PERSONA, e aver arricchito i metadati del catalogo non significa che quella
 * persona ci abbia detto qualcosa in piu'. Alzarlo sposterebbe il cold start e
 * la soglia `MIN_TASTE_CONFIDENCE` senza motivo.
 *
 * ROLLBACK — prima di scrivere salva i bucket attuali in un file JSON
 * (default ~/somto-taste-backups/). A differenza di `countries`, qui si
 * SOVRASCRIVE roba che c'era: lo stato precedente non e' ricostruibile, perche'
 * rifletteva titoli che oggi non esistono piu' in quella forma.
 *
 *   node scripts/backfill-taste-people.js --restore <file.json> --write
 *
 * Usage:
 *   cd functions
 *   node scripts/backfill-taste-people.js                    # dry-run
 *   node scripts/backfill-taste-people.js --write
 *   node scripts/backfill-taste-people.js --write --uid <UID>
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const admin = require("firebase-admin");
const {
  BUCKET_CAPS,
  deltaForAction,
  extractTitleFeatures,
  foldTitleDeltas,
  pruneFeatureSums,
} = require("../lib/tasteProfileAggregate");

const WRITE = process.argv.includes("--write");
const ONLY_UID = argValue("--uid");
const RESTORE = argValue("--restore");
const BACKUP_DIR = argValue("--backup") || path.join(os.homedir(), "somto-taste-backups");
const PROJECT_ID = argValue("--project") || "gia-visto";

const CONSUMED_STATES = new Set(["seen_unrated", "rated", "in_progress", "completed_unrated", "completed"]);

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0 || idx === process.argv.length - 1) return null;
  const value = String(process.argv[idx + 1] || "").trim();
  return value.startsWith("--") ? null : value || null;
}

function toMs(value, fallback = 0) {
  const seconds = Number(value?._seconds ?? value?.seconds);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();

/** Confronto stabile: da Firestore `lastAt` torna Timestamp, dal fold e' Date. */
function sameBucket(a = {}, b = {}) {
  const norm = (bucket) => Object.keys(bucket || {}).sort().map((id) => {
    const entry = bucket[id] || {};
    return [
      id,
      Math.round(Number(entry.sum || 0) * 1e6),
      Math.round(Number(entry.weight || 0) * 1e6),
      toMs(entry.lastAt),
    ].join(":");
  }).join("|");
  return norm(a) === norm(b);
}

async function loadTitles() {
  const snap = await db.collection("titles").select("genres", "castIds", "directorIds", "meta").get();
  const map = new Map();
  snap.forEach((doc) => map.set(doc.id, { id: doc.id, ...doc.data() }));
  return map;
}

/** Solo i titoli arrivati da un import: sono gli unici che il fold ha toccato. */
async function loadImportedByUser() {
  const snap = await db.collectionGroup("titleStates")
    .select("titleId", "state", "completedCount", "source", "updatedAt")
    .get();
  const byUser = new Map();
  snap.forEach((doc) => {
    const data = doc.data() || {};
    if (!String(data.source || "").startsWith("import_")) return;
    const state = String(data.state || "");
    if (!CONSUMED_STATES.has(state) && !(Number(data.completedCount || 0) > 0)) return;
    const uid = doc.ref.path.split("/")[1];
    let titles = byUser.get(uid);
    if (!titles) { titles = new Map(); byUser.set(uid, titles); }
    titles.set(String(data.titleId || doc.id), toMs(data.updatedAt, Date.now()));
  });
  return byUser;
}

async function loadRatingsByUser() {
  const snap = await db.collection("ratings").select("uid", "titleId", "rating", "level", "updatedAt").get();
  const byUser = new Map();
  snap.forEach((doc) => {
    const data = doc.data() || {};
    if (data.level && data.level !== "title") return;
    const uid = String(data.uid || "");
    const titleId = String(data.titleId || "");
    if (!uid || !titleId) return;
    let ratings = byUser.get(uid);
    if (!ratings) { ratings = new Map(); byUser.set(uid, ratings); }
    ratings.set(titleId, { rating: Number(data.rating) || 0, atMs: toMs(data.updatedAt, Date.now()) });
  });
  return byUser;
}

/** I segnali in-app, con il delta gia' calcolato al momento della scrittura. */
async function loadSignalsByUser() {
  const snap = await db.collectionGroup("signals").select("titleId", "actionType", "rawValue", "delta", "createdAt").get();
  const byUser = new Map();
  snap.forEach((doc) => {
    const data = doc.data() || {};
    const titleId = String(data.titleId || "");
    if (!titleId) return;
    const uid = doc.ref.path.split("/")[1];
    const delta = Number.isFinite(Number(data.delta))
      ? Number(data.delta)
      : deltaForAction(String(data.actionType || ""), data.rawValue);
    if (!delta) return;
    let rows = byUser.get(uid);
    if (!rows) { rows = []; byUser.set(uid, rows); }
    rows.push({ titleId, delta, actionType: String(data.actionType || ""), atMs: toMs(data.createdAt, Date.now()) });
  });
  return byUser;
}

/**
 * Fonde il bucket ricalcolato con quello esistente, per id.
 *
 * PERCHE' NON SI SOSTITUISCE E BASTA — il ricalcolo copre solo le due sorgenti
 * ancora leggibili (titleStates da import + doc `signals`). Alcuni profili hanno
 * pero' contenuto che non viene da nessuna delle due: i segnali piu' vecchi non
 * ci sono piu' (la collection parte dal 2026-05-15) e la loro traccia resta solo
 * dentro il bucket. Misurato in dry-run: **64 profili su 205** sarebbero rimasti
 * senza persone con una sostituzione secca, uno perdendone 54. Sostituire vuol
 * dire cancellarli.
 *
 * REGOLA — dove il ricalcolo conosce un id vince lui, perche' e' costruito sui
 * titoli di oggi e quindi non puo' che essere piu' completo per quell'id. Dove
 * non lo conosce resta il valore storico. Non si sommano mai i due: sarebbe
 * doppio conteggio.
 */
function mergeBucket(previous = {}, next = {}) {
  return { ...(previous && typeof previous === "object" ? previous : {}), ...next };
}

function rebuild({ titles, imported, ratings, signals }) {
  const inputs = [];

  // 1. I segnali sopravvissuti, con il delta gia' calcolato allora: sono la
  //    verita' su cosa la produzione ha applicato.
  const ratedBySignal = new Set();
  for (const row of signals) {
    const title = titles.get(row.titleId);
    if (!title) continue;
    if (row.actionType === "rating") ratedBySignal.add(row.titleId);
    inputs.push({ features: extractTitleFeatures(title), delta: row.delta, createdAt: new Date(row.atMs) });
  }

  // 2. I VOTI, qualunque sia la source del titleState.
  //
  //    Un voto in app scriveva un segnale, che il trigger piegava nel profilo.
  //    I segnali pero' partono dal 2026-05-15: per tutto quello che c'era prima
  //    la traccia e' andata, ma il voto e' ancora nella collection `ratings`.
  //    Rifarlo da li' NON inventa semantica, ricostruisce quello che la
  //    produzione aveva gia' fatto.
  //
  //    Limitarsi ai titoli importati sembrava piu' prudente e invece tagliava
  //    fuori 4.772 righe su 186 utenti — cioe' proprio chi vota in app invece di
  //    importare, la parte piu' attiva. Un utente con 371 titoli votati e zero
  //    import non prendeva niente.
  for (const [titleId, rated] of ratings) {
    if (ratedBySignal.has(titleId)) continue; // gia' contato al punto 1
    const title = titles.get(titleId);
    if (!title) continue;
    const delta = deltaForAction("rating", rated.rating);
    if (!delta) continue;
    inputs.push({ features: extractTitleFeatures(title), delta, createdAt: new Date(rated.atMs) });
  }

  // 3. Gli importati SENZA voto: preferenza positiva debole, come fa
  //    `applyImportTasteProfile`. Un titolo marcato visto in app senza voto non
  //    scriveva nessun segnale, quindi non entra nemmeno adesso.
  for (const [titleId, atMs] of imported) {
    if (ratings.has(titleId)) continue; // gia' contato al punto 2
    const title = titles.get(titleId);
    if (!title) continue;
    const delta = deltaForAction("import_seen");
    if (!delta) continue;
    inputs.push({ features: extractTitleFeatures(title), delta, createdAt: new Date(atMs) });
  }
  // `applyTitleDelta` sovrascrive `lastAt`: in ordine crescente resta la data
  // piu' recente, che e' quella che il decay a valle si aspetta.
  inputs.sort((a, b) => a.createdAt - b.createdAt);
  const { featureSums } = foldTitleDeltas({}, inputs);
  pruneFeatureSums(featureSums, { people: BUCKET_CAPS.people, directors: BUCKET_CAPS.directors });
  return {
    people: featureSums.people || {},
    directors: featureSums.directors || {},
    titlesUsed: inputs.length,
  };
}

async function restore() {
  const file = path.resolve(RESTORE);
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  console.log(`ripristino da ${file}: ${rows.length} profili — ${WRITE ? "SCRITTURA" : "dry-run"}`);
  if (!WRITE) { console.log("DRY RUN — aggiungi --write."); return; }
  let batch = db.batch();
  let ops = 0;
  for (const row of rows) {
    batch.update(db.doc(`users/${row.uid}/tasteProfile/agg`), {
      "featureSums.people": row.people || {},
      "featureSums.directors": row.directors || {},
    });
    if (++ops >= 20) { await batch.commit(); batch = db.batch(); ops = 0; }
  }
  if (ops) await batch.commit();
  console.log(`ripristinati ${rows.length} profili.`);
}

async function main() {
  if (RESTORE) return restore();

  console.log(`progetto ${PROJECT_ID} — ${WRITE ? "SCRITTURA" : "dry-run"}`);
  const [titles, importedByUser, ratingsByUser, signalsByUser] = await Promise.all([
    loadTitles(), loadImportedByUser(), loadRatingsByUser(), loadSignalsByUser(),
  ]);
  console.log(`titoli: ${titles.size} | utenti con import: ${importedByUser.size} | utenti con segnali: ${signalsByUser.size}`);

  const refs = [];
  if (ONLY_UID) refs.push(db.doc(`users/${ONLY_UID}/tasteProfile/agg`));
  else (await db.collection("users").select().get()).forEach((doc) => refs.push(db.doc(`users/${doc.id}/tasteProfile/agg`)));

  const stats = { profiles: 0, changed: 0, unchanged: 0, rebuildEmpty: 0, peopleBefore: 0, peopleAfter: 0, dirBefore: 0, dirAfter: 0 };
  const backup = [];
  const updates = [];
  const preview = [];

  for (let i = 0; i < refs.length; i += 200) {
    const docs = await db.getAll(...refs.slice(i, i + 200));
    for (const doc of docs) {
      if (!doc.exists) continue;
      stats.profiles += 1;
      const uid = doc.ref.path.split("/")[1];
      const before = doc.data()?.featureSums || {};

      const rebuilt = rebuild({
        titles,
        imported: importedByUser.get(uid) || new Map(),
        ratings: ratingsByUser.get(uid) || new Map(),
        signals: signalsByUser.get(uid) || [],
      });
      const merged = {
        people: mergeBucket(before.people, rebuilt.people),
        directors: mergeBucket(before.directors, rebuilt.directors),
      };
      pruneFeatureSums(merged, { people: BUCKET_CAPS.people, directors: BUCKET_CAPS.directors });
      const next = { ...merged, titlesUsed: rebuilt.titlesUsed };
      if (!Object.keys(rebuilt.people).length && Object.keys(before.people || {}).length) stats.rebuildEmpty += 1;

      stats.peopleBefore += Object.keys(before.people || {}).length;
      stats.dirBefore += Object.keys(before.directors || {}).length;
      stats.peopleAfter += Object.keys(next.people).length;
      stats.dirAfter += Object.keys(next.directors).length;

      if (sameBucket(before.people, next.people) && sameBucket(before.directors, next.directors)) {
        stats.unchanged += 1;
        continue;
      }
      stats.changed += 1;
      backup.push({ uid, people: before.people || {}, directors: before.directors || {} });
      updates.push({ ref: doc.ref, people: next.people, directors: next.directors });
      if (preview.length < 10) {
        preview.push(`  ${uid.slice(0, 10)}… ${String(next.titlesUsed).padStart(5)} segnali → persone ${Object.keys(before.people || {}).length}→${Object.keys(next.people).length}, registi ${Object.keys(before.directors || {}).length}→${Object.keys(next.directors).length}`);
      }
    }
  }

  if (preview.length) {
    console.log("\nanteprima:");
    preview.forEach((line) => console.log(line));
  }
  console.log("\n", JSON.stringify(stats));
  console.log(`persone nei bucket: ${stats.peopleBefore} → ${stats.peopleAfter} (${stats.peopleAfter - stats.peopleBefore >= 0 ? "+" : ""}${stats.peopleAfter - stats.peopleBefore})`);
  if (stats.rebuildEmpty) console.log(`${stats.rebuildEmpty} profili avrebbero perso tutto con una sostituzione secca: la fusione li tiene.`);
  console.log(`registi nei bucket: ${stats.dirBefore} → ${stats.dirAfter} (${stats.dirAfter - stats.dirBefore >= 0 ? "+" : ""}${stats.dirAfter - stats.dirBefore})`);

  if (!WRITE) { console.log("\nDRY RUN — rilancia con --write per applicare."); return; }
  if (!updates.length) { console.log("niente da scrivere."); return; }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date(Number(process.env.SOMTO_BACKUP_STAMP) || Date.now()).toISOString().replace(/[:.]/g, "-");
  const backupFile = path.join(BACKUP_DIR, `taste-people-${stamp}.json`);
  fs.writeFileSync(backupFile, JSON.stringify(backup, null, 1));
  console.log(`\nbackup dello stato precedente: ${backupFile} (${backup.length} profili)`);

  // 20 e non 400: ogni profilo porta fino a 400 persone e 250 registi, quindi un
  // batch pieno sfonda il limite di dimensione della transazione
  // ("Transaction too big"). Qui il collo di bottiglia sono i byte, non le op.
  const BATCH_DOCS = 20;
  let batch = db.batch();
  let ops = 0;
  for (const row of updates) {
    // Field path puntato in update(): sostituisce la sotto-mappa e non tocca
    // genres, countries o confidenceScore. In set() sarebbe un campo letterale.
    batch.update(row.ref, { "featureSums.people": row.people, "featureSums.directors": row.directors });
    if (++ops >= BATCH_DOCS) { await batch.commit(); batch = db.batch(); ops = 0; }
  }
  if (ops) await batch.commit();
  console.log(`scritti ${updates.length} profili.`);
  console.log(`rollback: node scripts/backfill-taste-people.js --restore ${backupFile} --write`);
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
