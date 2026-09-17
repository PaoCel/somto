#!/usr/bin/env node
// Routine editoriale locale: la parte deterministica.
//
// PERCHE' E' SPACCATA IN DUE — il ragionamento non sta qui dentro. Questo
// script prepara il lavoro (`--emit`) e scrive i risultati (`--apply`); a
// pensarci in mezzo e' una sessione Claude schedulata nell'app, che usa
// l'abbonamento di Paolo: niente API key da pagare e niente login separato
// della CLI.
//
// Il vantaggio non e' solo di autenticazione: cosi' i controlli stanno in un
// file di codice con dei test, non dentro un prompt. Il modello propone,
// questo script verifica, e solo dopo si scrive.
//
// Due lavori, indipendenti:
//
//  1. la coda dello scanner YouTube: i video di cui non abbiamo riconosciuto
//     il titolo. Sono nomi scritti come li scrive il canale ("Percy Jackson e
//     gli Dei dell'Olimpo") contro nomi come li ha il catalogo. I candidati li
//     cerchiamo noi: al modello resta di scegliere, non di inventare un id.
//  2. il copy dei post sulle uscite, nella voce di Paolo. Oggi il template
//     scrive "Lo aspettavi?" su ogni singolo post.
//
// Nessuno dei due e' bloccante: se la routine non gira, il cloud pubblica il
// template come sempre e i video non riconosciuti restano in coda.
//
// Uso:
//   node scripts/editorial-routine.mjs --emit                 # cosa c'e' da fare
//   node scripts/editorial-routine.mjs --emit --force         # anche sotto soglia
//   node scripts/editorial-routine.mjs --apply risposte.json  # verifica e scrive
//   node scripts/editorial-routine.mjs --apply r.json --dry-run

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const admin = require(join(ROOT, "functions/node_modules/firebase-admin"));
const { writeTitleUpdateEvents } = require(join(ROOT, "functions/lib/titleUpdateEvents"));
const {
  buildYouTubeVideoCandidate,
  parseYouTubeVideoTitle,
} = require(join(ROOT, "functions/lib/youtubeTrailers"));
const {
  buildReleaseConversationInput,
  providerName,
  DEFAULT_LOOKAHEAD_MS: PUBLISH_WINDOW_MS,
} = require(join(ROOT, "functions/lib/releaseConversationPosts"));

const PROJECT_ID = "gia-visto";
const STATE_PATH = "systemJobs/editorialRoutine";
const YOUTUBE_STATE_PATH = "systemJobs/youtubeTrailerScanner";

const DAY_MS = 24 * 60 * 60 * 1000;
// Piu' larga della finestra della sync cloud (45 giorni) di proposito: il copy
// deve essere pronto PRIMA che l'uscita entri in finestra, se no il post nasce
// col template e poi cambia testo sotto gli occhi di chi l'ha gia' letto.
const COPY_LOOKAHEAD_MS = 60 * DAY_MS;
const QUEUE_LIMIT = 12;
const COPY_LIMIT = 8;
const MAX_HANDLED_IDS = 400;
const MIN_MATCH_CONFIDENCE = 0.7;

// Soglie di lotto: sotto queste, `--emit` non consegna niente e la sessione
// schedulata chiude senza lavorare.
//
// PERCHE' — la sessione costa uguale che ci siano due righe o dieci, e due
// righe non valgono il giro: la coda non scade (100 slot, le nuove davanti,
// vedi `mergePendingRows`) quindi rimandare non perde niente. Override per un
// giro singolo: SOMTO_EDITORIAL_MIN_QUEUE / SOMTO_EDITORIAL_MIN_COPY, oppure
// --force per ignorarle del tutto.
const QUEUE_MIN_BATCH = Number(process.env.SOMTO_EDITORIAL_MIN_QUEUE || 5);
const COPY_MIN_BATCH = Number(process.env.SOMTO_EDITORIAL_MIN_COPY || 3);

const ROME_DATE = new Intl.DateTimeFormat("it-IT", {
  timeZone: "Europe/Rome",
  day: "numeric",
  month: "long",
});

