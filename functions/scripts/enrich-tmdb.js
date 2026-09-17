#!/usr/bin/env node
/**
 * enrich-tmdb.js — Batch enrichment of titles via TMDB API.
 *
 * For each title missing description and/or year:
 *  1. Search TMDB by name + type (movie/tv)
 *  2. Pick the best match (exact name or closest year)
 *  3. Fetch full details (overview, release_date, poster_path)
 *  4. Update Firestore with: description, year (if missing)
 *
 * Also fills missing poster for the 7 titles without one.
 *
 * Usage:
 *   cd functions
 *   node scripts/enrich-tmdb.js              # dry-run
 *   node scripts/enrich-tmdb.js --write      # apply changes
 *   node scripts/enrich-tmdb.js --write --poster  # also download posters
 *
 * Rate limit: TMDB allows ~40 req/s. We throttle to ~4 req/s to be safe.
 */

const admin = require("firebase-admin");

const WRITE = process.argv.includes("--write");
const DO_POSTER = process.argv.includes("--poster");

const TMDB_KEY = process.env.TMDB_KEY || process.env.TMDB_API_KEY;
const TMDB_BASE = "https://api.themoviedb.org/3";

if (!TMDB_KEY) {
  console.error("❌ TMDB_KEY mancante. Export TMDB_KEY=... prima di eseguire.");
  process.exit(1);
}

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

// ---- TMDB helpers ----

async function tmdbFetch(path, params = {}) {
  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set("api_key", TMDB_KEY);
  url.searchParams.set("language", "it-IT");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const res = await fetch(url.toString());
  if (res.status === 429) {
    // Rate limited — wait and retry
    console.log("   ⏳ Rate limited, attendo 2s...");
    await sleep(2000);
    return tmdbFetch(path, params);
  }
  if (!res.ok) throw new Error(`TMDB ${res.status} for ${path}`);
  return res.json();
}

async function searchTmdb(query, mediaType) {
  const endpoint = mediaType === "tv" ? "/search/tv" : "/search/movie";
  const data = await tmdbFetch(endpoint, { query });
  return data.results || [];
}

