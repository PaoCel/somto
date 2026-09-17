#!/usr/bin/env node
/**
 * rematch-import-unresolved.js
 *
 * Riprova il matching sugli item NON risolti (`resolved:false`, `skip:false`)
 * di un import titoli gia' esistente (`users/{uid}/imports/{importId}`).
 * Motivo: `altNamesLower` e' stato backfillato (backfill-title-altnames.js)
 * DOPO che alcuni import sono stati eseguiti/confermati -> molte righe che
 * allora fallivano tutta la cascata (matchExact/matchNormalizedVariant, poi
 * TMDB search fallback a bassa confidenza) ora matcherebbero deterministicamente
 * via matchAltNamesLower.
 *
 * Mima il percorso di `confirmTitlesImport` (functions/index.js): stessa
 * scrittura di titleStates (buildImportTitleStateWrites, merge non
 * distruttivo max-progress, mai regressioni), stesse proiezioni
 * library/watchlist, stesso update dei contatori import (matchedCount/
 * unresolvedCount) e stessa transizione di status verso "completed" quando
 * l'unresolvedCount arriva a 0. UNICA divergenza voluta da confirmTitlesImport:
 * gli item `watchlistOnly:true` (righe TV Time "follow"/is_for_later, nessun
 * segnale di visione) ricevono `toggle_watchlist` come in finalizeImportResults,
 * NON mark_seen/set_progress — confirmTitlesImport ha un gap noto qui (droppa
 * item.watchlistOnly), che questo script NON replica.
 *
 * ATTENZIONE DRY-RUN — NON usa resolveTitleMatch/matchViaTmdb/matchViaTvdbId
 * di functions/lib/importAdapters/matching.js direttamente: quelle funzioni
 * chiamano upsertTmdbTitle (write Firestore + upload Storage) in modo
 * INCONDIZIONATO ogni volta che un risultato TMDB arriva a HIGH_CONFIDENCE_SCORE,
 * senza alcuna nozione di "dry-run". Chiamarle da uno script "solo simulazione"
 * scriverebbe comunque per davvero (verificato: la prima dry-run di questo
 * script durante lo sviluppo ha stub-creato 9 doc `titles` reali su `gia-visto`
 * + tentato 9 upload poster su Storage, prima di essere individuato e ripulito
 * manualmente). Questo script reimplementa quindi la cascata (matchExact ->
 * matchNormalizedVariant -> matchAltNamesLower -> ricerca TMDB) chiamando le
 * funzioni read-only di matching.js direttamente, e mette un guard esplicito
 * attorno alla singola chiamata che scrive (upsertTmdbTitle): in dry-run si
 * ferma un istante prima e riporta solo "questo item risolverebbe con --write
 * (stub-create TMDB)" senza toccare nulla; in --write il comportamento e'
 * identico bit-per-bit alla cascata originale.
 *
 * NON tocca:
 * - item con skip:true (mai)
 * - item gia' resolved:true (mai)
 * - voti/commenti TV Time (ratings/reviewText): quel path (processTvTimeRatingsAndComments,
 *   in finalizeImportResults) legge le CSV RAW (rawCsvEpisodeVotes/rawCsvMovieVotes/...)
 *   da `imports/{id}/payload/raw`, che viene CANCELLATO subito dopo la finalizzazione
 *   iniziale (payloadRef.delete()). A questo punto il payload non esiste piu':
 *   non c'e' nulla da rigiocare per i voti, quindi lo script non ci prova nemmeno.
 *   Se un item rematchato genera un titleId nuovo, un eventuale voto/commento TV
 *   Time collegato a quello stesso titolo (gia' scritto o gia' scartato al primo
 *   giro) NON viene retroattivamente ricollegato: resta come fu deciso allora.
 *
 * Soglia prudente (identica alla cascata originale, nessuna soglia nuova):
 * - matchExact (confidence 1, strategy "exact")
 * - matchNormalizedVariant (strategy "normalized_variant", gia' filtrato a
 *   confidence >= HIGH_CONFIDENCE_SCORE=0.82 dentro matching.js)
 * - matchAltNamesLower (confidence 0.95, strategy "alt_names_lower") <- il
 *   caso che questo script sblocca principalmente
 * - matchViaTvdbId (confidence 1, strategy "tvdb_id"/"tvdb_id_stub_created")
 *   quando l'item porta un tvdbSeriesId/tvdbMovieId (NON il caso comune per
 *   item gia' importati: il tvdbId non e' persistito sull'item doc, vedi nota
 *   sotto "Limite noto")
 * - matchViaTmdb SOLO se lo score arriva a HIGH_CONFIDENCE_SCORE (0.82) ->
 *   "tmdb_existing" (titolo gia' in catalogo) o "tmdb_stub_created" (nuovo
 *   doc titles stub-creato, stesso comportamento del flusso normale)
 *
 * Un fallback TMDB con score fra MIN_STUB_SCORE (0.6) e HIGH_CONFIDENCE_SCORE
 * (0.82) esclusivo ("tmdb_suggestion") NON viene applicato: resta irrisolto,
 * meglio manuale che sbagliato (requisito esplicito del task).
 *
 * Limite noto: gli item gia' salvati in `imports/{id}/items` NON portano
 * tvdbSeriesId/tvdbMovieId (quei campi vivono solo nella NormalizedRow in
 * memoria durante il parsing originale, mai scritti sull'item doc - vedi
 * l'oggetto scritto in finalizeImportResults). Per import TV Time GDPR v2 con
 * s_id, questo significa che il rematch qui sotto NON puo' sfruttare la
 * scorciatoia tvdb_id (che salterebbe la cascata nome-based interamente):
 * passa comunque per matchExact/matchNormalizedVariant/matchAltNamesLower/
 * matchViaTmdb usando seriesNameGuess/movieNameGuess, esattamente come
 * l'utente che conferma manualmente farebbe leggendo il nome.
 *
 * Idempotente: rilanciabile a piacere. Un item gia' risolto da una run
 * precedente (in DRY-RUN non scrive nulla; in WRITE lo marca resolved:true)
 * viene saltato alla run successiva dal filtro resolved==false.
 *
 * Usage:
 *   cd functions
 *   export TMDB_KEY=...   (o TMDB_API_KEY)
 *   node scripts/rematch-import-unresolved.js --uid=UID --import=IMPORT_ID          # dry-run
 *   node scripts/rematch-import-unresolved.js --uid=UID --import=IMPORT_ID --write  # applica
 *   node scripts/rematch-import-unresolved.js --all-awaiting                        # dry-run su tutti gli import awaiting_confirmation
 *   node scripts/rematch-import-unresolved.js --all-awaiting --write
 */

