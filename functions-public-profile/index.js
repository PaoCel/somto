const functions = require("firebase-functions/v1");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const { enforceCallableRateLimit } = require("./rateLimiter");

if (!admin.apps.length) {
  admin.initializeApp();
}

function toId(value) {
  return String(value || "").trim();
}

function toPositiveInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

const CONTENT_CATEGORIES = ["film", "serie_tv", "cartoni_animati", "anime"];

// Normalizes the cached stats.byCategory map. Keeps the same field names as the
// stored counters and always returns all four categories so clients can render
// a stable layout.
function buildCategoryBreakdown(rawByCategory) {
  const source = rawByCategory && typeof rawByCategory === "object" ? rawByCategory : {};
  const out = {};
  for (const category of CONTENT_CATEGORIES) {
    const bucket = source[category] && typeof source[category] === "object"
      ? source[category]
      : {};
    out[category] = {
      watchedCount: toPositiveInt(bucket.watchedCount),
      ratingsCount: toPositiveInt(bucket.ratingsCount),
      totalWatchMinutes: toPositiveInt(bucket.totalWatchMinutes),
      rewatchCount: toPositiveInt(bucket.rewatchCount),
    };
  }
  return out;
}

exports.getPublicProfileActivitySummary = functions
  .region("europe-west1")
  .https.onCall(async (data, context) => {
    // Richiede login: senza auth era un oracolo di esistenza uid + scraping
    // bulk delle statistiche profilo da qualsiasi origine.
    if (!context.auth?.uid) {
      throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
    }
    const targetUid = toId(data?.userId);
    if (!targetUid) {
      throw new functions.https.HttpsError("invalid-argument", "userId mancante.");
    }

    const userSnap = await admin.firestore().collection("users").doc(targetUid).get();
    if (!userSnap.exists) {
      throw new functions.https.HttpsError("not-found", "Utente non trovato.");
    }

    // stats is kept fresh server-side by the incremental titleStates /
    // listProgressEntries triggers, so just return the cached counters.
    const stats = (userSnap.data() || {}).stats || {};
    return {
      ok: true,
      watchedTitlesCount: toPositiveInt(stats.watchedCount),
      ratedTitlesCount: toPositiveInt(stats.ratingsCount),
      totalWatchMinutes: toPositiveInt(stats.totalWatchMinutes),
      rewatchCount: toPositiveInt(stats.rewatchCount),
      byCategory: buildCategoryBreakdown(stats.byCategory),
    };
  });

// Normalizza la sub-map seriesProgress (nessuno schema forzato a livello rules).
// Tiene gli stessi nomi campo usati dai client (iOS TitleSeriesProgress / PWA
// titleStates.api.js) così la decodifica lato app è 1:1.
function intOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

// Per stagione/episodio "ultimo visto": 0 o negativi non esistono (S0·E0 sul
// badge = nonsense) — stessa semantica del writer (toPositiveInt(x) || null in
// functions/lib/titleStates.js). Clampare QUI copre anche i doc storici scritti
// prima delle guardie, senza aspettare la riparazione dati o una release app.
function positiveIntOrNull(value) {
  const n = intOrNull(value);
  return n != null && n > 0 ? n : null;
}

// NB: logica speculare a functions/lib/titleStates.js#normalizeSeriesProgress (codebase separato, non importabile) — mantenere allineate.
function normalizeSeriesProgress(raw) {
  if (!raw || typeof raw !== "object") return null;

  const totalEpisodeCount = intOrNull(raw.totalEpisodeCount);
  const totalSeasonCount = intOrNull(raw.totalSeasonCount);
  let episodesWatchedCount = toPositiveInt(raw.episodesWatchedCount);
  let seasonsCompletedCount = toPositiveInt(raw.seasonsCompletedCount);

  if (typeof totalEpisodeCount === "number" && totalEpisodeCount > 0) {
    episodesWatchedCount = Math.min(episodesWatchedCount, totalEpisodeCount);
  }
  if (typeof totalSeasonCount === "number" && totalSeasonCount > 0) {
    seasonsCompletedCount = Math.min(seasonsCompletedCount, totalSeasonCount);
  }

  // percentComplete e' una FRAZIONE 0-1 (come functions/lib/titleStates.js#computePercent
  // e come decodificato da iOS TitleSeriesProgress.progressBadgeLabel: clamp 0-1, *100 solo
  // in UI). Non riscalare a 0-100 qui: romperebbe il badge iOS (clamp(0,1) tronca a "100%").
  let percentComplete;
  if (typeof totalEpisodeCount === "number" && totalEpisodeCount > 0) {
    percentComplete = Math.min(1, Math.max(0, episodesWatchedCount / totalEpisodeCount));
  } else {
    const storedPct = Number(raw.percentComplete);
    percentComplete = Number.isFinite(storedPct) ? storedPct : null;
  }

  const lastWatchedEpisodeName = typeof raw.lastWatchedEpisodeName === "string"
    ? raw.lastWatchedEpisodeName.slice(0, 180)
    : null;

  return {
    episodesWatchedCount,
    seasonsCompletedCount,
    totalEpisodeCount,
    totalSeasonCount,
    lastWatchedSeasonNumber: positiveIntOrNull(raw.lastWatchedSeasonNumber),
    lastWatchedEpisodeNumber: positiveIntOrNull(raw.lastWatchedEpisodeNumber),
    lastWatchedEpisodeName,
    lastWatchedAt: raw.lastWatchedAt || null,
    percentComplete,
  };
}

