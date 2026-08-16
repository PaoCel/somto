#!/usr/bin/env node
"use strict";

// Esporta uno snapshot READ-ONLY del catalogo e dei voti in un JSON locale, da
// dare in pasto a scripts/benchmark-recommendations.js.
//
// Perche' due passi invece di uno: il benchmark si rilancia decine di volte
// mentre si tara il motore. Se leggesse Firestore ogni volta pagheremmo le
// stesse letture a ripetizione; qui si legge UNA volta e poi si itera offline.
//
// NON scrive niente su Firestore. L'unico costo sono le letture dell'export.
//
// Uso:
//   node scripts/export-reco-dataset.js --out=/tmp/reco.json [--project=gia-visto]
//   node scripts/export-reco-dataset.js --out=/tmp/reco.json --max-titles=500 --max-ratings=5000
//   node scripts/export-reco-dataset.js --out=/tmp/reco.json --synthetic=  (dataset finto, zero letture)

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const out = { synthetic: 0 };
  for (const raw of argv.slice(2)) {
    const [key, value = ""] = raw.replace(/^--/, "").split("=");
    switch (key) {
      case "out": out.out = value; break;
      case "project": out.project = value; break;
      case "max-titles": out.maxTitles = Number(value) || 0; break;
      case "max-ratings": out.maxRatings = Number(value) || 0; break;
      case "synthetic": out.synthetic = Number(value) || 120; break;
      case "include-synthetic-users": out.includeSynthetic = true; break;
      case "no-title-states": out.skipTitleStates = true; break;
      case "max-title-states": out.maxTitleStates = Number(value) || 0; break;
      default: break;
    }
  }
  return out;
}

function toMs(value) {
  if (!value) return 0;
  if (typeof value === "number") return value;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value._seconds === "number") return value._seconds * 1000;
  if (typeof value.seconds === "number") return value.seconds * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Tiene solo i campi che il motore legge davvero: il resto gonfierebbe il file
// senza cambiare un singolo score.
function projectTitle(id, data) {
  return {
    id,
    name: data.name || "",
    originalName: data.originalName || "",
    description: String(data.description || data.overview || "").slice(0, 400),
    type: data.type || "movie",
    year: Number(data.year || 0) || null,
    genres: Array.isArray(data.genres) ? data.genres : [],
    cast: Array.isArray(data.cast) ? data.cast.slice(0, 12) : [],
    castIds: Array.isArray(data.castIds) ? data.castIds.slice(0, 12) : [],
    directors: Array.isArray(data.directors) ? data.directors.slice(0, 4) : [],
    directorIds: Array.isArray(data.directorIds) ? data.directorIds.slice(0, 4) : [],
    countries: Array.isArray(data.countries) ? data.countries : (Array.isArray(data.originCountry) ? data.originCountry : []),
    related: Array.isArray(data.related) ? data.related.slice(0, 30) : [],
    ratingAvg: Number(data.ratingAvg || 0),
    ratingCount: Number(data.ratingCount || 0),
    createdAtMs: toMs(data.createdAt),
    search: { tokens: Array.isArray(data?.search?.tokens) ? data.search.tokens.slice(0, 40) : [] },
  };
}

// Dataset finto, per verificare che l'harness funzioni senza toccare produzione.
// Gli utenti hanno un genere preferito: un motore che funziona DEVE batterci
// la baseline di popolarita'.
function buildSyntheticDataset(userCount) {
  const genres = ["Azione", "Commedia", "Dramma", "Horror", "Fantascienza", "Thriller"];
  const people = Array.from({ length: 40 }, (_, i) => `persona ${i}`);
  const titles = [];
  const TITLES = 400;
  const rnd = (() => { let a = 12345; return () => { a = (a * 1103515245 + 12345) % 2147483648; return a / 2147483648; }; })();

  for (let i = 0; i < TITLES; i++) {
    const g = genres[i % genres.length];
    const second = genres[(i * 3 + 1) % genres.length];
    titles.push({
      id: `t${i}`,
      name: `Titolo ${i}`,
      originalName: `Title ${i}`,
      description: `storia di ${g.toLowerCase()} numero ${i}`,
      type: i % 4 === 0 ? "tv" : "movie",
      year: 1990 + (i % 35),
      genres: g === second ? [g] : [g, second],
      cast: [people[i % people.length], people[(i * 7) % people.length]],
      castIds: [],
      directors: [people[(i * 5) % people.length]],
      directorIds: [],
      countries: ["IT"],
      related: [],
      ratingAvg: 4 + (rnd() * 6),
      ratingCount: Math.floor(rnd() * 400),
      createdAtMs: Date.UTC(2020, 0, 1) + (i * 86400000),
      search: { tokens: [`titolo`, String(i), g.toLowerCase()] },
    });
  }

  const ratings = [];
  const start = Date.UTC(2024, 0, 1);
  for (let u = 0; u < userCount; u++) {
    const uid = `u${u}`;
    const favourite = genres[u % genres.length];
    const count = 12 + Math.floor(rnd() * 25);
    for (let n = 0; n < count; n++) {
      const likesFavourite = rnd() < 0.75;
      const pool = titles.filter((t) => (t.genres.includes(favourite) === likesFavourite));
      const title = pool[Math.floor(rnd() * pool.length)];
      if (!title) continue;
      ratings.push({
        uid,
        titleId: title.id,
        rating: likesFavourite ? 7 + Math.floor(rnd() * 4) : 2 + Math.floor(rnd() * 5),
        level: "title",
        atMs: start + (n * 5 * 86400000) + Math.floor(rnd() * 86400000),
      });
    }
  }

  return { exportedAtMs: Date.now(), source: "synthetic", titles, ratings, watched: [] };
}

