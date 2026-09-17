#!/usr/bin/env node
/**
 * backfill-title-original-language.js
 *
 * Popola `meta.originalLanguage` (codice ISO 639-1, es. "ja") e
 * `meta.originCountry` (codici ISO 3166-1, es. ["JP"]) sui titoli che non li
 * hanno. Questi campi alimentano la distinzione Anime vs Cartoni animati nel
 * breakdown statistiche per categoria del profilo (deriveContentCategory):
 * un titolo animato di lingua originale giapponese e' classificato `anime`,
 * altrimenti `cartoni_animati`.
 *
 * Usage:
 *   cd functions
 *   node scripts/backfill-title-original-language.js                # dry-run
 *   node scripts/backfill-title-original-language.js --write        # applica
 *   node scripts/backfill-title-original-language.js --write --limit 300
 *   node scripts/backfill-title-original-language.js --write --force # riscrive anche dove gia' presente
 *
 * Note:
 * - Richiede TMDB_KEY (o TMDB_API_KEY) come variabile d'ambiente.
 * - Salta i titoli senza un tmdbId risolvibile (campo, meta o docId tmdb_*).
 * - Scrive solo i field path `meta.originalLanguage` / `meta.originCountry`,
 *   senza toccare il resto di `meta`.
 */

const admin = require("firebase-admin");

const WRITE = process.argv.includes("--write");
const FORCE = process.argv.includes("--force");
const LIMIT = getIntArg("--limit", 0);

const TMDB_KEY = process.env.TMDB_KEY || process.env.TMDB_API_KEY;
const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_MIN_GAP_MS = 240;
const MAX_BATCH_OPS = 450;

let tmdbLastReqAt = 0;

if (!TMDB_KEY) {
  console.error("ERROR: TMDB_KEY mancante. Export TMDB_KEY=... prima di eseguire.");
  process.exit(1);
}

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

function getIntArg(flag, fallback = 0) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0 || idx === process.argv.length - 1) return fallback;
  const n = Number.parseInt(process.argv[idx + 1], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toPosInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const v = Math.round(n);
  return v > 0 ? v : 0;
}

function mediaTypeOf(title) {
  return String(title?.type || "").toLowerCase() === "tv" ? "tv" : "movie";
}

function extractTmdbTarget(title) {
  const fromTop = toPosInt(title?.tmdbId);
  if (fromTop) return { tmdbId: fromTop, mediaType: mediaTypeOf(title) };
  const fromMeta = toPosInt(title?.meta?.tmdbId);
  if (fromMeta) return { tmdbId: fromMeta, mediaType: mediaTypeOf(title) };
  const m = String(title?.id || "").match(/^tmdb_(movie|tv)_(\d+)$/i);
  if (m) return { tmdbId: toPosInt(m[2]), mediaType: m[1].toLowerCase() === "tv" ? "tv" : "movie" };
  return null;
}

function hasOriginalLanguage(title) {
  return String(title?.meta?.originalLanguage || "").trim().length > 0;
}

async function tmdbFetch(path, params = {}) {
  const wait = TMDB_MIN_GAP_MS - (Date.now() - tmdbLastReqAt);
  if (wait > 0) await sleep(wait);
  tmdbLastReqAt = Date.now();

  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set("api_key", TMDB_KEY);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === null || v === undefined || v === "") continue;
    url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString());
  if (res.status === 429) {
    await sleep(1200);
    return tmdbFetch(path, params);
  }
  if (!res.ok) {
    throw new Error(`TMDB ${res.status} ${path}`);
  }
  return res.json();
}

function extractOriginalLanguage(details) {
  return String(details?.original_language || "").trim().toLowerCase().slice(0, 12);
}

function extractOriginCountry(details) {
  const fromOrigin = Array.isArray(details?.origin_country) ? details.origin_country : [];
  const fromProduction = Array.isArray(details?.production_countries)
    ? details.production_countries.map((row) => row?.iso_3166_1)
    : [];
  const codes = [...fromOrigin, ...fromProduction]
    .map((code) => String(code || "").trim().toUpperCase())
    .filter(Boolean);
  return [...new Set(codes)].slice(0, 5);
}

