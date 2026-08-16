"use strict";

const { fanOutDueTitleUpdates, fanOutTitleUpdate } = require("../lib/titleUpdateNotifications");
const {
  filterCandidatesByWindow,
  normalizeTitleForUpdateScan,
  scanTitleForUpdateCandidates,
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

function productionFeatureEnabled(env, flagName) {
  const configured = String(env[flagName] || "").trim().toLowerCase();
  if (configured) return configured === "true";
  const projectId = String(env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT || "").trim();
  return projectId === "gia-visto";
}

function titleUpdateNotificationsEnabled(env = process.env) {
  return productionFeatureEnabled(env, "TITLE_UPDATE_NOTIFICATIONS_ENABLED");
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

async function runScheduledTitleUpdateScan({ db, admin, logger, nowMs = Date.now(), batchSize = SCANNER_BATCH_SIZE }) {
  const batch = await readScannerBatch({ db, admin, batchSize });
  if (batch.snapshot.empty) {
    return { scanned: 0, candidates: 0, created: 0, updated: 0, providerUpdates: 0, errors: 0, wrapped: batch.wrapped };
  }

  const state = { maxApiCalls: 300, maxAttempts: 3 };
  const rows = batch.snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
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
  const liveCandidates = scheduledCandidateWindow(
    results.filter((row) => row.previouslyScanned).flatMap((row) => row.candidates),
    nowMs
  );
  const backfillCandidates = backfillCandidateWindow(
    results.filter((row) => !row.previouslyScanned).flatMap((row) => row.candidates),
    nowMs
  );
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

  const lastDocumentID = batch.snapshot.docs.at(-1)?.id || "";
  writeBatch.set(batch.stateRef, {
    cursor: lastDocumentID,
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
    candidates: candidates.length,
    liveCandidates: liveCandidates.length,
    backfillCandidates: backfillCandidates.length,
    created: writeReport.created,
    updated: writeReport.updated,
    providerUpdates,
    errors: writeReport.errors.length + results.reduce((sum, row) => sum + row.errors.length, 0),
    wrapped: batch.wrapped,
  };
  logger.info("[titleUpdates] scanner run", report);
  return report;
}

function registerTitleUpdates({ functionsV2Firestore, admin, logger }) {
  const firestoreV2 = functionsV2Firestore || require("firebase-functions/v2/firestore");
  const { onSchedule } = require("firebase-functions/v2/scheduler");

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
      const report = await fanOutDueTitleUpdates({ db: admin.firestore(), admin });
      logger.info("[titleUpdates] sweep a data completata", report);
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
  titleUpdateNotificationsEnabled,
  titleUpdateScannerEnabled,
};
