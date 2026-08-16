// imports.api.js — Import cronologia visioni (Netflix CSV, futuro TV Time).
// Wrapper client per le callable `startTitlesImport` / `confirmTitlesImport`
// (functions/index.js, europe-west1) + lettura realtime del job doc
// `users/{uid}/imports/{importId}` e delle sue righe `items/{itemId}`.
// Le rules negano ogni scrittura diretta: solo le callable (admin SDK)
// scrivono questi doc, il client legge soltanto.

import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  where,
  limit as fbLimit,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";
import {
  ref as storageRef,
  uploadBytes,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js";

import { app, db, storage } from "../firebase.js";

const functions = getFunctions(app, "europe-west1");
const startTitlesImportCallable = httpsCallable(functions, "startTitlesImport");
const confirmTitlesImportCallable = httpsCallable(functions, "confirmTitlesImport");
const createTitlesImportUploadSessionCallable = httpsCallable(functions, "createTitlesImportUploadSession");
// Trakt.tv — OAuth device flow (nessun redirect: l'utente inserisce uno
// "user code" su trakt.tv/activate) + import one-shot via /sync. Il token
// Trakt vive SOLO server-side (usersPrivate/{uid}/integrations/trakt, deny-all
// client); il client vede solo lo stato della connessione.
const startTraktConnectCallable = httpsCallable(functions, "startTraktConnect");
const pollTraktConnectCallable = httpsCallable(functions, "pollTraktConnect");
const startTraktImportCallable = httpsCallable(functions, "startTraktImport");
// finalizeTitlesImportUpload now just validates + enqueues the resumable
// matching worker and returns quickly ({status:"queued"}); the caller drives
// the terminal state off the Firestore listener (onImportJobChange). The
// generous timeout is kept only to tolerate the initial Storage download +
// parse on a very large file.
const finalizeTitlesImportUploadCallable = httpsCallable(functions, "finalizeTitlesImportUpload", { timeout: 120000 });
// Re-processa un import bloccato (failed / uploading orfano) DAL FILE GIA'
// SALVATO, senza chiedere di ricaricarlo — il grezzo resta finché l'import non
// riesce. Ritorna { ok:true, reprocessed:true } quando riparte, oppure
// { ok:false, needsReupload:true } se il file non c'e' piu' (unico caso in cui
// serve davvero ricaricare).
const retryTitlesImportCallable = httpsCallable(functions, "retryTitlesImport", { timeout: 60000 });

/**
 * Avvia un import. `dryRun:true` esegue l'intera pipeline (parsing + matching)
 * senza scrivere alcun titleState — utile per una stima "a secco".
 * `source: "netflix_csv"` richiede `rawCsv`; `source: "tvtime_gdpr"` richiede
 * `rawCsvV1` (film) + `rawCsvV2` (serie) — i 2 CSV rilevanti estratti dallo
 * ZIP export GDPR di TV Time, MAI lo ZIP intero (che contiene PII) — più 4
 * CSV OPZIONALI (voti + recensioni, film ed episodio): la loro assenza non
 * blocca mai l'import principale. Per l'estensione opensource Refract ("TV
 * Time Out") usa invece `createTitlesImportUploadSession` +
 * `uploadTitlesImportJsonFiles` + `finalizeTitlesImportUpload` qui sotto
 * (upload diretto a Storage, non attraverso il body di questa callable — i
 * JSON possono essere troppo grandi).
 * Ritorna { ok, importId, status, totalRows, matchedCount, unresolvedCount, errorCount, dryRun }.
 */
export async function startTitlesImport({
  source = "netflix_csv",
  rawCsv,
  rawCsvV1,
  rawCsvV2,
  rawCsvEpisodeVotes,
  rawCsvMovieVotes,
  rawCsvMovieRatings,
  rawCsvMovieComments,
  rawCsvEpisodeComments,
  rawCsvLists,
  dryRun = false,
  options = {},
} = {}) {
  const payload = source === "tvtime_gdpr"
    ? { source, platform: "web", rawCsvV1, rawCsvV2, rawCsvEpisodeVotes, rawCsvMovieVotes, rawCsvMovieRatings, rawCsvMovieComments, rawCsvEpisodeComments, rawCsvLists, dryRun, options }
    : { source, platform: "web", rawCsv, dryRun, options };
  const res = await startTitlesImportCallable(payload);
  return res?.data || null;
}

/**
 * Apre una sessione di upload diretto a Storage. Usata da tvtime_refract
 * (sempre) e da tvtime_gdpr/netflix_csv quando il payload è troppo grande per
 * il body callable (>~1MB doc Firestore). `has*` indica quali file il client
 * caricherà; il server whitelista i filename per sorgente. `options` viene
 * memorizzato sul job (rewatch, ecc.) come per startTitlesImport.
 */
export async function createTitlesImportUploadSession({
  source = "tvtime_refract",
  hasMovies = false,
  hasSeries = false,
  hasNetflix = false,
  hasEpisodeVotes = false,
  hasMovieVotes = false,
  hasMovieRatings = false,
  hasMovieComments = false,
  hasEpisodeComments = false,
  hasLists = false,
  hasShowRatings = false,
  options = {},
} = {}) {
  const res = await createTitlesImportUploadSessionCallable({
    source, platform: "web", hasMovies, hasSeries, hasNetflix,
    hasEpisodeVotes, hasMovieVotes, hasMovieRatings, hasMovieComments, hasEpisodeComments, hasLists,
    hasShowRatings,
    options,
  });
  return res?.data || null;
}

/**
 * Carica su Storage i file di una sessione di upload. `texts` è una mappa
 * kind->contenuto (movies/series/netflix/episodeVotes/...); `storagePaths` è
 * la mappa kind->path restituita da createTitlesImportUploadSession. Il
 * content-type è dedotto dall'estensione del path (.json vs .csv) e DEVE
 * combaciare con storage.rules (isJsonUpload/isCsvUpload).
 */
export async function uploadTitlesImportFiles({ storagePaths = {}, texts = {} } = {}) {
  const uploads = [];
  for (const [kind, path] of Object.entries(storagePaths)) {
    const text = texts[kind];
    if (!text || !path) continue;
    const type = /\.json$/i.test(path) ? "application/json;charset=utf-8" : "text/csv;charset=utf-8";
    const blob = new Blob([text], { type });
    uploads.push(uploadBytes(storageRef(storage, path), blob, { contentType: type }));
  }
  await Promise.all(uploads);
}

/** Compat: upload dei soli JSON Refract (delega a uploadTitlesImportFiles). */
export async function uploadTitlesImportJsonFiles({ storagePaths = {}, moviesJson = "", seriesJson = "" } = {}) {
  await uploadTitlesImportFiles({ storagePaths, texts: { movies: moviesJson, series: seriesJson } });
}

/**
 * STEP 3 del flusso di upload: il server scarica i file caricati su Storage,
 * fa il parse (cheap) e ACCODA il matching resumabile, ritornando subito
 * `{ status: "queued", totalRows }`. Il matching + scrittura avvengono in
 * background (worker a tick); il chiamante segue lo stato finale via
 * onImportJobChange, esattamente come per netflix_csv/tvtime_gdpr da body.
 */
export async function finalizeTitlesImportUpload({ importId }) {
  const res = await finalizeTitlesImportUploadCallable({ importId });
  return res?.data || null;
}

/**
 * Conferma una lista di righe non risolte automaticamente e/o chiude il job.
 * `resolutions`: Array<{ itemId, titleId } | { itemId, skip: true } | { itemId, acceptSuggestion: true }>.
 * `skipRemaining: true` — dopo aver applicato le eventuali resolutions, il
 * server marca TUTTE le righe ancora non risolte come skip e completa il job
 * in un'unica chiamata (percorso "conferma rapida" / azioni bulk). Può essere
 * combinato con `resolutions` vuoto (= "salta tutto e finisci"); il server
 * rifiuta solo la combinazione resolutions:[] + skipRemaining:false (nessuna
 * azione richiesta). Idempotente: su un job già completato ritorna il
 * riepilogo finale (`alreadyCompleted:true`) senza rieseguire l'import.
 * Ritorna { ok, importId, status, resolvedCount, importedTitleCount, skippedCount, unresolvedCount, alreadyCompleted? }.
 */
export async function confirmTitlesImport({ importId, resolutions = [], skipRemaining = false } = {}) {
  const res = await confirmTitlesImportCallable({ importId, resolutions, skipRemaining });
  return res?.data || null;
}

/**
 * Costruisce le resolutions "accept-suggestion" (one-tap sul miglior
 * tentativo del matcher) per ogni riga caricata che ha un `suggestion` —
 * usato dal percorso bulk "Usa i suggerimenti migliori" nella coda di
 * revisione manuale. Il server ri-valida comunque confidence>=0.6 +
 * suggestion.tmdbId lato suo (una riga senza i requisiti resta intoccata);
 * qui costruiamo solo il payload della richiesta.
 */
export function buildAcceptSuggestionResolutions(items = []) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && item.suggestion)
    .map((item) => ({ itemId: item.id, acceptSuggestion: true }));
}