async function main() {
  console.log(`\n=== BACKFILL meta.originalLanguage ===${WRITE ? " [WRITE]" : " [DRY-RUN]"}${FORCE ? " [FORCE]" : ""}`);
  if (!WRITE) console.log("Dry-run: nessuna modifica verra scritta.\n");

  const snap = await db.collection("titles").get();
  const titles = snap.docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() }));

  let work = titles.filter((t) => FORCE || !hasOriginalLanguage(t));
  if (LIMIT > 0) work = work.slice(0, LIMIT);

  console.log(`Titoli totali: ${titles.length}`);
  console.log(`Candidati al backfill: ${work.length}${LIMIT > 0 ? ` (limit ${LIMIT})` : ""}\n`);

  const stats = {
    processed: 0,
    updated: 0,
    skippedNoTmdbId: 0,
    languageFilled: 0,
    countryFilled: 0,
    errors: 0,
  };
  let batch = db.batch();
  let batchOps = 0;

  const flush = async () => {
    if (!batchOps) return;
    // Sostituisci il batch PRIMA del commit: se commit() fallisce, il batch
    // corrente resta comunque pulito e usabile (niente cascata di errori
    // "WriteBatch already committed"). I titoli del batch fallito mancheranno
    // ancora di originalLanguage e verranno ripresi alla prossima esecuzione.
    const pending = batch;
    batch = db.batch();
    batchOps = 0;
    if (!WRITE) return;
    try {
      await pending.commit();
    } catch (err) {
      console.log(`  batch commit fallito: ${err?.message || err} — titoli ritentati alla prossima esecuzione`);
    }
  };

  for (let i = 0; i < work.length; i += 1) {
    const t = work[i];
    const progress = `[${i + 1}/${work.length}]`;
    stats.processed += 1;

    try {
      const target = extractTmdbTarget(t);
      if (!target?.tmdbId) {
        stats.skippedNoTmdbId += 1;
        continue;
      }

      const endpoint = target.mediaType === "tv"
        ? `/tv/${target.tmdbId}`
        : `/movie/${target.tmdbId}`;
      const details = await tmdbFetch(endpoint, { language: "it-IT" });

      const language = extractOriginalLanguage(details);
      const country = extractOriginCountry(details);
      const update = {};
      if (language) update["meta.originalLanguage"] = language;
      if (country.length) update["meta.originCountry"] = country;
      if (!Object.keys(update).length) continue;

      update.updatedAt = admin.firestore.FieldValue.serverTimestamp();
      batch.update(t.ref, update);
      batchOps += 1;
      stats.updated += 1;
      if (language) stats.languageFilled += 1;
      if (country.length) stats.countryFilled += 1;
      console.log(`  ${progress} OK ${t.name} -> ${language || "?"}${country.length ? ` [${country.join(",")}]` : ""}`);

      if (batchOps >= MAX_BATCH_OPS) await flush();
    } catch (err) {
      stats.errors += 1;
      console.log(`  ${progress} ERR ${t.name} - ${err?.message || err}`);
    }
  }

  await flush();

  console.log("\n" + "=".repeat(56));
  console.log("RIEPILOGO");
  console.log("=".repeat(56));
  console.log(`Processati:                 ${stats.processed}`);
  console.log(`Aggiornati:                 ${stats.updated}`);
  console.log(`Senza tmdbId (saltati):     ${stats.skippedNoTmdbId}`);
  console.log(`originalLanguage riempito:  ${stats.languageFilled}`);
  console.log(`originCountry riempito:     ${stats.countryFilled}`);
  console.log(`Errori:                     ${stats.errors}`);
  console.log(`\n${WRITE ? "Modifiche applicate." : "Dry-run: nessuna modifica salvata."}`);
  console.log("\n=== FINE ===");
}

main().catch((err) => {
  console.error("ERRORE FATALE:", err);
  process.exit(1);
});
