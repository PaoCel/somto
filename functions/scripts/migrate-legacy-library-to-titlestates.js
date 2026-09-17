#!/usr/bin/env node
/**
 * migrate-legacy-library-to-titlestates.js — Ricostruisce i doc titleStates
 * dalla collection legacy `library` per gli utenti mai passati al modello
 * titleStates (0 doc titleStates, library popolata). Dopo la migrazione
 * titleStates e' fonte di verita completa per il calcolo delle stats.
 *
 * Un doc library legacy contiene solo { titleId, createdAt, updatedAt, lastRating }.
 * Ogni doc rappresenta un titolo visto; con lastRating e' anche valutato.
 *
 * Usage:
 *   cd functions
 *   node scripts/migrate-legacy-library-to-titlestates.js          # dry-run
 *   node scripts/migrate-legacy-library-to-titlestates.js --write
 */

const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { normalizeStateForTitle, isMeaningfulTitleState } = require("../lib/titleStates");

const WRITE = process.argv.includes("--write");

initializeApp({ projectId: "gia-visto" });
const db = getFirestore();

const titleCache = new Map();
async function getTitle(titleId) {
  if (titleCache.has(titleId)) return titleCache.get(titleId);
  const snap = await db.collection("titles").doc(titleId).get().catch(() => null);
  const data = snap && snap.exists ? { id: titleId, ...(snap.data() || {}) } : null;
  titleCache.set(titleId, data);
  return data;
}

function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function migrateUser(userDoc) {
  const userRef = userDoc.ref;
  const [statesSnap, librarySnap] = await Promise.all([
    userRef.collection("titleStates").limit(1).get(),
    userRef.collection("library").get(),
  ]);

  // Solo utenti legacy: nessun titleState esistente, library popolata.
  if (statesSnap.size > 0 || librarySnap.size === 0) return null;

  const batch = db.batch();
  let created = 0;
  let missingTitle = 0;
  let totalWatchMinutes = 0;

  for (const libDoc of librarySnap.docs) {
    const lib = libDoc.data() || {};
    const titleId = String(lib.titleId || libDoc.id || "").trim();
    if (!titleId) continue;

    const title = await getTitle(titleId);
    if (!title) { missingTitle += 1; continue; }

    const mediaType = String(title.type || "").trim().toLowerCase() === "tv" ? "tv" : "movie";
    const rating = toNumberOrNull(lib.lastRating);
    const createdAt = lib.createdAt || lib.updatedAt || null;
    const updatedAt = lib.updatedAt || lib.createdAt || null;

    const rawState = {
      titleId,
      mediaType,
      state: rating != null ? "rated" : (mediaType === "tv" ? "completed_unrated" : "seen_unrated"),
      hasTitleRating: rating != null,
      ratingValue: rating,
      ratedAt: rating != null ? (updatedAt || createdAt) : null,
      seenAt: createdAt,
      completedAt: mediaType === "tv" ? createdAt : null,
      createdAt,
      updatedAt,
      source: "legacy_library_migration",
    };

    const nextState = normalizeStateForTitle(rawState, title, { now: new Date() });
    if (!isMeaningfulTitleState(nextState)) continue;

    totalWatchMinutes += Number(nextState.watchMinutesContribution) || 0;
    if (WRITE) {
      batch.set(userRef.collection("titleStates").doc(titleId), nextState, { merge: true });
    }
    created += 1;
  }

  if (WRITE && created > 0) await batch.commit();
  return { uid: userDoc.id, libraryDocs: librarySnap.size, created, missingTitle, totalWatchMinutes };
}

async function main() {
  console.log(`migrate-legacy-library-to-titlestates — ${WRITE ? "WRITE" : "DRY-RUN"}\n`);
  const usersSnap = await db.collection("users").get();
  let migratedUsers = 0;
  let totalCreated = 0;
  let totalMissing = 0;

  for (const userDoc of usersSnap.docs) {
    const result = await migrateUser(userDoc);
    if (!result) continue;
    migratedUsers += 1;
    totalCreated += result.created;
    totalMissing += result.missingTitle;
    const miss = result.missingTitle ? `, ${result.missingTitle} titoli mancanti saltati` : "";
    console.log(`  ${result.uid}: ${result.libraryDocs} library -> ${result.created} titleStates, ${result.totalWatchMinutes} min${miss}`);
  }

  console.log(`\nFatto. Utenti legacy migrati: ${migratedUsers}, titleStates creati: ${totalCreated}, titoli mancanti: ${totalMissing}`);
  if (!WRITE) console.log("Dry-run, nulla scritto. Usa --write per applicare.");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
