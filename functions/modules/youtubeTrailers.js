"use strict";

// Scanner dei canali YouTube ufficiali. Vedi lib/youtubeTrailers.js per il
// perche' e per la contabilita' della quota.

const { collectYouTubeTrailerCandidates, mergePendingRows } = require("../lib/youtubeTrailers");
const { writeTitleUpdateEvents } = require("../lib/titleUpdateEvents");

const STATE_PATH = "systemJobs/youtubeTrailerScanner";
const FETCH_TIMEOUT_MS = 15_000;
const REGION = "europe-west1";

function youtubeTrailersEnabled(env = process.env) {
  if (!String(env.YOUTUBE_API_KEY || "").trim()) return false;
  const configured = String(env.YOUTUBE_TRAILERS_ENABLED || "").trim().toLowerCase();
  if (configured) return configured === "true";
  const projectId = String(env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT || "").trim();
  return projectId === "gia-visto";
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`YouTube ${res.status}: ${body.slice(0, 180)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function runYouTubeTrailerScan({ db, admin, logger, env = process.env, nowMs = Date.now() }) {
  const stateRef = db.doc(STATE_PATH);
  const stateSnap = await stateRef.get().catch(() => null);
  const state = stateSnap?.data() || {};

  const collected = await collectYouTubeTrailerCandidates({
    db,
    apiKey: String(env.YOUTUBE_API_KEY || "").trim(),
    fetchJson,
    state,
    nowMs,
  });

  // Due scritture separate perche' cambiano una cosa sola ma decisiva: solo i
  // candidati `live` possono far partire una notifica.
  const byMode = { live: [], backfill: [] };
  for (const candidate of collected.candidates) {
    byMode[candidate.acquisition === "live" ? "live" : "backfill"].push(candidate);
  }
  const [live, backfill] = await Promise.all(["live", "backfill"].map((mode) => writeTitleUpdateEvents({
    db,
    candidates: byMode[mode],
    acquisitionMode: mode,
    publishEligible: true,
    now: new Date(nowMs),
    maxEvents: 50,
  })));

  await stateRef.set({
    channels: collected.channelState,
    lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
    lastRunAtMs: nowMs,
    lastQuotaUsed: collected.quotaUsed,
    lastCandidateCount: collected.candidates.length,
    lastCreatedCount: live.created + backfill.created,
    lastErrorCount: collected.errors.length,
    // Nome ambiguo o titolo fuori catalogo: qui, non negli eventi. E' la coda
    // su cui puo' lavorare la routine editoriale locale.
    pending: mergePendingRows(state.pending, collected.pending),
    errors: collected.errors,
  }, { merge: true });

  const report = {
    candidates: collected.candidates.length,
    created: live.created + backfill.created,
    updated: live.updated + backfill.updated,
    pending: collected.pending.length,
    quotaUsed: collected.quotaUsed,
    errors: collected.errors.length,
  };
  logger.info("[youtubeTrailers] scan", report);
  return report;
}

function registerYouTubeTrailers({ admin, logger }) {
  const { onSchedule } = require("firebase-functions/v2/scheduler");

  // Ogni 30 minuti: a 2 unita' per canale sono ~400 unita' al giorno su 10.000.
  // La frequenza serve a prendere il trailer il giorno in cui esce, che e'
  // tutto il punto dell'operazione.
  const scanYouTubeTrailers = onSchedule(
    {
      schedule: "every 30 minutes",
      timeZone: "Europe/Rome",
      region: REGION,
      timeoutSeconds: 300,
      memory: "512MiB",
      concurrency: 1,
      maxInstances: 1,
      secrets: [],
    },
    async () => {
      if (!youtubeTrailersEnabled()) {
        logger.info("[youtubeTrailers] disabilitato (kill switch o chiave mancante)");
        return null;
      }
      await runYouTubeTrailerScan({ db: admin.firestore(), admin, logger });
      return null;
    }
  );

  return { scanYouTubeTrailers };
}

module.exports = {
  STATE_PATH,
  registerYouTubeTrailers,
  runYouTubeTrailerScan,
  youtubeTrailersEnabled,
};
