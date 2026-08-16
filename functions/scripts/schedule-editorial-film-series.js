#!/usr/bin/env node
/**
 * schedule-editorial-film-series.js — programma la serie editoriale di 3 post
 * "film per categoria" (luglio 2026) sul sistema aggiornamenti ufficiali.
 *
 * Non introduce nulla di nuovo: crea 3 BOZZE `officialUpdates/{slug}` con
 * `scheduledAt`, e le pubblica lo scheduler `publishScheduledOfficialUpdates`
 * (gen2, ogni 15 min) riusando `publishOfficialUpdate`. Un post al giorno,
 * stessa ora.
 *
 * Ogni post tagga i film con `#[Nome](titleDocId)`:
 *   - web  → link alla scheda + poster del primo titolo come immagine della card
 *   - iOS  → collage delle locandine dei titoli taggati (MultiTitleCollageView)
 * I poster arrivano da `titles/{id}.posterPath` (TMDB), nessuna immagine esterna.
 *
 * Uso (dry-run di default):
 *   cd functions
 *   node scripts/schedule-editorial-film-series.js
 *   node scripts/schedule-editorial-film-series.js --write
 *   node scripts/schedule-editorial-film-series.js --write --start 2026-07-29T10:00:00+02:00
 */

const admin = require("firebase-admin");
const { publishOfficialUpdate } = require("../lib/officialUpdates");

const PROJECT_ID = "gia-visto";
const BLOG_BASE = "https://somto.it/blog";
// Prima uscita: 29/07/2026 alle 19:00 di Roma (CEST = UTC+2), poi +1 giorno.
const DEFAULT_START_ISO = "2026-07-29T19:00:00+02:00";
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_POST_TEXT = 1000; // tetto rules su posts.text

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i++;
  }
  return out;
}

function tagsBlock(films) {
  return films.map((f) => `#[${f.label}](${f.id})`).join("\n");
}

const SERIES = [
  {
    slug: "film-che-fanno-riflettere",
    title: "Film che fanno riflettere: 6 titoli che restano",
    summary: "Sei film che quando finiscono ti lasciano una domanda aperta. Qual e' quello che ti ha cambiato di piu' il modo di vedere qualcosa?",
    films: [
      { id: "tmdb_movie_37165", label: "The Truman Show" },
      { id: "tmdb_movie_5915", label: "Into the Wild" },
      { id: "tmdb_movie_87827", label: "Vita di Pi" },
      { id: "tmdb_movie_13", label: "Forrest Gump" },
      { id: "fly-me-to-the-moon-2024-movie", label: "Fly Me to the Moon" },
      { id: "tmdb_movie_423", label: "Il pianista" },
    ],
    intro: "Ecco sei film che è davvero difficile dimenticare. Sono diversissimi tra loro, ma tutti ti lasciano una domanda aperta invece di una risposta.",
    question: "Qual è il film che ti ha cambiato di più il modo di vedere qualcosa? Vale anche se non è in questa lista.",
    ctaLabel: "L'articolo completo, con un commento per ogni film",
  },
  {
    slug: "film-sullo-spazio",
    title: "Film sullo spazio: 6 storie tra scienza ed esplorazione",
    summary: "Sei film tra esplorazione, scienza e sopravvivenza. Preferisci le storie spaziali piu' scientifiche o quelle piu' filosofiche?",
    films: [
      { id: "UzqvbouvIY6XWxoLFOru", label: "Interstellar" },
      { id: "ZzxamV8XXDxzakvwjFuU", label: "The Martian" },
      { id: "tmdb_movie_568", label: "Apollo 13" },
      { id: "tmdb_movie_381284", label: "Il diritto di contare" },
      { id: "tmdb_movie_687163", label: "Project Hail Mary" },
      { id: "tmdb_movie_13466", label: "Cielo d'ottobre" },
    ],
    intro: "Sei film sullo spazio, con un'idea larga di spazio: ci sono gli astronauti, e c'è anche chi faceva i calcoli a mano, chi montava razzi in cortile e chi da una sala controllo doveva inventarsi una soluzione in poche ore.",
    question: "Preferisci le storie spaziali più scientifiche o quelle più filosofiche?",
    ctaLabel: "Qui li trovi spiegati uno per uno",
  },
  {
    slug: "film-imprenditoria-business",
    title: "Imprenditoria e business: 7 film tra luci e ombre",
    summary: "Sette film su come nascono le aziende e su cosa costano. Quale racconta meglio il confine tra ambizione e ossessione?",
    films: [
      { id: "tmdb_movie_37799", label: "The Social Network" },
      { id: "tmdb_movie_310307", label: "The Founder" },
      { id: "tmdb_movie_60308", label: "Moneyball - L'arte di vincere" },
      { id: "tmdb_movie_115782", label: "Jobs" },
      { id: "tmdb_movie_321697", label: "Steve Jobs" },
      { id: "tmdb_movie_3293", label: "I pirati di Silicon Valley" },
      { id: "tmdb_movie_106646", label: "The Wolf of Wall Street" },
    ],
    intro: "Sette film su come nascono le aziende e su cosa succede a chi le fonda. C'è la visione e c'è il conto da pagare: The Wolf of Wall Street chiude la lista come ritratto dell'eccesso.",
    question: "Quale di questi racconta meglio il confine tra ambizione e ossessione?",
    ctaLabel: "L'articolo completo",
  },
];

