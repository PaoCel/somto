#!/usr/bin/env node
/**
 * fix-db.js — Automated fixes for titles ↔ people integrity.
 *
 * Fixes:
 * 1. Remove `null` values from directorIds / castIds arrays
 * 2. Populate missing directors/cast name arrays from people docs
 * 3. Recalculate occurrences for all people
 * 4. Create missing genre docs (romantico, sport)
 * 5. Fix people without roles (infer from title references)
 *
 * Usage:
 *   cd functions
 *   node scripts/fix-db.js              # dry-run (default)
 *   node scripts/fix-db.js --write      # apply changes
 */

const admin = require("firebase-admin");

const WRITE = process.argv.includes("--write");

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

// Batched writes helper (Firestore limit = 500 ops per batch)
class BatchWriter {
  constructor(db) {
    this.db = db;
    this.batch = db.batch();
    this.count = 0;
    this.totalCommits = 0;
  }
  set(ref, data, opts) {
    this.batch.set(ref, data, opts || {});
    this.count++;
    if (this.count >= 450) return this.flush();
    return Promise.resolve();
  }
  update(ref, data) {
    this.batch.update(ref, data);
    this.count++;
    if (this.count >= 450) return this.flush();
    return Promise.resolve();
  }
  async flush() {
    if (this.count === 0) return;
    if (WRITE) {
      await this.batch.commit();
      this.totalCommits += this.count;
      console.log(`   💾 Batch committed (${this.count} ops, total: ${this.totalCommits})`);
    } else {
      this.totalCommits += this.count;
    }
    this.batch = this.db.batch();
    this.count = 0;
  }
}

