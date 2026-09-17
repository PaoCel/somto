"use strict";

const { fanOutDueTitleUpdates, fanOutTitleUpdate } = require("../lib/titleUpdateNotifications");
const {
  filterCandidatesByWindow,
  normalizeTitleForUpdateScan,
  scanTitleForUpdateCandidates,
  splitFutureCandidates,
} = require("../lib/titleUpdateScanner");
const { writeTitleUpdateEvents } = require("../lib/titleUpdateEvents");
const { syncReleaseConversationPosts } = require("../lib/releaseConversationPosts");
const { fetchTmdbCachedJson } = require("./tmdb");
const {
  extractStreamingPlatformLogos,
  extractStreamingPlatformNames,
  normalizeCustomProviders,
  normalizeProvidersForRegion,
} = require("../lib/watchProviders");

// Il catalogo conta ~20k titoli: con 30 titoli ogni 5 minuti un giro completo
// dura ~2,5 giorni. La finestra live sotto DEVE restare piu' larga del giro,
// altrimenti un trailer uscito subito dopo la scansione di quel titolo risulta
// "vecchio" quando lo scanner ci ripassa e non diventa mai un evento.
const SCANNER_BATCH_SIZE = 30;
const SCANNER_LOOKBACK_MS = 5 * 24 * 60 * 60 * 1000;
const SCANNER_FUTURE_MS = 60 * 24 * 60 * 60 * 1000;
const SCANNER_BACKFILL_LOOKBACK_MS = 180 * 24 * 60 * 60 * 1000;
const SCANNER_BACKFILL_FUTURE_MS = 365 * 24 * 60 * 60 * 1000;

// Corsia prioritaria: il giro tondo tratta un titolo che esce fra tre mesi come
// un film del 1997, e 2,5 giorni di ritardo su un teaser sono tanti.
//
// Successo il 2026-09-02: il teaser della serie Harry Potter esce alle 17:00,
// TMDB lo indicizza subito, noi avevamo scansionato quel titolo il giorno prima
// e il cursore ci sarebbe ripassato 15 ore dopo. Nel frattempo, niente.
//
// Il bacino sono i titoli con un'uscita gia' nota nei prossimi mesi: sono
// esattamente quelli di cui esce materiale nuovo. Con ~300 titoli in finestra e
// 6 titoli a giro il ripasso e' ogni ~4 ore, sopra la TTL di un'ora della cache
// TMDB (sotto, si rileggerebbe la stessa risposta in cache).
const PRIORITY_BATCH_SIZE = 6;
const PRIORITY_WINDOW_MS = 150 * 24 * 60 * 60 * 1000;
const PRIORITY_EVENT_TYPES = Object.freeze(["release_date", "new_episode"]);
const TRAILER_EVENT_TYPES = new Set(["trailer", "teaser"]);

function productionFeatureEnabled(env, flagName) {
  const configured = String(env[flagName] || "").trim().toLowerCase();
  if (configured) return configured === "true";
  const projectId = String(env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT || "").trim();
  return projectId === "gia-visto";
}

function titleUpdateNotificationsEnabled(env = process.env) {
  return productionFeatureEnabled(env, "TITLE_UPDATE_NOTIFICATIONS_ENABLED");
}

// La sweep giornaliera che notifica i nuovi episodi **il giorno stesso**.
//
// SPENTA dal 2026-08-25: quelle notifiche erano 553 e ne sono state lette 4
// (0,7%). Le stesse novità adesso viaggiano nel digest settimanale
// (`sendWeeklyDigest`), che le raccoglie in una notifica sola invece di
// spargerle su sette giorni. Il fan-out immediato degli altri tipi di evento
// (trailer, rinnovi, date) resta acceso: quello sta su
// `TITLE_UPDATE_NOTIFICATIONS_ENABLED`, non qui.
//
// Eccezione dal 2026-09-10: le premiere di stagione (episodio 1). Anche a
// sweep spenta il job gira alle 9 e manda solo quelle, quindi
// `firebase-schedule-notifyDueTitleUpdates-europe-west1` deve restare ENABLED.
//
// Per riaccenderla per tutti gli episodi: `TITLE_UPDATE_DUE_SWEEP_ENABLED=true`.
// Se la riaccendi, valuta di spegnere `new_episode` nel digest: altrimenti la
// stessa serie bussa due volte.
function titleUpdateDueSweepEnabled(env = process.env) {
  return String(env.TITLE_UPDATE_DUE_SWEEP_ENABLED || "").trim().toLowerCase() === "true";
}

