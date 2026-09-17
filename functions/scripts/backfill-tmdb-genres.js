#!/usr/bin/env node
/**
 * backfill-tmdb-genres.js
 *
 * Obiettivo: uniformare i generi dei titoli usando il catalogo TMDB
 * e ridurre i duplicati/alias (es. "Comedy" vs "Commedia").
 *
 * Cosa fa:
 * 1) Upserta tutti i generi TMDB nella collection /genres con name, nameLower.
 * 2) Scansiona /titles in batch, rimappa l'array genres:
 *    - mantiene i tmdb_* validi
 *    - converte alias (en/it/syn) in tmdb_*
 *    - deduplica preservando ordine
 *    - lascia intatti gli elementi non mappati (reportati a fine run)
 *
 * Uso:
 *   cd functions
 *   node scripts/backfill-tmdb-genres.js
 *
 * Note:
 * - Usa le credenziali default di firebase-admin (GOOGLE_APPLICATION_CREDENTIALS o emulatore).
 * - Scrive a Firestore titolo per titolo (no batch) per evitare limiti batch/ram.
 */

const admin = require("firebase-admin");

// Init Admin SDK (usa env o fallback progetto)
const projectId =
  process.env.GCLOUD_PROJECT ||
  process.env.GCP_PROJECT ||
  process.env.FIREBASE_CONFIG && (() => {
    try { return JSON.parse(process.env.FIREBASE_CONFIG).projectId; } catch (_) { return null; }
  })() ||
  "gia-visto";

admin.initializeApp({ projectId });
const db = admin.firestore();

// ---------- Cataloghi ----------
const TMDB_GENRES = [
  { id: "tmdb_28", name: "Azione", aliases: ["action", "azione"] },
  { id: "tmdb_12", name: "Avventura", aliases: ["adventure", "avventura"] },
  { id: "tmdb_16", name: "Animazione", aliases: ["animation", "animazione", "cartoon", "cartoons", "cartoni", "cartoni animati", "cartone animato", "animated"] },
  { id: "tmdb_35", name: "Commedia", aliases: ["comedy", "commedia", "humor"] },
  { id: "tmdb_80", name: "Crime", aliases: ["crime", "poliziesco", "police"] },
  { id: "tmdb_99", name: "Documentario", aliases: ["documentary", "documentario", "doc"] },
  { id: "tmdb_18", name: "Dramma", aliases: ["drama", "drammatico", "drama"] },
  { id: "tmdb_10751", name: "Famiglia", aliases: ["family", "famiglia", "kids"] },
  { id: "tmdb_10759", name: "Azione & Avventura (TV)", aliases: ["action & adventure", "azione e avventura", "azione avventura", "serie azione", "serie avventura"] },
  { id: "tmdb_14", name: "Fantasy", aliases: ["fantasy", "fantasia"] },
  { id: "tmdb_10765", name: "Fantascienza & Fantasy (TV)", aliases: ["sci fi & fantasy", "fantascienza e fantasy", "fantascienza & fantasy", "sci-fi fantasy", "scifi fantasy"] },
  { id: "tmdb_36", name: "Storia", aliases: ["history", "storico", "storia"] },
  { id: "tmdb_27", name: "Horror", aliases: ["horror", "paura", "spavento"] },
  { id: "tmdb_10402", name: "Musica", aliases: ["music", "musical", "musica"] },
  { id: "tmdb_9648", name: "Mistero", aliases: ["mystery", "mistero", "giallo"] },
  { id: "tmdb_10749", name: "Romantico", aliases: ["romance", "romantico", "love"] },
  { id: "tmdb_878", name: "Fantascienza", aliases: ["science fiction", "sci-fi", "scifi", "fantascienza"] },
  { id: "tmdb_10770", name: "Film TV", aliases: ["tv movie", "film tv"] },
  { id: "tmdb_53", name: "Thriller", aliases: ["thriller", "suspense"] },
  { id: "tmdb_10752", name: "Guerra", aliases: ["war", "guerra", "military"] },
  { id: "tmdb_37", name: "Western", aliases: ["western"] },
  { id: "tmdb_10768", name: "Guerra & Politica (TV)", aliases: ["war & politics", "guerra e politica"] },
  { id: "tmdb_10766", name: "Soap", aliases: ["soap", "telenovela", "soap opera"] },
];

// Normalizza testo per matching
function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\\s]/g, " ")
    .replace(/\\s+/g, " ")
    .trim();
}

