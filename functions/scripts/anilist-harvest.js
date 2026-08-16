#!/usr/bin/env node
/**
 * anilist-harvest.js — FASE 1 (decoupled): raccoglie le mappe AniList per gli
 * item irrisolti LATINI di un import e le salva in un JSON. NESSUNA chiamata
 * TMDB/Firestore-di-matching qui: solo AniList (come il loop standalone che
 * funziona), così il throttle non è disturbato dall'interleaving.
 *
 * Output: /tmp/anilist-map-<importId>.json  { itemId: {name, expectedType, native, english, type, year} }
 *
 * Usage: TMDB non serve. Solo:
 *   GOOGLE_CLOUD_PROJECT=gia-visto node scripts/anilist-harvest.js --uid=UID --import=IMPORT_ID
 */
"use strict";
const fs = require("fs");
const admin = require("firebase-admin");
const { searchAnilistAnime } = require("../lib/importAdapters/anilist");
const { hasCjk } = require("../lib/importAdapters/matching");

const args = process.argv.slice(2);
const g = (f) => { const h = args.find((a) => a.startsWith(`${f}=`)); return h ? h.slice(f.length + 1).trim() : ""; };
const UID = g("--uid"); const IMPORT = g("--import");
if (!UID || !IMPORT) { console.error("--uid=UID --import=IMPORT_ID"); process.exit(1); }

admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

(async () => {
  const items = await db.collection("users").doc(UID).collection("imports").doc(IMPORT).collection("items").get();
  const unresolved = items.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((it) => !it.resolved && it.skip !== true);
  // one entry per item; name = series or movie guess; skip CJK (already handled)
  const targets = unresolved
    .map((it) => ({ id: it.id, name: (it.seriesNameGuess || it.movieNameGuess || "").trim(), expectedType: it.kind === "movie" ? "movie" : "tv" }))
    .filter((t) => t.name && !hasCjk(t.name));
  console.log(`irrisolti totali: ${unresolved.length} | latini da cercare su AniList: ${targets.length}`);

  const out = {};
  let ok = 0, empty = 0;
  for (let i = 0; i < targets.length; i += 1) {
    const t = targets[i];
    // eslint-disable-next-line no-await-in-loop
    const cands = await searchAnilistAnime(t.name);
    if (cands.length && (cands[0].native || cands[0].english)) {
      out[t.id] = { name: t.name, expectedType: t.expectedType, native: cands[0].native, english: cands[0].english, type: cands[0].type, year: cands[0].year };
      ok += 1;
    } else {
      empty += 1;
    }
    if (i % 20 === 0 || i === targets.length - 1) console.log(`  ${i + 1}/${targets.length} (mappati ${ok}, vuoti ${empty})`);
  }

  const path = `/tmp/anilist-map-${IMPORT}.json`;
  fs.writeFileSync(path, JSON.stringify(out, null, 0));
  console.log(`\nSalvato ${ok} mappe (${empty} senza match AniList) in ${path}`);
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