"use strict";

const admin = require("firebase-admin");

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const ALL_AWAITING = args.includes("--all-awaiting");

function getArg(flag) {
  const prefix = `${flag}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length).trim() : "";
}

const ARG_UID = getArg("--uid");
const ARG_IMPORT = getArg("--import");

if (!ALL_AWAITING && (!ARG_UID || !ARG_IMPORT)) {
  console.error("ERRORE: serve --uid=... --import=... oppure --all-awaiting");
  process.exit(1);
}

const TMDB_KEY = process.env.TMDB_KEY || process.env.TMDB_API_KEY;
if (!TMDB_KEY) {
  console.error("ERRORE: TMDB_KEY mancante. Export TMDB_KEY=... (o TMDB_API_KEY) prima di eseguire.");
  process.exit(1);
}
// modules/tmdb.js legge la chiave da firebase-functions/params.defineString("TMDB_KEY")
// con fallback a process.env.TMDB_KEY/TMDB_API_KEY (getTmdbApiKey) — impostare
// anche TMDB_KEY qui garantisce che il fallback funzioni fuori da un contesto
// Cloud Functions deployato (defineString().value() torna "" se non risolvibile).
process.env.TMDB_KEY = TMDB_KEY;

admin.initializeApp({ projectId: "gia-visto", storageBucket: "gia-visto.firebasestorage.app" });
const db = admin.firestore();
const bucket = admin.storage().bucket();

const {
  matchExact,
  matchNormalizedVariant,
  matchAltNamesLower,
  searchTmdb,
  rankTmdbResults,
  hasCjk,
} = require("../lib/importAdapters/matching");
const { searchAnilistAnime, anilistQueryCandidates } = require("../lib/importAdapters/anilist");

// Optional decoupled mode: if ANILIST_MAP_FILE points to a JSON harvested by
// anilist-harvest.js ({itemId:{name,native,english,type,...}}), use it as the
// AniList source instead of LIVE calls during matching. This keeps the rematch
// a pure TMDB+Firestore pass (no AniList rate-limit surface interleaved with
// the per-item TMDB work). Keyed by lowercased name (many items share a name).
const _anilistMapByName = (() => {
  const p = process.env.ANILIST_MAP_FILE;
  if (!p) return null;
  try {
    const raw = JSON.parse(require("fs").readFileSync(p, "utf8"));
    const byName = new Map();
    for (const e of Object.values(raw)) {
      const key = String(e.name || "").trim().toLowerCase();
      if (key && !byName.has(key)) byName.set(key, e);
    }
    console.log(`[anilist-map] caricate ${byName.size} mappe da ${p} (mode: NO live AniList)`);
    return byName;
  } catch (err) { console.error("[anilist-map] impossibile leggere", p, err.message); return null; }
})();
const { buildImportTitleStateWrites } = require("../lib/importAdapters/writeTitleStates");
const {
  buildNextTitleState,
  buildLegacyLibraryProjection,
  buildLegacyWatchlistProjection,
  isMeaningfulTitleState,
} = require("../lib/titleStates");
const {
  titleDocMediaType,
  normalizeText,
  existsLogicalDuplicateTitle,
  upsertTmdbTitle,
  tmdbTitleDocId,
} = require("../modules/tmdb");

// Stesse soglie di functions/lib/importAdapters/matching.js (non esportate da
// li' — duplicate qui SOLO per poter decidere, PRIMA di chiamare
// upsertTmdbTitle/matchViaTvdbId, se uno stub-create scatterebbe. I valori
// devono restare identici alla cascata originale: se matching.js li cambia,
// aggiornare anche qui.
const HIGH_CONFIDENCE_SCORE = 0.82;

// IMPORTANTE — perche' questo file NON chiama semplicemente resolveTitleMatch/
// matchViaTmdb/matchViaTvdbId di matching.js: quelle funzioni chiamano
// upsertTmdbTitle/uploadTmdbPosterToStorage in modo INCONDIZIONATO ogni volta
// che il punteggio arriva ad HIGH_CONFIDENCE_SCORE — un vero scrittura
// Firestore + upload Storage, a prescindere da un flag "dry-run" che la
// cascata non conosce. Rilanciarle direttamente in modalita' dry-run
// creerebbe DAVVERO gli stub (successo in produzione durante la stesura di
// questo script: 9 doc titles + upload poster falliti sono stati creati e poi
// ripuliti manualmente). Qui sotto reimplementiamo lo STESSO smistamento kind
// per kind, MA con un guard esplicito: in dry-run ci si ferma un attimo prima
// della scrittura effettiva e si riporta solo "cosa succederebbe".

const FIRESTORE_BATCH_CHUNK = 400; // stesso margine di index.js (cap 500 op/batch)

// Mirror di buildFirestoreProjectionPayload in index.js (non esportata).
function buildFirestoreProjectionPayload(basePayload, serverTimestampField, timestampKey) {
  const payload = { ...(basePayload || {}) };
  if (!payload || !Object.keys(payload).length) return null;
  payload.updatedAt = serverTimestampField;
  if (timestampKey && !payload[timestampKey]) {
    payload[timestampKey] = serverTimestampField;
  }
  return payload;
}

async function commitInChunks(writeFns) {
  for (let i = 0; i < writeFns.length; i += FIRESTORE_BATCH_CHUNK) {
    const chunk = writeFns.slice(i, i + FIRESTORE_BATCH_CHUNK);
    const batch = db.batch();
    chunk.forEach((fn) => fn(batch));
    if (WRITE) {
      // eslint-disable-next-line no-await-in-loop
      await batch.commit();
    }
  }
}

// Stesse soglie della cascata (matching.js) — nessuna soglia nuova qui.
// Un match e' "applicabile" (auto-confermabile senza intervento umano) se e'
// arrivato da una strategia deterministica o ad alta confidenza:
//   exact / normalized_variant / alt_names_lower / tvdb_id* / tmdb_existing /
//   tmdb_stub_created  (tutte >= HIGH_CONFIDENCE_SCORE=0.82 o id-based)
// "tmdb_suggestion" (score tra 0.6 e 0.82, matchViaTmdb) resta escluso: non ha
// un titleId, e' solo un hint per la UI di conferma manuale.
const APPLICABLE_STRATEGIES = new Set([
  "exact",
  "normalized_variant",
  "alt_names_lower",
  "tvdb_id",
  "tvdb_id_stub_created",
  "tmdb_existing",
  "tmdb_stub_created",
]);

function isApplicableMatch(match) {
  if (!match?.titleId) return false;
  // Strip the tracking prefixes (cache_/anilist_, possibly stacked) so the
  // underlying strategy (tmdb_existing, tmdb_stub_created, …) is checked.
  const baseStrategy = String(match.strategy || "").replace(/^(cache_|anilist_)+/, "");
  return APPLICABLE_STRATEGIES.has(baseStrategy);
}

// Ricostruisce un NormalizedRow-like a partire dal doc item (stesso shape che
// confirmTitlesImport costruisce per user_confirmed — vedi index.js).
function itemToRow(item) {
  return {
    rawTitle: item.rawTitle,
    rawDate: item.rawDate ?? null,
    kind: item.kind,
    seriesNameGuess: item.seriesNameGuess,
    movieNameGuess: item.movieNameGuess,
    seasonNumber: item.seasonNumber,
    episodeNumber: item.episodeNumber,
    episodeNameGuess: item.episodeNameGuess,
    watchedDate: item.watchedDate?.toDate ? item.watchedDate.toDate() : new Date(),
    watchlistOnly: item.watchlistOnly === true,
  };
}

// Tokenizer per lo scoring: come tokenizeNormalized (modules/tmdb.js) MA
// conserva anche i token numerici a 1 carattere. tokenizeNormalized filtra
// `length >= 2`, quindi "3"/"4" spariscono e "Home Alone 3" tokenizza
// IDENTICO a "Home Alone" -> falso score 1.00 sul sequel sbagliato (TMDB
// ordina Home Alone 3 sopra l'originale 1990 per popularity). Con la cifra
// preservata il sequel scende a 0.67 (sotto soglia) e l'originale — che
// come original_title fa exact match — vince il rank. Verificato sul caso
// reale "Home Alone" di questo import.
// tokenizeForScoring + rankTmdbResults ora arrivano da matching.js (esportati
// 2026-07-10, versione CJK-aware: bigrammi di carattere per titoli JP/KR/ZH).

// Step "search+stub" della cascata (equivalente a matchViaTmdb in
// matching.js), MA con un guard esplicito attorno all'UNICA chiamata che
// scrive (upsertTmdbTitle, stub-crea un doc titles + carica un poster su
// Storage): in dry-run ci fermiamo un istante prima e riportiamo solo cosa
// accadrebbe, senza toccare Firestore/Storage. In --write il comportamento e'
// identico bit-per-bit a matchViaTmdb.
async function matchViaTmdbGuarded(name, expectedType, logicalDupCache) {
  const results = await searchTmdb(db, name, expectedType, {});
  if (results.length === 0) return null;

  const ranked = rankTmdbResults(results, name);
  const top = ranked[0];
  if (!top || top.score < 0.6) return null; // MIN_STUB_SCORE in matching.js

  const existingDocId = await existsLogicalDuplicateTitle(db, top.row, logicalDupCache);
  if (existingDocId) {
    const doc = await db.collection("titles").doc(existingDocId).get();
    return { titleId: existingDocId, title: doc.data(), confidence: top.score, strategy: "tmdb_existing" };
  }

  if (top.score < HIGH_CONFIDENCE_SCORE) {
    return {
      titleId: null,
      title: null,
      confidence: top.score,
      strategy: "tmdb_suggestion",
      suggestion: {
        tmdbId: Number(top.row.tmdbId || top.row.id) || null,
        name: top.row.type === "tv" ? top.row.name : top.row.title,
        year: Number(String(top.row.release_date || top.row.first_air_date || "").slice(0, 4)) || null,
        posterPath: top.row.poster_path || null,
        mediaType: expectedType,
      },
    };
  }

  // Da qui in poi la cascata originale creerebbe DAVVERO uno stub
  // (upsertTmdbTitle: write Firestore + upload Storage). In dry-run ci
  // fermiamo e riportiamo solo l'esito previsto — NESSUNA scrittura.
  if (!WRITE) {
    return {
      titleId: null,
      title: null,
      confidence: top.score,
      strategy: "would_tmdb_stub_create",
      wouldCreateStub: {
        tmdbId: Number(top.row.tmdbId || top.row.id) || null,
        name: top.row.type === "tv" ? top.row.name : top.row.title,
        mediaType: expectedType,
      },
    };
  }

  const upsertResult = await upsertTmdbTitle(db, bucket, top.row, logicalDupCache);
  if (!upsertResult.imported) return null;
  const docId = tmdbTitleDocId(expectedType, top.row.tmdbId || top.row.id);
  const doc = await db.collection("titles").doc(docId).get();
  return { titleId: docId, title: doc.data(), confidence: top.score, strategy: "tmdb_stub_created" };
}

// Cascata read-only-first per un singolo nome+tipo: matchExact ->
// matchNormalizedVariant -> matchAltNamesLower -> matchViaTmdbGuarded. Non
// include la scorciatoia tvdb-id di resolveTitleMatch (matchViaTvdbId): gli
// item gia' persistiti non portano tvdbSeriesId/tvdbMovieId (mai scritti su
// imports/{id}/items — vedi docstring in cima al file), quindi quel ramo non
// e' mai raggiungibile qui comunque. Nessuna cache cross-import (importMatchCache):
// per un rematch mirato su un import gia' esistente non serve, ed evita di
// scrivere entries di cache per un WRITE=false che non ha davvero risolto nulla.
async function matchNameGuarded(name, expectedType, logicalDupCache) {
  const trimmedName = String(name || "").trim();
  if (!trimmedName) return null;

  const exact = await matchExact(db, trimmedName, expectedType);
  if (exact) return exact;

  const variant = await matchNormalizedVariant(db, trimmedName, expectedType);
  if (variant) return variant;

  const altNames = await matchAltNamesLower(db, trimmedName, expectedType);
  if (altNames) return altNames;

  const viaTmdb = await matchViaTmdbGuarded(trimmedName, expectedType, logicalDupCache);
  if (viaTmdb?.titleId) return viaTmdb;

  // AniList bridge (dry-run-safe: usa matchViaTmdbGuarded, non matchViaTmdb):
  // romaji/nomi-fan di ANIME che TMDB non mappa al titolo ufficiale. Solo su
  // nome LATINO irrisolto (il CJK è già gestito dallo scorer a bigrammi).
  if (!hasCjk(trimmedName)) {
    let cands = [];
    if (_anilistMapByName) {
      const hit = _anilistMapByName.get(trimmedName.toLowerCase());
      cands = hit ? [hit] : [];
    } else {
      try { cands = await searchAnilistAnime(trimmedName); } catch { cands = []; }
    }
    for (const cand of cands.slice(0, 2)) {
      const type = cand.type || expectedType;
      for (const q of anilistQueryCandidates(cand)) {
        // eslint-disable-next-line no-await-in-loop
        const m = await matchViaTmdbGuarded(q, type, logicalDupCache);
        if (m?.titleId || m?.strategy === "would_tmdb_stub_create") return { ...m, strategy: `anilist_${m.strategy}` };
      }
    }
  }

  return viaTmdb; // il miglior tentativo (suggerimento o null) se AniList non aiuta
}

// Rigioca la cascata per un singolo item non risolto, replicando
// resolveRowMatch (matching.js) per kind movie/tv_episode/ambiguous, ma
// passando per matchNameGuarded (vedi sopra) invece di resolveTitleMatch per
// non scrivere nulla in dry-run.
async function rematchItem(item, logicalDupCache) {
  if (item.kind === "movie") {
    const match = await matchNameGuarded(item.movieNameGuess, "movie", logicalDupCache);
    return match ? { ...match, resolvedAsType: match.titleId ? "movie" : null } : null;
  }
  if (item.kind === "tv_episode") {
    const match = await matchNameGuarded(item.seriesNameGuess, "tv", logicalDupCache);
    return match ? { ...match, resolvedAsType: match.titleId ? "tv" : null } : null;
  }

  // kind === "ambiguous": stesso doppio tentativo di resolveRowMatch, poi la
  // stessa regola "esattamente uno risolve" per non decidere alla cieca.
  const [movieAttempt, tvAttempt] = await Promise.all([
    matchNameGuarded(item.movieNameGuess, "movie", logicalDupCache),
    matchNameGuarded(item.seriesNameGuess, "tv", logicalDupCache),
  ]);
  const movieResolved = Boolean(movieAttempt?.titleId);
  const tvResolved = Boolean(tvAttempt?.titleId);
  if (movieResolved && !tvResolved) return { ...movieAttempt, resolvedAsType: "movie" };
  if (tvResolved && !movieResolved) return { ...tvAttempt, resolvedAsType: "tv" };
  // Entrambi o nessuno: non decidiamo. Riporta il migliore come solo hint.
  const best = (movieAttempt?.confidence || 0) >= (tvAttempt?.confidence || 0) ? movieAttempt : tvAttempt;
  return best ? { ...best, titleId: null, resolvedAsType: null, ambiguousBothMatched: movieResolved && tvResolved } : null;
}

async function fetchUnresolvedItems(importRef) {
  const snap = await importRef.collection("items")
    .where("resolved", "==", false)
    .where("skip", "==", false)
    .get();
  return snap.docs;
}

async function findAwaitingImports() {
  // Preferisce collectionGroup (nessun indice dedicato noto in
  // firestore.indexes.json per "imports"; Firestore in genere abilita
  // automaticamente gli indici single-field anche in scope collectionGroup,
  // ma se questo fallisse per mancanza di indice, ripiega su una scansione
  // utente-per-utente).
  try {
    const snap = await db.collectionGroup("imports").where("status", "==", "awaiting_confirmation").get();
    if (!snap.empty || snap.size === 0) {
      return snap.docs.map((d) => ({ uid: d.ref.parent.parent.id, importId: d.id, ref: d.ref, data: d.data() }));
    }
  } catch (err) {
    console.log(`  (collectionGroup query fallita, fallback a scan utenti: ${err?.message || err})`);
  }

  const results = [];
  const usersSnap = await db.collection("users").get();
  for (const userDoc of usersSnap.docs) {
    // eslint-disable-next-line no-await-in-loop
    const importsSnap = await userDoc.ref.collection("imports").where("status", "==", "awaiting_confirmation").get();
    importsSnap.docs.forEach((d) => {
      results.push({ uid: userDoc.id, importId: d.id, ref: d.ref, data: d.data() });
    });
  }
  return results;
}

async function processImport({ uid, importId }) {
  const userRef = db.collection("users").doc(uid);
  const importRef = userRef.collection("imports").doc(importId);
  const importSnap = await importRef.get();
  if (!importSnap.exists) {
    console.log(`Import non trovato: users/${uid}/imports/${importId}`);
    return null;
  }
  const importData = importSnap.data() || {};
  console.log(`\n=== users/${uid}/imports/${importId} (status=${importData.status}, source=${importData.source || "?"}) ===`);

  const unresolvedDocs = await fetchUnresolvedItems(importRef);
  console.log(`Item irrisolti (resolved:false, skip:false): ${unresolvedDocs.length}`);
  if (unresolvedDocs.length === 0) {
    return { uid, importId, totalUnresolved: 0, wouldResolve: 0, stillUnresolved: 0 };
  }

  const matchedRows = [];
  const itemWriteFns = [];
  const sample = [];
  const stillUnresolvedReasons = { no_match: 0, low_confidence_tmdb_suggestion: 0, ambiguous_both_or_neither: 0, would_stub_create_dry_run: 0 };
  // Cache locale (per-import) di logicalKey->titleId per existsLogicalDuplicateTitle/
  // upsertTmdbTitle — evita ricontrollare lo stesso titolo TMDB piu' volte nella
  // stessa run quando piu' item irrisolti puntano allo stesso film/serie
  // (es. piu' episodi della stessa serie, o rewatch multipli). Vale sia in
  // dry-run (solo letture) che in --write (stesso pattern di confirmTitlesImport,
  // che pero' non lo usa perche' li' il titleId e' scelto dall'utente).
  const logicalDupCache = new Map();

  for (let i = 0; i < unresolvedDocs.length; i += 1) {
    const itemDoc = unresolvedDocs[i];
    const item = itemDoc.data();
    const name = item.seriesNameGuess || item.movieNameGuess || item.rawTitle || "(senza nome)";

    let match = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      match = await rematchItem(item, logicalDupCache);
    } catch (err) {
      console.log(`  [${i + 1}/${unresolvedDocs.length}] ERR "${name}" - ${err?.message || err}`);
      continue;
    }

    if (isApplicableMatch(match)) {
      const titleSnap = await db.collection("titles").doc(match.titleId).get(); // eslint-disable-line no-await-in-loop
      const title = { id: match.titleId, ...(titleSnap.data() || {}) };
      const row = itemToRow(item);
      const resolvedAsType = match.resolvedAsType || titleDocMediaType(title);

      matchedRows.push({ titleId: match.titleId, title, row });
      itemWriteFns.push((batch) => batch.set(itemDoc.ref, {
        resolved: true,
        skip: false,
        titleId: match.titleId,
        titleName: title.name || null,
        resolvedAsType,
        confidence: Number(match.confidence || 0),
        strategy: match.strategy || null,
        suggestion: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true }));

      const line = `  [${i + 1}/${unresolvedDocs.length}] MATCH "${name}" -> "${title.name || match.titleId}" (${match.strategy}, conf=${Number(match.confidence || 0).toFixed(2)})`;
      console.log(line);
      if (sample.length < 15) sample.push({ name, titleName: title.name || match.titleId, titleId: match.titleId, strategy: match.strategy, confidence: match.confidence });
    } else if (match?.strategy === "would_tmdb_stub_create") {
      // Solo in dry-run: il match e' identico a un tmdb_stub_created reale
      // (score >= HIGH_CONFIDENCE_SCORE), ma qui NON e' stato eseguito
      // l'upsert (nessun titleId assegnato) per non scrivere in Firestore/
      // Storage durante una simulazione. Contato separatamente da "nessun
      // match" perche' CON --write questo item risolverebbe.
      stillUnresolvedReasons.would_stub_create_dry_run += 1;
      const stub = match.wouldCreateStub || {};
      console.log(`  [${i + 1}/${unresolvedDocs.length}] ~~ "${name}" risolverebbe con --write (stub-create TMDB "${stub.name}" tmdbId=${stub.tmdbId}, conf=${Number(match.confidence || 0).toFixed(2)}) — dry-run non crea il titolo`);
      if (sample.length < 15) sample.push({ name, titleName: `${stub.name} [NUOVO STUB]`, titleId: `(tmdbId ${stub.tmdbId}, non creato in dry-run)`, strategy: match.strategy, confidence: match.confidence });
    } else {
      const strategy = match?.strategy || null;
      if (strategy === "tmdb_suggestion") {
        stillUnresolvedReasons.low_confidence_tmdb_suggestion += 1;
        console.log(`  [${i + 1}/${unresolvedDocs.length}] -- "${name}" ancora irrisolto (suggerimento TMDB a bassa confidenza: "${match.suggestion?.name}" conf=${Number(match.confidence || 0).toFixed(2)}, sotto soglia 0.82)`);
      } else if (match?.ambiguousBothMatched) {
        stillUnresolvedReasons.ambiguous_both_or_neither += 1;
        console.log(`  [${i + 1}/${unresolvedDocs.length}] -- "${name}" ancora irrisolto (ambiguo: sia film che serie hanno matchato, serve conferma manuale)`);
      } else {
        stillUnresolvedReasons.no_match += 1;
        console.log(`  [${i + 1}/${unresolvedDocs.length}] -- "${name}" ancora irrisolto (nessun match, nemmeno un suggerimento)`);
      }
    }
  }

  console.log(`\nCampione primi ${sample.length} match proposti:`);
  sample.forEach((s, idx) => {
    console.log(`  ${idx + 1}. "${s.name}" -> "${s.titleName}" [${s.strategy}, conf=${Number(s.confidence || 0).toFixed(2)}] (titleId=${s.titleId})`);
  });

  const wouldAlsoResolveWithWrite = WRITE ? 0 : stillUnresolvedReasons.would_stub_create_dry_run;
  console.log(`\nRisultato: ${matchedRows.length}/${unresolvedDocs.length} risolti${WRITE ? "" : " (simulati, letture-only)"}.${wouldAlsoResolveWithWrite ? ` +${wouldAlsoResolveWithWrite} risolverebbero SOLO con --write (stub-create TMDB, non eseguito in dry-run).` : ""} Restano davvero irrisolti (nessuna strategia): ${unresolvedDocs.length - matchedRows.length - wouldAlsoResolveWithWrite}`);
  console.log(`  di cui: suggerimento TMDB a bassa confidenza=${stillUnresolvedReasons.low_confidence_tmdb_suggestion}, ambiguo (entrambi)=${stillUnresolvedReasons.ambiguous_both_or_neither}, nessun match=${stillUnresolvedReasons.no_match}, stub-create solo simulato (--write lo risolverebbe)=${stillUnresolvedReasons.would_stub_create_dry_run}`);

  if (matchedRows.length === 0) {
    return { uid, importId, totalUnresolved: unresolvedDocs.length, wouldResolve: 0, stillUnresolved: unresolvedDocs.length };
  }

  await commitInChunks(itemWriteFns);

  // Split watched vs watchlist-only — stesso comportamento di
  // finalizeImportResults (index.js), NON di confirmTitlesImport che ha un
  // gap noto (droppa item.watchlistOnly e marca tutto come visto). Le righe
  // TV Time "follow"/is_for_later NON portano segnale di visione: mai
  // mark_seen/set_progress per loro. Se un titleId ha ALMENO una riga
  // watched, le righe watchlist-only per lo stesso titolo vengono scartate
  // (un titolo davvero visto non torna in "da vedere"); un titleId con SOLO
  // righe watchlist-only riceve toggle_watchlist (no-op se il titolo risulta
  // gia' iniziato: hasStartedWatching dentro buildNextTitleState — quindi
  // mai regressioni, idempotente al rilancio).
  const watchlistOnlyRowsRaw = matchedRows.filter((r) => r.row.watchlistOnly === true);
  const watchedRows = matchedRows.filter((r) => r.row.watchlistOnly !== true);
  const watchedTitleIds = new Set(watchedRows.map((r) => r.titleId));
  const watchlistOnlyRows = watchlistOnlyRowsRaw.filter((r) => !watchedTitleIds.has(r.titleId));

  const uniqueTitleIds = Array.from(new Set([
    ...watchedRows.map((r) => r.titleId),
    ...watchlistOnlyRows.map((r) => r.titleId),
  ]));
  const currentStatesByTitleId = new Map();
  for (let i = 0; i < uniqueTitleIds.length; i += 10) {
    const chunk = uniqueTitleIds.slice(i, i + 10);
    // eslint-disable-next-line no-await-in-loop
    const snaps = await Promise.all(chunk.map((id) => userRef.collection("titleStates").doc(id).get()));
    snaps.forEach((snap, idx) => {
      currentStatesByTitleId.set(chunk[idx], snap.exists ? snap.data() : null);
    });
  }

  const importOptions = {
    countDuplicateRewatches: importData?.importOptions?.countDuplicateRewatches !== false,
    countExistingAsRewatch: Boolean(importData?.importOptions?.countExistingAsRewatch),
  };
  const writes = buildImportTitleStateWrites(watchedRows, currentStatesByTitleId, {
    now: new Date(),
    ...importOptions,
  });

  // Watchlist-only: toggle_watchlist via buildNextTitleState, stesso codice
  // di finalizeImportResults (source `import_<source>`).
  const importSource = String(importData.source || "unknown").trim().toLowerCase();
  const watchlistOnlyByTitleId = new Map();
  for (const { titleId, title } of watchlistOnlyRows) {
    if (watchlistOnlyByTitleId.has(titleId)) continue;
    const currentState = currentStatesByTitleId.get(titleId) || null;
    const titleForState = { ...(title || {}), id: titleId };
    const next = buildNextTitleState(currentState, {
      type: "toggle_watchlist",
      enabled: true,
      source: `import_${importSource}`,
    }, titleForState, { now: new Date() });
    watchlistOnlyByTitleId.set(titleId, next);
  }

  const titleStateWriteFns = [];
  const applyStateWrite = (titleId, next) => {
    const stateRef = userRef.collection("titleStates").doc(titleId);
    titleStateWriteFns.push((batch) => batch.set(stateRef, next, { merge: true }));
    if (isMeaningfulTitleState(next)) {
      const libraryPayload = buildFirestoreProjectionPayload(
        buildLegacyLibraryProjection(next),
        admin.firestore.FieldValue.serverTimestamp(),
        "createdAt"
      );
      const watchlistPayload = buildFirestoreProjectionPayload(
        buildLegacyWatchlistProjection(next),
        admin.firestore.FieldValue.serverTimestamp(),
        "addedAt"
      );
      if (libraryPayload) {
        titleStateWriteFns.push((batch) => batch.set(userRef.collection("library").doc(titleId), libraryPayload, { merge: true }));
      }
      if (watchlistPayload) {
        titleStateWriteFns.push((batch) => batch.set(userRef.collection("watchlist").doc(titleId), watchlistPayload, { merge: true }));
      }
    }
  };
  writes.forEach(({ titleId, next }) => applyStateWrite(titleId, next));
  watchlistOnlyByTitleId.forEach((next, titleId) => applyStateWrite(titleId, next));
  await commitInChunks(titleStateWriteFns);
  if (watchlistOnlyByTitleId.size > 0) {
    console.log(`Watchlist-only: ${watchlistOnlyByTitleId.size} titoli -> toggle_watchlist (nessun mark_seen)${WRITE ? "" : " [simulato]"}`);
  }

  const mergedTitleStateIds = Array.from(new Set([
    ...(Array.isArray(importData.titleStateIdsWritten) ? importData.titleStateIdsWritten : []),
    ...writes.map((w) => w.titleId),
    ...Array.from(watchlistOnlyByTitleId.keys()),
  ]));

  // Ricalcola l'unresolvedCount reale dalla subcollection items (stesso
  // approccio di confirmTitlesImport: query, non aritmetica cieca).
  const remainingUnresolvedSnap = await importRef.collection("items")
    .where("resolved", "==", false)
    .where("skip", "==", false)
    .limit(1)
    .get();
  const stillUnresolved = !remainingUnresolvedSnap.empty;
  const nextStatus = stillUnresolved ? "awaiting_confirmation" : "completed";

  if (WRITE) {
    await importRef.set({
      status: nextStatus,
      titleStateIdsWritten: mergedTitleStateIds,
      matchedCount: admin.firestore.FieldValue.increment(matchedRows.length),
      unresolvedCount: Math.max(0, unresolvedDocs.length - matchedRows.length),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      completedAt: stillUnresolved ? (importData.completedAt || null) : admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    console.log(`Import doc aggiornato: status=${nextStatus}, matchedCount+=${matchedRows.length}, unresolvedCount=${Math.max(0, unresolvedDocs.length - matchedRows.length)}`);
  } else {
    console.log(`[DRY-RUN] Import doc NON aggiornato (verrebbe: status=${nextStatus}, matchedCount+=${matchedRows.length}, unresolvedCount=${Math.max(0, unresolvedDocs.length - matchedRows.length)})`);
  }

  return { uid, importId, totalUnresolved: unresolvedDocs.length, wouldResolve: matchedRows.length, stillUnresolved: unresolvedDocs.length - matchedRows.length, nextStatus };
}

async function main() {
  console.log(`\n=== REMATCH IMPORT UNRESOLVED ===${WRITE ? " [WRITE]" : " [DRY-RUN]"}`);
  if (!WRITE) console.log("Dry-run: nessuna modifica verra scritta.\n");

  const targets = ALL_AWAITING
    ? await findAwaitingImports()
    : [{ uid: ARG_UID, importId: ARG_IMPORT }];

  if (ALL_AWAITING) {
    console.log(`Import in stato awaiting_confirmation trovati: ${targets.length}`);
  }

  const summary = [];
  for (const t of targets) {
    // eslint-disable-next-line no-await-in-loop
    const result = await processImport(t);
    if (result) summary.push(result);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("RIEPILOGO");
  console.log("=".repeat(60));
  summary.forEach((s) => {
    console.log(`users/${s.uid}/imports/${s.importId}: irrisolti=${s.totalUnresolved}, risolti${WRITE ? "" : " (simulati)"}=${s.wouldResolve}, ancora irrisolti=${s.stillUnresolved}${s.nextStatus ? `, nextStatus=${s.nextStatus}` : ""}`);
  });
  console.log(`\n${WRITE ? "Modifiche applicate." : "Dry-run: nessuna modifica salvata. Rilancia con --write per applicare."}`);
  console.log("=== FINE ===");
}

main().catch((err) => {
  console.error("ERRORE FATALE:", err);
  process.exit(1);
});