/**
 * STEP 1 del collegamento Trakt (OAuth device flow): chiede a Trakt un codice
 * dispositivo. Ritorna { userCode, verificationUrl, interval, expiresIn }.
 * `interval` = secondi tra un poll e l'altro di pollTraktConnect; `expiresIn`
 * = secondi entro cui l'utente deve autorizzare su trakt.tv/activate.
 */
export async function startTraktConnect() {
  const res = await startTraktConnectCallable({});
  return res?.data || null;
}

/**
 * STEP 2: interroga lo stato del collegamento in corso. Da chiamare ogni
 * `interval` secondi (valore ricevuto da startTraktConnect) finché lo stato
 * non è "connected" (o "expired"/"denied", che richiedono di ricominciare).
 * Ritorna { status: "pending"|"connected"|"expired"|"denied"|"none" }.
 */
export async function pollTraktConnect() {
  const res = await pollTraktConnectCallable({});
  return res?.data || null;
}

/**
 * STEP 3: avvia l'import vero e proprio (richiede una connessione "connected"
 * già stabilita). Stessa forma di risposta di startTitlesImport — il
 * chiamante segue lo stato con lo stesso onImportJobChange/coda di conferma.
 */
export async function startTraktImport({ dryRun = false, options = {} } = {}) {
  const res = await startTraktImportCallable({ dryRun, platform: "web", options });
  return res?.data || null;
}

