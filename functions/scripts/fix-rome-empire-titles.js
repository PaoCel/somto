#!/usr/bin/env node
/**
 * fix-rome-empire-titles.js
 *
 * Bug dati prod: il doc `titles/tmdb_movie_1891` contiene la SERIE TV "Rome"
 * (2005, HBO/BBC = TMDB tv/1891, nome IT "Roma") ma vive sotto un docId col
 * prefisso sbagliato (`tmdb_movie_` invece di `tmdb_tv_`) e porta uno slug
 * stantio di Empire (`l-impero-colpisce-ancora-1980`). TMDB riusa l'id 1891
 * sia per movie/1891 (L'Impero colpisce ancora) sia per tv/1891 (Rome): la
 * convenzione `tmdb_<type>_<id>` li distingue, ma qui il prefisso e' errato →
 * lo slot `tmdb_movie_1891` (che spetta a Empire) e' occupato.
 *
 * Fix (idempotente, dry-run default):
 *   FASE 1  Relocate: copia il doc Rome a `tmdb_tv_1891`, slug→`roma-2005`,
 *           preserva createdAt, repointa eventuali ref utente (verificate 0),
 *           cancella il vecchio `tmdb_movie_1891`.
 *   FASE 2  Seed Empire (movie/1891) come stub `approved` nello slot ora libero
 *           `tmdb_movie_1891` (enrich lazy al primo open via refreshTitleFromTmdb).
 *
 * Le 50 domande quiz (quiz_beta/wave2/q_172.json, titleId gia' = tmdb_movie_1891)
 * si importano con lo script separato `import-quiz-q172.js` DOPO questo.
 *
 * Usage (da functions/):
 *   node scripts/fix-rome-empire-titles.js            # dry-run
 *   node scripts/fix-rome-empire-titles.js --write      # applica
 */
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
const { slugify } = require("../modules/titleSlug");

const WRITE = process.argv.includes("--write");

const OLD_ID = "tmdb_movie_1891"; // squat: Rome-TV col prefisso movie
const NEW_ID = "tmdb_tv_1891";    // slot corretto per la serie Rome
const EMPIRE_ID = "tmdb_movie_1891"; // = OLD_ID, ora liberato per il film
const EMPIRE_TMDB = 1891;
const NEW_SLUG = "roma-2005";

const KEY = (() => {
  for (const f of [".env", ".env.gia-visto", ".env.production"]) {
    try {
      const m = fs.readFileSync(path.resolve(__dirname, "..", f), "utf8").match(/^TMDB_KEY=(.+)$/m);
      if (m) return m[1].trim();
    } catch (_) {}
  }
  return process.env.TMDB_KEY || process.env.TMDB_API_KEY || "";
})();

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();
const TS = () => admin.firestore.FieldValue.serverTimestamp();
const IMG = (p, size) => (p ? `https://image.tmdb.org/t/p/${size}${p}` : "");
const nameLower = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

async function tmdbDetails(type, id, lang) {
  const res = await fetch(`https://api.themoviedb.org/3/${type}/${id}?api_key=${KEY}&language=${lang}`);
  if (!res.ok) throw new Error(`TMDB ${type}/${id} ${lang} -> ${res.status}`);
  return res.json();
}

async function repointUserRefs() {
  // Verificato 0 in diagnostica, ma idempotente/difensivo: 81 utenti, get per docId
  // (niente indici collectionGroup). Ritorna conteggio ref spostate.
  const users = await db.collection("users").select("__name__").get();
  let moved = 0;
  for (const u of users.docs) {
    for (const sub of ["titleStates", "watchlist", "library"]) {
      const oldRef = db.doc(`users/${u.id}/${sub}/${OLD_ID}`);
      const snap = await oldRef.get();
      if (!snap.exists) continue;
      moved++;
      console.log(`  REF  users/${u.id}/${sub}/${OLD_ID} → ${NEW_ID}`);
      if (WRITE) {
        const data = snap.data() || {};
        if (typeof data.titleId === "string" && data.titleId === OLD_ID) data.titleId = NEW_ID;
        await db.doc(`users/${u.id}/${sub}/${NEW_ID}`).set(data, { merge: true });
        await oldRef.delete();
      }
    }
    // listProgressEntries: id proprio, campo titleId
    const lpe = await db.collection(`users/${u.id}/listProgressEntries`).where("titleId", "==", OLD_ID).get();
    for (const d of lpe.docs) {
      moved++;
      console.log(`  REF  users/${u.id}/listProgressEntries/${d.id}.titleId → ${NEW_ID}`);
      if (WRITE) await d.ref.set({ titleId: NEW_ID }, { merge: true });
    }
  }
  // ratings globali (titleId indicizzato single-field di default)
  const ratings = await db.collection("ratings").where("titleId", "==", OLD_ID).get();
  for (const d of ratings.docs) {
    moved++;
    const data = d.data() || {};
    const newId = d.id.replace(`__${OLD_ID}__`, `__${NEW_ID}__`);
    console.log(`  REF  ratings/${d.id} → ratings/${newId}`);
    if (WRITE) {
      await db.collection("ratings").doc(newId).set({ ...data, titleId: NEW_ID }, { merge: true });
      await d.ref.delete();
    }
  }
  return moved;
}

