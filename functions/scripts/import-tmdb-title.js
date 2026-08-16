#!/usr/bin/env node
/**
 * import-tmdb-title.js — importa nel catalogo UN singolo titolo TMDB.
 *
 * Colma il buco noto in CLAUDE.md: l'import puntuale di un titolo esisteva
 * solo lato iOS (`importTMDBTitle`, admin-only, client-side). Qui si usa lo
 * stesso percorso server del cron `importRecentTmdbTitles`:
 * `upsertTmdbTitle` (modules/tmdb.js) → dedup logico, poster su Storage,
 * doc `titles/{tmdb_<type>_<id>}`, slug assegnato dal trigger onTitleCreatedSlug.
 *
 * Cast/trailer NON vengono scaricati qui: ci pensa il callable esistente
 * `enrichTitleAssets` alla prima apertura della scheda.
 *
 * Uso (dry-run di default):
 *   cd functions
 *   node --env-file=.env scripts/import-tmdb-title.js --tmdbId 3293 --type movie
 *   node --env-file=.env scripts/import-tmdb-title.js --tmdbId 3293 --type movie --write
 */

const admin = require("firebase-admin");

const PROJECT_ID = "gia-visto";
const STORAGE_BUCKET = "gia-visto.firebasestorage.app";
const TMDB_BASE = "https://api.themoviedb.org/3";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i++;
  }
  return out;
}

async function tmdbGet(path, params) {
  const key = String(process.env.TMDB_KEY || process.env.TMDB_API_KEY || "").trim();
  if (!key) throw new Error("TMDB_KEY mancante (usa --env-file=.env)");
  const url = new URL(`${TMDB_BASE}${path}`);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, String(v));
  url.searchParams.set("api_key", key);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB ${path} → HTTP ${res.status}`);
  return res.json();
}

// I dettagli /movie|/tv espongono `genres:[{id,name}]`, mentre buildTmdbTitleDoc
// si aspetta la forma `genre_ids:[number]` dei risultati /search (altrimenti
// String({id,name}) finirebbe come "[object Object]" nel doc).
function detailsToSearchRow(details, type) {
  return {
    type,
    tmdbId: Number(details.id),
    id: Number(details.id),
    title: details.title || "",
    name: details.name || "",
    original_title: details.original_title || "",
    original_name: details.original_name || "",
    overview: details.overview || "",
    poster_path: details.poster_path || "",
    release_date: details.release_date || "",
    first_air_date: details.first_air_date || "",
    genre_ids: (details.genres || []).map((g) => Number(g.id)).filter(Boolean),
    vote_average: Number(details.vote_average || 0),
    original_language: details.original_language || "",
    origin_country: details.origin_country || [],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tmdbId = Number(args.tmdbId || args.id);
  const type = String(args.type || "movie") === "tv" ? "tv" : "movie";
  const write = args.write === true;
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) throw new Error("--tmdbId obbligatorio");

  admin.initializeApp({ projectId: PROJECT_ID, storageBucket: STORAGE_BUCKET });
  const db = admin.firestore();
  const bucket = admin.storage().bucket();
  const { upsertTmdbTitle, tmdbTitleDocId } = require("../modules/tmdb");

  const details = await tmdbGet(`/${type}/${tmdbId}`, { language: "it-IT" });
  if (!details?.id) throw new Error("titolo TMDB non trovato");
  if (!String(details.overview || "").trim()) {
    const en = await tmdbGet(`/${type}/${tmdbId}`, { language: "en-US" });
    details.overview = en?.overview || "";
  }

  const row = detailsToSearchRow(details, type);
  const expectedDocId = tmdbTitleDocId(type, tmdbId);
  const existing = await db.collection("titles").where("tmdbId", "==", tmdbId).get();

  console.log(JSON.stringify({
    tmdbId,
    type,
    name: row.title || row.name,
    originalName: row.original_title || row.original_name,
    year: (row.release_date || row.first_air_date || "").slice(0, 4),
    genres: row.genre_ids,
    runtime: details.runtime || null,
    expectedDocId,
    alreadyInCatalog: existing.docs.map((d) => d.id),
  }, null, 2));

  if (existing.size) {
    console.log("Titolo gia' presente: nessuna scrittura.");
    return;
  }
  if (!write) {
    console.log("DRY RUN — rilancia con --write per importare.");
    return;
  }

  const result = await upsertTmdbTitle(db, bucket, row, new Map());
  if (!result.imported) throw new Error(`upsert fallito: ${result.error}`);

  // Runtime: non e' nel payload /search da cui buildTmdbTitleDoc parte, ma
  // serve al conteggio ore viste (stats.totalWatchMinutes).
  const runtime = Number(details.runtime || 0);
  if (type === "movie" && runtime > 0) {
    await db.collection("titles").doc(expectedDocId).set(
      { meta: { durationMovie: runtime } },
      { merge: true }
    );
  }

  const saved = await db.collection("titles").doc(expectedDocId).get();
  console.log("Importato:", JSON.stringify({
    docId: saved.id,
    name: saved.data()?.name,
    slug: saved.data()?.slug || "(assegnato dal trigger onTitleCreatedSlug)",
    duplicate: result.duplicate,
  }, null, 2));
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("ERRORE:", err?.message || err);
  process.exit(1);
});