async function exportFromFirestore(args) {
  const admin = require("firebase-admin");
  if (!admin.apps.length) {
    admin.initializeApp({ projectId: args.project || process.env.GCLOUD_PROJECT });
  }
  const db = admin.firestore();

  console.log("[export] leggo i titoli approvati...");
  let titlesQuery = db.collection("titles").where("status", "==", "approved");
  if (args.maxTitles) titlesQuery = titlesQuery.limit(args.maxTitles);
  const titlesSnap = await titlesQuery.get();
  const titles = titlesSnap.docs.map((d) => projectTitle(d.id, d.data() || {}));
  console.log(`[export] titoli: ${titles.length}`);

  console.log("[export] leggo i voti a livello titolo...");
  const titleIds = new Set(titles.map((t) => t.id));
  const ratings = [];
  let skippedSynthetic = 0;
  let skippedUnknownTitle = 0;

  // Si esportano TUTTI i livelli (title/season/episode) con il loro `level`: il
  // benchmark decide poi quali usare. In produzione i seed leggono solo
  // level=="title", ma su questo catalogo i voti per stagione sono la
  // maggioranza — escluderli qui vorrebbe dire buttare via il dato prima ancora
  // di poter misurare quanto pesa.
  let query = db.collection("ratings").orderBy("createdAt", "asc").limit(2000);
  let cursor = null;
  for (;;) {
    const snap = await (cursor ? query.startAfter(cursor).get() : query.get());
    if (snap.empty) break;
    for (const doc of snap.docs) {
      const row = doc.data() || {};
      const uid = String(row.uid || "").trim();
      const titleId = String(row.titleId || "").trim();
      const rating = Number(row.rating || 0);
      if (!uid || !titleId || !Number.isFinite(rating) || rating <= 0) continue;
      if (!args.includeSynthetic && (row.isSynthetic === true || uid.startsWith("guided_"))) {
        skippedSynthetic++;
        continue;
      }
      if (!titleIds.has(titleId)) { skippedUnknownTitle++; continue; }
      ratings.push({
        uid,
        titleId,
        rating,
        level: String(row.level || "title"),
        atMs: toMs(row.createdAt) || toMs(row.updatedAt),
      });
    }
    cursor = snap.docs[snap.docs.length - 1];
    if (snap.size < 2000) break;
    if (args.maxRatings && ratings.length >= args.maxRatings) break;
    process.stdout.write(`\r[export] voti: ${ratings.length}`);
  }
  process.stdout.write("\n");
  console.log(`[export] voti: ${ratings.length} (sintetici saltati: ${skippedSynthetic}, titolo sconosciuto: ${skippedUnknownTitle})`);

  // Gli stati titolo sono il segnale IMPLICITO: 70k doc contro 3k voti, ed e'
  // quello che l'utente ha davvero consumato. Attenzione pero' ai timestamp —
  // per chi e' arrivato da un import (Netflix/TV Time/Trakt) `seenAt` e
  // `completedAt` valgono la data dell'IMPORT, non quella della visione: una
  // cronologia di anni si schiaccia su due giorni. Per questo l'export porta con
  // se' `source`, e il benchmark non deve fingere che sia un ordine temporale
  // vero (vedi --split nel benchmark).
  const watched = [];
  if (!args.skipTitleStates) {
    console.log("[export] leggo gli stati titolo (segnale implicito)...");
    let seen = 0;
    let cursor = null;
    for (;;) {
      let q = db.collectionGroup("titleStates").orderBy("__name__").limit(2000);
      if (cursor) q = q.startAfter(cursor);
      const snap = await q.get();
      if (snap.empty) break;
      for (const doc of snap.docs) {
        seen++;
        const row = doc.data() || {};
        const uid = String(doc.ref.path.split("/")[1] || "").trim();
        const titleId = String(row.titleId || doc.id || "").trim();
        if (!uid || !titleId) continue;
        if (!args.includeSynthetic && uid.startsWith("guided_")) continue;
        if (!titleIds.has(titleId)) continue;
        watched.push({
          uid,
          titleId,
          state: String(row.state || ""),
          source: String(row.source || ""),
          atMs: toMs(row.seenAt) || toMs(row.completedAt) || toMs(row.createdAt) || toMs(row.updatedAt),
        });
      }
      cursor = snap.docs[snap.docs.length - 1];
      if (snap.size < 2000) break;
      if (args.maxTitleStates && watched.length >= args.maxTitleStates) break;
      process.stdout.write(`\r[export] stati titolo: ${watched.length} (letti ${seen})`);
    }
    process.stdout.write("\n");
    console.log(`[export] stati titolo: ${watched.length}`);
  }

  return { exportedAtMs: Date.now(), source: args.project || "firestore", titles, ratings, watched };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.out) {
    console.error("Manca --out=/percorso/dataset.json");
    process.exit(1);
  }

  const dataset = args.synthetic
    ? buildSyntheticDataset(args.synthetic)
    : await exportFromFirestore(args);

  const outPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(dataset));
  const mb = (fs.statSync(outPath).size / (1024 * 1024)).toFixed(2);
  console.log(`[export] scritto ${outPath} (${mb} MB) — ${dataset.titles.length} titoli, ${dataset.ratings.length} voti, ${(dataset.watched || []).length} stati titolo`);
}

main().catch((err) => {
  console.error("[export] errore:", err);
  process.exit(1);
});