async function main() {
  console.log("=".repeat(64));
  console.log("FIX Rome/Empire — relocate tmdb_movie_1891 → tmdb_tv_1891 + seed Empire");
  console.log("mode:", WRITE ? "WRITE" : "DRY-RUN");
  console.log("=".repeat(64));
  if (!KEY) { console.error("TMDB key non trovata (functions/.env TMDB_KEY)."); process.exit(1); }

  const oldSnap = await db.collection("titles").doc(OLD_ID).get();
  const newSnap = await db.collection("titles").doc(NEW_ID).get();

  // --- FASE 1: relocate Rome ---
  console.log("\n[FASE 1] Relocate serie Rome");
  if (!oldSnap.exists) {
    console.log(`  SKIP relocate: ${OLD_ID} non esiste (gia' migrato?).`);
  } else if (newSnap.exists) {
    console.log(`  ABORT relocate: ${NEW_ID} esiste gia' → controllo manuale necessario.`);
    process.exit(1);
  } else {
    const old = oldSnap.data() || {};
    if (old.type !== "tv" || Number(old.tmdbId) !== EMPIRE_TMDB || old.nameLower !== "roma") {
      console.log("  ABORT: il doc non combacia con l'atteso (type=tv, tmdbId=1891, nameLower=roma):", { type: old.type, tmdbId: old.tmdbId, nameLower: old.nameLower });
      process.exit(1);
    }
    const baseSlug = slugify(old.name, old.year); // "roma-2005"
    const newData = { ...old, slug: baseSlug, slugUpdatedAt: TS(), updatedAt: TS(), relocatedFrom: OLD_ID };
    console.log(`  COPY ${OLD_ID} → ${NEW_ID}  (name="${old.name}", type=${old.type}, year=${old.year})`);
    console.log(`  SLUG "${old.slug}" → "${baseSlug}"`);
    if (baseSlug !== NEW_SLUG) console.log(`  WARN slug calcolato "${baseSlug}" != atteso "${NEW_SLUG}" (procedo col calcolato)`);
    if (WRITE) await db.collection("titles").doc(NEW_ID).set(newData, { merge: false });

    const moved = await repointUserRefs();
    console.log(`  ref utente spostate: ${moved}`);

    console.log(`  DELETE ${OLD_ID}`);
    if (WRITE) await db.collection("titles").doc(OLD_ID).delete();
  }

  // --- FASE 2: seed Empire nello slot liberato ---
  console.log("\n[FASE 2] Seed film Empire (movie/1891)");
  const empSnap = await db.collection("titles").doc(EMPIRE_ID).get();
  if (empSnap.exists && !WRITE && oldSnap.exists) {
    // in dry-run il delete di FASE 1 non e' avvenuto → lo slot risulta ancora occupato
    console.log(`  (dry-run) slot ${EMPIRE_ID} ancora occupato dal doc Rome; in --write sara' libero.`);
  } else if (empSnap.exists && WRITE) {
    console.log(`  SKIP seed: ${EMPIRE_ID} gia' presente ("${(empSnap.data() || {}).name}").`);
    return;
  }
  let it;
  try { it = await tmdbDetails("movie", EMPIRE_TMDB, "it-IT"); } catch (e) { console.log(`  ERR TMDB: ${e.message}`); process.exit(1); }
  let en = null;
  if (!String(it.overview || "").trim()) { try { en = await tmdbDetails("movie", EMPIRE_TMDB, "en-US"); } catch (_) {} }
  const name = it.title || it.original_title;
  const year = (it.release_date || "").slice(0, 4) ? Number((it.release_date || "").slice(0, 4)) : null;
  const empSlug = slugify(name, year);
  const empDoc = {
    name,
    originalName: it.original_title || "",
    type: "movie",
    year,
    status: "approved",
    tmdbId: EMPIRE_TMDB,
    tmdbRating: typeof it.vote_average === "number" ? it.vote_average : null,
    description: String(it.overview || (en && en.overview) || "").trim(),
    genres: Array.isArray(it.genres) ? it.genres.map((g) => `tmdb_${g.id}`) : [],
    posterPath: IMG(it.poster_path, "w500"),
    backdropPath: IMG(it.backdrop_path, "w780"),
    nameLower: nameLower(name),
    slug: empSlug,
    slugUpdatedAt: TS(),
    source: "manual_quiz_seed",
    search: { normalized: nameLower(name) },
    createdAt: TS(),
    updatedAt: TS(),
    tmdbSync: {
      lastTmdbId: EMPIRE_TMDB,
      lastMediaType: "movie",
      lastSource: "manual_quiz_seed",
      nextCheckAt: admin.firestore.Timestamp.fromMillis(Date.now() - 1000),
      lastStatus: "seed_pending_enrich",
      lastError: "",
    },
  };
  console.log(`  SEED ${EMPIRE_ID}  "${name}" (${year}) slug="${empSlug}" genres=${empDoc.genres.length} poster=${empDoc.posterPath ? "y" : "n"}`);
  if (WRITE) await db.collection("titles").doc(EMPIRE_ID).set(empDoc, { merge: false });

  console.log("\nFatto.", WRITE ? "(scritture applicate)" : "(dry-run: nessuna scrittura)");
}

main().then(() => process.exit(0)).catch((e) => { console.error("Failed:", e); process.exit(1); });
