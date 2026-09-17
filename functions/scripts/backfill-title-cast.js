#!/usr/bin/env node
/**
 * backfill-title-cast.js
 *
 * Riempie `castIds` e `directorIds` sui titoli che qualcuno ha in libreria.
 *
 * PERCHE' — questi due campi li scrive `enrichTitleAssets`, che gira solo alla
 * PRIMA APERTURA di una scheda: la copertura segue le visite, non il catalogo.
 * Misurato il 2026-08-26 su 21.134 titoli: `castIds` sul 16%, `directorIds` sul
 * 7,2%. Sono i due segnali personali del profilo gusti (bucket `people` e
 * `directors`), quindi il pubblico per affinita' resta di fatto guidato dal solo
 * genere — che discrimina poco. Caso reale: chi aveva visto
 * "La casa di carta: Corea" non e' stato raggiunto dall'annuncio di "Mousetrap",
 * stesso regista, perche' quel titolo non aveva `directorIds`.
 *
 * SOLO GLI ID, NON `castWithCharacters` — la lista con personaggi e foto pesa
 * ~2,2 KB a titolo: su 14k titoli sarebbero +31 MB su `titles`, che e' una
 * collection letta a tappeto (pool candidati, ricerca, feed). Gli id pesano
 * ~250 byte e portano il 100% del beneficio per i gusti. La lista completa resta
 * pigra: `enrichTitleAssets` la riempie alla prima apertura come sempre, perche'
 * il suo gate `castWithCharsMissing` resta vero.
 *
 * PERIMETRO (`--scope`) — `library` (default) sono i titoli che qualcuno ha in
 * libreria: gli unici che possono comparire in un profilo gusti. `rest` sono gli
 * altri: non entrano in nessun profilo, ma stanno nel pool dei CANDIDATI di
 * Match e consigli, dove un titolo senza cast ne' regista non puo' somigliare a
 * niente — e i candidati sono per definizione roba che l'utente non ha visto.
 * `all` fa entrambi.
 *
 * IDEMPOTENTE — rilanciarlo salta i titoli gia' completi, quindi riprende da
 * dove si era fermato senza tenere uno stato. Non sovrascrive mai un campo
 * gia' popolato.
 *
 * Usage:
 *   cd functions
 *   node --env-file=.env scripts/backfill-title-cast.js                 # dry-run
 *   node --env-file=.env scripts/backfill-title-cast.js --write
 *   node --env-file=.env scripts/backfill-title-cast.js --write --limit 200
 *   node --env-file=.env scripts/backfill-title-cast.js --write --scope rest
 *   node --env-file=.env scripts/backfill-title-cast.js --write --concurrency 4
 */

const admin = require("firebase-admin");
const { buildCastAssets } = require("../lib/titleCastAssets");

const WRITE = process.argv.includes("--write");
const LIMIT = intArg("--limit", 0);
// library (default) = solo i titoli che qualcuno ha in libreria; rest = solo gli
// altri; all = tutto il catalogo.
const SCOPE = ["library", "rest", "all"].includes(String(strArg("--scope") || "").toLowerCase())
  ? String(strArg("--scope")).toLowerCase()
  : "library";
const CONCURRENCY = Math.max(1, Math.min(12, intArg("--concurrency", 6)));
const PROJECT_ID = "gia-visto";
const TMDB_BASE = "https://api.themoviedb.org/3";
const MAX_BATCH_OPS = 400;

function strArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0 || idx === process.argv.length - 1) return null;
  const value = String(process.argv[idx + 1] || "").trim();
  return value.startsWith("--") ? null : value || null;
}

function intArg(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0 || idx === process.argv.length - 1) return fallback;
  const n = Number.parseInt(process.argv[idx + 1], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const TMDB_KEY = String(process.env.TMDB_KEY || process.env.TMDB_API_KEY || "").trim();
if (!TMDB_KEY) {
  console.error("ERRORE: TMDB_KEY mancante (usa --env-file=.env)");
  process.exit(1);
}

admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `null` quando TMDB dice che il titolo non c'e' piu' (404): non e' un errore. */
async function tmdbGet(path, attempt = 0) {
  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set("api_key", TMDB_KEY);
  url.searchParams.set("language", "it-IT");
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 3) throw new Error(`TMDB HTTP ${res.status}`);
    await sleep(1000 * (attempt + 1));
    return tmdbGet(path, attempt + 1);
  }
  if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);
  return res.json();
}

