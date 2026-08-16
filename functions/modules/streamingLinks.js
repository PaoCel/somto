"use strict";

// Dove vivono i link diretti alle piattaforme, e chi li mette li'.
//
// IL GIRO — la scheda titolo chiede i provider (`watchProviders`, gia'
// esistente). Quella risposta ora porta anche `deepLinks`, se li abbiamo. Se non
// li abbiamo e la funzione e' accesa, si risolve UNA volta su Wikidata e si
// salva: il primo utente che apre quel titolo paga la risoluzione, tutti gli
// altri leggono la cache.
//
// DOVE SI SALVANO — dentro `titleProviders/{titleId}`, cioe' il documento che
// gia' contiene i provider per regione, con `deepLinksAt` accanto. Nessuna
// collection nuova, nessuna migrazione: un campo in piu' su un documento che
// esiste gia' e che ha gia' il suo ciclo di vita (TTL, refresh).
//
// I link NON sono per regione (un id Netflix e' lo stesso ovunque), ma vengono
// filtrati su cio' che TMDB dichiara disponibile nella regione richiesta: e' la
// separazione che tiene in piedi tutto — TMDB dice QUALI piattaforme mostrare,
// questo modulo dice DOVE porta il bottone.

const functions = require("firebase-functions/v1");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const {
  canonicalProvider,
  filterByAvailability,
  queryWikidata,
} = require("../lib/wikidataStreamingLinks");

const REGION = "europe-west1";

// Un id di piattaforma non cambia quasi mai; quando cambia, il vecchio link
// redirige. Trenta giorni sono un compromesso fra "non chiedere a Wikidata" e
// "non restare con un link morto per sempre".
const DEEP_LINKS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Interruttore. Spento, tutto il modulo e' inerte e l'app si comporta
 * esattamente come prima — che e' il requisito: questa roba non deve poter
 * peggiorare niente.
 */
function streamingDeepLinksEnabled(env = process.env) {
  const configured = String(env.STREAMING_DEEPLINKS_ENABLED || "").trim().toLowerCase();
  if (configured) return configured === "true";
  return false;
}

function isFresh(deepLinksAtMs, nowMs) {
  const at = Number(deepLinksAtMs);
  return Number.isFinite(at) && at > 0 && (nowMs - at) < DEEP_LINKS_TTL_MS;
}

/**
 * I link diretti di un titolo, dalla cache o da Wikidata.
 *
 * Torna sempre un oggetto (eventualmente vuoto): chi chiama non deve gestire
 * `null`, e un titolo senza link e' un titolo che si comporta come prima.
 */