// True se la persona ha davvero iniziato/finito la serie (filtra i meri "salvati
// in watchlist" senza progresso).
function hasWatchSignal(progress, state) {
  if (progress && (progress.episodesWatchedCount > 0
    || progress.seasonsCompletedCount > 0
    || (typeof progress.percentComplete === "number" && progress.percentComplete > 0))) {
    return true;
  }
  return state === "completed" || state === "completed_unrated"
    || state === "in_progress" || state === "rated" || state === "seen_unrated";
}

// Progresso per-serie di un altro utente, per la tab "Visti" del suo profilo.
// I titoli visti sono già contenuto pubblico del profilo (rules: library read =
// isSignedIn), quindi esponiamo il "a che punto è" alla stessa platea. Solo TV:
// per i film non tracciamo il minutaggio. titleStates è owner-only, perciò la
// lettura passa di qui via admin SDK.
exports.getPublicProfileSeriesProgress = functions
  .region("europe-west1")
  .https.onCall(async (data, context) => {
    if (!context.auth?.uid) {
      throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
    }
    const callerUid = context.auth.uid;
    const targetUid = toId(data?.userId);
    if (!targetUid) {
      throw new functions.https.HttpsError("invalid-argument", "userId mancante.");
    }

    try {
      await enforceCallableRateLimit(admin.firestore(), callerUid, "getPublicProfileSeriesProgress", {
        windowSeconds: 12,
        maxInWindow: 8,
        dailyMax: 400,
      });

      const snap = await admin.firestore()
        .collection("users").doc(targetUid)
        .collection("titleStates")
        .where("mediaType", "==", "tv")
        .limit(600)
        .get();

      const progress = {};
      snap.forEach((doc) => {
        const d = doc.data() || {};
        const sp = normalizeSeriesProgress(d.seriesProgress);
        const state = String(d.state || "");
        if (!hasWatchSignal(sp, state)) return;
        progress[doc.id] = Object.assign({ state }, sp || {});
      });

      return { ok: true, progress };
    } catch (e) {
      if (e instanceof functions.https.HttpsError) throw e;
      logger.error("[publicprofile] getPublicProfileSeriesProgress", { callerUid, error: e?.message });
      throw new functions.https.HttpsError("internal", "Errore interno.");
    }
  });

// "Chi la sta guardando": per la scheda di una serie, gli amici (accettati) e le
// persone che il chiamante segue, con il loro progresso su quel titolo. Resta
// dentro il grafo sociale del chiamante (nessuna esposizione di estranei) e
// riguarda solo le serie TV. titleStates altrui = owner-only → lettura admin SDK.
exports.getTitleWatchersProgress = functions
  .region("europe-west1")
  .https.onCall(async (data, context) => {
    const callerUid = context.auth?.uid;
    if (!callerUid) {
      throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
    }
    const titleId = toId(data?.titleId);
    if (!titleId) {
      throw new functions.https.HttpsError("invalid-argument", "titleId mancante.");
    }

    try {
      await enforceCallableRateLimit(admin.firestore(), callerUid, "getTitleWatchersProgress", {
        windowSeconds: 12,
        maxInWindow: 6,
        dailyMax: 300,
      });

      const fs = admin.firestore();
      const [friendsSnap, followingSnap] = await Promise.all([
        fs.collection("users").doc(callerUid).collection("friends")
          .where("status", "==", "accepted").limit(500).get(),
        fs.collection("users").doc(callerUid).collection("following").limit(500).get(),
      ]);

      const uidSet = new Set();
      friendsSnap.forEach((d) => uidSet.add(d.id));
      followingSnap.forEach((d) => uidSet.add(d.id));
      uidSet.delete(callerUid);
      const uids = Array.from(uidSet).slice(0, 300);
      if (!uids.length) return { ok: true, watchers: [] };

      const rows = await Promise.all(uids.map(async (uid) => {
        const tsSnap = await fs.doc(`users/${uid}/titleStates/${titleId}`).get();
        if (!tsSnap.exists) return null;
        const d = tsSnap.data() || {};
        if (String(d.mediaType) !== "tv") return null;
        const sp = normalizeSeriesProgress(d.seriesProgress);
        const state = String(d.state || "");
        if (!hasWatchSignal(sp, state)) return null;

        const userSnap = await fs.collection("users").doc(uid).get();
        if (!userSnap.exists) return null;
        const u = userSnap.data() || {};
        return {
          uid,
          displayName: String(u.displayName || ""),
          photoURL: u.photoURL || u.avatarURL || null,
          isSynthetic: u.isSynthetic === true,
          state,
          seriesProgress: sp,
        };
      }));

      const watchers = rows.filter(Boolean);
      const rank = (w) => {
        if (w.state === "in_progress") return 0;
        if (w.state === "completed" || w.state === "completed_unrated") return 2;
        return 1;
      };
      watchers.sort((a, b) => {
        const ra = rank(a);
        const rb = rank(b);
        if (ra !== rb) return ra - rb;
        return (b.seriesProgress?.episodesWatchedCount || 0)
          - (a.seriesProgress?.episodesWatchedCount || 0);
      });

      return { ok: true, watchers: watchers.slice(0, 60) };
    } catch (e) {
      if (e instanceof functions.https.HttpsError) throw e;
      logger.error("[publicprofile] getTitleWatchersProgress", { callerUid, error: e?.message });
      throw new functions.https.HttpsError("internal", "Errore interno.");
    }
  });