function titleUpdateScannerEnabled(env = process.env) {
  return productionFeatureEnabled(env, "TITLE_UPDATE_SCANNER_ENABLED");
}

function releaseConversationPostsEnabled(env = process.env) {
  return productionFeatureEnabled(env, "RELEASE_CONVERSATION_POSTS_ENABLED");
}

function scheduledCandidateWindow(candidates, nowMs = Date.now()) {
  return filterCandidatesByWindow(candidates, {
    sinceMs: nowMs - SCANNER_LOOKBACK_MS,
    untilMs: nowMs + SCANNER_FUTURE_MS,
  });
}

function backfillCandidateWindow(candidates, nowMs = Date.now()) {
  return filterCandidatesByWindow(candidates, {
    sinceMs: nowMs - SCANNER_BACKFILL_LOOKBACK_MS,
    untilMs: nowMs + SCANNER_BACKFILL_FUTURE_MS,
  });
}

/**
 * I titoli con un'uscita nota nei prossimi mesi, un pezzo per giro.
 *
 * Il cursore e' la data dell'ultimo evento guardato, non un document id: cosi'
 * la corsia scorre la finestra in ordine di uscita e riparte dall'inizio quando
 * la esaurisce. Gli eventi di un titolo sono spesso piu' d'uno (una serie ha un
 * episodio a settimana): si deduplica per titleId, se no un titolo solo si
 * mangia il giro.
 */
async function readPriorityTitleIds({ db, nowMs = Date.now(), limit = PRIORITY_BATCH_SIZE, cursorMs = 0 }) {
  const startMs = Math.max(Number(cursorMs) || 0, nowMs);
  const start = new Date(startMs);
  const end = new Date(nowMs + PRIORITY_WINDOW_MS);
  if (start >= end) return { titleIds: [], nextCursorMs: 0 };

  const perType = Math.max(1, limit) * 4;
  const snapshots = await Promise.all(PRIORITY_EVENT_TYPES.map((eventType) => db.collection("titleUpdateEvents")
    .where("eventType", "==", eventType)
    .where("status", "==", "published")
    .where("effectiveAt", ">=", start)
    .where("effectiveAt", "<=", end)
    .orderBy("effectiveAt")
    .limit(perType)
    .get()
    .catch(() => null)));

  const rows = [];
  for (const snapshot of snapshots) {
    for (const doc of snapshot?.docs || []) {
      const data = doc.data() || {};
      const titleId = String(data.titleId || "").trim();
      const effectiveAtMs = typeof data.effectiveAt?.toMillis === "function" ? data.effectiveAt.toMillis() : null;
      if (!titleId || !Number.isFinite(effectiveAtMs)) continue;
      rows.push({ titleId, effectiveAtMs });
    }
  }
  rows.sort((left, right) => left.effectiveAtMs - right.effectiveAtMs);

  const titleIds = [];
  let lastMs = 0;
  for (const row of rows) {
    if (!titleIds.includes(row.titleId)) titleIds.push(row.titleId);
    lastMs = row.effectiveAtMs;
    if (titleIds.length >= limit) break;
  }
  // Finestra finita (o quasi): il giro dopo riparte da adesso. Senza questo la
  // corsia si fermerebbe sull'ultima uscita e non tornerebbe piu' indietro.
  const exhausted = rows.length < PRIORITY_EVENT_TYPES.length || titleIds.length < limit;
  return { titleIds, nextCursorMs: exhausted ? 0 : lastMs + 1 };
}

/**
 * Il video in scheda segue il trailer piu' recente che conosciamo.
 *
 * PERCHE' — `enrichTitleAssets` scrive `trailerUrl` solo se il campo e' vuoto
 * (`if (wantTrailer && !existingTrailer)`), quindi ogni titolo mostra per
 * sempre il PRIMO video che abbiamo visto. La serie Harry Potter aveva in
 * scheda il teaser di marzo il giorno in cui usciva quello nuovo: l'evento
 * arrivava in timeline, ma chi apriva la scheda e premeva play vedeva il
 * vecchio.
 *
 * Si sostituisce solo se il video e' piu' recente dell'ultima volta che quel
 * campo e' stato scritto: cosi' un backfill di roba vecchia non torna indietro.
 */