function buildText(entry) {
  const blogUrl = `${BLOG_BASE}/${entry.slug}/`;
  return [
    entry.intro,
    "",
    tagsBlock(entry.films),
    "",
    entry.question,
    "",
    `${entry.ctaLabel}: ${blogUrl}`,
  ].join("\n");
}

async function assertTitlesExist(db, entry) {
  const refs = entry.films.map((f) => db.collection("titles").doc(f.id));
  const snaps = await db.getAll(...refs);
  const missing = [];
  snaps.forEach((snap, i) => {
    const data = snap.exists ? snap.data() || {} : null;
    if (!data) missing.push(`${entry.films[i].label} (${entry.films[i].id}) — doc inesistente`);
    else if (data.status !== "approved") missing.push(`${entry.films[i].label} — status ${data.status}`);
  });
  if (missing.length) {
    throw new Error(`[${entry.slug}] titoli non utilizzabili:\n  - ${missing.join("\n  - ")}`);
  }
  return snaps.map((snap) => snap.data());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const write = args.write === true;
  const startIso = String(args.start || DEFAULT_START_ISO);
  const startMs = Date.parse(startIso);
  if (!Number.isFinite(startMs)) throw new Error(`--start non valido: ${startIso}`);

  admin.initializeApp({ projectId: PROJECT_ID });
  const db = admin.firestore();

  for (let i = 0; i < SERIES.length; i++) {
    const entry = SERIES[i];
    const text = buildText(entry);
    const scheduledAt = new Date(startMs + i * DAY_MS);

    if (text.length > MAX_POST_TEXT) {
      throw new Error(`[${entry.slug}] testo ${text.length} char > ${MAX_POST_TEXT}`);
    }
    const titles = await assertTitlesExist(db, entry);

    console.log("─".repeat(72));
    console.log(`${entry.slug}  →  ${scheduledAt.toISOString()}  (${text.length} char)`);
    console.log(`poster card: ${titles[0]?.name} — ${titles[0]?.posterPath ? "ok" : "MANCANTE"}`);
    console.log(text);

    if (!write) continue;

    const result = await publishOfficialUpdate({
      db,
      admin,
      requestedByUid: "editorial-script",
      input: {
        slug: entry.slug,
        title: entry.title,
        text,
        summary: entry.summary,
        updateType: "announcement",
        status: "draft",
        scheduledAt: scheduledAt.toISOString(),
        linkedTitleIds: entry.films.map((f) => f.id),
        sourceUrls: [`${BLOG_BASE}/${entry.slug}/`],
      },
    });
    console.log(`→ bozza salvata: officialUpdates/${result.slug}`);
  }

  console.log("─".repeat(72));
  if (!write) {
    console.log("DRY RUN — rilancia con --write per creare le 3 bozze programmate.");
  } else {
    console.log("3 bozze programmate. Le pubblica publishScheduledOfficialUpdates (ogni 15 min).");
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("ERRORE:", err?.message || err);
  process.exit(1);
});
