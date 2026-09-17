#!/usr/bin/env node
/**
 * backfill-taste-countries.js
 *
 * Riempie `featureSums.countries` su `users/{uid}/tasteProfile/agg`.
 *
 * PERCHE' — il bucket esiste nel modello dal primo giorno (peso 0.12, una
 * feature per titolo) ma era vuoto su 205 profili su 205: `extractTitleFeatures`
 * cercava il paese in `countries` / `originCountry` / `countryCode` top-level,
 * campi che non sono mai stati popolati su nessun titolo. Il paese vive in
 * `meta.originCountry`. Corretto l'estrattore il 2026-08-26, i profili gia'
 * esistenti restavano comunque vuoti: li ricostruisce questo script.
 *
 * NON E' INCREMENTALE — ricalcola il bucket da zero sull'intera storia
 * dell'utente (titleStates consumati + voti) e lo SOSTITUISCE. Rilanciarlo non
 * raddoppia niente, e' la sua proprieta' di sicurezza principale.
 *
 * NON TOCCA IL RESTO — scrive solo il field path `featureSums.countries`.
 * `cumulativeWeight` esclude di proposito il bucket paesi, quindi
 * `confidenceScore`, il cold start e ogni altra soglia restano identici.
 *
 * Rollback: `--reset` svuota il bucket e riporta i profili a com'erano.
 *
 * Usage:
 *   cd functions
 *   node scripts/backfill-taste-countries.js                 # dry-run
 *   node scripts/backfill-taste-countries.js --write
 *   node scripts/backfill-taste-countries.js --write --uid <UID>
 *   node scripts/backfill-taste-countries.js --write --reset  # svuota
 */

const admin = require("firebase-admin");
const {
  FEATURE_WEIGHTS,
  deltaForAction,
  foldTitleDeltas,
  pruneFeatureSums,
  BUCKET_CAPS,
} = require("../lib/tasteProfileAggregate");

const WRITE = process.argv.includes("--write");
const RESET = process.argv.includes("--reset");
const ONLY_UID = argValue("--uid");
const PROJECT_ID = argValue("--project") || "gia-visto";

const CONSUMED_STATES = new Set([
  "seen_unrated",
  "rated",
  "in_progress",
  "completed_unrated",
  "completed",
]);

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0 || idx === process.argv.length - 1) return null;
  const value = String(process.argv[idx + 1] || "").trim();
  return value.startsWith("--") ? null : value || null;
}

function toMs(timestamp, fallback) {
  const seconds = Number(timestamp?._seconds ?? timestamp?.seconds);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallback;
}

admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();

async function loadCountryByTitle() {
  const snap = await db.collection("titles").select("meta").get();
  const byTitle = new Map();
  snap.forEach((doc) => {
    const codes = doc.data()?.meta?.originCountry;
    if (!Array.isArray(codes)) return;
    // Una sola feature per titolo, come FEATURE_TAKE.countries.
    const first = String(codes[0] || "").trim();
    if (first) byTitle.set(doc.id, [first]);
  });
  return byTitle;
}

async function loadConsumedByUser() {
  const snap = await db.collectionGroup("titleStates")
    .select("titleId", "state", "completedCount", "updatedAt")
    .get();
  const byUser = new Map();
  snap.forEach((doc) => {
    const data = doc.data() || {};
    const state = String(data.state || "");
    if (!CONSUMED_STATES.has(state) && !(Number(data.completedCount || 0) > 0)) return;
    const uid = doc.ref.path.split("/")[1];
    if (!uid) return;
    let titles = byUser.get(uid);
    if (!titles) { titles = new Map(); byUser.set(uid, titles); }
    titles.set(String(data.titleId || doc.id), toMs(data.updatedAt, Date.now()));
  });
  return byUser;
}

