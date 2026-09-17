#!/usr/bin/env node
/**
 * diagnose-db.js — Diagnostic script for titles ↔ people integrity.
 *
 * Reads all titles and people docs, checks:
 * 1. directors/directorIds array sync
 * 2. cast/castIds array sync
 * 3. Orphaned IDs (pointing to non-existent people)
 * 4. People with wrong occurrences count
 * 5. Titles missing description
 * 6. Titles missing poster
 * 7. People not referenced by any title
 *
 * Usage:
 *   cd functions
 *   node scripts/diagnose-db.js
 */

const admin = require("firebase-admin");

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

async function main() {
  console.log("=== DIAGNOSI DATABASE gia-visto ===\n");
  console.log("Caricamento dati...\n");

  // ---- Load all titles ----
  const titlesSnap = await db.collection("titles").get();
  const titles = [];
  titlesSnap.forEach(doc => titles.push({ id: doc.id, ...doc.data() }));

  // ---- Load all people ----
  const peopleSnap = await db.collection("people").get();
  const people = [];
  const peopleMap = new Map();
  peopleSnap.forEach(doc => {
    const d = { id: doc.id, ...doc.data() };
    people.push(d);
    peopleMap.set(doc.id, d);
  });

  // ---- Load all genres ----
  const genresSnap = await db.collection("genres").get();
  const genreIds = new Set();
  genresSnap.forEach(doc => genreIds.add(doc.id));

  console.log(`Titoli: ${titles.length}`);
  console.log(`People: ${people.length}`);
  console.log(`Generi: ${genreIds.size}\n`);

  // ========== 1. TITLE INTEGRITY ==========
  console.log("=" .repeat(60));
  console.log("1. INTEGRITÀ TITOLI");
  console.log("=" .repeat(60));

  const issues = {
    directorMismatch: [],    // directors.length !== directorIds.length
    castMismatch: [],        // cast.length !== castIds.length
    directorsNoIds: [],      // has directors names but empty directorIds
    castNoIds: [],           // has cast names but empty castIds
    orphanedDirectorIds: [], // directorIds pointing to non-existent people
    orphanedCastIds: [],     // castIds pointing to non-existent people
    noDescription: [],       // no description field
    noPoster: [],            // no posterPath
    noGenres: [],            // empty genres
    invalidGenres: [],       // genres referencing non-existent genre docs
    noYear: [],              // no year
    tmpIds: [],              // still has tmp_ IDs
  };

  // Track real occurrences per person
  const realOccurrences = new Map(); // personId → count

  for (const t of titles) {
    const dirs = Array.isArray(t.directors) ? t.directors : [];
    const dirIds = Array.isArray(t.directorIds) ? t.directorIds : [];
    const cast = Array.isArray(t.cast) ? t.cast : [];
    const castIds = Array.isArray(t.castIds) ? t.castIds : [];
    const genres = Array.isArray(t.genres) ? t.genres : [];

    // Director sync
    if (dirs.length !== dirIds.length) {
      issues.directorMismatch.push({ id: t.id, name: t.name, dirs: dirs.length, ids: dirIds.length });
    }
    if (dirs.length > 0 && dirIds.length === 0) {
      issues.directorsNoIds.push({ id: t.id, name: t.name, directors: dirs });
    }

    // Cast sync
    if (cast.length !== castIds.length) {
      issues.castMismatch.push({ id: t.id, name: t.name, cast: cast.length, ids: castIds.length });
    }
    if (cast.length > 0 && castIds.length === 0) {
      issues.castNoIds.push({ id: t.id, name: t.name, cast: cast });
    }

    // Check for tmp_ IDs
    const allIds = [...dirIds, ...castIds];
    const tmpFound = allIds.filter(id => String(id).startsWith("tmp_"));
    if (tmpFound.length > 0) {
      issues.tmpIds.push({ id: t.id, name: t.name, tmpIds: tmpFound });
    }

    // Orphaned IDs
    for (const did of dirIds) {
      if (!String(did).startsWith("tmp_") && !peopleMap.has(did)) {
        issues.orphanedDirectorIds.push({ titleId: t.id, titleName: t.name, personId: did });
      }
    }
    for (const cid of castIds) {
      if (!String(cid).startsWith("tmp_") && !peopleMap.has(cid)) {
        issues.orphanedCastIds.push({ titleId: t.id, titleName: t.name, personId: cid });
      }
    }

    // Count real occurrences
    for (const pid of [...dirIds, ...castIds]) {
      if (!String(pid).startsWith("tmp_")) {
        realOccurrences.set(pid, (realOccurrences.get(pid) || 0) + 1);
      }
    }

    // Missing fields
    if (!t.description) issues.noDescription.push({ id: t.id, name: t.name, year: t.year, type: t.type });
    if (!t.posterPath) issues.noPoster.push({ id: t.id, name: t.name });
    if (genres.length === 0) issues.noGenres.push({ id: t.id, name: t.name });
    if (!t.year) issues.noYear.push({ id: t.id, name: t.name });

    // Invalid genres
    const bad = genres.filter(gid => !genreIds.has(gid));
    if (bad.length > 0) {
      issues.invalidGenres.push({ id: t.id, name: t.name, invalidGenres: bad });
    }
  }

  // Print title issues
  printSection("Director array mismatch (directors.length ≠ directorIds.length)", issues.directorMismatch);
  printSection("Cast array mismatch (cast.length ≠ castIds.length)", issues.castMismatch);
  printSection("Directors senza IDs (nomi presenti, IDs vuoti)", issues.directorsNoIds);
  printSection("Cast senza IDs (nomi presenti, IDs vuoti)", issues.castNoIds);
  printSection("Director IDs orfani (persona non esiste in /people)", issues.orphanedDirectorIds);
  printSection("Cast IDs orfani (persona non esiste in /people)", issues.orphanedCastIds);
  printSection("Titoli con tmp_ IDs ancora presenti", issues.tmpIds);
  printSection("Titoli senza description", issues.noDescription, true);
  printSection("Titoli senza poster", issues.noPoster, true);
  printSection("Titoli senza generi", issues.noGenres);
  printSection("Titoli con generi non validi", issues.invalidGenres);
  printSection("Titoli senza anno", issues.noYear);

  // ========== 2. PEOPLE INTEGRITY ==========
  console.log("\n" + "=" .repeat(60));
  console.log("2. INTEGRITÀ PEOPLE");
  console.log("=" .repeat(60));

  const peopleIssues = {
    wrongOccurrences: [],   // stored occurrences ≠ real count
    unreferenced: [],       // people not in any title
    noRoles: [],            // people without roles
  };

  for (const p of people) {
    const storedOcc = Number(p.occurrences || 0);
    const realOcc = realOccurrences.get(p.id) || 0;

    if (storedOcc !== realOcc) {
      peopleIssues.wrongOccurrences.push({
        id: p.id, name: p.name, stored: storedOcc, real: realOcc, diff: realOcc - storedOcc
      });
    }

    if (realOcc === 0) {
      peopleIssues.unreferenced.push({ id: p.id, name: p.name, roles: p.roles });
    }

    if (!p.roles || !Array.isArray(p.roles) || p.roles.length === 0) {
      peopleIssues.noRoles.push({ id: p.id, name: p.name });
    }
  }

  printSection("Occurrences sbagliate (stored ≠ conteggio reale)", peopleIssues.wrongOccurrences);
  printSection("People non referenziati da nessun titolo", peopleIssues.unreferenced);
  printSection("People senza ruoli definiti", peopleIssues.noRoles);

  // ========== 3. SUMMARY ==========
  console.log("\n" + "=" .repeat(60));
  console.log("3. RIEPILOGO");
  console.log("=" .repeat(60));

  const totalTitles = titles.length;
  const titlesWithAllIds = titles.filter(t => {
    const dirs = Array.isArray(t.directors) ? t.directors : [];
    const dirIds = Array.isArray(t.directorIds) ? t.directorIds : [];
    const cast = Array.isArray(t.cast) ? t.cast : [];
    const castIds = Array.isArray(t.castIds) ? t.castIds : [];
    return dirs.length === dirIds.length && cast.length === castIds.length && dirIds.length + castIds.length > 0;
  }).length;

  const titlesWithPeople = titles.filter(t => {
    const dirs = Array.isArray(t.directors) ? t.directors : [];
    const cast = Array.isArray(t.cast) ? t.cast : [];
    return dirs.length > 0 || cast.length > 0;
  }).length;

  console.log(`\nTitoli totali: ${totalTitles}`);
  console.log(`  - con people (nomi): ${titlesWithPeople} (${pct(titlesWithPeople, totalTitles)})`);
  console.log(`  - con people IDs completi: ${titlesWithAllIds} (${pct(titlesWithAllIds, totalTitles)})`);
  console.log(`  - senza description: ${issues.noDescription.length} (${pct(issues.noDescription.length, totalTitles)})`);
  console.log(`  - senza poster: ${issues.noPoster.length} (${pct(issues.noPoster.length, totalTitles)})`);
  console.log(`  - senza anno: ${issues.noYear.length} (${pct(issues.noYear.length, totalTitles)})`);

  console.log(`\nPeople totali: ${people.length}`);
  console.log(`  - con occurrences corrette: ${people.length - peopleIssues.wrongOccurrences.length} (${pct(people.length - peopleIssues.wrongOccurrences.length, people.length)})`);
  console.log(`  - non referenziati: ${peopleIssues.unreferenced.length} (${pct(peopleIssues.unreferenced.length, people.length)})`);

  const criticalIssues =
    issues.directorMismatch.length +
    issues.castMismatch.length +
    issues.directorsNoIds.length +
    issues.castNoIds.length +
    issues.orphanedDirectorIds.length +
    issues.orphanedCastIds.length +
    issues.tmpIds.length;

  console.log(`\n🔴 Problemi critici (people↔titles): ${criticalIssues}`);
  console.log(`🟡 Dati mancanti (description/poster): ${issues.noDescription.length + issues.noPoster.length}`);
  console.log(`🟢 People orfani: ${peopleIssues.unreferenced.length}`);
  console.log(`🟡 Occurrences da correggere: ${peopleIssues.wrongOccurrences.length}`);

  console.log("\n=== FINE DIAGNOSI ===");
}

function pct(n, total) {
  if (!total) return "0%";
  return `${Math.round((n / total) * 100)}%`;
}

function printSection(label, items, summaryOnly = false) {
  const icon = items.length === 0 ? "✅" : "⚠️ ";
  console.log(`\n${icon} ${label}: ${items.length}`);
  if (items.length > 0 && !summaryOnly) {
    for (const item of items.slice(0, 15)) {
      console.log(`   → ${JSON.stringify(item)}`);
    }
    if (items.length > 15) console.log(`   ... e altri ${items.length - 15}`);
  } else if (items.length > 0 && summaryOnly) {
    console.log(`   (lista omessa per brevità — ${items.length} elementi)`);
  }
}

main().catch(err => {
  console.error("ERRORE:", err);
  process.exit(1);
});