function pickTrailerRefreshes({ candidates = [], titles = [] } = {}) {
  const byId = new Map(titles.map((row) => [String(row?.id || ""), row]));
  const best = new Map();
  for (const candidate of candidates) {
    if (!TRAILER_EVENT_TYPES.has(String(candidate?.eventType || ""))) continue;
    const titleId = String(candidate?.titleId || "");
    const videoId = String(candidate?.sourceId || "");
    const publishedAtMs = Date.parse(String(candidate?.publishedAt || ""));
    if (!titleId || !videoId || !Number.isFinite(publishedAtMs)) continue;
    const current = best.get(titleId);
    if (!current || publishedAtMs > current.publishedAtMs) best.set(titleId, { titleId, videoId, publishedAtMs });
  }

  const out = [];
  for (const row of best.values()) {
    const title = byId.get(row.titleId);
    if (!title) continue;
    const trailerUrl = `https://www.youtube.com/watch?v=${row.videoId}`;
    if (String(title.trailerUrl || "") === trailerUrl) continue;
    const cachedAtMs = typeof title.trailerCachedAt?.toMillis === "function" ? title.trailerCachedAt.toMillis() : 0;
    if (title.trailerUrl && Number.isFinite(cachedAtMs) && cachedAtMs >= row.publishedAtMs) continue;
    out.push({ titleId: row.titleId, trailerUrl });
  }
  return out;
}

async function readScannerBatch({ db, admin, batchSize = SCANNER_BATCH_SIZE }) {
  const stateRef = db.collection("systemJobs").doc("titleUpdateScanner");
  const stateSnap = await stateRef.get().catch(() => null);
  const cursor = String(stateSnap?.data()?.cursor || "").trim();
  const makeQuery = (after) => {
    let query = db.collection("titles")
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(Math.max(1, Math.min(30, Number(batchSize) || SCANNER_BATCH_SIZE)));
    if (after) query = query.startAfter(after);
    return query;
  };

  let snapshot = await makeQuery(cursor).get();
  let wrapped = false;
  if (snapshot.empty && cursor) {
    snapshot = await makeQuery("").get();
    wrapped = true;
  }
  return { stateRef, state: stateSnap?.data() || {}, snapshot, cursor, wrapped };
}

async function scanScheduledTitle({ db, title, state }) {
  const normalized = normalizeTitleForUpdateScan(title);
  if (!normalized || title.status !== "approved") {
    return { title: normalized, candidates: [], errors: [], providerPayload: null };
  }
  const fetchJson = async (tmdbPath, params = {}) => {
    const result = await fetchTmdbCachedJson(tmdbPath, params, {
      db,
      state,
      cacheScope: "scheduledTitleUpdates",
      ttlSeconds: 60 * 60,
      allowStaleOnError: true,
    });
    return result?.data || {};
  };

  const [scan, providerResult, cacheSnap] = await Promise.all([
    scanTitleForUpdateCandidates({ title: normalized, fetchJson }),
    fetchJson(`/${normalized.mediaType}/${normalized.tmdbId}/watch/providers`, {})
      .catch(() => null),
    db.collection("titleProviders").doc(normalized.id).get().catch(() => null),
  ]);
  let providerPayload = null;
  if (providerResult) {
    const providers = normalizeProvidersForRegion(providerResult, "IT");
    const customAdmin = normalizeCustomProviders(cacheSnap?.data()?.customAdmin);
    providerPayload = {
      providers,
      customAdmin,
      watchProviderNames: extractStreamingPlatformNames(providers, customAdmin),
      watchProviderLogos: extractStreamingPlatformLogos(providers, customAdmin),
    };
  }
  // Alla PRIMA scansione di un titolo non sappiamo distinguere una novita' vera
  // da tutto lo storico che TMDB ci restituisce: quel giro resta backfill (mai
  // notificabile). Dalla seconda in poi cio' che compare e' davvero nuovo.
  const previouslyScanned = Number(cacheSnap?.data()?.titleUpdateScanAtMs) > 0;
  return { ...scan, providerPayload, previouslyScanned };
}