/**
 * Su una serie i credits "principali" sono spesso quasi vuoti: TMDB tiene il
 * cast vero in `aggregate_credits`, aggregato per episodio. Campionate 20 serie
 * il 2026-08-26: 6 avevano meno di 5 nomi nei credits normali e migliaia in
 * quelli aggregati (NCIS: 0 contro 3.846).
 *
 * Li' pero' `order` non e' affidabile — su Supernatural mette al primo posto
 * un'attrice da 5 episodi e il protagonista da 327 al secondo. Il segnale
 * onesto su una serie e' in quanti episodi uno c'e' davvero: si riordina per
 * `total_episode_count` e si riscrive `order`, cosi' `buildCastAssets` (che
 * ordina per `order`) prende i protagonisti veri.
 */
function rankAggregateCast(aggregate) {
  return (Array.isArray(aggregate?.cast) ? aggregate.cast : [])
    .slice()
    .sort((a, b) =>
      (Number(b?.total_episode_count) || 0) - (Number(a?.total_episode_count) || 0) ||
      (Number(a?.order ?? 999)) - (Number(b?.order ?? 999)))
    .map((row, index) => ({ ...row, order: index }));
}

async function fetchCredits(type, tmdbId) {
  const details = await tmdbGet(`/${type}/${tmdbId}?append_to_response=credits`);
  if (details === null) return null;
  const credits = details?.credits || {};

  if (type !== "tv" || (Array.isArray(credits.cast) ? credits.cast.length : 0) >= 5) return credits;

  const aggregate = await tmdbGet(`/tv/${tmdbId}/aggregate_credits`);
  const ranked = rankAggregateCast(aggregate);
  if (!ranked.length) return credits;
  // Il crew resta quello dei credits normali: in `aggregate_credits` il ruolo
  // sta in `jobs[]` e non in `job`, quindi l'estrazione dei registi non
  // funzionerebbe comunque.
  return { cast: ranked, crew: credits.crew || [] };
}

/** tmdbId dal campo, oppure dal docId `tmdb_<type>_<id>`. */
function resolveTmdb(docId, data) {
  const fromField = Number(data.tmdbId) || Number(data.meta?.tmdbId) || 0;
  const match = /^tmdb_(movie|tv)_(\d+)$/.exec(docId);
  const tmdbId = fromField || (match ? Number(match[2]) : 0);
  const type = String(data.type || data.meta?.mediaType || (match ? match[1] : "")).toLowerCase() === "tv"
    ? "tv"
    : "movie";
  return tmdbId > 0 ? { tmdbId, type } : null;
}

