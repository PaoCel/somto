#!/usr/bin/env node
/**
 * repair-corrupted-genres.js
 *
 * Ripara i titoli con generi scritti come `[object Object]`.
 *
 * Causa: `buildTmdbTitleDoc` mappava `row.genres` con `String(g)`, ma dai
 * dettagli TMDB (`/movie|tv/{id}`) i generi arrivano come oggetti `{id, name}`
 * — non come numeri, che e' la forma delle ricerche. Il ramo mancante e' stato
 * chiuso in `modules/tmdb.js`; questo script sistema il pregresso.
 *
 * Effetto del difetto: quei titoli sono invisibili ai filtri per genere e non
 * dicono niente al profilo gusti, che sui generi si costruisce.
 *
 * I generi veri si rileggono da TMDB per `tmdbId`. Chi non ha un tmdbId (o non
 * risponde) resta com'e' e viene contato a parte: meglio saperlo che scrivere
 * un array vuoto sopra un dato recuperabile.
 *
 * Uso:
 *   cd functions
 *   node scripts/repair-corrupted-genres.js              # dry-run
 *   node scripts/repair-corrupted-genres.js --write
 *   ... --limit=50    quanti titoli lavorare (default tutti)
 */

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const PROJECT_ID = "gia-visto";
const WRITE = process.argv.includes("--write");
const LIMIT = Number((process.argv.find((a) => a.startsWith("--limit=")) || "").split("=")[1]) || Infinity;
// TMDB tollera bene questo ritmo ed e' lo stesso gap dell'import automatico.
const REQUEST_GAP_MS = 130;

function readTmdbKey() {
  const candidates = [".env.gia-visto", ".env"];
  for (const name of candidates) {
    const file = path.join(__dirname, "..", name);
    if (!fs.existsSync(file)) continue;
    const match = fs.readFileSync(file, "utf8").match(/^TMDB_(?:API_)?KEY\s*=\s*(.+)$/m);
    if (match) return match[1].trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("chiave TMDB non trovata in functions/.env*");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isCorrupted(genres) {
  return Array.isArray(genres) && genres.some((value) => String(value).includes("[object"));
}

async function fetchGenres(key, mediaType, tmdbId) {
  const url = new URL(`https://api.themoviedb.org/3/${mediaType}/${tmdbId}`);
  url.searchParams.set("api_key", key);
  url.searchParams.set("language", "it-IT");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  const json = await res.json();
  return (json.genres || [])
    .map((genre) => Math.floor(Number(genre?.id)))
    .filter((id) => Number.isFinite(id) && id > 0)
    .map((id) => `tmdb_${id}`);
}

async function main() {
  const key = readTmdbKey();
  admin.initializeApp({ projectId: PROJECT_ID });
  const db = admin.firestore();

  const snap = await db.collection("titles").select("genres", "name", "tmdbId", "type", "meta").get();
  const targets = [];
  snap.forEach((docSnap) => {
    const data = docSnap.data() || {};
    if (!isCorrupted(data.genres)) return;
    targets.push({
      id: docSnap.id,
      name: data.name || docSnap.id,
      genres: data.genres || [],
      tmdbId: Number(data.tmdbId || data.meta?.tmdbId) || null,
      mediaType: data.type === "tv" ? "tv" : "movie",
    });
  });

  console.log(`titoli in catalogo: ${snap.size} | con generi corrotti: ${targets.length}`);
  const work = targets.slice(0, LIMIT === Infinity ? targets.length : LIMIT);

  let fixed = 0;
  let cleanedOnly = 0;
  let skipped = 0;
  const failures = [];

  for (const row of work) {
    // Senza tmdbId non si puo' rileggere: si toglie solo la voce illeggibile,
    // conservando gli eventuali generi buoni gia' presenti.
    const survivors = row.genres.filter((value) => !String(value).includes("[object"));

    if (!row.tmdbId) {
      skipped += 1;
      if (WRITE && survivors.length !== row.genres.length) {
        await db.collection("titles").doc(row.id).set({ genres: survivors }, { merge: true });
        cleanedOnly += 1;
      }
      continue;
    }

    try {
      const genres = await fetchGenres(key, row.mediaType, row.tmdbId);
      await sleep(REQUEST_GAP_MS);
      const next = genres.length ? genres : survivors;
      if (!next.length) {
        skipped += 1;
        continue;
      }
      if (WRITE) {
        await db.collection("titles").doc(row.id).set({ genres: next }, { merge: true });
      }
      fixed += 1;
      if (fixed <= 5 || fixed % 100 === 0) {
        console.log(`  ${WRITE ? "" : "[dry-run] "}${row.name} → ${next.join(", ")}`);
      }
    } catch (err) {
      failures.push({ id: row.id, error: String(err?.message || err).slice(0, 120) });
    }
  }

  console.log(`\nriletti da TMDB: ${fixed} | solo ripuliti: ${cleanedOnly} | saltati: ${skipped} | errori: ${failures.length}`);
  failures.slice(0, 5).forEach((row) => console.log(`  errore ${row.id}: ${row.error}`));
  if (!WRITE) console.log("nessuna scrittura: rilancia con --write");
  process.exit(0);
}

main().catch((err) => {
  console.error("errore:", err?.message || err);
  process.exit(1);
});