function importDocRef(uid, importId) {
  return doc(db, "users", uid, "imports", importId);
}

/** Legge una volta lo stato del job import (progress, conteggi, status). */
export async function getImportJob(uid, importId) {
  const snap = await getDoc(importDocRef(uid, importId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/**
 * Ritorna l'import NON terminale piu' recente dell'utente (in corso o pronto
 * da confermare), o null. Serve a RIPRENDERE lo stato al rientro sulla pagina
 * import invece di mostrare un form vuoto — un form vuoto fa pensare che il
 * caricamento precedente non sia andato a buon fine e spinge l'utente a
 * ricaricare lo stesso file (causa n.1 di costo). Gli stati di elaborazione
 * (queued/matching/uploading) vengono ignorati se stantii (>24h = sessione
 * probabilmente abbandonata); awaiting_confirmation resta sempre valido.
 */
export async function getActiveImport(uid) {
  if (!uid) return null;
  // Include "failed" so a returning user resumes the failure screen (with a
  // one-tap "riprova elaborazione" that re-processes the file we still hold)
  // instead of a blank picker — a blank picker reads as "il caricamento non e'
  // riuscito" and drives a needless re-upload (causa n.1 del carico Firestore).
  const q = query(
    collection(db, "users", uid, "imports"),
    where("status", "in", ["queued", "matching", "uploading", "awaiting_confirmation", "failed"]),
    fbLimit(12)
  );
  const snap = await getDocs(q).catch(() => null);
  if (!snap || snap.empty) return null;
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  let best = null;
  snap.forEach((d) => {
    const x = { id: d.id, ...d.data() };
    const ms = x.updatedAt?.toMillis ? x.updatedAt.toMillis() : 0;
    // Staleness window per state: awaiting_confirmation never expires (the user
    // still owes a confirmation); a failed import stays resumable for 7 days
    // (matching the Storage payload TTL — the inline TTL is 24h, but retry's
    // own hasCore check is the real gate); in-flight states drop after 24h.
    const maxAgeMs = x.status === "awaiting_confirmation" ? Infinity
      : x.status === "failed" ? 7 * DAY
      : DAY;
    if (ms > 0 && (now - ms) > maxAgeMs) return;
    if (!best || ms > best._ms) best = Object.assign(x, { _ms: ms });
  });
  if (best) delete best._ms;
  return best;
}

/**
 * Ultimo import COMPLETATO dell'utente, per il reveal in Home
 * ("la tua libreria e' pronta", docs/ONBOARDING_V2.md). Nessun orderBy: la
 * collection e' piccola per utente e un ordinamento server chiederebbe un
 * indice composito in piu' per un dato che si ordina benissimo in memoria.
 */
export async function getLastCompletedImport(uid) {
  if (!uid) return null;
  const q = query(
    collection(db, "users", uid, "imports"),
    where("status", "==", "completed"),
    fbLimit(12)
  );
  const snap = await getDocs(q).catch(() => null);
  if (!snap || snap.empty) return null;

  let best = null;
  let bestMs = -1;
  snap.forEach((d) => {
    const x = { id: d.id, ...d.data() };
    const ms = x.updatedAt?.toMillis ? x.updatedAt.toMillis() : 0;
    if (ms > bestMs) { best = x; bestMs = ms; }
  });
  return best;
}

/**
 * Re-processa un import bloccato dal file gia' salvato server-side (nessun
 * re-upload). Ritorna il payload della callable: { ok, reprocessed } quando
 * riparte, { ok:false, needsReupload:true } se il file non e' piu' disponibile.
 */
export async function retryTitlesImport(importId) {
  if (!importId) throw new Error("importId mancante");
  const res = await retryTitlesImportCallable({ importId });
  return res?.data || {};
}

/** Ascolta in realtime il job import (per la progress bar durante il parsing/matching). */
export function onImportJobChange(uid, importId, cb) {
  return onSnapshot(importDocRef(uid, importId), (snap) => {
    cb(snap.exists() ? { id: snap.id, ...snap.data() } : null);
  });
}

/** Elenca le righe NON risolte automaticamente (in attesa di conferma manuale). */
export async function listUnresolvedImportItems(uid, importId, { max = 500 } = {}) {
  const itemsCol = collection(db, "users", uid, "imports", importId, "items");
  const q = query(
    itemsCol,
    where("resolved", "==", false),
    where("skip", "==", false),
    fbLimit(max)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** Elenca tutte le righe importate (per un riepilogo dettagliato, se servisse). */
export async function listAllImportItems(uid, importId, { max = 2000 } = {}) {
  const itemsCol = collection(db, "users", uid, "imports", importId, "items");
  const snap = await getDocs(query(itemsCol, fbLimit(max)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