async function runScheduledTitleUpdateScan({
  db,
  admin,
  logger,
  nowMs = Date.now(),
  batchSize = SCANNER_BATCH_SIZE,
  titleIds = null,
}) {
  // Modalita' mirata (script ops): stessa pipeline, stesse regole di
  // pubblicazione, ma non tocca il cursore del giro tondo.
  const targetedIds = Array.isArray(titleIds)
    ? titleIds.map((value) => String(value || "").trim()).filter(Boolean)
    : null;
  const targeted = Array.isArray(targetedIds) && targetedIds.length > 0;

  const batch = targeted
    ? { stateRef: db.collection("systemJobs").doc("titleUpdateScanner"), state: {}, snapshot: { docs: [], empty: true }, cursor: "", wrapped: false }
    : await readScannerBatch({ db, admin, batchSize });

  const state = { maxApiCalls: 360, maxAttempts: 3 };
  const rows = batch.snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  // La corsia prioritaria si aggiunge al giro tondo, non lo sostituisce: il
  // catalogo intero va comunque ripassato.
  const priority = targeted
    ? { titleIds: targetedIds, nextCursorMs: Number(batch.state.priorityCursorMs) || 0 }
    : await readPriorityTitleIds({
      db,
      nowMs,
      limit: PRIORITY_BATCH_SIZE,
      cursorMs: Number(batch.state.priorityCursorMs) || 0,
    });
  const alreadyQueued = new Set(rows.map((row) => row.id));
  const extraIds = priority.titleIds.filter((id) => !alreadyQueued.has(id));
  if (extraIds.length) {
    const extraSnaps = await Promise.all(extraIds.map((id) => db.collection("titles").doc(id).get().catch(() => null)));
    for (const snap of extraSnaps) {
      if (snap?.exists) rows.push({ id: snap.id, ...snap.data() });
    }
  }

  if (!rows.length) {
    return { scanned: 0, candidates: 0, created: 0, updated: 0, providerUpdates: 0, errors: 0, wrapped: batch.wrapped };
  }
  const results = [];
  // Tre titoli alla volta: richieste interne parallele, ma senza una raffica
  // incontrollata verso TMDB.
  for (let index = 0; index < rows.length; index += 3) {
    results.push(...await Promise.all(rows.slice(index, index + 3).map((title) =>
      scanScheduledTitle({ db, title, state })
    )));
  }

  // Il gate e' PER TITOLO, non globale: aspettare che l'intero catalogo fosse
  // stato scansionato una volta significava tenere spente le notifiche per
  // settimane e bruciare come "backfill" ogni novita' scoperta nel frattempo.
  // ...con una eccezione, dal 2026-08-26: al PRIMO scan un candidato con data
  // futura non puo' essere storia, quindi non ha bisogno del gate. Senza questa
  // riga un titolo che entra in catalogo poco prima della sua uscita nasce
  // backfill e resta non notificabile per sempre — cioe' proprio le uscite che
  // vogliamo annunciare.
  const alreadyScanned = results.filter((row) => row.previouslyScanned).flatMap((row) => row.candidates);
  const firstScan = splitFutureCandidates(
    results.filter((row) => !row.previouslyScanned).flatMap((row) => row.candidates),
    nowMs
  );

  const liveCandidates = scheduledCandidateWindow([...alreadyScanned, ...firstScan.future], nowMs);
  const backfillCandidates = backfillCandidateWindow(firstScan.past, nowMs);
  const candidates = [...liveCandidates, ...backfillCandidates];
  const [liveReport, backfillReport] = await Promise.all([
    writeTitleUpdateEvents({
      db,
      candidates: liveCandidates,
      acquisitionMode: "live",
      publishEligible: true,
      now: new Date(nowMs),
      maxEvents: 50,
    }),
    writeTitleUpdateEvents({
      db,
      candidates: backfillCandidates,
      acquisitionMode: "backfill",
      publishEligible: true,
      now: new Date(nowMs),
      maxEvents: 50,
    }),
  ]);
  const writeReport = {
    created: liveReport.created + backfillReport.created,
    updated: liveReport.updated + backfillReport.updated,
    errors: [...liveReport.errors, ...backfillReport.errors],
  };

  let providerUpdates = 0;
  let writeBatch = db.batch();
  for (const result of results) {
    if (!result.title) continue;
    const providerRef = db.collection("titleProviders").doc(result.title.id);
    // Marcatore di "titolo gia' visto una volta": e' quello che sblocca la
    // modalita' live al giro successivo. Va scritto anche quando TMDB non ha
    // risposto sui provider, altrimenti quel titolo resta backfill per sempre.
    const providerPatch = {
      titleId: result.title.id,
      tmdbId: result.title.tmdbId,
      type: result.title.mediaType,
      titleUpdateScanAtMs: nowMs,
    };
    if (result.title.mediaType === "tv" && result.sourceSnapshot) {
      Object.assign(providerPatch, {
        tmdbSeriesStatus: result.sourceSnapshot.seriesStatus || null,
        tmdbSeasonsCount: Math.max(0, Number(result.sourceSnapshot.seasonsCount || 0)),
        tmdbNextEpisodeAirDate: result.sourceSnapshot.nextEpisodeAirDate || null,
      });
    }
    if (result.providerPayload) {
      Object.assign(providerPatch, {
        region: "IT",
        providers: result.providerPayload.providers,
        customAdmin: result.providerPayload.customAdmin,
        source: "scheduled_title_updates",
        updatedAtMs: nowMs,
        expiresAtMs: nowMs + (7 * 24 * 60 * 60 * 1000),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      writeBatch.set(db.collection("titles").doc(result.title.id), {
        watchProviderNames: result.providerPayload.watchProviderNames,
        watchProviderLogos: result.providerPayload.watchProviderLogos,
      }, { merge: true });
      providerUpdates += 1;
    }
    writeBatch.set(providerRef, providerPatch, { merge: true });
  }

  const trailerRefreshes = pickTrailerRefreshes({ candidates, titles: rows });
  for (const refresh of trailerRefreshes) {
    writeBatch.set(db.collection("titles").doc(refresh.titleId), {
      trailerUrl: refresh.trailerUrl,
      trailerSource: "title_update_event",
      trailerCachedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  const lastDocumentID = batch.snapshot.docs.at(-1)?.id || "";
  // Con `titleIds` il giro tondo non e' avanzato: riscrivere il cursore lo
  // rimanderebbe all'inizio del catalogo, cioe' altri 2,5 giorni di ritardo.
  writeBatch.set(batch.stateRef, targeted ? {
    lastTargetedRunAtMs: nowMs,
    lastTargetedIds: targetedIds.slice(0, 30),
  } : {
    cursor: lastDocumentID,
    priorityCursorMs: priority.nextCursorMs,
    lastPriorityCount: extraIds.length,
    lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
    lastRunAtMs: nowMs,
    lastBatchSize: rows.length,
    lastCandidateCount: candidates.length,
    lastCreatedCount: writeReport.created,
    lastUpdatedCount: writeReport.updated,
    lastProviderUpdates: providerUpdates,
    lastErrorCount: writeReport.errors.length + results.reduce((sum, row) => sum + row.errors.length, 0),
    wrapped: batch.wrapped,
    initialBackfillCompleted: batch.state.initialBackfillCompleted === true || batch.wrapped,
  }, { merge: true });
  await writeBatch.commit();

  const report = {
    scanned: results.filter((row) => row.title).length,
    firstScan: results.filter((row) => row.title && !row.previouslyScanned).length,
    priority: extraIds.length,
    targeted,
    candidates: candidates.length,
    liveCandidates: liveCandidates.length,
    backfillCandidates: backfillCandidates.length,
    created: writeReport.created,
    updated: writeReport.updated,
    providerUpdates,
    trailerRefreshes: trailerRefreshes.length,
    errors: writeReport.errors.length + results.reduce((sum, row) => sum + row.errors.length, 0),
    wrapped: batch.wrapped,
  };
  logger.info("[titleUpdates] scanner run", report);
  return report;
}

function registerTitleUpdates({ functionsV2Firestore, admin, logger }) {
  const firestoreV2 = functionsV2Firestore || require("firebase-functions/v2/firestore");
  const { onSchedule } = require("firebase-functions/v2/scheduler");
  const { isSeasonPremiere } = require("../lib/titleUpdateNotifications");

  const notifyOnTitleUpdatePublished = firestoreV2.onDocumentWritten(
    {
      document: "titleUpdateEvents/{eventId}",
      region: "europe-west1",
    },
    async (event) => {
      if (!titleUpdateNotificationsEnabled()) {
        logger.info("[titleUpdates] fanout disabilitato dal kill switch");
        return null;
      }

      const before = event.data?.before?.exists ? (event.data.before.data() || {}) : null;
      const after = event.data?.after?.exists ? (event.data.after.data() || {}) : null;

      // Gli episodi appartengono al digest settimanale, non al fan-out
      // immediato. Spegnere solo la sweep a data non bastava: un episodio
      // scoperto **il giorno in cui esce** non aspetta niente e partiva da qui
      // (visto in prod il 2026-08-25, dopo la pausa della sweep). Gli altri
      // tipi — trailer, rinnovi, date, nuove stagioni — restano immediati:
      // sono notizie che invecchiano, non appuntamenti settimanali.
      // Una nuova stagione pero' arriva come `new_episode` episodio 1: fino al
      // 2026-09-10 finiva nel digest anche lei (37 premiere in 30 giorni).
      // Ora passa: se esce oggi parte da qui, se e' futura la manda la sweep
      // delle 9 il giorno giusto.
      if (!titleUpdateDueSweepEnabled()
        && String(after?.eventType || "") === "new_episode"
        && !isSeasonPremiere(after || {})) {
        logger.info("[titleUpdates] episodio lasciato al digest settimanale", {
          eventId: event.params.eventId,
        });
        return null;
      }

      const result = await fanOutTitleUpdate({
        db: admin.firestore(),
        admin,
        eventId: event.params.eventId,
        before,
        after,
      });
      logger.info("[titleUpdates] fanout completato", {
        eventId: event.params.eventId,
        ...result,
      });
      return null;
    }
  );

  const scanTitleUpdates = onSchedule(
    {
      schedule: "every 5 minutes",
      timeZone: "Europe/Rome",
      region: "europe-west1",
      timeoutSeconds: 540,
      memory: "1GiB",
      concurrency: 1,
      maxInstances: 1,
    },
    async () => {
      if (!titleUpdateScannerEnabled()) {
        logger.info("[titleUpdates] scanner disabilitato dal kill switch");
        return null;
      }
      await runScheduledTitleUpdateScan({ db: admin.firestore(), admin, logger });
      return null;
    }
  );

  // Le 9:00 sono l'orario in cui un episodio del giorno e' gia' online sulle
  // piattaforme che pubblicano di notte (Apple TV+, Netflix) e resta comunque
  // mattina per chi lo guarda la sera.
  const notifyDueTitleUpdates = onSchedule(
    {
      schedule: "0 9 * * *",
      timeZone: "Europe/Rome",
      region: "europe-west1",
      timeoutSeconds: 540,
      memory: "512MiB",
      concurrency: 1,
      maxInstances: 1,
    },
    async () => {
      if (!titleUpdateNotificationsEnabled()) {
        logger.info("[titleUpdates] sweep a data disabilitata dal kill switch");
        return null;
      }
      // A sweep per episodio spenta restano le premiere: l'episodio 1 di una
      // stagione e' l'uscita, e il giorno giusto per dirlo e' quello in cui
      // esce. Gli altri episodi viaggiano nel digest settimanale.
      const premieresOnly = !titleUpdateDueSweepEnabled();
      const report = await fanOutDueTitleUpdates({ db: admin.firestore(), admin, premieresOnly });
      logger.info(
        premieresOnly ? "[titleUpdates] sweep premiere completata" : "[titleUpdates] sweep a data completata",
        report
      );
      return null;
    }
  );

  // Trasforma le uscite affidabili dei prossimi 45 giorni in post Somto
  // commentabili. Il modulo usa slug/post id deterministici e conserva lo
  // stesso thread se TMDB corregge la data. Ogni sei ore tiene bassa la
  // latenza senza legare la pubblicazione al giro completo dello scanner.
  const publishReleaseConversationPosts = onSchedule(
    {
      schedule: "17 */6 * * *",
      timeZone: "Europe/Rome",
      region: "europe-west1",
      timeoutSeconds: 540,
      memory: "1GiB",
      concurrency: 1,
      maxInstances: 1,
    },
    async () => {
      if (!releaseConversationPostsEnabled()) {
        logger.info("[release-conversations] pubblicazione disabilitata dal kill switch");
        return null;
      }
      const report = await syncReleaseConversationPosts({ db: admin.firestore(), admin });
      logger.info("[release-conversations] sync completata", report);
      return null;
    }
  );

  return {
    notifyOnTitleUpdatePublished,
    notifyDueTitleUpdates,
    publishReleaseConversationPosts,
    scanTitleUpdates,
  };
}

module.exports = {
  PRIORITY_BATCH_SIZE,
  pickTrailerRefreshes,
  PRIORITY_WINDOW_MS,
  readPriorityTitleIds,
  SCANNER_BATCH_SIZE,
  SCANNER_BACKFILL_FUTURE_MS,
  SCANNER_BACKFILL_LOOKBACK_MS,
  SCANNER_FUTURE_MS,
  SCANNER_LOOKBACK_MS,
  registerTitleUpdates,
  backfillCandidateWindow,
  productionFeatureEnabled,
  releaseConversationPostsEnabled,
  runScheduledTitleUpdateScan,
  scheduledCandidateWindow,
  titleUpdateDueSweepEnabled,
  titleUpdateNotificationsEnabled,
  titleUpdateScannerEnabled,
};
