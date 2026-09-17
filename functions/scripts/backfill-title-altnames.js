#!/usr/bin/env node
/**
 * backfill-title-altnames.js
 *
 * Popola `altNamesLower: string[]` sui doc `titles` con un tmdbId risolvibile:
 * varianti di nome normalizzate (lowercase, accent-stripped) da
 * original_title/original_name + alternative_titles TMDB (filtrate a
 * IT/US/GB — vedi ALT_NAMES_RELEVANT_COUNTRIES in modules/tmdb.js), cap 10,
 * dedup, esclude il valore gia' coperto da `nameLower`.
 *
 * Perche': la cascata di matching import (functions/lib/importAdapters/
 * matching.js) risolve nameLower->titleId, ma Netflix/TV Time esportano
 * spesso il nome in inglese/originale mentre il catalogo Somto ha `name`
 * localizzato IT — un titolo come "The Bear" non matcha mai "Orso" senza
 * questo denormalizzato. `altNamesLower` chiude il gap con UNA query
 * Firestore array-contains (nessuna chiamata TMDB aggiuntiva in fase di
 * import), invece di forzare ogni riga non risolta su TMDB search.
 *
 * Usage:
 *   cd functions
 *   node scripts/backfill-title-altnames.js                 # dry-run
 *   node scripts/backfill-title-altnames.js --write          # applica
 *   node scripts/backfill-title-altnames.js --write --limit 300
 *   node scripts/backfill-title-altnames.js --write --force  # riscrive anche dove gia' presente
 *
 * Note:
 * - Richiede TMDB_KEY (o TMDB_API_KEY) come variabile d'ambiente.
 * - Salta i titoli senza un tmdbId risolvibile (campo, meta o docId tmdb_*).
 * - Rispetta `tmdbSync.syncDisabled` (titoli curati manualmente / merge, es.
 *   "berlino"): mai risincronizzare, come refreshTitleFromTmdb e
 *   adminBackfillTitleMetadata.
 * - Scrive solo il field path `altNamesLower`, non tocca il resto del doc.
 * - Rate limit verso TMDB identico agli altri script offline (TMDB_MIN_GAP_MS,
 *   retry su 429), niente `withCircuitBreaker` (quello e' per la runtime delle
 *   Cloud Functions, non per uno script batch one-shot).
 */

const admin = require("firebase-admin");
const { extractAltNamesLower } = require("../modules/tmdb");

const WRITE = process.argv.includes("--write");
const FORCE = process.argv.includes("--force");
const LIMIT = getIntArg("--limit", 0);

const TMDB_KEY = process.env.TMDB_KEY || process.env.TMDB_API_KEY;
const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_MIN_GAP_MS = 240;
const MAX_BATCH_OPS = 450;

let tmdbLastReqAt = 0;

if (!TMDB_KEY) {
  console.error("ERRORE: TMDB_KEY mancante. Export TMDB_KEY=... prima di eseguire.");
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
  return String(title?.type || title?.meta?.mediaType || "").toLowerCase() === "tv" ? "tv" : "movie";
}

// Mirrors extractTmdbTarget/extractKnownTmdb in the sibling backfill scripts.
function extractTmdbTarget(titleId, title) {
  const mediaType = mediaTypeOf(title);
  const topLevel = toPosInt(title?.tmdbId);
  if (topLevel) return { tmdbId: topLevel, mediaType };
  const metaLevel = toPosInt(title?.meta?.tmdbId);
  if (metaLevel) return { tmdbId: metaLevel, mediaType };
  const m = String(titleId || "").match(/^tmdb_(movie|tv)_(\d+)$/i);
  if (m) return { tmdbId: toPosInt(m[2]), mediaType: m[1].toLowerCase() === "tv" ? "tv" : "movie" };
  return null;
}

function hasAltNames(title) {
  return Array.isArray(title?.altNamesLower) && title.altNamesLower.length > 0;
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

async function main() {
  console.log(`\n=== BACKFILL altNamesLower ===${WRITE ? " [WRITE]" : " [DRY-RUN]"}${FORCE ? " [FORCE]" : ""}`);
  if (!WRITE) console.log("Dry-run: nessuna modifica verra scritta.\n");

  const snap = await db.collection("titles").get();
  const titles = snap.docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() }));

  let work = titles.filter((t) => {
    if (t?.tmdbSync?.syncDisabled === true) return false;
    if (!FORCE && hasAltNames(t)) return false;
    return Boolean(extractTmdbTarget(t.id, t));
  });
  if (LIMIT > 0) work = work.slice(0, LIMIT);

  console.log(`Titoli totali: ${titles.length}`);
  console.log(`Candidati al backfill: ${work.length}${LIMIT > 0 ? ` (limit ${LIMIT})` : ""}\n`);

  const stats = {
    processed: 0,
    updated: 0,
    skippedNoTmdbId: 0,
    skippedSyncDisabled: 0,
    skippedNoAltNames: 0,
    errors: 0,
  };
  let batch = db.batch();
  let batchOps = 0;

  const flush = async () => {
    if (!batchOps) return;
    // Sostituisci il batch PRIMA del commit: se commit() fallisce, il batch
    // corrente resta comunque pulito e usabile (niente cascata di errori
    // "WriteBatch already committed"). I titoli del batch fallito mancheranno
    // ancora di altNamesLower e verranno ripresi alla prossima esecuzione.
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
      const target = extractTmdbTarget(t.id, t);
      if (!target?.tmdbId) {
        stats.skippedNoTmdbId += 1;
        continue;
      }

      const endpoint = target.mediaType === "tv"
        ? `/tv/${target.tmdbId}`
        : `/movie/${target.tmdbId}`;
      const details = await tmdbFetch(endpoint, {
        language: "it-IT",
        append_to_response: "alternative_titles",
      });

      const nameLower = String(t.nameLower || "").trim();
      const altNamesLower = extractAltNamesLower(details, { nameLower, mediaType: target.mediaType });

      if (!altNamesLower.length) {
        stats.skippedNoAltNames += 1;
        console.log(`  ${progress} -- ${t.name || t.id} (nessuna variante utile)`);
        continue;
      }

      batch.update(t.ref, {
        altNamesLower,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      batchOps += 1;
      stats.updated += 1;
      console.log(`  ${progress} OK ${t.name || t.id} -> [${altNamesLower.join(", ")}]`);

      if (batchOps >= MAX_BATCH_OPS) await flush();
    } catch (err) {
      stats.errors += 1;
      console.log(`  ${progress} ERR ${t.name || t.id} - ${err?.message || err}`);
    }
  }

  await flush();

  console.log("\n" + "=".repeat(56));
  console.log("RIEPILOGO");
  console.log("=".repeat(56));
  console.log(`Processati:                 ${stats.processed}`);
  console.log(`Aggiornati:                 ${stats.updated}`);
  console.log(`Senza tmdbId (saltati):     ${stats.skippedNoTmdbId}`);
  console.log(`Nessuna variante utile:     ${stats.skippedNoAltNames}`);
  console.log(`Errori:                     ${stats.errors}`);
  console.log(`\n${WRITE ? "Modifiche applicate." : "Dry-run: nessuna modifica salvata."}`);
  console.log("\n=== FINE ===");
}

main().catch((err) => {
  console.error("ERRORE FATALE:", err);
  process.exit(1);
});