// Costruisce la mappa alias -> tmdbId
function buildAliasMap() {
  const map = new Map();
  for (const g of TMDB_GENRES) {
    const base = normalizeText(g.name);
    if (base) map.set(base, g.id);
    for (const a of g.aliases || []) {
      const n = normalizeText(a);
      if (n) map.set(n, g.id);
    }
  }
  return map;
}

const aliasMap = buildAliasMap();
const tmdbIdSet = new Set(TMDB_GENRES.map(g => g.id));

async function upsertGenresCollection() {
  console.log("Aggiorno collection /genres con catalogo TMDB...");
  for (const g of TMDB_GENRES) {
    const ref = db.collection("genres").doc(g.id);
    await ref.set({
      name: g.name,
      nameLower: normalizeText(g.name),
      source: "tmdb",
      tmdbGenreId: Number(g.id.replace("tmdb_", "")) || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  console.log("✅ Generi TMDB upserted.\n");
}

function mapGenreId(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (tmdbIdSet.has(s)) return s;
  const norm = normalizeText(s);
  // handle variants like "tmdb 10765"
  const tmdbMatch = norm.match(/^tmdb\\s*(\\d{2,})$/);
  if (tmdbMatch) {
    const id = `tmdb_${tmdbMatch[1]}`;
    if (tmdbIdSet.has(id)) return id;
  }
  if (aliasMap.has(norm)) return aliasMap.get(norm);
  // try stripping tmdb_ if uppercase variants
  if (norm.startsWith("tmdb ")) {
    const id = `tmdb_${norm.split(" ")[1]}`;
    if (tmdbIdSet.has(id)) return id;
  }

  // custom extra heuristic mappings
  if (["supereroi", "supereroe", "superhero", "superheroes"].includes(norm)) return "tmdb_28";
  if (["sentimentale", "commedia romantica", "romcom", "rom com"].includes(norm)) return "tmdb_10749";
  if (["comico"].includes(norm)) return "tmdb_35";
  if (["suspence", "suspenso"].includes(norm)) return "tmdb_53";
  if (["basato su storia vera", "storia vera", "true story"].includes(norm)) return "tmdb_36";
  if (["adolescenziale", "teen"].includes(norm)) return "tmdb_18";
  if (["trip mentale", "mindfuck", "mind fuck"].includes(norm)) return "tmdb_9648";
  if (["amicizia", "friendship"].includes(norm)) return "tmdb_10751"; // meglio famiglia / feel-good

  return null; // unmapped
}

function arrayEquals(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function processTitles() {
  console.log("Scansione titoli...");
  let processed = 0;
  let updated = 0;
  const unresolved = new Map(); // normalized term -> count

  const snap = await db.collection("titles").get();
  console.log(`Totale titoli: ${snap.size}`);

  for (const doc of snap.docs) {
    processed++;
    const data = doc.data() || {};
    const genres = Array.isArray(data.genres) ? data.genres : [];
    if (!genres.length) continue;

    const mapped = [];
    const seen = new Set();
    const leftovers = [];

    for (const g of genres) {
      const mappedId = mapGenreId(g);
      if (mappedId) {
        if (!seen.has(mappedId)) {
          mapped.push(mappedId);
          seen.add(mappedId);
        }
      } else {
        const norm = normalizeText(g);
        leftovers.push(norm || g);
        const key = norm || g || "(vuoto)";
        unresolved.set(key, (unresolved.get(key) || 0) + 1);
        if (!seen.has(g)) {
          mapped.push(g);
          seen.add(g);
        }
      }
    }

    if (!arrayEquals(genres, mapped)) {
      await doc.ref.update({
        genres: mapped,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      updated++;
    }

    if (processed % 200 === 0) {
      console.log(`...${processed}/${snap.size} titoli elaborati (aggiornati: ${updated})`);
    }
  }

  console.log(`\nCompletato. Titoli elaborati: ${processed}, aggiornati: ${updated}`);
  if (unresolved.size) {
    console.log("\nGeneri non mappati (top 20):");
    const top = [...unresolved.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    for (const [term, count] of top) {
      console.log(`- ${term}: ${count}`);
    }
  } else {
    console.log("\nTutti i generi sono stati mappati.");
  }
}

async function main() {
  await upsertGenresCollection();
  await processTitles();
  console.log("\nDone.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Errore:", err);
  process.exit(1);
});
