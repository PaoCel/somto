#!/usr/bin/env node
/**
 * fix-remaining.js — Manual fix for the 6 titles that couldn't be auto-matched.
 *
 * Uses exact TMDB IDs looked up manually.
 *
 * Usage:
 *   node scripts/fix-remaining.js              # dry-run
 *   node scripts/fix-remaining.js --write      # apply
 */

const admin = require("firebase-admin");

const WRITE = process.argv.includes("--write");
const TMDB_KEY = process.env.TMDB_KEY || process.env.TMDB_API_KEY;
const TMDB_BASE = "https://api.themoviedb.org/3";

if (!TMDB_KEY) {
  console.error("❌ TMDB_KEY mancante. Export TMDB_KEY=... prima di eseguire.");
  process.exit(1);
}

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

// Manual mapping: Firestore doc ID → { tmdbId, mediaType }
const MANUAL_FIXES = [
  {
    firestoreId: "K53xUv33xo2vlpaVyJTZ",
    name: "Ant Man and the Wasp Quantumania",
    tmdbId: 640146,
    mediaType: "movie",
  },
  {
    firestoreId: "UpVSI3B4o9cCZltZYLkr",
    name: "Ant Man and the Wasp",
    tmdbId: 363088,
    mediaType: "movie",
  },
  {
    firestoreId: "ZT88OGiYjMeE81jR0GhJ",
    name: "Dahmer mostro: la storia di jeffrey dhamer",
    tmdbId: 113988,
    mediaType: "tv",
  },
  {
    firestoreId: "aTWYgjcmN0nmRfRGvBpz",
    name: "Guardiani della Galassia vol.3",
    tmdbId: 447365,
    mediaType: "movie",
  },
  {
    firestoreId: "la-storia-di-lyle-ed-erik-menendez-2024",
    name: "la storia di Lyle ed Erik Menéndez",
    tmdbId: 225634,
    mediaType: "tv",
  },
  {
    firestoreId: "sicilia-express",
    name: "Sicilia Express",
    // This may not exist on TMDB — we'll try, or skip
    tmdbId: null,
    mediaType: "tv",
  },
];

async function tmdbFetch(path, params = {}) {
  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set("api_key", TMDB_KEY);
  url.searchParams.set("language", "it-IT");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  return res.json();
}

async function main() {
  console.log(`=== FIX REMAINING ===${WRITE ? " [WRITE]" : " [DRY-RUN]"}\n`);

  for (const fix of MANUAL_FIXES) {
    console.log(`\n--- ${fix.name} ---`);

    if (!fix.tmdbId) {
      console.log("  ⏭️  Nessun TMDB ID, skip");
      continue;
    }

    try {
      const endpoint = fix.mediaType === "tv" ? `/tv/${fix.tmdbId}` : `/movie/${fix.tmdbId}`;
      const d = await tmdbFetch(endpoint);

      const isTV = fix.mediaType === "tv";
      const overview = d.overview || "";
      const dateStr = isTV ? d.first_air_date : d.release_date;
      const year = dateStr ? parseInt(dateStr.substring(0, 4), 10) : null;

      console.log(`  TMDB title: ${isTV ? d.name : d.title}`);
      console.log(`  Overview: ${overview ? overview.substring(0, 80) + "..." : "(vuota)"}`);
      console.log(`  Year: ${year}`);

      const ref = db.collection("titles").doc(fix.firestoreId);
      const doc = await ref.get();

      if (!doc.exists) {
        console.log(`  ❌ Documento ${fix.firestoreId} non trovato!`);
        continue;
      }

      const data = doc.data();
      const update = {};

      if (!data.description && overview) {
        update.description = overview;
        console.log("  ✅ Aggiungo description");
      }
      if (!data.year && year) {
        update.year = year;
        console.log(`  ✅ Aggiungo anno: ${year}`);
      }

      if (Object.keys(update).length > 0) {
        if (WRITE) {
          await ref.update(update);
          console.log("  💾 Scritto!");
        } else {
          console.log("  ⚡ (dry-run)");
        }
      } else {
        console.log("  ⚪ Niente da aggiornare");
      }
    } catch (err) {
      console.log(`  💥 Errore: ${err.message}`);
    }
  }

  console.log("\n=== FINE ===");
}

main().catch(err => {
  console.error("ERRORE:", err);
  process.exit(1);
});
