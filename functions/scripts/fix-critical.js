#!/usr/bin/env node
/**
 * fix-critical.js — Fix the 11 remaining critical issues:
 *
 * A) 3 directors with names but no IDs:
 *    - Carry-On → Jaume Collet-Serra
 *    - Io sono nessuno → Il'ja Najšuller (exists as orphaned person!)
 *    - Un medico in famiglia → Anna Di Francisca
 *
 * B) 3 cast with more names than IDs (null removed left gaps):
 *    - Game Night (10 cast, 9 IDs) → find which name has no ID
 *    - Almost Cops (10 cast, 9 IDs)
 *    - Giurato numero 2 (10 cast, 8 IDs)
 *
 * C) 1 cast with names but no IDs:
 *    - Un medico in famiglia → Lino Banfi
 *
 * Strategy: For each, find or create the missing person doc and link it.
 *
 * Usage:
 *   node scripts/fix-critical.js              # dry-run
 *   node scripts/fix-critical.js --write      # apply
 */

const admin = require("firebase-admin");

const WRITE = process.argv.includes("--write");

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

async function main() {
  console.log(`=== FIX CRITICAL ===${WRITE ? " [WRITE]" : " [DRY-RUN]"}\n`);

  // Load people for name lookup
  const peopleSnap = await db.collection("people").get();
  const peopleByName = new Map(); // lowercase name → { id, name }
  peopleSnap.forEach(doc => {
    const d = doc.data();
    if (d.name) {
      peopleByName.set(d.name.toLowerCase().trim(), { id: doc.id, name: d.name });
    }
  });

  console.log(`People caricati: ${peopleByName.size}\n`);

  // ============================================================
  // PART A: Directors with names but no IDs
  // ============================================================
  console.log("=" .repeat(60));
  console.log("PART A: Directors senza IDs");
  console.log("=" .repeat(60));

  const directorsToFix = [
    { titleId: "QHKxNxuc5uymJp3TMvSn", titleName: "Carry-On", directorName: "Jaume Collet-Serra" },
    { titleId: "r8Gu8Bsp0S1olfYUyj0j", titleName: "Io sono nessuno", directorName: "Il'ja Najšuller" },
    { titleId: "un-medico-in-famiglia", titleName: "Un medico in famiglia", directorName: "Anna Di Francisca" },
  ];

  for (const fix of directorsToFix) {
    console.log(`\n  📌 ${fix.titleName} → regista: ${fix.directorName}`);

    // Find existing person
    let personId = null;
    const existing = peopleByName.get(fix.directorName.toLowerCase().trim());

    if (existing) {
      personId = existing.id;
      console.log(`     ✅ Persona trovata: ${existing.name} (${personId})`);
    } else {
      // Create new person
      personId = fix.directorName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/_+$/, "");
      console.log(`     🆕 Creo persona: ${fix.directorName} (${personId})`);

      if (WRITE) {
        await db.collection("people").doc(personId).set({
          name: fix.directorName,
          roles: ["director"],
          occurrences: 1,
          search: { nameLower: fix.directorName.toLowerCase() },
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }

    // Update title's directorIds
    if (WRITE) {
      const titleRef = db.collection("titles").doc(fix.titleId);
      const titleDoc = await titleRef.get();
      const data = titleDoc.data();
      const currentIds = Array.isArray(data.directorIds) ? data.directorIds : [];

      // Set directorIds to match directors array
      const newIds = [personId];
      await titleRef.update({ directorIds: newIds });
      console.log(`     💾 directorIds aggiornato: [${newIds.join(", ")}]`);

      // Update occurrences for person if it already existed
      if (existing) {
        const pRef = db.collection("people").doc(personId);
        const pDoc = await pRef.get();
        const pData = pDoc.data();
        const currentOcc = pData.occurrences || 0;
        // Count real occurrences by scanning all titles
        // For simplicity, just increment by 1 (we'll re-run diagnose to verify)
        await pRef.update({ occurrences: admin.firestore.FieldValue.increment(1) });
      }
    } else {
      console.log(`     ⚡ (dry-run) directorIds → [${personId}]`);
    }
  }

  // ============================================================
  // PART B: Cast mismatch — more names than IDs
  // ============================================================
  console.log("\n\n" + "=" .repeat(60));
  console.log("PART B: Cast mismatch (nomi > IDs)");
  console.log("=" .repeat(60));

  const castToFix = [
    "UkIVEZcUUTd2K0N2H37I",  // Game Night
    "efVsiQ9NyP317T4fipQD",  // Almost Cops
    "zzrWcDDFCgdrJuJB8VxJ",  // Giurato numero 2
  ];

  for (const titleId of castToFix) {
    const titleRef = db.collection("titles").doc(titleId);
    const titleDoc = await titleRef.get();
    const data = titleDoc.data();

    const names = Array.isArray(data.cast) ? data.cast : [];
    const ids = Array.isArray(data.castIds) ? data.castIds : [];

    console.log(`\n  📌 ${data.name} — cast: ${names.length} nomi, ${ids.length} IDs`);

    // The IDs correspond to names that had valid people docs.
    // The missing ones are names where the null was removed.
    // We need to figure out which positions had nulls.
    // Since we can't know exactly, the safest approach is:
    // 1. For each name, check if it has a corresponding person
    // 2. Build a new castIds array matching each name

    const newIds = [];
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const existing = peopleByName.get(name.toLowerCase().trim());

      if (existing) {
        newIds.push(existing.id);
        console.log(`     [${i}] ${name} → ${existing.id} ✅`);
      } else {
        // Create new person
        const newId = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/_+$/, "");
        newIds.push(newId);
        console.log(`     [${i}] ${name} → 🆕 ${newId}`);

        if (WRITE) {
          const pRef = db.collection("people").doc(newId);
          const pExists = await pRef.get();
          if (!pExists.exists) {
            await pRef.set({
              name: name,
              roles: ["actor"],
              occurrences: 1,
              search: { nameLower: name.toLowerCase() },
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
        }
      }
    }

    console.log(`     → Nuovo castIds: ${newIds.length} IDs`);

    if (WRITE) {
      await titleRef.update({ castIds: newIds });
      console.log(`     💾 Scritto!`);
    }
  }

  // ============================================================
  // PART C: Un medico in famiglia — cast senza IDs
  // ============================================================
  console.log("\n\n" + "=" .repeat(60));
  console.log("PART C: Un medico in famiglia — cast senza IDs");
  console.log("=" .repeat(60));

  {
    const titleId = "un-medico-in-famiglia";
    const titleRef = db.collection("titles").doc(titleId);
    const titleDoc = await titleRef.get();
    const data = titleDoc.data();

    const castNames = Array.isArray(data.cast) ? data.cast : [];
    console.log(`\n  📌 Cast: [${castNames.join(", ")}]`);

    const newCastIds = [];
    for (const name of castNames) {
      const existing = peopleByName.get(name.toLowerCase().trim());
      if (existing) {
        newCastIds.push(existing.id);
        console.log(`     ${name} → ${existing.id} ✅`);
      } else {
        const newId = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/_+$/, "");
        newCastIds.push(newId);
        console.log(`     ${name} → 🆕 ${newId}`);

        if (WRITE) {
          const pRef = db.collection("people").doc(newId);
          const pExists = await pRef.get();
          if (!pExists.exists) {
            await pRef.set({
              name: name,
              roles: ["actor"],
              occurrences: 1,
              search: { nameLower: name.toLowerCase() },
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
        }
      }
    }

    if (WRITE) {
      await titleRef.update({ castIds: newCastIds });
      console.log(`     💾 castIds scritto: [${newCastIds.join(", ")}]`);
    } else {
      console.log(`     ⚡ (dry-run) castIds → [${newCastIds.join(", ")}]`);
    }
  }

  console.log("\n\n=== FINE FIX CRITICAL ===");
}

main().catch(err => {
  console.error("ERRORE:", err);
  process.exit(1);
});