function safeText(value, max = 240) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
}

function toMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value?.toMillis === "function") return value.toMillis();
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeForSearch(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Lettura: cosa c'e' da fare
// ---------------------------------------------------------------------------

// Parole che in un titolo non distinguono niente: pescano mezzo catalogo e
// lasciano fuori quella che conta. "Dune - Parte Tre" cercato per "parte"
// restituisce Barbie e Twilight, mai Dune.
const WEAK_TOKENS = new Set([
  "parte", "part", "stagione", "season", "serie", "series", "film", "movie",
  "trailer", "teaser", "ufficiale", "official", "the", "and", "con", "per",
  "del", "della", "dei", "delle", "dal", "dalla", "una", "uno", "gli", "che",
  "primo", "prima", "secondo", "seconda", "terzo", "terza",
]);

/**
 * Candidati di catalogo per un nome. Si cerca per token e non per nome esatto:
 * e' esattamente il match esatto ad aver fallito nel cloud.
 *
 * PERCHE' NON SI ORDINA PER POPOLARITA': i trailer parlano di roba che deve
 * ancora uscire, e un titolo non uscito ha ratingCount 0. Ordinare per
 * ratingCount e tagliare a 10 escludeva sistematicamente proprio i titoli che
 * la coda contiene. Si ordina invece per quanto il nome somiglia, che e' la
 * domanda vera.
 *
 * `search.tokens` contiene anche le keyword TMDB e le parole della trama: un
 * token generico pesca rumore (Encanto sotto "nascosta"). Per questo il
 * punteggio si calcola solo sui token del nome, non su quelli indicizzati.
 *
 * La stessa funzione serve due volte — quando si prepara la domanda e quando
 * si verifica la risposta — proprio perche' l'insieme delle scelte legittime
 * va ricalcolato, non riletto da un file che nel frattempo puo' essere
 * cambiato.
 */
async function catalogCandidatesFor(db, name) {
  const queryTokens = normalizeForSearch(name).filter((token) => token.length >= 3);
  if (!queryTokens.length) return [];

  // Piu' di un needle, perche' nessun singolo token e' affidabile: "dune" e'
  // corto ma raro, "filosofale" e' lungo e raro, "parte" e' lungo e inutile.
  const needles = [...new Set(queryTokens)]
    .filter((token) => !WEAK_TOKENS.has(token))
    .sort((a, b) => b.length - a.length)
    .slice(0, 3);
  if (!needles.length) needles.push(queryTokens[0]);

  const found = new Map();
  for (const needle of needles) {
    const snap = await db.collection("titles")
      .where("search.tokens", "array-contains", needle)
      .limit(40)
      .get();
    for (const doc of snap.docs) {
      if (!found.has(doc.id)) found.set(doc.id, { id: doc.id, ...doc.data() });
    }
  }

  const wanted = new Set(queryTokens);
  return [...found.values()]
    .filter((row) => row.status === "approved")
    .map((row) => {
      const nameTokens = new Set([
        ...normalizeForSearch(row.name),
        ...normalizeForSearch(row.originalName),
      ]);
      let hit = 0;
      for (const token of wanted) if (nameTokens.has(token)) hit += 1;
      return { row, score: hit / wanted.size };
    })
    // Zero parole in comune col nome vuol dire che il match veniva dalla trama:
    // e' rumore, e in coda costa un giro di revisione per niente.
    .filter((entry) => entry.score > 0)
    .sort((a, b) =>
      b.score - a.score ||
      (b.row.year || 0) - (a.row.year || 0) ||
      (b.row.ratingCount || 0) - (a.row.ratingCount || 0))
    .slice(0, 10)
    .map(({ row }) => ({
      titleId: row.id,
      name: safeText(row.name, 120),
      originalName: safeText(row.originalName, 120),
      type: row.type,
      year: row.year || null,
      tmdbId: row.tmdbId ?? row.meta?.tmdbId ?? null,
      providers: (row.watchProviderNames || []).slice(0, 3),
    }))
    .filter((row) => row.tmdbId);
}

/**
 * I nomi su cui cercare i candidati per una riga di coda.
 *
 * PERCHE' PIU' DI UNO — "South America | Trailer ufficiale | Paramount+ |
 * South Park s29": il nome parsato e' quello dell'episodio, la serie sta nel
 * segmento con la stagione. Le righe finite in coda prima del fix dello
 * scanner non hanno `altNames`, quindi si riparsa anche il titolo del video:
 * cosi' la coda vecchia si sblocca senza aspettare un nuovo giro.
 */
function queueRowNames(row) {
  const fromScanner = Array.isArray(row?.altNames) ? row.altNames : [];
  const fromTitle = parseYouTubeVideoTitle(row?.videoTitle || "")?.altNames || [];
  const out = [];
  const seen = new Set();
  for (const name of [row?.parsedName, ...fromScanner, ...fromTitle]) {
    const clean = safeText(name, 200);
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

/**
 * Il titolo che si chiama ESATTAMENTE cosi', se c'e'.
 *
 * PERCHE' SERVE — la ricerca per token prende 40 documenti per needle senza
 * ordinarli: con parole comuni ("south", "park") i 40 sono altri titoli e il
 * titolo giusto non compare mai fra i candidati, per quanto sia ovvio. Il
 * lookup esatto su `nameLower` usa l'indice status+nameLower e costa una
 * lettura: va messo davanti, non al posto, della ricerca per token.
 */
async function exactNameCandidates(db, name) {
  const needle = safeText(name, 200).toLowerCase();
  if (!needle) return [];
  const snap = await db.collection("titles")
    .where("status", "==", "approved")
    .where("nameLower", "==", needle)
    .limit(5)
    .get();
  return snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .map((row) => ({
      titleId: row.id,
      name: safeText(row.name, 120),
      originalName: safeText(row.originalName, 120),
      type: row.type,
      year: row.year || null,
      tmdbId: row.tmdbId ?? row.meta?.tmdbId ?? null,
      providers: (row.watchProviderNames || []).slice(0, 3),
    }))
    .filter((row) => row.tmdbId);
}

/** L'unione dei candidati dei vari nomi, senza doppioni. */
async function catalogCandidatesForRow(db, row) {
  const found = new Map();
  const names = queueRowNames(row);
  for (const name of names) {
    for (const candidate of await exactNameCandidates(db, name)) {
      if (!found.has(candidate.titleId)) found.set(candidate.titleId, candidate);
    }
  }
  for (const name of names) {
    for (const candidate of await catalogCandidatesFor(db, name)) {
      if (!found.has(candidate.titleId)) found.set(candidate.titleId, candidate);
    }
  }
  return [...found.values()].slice(0, 14);
}

async function collectQueueWork({ db, state }) {
  const snap = await db.doc(YOUTUBE_STATE_PATH).get();
  const pending = Array.isArray(snap.data()?.pending) ? snap.data().pending : [];
  const handled = new Set(state.handledVideoIds || []);
  const todo = pending.filter((row) => row?.videoId && !handled.has(row.videoId)).slice(0, QUEUE_LIMIT);

  const rows = [];
  for (const row of todo) {
    rows.push({
      videoId: row.videoId,
      videoTitle: row.videoTitle,
      parsedName: row.parsedName,
      season: row.season || null,
      platform: row.platform || row.channel || null,
      candidates: await catalogCandidatesForRow(db, row),
    });
  }
  return rows;
}

/**
 * Il copy serve solo dove un post uscira' davvero.
 *
 * PERCHE' — il publisher scarta piu' eventi di quanti ne scarti questa query:
 * niente provider italiano su un `new_episode`, regione diversa da IT o
 * `releaseType` da saltare su un film, `sourceTrust: "unverified"`. Senza
 * questo filtro la routine chiedeva di scrivere post che poi non venivano
 * pubblicati: lavoro editoriale buttato, e otto slot di `COPY_LIMIT` occupati
 * da eventi morti al posto di uscite vere.
 *
 * Si chiama la funzione del publisher invece di ricopiarne le condizioni,
 * cosi' le due parti non possono divergere. L'unica differenza voluta e' la
 * finestra temporale: qui si guarda 60 giorni avanti contro i 45 della sync,
 * perche' il copy deve essere pronto PRIMA che l'uscita entri in finestra. Per
 * neutralizzarla si passa come `nowMs` la data dell'evento stesso, che rende
 * vero il solo controllo di finestra e lascia intatti tutti gli altri.
 */
function willPublish({ eventId, event, title, effectiveAtMs }) {
  return Boolean(buildReleaseConversationInput({
    eventId,
    event,
    title,
    nowMs: effectiveAtMs,
  }));
}

async function collectCopyWork({ db, nowMs }) {
  const start = admin.firestore.Timestamp.fromMillis(nowMs);
  const end = admin.firestore.Timestamp.fromMillis(nowMs + COPY_LOOKAHEAD_MS);
  const base = (eventType) => db.collection("titleUpdateEvents")
    .where("eventType", "==", eventType)
    .where("status", "==", "published");

  const [releases, premieres] = await Promise.all([
    base("release_date").where("effectiveAt", ">=", start).where("effectiveAt", "<=", end)
      .orderBy("effectiveAt", "asc").limit(40).get(),
    base("new_episode").where("episode", "==", 1)
      .where("effectiveAt", ">=", start).where("effectiveAt", "<=", end)
      .orderBy("effectiveAt", "asc").limit(40).get(),
  ]);

  const events = [...releases.docs, ...premieres.docs]
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((event) => !event.editorialCopy?.text && !event.reviewReason);

  const out = [];
  for (const event of events) {
    if (out.length >= COPY_LIMIT) break;
    const titleSnap = await db.collection("titles").doc(String(event.titleId)).get();
    const title = titleSnap.exists ? titleSnap.data() : null;
    if (!title || title.status !== "approved" || !title.name) continue;
    const effectiveAtMs = toMillis(event.effectiveAt);
    if (!Number.isFinite(effectiveAtMs)) continue;
    if (!willPublish({ eventId: event.id, event, title, effectiveAtMs })) continue;
    out.push({
      eventId: event.id,
      titleId: event.titleId,
      name: title.name,
      type: title.type,
      season: event.eventType === "new_episode" ? Math.floor(Number(event.season)) || null : null,
      date: ROME_DATE.format(new Date(effectiveAtMs)),
      // La stessa funzione del publisher: cosi' il nome della piattaforma
      // mostrato qui e' quello che finira' nel post, non un primo elemento
      // dell'array che il publisher scarterebbe.
      platform: providerName(title) || null,
      genres: (title.genres || []).slice(0, 4),
      year: title.year || null,
      kind: event.eventType,
      // Interno, tolto prima di consegnare: serve solo a capire se l'uscita e'
      // gia' dentro la finestra di pubblicazione e quindi non e' rimandabile.
      effectiveAtMs,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scrittura: le risposte, verificate
// ---------------------------------------------------------------------------

async function applyQueue({ db, answers, state, dryRun }) {
  const snap = await db.doc(YOUTUBE_STATE_PATH).get();
  const pending = Array.isArray(snap.data()?.pending) ? snap.data().pending : [];
  const byVideo = new Map(pending.map((row) => [row.videoId, row]));
  const handled = new Set(state.handledVideoIds || []);

  const candidates = [];
  const report = { seen: 0, matched: 0, created: 0, updated: 0, skipped: [] };
  for (const answer of Array.isArray(answers) ? answers : []) {
    const videoId = safeText(answer?.videoId, 40);
    const raw = byVideo.get(videoId);
    if (!raw) continue;
    report.seen += 1;
    // Anche un "non lo so" e' una risposta: senza questo la stessa riga
    // tornerebbe a ogni giro e la si riguarderebbe all'infinito.
    handled.add(videoId);

    const titleId = safeText(answer?.titleId, 160);
    const confidence = Number(answer?.confidence);
    if (!titleId || !(confidence >= MIN_MATCH_CONFIDENCE)) {
      report.skipped.push({ videoId, name: raw.parsedName, why: "nessun aggancio o confidenza bassa" });
      continue;
    }
    // Ricalcolati, non riletti: un id fuori da questo insieme non e' una
    // scelta ma un'invenzione, e non deve poter arrivare in scheda.
    const allowed = await catalogCandidatesForRow(db, raw);
    const chosen = allowed.find((row) => row.titleId === titleId);
    if (!chosen) {
      report.skipped.push({ videoId, name: raw.parsedName, why: `titleId fuori dai candidati: ${titleId}` });
      continue;
    }

    const candidate = buildYouTubeVideoCandidate({
      video: { videoId: raw.videoId, title: raw.videoTitle, publishedAt: raw.publishedAt },
      title: { id: chosen.titleId, type: chosen.type, tmdbId: chosen.tmdbId },
      channel: { key: raw.channel, platform: raw.platform },
      parsed: {
        name: raw.parsedName,
        season: raw.season || null,
        kind: raw.kind === "teaser" ? "teaser" : "trailer",
      },
    });
    if (!candidate) {
      report.skipped.push({ videoId, name: raw.parsedName, why: "candidato non costruibile" });
      continue;
    }
    report.matched += 1;
    candidates.push(candidate);
  }

  if (!dryRun && candidates.length) {
    // Backfill: video gia' usciti, riconosciuti in ritardo. Vanno in scheda,
    // non svegliano nessuno.
    const written = await writeTitleUpdateEvents({
      db,
      candidates,
      acquisitionMode: "backfill",
      publishEligible: true,
      now: new Date(),
      maxEvents: 50,
    });
    report.created = written.created;
    report.updated = written.updated;
  }
  // La coda si svuota di cio' che e' stato guardato: se no le righe vecchie
  // restano li' e, a coda piena, spingono fuori quelle nuove. Transazione
  // perche' lo scanner ci scrive dentro ogni mezz'ora.
  if (!dryRun && report.seen) {
    const treated = new Set([...handled]);
    await db.runTransaction(async (tx) => {
      const ref = db.doc(YOUTUBE_STATE_PATH);
      const snap = await tx.get(ref);
      const rows = Array.isArray(snap.data()?.pending) ? snap.data().pending : [];
      tx.set(ref, { pending: rows.filter((row) => !treated.has(row?.videoId)) }, { merge: true });
    });
  }
  return { report, handled: [...handled].slice(-MAX_HANDLED_IDS) };
}

async function applyCopy({ db, answers, dryRun }) {
  const report = { seen: 0, written: 0, skipped: [] };
  for (const answer of Array.isArray(answers) ? answers : []) {
    const eventId = safeText(answer?.eventId, 240);
    if (!eventId) continue;
    report.seen += 1;

    const eventSnap = await db.collection("titleUpdateEvents").doc(eventId).get();
    const event = eventSnap.exists ? eventSnap.data() : null;
    const effectiveAtMs = event ? toMillis(event.effectiveAt) : null;
    if (!event || !Number.isFinite(effectiveAtMs)) {
      report.skipped.push({ eventId, why: "evento inesistente" });
      continue;
    }
    const date = ROME_DATE.format(new Date(effectiveAtMs));
    const title = safeText(answer?.title, 120);
    const text = String(answer?.text || "").trim().slice(0, 1200);
    // Prima rete. La seconda, identica, la rifa' il cloud in
    // `pickConversationCopy` prima di pubblicare: cosi' un copy sbagliato non
    // esce nemmeno se qualcuno lo mettesse in database a mano.
    if (!title || !text) {
      report.skipped.push({ eventId, why: "titolo o testo vuoto" });
      continue;
    }
    if (!text.includes(date)) {
      report.skipped.push({ eventId, why: `il testo non contiene la data "${date}"` });
      continue;
    }

    if (!dryRun) {
      await db.collection("titleUpdateEvents").doc(eventId).set({
        editorialCopy: {
          title,
          text,
          summary: safeText(answer?.summary, 240),
          sources: (Array.isArray(answer?.sources) ? answer.sources : [])
            .map((url) => safeText(url, 600)).filter(Boolean).slice(0, 4),
          generatedAt: admin.firestore.FieldValue.serverTimestamp(),
          generatedBy: "editorial-routine",
        },
      }, { merge: true });
    }
    report.written += 1;
  }
  return report;
}

// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const emit = argv.includes("--emit");
  const force = argv.includes("--force");
  const applyIndex = argv.indexOf("--apply");
  const probeIndex = argv.indexOf("--probe");
  if (!emit && applyIndex < 0 && probeIndex < 0) {
    console.error("uso: --emit  oppure  --apply <file.json> [--dry-run]  oppure  --probe \"<nome>\"");
    process.exit(2);
  }

  admin.initializeApp({ projectId: PROJECT_ID });
  const db = admin.firestore();

  // Diagnostica: che candidati escono per un nome (o per un titolo YouTube
  // intero), senza toccare la coda. Passa dalla stessa funzione della coda, se
  // no il probe risponde a una domanda diversa da quella che conta.
  if (probeIndex >= 0) {
    const probe = argv[probeIndex + 1] || "";
    const row = { parsedName: parseYouTubeVideoTitle(probe)?.name || probe, videoTitle: probe };
    console.log(JSON.stringify(await catalogCandidatesForRow(db, row), null, 1));
    process.exit(0);
  }
  const nowMs = Date.now();
  const stateRef = db.doc(STATE_PATH);
  const state = (await stateRef.get()).data() || {};

  if (emit) {
    const [queueAll, copyAll] = await Promise.all([
      collectQueueWork({ db, state }),
      collectCopyWork({ db, nowMs }),
    ]);

    // Un'uscita gia' dentro la finestra del publisher non si rimanda: al giro
    // dopo il post e' gia' uscito col template, e il testo non si riscrive
    // sotto gli occhi di chi l'ha letto.
    const urgent = (row) => row.effectiveAtMs <= nowMs + PUBLISH_WINDOW_MS;
    const copyUrgent = copyAll.filter(urgent);
    const strip = (row) => { const { effectiveAtMs, ...rest } = row; return rest; };

    const queueOk = force || queueAll.length >= QUEUE_MIN_BATCH;
    const copyOk = force || copyAll.length >= COPY_MIN_BATCH || copyUrgent.length > 0;

    const queue = queueOk ? queueAll : [];
    const copy = copyOk ? copyAll.map(strip) : [];
    // Se il copy passa per urgenza si consegna tutto il lotto: il costo e' la
    // sessione, non la singola riga, e una volta svegliata tanto vale
    // sfruttarla.
    const held = {
      queue: queueOk ? 0 : queueAll.length,
      copy: copyOk ? 0 : copyAll.length,
      soglie: { queue: QUEUE_MIN_BATCH, copy: COPY_MIN_BATCH },
    };
    console.log(JSON.stringify(
      held.queue || held.copy ? { queue, copy, held } : { queue, copy },
      null,
      1,
    ));
    process.exit(0);
  }

  const path = argv[applyIndex + 1];
  if (!path) {
    console.error("--apply vuole il percorso del file di risposte");
    process.exit(2);
  }
  const answers = JSON.parse(readFileSync(path, "utf8"));

  const queueResult = await applyQueue({ db, answers: answers.queue, state, dryRun });
  const copyReport = await applyCopy({ db, answers: answers.copy, dryRun });

  if (!dryRun) {
    await stateRef.set({
      handledVideoIds: queueResult.handled,
      lastRunAtMs: nowMs,
      lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  console.log(JSON.stringify({ dryRun, coda: queueResult.report, copy: copyReport }, null, 1));
  process.exit(0);
}

main().catch((err) => {
  console.error(`[editorial-routine] ${String(err?.message || err).slice(0, 400)}`);
  process.exit(1);
});