async function main() {
  console.log(`\n=== FIX DATABASE gia-visto ===${WRITE ? " [WRITE MODE]" : " [DRY-RUN]"}\n`);
  if (!WRITE) console.log("⚡ Usa --write per applicare le modifiche\n");

  // ---- Load all data ----
  console.log("Caricamento dati...");
  const [titlesSnap, peopleSnap, genresSnap] = await Promise.all([
    db.collection("titles").get(),
    db.collection("people").get(),
    db.collection("genres").get(),
  ]);

  const titles = [];
  titlesSnap.forEach(doc => titles.push({ id: doc.id, ref: doc.ref, ...doc.data() }));

  const people = [];
  const peopleMap = new Map();
  peopleSnap.forEach(doc => {
    const d = { id: doc.id, ref: doc.ref, ...doc.data() };
    people.push(d);
    peopleMap.set(doc.id, d);
  });

  const genreIds = new Set();
  genresSnap.forEach(doc => genreIds.add(doc.id));

  console.log(`Titoli: ${titles.length} | People: ${people.length} | Generi: ${genreIds.size}\n`);

  const writer = new BatchWriter(db);
  const stats = {
    nullIdsFixed: 0,
    namesPopulated: 0,
    occurrencesFixed: 0,
    genresCreated: 0,
    rolesFixed: 0,
  };

  // ============================================================
  // FIX 1: Remove null values from directorIds / castIds
  // FIX 2: Populate missing directors/cast names from people docs
  // ============================================================
  console.log("=" .repeat(60));
  console.log("FIX 1+2: Null IDs + Nomi mancanti");
  console.log("=" .repeat(60));

  // Track real occurrences (needed for FIX 3)
  const realOccurrences = new Map();

  for (const t of titles) {
    let dirIds = Array.isArray(t.directorIds) ? [...t.directorIds] : [];
    let castIds = Array.isArray(t.castIds) ? [...t.castIds] : [];
    const dirNames = Array.isArray(t.directors) ? [...t.directors] : [];
    const castNames = Array.isArray(t.cast) ? [...t.cast] : [];

    const update = {};
    let changed = false;

    // --- FIX 1: Remove nulls ---
    const dirIdsClean = dirIds.filter(id => id !== null && id !== undefined);
    const castIdsClean = castIds.filter(id => id !== null && id !== undefined);

    if (dirIdsClean.length !== dirIds.length) {
      const removed = dirIds.length - dirIdsClean.length;
      console.log(`  🔧 ${t.name} (${t.id}): rimosso ${removed} null da directorIds`);
      update.directorIds = dirIdsClean;
      dirIds = dirIdsClean;
      changed = true;
      stats.nullIdsFixed += removed;
    }

    if (castIdsClean.length !== castIds.length) {
      const removed = castIds.length - castIdsClean.length;
      console.log(`  🔧 ${t.name} (${t.id}): rimosso ${removed} null da castIds`);
      update.castIds = castIdsClean;
      castIds = castIdsClean;
      changed = true;
      stats.nullIdsFixed += removed;
    }

    // --- FIX 2: Populate missing names from people docs ---
    // Case: has directorIds but empty directors names
    if (dirIds.length > 0 && dirNames.length === 0) {
      const names = dirIds.map(id => {
        const p = peopleMap.get(id);
        return p ? p.name : `[sconosciuto: ${id}]`;
      });
      console.log(`  📝 ${t.name}: directors = [${names.join(", ")}]`);
      update.directors = names;
      changed = true;
      stats.namesPopulated++;
    }
    // Case: has castIds but empty cast names
    if (castIds.length > 0 && castNames.length === 0) {
      const names = castIds.map(id => {
        const p = peopleMap.get(id);
        return p ? p.name : `[sconosciuto: ${id}]`;
      });
      console.log(`  📝 ${t.name}: cast = [${names.join(", ")}] (${names.length} attori)`);
      update.cast = names;
      changed = true;
      stats.namesPopulated++;
    }

    // Track real occurrences (after cleaning)
    for (const pid of [...dirIds, ...castIds]) {
      if (pid && !String(pid).startsWith("tmp_")) {
        realOccurrences.set(pid, (realOccurrences.get(pid) || 0) + 1);
      }
    }

    if (changed) {
      await writer.update(t.ref, update);
    }
  }

  console.log(`\n  → Null rimossi: ${stats.nullIdsFixed}`);
  console.log(`  → Nomi popolati: ${stats.namesPopulated} titoli\n`);

  // ============================================================
  // FIX 3: Recalculate occurrences for all people
  // ============================================================
  console.log("=" .repeat(60));
  console.log("FIX 3: Ricalcolo occurrences");
  console.log("=" .repeat(60));

  let occSampleShown = 0;
  for (const p of people) {
    const stored = Number(p.occurrences || 0);
    const real = realOccurrences.get(p.id) || 0;

    if (stored !== real) {
      if (occSampleShown < 10) {
        console.log(`  🔢 ${p.name}: ${stored} → ${real}`);
        occSampleShown++;
      }
      await writer.update(p.ref, { occurrences: real });
      stats.occurrencesFixed++;
    }
  }

  if (stats.occurrencesFixed > 10) {
    console.log(`  ... e altri ${stats.occurrencesFixed - 10}`);
  }
  console.log(`\n  → Occurrences corrette: ${stats.occurrencesFixed}\n`);

  // ============================================================
  // FIX 4: Create missing genre docs
  // ============================================================
  console.log("=" .repeat(60));
  console.log("FIX 4: Generi mancanti");
  console.log("=" .repeat(60));

  const missingGenres = [
    { id: "romantico", name: "Romantico" },
    { id: "sport", name: "Sport" },
  ];

  for (const g of missingGenres) {
    if (!genreIds.has(g.id)) {
      console.log(`  🎭 Creo genere: ${g.name} (${g.id})`);
      const gRef = db.collection("genres").doc(g.id);
      await writer.set(gRef, {
        name: g.name,
        search: { nameLower: g.name.toLowerCase() },
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      stats.genresCreated++;
    } else {
      console.log(`  ✅ Genere ${g.id} già esiste`);
    }
  }

  console.log(`\n  → Generi creati: ${stats.genresCreated}\n`);

  // ============================================================
  // FIX 5: People without roles — infer from title references
  // ============================================================
  console.log("=" .repeat(60));
  console.log("FIX 5: People senza ruoli");
  console.log("=" .repeat(60));

  // Build reverse lookup: personId → { isDirector, isActor }
  const personRoles = new Map();
  for (const t of titles) {
    const dirIds = Array.isArray(t.directorIds) ? t.directorIds : [];
    const castIds = Array.isArray(t.castIds) ? t.castIds : [];

    for (const did of dirIds) {
      if (did) {
        if (!personRoles.has(did)) personRoles.set(did, { director: false, actor: false });
        personRoles.get(did).director = true;
      }
    }
    for (const cid of castIds) {
      if (cid) {
        if (!personRoles.has(cid)) personRoles.set(cid, { director: false, actor: false });
        personRoles.get(cid).actor = true;
      }
    }
  }

  for (const p of people) {
    if (!p.roles || !Array.isArray(p.roles) || p.roles.length === 0) {
      const refs = personRoles.get(p.id);
      const roles = [];
      if (refs) {
        if (refs.actor) roles.push("actor");
        if (refs.director) roles.push("director");
      }
      if (roles.length === 0) roles.push("actor"); // default

      console.log(`  👤 ${p.name}: ruoli = [${roles.join(", ")}]`);
      await writer.update(p.ref, { roles });
      stats.rolesFixed++;
    }
  }

  console.log(`\n  → Ruoli corretti: ${stats.rolesFixed}\n`);

  // ============================================================
  // FLUSH & SUMMARY
  // ============================================================
  await writer.flush();

  console.log("=" .repeat(60));
  console.log("RIEPILOGO FIX");
  console.log("=" .repeat(60));
  console.log(`  Null IDs rimossi:        ${stats.nullIdsFixed}`);
  console.log(`  Nomi popolati:           ${stats.namesPopulated} titoli`);
  console.log(`  Occurrences corrette:    ${stats.occurrencesFixed}`);
  console.log(`  Generi creati:           ${stats.genresCreated}`);
  console.log(`  Ruoli corretti:          ${stats.rolesFixed}`);
  console.log(`  Operazioni totali:       ${writer.totalCommits}`);
  console.log(`\n  ${WRITE ? "✅ MODIFICHE APPLICATE" : "⚡ DRY-RUN — nessuna modifica applicata"}`);
  console.log("\n=== FINE FIX ===");
}

main().catch(err => {
  console.error("ERRORE:", err);
  process.exit(1);
});