async function loadRatingsByUser() {
  const snap = await db.collection("ratings")
    .select("uid", "titleId", "rating", "level", "updatedAt")
    .get();
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

/**
 * Confronto fra il bucket gia' scritto e quello appena calcolato.
 *
 * Non si possono confrontare i due oggetti cosi' come sono: da Firestore
 * `lastAt` torna Timestamp, dal fold e' una Date, e l'ordine delle chiavi non
 * e' garantito. Senza normalizzare, ogni run direbbe "cambiato" e riscriverebbe
 * 182 documenti identici.
 */
function sameBucket(a = {}, b = {}) {
  const norm = (bucket) => Object.keys(bucket || {}).sort().map((code) => {
    const entry = bucket[code] || {};
    return [
      code,
      Math.round(Number(entry.sum || 0) * 1e6),
      Math.round(Number(entry.weight || 0) * 1e6),
      toMs(entry.lastAt, entry.lastAt instanceof Date ? entry.lastAt.getTime() : 0),
    ].join(":");
  }).join("|");
  return norm(a) === norm(b);
}

/** Il bucket paesi ricostruito dall'intera storia di un utente. */
function buildCountryBucket({ countryByTitle, consumed, ratings }) {
  const titleIds = new Set([...consumed.keys(), ...ratings.keys()]);
  const inputs = [];
  for (const titleId of titleIds) {
    const countries = countryByTitle.get(titleId);
    if (!countries) continue;
    const rated = ratings.get(titleId);
    const delta = rated
      ? deltaForAction("rating", rated.rating)
      : deltaForAction("import_seen");
    if (!delta) continue;
    const atMs = rated ? rated.atMs : (consumed.get(titleId) || Date.now());
    inputs.push({
      features: { genres: [], people: [], directors: [], countries },
      delta,
      createdAt: new Date(atMs),
    });
  }
  // `applyTitleDelta` sovrascrive `lastAt` a ogni passata: in ordine crescente
  // resta la data piu' recente, che e' quella che il decay a valle si aspetta.
  inputs.sort((a, b) => a.createdAt - b.createdAt);
  const { featureSums } = foldTitleDeltas({}, inputs);
  pruneFeatureSums(featureSums, { countries: BUCKET_CAPS.countries });
  return { bucket: featureSums.countries || {}, titlesUsed: inputs.length };
}

async function main() {
  console.log(`progetto ${PROJECT_ID} — ${RESET ? "RESET" : "backfill"} — ${WRITE ? "SCRITTURA" : "dry-run"}`);
  console.log(`peso per titolo: ${FEATURE_WEIGHTS.countries[0]}, cap bucket: ${BUCKET_CAPS.countries}`);

  const [countryByTitle, consumedByUser, ratingsByUser] = await Promise.all([
    loadCountryByTitle(),
    loadConsumedByUser(),
    loadRatingsByUser(),
  ]);
  console.log(`titoli con paese: ${countryByTitle.size}`);

  const profileRefs = [];
  if (ONLY_UID) {
    profileRefs.push(db.doc(`users/${ONLY_UID}/tasteProfile/agg`));
  } else {
    const users = await db.collection("users").select().get();
    users.forEach((doc) => profileRefs.push(db.doc(`users/${doc.id}/tasteProfile/agg`)));
  }

  const stats = { profiles: 0, updated: 0, empty: 0, unchanged: 0, errors: 0 };
  const preview = [];

  for (let i = 0; i < profileRefs.length; i += 200) {
    const docs = await db.getAll(...profileRefs.slice(i, i + 200));
    let batch = db.batch();
    let ops = 0;

    for (const doc of docs) {
      if (!doc.exists) continue;
      stats.profiles += 1;
      const uid = doc.ref.path.split("/")[1];

      if (RESET) {
        if (WRITE) { batch.update(doc.ref, { "featureSums.countries": {} }); ops += 1; }
        stats.updated += 1;
        continue;
      }

      const { bucket, titlesUsed } = buildCountryBucket({
        countryByTitle,
        consumed: consumedByUser.get(uid) || new Map(),
        ratings: ratingsByUser.get(uid) || new Map(),
      });

      const codes = Object.keys(bucket);
      if (!codes.length) { stats.empty += 1; continue; }

      const before = doc.data()?.featureSums?.countries || {};
      if (sameBucket(before, bucket)) { stats.unchanged += 1; continue; }

      if (WRITE) {
        // Field path puntato in update(): SOSTITUISCE la sotto-mappa e non
        // tocca gli altri bucket. In set() la stessa chiave sarebbe un campo
        // letterale chiamato "featureSums.countries" (footgun noto).
        batch.update(doc.ref, { "featureSums.countries": bucket });
        ops += 1;
      }
      stats.updated += 1;
      if (preview.length < 12) {
        const top = codes
          .map((code) => ({ code, weight: bucket[code].weight }))
          .sort((a, b) => b.weight - a.weight)
          .slice(0, 4)
          .map(({ code, weight }) => `${code}:${Math.round(weight / FEATURE_WEIGHTS.countries[0])}`)
          .join(" ");
        preview.push(`  ${uid.slice(0, 10)}… ${String(titlesUsed).padStart(5)} titoli → ${codes.length} paesi | ${top}`);
      }

      if (ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
    }
    if (WRITE && ops > 0) await batch.commit();
  }

  if (preview.length) {
    console.log("\nanteprima (titoli per paese, i primi 4):");
    preview.forEach((line) => console.log(line));
  }
  console.log("\n", JSON.stringify(stats));
  if (!WRITE) console.log("DRY RUN — rilancia con --write per applicare.");
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
