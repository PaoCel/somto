#!/usr/bin/env node
/**
 * resolve-wave2-titles.js  (read-only, NO write)
 * Risolve i candidati wave2 via TMDB (id verificati), li mappa al catalogo,
 * dedup vs i titoli già coperti (quizMeta/themes), e scrive una rosa pronta.
 * Output: quiz_beta/quiz_wave2_titles.json  (poi si pickano i 50 finali).
 */
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
const KEY = (() => {
  for (const f of [".env", ".env.gia-visto", ".env.production"]) {
    try { const m = fs.readFileSync(path.resolve(__dirname, "..", f), "utf8").match(/^TMDB_KEY=(.+)$/m); if (m) return m[1].trim(); } catch (_) {}
  }
  return process.env.TMDB_KEY || "";
})();
admin.initializeApp({ projectId: "gia-visto" });
const db = admin.firestore();

// [cluster, query, type, yearHint]
const CAND = [
  // anime
  ["anime","Hunter x Hunter","tv",2011],["anime","Fullmetal Alchemist Brotherhood","tv",2009],
  ["anime","Tokyo Revengers","tv",2021],["anime","Spy x Family","tv",2022],["anime","Chainsaw Man","tv",2022],
  ["anime","Bleach","tv",2004],["anime","One Punch Man","tv",2015],["anime","Haikyu!!","tv",2014],
  ["anime","Blue Lock","tv",2022],["anime","Vinland Saga","tv",2019],["anime","Neon Genesis Evangelion","tv",1995],
  ["anime","Dragon Ball","tv",1986],["anime","Pokémon","tv",1997],
  // italiano serie
  ["italiano","Suburra - La serie","tv",2017],["italiano","Baby","tv",2018],["italiano","L'amica geniale","tv",2018],
  ["italiano","Doc - Nelle tue mani","tv",2020],["italiano","Boris","tv",2007],["italiano","Don Matteo","tv",2000],
  ["italiano","Strappare lungo i bordi","tv",2021],["italiano","Il commissario Ricciardi","tv",2021],
  ["italiano","Che Dio ci aiuti","tv",2011],["italiano","Imma Tataranni","tv",2019],
  // italiano film
  ["italiano","Notte prima degli esami","movie",2006],["italiano","Immaturi","movie",2011],
  ["italiano","Come un gatto in tangenziale","movie",2017],["italiano","Il primo Natale","movie",2019],
  ["italiano","Tre uomini e una gamba","movie",1997],["italiano","Johnny Stecchino","movie",1991],
  ["italiano","Il mostro","movie",1994],["italiano","La leggenda del pianista sull'oceano","movie",1998],
  ["italiano","Sotto il sole di Riccione","movie",2020],["italiano","Benvenuti al Nord","movie",2012],
  // tv global
  ["tv_global","The Mandalorian","tv",2019],["tv_global","Loki","tv",2021],["tv_global","WandaVision","tv",2021],
  ["tv_global","Sex Education","tv",2019],["tv_global","Élite","tv",2018],["tv_global","Cobra Kai","tv",2018],
  ["tv_global","The Umbrella Academy","tv",2019],["tv_global","The White Lotus","tv",2021],
  ["tv_global","Severance","tv",2022],["tv_global","Succession","tv",2018],["tv_global","Ozark","tv",2017],
  ["tv_global","Prison Break","tv",2005],["tv_global","The Big Bang Theory","tv",2007],
  ["tv_global","Grey's Anatomy","tv",2005],["tv_global","Rick and Morty","tv",2013],
  ["tv_global","Arcane","tv",2021],["tv_global","Vikings","tv",2013],["tv_global","Black Mirror","tv",2011],
  ["tv_global","Brooklyn Nine-Nine","tv",2013],["tv_global","The Walking Dead","tv",2010],
  // film cult / franchise
  ["film_cult","Inception","movie",2010],["film_cult","Le iene","movie",1992],
  ["film_cult","Spider-Man","movie",2002],["film_cult","Batman Begins","movie",2005],
  ["film_cult","The Batman","movie",2022],["film_cult","Harry Potter e la pietra filosofale","movie",2001],
  ["film_cult","Guerre stellari - L'Impero colpisce ancora","movie",1980],
  ["film_cult","Il ritorno dello Jedi","movie",1983],["film_cult","Terminator 2","movie",1991],
  ["film_cult","Alien","movie",1979],["film_cult","Top Gun: Maverick","movie",2022],
  ["film_cult","Oppenheimer","movie",2023],["film_cult","Barbie","movie",2023],["film_cult","Dune","movie",2021],
  ["film_cult","Toy Story","movie",1995],["film_cult","Inside Out","movie",2015],
  ["film_cult","Il lupo di Wall Street","movie",2013],["film_cult","C'era una volta a... Hollywood","movie",2019],
  ["film_cult","Kill Bill: Volume 1","movie",2003],["film_cult","Rocky","movie",1976],
  ["film_cult","Mamma, ho perso l'aereo","movie",1990],["film_cult","Il diavolo veste Prada","movie",2006],
];