async function main() {
  console.log(`progetto ${PROJECT_ID} — ${WRITE ? "SCRITTURA" : "dry-run"} — ${CONCURRENCY} richieste in parallelo`);

  const inLibrary = new Set();
  if (SCOPE !== "all") {
    (await db.collectionGroup("titleStates").select("titleId").get())
      .forEach((doc) => inLibrary.add(String(doc.data()?.titleId || doc.id)));
    console.log(`titoli con almeno un titleState: ${inLibrary.size}`);
  }
  console.log(`perimetro: ${SCOPE}`);

  const snap = await db.collection("titles").select("castIds", "directorIds", "tmdbId", "type", "meta", "name").get();
  const queue = [];
  let skippedComplete = 0;
  let skippedNoTmdb = 0;
  snap.forEach((doc) => {
    if (SCOPE === "library" && !inLibrary.has(doc.id)) return;
    if (SCOPE === "rest" && inLibrary.has(doc.id)) return;
    const data = doc.data() || {};
    const needCast = (data.castIds || []).length < 5;
    const needDirectors = (data.directorIds || []).length === 0;
    if (!needCast && !needDirectors) { skippedComplete += 1; return; }
    const tmdb = resolveTmdb(doc.id, data);
    if (!tmdb) { skippedNoTmdb += 1; return; }
    queue.push({ id: doc.id, name: data.name || doc.id, needCast, needDirectors, ...tmdb });
  });

  // Una serie a cui manca SOLO il regista quasi sempre non ce l'ha proprio: TMDB
  // accredita i registi per episodio, non a livello di serie (misurato: 23,3% di
  // copertura sulle serie contro il 99,2% sui film). Senza dirlo, ogni run
  // successivo sembra avere migliaia di titoli "da fare" che non lo sono.
  const seriesWithoutDirector = queue.filter((row) => row.type === "tv" && !row.needCast && row.needDirectors).length;

  const work = LIMIT > 0 ? queue.slice(0, LIMIT) : queue;
  console.log(`da elaborare: ${work.length}${LIMIT ? ` (limite ${LIMIT} su ${queue.length})` : ""}`);
  console.log(`gia' completi: ${skippedComplete} | senza tmdbId: ${skippedNoTmdb}`);
  if (seriesWithoutDirector) {
    console.log(`  di cui ${seriesWithoutDirector} serie a cui manca solo il regista: su TMDB quasi nessuna ce l'ha a livello di serie, quindi resteranno cosi'.`);
  }
  if (!WRITE) {
    console.log("\nDRY RUN — rilancia con --write per applicare.");
    console.log("Esempi:");
    work.slice(0, 5).forEach((row) => console.log(`  ${row.type}/${row.tmdbId} ${row.name}`));
    return;
  }

  const stats = { done: 0, written: 0, noCredits: 0, gone: 0, errors: 0, castIds: 0, directorIds: 0 };
  const startedAt = Date.now();

  let cursor = 0;
  // Ogni worker ha il SUO batch: con un batch condiviso, mentre un worker fa
  // commit() gli altri continuano ad aggiungerci scritture e Firestore risponde
  // "Cannot modify a WriteBatch that has been committed". E' successo davvero al
  // primo giro: 1.402 titoli su 13.758 persi cosi'.
  const worker = async () => {
    let batch = db.batch();
    let ops = 0;
    const flush = async () => {
      if (!ops) return;
      const pending = batch;
      batch = db.batch();
      ops = 0;
      await pending.commit();
    };

    while (cursor < work.length) {
      const row = work[cursor++];
      try {
        const credits = await fetchCredits(row.type, row.tmdbId);
        if (credits === null) { stats.gone += 1; continue; }
        const { castIds, directorIds } = buildCastAssets(credits);

        const patch = {};
        if (row.needCast && castIds.length) { patch.castIds = castIds; stats.castIds += 1; }
        if (row.needDirectors && directorIds.length) { patch.directorIds = directorIds; stats.directorIds += 1; }
        if (!Object.keys(patch).length) { stats.noCredits += 1; continue; }

        batch.set(db.collection("titles").doc(row.id), patch, { merge: true });
        ops += 1;
        stats.written += 1;
        if (ops >= MAX_BATCH_OPS) await flush();
      } catch (err) {
        stats.errors += 1;
        if (stats.errors <= 10) console.error(`  errore ${row.type}/${row.tmdbId} ${row.name}: ${err.message}`);
      } finally {
        stats.done += 1;
        if (stats.done % 500 === 0) {
          const rate = stats.done / ((Date.now() - startedAt) / 1000);
          const left = Math.round((work.length - stats.done) / Math.max(rate, 0.1));
          console.log(`  ${stats.done}/${work.length} — ${rate.toFixed(1)}/s — ~${Math.ceil(left / 60)} min rimasti — scritti ${stats.written}`);
        }
      }
    }
    await flush();
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  console.log("\n", JSON.stringify(stats));
  console.log(`durata: ${Math.round((Date.now() - startedAt) / 1000)}s`);
  if (stats.gone) console.log(`${stats.gone} titoli non esistono piu' su TMDB (404): lasciati come sono.`);
  if (stats.noCredits) console.log(`${stats.noCredits} titoli senza credits utili su TMDB.`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
