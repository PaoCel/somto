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
 * Cast e registi vengono scritti QUI (dal 2026-08-26), non aspettando la prima
 * apertura della scheda: un titolo importato a mano serve quasi sempre a
 * promuovere un'uscita imminente, e senza `directorIds` il pubblico per
 * affinita' non riconosce "stesso regista di una cosa che hai visto". Il
 * trailer resta a `enrichTitleAssets`.
 *
 * Su un titolo GIA' a catalogo lo script non reimporta, ma completa i campi
 * mancanti: e' il modo per recuperare uno stub vecchio senza cast.
 *
 * Uso (dry-run di default):
 *   cd functions
 *   node --env-file=.env scripts/import-tmdb-title.js --tmdbId 3293 --type movie
 *   node --env-file=.env scripts/import-tmdb-title.js --tmdbId 3293 --type movie --write
 */

const admin = require("firebase-admin");
const { buildCastAssets } = require("../lib/titleCastAssets");

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

// Cast e registi subito, non alla prima apertura della scheda.
//
// PERCHE' — `enrichTitleAssets` e' il proprietario di questi campi ma gira solo
// quando qualcuno apre la scheda. Un titolo importato a mano serve quasi sempre
// a promuovere un'uscita imminente, e finche' `directorIds` e' vuoto il pubblico
// per affinita' non puo' riconoscere "stesso regista di una cosa che hai gia'
// visto" — sull'uscita nuova e' il segnale piu' forte che abbiamo. Stessa forma
// dei campi (lib/titleCastAssets.js), quindi la callable poi non riscrive nulla.
//
// Non sovrascrive quello che c'e' gia': completa e basta.
async function writeCastAssets(db, docId, details, { existing = null } = {}) {
  const { cast, castIds, directorIds } = buildCastAssets(details.credits);
  const current = existing || (await db.collection("titles").doc(docId).get()).data() || {};
  const assets = {};

  if (cast.length && !(current.castWithCharacters || []).length) {
    assets.castWithCharacters = cast;
    assets.castWithCharactersCachedAt = admin.firestore.FieldValue.serverTimestamp();
    if (!(current.cast || []).length) assets.cast = cast.slice(0, 8).map((row) => row.name);
  }
  if (castIds.length && (current.castIds || []).length < 5) assets.castIds = castIds;
  if (directorIds.length && !(current.directorIds || []).length) assets.directorIds = directorIds;

  if (!Object.keys(assets).length) return { written: false, castIds: 0, directorIds: 0 };
  await db.collection("titles").doc(docId).set(assets, { merge: true });
  return { written: true, castIds: castIds.length, directorIds: directorIds.length };
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

  const details = await tmdbGet(`/${type}/${tmdbId}`, {
    language: "it-IT",
    append_to_response: "credits",
  });
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
    const doc = existing.docs[0];
    const missing = !(doc.data()?.directorIds || []).length || (doc.data()?.castIds || []).length < 5;
    if (!missing) {
      console.log("Titolo gia' presente e completo: nessuna scrittura.");
      return;
    }
    if (!write) {
      console.log("Titolo gia' presente ma senza cast/registi — rilancia con --write per completarlo.");
      return;
    }
    const filled = await writeCastAssets(db, doc.id, details, { existing: doc.data() });
    console.log("Completato:", JSON.stringify({ docId: doc.id, ...filled }, null, 2));
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

  await writeCastAssets(db, expectedDocId, details);

  const saved = await db.collection("titles").doc(expectedDocId).get();
  console.log("Importato:", JSON.stringify({
    docId: saved.id,
    name: saved.data()?.name,
    slug: saved.data()?.slug || "(assegnato dal trigger onTitleCreatedSlug)",
    duplicate: result.duplicate,
    castIds: (saved.data()?.castIds || []).length,
    directorIds: (saved.data()?.directorIds || []).length,
  }, null, 2));
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("ERRORE:", err?.message || err);
  process.exit(1);
});
