// Prova end-to-end del modulo vero (sola lettura: il db e' un finto).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const admin = require("firebase-admin");
const { queryWikidata, filterByAvailability } = require("./lib/wikidataStreamingLinks.js");

process.env.STREAMING_DEEPLINKS_ENABLED = "true";
const { resolveDeepLinksForTitle } = require("./modules/streamingLinks.js");

admin.initializeApp({ projectId: "gia-visto" });
const real = admin.firestore();

// Db finto: legge niente, e registra cosa SCRIVEREBBE. Su prod non si tocca
// niente finche' non lo decide Paolo.
const scritture = [];
const fakeDb = {
  collection: (name) => ({
    doc: (id) => ({
      set: async (data) => { scritture.push({ collection: name, id, data }); },
      get: async () => ({ exists: false, data: () => null }),
    }),
  }),
};

const CAMPIONE = [
  ["Breaking Bad", "tv", 1396, ["Netflix"]],
  ["The Mandalorian", "tv", 82856, ["Disney Plus"]],
  ["Ted Lasso", "tv", 97546, ["Apple TV"]],
  ["The Last of Us", "tv", 100088, ["HBO Max"]],
  ["The Boys", "tv", 76479, ["Amazon Prime Video"]],
  ["Star Trek: Strange New Worlds", "tv", 103516, ["Paramount Plus"]],
  ["Soul", "movie", 508442, ["Disney Plus"]],
  ["Dune", "movie", 438631, ["Netflix", "HBO Max"]],
];

console.log("=== RISOLUZIONE (modulo vero, scritture intercettate) ===\n");
const esiti = [];
for (const [nome, tipo, tmdbId, provider] of CAMPIONE) {
  const links = await resolveDeepLinksForTitle({
    db: fakeDb,
    titleId: `test_${tmdbId}`,
    tmdbId,
    mediaType: tipo,
    availableProviders: provider,
    cached: null,
  });
  const voci = Object.entries(links);
  console.log(`${nome} (${provider.join(", ")})`);
  if (!voci.length) console.log("  nessun link diretto");
  for (const [p, url] of voci) console.log(`  ${p.padEnd(20)} ${url}`);
  esiti.push({ nome, provider: provider[0], link: voci[0]?.[1] || null });
  await new Promise((r) => setTimeout(r, 2500));
}

console.log("\n=== GLI URL RISPONDONO? ===");
for (const e of esiti.filter((x) => x.link)) {
  try {
    const res = await fetch(e.link, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" },
      signal: AbortSignal.timeout(20000),
    });
    console.log(`${res.status}  ${e.nome.slice(0, 26).padEnd(28)} ${e.link}`);
  } catch (err) {
    console.log(`ERR  ${e.nome.padEnd(28)} ${String(err.message).slice(0, 40)}`);
  }
}

console.log("\n=== COSA AVREBBE SCRITTO ===");
for (const s of scritture.slice(0, 4)) {
  console.log(`${s.collection}/${s.id}: ${JSON.stringify(s.data).slice(0, 150)}`);
}
console.log(`(totale scritture intercettate: ${scritture.length}, su prod: nessuna)`);
await real.terminate();