async function getDetails(tmdbId, mediaType) {
  const endpoint = mediaType === "tv" ? `/tv/${tmdbId}` : `/movie/${tmdbId}`;
  return tmdbFetch(endpoint);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---- Matching logic ----

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[''`]/g, "'")
    .replace(/[""]/g, '"')
    .replace(/[^a-z0-9àáâãäåèéêëìíîïòóôõöùúûüñç\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function pickBestMatch(results, titleName, titleYear, mediaType) {
  if (!results || results.length === 0) return null;

  const normName = normalize(titleName);

  // Score each result
  const scored = results.map(r => {
    const isTV = mediaType === "tv";
    const rName = isTV ? (r.name || "") : (r.title || "");
    const rOrigName = isTV ? (r.original_name || "") : (r.original_title || "");
    const dateStr = isTV ? r.first_air_date : r.release_date;
    const rYear = dateStr ? parseInt(dateStr.substring(0, 4), 10) : null;

    let score = 0;

    // Exact name match (IT or original)
    if (normalize(rName) === normName) score += 100;
    else if (normalize(rOrigName) === normName) score += 90;
    // Partial match
    else if (normalize(rName).includes(normName) || normName.includes(normalize(rName))) score += 50;
    else if (normalize(rOrigName).includes(normName) || normName.includes(normalize(rOrigName))) score += 40;

    // Year match
    if (titleYear && rYear) {
      if (rYear === titleYear) score += 30;
      else if (Math.abs(rYear - titleYear) === 1) score += 15;
    }

    // Popularity boost (tiebreaker)
    score += Math.min((r.popularity || 0) / 100, 5);

    return { ...r, score, rName, rYear };
  });

  scored.sort((a, b) => b.score - a.score);

  // Only accept if score is reasonable
  const best = scored[0];
  if (best.score < 40) return null; // too weak a match

  return best;
}

// ---- Main ----

async function main() {
  console.log(`\n=== ENRICH TMDB ===${WRITE ? " [WRITE]" : " [DRY-RUN]"}${DO_POSTER ? " +POSTER" : ""}\n`);
  if (!WRITE) console.log("⚡ Usa --write per applicare le modifiche\n");

  // Load titles
  const titlesSnap = await db.collection("titles").get();
  const titles = [];
  titlesSnap.forEach(doc => titles.push({ id: doc.id, ref: doc.ref, ...doc.data() }));

  console.log(`Titoli totali: ${titles.length}\n`);

  // Filter titles that need enrichment
  const toEnrich = titles.filter(t => {
    const needsDescription = !t.description;
    const needsYear = !t.year;
    const needsPoster = !t.posterPath && DO_POSTER;
    return needsDescription || needsYear || needsPoster;
  });

  console.log(`Titoli da arricchire: ${toEnrich.length}`);
  console.log(`  - senza description: ${titles.filter(t => !t.description).length}`);
  console.log(`  - senza anno: ${titles.filter(t => !t.year).length}`);
  if (DO_POSTER) console.log(`  - senza poster: ${titles.filter(t => !t.posterPath).length}`);
  console.log();

  const stats = {
    searched: 0,
    matched: 0,
    descriptionAdded: 0,
    yearAdded: 0,
    posterUrlAdded: 0,
    noMatch: 0,
    noDescription: 0,
    errors: 0,
  };

  const noMatchList = [];
  const batch = db.batch();
  let batchCount = 0;

  for (let i = 0; i < toEnrich.length; i++) {
    const t = toEnrich[i];
    const mediaType = t.type === "tv" ? "tv" : "movie";
    const progress = `[${i + 1}/${toEnrich.length}]`;

    try {
      // Search TMDB
      const results = await searchTmdb(t.name, mediaType);
      stats.searched++;

      // If no results with Italian name, try originalName
      let match = pickBestMatch(results, t.name, t.year || null, mediaType);

      if (!match && t.originalName && t.originalName !== t.name) {
        const results2 = await searchTmdb(t.originalName, mediaType);
        match = pickBestMatch(results2, t.originalName, t.year || null, mediaType);
        stats.searched++;
        await sleep(250); // throttle
      }

      if (!match) {
        console.log(`  ${progress} ❌ ${t.name} — nessun match`);
        stats.noMatch++;
        noMatchList.push({ id: t.id, name: t.name, type: t.type });
        await sleep(250);
        continue;
      }

      // Fetch full details
      const tmdbId = match.id;
      const details = await getDetails(tmdbId, mediaType);
      stats.searched++;

      const isTV = mediaType === "tv";
      const overview = details.overview || "";
      const dateStr = isTV ? details.first_air_date : details.release_date;
      const year = dateStr ? parseInt(dateStr.substring(0, 4), 10) : null;
      const posterPath = details.poster_path || null;

      // Build update
      const update = {};
      let changes = [];

      if (!t.description && overview) {
        update.description = overview;
        stats.descriptionAdded++;
        changes.push("description");
      } else if (!t.description && !overview) {
        stats.noDescription++;
        changes.push("desc:vuota");
      }

      if (!t.year && year) {
        update.year = year;
        stats.yearAdded++;
        changes.push(`anno:${year}`);
      }

      if (!t.posterPath && posterPath && DO_POSTER) {
        // Store TMDB poster path for later download (not the full URL)
        update.tmdbPosterPath = posterPath;
        stats.posterUrlAdded++;
        changes.push("poster-path");
      }

      if (Object.keys(update).length > 0) {
        console.log(`  ${progress} ✅ ${t.name} → TMDB:${tmdbId} (${match.rName}) [${changes.join(", ")}]`);
        stats.matched++;

        if (WRITE) {
          batch.update(t.ref, update);
          batchCount++;

          // Flush batch every 450 ops
          if (batchCount >= 450) {
            await batch.commit();
            console.log(`   💾 Batch committed (${batchCount} ops)`);
            batchCount = 0;
          }
        }
      } else {
        console.log(`  ${progress} ⚪ ${t.name} → match trovato ma niente da aggiornare`);
      }

    } catch (err) {
      console.log(`  ${progress} 💥 ${t.name} — errore: ${err.message}`);
      stats.errors++;
    }

    // Throttle: ~4 requests per second
    await sleep(250);
  }

  // Flush remaining
  if (WRITE && batchCount > 0) {
    await batch.commit();
    console.log(`   💾 Batch finale committed (${batchCount} ops)`);
  }

  // ---- Summary ----
  console.log("\n" + "=".repeat(60));
  console.log("RIEPILOGO ENRICHMENT");
  console.log("=".repeat(60));
  console.log(`  Ricerche TMDB:           ${stats.searched}`);
  console.log(`  Match trovati:           ${stats.matched}`);
  console.log(`  Description aggiunte:    ${stats.descriptionAdded}`);
  console.log(`  Anno aggiunto:           ${stats.yearAdded}`);
  if (DO_POSTER) console.log(`  Poster path salvati:     ${stats.posterUrlAdded}`);
  console.log(`  Nessun match:            ${stats.noMatch}`);
  console.log(`  Match senza description: ${stats.noDescription}`);
  console.log(`  Errori:                  ${stats.errors}`);
  console.log(`\n  ${WRITE ? "✅ MODIFICHE APPLICATE" : "⚡ DRY-RUN — nessuna modifica"}`);

  if (noMatchList.length > 0) {
    console.log(`\n  Titoli senza match (${noMatchList.length}):`);
    for (const t of noMatchList) {
      console.log(`    - ${t.name} (${t.type}) [${t.id}]`);
    }
  }

  console.log("\n=== FINE ENRICHMENT ===");
}

main().catch(err => {
  console.error("ERRORE:", err);
  process.exit(1);
});