async function resolveDeepLinksForTitle({
  db,
  titleId,
  tmdbId,
  mediaType,
  availableProviders,
  cached,
  now = Date.now(),
  fetchImpl,
} = {}) {
  if (!streamingDeepLinksEnabled()) return {};
  const numericTmdbId = Math.floor(Number(tmdbId));
  if (!titleId || !Number.isFinite(numericTmdbId) || numericTmdbId <= 0) return {};

  // Nessuna piattaforma disponibile qui = nessun bottone da portare da nessuna
  // parte. Si evita anche la query.
  const wanted = (Array.isArray(availableProviders) ? availableProviders : [])
    .map(canonicalProvider)
    .filter(Boolean);
  if (!wanted.length) return {};

  const cachedLinks = cached?.deepLinks && typeof cached.deepLinks === "object" ? cached.deepLinks : null;
  if (cachedLinks && isFresh(cached?.deepLinksAtMs, now)) {
    return filterByAvailability(cachedLinks, availableProviders);
  }

  const resolved = await queryWikidata({ tmdbIds: [numericTmdbId], mediaType, fetchImpl });
  if (!resolved) {
    // Wikidata non ha risposto (429, timeout, rete): si resta con quel che c'e'
    // in cache, anche se scaduto. Un link di ieri e' meglio di nessun link.
    return cachedLinks ? filterByAvailability(cachedLinks, availableProviders) : {};
  }

  const links = resolved.get(String(numericTmdbId)) || {};
  try {
    await db.collection("titleProviders").doc(titleId).set({
      deepLinks: links,
      deepLinksAtMs: now,
      deepLinksSource: "wikidata",
    }, { merge: true });

    // Denormalizzato sul titolo come `watchProviderNames`: e' quello che leggono
    // il widget e le liste, che non passano dalla callable dei provider.
    const forTitle = filterByAvailability(links, availableProviders);
    await db.collection("titles").doc(titleId).set({
      watchDeepLinks: forTitle,
    }, { merge: true });
  } catch (error) {
    logger.warn("[streamingLinks] scrittura cache fallita", {
      titleId,
      message: String(error?.message || error).slice(0, 160),
    });
  }

  return filterByAvailability(links, availableProviders);
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

/**
 * Riempie i link a poco a poco, partendo dai titoli che hanno gia' provider
 * italiani (cioe' quelli dove il bottone si vedrebbe davvero).
 *
 * Batch piccolo e una query sola per gruppo: Wikidata risponde 429 al terzo
 * gruppo da 40 id consecutivo (misurato), e non c'e' nessuna fretta — un titolo
 * senza link diretto resta un titolo che funziona.
 */
async function runStreamingLinksBackfill({ db, batchSize = 20, now = Date.now(), fetchImpl } = {}) {
  if (!streamingDeepLinksEnabled()) return { skipped: true };

  const stateRef = db.collection("systemJobs").doc("streamingLinksBackfill");
  const stateSnap = await stateRef.get().catch(() => null);
  const cursor = String(stateSnap?.data()?.cursor || "").trim();

  let query = db.collection("titles")
    .orderBy(admin.firestore.FieldPath.documentId())
    .limit(Math.max(1, Math.min(40, batchSize)));
  if (cursor) query = query.startAfter(cursor);

  let snapshot = await query.get();
  let wrapped = false;
  if (snapshot.empty && cursor) {
    snapshot = await db.collection("titles")
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(batchSize)
      .get();
    wrapped = true;
  }
  if (snapshot.empty) return { scanned: 0, resolved: 0, wrapped };

  let resolvedCount = 0;
  for (const doc of snapshot.docs) {
    const title = doc.data() || {};
    const providers = Array.isArray(title.watchProviderNames) ? title.watchProviderNames : [];
    if (!providers.length || !title.tmdbId) continue;
    if (title.watchDeepLinks && Object.keys(title.watchDeepLinks).length) continue;

    const cachedSnap = await db.collection("titleProviders").doc(doc.id).get().catch(() => null);
    const links = await resolveDeepLinksForTitle({
      db,
      titleId: doc.id,
      tmdbId: title.tmdbId,
      mediaType: title.type,
      availableProviders: providers,
      cached: cachedSnap?.data(),
      now,
      fetchImpl,
    });
    if (Object.keys(links).length) resolvedCount += 1;
  }

  await stateRef.set({
    cursor: snapshot.docs.at(-1)?.id || "",
    lastRunAtMs: now,
    lastScanned: snapshot.size,
    lastResolved: resolvedCount,
    wrapped,
  }, { merge: true });

  return { scanned: snapshot.size, resolved: resolvedCount, wrapped };
}

function registerStreamingLinks(exports) {
  // Ogni dieci minuti venti titoli: il catalogo si copre in qualche giorno
  // senza che Wikidata se ne accorga.
  exports.backfillStreamingLinks = functions
    .region(REGION)
    .pubsub.schedule("every 10 minutes")
    .onRun(async () => {
      if (!streamingDeepLinksEnabled()) return null;
      try {
        const report = await runStreamingLinksBackfill({ db: admin.firestore() });
        logger.info("[streamingLinks] backfill", report);
      } catch (error) {
        logger.error("[streamingLinks] backfill fallito", error);
      }
      return null;
    });
}

module.exports = {
  DEEP_LINKS_TTL_MS,
  registerStreamingLinks,
  resolveDeepLinksForTitle,
  runStreamingLinksBackfill,
  streamingDeepLinksEnabled,
};