async function tmdb(type, q, year) {
  const u = `https://api.themoviedb.org/3/search/${type}?api_key=${KEY}&language=it-IT&query=${encodeURIComponent(q)}${year ? (type === "tv" ? `&first_air_date_year=${year}` : `&year=${year}`) : ""}`;
  const r = await fetch(u); if (!r.ok) return null;
  const j = await r.json(); return (j.results || [])[0] || null;
}

(async () => {
  // catalog map type:tmdb -> id
  const snap = await db.collection("titles").get();
  const cat = new Map();
  snap.forEach((d) => { const t = d.data() || {}; if (t.tmdbId) { const k = `${(t.type || "").toLowerCase()}:${t.tmdbId}`; if (!cat.has(k)) cat.set(k, { id: d.id, slug: t.slug || "" }); } });
  // covered set
  const meta = (await db.collection("quizMeta").doc("themes").get()).data() || {};
  const coveredIds = new Set((meta.themes || []).map((x) => x.titleId));
  // covered tmdb (read covered docs)
  const coveredTmdb = new Set();
  const ids = [...coveredIds];
  for (let i = 0; i < ids.length; i += 200) {
    const refs = ids.slice(i, i + 200).map((id) => db.collection("titles").doc(id));
    const docs = await db.getAll(...refs);
    docs.forEach((d) => { const t = d.data() || {}; if (t.tmdbId) coveredTmdb.add(`${(t.type || "").toLowerCase()}:${t.tmdbId}`); });
  }

  const kept = [], skipped = [], missed = [];
  for (const [cluster, q, type, year] of CAND) {
    const res = await tmdb(type, q, year);
    if (!res) { missed.push(q); continue; }
    const tmdbId = String(res.id);
    const key = `${type}:${tmdbId}`;
    const inCat = cat.get(key);
    const titleId = inCat ? inCat.id : `tmdb_${type}_${tmdbId}`;
    if (coveredIds.has(titleId) || coveredTmdb.has(key)) { skipped.push(`${q} (già coperto)`); continue; }
    kept.push({
      cluster, title: q, mediaType: type, tmdbId,
      tmdbName: res.title || res.name, tmdbYear: (res.release_date || res.first_air_date || "").slice(0, 4),
      titleId, inCatalog: !!inCat, needsTmdbImport: !inCat, targetQuestions: 50, status: "beta_pending_review",
    });
  }
  fs.writeFileSync(path.resolve(__dirname, "../../quiz_beta/quiz_wave2_titles.json"), JSON.stringify(kept, null, 2));
  const byC = {}; kept.forEach((k) => byC[k.cluster] = (byC[k.cluster] || 0) + 1);
  console.log("kept:", kept.length, "| skipped(covered):", skipped.length, "| tmdb-missed:", missed.length);
  console.log("cluster:", JSON.stringify(byC));
  console.log("need import:", kept.filter((k) => k.needsTmdbImport).length);
  if (skipped.length) console.log("skipped:", skipped.join(", "));
  if (missed.length) console.log("missed:", missed.join(", "));
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
