const functions = require("firebase-functions/v1");
// Gen2 (Eventarc), nome distinto per non toccare l'import gen1 sopra: il
// database Firestore di prod/staging è multi-region `eur3` e i trigger
// Firestore gen1 non sono più creabili su quella location (vedi
// docs/DECISIONS.md + CLAUDE.md "Migrazione functions gen1->gen2"). Primo
// utilizzo nel repo: recomputeCharacterVoteAggregates e
// recomputeTitleCharacterAggregate più sotto. Tutti gli altri trigger
// restano gen1 (`functions.region(...).firestore...`), gen1/gen2 convivono
// nello stesso file/deploy senza conflitti.
const functionsV2Firestore = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const { randomUUID, createHash } = require("crypto");
const { defineString } = require("firebase-functions/params");
const { enforceCallableRateLimit, enforceGuestCallableRateLimit } = require("./lib/rateLimiter");
const { bumpDailyMetric } = require("./lib/productMetrics");
const { commentReviewPresentation } = require("./lib/notificationPresentation");
const {
  isManualProgressTransition,
  normalizeTrackingState,
  buildSuccessfulImportTrackingState,
  buildManualProgressTrackingState,
  computeManualProgressSnapshot,
} = require("./lib/productTracking");
const { buildKnownUsersMap, collectMissingAdderProfileUids } = require("./lib/leaderboard");
const { sanitizeHttpUrl, normalizeCustomProviders, normalizeProvidersForRegion, hasAnyProvidersBundle, extractStreamingPlatformNames, extractStreamingPlatformLogos } = require("./lib/watchProviders");
const { resolveDeepLinksForTitle, registerStreamingLinks } = require("./modules/streamingLinks");
const { collectFeedRecipientUids, uniqueUids, writeFeedEvents, deleteFeedEvents } = require("./lib/feedEvents");
const {
  buildEchoPostId,
  buildEchoPostData,
  isEchoPostData,
  parsePublicThreadId,
} = require("./lib/commentEcho");
const pureUtils = require("./lib/pureUtils");
const { collectCollabSignals, MAX_COLLAB_SEEDS } = require("./lib/itemSimilarity");
const { TITLE_SIMILAR_DOC_ID, rebuildTitleSimilarityIndex } = require("./lib/titleSimilarityJob");
const { TMDB_GENRE_LABELS, toTmdbGenreKey, normalizeGenreKey } = require("./lib/genreLabels");
// Motore di raccomandazione: la parte PURA vive in lib/recommendationEngine.js
// (unit-testabile e riusata identica dal benchmark offline). Qui restano solo le
// funzioni che leggono Firestore e i due callable.
const {
  buildSeedStats,
  parseDecadeWindow,
  yearInsideDecade,
  buildTasteProfile,
  scoreCandidate,
  selectTopWithDiversity,
  mapRecommendedTitle,
  addSeedScore,
  mergeSeedScores,
  buildPeopleAffinity,
  buildProviderAffinity,
  selectProviderRecommendationLane,
  pickMatchDeck,
  mapMatchTitle,
  rankMatchCandidates,
} = require("./lib/recommendationEngine");
const {
  TITLE_STATE_SCHEMA_VERSION,
  estimateTitleTotals,
  computeWatchMinutesContribution,
  buildNextTitleState,
  buildLegacyLibraryProjection,
  buildLegacyWatchlistProjection,
  computeUserStatsFromStateSet,
  computeUserStatsContribution,
  applyTitleRatingToState,
  normalizeStateForTitle,
  isMeaningfulTitleState,
  hasNewContentVsSnapshot,
  deriveContentCategory,
} = require("./lib/titleStates");
const {
  buildTitleDurationMetaPatch,
  titleNeedsDurationEnrichment,
  normalizeTmdbSeasons,
  uniformEpisodesForSeasons,
} = require("./lib/tmdbDurations");
const { recomputeUserStatsForUid: sharedRecomputeUserStatsForUid } = require("./lib/userStats");
const { applyEmotionAggregateDelta, emotionSetsEqual } = require("./lib/emotionAggregate");
const {
  makeEpisodeEmotionBucketId,
  applyEpisodeEmotionAggregateDelta,
  emotionSetsEqual: episodeEmotionSetsEqual,
} = require("./lib/episodeEmotionAggregate");
const { applyDerivedEpisodeDelta, derivedDeltaIsNoop } = require("./lib/derivedRatingAggregate");
const {
  normalizePicks,
  makeEpisodeBucketId,
  applyEpisodeAggregateDelta,
  applyPersonalRollupDelta,
  applyUniqueUserAggregateDelta,
} = require("./lib/characterVoteAggregate");
const {
  ACTION_WEIGHTS,
  normalizedFromRating,
  extractTitleFeatures: extractTasteFeatures,
  applyTitleDelta: applyTasteTitleDelta,
  foldTitleDeltas: foldTasteDeltas,
  buildImportTasteInputs,
  computeConfidenceScore: computeTasteConfidence,
  pruneFeatureSums: pruneTasteFeatureSums,
} = require("./lib/tasteProfileAggregate");
const registerNotifications = require("./modules/notifications");
const { registerQuizInvite } = require("./modules/quizInvite");
const { registerQuizSessionV2 } = require("./modules/quizSessionV2");
const { registerTitlePage } = require("./modules/titlePage");
const { registerQuizPage } = require("./modules/quizPage");
const { registerListPage } = require("./modules/listPage");
const { registerOfficialUpdatePage } = require("./modules/officialUpdatePage");
const { registerUpcomingReleasesFeed } = require("./modules/upcomingReleasesFeed");
const { registerGuidedProfiles } = require("./modules/guidedProfiles");
const { registerOfficialUpdates } = require("./modules/officialUpdates");
const { registerTitleUpdates } = require("./modules/titleUpdates");
const { buildEditorialPatch } = require("./lib/titleUpdateEditorial");
const { registerPushCoverage } = require("./modules/pushCoverage");
const { isGuidedUserData, isGuidedUid, isSyntheticDoc } = require("./modules/guidedProfiles/guards");
const { syncPublicUserListProjection } = require("./modules/publicUserLists");
const { slugify, resolveUniqueSlug } = require("./modules/titleSlug");
const { computeListSlug } = require("./modules/listSlug");
const { parseNetflixCsv } = require("./lib/importAdapters/netflixCsv");
const { parseTvTimeGdprCsvs } = require("./lib/importAdapters/tvTimeGdpr");
const {
  prepareTvTimeLists,
  collectListCandidates,
  buildTvTimeListPlans,
} = require("./lib/importAdapters/tvTimeListsWriter");
const { parseTvTimeRefractJson } = require("./lib/importAdapters/tvTimeRefract");
const { applyAnthologySplitsToRows } = require("./lib/importAdapters/anthologySplit");
const {
  manualImportStoragePaths,
  normalizeManualImportFileKinds,
} = require("./lib/importAdapters/tvTimeRefractStandby");
const {
  parseTvTimeEpisodeVotesCsv,
  parseTvTimeMovieRatingsCsv,
  parseTvTimeMovieEmotionsCsv,
  parseTvTimeMovieCommentsCsv,
  parseTvTimeEpisodeCommentsCsv,
  mergeVotesAndComments,
  buildEmotionStashByTitle,
} = require("./lib/importAdapters/tvTimeRatings");
const { buildTitleResolutionMap, resolveRatingWrites, makeRatingId } = require("./lib/importAdapters/tvTimeRatingsWriter");
const { parseTvTimeShowRatingsCsv } = require("./lib/importAdapters/tvTimeShowRatings");
const {
  selectPublishableEpisodeComments,
  episodeCommentMessageId,
  buildReviewCandidate,
  buildThreadMessage,
} = require("./lib/importAdapters/tvTimeCommentsPublish");
const {
  requestDeviceCode: traktRequestDeviceCode,
  pollDeviceToken: traktPollDeviceToken,
  refreshAccessToken: traktRefreshAccessToken,
  revokeToken: traktRevokeToken,
  fetchTraktLibrary,
  buildTraktImportBlob,
  parseTraktBlob,
  buildTraktRatingIntents,
} = require("./lib/importAdapters/traktSync");
const { resolveTraktRatingWrites } = require("./lib/importAdapters/traktRatingsWriter");
const { resolveRowMatch, matchViaTmdbId } = require("./lib/importAdapters/matching");
const {
  classifyResolution: classifyImportResolution,
  planSkipRemaining: planImportSkipRemaining,
  computeConfirmationStatus: computeImportConfirmationStatus,
  SUGGESTION_ACCEPT_MIN_CONFIDENCE,
} = require("./lib/importAdapters/confirmPlan");
const {
  computeMatchWindow,
  computeEnrichWindow,
  buildMatchResultsFromItems,
  distinctResolvedTitleIds,
} = require("./lib/importAdapters/resumeMatch");
const { buildImportTitleStateWrites } = require("./lib/importAdapters/writeTitleStates");
const { buildImportWarnings } = require("./lib/importAdapters/importWarnings");
const {
  auditedTvTimePayloadSource,
  detectTvTimePayloadSource,
} = require("./lib/importAdapters/importPayloadFormat");
const { persistPreviousTitleStates } = require("./lib/importAdapters/previousStateSnapshots");
const {
  diagnoseImportDoc,
  importFailureErrorCount,
  computeParseErrorRatio,
} = require("./lib/importHealth");
let tmdbModuleCache = null;

function getTmdbModule() {
  if (!tmdbModuleCache) {
    tmdbModuleCache = require("./modules/tmdb");
  }
  return tmdbModuleCache;
}

function getTmdbApiKey(...args) {
  return getTmdbModule().getTmdbApiKey(...args);
}

function fetchTmdbCachedJson(...args) {
  return getTmdbModule().fetchTmdbCachedJson(...args);
}

function fetchTmdbGenreCatalog(...args) {
  return getTmdbModule().fetchTmdbGenreCatalog(...args);
}

function ensureTmdbGenreDocs(...args) {
  return getTmdbModule().ensureTmdbGenreDocs(...args);
}

function fetchTmdbRecentCandidatesForType(...args) {
  return getTmdbModule().fetchTmdbRecentCandidatesForType(...args);
}

function tmdbTitleDocId(...args) {
  return getTmdbModule().tmdbTitleDocId(...args);
}

function tmdbLogicalDuplicateKey(...args) {
  return getTmdbModule().tmdbLogicalDuplicateKey(...args);
}

function existsLogicalDuplicateTitle(...args) {
  return getTmdbModule().existsLogicalDuplicateTitle(...args);
}

function titleDocMediaType(...args) {
  return getTmdbModule().titleDocMediaType(...args);
}

function extractAltNamesLower(...args) {
  return getTmdbModule().extractAltNamesLower(...args);
}

function uploadTmdbPosterToStorage(...args) {
  return getTmdbModule().uploadTmdbPosterToStorage(...args);
}

function buildTmdbTitleDoc(...args) {
  return getTmdbModule().buildTmdbTitleDoc(...args);
}

function upsertTmdbTitle(...args) {
  return getTmdbModule().upsertTmdbTitle(...args);
}

function writeTmdbImportRunReport(...args) {
  return getTmdbModule().writeTmdbImportRunReport(...args);
}

function shuffleRows(...args) {
  return getTmdbModule().shuffleRows(...args);
}

function safeString(...args) {
  return getTmdbModule().safeString(...args);
}

admin.initializeApp();

// ============================================
// CONFIG (via params) per admin e TMDB
// ============================================
const ADMIN_UIDS_PARAM = defineString("ADMIN_UIDS", { default: "" });
const ANALYTICS_EXCLUDED_UIDS_PARAM = defineString("ANALYTICS_EXCLUDED_UIDS", { default: "" });
const PERSONAL_ANALYTICS_ALLOWED_EMAIL_PARAM = defineString("PERSONAL_ANALYTICS_ALLOWED_EMAIL", { default: "" });

function readAdminUids(opts = {}) {
  const allowParamValue = opts?.allowParamValue !== false;
  if (allowParamValue) {
    try {
      const fromParam = String(ADMIN_UIDS_PARAM.value() || "").trim();
      if (fromParam) return fromParam.split(",").map((s) => s.trim()).filter(Boolean);
    } catch (_) {}
  }

  const env = String(process.env.ADMIN_UIDS || "").trim();
  if (env) return env.split(",").map((s) => s.trim()).filter(Boolean);

  try {
    const cfg = functions.config();
    if (Array.isArray(cfg?.admin?.uids)) return cfg.admin.uids.filter(Boolean);
    if (typeof cfg?.admin?.uids === "string") {
      return cfg.admin.uids.split(",").map((s) => s.trim()).filter(Boolean);
    }
  } catch (_) {}
  return [];
}

function getAdminUids() {
  return readAdminUids({ allowParamValue: true });
}

function getAnalyticsExcludedUids() {
  let raw = "";
  try {
    raw = String(ANALYTICS_EXCLUDED_UIDS_PARAM.value() || "").trim();
  } catch (_) {
    raw = String(process.env.ANALYTICS_EXCLUDED_UIDS || "").trim();
  }
  const supportUid = getSupportUid();
  return new Set([
    ...getAdminUids(),
    ...(supportUid ? [supportUid] : []),
    ...raw.split(",").map((s) => s.trim()).filter(Boolean),
  ]);
}

function isExcludedFromProductAnalytics(uid, userData = {}) {
  return !uid
    || getAnalyticsExcludedUids().has(uid)
    || String(uid).startsWith("guided_")
    || isGuidedUserData(userData)
    || userData.isAdmin === true
    || userData.deleted === true;
}

function getSupportUid() {
  const env = String(process.env.SUPPORT_UID || "").trim();
  if (env) return env;

  try {
    const cfg = functions.config();
    const fromConfig = String(cfg?.support?.uid || "").trim();
    if (fromConfig) return fromConfig;
  } catch (_) {}

  return getAdminUids()[0] || "";
}

const ADMIN_UIDS_BOOT = readAdminUids({ allowParamValue: false });
const notificationExports = registerNotifications({
  functions,
  functionsV2Firestore,
  admin,
  logger,
  adminUids: ADMIN_UIDS_BOOT,
  getAdminUids,
});
Object.assign(exports, notificationExports);
Object.assign(exports, registerTitleUpdates({ functionsV2Firestore, admin, logger }));
Object.assign(exports, registerPushCoverage({ admin, logger, getAdminUids }));
// Plain async helper (not a Cloud Function — see notifications.js's return
// comment), used by the titles-import callables to give admins a heads-up
// when a user kicks off an import.
const notifyAdminsImportStarted = notificationExports.notifyAdminsImportStarted;
const notifyFollowersOnManualPost = notificationExports.notifyFollowersOnManualPost;
const notifyAdminsModeration = notificationExports.notifyAdminsModeration;

// Best-effort display name lookup for the admin_import_started notification.
// Mirrors the "nome utente" fallback chain notifyAdminOnUserSignup uses
// (displayName -> username -> email localpart -> generic fallback).
async function getDisplayNameForNotify(db, uid) {
  try {
    const snap = await db.collection("users").doc(uid).get();
    const u = snap.data() || {};
    let name = String(u.displayName || u.username || "").trim();
    if (!name && u.email) name = String(u.email).split("@")[0];
    return name || "Un utente";
  } catch (err) {
    logger.warn("[titlesImport] getDisplayNameForNotify failed", { uid, message: safeString(err?.message || String(err), 200) });
    return "Un utente";
  }
}

// True for any rating written by a bulk viewing-history import (TV Time
// `import_tvtime_gdpr`, Trakt `import_trakt`, and any future `import_*`
// source). The social fan-out triggers (notify friends / create discussion
// thread / feed event) early-return on this so a one-shot import of years-old
// ratings never spams friends — see processTvTimeRatingsAndComments's
// docstring. Prefix-based (not the exact TV Time string) so new import sources
// are covered automatically.
function isBulkImportRatingSource(source) {
  return typeof source === "string" && source.startsWith("import_");
}

// onQuizAttemptCreated (leaderboard_weekly/allTime) rimosso 2026-07-13:
// nessuna UI leggeva quelle collection (la leaderboard usa collectionGroup
// quizStats). Scriveva a vuoto a ogni partita. deleteMyAccount continua a
// ripulire i doc legacy residui.
registerQuizInvite(exports);
registerQuizSessionV2(exports, { functions, admin, enforceCallableRateLimit });
registerTitlePage(exports);
registerQuizPage(exports);
registerListPage(exports);
registerOfficialUpdatePage(exports);
registerUpcomingReleasesFeed(exports);
registerStreamingLinks(exports);
// Profili guidati (synthetic guided profiles): scheduler attivita', callable
// admin (run/dry-run + config/kill switch) e auto-reply DM.
Object.assign(exports, registerGuidedProfiles({ functions, admin, logger, getAdminUids }));
Object.assign(exports, registerOfficialUpdates({
  functions,
  admin,
  logger,
  isAdminCaller,
  enforceCallableRateLimit,
  getAdminUids,
}));

function sanitizeAuthDisplayName(value) {
  const normalized = String(value || "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/[._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24)
    .replace(/^_+|_+$/g, "");

  if (normalized.length >= 3) return normalized;
  if (!normalized) return "User";
  return `${normalized}000`.slice(0, 3);
}

function displayNameForAuthRecord(userRecord = {}) {
  const emailLocalPart = String(userRecord.email || "").split("@")[0] || "";
  return sanitizeAuthDisplayName(userRecord.displayName || emailLocalPart || "User");
}

function authCreationTimestamp(userRecord = {}) {
  const raw = userRecord.metadata?.creationTime;
  const date = raw ? new Date(raw) : null;
  return date && Number.isFinite(date.getTime())
    ? admin.firestore.Timestamp.fromDate(date)
    : admin.firestore.FieldValue.serverTimestamp();
}

function buildAuthPublicUserDoc(userRecord = {}) {
  const displayName = displayNameForAuthRecord(userRecord);
  const photoURL = userRecord.photoURL || "";
  return {
    displayName,
    displayNameLower: displayName.toLowerCase(),
    photoURL,
    avatarURL: photoURL,
    createdAt: authCreationTimestamp(userRecord),
    lastActiveAt: admin.firestore.FieldValue.serverTimestamp(),
    privacyDefault: "public",
    trusted: false,
    isAdmin: false,
    level: "base",
    favoriteGenres: [],
    stats: {
      ratingsCount: 0,
      reviewsCount: 0,
      watchedCount: 0,
      totalWatchMinutes: 0,
      rewatchCount: 0,
    },
  };
}

function buildAuthPrivateUserDoc(userRecord = {}) {
  return {
    ...(userRecord.email ? { email: userRecord.email } : {}),
    onboardingStatus: {
      version: 1,
      startedAt: null,
      completedAt: null,
      completedLevel: 0,
      lastPromptAt: null,
      dismissedAt: null,
      confidenceScore: 0,
    },
    tasteProfile: {
      seedTitleIds: [],
      seedLikedTitleIds: [],
      vibe: [],
      filmVsSeries: "mix",
      mainstream: "mix",
      era: null,
      context: [],
      dislikes: [],
      favoriteTitleText: null,
      contentTolerance: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

function supportThreadIdForUser(uid) {
  return `support_${uid}`;
}

function supportThreadContextIdForUser(uid) {
  return `support_${uid}`;
}

function isSupportThread(thread = {}) {
  const contextId = String(thread.contextId || "");
  return thread.visibility === "private"
    && thread.contextType === "group"
    && contextId.startsWith("support_");
}

async function ensureSupportThreadForUser(db, uid, opts = {}) {
  const userUid = String(uid || "").trim();
  const supportUid = String(opts.supportUid || getSupportUid() || "").trim();
  if (!userUid || !supportUid || userUid === supportUid) {
    return { ok: false, skipped: true, reason: "missing-or-self" };
  }

  const adminUids = getAdminUids();
  if (adminUids.includes(userUid)) {
    return { ok: false, skipped: true, reason: "admin-user" };
  }

  const threadId = supportThreadIdForUser(userUid);
  const threadRef = db.collection("threads").doc(threadId);
  const introMessage = String(opts.message || "").trim()
    || "Ciao, benvenuto su Somto! Questa è la chat di assistenza: puoi scrivere qui per dubbi, problemi o feedback. Ti risponderò il prima possibile. La ritrovi in Messaggi → Assistenza, nell’app oppure sul sito.";
  const now = admin.firestore.FieldValue.serverTimestamp();
  const threadSnap = await threadRef.get().catch(() => null);

  if (threadSnap?.exists) {
    const thread = threadSnap.data() || {};
    const participants = safeArray(thread.participants).map((item) => toId(item)).filter(Boolean);
    if (participants.includes(userUid) && participants.includes(supportUid)) {
      return { ok: true, created: false, threadId };
    }
  }

  const messageRef = threadRef.collection("messages").doc();
  const batch = db.batch();
  batch.set(threadRef, {
    titleId: null,
    visibility: "private",
    contextType: "group",
    contextId: supportThreadContextIdForUser(userUid),
    participants: [supportUid, userUid].sort(),
    groupName: "Assistenza Somto",
    createdBy: supportUid,
    createdAt: now,
    lastMessageAt: now,
    lastMessagePreview: introMessage.slice(0, 100),
    lastSenderUid: supportUid,
    lastMessageId: messageRef.id,
  }, { merge: true });
  batch.set(messageRef, {
    uid: supportUid,
    displayName: "Assistenza Somto",
    text: introMessage,
    type: "text",
    createdAt: now,
  });
  await batch.commit();
  return { ok: true, created: true, threadId };
}

exports.ensureMySupportThread = functions
  .region("europe-west1")
  .https
  .onCall(async (_data, context) => {
    const uid = String(context.auth?.uid || "").trim();
    if (!uid) {
      throw new functions.https.HttpsError("unauthenticated", "Autenticazione richiesta.");
    }

    const result = await ensureSupportThreadForUser(admin.firestore(), uid);
    if (!result?.ok || !result.threadId) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Chat di supporto non disponibile."
      );
    }

    return { ok: true, threadId: result.threadId, created: result.created === true };
  });

exports.ensureUserDocsOnAuthCreate = functions
  .region("europe-west1")
  .auth
  .user()
  .onCreate(async (userRecord) => {
    const uid = String(userRecord?.uid || "").trim();
    if (!uid) return null;

    const db = admin.firestore();
    const userRef = db.collection("users").doc(uid);
    const privateRef = db.collection("usersPrivate").doc(uid);
    const [userSnap, privateSnap] = await Promise.all([
      userRef.get().catch(() => null),
      privateRef.get().catch(() => null),
    ]);

    const batch = db.batch();
    let writes = 0;
    if (!userSnap?.exists) {
      batch.set(userRef, buildAuthPublicUserDoc(userRecord), { merge: true });
      writes += 1;
    }
    if (!privateSnap?.exists) {
      batch.set(privateRef, buildAuthPrivateUserDoc(userRecord), { merge: true });
      writes += 1;
    }
    if (writes) {
      await batch.commit();
      logger.info("[ensureUserDocsOnAuthCreate] created missing user docs", { uid, writes });
    }

    try {
      const supportResult = await ensureSupportThreadForUser(db, uid);
      if (supportResult?.ok) {
        logger.info("[ensureUserDocsOnAuthCreate] support thread ensured", {
          uid,
          threadId: supportResult.threadId,
          created: supportResult.created === true,
        });
      }
    } catch (err) {
      logger.warn("[ensureUserDocsOnAuthCreate] support thread failed", {
        uid,
        error: err?.message || String(err),
      });
    }
    return null;
  });

exports.autoReplyOnSupportThreadMessage = functions
  .region("europe-west1")
  .firestore
  .document("threads/{threadId}/messages/{messageId}")
  .onCreate(async (snap, context) => {
    const msg = snap.data() || {};
    const senderUid = String(msg.uid || "").trim();
    if (!senderUid) return null;

    const supportUid = getSupportUid();
    if (!supportUid || senderUid === supportUid) return null;

    const db = admin.firestore();
    const threadId = context.params.threadId;
    const threadRef = db.collection("threads").doc(threadId);
    const threadSnap = await threadRef.get().catch(() => null);
    if (!threadSnap?.exists) return null;

    const thread = threadSnap.data() || {};
    if (!isSupportThread(thread)) return null;

    const participants = safeArray(thread.participants).map((item) => toId(item)).filter(Boolean);
    if (!participants.includes(senderUid) || !participants.includes(supportUid)) return null;

    const ackRef = threadRef.collection("_system").doc("supportAutoReply");
    const replyRef = threadRef.collection("messages").doc();
    const replyText = "Messaggio ricevuto. Ti rispondo il prima possibile. La conversazione resta in Messaggi → Assistenza, nell’app oppure sul sito.";
    const now = admin.firestore.FieldValue.serverTimestamp();
    const cooldownMs = 24 * 60 * 60 * 1000;

    const created = await db.runTransaction(async (tx) => {
      const ackSnap = await tx.get(ackRef);
      const lastAckMs = toMillis(ackSnap.data()?.lastAckAt);
      if (lastAckMs && (Date.now() - lastAckMs) < cooldownMs) {
        return false;
      }

      tx.set(replyRef, {
        uid: supportUid,
        displayName: "Assistenza Somto",
        text: replyText,
        type: "text",
        createdAt: now,
      });
      tx.set(threadRef, {
        lastMessageId: replyRef.id,
        lastMessageAt: now,
        lastMessagePreview: replyText.slice(0, 100),
        lastSenderUid: supportUid,
      }, { merge: true });
      tx.set(ackRef, {
        lastAckAt: now,
        lastUserMessageId: context.params.messageId,
        updatedAt: now,
      }, { merge: true });
      return true;
    });

    if (created) {
      logger.info("[support] auto reply sent", { threadId, senderUid });
    }
    return null;
  });

// ============================================
// SEO: slug leggibile per i nuovi titoli del catalogo
// ============================================
// Ogni titolo ha un campo `slug` (es. "thor-love-and-thunder-2022") che
// alimenta gli URL pubblici /film/{slug} e /serie/{slug} resi da `titlePage`.
// I titoli storici ricevono lo slug via scripts/backfill-title-slugs.js;
// questo trigger copre i titoli creati da qui in avanti.
//
// onCreate ONLY: scrive lo slug una sola volta, alla creazione del doc — non
// reagisce agli update, quindi non innesca alcun loop di scrittura.
exports.onTitleCreatedSlug = functions
  .region("europe-west1")
  .firestore
  .document("titles/{titleId}")
  .onCreate(async (snap, context) => {
    const data = snap.data() || {};
    // Se il doc è già stato creato con uno slug, non si tocca.
    if (typeof data.slug === "string" && data.slug.trim()) return null;

    const titleId = String(context.params.titleId || snap.id || "").trim();
    if (!titleId) return null;

    const base = slugify(data.name || data.originalName || "", data.year);
    // Nessun nome alfanumerico né anno valido: niente slug, l'URL /film/{docId}
    // continua a funzionare via fallback su docId in titlePage.
    if (!base) return null;

    try {
      const db = admin.firestore();
      // Prefix-scan per le collisioni: lo slug base e ogni variante con
      // suffisso (base-2, base-3, ...) ricadono nell'intervallo
      // [base, base + \uf8ff]. Range su un solo campo: usa solo l'indice
      // automatico di Firestore, nessun indice composito richiesto.
      const collidingSnap = await db
        .collection("titles")
        .where("slug", ">=", base)
        .where("slug", "<=", base + "\uf8ff")
        .select("slug")
        .get();

      const takenSlugs = new Set();
      collidingSnap.forEach((doc) => {
        if (doc.id === titleId) return;
        const existing = (doc.data() || {}).slug;
        if (typeof existing === "string" && existing) takenSlugs.add(existing);
      });

      const slug = resolveUniqueSlug(base, takenSlugs);
      await snap.ref.set(
        { slug, slugUpdatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
    } catch (err) {
      logger.error("[onTitleCreatedSlug] error", err);
    }
    return null;
  });

// ============================================
// Counter incrementale users/{uid}.stats.titlesCreated
// ============================================
// Mantenuto su un campo incrementale così la leaderboard "top adders" può
// fare semplicemente `users.orderBy("stats.titlesCreated","desc").limit(N)`
// invece di scannare l'intera collection `titles` ogni run.
//
// Conta solo i titoli con status == "approved" (come faceva la query legacy)
// per evitare di gonfiare il counter con titoli in moderazione/bozza.
exports.incrementCreatorTitlesCount = functions
  .region("europe-west1")
  .firestore
  .document("titles/{titleId}")
  .onCreate(async (snap) => {
    const data = snap.data() || {};
    const createdBy = typeof data.createdBy === "string" ? data.createdBy.trim() : "";
    if (!createdBy) return null;
    const status = typeof data.status === "string" ? data.status.trim() : "";
    if (status !== "approved") return null;
    try {
      await admin.firestore().doc(`users/${createdBy}`).set(
        { stats: { titlesCreated: admin.firestore.FieldValue.increment(1) } },
        { merge: true }
      );
    } catch (err) {
      logger.error("[incrementCreatorTitlesCount] error", err);
    }
    return null;
  });

exports.decrementCreatorTitlesCount = functions
  .region("europe-west1")
  .firestore
  .document("titles/{titleId}")
  .onDelete(async (snap) => {
    const data = snap.data() || {};
    const createdBy = typeof data.createdBy === "string" ? data.createdBy.trim() : "";
    if (!createdBy) return null;
    const status = typeof data.status === "string" ? data.status.trim() : "";
    if (status !== "approved") return null;
    try {
      await admin.firestore().doc(`users/${createdBy}`).set(
        { stats: { titlesCreated: admin.firestore.FieldValue.increment(-1) } },
        { merge: true }
      );
    } catch (err) {
      logger.error("[decrementCreatorTitlesCount] error", err);
    }
    return null;
  });

// Trigger di transizione: quando lo status di un titolo passa a/da "approved"
// aggiorna il counter del creator di conseguenza, così la cifra resta in
// linea con la query legacy `where status == approved`.
exports.syncCreatorTitlesCountOnStatus = functions
  .region("europe-west1")
  .firestore
  .document("titles/{titleId}")
  .onUpdate(async (change) => {
    const before = (change.before.data() || {});
    const after = (change.after.data() || {});
    const beforeStatus = typeof before.status === "string" ? before.status.trim() : "";
    const afterStatus = typeof after.status === "string" ? after.status.trim() : "";
    if (beforeStatus === afterStatus) return null;
    const createdBy = typeof after.createdBy === "string" ? after.createdBy.trim() : "";
    if (!createdBy) return null;

    const wasApproved = beforeStatus === "approved";
    const isApproved = afterStatus === "approved";
    if (wasApproved === isApproved) return null;

    const delta = isApproved ? 1 : -1;
    try {
      await admin.firestore().doc(`users/${createdBy}`).set(
        { stats: { titlesCreated: admin.firestore.FieldValue.increment(delta) } },
        { merge: true }
      );
    } catch (err) {
      logger.error("[syncCreatorTitlesCountOnStatus] error", err);
    }
    return null;
  });

// ============================================
// Re-engagement: nudge automatico per utenti inattivi
// ============================================
exports.sendInactivityNudges = functions
  .region("europe-west1")
  .pubsub.schedule("every 24 hours")
  .onRun(async () => {
    const db = admin.firestore();
    const nowMs = Date.now();
    const inactiveBefore = admin.firestore.Timestamp.fromMillis(nowMs - INACTIVITY_NUDGE_AFTER_MS);

    let usersSnap;
    try {
      usersSnap = await db
        .collection("users")
        .where("lastActiveAt", "<=", inactiveBefore)
        .limit(220)
        .get();
    } catch (err) {
      logger.error(`[nudge] query error: ${err.message}`);
      return null;
    }

    if (usersSnap.empty) {
      logger.info("[nudge] No inactive users to notify.");
      return null;
    }

    let batch = db.batch();
    let writeOps = 0;
    let sentCount = 0;
    let skippedAdmins = 0;
    let skippedCooldown = 0;
    const adminUids = getAdminUids();

    for (const docSnap of usersSnap.docs) {
      const uid = docSnap.id;
      const u = docSnap.data() || {};

      if (u.isAdmin === true || adminUids.includes(uid)) {
        skippedAdmins++;
        continue;
      }

      const lastNudgeAtMs = toMillis(u.engagement?.lastNudgeAt);
      if (lastNudgeAtMs && (nowMs - lastNudgeAtMs) < INACTIVITY_NUDGE_COOLDOWN_MS) {
        skippedCooldown++;
        continue;
      }

      const notifRef = db.collection("users").doc(uid).collection("notifications").doc();
      batch.set(notifRef, {
        toUid: uid,
        fromUid: "system",
        type: "engagement_nudge",
        data: {
          fromName: "Somto",
          message: "Ci sono nuovi thread e consigli: rientra su Somto",
          ctaUrl: "/",
        },
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + NOTIFICATION_TTL_MS),
      });
      writeOps++;

      batch.set(
        docSnap.ref,
        {
          "engagement.lastNudgeAt": admin.firestore.FieldValue.serverTimestamp(),
          "engagement.nudgeCount": admin.firestore.FieldValue.increment(1),
        },
        { merge: true }
      );
      writeOps++;
      sentCount++;

      if (writeOps >= 400) {
        await batch.commit();
        batch = db.batch();
        writeOps = 0;
      }
    }

    if (writeOps > 0) {
      await batch.commit();
    }

    logger.info(
      `[nudge] sent=${sentCount} skippedAdmins=${skippedAdmins} skippedCooldown=${skippedCooldown} scanned=${usersSnap.size}`
    );
    return null;
  });

// ============================================
// Engagement: notifica amici quando un utente valuta un titolo
// ============================================
const FRIEND_WATCHED_NOTIFICATION_COOLDOWN_MS = 6 * 60 * 60 * 1000;

exports.notifyFriendsOnRating = functions
  .region("europe-west1")
  .firestore
  .document("ratings/{ratingId}")
  .onCreate(async (snap, context) => {
    const rating = snap.data() || {};
    const actorUid = String(rating.uid || "").trim();
    const titleId = String(rating.titleId || "").trim();
    const level = String(rating.level || "title").trim();
    if (!actorUid || !titleId || level !== "title") return null;
    // Bulk historical import (TV Time GDPR, Trakt, …): never spam friends with
    // notifications for years-old viewing history — see
    // processTvTimeRatingsAndComments's docstring.
    if (isBulkImportRatingSource(rating.source)) return null;

    const db = admin.firestore();

    // Get actor name
    const actorDoc = await db.collection("users").doc(actorUid).get().catch(() => null);
    const actorName = actorDoc?.data()?.displayName || "Un amico";

    // Get title name
    const titleDoc = await db.collection("titles").doc(titleId).get().catch(() => null);
    const titleName = titleDoc?.data()?.name || "un titolo";

    // Get accepted friends
    const friendsSnap = await db.collection("users").doc(actorUid)
      .collection("friends")
      .where("status", "==", "accepted")
      .limit(100)
      .get()
      .catch(() => ({ docs: [] }));

    if (friendsSnap.docs.length === 0) return null;

    let sentCount = 0;
    let skippedCooldown = 0;

    for (const friendDoc of friendsSnap.docs) {
      const friendUid = friendDoc.id;
      if (friendUid === actorUid) continue;

      const notifRef = db.collection("users").doc(friendUid).collection("notifications").doc();
      const cooldownRef = db.collection("users").doc(friendUid)
        .collection("_system")
        .doc(`engagementFriendWatched_${actorUid}`);

      const created = await db.runTransaction(async (tx) => {
        const cooldownSnap = await tx.get(cooldownRef);
        const lastSentMs = toMillis(cooldownSnap.data()?.lastSentAt);
        const nowMs = Date.now();
        if (lastSentMs && (nowMs - lastSentMs) < FRIEND_WATCHED_NOTIFICATION_COOLDOWN_MS) {
          return false;
        }

        const now = admin.firestore.FieldValue.serverTimestamp();
        tx.set(notifRef, {
          toUid: friendUid,
          fromUid: actorUid,
          type: "engagement_friend_watched",
          data: {
            fromName: actorName,
            titleId,
            titleName,
            message: `${actorName} ha visto ${titleName}`,
            ctaUrl: `/title.html?id=${encodeURIComponent(titleId)}`,
          },
          read: false,
          createdAt: now,
          expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + 90 * 24 * 60 * 60 * 1000),
        });
        tx.set(cooldownRef, {
          lastSentAt: now,
          lastTitleId: titleId,
          lastTitleName: titleName,
          updatedAt: now,
        }, { merge: true });
        return true;
      });

      if (created) {
        sentCount++;
      } else {
        skippedCooldown++;
      }
    }

    logger.info(`[engagement_friend_watched] actor=${actorUid} title=${titleId} sent=${sentCount} skippedCooldown=${skippedCooldown}`);
    return null;
  });

// ============================================
// Engagement: promemoria watchlist settimanale
// ============================================
const WATCHLIST_REMINDER_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

exports.sendWatchlistReminders = functions
  .region("europe-west1")
  .pubsub.schedule("every 24 hours")
  .onRun(async () => {
    const db = admin.firestore();
    const nowMs = Date.now();

    // Query active users (active in last 30 days but not in last 3 days = lightly disengaged)
    const activeAfter = admin.firestore.Timestamp.fromMillis(nowMs - 30 * 24 * 60 * 60 * 1000);
    const activeBefore = admin.firestore.Timestamp.fromMillis(nowMs - 3 * 24 * 60 * 60 * 1000);

    let usersSnap;
    try {
      usersSnap = await db.collection("users")
        .where("lastActiveAt", ">=", activeAfter)
        .where("lastActiveAt", "<=", activeBefore)
        .limit(200)
        .get();
    } catch (err) {
      logger.error(`[watchlist-reminder] query error: ${err.message}`);
      return null;
    }

    if (usersSnap.empty) {
      logger.info("[watchlist-reminder] No eligible users.");
      return null;
    }

    let batch = db.batch();
    let writeOps = 0;
    let sentCount = 0;
    let skipped = 0;

    for (const userDoc of usersSnap.docs) {
      const uid = userDoc.id;
      const u = userDoc.data() || {};

      // Check cooldown
      const lastReminderMs = toMillis(u.engagement?.lastWatchlistReminderAt);
      if (lastReminderMs && (nowMs - lastReminderMs) < WATCHLIST_REMINDER_COOLDOWN_MS) {
        skipped++;
        continue;
      }

      // Check if user has watchlist items
      const watchSnap = await db.collection("users").doc(uid)
        .collection("watchlist")
        .limit(3)
        .get()
        .catch(() => ({ size: 0, empty: true }));

      if (watchSnap.empty || watchSnap.size < 3) {
        skipped++;
        continue;
      }

      const notifRef = db.collection("users").doc(uid).collection("notifications").doc();
      batch.set(notifRef, {
        toUid: uid,
        fromUid: "system",
        type: "engagement_watchlist_reminder",
        data: {
          fromName: "Somto",
          count: watchSnap.size,
          message: `Hai ${watchSnap.size}+ titoli in watchlist da recuperare`,
          ctaUrl: "/watchlist.html",
        },
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + 90 * 24 * 60 * 60 * 1000),
      });
      writeOps++;

      batch.set(
        userDoc.ref,
        { "engagement.lastWatchlistReminderAt": admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
      writeOps++;
      sentCount++;

      if (writeOps >= 400) {
        await batch.commit();
        batch = db.batch();
        writeOps = 0;
      }
    }

    if (writeOps > 0) await batch.commit();
    logger.info(`[watchlist-reminder] sent=${sentCount} skipped=${skipped} scanned=${usersSnap.size}`);
    return null;
  });

// ============================================
// Engagement: digest settimanale attività amici
// ============================================
const FRIEND_DIGEST_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

exports.sendFriendActivityDigest = functions
  .region("europe-west1")
  .pubsub.schedule("every 168 hours")
  .onRun(async () => {
    const db = admin.firestore();
    const nowMs = Date.now();
    const recentCutoff = admin.firestore.Timestamp.fromMillis(nowMs - 7 * 24 * 60 * 60 * 1000);

    // Active users who haven't received a digest recently
    const activeAfter = admin.firestore.Timestamp.fromMillis(nowMs - 14 * 24 * 60 * 60 * 1000);
    let usersSnap;
    try {
      usersSnap = await db.collection("users")
        .where("lastActiveAt", ">=", activeAfter)
        .limit(300)
        .get();
    } catch (err) {
      logger.error(`[friend-digest] query error: ${err.message}`);
      return null;
    }

    if (usersSnap.empty) return null;

    let batch = db.batch();
    let writeOps = 0;
    let sentCount = 0;

    for (const userDoc of usersSnap.docs) {
      const uid = userDoc.id;
      const u = userDoc.data() || {};

      const lastDigestMs = toMillis(u.engagement?.lastFriendDigestAt);
      if (lastDigestMs && (nowMs - lastDigestMs) < FRIEND_DIGEST_COOLDOWN_MS) continue;

      // Count recent friend activity via friends collection
      const friendsSnap = await db.collection("users").doc(uid)
        .collection("friends")
        .where("status", "==", "accepted")
        .limit(50)
        .get()
        .catch(() => ({ docs: [] }));

      if (friendsSnap.docs.length === 0) continue;

      // Sample: count recent ratings from a few friends
      let friendActivityCount = 0;
      const sampleFriends = friendsSnap.docs.slice(0, 10);
      for (const f of sampleFriends) {
        const recentRatings = await db.collection("ratings")
          .where("uid", "==", f.id)
          .where("updatedAt", ">=", recentCutoff)
          .limit(5)
          .get()
          .catch(() => ({ docs: [] }));
        friendActivityCount += recentRatings.docs.filter((doc) => (
          !isBulkImportRatingSource((doc.data() || {}).source)
        )).length;
      }

      if (friendActivityCount < 2) continue;

      const notifRef = db.collection("users").doc(uid).collection("notifications").doc();
      batch.set(notifRef, {
        toUid: uid,
        fromUid: "system",
        type: "engagement_friend_activity",
        data: {
          fromName: "Somto",
          count: friendActivityCount,
          message: `${friendActivityCount} nuove attività dai tuoi amici questa settimana`,
          ctaUrl: "/",
        },
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + 90 * 24 * 60 * 60 * 1000),
      });
      writeOps++;

      batch.set(
        userDoc.ref,
        { "engagement.lastFriendDigestAt": admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
      writeOps++;
      sentCount++;

      if (writeOps >= 400) {
        await batch.commit();
        batch = db.batch();
        writeOps = 0;
      }
    }

    if (writeOps > 0) await batch.commit();
    logger.info(`[friend-digest] sent=${sentCount} scanned=${usersSnap.size}`);
    return null;
  });

// ============================================
// Cleanup vecchie notifiche e signals
// ============================================
exports.cleanupOldNotifications = functions
  .region("europe-west1")
  .pubsub.schedule("every 24 hours")
  .onRun(async () => {
    const db = admin.firestore();
    const notifCutoff = admin.firestore.Timestamp.fromMillis(Date.now() - NOTIFICATION_TTL_MS);
    const signalCutoff = admin.firestore.Timestamp.fromMillis(Date.now() - SIGNAL_TTL_MS);

    // Cleanup notifications
    let deleted = 0;
    const notifSnap = await db.collectionGroup("notifications")
      .where("createdAt", "<=", notifCutoff)
      .limit(400)
      .get();

    if (!notifSnap.empty) {
      const batch = db.batch();
      notifSnap.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      deleted += notifSnap.size;
    }

    // Cleanup signals
    const signalsSnap = await db.collectionGroup("signals")
      .where("createdAt", "<=", signalCutoff)
      .limit(400)
      .get();

    if (!signalsSnap.empty) {
      const batch = db.batch();
      signalsSnap.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      deleted += signalsSnap.size;
    }

    logger.info(`[cleanup] deleted=${deleted} (notifications + signals)`);
    return null;
  });

// ============================================
// Cleanup cache TMDB scaduta
// ============================================
exports.cleanupTmdbCache = functions
  .region("europe-west1")
  .pubsub.schedule("every 24 hours")
  .onRun(async () => {
    const db = admin.firestore();
    const cutoffMs = Date.now() - DAY_MS;
    let deleted = 0;

    for (let pass = 0; pass < 5; pass++) {
      const snap = await db.collection("tmdbCache")
        .where("expiresAtMs", "<=", cutoffMs)
        .limit(300)
        .get();

      if (snap.empty) break;
      const batch = db.batch();
      snap.docs.forEach((docSnap) => batch.delete(docSnap.ref));
      await batch.commit();
      deleted += snap.size;
    }

    logger.info(`[tmdb-cache] cleanup deleted=${deleted}`);
    return null;
  });

const DAY_MS = 24 * 60 * 60 * 1000;
const INACTIVITY_NUDGE_AFTER_MS = 3 * DAY_MS;
const INACTIVITY_NUDGE_COOLDOWN_MS = 2 * DAY_MS;
const MATCH_SKIP_COOLDOWN_MS = 14 * DAY_MS;
const MATCH_SHOWN_COOLDOWN_MS = 10 * 60 * 60 * 1000;
const MATCH_SEED_RECENCY_MS = 180 * DAY_MS;
const MATCH_FEEDBACK_SCAN_MAX = 900;
const NOTIFICATION_TTL_MS = 90 * DAY_MS;
const SIGNAL_TTL_MS = 120 * DAY_MS;
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";
const TMDB_TITLE_REFRESH_INTERVAL_MS = 15 * DAY_MS;
const TMDB_TITLE_REFRESH_LOCK_MS = 2 * 60 * 1000;
const TMDB_TITLE_REFRESH_RETRY_MS = 15 * DAY_MS;
const TMDB_IMPORT_LIMIT_PER_RUN = clamp(Number(process.env.TMDB_IMPORT_LIMIT_PER_RUN || 150), 20, 240);
const TMDB_IMPORT_RECENT_PAGE_WINDOW = clamp(Number(process.env.TMDB_IMPORT_RECENT_PAGE_WINDOW || 40), 8, 120);
const TMDB_IMPORT_PAGES_PER_TYPE = clamp(Number(process.env.TMDB_IMPORT_PAGES_PER_TYPE || 12), 3, 35);
const TMDB_IMPORT_MIN_REQ_GAP_MS = clamp(Number(process.env.TMDB_IMPORT_MIN_REQ_GAP_MS || 130), 70, 1200);
const TMDB_IMPORT_MAX_API_CALLS = clamp(Number(process.env.TMDB_IMPORT_MAX_API_CALLS || 150), 20, 600);
const WATCHLIST_V2_SCHEMA_VERSION = 2;
const TITLE_METADATA_BACKFILL_VERSION = 2;

// ============================================
// Server-driven feed events (append-only)
// ============================================

function normalizeRatingLevel(value) {
  const level = toId(value || "title");
  return ["title", "season", "episode"].includes(level) ? level : "title";
}

function ratingThreadId(actorUid, titleId, rating = {}) {
  const level = normalizeRatingLevel(rating.level);
  if (level === "season") {
    const season = Number(rating.season || 0);
    return `rating::${actorUid}::${titleId}::season::${Number.isFinite(season) && season > 0 ? Math.floor(season) : 0}`;
  }
  if (level === "episode") {
    const season = Number(rating.season || 0);
    const episode = Number(rating.episode || 0);
    return `rating::${actorUid}::${titleId}::episode::${Number.isFinite(season) && season > 0 ? Math.floor(season) : 0}::${Number.isFinite(episode) && episode > 0 ? Math.floor(episode) : 0}`;
  }
  return `rating::${actorUid}::${titleId}`;
}

function ratingFeedEventKey(ratingId, actorUid, titleId) {
  return `rating:${toId(ratingId)}:${toId(actorUid)}:${toId(titleId)}`;
}

function buildRatingFeedThreadDoc(ratingId, rating) {
  if (!rating || typeof rating !== "object") return null;
  const actorUid = toId(rating.uid);
  const titleId = toId(rating.titleId);
  const level = normalizeRatingLevel(rating.level);
  if (!actorUid || !titleId) return null;

  const eventId = ratingThreadId(actorUid, titleId, rating);
  return {
    eventId,
    data: {
      eventId,
      ratingId: toId(ratingId),
      actorUid,
      titleId,
      level,
      season: level === "season" || level === "episode" ? (Number(rating.season || 0) || null) : null,
      episode: level === "episode" ? (Number(rating.episode || 0) || null) : null,
      createdAt: rating.createdAt || admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: rating.updatedAt || rating.createdAt || admin.firestore.FieldValue.serverTimestamp(),
    },
  };
}

async function syncRatingFeedThreadDoc({ db, ratingId, beforeRating = null, afterRating = null }) {
  const beforeDoc = buildRatingFeedThreadDoc(ratingId, beforeRating);
  const afterDoc = buildRatingFeedThreadDoc(ratingId, afterRating);
  const beforeEventId = beforeDoc?.eventId || null;
  const afterEventId = afterDoc?.eventId || null;

  if (afterDoc) {
    await db.collection("ratingFeed").doc(afterEventId).set(afterDoc.data, { merge: true });
  }

  if (beforeEventId && beforeEventId !== afterEventId) {
    await db.recursiveDelete(db.collection("ratingFeed").doc(beforeEventId));
  }
}

function normalizePostKind(value) {
  return value === "share" ? "share" : "post";
}

function compactText(value, maxLen = 280) {
  return String(value || "").trim().slice(0, maxLen);
}

function compactSharedPost(sharedPost) {
  if (!sharedPost || typeof sharedPost !== "object") return null;
  const postId = toId(sharedPost.postId);
  const authorUid = toId(sharedPost.authorUid);
  if (!postId || !authorUid) return null;
  return {
    postId,
    authorUid,
    authorName: compactText(sharedPost.authorName, 80) || "User",
    text: compactText(sharedPost.text, 500),
    titleId: toId(sharedPost.titleId) || null,
  };
}

function compactWatchedWith(list, max = 12) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const uid = toId(row.uid);
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    out.push({
      uid,
      displayName: compactText(row.displayName, 80) || "Amico",
    });
    if (out.length >= max) break;
  }
  return out;
}

function compactMediaUrls(list, max = 2) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const url = compactText(raw, 600);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= max) break;
  }
  return out;
}

function compactWatchedWithGroup(value) {
  if (!value || typeof value !== "object") return null;
  const threadId = toId(value.threadId);
  if (!threadId) return null;
  return {
    threadId,
    groupName: compactText(value.groupName, 80) || "Gruppo",
  };
}

function safeRatingPart(value) {
  return String(value ?? "0").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function makeTitleRatingDocId(uid, titleId) {
  return [
    safeRatingPart(uid),
    safeRatingPart(titleId),
    "title",
    "0",
    "0",
  ].join("__");
}

function watchedWithMap(list) {
  const map = new Map();
  compactWatchedWith(list || [], 20).forEach((row) => {
    if (!row?.uid || map.has(row.uid)) return;
    map.set(row.uid, row);
  });
  return map;
}

function extractNewWatchedWithRows(beforeList, afterList, actorUid) {
  const before = watchedWithMap(beforeList);
  const after = watchedWithMap(afterList);
  const out = [];
  after.forEach((row, uid) => {
    if (uid === actorUid) return;
    if (!before.has(uid)) out.push(row);
  });
  return out;
}

async function collectRatingFeedRecipientUids(db, actorUid, watchedWithRows) {
  const participantUids = uniqueUids([
    actorUid,
    ...compactWatchedWith(watchedWithRows || []).map((row) => row.uid),
  ]);
  if (!participantUids.length) return [];

  const recipientGroups = await Promise.all(
    participantUids.map((uid) => collectFeedRecipientUids(db, uid))
  );

  return uniqueUids(recipientGroups.flat());
}

async function notifyWatchedWithTaggedUsers({
  db,
  actorUid,
  titleId,
  ratingId,
  watchedWithRows,
}) {
  const rows = compactWatchedWith(watchedWithRows || [])
    .filter((row) => row.uid && row.uid !== actorUid);
  if (!rows.length) return 0;

  const uniqueRows = [];
  const seen = new Set();
  rows.forEach((row) => {
    if (!row?.uid || seen.has(row.uid)) return;
    seen.add(row.uid);
    uniqueRows.push(row);
  });
  if (!uniqueRows.length) return 0;

  const [actorSnap, titleSnap, ratedFlags] = await Promise.all([
    db.collection("users").doc(actorUid).get().catch(() => null),
    db.collection("titles").doc(titleId).get().catch(() => null),
    Promise.all(uniqueRows.map(async (row) => {
      const docId = makeTitleRatingDocId(row.uid, titleId);
      const snap = await db.collection("ratings").doc(docId).get().catch(() => null);
      return !!snap?.exists;
    })),
  ]);

  const fromName = String(actorSnap?.data?.()?.displayName || "").trim() || "Un amico";
  const titleName = String(titleSnap?.data?.()?.name || titleSnap?.data?.()?.originalName || "").trim() || "questo titolo";
  const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + NOTIFICATION_TTL_MS);
  const batch = db.batch();
  const postId = ratingThreadId(actorUid, titleId);

  uniqueRows.forEach((row, idx) => {
    const toUid = row.uid;
    const notifRef = db.collection("users").doc(toUid).collection("notifications").doc();
    batch.set(notifRef, {
      toUid,
      fromUid: actorUid,
      type: "watched_with_tag",
      data: {
        fromName,
        titleId,
        titleName,
        ratingId,
        postId,
      },
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt,
    });

    if (!ratedFlags[idx]) {
      const watchlistRef = db.collection("users").doc(toUid).collection("watchlist").doc(titleId);
      batch.set(watchlistRef, {
        titleId,
        pendingRating: true,
        taggedByUid: actorUid,
        taggedFromRatingId: ratingId,
        taggedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  });

  await batch.commit();
  return uniqueRows.length;
}

async function appendWatchedWithMirrorFeedEvents({
  db,
  sourceActorUid,
  titleId,
  ratingId,
  sourcePath,
  createdAt,
  mediaUrl,
  watchedWithRows,
}) {
  const mirrors = compactWatchedWith(watchedWithRows || [])
    .filter((row) => row.uid && row.uid !== sourceActorUid);
  if (!mirrors.length) return 0;

  const actorSnap = await db.collection("users").doc(sourceActorUid).get().catch(() => null);
  const sourceActorName = String(actorSnap?.data?.()?.displayName || "").trim() || "Amico";
  const allTagged = compactWatchedWith(watchedWithRows || []);

  let writes = 0;
  await Promise.all(mirrors.map(async (mirrorRow) => {
    const mirrorActorUid = mirrorRow.uid;
    const mirrorWatchedWith = [
      { uid: sourceActorUid, displayName: sourceActorName },
      ...allTagged.filter((row) => row.uid !== mirrorActorUid),
    ];
    const recipientUids = await collectFeedRecipientUids(db, mirrorActorUid, { extraUids: [sourceActorUid] });
    const count = await appendFeedEventForRecipients({
      db,
      eventKey: `watch_together:${ratingId}:${mirrorActorUid}`,
      recipientUids,
      payload: {
        actorUid: mirrorActorUid,
        eventType: "watch_together",
        sourceId: ratingId,
        sourcePath,
        createdAt: createdAt || null,
        titleId,
        postId: ratingThreadId(sourceActorUid, titleId),
        mediaUrl: compactText(mediaUrl, 600),
        watchedWith: mirrorWatchedWith,
      },
    });
    writes += count;
  }));

  return writes;
}

function ratingFeedSignature(rating) {
  const watchedWith = compactWatchedWith(rating?.watchedWith || []);
  const photo = compactText(rating?.reviewPhotoUrl, 600);
  const mediaUrls = compactMediaUrls(
    Array.isArray(rating?.mediaUrls) && rating.mediaUrls.length ? rating.mediaUrls : (photo ? [photo] : [])
  );
  const review = compactText(rating?.reviewText, 500);
  const score = Number(rating?.rating || 0);
  const watchedWithGroup = compactWatchedWithGroup(rating?.watchedWithGroup);
  const level = normalizeRatingLevel(rating?.level);
  return JSON.stringify({
    level,
    season: level === "season" || level === "episode" ? (Number(rating?.season || 0) || null) : null,
    episode: level === "episode" ? (Number(rating?.episode || 0) || null) : null,
    rating: Number.isFinite(score) ? score : null,
    review,
    photo,
    mediaUrls,
    watchedWith,
    watchedWithGroup,
  });
}

async function appendFeedEventForRecipients({ db, eventKey, recipientUids, payload }) {
  if (!recipientUids || !recipientUids.length) return 0;
  return writeFeedEvents({
    db,
    recipientUids,
    eventKey,
    payload,
    serverTimestamp: admin.firestore.FieldValue.serverTimestamp(),
  });
}

exports.syncRatingFeedThreadDoc = functions
  .region("europe-west1")
  .firestore
  .document("ratings/{ratingId}")
  .onWrite(async (change, context) => {
    const afterRating = change.after.exists ? (change.after.data() || {}) : null;
    const beforeRating = change.before.exists ? (change.before.data() || {}) : null;
    // Bulk historical import (TV Time GDPR, Trakt, …): never auto-create a
    // public discussion thread for every imported rating — see
    // processTvTimeRatingsAndComments's docstring.
    if (isBulkImportRatingSource(afterRating?.source) || isBulkImportRatingSource(beforeRating?.source)) {
      return null;
    }
    try {
      await syncRatingFeedThreadDoc({
        db: admin.firestore(),
        ratingId: context.params.ratingId,
        beforeRating,
        afterRating,
      });
    } catch (err) {
      logger.error("[ratingFeed] syncRatingFeedThreadDoc error", {
        ratingId: context.params.ratingId,
        error: err?.message || String(err),
      });
    }
    return null;
  });

exports.onRatingCreatedFeedEvent = functions
  .region("europe-west1")
  .firestore
  .document("ratings/{ratingId}")
  .onCreate(async (snap, context) => {
    const rating = snap.data() || {};
    const actorUid = toId(rating.uid);
    const titleId = toId(rating.titleId);
    const level = normalizeRatingLevel(rating.level);
    if (!actorUid || !titleId) return null;
    // Bulk historical import (TV Time GDPR, Trakt, …): never fan out a feed
    // event for every imported rating — see processTvTimeRatingsAndComments's
    // docstring.
    if (isBulkImportRatingSource(rating.source)) return null;

    try {
      const db = admin.firestore();
      const recipientUids = await collectRatingFeedRecipientUids(db, actorUid, rating.watchedWith || []);
      const photo = compactText(rating.reviewPhotoUrl, 600);
      const mediaUrls = compactMediaUrls(
        Array.isArray(rating.mediaUrls) && rating.mediaUrls.length ? rating.mediaUrls : (photo ? [photo] : [])
      );
      await appendFeedEventForRecipients({
        db,
        eventKey: ratingFeedEventKey(context.params.ratingId, actorUid, titleId),
        recipientUids,
        payload: {
          actorUid,
          eventType: "rating",
          sourceId: context.params.ratingId,
          sourcePath: snap.ref.path,
          createdAt: rating.updatedAt || rating.createdAt || null,
          titleId,
          rating: Number(rating.rating || 0),
          postId: ratingThreadId(actorUid, titleId, rating),
          level,
          season: level === "season" || level === "episode" ? (Number(rating.season || 0) || null) : null,
          episode: level === "episode" ? (Number(rating.episode || 0) || null) : null,
          reviewText: compactText(rating.reviewText, 500),
          mediaUrl: mediaUrls[0] || "",
          mediaUrls,
          watchedWith: compactWatchedWith(rating.watchedWith || []),
          watchedWithGroup: compactWatchedWithGroup(rating.watchedWithGroup),
        },
      });
      await notifyWatchedWithTaggedUsers({
        db,
        actorUid,
        titleId,
        ratingId: context.params.ratingId,
        watchedWithRows: rating.watchedWith || [],
      });
    } catch (err) {
      logger.error("[feedEvents] onRatingCreatedFeedEvent error", err);
    }
    return null;
  });

// Quando una serie entra "in corso" per la prima volta pubblica un evento nel
// feed di amici e follower (come per i voti). Il guard su `before.state` evita
// che si rigeneri a ogni episodio segnato successivo.
exports.onSeriesStartedFeedEvent = functions
  .region("europe-west1")
  .firestore
  .document("users/{uid}/titleStates/{titleId}")
  .onWrite(async (change, context) => {
    const after = change.after.exists ? (change.after.data() || {}) : null;
    if (!after) return null;
    // Import massivi (TV Time/Trakt): NON generare un evento feed "ha iniziato
    // a guardare" per ogni serie del back-catalogo importato — sarebbe spam nel
    // feed degli amici e un forte moltiplicatore di read/write (legge i
    // destinatari + scrive un doc feed per ognuno, per migliaia di serie).
    // Stessa guardia dei trigger sui voti; i titleState da import portano
    // source "import_*".
    if (isBulkImportRatingSource(after.source)) return null;
    if (String(after.mediaType || "").trim().toLowerCase() !== "tv") return null;
    if (String(after.state || "") !== "in_progress") return null;
    const before = change.before.exists ? (change.before.data() || {}) : null;
    if (before && String(before.state || "") === "in_progress") return null;

    const actorUid = context.params.uid;
    const titleId = context.params.titleId;
    try {
      const db = admin.firestore();
      const recipientUids = await collectFeedRecipientUids(db, actorUid);
      await appendFeedEventForRecipients({
        db,
        eventKey: `series_started:${actorUid}:${titleId}`,
        recipientUids,
        payload: {
          actorUid,
          eventType: "series_started",
          sourceId: titleId,
          sourcePath: change.after.ref.path,
          createdAt: after.updatedAt || after.lastInteractionAt || null,
          titleId,
        },
      });
    } catch (err) {
      logger.error("[feedEvents] onSeriesStartedFeedEvent error", err);
    }
    return null;
  });

exports.onRatingUpdatedFeedEvent = functions
  .region("europe-west1")
  .firestore
  .document("ratings/{ratingId}")
  .onUpdate(async (change, context) => {
    const before = change.before.data() || {};
    const after = change.after.data() || {};
    const actorUid = toId(after.uid);
    const titleId = toId(after.titleId);
    const level = normalizeRatingLevel(after.level);
    if (!actorUid || !titleId) return null;
    // Bulk historical import (TV Time GDPR, Trakt, …): re-running the import
    // (idempotent merge writes) must never fan out a feed event — see
    // processTvTimeRatingsAndComments's docstring.
    if (isBulkImportRatingSource(after.source) || isBulkImportRatingSource(before.source)) return null;

    if (ratingFeedSignature(before) === ratingFeedSignature(after)) {
      return null;
    }

    try {
      const db = admin.firestore();
      const beforeRecipientUids = await collectRatingFeedRecipientUids(db, actorUid, before.watchedWith || []);
      const recipientUids = await collectRatingFeedRecipientUids(db, actorUid, after.watchedWith || []);
      const eventKey = ratingFeedEventKey(context.params.ratingId, actorUid, titleId);
      const photo = compactText(after.reviewPhotoUrl, 600);
      const mediaUrls = compactMediaUrls(
        Array.isArray(after.mediaUrls) && after.mediaUrls.length ? after.mediaUrls : (photo ? [photo] : [])
      );
      await appendFeedEventForRecipients({
        db,
        eventKey,
        recipientUids,
        payload: {
          actorUid,
          eventType: "rating",
          sourceId: context.params.ratingId,
          sourcePath: change.after.ref.path,
          createdAt: after.updatedAt || after.createdAt || null,
          titleId,
          rating: Number(after.rating || 0),
          postId: ratingThreadId(actorUid, titleId, after),
          level,
          season: level === "season" || level === "episode" ? (Number(after.season || 0) || null) : null,
          episode: level === "episode" ? (Number(after.episode || 0) || null) : null,
          reviewText: compactText(after.reviewText, 500),
          mediaUrl: mediaUrls[0] || "",
          mediaUrls,
          watchedWith: compactWatchedWith(after.watchedWith || []),
          watchedWithGroup: compactWatchedWithGroup(after.watchedWithGroup),
        },
      });

      const removedRecipientUids = beforeRecipientUids.filter((uid) => !recipientUids.includes(uid));
      if (removedRecipientUids.length) {
        await deleteFeedEvents({
          db,
          recipientUids: removedRecipientUids,
          eventKey,
        });
      }

      const newlyTagged = extractNewWatchedWithRows(before.watchedWith || [], after.watchedWith || [], actorUid);
      if (newlyTagged.length) {
        await notifyWatchedWithTaggedUsers({
          db,
          actorUid,
          titleId,
          ratingId: context.params.ratingId,
          watchedWithRows: newlyTagged,
        });
      }
    } catch (err) {
      logger.error("[feedEvents] onRatingUpdatedFeedEvent error", err);
    }
    return null;
  });

exports.onPostCreatedFeedEvent = functions
  .region("europe-west1")
  .firestore
  .document("posts/{postId}")
  .onCreate(async (snap, context) => {
    const post = snap.data() || {};
    const actorUid = toId(post.authorUid);
    const postId = toId(context.params.postId || snap.id);
    if (!actorUid || !postId) return null;
    if (post.skipAutoFeedFanout === true) return null;

    try {
      const db = admin.firestore();
      const postKind = normalizePostKind(post.kind);
      const sharedPost = postKind === "share" ? compactSharedPost(post.sharedPost) : null;
      const recipientUids = await collectFeedRecipientUids(db, actorUid);
      await appendFeedEventForRecipients({
        db,
        eventKey: `post:${context.eventId}`,
        recipientUids,
        payload: {
          actorUid,
          eventType: postKind === "share" ? "post_share" : "post",
          sourceId: postId,
          sourcePath: snap.ref.path,
          createdAt: post.createdAt || post.updatedAt || null,
          postId,
          titleId: toId(post.titleId) || sharedPost?.titleId || null,
          postKind,
          text: compactText(post.text, 500),
          sharedPost,
        },
      });

      // Notifica social (campanella + push) a follower/amici quando un utente
      // pubblica un post A MANO — NON i "post" da voti (i rating non scrivono su
      // /posts). Escludo share, contenuti sintetici e post privati. Riuso i
      // recipientUids del fan-out feed (nessuna read extra); il best-effort
      // interno non lancia mai, quindi non può rompere la creazione del post.
      const isPrivatePost = String(post.visibility || "").trim().toLowerCase() === "private";
      if (postKind === "post" && post.isSynthetic !== true && !isPrivatePost) {
        await notifyFollowersOnManualPost({
          recipientUids,
          actorUid,
          postId,
          titleId: toId(post.titleId) || null,
          preview: compactText(post.text, 200),
        });
      }
    } catch (err) {
      logger.error("[feedEvents] onPostCreatedFeedEvent error", err);
    }
    return null;
  });

exports.onRecommendationCreatedFeedEvent = functions
  .region("europe-west1")
  .firestore
  .document("recommendations/{recId}")
  .onCreate(async (snap, context) => {
    // Le recommendation restano private: niente pubblicazione nel feed Home.
    return null;
  });

exports.onFollowCreatedFeedEvent = functions
  .region("europe-west1")
  .firestore
  .document("users/{uid}/following/{targetUserId}")
  .onCreate(async (snap, context) => {
    const actorUid = toId(context.params.uid);
    const targetUid = toId(context.params.targetUserId || snap.data()?.targetUid);
    if (!actorUid || !targetUid) return null;

    try {
      const db = admin.firestore();
      const recipientUids = await collectFeedRecipientUids(db, actorUid, { extraUids: [targetUid] });
      await appendFeedEventForRecipients({
        db,
        eventKey: `follow:${context.eventId}`,
        recipientUids,
        payload: {
          actorUid,
          eventType: "follow",
          sourceId: `${actorUid}:${targetUid}`,
          sourcePath: snap.ref.path,
          createdAt: snap.data()?.createdAt || null,
          targetUid,
        },
      });
    } catch (err) {
      logger.error("[feedEvents] onFollowCreatedFeedEvent error", err);
    }
    return null;
  });

exports.onPostCommentCreatedFeedEvent = functions
  .region("europe-west1")
  .firestore
  .document("posts/{postId}/comments/{commentId}")
  .onCreate(async (snap, context) => {
    const comment = snap.data() || {};
    const actorUid = toId(comment.uid);
    const postId = toId(context.params.postId);
    if (!actorUid || !postId) return null;

    try {
      const db = admin.firestore();
      const postSnap = await db.collection("posts").doc(postId).get().catch(() => null);
      const postData = postSnap?.exists ? (postSnap.data() || {}) : {};
      const postAuthorUid = toId(postData.authorUid);
      const titleId = toId(postData.titleId);
      const recipientUids = await collectFeedRecipientUids(db, actorUid, {
        extraUids: postAuthorUid ? [postAuthorUid] : [],
      });

      await appendFeedEventForRecipients({
        db,
        eventKey: `post_comment:${context.eventId}`,
        recipientUids,
        payload: {
          actorUid,
          eventType: "post_comment",
          sourceId: context.params.commentId,
          sourcePath: snap.ref.path,
          createdAt: comment.createdAt || null,
          postId,
          titleId: titleId || null,
          targetUid: postAuthorUid || null,
          snippet: compactText(comment.text, 240),
        },
      });
    } catch (err) {
      logger.error("[feedEvents] onPostCommentCreatedFeedEvent error", err);
    }
    return null;
  });

// ============================================
// Eco dei commenti pubblici nel feed Community
// ============================================
//
// Ogni messaggio in un thread pubblico (commento su film / serie / episodio)
// genera un "post gemello" in `posts`, così compare nel feed senza duplicare
// card, like, condivisione e deep-link lato client. Logica pura + shape del
// doc in `lib/commentEcho.js`.
//
// Gen2/europe-west1: il database eur3 non accetta nuovi trigger Firestore
// gen1 (stessa ragione dei trigger characterVotes/episodeEmotions più sotto).
// La conversazione resta UNA sola: le risposte dal feed scrivono nel thread,
// non nei commenti del post gemello.

// `admin.firestore.FieldValue` (convenzione storica di questo file) è
// undefined dentro il runtime dell'emulatore functions: l'import modulare
// funziona in entrambi gli ambienti, quindi il trigger è testabile in locale.
const { FieldValue: AdminFieldValue } = require("firebase-admin/firestore");

async function writeCommentEchoPost({ threadId, messageId, message }) {
  const scope = parsePublicThreadId(threadId);
  if (!scope) return null;

  const db = admin.firestore();
  const threadSnap = await db.collection("threads").doc(threadId).get().catch(() => null);
  const threadData = threadSnap?.exists ? (threadSnap.data() || {}) : null;

  const data = buildEchoPostData({
    threadId,
    messageId,
    message,
    threadData,
    now: AdminFieldValue.serverTimestamp(),
  });
  if (!data) return null;

  const postId = buildEchoPostId(threadId, messageId);
  await db.collection("posts").doc(postId).set({
    ...data,
    createdAt: data.createdAt || AdminFieldValue.serverTimestamp(),
  }, { merge: true });
  return postId;
}

exports.onPublicThreadMessageEchoPost = functionsV2Firestore.onDocumentCreated(
  {
    document: "threads/{tid}/messages/{mid}",
    region: "europe-west1",
  },
  async (event) => {
    const message = event.data?.data() || null;
    if (!message) return null;
    try {
      await writeCommentEchoPost({
        threadId: event.params.tid,
        messageId: event.params.mid,
        message,
      });
    } catch (err) {
      // Best-effort: un eco fallito non deve mai far fallire il messaggio.
      logger.error("[commentEcho] onPublicThreadMessageEchoPost error", err);
    }
    return null;
  }
);

// Cancellazione del messaggio → via anche il post gemello (id deterministico,
// nessuna query necessaria). Idempotente: delete su doc inesistente è un no-op.
exports.onPublicThreadMessageEchoPostDeleted = functionsV2Firestore.onDocumentDeleted(
  {
    document: "threads/{tid}/messages/{mid}",
    region: "europe-west1",
  },
  async (event) => {
    const threadId = String(event.params.tid || "");
    const messageId = String(event.params.mid || "");
    if (!parsePublicThreadId(threadId) || !messageId) return null;
    try {
      await admin.firestore()
        .collection("posts")
        .doc(buildEchoPostId(threadId, messageId))
        .delete();
    } catch (err) {
      logger.error("[commentEcho] onPublicThreadMessageEchoPostDeleted error", err);
    }
    return null;
  }
);

// ============================================
// Share preview (OG) per titolo
// ============================================

// Escapes a value for safe interpolation inside HTML text/attributes.
// Duplicato locale (modules/titlePage.js ha la stessa funzione, qui non
// importiamo per mantenere l'isolamento del modulo SSR).
function shareEscapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Accetta solo URL https:// per src/og:image. Tutto il resto -> fallback
// asset locale, evitando javascript:, data:, http://, ecc.
function safeShareImageUrl(siteUrl, candidate) {
  const fallback = `${siteUrl}/icons/icon-512.png`;
  if (typeof candidate !== "string" || candidate.length === 0) return fallback;
  if (/^https:\/\//i.test(candidate)) return candidate;
  return fallback;
}

exports.shareTitlePreview = functions
  .region("europe-west1")
  .https.onRequest(async (req, res) => {
    try {
      const pathParts = String(req.path || "").split("/").filter(Boolean);
      const titleId = req.query.id || pathParts[pathParts.length - 1];
      if (!titleId) {
        res.status(400).send("Missing title id");
        return;
      }

      const db = admin.firestore();
      const snap = await db.collection("titles").doc(String(titleId)).get();
      if (!snap.exists) {
        res.status(404).send("Title not found");
        return;
      }

      const t = snap.data() || {};
      const siteUrl = "https://somto.it";
      const targetUrl = `${siteUrl}/title.html?id=${encodeURIComponent(titleId)}`;
      const name = safeString(t.name || t.originalName || "Somto", 140);
      const desc = safeString(t.description || t.overview || "Scopri e condividi film e serie TV su Somto.", 200);
      const poster = safeString(t.posterPath || "", 500);
      const rawImageUrl = poster.startsWith("http")
        ? poster
        : `${siteUrl}${poster.startsWith("/") ? "" : "/"}${poster || "icons/icon-512.png"}`;
      const imageUrl = safeShareImageUrl(siteUrl, rawImageUrl);

      const nameEsc = shareEscapeHtml(name);
      const descEsc = shareEscapeHtml(desc);
      const imageUrlEsc = shareEscapeHtml(imageUrl);
      const targetUrlEsc = shareEscapeHtml(targetUrl);

      const html = `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <title>${nameEsc} | Somto</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta property="og:type" content="video.movie">
  <meta property="og:title" content="${nameEsc}">
  <meta property="og:description" content="${descEsc}">
  <meta property="og:image" content="${imageUrlEsc}">
  <meta property="og:url" content="${targetUrlEsc}">
  <meta property="og:site_name" content="Somto">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${nameEsc}">
  <meta name="twitter:description" content="${descEsc}">
  <meta name="twitter:image" content="${imageUrlEsc}">
  <meta http-equiv="refresh" content="0;url=${targetUrlEsc}">
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; padding: 24px; text-align: center; }
    .card { max-width: 480px; margin: 0 auto; }
    img { width: 100%; border-radius: 16px; box-shadow: 0 8px 32px rgba(0,0,0,0.2); }
  </style>
</head>
<body>
  <div class="card">
    <img src="${imageUrlEsc}" alt="${nameEsc}">
    <p>Reindirizzamento a Somto...</p>
  </div>
  <script>window.location.replace(${JSON.stringify(targetUrl)});</script>
</body>
</html>`;

      res.set("Cache-Control", "public, max-age=300, s-maxage=600");
      res.status(200).send(html);
    } catch (err) {
      logger.error("[shareTitlePreview] error", err);
      res.status(500).send("Internal error");
    }
  });

// Questi 6 helper vivono in lib/pureUtils.js e qui sono semplici deleghe: il
// motore di raccomandazione e il benchmark offline devono usare le stesse
// identiche implementazioni, e due copie divergerebbero senza che nessuno se ne
// accorga. Le firme restano invariate per le centinaia di call site sottostanti.
function toMillis(ts) {
  return pureUtils.toMillis(ts);
}

function normalizeText(value) {
  return pureUtils.normalizeText(value);
}

function tokenizeNormalized(value) {
  return pureUtils.tokenizeNormalized(value);
}

function safeArray(value) {
  return pureUtils.safeArray(value);
}

function clamp(n, min, max) {
  return pureUtils.clamp(n, min, max);
}

function toId(value) {
  return pureUtils.toId(value);
}

const COMMUNITY_SAFETY_VERSION = 1;
const THREAD_MESSAGE_HARD_BLOCK_PATTERNS = [
  /\b(kill yourself|kys|i will kill you|ti ammazzo|ti uccido|ammazzati)\b/i,
  /\b(rape|raped|stupr\w*|pedofil\w*|pedo)\b/i,
  /\b(nigger|faggot)\b/i,
];
const THREAD_MESSAGE_MASK_PATTERNS = [
  /\b(fuck|shit|bitch|asshole)\b/gi,
  /\b(cazzo|merda|stronz\w*|troi\w*)\b/gi,
];

function maskMatchedWord(match) {
  const raw = String(match || "").trim();
  return raw ? "*".repeat(clamp(raw.length, 3, 8)) : "***";
}

function countUrlsInText(value) {
  const matches = String(value || "").match(/https?:\/\/|www\./gi);
  return matches ? matches.length : 0;
}

function moderateThreadMessageText(value) {
  let text = String(value || "")
    .replace(/\r\n/g, "\n")
    .trim();

  if (!text) {
    return { rejected: true, reason: "empty", message: "Scrivi un messaggio prima di inviare." };
  }

  if (text.length > 5000) {
    text = text.slice(0, 5000).trim();
  }

  if (!text) {
    return { rejected: true, reason: "empty", message: "Scrivi un messaggio prima di inviare." };
  }

  const normalized = normalizeText(text);
  if (countUrlsInText(text) > 2 || /(.)\1{9,}/.test(text)) {
    return {
      rejected: true,
      reason: "spam",
      message: "Il messaggio sembra spam o abuso e non può essere inviato.",
    };
  }

  for (const pattern of THREAD_MESSAGE_HARD_BLOCK_PATTERNS) {
    if (pattern.test(text) || pattern.test(normalized)) {
      return {
        rejected: true,
        reason: "objectionable",
        message: "Il messaggio contiene contenuti non ammessi dalle regole community.",
      };
    }
  }

  let sanitized = text;
  for (const pattern of THREAD_MESSAGE_MASK_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match) => maskMatchedWord(match));
  }

  if (!normalizeText(sanitized)) {
    return {
      rejected: true,
      reason: "empty_after_filter",
      message: "Il messaggio non può essere pubblicato così com'è.",
    };
  }

  return { rejected: false, text: sanitized };
}

function hasAcceptedCommunitySafety(userDoc) {
  const data = userDoc && typeof userDoc === "object" ? userDoc : {};
  return toMillis(data.communitySafetyAcceptedAt) > 0
    && Number(data.communitySafetyVersion || 0) >= COMMUNITY_SAFETY_VERSION;
}

async function usersAreBlocked(db, leftUid, rightUid) {
  const left = toId(leftUid);
  const right = toId(rightUid);
  if (!left || !right || left === right) return false;

  const [leftBlocksRight, rightBlocksLeft] = await Promise.all([
    db.collection("users").doc(left).collection("blockedUsers").doc(right).get(),
    db.collection("users").doc(right).collection("blockedUsers").doc(left).get(),
  ]);

  return leftBlocksRight.exists || rightBlocksLeft.exists;
}

function normalizeThreadVisibility(thread) {
  if (thread && thread.visibility === "public") return "public";
  if (thread && thread.visibility === "private") return "private";
  if (thread && thread.contextType === "public") return "public";
  return String(thread?.id || "").startsWith("public_") ? "public" : "private";
}

function canUserAccessThread(thread, uid) {
  const userId = toId(uid);
  if (!thread || !userId) return false;

  const participants = safeArray(thread.participants).map((item) => toId(item)).filter(Boolean);
  if (normalizeThreadVisibility(thread) === "public") return true;
  if (participants.includes(userId)) return true;
  return thread.createdBy === userId && participants.length === 0;
}

function parseBase64JpegPayload(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  let contentType = "image/jpeg";
  let base64 = raw;
  const dataUrlMatch = raw.match(/^data:([^;]+);base64,(.+)$/i);
  if (dataUrlMatch) {
    contentType = String(dataUrlMatch[1] || "").trim().toLowerCase();
    base64 = String(dataUrlMatch[2] || "").trim();
  }

  if (!base64 || !/^[A-Za-z0-9+/=\s]+$/.test(base64)) {
    return null;
  }

  if (contentType !== "image/jpeg" && contentType !== "image/jpg") {
    return null;
  }

  try {
    return {
      buffer: Buffer.from(base64.replace(/\s+/g, ""), "base64"),
      contentType: "image/jpeg",
    };
  } catch (_) {
    return null;
  }
}

function buildFirebaseStorageDownloadUrl(bucketName, objectPath, downloadToken) {
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(objectPath)}?alt=media&token=${encodeURIComponent(downloadToken)}`;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function ymdFromDate(date) {
  const d = date instanceof Date ? date : new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function tsToDate(ts) {
  if (!ts) return new Date();
  if (ts.toDate) return ts.toDate();
  if (typeof ts.seconds === "number") return new Date(ts.seconds * 1000);
  return new Date(ts);
}

function parseYearFromDate(dateString) {
  const raw = String(dateString || "").trim();
  if (!raw) return null;
  const m = raw.match(/^(\d{4})-/);
  if (!m) return null;
  const year = Number(m[1]);
  if (!Number.isFinite(year) || year < 1870 || year > 2100) return null;
  return year;
}

function buildPrefixes(nameLower, max = 6) {
  const out = [];
  const base = String(nameLower || "").trim();
  for (let i = 1; i <= Math.min(max, base.length); i++) {
    out.push(base.slice(0, i));
  }
  return out;
}

async function loadGenreLabelMap(db) {
  const map = new Map();

  const register = (rawKey, rawName) => {
    const key = String(rawKey || "").trim();
    const name = safeString(rawName || "", 120).trim();
    if (!key || !name) return;
    map.set(key, name);
    const norm = normalizeGenreKey(key);
    if (norm) map.set(norm, name);
  };

  const registerGenre = (rawId, rawName) => {
    const id = String(rawId || "").trim();
    const name = safeString(rawName || "", 120).trim();
    if (!id || !name) return;
    register(id, name);
    register(name, name);

    const tmdbMatch = id.match(/^tmdb_(\d+)$/i);
    if (tmdbMatch) {
      register(tmdbMatch[1], name);
      register(`tmdb ${tmdbMatch[1]}`, name);
    }
  };

  for (const [id, name] of Object.entries(TMDB_GENRE_LABELS)) {
    registerGenre(id, name);
  }

  try {
    const snap = await db.collection("genres").limit(1200).get();
    snap.docs.forEach((docSnap) => {
      const row = docSnap.data() || {};
      const id = String(docSnap.id || row.id || "").trim();
      const name = String(row.name || "").trim();
      registerGenre(id, name);
    });
  } catch (err) {
    logger.warn(`[genres] label map load failed: ${err.message}`);
  }

  return map;
}

function pickRecentPages(totalPages, count) {
  const maxPage = clamp(Number(totalPages || 1), 1, TMDB_IMPORT_RECENT_PAGE_WINDOW);
  const wanted = clamp(Number(count || 6), 1, maxPage);
  const set = new Set([1]);
  const fixed = [2, 3, 4, 5, 6];
  for (const page of fixed) {
    if (set.size >= wanted) break;
    if (page <= maxPage) set.add(page);
  }
  let guard = 0;
  while (set.size < wanted && guard < wanted * 12) {
    const roll = Math.random();
    const page = roll < 0.75
      ? (1 + Math.floor(Math.pow(Math.random(), 1.8) * maxPage))
      : (1 + Math.floor(Math.random() * maxPage));
    if (page >= 1 && page <= maxPage) set.add(page);
    guard++;
  }
  return [...set].sort((a, b) => a - b);
}

function normalizeTmdbMediaType(value) {
  const media = String(value || "").trim().toLowerCase();
  if (media === "movie" || media === "tv") return media;
  return "movie";
}

function normalizeTmdbLanguage(value) {
  const raw = String(value || "it-IT").trim();
  return /^[a-z]{2}-[A-Z]{2}$/.test(raw) ? raw : "it-IT";
}

function normalizeTmdbRegion(value) {
  const raw = String(value || "IT").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(raw) ? raw : "IT";
}

function isoDateOnly(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function wrapTmdbProxyResult(result, fallback = {}) {
  const payload = (result && typeof result === "object" && "data" in result)
    ? (result.data || fallback)
    : (result || fallback);
  const cache = (result && typeof result === "object" && "cache" in result)
    ? result.cache
    : null;
  return { payload, cache };
}

// Stagioni autorevoli per un titolo curato a mano (merge di piu id TMDB in un
// solo doc): la struttura stagioni vive su Firestore in `meta.seasons`, mentre
// TMDB conosce solo le stagioni del singolo id. Ritorna le stagioni nel
// formato TMDB (`season_number`/`episode_count`/`name`) o null se non curato.
async function curatedSeasonsForTmdbId(db, tmdbId) {
  try {
    const snap = await db.collection("titles")
      .where("mergedTmdbIds", "array-contains", tmdbId)
      .limit(1)
      .get();
    if (snap.empty) return null;
    const meta = snap.docs[0].get("meta") || {};
    const seasons = Array.isArray(meta.seasons) ? meta.seasons : [];
    if (!seasons.length) return null;
    return seasons.map((s) => ({
      season_number: Number(s.season) || 0,
      episode_count: Number(s.episodes) || 0,
      name: s.name || `Stagione ${Number(s.season) || 0}`,
    }));
  } catch (err) {
    logger.warn("[tmdbProxy] curatedSeasonsForTmdbId fallita", {
      tmdbId,
      message: err && err.message,
    });
    return null;
  }
}

// Cap difensivo sul numero di persone per lista (cast/guestStars) restituite
// da seasoncredits/episodecredits — stesso ordine di grandezza del top-20 di
// castWithCharacters, un po' piu' permissivo per non tagliare le guest star
// negli episodi corali.
const TMDB_CREDITS_CAST_CAP = 30;

// Cap del cast COMPLETO (action titlecredits). Piu' alto degli altri perche'
// qui il senso e' proprio "vedili tutti": 120 copre i film corali senza
// lasciare che un payload TMDB anomalo diventi illimitato.
const TMDB_FULL_CAST_CAP = 120;

// Un errore TMDB "non-ok" e' sempre Error("TMDB {status} su {path}: ...")
// (vedi modules/tmdb.js#tmdbFetch), nessun .code dedicato: il 404 si
// riconosce dal messaggio. E' un esito valido e frequente per
// seasoncredits/episodecredits (anime, serie vecchie, episodi senza credits
// su TMDB) — va distinto da un vero errore di servizio.
function isTmdbNotFoundError(err) {
  // `code` e' la via canonica (impostata da tmdbFetch, ed e' anche cio' che
  // impedisce al circuit breaker di contare il 404 come guasto); la regex resta
  // come fallback per errori risalenti da percorsi che non la marcano.
  if (err && err.code === "TMDB_NOT_FOUND") return true;
  return /^TMDB 404\b/.test(String(err?.message || ""));
}

// Normalizza un cast member di /credits o /guest_stars (character e' una
// stringa diretta) alla stessa forma di titles.castWithCharacters, cosi' il
// client (picker "personaggi preferiti", docs/CHARACTER_VOTES_SPEC.md §6) ha
// un solo modello per titolo/stagione/episodio.
function normalizeTmdbCastPerson(raw) {
  const personId = raw?.id ? String(raw.id) : "";
  const name = safeString(raw?.name || raw?.original_name || "", 120);
  if (!personId || !name) return null;
  const character = safeString(raw?.character || "", 160);
  const profilePath = raw?.profile_path
    ? `https://image.tmdb.org/t/p/w500${raw.profile_path}`
    : "";
  const order = Number.isFinite(raw?.order) ? Number(raw.order) : 999;
  return { personId, name, character, profilePath, order };
}

// Normalizza un cast member di /aggregate_credits: il personaggio sta in
// roles[] (un attore puo' avere piu' ruoli nella stagione) — si prende quello
// con piu' episodi e si riporta anche episodeCount, utile al picker per
// distinguere un ricorrente da un'apparizione singola.
function normalizeTmdbAggregateCastPerson(raw) {
  const personId = raw?.id ? String(raw.id) : "";
  const name = safeString(raw?.name || raw?.original_name || "", 120);
  if (!personId || !name) return null;
  const roles = Array.isArray(raw?.roles) ? raw.roles : [];
  const topRole = roles.reduce((best, role) => {
    const count = Math.max(0, Math.floor(Number(role?.episode_count) || 0));
    return !best || count > best.count ? { character: role?.character, count } : best;
  }, null);
  const character = safeString(topRole?.character || "", 160);
  const episodeCount = topRole ? topRole.count : 0;
  const profilePath = raw?.profile_path
    ? `https://image.tmdb.org/t/p/w500${raw.profile_path}`
    : "";
  const order = Number.isFinite(raw?.order) ? Number(raw.order) : 999;
  return { personId, name, character, profilePath, order, episodeCount };
}

function sortAndCapCredits(list, cap) {
  return (Array.isArray(list) ? list : [])
    .slice()
    .sort((a, b) => a.order - b.order)
    .slice(0, cap);
}

exports.sendThreadMessage = functions
  .region("europe-west1")
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid;
    if (!uid) {
      throw new functions.https.HttpsError("unauthenticated", "Devi essere autenticato per usare la chat.");
    }

    const db = admin.firestore();
    await enforceCallableRateLimit(db, uid, "sendThreadMessage", {
      windowSeconds: 10,
      maxInWindow: 12,
      dailyMax: 900,
    });

    const threadId = toId(data?.threadId);
    if (!threadId) {
      throw new functions.https.HttpsError("invalid-argument", "threadId mancante.");
    }

    // Messaggio GIF (picker Giphy): type "gif" + gifUrl su host giphy.com.
    // La caption testuale è opzionale; se presente viene moderata come il testo.
    const isGif = String(data?.type || "") === "gif";
    let gifUrl = "";
    if (isGif) {
      gifUrl = String(data?.gifUrl || "").split("?")[0];
      if (!/^https:\/\/[a-z0-9.-]*giphy\.com\//i.test(gifUrl) || gifUrl.length > 500) {
        throw new functions.https.HttpsError("invalid-argument", "GIF non valida.");
      }
    }

    const moderated = moderateThreadMessageText(data?.text);
    // Per le gif, una caption vuota non è un errore (il contenuto è la GIF).
    if (moderated.rejected && !(isGif && String(data?.text || "").trim() === "")) {
      throw new functions.https.HttpsError("failed-precondition", moderated.message);
    }

    let [threadSnap, userSnap] = await Promise.all([
      db.collection("threads").doc(threadId).get(),
      db.collection("users").doc(uid).get(),
    ]);

    // Public title threads use the deterministic id `public_<titleId>`. Allow
    // auto-creation server-side so iOS clients don't need to do a direct
    // Firestore write (which fails when App Check enforcement is on).
    if (!threadSnap.exists) {
      const ensurePublicTitleId = toId(data?.ensurePublicForTitleId || data?.publicForTitleId);
      const looksPublic = /^public_.+/.test(threadId);
      if (looksPublic && ensurePublicTitleId && `public_${ensurePublicTitleId}` === threadId) {
        await db.collection("threads").doc(threadId).set({
          titleId: ensurePublicTitleId,
          visibility: "public",
          contextType: "public",
          contextId: "global",
          participants: [],
          groupName: "Discussione pubblica",
          createdBy: uid,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          lastMessageAt: null,
          lastMessagePreview: "",
          lastSenderUid: null,
          lastMessageId: null,
        });
        threadSnap = await db.collection("threads").doc(threadId).get();
      }
    }

    if (!threadSnap.exists) {
      throw new functions.https.HttpsError("not-found", "Thread non trovato.");
    }

    if (!userSnap.exists) {
      throw new functions.https.HttpsError("failed-precondition", "Profilo utente non disponibile.");
    }

    const thread = threadSnap.data() || {};
    if (!canUserAccessThread(thread, uid)) {
      throw new functions.https.HttpsError("permission-denied", "Non puoi scrivere in questa conversazione.");
    }

    const user = userSnap.data() || {};
    if (!isSupportThread(thread) && !hasAcceptedCommunitySafety(user)) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Accetta i termini community prima di usare la chat."
      );
    }

    const participants = safeArray(thread.participants).map((item) => toId(item)).filter(Boolean);
    if (normalizeThreadVisibility(thread) !== "public") {
      const otherParticipants = participants.filter((participantUid) => participantUid !== uid);
      for (const participantUid of otherParticipants) {
        if (await usersAreBlocked(db, uid, participantUid)) {
          throw new functions.https.HttpsError(
            "failed-precondition",
            "Questa conversazione non è disponibile perché uno dei partecipanti è bloccato."
          );
        }
      }
    }

    const displayName = safeString(
      user.displayName || context.auth?.token?.name || data?.displayName || "User",
      80
    ).trim() || "User";
    const messageText = String(moderated.text || "").trim();
    const preview = isGif
      ? (messageText ? `GIF · ${messageText}`.slice(0, 100) : "GIF")
      : messageText.replace(/\s+/g, " ").slice(0, 100);

    // Anti-spoiler: opzionali, default false / [] (max 5 titoli).
    const containsSpoiler = data?.containsSpoiler === true;
    const rawSpoilerTitleIds = Array.isArray(data?.spoilerTitleIds) ? data.spoilerTitleIds : [];
    const spoilerTitleIds = rawSpoilerTitleIds
      .map((v) => String(v || "").trim())
      .filter(Boolean)
      .slice(0, 5);

    const threadRef = db.collection("threads").doc(threadId);
    const messageRef = threadRef.collection("messages").doc();
    const batch = db.batch();
    const now = admin.firestore.FieldValue.serverTimestamp();

    batch.set(messageRef, {
      uid,
      displayName,
      text: messageText,
      type: isGif ? "gif" : "text",
      ...(isGif ? { gifUrl } : {}),
      createdAt: now,
      containsSpoiler,
      spoilerTitleIds,
    });

    batch.set(threadRef, {
      lastMessageId: messageRef.id,
      lastMessageAt: now,
      lastMessagePreview: preview,
      lastSenderUid: uid,
    }, { merge: true });

    await batch.commit();

    logger.info("[thread] message sent", {
      threadId,
      messageId: messageRef.id,
      uid,
      visibility: normalizeThreadVisibility(thread),
    });

    return {
      ok: true,
      threadId,
      messageId: messageRef.id,
      text: messageText,
      containsSpoiler,
      spoilerTitleIds,
    };
  });

exports.tmdbProxy = functions
  .region("europe-west1")
  // minInstances: 1 azzera il cold start del proxy TMDB più hot dell'app
  // (~$5/mese di idle). 256MB sono sufficienti, timeout 60s copre eventuali
  // ritardi TMDB. Solo su prod: staging non paga l'istanza calda.
  .runWith({
    memory: "256MB",
    timeoutSeconds: 60,
    minInstances: (process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT) === "gia-visto" ? 1 : 0,
  })
  .https.onCall(async (data, context) => {
    const db = admin.firestore();
    const uid = context.auth?.uid;
    if (!uid) {
      throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
    }
    const action = safeString(data?.action || "", 48).toLowerCase();

    if (!action) {
      throw new functions.https.HttpsError("invalid-argument", "Azione TMDb mancante.");
    }

    await enforceCallableRateLimit(db, uid, "tmdbProxy", {
      windowSeconds: 8,
      maxInWindow: 8,
      dailyMax: 1200,
    });

    const language = normalizeTmdbLanguage(data?.language);
    const region = normalizeTmdbRegion(data?.region);
    const state = {
      maxApiCalls: 45,
      maxAttempts: 3,
    };

    try {
      if (action === "searchmulti") {
        const query = safeString(data?.query || "", 140).trim();
        const page = clamp(Number(data?.page || 1), 1, 3);
        if (!query || query.length < 2) {
          return {
            payload: { page: 1, total_pages: 0, total_results: 0, results: [] },
            cache: { key: "empty_search", hit: true, stale: false, source: "local", scope: "searchMulti", ttlSeconds: 0 },
          };
        }

        const result = await fetchTmdbCachedJson("/search/multi", {
          query,
          language,
          include_adult: false,
          page,
        }, {
          db,
          state,
          cacheScope: "searchMulti",
          ttlSeconds: 4 * 60 * 60,
          allowStaleOnError: true,
        });
        return wrapTmdbProxyResult(result, { page: 1, total_pages: 0, total_results: 0, results: [] });
      }

      if (action === "details") {
        const tmdbId = Number(data?.tmdbId || 0);
        if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
          throw new functions.https.HttpsError("invalid-argument", "tmdbId non valido.");
        }
        const mediaType = normalizeTmdbMediaType(data?.mediaType);
        const path = mediaType === "tv" ? `/tv/${tmdbId}` : `/movie/${tmdbId}`;
        let result = await fetchTmdbCachedJson(path, {
          language,
          append_to_response: "credits,keywords,alternative_titles",
        }, {
          db,
          state,
          cacheScope: "details",
          ttlSeconds: 7 * 24 * 60 * 60,
          allowStaleOnError: true,
        });
        // Titolo curato (merge manuale di piu id TMDB): le stagioni autorevoli
        // sono su Firestore, non quelle del singolo id TMDB.
        if (mediaType === "tv" && result && result.data) {
          const curatedSeasons = await curatedSeasonsForTmdbId(db, tmdbId);
          if (curatedSeasons) {
            result = { ...result, data: { ...result.data, seasons: curatedSeasons } };
          }
        }
        return wrapTmdbProxyResult(result, {});
      }

      if (action === "seasonepisodes") {
        // Episodi (nome + data + overview) di una singola stagione TV.
        // Alimenta la lista episodi per-riga nella scheda titolo (web + iOS):
        // il catalogo Somto non tiene nome/data per episodio, li prende da qui.
        // Read-only, cache 7g, payload sfrondato a cio' che serve al client.
        const tmdbId = Number(data?.tmdbId || 0);
        if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
          throw new functions.https.HttpsError("invalid-argument", "tmdbId non valido.");
        }
        const seasonNumberRaw = Number(data?.season);
        if (!Number.isFinite(seasonNumberRaw) || seasonNumberRaw < 0 || seasonNumberRaw > 500) {
          throw new functions.https.HttpsError("invalid-argument", "season non valido.");
        }
        const seasonNumber = Math.floor(seasonNumberRaw);
        const result = await fetchTmdbCachedJson(`/tv/${tmdbId}/season/${seasonNumber}`, {
          language,
        }, {
          db,
          state,
          cacheScope: "seasonEpisodes",
          ttlSeconds: 7 * 24 * 60 * 60,
          allowStaleOnError: true,
        });
        const rawEpisodes = Array.isArray(result?.data?.episodes) ? result.data.episodes : [];
        const episodes = rawEpisodes
          .map((e) => ({
            episode_number: Number(e?.episode_number) || 0,
            name: safeString(e?.name || "", 200),
            air_date: e?.air_date ? safeString(e.air_date, 10) : null,
            overview: safeString(e?.overview || "", 1000),
            still_path: e?.still_path ? safeString(e.still_path, 200) : null,
            vote_average: Number(e?.vote_average) || 0,
            runtime: Number.isFinite(Number(e?.runtime)) && Number(e.runtime) > 0 ? Number(e.runtime) : null,
          }))
          .filter((e) => e.episode_number > 0)
          .sort((a, b) => a.episode_number - b.episode_number);
        return wrapTmdbProxyResult(
          { data: { season_number: seasonNumber, episodes }, cache: result?.cache || null },
          { season_number: seasonNumber, episodes: [] },
        );
      }

      if (action === "seasoncredits") {
        // Cast ricorrente di una stagione TV con ruoli aggregati (roles[] +
        // episodeCount). Alimenta il picker "personaggi preferiti" per
        // stagione/episodio (docs/CHARACTER_VOTES_SPEC.md §6): in DB c'e'
        // solo castWithCharacters, il top-20 del titolo, non per-stagione.
        // Stesso pattern di seasonepisodes: cache 7g, payload sfrondato.
        const tmdbId = Number(data?.tmdbId || 0);
        if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
          throw new functions.https.HttpsError("invalid-argument", "tmdbId non valido.");
        }
        const seasonNumberRaw = Number(data?.season);
        if (!Number.isFinite(seasonNumberRaw) || seasonNumberRaw < 0 || seasonNumberRaw > 500) {
          throw new functions.https.HttpsError("invalid-argument", "season non valido.");
        }
        const seasonNumber = Math.floor(seasonNumberRaw);

        try {
          const result = await fetchTmdbCachedJson(`/tv/${tmdbId}/season/${seasonNumber}/aggregate_credits`, {
            language,
          }, {
            db,
            state,
            cacheScope: "seasonCredits",
            ttlSeconds: 7 * 24 * 60 * 60,
            allowStaleOnError: true,
          });
          const rawCast = Array.isArray(result?.data?.cast) ? result.data.cast : [];
          const cast = sortAndCapCredits(
            rawCast.map(normalizeTmdbAggregateCastPerson).filter(Boolean),
            TMDB_CREDITS_CAST_CAP
          );
          return wrapTmdbProxyResult(
            { data: { cast }, cache: result?.cache || null },
            { cast: [] }
          );
        } catch (err) {
          // 404 = TMDB non ha i credits di questa stagione (comune su anime
          // e serie vecchie): esito valido, il client fa fallback su
          // castWithCharacters, mai un errore mostrato all'utente.
          if (isTmdbNotFoundError(err)) {
            return { payload: { cast: [], missing: true }, cache: null };
          }
          throw err;
        }
      }

      if (action === "titlecredits") {
        // Cast COMPLETO del titolo. In DB c'e' solo castWithCharacters, il
        // top-20 denormalizzato: basta per l'anteprima della scheda, non per
        // il "vedi tutto il cast". Film -> /credits (character stringa),
        // serie -> /aggregate_credits (roles[], stesso normalizer di
        // seasoncredits). Cache 7g come gli altri credits.
        const tmdbId = Number(data?.tmdbId || 0);
        if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
          throw new functions.https.HttpsError("invalid-argument", "tmdbId non valido.");
        }
        const isTv = String(data?.mediaType || "").toLowerCase() === "tv";
        const path = isTv
          ? `/tv/${tmdbId}/aggregate_credits`
          : `/movie/${tmdbId}/credits`;

        try {
          const result = await fetchTmdbCachedJson(path, { language }, {
            db,
            state,
            cacheScope: "titleCredits",
            ttlSeconds: 7 * 24 * 60 * 60,
            allowStaleOnError: true,
          });
          const rawCast = Array.isArray(result?.data?.cast) ? result.data.cast : [];
          const normalize = isTv ? normalizeTmdbAggregateCastPerson : normalizeTmdbCastPerson;
          const cast = sortAndCapCredits(
            rawCast.map(normalize).filter(Boolean),
            TMDB_FULL_CAST_CAP
          );
          return wrapTmdbProxyResult(
            { data: { cast }, cache: result?.cache || null },
            { cast: [] }
          );
        } catch (err) {
          // Come seasoncredits: il 404 e' un esito valido (il client resta
          // sui 20 denormalizzati), non un errore da mostrare.
          if (isTmdbNotFoundError(err)) {
            return { payload: { cast: [], missing: true }, cache: null };
          }
          throw err;
        }
      }

      if (action === "episodecredits") {
        // Cast + guest star di un singolo episodio (docs/CHARACTER_VOTES_SPEC.md
        // §6): le guest star sono il motivo per cui esiste questa action,
        // tenute su una lista separata dal cast fisso (mai fuse). Stesso
        // pattern di seasonepisodes/seasoncredits: cache 7g, 404 (credits
        // episodio assenti, comune su anime/serie vecchie) = esito valido.
        const tmdbId = Number(data?.tmdbId || 0);
        if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
          throw new functions.https.HttpsError("invalid-argument", "tmdbId non valido.");
        }
        const seasonNumberRaw = Number(data?.season);
        if (!Number.isFinite(seasonNumberRaw) || seasonNumberRaw < 0 || seasonNumberRaw > 500) {
          throw new functions.https.HttpsError("invalid-argument", "season non valido.");
        }
        const episodeNumberRaw = Number(data?.episode);
        if (!Number.isFinite(episodeNumberRaw) || episodeNumberRaw < 0 || episodeNumberRaw > 5000) {
          throw new functions.https.HttpsError("invalid-argument", "episode non valido.");
        }
        const seasonNumber = Math.floor(seasonNumberRaw);
        const episodeNumber = Math.floor(episodeNumberRaw);

        try {
          const result = await fetchTmdbCachedJson(
            `/tv/${tmdbId}/season/${seasonNumber}/episode/${episodeNumber}/credits`,
            { language },
            {
              db,
              state,
              cacheScope: "episodeCredits",
              ttlSeconds: 7 * 24 * 60 * 60,
              allowStaleOnError: true,
            }
          );
          const rawCast = Array.isArray(result?.data?.cast) ? result.data.cast : [];
          const rawGuestStars = Array.isArray(result?.data?.guest_stars) ? result.data.guest_stars : [];
          const cast = sortAndCapCredits(
            rawCast.map(normalizeTmdbCastPerson).filter(Boolean),
            TMDB_CREDITS_CAST_CAP
          );
          const guestStars = sortAndCapCredits(
            rawGuestStars.map(normalizeTmdbCastPerson).filter(Boolean),
            TMDB_CREDITS_CAST_CAP
          );
          return wrapTmdbProxyResult(
            { data: { cast, guestStars }, cache: result?.cache || null },
            { cast: [], guestStars: [] }
          );
        } catch (err) {
          if (isTmdbNotFoundError(err)) {
            return { payload: { cast: [], guestStars: [], missing: true }, cache: null };
          }
          throw err;
        }
      }

      if (action === "videos") {
        const tmdbId = Number(data?.tmdbId || 0);
        if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
          throw new functions.https.HttpsError("invalid-argument", "tmdbId non valido.");
        }
        const mediaType = normalizeTmdbMediaType(data?.mediaType);
        const path = mediaType === "tv" ? `/tv/${tmdbId}/videos` : `/movie/${tmdbId}/videos`;
        const result = await fetchTmdbCachedJson(path, { language }, {
          db,
          state,
          cacheScope: "videos",
          ttlSeconds: 12 * 60 * 60,
          allowStaleOnError: true,
        });
        return wrapTmdbProxyResult(result, { results: [] });
      }

      if (action === "trending") {
        // Tendenze reali della settimana (film+serie, TMDB /trending) per la
        // Home. Read-only, nessun input utente oltre alla lingua, stessa
        // cache e stesso wrapping delle altre azioni.
        const result = await fetchTmdbCachedJson("/trending/all/week", { language }, {
          db,
          state,
          cacheScope: "trending",
          ttlSeconds: 6 * 60 * 60,
          allowStaleOnError: true,
        });
        return wrapTmdbProxyResult(result, { results: [] });
      }

      if (action === "personcredits") {
        // Combined filmography (cast + crew) for a TMDB person. Powers the
        // dynamic Person page import flow on iOS so the app can lazy-import
        // missing titles using the existing TMDB import pipeline.
        const personId = Number(data?.personId || 0);
        if (!Number.isFinite(personId) || personId <= 0) {
          throw new functions.https.HttpsError("invalid-argument", "personId non valido.");
        }
        const result = await fetchTmdbCachedJson(`/person/${personId}/combined_credits`, {
          language,
        }, {
          db,
          state,
          cacheScope: "personCredits",
          ttlSeconds: 24 * 60 * 60,
          allowStaleOnError: true,
        });
        return wrapTmdbProxyResult(result, { cast: [], crew: [], id: personId });
      }

      if (action === "upcomingcinema") {
        const page = clamp(Number(data?.page || 1), 1, 3);
        const [p1, p2] = await Promise.all([
          fetchTmdbCachedJson("/movie/upcoming", {
            language,
            region,
            page,
          }, {
            db,
            state,
            cacheScope: `upcomingCinema_p${page}`,
            ttlSeconds: 6 * 60 * 60,
            allowStaleOnError: true,
          }),
          page === 1 ? fetchTmdbCachedJson("/movie/upcoming", {
            language,
            region,
            page: 2,
          }, {
            db,
            state,
            cacheScope: "upcomingCinema_p2",
            ttlSeconds: 6 * 60 * 60,
            allowStaleOnError: true,
          }) : Promise.resolve({ data: { results: [] } }),
        ]);

        const combined = [
          ...((p1.data || {}).results || []),
          ...((p2.data || {}).results || []),
        ];

        return {
          payload: {
            page: 1,
            total_pages: (p1.data || {}).total_pages || 0,
            total_results: (p1.data || {}).total_results || 0,
            results: combined,
          },
          cache: p1.cache || null,
        };
      }

      if (action === "upcomingstreaming") {
        const days = clamp(Number(data?.days || 90), 7, 180);
        const today = new Date();
        const end = new Date();
        end.setDate(today.getDate() + days);
        const gte = isoDateOnly(today);
        const lte = isoDateOnly(end);

        const movieParams = (pg) => ({
          language,
          "primary_release_date.gte": gte,
          "primary_release_date.lte": lte,
          sort_by: "popularity.desc",
          page: pg,
        });
        const tvParams = (pg) => ({
          language,
          "air_date.gte": gte,
          "air_date.lte": lte,
          sort_by: "popularity.desc",
          page: pg,
        });
        const cacheOpts = (scope) => ({
          db,
          state,
          cacheScope: scope,
          ttlSeconds: 6 * 60 * 60,
          allowStaleOnError: true,
        });

        const [mP1, mP2, mP3, tP1, tP2, tP3] = await Promise.all([
          fetchTmdbCachedJson("/discover/movie", movieParams(1), cacheOpts("upDisMovie_p1")),
          fetchTmdbCachedJson("/discover/movie", movieParams(2), cacheOpts("upDisMovie_p2")),
          fetchTmdbCachedJson("/discover/movie", movieParams(3), cacheOpts("upDisMovie_p3")),
          fetchTmdbCachedJson("/discover/tv", tvParams(1), cacheOpts("upDisTv_p1")),
          fetchTmdbCachedJson("/discover/tv", tvParams(2), cacheOpts("upDisTv_p2")),
          fetchTmdbCachedJson("/discover/tv", tvParams(3), cacheOpts("upDisTv_p3")),
        ]);

        const movieResults = [
          ...((mP1.data || {}).results || []),
          ...((mP2.data || {}).results || []),
          ...((mP3.data || {}).results || []),
        ];
        const showResults = [
          ...((tP1.data || {}).results || []),
          ...((tP2.data || {}).results || []),
          ...((tP3.data || {}).results || []),
        ];

        return {
          payload: {
            movies: { results: movieResults },
            shows: { results: showResults },
          },
          cache: {
            movie: mP1.cache || null,
            tv: tP1.cache || null,
          },
        };
      }

      throw new functions.https.HttpsError("invalid-argument", `Azione TMDb non supportata: ${action}`);
    } catch (err) {
      if (err instanceof functions.https.HttpsError) throw err;
      logger.warn("[tmdbProxy] request failed", {
        action,
        uid: uid || "anon",
        code: err?.code || "",
        message: safeString(err?.message || String(err), 220),
      });
      if (String(err?.code || "") === "CIRCUIT_OPEN") {
        throw new functions.https.HttpsError("unavailable", "TMDb temporaneamente non disponibile. Riprova a breve.");
      }
      throw new functions.https.HttpsError("unavailable", "Servizio TMDb non disponibile al momento.");
    }
  });

// =====================================================================
// gifSearch
// Proxy Giphy per il picker GIF nei commenti/thread. Tiene la API key
// server-side (env GIPHY_API_KEY), forza SFW (rating=pg), e ritorna URL
// normalizzati su host giphy.com (in whitelist nelle firestore.rules).
// Signed-in + rate-limited come tmdbProxy. Nessuna scrittura utente.
// =====================================================================
exports.gifSearch = functions
  .region("europe-west1")
  .runWith({ memory: "128MB", timeoutSeconds: 20 })
  .https.onCall(async (data, context) => {
    const db = admin.firestore();
    const uid = context.auth?.uid;
    if (!uid) {
      throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
    }
    const apiKey = String(process.env.GIPHY_API_KEY || "").trim();
    if (!apiKey) {
      throw new functions.https.HttpsError("failed-precondition", "Ricerca GIF non configurata.");
    }

    await enforceCallableRateLimit(db, uid, "gifSearch", {
      windowSeconds: 6,
      maxInWindow: 12,
      dailyMax: 800,
    });

    const action = safeString(data?.action || "search", 16).toLowerCase();
    const query = safeString(data?.query || "", 80).trim();
    const limit = clamp(Number(data?.limit || 24), 1, 30);
    const offset = clamp(Number(data?.offset || 0), 0, 500);

    const useTrending = action === "trending" || query.length < 1;
    const base = useTrending
      ? "https://api.giphy.com/v1/gifs/trending"
      : "https://api.giphy.com/v1/gifs/search";
    const params = new URLSearchParams({
      api_key: apiKey,
      limit: String(limit),
      offset: String(offset),
      rating: "pg",
      bundle: "messaging_non_clips",
      lang: "it",
    });
    if (!useTrending) params.set("q", query);

    let json;
    try {
      const resp = await fetch(`${base}?${params.toString()}`, { method: "GET" });
      if (!resp.ok) throw new Error(`giphy_http_${resp.status}`);
      json = await resp.json();
    } catch (err) {
      logger.warn("[gifSearch] request failed", {
        uid,
        message: safeString(err?.message || String(err), 200),
      });
      throw new functions.https.HttpsError("unavailable", "GIF non disponibili al momento. Riprova a breve.");
    }

    const giphyHost = /^https:\/\/[a-z0-9.-]*giphy\.com\//i;
    const results = (Array.isArray(json?.data) ? json.data : [])
      .map((g) => {
        const imgs = g?.images || {};
        const anim = imgs.fixed_height || imgs.downsized_medium || {};
        const still = imgs.fixed_height_still || imgs.fixed_width_still || {};
        return {
          id: safeString(g?.id || "", 40),
          gifUrl: String(anim.url || "").split("?")[0],
          previewUrl: String(still.url || anim.url || "").split("?")[0],
          width: Number(anim.width) || 0,
          height: Number(anim.height) || 0,
          title: safeString(g?.title || "", 120),
        };
      })
      .filter((r) => r.id && giphyHost.test(r.gifUrl));

    return { results, next: offset + limit };
  });

// =====================================================================
// enrichTitleAssets
// Lazy-cache title assets (trailer URL + cast with character names) on the
// titles/{id} document so iOS clients don't need to round-trip TMDb every
// time a detail view is opened. Idempotent: skips work that's already done.
// =====================================================================
exports.enrichTitleAssets = functions
  .region("europe-west1")
  .https.onCall(async (data, context) => {
    const db = admin.firestore();
    const uid = context.auth?.uid;
    if (!uid) {
      throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
    }

    await enforceCallableRateLimit(db, uid, "enrichTitleAssets", {
      windowSeconds: 6,
      maxInWindow: 6,
      dailyMax: 600,
    });

    const titleId = toId(data?.titleId);
    if (!titleId) {
      throw new functions.https.HttpsError("invalid-argument", "titleId mancante.");
    }

    const wantTrailer = data?.includeTrailer !== false;
    const wantCast = data?.includeCast !== false;

    const titleRef = db.collection("titles").doc(titleId);
    const titleSnap = await titleRef.get();
    if (!titleSnap.exists) {
      throw new functions.https.HttpsError("not-found", "Titolo non trovato.");
    }
    const titleData = titleSnap.data() || {};
    const tmdbId = Number(titleData?.metadata?.tmdbId || 0) || Number(data?.tmdbId || 0);
    const mediaType = normalizeTmdbMediaType(
      titleData?.metadata?.mediaType || titleData?.type || data?.mediaType
    );

    if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
      return { trailerCached: false, castCached: false, reason: "no_tmdb_id" };
    }

    const updates = {};
    const result = { trailerCached: false, castCached: false };

    // ---- Trailer ----
    const existingTrailer = safeString(titleData?.trailerUrl || "", 600).trim();
    if (wantTrailer && !existingTrailer) {
      try {
        const language = normalizeTmdbLanguage("it-IT");
        const path = mediaType === "tv" ? `/tv/${tmdbId}/videos` : `/movie/${tmdbId}/videos`;
        const state = { maxApiCalls: 6, maxAttempts: 2 };
        let videosRes = await fetchTmdbCachedJson(path, { language }, {
          db, state, cacheScope: "videos", ttlSeconds: 24 * 60 * 60, allowStaleOnError: true,
        });
        let trailer = pickBestTrailerFromTmdbVideos(videosRes?.data);
        if (!trailer) {
          videosRes = await fetchTmdbCachedJson(path, {}, {
            db, state, cacheScope: "videos_en", ttlSeconds: 24 * 60 * 60, allowStaleOnError: true,
          });
          trailer = pickBestTrailerFromTmdbVideos(videosRes?.data);
        }
        if (trailer) {
          updates.trailerUrl = `https://www.youtube.com/watch?v=${trailer.key}`;
          updates.trailerSource = "tmdb_auto";
          updates.trailerCachedAt = admin.firestore.FieldValue.serverTimestamp();
          result.trailerCached = true;
        }
      } catch (err) {
        logger.warn("[enrichTitleAssets] trailer fetch failed", { titleId, message: err?.message });
      }
    }

    // ---- Cast w/ characters + castIds + directorIds ----
    // Strategy:
    // - Always re-derive person ID arrays from TMDB credits when the doc is
    //   missing them (or has fewer than a sane threshold). This lets older
    //   stubs catch up over time.
    // - Use arrayUnion when writing castIds/directorIds so any seed values
    //   (e.g. a personId planted by linkPersonToTitles for a minor cast
    //   member outside the top 20) survive the refresh.
    const existingCastWithChars = Array.isArray(titleData?.castWithCharacters)
      ? titleData.castWithCharacters
      : null;
    const existingCastIds = Array.isArray(titleData?.castIds) ? titleData.castIds : [];
    const existingDirectorIds = Array.isArray(titleData?.directorIds) ? titleData.directorIds : [];
    const castWithCharsMissing = !existingCastWithChars || existingCastWithChars.length === 0;
    const castIdsSparse = existingCastIds.length < 5;
    const directorIdsMissing = existingDirectorIds.length === 0;
    if (wantCast && (castWithCharsMissing || castIdsSparse || directorIdsMissing)) {
      try {
        const language = normalizeTmdbLanguage("it-IT");
        const path = mediaType === "tv" ? `/tv/${tmdbId}` : `/movie/${tmdbId}`;
        const state = { maxApiCalls: 6, maxAttempts: 2 };
        const detailsRes = await fetchTmdbCachedJson(path, {
          language,
          append_to_response: "credits",
        }, {
          db, state, cacheScope: "details", ttlSeconds: 7 * 24 * 60 * 60, allowStaleOnError: true,
        });
        const castRaw = safeArray(detailsRes?.data?.credits?.cast);
        const cast = castRaw
          .slice(0, 20)
          .map((c) => {
            const personId = c?.id ? String(c.id) : "";
            const name = safeString(c?.name || c?.original_name || "", 120);
            const character = safeString(c?.character || "", 160);
            const profilePath = c?.profile_path
              ? `https://image.tmdb.org/t/p/w500${c.profile_path}`
              : "";
            const order = Number.isFinite(c?.order) ? Number(c.order) : 999;
            if (!personId || !name) return null;
            return { personId, name, character, profilePath, order };
          })
          .filter(Boolean)
          .sort((a, b) => a.order - b.order);
        if (cast.length > 0 && castWithCharsMissing) {
          updates.castWithCharacters = cast;
          updates.castWithCharactersCachedAt = admin.firestore.FieldValue.serverTimestamp();
          result.castCached = true;
        }
        if (castIdsSparse) {
          const newCastIds = cast.map((c) => c.personId).filter(Boolean);
          if (newCastIds.length > 0) {
            updates.castIds = admin.firestore.FieldValue.arrayUnion(...newCastIds);
          }
        }
        if (directorIdsMissing) {
          const crewRaw = safeArray(detailsRes?.data?.credits?.crew);
          const directorIds = Array.from(new Set(
            crewRaw
              .filter((c) => String(c?.job || "") === "Director" && c?.id)
              .map((c) => String(c.id))
              .filter(Boolean)
          ));
          if (directorIds.length > 0) {
            updates.directorIds = admin.firestore.FieldValue.arrayUnion(...directorIds);
          }
        }
      } catch (err) {
        logger.warn("[enrichTitleAssets] cast fetch failed", { titleId, message: err?.message });
      }
    } else if (wantCast && existingCastWithChars && existingCastWithChars.length > 0 && existingCastIds.length === 0) {
      // Derive castIds from already-cached cast list without an extra TMDB hop.
      const derived = existingCastWithChars
        .map((c) => (typeof c?.personId === "string" ? c.personId : ""))
        .filter(Boolean);
      if (derived.length > 0) {
        updates.castIds = admin.firestore.FieldValue.arrayUnion(...derived);
      }
    }

    if (Object.keys(updates).length > 0) {
      await titleRef.set(updates, { merge: true });
    }

    return {
      ...result,
      trailerUrl: updates.trailerUrl || existingTrailer || null,
      castWithCharacters: updates.castWithCharacters || existingCastWithChars || [],
    };
  });

// =====================================================================
// linkPersonToTitles
// Reconciles the local catalog with a TMDB person's full filmography.
// For each cast/director credit:
//   - if the title already exists locally, arrayUnion the personId into
//     castIds (or directorIds) so PersonTitlesView can find it via
//     `whereField("castIds", arrayContains:)`;
//   - if the title does not exist locally, create a minimal approved doc
//     using fields the credit payload already carries (name, year, poster,
//     genres, overview) and seed the appropriate ID array with [personId].
//     The doc will be fully filled on first enrichTitleAssets call.
// Runs with the admin SDK so it works for every authenticated user,
// bypassing the trusted-only Firestore rule on titles.
// =====================================================================
exports.linkPersonToTitles = functions
  .region("europe-west1")
  .runWith({ memory: "512MB", timeoutSeconds: 120 })
  .https.onCall(async (data, context) => {
    const db = admin.firestore();
    const uid = context.auth?.uid;
    if (!uid) {
      throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
    }
    const personIdRaw = String(data?.personId || "").trim();
    if (!/^[0-9]+$/.test(personIdRaw)) {
      throw new functions.https.HttpsError("invalid-argument", "personId mancante o non valido.");
    }
    // Rate-limit: 200/giorno per utenti trusted/admin (workflow editoriale),
    // 5/giorno per gli altri. Senza distinzione un utente base potrebbe spammare
    // import di filmografie TMDb consumando l'intera quota giornaliera.
    const userDocSnap = await db.collection("users").doc(uid).get();
    const userData = userDocSnap.exists ? (userDocSnap.data() || {}) : {};
    const isTrustedUser = userData.trusted === true || userData.isAdmin === true;
    await enforceCallableRateLimit(db, uid, "linkPersonToTitles", {
      windowSeconds: 5,
      maxInWindow: 2,
      dailyMax: isTrustedUser ? 200 : 5,
    });

    const personId = personIdRaw;
    const language = normalizeTmdbLanguage("it-IT");
    const state = { maxApiCalls: 4, maxAttempts: 2 };
    const creditsRes = await fetchTmdbCachedJson(
      `/person/${personId}/combined_credits`,
      { language },
      { db, state, cacheScope: "personCredits", ttlSeconds: 24 * 60 * 60, allowStaleOnError: true }
    );
    const payload = creditsRes?.data || {};
    const castRaw = safeArray(payload.cast);
    const crewRaw = safeArray(payload.crew);

    const credits = new Map();
    const enqueue = (item, role) => {
      const mediaType = item?.media_type === "tv" ? "tv" : (item?.media_type === "movie" ? "movie" : null);
      if (!mediaType) return;
      const tmdbId = Number(item?.id);
      if (!Number.isFinite(tmdbId) || tmdbId <= 0) return;
      const key = `${mediaType}_${tmdbId}`;
      if (credits.has(key)) {
        const existing = credits.get(key);
        // Cast wins; otherwise upgrade crewOther → director.
        if (existing.role === "cast") return;
        if (role === "cast" || (existing.role === "crewOther" && role === "director")) {
          credits.set(key, { item, role, tmdbId, mediaType });
        }
        return;
      }
      credits.set(key, { item, role, tmdbId, mediaType });
    };
    for (const c of castRaw) enqueue(c, "cast");
    for (const c of crewRaw) {
      const job = String(c?.job || "");
      enqueue(c, job === "Director" ? "director" : "crewOther");
    }

    const eligible = Array.from(credits.values())
      .filter((c) => c.role === "cast" || c.role === "director")
      .slice(0, 120);

    let imported = 0;
    let linked = 0;
    let alreadyLinked = 0;
    let skippedUntrusted = 0;

    const titlesCol = db.collection("titles");
    for (const credit of eligible) {
      const docId = `tmdb_${credit.mediaType}_${credit.tmdbId}`;
      const arrayField = credit.role === "director" ? "directorIds" : "castIds";
      let docRef = titlesCol.doc(docId);
      let snap = await docRef.get();

      // Un titolo potrebbe gestire questo id TMDB con un doc id diverso
      // (titolo curato/merge manuale): collega la persona a quello,
      // non ricreare uno stub tmdb_*. Gli id TMDB collidono tra movie e tv
      // (es. 1891 = movie + tv): filtra per tipo (post-filtro client-side) per
      // non agganciare un doc di tipo diverso con lo stesso tmdbId.
      if (!snap.exists) {
        const sameType = (doc) => titleDocMediaType(doc) === credit.mediaType;
        let ownerSnap = await titlesCol.where("tmdbId", "==", credit.tmdbId).limit(5).get();
        let owner = ownerSnap.docs.find(sameType);
        if (!owner) {
          ownerSnap = await titlesCol
            .where("mergedTmdbIds", "array-contains", credit.tmdbId)
            .limit(5)
            .get();
          owner = ownerSnap.docs.find(sameType);
        }
        if (owner) {
          docRef = owner.ref;
          snap = owner;
        }
      }

      if (snap.exists) {
        const ids = Array.isArray(snap.get(arrayField)) ? snap.get(arrayField) : [];
        if (ids.includes(personId)) {
          alreadyLinked += 1;
          continue;
        }
        await docRef.update({
          [arrayField]: admin.firestore.FieldValue.arrayUnion(personId),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        linked += 1;
        continue;
      }

      // Solo trusted/admin possono CREARE nuovi titoli "approved" nel catalogo
      // (le rules richiedono isTrusted() per `titles` create). Un utente base
      // puo' solo collegare la persona a titoli gia' esistenti (ramo sopra),
      // non seminare doc tmdb_* approvati via admin SDK.
      if (!isTrustedUser) {
        skippedUntrusted += 1;
        continue;
      }

      // Build a slim approved doc from the credit payload alone — no
      // extra TMDB call. enrichTitleAssets will fill the rest on first
      // open of the title detail.
      const item = credit.item;
      const isTv = credit.mediaType === "tv";
      const name = safeString(isTv ? (item?.name || item?.original_name) : (item?.title || item?.original_title), 160);
      if (!name) continue;
      const dateStr = isTv ? safeString(item?.first_air_date || "", 12) : safeString(item?.release_date || "", 12);
      const year = Number.isFinite(Number(dateStr.slice(0, 4))) ? Number(dateStr.slice(0, 4)) : null;
      const posterPath = item?.poster_path
        ? `https://image.tmdb.org/t/p/w500${item.poster_path}`
        : "";
      const backdropPath = item?.backdrop_path
        ? `https://image.tmdb.org/t/p/w780${item.backdrop_path}`
        : "";
      const overview = safeString(item?.overview || "", 2000);
      const genres = Array.isArray(item?.genre_ids)
        ? item.genre_ids.filter((g) => Number.isFinite(Number(g))).map((g) => `tmdb_${Number(g)}`)
        : [];
      const tmdbRating = Number(item?.vote_average || 0) || 0;
      const initialDirectorIds = credit.role === "director" ? [personId] : [];
      const initialCastIds = credit.role === "cast" ? [personId] : [];

      const doc = {
        name,
        nameLower: String(name).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""),
        type: credit.mediaType,
        year,
        description: overview,
        posterPath,
        backdropPath,
        genres,
        cast: [],
        castIds: initialCastIds,
        directors: [],
        directorIds: initialDirectorIds,
        status: "approved",
        source: "tmdb_person_link",
        tmdbId: credit.tmdbId,
        tmdbRating,
        ratingAvg: 0,
        ratingCount: 0,
        reviewCount: 0,
        meta: {
          tmdbId: credit.tmdbId,
          mediaType: credit.mediaType,
          source: "tmdb_person_link",
        },
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdBy: uid,
      };

      try {
        await docRef.set(doc, { merge: false });
        imported += 1;
      } catch (err) {
        logger.warn("[linkPersonToTitles] create failed", {
          personId,
          docId,
          message: err?.message,
        });
      }
    }

    return {
      personId,
      imported,
      linked,
      alreadyLinked,
      skippedUntrusted,
      total: eligible.length,
    };
  });

function pickBestTrailerFromTmdbVideos(payload) {
  const list = safeArray(payload?.results);
  if (!list.length) return null;
  // Prefer official YouTube trailers, then any trailer/teaser on YouTube.
  const youtube = list.filter((v) => String(v?.site || "").toLowerCase() === "youtube" && v?.key);
  if (!youtube.length) return null;
  const ranked = youtube
    .map((v) => ({
      v,
      score:
        (String(v?.type || "").toLowerCase() === "trailer" ? 100 : 0) +
        (String(v?.type || "").toLowerCase() === "teaser" ? 40 : 0) +
        (v?.official ? 25 : 0) +
        (Number(v?.size || 0) >= 1080 ? 5 : 0),
    }))
    .sort((a, b) => b.score - a.score);
  const top = ranked[0];
  return top && top.score > 0 ? top.v : youtube[0];
}

exports.getWatchProviders = functions
  .region("europe-west1")
  .https.onCall(async (data, context) => {
    const db = admin.firestore();
    const uid = context.auth?.uid;
    if (!uid) {
      throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
    }
    await enforceCallableRateLimit(db, uid, "getWatchProviders", {
      windowSeconds: 8,
      maxInWindow: 8,
      dailyMax: 600,
    });

    const titleId = toId(data?.titleId);
    const region = normalizeTmdbRegion(data?.region);
    const ttlMs = 7 * DAY_MS;
    const nowMs = Date.now();

    if (!titleId) {
      throw new functions.https.HttpsError("invalid-argument", "titleId mancante.");
    }

    const cacheRef = db.collection("titleProviders").doc(titleId);
    const [titleSnap, cacheSnap] = await Promise.all([
      db.collection("titles").doc(titleId).get(),
      cacheRef.get(),
    ]);

    const cacheDoc = cacheSnap.exists ? (cacheSnap.data() || {}) : {};
    const cacheCustomAdmin = normalizeCustomProviders(cacheDoc.customAdmin);
    const cacheProviders = cacheDoc.providers || null;

    const cacheIsFresh = Boolean(
      cacheProviders &&
      String(cacheDoc.region || "") === region &&
      Number(cacheDoc.expiresAtMs || 0) > nowMs
    );

    if (cacheIsFresh) {
      // Backfill loghi per i titoli enrichati prima dell'introduzione di
      // watchProviderLogos: con cache fresca il path network non gira più,
      // quindi senza questo i loghi non arriverebbero mai sul doc titolo.
      try {
        const titleData = titleSnap.exists ? (titleSnap.data() || {}) : null;
        if (titleData && titleData.watchProviderLogos === undefined) {
          const watchProviderLogos = extractStreamingPlatformLogos(cacheProviders, cacheCustomAdmin);
          await db.collection("titles").doc(titleId).set({ watchProviderLogos }, { merge: true });
        }
      } catch (e) {
        logger.warn("[watchProviders] backfill logos failed", { titleId, message: safeString(e?.message || String(e), 160) });
      }
      // Link diretti alle piattaforme: cache se c'e', altrimenti una
      // risoluzione su Wikidata. Non puo' rompere questa risposta — il modulo
      // torna sempre un oggetto, e a interruttore spento torna vuoto.
      const cachedTitleData = titleSnap.exists ? (titleSnap.data() || {}) : {};
      const deepLinks = await resolveDeepLinksForTitle({
        db,
        titleId,
        tmdbId: Number(cacheDoc.tmdbId || cachedTitleData.tmdbId || 0),
        mediaType: String(cacheDoc.type || cachedTitleData.type || "movie"),
        availableProviders: extractStreamingPlatformNames(cacheProviders, cacheCustomAdmin),
        cached: cacheDoc,
      });

      return {
        titleId,
        region,
        tmdbId: Number(cacheDoc.tmdbId || 0) || null,
        type: String(cacheDoc.type || "movie"),
        providers: cacheProviders,
        customAdmin: cacheCustomAdmin,
        deepLinks,
        available: hasAnyProvidersBundle(cacheProviders) || cacheCustomAdmin.length > 0,
        stale: false,
        fromCache: true,
        updatedAtMs: Number(cacheDoc.updatedAtMs || nowMs),
        expiresAtMs: Number(cacheDoc.expiresAtMs || (nowMs + ttlMs)),
        source: "titleProviders_cache",
      };
    }

    if (!titleSnap.exists) {
      throw new functions.https.HttpsError("not-found", "Titolo non trovato.");
    }

    const title = titleSnap.data() || {};
    const mediaType = normalizeTmdbMediaType(title.type || title.meta?.mediaType || "movie");
    const tmdbId = Number(title.tmdbId || title.meta?.tmdbId || 0);

    if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
      return {
        titleId,
        region,
        tmdbId: null,
        type: mediaType,
        providers: { region, link: "", flatrate: [], rent: [], buy: [], free: [], ads: [] },
        customAdmin: cacheCustomAdmin,
        available: cacheCustomAdmin.length > 0,
        stale: false,
        fromCache: false,
        updatedAtMs: nowMs,
        expiresAtMs: nowMs + ttlMs,
        source: "missing_tmdb_id",
      };
    }

    const path = mediaType === "tv"
      ? `/tv/${tmdbId}/watch/providers`
      : `/movie/${tmdbId}/watch/providers`;

    try {
      const state = { maxApiCalls: 20, maxAttempts: 3 };
      const tmdbResponse = await fetchTmdbCachedJson(path, {}, {
        db,
        state,
        cacheScope: `watchProviders_${region.toLowerCase()}`,
        ttlSeconds: 7 * 24 * 60 * 60,
        allowStaleOnError: true,
      });

      const providers = normalizeProvidersForRegion(tmdbResponse.data, region);
      const payload = {
        titleId,
        region,
        tmdbId,
        type: mediaType,
        providers,
        customAdmin: cacheCustomAdmin,
        available: hasAnyProvidersBundle(providers) || cacheCustomAdmin.length > 0,
        stale: tmdbResponse.cache?.stale === true,
        fromCache: tmdbResponse.cache?.source !== "network",
        updatedAtMs: nowMs,
        expiresAtMs: nowMs + ttlMs,
        source: "tmdb_watch_providers",
      };

      await cacheRef.set(
        {
          ...payload,
          suggestionsCount: Number(cacheDoc.suggestionsCount || 0),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      // Denormalizza nomi + loghi piattaforma sul doc titolo per il raggruppamento/
      // filtro watchlist (F-C). Best-effort: un fallimento qui non deve rompere la risposta.
      try {
        const watchProviderNames = extractStreamingPlatformNames(providers, cacheCustomAdmin);
        const watchProviderLogos = extractStreamingPlatformLogos(providers, cacheCustomAdmin);
        await db.collection("titles").doc(titleId).set({ watchProviderNames, watchProviderLogos }, { merge: true });
      } catch (e) {
        logger.warn("[watchProviders] denormalize names failed", { titleId, message: safeString(e?.message || String(e), 160) });
      }

      payload.deepLinks = await resolveDeepLinksForTitle({
        db,
        titleId,
        tmdbId,
        mediaType,
        availableProviders: extractStreamingPlatformNames(providers, cacheCustomAdmin),
        cached: cacheDoc,
      });

      return payload;
    } catch (err) {
      logger.warn("[watchProviders] fetch failed", {
        titleId,
        region,
        message: safeString(err?.message || String(err), 220),
        code: String(err?.code || ""),
      });

      if (cacheProviders) {
        return {
          titleId,
          region,
          tmdbId: Number(cacheDoc.tmdbId || tmdbId),
          type: String(cacheDoc.type || mediaType),
          providers: cacheProviders,
          customAdmin: cacheCustomAdmin,
          available: hasAnyProvidersBundle(cacheProviders) || cacheCustomAdmin.length > 0,
          stale: true,
          fromCache: true,
          updatedAtMs: Number(cacheDoc.updatedAtMs || nowMs),
          expiresAtMs: Number(cacheDoc.expiresAtMs || nowMs),
          source: "titleProviders_stale_cache",
        };
      }

      if (String(err?.code || "") === "CIRCUIT_OPEN") {
        throw new functions.https.HttpsError("unavailable", "Provider TMDb temporaneamente non disponibili.");
      }
      throw new functions.https.HttpsError("unavailable", "Impossibile recuperare i provider.");
    }
  });

exports.suggestWatchProvider = functions
  .region("europe-west1")
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid;
    if (!uid) {
      throw new functions.https.HttpsError("unauthenticated", "Devi essere autenticato.");
    }

    const db = admin.firestore();
    await enforceCallableRateLimit(db, uid, "watchProviderSuggestion", {
      windowSeconds: 30,
      maxInWindow: 2,
      dailyMax: 40,
    });

    const titleId = toId(data?.titleId);
    const name = safeString(data?.name || "", 120).trim();
    const url = sanitizeHttpUrl(data?.url || "");
    const note = safeString(data?.note || "", 220).trim();
    const region = normalizeTmdbRegion(data?.region);

    if (!titleId) {
      throw new functions.https.HttpsError("invalid-argument", "titleId mancante.");
    }
    if (name.length < 2) {
      throw new functions.https.HttpsError("invalid-argument", "Nome piattaforma non valido.");
    }

    const titleSnap = await db.collection("titles").doc(titleId).get();
    if (!titleSnap.exists) {
      throw new functions.https.HttpsError("not-found", "Titolo non trovato.");
    }

    const docRef = db.collection("titleProviders").doc(titleId).collection("suggestions").doc();
    await docRef.set({
      titleId,
      uid,
      region,
      name,
      url,
      note,
      status: "pending",
      source: "user_suggestion",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await db.collection("titleProviders").doc(titleId).set({
      titleId,
      suggestionsCount: admin.firestore.FieldValue.increment(1),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return { ok: true, id: docRef.id };
  });

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toPositiveInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

function sameArrayShallow(a, b) {
  const left = safeArray(a);
  const right = safeArray(b);
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function sameJsonValue(a, b) {
  try {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  } catch (_) {
    return false;
  }
}

function uniqueStrings(values, { maxLen = 160, maxItems = 30 } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of safeArray(values)) {
    const value = safeString(raw, maxLen).trim();
    if (!value) continue;
    const key = normalizeText(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= maxItems) break;
  }
  return out;
}

function mergeUniqueStrings(existing, incoming, { maxLen = 160, maxItems = 30 } = {}) {
  const base = uniqueStrings(existing, { maxLen, maxItems });
  const next = [...base];
  const seen = new Set(base.map((v) => normalizeText(v)).filter(Boolean));
  for (const item of uniqueStrings(incoming, { maxLen, maxItems })) {
    const key = normalizeText(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    next.push(item);
    if (next.length >= maxItems) break;
  }
  return next;
}

function tmdbImageUrl(path, size = "w500") {
  const raw = safeString(path, 260).trim();
  if (!raw || !raw.startsWith("/")) return "";
  return `${TMDB_IMAGE_BASE}/${size}${raw}`;
}

// normalizeTmdbSeasons + uniformEpisodesForSeasons live in
// functions/lib/tmdbDurations.js (single source of truth, shared with the
// import enrichment pass) and are imported at the top of this file.

function resolveKnownTmdbTarget(titleId, title) {
  const mediaType = normalizeTmdbMediaType(title?.type || title?.meta?.mediaType || "movie");
  const topLevel = toPositiveInt(title?.tmdbId);
  if (topLevel > 0) return { tmdbId: topLevel, mediaType, source: "title.tmdbId" };

  const metaLevel = toPositiveInt(title?.meta?.tmdbId);
  if (metaLevel > 0) return { tmdbId: metaLevel, mediaType, source: "title.meta.tmdbId" };

  const m = String(titleId || "").match(/^tmdb_(movie|tv)_(\d+)$/i);
  if (m) {
    return {
      tmdbId: toPositiveInt(m[2]),
      mediaType: m[1] === "tv" ? "tv" : "movie",
      source: "docId",
    };
  }
  return null;
}

function scoreTmdbSearchResult({ title, mediaType, row }) {
  const wanted = normalizeText(title?.name || "");
  const wantedYear = toPositiveInt(title?.year);

  const tmdbTitle = mediaType === "tv"
    ? safeString(row?.name || "", 180)
    : safeString(row?.title || "", 180);
  const tmdbOriginal = mediaType === "tv"
    ? safeString(row?.original_name || "", 180)
    : safeString(row?.original_title || "", 180);
  const tmdbNorm = normalizeText(tmdbTitle);
  const tmdbOrigNorm = normalizeText(tmdbOriginal);
  const dateStr = mediaType === "tv" ? row?.first_air_date : row?.release_date;
  const tmdbYear = parseYearFromDate(dateStr);

  let score = 0;
  if (wanted && tmdbNorm === wanted) score += 100;
  else if (wanted && tmdbOrigNorm === wanted) score += 92;
  else if (wanted && tmdbNorm && (tmdbNorm.includes(wanted) || wanted.includes(tmdbNorm))) score += 56;
  else if (wanted && tmdbOrigNorm && (tmdbOrigNorm.includes(wanted) || wanted.includes(tmdbOrigNorm))) score += 48;

  if (wantedYear && tmdbYear) {
    if (wantedYear === tmdbYear) score += 30;
    else if (Math.abs(wantedYear - tmdbYear) === 1) score += 16;
  }

  score += Math.min(Number(row?.popularity || 0) / 100, 6);
  return score;
}

async function resolveTmdbTargetForTitle({ db, titleId, title, state = {} }) {
  const known = resolveKnownTmdbTarget(titleId, title);
  if (known?.tmdbId) return known;

  const mediaType = normalizeTmdbMediaType(title?.type || title?.meta?.mediaType || "movie");
  const endpoint = mediaType === "tv" ? "/search/tv" : "/search/movie";
  const queries = uniqueStrings([title?.name, title?.originalName], { maxLen: 180, maxItems: 2 });

  for (const q of queries) {
    const response = await fetchTmdbCachedJson(endpoint, {
      query: q,
      language: "it-IT",
      include_adult: false,
      page: 1,
    }, {
      db,
      state,
      cacheScope: `titleRefreshSearch_${mediaType}`,
      ttlSeconds: 15 * 24 * 60 * 60,
      allowStaleOnError: true,
    });

    const results = safeArray(response?.data?.results);
    if (!results.length) continue;

    const scored = results
      .map((row) => ({ row, score: scoreTmdbSearchResult({ title, mediaType, row }) }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (!best || best.score < 40) continue;
    const tmdbId = toPositiveInt(best.row?.id);
    if (!tmdbId) continue;
    return { tmdbId, mediaType, source: "search" };
  }

  return null;
}

function buildTitleSearchSnapshot({
  title,
  nextName,
  nextType,
  nextYear,
  nextOriginalName,
  nextAliases = safeArray(title?.aliases),
  nextCollectionName = "",
  nextKeywords = [],
  nextDescription = "",
}) {
  const currentSearch = asObject(title?.search);
  const nextSearch = { ...currentSearch };
  let changed = false;

  const nameLower = normalizeText(nextName || "");
  if (!nameLower) return { changed: false, nextSearch, nameLower };

  const sourceTexts = [nameLower];
  const originalNorm = normalizeText(nextOriginalName || "");
  if (originalNorm) sourceTexts.push(originalNorm);
  const aliases = safeArray(nextAliases);
  for (const alias of aliases) {
    const aNorm = normalizeText(alias);
    if (aNorm) sourceTexts.push(aNorm);
  }
  const collectionNorm = normalizeText(nextCollectionName || "");
  if (collectionNorm) sourceTexts.push(collectionNorm);
  for (const keyword of safeArray(nextKeywords)) {
    const kNorm = normalizeText(keyword);
    if (kNorm) sourceTexts.push(kNorm);
  }
  const descriptionNorm = normalizeText(nextDescription || "");
  if (descriptionNorm) sourceTexts.push(descriptionNorm);
  const tokenSet = new Set();
  for (const text of sourceTexts) {
    for (const tok of tokenizeNormalized(text)) {
      tokenSet.add(tok);
      if (tokenSet.size >= 80) break;
    }
    if (tokenSet.size >= 80) break;
  }
  const tokens = [...tokenSet];
  const prefixes = buildPrefixes(nameLower, 6);
  const dedupeKey = `${nameLower}_${nextType || "null"}_${nextYear ?? "null"}`;
  const searchableText = buildTitleSearchableText({
    name: nextName,
    originalName: nextOriginalName,
    aliases,
    collectionName: nextCollectionName || "",
    keywords: nextKeywords || [],
    description: nextDescription || "",
  });

  if (nextSearch.normalized !== nameLower) {
    nextSearch.normalized = nameLower;
    changed = true;
  }
  if (nextSearch.dedupeKey !== dedupeKey) {
    nextSearch.dedupeKey = dedupeKey;
    changed = true;
  }
  if (!sameArrayShallow(nextSearch.prefixes, prefixes)) {
    nextSearch.prefixes = prefixes;
    changed = true;
  }
  if (!sameArrayShallow(nextSearch.tokens, tokens)) {
    nextSearch.tokens = tokens;
    changed = true;
  }
  if (nextSearch.searchableText !== searchableText) {
    nextSearch.searchableText = searchableText;
    changed = true;
  }

  return { changed, nextSearch, nameLower, searchableText };
}

function buildTitleSearchableText({ name, originalName, aliases, collectionName, keywords, description }) {
  return [
    safeString(name || "", 200).trim(),
    safeString(originalName || "", 200).trim(),
    safeArray(aliases).map((value) => safeString(value, 160).trim()).filter(Boolean).join(" "),
    safeString(collectionName || "", 200).trim(),
    safeArray(keywords).map((value) => safeString(value, 80).trim()).filter(Boolean).join(" "),
    safeString(description || "", 2200).trim(),
  ].filter(Boolean).join(" • ");
}

function extractTmdbKeywords(details) {
  const payload = asObject(details?.keywords);
  const rows = [
    ...safeArray(payload?.keywords),
    ...safeArray(payload?.results),
  ];
  return uniqueStrings(rows.map((row) => row?.name), { maxLen: 80, maxItems: 30 });
}

function extractTmdbAlternativeTitles(details) {
  const payload = asObject(details?.alternative_titles);
  const rows = [
    ...safeArray(payload?.titles),
    ...safeArray(payload?.results),
  ];
  return uniqueStrings(rows.map((row) => row?.title || row?.name), { maxLen: 160, maxItems: 40 });
}

function buildTmdbTitleRefreshPatch({ title, target, detailsIt, detailsEn }) {
  const patch = {};
  const changedFields = [];
  const mediaType = normalizeTmdbMediaType(target?.mediaType || title?.type || "movie");
  const isTv = mediaType === "tv";
  const tmdbId = toPositiveInt(target?.tmdbId);
  const currentMeta = asObject(title?.meta);
  const nextMeta = { ...currentMeta };
  let metaChanged = false;

  const setRoot = (field, value, { allowEmpty = false } = {}) => {
    if (value === undefined) return;
    if (!allowEmpty && (value === null || value === "")) return;
    const prev = title?.[field];
    const same = (typeof value === "object" && value !== null)
      ? sameJsonValue(prev, value)
      : prev === value;
    if (same) return;
    patch[field] = value;
    changedFields.push(field);
  };

  const setMeta = (field, value, { allowEmpty = false } = {}) => {
    if (value === undefined) return;
    if (!allowEmpty && (value === null || value === "")) return;
    const prev = currentMeta[field];
    const same = (typeof value === "object" && value !== null)
      ? sameJsonValue(prev, value)
      : prev === value;
    if (same) return;
    nextMeta[field] = value;
    metaChanged = true;
    changedFields.push(`meta.${field}`);
  };

  const tmdbName = safeString(isTv ? detailsIt?.name : detailsIt?.title, 160).trim();
  const tmdbOriginalName = safeString(isTv ? detailsIt?.original_name : detailsIt?.original_title, 160).trim();
  const dateStr = safeString(isTv ? detailsIt?.first_air_date : detailsIt?.release_date, 24).trim();
  const tmdbYear = parseYearFromDate(dateStr);
  const tmdbRating = Number(detailsIt?.vote_average || 0) || 0;
  const overviewIt = safeString(detailsIt?.overview, 2200).trim();
  const overviewEn = safeString(detailsEn?.overview, 2200).trim();
  const nextDescription = overviewIt || overviewEn;
  const collection = asObject(detailsIt?.belongs_to_collection);
  const collectionId = toPositiveInt(collection?.id);
  const collectionName = safeString(collection?.name || "", 180).trim();
  const collectionPosterPath = tmdbImageUrl(collection?.poster_path, "w500");
  const collectionBackdropPath = tmdbImageUrl(collection?.backdrop_path, "w780");
  const tmdbKeywords = uniqueStrings([
    ...extractTmdbKeywords(detailsIt),
    ...extractTmdbKeywords(detailsEn),
  ], { maxLen: 80, maxItems: 30 });
  const tmdbAliases = uniqueStrings([
    tmdbOriginalName,
    ...extractTmdbAlternativeTitles(detailsIt),
    ...extractTmdbAlternativeTitles(detailsEn),
  ], { maxLen: 160, maxItems: 40 });

  if (tmdbId > 0) {
    setRoot("tmdbId", tmdbId);
    setMeta("tmdbId", tmdbId);
  }
  setRoot("type", mediaType);
  setMeta("mediaType", mediaType);

  if (tmdbRating > 0) setRoot("tmdbRating", Number(tmdbRating.toFixed(3)));
  if (tmdbName) setRoot("name", tmdbName);
  if (tmdbOriginalName) setRoot("originalName", tmdbOriginalName);
  if (tmdbYear) setRoot("year", tmdbYear);
  if (nextDescription) setRoot("description", nextDescription);
  if (collectionId > 0) {
    setRoot("collectionId", collectionId);
    setMeta("collectionId", collectionId);
  }
  if (collectionName) {
    setRoot("collectionName", collectionName);
    setMeta("collectionName", collectionName);
  }
  if (collectionPosterPath) {
    setRoot("collectionPosterPath", collectionPosterPath);
    setMeta("collectionPosterPath", collectionPosterPath);
  }
  if (collectionBackdropPath) {
    setRoot("collectionBackdropPath", collectionBackdropPath);
    setMeta("collectionBackdropPath", collectionBackdropPath);
  }

  const tmdbGenres = safeArray(detailsIt?.genres)
    .map((row) => toTmdbGenreKey(row?.id))
    .filter((v) => v && /^tmdb_\d+$/.test(v));
  if (tmdbGenres.length) {
    const mergedGenres = mergeUniqueStrings(title?.genres, tmdbGenres, { maxLen: 40, maxItems: 40 });
    if (!sameArrayShallow(title?.genres, mergedGenres)) {
      patch.genres = mergedGenres;
      changedFields.push("genres");
    }
  }

  const crew = safeArray(detailsIt?.credits?.crew);
  const cast = safeArray(detailsIt?.credits?.cast);
  const tmdbDirectors = uniqueStrings(
    crew.filter((row) => String(row?.job || "") === "Director").map((row) => row?.name),
    { maxLen: 120, maxItems: 8 }
  );
  if (tmdbDirectors.length) {
    const mergedDirectors = mergeUniqueStrings(title?.directors, tmdbDirectors, { maxLen: 120, maxItems: 18 });
    if (!sameArrayShallow(title?.directors, mergedDirectors)) {
      patch.directors = mergedDirectors;
      changedFields.push("directors");
    }
  }

  const tmdbCast = uniqueStrings(cast.slice(0, 12).map((row) => row?.name), { maxLen: 120, maxItems: 12 });
  if (tmdbCast.length) {
    const mergedCast = mergeUniqueStrings(title?.cast, tmdbCast, { maxLen: 120, maxItems: 30 });
    if (!sameArrayShallow(title?.cast, mergedCast)) {
      patch.cast = mergedCast;
      changedFields.push("cast");
    }
  }

  if (tmdbAliases.length) {
    const mergedAliases = mergeUniqueStrings(title?.aliases, tmdbAliases, { maxLen: 160, maxItems: 40 });
    if (!sameArrayShallow(title?.aliases, mergedAliases)) {
      patch.aliases = mergedAliases;
      changedFields.push("aliases");
    }
  }

  if (tmdbKeywords.length) {
    const mergedKeywords = mergeUniqueStrings(title?.keywords, tmdbKeywords, { maxLen: 80, maxItems: 30 });
    if (!sameArrayShallow(title?.keywords, mergedKeywords)) {
      patch.keywords = mergedKeywords;
      changedFields.push("keywords");
    }
  }

  const hasCustomPoster = Boolean(toId(title?.posterStoragePath));
  if (!hasCustomPoster) {
    const posterUrl = tmdbImageUrl(detailsIt?.poster_path, "w500");
    if (posterUrl) setRoot("posterPath", posterUrl);
  }
  const backdropUrl = tmdbImageUrl(detailsIt?.backdrop_path, "w780");
  if (backdropUrl) setRoot("backdropPath", backdropUrl);

  const lang = safeString(
    detailsIt?.spoken_languages?.[0]?.italian_name ||
    detailsIt?.spoken_languages?.[0]?.english_name ||
    detailsIt?.spoken_languages?.[0]?.name ||
    detailsIt?.spoken_languages?.[0]?.iso_639_1 || "",
    80
  ).trim();
  const country = safeString(detailsIt?.production_countries?.[0]?.name || "", 80).trim();
  const network = safeString(detailsIt?.networks?.[0]?.name || "", 120).trim();
  if (lang) setMeta("language", lang);
  if (country) setMeta("country", country);
  if (network) setMeta("network", network);
  const originalLanguageIso = safeString(detailsIt?.original_language || "", 12)
    .trim()
    .toLowerCase();
  if (originalLanguageIso) setMeta("originalLanguage", originalLanguageIso);
  const originCountryCodes = safeArray(detailsIt?.origin_country)
    .map((code) => safeString(code || "", 4).trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 5);
  if (originCountryCodes.length) setMeta("originCountry", originCountryCodes);

  // Duration + episode-count meta (durationMovie / seasons / seasonsCount /
  // episodesPerSeason / durationEpisode) — the fields `estimateTitleTotals`
  // reads for watch-minutes + completion. Delegated to the shared pure builder
  // (functions/lib/tmdbDurations.js) so the full TMDB refresh and the import
  // enrichment tick apply identical logic. Only re-declares meta as changed for
  // the fields it actually touched.
  const durationMeta = buildTitleDurationMetaPatch(currentMeta, detailsIt, mediaType);
  if (durationMeta.changedFields.length) {
    for (const [key, value] of Object.entries(durationMeta.nextMeta)) {
      nextMeta[key] = value;
    }
    metaChanged = true;
    changedFields.push(...durationMeta.changedFields);
  }

  const nextName = patch.name || title?.name || "";
  const nextType = patch.type || title?.type || mediaType;
  const nextYear = (patch.year ?? title?.year ?? null);
  const nextOriginalName = patch.originalName || title?.originalName || "";
  const nextAliases = patch.aliases || title?.aliases || [];
  const nextKeywords = patch.keywords || title?.keywords || [];
  const nextCollectionName = patch.collectionName || title?.collectionName || currentMeta.collectionName || "";
  const nextDescriptionText = patch.description || title?.description || "";
  const searchSnapshot = buildTitleSearchSnapshot({
    title,
    nextName,
    nextType,
    nextYear,
    nextOriginalName,
    nextAliases,
    nextCollectionName,
    nextKeywords,
    nextDescription: nextDescriptionText,
  });

  if (searchSnapshot.nameLower && searchSnapshot.nameLower !== String(title?.nameLower || "")) {
    patch.nameLower = searchSnapshot.nameLower;
    changedFields.push("nameLower");
  }

  if (searchSnapshot.searchableText && searchSnapshot.searchableText !== String(title?.searchableText || "")) {
    patch.searchableText = searchSnapshot.searchableText;
    changedFields.push("searchableText");
  }

  if (searchSnapshot.changed) {
    patch.search = searchSnapshot.nextSearch;
    changedFields.push("search");
  }

  // altNamesLower: denormalizzato per il matching import (netflixCsv/tvTimeGdpr
  // -> matching.js), popolato qui perche' detailsIt/detailsEn gia' includono
  // `alternative_titles` via append_to_response (nessuna chiamata TMDB extra).
  const nextNameLower = searchSnapshot.nameLower || String(title?.nameLower || "");
  const altNamesLower = uniqueStrings([
    ...extractAltNamesLower(detailsIt, { nameLower: nextNameLower, mediaType }),
    ...extractAltNamesLower(detailsEn, { nameLower: nextNameLower, mediaType }),
  ], { maxLen: 80, maxItems: 10 });
  if (altNamesLower.length) {
    const mergedAltNames = mergeUniqueStrings(title?.altNamesLower, altNamesLower, { maxLen: 80, maxItems: 10 })
      .filter((v) => v !== nextNameLower);
    if (!sameArrayShallow(title?.altNamesLower, mergedAltNames)) {
      patch.altNamesLower = mergedAltNames;
      changedFields.push("altNamesLower");
    }
  }

  if (metaChanged) patch.meta = nextMeta;
  return { patch, changedFields };
}

exports.refreshTitleFromTmdb = functions
  .region("europe-west1")
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid;
    if (!uid) {
      throw new functions.https.HttpsError("unauthenticated", "Devi essere autenticato.");
    }
    const db = admin.firestore();
    await enforceCallableRateLimit(db, uid, "refreshTitleFromTmdb", {
      windowSeconds: 10,
      maxInWindow: 4,
      dailyMax: 600,
    });

    const titleId = toId(data?.titleId);
    if (!titleId) {
      throw new functions.https.HttpsError("invalid-argument", "titleId mancante.");
    }

    const force = data?.force === true && getAdminUids().includes(uid);
    const nowMs = Date.now();
    const titleRef = db.collection("titles").doc(titleId);

    let txResult;
    try {
      txResult = await db.runTransaction(async (tx) => {
        const snap = await tx.get(titleRef);
        if (!snap.exists) return { notFound: true };

        const title = snap.data() || {};
        const sync = asObject(title.tmdbSync);
        const lockUntilMs = Number(sync.refreshLockUntilMs || 0);
        const nextCheckAtMs = toMillis(sync.nextCheckAt) || Number(sync.nextCheckAtMs || 0);

        // Titolo curato manualmente (es. merge di vari id TMDB in uno solo):
        // mai risincronizzare da TMDB, nemmeno con force.
        if (sync.syncDisabled === true) {
          return { shouldRun: false, reason: "sync_disabled", nextCheckAtMs };
        }
        if (!force && lockUntilMs > nowMs) {
          return { shouldRun: false, reason: "locked", nextCheckAtMs };
        }
        if (!force && nextCheckAtMs > nowMs) {
          return { shouldRun: false, reason: "cooldown", nextCheckAtMs };
        }

        tx.set(titleRef, {
          tmdbSync: {
            ...sync,
            refreshLockUntilMs: nowMs + TMDB_TITLE_REFRESH_LOCK_MS,
            lastRequestAt: admin.firestore.FieldValue.serverTimestamp(),
            requestedBy: uid || "anon",
          },
        }, { merge: true });

        return { shouldRun: true, title };
      });
    } catch (err) {
      logger.warn("[tmdb-refresh] claim lock failed", {
        titleId,
        uid,
        message: safeString(err?.message || String(err), 180),
      });
      return { ok: false, checked: false, updated: false, reason: "lock_error" };
    }

    if (txResult?.notFound) {
      throw new functions.https.HttpsError("not-found", "Titolo non trovato.");
    }
    if (!txResult?.shouldRun) {
      return {
        ok: true,
        checked: false,
        updated: false,
        reason: txResult?.reason || "cooldown",
        nextCheckAtMs: Number(txResult?.nextCheckAtMs || 0),
      };
    }

    try {
      const claimedTitle = txResult?.title || {};
      if (String(claimedTitle?.status || "") !== "approved") {
        await titleRef.set({
          tmdbSync: {
            ...asObject(claimedTitle.tmdbSync),
            refreshLockUntilMs: 0,
            lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
            nextCheckAt: admin.firestore.Timestamp.fromMillis(nowMs + TMDB_TITLE_REFRESH_INTERVAL_MS),
            lastStatus: "not_approved",
            lastError: "",
          },
        }, { merge: true });
        return { ok: true, checked: false, updated: false, reason: "not_approved" };
      }

      if (!getTmdbApiKey()) {
        await titleRef.set({
          tmdbSync: {
            ...asObject(claimedTitle.tmdbSync),
            refreshLockUntilMs: 0,
            lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
            nextCheckAt: admin.firestore.Timestamp.fromMillis(nowMs + TMDB_TITLE_REFRESH_RETRY_MS),
            lastStatus: "tmdb_key_missing",
            lastError: "TMDB API key mancante",
          },
        }, { merge: true });
        return { ok: false, checked: false, updated: false, reason: "tmdb_key_missing" };
      }

      const state = { maxApiCalls: 18, maxAttempts: 3 };
      const target = await resolveTmdbTargetForTitle({ db, titleId, title: claimedTitle, state });
      if (!target?.tmdbId) {
        await titleRef.set({
          tmdbSync: {
            ...asObject(claimedTitle.tmdbSync),
            refreshLockUntilMs: 0,
            lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
            nextCheckAt: admin.firestore.Timestamp.fromMillis(nowMs + TMDB_TITLE_REFRESH_INTERVAL_MS),
            lastStatus: "no_tmdb_match",
            lastError: "",
          },
        }, { merge: true });
        return { ok: true, checked: true, updated: false, reason: "no_tmdb_match" };
      }

      const detailsPath = target.mediaType === "tv" ? `/tv/${target.tmdbId}` : `/movie/${target.tmdbId}`;
      const detailsIt = await fetchTmdbCachedJson(detailsPath, {
        language: "it-IT",
        append_to_response: "credits,keywords,alternative_titles",
      }, {
        db,
        state,
        cacheScope: `titleRefreshDetails_${target.mediaType}`,
        ttlSeconds: 7 * 24 * 60 * 60,
        allowStaleOnError: true,
      });

      let detailsEnPayload = null;
      if (!safeString(detailsIt?.data?.overview || "", 2200).trim()) {
        const detailsEn = await fetchTmdbCachedJson(detailsPath, {
          language: "en-US",
          append_to_response: "credits,keywords,alternative_titles",
        }, {
          db,
          state,
          cacheScope: `titleRefreshDetailsEn_${target.mediaType}`,
          ttlSeconds: 14 * 24 * 60 * 60,
          allowStaleOnError: true,
        });
        detailsEnPayload = detailsEn?.data || null;
      }

      const latestSnap = await titleRef.get();
      if (!latestSnap.exists) {
        throw new Error("Titolo non trovato dopo lock.");
      }
      const latestTitle = latestSnap.data() || {};

      const { patch, changedFields } = buildTmdbTitleRefreshPatch({
        title: latestTitle,
        target,
        detailsIt: detailsIt?.data || {},
        detailsEn: detailsEnPayload,
      });

      const nextCheckAt = admin.firestore.Timestamp.fromMillis(Date.now() + TMDB_TITLE_REFRESH_INTERVAL_MS);
      const writePayload = {
        tmdbSync: {
          ...asObject(latestTitle.tmdbSync),
          refreshLockUntilMs: 0,
          lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
          nextCheckAt,
          lastStatus: "ok",
          lastError: "",
          lastTmdbId: target.tmdbId,
          lastMediaType: target.mediaType,
          lastSource: String(detailsIt?.cache?.source || "network"),
          lastChangedFields: changedFields.slice(0, 30),
          metadataBackfillVersion: TITLE_METADATA_BACKFILL_VERSION,
          metadataBackfillAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      };

      if (changedFields.length) {
        Object.assign(writePayload, patch);
        writePayload.updatedAt = admin.firestore.FieldValue.serverTimestamp();
        writePayload.tmdbSync.lastUpdatedAt = admin.firestore.FieldValue.serverTimestamp();
      }

      await titleRef.set(writePayload, { merge: true });

      return {
        ok: true,
        checked: true,
        updated: changedFields.length > 0,
        changedFields: changedFields.slice(0, 30),
        tmdbId: target.tmdbId,
        mediaType: target.mediaType,
        nextCheckAtMs: nextCheckAt.toMillis(),
      };
    } catch (err) {
      logger.warn("[tmdb-refresh] failed", {
        titleId,
        uid,
        message: safeString(err?.message || String(err), 220),
        code: String(err?.code || ""),
      });

      await titleRef.set({
        tmdbSync: {
          refreshLockUntilMs: 0,
          lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
          nextCheckAt: admin.firestore.Timestamp.fromMillis(Date.now() + TMDB_TITLE_REFRESH_RETRY_MS),
          lastStatus: "error",
          lastError: safeString(err?.message || String(err), 220),
        },
      }, { merge: true });

      return {
        ok: false,
        checked: false,
        updated: false,
        reason: "error",
        error: safeString(err?.message || String(err), 220),
      };
    }
  });

function toTimestampOrNull(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return admin.firestore.Timestamp.fromDate(value);
  }
  if (typeof value?.toMillis === "function" && typeof value?.toDate === "function") {
    return value;
  }
  if (typeof value === "object" && Number.isFinite(value._seconds)) {
    return new admin.firestore.Timestamp(value._seconds, Number(value._nanoseconds || 0));
  }
  return null;
}

function firstTimestamp(...values) {
  for (const value of values) {
    const ts = toTimestampOrNull(value);
    if (ts) return ts;
  }
  return null;
}

function plusDaysTimestamp(value, days) {
  const baseMs = toMillis(value) || Date.now();
  return admin.firestore.Timestamp.fromMillis(baseMs + (days * DAY_MS));
}

function uniqueIdList(values) {
  const out = [];
  const seen = new Set();
  for (const raw of safeArray(values)) {
    const value = String(raw || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

async function isAdminCaller(db, uid) {
  if (!uid) return false;
  if (getAdminUids().includes(uid)) return true;
  const userSnap = await db.collection("users").doc(uid).get().catch(() => null);
  return Boolean(userSnap?.exists && userSnap.data()?.isAdmin === true);
}

function buildReminderHintsData({ mediaType, state, generalWatchlist, lastProgressAt }) {
  const ratingReminderEligible = state === "seen_unrated" || state === "completed_unrated";
  const resumeReminderEligible = mediaType === "tv" && generalWatchlist && state === "in_progress";
  return {
    ratingReminderEligible,
    resumeReminderEligible,
    lastProgressAt: lastProgressAt || null,
    suggestedReminderAt: (ratingReminderEligible || resumeReminderEligible)
      ? plusDaysTimestamp(lastProgressAt, 3)
      : null,
  };
}

function buildTitleSnapshotData(titleId, title, mediaType) {
  const watchSnapshot = asObject(title?.titleSnapshot);
  return {
    titleId,
    name: safeString(title?.name || watchSnapshot?.name || "Titolo", 180) || "Titolo",
    posterPath: safeString(title?.posterPath || watchSnapshot?.posterPath || "", 500) || null,
    mediaType,
  };
}

function estimateSeriesTotalsFromTitle(title) {
  const meta = asObject(title?.meta);
  const totalSeasonCount = toPositiveInt(meta?.seasonsCount) || null;
  const episodesPerSeason = toPositiveInt(meta?.episodesPerSeason) || null;
  const totalEpisodeCount = totalSeasonCount && episodesPerSeason
    ? totalSeasonCount * episodesPerSeason
    : null;
  return { totalSeasonCount, episodesPerSeason, totalEpisodeCount };
}

function buildMigratedTitleState({ titleId, title, watchDoc, libraryDoc, ratingDoc }) {
  const watchData = asObject(watchDoc);
  const libraryData = asObject(libraryDoc);
  const ratingData = asObject(ratingDoc);
  const mediaType = normalizeTmdbMediaType(
    title?.type || title?.meta?.mediaType || watchData?.mediaType || libraryData?.mediaType || "movie"
  );
  const inLegacyWatchlist = Boolean(watchDoc);
  const legacyWatchState = safeString(watchData?.watchState || "", 40).toLowerCase();
  const legacyInProgress = ["watching", "in_progress", "started", "continue"].includes(legacyWatchState);
  const legacyCompleted = ["completed", "watched", "done"].includes(legacyWatchState);
  const numericRating = Number(ratingData?.rating ?? libraryData?.lastRating ?? 0);
  const hasRating = Number.isFinite(numericRating) && numericRating > 0;
  const ratingValue = hasRating ? Number(numericRating.toFixed(2)) : null;
  // IMPORTANTE: NON usare `watchData?.updatedAt` come segnale di "visto".
  // L'updatedAt di una riga watchlist e' solo l'ora dell'ultima modifica
  // del record "da vedere", non la prova di averlo guardato. Includerlo qui
  // marcava ogni titolo "da vedere" come seen_unrated/completed_unrated
  // (vedi branch sotto: `seenAt || ...`), svuotando la watchlist in "visti".
  // Il segnale "visto" arriva da: doc library, rating, watchState completato,
  // o un seenAt esplicito sulla riga watchlist.
  const seenAt = firstTimestamp(
    libraryData?.seenAt,
    libraryData?.updatedAt,
    ratingData?.seenAt,
    ratingData?.updatedAt,
    ratingData?.createdAt,
    watchData?.seenAt
  );
  const ratedAt = hasRating
    ? firstTimestamp(
      libraryData?.ratedAt,
      ratingData?.updatedAt,
      ratingData?.createdAt,
      libraryData?.updatedAt
    )
    : null;
  const createdAt = firstTimestamp(
    watchData?.addedAt,
    watchData?.createdAt,
    libraryData?.createdAt,
    ratingData?.createdAt,
    seenAt,
    ratedAt
  ) || admin.firestore.Timestamp.fromMillis(Date.now());
  const updatedAt = firstTimestamp(
    ratedAt,
    libraryData?.updatedAt,
    watchData?.updatedAt,
    seenAt,
    createdAt
  ) || createdAt;

  let state = mediaType === "tv" ? "not_started" : "unseen";
  let generalWatchlist = inLegacyWatchlist;
  let completedAt = null;
  let seriesProgress = null;
  let reminderAnchor = seenAt || updatedAt;

  if (mediaType === "movie") {
    if (hasRating) {
      state = "rated";
      generalWatchlist = false;
    } else if (seenAt || legacyCompleted || Object.keys(libraryData).length > 0) {
      state = "seen_unrated";
      generalWatchlist = false;
    }
  } else {
    const totals = estimateSeriesTotalsFromTitle(title);
    if (hasRating) {
      state = "rated";
      generalWatchlist = false;
      completedAt = firstTimestamp(libraryData?.seenAt, ratedAt, seenAt, updatedAt);
      seriesProgress = {
        episodesWatchedCount: totals.totalEpisodeCount || 0,
        seasonsCompletedCount: totals.totalSeasonCount || 0,
        totalEpisodeCount: totals.totalEpisodeCount,
        totalSeasonCount: totals.totalSeasonCount,
        lastWatchedEpisodeId: null,
        lastWatchedEpisodeName: null,
        lastWatchedSeasonNumber: totals.totalSeasonCount,
        lastWatchedEpisodeNumber: totals.episodesPerSeason,
        lastWatchedAt: completedAt || ratedAt,
        percentComplete: 1,
      };
      reminderAnchor = completedAt || ratedAt || updatedAt;
    } else if (seenAt || legacyCompleted || Object.keys(libraryData).length > 0) {
      state = "completed_unrated";
      generalWatchlist = false;
      completedAt = firstTimestamp(libraryData?.seenAt, seenAt, updatedAt);
      seriesProgress = {
        episodesWatchedCount: totals.totalEpisodeCount || 0,
        seasonsCompletedCount: totals.totalSeasonCount || 0,
        totalEpisodeCount: totals.totalEpisodeCount,
        totalSeasonCount: totals.totalSeasonCount,
        lastWatchedEpisodeId: null,
        lastWatchedEpisodeName: null,
        lastWatchedSeasonNumber: totals.totalSeasonCount,
        lastWatchedEpisodeNumber: totals.episodesPerSeason,
        lastWatchedAt: completedAt,
        percentComplete: 1,
      };
      reminderAnchor = completedAt || updatedAt;
    } else if (legacyInProgress) {
      const episodeProgress = totals.totalEpisodeCount ? 1 : 0;
      const percentComplete = totals.totalEpisodeCount
        ? Math.min(1, 1 / totals.totalEpisodeCount)
        : (totals.totalSeasonCount ? Math.min(1, 1 / totals.totalSeasonCount) : 0.05);
      state = "in_progress";
      generalWatchlist = true;
      seriesProgress = {
        episodesWatchedCount: episodeProgress,
        seasonsCompletedCount: 0,
        totalEpisodeCount: totals.totalEpisodeCount,
        totalSeasonCount: totals.totalSeasonCount,
        lastWatchedEpisodeId: null,
        lastWatchedEpisodeName: null,
        lastWatchedSeasonNumber: null,
        lastWatchedEpisodeNumber: null,
        lastWatchedAt: firstTimestamp(watchData?.updatedAt, watchData?.addedAt),
        percentComplete,
      };
      reminderAnchor = seriesProgress.lastWatchedAt || updatedAt;
    } else {
      state = "not_started";
      generalWatchlist = inLegacyWatchlist;
      seriesProgress = {
        episodesWatchedCount: 0,
        seasonsCompletedCount: 0,
        totalEpisodeCount: totals.totalEpisodeCount,
        totalSeasonCount: totals.totalSeasonCount,
        lastWatchedEpisodeId: null,
        lastWatchedEpisodeName: null,
        lastWatchedSeasonNumber: null,
        lastWatchedEpisodeNumber: null,
        lastWatchedAt: null,
        percentComplete: 0,
      };
      reminderAnchor = updatedAt;
    }
  }

  if (!generalWatchlist && !hasRating && !seenAt && !legacyCompleted && !legacyInProgress && Object.keys(libraryData).length === 0) {
    return null;
  }

  const nextState = {
    titleId,
    mediaType,
    state,
    generalWatchlist,
    hasTitleRating: hasRating,
    ratingValue,
    seenAt: mediaType === "movie" ? (seenAt || (state !== "unseen" ? updatedAt : null)) : seenAt,
    completedAt,
    ratedAt,
    source: "legacy_watchlist_migration_v2",
    createdAt,
    updatedAt,
    lastInteractionAt: updatedAt,
    seriesProgress,
    reminders: buildReminderHintsData({
      mediaType,
      state,
      generalWatchlist,
      lastProgressAt: reminderAnchor,
    }),
    titleSnapshot: buildTitleSnapshotData(titleId, title, mediaType),
  };

  const completedCount = mediaType === "movie"
    ? ((state === "seen_unrated" || state === "rated") ? 1 : 0)
    : ((state === "completed_unrated" || state === "rated") ? 1 : 0);

  nextState.completedCount = completedCount;
  nextState.watchMinutesContribution = computeWatchMinutesContribution(title, {
    ...nextState,
    completedCount,
  });
  nextState.schemaVersion = TITLE_STATE_SCHEMA_VERSION;

  return nextState;
}

function isCompletedPersonalState(stateData) {
  const mediaType = normalizeTmdbMediaType(stateData?.mediaType || "movie");
  const state = safeString(stateData?.state || "", 40).toLowerCase();
  return mediaType === "tv"
    ? (state === "completed_unrated" || state === "rated")
    : (state === "seen_unrated" || state === "rated");
}

function isInProgressSeriesState(stateData) {
  return normalizeTmdbMediaType(stateData?.mediaType || "movie") === "tv"
    && safeString(stateData?.state || "", 40).toLowerCase() === "in_progress";
}

function sanitizeTitleStateActionPayload(data = {}) {
  const action = safeString(data?.action || "", 60).trim().toLowerCase();
  const supportedActions = new Set([
    "toggle_watchlist",
    "mark_movie_seen",
    "mark_movie_unseen",
    "mark_series_episode",
    "mark_series_season",
    "mark_series_completed",
    "mark_series_unstarted",
    "set_rewatch_intent",
    "clear_rewatch_intent",
    "set_series_progress",
    "acknowledge_new_content",
  ]);

  if (!supportedActions.has(action)) {
    throw new functions.https.HttpsError("invalid-argument", "Azione titleState non supportata.");
  }

  return {
    type: action,
    source: safeString(data?.source || "apply_title_state_action", 80).trim() || "apply_title_state_action",
    enabled: typeof data?.enabled === "boolean" ? data.enabled : undefined,
    episodesWatchedCount: toPositiveInt(data?.episodesWatchedCount),
    seasonsCompletedCount: toPositiveInt(data?.seasonsCompletedCount),
    lastWatchedSeasonNumber: toPositiveInt(data?.lastWatchedSeasonNumber),
    lastWatchedEpisodeNumber: toPositiveInt(data?.lastWatchedEpisodeNumber),
  };
}

function productTrackingTimestamp(valueMs) {
  const value = Number(valueMs || 0);
  return value > 0 ? admin.firestore.Timestamp.fromMillis(value) : null;
}

function productTrackingFirestorePayload(stateRaw) {
  const state = normalizeTrackingState(stateRaw);
  return {
    schemaVersion: state.schemaVersion,
    cohortOrigin: state.cohortOrigin || null,
    migrationVersion: state.migrationVersion || null,
    firstSuccessfulImportAt: productTrackingTimestamp(state.firstSuccessfulImportAtMs),
    lastSuccessfulImportAt: productTrackingTimestamp(state.lastSuccessfulImportAtMs),
    firstManualProgressAt: productTrackingTimestamp(state.firstManualProgressAtMs),
    lastManualProgressAt: productTrackingTimestamp(state.lastManualProgressAtMs),
    firstManualProgressAfterImportAt: productTrackingTimestamp(state.firstManualProgressAfterImportAtMs),
    firstManualProgressAtOrAfterD1: productTrackingTimestamp(state.firstManualProgressAtOrAfterD1Ms),
    firstManualProgressAtOrAfterD3: productTrackingTimestamp(state.firstManualProgressAtOrAfterD3Ms),
    firstManualProgressAtOrAfterD7: productTrackingTimestamp(state.firstManualProgressAtOrAfterD7Ms),
    updatedAt: productTrackingTimestamp(state.updatedAtMs),
    expiresAt: productTrackingTimestamp(state.expiresAtMs),
  };
}

async function recordSuccessfulImportTracking({
  db,
  uid,
  completedAt,
  cohortOrigin = "prospective",
  migrationVersion = null,
}) {
  const completedAtMs = toMillis(completedAt);
  if (!uid || !completedAtMs) return false;
  const userRef = db.collection("users").doc(uid);
  const trackingRef = userRef.collection("_system").doc("productTracking");

  return db.runTransaction(async (tx) => {
    const [userSnap, trackingSnap] = await Promise.all([
      tx.get(userRef),
      tx.get(trackingRef),
    ]);
    const userData = userSnap.exists ? (userSnap.data() || {}) : {};
    if (isExcludedFromProductAnalytics(uid, userData)) return false;
    const next = buildSuccessfulImportTrackingState(
      trackingSnap.exists ? (trackingSnap.data() || {}) : {},
      { completedAtMs, cohortOrigin, migrationVersion }
    );
    tx.set(trackingRef, productTrackingFirestorePayload(next), { merge: true });
    return true;
  });
}

function actionNeedsWatchMetrics(action) {
  const type = safeString(action?.type || action?.action || "", 80).trim().toLowerCase();
  return [
    "mark_movie_seen",
    "mark_series_episode",
    "mark_series_season",
    "mark_series_completed",
    "set_series_progress",
  ].includes(type);
}

function titleHasRequiredWatchMetrics(title, action = {}) {
  const titleData = asObject(title);
  const totals = estimateTitleTotals(titleData);
  if (totals.mediaType === "movie") {
    return toPositiveInt(totals.durationMovie) > 0;
  }
  if (totals.mediaType !== "tv") return true;
  if (!toPositiveInt(totals.durationEpisode)) return false;

  const actionType = safeString(action?.type || action?.action || "", 80).trim().toLowerCase();
  if (actionType === "mark_series_completed") {
    return toPositiveInt(totals.totalEpisodeCount) > 0;
  }
  return true;
}

function titleWatchMetricsSignature(title) {
  const totals = estimateTitleTotals(title || {});
  return [
    totals.mediaType || "",
    toPositiveInt(totals.durationMovie),
    toPositiveInt(totals.durationEpisode),
    toPositiveInt(totals.totalEpisodeCount),
    toPositiveInt(totals.totalSeasonCount),
  ].join(":");
}

async function refreshTitleWatchMetricsIfNeeded({ db, titleId, action, requestedBy = "system" }) {
  if (!actionNeedsWatchMetrics(action)) {
    return { attempted: false, reason: "action_not_watch_metric_sensitive" };
  }

  const titleRef = db.collection("titles").doc(titleId);
  const titleSnap = await titleRef.get().catch(() => null);
  if (!titleSnap?.exists) return { attempted: false, reason: "missing_title" };

  const title = titleSnap.data() || {};
  if (titleHasRequiredWatchMetrics(title, action)) {
    return { attempted: false, reason: "already_has_metrics" };
  }
  if (safeString(title.status || "", 32) !== "approved") {
    return { attempted: false, reason: "not_approved" };
  }
  const sync = asObject(title.tmdbSync);
  if (sync.syncDisabled === true) {
    return { attempted: false, reason: "sync_disabled" };
  }
  if (!getTmdbApiKey()) {
    return { attempted: false, reason: "tmdb_key_missing" };
  }

  const state = { maxApiCalls: 10, maxAttempts: 2 };
  const target = await resolveTmdbTargetForTitle({ db, titleId, title, state });
  if (!target?.tmdbId) {
    return { attempted: true, refreshed: false, reason: "no_tmdb_match" };
  }

  const detailsPath = target.mediaType === "tv" ? `/tv/${target.tmdbId}` : `/movie/${target.tmdbId}`;
  const detailsIt = await fetchTmdbCachedJson(detailsPath, {
    language: "it-IT",
    append_to_response: "credits,keywords,alternative_titles",
  }, {
    db,
    state,
    cacheScope: `titleMetricsPreflight_${target.mediaType}`,
    ttlSeconds: 7 * 24 * 60 * 60,
    allowStaleOnError: true,
  });

  const latestSnap = await titleRef.get().catch(() => null);
  if (!latestSnap?.exists) return { attempted: true, refreshed: false, reason: "missing_title_after_fetch" };
  const latestTitle = latestSnap.data() || {};
  if (titleHasRequiredWatchMetrics(latestTitle, action)) {
    return { attempted: true, refreshed: false, reason: "already_refreshed" };
  }

  const { patch, changedFields } = buildTmdbTitleRefreshPatch({
    title: latestTitle,
    target,
    detailsIt: detailsIt?.data || {},
    detailsEn: null,
  });

  const writePayload = {
    tmdbSync: {
      ...asObject(latestTitle.tmdbSync),
      lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
      nextCheckAt: admin.firestore.Timestamp.fromMillis(Date.now() + TMDB_TITLE_REFRESH_INTERVAL_MS),
      lastStatus: "ok",
      lastError: "",
      lastTmdbId: target.tmdbId,
      lastMediaType: target.mediaType,
      lastSource: String(detailsIt?.cache?.source || "network"),
      lastChangedFields: changedFields.slice(0, 30),
      metadataBackfillVersion: TITLE_METADATA_BACKFILL_VERSION,
      metadataBackfillAt: admin.firestore.FieldValue.serverTimestamp(),
      metricsPreflightAt: admin.firestore.FieldValue.serverTimestamp(),
      metricsPreflightBy: safeString(requestedBy || "system", 128),
    },
  };

  if (changedFields.length) {
    Object.assign(writePayload, patch);
    writePayload.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    writePayload.tmdbSync.lastUpdatedAt = admin.firestore.FieldValue.serverTimestamp();
  }

  await titleRef.set(writePayload, { merge: true });
  return {
    attempted: true,
    refreshed: changedFields.length > 0,
    changedFields: changedFields.slice(0, 30),
    tmdbId: target.tmdbId,
    mediaType: target.mediaType,
  };
}

function buildFirestoreProjectionPayload(basePayload, serverTimestampField, timestampKey) {
  const payload = { ...(basePayload || {}) };
  if (!payload || !Object.keys(payload).length) return null;
  payload.updatedAt = serverTimestampField;
  if (timestampKey && !payload[timestampKey]) {
    payload[timestampKey] = serverTimestampField;
  }
  return payload;
}

async function buildMissingWatchMetricsIssue({ db, uid, titleId, afterState, title: providedTitle }) {
  const after = computeUserStatsContribution(afterState);
  if (after.watchedCount <= 0 || after.totalWatchMinutes > 0) return null;

  let title = providedTitle;
  if (title === undefined) {
    const titleSnap = await db.collection("titles").doc(titleId).get().catch(() => null);
    title = titleSnap?.exists ? { id: titleId, ...(titleSnap.data() || {}) } : null;
  }
  const mediaType = String(afterState?.mediaType || title?.type || title?.meta?.mediaType || "movie")
    .trim()
    .toLowerCase() === "tv" ? "tv" : "movie";
  const totals = title ? estimateTitleTotals(title) : {};
  const progress = afterState?.seriesProgress || {};

  let reason = "unknown_zero_contribution";
  if (!title) {
    reason = "missing_title";
  } else if (mediaType === "movie" && !toPositiveInt(totals.durationMovie)) {
    reason = "missing_movie_duration";
  } else if (mediaType === "tv" && !toPositiveInt(totals.durationEpisode)) {
    reason = "missing_episode_duration";
  } else if (
    mediaType === "tv"
    && !toPositiveInt(afterState?.completedAtTotalEpisodes)
    && !toPositiveInt(progress?.episodesWatchedCount)
    && !toPositiveInt(totals.totalEpisodeCount)
  ) {
    reason = "missing_episode_totals";
  }

  return {
    kind: "missing_watch_minutes",
    status: "open",
    reason,
    uid,
    titleId,
    mediaType,
    state: safeString(afterState?.state || "", 80) || null,
    titleName: safeString(title?.name || afterState?.titleSnapshot?.name || titleId, 180) || titleId,
    titlePath: title ? `titles/${titleId}` : null,
    statePath: `users/${uid}/titleStates/${titleId}`,
    titleSnapshot: afterState?.titleSnapshot || null,
    ratingValue: afterState?.ratingValue ?? null,
    completedCount: toPositiveInt(afterState?.completedCount),
    completedAtTotalEpisodes: toPositiveInt(afterState?.completedAtTotalEpisodes) || null,
    completedAtTotalSeasons: toPositiveInt(afterState?.completedAtTotalSeasons) || null,
    episodesWatchedCount: toPositiveInt(progress?.episodesWatchedCount),
    seasonsCompletedCount: toPositiveInt(progress?.seasonsCompletedCount),
    durationMovie: toPositiveInt(totals.durationMovie) || null,
    durationEpisode: toPositiveInt(totals.durationEpisode) || null,
    totalEpisodeCount: toPositiveInt(totals.totalEpisodeCount) || null,
    totalSeasonCount: toPositiveInt(totals.totalSeasonCount) || null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

function buildTitleStateMetricsRepairPayload(stateData, titleData) {
  const state = asObject(stateData);
  const title = asObject(titleData);
  const totals = estimateTitleTotals(title);
  const repaired = { ...state };
  const progress = asObject(state.seriesProgress);
  let changed = false;

  if (normalizeTmdbMediaType(state.mediaType || title.type || title.meta?.mediaType) === "tv"
    && isCompletedPersonalState(state)) {
    const totalEpisodeCount = toPositiveInt(totals.totalEpisodeCount);
    const totalSeasonCount = toPositiveInt(totals.totalSeasonCount);
    if (totalEpisodeCount && !toPositiveInt(repaired.completedAtTotalEpisodes)) {
      repaired.completedAtTotalEpisodes = totalEpisodeCount;
      changed = true;
    }
    if (totalSeasonCount && !toPositiveInt(repaired.completedAtTotalSeasons)) {
      repaired.completedAtTotalSeasons = totalSeasonCount;
      changed = true;
    }
    // Il riempimento del progresso e' tappato allo snapshot di completamento,
    // non ai totali correnti. Se TMDB aggiunge una stagione DOPO che l'utente
    // ha finito la serie, quegli episodi non li ha visti: alzarli qui glieli
    // accreditava e rendeva impossibile tracciare la stagione nuova
    // (incidente Ted Lasso S4, 2026-08-04). `hasNewContent` segnala gia' la
    // novita', quindi lo stato "finita" resta coerente senza mentire.
    const watchedEpisodesCap = toPositiveInt(repaired.completedAtTotalEpisodes) || totalEpisodeCount;
    const watchedSeasonsCap = toPositiveInt(repaired.completedAtTotalSeasons) || totalSeasonCount;

    const nextProgress = { ...progress };
    if (watchedEpisodesCap && toPositiveInt(nextProgress.episodesWatchedCount) < watchedEpisodesCap) {
      nextProgress.episodesWatchedCount = watchedEpisodesCap;
      changed = true;
    }
    if (watchedSeasonsCap && toPositiveInt(nextProgress.seasonsCompletedCount) < watchedSeasonsCap) {
      nextProgress.seasonsCompletedCount = watchedSeasonsCap;
      changed = true;
    }
    // I totali invece seguono sempre TMDB: servono a mostrare "34 di 44".
    if (totalEpisodeCount && toPositiveInt(nextProgress.totalEpisodeCount) !== totalEpisodeCount) {
      nextProgress.totalEpisodeCount = totalEpisodeCount;
      changed = true;
    }
    if (totalSeasonCount && toPositiveInt(nextProgress.totalSeasonCount) !== totalSeasonCount) {
      nextProgress.totalSeasonCount = totalSeasonCount;
      changed = true;
    }
    if (totalEpisodeCount) {
      const watched = toPositiveInt(nextProgress.episodesWatchedCount);
      const nextPercent = Math.max(0, Math.min(1, watched / totalEpisodeCount));
      if (nextProgress.percentComplete !== nextPercent) {
        nextProgress.percentComplete = nextPercent;
        changed = true;
      }
    } else if (totalSeasonCount) {
      nextProgress.percentComplete = 1;
    }
    repaired.seriesProgress = nextProgress;
  }

  const nextMinutes = computeWatchMinutesContribution(title, repaired);
  if (toPositiveInt(state.watchMinutesContribution) !== nextMinutes) {
    repaired.watchMinutesContribution = nextMinutes;
    changed = true;
  }
  if (toPositiveInt(state.schemaVersion) !== TITLE_STATE_SCHEMA_VERSION) {
    repaired.schemaVersion = TITLE_STATE_SCHEMA_VERSION;
    changed = true;
  }

  if (!changed) return null;
  const payload = {
    watchMinutesContribution: nextMinutes,
    schemaVersion: TITLE_STATE_SCHEMA_VERSION,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (repaired.completedAtTotalEpisodes !== state.completedAtTotalEpisodes) {
    payload.completedAtTotalEpisodes = repaired.completedAtTotalEpisodes || null;
  }
  if (repaired.completedAtTotalSeasons !== state.completedAtTotalSeasons) {
    payload.completedAtTotalSeasons = repaired.completedAtTotalSeasons || null;
  }
  if (!sameJsonValue(repaired.seriesProgress, state.seriesProgress)) {
    payload.seriesProgress = repaired.seriesProgress;
  }
  return payload;
}

async function syncLegacyTitleStateProjectionsAndStats({ db, uid, titleId, beforeState, afterState }) {
  const userRef = db.collection("users").doc(uid);
  const serverTimestampField = admin.firestore.FieldValue.serverTimestamp();
  const batch = db.batch();
  const libraryRef = userRef.collection("library").doc(titleId);
  const watchlistRef = userRef.collection("watchlist").doc(titleId);
  const metadataIssueRef = db.collection("metadataIssues").doc(`${uid}__${titleId}`);

  if (afterState) {
    const libraryPayload = buildFirestoreProjectionPayload(
      buildLegacyLibraryProjection(afterState),
      serverTimestampField,
      "createdAt"
    );
    const watchlistPayload = buildFirestoreProjectionPayload(
      buildLegacyWatchlistProjection(afterState),
      serverTimestampField,
      "addedAt"
    );

    if (libraryPayload) {
      batch.set(libraryRef, libraryPayload, { merge: true });
    } else {
      batch.delete(libraryRef);
    }

    if (watchlistPayload) {
      batch.set(watchlistRef, watchlistPayload, { merge: true });
    } else {
      batch.delete(watchlistRef);
    }
  } else {
    batch.delete(libraryRef);
    batch.delete(watchlistRef);
  }

  // The title doc resolves the per-category breakdown and also feeds
  // buildMissingWatchMetricsIssue, so fetch it once and reuse it.
  const titleSnap = await db.collection("titles").doc(titleId).get().catch(() => null);
  const title = titleSnap && titleSnap.exists
    ? { id: titleId, ...(titleSnap.data() || {}) }
    : null;

  // Incremental stats: apply only the delta this titleState write introduces,
  // instead of re-summing the whole titleStates collection on every write.
  // Drift from at-least-once trigger retries is reconciled by reconcileUserStats.
  const before = computeUserStatsContribution(beforeState);
  const after = computeUserStatsContribution(afterState);
  const category = deriveContentCategory(
    title || { type: (afterState || beforeState || {}).mediaType }
  );
  const statsDelta = {};
  const categoryDelta = {};
  for (const metric of ["watchedCount", "ratingsCount", "totalWatchMinutes", "rewatchCount"]) {
    const diff = after[metric] - before[metric];
    if (diff !== 0) {
      statsDelta[metric] = admin.firestore.FieldValue.increment(diff);
      categoryDelta[metric] = admin.firestore.FieldValue.increment(diff);
    }
  }
  if (Object.keys(categoryDelta).length) {
    statsDelta.byCategory = { [category]: categoryDelta };
  }
  if (Object.keys(statsDelta).length) {
    batch.set(userRef, { stats: statsDelta }, { merge: true });
  }

  const missingMetricsIssue = afterState
    ? await buildMissingWatchMetricsIssue({ db, uid, titleId, afterState, title })
    : null;
  if (missingMetricsIssue) {
    batch.set(metadataIssueRef, {
      ...missingMetricsIssue,
      createdAt: afterState.createdAt || serverTimestampField,
    }, { merge: true });
  } else {
    batch.delete(metadataIssueRef);
  }

  await batch.commit();
}

exports.applyTitleStateAction = functions
  .region("europe-west1")
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid || null;
    if (!uid) {
      throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
    }

    const db = admin.firestore();
    await enforceCallableRateLimit(db, uid, "applyTitleStateAction", {
      windowSeconds: 10,
      maxInWindow: 20,
      dailyMax: 1200,
    });

    const titleId = toId(data?.titleId);
    if (!titleId) {
      throw new functions.https.HttpsError("invalid-argument", "titleId mancante.");
    }

    const action = sanitizeTitleStateActionPayload(data);
    const metricsPreflight = await refreshTitleWatchMetricsIfNeeded({
      db,
      titleId,
      action,
      requestedBy: uid,
    }).catch((err) => {
      logger.warn("[title-state] metrics preflight failed", {
        uid,
        titleId,
        action: action.type,
        message: safeString(err?.message || String(err), 180),
      });
      return { attempted: true, refreshed: false, reason: "preflight_error" };
    });
    const userRef = db.collection("users").doc(uid);
    const stateRef = userRef.collection("titleStates").doc(titleId);
    const libraryRef = userRef.collection("library").doc(titleId);
    const watchlistRef = userRef.collection("watchlist").doc(titleId);
    const trackingRef = userRef.collection("_system").doc("productTracking");
    const titleRef = db.collection("titles").doc(titleId);

    const result = await db.runTransaction(async (tx) => {
      const [titleSnap, stateSnap, userSnap, trackingSnap] = await Promise.all([
        tx.get(titleRef),
        tx.get(stateRef),
        tx.get(userRef),
        tx.get(trackingRef),
      ]);

      if (!titleSnap.exists) {
        throw new functions.https.HttpsError("not-found", "Titolo non trovato.");
      }

      const titleData = { id: titleId, ...(titleSnap.data() || {}) };
      const now = admin.firestore.Timestamp.now();
      const beforeState = stateSnap.exists ? (stateSnap.data() || {}) : null;
      const nextState = buildNextTitleState(beforeState, action, titleData, { now });

      if (isMeaningfulTitleState(nextState)) {
        tx.set(stateRef, nextState, { merge: true });
      } else {
        tx.delete(stateRef);
      }

      const libraryPayload = buildFirestoreProjectionPayload(
        buildLegacyLibraryProjection(nextState),
        admin.firestore.FieldValue.serverTimestamp(),
        "createdAt"
      );
      const watchlistPayload = buildFirestoreProjectionPayload(
        buildLegacyWatchlistProjection(nextState),
        admin.firestore.FieldValue.serverTimestamp(),
        "addedAt"
      );

      if (libraryPayload && isMeaningfulTitleState(nextState)) {
        tx.set(libraryRef, libraryPayload, { merge: true });
      } else {
        tx.delete(libraryRef);
      }

      if (watchlistPayload && isMeaningfulTitleState(nextState)) {
        tx.set(watchlistRef, watchlistPayload, { merge: true });
      } else {
        tx.delete(watchlistRef);
      }

      const userData = userSnap.exists ? (userSnap.data() || {}) : {};
      if (
        !isExcludedFromProductAnalytics(uid, userData)
        && isManualProgressTransition(beforeState, nextState, action.type)
      ) {
        const nextTracking = buildManualProgressTrackingState(
          trackingSnap.exists ? (trackingSnap.data() || {}) : {},
          { occurredAtMs: now.toMillis() }
        );
        tx.set(trackingRef, productTrackingFirestorePayload(nextTracking), { merge: true });
      }

      return nextState;
    });

    return {
      ok: true,
      state: result,
      metricsPreflight,
    };
  });

// ---------------------------------------------------------------------------
// Titles import (Netflix CSV viewing-history) — see
// functions/lib/importAdapters/{netflixCsv,matching,writeTitleStates}.js for
// the pure parser/matcher/writer logic. This section only wires them into a
// callable, owns the Firestore import-job doc, and enforces the security
// invariants (own-account only, row cap, rate limits).
// ---------------------------------------------------------------------------

// Abuse ceiling only — the resumable tick worker (runImportMatchTick) chunks
// matching across many 540s invocations, so large libraries (a real 7128-row
// TV Time export) are no longer a hard wall. This cap just bounds a
// pathological/malicious upload; a genuine personal viewing history is well
// under it. The Storage-upload transport is ALSO byte-bounded (storage.rules
// caps a file at 50MB ≈ ~200k CSV rows), so this row cap is a secondary guard.
// Raised 5000 → 25000 → 100000: a real TV-Time power user (15+ yrs, 26025
// episode rows) hit 27544 and got silently stuck at "uploading" because the cap
// lives in the callables, not the resumable worker (which handles any size).
const TITLES_IMPORT_MAX_ROWS = 100000;
// startTitlesImport (callable request body) supports these two; tvtime_refract
// only ever arrives via the Storage-upload transport. All three ALSO accept
// the Storage-upload transport for large payloads — see MANUAL_IMPORT_SOURCES.
const TITLES_IMPORT_SOURCES = new Set(["netflix_csv", "tvtime_gdpr", "trakt"]);
// Sources allowed through the direct-to-Storage upload pair
// (createTitlesImportUploadSession + finalizeTitlesImportUpload). Used both by
// tvtime_refract (always, its payload can exceed Firestore's 1MB doc-field
// limit) and by netflix_csv/tvtime_gdpr when the client detects a large
// payload and routes around startTitlesImport's request body.
const MANUAL_IMPORT_SOURCES = new Set(["tvtime_refract", "tvtime_gdpr", "netflix_csv", "trakt"]);
// Best-effort client hint for which app started the import (web vs iOS).
// Purely informational (support/triage), never trusted for security or
// gating — an old client that omits it just gets "unknown".
const IMPORT_PLATFORMS = new Set(["web", "ios"]);
function normalizeImportPlatform(raw) {
  const p = safeString(raw || "", 20).trim().toLowerCase();
  return IMPORT_PLATFORMS.has(p) ? p : "unknown";
}
const FIRESTORE_BATCH_CHUNK = 400; // margin under Firestore's 500-op batch cap

// Resumable matching (runImportMatchTick) tuning. Each tick processes at most
// IMPORT_MATCH_WINDOW_MAX rows OR until IMPORT_MATCH_TIME_BUDGET_MS of the 540s
// invocation is spent (whichever comes first), persists that window's items,
// advances a cursor, and chains a successor tick until the whole file is
// matched. IMPORT_MAX_TICKS is a runaway backstop.
const IMPORT_MATCH_WINDOW_MAX = 400;
const IMPORT_MATCH_TIME_BUDGET_MS = 450 * 1000; // stop well before the 540s hard kill
const IMPORT_MAX_TICKS = 400;
// A tick that claimed an import but never advanced it (crash/OOM) leaves the
// doc in "matching" with a stale updatedAt. reviveStalledTitlesImports
// re-arms it after this long.
const IMPORT_STALL_REVIVE_MS = 12 * 60 * 1000;
// "uploading" imports with core files on Storage reuse this same window
// (see reviveStalledTitlesImports). If NOTHING usable ever landed, only give
// up and mark "failed" after this much longer window — slow/flaky uploads on
// a big library can legitimately take a while.
const IMPORT_UPLOAD_ABANDON_MS = 6 * 60 * 60 * 1000;

// Metadata enrichment phase (runs AFTER matching, BEFORE finalize — see
// processImportMatchTick). Imported titles are often un-enriched catalog stubs
// missing the duration + episode-count meta the stats math needs
// (estimateTitleTotals in functions/lib/titleStates.js): movies with no
// durationMovie count 0 minutes; series with no seasons/durationEpisode can
// never be marked completed. Each enrichment tick fetches TMDB details for a
// bounded slice of the DISTINCT resolved titles that need it, patching the
// title doc's meta, then advances an `enrichCursor` and chains a successor —
// exactly the resumable pattern the matcher uses, so hundreds of ~150ms TMDB
// calls spread across invocations instead of blowing the 540s budget in one.
// A time budget caps a single tick; the window max caps the per-tick title
// count. Missing enrichment degrades gracefully (title stays 0-min, same as
// before this phase existed) — never fails the import.
const IMPORT_ENRICH_WINDOW_MAX = 120;
const IMPORT_ENRICH_TIME_BUDGET_MS = 450 * 1000;

function normalizeTitlesImportOptions(rawOptions = {}) {
  return {
    countDuplicateRewatches: rawOptions?.countDuplicateRewatches !== false,
    countExistingAsRewatch: Boolean(rawOptions?.countExistingAsRewatch),
    // TV Time episode comments: importing them is now part of the normal import
    // (no more consent toggle on the client → less friction). Default ON;
    // respected only if a client explicitly opts out (importComments === false).
    // This just builds resolved CANDIDATES in the review queue
    // (importCommentReview) — comments are STILL never auto-published;
    // publishImportComments (admin) does the public write after a human review.
    importComments: rawOptions?.importComments !== false,
  };
}

function sha256Hex(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

// Deterministic per-row id: same (source, normalized title, watched date,
// season/episode) -> same itemId, so re-running an import on the same file
// is idempotent at the Firestore-doc level (upsert, not append). Season/
// episode are included because TV Time's `rawTitle` is just the bare series
// name (unlike Netflix's "Series: Stagione N: Episodio M", which already
// disambiguates same-day episodes via rawTitle alone) — without them, 2
// different episodes of the same series watched on the same calendar day
// would collide onto the same itemId and silently overwrite each other.
function buildImportItemId(source, row) {
  const nameKey = String(row.seriesNameGuess || row.movieNameGuess || row.rawTitle || "").trim().toLowerCase();
  const dateKey = row.watchedDate instanceof Date ? row.watchedDate.toISOString().slice(0, 10) : String(row.rawDate || "");
  const episodeKey = row.seasonNumber != null && row.episodeNumber != null
    ? `${row.seasonNumber}x${row.episodeNumber}`
    : "";
  // Anthology-split rows (anthologySplit.js) remap every installment onto the
  // SAME season number (1), so without the forced titleId two installments'
  // episode N watched on the same day would collide onto one itemId. Empty for
  // all normal rows -> existing itemIds unchanged (backward compatible).
  const forcedKey = row.forcedTitleId ? `|ft:${row.forcedTitleId}` : "";
  return sha256Hex(`${source}|${nameKey}|${dateKey}|${row.rawTitle}|${episodeKey}${forcedKey}`).slice(0, 32);
}

async function commitInChunks(db, writeFns) {
  for (let i = 0; i < writeFns.length; i += FIRESTORE_BATCH_CHUNK) {
    const chunk = writeFns.slice(i, i + FIRESTORE_BATCH_CHUNK);
    const batch = db.batch();
    chunk.forEach((fn) => fn(batch));
    await batch.commit();
  }
}

function importRowRefKind(row) {
  if (row.kind === "movie") return "movie";
  if (row.kind === "tv_episode") return "tv";
  return "ambiguous";
}

// Parses the raw payload for an automated source into NormalizedRow[]. Pure
// parsing only — no matching, no Firestore. `rawPayload` shape depends on
// `source`: netflix_csv -> string (the CSV text); tvtime_gdpr -> { rawCsvV1,
// rawCsvV2 } (the 2 relevant CSVs out of the ~20 in the GDPR export ZIP).
// tvtime_refract is NOT a valid source here — it has its own manual-standby
// path (createTitlesImportUploadSession + finalizeTitlesImportUpload) that
// never calls this function; see TITLES_IMPORT_SOURCES.
function parseTitlesImportPayload(source, rawPayload) {
  let parsed;
  if (source === "netflix_csv") {
    parsed = parseNetflixCsv(typeof rawPayload === "string" ? rawPayload : "");
  } else if (source === "tvtime_gdpr") {
    const moviesCsv = typeof rawPayload?.rawCsvV1 === "string" ? rawPayload.rawCsvV1 : "";
    const seriesCsv = typeof rawPayload?.rawCsvV2 === "string" ? rawPayload.rawCsvV2 : "";
    parsed = parseTvTimeGdprCsvs({ moviesCsv, seriesCsv });
  } else {
    throw new functions.https.HttpsError("invalid-argument", `Sorgente import non supportata: ${source}`);
  }
  // Split Netflix-style anthologies (e.g. TV Time "Monster (2022)") into their
  // per-installment Somto titles in place — see anthologySplit.js. Runs in the
  // parser so every re-parse across resumable ticks stays consistent (the
  // matcher honors the forcedTitleId this sets).
  applyAnthologySplitsToRows(parsed.rows);
  return parsed;
}

async function downloadStorageText(bucket, path, { maxBytes = 50 * 1024 * 1024 } = {}) {
  const cleanPath = safeString(path, 500).trim();
  if (!cleanPath) return "";
  const file = bucket.file(cleanPath);
  const [exists] = await file.exists();
  if (!exists) return "";
  const [metadata] = await file.getMetadata();
  const size = Number(metadata?.size || 0);
  if (!Number.isFinite(size) || size <= 0) return "";
  if (size > maxBytes) {
    throw new functions.https.HttpsError("invalid-argument", "File troppo grande.");
  }
  const [buf] = await file.download();
  return buf.toString("utf8");
}

// Loads the raw import payload for an import job, normalizing BOTH transports
// into one shape: Storage-upload (payload doc holds `storagePaths` → download
// each file) and callable-body (payload doc holds the raw text inline as
// `rawCsv`/`rawCsvV1`/`rawCsvV2`/`rawCsv*`). Returns null if the payload doc
// is gone (already finalized/expired). The optional vote/comment CSVs (TV Time
// GDPR ratings) come back in `.ratings`. Downloading is idempotent and cheap
// relative to the per-row matching, so this is safely re-called every tick.
async function loadImportRawPayload(bucket, importRef) {
  const payloadSnap = await importRef.collection("payload").doc("raw").get();
  if (!payloadSnap.exists) return null;
  const payload = payloadSnap.data() || {};
  const source = safeString(payload.source || "", 40).trim().toLowerCase();
  const storagePaths = (payload.storagePaths && typeof payload.storagePaths === "object")
    ? payload.storagePaths
    : null;

  if (storagePaths) {
    const [moviesText, seriesText, netflixText, traktJson, episodeVotes, movieRatings, movieVotes, movieComments, episodeComments, listsText, showRatings] =
      await Promise.all([
        storagePaths.movies ? downloadStorageText(bucket, storagePaths.movies) : "",
        storagePaths.series ? downloadStorageText(bucket, storagePaths.series) : "",
        storagePaths.netflix ? downloadStorageText(bucket, storagePaths.netflix) : "",
        storagePaths.trakt ? downloadStorageText(bucket, storagePaths.trakt) : "",
        storagePaths.episodeVotes ? downloadStorageText(bucket, storagePaths.episodeVotes) : "",
        storagePaths.movieRatings ? downloadStorageText(bucket, storagePaths.movieRatings) : "",
        storagePaths.movieVotes ? downloadStorageText(bucket, storagePaths.movieVotes) : "",
        storagePaths.movieComments ? downloadStorageText(bucket, storagePaths.movieComments) : "",
        storagePaths.episodeComments ? downloadStorageText(bucket, storagePaths.episodeComments) : "",
        storagePaths.lists ? downloadStorageText(bucket, storagePaths.lists) : "",
        storagePaths.showRatings ? downloadStorageText(bucket, storagePaths.showRatings) : "",
      ]);
    return {
      source,
      transport: "storage",
      storagePaths,
      moviesText,
      seriesText,
      netflixText,
      // Trakt library JSON (compact blob written by startTraktImport) — a
      // single JSON file, not a set of CSVs like the other sources.
      traktJson,
      listsText,
      // episodeVotes = episode RATINGS (ratings-3), movieRatings = movie RATINGS
      // (ratings-live), movieVotes = movie EMOTIONS (emotions-live, stashed).
      // showRatings = voti per SERIE (tv_show_rate.csv): l'unico voto che
      // esiste sugli account vecchi, dove i voti per episodio non c'erano.
      ratings: { episodeVotes, movieRatings, movieVotes, movieComments, episodeComments, showRatings },
    };
  }

  return {
    source,
    transport: "inline",
    storagePaths: null,
    moviesText: typeof payload.rawCsvV1 === "string" ? payload.rawCsvV1 : "",
    seriesText: typeof payload.rawCsvV2 === "string" ? payload.rawCsvV2 : "",
    netflixText: typeof payload.rawCsv === "string" ? payload.rawCsv : "",
    traktJson: typeof payload.rawTraktJson === "string" ? payload.rawTraktJson : "",
    listsText: typeof payload.rawCsvLists === "string" ? payload.rawCsvLists : "",
    ratings: {
      episodeVotes: typeof payload.rawCsvEpisodeVotes === "string" ? payload.rawCsvEpisodeVotes : "",
      movieRatings: typeof payload.rawCsvMovieRatings === "string" ? payload.rawCsvMovieRatings : "",
      movieVotes: typeof payload.rawCsvMovieVotes === "string" ? payload.rawCsvMovieVotes : "",
      movieComments: typeof payload.rawCsvMovieComments === "string" ? payload.rawCsvMovieComments : "",
      episodeComments: typeof payload.rawCsvEpisodeComments === "string" ? payload.rawCsvEpisodeComments : "",
      showRatings: typeof payload.rawCsvShowRatings === "string" ? payload.rawCsvShowRatings : "",
    },
  };
}

// Parses a loaded payload (loadImportRawPayload output) into NormalizedRow[].
// Deterministic order (CSV/JSON order) — essential: the resumable matcher uses
// a numeric row cursor, so every re-parse across ticks MUST yield the same
// rows in the same order for the cursor to point at the same work.
function parseImportRows(source, loaded) {
  if (source === "tvtime_refract") {
    const parsed = parseTvTimeRefractJson({ moviesJson: loaded.moviesText || "", seriesJson: loaded.seriesText || "" });
    applyAnthologySplitsToRows(parsed.rows); // see anthologySplit.js (gdpr/netflix already split in parseTitlesImportPayload)
    return parsed;
  }
  if (source === "netflix_csv") {
    return parseTitlesImportPayload("netflix_csv", loaded.netflixText || "");
  }
  if (source === "tvtime_gdpr") {
    return parseTitlesImportPayload("tvtime_gdpr", { rawCsvV1: loaded.moviesText || "", rawCsvV2: loaded.seriesText || "" });
  }
  if (source === "trakt") {
    // Trakt payload is a single JSON blob (buildTraktImportBlob output).
    // parseTraktBlob is defensive (skip+count, never throws) and produces a
    // deterministically-sorted NormalizedRow[] — required for the resumable
    // matcher's cursor. No anthology split needed (Trakt matches by tmdb id).
    let blob = {};
    try {
      blob = JSON.parse(loaded.traktJson || "{}");
    } catch (err) {
      return { rows: [], errors: [{ line: 0, rawTitle: "", reason: "Payload Trakt JSON non valido." }] };
    }
    return parseTraktBlob(blob);
  }
  throw new functions.https.HttpsError("invalid-argument", `Sorgente import non supportata: ${source}`);
}

async function resolveAndPersistImportPayloadSource(importRef, requestedSource, loaded, currentData = {}) {
  const audited = auditedTvTimePayloadSource(currentData);
  if (audited) return audited;
  const detection = detectTvTimePayloadSource(requestedSource, loaded);
  if (!detection.valid) return detection;
  if (!["tvtime_gdpr", "tvtime_refract"].includes(detection.requestedSource)) return detection;

  const alreadyPersisted =
    currentData.source === detection.effectiveSource
    && currentData.requestedSource === detection.requestedSource
    && currentData.detectedSource === detection.detectedFormat
    && currentData.sourceAutoDetected === detection.autoDetected;
  if (!alreadyPersisted) {
    const audit = {
      source: detection.effectiveSource,
      requestedSource: detection.requestedSource,
      detectedSource: detection.detectedFormat,
      sourceAutoDetected: detection.autoDetected,
      sourceDetectedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await Promise.all([
      importRef.set(audit, { merge: true }),
      importRef.collection("payload").doc("raw").set(audit, { merge: true }),
    ]);
    if (detection.autoDetected) {
      logger.info("[titlesImport] corrected uploaded TV Time format", {
        importId: importRef.id,
        requestedSource: detection.requestedSource,
        effectiveSource: detection.effectiveSource,
      });
    }
  }
  return detection;
}

// Creates a matching-tick continuation doc. onCreate of `importMatchTicks/{id}`
// fires runImportMatchTick. The doc id is deterministic per cursor position
// (`${importId}_${cursor}`) so a duplicate enqueue at the same position is an
// idempotent overwrite (which does NOT re-fire onCreate) rather than a second
// concurrent worker. Successor ticks advance the cursor → fresh id → fresh
// onCreate. Deny-all to clients (firestore.rules); server admin SDK only.
async function createImportMatchTick(db, uid, importId, cursor) {
  const tickId = `${importId}_${cursor}`;
  await db.collection("importMatchTicks").doc(tickId).set({
    uid,
    importId,
    cursor,
    phase: "match",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return tickId;
}

// Creates an ENRICHMENT-phase continuation tick. Same deterministic-id +
// onCreate mechanism as createImportMatchTick, but the id is namespaced with an
// `enrich_` prefix (its cursor indexes the distinct-titleId list, a different
// space from the match cursor that indexes rows) so a match tick and an enrich
// tick at the same numeric cursor never collide. The tick carries phase:"enrich"
// so runImportMatchTick claims it against `enrichCursor` and dispatches to the
// enrichment worker instead of the matcher.
async function createImportEnrichTick(db, uid, importId, cursor) {
  const tickId = `${importId}_enrich_${cursor}`;
  await db.collection("importMatchTicks").doc(tickId).set({
    uid,
    importId,
    cursor,
    phase: "enrich",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return tickId;
}

// Deletes the uploaded Storage objects for a manual-import session once the
// import has been fully processed (or failed terminally). Best-effort: a
// leftover object is only wasted bytes, never a correctness problem, and a
// storage lifecycle rule on `manualImports/` is the backstop.
async function cleanupImportStorage(bucket, storagePaths) {
  if (!storagePaths || typeof storagePaths !== "object") return;
  await Promise.all(Object.values(storagePaths).map((path) => {
    const clean = safeString(path, 500).trim();
    if (!clean) return Promise.resolve();
    return bucket.file(clean).delete().catch(() => {});
  }));
}

exports.createTitlesImportUploadSession = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 60, memory: "256MB" })
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid || null;
    if (!uid) {
      throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
    }

    const db = admin.firestore();
    await enforceCallableRateLimit(db, uid, "createTitlesImportUploadSession", {
      windowSeconds: 60,
      maxInWindow: 2,
      dailyMax: 5,
    });

    const source = safeString(data?.source || "", 40).trim().toLowerCase();
    if (!MANUAL_IMPORT_SOURCES.has(source)) {
      throw new functions.https.HttpsError("invalid-argument", "Upload diretto non supportato per questa sorgente.");
    }
    await assertNoConflictingImport(db, uid, source);
    const fileKinds = normalizeManualImportFileKinds(data, source);
    if (fileKinds.length === 0) {
      throw new functions.https.HttpsError("invalid-argument", "Nessun file da caricare.");
    }
    const importOptions = normalizeTitlesImportOptions(data?.options || data?.importOptions || {});
    const platform = normalizeImportPlatform(data?.platform);

    const importRef = db.collection("users").doc(uid).collection("imports").doc();
    const importId = importRef.id;
    const storagePaths = manualImportStoragePaths(uid, importId, fileKinds, source);
    const now = admin.firestore.FieldValue.serverTimestamp();
    const expiresAt = admin.firestore.Timestamp.fromDate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

    await importRef.set({
      source,
      platform,
      dryRun: false,
      importOptions,
      status: "uploading",
      totalRows: 0,
      processedCount: 0,
      matchCursor: 0,
      tickCount: 0,
      matchedCount: 0,
      unresolvedCount: 0,
      errorCount: 0,
      titleStateIdsWritten: [],
      storagePaths,
      createdAt: now,
      updatedAt: now,
      expiresAt,
      startedBy: uid,
    });

    await importRef.collection("payload").doc("raw").set({
      source,
      storageBucket: admin.storage().bucket().name,
      storagePaths,
      createdAt: now,
      expiresAt,
    });

    // Best-effort admin heads-up (see the same call in startTitlesImport).
    // tvtime_refract is never a dryRun (see the field above), and totalRows
    // isn't known yet at this point — the file hasn't been parsed until
    // finalizeTitlesImportUpload runs — so it's reported as null/unknown.
    notifyAdminsImportStarted({
      fromUid: uid,
      fromName: await getDisplayNameForNotify(db, uid),
      source,
      totalRows: null,
      importUid: uid,
      importId,
    }).catch((err) => {
      logger.warn("[titlesImport] notifyAdminsImportStarted (createTitlesImportUploadSession) failed", {
        uid,
        importId,
        message: safeString(err?.message || String(err), 200),
      });
    });

    return {
      ok: true,
      importId,
      source,
      status: "uploading",
      storageBucket: admin.storage().bucket().name,
      storagePaths,
      maxBytesPerFile: 50 * 1024 * 1024,
    };
  });

exports.finalizeTitlesImportUpload = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 540, memory: "1GB" })
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid || null;
    if (!uid) {
      throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
    }

    const db = admin.firestore();
    await enforceCallableRateLimit(db, uid, "finalizeTitlesImportUpload", {
      windowSeconds: 60,
      maxInWindow: 5,
      dailyMax: 20,
    });

    const importId = toId(data?.importId);
    if (!importId) {
      throw new functions.https.HttpsError("invalid-argument", "importId mancante.");
    }

    const importRef = db.collection("users").doc(uid).collection("imports").doc(importId);
    const payloadRef = importRef.collection("payload").doc("raw");
    const [importSnap, payloadSnap] = await Promise.all([importRef.get(), payloadRef.get()]);
    if (!importSnap.exists || !payloadSnap.exists) {
      throw new functions.https.HttpsError("not-found", "Sessione upload non trovata.");
    }
    const importData = importSnap.data() || {};
    const payload = payloadSnap.data() || {};
    if (importData.startedBy !== uid || importData.status !== "uploading") {
      throw new functions.https.HttpsError("failed-precondition", "Sessione upload non valida.");
    }
    const requestedSource = safeString(importData.requestedSource || importData.source || payload.source || "", 40).trim().toLowerCase();
    if (!MANUAL_IMPORT_SOURCES.has(requestedSource)) {
      throw new functions.https.HttpsError("invalid-argument", "Finalizzazione non supportata per questa sorgente.");
    }

    // Download the uploaded files from Storage and parse them (cheap — no TMDB
    // calls yet), applying the same zero-rows / row-cap checks every other
    // source gets. A parse failure or zero usable rows fails the callable
    // BEFORE we transition off "uploading", so the upload session itself is
    // still cleanly re-triable (no half-started job doc to clean up).
    const bucket = admin.storage().bucket();
    const loaded = await loadImportRawPayload(bucket, importRef);
    if (!loaded) {
      throw new functions.https.HttpsError("not-found", "Payload upload non trovato.");
    }
    const hasAnyCore = (loaded.moviesText && loaded.moviesText.trim())
      || (loaded.seriesText && loaded.seriesText.trim())
      || (loaded.netflixText && loaded.netflixText.trim());
    if (!hasAnyCore) {
      throw new functions.https.HttpsError("failed-precondition", "File upload mancanti.");
    }

    // A parse that yields nothing usable is a DEAD END, not a stalled upload:
    // the files are on Storage and readable, they just aren't what we can
    // read (observed live: the Refract JSON export picked into the GDPR CSV
    // slots — "Header CSV film/serie inatteso"). Leaving the doc on
    // "uploading" made reviveStalledTitlesImports adopt it 12 minutes later,
    // re-queue it, and land it on `completed` with 0 rows — the user is told
    // the import succeeded while nothing was imported. Mark it failed with a
    // readable reason so the watchdog skips it and the client can say why.
    const failImport = async (reason, parseErrors = []) => {
      await importRef.set({
        status: "failed",
        failureReason: safeString(reason, 300),
        // Stesso testo anche su `error`: e' il campo che i client leggono.
        error: safeString(reason, 300),
        errorCount: importFailureErrorCount(parseErrors, importData.errorCount),
        parseErrors: parseErrors.slice(0, 20),
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      // Deliberately NOT cleaning up Storage here: the uploaded files are the
      // only evidence of what went wrong, and support can re-run a failed
      // import against them (that is exactly how the Refract-in-GDPR-slots
      // cases were recovered without asking the user to upload again).
    };

    const detection = await resolveAndPersistImportPayloadSource(importRef, requestedSource, loaded, importData);
    if (!detection.valid) {
      await failImport(detection.reason);
      throw new functions.https.HttpsError("invalid-argument", detection.reason);
    }
    const source = detection.effectiveSource;
    const { rows, errors } = parseImportRows(source, loaded);
    if (rows.length === 0) {
      const reason = "Non riesco a leggere voci utili nei file caricati.";
      await failImport(reason, errors);
      throw new functions.https.HttpsError("invalid-argument", reason);
    }
    if (rows.length > TITLES_IMPORT_MAX_ROWS) {
      const reason = `Il file ha ${rows.length} righe, oltre il limite di ${TITLES_IMPORT_MAX_ROWS}.`;
      await failImport(reason, errors);
      throw new functions.https.HttpsError("invalid-argument", reason);
    }

    const sourceDigest = sha256Hex(JSON.stringify({
      source,
      storagePaths: payload.storagePaths || {},
      totalRows: rows.length,
    }));
    await payloadRef.set({
      source,
      sourceDigest,
      finalizedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    // Hand off to the resumable tick worker instead of matching inline: a
    // large library can take far longer than a single 540s invocation to
    // match (sequential per-row TMDB lookups throttled to 130ms each), so
    // matching is chunked across many self-chaining ticks. The client already
    // drives its terminal state off the Firestore listener on this import doc
    // (see import.page.js / TitlesImportView), so returning "queued" here and
    // letting the ticks land the final status is transparent to the user.
    await importRef.set({
      source,
      requestedSource,
      detectedSource: detection.detectedFormat,
      sourceAutoDetected: detection.autoDetected,
      sourceDigest,
      status: "queued",
      matchCursor: 0,
      tickCount: 0,
      totalRows: rows.length,
      errorCount: errors.length,
      startedProcessingAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    await createImportMatchTick(db, uid, importId, 0).catch(async (err) => {
      logger.error("[titlesImport] failed to enqueue first tick (upload)", {
        uid, importId, message: safeString(err?.message || String(err), 200),
      });
      // Leave status "queued" — reviveStalledTitlesImports will re-arm it.
    });

    return {
      ok: true,
      importId,
      status: "queued",
      totalRows: rows.length,
    };
  });

async function createTitlesImportNotification(db, uid, importId, status, counts = {}, source = "") {
  if (!uid || !importId) return;

  const type =
    status === "completed" ? "titles_import_completed" :
    status === "awaiting_confirmation" ? "titles_import_needs_review" :
    status === "failed" ? "titles_import_failed" :
    null;
  if (!type) return;

  // Metrica funnel import (aggregata, anonima): choke point unico completa/fallita.
  if (status === "completed") await bumpDailyMetric("imports_completed");
  else if (status === "failed") await bumpDailyMetric("imports_failed");

  // Source-agnostic copy: this fires for netflix_csv, tvtime_gdpr AND
  // tvtime_refract now (the resumable worker is shared) — "Import Netflix"
  // would be wrong for the TV Time flows.
  const label = source === "netflix_csv" ? "Import Netflix"
    : (source === "tvtime_gdpr" || source === "tvtime_refract") ? "Import TV Time"
    : source === "trakt" ? "Import Trakt"
    : "Import";
  const matchedCount = Number(counts.matchedCount || 0);
  const unresolvedCount = Number(counts.unresolvedCount || 0);
  // Il primo warning (se c'e') viaggia nella notifica: e' l'unico punto che
  // l'utente legge davvero a fine import, e senza di esso "completato" nasconde
  // il fatto che, per dire, i film non sono arrivati.
  const warnings = Array.isArray(counts.warnings) ? counts.warnings : [];
  const firstWarning = warnings[0]?.message ? ` ${warnings[0].message}` : "";
  const message =
    type === "titles_import_completed"
      ? `${label} completato: ${matchedCount} titoli aggiornati nella tua libreria.${firstWarning}`
      : type === "titles_import_needs_review"
        ? `${label} quasi pronto: ${matchedCount} titoli aggiornati, ${unresolvedCount} da controllare.`
        : counts.failureReason
          // Un "non riuscito, riprova" su file sbagliati manda l'utente a
          // ripetere lo stesso caricamento all'infinito: il motivo serve.
          ? `${label} non riuscito: ${safeString(counts.failureReason, 160)} Controlla di aver scelto i file giusti dell'export.`
          : `${label} non riuscito. Puoi riprovare quando vuoi.`;

  await db.collection("users").doc(uid).collection("notifications").add({
    type,
    fromUid: null,
    toUid: uid,
    read: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    data: {
      importId,
      source: source || "netflix_csv",
      matchedCount,
      unresolvedCount,
      message,
      ctaUrl: type === "titles_import_completed"
        ? "/account.html?tab=watched"
        : `/import.html?id=${encodeURIComponent(importId)}`,
    },
  }).catch((err) => {
    logger.warn("[titlesImport] failed to create notification", {
      uid,
      importId,
      message: safeString(err?.message || String(err), 200),
    });
  });
}

// Some import sources (TV Time GDPR: `runtimeMinutes`, from the CSV's
// `runtime` column in seconds) supply a reliable per-title runtime that a
// freshly stub-created `titles` doc may be missing (TMDB search results
// don't include `runtime`; only `/details` does, which the import's TMDB
// search step never calls). This is a GAP-FILL ONLY: it never overwrites an
// existing meta.durationMovie/durationEpisode (TMDB is generally the more
// reliable source when present) — it only helps a brand-new stub title have
// a working watch-minutes estimate from the very first import that touches
// it, instead of silently reading as 0 minutes forever.
async function backfillTitleDurationsFromImport(db, watchedRows) {
  const runtimeMinutesByTitleId = new Map();
  for (const { titleId, row } of watchedRows) {
    const minutes = Number(row?.runtimeMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) continue;
    if (!runtimeMinutesByTitleId.has(titleId)) runtimeMinutesByTitleId.set(titleId, []);
    runtimeMinutesByTitleId.get(titleId).push(Math.round(minutes));
  }
  if (runtimeMinutesByTitleId.size === 0) return;

  for (const [titleId, samples] of runtimeMinutesByTitleId.entries()) {
    // eslint-disable-next-line no-await-in-loop
    const snap = await db.collection("titles").doc(titleId).get();
    if (!snap.exists) continue;
    const data = snap.data() || {};
    const mediaType = titleDocMediaType(data);
    const meta = (data.meta && typeof data.meta === "object") ? data.meta : {};
    // Median of the samples: robust against a single mis-tagged episode
    // runtime (e.g. a double-length finale) skewing the estimate.
    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    const field = mediaType === "tv" ? "durationEpisode" : "durationMovie";
    if (toPositiveInt(meta[field]) > 0) continue; // never overwrite an existing value

    // eslint-disable-next-line no-await-in-loop
    await db.collection("titles").doc(titleId).set({
      meta: { ...meta, [field]: median },
    }, { merge: true }).catch((err) => {
      logger.warn("[titlesImport] duration backfill write failed", { titleId, message: safeString(err?.message || String(err), 200) });
    });
  }
}

// TV Time GDPR import ONLY: imports the user's 5-star votes (converted to
// Somto's 1-10 scale, see tvTimeRatings.js's calibrated
// TVTIME_VOTE_ID_TO_DECIMAL) and comments (merged into reviewText on the
// same rating — Somto's schema has no review-without-a-numeric-rating
// shape, see firestore.rules `rating is number` on ratings/{ratingId}
// create). All 4 source CSVs are OPTIONAL: their absence never fails or
// blocks the main import (the core viewing-history import already
// succeeded by the time this runs).
//
// IMPORTANT — SOCIAL FAN-OUT SUPPRESSED FOR IMPORTED RATINGS: writing to
// `ratings/{id}` normally triggers `notifyFriendsOnRating` (push
// notification to friends), `syncRatingFeedThreadDoc` (creates a public
// discussion thread) and `onRatingCreatedFeedEvent`/`onRatingUpdatedFeedEvent`
// (friend/follower feed events). A bulk historical import can carry
// hundreds of ratings in one go — letting those fire normally would spam
// the user's friends with a wall of "ha valutato X" notifications/feed
// events for years-old viewing history, and litter profiles with thread
// docs for every imported title. Every rating written here therefore
// carries `source: "import_tvtime_gdpr"` (see tvTimeRatingsWriter.js), and
// the 3 fan-out triggers early-return when they see that marker (grep
// `import_tvtime_gdpr` in this file for the guard in each). This does NOT
// affect `recomputeTitleRatingAggregate` (the public community rating DOES
// include these — they're real ratings, not synthetic) nor
// `syncTitleStateFromTitleRating` (level=title only; harmless here since
// this import already wrote the matching titleState via the main pipeline).
async function processTvTimeRatingsAndComments({ db, uid, userRef, payload, matchResults }) {
  const rawCsvEpisodeVotes = typeof payload?.rawCsvEpisodeVotes === "string" ? payload.rawCsvEpisodeVotes : "";
  const rawCsvMovieRatings = typeof payload?.rawCsvMovieRatings === "string" ? payload.rawCsvMovieRatings : "";
  const rawCsvMovieVotes = typeof payload?.rawCsvMovieVotes === "string" ? payload.rawCsvMovieVotes : "";
  const rawCsvMovieComments = typeof payload?.rawCsvMovieComments === "string" ? payload.rawCsvMovieComments : "";
  const rawCsvEpisodeComments = typeof payload?.rawCsvEpisodeComments === "string" ? payload.rawCsvEpisodeComments : "";
  const rawCsvShowRatings = typeof payload?.rawCsvShowRatings === "string" ? payload.rawCsvShowRatings : "";

  const emptySummary = {
    ratingsWritten: 0, unrecognizedVotes: 0, commentsWithoutVote: 0, unresolvedRatings: 0,
    emotionsStashed: 0, emotionsUnresolved: 0, episodeScale: null, movieScale: null,
    dominantIdUnrecognized: false,
  };
  if (!rawCsvEpisodeVotes && !rawCsvMovieRatings && !rawCsvMovieVotes && !rawCsvMovieComments
      && !rawCsvEpisodeComments && !rawCsvShowRatings) {
    return emptySummary;
  }

  // Disambiguation is ALWAYS by SOURCE FILE (ids collide across the rating and
  // emotion namespaces — see tvTimeRatings.js):
  //   episode ratings (ratings-3) + movie ratings (ratings-live) -> ratings
  //   movie emotions (emotions-live) -> titleEmotions stash (NEVER a rating)
  const epRes = parseTvTimeEpisodeVotesCsv(rawCsvEpisodeVotes);
  const mvRes = parseTvTimeMovieRatingsCsv(rawCsvMovieRatings);
  const { comments: movieComments } = parseTvTimeMovieCommentsCsv(rawCsvMovieComments);
  const { comments: episodeComments } = parseTvTimeEpisodeCommentsCsv(rawCsvEpisodeComments);
  const { emotions } = parseTvTimeMovieEmotionsCsv(rawCsvMovieVotes);

  // Reuse the SAME titleId resolutions the main viewing-history import already
  // computed (matchResults) — never re-runs the TMDB matching cascade.
  const titleResolutionMap = buildTitleResolutionMap(matchResults);
  const now = admin.firestore.FieldValue.serverTimestamp();

  // --- ratings (episode + movie) + comments ---
  const { intents, unrecognizedVotes, commentsWithoutVote } = mergeVotesAndComments(
    [...(epRes.votes || []), ...(mvRes.votes || [])],
    [...movieComments, ...episodeComments]
  );
  const { writes, unresolvedCount } = resolveRatingWrites({ uid, intents, titleResolutionMap, now });

  // --- voti per SERIE (tv_show_rate.csv) ---
  // Risolti per NOME SERIE sulla stessa mappa gia' costruita dal match della
  // cronologia: nessuna nuova ricerca TMDB. Scritti a livello `title`, come
  // farebbe l'utente votando la serie dalla scheda.
  //
  // NB: questi voti NON completano la serie. Su TV Time si vota una serie
  // anche a meta', e applyTitleRatingToState riconosce i voti `import_*`
  // proprio per non fabbricare un completamento (e le ore che ne seguirebbero).
  const showRatingsRes = parseTvTimeShowRatingsCsv(rawCsvShowRatings);
  const { bySeriesName: showRatingSeriesMap } = buildTvTimeImportResolutionMaps(matchResults);
  let showRatingsWritten = 0;
  let showRatingsUnresolved = 0;
  for (const r of showRatingsRes.ratings) {
    const titleId = showRatingSeriesMap.get(safeString(r.seriesName, 500).trim().toLowerCase());
    if (!titleId) { showRatingsUnresolved += 1; continue; }
    const ratingId = makeRatingId({ uid, titleId, level: "title", season: null, episode: null });
    writes.push({
      ratingId,
      titleId,
      payload: {
        uid,
        titleId,
        level: "title",
        season: null,
        episode: null,
        rating: r.decimalRating,
        createdAt: r.ratedAt || now,
        updatedAt: now,
        source: "import_tvtime_gdpr",
      },
    });
    showRatingsWritten += 1;
  }

  if (writes.length > 0) {
    const writeFns = writes.map(({ ratingId, payload: ratingPayload }) => (batch) => {
      batch.set(db.collection("ratings").doc(ratingId), ratingPayload, { merge: true });
    });
    await commitInChunks(db, writeFns);
  }

  // --- movie emotions -> titleEmotions stash (feature not user-facing yet;
  //     aggregates rebuilt by scripts/backfill-titleEmotionAggregate.cjs when
  //     the emotions feature ships) ---
  const { stashed: emotionsStashed, unresolved: emotionsUnresolved } =
    await stashTvTimeMovieEmotions({ db, uid, emotions, titleResolutionMap, now });

  return {
    ratingsWritten: writes.length,
    unrecognizedVotes,
    commentsWithoutVote,
    unresolvedRatings: unresolvedCount,
    emotionsStashed,
    emotionsUnresolved,
    episodeScale: epRes.scale || null,
    movieScale: mvRes.scale || null,
    showRatingsWritten,
    showRatingsUnresolved,
    showRatingScale: showRatingsRes.scale || null,
    dominantIdUnrecognized: Boolean(epRes.dominantIdUnrecognized || mvRes.dominantIdUnrecognized),
  };
}

function buildTvTimeImportResolutionMaps(matchResults) {
  const bySeriesName = new Map();
  const byTvdbSeriesId = new Map();
  const byListCandidate = new Map();
  for (const { row, match } of matchResults || []) {
    if (!match?.resolved || !match?.titleId) continue;
    const seriesName = safeString(row?.seriesNameGuess || "", 500).trim().toLowerCase();
    if (seriesName) bySeriesName.set(seriesName, match.titleId);
    if (Number(row?.tvdbSeriesId) > 0) {
      byTvdbSeriesId.set(Number(row.tvdbSeriesId), match.titleId);
      byListCandidate.set(`tv|${Number(row.tvdbSeriesId)}`, match.titleId);
    }
    const tvtimeUuid = safeString(row?.tvtimeUuid || "", 80).trim().toLowerCase();
    if (tvtimeUuid) byListCandidate.set(`movie|${tvtimeUuid}`, match.titleId);
  }
  return { bySeriesName, byTvdbSeriesId, byListCandidate };
}

async function preserveTvTimeExtraEpisodes({ db, uid, importId, extraEpisodes, matchResults, dryRun = false }) {
  const rows = Array.isArray(extraEpisodes) ? extraEpisodes : [];
  const summary = { total: rows.length, written: 0, unresolved: 0, specials: 0, unnumbered: 0 };
  if (!rows.length) return summary;

  const { bySeriesName, byTvdbSeriesId } = buildTvTimeImportResolutionMaps(matchResults);
  const writeFns = [];
  const now = admin.firestore.FieldValue.serverTimestamp();
  for (const row of rows) {
    const titleId = (Number(row?.tvdbSeriesId) > 0 ? byTvdbSeriesId.get(Number(row.tvdbSeriesId)) : null)
      || bySeriesName.get(safeString(row?.seriesNameGuess || "", 500).trim().toLowerCase())
      || null;
    if (!titleId) { summary.unresolved += 1; continue; }
    const classification = row.classification === "special" ? "special" : "unnumbered";
    if (classification === "special") summary.specials += 1;
    else summary.unnumbered += 1;
    const identity = Number(row?.tvdbEpisodeId) > 0
      ? `tvdb:${Number(row.tvdbEpisodeId)}`
      : `${row?.seasonNumber ?? "x"}:${row?.episodeNumber ?? "x"}:${row?.watchedDate instanceof Date ? row.watchedDate.toISOString() : ""}`;
    const docId = createHash("sha256").update(`${uid}|${titleId}|${identity}`).digest("hex").slice(0, 40);
    const payload = {
      uid,
      titleId,
      mediaType: "tv",
      seriesName: safeString(row?.seriesNameGuess || "", 500) || null,
      season: Number.isFinite(Number(row?.seasonNumber)) ? Number(row.seasonNumber) : null,
      episode: Number.isFinite(Number(row?.episodeNumber)) ? Number(row.episodeNumber) : null,
      tvdbSeriesId: Number(row?.tvdbSeriesId) > 0 ? Number(row.tvdbSeriesId) : null,
      tvdbEpisodeId: Number(row?.tvdbEpisodeId) > 0 ? Number(row.tvdbEpisodeId) : null,
      classification,
      countsTowardProgress: false,
      source: "import_tvtime_gdpr",
      sourceImportId: importId,
      watchedAt: row?.watchedDate instanceof Date ? admin.firestore.Timestamp.fromDate(row.watchedDate) : null,
      createdAt: now,
      updatedAt: now,
    };
    writeFns.push((batch) => batch.set(db.collection("users").doc(uid).collection("episodeViews").doc(docId), payload, { merge: true }));
  }
  summary.written = writeFns.length;
  if (!dryRun && writeFns.length) await commitInChunks(db, writeFns);
  return summary;
}

// Best-effort admin heads-up that an import produced episode comments awaiting
// review (mirror of notifyAdminsImportStarted's fire-and-forget style). Never
// throws — a failure here must never break the import.
async function notifyAdminsCommentReviewPending({ db, importUid, importId, eligible, resolved, fromName } = {}) {
  const adminUids = getAdminUids();
  if (!adminUids.length) return;
  const presentation = commentReviewPresentation({ importUid, importId, eligible, resolved, fromName });
  const batch = db.batch();
  for (const adminUid of adminUids) {
    if (adminUid === importUid) continue; // don't ping an admin about their own import
    const ref = db.collection("users").doc(adminUid).collection("notifications").doc();
    batch.set(ref, {
      toUid: adminUid,
      fromUid: importUid || "system",
      type: "comment_review_pending",
      data: {
        fromName: fromName || "Un utente",
        importUid: importUid || null,
        importId: importId || null,
        eligible: presentation.eligible,
        resolved: presentation.resolved,
        message: presentation.title,
        ctaUrl: presentation.url,
      },
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + NOTIFICATION_TTL_MS),
    });
  }
  await batch.commit();
}

// Republish path for TV Time episode comments (see CLAUDE.md "TV Time comment
// republish"). Runs in the tvtime_gdpr finalize tail. TWO responsibilities:
//   LEVEL 1 (always, no consent needed): archive the raw episode_comment.csv to
//     commentArchive/ (a Storage prefix with NO lifecycle TTL) so it survives
//     the 7d purge on manualImports/, and write a review-queue SUMMARY doc so
//     imports carrying comments are visible to an admin. NO public write.
//   LEVEL 2 (only with consent — importOptions.importComments): resolve each
//     publishable comment (standalone/self-thread + quality gate) to a Somto
//     titleId via the series-name map already built from the viewing-history
//     match, and write a per-comment CANDIDATE doc to the review queue. NOTHING
//     is published to a public thread here — publishImportComments (admin) does
//     the public write, and ONLY after a human approves. This keeps public
//     data behind an explicit consent gate AND a human review.
async function processTvTimeEpisodeComments({ db, uid, importId, importRef, bucket, episodeCommentsCsv, matchResults, importOptions, dryRun = false }) {
  const csv = typeof episodeCommentsCsv === "string" ? episodeCommentsCsv : "";
  if (!csv.trim()) return null;

  const consent = Boolean(importOptions?.importComments);
  const { comments } = parseTvTimeEpisodeCommentsCsv(csv);
  const { counts, eligible } = selectPublishableEpisodeComments(comments);

  // Resolve eligible comments to Somto titleIds via the series-name map already
  // computed from the viewing-history match (no new TMDB matching cascade).
  const { bySeriesName } = buildTvTimeImportResolutionMaps(matchResults);
  let resolved = 0;
  const candidates = eligible.map((c) => {
    const titleId = bySeriesName.get(safeString(c.seriesNameGuess || "", 500).trim().toLowerCase()) || null;
    if (titleId) resolved += 1;
    return { comment: c, titleId };
  });

  const summary = {
    total: counts.total,
    standalone: counts.standalone,
    selfThread: counts.selfThread,
    replyOther: counts.replyOther,
    qualityRejected: counts.qualityRejected,
    eligible: counts.eligible,
    resolved,
    unresolved: counts.eligible - resolved,
    consent,
    published: 0,
    status: "pending",
  };

  if (dryRun) return summary;

  const now = admin.firestore.FieldValue.serverTimestamp();

  // LEVEL 1 — archive raw CSV (best-effort; never blocks the import).
  const activeBucket = bucket || admin.storage().bucket();
  await activeBucket.file(`commentArchive/${uid}/${importId}/episode_comments.csv`).save(csv, {
    contentType: "text/csv",
    resumable: false,
    metadata: { cacheControl: "no-store" },
  }).catch((err) => {
    logger.warn("[titlesImport] commentArchive save failed", { uid, importId, message: safeString(err?.message || String(err), 200) });
  });

  // Review-queue root doc (admin-read / server-write). One per import.
  const reviewRoot = db.collection("importCommentReview").doc(`${uid}__${importId}`);
  await reviewRoot.set({ uid, importId, ...summary, createdAt: now, updatedAt: now }, { merge: true }).catch((err) => {
    logger.warn("[titlesImport] importCommentReview summary write failed", { uid, importId, message: safeString(err?.message || String(err), 200) });
  });

  // LEVEL 2 — per-comment candidates ONLY with consent. Without consent we keep
  // the archive + summary (nothing lost, everything visible) but write no
  // publishable candidates.
  if (consent && candidates.length) {
    const writeFns = candidates.map(({ comment, titleId }) => {
      const { id, payload } = buildReviewCandidate({ uid, importId, comment, titleId, now });
      const ref = reviewRoot.collection("comments").doc(id);
      return (batch) => batch.set(ref, payload, { merge: true });
    });
    await commitInChunks(db, writeFns).catch((err) => {
      logger.warn("[titlesImport] importCommentReview candidates write failed", { uid, importId, message: safeString(err?.message || String(err), 200) });
    });

    if (counts.eligible > 0) {
      await notifyAdminsCommentReviewPending({
        db, importUid: uid, importId, eligible: counts.eligible, resolved,
        fromName: await getDisplayNameForNotify(db, uid),
      }).catch((err) => {
        logger.warn("[titlesImport] notifyAdminsCommentReviewPending failed", { uid, importId, message: safeString(err?.message || String(err), 200) });
      });
    }
  }

  return summary;
}

async function processTvTimeCustomLists({ db, bucket, uid, importId, listsCsv, moviesCsv, matchResults, dryRun = false }) {
  const prepared = prepareTvTimeLists(listsCsv || "", moviesCsv || "");
  const candidates = collectListCandidates(prepared.lists);
  const { byListCandidate } = buildTvTimeImportResolutionMaps(matchResults);
  const titleIdByCandidateKey = new Map(byListCandidate);
  const logicalDupCache = new Map();
  const MAX_FALLBACK_MATCHES = 1500;
  let fallbackMatches = 0;

  if (!dryRun) {
    for (const candidate of candidates) {
      if (titleIdByCandidateKey.has(candidate.key) || !candidate.row) continue;
      if (fallbackMatches >= MAX_FALLBACK_MATCHES) break;
      fallbackMatches += 1;
      // eslint-disable-next-line no-await-in-loop
      const match = await resolveRowMatch(db, bucket, candidate.row, { logicalDupCache }).catch(() => null);
      if (match?.resolved && match?.titleId) titleIdByCandidateKey.set(candidate.key, match.titleId);
    }
  }

  const userSnap = await db.collection("users").doc(uid).get();
  const owner = userSnap.data() || {};
  const now = new Date();
  const planned = buildTvTimeListPlans({ uid, lists: prepared.lists, titleIdByCandidateKey, owner, now });
  const summary = {
    sourceLists: prepared.lists.length,
    createdLists: 0,
    alreadyImported: 0,
    originalPublicLists: planned.originalPublicLists,
    resolvedItems: planned.plans.reduce((n, plan) => n + plan.items.length, 0),
    unresolvedItems: planned.unresolvedItems,
    parseErrors: prepared.errors.length,
    fallbackMatches,
    importedVisibility: "private",
  };
  if (dryRun) return summary;

  for (const plan of planned.plans) {
    const listRef = db.collection("userLists").doc(plan.listId);
    // eslint-disable-next-line no-await-in-loop
    const existing = await listRef.get();
    if (existing.exists) { summary.alreadyImported += 1; continue; }
    const rootBatch = db.batch();
    rootBatch.set(listRef, plan.root);
    rootBatch.set(listRef.collection("members").doc(uid), plan.member);
    // eslint-disable-next-line no-await-in-loop
    await rootBatch.commit();
    const itemFns = plan.items.map((item) => (batch) => {
      batch.set(listRef.collection("items").doc(item.titleId), item);
    });
    // eslint-disable-next-line no-await-in-loop
    if (itemFns.length) await commitInChunks(db, itemFns);
    summary.createdLists += 1;
  }
  return summary;
}

// Writes TV Time movie EMOTIONS (emotions-live-votes.csv) into `titleEmotions`
// as the source of a future backfill — NOT ratings. One doc per (uid, title),
// id `<uid>__<titleId>__title__0__0` (same scheme as titleEmotions in
// firestore.rules), `source: "tvtime_import"`, 1..3 canonical emotion keys. The
// emotions feature's aggregate trigger is not live yet, so these are inert
// until scripts/backfill-titleEmotionAggregate.cjs runs. Admin SDK, so the
// firestore.rules doc-id/whitelist constraints are bypassed — but we still
// write the exact validated shape. Unresolved (movie not matched) are counted.
async function stashTvTimeMovieEmotions({ db, uid, emotions, titleResolutionMap, now }) {
  if (!Array.isArray(emotions) || emotions.length === 0) return { stashed: 0, unresolved: 0 };
  const byTitle = buildEmotionStashByTitle(emotions);
  let unresolved = 0;
  const writeFns = [];
  for (const entry of byTitle) {
    const titleId = titleResolutionMap.get(`movie|${(entry.movieNameGuess || "").trim().toLowerCase()}`);
    if (!titleId) { unresolved += 1; continue; }
    if (!Array.isArray(entry.emotionKeys) || entry.emotionKeys.length === 0) continue;
    const docId = makeRatingId({ uid, titleId, level: "title" });
    const emotionDoc = {
      uid,
      titleId,
      level: "title",
      season: null,
      episode: null,
      emotions: entry.emotionKeys,
      source: "tvtime_import",
      createdAt: now,
      updatedAt: now,
    };
    writeFns.push((batch) => { batch.set(db.collection("titleEmotions").doc(docId), emotionDoc, { merge: true }); });
  }
  if (writeFns.length > 0) await commitInChunks(db, writeFns);
  return { stashed: writeFns.length, unresolved };
}

// Writes Trakt ratings (trakt-native 1..10 → Somto 1..10, NO calibration).
// Mirrors processTvTimeRatingsAndComments's suppression rationale: a bulk
// historical import writes many ratings at once, so every rating carries
// `source: "import_trakt"` and the fan-out triggers early-return on any
// `import_*` source (see the guards in this file), keeping friends' feeds and
// notifications clean for years-old viewing history.
//
// Resolution is by tmdb id (deterministic): the main viewing-history import's
// matchResults already resolved every WATCHED title's tmdbId → titleId, so
// rated-and-watched titles resolve for free. Rated-but-NOT-watched titles
// (a rating with no watch row) aren't in that map, so they're resolved
// on-the-fly via matchViaTmdbId (best-effort; the count of still-unresolved is
// returned for the import summary).
async function processTraktRatings({ db, bucket, uid, intents, tmdbToTitleId }) {
  if (!Array.isArray(intents) || intents.length === 0) {
    return { ratingsWritten: 0, unresolvedRatings: 0 };
  }

  // Copy the caller's tmdbId -> titleId map (built from the viewing-history
  // matchResults) so on-the-fly additions below don't mutate it.
  const resolutionMap = new Map();
  if (tmdbToTitleId instanceof Map) {
    for (const [k, v] of tmdbToTitleId) resolutionMap.set(Number(k), v);
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const first = resolveTraktRatingWrites({ uid, intents, tmdbToTitleId: resolutionMap, now });

  // Best-effort on-the-fly resolution for rated-but-not-watched titles (a
  // rating with no matching watch row). Cap the extra TMDB lookups so a
  // pathological ratings list can't blow the finalize budget — the common case
  // is a handful of rated-not-watched items.
  const logicalDupCache = new Map();
  const seenTmdb = new Set();
  let extraResolvedCount = 0;
  const MAX_ON_THE_FLY = 200;
  for (const intent of first.unresolved) {
    if (extraResolvedCount >= MAX_ON_THE_FLY) break;
    const tmdbId = Number(intent?.tmdbId);
    if (!Number.isFinite(tmdbId) || tmdbId <= 0 || seenTmdb.has(tmdbId)) continue;
    seenTmdb.add(tmdbId);
    // Title-level ratings could be a movie OR a show; season/episode are
    // always tv. For title-level try movie first, then tv (a Trakt "movie"
    // and "show" rating both map to level:"title" here).
    const expectedType = intent.level === "title" ? "movie" : "tv";
    // eslint-disable-next-line no-await-in-loop
    let match = await matchViaTmdbId(db, bucket, tmdbId, expectedType, { logicalDupCache }).catch(() => null);
    if (!match?.titleId && intent.level === "title") {
      // eslint-disable-next-line no-await-in-loop
      match = await matchViaTmdbId(db, bucket, tmdbId, "tv", { logicalDupCache }).catch(() => null);
    }
    if (match?.titleId) {
      resolutionMap.set(tmdbId, match.titleId);
      extraResolvedCount += 1;
    }
  }

  // Single final resolution pass over ALL intents with the (possibly grown)
  // map — the writer is idempotent by ratingId, so building the full write set
  // once is simplest and correct.
  const final = resolveTraktRatingWrites({ uid, intents, tmdbToTitleId: resolutionMap, now });

  if (final.writes.length > 0) {
    const writeFns = final.writes.map(({ ratingId, payload }) => (batch) => {
      batch.set(db.collection("ratings").doc(ratingId), payload, { merge: true });
    });
    await commitInChunks(db, writeFns);
  }

  return { ratingsWritten: final.writes.length, unresolvedRatings: final.unresolvedCount };
}

// Persists the per-row `items` docs for a matched window (called incrementally
// by the resumable tick worker as it matches, so partial progress survives a
// crash/timeout and a resume never re-does matched rows). itemId is
// deterministic (buildImportItemId) → idempotent upsert on re-processing.
async function writeImportItemsWindow(db, importRef, source, windowResults) {
  const itemWrites = windowResults.map(({ row, match }) => {
    const itemId = buildImportItemId(source, row);
    return (batch) => {
      batch.set(importRef.collection("items").doc(itemId), {
        itemId,
        rawTitle: row.rawTitle,
        // TV Time rows have no `rawDate` string (netflixCsv.js's field;
        // tvTimeGdpr.js/tvTimeRefract.js only produce watchedDate) —
        // normalize to null rather than writing `undefined` (Firestore
        // rejects it).
        rawDate: row.rawDate ?? null,
        kind: row.kind,
        refKind: importRowRefKind(row),
        seriesNameGuess: row.seriesNameGuess,
        movieNameGuess: row.movieNameGuess,
        seasonNumber: row.seasonNumber,
        episodeNumber: row.episodeNumber,
        episodeNameGuess: row.episodeNameGuess,
        watchedDate: admin.firestore.Timestamp.fromDate(row.watchedDate),
        watchlistOnly: row.watchlistOnly === true,
        resolved: Boolean(match?.resolved),
        titleId: match?.titleId || null,
        titleName: match?.title?.name || null,
        resolvedAsType: match?.resolvedAsType || null,
        confidence: Number(match?.confidence || 0),
        strategy: match?.strategy || null,
        suggestion: match?.suggestion || null,
        skip: false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    };
  });
  await commitInChunks(db, itemWrites);
}

// Rebuilds the { row, match }[] that finalizeImportResults consumes, sourcing
// each row's resolution from the persisted `items` docs (written by the tick
// worker) rather than an in-memory match array — because matching spanned many
// separate invocations, no single process ever held them all. `rows` is the
// fresh re-parse (deterministic order); we look up each row's item by its
// deterministic itemId, then batch-fetch the unique resolved title docs
// (buildImportTitleStateWrites/toggle_watchlist need the full title doc, not
// just its id).
async function reconstructMatchResultsFromItems(db, importRef, rows, source) {
  const itemsSnap = await importRef.collection("items").get();
  const itemById = new Map();
  itemsSnap.forEach((doc) => itemById.set(doc.id, doc.data() || {}));

  // Batch-load the unique resolved (non-skipped) title docs.
  const titleIds = Array.from(new Set(
    Array.from(itemById.values())
      .filter((it) => it.resolved && it.titleId && it.skip !== true)
      .map((it) => it.titleId)
  ));
  const titleById = new Map();
  for (let i = 0; i < titleIds.length; i += 10) {
    const chunk = titleIds.slice(i, i + 10);
    // eslint-disable-next-line no-await-in-loop
    const snaps = await Promise.all(chunk.map((id) => db.collection("titles").doc(id).get()));
    snaps.forEach((snap, idx) => {
      if (snap.exists) titleById.set(chunk[idx], snap.data() || {});
    });
  }

  return buildMatchResultsFromItems({
    rows,
    itemById,
    titleById,
    itemIdFor: (row) => buildImportItemId(source, row),
  });
}

// Enriches ONE resolved title doc with the duration + episode-count meta the
// stats math needs, fetching TMDB details and patching only the missing fields.
// Reuses the canonical enrichment building blocks (resolveKnownTmdbTarget →
// fetchTmdbCachedJson → buildTitleDurationMetaPatch, the shared field logic that
// refreshTitleFromTmdb also uses) — no duplicated TMDB-shape parsing here.
//
// - Skips a title that already carries the needed fields (titleNeedsDurationEnrichment).
// - Skips a title with tmdbSync.syncDisabled (manually-curated merge doc).
// - Uses the doc's OWN tmdbId / tmdb_* docId (resolveKnownTmdbTarget, no search
//   call) — imported stubs are created with a tmdbId, so this is the common path.
//   No fallback TMDB search is attempted (keeps the enrichment cost 1 call/title
//   and avoids mis-matching a bare-name stub); a title with no known tmdbId is
//   left as-is (degrades gracefully to 0 minutes, exactly as before this phase).
// Returns "enriched" | "skipped" | "no_tmdb_id" | "no_details" | "error".
async function enrichSingleImportTitle(db, titleId, title, { state }) {
  const data = title && typeof title === "object" ? title : {};
  if (asObject(data.tmdbSync).syncDisabled === true) return "skipped";
  if (!titleNeedsDurationEnrichment(data)) return "skipped";

  const target = resolveKnownTmdbTarget(titleId, data);
  if (!target?.tmdbId) return "no_tmdb_id";

  const detailsPath = target.mediaType === "tv" ? `/tv/${target.tmdbId}` : `/movie/${target.tmdbId}`;
  const details = await fetchTmdbCachedJson(detailsPath, {
    language: "it-IT",
  }, {
    db,
    state,
    cacheScope: `importEnrichDetails_${target.mediaType}`,
    ttlSeconds: 7 * 24 * 60 * 60,
    allowStaleOnError: true,
  });

  const payload = details?.data || null;
  if (!payload) return "no_details";

  const currentMeta = asObject(data.meta);
  const { nextMeta, changedFields } = buildTitleDurationMetaPatch(currentMeta, payload, target.mediaType);
  if (!changedFields.length) return "skipped";

  // Merge non-destructively: only the duration/episode-count meta fields the
  // builder touched are written (buildTitleDurationMetaPatch never overwrites an
  // existing positive value). Also stamp mediaType if the stub lacked it, so
  // estimateTitleTotals reads the right branch.
  const metaPatch = { ...nextMeta };
  if (!currentMeta.mediaType) metaPatch.mediaType = target.mediaType;
  await db.collection("titles").doc(titleId).set({
    meta: metaPatch,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return "enriched";
}

// One enrichment tick: enriches a time-bounded window of the DISTINCT resolved
// titles that still need duration/episode meta, advances `enrichCursor`, then
// chains a successor enrich tick or runs the finalize tail. Resumable +
// idempotent — the cursor advances only after the window is processed, and
// enrichSingleImportTitle skips already-enriched titles, so a re-run of any
// window is a no-op on titles already done. Enriching BEFORE finalize means the
// titleStates computed there (buildImportTitleStateWrites) read the freshly
// patched meta → correct watch-minutes + completed/in-progress out of the box.
//
// Self-contained (loads + parses the payload itself, like processImportMatchTick)
// so finalize gets the rows it needs; a missing payload fails the import.
async function processImportEnrichTick({ db, uid, importId, importRef, importData, cursor }) {
  const requestedSource = safeString(importData?.requestedSource || importData?.source || "", 40).trim().toLowerCase();
  const bucket = admin.storage().bucket();

  const loaded = await loadImportRawPayload(bucket, importRef);
  if (!loaded) {
    await importRef.set({
      status: "failed",
      error: "Payload import mancante.",
      failureReason: "Payload import mancante.",
      errorCount: importFailureErrorCount([], importData?.errorCount),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => {});
    await createTitlesImportNotification(db, uid, importId, "failed", {}, requestedSource);
    return;
  }
  const detection = await resolveAndPersistImportPayloadSource(importRef, requestedSource, loaded, importData);
  if (!detection.valid) {
    await importRef.set({
      status: "failed",
      error: detection.reason,
      failureReason: detection.reason,
      errorCount: importFailureErrorCount([], importData?.errorCount),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    await createTitlesImportNotification(db, uid, importId, "failed", {}, requestedSource);
    return;
  }
  const source = detection.effectiveSource;
  const { rows, errors } = parseImportRows(source, loaded);

  // Rebuild the durable item map (same source reconstructMatchResultsFromItems
  // uses) and derive the deterministic distinct-titleId order.
  const itemsSnap = await importRef.collection("items").get();
  const itemById = new Map();
  itemsSnap.forEach((doc) => itemById.set(doc.id, doc.data() || {}));
  const titleIds = distinctResolvedTitleIds(itemById);
  const total = titleIds.length;

  // Nothing to enrich (no resolved titles) → straight to finalize.
  if (total === 0 || cursor >= total) {
    await finalizeImportTail({ db, uid, importId, importRef, source, rows, errors, loaded, importData, bucket });
    return;
  }

  const startMs = Date.now();
  const { end: windowEnd } = computeEnrichWindow(cursor, total, IMPORT_ENRICH_WINDOW_MAX);
  // Shared TMDB call-budget/attempt guard, same knobs refreshTitleFromTmdb uses.
  const state = { maxApiCalls: 400, maxAttempts: 3 };
  let processed = cursor;
  for (let i = cursor; i < windowEnd; i++) {
    const titleId = titleIds[i];
    // eslint-disable-next-line no-await-in-loop
    const snap = await db.collection("titles").doc(titleId).get().catch(() => null);
    if (snap && snap.exists) {
      // eslint-disable-next-line no-await-in-loop
      await enrichSingleImportTitle(db, titleId, snap.data() || {}, { state }).catch((err) => {
        // Never let one title's TMDB blip fail the import — degrade gracefully.
        logger.warn("[titlesImport] enrich title failed", {
          titleId, message: safeString(err?.message || String(err), 200),
        });
      });
    }
    processed = i + 1;
    if (Date.now() - startMs > IMPORT_ENRICH_TIME_BUDGET_MS) break;
  }

  await importRef.set({
    enrichCursor: processed,
    enrichTotal: total,
    status: "enriching",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  if (processed < total) {
    await createImportEnrichTick(db, uid, importId, processed);
  } else {
    await finalizeImportTail({ db, uid, importId, importRef, source, rows, errors, loaded, importData, bucket });
  }
}

// Shared "given matched rows, write everything and land the import doc in a
// terminal state" tail — title-state writes (watched vs watchlist-only split),
// duration backfill, GDPR-only ratings/comments, final status + notification.
// Called by the resumable tick worker's finalize step once every row has been
// matched (its per-row `items` already persisted). Does NOT catch its own
// errors — the caller wraps this so a thrown error still lands the import doc
// in "failed".
// Alimenta il taste profile (users/{uid}/tasteProfile/agg) con i titoli appena
// importati, in UNA sola transazione — nessun fan-out di segnali, nessuna
// contesa sull'hot-doc. Riusa IDENTICA la matematica del trigger via
// lib/tasteProfileAggregate. Un titolo con voto (TV Time/Trakt) usa il delta
// reale (anche negativo); un visto senza voto (es. Netflix) usa import_seen,
// preferenza debole positiva → il profilo si sposta verso i generi realmente
// consumati. Idempotente: guardia tasteProfileApplied su importRef (un re-run
// del finalize non ri-somma). Best-effort: il chiamante non fa fallire l'import
// se questo lancia.
async function applyImportTasteProfile({ db, uid, importRef, source, watchedRows, allMatchedRows }) {
  const watchedIds = Array.from(new Set((watchedRows || []).map((r) => r.titleId).filter(Boolean)));
  if (watchedIds.length === 0) return { applied: false, reason: "no_watched" };

  // Guardia idempotenza: se già applicato (reprocess/riparazione) non ri-sommo.
  const importSnap = await importRef.get().catch(() => null);
  if (importSnap && importSnap.exists && importSnap.data() && importSnap.data().tasteProfileApplied === true) {
    return { applied: false, reason: "already_applied" };
  }

  // Feature per titolo dal doc titolo completo già in memoria (match.title):
  // nessuna rilettura di titles/*.
  const featuresByTitleId = new Map();
  for (const { titleId, title } of (allMatchedRows || [])) {
    if (!titleId || featuresByTitleId.has(titleId)) continue;
    featuresByTitleId.set(titleId, extractTasteFeatures(title));
  }

  // Voti a livello titolo (solo sorgenti che scrivono /ratings): danno il delta
  // reale, anche negativo. TV Time scrive già la scala 1-10 calibrata, quindi
  // normalizedFromRating (dentro deltaForAction) va bene così.
  const ratingByTitleId = new Map();
  if (source === "tvtime_gdpr" || source === "trakt") {
    const ratingsSnap = await db.collection("ratings")
      .where("uid", "==", uid)
      .limit(2000)
      .get()
      .catch(() => ({ docs: [] }));
    ratingsSnap.forEach((doc) => {
      const r = doc.data() || {};
      if (r.level !== "title") return;
      const tId = toId(r.titleId);
      const val = Number(r.rating);
      if (tId && Number.isFinite(val) && val > 0) ratingByTitleId.set(tId, val);
    });
  }

  // Input del fold (logica pura nel modulo): voto reale se presente, altrimenti
  // visto-positivo debole; scarta senza-feature e voti neutri.
  const now = new Date();
  const inputs = buildImportTasteInputs({ watchedTitleIds: watchedIds, featuresByTitleId, ratingByTitleId })
    .map((it) => ({ ...it, createdAt: now }));
  if (inputs.length === 0) return { applied: false, reason: "no_inputs" };

  const userRef = db.collection("users").doc(uid);
  const privateUserRef = db.collection("usersPrivate").doc(uid);
  const tpRef = userRef.collection("tasteProfile").doc("agg");

  await db.runTransaction(async (tx) => {
    const [tpSnap, userSnap, privSnap] = await Promise.all([
      tx.get(tpRef), tx.get(userRef), tx.get(privateUserRef),
    ]);
    const current = tpSnap.exists ? (tpSnap.data() || {}) : {};
    const merged = {
      ...(userSnap.exists ? userSnap.data() || {} : {}),
      ...(privSnap.exists ? privSnap.data() || {} : {}),
    };
    const featureSums = current.featureSums || {};
    foldTasteDeltas(featureSums, inputs);
    pruneTasteFeatureSums(featureSums);
    const completedLevel = Number(merged && merged.onboardingStatus && merged.onboardingStatus.completedLevel || 0);
    const confidenceScore = computeTasteConfidence(featureSums, completedLevel);
    tx.set(tpRef, {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      featureSums,
      confidenceScore,
      seed: {
        onboardingCompletedLevel: completedLevel,
        seedTitleIds: Array.isArray(merged && merged.tasteProfile && merged.tasteProfile.seedTitleIds)
          ? merged.tasteProfile.seedTitleIds
          : [],
      },
    }, { merge: true });
  });

  await importRef.set({
    tasteProfileApplied: true,
    tasteProfileSummary: { titlesFolded: inputs.length, ratedTitles: ratingByTitleId.size, source },
  }, { merge: true }).catch(() => {});

  return { applied: true, titlesFolded: inputs.length, ratedTitles: ratingByTitleId.size };
}

async function finalizeImportResults({ db, uid, importId, importRef, payloadRef, source, rows, errors, matchResults, dryRun, importOptions, payload = {}, traktJson = "", bucket = null, extraEpisodes = [], listsCsv = "", moviesCsv = "" }) {
  const userRef = db.collection("users").doc(uid);

  // NOTE: the per-row `items` docs are NOT written here — the resumable tick
  // worker (writeImportItemsWindow) persists them incrementally as it matches,
  // so by the time this tail runs they already exist. This function only reads
  // the reconstructed matchResults to drive the title-state writes.
  const allMatchedRows = matchResults
    .filter(({ match }) => match?.resolved && match?.titleId)
    .map(({ row, match }) => ({ titleId: match.titleId, title: match.title, row }));
  const unresolvedCount = matchResults.length - allMatchedRows.length;

  // TV Time "follow"/is_for_later rows carry NO watch signal — they must
  // never call mark_movie_seen/set_series_progress. Split them out from the
  // ordinary "watched" rows. If a titleId has AT LEAST ONE watched row, the
  // watchlist-only rows for that same title are dropped entirely (a title
  // the user has actually watched should never be pushed back into "to
  // watch"); a titleId with ONLY watchlist-only rows gets toggle_watchlist
  // instead of a fabricated watch/progress state.
  const watchlistOnlyRowsRaw = allMatchedRows.filter((r) => r.row.watchlistOnly === true);
  const watchedRows = allMatchedRows.filter((r) => r.row.watchlistOnly !== true);
  const watchedTitleIds = new Set(watchedRows.map((r) => r.titleId));
  const watchlistOnlyRows = watchlistOnlyRowsRaw.filter((r) => !watchedTitleIds.has(r.titleId));
  // matchedRows = union used for reporting (matchedCount includes both).
  const matchedRows = watchedRows.concat(
    watchlistOnlyRowsRaw.filter((r) => watchedTitleIds.has(r.titleId))
  );

  let titleStateIdsWritten = [];
  if (!dryRun && (watchedRows.length > 0 || watchlistOnlyRows.length > 0)) {
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

    await persistPreviousTitleStates({
      db,
      importRef,
      currentStatesByTitleId,
      capturedAt: admin.firestore.FieldValue.serverTimestamp(),
      logger,
      logContext: { uid, importId, phase: "finalize" },
    });

    const writes = buildImportTitleStateWrites(watchedRows, currentStatesByTitleId, {
      now: new Date(),
      source,
      ...importOptions,
    });

    // Watchlist-only titles: toggle_watchlist, using buildNextTitleState
    // directly (buildImportTitleStateWrites always drives mark_seen/
    // set_progress, which would be wrong here — there's no watch signal).
    // toggle_watchlist itself is a no-op if the title has already started
    // (hasStartedWatching), so this can never regress an in-progress/rated
    // title back to "to watch".
    const watchlistOnlyByTitleId = new Map();
    for (const { titleId, title } of watchlistOnlyRows) {
      if (watchlistOnlyByTitleId.has(titleId)) continue;
      const currentState = currentStatesByTitleId.get(titleId) || null;
      const titleForState = { ...(title || {}), id: titleId };
      const next = buildNextTitleState(currentState, {
        type: "toggle_watchlist",
        enabled: true,
        source: `import_${source}`,
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

    await commitInChunks(db, titleStateWriteFns);
    titleStateIdsWritten = Array.from(new Set([
      ...writes.map((w) => w.titleId),
      ...Array.from(watchlistOnlyByTitleId.keys()),
    ]));

    await backfillTitleDurationsFromImport(db, watchedRows).catch((err) => {
      logger.warn("[titlesImport] backfillTitleDurationsFromImport failed", { message: safeString(err?.message || String(err), 200) });
    });

    if (source === "tvtime_gdpr") {
      const ratingsSummary = await processTvTimeRatingsAndComments({ db, uid, userRef, payload, matchResults }).catch((err) => {
        logger.warn("[titlesImport] processTvTimeRatingsAndComments failed", { message: safeString(err?.message || String(err), 200) });
        return null;
      });
      if (ratingsSummary) {
        // Surface what happened to votes/emotions on the import doc (scale
        // detected, ratings written, emotions stashed, anything unrecognized).
        await importRef.set({ ratingsSummary }, { merge: true }).catch(() => {});
        if (ratingsSummary.dominantIdUnrecognized) {
          logger.warn("[titlesImport] tvtime vote scale flag: dominant id unrecognized", { uid, importId });
        }
      }
    }

    if (source === "trakt") {
      // Trakt ratings (1..10, no calibration) — resolve by tmdb id. The
      // viewing-history matchResults already carry `row.tmdbId` + `match.titleId`
      // for every watched title, so rated-and-watched titles resolve for free;
      // rated-not-watched fall back to matchViaTmdbId inside processTraktRatings.
      const tmdbToTitleId = new Map();
      for (const { row, match } of matchResults) {
        if (match?.resolved && match?.titleId && row?.tmdbId != null) {
          tmdbToTitleId.set(Number(row.tmdbId), match.titleId);
        }
      }
      let intents = [];
      try {
        intents = buildTraktRatingIntents(JSON.parse(traktJson || "{}"));
      } catch (err) {
        logger.warn("[titlesImport] trakt rating intents parse failed", { message: safeString(err?.message || String(err), 200) });
      }
      if (intents.length > 0) {
        await processTraktRatings({ db, bucket: bucket || admin.storage().bucket(), uid, intents, tmdbToTitleId }).catch((err) => {
          logger.warn("[titlesImport] processTraktRatings failed", { message: safeString(err?.message || String(err), 200) });
        });
      }
    }
  }

  if (source === "tvtime_gdpr") {
    const extraEpisodesSummary = await preserveTvTimeExtraEpisodes({
      db, uid, importId, extraEpisodes, matchResults, dryRun,
    }).catch((err) => {
      logger.warn("[titlesImport] preserveTvTimeExtraEpisodes failed", { message: safeString(err?.message || String(err), 200) });
      return null;
    });
    if (extraEpisodesSummary) await importRef.set({ extraEpisodesSummary }, { merge: true }).catch(() => {});

    if (listsCsv) {
      const listsSummary = await processTvTimeCustomLists({
        db,
        bucket: bucket || admin.storage().bucket(),
        uid,
        importId,
        listsCsv,
        moviesCsv,
        matchResults,
        dryRun,
      }).catch((err) => {
        logger.warn("[titlesImport] processTvTimeCustomLists failed", { message: safeString(err?.message || String(err), 200) });
        return null;
      });
      if (listsSummary) await importRef.set({ listsSummary }, { merge: true }).catch(() => {});
    }

    // Episode comments: archive (no-TTL) + review queue. Runs even with zero
    // watched rows, and independent of consent (consent only gates whether
    // per-comment publishable candidates are written — see the function).
    const commentsSummary = await processTvTimeEpisodeComments({
      db, uid, importId, importRef,
      bucket: bucket || admin.storage().bucket(),
      episodeCommentsCsv: payload?.rawCsvEpisodeComments || "",
      matchResults, importOptions, dryRun,
    }).catch((err) => {
      logger.warn("[titlesImport] processTvTimeEpisodeComments failed", { message: safeString(err?.message || String(err), 200) });
      return null;
    });
    if (commentsSummary) await importRef.set({ commentsSummary }, { merge: true }).catch(() => {});
  }

  // Alimenta il taste profile con i titoli importati (dopo che titleStates e
  // ratings sono già stati scritti). Best-effort: un errore qui NON fa fallire
  // l'import.
  if (!dryRun) {
    await applyImportTasteProfile({ db, uid, importRef, source, watchedRows, allMatchedRows })
      .then((res) => {
        if (res && res.applied) logger.info("[titlesImport] taste profile aggiornato", { uid, importId, titlesFolded: res.titlesFolded, ratedTitles: res.ratedTitles });
      })
      .catch((err) => logger.warn("[titlesImport] applyImportTasteProfile failed", { message: safeString(err?.message || String(err), 200) }));
  }

  // matchedCount = every row that resolved to a titleId, whether it ended
  // up driving a watch/progress write (matchedRows) or a watchlist-only
  // toggle (watchlistOnlyRows) — both are a successful, user-visible
  // outcome of the import.
  const totalMatchedCount = matchedRows.length + watchlistOnlyRows.length;
  // Zero righe utili = fallimento, MAI "completato". Le guardie sulle due
  // callable d'ingresso non bastano: `retryTitlesImport` (il bottone "Riprova")
  // e `reviveStalledTitlesImports` rimettono in coda un import gia' fallito
  // controllando solo che i file esistano, e la coda finiva qui marcando
  // "completed" con 0 titoli. Caso live: Francesca_Scrofani, import
  // 6pXCspU8VAeOOL4drppY (`retriedBy: retryTitlesImport`), 23 luglio.
  // Questo e' il collo di bottiglia comune a ogni via: la guardia sta qui.
  const finalStatus = rows.length === 0
    ? "failed"
    : (unresolvedCount > 0 ? "awaiting_confirmation" : "completed");
  const finalizedAt = admin.firestore.Timestamp.now();
  // Cosa NON e' arrivato: un import puo' riuscire e aver lasciato fuori i film
  // (file assente dallo ZIP) o centinaia di titoli non riconosciuti. Finora
  // restava scritto solo nei parseErrors, che l'utente non vede — se ne
  // accorgeva guardando la libreria e ci scriveva.
  const warnings = buildImportWarnings({ source, rows, errors, matchedCount: totalMatchedCount, unresolvedCount });
  const parseErrorRatio = computeParseErrorRatio(rows.length, errors);
  if (parseErrorRatio >= 0.2) {
    logger.warn("[titlesImport] high parser error ratio", {
      uid,
      importId,
      source,
      rows: rows.length,
      errors: errors.length,
      parseErrorRatio,
    });
  }
  await importRef.set({
    status: finalStatus,
    warnings,
    // `error` E `failureReason`: entrambi i client leggono `error` (iOS
    // TitlesImportRepository, web friendlyFailureMessage). Scrivere solo il
    // campo nuovo avrebbe lasciato le app gia' installate senza il motivo
    // fino alla prossima release.
    ...(finalStatus === "failed" ? (() => {
      const reason = errors?.[0]?.reason
        ? `Non riesco a leggere voci utili nei file caricati (${safeString(errors[0].reason, 200)}).`
        : "Non riesco a leggere voci utili nei file caricati.";
      return { failureReason: reason, error: reason };
    })() : {}),
    totalRows: rows.length,
    processedCount: rows.length,
    matchedCount: totalMatchedCount,
    // Unique titles actually written to the library (auto-matched). The confirm
    // step later merges in user-picked/accepted titles; both clients read this
    // for the final summary. skippedCount starts at 0 (nothing skipped yet).
    importedTitleCount: titleStateIdsWritten.length,
    skippedCount: 0,
    unresolvedCount,
    errorCount: finalStatus === "failed"
      ? importFailureErrorCount(errors)
      : errors.length,
    parseErrorRatio,
    parseErrors: errors.slice(0, 200),
    titleStateIdsWritten,
    updatedAt: finalizedAt,
    completedAt: finalStatus === "completed" ? finalizedAt : null,
  }, { merge: true });

  if (finalStatus === "completed" && titleStateIdsWritten.length > 0) {
    await recordSuccessfulImportTracking({ db, uid, completedAt: finalizedAt })
      .catch((err) => logger.warn("[productTracking] import milestone failed", {
        uid,
        importId,
        message: safeString(err?.message || String(err), 180),
      }));
  }

  await payloadRef.delete().catch(() => {});
  await createTitlesImportNotification(db, uid, importId, finalStatus, {
    matchedCount: totalMatchedCount,
    unresolvedCount,
    warnings,
    failureReason: finalStatus === "failed" ? (errors?.[0]?.reason || "") : "",
  }, source);

  return {
    status: finalStatus,
    matchedCount: totalMatchedCount,
    unresolvedCount,
    errorCount: finalStatus === "failed" ? importFailureErrorCount(errors) : errors.length,
    titleStateIdsWritten,
  };
}

// Processes one matching "tick": matches a time-budgeted window of rows,
// persists their items, advances the cursor, then either chains a successor
// tick or runs the finalize tail. Idempotent + resumable — the cursor only
// advances AFTER the window's items are durably written, so a crash/timeout
// mid-tick just re-does the un-persisted tail of the window on the next tick,
// never double-writes a matched row.
async function processImportMatchTick({ db, uid, importId, importRef, importData, cursor }) {
  const requestedSource = safeString(importData?.requestedSource || importData?.source || "", 40).trim().toLowerCase();
  const bucket = admin.storage().bucket();

  const loaded = await loadImportRawPayload(bucket, importRef);
  if (!loaded) {
    await importRef.set({
      status: "failed",
      error: "Payload import mancante.",
      failureReason: "Payload import mancante.",
      errorCount: importFailureErrorCount([], importData?.errorCount),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => {});
    await createTitlesImportNotification(db, uid, importId, "failed", {}, requestedSource);
    return;
  }

  const detection = await resolveAndPersistImportPayloadSource(importRef, requestedSource, loaded, importData);
  if (!detection.valid) {
    await importRef.set({
      status: "failed",
      error: detection.reason,
      failureReason: detection.reason,
      errorCount: importFailureErrorCount([], importData?.errorCount),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    await createTitlesImportNotification(db, uid, importId, "failed", {}, requestedSource);
    return;
  }
  const source = detection.effectiveSource;
  const { rows, errors } = parseImportRows(source, loaded);
  const total = rows.length;

  // Cursor at/after the end → matching done; enter the enrichment phase
  // (which runs the finalize tail when it completes).
  if (cursor >= total) {
    await startImportEnrichmentPhase({ db, uid, importId, importRef, source, rows, errors, loaded, importData, bucket });
    return;
  }

  const startMs = Date.now();
  const { end: windowEnd } = computeMatchWindow(cursor, total, IMPORT_MATCH_WINDOW_MAX);
  const logicalDupCache = new Map();
  const windowResults = [];
  let processed = cursor;
  for (let i = cursor; i < windowEnd; i++) {
    const row = rows[i];
    // eslint-disable-next-line no-await-in-loop
    const match = await resolveRowMatch(db, bucket, row, { logicalDupCache }).catch((err) => {
      logger.warn("[titlesImport] row match failed", { message: safeString(err?.message || String(err), 200) });
      return { resolved: false, titleId: null, title: null, confidence: 0, strategy: null, resolvedAsType: null, suggestion: null };
    });
    windowResults.push({ row, match });
    processed = i + 1;
    // Yield well before the 540s hard kill so we can persist + chain a
    // successor rather than being killed mid-window.
    if (Date.now() - startMs > IMPORT_MATCH_TIME_BUDGET_MS) break;
  }

  // Durability point: persist this window's items BEFORE advancing the cursor.
  await writeImportItemsWindow(db, importRef, source, windowResults);

  await importRef.set({
    matchCursor: processed,
    processedCount: processed,
    totalRows: total,
    status: "matching",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  if (processed < total) {
    await createImportMatchTick(db, uid, importId, processed);
  } else {
    // Matching done — hand off to the enrichment phase before finalize.
    await startImportEnrichmentPhase({ db, uid, importId, importRef, source, rows, errors, loaded, importData, bucket });
  }
}

// Transitions a fully-matched import into the enrichment phase: resets
// enrichCursor to 0 and enqueues the first enrich tick. A dryRun import writes
// nothing, so enrichment (a title-doc write) is skipped and it goes straight to
// finalize. processImportEnrichTick itself short-circuits to finalize when there
// are no resolved titles to enrich, so this never strands an import.
async function startImportEnrichmentPhase({ db, uid, importId, importRef, source, rows, errors, loaded, importData, bucket }) {
  if (Boolean(importData?.dryRun)) {
    await finalizeImportTail({ db, uid, importId, importRef, source, rows, errors, loaded, importData, bucket });
    return;
  }
  await importRef.set({
    enrichCursor: 0,
    status: "enriching",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  await createImportEnrichTick(db, uid, importId, 0);
}

// Finalize tail — runs once every row has been matched (its item persisted):
// reconstruct matchResults from the persisted items, run the shared title-
// state/ratings writer, then delete the uploaded Storage objects.
async function finalizeImportTail({ db, uid, importId, importRef, source, rows, errors, loaded, importData, bucket }) {
  const dryRun = Boolean(importData?.dryRun);
  const importOptions = normalizeTitlesImportOptions(importData?.importOptions || {});
  const payloadRef = importRef.collection("payload").doc("raw");

  const matchResults = await reconstructMatchResultsFromItems(db, importRef, rows, source);
  const reparsed = parseImportRows(source, loaded);

  // GDPR ratings/comments come from the loaded payload's `.ratings` (Storage
  // or inline); processTvTimeRatingsAndComments only runs for tvtime_gdpr.
  const payload = {
    rawCsvEpisodeVotes: loaded?.ratings?.episodeVotes || "",
    rawCsvMovieRatings: loaded?.ratings?.movieRatings || "",
    rawCsvShowRatings: loaded?.ratings?.showRatings || "",
    rawCsvMovieVotes: loaded?.ratings?.movieVotes || "",
    rawCsvMovieComments: loaded?.ratings?.movieComments || "",
    rawCsvEpisodeComments: loaded?.ratings?.episodeComments || "",
  };

  await finalizeImportResults({
    db, uid, importId, importRef, payloadRef, source, rows, errors, matchResults, dryRun, importOptions, payload,
    // Trakt ratings live in the loaded JSON blob (not the CSV `.ratings`).
    traktJson: loaded?.traktJson || "",
    bucket,
    extraEpisodes: reparsed?.extraEpisodes || [],
    listsCsv: loaded?.listsText || "",
    moviesCsv: loaded?.moviesText || "",
  });

  // Source files are RETAINED after matching so a problematic import can be
  // re-processed without asking the user to re-upload (TV Time ondata
  // safety-net, 2026-07-08). Deletion is delegated to a GCS Object Lifecycle
  // rule on the bucket (manualImports/ = 7d TTL, supportImports/ = 14d TTL).
  // cleanupImportStorage is kept for explicit manual cleanup if ever needed.
  void cleanupImportStorage;
}

// Impedisce import concorrenti / ricaricamenti inutili. Causa n.1 di costo
// Firestore nell'ondata import: l'utente non vede la coda di conferma, pensa
// che non sia successo nulla e RICARICA lo stesso file piu' volte -> ogni
// ricarica ri-esegue il matching completo (migliaia di read a testa). Blocca
// un nuovo import se ce n'e' gia' uno ATTIVO di recente (queued/matching/
// uploading, <15 min) o uno della STESSA fonte gia' pronto da confermare
// (awaiting_confirmation). NON intrappola: gli stati stantii (>15 min, es.
// upload bloccati) non bloccano, e una fonte diversa e' sempre permessa.
async function assertNoConflictingImport(db, uid, source) {
  const snap = await db.collection("users").doc(uid).collection("imports")
    .where("status", "in", ["queued", "matching", "uploading", "awaiting_confirmation"])
    .get()
    .catch(() => null);
  if (!snap || snap.empty) return;
  const now = Date.now();
  const RECENT_MS = 15 * 60 * 1000;
  for (const d of snap.docs) {
    const x = d.data() || {};
    const st = String(x.status || "");
    const updatedMs = x.updatedAt && x.updatedAt.toMillis ? x.updatedAt.toMillis() : 0;
    if ((st === "queued" || st === "matching" || st === "uploading") && (now - updatedMs) < RECENT_MS) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Hai gia' un import in corso. Attendi che finisca (di solito 1-2 minuti) prima di caricarne un altro."
      );
    }
    if (st === "awaiting_confirmation" && String(x.source || "") === String(source || "")) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Hai gia' un import da questa fonte pronto da confermare: aprilo e completa la conferma nella coda. Non serve ricaricare il file."
      );
    }
  }
}

exports.startTitlesImport = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 60, memory: "256MB" })
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid || null;
    if (!uid) {
      throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
    }

    const db = admin.firestore();
    await enforceCallableRateLimit(db, uid, "startTitlesImport", {
      windowSeconds: 60,
      maxInWindow: 1,
      dailyMax: 3,
    });

    const requestedSource = safeString(data?.source || "", 40).trim().toLowerCase();
    if (!TITLES_IMPORT_SOURCES.has(requestedSource)) {
      throw new functions.https.HttpsError("invalid-argument", "Sorgente import non supportata.");
    }
    await assertNoConflictingImport(db, uid, requestedSource);
    const dryRun = Boolean(data?.dryRun);
    const importOptions = normalizeTitlesImportOptions(data?.options || data?.importOptions || {});
    const platform = normalizeImportPlatform(data?.platform);

    // Payload shape depends on source: netflix_csv sends a single `rawCsv`
    // string; tvtime_gdpr sends the 2 relevant CSVs extracted client-side
    // from the GDPR export ZIP as `rawCsvV1` (movies) + `rawCsvV2` (series),
    // plus 4 OPTIONAL vote/comment CSVs (votes+reviews are a bonus on top of
    // the core viewing-history import — their absence never blocks it).
    // Refract normally uploads JSON through Storage. A stale/misconfigured
    // client can still send a small Refract payload through these GDPR slots:
    // the structural detector below corrects it before parsing.
    let payloadFields;
    let rawPayload;
    if (requestedSource === "tvtime_gdpr") {
      const rawCsvV1 = typeof data?.rawCsvV1 === "string" ? data.rawCsvV1 : "";
      const rawCsvV2 = typeof data?.rawCsvV2 === "string" ? data.rawCsvV2 : "";
      if (!rawCsvV1.trim() && !rawCsvV2.trim()) {
        throw new functions.https.HttpsError("invalid-argument", "File CSV mancanti o vuoti.");
      }
      // Optional: ratings-3-prod-episode_votes.csv (episode ratings),
      // ratings-live-votes.csv (movie ratings), emotions-live-votes.csv (movie
      // emotions), comments-prod-comments.csv, episode_comment.csv.
      const rawCsvEpisodeVotes = typeof data?.rawCsvEpisodeVotes === "string" ? data.rawCsvEpisodeVotes : "";
      const rawCsvMovieRatings = typeof data?.rawCsvMovieRatings === "string" ? data.rawCsvMovieRatings : "";
      const rawCsvShowRatings = typeof data?.rawCsvShowRatings === "string" ? data.rawCsvShowRatings : "";
      const rawCsvMovieVotes = typeof data?.rawCsvMovieVotes === "string" ? data.rawCsvMovieVotes : "";
      const rawCsvMovieComments = typeof data?.rawCsvMovieComments === "string" ? data.rawCsvMovieComments : "";
      const rawCsvEpisodeComments = typeof data?.rawCsvEpisodeComments === "string" ? data.rawCsvEpisodeComments : "";
      const rawCsvLists = typeof data?.rawCsvLists === "string" ? data.rawCsvLists : "";
      rawPayload = { rawCsvV1, rawCsvV2 };
      payloadFields = { rawCsvV1, rawCsvV2, rawCsvEpisodeVotes, rawCsvMovieRatings, rawCsvMovieVotes, rawCsvMovieComments, rawCsvEpisodeComments, rawCsvLists, rawCsvShowRatings };
    } else {
      const rawCsv = typeof data?.rawCsv === "string" ? data.rawCsv : "";
      if (!rawCsv.trim()) {
        throw new functions.https.HttpsError("invalid-argument", "File CSV mancante o vuoto.");
      }
      rawPayload = rawCsv;
      payloadFields = { rawCsv };
    }

    // The callable-body transport stores the raw payload inside a single
    // Firestore doc (1MB per-field cap). Large libraries MUST use the
    // Storage-upload transport (createTitlesImportUploadSession); a modern
    // client routes there automatically, but guard here so a stale client (or
    // a direct call) fails with a clear message instead of an opaque
    // batch.commit "value too large" deep in the write.
    // NB: il check byte sta PRIMA di parseTitlesImportPayload — il parse tiene
    // tutto in memoria e con 256MB la function andrebbe in OOM (errore
    // "internal" opaco) proprio sui file per cui esiste questo messaggio.
    const payloadBytes = Buffer.byteLength(JSON.stringify(payloadFields), "utf8");
    if (payloadBytes > 900 * 1024) {
      // Un client aggiornato instrada da solo verso l'upload su Storage; qui
      // ci arriva solo un client vecchio (tipicamente l'app iOS non ancora
      // aggiornata). Messaggio azionabile mostrato tale e quale dall'app.
      throw new functions.https.HttpsError(
        "invalid-argument",
        "La tua libreria è troppo grande per l'importazione da app. Importala dal sito somto.it/import (stesso account): lì il caricamento gestisce anche i file grandi."
      );
    }

    let source = requestedSource;
    let sourceAudit = null;
    let parsed;
    if (requestedSource === "tvtime_gdpr") {
      sourceAudit = detectTvTimePayloadSource(requestedSource, {
        moviesText: rawPayload.rawCsvV1,
        seriesText: rawPayload.rawCsvV2,
      });
      if (!sourceAudit.valid) {
        throw new functions.https.HttpsError("invalid-argument", sourceAudit.reason);
      }
      source = sourceAudit.effectiveSource;
      if (source !== requestedSource) {
        await assertNoConflictingImport(db, uid, source);
      }
      parsed = parseImportRows(source, {
        moviesText: rawPayload.rawCsvV1,
        seriesText: rawPayload.rawCsvV2,
      });
    } else {
      parsed = parseTitlesImportPayload(source, rawPayload);
    }
    const { rows, errors } = parsed;
    // Stessa guardia della via su Storage (finalizeTitlesImportUpload): senza,
    // questa via creava l'import doc con totalRows 0 e lo portava fino a
    // "completed" senza importare niente — l'utente vedeva "fatto" e zero
    // titoli. Qui il doc non esiste ancora, quindi basta non crearlo: il
    // messaggio arriva al client come errore dell'avvio.
    if (rows.length === 0) {
      const firstReason = errors?.[0]?.reason ? ` (${errors[0].reason})` : "";
      throw new functions.https.HttpsError(
        "invalid-argument",
        `Non riesco a leggere voci utili nei file caricati${firstReason}. Controlla di aver scelto i file giusti dell'export.`
      );
    }
    if (rows.length > TITLES_IMPORT_MAX_ROWS) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        `Il file ha ${rows.length} righe, oltre il limite di ${TITLES_IMPORT_MAX_ROWS}.`
      );
    }

    const sourceDigest = sha256Hex(JSON.stringify({ source, payloadFields }));
    const importRef = db.collection("users").doc(uid).collection("imports").doc();
    const importId = importRef.id;
    const now = admin.firestore.FieldValue.serverTimestamp();

    const payloadRef = importRef.collection("payload").doc("raw");
    const batch = db.batch();
    batch.set(payloadRef, {
      ...payloadFields,
      source,
      ...(sourceAudit ? {
        requestedSource,
        detectedSource: sourceAudit.detectedFormat,
        sourceAutoDetected: sourceAudit.autoDetected,
        sourceDetectedAt: now,
      } : {}),
      sourceDigest,
      createdAt: now,
      expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 24 * 60 * 60 * 1000)),
    });
    batch.set(importRef, {
      source,
      ...(sourceAudit ? {
        requestedSource,
        detectedSource: sourceAudit.detectedFormat,
        sourceAutoDetected: sourceAudit.autoDetected,
        sourceDetectedAt: now,
      } : {}),
      platform,
      sourceDigest,
      dryRun,
      status: "queued",
      totalRows: rows.length,
      processedCount: 0,
      matchCursor: 0,
      tickCount: 0,
      matchedCount: 0,
      unresolvedCount: 0,
      errorCount: errors.length,
      titleStateIdsWritten: [],
      importOptions,
      createdAt: now,
      updatedAt: now,
      startedBy: uid,
    });
    await batch.commit();

    // Best-effort admin heads-up for monitoring the TV Time/Netflix import
    // wave — never blocks or fails the import itself (see
    // notifyAdminsImportStarted's own try/catch in notifications.js).
    // dryRun previews (used by the client to sanity-check a file before
    // committing) are NOT a real import event, so admins aren't notified.
    if (!dryRun) {
      notifyAdminsImportStarted({
        fromUid: uid,
        fromName: await getDisplayNameForNotify(db, uid),
        source,
        totalRows: rows.length,
        importUid: uid,
        importId,
      }).catch((err) => {
        logger.warn("[titlesImport] notifyAdminsImportStarted (startTitlesImport) failed", {
          uid,
          importId,
          message: safeString(err?.message || String(err), 200),
        });
      });
    }

    return {
      ok: true,
      importId,
      status: "queued",
      totalRows: rows.length,
      matchedCount: 0,
      unresolvedCount: 0,
      errorCount: errors.length,
      dryRun,
      importOptions,
      source,
      sourceAutoDetected: Boolean(sourceAudit?.autoDetected),
    };
  });

// Shared publisher for reviewed TV Time episode comments, used by the admin
// callable AND the ops script (functions/scripts/publish-import-comments.js).
// Reads candidate docs (importCommentReview/{uid}__{importId}/comments), selects
// the ones cleared for publish, writes each as a Somto episode-thread message
// ON BEHALF OF the importing user, and marks them published. Idempotent:
// deterministic message ids + a `published` guard mean a re-run never
// duplicates. One bad candidate never aborts the batch.
//
// Selection: a candidate must be RESOLVED (titleId), NOT already published, NOT
// rejected. `approveAll` publishes every remaining pending one; an explicit
// `onlyIds` set publishes just those; otherwise only status=="approved".
async function publishImportCommentsForImport({ db, uid, importId, approveAll = false, onlyIds = null, dryRun = false }) {
  const reviewRoot = db.collection("importCommentReview").doc(`${uid}__${importId}`);
  const snap = await reviewRoot.collection("comments").get();
  const displayName = await getDisplayNameForNotify(db, uid);

  const plan = {
    candidates: snap.size, selected: 0, published: 0, threads: 0,
    skippedUnresolved: 0, skippedAlreadyPublished: 0, skippedNotApproved: 0, skippedRejected: 0,
  };

  const selected = [];
  snap.forEach((doc) => {
    const c = doc.data() || {};
    if (onlyIds && !onlyIds.has(doc.id)) return;
    if (c.published === true) { plan.skippedAlreadyPublished += 1; return; }
    if (c.status === "rejected") { plan.skippedRejected += 1; return; }
    if (!c.titleId) { plan.skippedUnresolved += 1; return; }
    const season = Number(c.season), episode = Number(c.episode);
    if (!(season > 0 && episode > 0)) { plan.skippedUnresolved += 1; return; }
    if (!approveAll && !onlyIds && c.status !== "approved") { plan.skippedNotApproved += 1; return; }
    selected.push({ id: doc.id, ...c, season, episode });
  });
  plan.selected = selected.length;
  if (dryRun || !selected.length) return plan;

  // Group by episode thread so each thread is created once and its lastMessage
  // reflects the newest published comment in it.
  const threadOps = new Map(); // threadId -> { titleId, season, episode, messages:[] }
  for (const c of selected) {
    const threadId = `public_${c.titleId}_s${c.season}e${c.episode}`;
    const msgId = episodeCommentMessageId({ uid, titleId: c.titleId, season: c.season, episode: c.episode, commentId: c.sourceCommentId });
    const msg = buildThreadMessage({ uid, displayName, candidate: c });
    const createdAtDate = c.originalCreatedAt && typeof c.originalCreatedAt.toDate === "function"
      ? c.originalCreatedAt.toDate()
      : (c.originalCreatedAt instanceof Date ? c.originalCreatedAt : null);
    let entry = threadOps.get(threadId);
    if (!entry) { entry = { titleId: c.titleId, season: c.season, episode: c.episode, messages: [] }; threadOps.set(threadId, entry); }
    entry.messages.push({ candidateId: c.id, msgId, msg, createdAtDate });
  }

  const nowServer = admin.firestore.FieldValue.serverTimestamp();
  // Unknown source dates must remain historical. Using "now" would make an
  // imported comment indistinguishable from a native one to notification
  // triggers and could fan out a false "new comment" burst.
  const unknownImportDate = admin.firestore.Timestamp.fromMillis(Date.UTC(2000, 0, 1));
  const writeFns = [];
  for (const [threadId, entry] of threadOps) {
    const threadRef = db.collection("threads").doc(threadId);
    // eslint-disable-next-line no-await-in-loop
    const threadSnap = await threadRef.get().catch(() => null);
    if (!threadSnap || !threadSnap.exists) {
      // Create the public episode thread with the SAME shape ensurePublicThread
      // (threads.api.js) uses — keeps client reads/rules happy. createdBy = the
      // importing user (they authored the discussion).
      writeFns.push((batch) => batch.set(threadRef, {
        titleId: entry.titleId,
        visibility: "public",
        contextType: "public",
        contextId: `s${entry.season}e${entry.episode}`,
        participants: [],
        groupName: "Discussione episodio",
        createdBy: uid,
        createdAt: nowServer,
        lastMessageAt: null,
        lastMessagePreview: "",
        lastSenderUid: null,
        lastMessageId: null,
      }, { merge: true }));
    }
    plan.threads += 1;

    let newest = null;
    for (const m of entry.messages) {
      const createdAt = m.createdAtDate ? admin.firestore.Timestamp.fromDate(m.createdAtDate) : unknownImportDate;
      const msgRef = threadRef.collection("messages").doc(m.msgId);
      writeFns.push((batch) => batch.set(msgRef, { ...m.msg, createdAt }, { merge: true }));
      const candRef = reviewRoot.collection("comments").doc(m.candidateId);
      writeFns.push((batch) => batch.set(candRef, {
        published: true, publishedMessageId: m.msgId, publishedThreadId: threadId,
        status: "approved", updatedAt: nowServer,
      }, { merge: true }));
      plan.published += 1;
      const ms = m.createdAtDate ? m.createdAtDate.getTime() : unknownImportDate.toMillis();
      if (!newest || ms >= newest.ms) newest = { ms, m, createdAt };
    }
    // Only advance the thread's lastMessage pointer if the imported comment is
    // NEWER than whatever is already there — a historical comment must never
    // regress the preview of a thread that already has fresher real messages.
    const existingLastMs = (threadSnap && threadSnap.exists && threadSnap.data()?.lastMessageAt && typeof threadSnap.data().lastMessageAt.toMillis === "function")
      ? threadSnap.data().lastMessageAt.toMillis()
      : 0;
    if (newest && newest.ms > existingLastMs) {
      writeFns.push((batch) => batch.set(threadRef, {
        lastMessageId: newest.m.msgId,
        lastMessageAt: newest.createdAt,
        lastMessagePreview: String(newest.m.msg.text || "").slice(0, 100),
        lastSenderUid: uid,
      }, { merge: true }));
    }
  }

  await commitInChunks(db, writeFns);
  await reviewRoot.set({
    published: admin.firestore.FieldValue.increment(plan.published),
    status: "published",
    updatedAt: nowServer,
  }, { merge: true }).catch(() => {});
  return plan;
}

// Admin-only: publish reviewed TV Time episode comments as episode-thread
// messages. See publishImportCommentsForImport for selection/idempotency.
exports.publishImportComments = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 300, memory: "512MB" })
  .https.onCall(async (data, context) => {
    const callerUid = context.auth?.uid || null;
    if (!callerUid) throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
    const db = admin.firestore();
    if (!(await isAdminCaller(db, callerUid))) {
      throw new functions.https.HttpsError("permission-denied", "Solo gli admin possono pubblicare i commenti importati.");
    }
    const uid = toId(data?.uid);
    const importId = toId(data?.importId);
    if (!uid || !importId) throw new functions.https.HttpsError("invalid-argument", "uid e importId richiesti.");
    const onlyIds = Array.isArray(data?.commentIds)
      ? new Set(data.commentIds.map((v) => String(v || "").trim()).filter(Boolean))
      : null;
    const result = await publishImportCommentsForImport({
      db, uid, importId,
      approveAll: Boolean(data?.approveAll),
      onlyIds,
      dryRun: Boolean(data?.dryRun),
    });
    return { ok: true, ...result };
  });

// Admin-only: segna/dis-segna candidati della coda commenti import come
// "scartati" (status: rejected). Un candidato scartato non viene MAI
// pubblicato: publishImportCommentsForImport e lo script ops lo saltano già
// (skippedRejected) — questo callable è il primo writer di quello stato.
// Non tocca i thread; i candidati già pubblicati non sono scartabili da qui.
// La collection è deny-all per i client (rules), quindi si passa di qua.
exports.reviewImportComments = functions
  .region("europe-west1")
  .https.onCall(async (data, context) => {
    const callerUid = context.auth?.uid || null;
    if (!callerUid) throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
    const db = admin.firestore();
    if (!(await isAdminCaller(db, callerUid))) {
      throw new functions.https.HttpsError("permission-denied", "Solo gli admin possono rivedere i commenti importati.");
    }
    const uid = toId(data?.uid);
    const importId = toId(data?.importId);
    if (!uid || !importId) throw new functions.https.HttpsError("invalid-argument", "uid e importId richiesti.");
    const action = String(data?.action || "").trim();
    if (action !== "reject" && action !== "unreject") {
      throw new functions.https.HttpsError("invalid-argument", "action deve essere reject o unreject.");
    }
    const ids = Array.isArray(data?.commentIds)
      ? [...new Set(data.commentIds.map((v) => String(v || "").trim()).filter(Boolean))]
      : [];
    if (!ids.length || ids.length > 500) {
      throw new functions.https.HttpsError("invalid-argument", "commentIds richiesti (max 500).");
    }

    const reviewRoot = db.collection("importCommentReview").doc(`${uid}__${importId}`);
    const commentsCol = reviewRoot.collection("comments");
    const snaps = await db.getAll(...ids.map((id) => commentsCol.doc(id)));

    const nowServer = admin.firestore.FieldValue.serverTimestamp();
    const outcome = { updated: 0, skippedPublished: 0, skippedMissing: 0, skippedNoop: 0 };
    const writeFns = [];
    for (const snap of snaps) {
      if (!snap.exists) { outcome.skippedMissing += 1; continue; }
      const c = snap.data() || {};
      if (c.published === true) { outcome.skippedPublished += 1; continue; }
      if (action === "reject") {
        if (c.status === "rejected") { outcome.skippedNoop += 1; continue; }
        writeFns.push((batch) => batch.set(snap.ref, { status: "rejected", updatedAt: nowServer }, { merge: true }));
      } else {
        if (c.status !== "rejected") { outcome.skippedNoop += 1; continue; }
        writeFns.push((batch) => batch.set(snap.ref, { status: "pending", updatedAt: nowServer }, { merge: true }));
      }
      outcome.updated += 1;
    }
    if (writeFns.length) await commitInChunks(db, writeFns);

    // Ricontai ESATTI post-scrittura (niente increment che possono driftare):
    // `rejected` totale per la pill, `rejectedResolved` (scartati che
    // sarebbero pubblicabili) per il conteggio "da pubblicare" in console
    // (resolved - published - rejectedResolved).
    const rejSnap = await commentsCol.where("status", "==", "rejected").get();
    let rejected = 0;
    let rejectedResolved = 0;
    rejSnap.forEach((doc) => {
      const c = doc.data() || {};
      rejected += 1;
      const season = Number(c.season);
      const episode = Number(c.episode);
      if (c.titleId && season > 0 && episode > 0 && c.published !== true) rejectedResolved += 1;
    });
    await reviewRoot.set({ rejected, rejectedResolved, updatedAt: nowServer }, { merge: true }).catch(() => {});
    return { ok: true, ...outcome, rejected, rejectedResolved };
  });

/* ============================= Trakt.tv OAuth + import ============================= */

// Reads the Trakt OAuth client credentials from env at CALL time (never at
// require time). Throws a failed-precondition the client can surface if the
// deploy is missing them, rather than silently 500ing.
function getTraktCredentials() {
  const clientId = process.env.TRAKT_CLIENT_ID || "";
  const clientSecret = process.env.TRAKT_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) {
    throw new functions.https.HttpsError("failed-precondition", "Trakt non configurato.");
  }
  return { clientId, clientSecret };
}

// Token doc ref: usersPrivate/{uid}/integrations/trakt. Written ONLY here
// (admin SDK) — firestore.rules deny all client read/write on this
// subcollection (OAuth tokens are secrets).
function traktIntegrationRef(db, uid) {
  return db.collection("usersPrivate").doc(uid).collection("integrations").doc("trakt");
}

// Step 1 of the OAuth device flow. Requests a device+user code from Trakt,
// stores the (secret) device_code server-side, and returns ONLY the
// client-safe fields (user code + verification URL + polling cadence). NEVER
// returns device_code.
exports.startTraktConnect = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 30, memory: "256MB" })
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid || null;
    if (!uid) {
      throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
    }

    const db = admin.firestore();
    await enforceCallableRateLimit(db, uid, "startTraktConnect", {
      windowSeconds: 30,
      maxInWindow: 2,
      dailyMax: 20,
    });

    const { clientId } = getTraktCredentials();

    let device;
    try {
      device = await traktRequestDeviceCode({ clientId });
    } catch (err) {
      logger.warn("[trakt] requestDeviceCode failed", { uid, message: safeString(err?.message || String(err), 200) });
      throw new functions.https.HttpsError("unavailable", "Trakt non raggiungibile, riprova.");
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    await traktIntegrationRef(db, uid).set({
      status: "pending",
      deviceCode: device.device_code, // secret — never returned to the client
      interval: device.interval,
      expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + device.expires_in * 1000)),
      createdAt: now,
      updatedAt: now,
    }, { merge: true });

    return {
      userCode: device.user_code,
      verificationUrl: device.verification_url,
      interval: device.interval,
      expiresIn: device.expires_in,
    };
  });

// Step 2 of the OAuth device flow. The client polls this every `interval`s
// until it stops returning "pending". On authorization, persists the tokens
// server-side (secret) and drops the device_code. NEVER returns any token.
exports.pollTraktConnect = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 30, memory: "256MB" })
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid || null;
    if (!uid) {
      throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
    }

    const db = admin.firestore();
    const ref = traktIntegrationRef(db, uid);
    const snap = await ref.get();
    if (!snap.exists) return { status: "none" };
    const doc = snap.data() || {};
    if (doc.status === "connected") return { status: "connected" };
    if (doc.status !== "pending" || !doc.deviceCode) return { status: "none" };

    const expiresAtMs = doc.expiresAt?.toMillis ? doc.expiresAt.toMillis() : 0;
    if (expiresAtMs && Date.now() > expiresAtMs) {
      await ref.set({ status: "expired", updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return { status: "expired" };
    }

    const { clientId, clientSecret } = getTraktCredentials();
    let result;
    try {
      result = await traktPollDeviceToken({ clientId, clientSecret, deviceCode: doc.deviceCode });
    } catch (err) {
      logger.warn("[trakt] pollDeviceToken failed", { uid, message: safeString(err?.message || String(err), 200) });
      return { status: "pending" }; // transient — let the client keep polling
    }

    if (result.status === "authorized") {
      const t = result.tokens;
      const now = admin.firestore.FieldValue.serverTimestamp();
      await ref.set({
        status: "connected",
        accessToken: t.accessToken,
        refreshToken: t.refreshToken,
        tokenType: t.tokenType,
        scope: t.scope,
        expiresAt: admin.firestore.Timestamp.fromDate(new Date(t.expiresAtSeconds * 1000)),
        connectedAt: now,
        updatedAt: now,
        deviceCode: admin.firestore.FieldValue.delete(),
      }, { merge: true });
      return { status: "connected" };
    }
    if (result.status === "expired") {
      await ref.set({ status: "expired", updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return { status: "expired" };
    }
    if (result.status === "denied") {
      await ref.set({ status: "denied", updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return { status: "denied" };
    }
    return { status: "pending" };
  });

// Runs the one-shot Trakt import: fetch the full sync library, compact it to a
// blob, upload the blob to Storage, and create a "queued" import doc — which
// processQueuedTitlesImport picks up and hands to the resumable tick worker
// (same pipeline as every other source). NEVER returns tokens.
exports.startTraktImport = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 120, memory: "512MB" })
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid || null;
    if (!uid) {
      throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
    }

    const db = admin.firestore();
    await enforceCallableRateLimit(db, uid, "startTraktImport", {
      windowSeconds: 60,
      maxInWindow: 1,
      dailyMax: 3,
    });
    await assertNoConflictingImport(db, uid, "trakt");

    const { clientId, clientSecret } = getTraktCredentials();
    const ref = traktIntegrationRef(db, uid);
    const snap = await ref.get();
    const doc = snap.exists ? (snap.data() || {}) : {};
    if (doc.status !== "connected" || !doc.accessToken) {
      throw new functions.https.HttpsError("failed-precondition", "Collega prima Trakt.");
    }

    // Refresh the access token if it's expired or about to (within 5 min).
    let accessToken = doc.accessToken;
    const expiresAtMs = doc.expiresAt?.toMillis ? doc.expiresAt.toMillis() : 0;
    if (expiresAtMs && Date.now() >= expiresAtMs - 5 * 60 * 1000 && doc.refreshToken) {
      try {
        const t = await traktRefreshAccessToken({ clientId, clientSecret, refreshToken: doc.refreshToken });
        accessToken = t.accessToken;
        await ref.set({
          accessToken: t.accessToken,
          refreshToken: t.refreshToken,
          tokenType: t.tokenType,
          scope: t.scope,
          expiresAt: admin.firestore.Timestamp.fromDate(new Date(t.expiresAtSeconds * 1000)),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      } catch (err) {
        logger.warn("[trakt] token refresh failed", { uid, message: safeString(err?.message || String(err), 200) });
        throw new functions.https.HttpsError("failed-precondition", "Sessione Trakt scaduta, ricollega Trakt.");
      }
    }

    let library;
    try {
      library = await fetchTraktLibrary({ clientId, token: accessToken });
    } catch (err) {
      logger.warn("[trakt] fetchTraktLibrary failed", { uid, message: safeString(err?.message || String(err), 200) });
      throw new functions.https.HttpsError("unavailable", "Impossibile leggere la libreria Trakt, riprova.");
    }

    const blob = buildTraktImportBlob(library);
    const { rows } = parseTraktBlob(blob);
    if (rows.length > TITLES_IMPORT_MAX_ROWS) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        `La tua libreria Trakt ha ${rows.length} righe, oltre il limite di ${TITLES_IMPORT_MAX_ROWS}.`
      );
    }
    if (rows.length === 0) {
      throw new functions.https.HttpsError("failed-precondition", "Nessun dato da importare da Trakt.");
    }

    const dryRun = Boolean(data?.dryRun);
    const importOptions = normalizeTitlesImportOptions(data?.options || data?.importOptions || {});
    const platform = normalizeImportPlatform(data?.platform);
    const importRef = db.collection("users").doc(uid).collection("imports").doc();
    const importId = importRef.id;
    const blobJson = JSON.stringify(blob);
    const storagePath = `supportImports/${uid}/trakt-${importId}.json`;

    // Admin-SDK write to Storage bypasses storage.rules (no rules change
    // needed); supportImports/ has a 14d GCS lifecycle TTL.
    const bucket = admin.storage().bucket();
    await bucket.file(storagePath).save(blobJson, {
      contentType: "application/json",
      resumable: false,
      metadata: { cacheControl: "no-store" },
    });

    const now = admin.firestore.FieldValue.serverTimestamp();
    const sourceDigest = sha256Hex(blobJson);
    const expiresAt = admin.firestore.Timestamp.fromDate(new Date(Date.now() + 24 * 60 * 60 * 1000));

    const batch = db.batch();
    batch.set(importRef.collection("payload").doc("raw"), {
      source: "trakt",
      storageBucket: bucket.name,
      storagePaths: { trakt: storagePath },
      sourceDigest,
      createdAt: now,
      expiresAt,
    });
    batch.set(importRef, {
      source: "trakt",
      platform,
      sourceDigest,
      dryRun,
      status: "queued",
      totalRows: rows.length,
      processedCount: 0,
      matchCursor: 0,
      tickCount: 0,
      matchedCount: 0,
      unresolvedCount: 0,
      errorCount: 0,
      titleStateIdsWritten: [],
      storagePaths: { trakt: storagePath },
      importOptions,
      createdAt: now,
      updatedAt: now,
      startedBy: uid,
    });
    await batch.commit();

    if (!dryRun) {
      notifyAdminsImportStarted({
        fromUid: uid,
        fromName: await getDisplayNameForNotify(db, uid),
        source: "trakt",
        totalRows: rows.length,
        importUid: uid,
        importId,
      }).catch((err) => {
        logger.warn("[titlesImport] notifyAdminsImportStarted (startTraktImport) failed", {
          uid, importId, message: safeString(err?.message || String(err), 200),
        });
      });
    }

    return {
      ok: true,
      importId,
      status: "queued",
      totalRows: rows.length,
      matchedCount: 0,
      unresolvedCount: 0,
      errorCount: 0,
      dryRun,
      importOptions,
    };
  });

// Disconnects Trakt: revokes the token on Trakt's side (best-effort) and
// deletes the local token doc. Returns { ok:true } even if the revoke call
// fails (the local doc is gone either way, which is what matters for us).
exports.disconnectTrakt = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 30, memory: "256MB" })
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid || null;
    if (!uid) {
      throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
    }

    const db = admin.firestore();
    await enforceCallableRateLimit(db, uid, "disconnectTrakt", {
      windowSeconds: 30,
      maxInWindow: 3,
      dailyMax: 30,
    });

    const ref = traktIntegrationRef(db, uid);
    const snap = await ref.get();
    if (snap.exists) {
      const doc = snap.data() || {};
      if (doc.accessToken) {
        const clientId = process.env.TRAKT_CLIENT_ID || "";
        const clientSecret = process.env.TRAKT_CLIENT_SECRET || "";
        if (clientId && clientSecret) {
          await traktRevokeToken({ clientId, clientSecret, token: doc.accessToken });
        }
      }
      await ref.delete().catch(() => {});
    }
    return { ok: true };
  });

// Kicks off matching for a callable-body import (startTitlesImport): enqueues
// the FIRST matching tick. It does NOT do the matching itself — that's the
// resumable tick worker's job (runImportMatchTick), so a huge library isn't
// bound to this single 540s invocation. onCreate is at-least-once, so guard
// with a transaction that only enqueues once (firstTickEnqueued).
exports.processQueuedTitlesImport = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 60, memory: "256MB" })
  .firestore
  .document("users/{uid}/imports/{importId}")
  .onCreate(async (snap, context) => {
    const db = admin.firestore();
    const importRef = snap.ref;
    const uid = context.params.uid;
    const importId = context.params.importId;

    // The Storage-upload transport creates its import doc in status
    // "uploading" and enqueues its own first tick from finalizeTitlesImportUpload
    // — don't double-fire for those. Only the callable-body transport
    // (startTitlesImport) creates the doc already in "queued".
    let shouldEnqueue = false;
    try {
      shouldEnqueue = await db.runTransaction(async (tx) => {
        const current = await tx.get(importRef);
        if (!current.exists) return false;
        const data = current.data() || {};
        if (data.status !== "queued") return false; // uploading / already processing / redelivery
        if (data.firstTickEnqueued === true) return false;
        tx.set(importRef, {
          firstTickEnqueued: true,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        return true;
      });
    } catch (err) {
      logger.error("[titlesImport] first-tick claim transaction failed", {
        uid, importId, message: safeString(err?.message || String(err), 300),
      });
      return null;
    }

    if (!shouldEnqueue) return null;

    await createImportMatchTick(db, uid, importId, 0).catch((err) => {
      logger.error("[titlesImport] failed to enqueue first tick (queued)", {
        uid, importId, message: safeString(err?.message || String(err), 200),
      });
    });
    return null;
  });

// The resumable matcher. Each `importMatchTicks/{tickId}` doc (created by
// createImportMatchTick) fires exactly one run. A run claims the import at its
// cursor position, matches a bounded window (processImportMatchTick), then
// chains a successor tick until done. Claim invariants make it safe under
// at-least-once delivery AND concurrent duplicates: only proceed if the import
// is still queued/matching AND its matchCursor equals this tick's cursor — a
// stale/duplicate tick (cursor already advanced) is a no-op.
exports.runImportMatchTick = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 540, memory: "1GB" })
  .firestore
  .document("importMatchTicks/{tickId}")
  .onCreate(async (snap, context) => {
    const db = admin.firestore();
    const tickRef = snap.ref;
    const tick = snap.data() || {};
    const uid = toId(tick.uid);
    const importId = toId(tick.importId);
    const cursor = Number.isFinite(tick.cursor) ? Number(tick.cursor) : 0;
    // "match" (rows) vs "enrich" (distinct titles) phase — claimed against a
    // different cursor field and dispatched to a different worker.
    const phase = tick.phase === "enrich" ? "enrich" : "match";

    if (!uid || !importId) {
      await tickRef.delete().catch(() => {});
      return null;
    }
    const importRef = db.collection("users").doc(uid).collection("imports").doc(importId);

    let claimed = null;
    try {
      claimed = await db.runTransaction(async (tx) => {
        const current = await tx.get(importRef);
        if (!current.exists) return null;
        const data = current.data() || {};
        // Accept the statuses valid for each phase. Matching runs while
        // queued/matching; enrichment runs while enriching (and tolerates a
        // stale "matching" from the transition write, before the enrich phase's
        // first status flip has landed).
        const validStatus = phase === "enrich"
          ? (data.status === "enriching" || data.status === "matching")
          : (data.status === "queued" || data.status === "matching");
        if (!validStatus) return null; // terminal / failed / wrong phase
        // Stale duplicate tick: the phase's cursor must equal this tick's.
        const currentCursor = phase === "enrich"
          ? Number(data.enrichCursor || 0)
          : Number(data.matchCursor || 0);
        if (currentCursor !== cursor) return null;
        const tickCount = Number(data.tickCount || 0) + 1;
        if (tickCount > IMPORT_MAX_TICKS) {
          tx.set(importRef, {
            status: "failed",
            error: "Troppi cicli di matching (limite di sicurezza).",
            failureReason: "Troppi cicli di matching (limite di sicurezza).",
            errorCount: importFailureErrorCount([], data.errorCount),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
          return null;
        }
        tx.set(importRef, {
          status: phase === "enrich" ? "enriching" : "matching",
          tickCount,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        return data;
      });
    } catch (err) {
      logger.error("[titlesImport] tick claim transaction failed", {
        uid, importId, cursor, phase, message: safeString(err?.message || String(err), 300),
      });
      // Leave the tick doc in place — a transient claim failure can be retried
      // by reviveStalledTitlesImports (delete-then-recreate at the cursor).
      return null;
    }

    if (!claimed) {
      await tickRef.delete().catch(() => {});
      return null;
    }

    try {
      if (phase === "enrich") {
        await processImportEnrichTick({ db, uid, importId, importRef, importData: claimed, cursor });
      } else {
        await processImportMatchTick({ db, uid, importId, importRef, importData: claimed, cursor });
      }
    } catch (err) {
      // A thrown tick leaves status matching/enriching with a stale updatedAt;
      // the watchdog re-arms it from the persisted cursor. Do NOT mark failed
      // here (the error may be transient — a title fetch, a Storage blip).
      logger.error("[titlesImport] tick processing failed", {
        uid,
        importId,
        cursor,
        phase,
        errorMessage: safeString(err?.message || String(err), 500),
        errorStack: safeString(err?.stack || "", 2000),
      });
    } finally {
      await tickRef.delete().catch(() => {});
    }
    return null;
  });

// User-initiated recovery of a stuck import WITHOUT a re-upload. The raw
// payload is retained (inline in payload/raw for netflix/gdpr, on Storage for
// the upload-session sources) until an import SUCCEEDS (payloadRef.delete runs
// only on completed/awaiting_confirmation) — so a "failed" or orphaned
// "uploading" import can always be re-processed from the file we already hold.
// Re-upload is the correct action ONLY when that payload is physically gone
// (upload interrupted before any file landed, or TTL-expired) — signalled back
// as { needsReupload: true } so the client can prompt for the file instead of
// dead-ending to a blank picker (the #1 driver of duplicate imports / read
// cost: every re-upload re-runs the full TMDB match and re-creates stub
// titles). Mirrors the auto-kick in reviveStalledTitlesImports, but on demand.
exports.retryTitlesImport = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 60, memory: "256MB" })
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid || null;
    if (!uid) {
      throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
    }
    const db = admin.firestore();
    await enforceCallableRateLimit(db, uid, "retryTitlesImport", {
      windowSeconds: 60,
      maxInWindow: 3,
      dailyMax: 20,
    });

    const importId = toId(data?.importId);
    if (!importId) {
      throw new functions.https.HttpsError("invalid-argument", "importId mancante.");
    }

    const importRef = db.collection("users").doc(uid).collection("imports").doc(importId);
    const importSnap = await importRef.get();
    if (!importSnap.exists) {
      throw new functions.https.HttpsError("not-found", "Import non trovato.");
    }
    const importData = importSnap.data() || {};
    if (importData.startedBy && importData.startedBy !== uid) {
      throw new functions.https.HttpsError("permission-denied", "Import non tuo.");
    }

    const status = String(importData.status || "");
    // An in-flight import is already handled by its tick chain / the watchdog;
    // a completed / awaiting_confirmation one has nothing to re-process (its
    // payload was deleted on success). Only failed / orphaned-uploading imports
    // are re-runnable — everything else is a no-op that returns current state.
    const RETRIABLE = new Set(["failed", "uploading"]);
    if (!RETRIABLE.has(status)) {
      return { ok: true, importId, status, reprocessed: false };
    }

    // Confirm the file is physically still here BEFORE promising a re-process.
    const bucket = admin.storage().bucket();
    const loaded = await loadImportRawPayload(bucket, importRef).catch(() => null);
    const hasCore = Boolean(loaded && (
      (loaded.moviesText && loaded.moviesText.trim())
      || (loaded.seriesText && loaded.seriesText.trim())
      || (loaded.netflixText && loaded.netflixText.trim())
      || (loaded.traktJson && loaded.traktJson.trim())
    ));
    if (!hasCore) {
      // The one legitimate re-upload case: we do not have the file anymore.
      return { ok: false, importId, needsReupload: true };
    }

    // Re-arm from cursor 0 exactly like reviveStalledTitlesImports' auto-kick:
    // the tick worker re-parses the payload and re-matches idempotently
    // (composite titleState ids + no-op aggregate guards), so replaying from 0
    // never double-writes.
    const now = admin.firestore.FieldValue.serverTimestamp();
    await importRef.set({
      status: "queued",
      matchCursor: 0,
      tickCount: 0,
      errorCount: 0,
      error: admin.firestore.FieldValue.delete(),
      failureReason: admin.firestore.FieldValue.delete(),
      startedProcessingAt: now,
      updatedAt: now,
      retriedBy: "retryTitlesImport",
      retryCount: admin.firestore.FieldValue.increment(1),
    }, { merge: true });

    const tickRef = db.collection("importMatchTicks").doc(`${importId}_0`);
    await tickRef.delete().catch(() => {});
    await createImportMatchTick(db, uid, importId, 0).catch((err) => {
      logger.error("[titlesImport] retry: enqueue first tick failed", {
        uid, importId, message: safeString(err?.message || String(err), 200),
      });
      // Leave status "queued" — reviveStalledTitlesImports will re-arm it.
    });

    return { ok: true, importId, status: "queued", reprocessed: true };
  });

// Watchdog: re-arms imports stuck in "matching"/"enriching" whose chain broke
// (a tick that crashed/OOMed before persisting its window or enqueuing a
// successor). Finds stale ones and recreates the RIGHT phase tick at the current
// cursor (delete-then-create so onCreate fires even if a lingering tick doc
// exists). Cheap and bounded.
//
// ALSO covers "uploading": that state is client-driven (the browser tab runs
// uploadTitlesImportFiles, a Promise.all of parallel Storage uploads, then
// calls finalizeTitlesImportUpload) with NO server-side chain to re-arm — if
// the tab backgrounds/stalls mid-upload, one file of N never lands, finalize
// is never called, and the doc sits at "uploading" forever with nothing
// processed (silently: no error, no notification). Mirrors the manual rescue
// script scripts/kick-stuck-import.js. Two outcomes: core file(s) present on
// Storage → auto-kick into "queued" + first tick, same as a normal finalize;
// nothing usable after IMPORT_UPLOAD_ABANDON_MS → mark "failed" (notifies the
// user) so it stops masquerading as active in getActiveImport's resume UI.
exports.reviveStalledTitlesImports = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 120, memory: "256MB" })
  .pubsub.schedule("every 10 minutes")
  .onRun(async () => {
    const db = admin.firestore();
    const cutoff = admin.firestore.Timestamp.fromDate(new Date(Date.now() - IMPORT_STALL_REVIVE_MS));
    // Also covers "queued" imports whose first-tick enqueue failed (the
    // enqueue is best-effort in startTitlesImport/finalizeTitlesImportUpload):
    // a genuinely queued import gets its tick within seconds, so only one
    // stuck past the stall cutoff is revived. "enriching" covers the second
    // phase whose chain broke the same way.
    const snap = await db.collectionGroup("imports")
      .where("status", "in", ["queued", "matching", "enriching"])
      .where("updatedAt", "<", cutoff)
      .limit(50)
      .get();
    // NB: no early `return null` when this snapshot is empty — the "uploading"
    // rescue/abandon block below is independent and MUST still run. An empty
    // snap.docs makes this loop a no-op and execution falls through. (Before,
    // an early return here meant stuck "uploading" imports were never handled
    // whenever no matching/enriching import happened to be stalled in the same
    // run — i.e. almost always → imports stuck in "uploading" forever, silently.)

    for (const doc of snap.docs) {
      const data = doc.data() || {};
      const uid = toId(data.startedBy) || toId(doc.ref.parent.parent?.id);
      const importId = doc.id;
      if (!uid || !importId) continue;
      // Re-arm the phase the import is actually in: an "enriching" import
      // resumes at enrichCursor with an enrich tick; everything else resumes
      // matching at matchCursor.
      const phase = data.status === "enriching" ? "enrich" : "match";
      const cursor = phase === "enrich" ? Number(data.enrichCursor || 0) : Number(data.matchCursor || 0);
      const tickId = phase === "enrich" ? `${importId}_enrich_${cursor}` : `${importId}_${cursor}`;
      const tickRef = db.collection("importMatchTicks").doc(tickId);
      try {
        // eslint-disable-next-line no-await-in-loop
        await tickRef.delete().catch(() => {});
        // eslint-disable-next-line no-await-in-loop
        await tickRef.set({
          uid,
          importId,
          cursor,
          phase,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          revived: true,
        });
        // Touch updatedAt so we don't re-revive it on the very next run before
        // the new tick has had a chance to claim.
        // eslint-disable-next-line no-await-in-loop
        await doc.ref.set({ updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        logger.info("[titlesImport] revived stalled import", { uid, importId, cursor, phase });
      } catch (err) {
        logger.warn("[titlesImport] revive failed", { uid, importId, cursor, phase, message: safeString(err?.message || String(err), 200) });
      }
    }

    const uploadingCutoff = admin.firestore.Timestamp.fromDate(new Date(Date.now() - IMPORT_STALL_REVIVE_MS));
    const uploadingSnap = await db.collectionGroup("imports")
      .where("status", "==", "uploading")
      .where("updatedAt", "<", uploadingCutoff)
      .limit(50)
      .get();

    if (!uploadingSnap.empty) {
      const bucket = admin.storage().bucket();
      for (const doc of uploadingSnap.docs) {
        const data = doc.data() || {};
        const uid = toId(data.startedBy) || toId(doc.ref.parent.parent?.id);
        const importId = doc.id;
        if (!uid || !importId) continue;
        const sp = data.storagePaths || {};
        const coreKeys = data.source === "netflix_csv" ? ["netflix"]
          : data.source === "trakt" ? ["trakt"]
          : ["movies", "series"];

        let hasCore = false;
        try {
          const checks = await Promise.all(
            coreKeys.map((k) => (sp[k] ? bucket.file(sp[k]).exists().then(([e]) => e) : Promise.resolve(false)))
          );
          hasCore = checks.some(Boolean);
        } catch (err) {
          logger.warn("[titlesImport] revive uploading: storage check failed", {
            uid, importId, message: safeString(err?.message || String(err), 200),
          });
          continue;
        }

        if (hasCore) {
          try {
            const sourceDigest = createHash("sha256")
              .update(JSON.stringify({ storagePaths: sp, rescuedAt: Date.now() }))
              .digest("hex");
            const now = admin.firestore.FieldValue.serverTimestamp();
            await doc.ref.collection("payload").doc("raw").set({
              source: data.source,
              sourceDigest,
              finalizedAt: now,
              updatedAt: now,
              rescuedBy: "reviveStalledTitlesImports",
            }, { merge: true });
            await doc.ref.set({
              sourceDigest,
              status: "queued",
              matchCursor: 0,
              tickCount: 0,
              startedProcessingAt: now,
              updatedAt: now,
              rescuedBy: "reviveStalledTitlesImports",
            }, { merge: true });
            const tickRef = db.collection("importMatchTicks").doc(`${importId}_0`);
            await tickRef.delete().catch(() => {});
            await tickRef.set({
              uid, importId, cursor: 0, phase: "match",
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              rescued: true,
            });
            logger.info("[titlesImport] auto-kicked stuck upload", { uid, importId, source: data.source });
          } catch (err) {
            logger.warn("[titlesImport] auto-kick failed", { uid, importId, message: safeString(err?.message || String(err), 200) });
          }
          continue;
        }

        // Nothing usable at all: only give up once genuinely abandoned. Uses
        // createdAt (not updatedAt) so a doc this same run just left alone
        // doesn't need a second cutoff to age past.
        const createdMs = data.createdAt?.toMillis ? data.createdAt.toMillis() : 0;
        if (createdMs && (Date.now() - createdMs) > IMPORT_UPLOAD_ABANDON_MS) {
          try {
            await doc.ref.set({
              status: "failed",
              failureReason: "upload_abandoned",
              error: "Upload abbandonato prima della finalizzazione.",
              errorCount: importFailureErrorCount([], data.errorCount),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
            await createTitlesImportNotification(db, uid, importId, "failed", {}, data.source).catch(() => {});
            logger.info("[titlesImport] marked abandoned upload as failed", { uid, importId, source: data.source });
          } catch (err) {
            logger.warn("[titlesImport] mark upload failed error", { uid, importId, message: safeString(err?.message || String(err), 200) });
          }
        }
      }
    }

    return null;
  });

// Controllo di salute degli import (settimanale, admin-facing).
//
// Lo `status` di un import non dice se e' andato bene: a luglio 2026 tre utenti
// avevano "completed" con zero dati, e li abbiamo scoperti solo perche' uno di
// loro ha scritto all'assistenza. Questa funzione cerca i sintomi veri sugli
// import degli ultimi 7 giorni e, se ne trova, manda UNA notifica agli admin.
// Silenziosa quando tutto e' a posto (nessuna notifica = nessun rumore).
//
// Volutamente NON controlla le stagioni sfasate: quel bug e' chiuso all'origine
// (writeTitleStates#seasonNumberingLooksCompatible) e il censimento costava
// migliaia di letture. Qui restano solo controlli su campi gia' presenti sul
// doc: costo ~1 query, indipendente dal numero di titoli.
const IMPORT_HEALTH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

exports.scanImportHealth = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 120, memory: "256MB" })
  .pubsub.schedule("every 168 hours")
  .onRun(async () => {
    const db = admin.firestore();
    const nowMs = Date.now();
    const cutoff = admin.firestore.Timestamp.fromMillis(nowMs - IMPORT_HEALTH_WINDOW_MS);

    let snap;
    try {
      snap = await db.collectionGroup("imports").where("createdAt", ">=", cutoff).limit(500).get();
    } catch (err) {
      logger.error("[importHealth] query fallita", { message: safeString(err?.message || String(err), 200) });
      return null;
    }

    const bad = [];
    for (const doc of snap.docs) {
      const data = doc.data() || {};
      const symptoms = diagnoseImportDoc(data, nowMs);
      if (!symptoms.length) continue;
      bad.push({
        uid: doc.ref.parent.parent?.id || "?",
        importId: doc.id,
        source: data.source || "?",
        status: data.status || "?",
        symptoms,
      });
    }

    logger.info("[importHealth] scansione completata", { scanned: snap.size, flagged: bad.length });
    if (!bad.length) return null;

    const adminUids = getAdminUids();
    if (!adminUids.length) return null;

    const preview = bad.slice(0, 5)
      .map((b) => `${b.importId} (${b.source}): ${b.symptoms.join(", ")}`)
      .join(" · ");
    const batch = db.batch();
    for (const adminUid of adminUids) {
      const ref = db.collection("users").doc(adminUid).collection("notifications").doc();
      batch.set(ref, {
        toUid: adminUid,
        fromUid: "system",
        type: "import_health_alert",
        data: {
          flagged: bad.length,
          scanned: snap.size,
          message: `${bad.length} import da controllare negli ultimi 7 giorni. ${preview}`,
          details: bad.slice(0, 20),
        },
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + NOTIFICATION_TTL_MS),
      });
    }
    await batch.commit();
    return null;
  });

// Storage trigger: un utente carica un export sulla pagina di assistenza
// (support-import.html -> supportImports/{uid}/...). Avvisa gli admin che c'e'
// un file da processare a mano (rescue import) con una notifica che linka alla
// chat di supporto dell'utente. Il bucket sta in US-CENTRAL1, quindi il trigger
// DEVE essere in us-central1 (altrimenti il deploy fallisce region-mismatch).
exports.notifyAdminsSupportUpload = functions
  .region("us-central1")
  .storage.bucket("gia-visto.firebasestorage.app")
  .object()
  .onFinalize(async (object) => {
    const name = String(object?.name || "");
    if (!name.startsWith("supportImports/")) return null;
    const uploaderUid = name.split("/")[1] || "";
    if (!uploaderUid) return null;
    try {
      const db = admin.firestore();
      const adminUids = getAdminUids();
      if (!adminUids.length) return null;
      let fromName = "Un utente";
      try {
        const u = (await db.collection("users").doc(uploaderUid).get()).data();
        if (u?.displayName) fromName = String(u.displayName);
      } catch (_) { /* best-effort name lookup */ }
      const fileName = name.split("/").pop() || "file";
      const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const batch = db.batch();
      for (const adminUid of adminUids) {
        if (adminUid === uploaderUid) continue; // don't self-notify
        const ref = db.collection("users").doc(adminUid).collection("notifications").doc();
        // Reuse the data-driven engagement_nudge type: fully wired for push
        // (title "Somto", body=data.message, link=data.ctaUrl) + web + iOS, so
        // no changes to notifications.js are needed. Admin-only recipient.
        batch.set(ref, {
          toUid: adminUid,
          fromUid: uploaderUid,
          type: "engagement_nudge",
          data: {
            message: `${fromName} ha caricato un file dalla pagina assistenza — da processare`,
            ctaUrl: `/thread.html?tid=support_${uploaderUid}`,
            userUid: uploaderUid,
            fileName,
          },
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          expiresAt,
        });
      }
      await batch.commit();
      logger.info("[supportUpload] admin notified", { uploaderUid, fileName, admins: adminUids.length });
    } catch (err) {
      logger.warn("[notifyAdminsSupportUpload] failed", { name, error: err?.message || String(err) });
    }
    return null;
  });

exports.confirmTitlesImport = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 300, memory: "512MB" })
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid || null;
    if (!uid) {
      throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
    }

    const db = admin.firestore();
    await enforceCallableRateLimit(db, uid, "confirmTitlesImport", {
      windowSeconds: 30,
      maxInWindow: 10,
      dailyMax: 50,
    });

    const importId = toId(data?.importId);
    if (!importId) {
      throw new functions.https.HttpsError("invalid-argument", "importId mancante.");
    }
    const resolutions = Array.isArray(data?.resolutions) ? data.resolutions : [];
    // Quick path ("Importa i titoli trovati" / "Salta tutti"): finish the import
    // by disposing of EVERY still-unresolved row server-side — the safe matches
    // are already in the library, so a leftover dubious row must never block
    // completion. Only a request that neither resolves nor finishes is invalid.
    const skipRemaining = data?.skipRemaining === true;
    if (resolutions.length === 0 && !skipRemaining) {
      throw new functions.https.HttpsError("invalid-argument", "Nessuna risoluzione fornita.");
    }
    if (resolutions.length > 500) {
      throw new functions.https.HttpsError("invalid-argument", "Troppe risoluzioni in una sola chiamata (max 500).");
    }

    const userRef = db.collection("users").doc(uid);
    const importRef = userRef.collection("imports").doc(importId);
    const importSnap = await importRef.get();
    if (!importSnap.exists) {
      throw new functions.https.HttpsError("not-found", "Import non trovato.");
    }
    const importData = importSnap.data() || {};
    if (importData.startedBy !== uid) {
      throw new functions.https.HttpsError("permission-denied", "Import di un altro account.");
    }
    const source = safeString(importData?.source || "", 40).trim().toLowerCase();

    // Idempotency / double-tap: a job that already completed has nothing left to
    // dispose of. Return its terminal summary WITHOUT re-importing — a second
    // "Importa i titoli trovati" tap must never double-write titleStates or
    // resurrect the confirmation screen.
    if (importData.status === "completed") {
      const existingIds = Array.isArray(importData.titleStateIdsWritten) ? importData.titleStateIdsWritten : [];
      return {
        ok: true,
        importId,
        status: "completed",
        resolvedCount: 0,
        importedTitleCount: existingIds.length,
        skippedCount: Number(importData.skippedCount || 0),
        unresolvedCount: 0,
        alreadyCompleted: true,
      };
    }
    // Only a job that is genuinely awaiting confirmation can be confirmed —
    // reject queued/matching/enriching/failed so a stray call can't corrupt a
    // job mid-pipeline.
    if (importData.status !== "awaiting_confirmation") {
      throw new functions.https.HttpsError("failed-precondition", "L'import non è ancora pronto per la conferma.");
    }

    const bucket = admin.storage().bucket();
    const logicalDupCache = new Map();
    const tmdbCtxState = {};
    const matchedRows = [];
    const itemWriteFns = [];
    let acceptSuggestionCount = 0;
    const MAX_SUGGESTION_ACCEPTS_PER_CALL = 300;

    // Shared write for a row we're importing (an explicit title pick OR an
    // accepted best-guess suggestion): record the resolution on the item and
    // queue the titleState write via the same buildImportTitleStateWrites path
    // finalize uses.
    const pushMatchedRow = (itemSnap, item, titleId, title, { confidence, strategy }) => {
      const row = {
        rawTitle: item.rawTitle,
        rawDate: item.rawDate,
        kind: item.kind,
        seriesNameGuess: item.seriesNameGuess,
        movieNameGuess: item.movieNameGuess,
        seasonNumber: item.seasonNumber,
        episodeNumber: item.episodeNumber,
        episodeNameGuess: item.episodeNameGuess,
        watchedDate: item.watchedDate?.toDate ? item.watchedDate.toDate() : new Date(),
      };
      matchedRows.push({ titleId, title, row });
      itemWriteFns.push((batch) => batch.set(itemSnap.ref, {
        resolved: true,
        skip: false,
        titleId,
        titleName: title.name || null,
        resolvedAsType: titleDocMediaType(title),
        confidence,
        strategy,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true }));
    };

    for (const resolution of resolutions) {
      const itemId = toId(resolution?.itemId);
      if (!itemId) continue;
      // eslint-disable-next-line no-await-in-loop
      const itemSnap = await importRef.collection("items").doc(itemId).get();
      if (!itemSnap.exists) continue;
      const item = itemSnap.data() || {};

      const decision = classifyImportResolution(resolution, item, {
        minConfidence: SUGGESTION_ACCEPT_MIN_CONFIDENCE,
      });

      if (decision.action === "skip") {
        itemWriteFns.push((batch) => batch.set(itemSnap.ref, {
          skip: true,
          resolved: false,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true }));
        continue;
      }

      if (decision.action === "accept_suggestion") {
        if (acceptSuggestionCount >= MAX_SUGGESTION_ACCEPTS_PER_CALL) {
          throw new functions.https.HttpsError("invalid-argument", "Troppi suggerimenti da accettare in una sola chiamata; riprova con meno voci.");
        }
        acceptSuggestionCount += 1;
        // Resolve the matcher's best guess deterministically by its tmdb id —
        // reuses the SAME stub-or-existing helper the auto-match cascade uses
        // (matchViaTmdbId), so no new title-creation surface is introduced. A
        // miss leaves the row untouched (skipRemaining can still dispose of it).
        // eslint-disable-next-line no-await-in-loop
        const match = await matchViaTmdbId(db, bucket, decision.tmdbId, decision.mediaType, {
          logicalDupCache, state: tmdbCtxState,
        }).catch((err) => {
          logger.warn("[titlesImport] confirm acceptSuggestion match failed", { message: safeString(err?.message || String(err), 200) });
          return null;
        });
        if (match?.titleId && match?.title) {
          pushMatchedRow(itemSnap, item, match.titleId, { id: match.titleId, ...match.title }, {
            confidence: Number(item.confidence || match.confidence || 0),
            strategy: "user_confirmed_suggestion",
          });
        }
        continue;
      }

      if (decision.action === "import_title") {
        // eslint-disable-next-line no-await-in-loop
        const titleSnap = await db.collection("titles").doc(decision.titleId).get();
        if (!titleSnap.exists) continue;
        const title = { id: decision.titleId, ...(titleSnap.data() || {}) };
        pushMatchedRow(itemSnap, item, decision.titleId, title, {
          confidence: 1,
          strategy: "user_confirmed",
        });
      }
      // decision.action === "ignore": no write — the row stays as it is.
    }

    // Snapshot is a hard precondition for state mutation. Capture it before
    // even persisting "resolved" item decisions so a snapshot failure leaves
    // the confirmation fully retryable and does not create half-confirmed rows.
    let confirmedCurrentStatesByTitleId = null;
    if (matchedRows.length > 0) {
      const uniqueTitleIds = Array.from(new Set(matchedRows.map((row) => row.titleId)));
      confirmedCurrentStatesByTitleId = new Map();
      for (let i = 0; i < uniqueTitleIds.length; i += 10) {
        const chunk = uniqueTitleIds.slice(i, i + 10);
        // eslint-disable-next-line no-await-in-loop
        const snaps = await Promise.all(chunk.map((id) => userRef.collection("titleStates").doc(id).get()));
        snaps.forEach((snap, idx) => {
          confirmedCurrentStatesByTitleId.set(chunk[idx], snap.exists ? snap.data() : null);
        });
      }
      await persistPreviousTitleStates({
        db,
        importRef,
        currentStatesByTitleId: confirmedCurrentStatesByTitleId,
        capturedAt: admin.firestore.FieldValue.serverTimestamp(),
        markerCapturedAt: importData?.previousStateSnapshot?.capturedAt || null,
        logger,
        logContext: { uid, importId, phase: "confirm" },
      });
    }

    // Persist the explicit item decisions FIRST so the skipRemaining sweep below
    // sees them as resolved/skipped and naturally excludes them.
    await commitInChunks(db, itemWriteFns);

    // Quick-finish sweep: repeatedly grab a page of rows still unresolved and
    // un-skipped and mark them skipped. Committed rows drop out of the filter,
    // so the same query walks the whole leftover set without a cursor — one
    // server-driven pass finishes a job with thousands of leftovers. The
    // iteration cap is a runaway backstop far above the real max (~1.4k rows).
    if (skipRemaining) {
      const SWEEP_PAGE = 400;
      const MAX_SWEEP_ITERATIONS = 200;
      for (let iter = 0; iter < MAX_SWEEP_ITERATIONS; iter++) {
        // eslint-disable-next-line no-await-in-loop
        const page = await importRef.collection("items")
          .where("resolved", "==", false)
          .where("skip", "==", false)
          .limit(SWEEP_PAGE)
          .get();
        if (page.empty) break;
        const sweepFns = page.docs.map((docSnap) => (batch) => batch.set(docSnap.ref, {
          skip: true,
          resolved: false,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true }));
        // eslint-disable-next-line no-await-in-loop
        await commitInChunks(db, sweepFns);
        if (page.size < SWEEP_PAGE) break;
      }
    }

    let titleStateIdsWritten = [];
    if (matchedRows.length > 0) {
      const importOptions = normalizeTitlesImportOptions(importData.importOptions || {});
      const writes = buildImportTitleStateWrites(matchedRows, confirmedCurrentStatesByTitleId, {
        now: new Date(),
        source: importData.source || "netflix_csv",
        ...importOptions,
      });
      const titleStateWriteFns = [];
      writes.forEach(({ titleId, next }) => {
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
      });
      await commitInChunks(db, titleStateWriteFns);
      titleStateIdsWritten = writes.map((w) => w.titleId);
    }

    // Recompute exact remaining/skipped counts from the items subcollection via
    // aggregation (O(1) billing, no doc reads) so the summary the client shows
    // is always accurate — the previous code left `unresolvedCount` frozen at its
    // original value after a partial confirm.
    const [remainingAgg, skippedAgg] = await Promise.all([
      importRef.collection("items").where("resolved", "==", false).where("skip", "==", false).count().get(),
      importRef.collection("items").where("skip", "==", true).count().get(),
    ]);
    const remainingUnresolved = Number(remainingAgg.data().count || 0);
    const skippedCount = Number(skippedAgg.data().count || 0);

    const mergedTitleStateIds = Array.from(new Set([
      ...(Array.isArray(importData.titleStateIdsWritten) ? importData.titleStateIdsWritten : []),
      ...titleStateIdsWritten,
    ]));

    const nextStatus = computeImportConfirmationStatus(remainingUnresolved);
    const confirmationAt = admin.firestore.Timestamp.now();
    await importRef.set({
      status: nextStatus,
      titleStateIdsWritten: mergedTitleStateIds,
      // Persisted so a resumed completed-summary (deep link / listener) shows an
      // exact imported count on both clients without recomputing.
      importedTitleCount: mergedTitleStateIds.length,
      unresolvedCount: remainingUnresolved,
      skippedCount,
      updatedAt: confirmationAt,
      completedAt: nextStatus === "completed" ? confirmationAt : null,
    }, { merge: true });

    if (nextStatus === "completed") {
      if (mergedTitleStateIds.length > 0) {
        await recordSuccessfulImportTracking({ db, uid, completedAt: confirmationAt })
          .catch((err) => logger.warn("[productTracking] confirmed import milestone failed", {
            uid,
            importId,
            message: safeString(err?.message || String(err), 180),
          }));
      }
      await createTitlesImportNotification(db, uid, importId, "completed", {
        matchedCount: mergedTitleStateIds.length,
        unresolvedCount: 0,
      }, source);
    }

    return {
      ok: true,
      importId,
      status: nextStatus,
      resolvedCount: matchedRows.length,
      importedTitleCount: mergedTitleStateIds.length,
      skippedCount,
      unresolvedCount: remainingUnresolved,
    };
  });

async function fetchTitlesByIds(db, titleIds) {
  const result = new Map();
  const uniqueIds = uniqueIdList(titleIds);
  for (let i = 0; i < uniqueIds.length; i += 10) {
    const chunk = uniqueIds.slice(i, i + 10);
    if (!chunk.length) continue;
    const snap = await db.collection("titles")
      .where(admin.firestore.FieldPath.documentId(), "in", chunk)
      .get();
    snap.docs.forEach((docSnap) => result.set(docSnap.id, docSnap.data() || {}));
  }
  return result;
}

const NEW_SEASON_NOTIF_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const NEW_SEASON_RECENT_WINDOW_MS = 180 * DAY_MS;
const NEW_SEASON_FUTURE_GRACE_MS = 2 * DAY_MS;

function parseDateOnlyMillis(value) {
  const raw = safeString(value || "", 24).trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return 0;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day);
  return Number.isFinite(ms) ? ms : 0;
}

function seasonNumberFromRow(row) {
  return toPositiveInt(row?.season || row?.season_number);
}

function seasonAirDateFromRow(row) {
  return safeString(row?.air_date || row?.airDate || "", 24).trim() || null;
}

function resolveNewSeasonCandidate({ stateData, totals, seasonsList }) {
  const rows = safeArray(seasonsList)
    .map((row) => ({
      season: seasonNumberFromRow(row),
      airDate: seasonAirDateFromRow(row),
    }))
    .filter((row) => row.season > 0)
    .sort((a, b) => a.season - b.season);

  const snapshotSeasons = toPositiveInt(stateData?.completedAtTotalSeasons);
  const currentSeasons = toPositiveInt(totals?.totalSeasonCount);
  const newRows = snapshotSeasons > 0
    ? rows.filter((row) => row.season > snapshotSeasons)
    : [];
  const candidate = (newRows.length ? newRows : rows).at(-1) || null;
  const latestSeason = toPositiveInt(candidate?.season) || currentSeasons || null;
  const latestSeasonAirDate = candidate?.airDate || null;
  const totalEpisodes = toPositiveInt(totals?.totalEpisodeCount) || null;
  const totalSeasonCount = currentSeasons || null;

  return {
    latestSeason,
    latestSeasonAirDate,
    signature: [
      latestSeason || "",
      latestSeasonAirDate || "",
      totalSeasonCount || "",
      totalEpisodes || "",
    ].join(":"),
  };
}

function newSeasonNotificationEligibility(candidate, nowMs = Date.now()) {
  const airMs = parseDateOnlyMillis(candidate?.latestSeasonAirDate);
  if (!airMs) return { eligible: false, reason: "missing_air_date" };
  if (airMs > nowMs + NEW_SEASON_FUTURE_GRACE_MS) {
    return { eligible: false, reason: "future_air_date" };
  }
  if (nowMs - airMs > NEW_SEASON_RECENT_WINDOW_MS) {
    return { eligible: false, reason: "old_air_date" };
  }
  return { eligible: true, reason: "recent_air_date" };
}

exports.detectNewSeasonsForUser = functions
  .region("europe-west1")
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid || null;
    if (!uid) {
      throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
    }

    const db = admin.firestore();
    await enforceCallableRateLimit(db, uid, "detectNewSeasonsForUser", {
      windowSeconds: 30,
      maxInWindow: 6,
      dailyMax: 240,
    });

    const userRef = db.collection("users").doc(uid);
    const statesQuery = userRef.collection("titleStates")
      .where("mediaType", "==", "tv")
      .where("state", "in", ["completed_unrated", "rated"])
      .limit(500);

    const statesSnap = await statesQuery.get().catch((err) => {
      logger.warn("[detectNewSeasons] read states failed", { uid, error: err?.message || String(err) });
      return null;
    });
    if (!statesSnap || statesSnap.empty) {
      return { ok: true, detected: [], scanned: 0 };
    }

    const titleIds = statesSnap.docs.map((d) => d.id);
    const titlesById = await fetchTitlesByIds(db, titleIds);
    const detected = [];
    const nowMs = Date.now();

    for (const docSnap of statesSnap.docs) {
      const stateData = docSnap.data() || {};
      const titleId = docSnap.id;
      const titleData = titlesById.get(titleId);
      if (!titleData) continue;
      const totals = estimateTitleTotals({ id: titleId, ...titleData });

      // Backfill snapshot for legacy states so future TMDB growth is detected correctly.
      const hasSnapshot = toPositiveInt(stateData.completedAtTotalEpisodes) > 0
        || toPositiveInt(stateData.completedAtTotalSeasons) > 0;
      if (!hasSnapshot) {
        const backfill = {
          completedAtTotalEpisodes: toPositiveInt(totals.totalEpisodeCount) || null,
          completedAtTotalSeasons: toPositiveInt(totals.totalSeasonCount) || null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        await docSnap.ref.set(backfill, { merge: true }).catch(() => {});
        // Re-read into local var so subsequent checks behave correctly.
        stateData.completedAtTotalEpisodes = backfill.completedAtTotalEpisodes;
        stateData.completedAtTotalSeasons = backfill.completedAtTotalSeasons;
      }

      if (!hasNewContentVsSnapshot(stateData, totals)) continue;

      const seasonsList = Array.isArray(titleData?.meta?.seasons) ? titleData.meta.seasons : [];
      const candidate = resolveNewSeasonCandidate({ stateData, totals, seasonsList });
      const eligibility = newSeasonNotificationEligibility(candidate, nowMs);
      if (!eligibility.eligible) {
        const sameSuppressed = stateData?.newContentSuppressedSignature === candidate.signature
          && !Boolean(stateData?.hasNewContent);
        if (!sameSuppressed) {
          await docSnap.ref.set({
            hasNewContent: false,
            latestSeasonNumber: candidate.latestSeason || stateData.latestSeasonNumber || null,
            latestSeasonAirDate: candidate.latestSeasonAirDate || stateData.latestSeasonAirDate || null,
            newContentDetectedAt: null,
            newContentSuppressedAt: admin.firestore.FieldValue.serverTimestamp(),
            newContentSuppressedReason: eligibility.reason,
            newContentSuppressedSignature: candidate.signature,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true }).catch((err) => {
            logger.warn("[detectNewSeasons] suppress stale candidate failed", {
              uid,
              titleId,
              reason: eligibility.reason,
              error: err?.message || String(err),
            });
          });
        }
        continue;
      }

      const lastNotifiedMs = toMillis(stateData?.lastNewContentNotifiedAt) || 0;
      const justFlagged = Boolean(stateData?.hasNewContent);

      const updates = {
        hasNewContent: true,
        latestSeasonNumber: candidate.latestSeason || stateData.latestSeasonNumber || null,
        latestSeasonAirDate: candidate.latestSeasonAirDate || stateData.latestSeasonAirDate || null,
        newContentDetectedAt: admin.firestore.FieldValue.serverTimestamp(),
        newContentSuppressedReason: null,
        newContentSuppressedSignature: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastInteractionAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      const shouldNotify = !justFlagged && (nowMs - lastNotifiedMs) > NEW_SEASON_NOTIF_COOLDOWN_MS;
      if (shouldNotify) {
        updates.lastNewContentNotifiedAt = admin.firestore.FieldValue.serverTimestamp();
      }

      await docSnap.ref.set(updates, { merge: true });

      const titleName = safeString(titleData?.name || stateData?.titleSnapshot?.name || "una serie", 160);
      detected.push({
        titleId,
        titleName,
        latestSeasonNumber: candidate.latestSeason || null,
        notified: shouldNotify,
      });

      if (shouldNotify) {
        await userRef.collection("notifications").add({
          toUid: uid,
          fromUid: "system",
          type: "new_season_available",
          data: {
            titleId,
            titleName,
            latestSeasonNumber: candidate.latestSeason || null,
            latestSeasonAirDate: candidate.latestSeasonAirDate,
          },
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + 30 * 24 * 60 * 60 * 1000),
        }).catch((err) => {
          logger.warn("[detectNewSeasons] notif create failed", {
            uid,
            titleId,
            error: err?.message || String(err),
          });
        });
      }
    }

    return {
      ok: true,
      detected,
      scanned: statesSnap.size,
    };
  });

exports.syncTitleStateFromTitleRating = functions
  .region("europe-west1")
  .firestore
  .document("ratings/{ratingId}")
  .onWrite(async (change) => {
    const before = change.before.exists ? (change.before.data() || {}) : null;
    const after = change.after.exists ? (change.after.data() || {}) : null;
    const level = toId(after?.level || before?.level || "title");
    if (level !== "title") return null;

    const uid = toId(after?.uid || before?.uid);
    const titleId = toId(after?.titleId || before?.titleId);
    if (!uid || !titleId) return null;

    // Guard anti-amplification: se before/after sono entrambi presenti e la
    // sostanza del rating (value + status) non è cambiata, evita la riscrittura
    // dello state. Eviita ping-pong di trigger su `set { merge: true }` che
    // toccano lo stesso doc senza cambiarne il contenuto rilevante.
    if (before && after) {
      const beforeValue = before.rating;
      const afterValue = after.rating;
      const beforeStatus = typeof before.status === "string" ? before.status : "";
      const afterStatus = typeof after.status === "string" ? after.status : "";
      // Nota: `null/undefined` vengono trattati come equivalenti via `==`.
      // Se i due value sono entrambi numerici e uguali, e lo status è uguale,
      // non c'è nulla da propagare allo state.
      // eslint-disable-next-line eqeqeq
      if (beforeValue == afterValue && beforeStatus === afterStatus) {
        return null;
      }
    }

    const db = admin.firestore();
    const userRef = db.collection("users").doc(uid);
    const stateRef = userRef.collection("titleStates").doc(titleId);
    const libraryRef = userRef.collection("library").doc(titleId);
    const watchlistRef = userRef.collection("watchlist").doc(titleId);

    await refreshTitleWatchMetricsIfNeeded({
      db,
      titleId,
      action: { type: "mark_series_completed" },
      requestedBy: uid,
    }).catch((err) => {
      logger.warn("[rating-state] metrics preflight failed", {
        uid,
        titleId,
        message: safeString(err?.message || String(err), 180),
      });
      return null;
    });

    const titleSnap = await db.collection("titles").doc(titleId).get().catch(() => null);
    const stateSnap = await stateRef.get().catch(() => null);

    if (!titleSnap?.exists && !stateSnap?.exists) return null;

    const titleData = titleSnap?.exists
      ? { id: titleId, ...(titleSnap.data() || {}) }
      : {
        id: titleId,
        type: normalizeTmdbMediaType(stateSnap.data()?.mediaType || "movie"),
        titleSnapshot: stateSnap.data()?.titleSnapshot || null,
      };
    const now = after?.updatedAt || after?.createdAt || admin.firestore.Timestamp.now();
    const nextState = applyTitleRatingToState(stateSnap?.exists ? (stateSnap.data() || {}) : null, after, titleData, { now });
    const batch = db.batch();

    if (isMeaningfulTitleState(nextState)) {
      batch.set(stateRef, nextState, { merge: true });
    } else {
      batch.delete(stateRef);
    }

    const libraryPayload = buildFirestoreProjectionPayload(
      buildLegacyLibraryProjection(nextState),
      admin.firestore.FieldValue.serverTimestamp(),
      "createdAt"
    );
    const watchlistPayload = buildFirestoreProjectionPayload(
      buildLegacyWatchlistProjection(nextState),
      admin.firestore.FieldValue.serverTimestamp(),
      "addedAt"
    );

    if (libraryPayload && isMeaningfulTitleState(nextState)) {
      batch.set(libraryRef, libraryPayload, { merge: true });
    } else {
      batch.delete(libraryRef);
    }

    if (watchlistPayload && isMeaningfulTitleState(nextState)) {
      batch.set(watchlistRef, watchlistPayload, { merge: true });
    } else {
      batch.delete(watchlistRef);
    }

    await batch.commit();
    return null;
  });

exports.recomputeUserStatsFromTitleStates = functions
  .region("europe-west1")
  .firestore
  .document("users/{uid}/titleStates/{titleId}")
  .onWrite(async (change, context) => {
    const beforeState = change.before.exists ? (change.before.data() || {}) : null;
    const afterState = change.after.exists ? (change.after.data() || {}) : null;
    await syncLegacyTitleStateProjectionsAndStats({
      db: admin.firestore(),
      uid: context.params.uid,
      titleId: context.params.titleId,
      beforeState,
      afterState,
    });
    return null;
  });

exports.recomputeTitleStatesFromTitleMetrics = functions
  .region("europe-west1")
  .firestore
  .document("titles/{titleId}")
  .onWrite(async (change, context) => {
    if (!change.after.exists) return null;

    const beforeTitle = change.before.exists ? (change.before.data() || {}) : null;
    const afterTitle = change.after.data() || {};
    if (beforeTitle && titleWatchMetricsSignature(beforeTitle) === titleWatchMetricsSignature(afterTitle)) {
      return null;
    }

    const db = admin.firestore();
    const titleId = context.params.titleId;
    const issuesSnap = await db.collection("metadataIssues")
      .where("titleId", "==", titleId)
      .limit(450)
      .get()
      .catch((err) => {
        logger.warn("[title-metrics] metadataIssues read failed", {
          titleId,
          message: safeString(err?.message || String(err), 180),
        });
        return null;
      });
    if (!issuesSnap || issuesSnap.empty) return null;

    let batch = db.batch();
    let ops = 0;
    let repairedCount = 0;
    const flush = async () => {
      if (!ops) return;
      await batch.commit();
      batch = db.batch();
      ops = 0;
    };

    for (const issueSnap of issuesSnap.docs) {
      const issue = issueSnap.data() || {};
      if (safeString(issue.status || "open", 40).toLowerCase() !== "open") continue;
      const uid = toId(issue.uid);
      if (!uid) {
        batch.delete(issueSnap.ref);
        ops += 1;
        if (ops >= 400) await flush();
        continue;
      }
      const stateRef = db.collection("users").doc(uid).collection("titleStates").doc(titleId);
      const stateSnap = await stateRef.get().catch(() => null);
      if (!stateSnap?.exists) {
        batch.delete(issueSnap.ref);
        ops += 1;
        if (ops >= 400) await flush();
        continue;
      }

      const repairPayload = buildTitleStateMetricsRepairPayload(
        stateSnap.data() || {},
        { id: titleId, ...afterTitle }
      );
      if (!repairPayload) continue;
      batch.set(stateRef, repairPayload, { merge: true });
      repairedCount += 1;
      ops += 1;
      if (ops >= 400) await flush();
    }

    await flush();
    if (repairedCount > 0) {
      logger.info("[title-metrics] repaired titleStates", { titleId, repairedCount });
    }
    return null;
  });

// listProgressEntries hold rewatch minutes from public/custom lists. Increment
// the same cached counter so stats.totalWatchMinutes stays the complete total.
exports.recomputeUserStatsFromListProgress = functions
  .region("europe-west1")
  .firestore
  .document("users/{uid}/listProgressEntries/{entryId}")
  .onWrite(async (change, context) => {
    const before = change.before.exists ? (change.before.data() || {}) : null;
    const after = change.after.exists ? (change.after.data() || {}) : null;
    const delta = toPositiveInt(after?.watchMinutesContribution)
      - toPositiveInt(before?.watchMinutesContribution);
    if (delta === 0) return null;

    const db = admin.firestore();
    const entryTitleId = toId(after?.titleId || before?.titleId);
    let title = null;
    if (entryTitleId) {
      const titleSnap = await db.collection("titles").doc(entryTitleId).get().catch(() => null);
      title = titleSnap && titleSnap.exists
        ? { id: entryTitleId, ...(titleSnap.data() || {}) }
        : null;
    }
    const category = deriveContentCategory(
      title || { type: (after || before || {}).mediaType }
    );
    await db.collection("users").doc(context.params.uid).set({
      stats: {
        totalWatchMinutes: admin.firestore.FieldValue.increment(delta),
        byCategory: {
          [category]: { totalWatchMinutes: admin.firestore.FieldValue.increment(delta) },
        },
      },
    }, { merge: true });
    return null;
  });

// Re-derives a user's cached stats from scratch (titleStates + listProgressEntries).
// Used by the scheduled reconciliation and the admin/self callable to correct any
// drift the incremental triggers accumulate from at-least-once retries.
// Implementation lives in ./lib/userStats.js so the backfill-title-states-metrics
// script can reuse the exact same logic instead of a parallel reimplementation.
const recomputeUserStatsForUid = sharedRecomputeUserStatsForUid;

// Weekly safety-net: re-derive every user's cached stats so drift is corrected.
exports.reconcileUserStats = functions
  .runWith({ timeoutSeconds: 540, memory: "512MB" })
  .region("europe-west1")
  .pubsub.schedule("every 168 hours")
  .onRun(async () => {
    const db = admin.firestore();
    const pageSize = 50;
    let lastDoc = null;
    let hasMore = true;
    let processed = 0;

    while (hasMore) {
      let query = db.collection("users")
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(pageSize);
      if (lastDoc) query = query.startAfter(lastDoc);
      const snap = await query.get();
      if (snap.empty) break;

      for (const docSnap of snap.docs) {
        await recomputeUserStatsForUid(db, docSnap.id).catch((err) => {
          logger.warn("[reconcileUserStats] user failed", {
            uid: docSnap.id,
            error: err?.message || String(err),
          });
        });
        processed += 1;
      }

      lastDoc = snap.docs[snap.docs.length - 1];
      hasMore = snap.size === pageSize;
    }

    logger.info("[reconcileUserStats] done", { processed });
    return null;
  });

// Backup notturno: export completo di Firestore su GCS. Chiude la meta'
// "recuperabilita'" del rischio R1 della review — senza backup schedulato un
// incidente dati (durante l'ondata TV Time) sarebbe irreversibile.
// Setup one-time del proprietario: creare il bucket FIRESTORE_BACKUP_BUCKET
// (default "gia-visto-backups") con lifecycle 30gg e concedere al service
// account gia-visto@appspot.gserviceaccount.com i ruoli
// roles/datastore.importExportAdmin + write sul bucket. Vedi docs/HARDENING-2026-07-13.md.
exports.scheduledFirestoreExport = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 540, memory: "512MB" })
  .pubsub.schedule("0 3 * * *")
  .timeZone("Europe/Rome")
  .onRun(async () => {
    const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "gia-visto";
    const bucket = process.env.FIRESTORE_BACKUP_BUCKET || "gia-visto-backups";
    const now = new Date();
    const ymd = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const outputUriPrefix = `gs://${bucket}/firestore-exports/${ymd}`;
    try {
      const { FirestoreAdminClient } = require("@google-cloud/firestore").v1;
      const client = new FirestoreAdminClient();
      const databaseName = client.databasePath(projectId, "(default)");
      const [operation] = await client.exportDocuments({
        name: databaseName,
        outputUriPrefix,
        // collectionIds vuoto = export di tutte le collection
      });
      logger.info("[firestoreBackup] export avviato", {
        outputUriPrefix,
        operation: operation?.name || null,
      });
    } catch (e) {
      // Fai fallire il run cosi' l'errore e' visibile (e allertabile quando
      // ci saranno le alert policy). Tipico primo errore: IAM non concesso.
      logger.error("[firestoreBackup] export fallito", { outputUriPrefix, error: e?.message });
      throw e;
    }
    return null;
  });

// Portabilita' dati (GDPR art. 20): l'utente scarica una copia JSON dei propri
// dati. Read-only, reauth-gated e rate-limitata come deleteMyAccount. Salva su
// Storage dataExports/{uid}/ con token e ritorna l'URL di download.
// Owner: aggiungere lifecycle TTL sul prefisso dataExports/ (come supportImports/).
exports.exportMyData = functions
  .runWith({ timeoutSeconds: 540, memory: "1GB" })
  .region("europe-west1")
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid || null;
    if (!uid) {
      throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
    }

    // Reauth recente (come deleteMyAccount): l'export contiene dati personali.
    const authTimeSeconds = Number(context.auth?.token?.auth_time || 0);
    const authAgeSeconds = Math.floor(Date.now() / 1000) - authTimeSeconds;
    if (!authTimeSeconds || authAgeSeconds > 10 * 60) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "auth/requires-recent-login: autenticati di nuovo per esportare i tuoi dati."
      );
    }

    const db = admin.firestore();
    await enforceCallableRateLimit(db, uid, "exportMyData", {
      windowSeconds: 10 * 60,
      maxInWindow: 2,
      dailyMax: 5,
    });

    // Dump paginato (cursore su __name__), cap per collection per limitare memoria.
    const dumpQuery = async (q, cap = 20000) => {
      const out = [];
      let last = null;
      for (;;) {
        let page = q.limit(1000);
        if (last) page = page.startAfter(last);
        const snap = await page.get();
        if (snap.empty) break;
        snap.forEach((d) => out.push({ id: d.id, ...d.data() }));
        last = snap.docs[snap.docs.length - 1];
        if (snap.size < 1000 || out.length >= cap) break;
      }
      return out;
    };
    const userRef = db.collection("users").doc(uid);
    const dumpSub = (name, cap) => dumpQuery(userRef.collection(name), cap);

    // Subcollection utente possedute (dati personali dell'utente).
    const SUBS = [
      "watchlist", "library", "savedLists", "listProgressEntries", "titleStates",
      "imports", "matchFeedback", "notifications", "onboardingTelemetry",
      "feedEvents", "signals", "friends", "following", "followers", "quizStats",
      "quizAttempts", "episodeViews", "derivedRatings", "tasteProfile",
      "blockedUsers", "reports", "experiments",
    ];
    const subcollections = {};
    for (const s of SUBS) subcollections[s] = await dumpSub(s);
    // Import snapshots moved out of the parent document to avoid Firestore's
    // 1 MiB document limit. They remain part of the user's portable data even
    // though Firestore rules intentionally deny direct client reads.
    for (const importDoc of subcollections.imports || []) {
      // eslint-disable-next-line no-await-in-loop
      importDoc.previousStates = await dumpQuery(
        userRef.collection("imports").doc(importDoc.id).collection("previousStates"),
        TITLES_IMPORT_MAX_ROWS
      );
    }

    const [userSnap, privateSnap, productTrackingSnap] = await Promise.all([
      userRef.get(),
      db.collection("usersPrivate").doc(uid).get(),
      userRef.collection("_system").doc("productTracking").get(),
    ]);

    const payload = {
      exportedAt: new Date().toISOString(),
      uid,
      profile: userSnap.exists ? userSnap.data() : null,
      private: privateSnap.exists ? privateSnap.data() : null,
      productTracking: productTrackingSnap.exists ? productTrackingSnap.data() : null,
      subcollections,
      ratings: await dumpQuery(db.collection("ratings").where("uid", "==", uid)),
      recommendationsSent: await dumpQuery(db.collection("recommendations").where("fromUid", "==", uid)),
      recommendationsReceived: await dumpQuery(db.collection("recommendations").where("toUid", "==", uid)),
      posts: await dumpQuery(db.collection("posts").where("authorUid", "==", uid)),
      titleEmotions: await dumpQuery(db.collection("titleEmotions").where("uid", "==", uid)),
      episodeEmotions: await dumpQuery(db.collection("episodeEmotions").where("uid", "==", uid)),
      ratingFeed: await dumpQuery(db.collection("ratingFeed").where("uid", "==", uid)),
      quizChallengesSent: await dumpQuery(db.collection("quizChallenges").where("fromUid", "==", uid)),
      ownedLists: await dumpQuery(db.collection("userLists").where("ownerUid", "==", uid)),
    };

    const exportId = randomUUID();
    const storagePath = `dataExports/${uid}/export-${exportId}.json`;
    const downloadToken = randomUUID();
    const bucket = admin.storage().bucket();
    await bucket.file(storagePath).save(JSON.stringify(payload, null, 2), {
      resumable: false,
      contentType: "application/json",
      metadata: {
        contentType: "application/json",
        cacheControl: "no-store",
        metadata: { firebaseStorageDownloadTokens: downloadToken, uid },
      },
    });
    const url = buildFirebaseStorageDownloadUrl(bucket.name, storagePath, downloadToken);
    logger.info("[exportMyData] export creato", { uid, storagePath });
    return { ok: true, url, exportedAt: payload.exportedAt };
  });

// Beacon funnel prodotto: incrementa un contatore giornaliero AGGREGATO e
// anonimo (nessun uid memorizzato) su productMetrics/{giorno}. Solo eventi in
// whitelist; no-op silenzioso altrimenti e su rate-limit. Copre gli step client
// che non hanno un trigger server (onboarding, import avviato, quiz, empty state).
const PRODUCT_EVENT_WHITELIST = new Set([
  "signup_started", "onboarding_started", "onboarding_completed", "onboarding_skipped",
  "import_started", "quiz_played", "guest_quiz_played", "empty_watchlist", "empty_feed",
]);
exports.logProductEvent = functions
  .region("europe-west1")
  .https.onCall(async (data, context) => {
    const event = String(data?.event || "").trim();
    if (!PRODUCT_EVENT_WHITELIST.has(event)) return { ok: false };
    const db = admin.firestore();
    const uid = context.auth?.uid || null;
    try {
      if (uid) {
        await enforceCallableRateLimit(db, uid, "logProductEvent", {
          windowSeconds: 60, maxInWindow: 40, dailyMax: 800,
        });
      } else {
        await enforceGuestCallableRateLimit(db, context?.rawRequest?.ip, "logProductEvent", {
          windowSeconds: 60, maxInWindow: 30, dailyMax: 400,
        });
      }
    } catch (_e) {
      // Rate-limitato: non contare, ma non far fallire l'UX del client.
      return { ok: false };
    }
    await bumpDailyMetric(event, 1);
    return { ok: true };
  });

// Snapshot giornaliero (03:30 Rome) delle metriche CORE dai dati gia' esistenti
// (users.createdAt/lastActiveAt/stats): utenti totali/nuovi, DAU/WAU (North Star),
// attivazione a 48h, totali cumulati (watch/rating/minuti) da cui la dashboard
// ricava i delta giornalieri. NESSUNA scrittura sui trigger caldi -> zero
// contention durante le ondate di import. Esclude profili sintetici/guidati,
// admin/staff e gli UID configurati in ANALYTICS_EXCLUDED_UIDS.
exports.computeProductMetricsSnapshot = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 540, memory: "512MB" })
  .pubsub.schedule("30 3 * * *")
  .timeZone("Europe/Rome")
  .onRun(async () => {
    const db = admin.firestore();
    const ms = (v) => (v && typeof v.toMillis === "function") ? v.toMillis()
      : (v instanceof Date ? v.getTime() : 0);
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const t1d = now - DAY;
    const t7d = now - 7 * DAY;
    const t2d = now - 2 * DAY;

    let totalUsers = 0, newUsers24h = 0, dau = 0, wau = 0;
    let sumWatched = 0, sumRatings = 0, sumMinutes = 0;
    let activated48h = 0, cohort48hSize = 0;
    const trackingEligibleUids = new Set();
    let last = null;
    for (;;) {
      let q = db.collection("users").orderBy(admin.firestore.FieldPath.documentId()).limit(500);
      if (last) q = q.startAfter(last);
      const snap = await q.get();
      if (snap.empty) break;
      for (const d of snap.docs) {
        last = d;
        const u = d.data() || {};
        if (isExcludedFromProductAnalytics(d.id, u)) continue;
        totalUsers += 1;
        trackingEligibleUids.add(d.id);
        const st = u.stats || {};
        const watched = Number(st.watchedCount || 0);
        sumWatched += watched;
        sumRatings += Number(st.ratingsCount || 0);
        sumMinutes += Number(st.totalWatchMinutes || 0);
        const created = ms(u.createdAt);
        const active = ms(u.lastActiveAt);
        if (created >= t1d) newUsers24h += 1;
        if (active >= t1d) dau += 1;
        if (active >= t7d) wau += 1;
        // Coorte attivazione: creati tra 48h e 24h fa (hanno avuto >=24h);
        // "attivati" = almeno 1 titolo visto.
        if (created && created < t1d && created >= t2d) {
          cohort48hSize += 1;
          if (watched > 0) activated48h += 1;
        }
      }
      if (snap.size < 500) break;
    }

    const trackingByUid = new Map();
    const expiredTrackingRefs = [];
    const eligibleUidList = [...trackingEligibleUids];
    for (let i = 0; i < eligibleUidList.length; i += 300) {
      const refs = eligibleUidList
        .slice(i, i + 300)
        .map((uid) => db.collection("users").doc(uid).collection("_system").doc("productTracking"));
      if (!refs.length) continue;
      // eslint-disable-next-line no-await-in-loop
      const trackingSnaps = await db.getAll(...refs);
      for (const trackingSnap of trackingSnaps) {
        if (!trackingSnap.exists) continue;
        const uid = trackingSnap.ref.parent.parent.id;
        const data = trackingSnap.data() || {};
        if (toMillis(data.expiresAt) > 0 && toMillis(data.expiresAt) <= now) {
          expiredTrackingRefs.push(trackingSnap.ref);
          continue;
        }
        trackingByUid.set(uid, data);
      }
    }
    const manualProgress = computeManualProgressSnapshot({
      nowMs: now,
      consumerUids: trackingEligibleUids,
      trackingByUid,
    });

    const { romeDateKey } = require("./lib/productMetrics");
    await db.collection("productMetrics").doc(romeDateKey()).set({
      snapshot: {
        totalUsers, newUsers24h, dau, wau,
        sumWatched, sumRatings, sumMinutes,
        activated48h, cohort48hSize,
        manualProgress,
        at: admin.firestore.FieldValue.serverTimestamp(),
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    for (let i = 0; i < expiredTrackingRefs.length; i += 400) {
      const batch = db.batch();
      expiredTrackingRefs.slice(i, i + 400).forEach((ref) => batch.delete(ref));
      // eslint-disable-next-line no-await-in-loop
      await batch.commit();
    }
    logger.info("[productMetrics] snapshot", {
      totalUsers,
      wau,
      dau,
      newUsers24h,
      activated48h,
      cohort48hSize,
      manualProgressUsers7d: manualProgress.manualProgressUsers7d,
      trackingEligibleUsers: trackingEligibleUids.size,
      expiredTrackingDeleted: expiredTrackingRefs.length,
    });
    return null;
  });

// On-demand reconciliation: admins can target any user, everyone else their own.
exports.recomputeUserStats = functions
  .region("europe-west1")
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid || null;
    if (!uid) {
      throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
    }

    const db = admin.firestore();
    await enforceCallableRateLimit(db, uid, "recomputeUserStats", {
      windowSeconds: 20,
      maxInWindow: 4,
      dailyMax: 60,
    });

    const requestedUid = toId(data?.userId);
    let targetUid = uid;
    if (requestedUid && requestedUid !== uid) {
      const callerIsAdmin = await isAdminCaller(db, uid);
      if (!callerIsAdmin) {
        throw new functions.https.HttpsError(
          "permission-denied",
          "Solo gli admin possono ricalcolare le statistiche di altri utenti."
        );
      }
      targetUid = requestedUid;
    }

    const stats = await recomputeUserStatsForUid(db, targetUid);
    return { ok: true, uid: targetUid, stats };
  });

// ============================================
// Quiz: aggregato temi giocabili (quizMeta/themes)
// Listing completo dei titoli che hanno domande + ricerca, con UNA sola read
// client (vs campionamento parziale). Ricostruito scheduled + on-demand (admin)
// invece che via trigger per-domanda, così gli import batch (migliaia di write)
// non creano un hotspot di scrittura sul singolo doc aggregato.
// ============================================
const QUIZ_THEME_PLAYABLE_STATUSES = ["approved", "beta_pending_review"];

// Lingua del pool quiz. Ogni doc `quizQuestions` ha da sempre un campo
// `language` (verificato su prod il 2026-07-29: 10.525 domande, tutte "it")
// ma nessuna query lo usava: una sola domanda in inglese avrebbe mescolato le
// lingue dentro la stessa partita. Filtriamo in memoria e non nella query
// perche' a livello di query servirebbero nuovi indici compositi, da deployare
// PRIMA del codice che li usa (vedi docs/DECISIONS.md, 2026-07-28). Finche' il
// corpus e' monolingua e' un no-op; quando esistera' un volume reale di
// domande EN, spostare il filtro nelle query e aggiungere gli indici.
const QUIZ_LANGUAGE = "it";

function isQuizLanguage(doc, lang = QUIZ_LANGUAGE) {
  return String((doc && doc.language) || "it") === lang;
}

async function rebuildQuizThemesAggregate(db) {
  const snap = await db
    .collection("quizQuestions")
    .where("status", "in", QUIZ_THEME_PLAYABLE_STATUSES)
    .select("titleId", "title", "mediaType", "language")
    .get();

  const themes = {};
  let counted = 0;
  for (const docSnap of snap.docs) {
    const d = docSnap.data() || {};
    const titleId = d.titleId;
    if (!titleId) continue;
    if (!isQuizLanguage(d)) continue;
    counted += 1;
    const existing = themes[titleId];
    if (existing) {
      existing.count += 1;
      if (!existing.title && d.title) existing.title = safeString(d.title, 180);
    } else {
      themes[titleId] = {
        titleId,
        title: safeString(d.title || "", 180),
        mediaType: safeString(d.mediaType || "", 20),
        count: 1,
      };
    }
  }

  const themeList = Object.values(themes).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return String(a.title).localeCompare(String(b.title), "it");
  });

  await db.collection("quizMeta").doc("themes").set({
    themes: themeList,
    totalTitles: themeList.length,
    totalQuestions: counted,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { totalTitles: themeList.length, totalQuestions: counted };
}

exports.rebuildQuizThemes = functions
  .region("europe-west1")
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid || null;
    if (!uid) throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
    const db = admin.firestore();
    const callerIsAdmin = await isAdminCaller(db, uid);
    if (!callerIsAdmin) {
      throw new functions.https.HttpsError("permission-denied", "Solo gli admin possono ricostruire i temi quiz.");
    }
    const result = await rebuildQuizThemesAggregate(db);
    return { ok: true, ...result };
  });

exports.scheduledRebuildQuizThemes = functions
  .region("europe-west1")
  .pubsub.schedule("every 24 hours")
  .onRun(async () => {
    const db = admin.firestore();
    try {
      const result = await rebuildQuizThemesAggregate(db);
      logger.info("[quizThemes] rebuilt", result);
    } catch (err) {
      logger.error("[quizThemes] rebuild failed", { message: err?.message || String(err) });
    }
    return null;
  });

// ============================================
// Guest quiz (teaser pubblico, NIENTE login) — funnel di acquisizione.
// Server-authoritative: getGuestQuiz serve le domande SENZA correctAnswerIndex
// né explanation; submitGuestQuiz valida lato server e restituisce correttezza
// + spiegazioni. Nessuna scrittura utente (i guest non hanno stats/XP), nessun
// leak dell'answer-key, niente forge del punteggio. Le rules quizQuestions
// (read isSignedIn) NON vengono toccate: qui si usa l'admin SDK.
// ============================================
const GUEST_QUIZ_MAX_COUNT = 10;
const GUEST_QUIZ_MIN_COUNT = 3;

function pickRandomN(arr, n) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

exports.getGuestQuiz = functions
  .region("europe-west1")
  .https.onCall(async (data, context) => {
    const db = admin.firestore();
    await enforceGuestCallableRateLimit(db, context?.rawRequest?.ip, "getGuestQuiz", {
      windowSeconds: 60,
      maxInWindow: 10,
      dailyMax: 120,
    });
    const count = Math.min(Math.max(Number(data?.count) || 5, GUEST_QUIZ_MIN_COUNT), GUEST_QUIZ_MAX_COUNT);
    let titleId = toId(data?.titleId);

    // Senza titolo esplicito: scegli un tema a caso tra i più popolari.
    if (!titleId) {
      const themesSnap = await db.collection("quizMeta").doc("themes").get();
      const themes = (asObject(themesSnap.data()).themes || [])
        .filter((t) => t && t.titleId && (Number(t.count) || 0) >= count);
      if (themes.length) {
        const top = themes.slice(0, 40);
        titleId = top[Math.floor(Math.random() * top.length)].titleId;
      }
    }
    if (!titleId) throw new functions.https.HttpsError("not-found", "Nessun tema disponibile.");

    const snap = await db.collection("quizQuestions")
      .where("titleId", "==", titleId)
      .where("status", "in", QUIZ_THEME_PLAYABLE_STATUSES)
      .limit(60)
      .get();
    const pool = snap.docs
      .map((d) => ({ id: d.id, ...(d.data() || {}) }))
      .filter((q) => isQuizLanguage(q));
    if (!pool.length) throw new functions.https.HttpsError("not-found", "Nessuna domanda per questo tema.");

    const picked = pickRandomN(pool, count);
    const questions = picked.map((q) => ({
      questionId: q.questionId || q.id,
      titleId: q.titleId || titleId,
      title: safeString(q.title || "", 180),
      questionText: safeString(q.questionText || "", 600),
      answers: Array.isArray(q.answers) ? q.answers.slice(0, 4).map((a) => safeString(a, 240)) : [],
      difficulty: safeString(q.difficulty || "medium", 20),
      spoilerLevel: safeString(q.spoilerLevel || "none", 20),
    })).filter((q) => q.answers.length === 4);

    return {
      ok: true,
      titleId,
      title: questions[0]?.title || "",
      mediaType: safeString(picked[0]?.mediaType || "", 20),
      count: questions.length,
      questions,
    };
  });

exports.submitGuestQuiz = functions
  .region("europe-west1")
  .https.onCall(async (data, context) => {
    const db = admin.firestore();
    await enforceGuestCallableRateLimit(db, context?.rawRequest?.ip, "submitGuestQuiz", {
      windowSeconds: 60,
      maxInWindow: 10,
      dailyMax: 120,
    });
    const answers = Array.isArray(data?.answers) ? data.answers.slice(0, GUEST_QUIZ_MAX_COUNT) : [];
    if (!answers.length) throw new functions.https.HttpsError("invalid-argument", "Nessuna risposta fornita.");
    const ids = answers.map((a) => toId(a?.questionId)).filter(Boolean);
    if (!ids.length) throw new functions.https.HttpsError("invalid-argument", "questionId mancanti.");

    const refs = ids.map((id) => db.collection("quizQuestions").doc(id));
    const snaps = await db.getAll(...refs);
    const byId = new Map();
    for (const s of snaps) if (s.exists) byId.set(s.id, s.data() || {});

    let correct = 0;
    const results = answers.map((a) => {
      const qid = toId(a?.questionId);
      const q = byId.get(qid) || {};
      const playable = QUIZ_THEME_PLAYABLE_STATUSES.includes(q.status);
      const correctIndex = playable && Number.isInteger(q.correctAnswerIndex) ? q.correctAnswerIndex : -1;
      const chosen = Number.isInteger(a?.chosenIndex) ? a.chosenIndex : -1;
      const isCorrect = correctIndex >= 0 && chosen === correctIndex;
      if (isCorrect) correct += 1;
      return {
        questionId: qid,
        correctIndex,
        chosen,
        isCorrect,
        explanation: safeString(q.explanation || "", 600),
      };
    });

    return { ok: true, total: results.length, correct, results };
  });

// Bumps the denormalized reportsCount/lastReportAt on the reported question
// so heavily-flagged ones surface first in the admin list. Server-side
// because quizQuestions writes are admin-only (firestore.rules) — clients
// can only create the report doc, not touch the question directly.
exports.bumpQuizQuestionReportCount = functions
  .region("europe-west1")
  .firestore.document("quizQuestionReports/{reportId}")
  .onCreate(async (snap) => {
    const questionId = toId(snap.data()?.questionId);
    if (!questionId) return null;
    return admin.firestore().collection("quizQuestions").doc(questionId).set({
      reportsCount: admin.firestore.FieldValue.increment(1),
      lastReportAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  });

async function fetchDocumentMapById(collectionRef, ids) {
  const out = new Map();
  const uniqueIds = uniqueIdList(ids);
  for (let i = 0; i < uniqueIds.length; i += 10) {
    const chunk = uniqueIds.slice(i, i + 10);
    if (!chunk.length) continue;
    const snap = await collectionRef.where(admin.firestore.FieldPath.documentId(), "in", chunk).get();
    snap.docs.forEach((docSnap) => out.set(docSnap.id, docSnap.data() || {}));
  }
  return out;
}

async function fetchUserTitleStateMap(db, uid, titleIds) {
  return fetchDocumentMapById(
    db.collection("users").doc(uid).collection("titleStates"),
    titleIds
  );
}

function summarizeMemberListProgress({ memberId, titleIds, titleMap, stateMap, userData }) {
  let completedCount = 0;
  let lastCompleted = null;
  let inProgress = null;

  for (const titleId of titleIds) {
    const stateData = asObject(stateMap.get(titleId));
    if (!Object.keys(stateData).length) continue;
    const titleData = asObject(titleMap.get(titleId));
    const titleSnapshot = asObject(stateData?.titleSnapshot);
    const titleName = safeString(titleData?.name || titleSnapshot?.name || "Titolo", 180) || "Titolo";

    if (isCompletedPersonalState(stateData)) {
      completedCount += 1;
      const completedAt = firstTimestamp(
        stateData?.completedAt,
        stateData?.ratedAt,
        stateData?.seenAt,
        stateData?.updatedAt
      );
      if (!lastCompleted || (toMillis(completedAt) || 0) > (toMillis(lastCompleted.at) || 0)) {
        lastCompleted = { id: titleId, name: titleName, at: completedAt };
      }
    }

    if (isInProgressSeriesState(stateData)) {
      const updatedAt = firstTimestamp(
        asObject(stateData?.seriesProgress)?.lastWatchedAt,
        stateData?.lastInteractionAt,
        stateData?.updatedAt
      );
      if (!inProgress || (toMillis(updatedAt) || 0) > (toMillis(inProgress.at) || 0)) {
        inProgress = { id: titleId, name: titleName, at: updatedAt };
      }
    }
  }

  const totalCount = titleIds.length;
  return {
    uid: memberId,
    displayName: safeString(userData?.displayName || "User", 120) || "User",
    photoURL: safeString(userData?.photoURL || userData?.avatarURL || "", 500) || null,
    completedCount,
    totalCount,
    percentComplete: totalCount > 0 ? Number((completedCount / totalCount).toFixed(4)) : 0,
    lastCompletedTitleId: lastCompleted?.id || null,
    lastCompletedTitleName: lastCompleted?.name || null,
    lastCompletedAt: lastCompleted?.at || null,
    inProgressTitleId: inProgress?.id || null,
    inProgressTitleName: inProgress?.name || null,
  };
}

async function recomputeUserListProgress({ db, listId, listData = null }) {
  const listRef = db.collection("userLists").doc(listId);
  const snapshot = listData ? { exists: true, data: () => listData } : await listRef.get();
  if (!snapshot.exists) {
    throw new functions.https.HttpsError("not-found", "Lista non trovata.");
  }

  const data = snapshot.data() || {};
  let titleIds = uniqueIdList(data.itemTitleIds);
  if (!titleIds.length) {
    const itemsSnap = await listRef.collection("items").orderBy("orderIndex").limit(400).get().catch(() => null);
    titleIds = itemsSnap ? uniqueIdList(itemsSnap.docs.map((docSnap) => docSnap.id)) : [];
  }
  const memberIds = uniqueIdList([data.ownerUid, ...safeArray(data.memberUids)]);

  const [titleMap, userMap, existingProgressSnap] = await Promise.all([
    fetchDocumentMapById(db.collection("titles"), titleIds),
    fetchDocumentMapById(db.collection("users"), memberIds),
    listRef.collection("progress").get(),
  ]);

  let batch = db.batch();
  let ops = 0;
  const flushBatch = async () => {
    if (!ops) return;
    await batch.commit();
    batch = db.batch();
    ops = 0;
  };

  const existingProgressIds = new Set(existingProgressSnap.docs.map((docSnap) => docSnap.id));

  for (const memberId of memberIds) {
    const stateMap = await fetchUserTitleStateMap(db, memberId, titleIds);
    const summary = summarizeMemberListProgress({
      memberId,
      titleIds,
      titleMap,
      stateMap,
      userData: userMap.get(memberId),
    });

    batch.set(listRef.collection("progress").doc(memberId), {
      ...summary,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    ops += 1;
    existingProgressIds.delete(memberId);

    if (ops >= 350) {
      await flushBatch();
    }
  }

  for (const staleId of existingProgressIds) {
    batch.delete(listRef.collection("progress").doc(staleId));
    ops += 1;
    if (ops >= 350) {
      await flushBatch();
    }
  }

  await flushBatch();

  return {
    listId,
    memberCount: memberIds.length,
    titleCount: titleIds.length,
  };
}

async function recomputeUserListItemSummary(db, listId) {
  const listRef = db.collection("userLists").doc(listId);
  const listSnap = await listRef.get();
  if (!listSnap.exists) return { exists: false };

  const itemsSnap = await listRef.collection("items")
    .orderBy("orderIndex")
    .limit(500)
    .get();
  const itemTitleIds = uniqueIdList(itemsSnap.docs.map((docSnap) => docSnap.id));
  const previewTitleIds = itemTitleIds.slice(0, 4);
  const listData = listSnap.data() || {};
  const currentCover = asObject(listData.cover);
  const nextCover = {
    imageUrl: currentCover.imageUrl || currentCover.imageURL || null,
    storagePath: currentCover.storagePath || null,
    fallbackTitleIds: previewTitleIds,
    accentHex: currentCover.accentHex || null,
  };

  await listRef.set({
    itemTitleIds,
    previewTitleIds,
    itemCount: itemTitleIds.length,
    cover: nextCover,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  return { exists: true, itemCount: itemTitleIds.length };
}

exports.recomputeListProgress = functions
  .runWith({ timeoutSeconds: 120, memory: "512MB" })
  .region("europe-west1")
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid || null;
    if (!uid) {
      throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
    }

    const db = admin.firestore();
    await enforceCallableRateLimit(db, uid, "recomputeListProgress", {
      windowSeconds: 20,
      maxInWindow: 4,
      dailyMax: 120,
    });
    const listId = toId(data?.listId);
    if (!listId) {
      throw new functions.https.HttpsError("invalid-argument", "listId mancante.");
    }

    const listSnap = await db.collection("userLists").doc(listId).get();
    if (!listSnap.exists) {
      throw new functions.https.HttpsError("not-found", "Lista non trovata.");
    }

    const listData = listSnap.data() || {};
    const callerIsAdmin = await isAdminCaller(db, uid);
    const memberIds = uniqueIdList([listData.ownerUid, ...safeArray(listData.memberUids)]);
    const editorIds = uniqueIdList([listData.ownerUid, ...safeArray(listData.editorUids)]);
    const canEdit = callerIsAdmin
      || editorIds.includes(uid);
    if (!canEdit) {
      throw new functions.https.HttpsError("permission-denied", "Non puoi aggiornare questa lista.");
    }

    const canRead = callerIsAdmin
      || safeString(listData.visibility || "", 20) === "public"
      || memberIds.includes(uid);
    if (!canRead) {
      throw new functions.https.HttpsError("permission-denied", "Non puoi leggere questa lista.");
    }

    const result = await recomputeUserListProgress({ db, listId, listData });
    return { ok: true, ...result };
  });

exports.uploadUserListCover = functions
  .runWith({ timeoutSeconds: 120, memory: "512MB" })
  .region("europe-west1")
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid || null;
    if (!uid) {
      throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
    }

    const db = admin.firestore();
    await enforceCallableRateLimit(db, uid, "uploadUserListCover", {
      windowSeconds: 60,
      maxInWindow: 4,
      dailyMax: 80,
    });

    const listId = toId(data?.listId);
    if (!listId) {
      throw new functions.https.HttpsError("invalid-argument", "listId mancante.");
    }

    const parsedImage = parseBase64JpegPayload(data?.imageBase64);
    if (!parsedImage || !parsedImage.buffer?.length) {
      throw new functions.https.HttpsError("invalid-argument", "Immagine cover non valida.");
    }

    if (parsedImage.buffer.length > 6 * 1024 * 1024) {
      throw new functions.https.HttpsError("invalid-argument", "Immagine cover troppo grande.");
    }

    const listRef = db.collection("userLists").doc(listId);
    const listSnap = await listRef.get();
    if (!listSnap.exists) {
      throw new functions.https.HttpsError("not-found", "Lista non trovata.");
    }

    const listData = listSnap.data() || {};
    const callerIsAdmin = await isAdminCaller(db, uid);
    const canChangeCover = callerIsAdmin || toId(listData.ownerUid) === uid;
    if (!canChangeCover) {
      throw new functions.https.HttpsError("permission-denied", "Non puoi modificare la cover di questa lista.");
    }

    const nextPath = `listCovers/${listId}/cover.jpg`;
    const previousCover = asObject(listData.cover);
    const previousPath = String(previousCover.storagePath || "").trim();
    const bucket = admin.storage().bucket();
    const file = bucket.file(nextPath);
    const downloadToken = randomUUID();

    await file.save(parsedImage.buffer, {
      resumable: false,
      contentType: parsedImage.contentType,
      metadata: {
        contentType: parsedImage.contentType,
        cacheControl: "private, max-age=3600",
        metadata: {
          firebaseStorageDownloadTokens: downloadToken,
          listId,
          uploadedBy: uid,
        },
      },
    });

    const imageUrl = buildFirebaseStorageDownloadUrl(bucket.name, nextPath, downloadToken);
    await listRef.set({
      cover: {
        imageUrl,
        storagePath: nextPath,
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    if (previousPath && previousPath !== nextPath && previousPath.startsWith("listCovers/")) {
      await bucket.file(previousPath).delete({ ignoreNotFound: true }).catch(() => {});
    }

    return {
      ok: true,
      storagePath: nextPath,
      imageUrl,
    };
  });

exports.deleteMyAccount = functions
  .runWith({ timeoutSeconds: 540, memory: "1GB" })
  .region("europe-west1")
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid || null;
    if (!uid) {
      throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
    }

    const db = admin.firestore();
    const userRef = db.collection("users").doc(uid);
    const privateRef = db.collection("usersPrivate").doc(uid);
    const deletionRef = db.collection("accountDeletionRequests").doc(uid);
    const userSnap = await userRef.get().catch(() => null);
    const userData = userSnap?.data() || {};
    const startedAt = admin.firestore.FieldValue.serverTimestamp();

    if (data?.confirm !== true) {
      throw new functions.https.HttpsError("invalid-argument", "Conferma eliminazione mancante.");
    }
    const authTimeSeconds = Number(context.auth?.token?.auth_time || 0);
    const authAgeSeconds = Math.floor(Date.now() / 1000) - authTimeSeconds;
    if (!authTimeSeconds || authAgeSeconds > 10 * 60) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "auth/requires-recent-login: autenticati di nuovo prima di eliminare l'account."
      );
    }
    await enforceCallableRateLimit(db, uid, "deleteMyAccount", {
      windowSeconds: 10 * 60,
      maxInWindow: 1,
      dailyMax: 2,
    });
    if (userData.isAdmin === true || getAdminUids().includes(uid)) {
      throw new functions.https.HttpsError("permission-denied", "Gli account admin non possono essere eliminati da questa schermata.");
    }

    await deletionRef.set({
      uid,
      status: "processing",
      source: "self-serve",
      requestedAt: startedAt,
      updatedAt: startedAt,
    }, { merge: true });

    const deleteQueryDocs = async (queryFactory) => {
      let deleted = 0;
      for (;;) {
        const snap = await queryFactory().limit(200).get();
        if (snap.empty) break;
        const batch = db.batch();
        snap.docs.forEach((docSnap) => batch.delete(docSnap.ref));
        await batch.commit();
        deleted += snap.size;
        if (snap.size < 200) break;
      }
      return deleted;
    };

    const anonymizeQueryDocs = async (queryFactory, patch) => {
      let updated = 0;
      for (;;) {
        const snap = await queryFactory().limit(200).get();
        if (snap.empty) break;
        const batch = db.batch();
        snap.docs.forEach((docSnap) => batch.update(docSnap.ref, patch));
        await batch.commit();
        updated += snap.size;
        if (snap.size < 200) break;
      }
      return updated;
    };

    const deleteSocialMirrorDocs = async (subcollection, mirrorSubcollection) => {
      const snap = await userRef.collection(subcollection).get().catch(() => ({ docs: [] }));
      if (!snap.docs?.length) return 0;

      let deleted = 0;
      let batch = db.batch();
      let ops = 0;
      const flush = async () => {
        if (!ops) return;
        await batch.commit();
        batch = db.batch();
        ops = 0;
      };

      for (const docSnap of snap.docs) {
        const otherUid = String(docSnap.id || "").trim();
        if (!otherUid) continue;
        batch.delete(docSnap.ref);
        ops += 1;
        batch.delete(db.collection("users").doc(otherUid).collection(mirrorSubcollection).doc(uid));
        ops += 1;
        deleted += 2;
        if (ops >= 350) {
          await flush();
        }
      }

      await flush();
      return deleted;
    };

    let deletedRatings = 0;
    let deletedRecommendations = 0;
    let deletedSocialEdges = 0;

    try {
      deletedSocialEdges += await deleteSocialMirrorDocs("friends", "friends");
      deletedSocialEdges += await deleteSocialMirrorDocs("following", "followers");
      deletedSocialEdges += await deleteSocialMirrorDocs("followers", "following");

      deletedRatings = await deleteQueryDocs(() =>
        db.collection("ratings").where("uid", "==", uid)
      );

      deletedRecommendations += await deleteQueryDocs(() =>
        db.collection("recommendations").where("fromUid", "==", uid)
      );

      deletedRecommendations += await deleteQueryDocs(() =>
        db.collection("recommendations").where("toUid", "==", uid)
      );

      for (const subcollection of [
        "watchlist",
        "library",
        "savedLists",
        "listProgressEntries",
        "titleStates",
        "imports",
        "_system",
        "matchFeedback",
        "notificationTokens",
        "notifications",
        "onboardingTelemetry",
        "feedEvents",
        "signals",
        "friends",
        "following",
        "followers",
        "quizStats",
        "quizAttempts",
        "episodeViews",
        "derivedRatings",
        "tasteProfile",
        "blockedUsers",
        "reports",
        "rateLimits",
        "experiments",
      ]) {
        await db.recursiveDelete(userRef.collection(subcollection));
      }

      // --- PII aggiuntiva (GDPR art. 17): contenuti social/quiz/liste,
      // file Storage, reservation username. Ogni blocco e' best-effort e
      // isolato: un indice mancante o un errore non deve abortire la
      // cancellazione core (tombstone + auth.deleteUser sotto).
      let deletedPosts = 0;
      let anonymizedMessages = 0;
      let anonymizedComments = 0;
      let deletedFeed = 0;
      let deletedChallenges = 0;
      let deletedLists = 0;
      let storageCleared = false;
      let usernameReleased = false;

      // Post dell'utente + comments/likes/reactions (subtree via recursiveDelete).
      for (;;) {
        const snap = await db.collection("posts").where("authorUid", "==", uid).limit(100).get();
        if (snap.empty) break;
        for (const d of snap.docs) { await db.recursiveDelete(d.ref); deletedPosts += 1; }
        if (snap.size < 100) break;
      }

      // Messaggi e commenti condivisi restano leggibili per gli altri partecipanti,
      // ma perdono ogni collegamento al profilo eliminato.
      anonymizedMessages = await anonymizeQueryDocs(
        () => db.collectionGroup("messages").where("uid", "==", uid),
        { uid: "deleted-user", displayName: "Utente eliminato" }
      );
      anonymizedComments = await anonymizeQueryDocs(
        () => db.collectionGroup("comments").where("uid", "==", uid),
        { uid: "deleted-user", authorName: "Utente eliminato" }
      );

      // Reazioni e condivisioni non sono necessarie all'integrita' del contenuto.
      await deleteQueryDocs(() => db.collectionGroup("likes").where("uid", "==", uid));
      await deleteQueryDocs(() => db.collectionGroup("shares").where("uid", "==", uid));

      await deleteQueryDocs(() => db.collection("titleEmotions").where("uid", "==", uid));
      await deleteQueryDocs(() => db.collection("episodeEmotions").where("uid", "==", uid));

      // Le segnalazioni vengono conservate per sicurezza, senza identita' del segnalante.
      await anonymizeQueryDocs(
        () => db.collection("reports").where("fromUid", "==", uid),
        { fromUid: "deleted-user" }
      );
      await anonymizeQueryDocs(
        () => db.collection("quizQuestionReports").where("reportedBy", "==", uid),
        { reportedBy: "deleted-user" }
      );

      // Eventi feed attivita'.
      deletedFeed = await deleteQueryDocs(() =>
        db.collection("ratingFeed").where("uid", "==", uid));

      // Sfide quiz (entrambi i lati).
      deletedChallenges += await deleteQueryDocs(() =>
        db.collection("quizChallenges").where("fromUid", "==", uid));
      deletedChallenges += await deleteQueryDocs(() =>
        db.collection("quizChallenges").where("toUid", "==", uid));

      // Liste possedute + sottoalberi (membri, cover).
      for (;;) {
        const snap = await db.collection("userLists").where("ownerUid", "==", uid).limit(100).get();
        if (snap.empty) break;
        for (const d of snap.docs) {
          const coverPath = String(d.data()?.cover?.storagePath || "").trim();
          if (coverPath.startsWith("listCovers/")) {
            await admin.storage().bucket().file(coverPath).delete({ ignoreNotFound: true });
          }
          await db.recursiveDelete(d.ref);
          deletedLists += 1;
        }
        if (snap.size < 100) break;
      }

      // Rimuove membership e progressi dalle liste possedute da altre persone.
      for (;;) {
        const snap = await db.collection("userLists").where("memberUids", "array-contains", uid).limit(100).get();
        if (snap.empty) break;
        for (const d of snap.docs) {
          const patch = {
            memberUids: admin.firestore.FieldValue.arrayRemove(uid),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          };
          if (Array.isArray(d.data()?.editorUids) && d.data().editorUids.includes(uid)) {
            patch.editorUids = admin.firestore.FieldValue.arrayRemove(uid);
          }
          if (Array.isArray(d.data()?.viewerUids) && d.data().viewerUids.includes(uid)) {
            patch.viewerUids = admin.firestore.FieldValue.arrayRemove(uid);
          }
          await d.ref.update(patch);
          await d.ref.collection("members").doc(uid).delete().catch(() => {});
          await d.ref.collection("progress").doc(uid).delete().catch(() => {});
        }
        if (snap.size < 100) break;
      }

      // Thread condivisi: rimuove il partecipante e anonimizza i riferimenti root.
      for (;;) {
        const snap = await db.collection("threads").where("participants", "array-contains", uid).limit(100).get();
        if (snap.empty) break;
        for (const d of snap.docs) {
          const data = d.data() || {};
          const patch = { participants: admin.firestore.FieldValue.arrayRemove(uid) };
          if (data.createdBy === uid) patch.createdBy = "deleted-user";
          if (data.lastSenderUid === uid) patch.lastSenderUid = "deleted-user";
          await d.ref.update(patch);
        }
        if (snap.size < 100) break;
      }
      await anonymizeQueryDocs(
        () => db.collection("threads").where("createdBy", "==", uid),
        { createdBy: "deleted-user" }
      );

      // Snapshot di post condivisi e inviti quiz conservati senza identita'.
      await anonymizeQueryDocs(
        () => db.collection("posts").where("sharedPost.authorUid", "==", uid),
        { "sharedPost.authorUid": "deleted-user", "sharedPost.authorName": "Utente eliminato" }
      );
      await anonymizeQueryDocs(
        () => db.collection("quizInvites").where("createdByUid", "==", uid),
        { createdByUid: "deleted-user", inviterDisplayName: "Utente eliminato" }
      );
      await anonymizeQueryDocs(
        () => db.collection("quizInvites").where("claimedByUid", "==", uid),
        { claimedByUid: "deleted-user" }
      );

      // Reservation username (doc id = displayNameLower) -> libera l'handle.
      try {
        const handle = String(userData.displayNameLower || "").trim();
        if (handle) { await db.collection("usernames").doc(handle).delete(); usernameReleased = true; }
      } catch (e) { logger.warn("[account-delete] username", { uid, error: e?.message }); }

      // Leaderboard denormalizzati legacy (doc id = uid): contengono il displayName -> PII.
      try {
        await db.collection("leaderboard_weekly").doc(uid).delete().catch(() => {});
        await db.collection("leaderboard_allTime").doc(uid).delete().catch(() => {});
      } catch (e) { logger.warn("[account-delete] leaderboard", { uid, error: e?.message }); }

      // Tentativi DM verso profili guidati, loggati con fromUid = utente reale.
      try {
        for (;;) {
          const snap = await db.collection("guidedDmAttempts").where("fromUid", "==", uid).limit(200).get();
          if (snap.empty) break;
          const batch = db.batch();
          snap.docs.forEach((d) => batch.delete(d.ref));
          await batch.commit();
          if (snap.size < 200) break;
        }
      } catch (e) { logger.warn("[account-delete] guidedDmAttempts", { uid, error: e?.message }); }

      // Coda moderazione (spoiler suspect): conserva preview (280 char di
      // contenuto utente) + authorUid -> PII residua dopo la cancellazione.
      try {
        await deleteQueryDocs(() => db.collection("moderationQueue").where("authorUid", "==", uid));
      } catch (e) { logger.warn("[account-delete] moderationQueue", { uid, error: e?.message }); }

      // File Storage personali, inclusi import manuali/supporto e path legacy.
      const bucket = admin.storage().bucket();
      for (const prefix of [
        `avatars/${uid}/`,
        `reviewPhotos/${uid}/`,
        `posters/${uid}/`,
        `manualImports/${uid}/`,
        `supportImports/${uid}/`,
        `users/${uid}/`,
      ]) {
        await bucket.deleteFiles({ prefix, force: true });
      }
      storageCleared = true;

      const createdAt = userData.createdAt || admin.firestore.FieldValue.serverTimestamp();
      await userRef.set({
        displayName: "Deleted user",
        displayNameLower: "deleted user",
        photoURL: "",
        avatarURL: "",
        createdAt,
        lastActiveAt: admin.firestore.FieldValue.serverTimestamp(),
        privacyDefault: "private",
        trusted: false,
        isAdmin: false,
        isDeleted: true,
        deletedAt: admin.firestore.FieldValue.serverTimestamp(),
        level: "base",
        favoriteGenres: [],
        stats: {
          ratingsCount: 0,
          reviewsCount: 0,
          watchedCount: 0,
          totalWatchMinutes: 0,
          rewatchCount: 0,
        },
      });
      await db.recursiveDelete(privateRef);
      await deletionRef.set({
        status: "ready_for_auth_delete",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      await admin.auth().deleteUser(uid);

      await deletionRef.set({
        status: "completed",
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        deletedRatings,
        deletedRecommendations,
        deletedSocialEdges,
        deletedPosts,
        anonymizedMessages,
        anonymizedComments,
        deletedFeed,
        deletedChallenges,
        deletedLists,
        storageCleared,
        usernameReleased,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      return {
        ok: true,
        deletedRatings,
        deletedRecommendations,
        deletedSocialEdges,
        deletedPosts,
        anonymizedMessages,
        anonymizedComments,
        deletedFeed,
        deletedChallenges,
        deletedLists,
        storageCleared,
        usernameReleased,
      };
    } catch (err) {
      logger.error("[account-delete] failed", {
        uid,
        error: err?.message || String(err),
      });

      await deletionRef.set({
        status: "failed",
        error: err?.message || "unknown-error",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      throw new functions.https.HttpsError(
        "internal",
        "Impossibile completare la cancellazione account in questo momento."
      );
    }
  });

exports.migrateUserWatchlistV2 = functions
  .runWith({ timeoutSeconds: 540, memory: "1GB" })
  .region("europe-west1")
  .https.onCall(async (data, context) => {
    const callerUid = context.auth?.uid || null;
    if (!callerUid) {
      throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
    }

    const db = admin.firestore();
    await enforceCallableRateLimit(db, callerUid, "migrateUserWatchlistV2", {
      windowSeconds: 30,
      maxInWindow: 1,
      dailyMax: 8,
    });
    const targetUid = toId(data?.uid) || callerUid;
    const force = data?.force === true;
    const callerIsAdmin = await isAdminCaller(db, callerUid);
    if (targetUid !== callerUid && !callerIsAdmin) {
      throw new functions.https.HttpsError("permission-denied", "Puoi migrare solo il tuo profilo.");
    }

    const migrationRef = db.collection("users").doc(targetUid).collection("_system").doc("watchlistV2");
    if (!force) {
      const migrationSnap = await migrationRef.get().catch(() => null);
      if (migrationSnap?.exists && toPositiveInt(migrationSnap.data()?.schemaVersion) >= WATCHLIST_V2_SCHEMA_VERSION) {
        return {
          migratedCount: 0,
          skippedCount: toPositiveInt(migrationSnap.data()?.lastSkippedCount),
          alreadyMigrated: true,
        };
      }
    }

    const userRef = db.collection("users").doc(targetUid);
    const [watchlistSnap, librarySnap, ratingsSnap, existingStatesSnap] = await Promise.all([
      userRef.collection("watchlist").get().catch(() => ({ docs: [] })),
      userRef.collection("library").get().catch(() => ({ docs: [] })),
      db.collection("ratings").where("uid", "==", targetUid).where("level", "==", "title").get().catch(() => ({ docs: [] })),
      userRef.collection("titleStates").get().catch(() => ({ docs: [] })),
    ]);

    const watchMap = new Map(watchlistSnap.docs.map((docSnap) => [docSnap.id, docSnap.data() || {}]));
    const libraryMap = new Map(librarySnap.docs.map((docSnap) => [
      toId(docSnap.data()?.titleId) || docSnap.id,
      docSnap.data() || {},
    ]));
    const ratingMap = new Map();
    ratingsSnap.docs.forEach((docSnap) => {
      const row = docSnap.data() || {};
      const titleId = toId(row.titleId);
      if (!titleId) return;
      const existing = ratingMap.get(titleId);
      const existingMs = toMillis(existing?.updatedAt || existing?.createdAt);
      const nextMs = toMillis(row?.updatedAt || row?.createdAt);
      if (!existing || nextMs >= existingMs) {
        ratingMap.set(titleId, row);
      }
    });

    const existingStateIds = new Set(existingStatesSnap.docs.map((docSnap) => docSnap.id));
    const titleIds = uniqueIdList([
      ...watchMap.keys(),
      ...libraryMap.keys(),
      ...ratingMap.keys(),
    ]);
    const titleMap = await fetchDocumentMapById(db.collection("titles"), titleIds);

    let batch = db.batch();
    let ops = 0;
    let migratedCount = 0;
    let skippedCount = 0;
    const flushBatch = async () => {
      if (!ops) return;
      await batch.commit();
      batch = db.batch();
      ops = 0;
    };

    for (const titleId of titleIds) {
      if (!force && existingStateIds.has(titleId)) {
        skippedCount += 1;
        continue;
      }

      const payload = buildMigratedTitleState({
        titleId,
        title: titleMap.get(titleId),
        watchDoc: watchMap.get(titleId),
        libraryDoc: libraryMap.get(titleId),
        ratingDoc: ratingMap.get(titleId),
      });
      if (!payload) {
        skippedCount += 1;
        continue;
      }

      batch.set(userRef.collection("titleStates").doc(titleId), payload, { merge: true });
      ops += 1;
      migratedCount += 1;

      if (ops >= 350) {
        await flushBatch();
      }
    }

    batch.set(migrationRef, {
      schemaVersion: WATCHLIST_V2_SCHEMA_VERSION,
      lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
      lastRunBy: callerUid,
      lastForceRun: force,
      lastMigratedCount: migratedCount,
      lastSkippedCount: skippedCount,
    }, { merge: true });
    ops += 1;

    await flushBatch();

    return {
      migratedCount,
      skippedCount,
      alreadyMigrated: false,
    };
  });

exports.adminBackfillTitleMetadata = functions
  .runWith({ timeoutSeconds: 540, memory: "1GB" })
  .region("europe-west1")
  .https.onCall(async (data, context) => {
    const callerUid = context.auth?.uid || null;
    if (!callerUid) {
      throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
    }

    const db = admin.firestore();
    const callerIsAdmin = await isAdminCaller(db, callerUid);
    if (!callerIsAdmin) {
      throw new functions.https.HttpsError("permission-denied", "Solo admin.");
    }
    await enforceCallableRateLimit(db, callerUid, "adminBackfillTitleMetadata", {
      windowSeconds: 45,
      maxInWindow: 1,
      dailyMax: 20,
    });

    const limit = clamp(Number(data?.limit || 25), 1, 50);
    const startAfterId = toId(data?.startAfterId);
    const forceAll = data?.forceAll === true;
    const state = {
      maxApiCalls: Math.max(24, limit * 8),
      maxAttempts: 3,
    };

    let query = db.collection("titles").orderBy(admin.firestore.FieldPath.documentId()).limit(limit);
    if (startAfterId) {
      query = db.collection("titles")
        .orderBy(admin.firestore.FieldPath.documentId())
        .startAfter(startAfterId)
        .limit(limit);
    }

    const snapshot = await query.get();
    if (snapshot.empty) {
      return {
        scannedCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        nextCursor: null,
        message: "Nessun altro titolo da elaborare.",
      };
    }

    let batch = db.batch();
    let ops = 0;
    let scannedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    let nextCursor = null;
    const flushBatch = async () => {
      if (!ops) return;
      await batch.commit();
      batch = db.batch();
      ops = 0;
    };

    for (const docSnap of snapshot.docs) {
      scannedCount += 1;
      nextCursor = docSnap.id;
      const title = docSnap.data() || {};
      const sync = asObject(title.tmdbSync);

      if (sync.syncDisabled === true) {
        skippedCount += 1;
        continue;
      }
      if (!forceAll && toPositiveInt(sync.metadataBackfillVersion) >= TITLE_METADATA_BACKFILL_VERSION) {
        skippedCount += 1;
        continue;
      }
      if (safeString(title.status || "", 32) !== "approved") {
        skippedCount += 1;
        continue;
      }

      try {
        const target = await resolveTmdbTargetForTitle({ db, titleId: docSnap.id, title, state });
        if (!target?.tmdbId) {
          batch.set(docSnap.ref, {
            tmdbSync: {
              ...sync,
              metadataBackfillVersion: TITLE_METADATA_BACKFILL_VERSION,
              metadataBackfillAt: admin.firestore.FieldValue.serverTimestamp(),
              lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
              nextCheckAt: admin.firestore.Timestamp.fromMillis(Date.now() + TMDB_TITLE_REFRESH_INTERVAL_MS),
              lastStatus: "no_tmdb_match",
              lastError: "",
            },
          }, { merge: true });
          ops += 1;
          skippedCount += 1;
        } else {
          const detailsPath = target.mediaType === "tv" ? `/tv/${target.tmdbId}` : `/movie/${target.tmdbId}`;
          const detailsIt = await fetchTmdbCachedJson(detailsPath, {
            language: "it-IT",
            append_to_response: "credits,keywords,alternative_titles",
          }, {
            db,
            state,
            cacheScope: `metadataBackfillDetails_${target.mediaType}`,
            ttlSeconds: 7 * 24 * 60 * 60,
            allowStaleOnError: true,
          });

          let detailsEnPayload = null;
          if (!safeString(detailsIt?.data?.overview || "", 2200).trim()) {
            const detailsEn = await fetchTmdbCachedJson(detailsPath, {
              language: "en-US",
              append_to_response: "credits,keywords,alternative_titles",
            }, {
              db,
              state,
              cacheScope: `metadataBackfillDetailsEn_${target.mediaType}`,
              ttlSeconds: 14 * 24 * 60 * 60,
              allowStaleOnError: true,
            });
            detailsEnPayload = detailsEn?.data || null;
          }

          const { patch, changedFields } = buildTmdbTitleRefreshPatch({
            title,
            target,
            detailsIt: detailsIt?.data || {},
            detailsEn: detailsEnPayload,
          });

          const writePayload = {
            tmdbSync: {
              ...sync,
              metadataBackfillVersion: TITLE_METADATA_BACKFILL_VERSION,
              metadataBackfillAt: admin.firestore.FieldValue.serverTimestamp(),
              lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
              nextCheckAt: admin.firestore.Timestamp.fromMillis(Date.now() + TMDB_TITLE_REFRESH_INTERVAL_MS),
              lastStatus: "ok",
              lastError: "",
              lastTmdbId: target.tmdbId,
              lastMediaType: target.mediaType,
              lastChangedFields: changedFields.slice(0, 30),
            },
          };

          if (changedFields.length) {
            Object.assign(writePayload, patch);
            writePayload.updatedAt = admin.firestore.FieldValue.serverTimestamp();
            writePayload.tmdbSync.lastUpdatedAt = admin.firestore.FieldValue.serverTimestamp();
            updatedCount += 1;
          } else {
            skippedCount += 1;
          }

          batch.set(docSnap.ref, writePayload, { merge: true });
          ops += 1;
        }
      } catch (err) {
        logger.warn("[title-metadata-backfill] failed", {
          titleId: docSnap.id,
          message: safeString(err?.message || String(err), 220),
        });
        batch.set(docSnap.ref, {
          tmdbSync: {
            ...sync,
            metadataBackfillVersion: TITLE_METADATA_BACKFILL_VERSION,
            metadataBackfillAt: admin.firestore.FieldValue.serverTimestamp(),
            lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
            nextCheckAt: admin.firestore.Timestamp.fromMillis(Date.now() + TMDB_TITLE_REFRESH_RETRY_MS),
            lastStatus: "error",
            lastError: safeString(err?.message || String(err), 220),
          },
        }, { merge: true });
        ops += 1;
        skippedCount += 1;
      }

      if (ops >= 120) {
        await flushBatch();
      }
    }

    await flushBatch();

    return {
      scannedCount,
      updatedCount,
      skippedCount,
      nextCursor,
      message: updatedCount > 0
        ? `Aggiornati ${updatedCount} titoli.`
        : "Nessun aggiornamento necessario in questo batch.",
    };
  });

function sanitizeTmdbDiscoverRow(row, type) {
  const mediaType = type === "tv" ? "tv" : "movie";
  const tmdbId = Number(row?.id || 0);
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) return null;

  const name = safeString(mediaType === "tv" ? row?.name : row?.title, 160);
  if (!name) return null;

  const originalName = safeString(mediaType === "tv" ? row?.original_name : row?.original_title, 160) || null;
  const releaseDate = safeString(mediaType === "tv" ? row?.first_air_date : row?.release_date, 24) || null;
  const year = parseYearFromDate(releaseDate);
  const posterPathTmdb = safeString(row?.poster_path, 240) || null;
  if (!posterPathTmdb || !posterPathTmdb.startsWith("/")) return null;

  return {
    type: mediaType,
    tmdbId,
    name,
    originalName,
    releaseDate,
    year,
    overview: safeString(row?.overview, 2000) || "",
    genreIds: safeArray(row?.genre_ids).map((x) => Number(x)).filter((x) => Number.isFinite(x)),
    popularity: Number(row?.popularity || 0) || 0,
    voteAverage: Number(row?.vote_average || 0) || 0,
    voteCount: Number(row?.vote_count || 0) || 0,
  };
}

function parseLooseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {}
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (_) {
    return null;
  }
}

async function findApprovedTitleByName(db, rawName) {
  const norm = normalizeText(rawName);
  if (!norm || norm.length < 2) return null;

  try {
    const prefixSnap = await db
      .collection("titles")
      .orderBy("nameLower")
      .startAt(norm)
      .endAt(`${norm}\uf8ff`)
      .limit(8)
      .get();

    if (!prefixSnap.empty) {
      const rows = prefixSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(x => x.status === "approved");
      if (rows.length) {
        rows.sort((a, b) => {
          const aName = String(a.nameLower || "");
          const bName = String(b.nameLower || "");
          const aScore = aName === norm ? 3 : (aName.startsWith(norm) ? 2 : (aName.includes(norm) ? 1 : 0));
          const bScore = bName === norm ? 3 : (bName.startsWith(norm) ? 2 : (bName.includes(norm) ? 1 : 0));
          if (aScore !== bScore) return bScore - aScore;
          return Number(b.ratingCount || 0) - Number(a.ratingCount || 0);
        });
        return rows[0];
      }
    }
  } catch (err) {
    logger.warn(`[ai] prefix title search failed: ${err.message}`);
  }

  const tokens = tokenizeNormalized(norm);
  if (!tokens.length) return null;
  try {
    const tokenSnap = await db
      .collection("titles")
      .where("search.tokens", "array-contains", tokens[0])
      .limit(10)
      .get();

    const rows = tokenSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(x => x.status === "approved");
    if (!rows.length) return null;

    rows.sort((a, b) => Number(b.ratingCount || 0) - Number(a.ratingCount || 0));
    return rows[0];
  } catch (err) {
    logger.warn(`[ai] token title search failed: ${err.message}`);
    return null;
  }
}

async function resolveSeedTitles(db, likedTitleIds, likedTitleNames) {
  const out = [];
  const seen = new Set();

  const uniqIds = Array.from(new Set(safeArray(likedTitleIds).map(x => String(x || "").trim()).filter(Boolean))).slice(0, 8);
  await Promise.all(uniqIds.map(async (id) => {
    try {
      const snap = await db.collection("titles").doc(id).get();
      if (!snap.exists) return;
      const data = snap.data() || {};
      if (data.status !== "approved") return;
      if (seen.has(snap.id)) return;
      seen.add(snap.id);
      out.push({ id: snap.id, ...data });
    } catch (_) {}
  }));

  const uniqNames = Array.from(new Set(safeArray(likedTitleNames).map(x => safeString(x, 80)).filter(Boolean))).slice(0, 8);
  for (const rawName of uniqNames) {
    if (out.length >= 8) break;
    const found = await findApprovedTitleByName(db, rawName);
    if (!found) continue;
    if (seen.has(found.id)) continue;
    seen.add(found.id);
    out.push(found);
  }

  return out.slice(0, 8);
}

function addCandidateDoc(candidateMap, docSnap) {
  const data = docSnap.data() || {};
  if (data.status !== "approved") return;
  candidateMap.set(docSnap.id, { id: docSnap.id, ...data });
}

async function collectCandidatePool(db, seedTitles, opts = {}) {
  const candidateMap = new Map();
  const popularLimit = clamp(Number(opts.popularLimit || 450), 60, 700);
  const recentLimit = clamp(Number(opts.recentLimit || 220), 60, 420);
  const genreLimit = clamp(Number(opts.genreLimit || 260), 70, 420);
  const tokenLimit = clamp(Number(opts.tokenLimit || 220), 70, 380);
  const relatedLimit = clamp(Number(opts.relatedLimit || 80), 20, 120);

  const tasks = [];
  tasks.push(
    db.collection("titles").orderBy("ratingCount", "desc").limit(popularLimit).get()
      .then((snap) => { snap.docs.forEach(d => addCandidateDoc(candidateMap, d)); })
      .catch((err) => logger.warn(`[ai] popular query failed: ${err.message}`))
  );
  tasks.push(
    db.collection("titles").orderBy("createdAt", "desc").limit(recentLimit).get()
      .then((snap) => { snap.docs.forEach(d => addCandidateDoc(candidateMap, d)); })
      .catch((err) => logger.warn(`[ai] recent query failed: ${err.message}`))
  );

  const topGenres = Array.from(new Set(
    seedTitles.flatMap(t => safeArray(t.genres)).filter(Boolean)
  )).slice(0, 10);
  if (topGenres.length) {
    tasks.push(
      db.collection("titles")
        .where("genres", "array-contains-any", topGenres)
        .limit(genreLimit)
        .get()
        .then((snap) => { snap.docs.forEach(d => addCandidateDoc(candidateMap, d)); })
        .catch((err) => logger.warn(`[ai] genres query failed: ${err.message}`))
    );
  }

  const seedTokens = Array.from(new Set(
    seedTitles.flatMap(t => tokenizeNormalized([t.name, t.originalName, t.description].join(" ")))
  )).slice(0, 10);
  if (seedTokens.length) {
    tasks.push(
      db.collection("titles")
        .where("search.tokens", "array-contains-any", seedTokens)
        .limit(tokenLimit)
        .get()
        .then((snap) => { snap.docs.forEach(d => addCandidateDoc(candidateMap, d)); })
        .catch((err) => logger.warn(`[ai] tokens query failed: ${err.message}`))
    );
  }

  const relatedIds = Array.from(new Set(
    seedTitles.flatMap(t => safeArray(t.related)).map(x => String(x || "").trim()).filter(Boolean)
  )).slice(0, relatedLimit);
  for (const rid of relatedIds) {
    tasks.push(
      db.collection("titles").doc(rid).get()
        .then((snap) => { if (snap.exists) addCandidateDoc(candidateMap, snap); })
        .catch(() => {})
    );
  }

  // Le letture dirette dei correlati non dipendono dalle query popolare/recenti:
  // eseguirle nello stesso round elimina una latenza seriale dal percorso Match.
  await Promise.all(tasks);

  return candidateMap;
}

async function loadUserSeenTitleIds(db, uid) {
  const ids = new Set();

  try {
    const libSnap = await db.collection("users").doc(uid).collection("library").limit(700).get();
    libSnap.docs.forEach((d) => {
      const data = d.data() || {};
      const titleId = String(data.titleId || d.id || "").trim();
      if (titleId) ids.add(titleId);
    });
  } catch (err) {
    logger.warn(`[ai] library load failed for uid=${uid}: ${err.message}`);
  }

  try {
    const ratingSnap = await db.collection("ratings").where("uid", "==", uid).limit(700).get();
    ratingSnap.docs.forEach((d) => {
      const titleId = String(d.data()?.titleId || "").trim();
      if (titleId) ids.add(titleId);
    });
  } catch (err) {
    logger.warn(`[ai] ratings load failed for uid=${uid}: ${err.message}`);
  }

  return ids;
}

async function loadTasteProfile(db, uid) {
  try {
    const snap = await db.collection("users").doc(uid).collection("tasteProfile").doc("agg").get();
    if (!snap.exists) return null;
    return buildTasteProfile(snap.data() || {}, Date.now());
  } catch (err) {
    logger.warn(`[match] loadTasteProfile failed uid=${uid}: ${err.message}`);
    return null;
  }
}

// Segnali collaborativi: LETTURA dell'indice precalcolato.
//
// Prima questa funzione ricalcolava tutto a ogni richiesta: per 5 seed leggeva
// `ratings` (cap 320 doc l'uno), poi i voti dei 24 utenti piu' simili (cap 220
// l'uno) — fino a ~6.900 letture per singola apertura di Match, con un costo che
// cresceva insieme a catalogo e utenti. Ora legge un doc per seed
// (`titles/{id}/aggregates/similar`), scritto dal job rebuildTitleSimilarities:
// **al massimo 8 letture**, e il costo per richiesta non dipende piu' da quanto
// cresce il resto.
//
// La matematica sta in lib/itemSimilarity.js, condivisa col benchmark offline:
// con gli stessi 8 seed il benchmark corretto misura NDCG@10 0.097 -> 0.147.
async function computeCollaborativeSignals(db, seedTitles, currentUid, excludedIds) {
  const seedIds = Array.from(new Set(
    safeArray(seedTitles).map((t) => toId(t?.id)).filter(Boolean)
  )).slice(0, MAX_COLLAB_SEEDS);
  if (!seedIds.length) return new Map();

  const snaps = await Promise.all(seedIds.map((seedId) =>
    db.collection("titles").doc(seedId).collection("aggregates").doc(TITLE_SIMILAR_DOC_ID).get()
      .catch((err) => {
        logger.warn(`[reco] similar read failed (${seedId}): ${err.message}`);
        return null;
      })
  ));

  const neighborsBySeed = new Map();
  snaps.forEach((snap, idx) => {
    if (!snap || !snap.exists) return;
    neighborsBySeed.set(seedIds[idx], safeArray((snap.data() || {}).neighbors));
  });
  if (!neighborsBySeed.size) return new Map();

  return collectCollabSignals(seedIds, (id) => neighborsBySeed.get(id), {
    maxSeeds: MAX_COLLAB_SEEDS,
    excludedIds,
  });
}

async function rerankCandidatesWithOpenAI({ seedTitles, likedTitleNames, prompt, candidates }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !candidates.length) return null;

  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const seedNames = seedTitles.map(t => t.name).filter(Boolean);
  const fallbackNames = safeArray(likedTitleNames).map(x => safeString(x, 80)).filter(Boolean);
  const profileTitles = seedNames.length ? seedNames : fallbackNames;
  if (!profileTitles.length) return null;

  const candidateRows = candidates.slice(0, 12).map((c) => {
    const genres = safeArray(c.genres).slice(0, 3).join("|");
    const desc = safeString(c.description || c.overview || "", 120);
    return `${c.id} :: ${safeString(c.name, 90)} :: ${c.year || "n/a"} :: ${c.type || "n/a"} :: ${genres} :: ${desc}`;
  });

  const systemPrompt = [
    "You are a recommendation ranker for a movie/tv app.",
    "Given user taste and candidate titles, return strict JSON:",
    "{\"rankedIds\":[\"id1\",\"id2\"],\"rationale\":\"short italian explanation\"}",
    "Use only candidate IDs present in the list.",
    "Prioritize semantic compatibility and variety.",
  ].join(" ");

  const userPrompt = [
    `Titoli preferiti: ${profileTitles.join(", ")}`,
    prompt ? `Contesto utente: ${safeString(prompt, 220)}` : "",
    "Candidate:",
    ...candidateRows.map(r => `- ${r}`),
  ].filter(Boolean).join("\n");

  const res = await withCircuitBreaker("openai", () => fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      max_tokens: 280,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  }), { failureThreshold: 3, coolDownMs: 10 * 60 * 1000 });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`OpenAI error ${res.status}: ${txt.slice(0, 180)}`);
  }

  const payload = await res.json();
  const content = payload?.choices?.[0]?.message?.content || "";
  const parsed = parseLooseJson(content);
  if (!parsed) return null;

  const rawIds = safeArray(parsed.rankedIds || parsed.ranked_ids).map(x => String(x || "").trim()).filter(Boolean);
  if (!rawIds.length) return null;

  return {
    rankedIds: rawIds,
    rationale: safeString(parsed.rationale || parsed.reason || "", 240),
    model,
  };
}

async function loadUserMatchSignals(db, uid) {
  const likedIds = new Set();
  const skippedRecentIds = new Set();
  const shownRecentIds = new Set();
  const seedScores = new Map();
  const nowMs = Date.now();

  try {
    const snap = await db
      .collection("users")
      .doc(uid)
      .collection("matchFeedback")
      .limit(MATCH_FEEDBACK_SCAN_MAX)
      .get();

    for (const docSnap of snap.docs) {
      const row = docSnap.data() || {};
      const titleId = toId(row.titleId || docSnap.id);
      if (!titleId) continue;

      const action = String(row.action || "").trim().toLowerCase();
      const actionMs = Math.max(toMillis(row.actionAt), toMillis(row.updatedAt));
      const shownMs = Math.max(toMillis(row.shownAt), toMillis(row.updatedAt));

      if (action === "like") {
        likedIds.add(titleId);
        addSeedScore(seedScores, titleId, 2.5);
      } else if (action === "superlike") {
        likedIds.add(titleId);
        addSeedScore(seedScores, titleId, 3.7);
      } else if (action === "skip") {
        if (!actionMs || (nowMs - actionMs) <= MATCH_SKIP_COOLDOWN_MS) {
          skippedRecentIds.add(titleId);
        }
      }

      if (shownMs && action !== "like" && action !== "superlike") {
        shownRecentIds.add(titleId);
      }
    }
  } catch (err) {
    logger.warn(`[match] feedback load failed for uid=${uid}: ${err.message}`);
  }

  return { likedIds, skippedRecentIds, shownRecentIds, seedScores };
}

async function loadUserWatchlistSignals(db, uid) {
  const ids = new Set();
  const seedScores = new Map();

  try {
    const snap = await db
      .collection("users")
      .doc(uid)
      .collection("watchlist")
      .limit(500)
      .get();

    for (const docSnap of snap.docs) {
      const row = docSnap.data() || {};
      const fallbackId = docSnap.id.startsWith("pending_") ? "" : docSnap.id;
      const titleId = toId(row.titleId || fallbackId);
      if (!titleId) continue;

      ids.add(titleId);
      const priority = String(row.priority || "normal").trim().toLowerCase();
      let score = 1.2;
      if (priority === "high") score += 0.7;
      if (priority === "low") score -= 0.2;
      addSeedScore(seedScores, titleId, score);
    }
  } catch (err) {
    logger.warn(`[match] watchlist load failed for uid=${uid}: ${err.message}`);
  }

  return { ids, seedScores };
}

async function loadUserRatingSeedScores(db, uid) {
  const scoreMap = new Map();
  const nowMs = Date.now();

  try {
    const snap = await db
      .collection("ratings")
      .where("uid", "==", uid)
      .where("level", "==", "title")
      .limit(520)
      .get();

    for (const docSnap of snap.docs) {
      const row = docSnap.data() || {};
      const titleId = toId(row.titleId);
      const rating = Number(row.rating || 0);
      if (!titleId || !Number.isFinite(rating) || rating < 6) continue;

      const tsMs = Math.max(toMillis(row.updatedAt), toMillis(row.createdAt));
      const recencyBoost = tsMs
        ? clamp(1 - ((nowMs - tsMs) / MATCH_SEED_RECENCY_MS), 0, 1)
        : 0;

      const score = ((rating - 5) * 1.45) + (recencyBoost * 1.2);
      addSeedScore(scoreMap, titleId, score);
    }
  } catch (err) {
    logger.warn(`[match] rating seeds load failed for uid=${uid}: ${err.message}`);
  }

  return scoreMap;
}

async function loadUserLibrarySeedScores(db, uid) {
  const scoreMap = new Map();
  let docs = [];

  try {
    const orderedSnap = await db
      .collection("users")
      .doc(uid)
      .collection("library")
      .orderBy("updatedAt", "desc")
      .limit(340)
      .get();
    docs = orderedSnap.docs;
  } catch (err) {
    logger.warn(`[match] ordered library query failed for uid=${uid}: ${err.message}`);
    try {
      const fallbackSnap = await db
        .collection("users")
        .doc(uid)
        .collection("library")
        .limit(340)
        .get();
      docs = fallbackSnap.docs;
    } catch (innerErr) {
      logger.warn(`[match] fallback library query failed for uid=${uid}: ${innerErr.message}`);
      return scoreMap;
    }
  }

  for (let i = 0; i < docs.length; i++) {
    const docSnap = docs[i];
    const row = docSnap.data() || {};
    const titleId = toId(row.titleId || docSnap.id);
    if (!titleId) continue;

    const freshness = clamp(1 - (i / 220), 0, 1);
    addSeedScore(scoreMap, titleId, 0.65 + (freshness * 0.8));
  }

  return scoreMap;
}

// Titoli scelti nell'onboarding (usersPrivate/{uid}.tasteProfile): segnale di
// gusto esplicito che fa partire Match personalizzato dal primo accesso,
// prima ancora che l'utente abbia votato o riempito la watchlist.
async function loadOnboardingSeedScores(db, uid) {
  const scoreMap = new Map();
  try {
    const snap = await db.collection("usersPrivate").doc(uid).get();
    const taste = (snap.data() || {}).tasteProfile || {};
    for (const id of safeArray(taste.seedTitleIds)) {
      const titleId = toId(id);
      if (titleId) addSeedScore(scoreMap, titleId, 2.2);
    }
    for (const id of safeArray(taste.seedLikedTitleIds)) {
      const titleId = toId(id);
      if (titleId) addSeedScore(scoreMap, titleId, 1.3);
    }
  } catch (err) {
    logger.warn(`[match] onboarding seeds load failed for uid=${uid}: ${err.message}`);
  }
  return scoreMap;
}

async function loadMatchSeedTitleIds(db, uid, opts = {}) {
  const [ratingSeeds, librarySeeds, onboardingSeeds] = await Promise.all([
    loadUserRatingSeedScores(db, uid),
    loadUserLibrarySeedScores(db, uid),
    loadOnboardingSeedScores(db, uid),
  ]);

  const merged = new Map();
  mergeSeedScores(merged, ratingSeeds, 1);
  mergeSeedScores(merged, librarySeeds, 1);
  mergeSeedScores(merged, onboardingSeeds, 1);
  mergeSeedScores(merged, opts.watchlistSeedScores, 0.92);
  mergeSeedScores(merged, opts.matchSeedScores, 1.1);

  const ranked = [...merged.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 42);

  return {
    seedIds: ranked.slice(0, 18).map(([titleId]) => titleId),
    seedScoreByTitle: new Map(ranked),
  };
}

// ============================================
// INDICE DI SIMILARITA' TITOLI (collaborativo precalcolato)
// ============================================

exports.rebuildTitleSimilarities = functions
  .region("europe-west1")
  .runWith({ memory: "2GB", timeoutSeconds: 540 })
  .pubsub.schedule("every 168 hours")
  .timeZone("Europe/Rome")
  .onRun(async () => {
    const db = admin.firestore();
    await rebuildTitleSimilarityIndex(db, admin, { dryRun: false });
    return null;
  });

exports.rebuildTitleSimilaritiesNow = functions
  .region("europe-west1")
  .runWith({ memory: "2GB", timeoutSeconds: 540 })
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid || null;
    if (!uid) throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
    const db = admin.firestore();
    if (!(await isAdminCaller(db, uid))) {
      throw new functions.https.HttpsError("permission-denied", "Solo gli admin possono ricostruire l'indice di similarita'.");
    }
    // Dry-run di default: una ricostruzione tocca migliaia di doc, non deve
    // partire per sbaglio.
    const dryRun = data?.dryRun !== false;
    return rebuildTitleSimilarityIndex(db, admin, { dryRun });
  });

exports.getMatchQueue = functions
  .region("europe-west1")
  .https.onCall(async (data, context) => {
    if (!context.auth?.uid) {
      throw new functions.https.HttpsError("unauthenticated", "Devi essere autenticato per usare Match Mode.");
    }

    const uid = context.auth.uid;
    const db = admin.firestore();
    await enforceCallableRateLimit(db, uid, "matchQueue", {
      windowSeconds: 12,
      maxInWindow: 3,
      dailyMax: 80,
    });
    const max = clamp(Number(data?.max || 18), 5, 36);
    const fastStart = data?.fastStart === true;
    const manualExcluded = new Set(
      safeArray(data?.excludeTitleIds)
        .map((x) => toId(x))
        .filter(Boolean)
        .slice(0, 600)
    );

    const [seenIds, matchSignals, watchlistSignals, genreLabelMap, tasteProfile] = await Promise.all([
      loadUserSeenTitleIds(db, uid),
      loadUserMatchSignals(db, uid),
      loadUserWatchlistSignals(db, uid),
      loadGenreLabelMap(db),
      loadTasteProfile(db, uid),
    ]);

    const seedInfo = await loadMatchSeedTitleIds(db, uid, {
      watchlistSeedScores: watchlistSignals.seedScores,
      matchSeedScores: matchSignals.seedScores,
    });

    const seedTitles = await resolveSeedTitles(db, seedInfo.seedIds, []);
    const peopleAffinity = buildPeopleAffinity(seedTitles, seedInfo.seedScoreByTitle);
    const providerAffinity = buildProviderAffinity(seedTitles, seedInfo.seedScoreByTitle);

    const excludedIds = new Set([
      ...Array.from(manualExcluded),
      ...Array.from(seenIds),
      ...Array.from(watchlistSignals.ids),
      ...Array.from(matchSignals.likedIds),
      ...Array.from(matchSignals.skippedRecentIds),
      ...Array.from(matchSignals.shownRecentIds),
      ...seedTitles.map((t) => toId(t.id)),
    ]);

    const [candidateMap, collabSignals] = await Promise.all([
      collectCandidatePool(
        db,
        seedTitles,
        fastStart
          ? { popularLimit: 170, recentLimit: 95, genreLimit: 140, tokenLimit: 120, relatedLimit: 36 }
          : { popularLimit: 360, recentLimit: 180, genreLimit: 240, tokenLimit: 210, relatedLimit: 70 }
      ),
      computeCollaborativeSignals(db, seedTitles, uid, excludedIds),
    ]);
    const hasCollab = collabSignals.size > 0;
    const seedStats = buildSeedStats(seedTitles, { genreLabelMap });

    // Scoring + fallback popolare: corpo estratto in lib/recommendationEngine.js
    // cosi' il benchmark offline puo' far girare la STESSA pipeline.
    const { scored, isColdStart, hasTasteBias, confidenceScore } = rankMatchCandidates({
      candidates: candidateMap,
      excludedIds,
      seedStats,
      seedCount: seedTitles.length,
      peopleAffinity,
      tasteProfile,
      collabSignals,
      providerAffinity,
      genreLabelMap,
      max,
    });

    const ranked = pickMatchDeck(scored, max);
    const topScore = Number(ranked[0]?._score || 0);
    const items = ranked.map((row) => mapMatchTitle(row, topScore));
    const providerLane = selectProviderRecommendationLane(scored, providerAffinity, 10);

    const hints = [];
    if (hasCollab) hints.push("segnali collaborativi attivi");
    if (hasTasteBias) hints.push(`taste profile decayato (conf ${Math.round(confidenceScore)})`);
    if (providerLane) hints.push(`affinità piattaforma ${providerLane.provider.name}`);
    if (isColdStart) hints.push("modalità discovery (cold start)");
    hints.push("diversità di genere e formato");
    hints.push("evita sequel consecutivi");
    hints.push("esplorazione controllata");

    const engineParts = ["hybrid"];
    if (hasCollab) engineParts.push("collab");
    if (hasTasteBias) engineParts.push("taste");
    if (isColdStart) engineParts.push("cold");

    return {
      engine: engineParts.join("+"),
      rationale: hints.join(" • "),
      items,
      providerLane,
      seedCount: seedTitles.length,
      poolCount: candidateMap.size,
      generatedAtMs: Date.now(),
    };
  });

exports.recommendTitlesByTaste = functions
  .region("europe-west1")
  .https.onCall(async (data, context) => {
    if (!context.auth?.uid) {
      throw new functions.https.HttpsError("unauthenticated", "Devi essere autenticato per usare i consigli AI.");
    }

    const uid = context.auth.uid;
    const db = admin.firestore();
    await enforceCallableRateLimit(db, uid, "aiRecommendations", {
      windowSeconds: 15,
      maxInWindow: 3,
      dailyMax: 60,
    });

    const likedTitleIds = safeArray(data?.likedTitleIds).map(x => String(x || "").trim()).filter(Boolean).slice(0, 8);
    const likedTitleNames = safeArray(data?.likedTitleNames).map(x => safeString(x, 80)).filter(Boolean).slice(0, 8);
    const excludeTitleIds = safeArray(data?.excludeTitleIds).map(x => String(x || "").trim()).filter(Boolean).slice(0, 240);
    const preferredTypeRaw = String(data?.preferredType || "all").trim().toLowerCase();
    const preferredType = ["movie", "tv"].includes(preferredTypeRaw) ? preferredTypeRaw : "all";
    const decadeRaw = String(data?.decade || "all").trim();
    const decadeWindow = parseDecadeWindow(decadeRaw);
    const moodRaw = String(data?.mood || "all").trim().toLowerCase();
    const mood = ["all", "light", "intense", "mind"].includes(moodRaw) ? moodRaw : "all";
    const prompt = safeString(data?.prompt || "", 280);
    const max = clamp(Number(data?.max || 5), 3, 10);

    if (!likedTitleIds.length && !likedTitleNames.length && !prompt) {
      throw new functions.https.HttpsError("invalid-argument", "Inserisci almeno un titolo di partenza.");
    }

    const seedTitles = await resolveSeedTitles(db, likedTitleIds, likedTitleNames);
    if (!seedTitles.length) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Non sono riuscito a trovare titoli validi da usare come base."
      );
    }
    if (seedTitles.length < 3) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Seleziona almeno 3 titoli per avere suggerimenti affidabili."
      );
    }

    const manualExcludedIds = new Set(excludeTitleIds);

    const [candidateMap, seenIds, genreLabelMap] = await Promise.all([
      collectCandidatePool(db, seedTitles),
      loadUserSeenTitleIds(db, uid),
      loadGenreLabelMap(db),
    ]);

    const excludedIds = new Set([
      ...seedTitles.map(t => String(t.id)),
      ...Array.from(seenIds),
      ...Array.from(manualExcludedIds),
    ]);

    const collabSignals = await computeCollaborativeSignals(db, seedTitles, uid, excludedIds);
    const hasCollab = collabSignals.size > 0;
    const seedStats = buildSeedStats(seedTitles, { genreLabelMap });
    const scored = [];
    for (const candidate of candidateMap.values()) {
      if (!candidate?.id) continue;
      if (excludedIds.has(String(candidate.id))) continue;
      if (preferredType !== "all" && String(candidate.type || "") !== preferredType) continue;
      if (!yearInsideDecade(candidate.year, decadeWindow)) continue;

      const collab = collabSignals.get(String(candidate.id)) || null;
      const { score, reasons } = scoreCandidate(candidate, seedStats, { mood, collab, genreLabelMap });
      if (score <= 0.75) continue;
      scored.push({
        ...candidate,
        _score: score,
        _reasons: reasons,
      });
    }

    scored.sort((a, b) => b._score - a._score);
    let ranked = selectTopWithDiversity(scored, Math.max(max * 2, 12));
    let engine = hasCollab ? "hybrid+collab" : "hybrid";
    let rationale = "";

    if (process.env.OPENAI_API_KEY && ranked.length >= 4 && (prompt || likedTitleNames.length >= 2 || seedTitles.length >= 2)) {
      try {
        const semantic = await rerankCandidatesWithOpenAI({
          seedTitles,
          likedTitleNames,
          prompt,
          candidates: ranked,
        });

        if (semantic?.rankedIds?.length) {
          const byId = new Map(ranked.map(r => [String(r.id), r]));
          const semanticSorted = [];
          for (const rid of semantic.rankedIds) {
            const row = byId.get(String(rid));
            if (!row) continue;
            semanticSorted.push(row);
            byId.delete(String(rid));
          }
          for (const rest of byId.values()) semanticSorted.push(rest);
          ranked = semanticSorted;
          rationale = semantic.rationale || "";
          engine = "hybrid+semantic";
        }
      } catch (err) {
        logger.warn(`[ai] semantic rerank skipped: ${err.message}`);
      }
    }

    if (!rationale) {
      const hints = [];
      if (hasCollab) hints.push("segnali collaborativi attivi");
      if (preferredType !== "all") hints.push(preferredType === "tv" ? "focus serie" : "focus film");
      if (decadeWindow) hints.push(`decade ${decadeWindow.from}s`);
      if (mood !== "all") {
        const moodLabel = mood === "light" ? "mood leggero" : mood === "intense" ? "mood intenso" : "mood mind-bending";
        hints.push(moodLabel);
      }
      rationale = hints.length
        ? hints.join(" • ")
        : "ranking su generi, cast/regia, similarità contenuto e qualità titolo";
    }

    const items = ranked.slice(0, max).map(mapRecommendedTitle);

    return {
      engine,
      rationale,
      items,
      seedTitles: seedTitles.map(t => ({
        id: t.id,
        name: t.name || "",
        type: t.type || "",
        year: Number(t.year || 0) || null,
      })),
      generatedAtMs: Date.now(),
    };
  });

function analyticsTimestampMs(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
  }
  return toMillis(value);
}

function analyticsIso(value) {
  const ms = analyticsTimestampMs(value);
  return ms > 0 ? new Date(ms).toISOString() : null;
}

function analyticsLatestIso(...values) {
  const ms = values.map(analyticsTimestampMs).filter((n) => n > 0).sort((a, b) => b - a)[0] || 0;
  return ms > 0 ? new Date(ms).toISOString() : null;
}

function analyticsFirstIso(...values) {
  const ms = values.map(analyticsTimestampMs).filter((n) => n > 0).sort((a, b) => a - b)[0] || 0;
  return ms > 0 ? new Date(ms).toISOString() : null;
}

function normalizeAnalyticsEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function getPersonalAnalyticsAllowedEmail() {
  let raw = "";
  try {
    raw = String(PERSONAL_ANALYTICS_ALLOWED_EMAIL_PARAM.value() || "");
  } catch (_) {}
  if (!raw) raw = String(process.env.PERSONAL_ANALYTICS_ALLOWED_EMAIL || "");
  return normalizeAnalyticsEmail(raw);
}

async function assertPersonalAnalyticsAccess(context) {
  const uid = context.auth?.uid || "";
  if (!uid) {
    throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
  }

  const tokenEmail = normalizeAnalyticsEmail(context.auth?.token?.email);
  const allowedEmail = getPersonalAnalyticsAllowedEmail();
  if (!allowedEmail) {
    logger.error("[personalAnalytics] missing PERSONAL_ANALYTICS_ALLOWED_EMAIL");
    throw new functions.https.HttpsError("failed-precondition", "Configurazione accesso mancante.");
  }
  let authEmail = "";
  try {
    const authUser = await admin.auth().getUser(uid);
    authEmail = normalizeAnalyticsEmail(authUser?.email);
  } catch (err) {
    logger.warn("[personalAnalytics] auth user lookup failed", {
      uid,
      message: safeString(err?.message || String(err), 180),
    });
  }

  if (tokenEmail !== allowedEmail && authEmail !== allowedEmail) {
    throw new functions.https.HttpsError("permission-denied", "Accesso riservato.");
  }

  return { uid, email: authEmail || tokenEmail };
}

async function analyticsCount(queryRef, label) {
  try {
    const snap = await queryRef.count().get();
    return Number(snap.data().count || 0);
  } catch (err) {
    logger.warn("[personalAnalytics] count failed", {
      label,
      message: safeString(err?.message || String(err), 180),
    });
    return null;
  }
}

async function analyticsFirstDocIso(queryRef, field, label) {
  try {
    const snap = await queryRef.orderBy(field, "asc").limit(1).get();
    if (snap.empty) return null;
    const data = snap.docs[0].data() || {};
    return analyticsIso(data[field]);
  } catch (err) {
    logger.warn("[personalAnalytics] first doc lookup failed", {
      label,
      field,
      message: safeString(err?.message || String(err), 180),
    });
    return null;
  }
}

async function analyticsRecentDocs(queryRef, field, max, mapper, label) {
  try {
    const snap = await queryRef.orderBy(field, "desc").limit(max).get();
    return snap.docs.map((doc) => mapper(doc.id, doc.data() || {}));
  } catch (err) {
    logger.warn("[personalAnalytics] recent docs lookup failed", {
      label,
      field,
      message: safeString(err?.message || String(err), 180),
    });
    return [];
  }
}

function classifyAnalyticsUserAgent(rawUa) {
  const ua = String(rawUa || "");
  if (!ua) return { device: "unknown", browser: "unknown" };
  const device = /iPhone|iPad|iPod/i.test(ua)
    ? "ios_web"
    : (/Android/i.test(ua) ? "android_web" : "desktop_web");
  const browser = /CriOS|Chrome/i.test(ua)
    ? "chrome"
    : (/FxiOS|Firefox/i.test(ua) ? "firefox" : (/Safari/i.test(ua) ? "safari" : "other"));
  return { device, browser };
}

function inferAnalyticsPlatform({ createdAtIso, tokenRows }) {
  const signupMs = Date.parse(createdAtIso || "") || 0;
  const nearSignupMs = 7 * 24 * 60 * 60 * 1000;
  const nearTokens = tokenRows.filter((row) => {
    const tokenMs = Date.parse(row.createdAt || row.updatedAt || "") || 0;
    return signupMs > 0 && tokenMs > 0 && Math.abs(tokenMs - signupMs) <= nearSignupMs;
  });
  const rows = nearTokens.length ? nearTokens : tokenRows;
  const platforms = rows.map((row) => String(row.platform || "").toLowerCase()).filter(Boolean);
  if (platforms.includes("ios")) return "ios";
  if (platforms.includes("web")) return "web";
  return "unknown";
}

function inferAnalyticsEntrypoint({ firstImportIso, firstQuizIso, firstTitleStateIso, createdAtIso, recentImports }) {
  const createdMs = Date.parse(createdAtIso || "") || 0;
  const within = (iso, days) => {
    const ms = Date.parse(iso || "") || 0;
    return createdMs > 0 && ms > 0 && ms - createdMs >= 0 && ms - createdMs <= days * 24 * 60 * 60 * 1000;
  };
  if (within(firstImportIso, 2)) {
    const source = recentImports[0]?.source || "import";
    return (source === "tvtime_gdpr" || source === "tvtime_refract") ? "tv_time_import"
      : source === "netflix_csv" ? "netflix_import"
      : source === "trakt" ? "trakt_import"
      : "import";
  }
  if (within(firstQuizIso, 2)) return "quiz";
  if (within(firstTitleStateIso, 2)) return "watchlist_or_seen";
  return "unknown";
}

function buildAnalyticsUserSummary(row) {
  const s = row.stats || {};
  const activity = row.activity || {};
  const quiz = row.quiz || {};
  return {
    titles: Number(activity.titleStatesCount || 0),
    watched: Number(s.watchedCount || 0),
    minutes: Number(s.totalWatchMinutes || 0),
    ratings: Number(s.ratingsCount || activity.ratingsCount || 0),
    reviews: Number(s.reviewsCount || 0),
    posts: Number(activity.postsCount || 0),
    lists: Number(activity.listsCount || 0),
    imports: Number(activity.importsCount || 0),
    quizAttempts: Number(quiz.attemptsCount || 0),
    quizXp: Number(quiz.xp || 0),
  };
}

async function buildPersonalAnalyticsUserRow(db, userDoc) {
  const uid = userDoc.id;
  const data = userDoc.data() || {};
  const stats = data.stats || {};
  const userRef = db.collection("users").doc(uid);

  const [
    authUser,
    privateSnap,
    tokenSnap,
    quizStatsSnap,
    titleStatesCount,
    watchlistCount,
    inProgressCount,
    importsCount,
    ratingsCount,
    postsCount,
    commentsCount,
    listsCount,
    titlesCreatedCount,
    recommendationsSentCount,
    recommendationsReceivedCount,
    firstTitleStateIso,
    firstQuizIso,
    firstImportIso,
    recentImports,
    recentTitleStates,
  ] = await Promise.all([
    admin.auth().getUser(uid).catch(() => null),
    db.collection("usersPrivate").doc(uid).get().catch(() => null),
    userRef.collection("notificationTokens").limit(20).get().catch(() => ({ docs: [] })),
    userRef.collection("quizStats").doc("agg").get().catch(() => null),
    analyticsCount(userRef.collection("titleStates"), `titleStates:${uid}`),
    analyticsCount(userRef.collection("titleStates").where("generalWatchlist", "==", true), `watchlistStates:${uid}`),
    analyticsCount(userRef.collection("titleStates").where("state", "==", "in_progress"), `inProgress:${uid}`),
    analyticsCount(userRef.collection("imports"), `imports:${uid}`),
    analyticsCount(db.collection("ratings").where("uid", "==", uid), `ratings:${uid}`),
    analyticsCount(db.collection("posts").where("authorUid", "==", uid), `posts:${uid}`),
    analyticsCount(db.collectionGroup("comments").where("uid", "==", uid), `comments:${uid}`),
    analyticsCount(db.collection("userLists").where("ownerUid", "==", uid), `lists:${uid}`),
    analyticsCount(db.collection("titles").where("createdBy", "==", uid), `titlesCreated:${uid}`),
    analyticsCount(db.collection("recommendations").where("fromUid", "==", uid), `recommendationsSent:${uid}`),
    analyticsCount(db.collection("recommendations").where("toUid", "==", uid), `recommendationsReceived:${uid}`),
    analyticsFirstDocIso(userRef.collection("titleStates"), "createdAt", `firstTitleState:${uid}`),
    analyticsFirstDocIso(userRef.collection("quizAttempts"), "createdAt", `firstQuiz:${uid}`),
    analyticsFirstDocIso(userRef.collection("imports"), "createdAt", `firstImport:${uid}`),
    analyticsRecentDocs(userRef.collection("imports"), "createdAt", 3, (id, row) => ({
      id,
      source: safeString(row.source || "", 40),
      status: safeString(row.status || "", 40),
      dryRun: row.dryRun === true,
      totalRows: Number(row.totalRows || 0),
      matchedCount: Number(row.matchedCount || 0),
      unresolvedCount: Number(row.unresolvedCount || 0),
      createdAt: analyticsIso(row.createdAt),
      updatedAt: analyticsIso(row.updatedAt),
    }), `recentImports:${uid}`),
    analyticsRecentDocs(userRef.collection("titleStates"), "updatedAt", 3, (id, row) => ({
      titleId: id,
      state: safeString(row.state || row.movieStatus || row.seriesStatus || "", 40),
      generalWatchlist: row.generalWatchlist === true,
      watchMinutesContribution: Number(row.watchMinutesContribution || 0),
      updatedAt: analyticsIso(row.updatedAt),
      createdAt: analyticsIso(row.createdAt),
    }), `recentTitleStates:${uid}`),
  ]);

  const privateData = privateSnap?.exists ? (privateSnap.data() || {}) : {};
  const quizStats = quizStatsSnap?.exists ? (quizStatsSnap.data() || {}) : {};
  const tokenRows = tokenSnap.docs.map((doc) => {
    const row = doc.data() || {};
    return {
      platform: safeString(row.platform || "", 32),
      createdAt: analyticsIso(row.createdAt),
      updatedAt: analyticsIso(row.updatedAt),
      userAgent: classifyAnalyticsUserAgent(row.userAgent),
    };
  });
  const providerIds = Array.isArray(authUser?.providerData)
    ? authUser.providerData.map((p) => safeString(p.providerId || "", 48)).filter(Boolean)
    : [];
  const createdAtIso = analyticsIso(data.createdAt) || (authUser?.metadata?.creationTime ? new Date(authUser.metadata.creationTime).toISOString() : null);
  const firstUsefulAt = analyticsFirstIso(firstTitleStateIso, firstQuizIso, firstImportIso, data.lastActiveAt);
  const lastActivityAt = analyticsLatestIso(
    data.lastActiveAt,
    recentImports[0]?.updatedAt,
    recentTitleStates[0]?.updatedAt,
    quizStats.updatedAt,
    quizStats.lastPlayedAt
  );

  const row = {
    uid,
    displayName: safeString(data.displayName || authUser?.displayName || "User", 80),
    email: safeString(privateData.email || authUser?.email || "", 160) || null,
    photoURL: safeString(data.photoURL || data.avatarURL || "", 500) || null,
    createdAt: createdAtIso,
    lastActiveAt: analyticsIso(data.lastActiveAt),
    lastActivityAt,
    firstUsefulAt,
    providerIds,
    accountType: safeString(data.accountType || "", 40) || (isGuidedUserData(data) ? "synthetic" : "real"),
    isSynthetic: isGuidedUserData(data),
    platform: {
      estimatedSignupSurface: inferAnalyticsPlatform({ createdAtIso, tokenRows }),
      tokenPlatforms: Array.from(new Set(tokenRows.map((row) => row.platform).filter(Boolean))),
      tokenEvidenceCount: tokenRows.length,
      userAgents: tokenRows.map((row) => row.userAgent),
    },
    entrypoint: inferAnalyticsEntrypoint({ firstImportIso, firstQuizIso, firstTitleStateIso, createdAtIso, recentImports }),
    stats: {
      ratingsCount: Number(stats.ratingsCount || 0),
      reviewsCount: Number(stats.reviewsCount || 0),
      watchedCount: Number(stats.watchedCount || 0),
      totalWatchMinutes: Number(stats.totalWatchMinutes || 0),
      rewatchCount: Number(stats.rewatchCount || 0),
      titlesCreated: Number(stats.titlesCreated || titlesCreatedCount || 0),
      byCategory: stats.byCategory || {},
    },
    quiz: {
      attemptsCount: Number(quizStats.attemptsCount || 0),
      totalScore: Number(quizStats.totalScore || 0),
      correctCount: Number(quizStats.correctCount || 0),
      xp: Number(quizStats.xp || 0),
      dailyStreak: Number(quizStats.dailyStreak || 0),
    },
    activity: {
      titleStatesCount: Number(titleStatesCount || 0),
      watchlistCount: Number(watchlistCount || 0),
      inProgressCount: Number(inProgressCount || 0),
      importsCount: Number(importsCount || 0),
      ratingsCount: Number(ratingsCount || 0),
      postsCount: Number(postsCount || 0),
      commentsCount: Number(commentsCount || 0),
      listsCount: Number(listsCount || 0),
      titlesCreatedCount: Number(titlesCreatedCount || 0),
      recommendationsSentCount: Number(recommendationsSentCount || 0),
      recommendationsReceivedCount: Number(recommendationsReceivedCount || 0),
      recentImports,
      recentTitleStates,
    },
  };

  row.summary = buildAnalyticsUserSummary(row);
  return row;
}

function buildPersonalAnalyticsOverview(users) {
  const nowMs = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const realUsers = users.filter((u) => !u.isSynthetic);
  const recent7 = realUsers.filter((u) => {
    const ms = Date.parse(u.createdAt || "") || 0;
    return ms > 0 && nowMs - ms <= 7 * dayMs;
  });
  const recent30 = realUsers.filter((u) => {
    const ms = Date.parse(u.createdAt || "") || 0;
    return ms > 0 && nowMs - ms <= 30 * dayMs;
  });
  const activated24h = realUsers.filter((u) => {
    const createdMs = Date.parse(u.createdAt || "") || 0;
    const firstMs = Date.parse(u.firstUsefulAt || "") || 0;
    return createdMs > 0 && firstMs > 0 && firstMs - createdMs <= dayMs;
  }).length;
  const activated7d = realUsers.filter((u) => {
    const createdMs = Date.parse(u.createdAt || "") || 0;
    const firstMs = Date.parse(u.firstUsefulAt || "") || 0;
    return createdMs > 0 && firstMs > 0 && firstMs - createdMs <= 7 * dayMs;
  }).length;
  const active7d = realUsers.filter((u) => {
    const ms = Date.parse(u.lastActivityAt || "") || 0;
    return ms > 0 && nowMs - ms <= 7 * dayMs;
  }).length;
  const sums = realUsers.reduce((acc, user) => {
    acc.watched += user.summary.watched;
    acc.minutes += user.summary.minutes;
    acc.ratings += user.summary.ratings;
    acc.quizAttempts += user.summary.quizAttempts;
    acc.imports += user.summary.imports;
    acc.posts += user.summary.posts;
    acc.lists += user.summary.lists;
    return acc;
  }, { watched: 0, minutes: 0, ratings: 0, quizAttempts: 0, imports: 0, posts: 0, lists: 0 });

  return {
    sampleSize: users.length,
    realUsers: realUsers.length,
    syntheticUsers: users.length - realUsers.length,
    signups7d: recent7.length,
    signups30d: recent30.length,
    active7d,
    activated24h,
    activated7d,
    activation24hRate: realUsers.length ? activated24h / realUsers.length : 0,
    activation7dRate: realUsers.length ? activated7d / realUsers.length : 0,
    sums,
  };
}

exports.getPersonalAdminAnalytics = functions
  .runWith({ timeoutSeconds: 120, memory: "512MB" })
  .region("europe-west1")
  .https.onCall(async (data, context) => {
    const caller = await assertPersonalAnalyticsAccess(context);
    const db = admin.firestore();
    await enforceCallableRateLimit(db, caller.uid, "personalAdminAnalytics", {
      windowSeconds: 10,
      maxInWindow: 6,
      dailyMax: 240,
    });

    const max = clamp(Number(data?.limit || 40), 10, 50);
    const usersSnap = await db.collection("users")
      .orderBy("createdAt", "desc")
      .limit(max)
      .get();

    const users = [];
    for (const userDoc of usersSnap.docs) {
      // eslint-disable-next-line no-await-in-loop
      users.push(await buildPersonalAnalyticsUserRow(db, userDoc));
    }

    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      scope: {
        callerUid: caller.uid,
        limit: max,
        restricted: true,
      },
      overview: buildPersonalAnalyticsOverview(users),
      users,
    };
  });

// ============================================
// Classifica globale (schedulata ogni 24h)
// ============================================
exports.computeGlobalLeaderboard = functions
  .region("europe-west1")
  .pubsub.schedule("every 24 hours")
  .onRun(async () => {
    const db = admin.firestore();

    // 1) Top raters: utenti con più voti dati
    const usersSnap = await db.collection("users")
      .orderBy("stats.ratingsCount", "desc")
      .limit(50)
      .get();

    const userDocs = usersSnap.docs
      // Profili guidati esclusi dalla leaderboard (metrica reale).
      .filter(d => (d.data().stats?.ratingsCount || 0) > 0 && !isGuidedUserData(d.data()));

    const topRaters = userDocs.slice(0, 20).map(d => ({
      uid: d.id,
      count: d.data().stats?.ratingsCount || 0,
      displayName: d.data().displayName || "",
      photoURL: d.data().photoURL || "",
    }));

    // 2) Top adders: utenti che hanno aggiunto più titoli.
    //    Usa il counter incrementale `users.stats.titlesCreated` (mantenuto
    //    dai trigger incrementCreatorTitlesCount/decrementCreatorTitlesCount/
    //    syncCreatorTitlesCountOnStatus) invece di scannare l'intera
    //    collection titles. Query O(50) invece di O(N).
    const addersSnap = await db.collection("users")
      .orderBy("stats.titlesCreated", "desc")
      .limit(50)
      .get();

    const adderCounts = {};
    addersSnap.docs.forEach(d => {
      const count = Number(d.data().stats?.titlesCreated || 0);
      // Profili guidati esclusi dalla leaderboard (metrica reale).
      if (count > 0 && !isGuidedUserData(d.data())) adderCounts[d.id] = count;
    });

    const adderEntries = Object.entries(adderCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);

    // Recupero displayName/photoURL per gli adder che non sono già nei top raters
    const knownUsers = buildKnownUsersMap(userDocs);

    // Carica profili mancanti per gli adder (postCounts viene calcolato dopo).
    const missingUids = collectMissingAdderProfileUids(adderEntries, knownUsers);

    for (const uid of missingUids) {
      const uSnap = await db.collection("users").doc(uid).get();
      if (uSnap.exists) {
        const u = uSnap.data();
        knownUsers[uid] = {
          displayName: u.displayName || "",
          photoURL: u.photoURL || "",
          ratingsCount: u.stats?.ratingsCount || 0,
        };
      }
    }

    const topAdders = adderEntries.map(([uid, count]) => ({
      uid,
      count,
      displayName: knownUsers[uid]?.displayName || "",
      photoURL: knownUsers[uid]?.photoURL || "",
    }));

    // 3) Posts count per utente (per score contributor) solo sui candidati noti
    const allUidsForPosts = [...new Set([
      ...topRaters.map(r => r.uid),
      ...topAdders.map(a => a.uid),
    ])];

    const postCounts = {};
    await Promise.all(allUidsForPosts.map(async (uid) => {
      const snap = await db.collection("posts")
        .where("authorUid", "==", uid)
        .count()
        .get();
      postCounts[uid] = snap.data().count;
    }));

    // 4) Top contributors: +3 titolo, +2 post, +1 rating
    const allUids = new Set([
      ...userDocs.map(d => d.id),
      ...Object.keys(adderCounts),
      ...Object.keys(postCounts),
    ]);

    const contributorScores = [];
    for (const uid of allUids) {
      const titles = adderCounts[uid] || 0;
      const posts = postCounts[uid] || 0;
      const ratings = knownUsers[uid]?.ratingsCount || 0;
      const score = titles * 3 + posts * 2 + ratings * 1;
      if (score > 0) {
        contributorScores.push({
          uid,
          score,
          displayName: knownUsers[uid]?.displayName || "",
          photoURL: knownUsers[uid]?.photoURL || "",
        });
      }
    }

    contributorScores.sort((a, b) => b.score - a.score);
    const topContributors = contributorScores.slice(0, 20);

    await db.collection("leaderboard").doc("global").set({
      topRaters,
      topAdders,
      topContributors,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info(`[leaderboard] Global leaderboard computed: raters=${topRaters.length} adders=${topAdders.length} contributors=${topContributors.length}`);
    return null;
  });

// ============================================
// TMDB auto-import (3x/day, random nei titoli recenti)
// ============================================
exports.importRecentTmdbTitles = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 540, memory: "1GB" })
  .pubsub.schedule("0 2,10,18 * * *")
  .timeZone("Europe/Rome")
  .onRun(async () => {
    const db = admin.firestore();
    const bucket = admin.storage().bucket();
    const startedAtMs = Date.now();
    const runId = String(startedAtMs);
    const apiKey = getTmdbApiKey();

    const stats = {
      runId,
      startedAtMs,
      status: "running",
      importLimit: TMDB_IMPORT_LIMIT_PER_RUN,
      pagesPerType: TMDB_IMPORT_PAGES_PER_TYPE,
      recentPageWindow: TMDB_IMPORT_RECENT_PAGE_WINDOW,
      minReqGapMs: TMDB_IMPORT_MIN_REQ_GAP_MS,
      maxApiCalls: TMDB_IMPORT_MAX_API_CALLS,
      apiCalls: 0,
      apiRateLimitHits: 0,
      apiNetworkErrors: 0,
      moviePoolCount: 0,
      tvPoolCount: 0,
      candidatePoolCount: 0,
      existingSkipped: 0,
      logicalDuplicateSkipped: 0,
      selectedCount: 0,
      importedCount: 0,
      mergedCount: 0,
      importErrors: 0,
      posterUploaded: 0,
      posterFailures: 0,
      genreDocsTouched: 0,
      fetchRounds: 0,
      moviePagesFetched: 0,
      tvPagesFetched: 0,
      targetReached: false,
      durationMs: 0,
    };

    if (!apiKey) {
      stats.status = "failed";
      stats.error = "TMDB API key mancante. Usa env TMDB_API_KEY o functions config tmdb.key.";
      stats.durationMs = Date.now() - startedAtMs;
      logger.error(`[tmdb-import] ${stats.error}`);
      await writeTmdbImportRunReport(db, stats).catch(() => {});
      return null;
    }

    const state = {
      apiKey,
      maxApiCalls: TMDB_IMPORT_MAX_API_CALLS,
      maxAttempts: 4,
      recentPageWindow: TMDB_IMPORT_RECENT_PAGE_WINDOW,
      pagesPerType: TMDB_IMPORT_PAGES_PER_TYPE,
      apiCalls: 0,
      apiRateLimitHits: 0,
      apiNetworkErrors: 0,
    };

    try {
      const genreCatalog = await fetchTmdbGenreCatalog(state);
      stats.genreDocsTouched = await ensureTmdbGenreDocs(db, genreCatalog);
      let batch = db.batch();
      let writeOps = 0;
      const flushBatch = async () => {
        if (writeOps <= 0) return;
        await batch.commit();
        batch = db.batch();
        writeOps = 0;
      };

      const logicalDupCache = new Map();
      const pending = [];
      const pendingLogicalKeys = new Set();
      const seenCandidateKeys = new Set();
      const existingKeys = new Set();
      const chunkSize = 240;
      const fetchOptions = {
        pagesPerCall: TMDB_IMPORT_PAGES_PER_TYPE,
        pageWindow: TMDB_IMPORT_RECENT_PAGE_WINDOW,
      };
      const maxFetchRounds = Math.max(
        2,
        Math.ceil(TMDB_IMPORT_RECENT_PAGE_WINDOW / Math.max(1, TMDB_IMPORT_PAGES_PER_TYPE)) + 2
      );
      let movieExhausted = false;
      let tvExhausted = false;

      const enqueueCandidates = async (rows) => {
        const freshRows = [];
        for (const row of rows || []) {
          const k = `${row.type}:${row.tmdbId}`;
          if (!k || seenCandidateKeys.has(k)) continue;
          seenCandidateKeys.add(k);
          freshRows.push(row);
        }
        stats.candidatePoolCount = seenCandidateKeys.size;

        if (!freshRows.length) return 0;

        const rowsToCheck = [];
        for (const row of freshRows) {
          const k = `${row.type}:${row.tmdbId}`;
          if (existingKeys.has(k)) {
            stats.existingSkipped += 1;
            continue;
          }
          rowsToCheck.push({
            key: k,
            row,
            ref: db.collection("titles").doc(tmdbTitleDocId(row.type, row.tmdbId)),
            exists: false,
          });
        }

        if (!rowsToCheck.length) return 0;

        for (let i = 0; i < rowsToCheck.length; i += chunkSize) {
          const chunk = rowsToCheck.slice(i, i + chunkSize);
          const refs = chunk.map((x) => x.ref);
          if (!refs.length) continue;
          const snaps = await db.getAll(...refs);
          for (let j = 0; j < snaps.length; j++) {
            const snap = snaps[j];
            if (!snap?.exists) continue;
            chunk[j].exists = true;
            existingKeys.add(chunk[j].key);
          }
        }

        let added = 0;
        for (const entry of rowsToCheck) {
          if (entry.exists) {
            stats.existingSkipped += 1;
            continue;
          }
          const logicalKey = tmdbLogicalDuplicateKey(entry.row);
          if (logicalKey && pendingLogicalKeys.has(logicalKey)) {
            stats.logicalDuplicateSkipped += 1;
            continue;
          }
          if (logicalKey) pendingLogicalKeys.add(logicalKey);
          pending.push(entry.row);
          stats.selectedCount += 1;
          added += 1;
        }
        return added;
      };

      while (stats.importedCount < TMDB_IMPORT_LIMIT_PER_RUN) {
        if (!pending.length) {
          if ((movieExhausted && tvExhausted) || stats.fetchRounds >= maxFetchRounds) break;

          stats.fetchRounds += 1;
          const movieResult = movieExhausted
            ? { candidates: [], pagesFetched: [], exhausted: true }
            : await fetchTmdbRecentCandidatesForType("movie", state, fetchOptions);
          const tvResult = tvExhausted
            ? { candidates: [], pagesFetched: [], exhausted: true }
            : await fetchTmdbRecentCandidatesForType("tv", state, fetchOptions);

          movieExhausted = movieExhausted || Boolean(movieResult.exhausted);
          tvExhausted = tvExhausted || Boolean(tvResult.exhausted);
          stats.moviePagesFetched += (movieResult.pagesFetched || []).length;
          stats.tvPagesFetched += (tvResult.pagesFetched || []).length;
          stats.moviePoolCount += (movieResult.candidates || []).length;
          stats.tvPoolCount += (tvResult.candidates || []).length;

          const merged = shuffleRows([
            ...(movieResult.candidates || []),
            ...(tvResult.candidates || []),
          ]);
          await enqueueCandidates(merged);

          if (!pending.length && movieExhausted && tvExhausted) break;
          if (!pending.length) continue;
        }

        const row = pending.shift();
        const queuedLogicalKey = tmdbLogicalDuplicateKey(row);
        if (queuedLogicalKey) pendingLogicalKeys.delete(queuedLogicalKey);

        try {
          const dupId = await existsLogicalDuplicateTitle(db, row, logicalDupCache);
          if (dupId) {
            // merge into existing
            const res = await upsertTmdbTitle(db, bucket, row, logicalDupCache);
            if (!res?.imported) {
              stats.importErrors += 1;
              stats.posterFailures += 1;
              const msg = safeString(res?.error || "unknown upsert error", 220);
              logger.warn(`[tmdb-import] skip ${row.type}:${row.tmdbId} -> ${msg}`);
              continue;
            }
            stats.posterUploaded += 1;
            stats.mergedCount += 1;
            const key = tmdbLogicalDuplicateKey(row);
            if (key) logicalDupCache.set(key, dupId);
          } else {
            const poster = await uploadTmdbPosterToStorage(bucket, row);
            stats.posterUploaded += 1;
            const docRef = db.collection("titles").doc(tmdbTitleDocId(row.type, row.tmdbId));
            const docData = buildTmdbTitleDoc(row, poster.url);
            batch.set(docRef, docData, { merge: true });
            writeOps++;
            stats.importedCount += 1;
            const key = tmdbLogicalDuplicateKey(row);
            if (key) logicalDupCache.set(key, docRef.id);
          }
        } catch (err) {
          stats.importErrors += 1;
          stats.posterFailures += 1;
          logger.warn(`[tmdb-import] skip ${row.type}:${row.tmdbId} -> ${err.message}`);
          continue;
        }

        if (writeOps >= 320) {
          await flushBatch();
        }
      }
      await flushBatch();

      stats.status = "ok";
      stats.apiCalls = state.apiCalls;
      stats.apiRateLimitHits = state.apiRateLimitHits;
      stats.apiNetworkErrors = state.apiNetworkErrors;
      stats.targetReached = stats.importedCount >= TMDB_IMPORT_LIMIT_PER_RUN;
      stats.durationMs = Date.now() - startedAtMs;
      logger.info(
        `[tmdb-import] imported=${stats.importedCount} merged=${stats.mergedCount} ` +
        `selected=${stats.selectedCount} pool=${stats.candidatePoolCount} rounds=${stats.fetchRounds} ` +
        `apiCalls=${stats.apiCalls} durationMs=${stats.durationMs}`
      );
      await writeTmdbImportRunReport(db, stats);
      return null;
    } catch (err) {
      stats.status = "failed";
      stats.error = safeString(err?.message || String(err), 360);
      stats.apiCalls = state.apiCalls;
      stats.apiRateLimitHits = state.apiRateLimitHits;
      stats.apiNetworkErrors = state.apiNetworkErrors;
      stats.durationMs = Date.now() - startedAtMs;
      logger.error(`[tmdb-import] FAILED: ${stats.error}`);
      await writeTmdbImportRunReport(db, stats).catch(() => {});
      return null;
    }
  });

// ============================================
// Taste profile aggregation on signal creation
// ============================================
exports.updateTasteProfileOnSignal = functions
  .region("europe-west1")
  .firestore
  .document("users/{uid}/signals/{signalId}")
  .onCreate(async (snap, context) => {
    const signal = snap.data() || {};
    const uid = context.params.uid;
    const titleId = toId(signal.titleId);
    if (!uid || !titleId) return null;

    const db = admin.firestore();
    const titleRef = db.collection("titles").doc(titleId);
    const userRef = db.collection("users").doc(uid);
    const privateUserRef = db.collection("usersPrivate").doc(uid);
    const tpRef = db.collection("users").doc(uid).collection("tasteProfile").doc("agg");

    const titleSnap = await titleRef.get().catch(() => null);
    const title = titleSnap?.exists ? titleSnap.data() || {} : {};

    // Estrazione feature + matematica delta ora nel modulo condiviso
    // lib/tasteProfileAggregate (riusato IDENTICO dalla coda di import).
    const features = extractTasteFeatures(title);

    const delta = Number(signal.delta || 0);
    if (!Number.isFinite(delta) || delta === 0) return null;
    const createdAt = signal.createdAt || admin.firestore.FieldValue.serverTimestamp();

    await db.runTransaction(async (tx) => {
      const [tpSnap, userSnap, privateUserSnap] = await Promise.all([
        tx.get(tpRef),
        tx.get(userRef),
        tx.get(privateUserRef),
      ]);

      const current = tpSnap.exists ? (tpSnap.data() || {}) : {};
      const publicUserData = userSnap.exists ? (userSnap.data() || {}) : {};
      const privateUserData = privateUserSnap.exists ? (privateUserSnap.data() || {}) : {};
      const mergedUserData = {
        ...publicUserData,
        ...privateUserData,
      };
      const featureSums = current.featureSums || {};

      applyTasteTitleDelta(featureSums, features, delta, createdAt);

      const completedLevel = Number(mergedUserData?.onboardingStatus?.completedLevel || 0);
      // confidenceScore CUMULATIVA (funzione dell'intero featureSums, non del
      // singolo segnale): non regredisce alla scrittura successiva.
      const confidenceScore = computeTasteConfidence(featureSums, completedLevel);

      tx.set(tpRef, {
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        featureSums,
        confidenceScore,
        seed: {
          onboardingCompletedLevel: completedLevel,
          seedTitleIds: Array.isArray(mergedUserData?.tasteProfile?.seedTitleIds)
            ? mergedUserData.tasteProfile.seedTitleIds
            : [],
        },
      }, { merge: true });
    });

    return null;
  });

// ============================================
// Backfill existing data → signals + tasteProfile (idempotente)
// Admin-only callable. Use limitUsers + startAfterUid for chunked runs.
// ============================================

// ACTION_WEIGHTS + normalizedFromRating vivono ora in
// lib/tasteProfileAggregate (importati in cima al file) — unica fonte,
// condivisa con il trigger e la coda di import.

function signalDocId({ actionType, titleId, createdAt }) {
  const day = ymdFromDate(createdAt || new Date());
  return `${actionType}_${titleId}_${day}`;
}

async function emitSignal(db, uid, payload) {
  const docId = signalDocId(payload);
  const ref = db.collection("users").doc(uid).collection("signals").doc(docId);
  await ref.set(
    {
      titleId: payload.titleId,
      actionType: payload.actionType,
      rawValue: payload.rawValue ?? null,
      normalizedValue: payload.normalizedValue,
      actionWeight: payload.actionWeight,
      delta: payload.delta,
      source: payload.source || "backfill",
      createdAt: payload.createdAt || admin.firestore.FieldValue.serverTimestamp(),
      dedupeKey: `${payload.actionType}_${ymdFromDate(payload.createdAt || new Date())}`,
      multiplier: 1,
    },
    { merge: false }
  );
}

exports.backfillTasteSignals = functions
  .runWith({ timeoutSeconds: 540, memory: "1GB" })
  .region("europe-west1")
  .https.onCall(async (data, context) => {
    const caller = context.auth?.uid;
    if (!caller || !getAdminUids().includes(caller)) {
      throw new functions.https.HttpsError("permission-denied", "Solo admin");
    }

    const db = admin.firestore();
    await enforceCallableRateLimit(db, caller, "backfillTasteSignals", {
      windowSeconds: 45,
      maxInWindow: 1,
      dailyMax: 12,
    });
    const limitUsers = Number(data?.limitUsers || 50);
    const startAfterUid = data?.startAfterUid || null;
    const dryRun = data?.dryRun === true;

    const userQuery = startAfterUid
      ? db.collection("users").orderBy(admin.firestore.FieldPath.documentId()).startAfter(startAfterUid).limit(limitUsers)
      : db.collection("users").orderBy(admin.firestore.FieldPath.documentId()).limit(limitUsers);

    const userSnaps = await userQuery.get();
    const users = userSnaps.docs.map((d) => ({ uid: d.id }));

    let written = 0;

    for (const { uid } of users) {
      // Ratings
      const ratingsSnap = await db.collection("ratings").where("uid", "==", uid).limit(500).get().catch(() => ({ docs: [] }));
      for (const doc of ratingsSnap.docs) {
        const r = doc.data() || {};
        const titleId = toId(r.titleId);
        if (!titleId) continue;
        const actionType = "rating";
        const meta = ACTION_WEIGHTS[actionType];
        const normalizedValue = normalizedFromRating(r.rating);
        const delta = normalizedValue * meta.weight;
        if (!dryRun) {
          await emitSignal(db, uid, {
            actionType,
            titleId,
            rawValue: r.rating,
            normalizedValue,
            actionWeight: meta.weight,
            delta,
            source: "backfill_rating",
            createdAt: tsToDate(r.updatedAt || r.createdAt),
          });
        }
        written += 1;
      }

      // Match feedback
      const matchSnap = await db.collection("users").doc(uid).collection("matchFeedback").limit(300).get().catch(() => ({ docs: [] }));
      for (const doc of matchSnap.docs) {
        const m = doc.data() || {};
        const titleId = toId(m.titleId || doc.id);
        if (!titleId) continue;
        let actionType = "match_ok";
        if (m.action === "skip") actionType = "match_dislike";
        if (m.action === "superlike") actionType = "match_love";
        if (m.action === "seen") actionType = "match_seen";
        const meta = ACTION_WEIGHTS[actionType] || ACTION_WEIGHTS.match_ok;
        const normalizedValue = meta.normalized;
        const delta = normalizedValue * meta.weight;
        if (!dryRun) {
          await emitSignal(db, uid, {
            actionType,
            titleId,
            rawValue: null,
            normalizedValue,
            actionWeight: meta.weight,
            delta,
            source: "backfill_match",
            createdAt: tsToDate(m.actionAt || m.updatedAt || m.shownAt),
          });
        }
        written += 1;
      }

      // Watchlist (only add)
      const watchSnap = await db.collection("users").doc(uid).collection("watchlist").limit(500).get().catch(() => ({ docs: [] }));
      for (const doc of watchSnap.docs) {
        const w = doc.data() || {};
        const titleId = toId(w.titleId || doc.id);
        if (!titleId) continue;
        const actionType = "watchlist_add";
        const meta = ACTION_WEIGHTS[actionType];
        const normalizedValue = meta.normalized;
        const delta = normalizedValue * meta.weight;
        if (!dryRun) {
          await emitSignal(db, uid, {
            actionType,
            titleId,
            rawValue: null,
            normalizedValue,
            actionWeight: meta.weight,
            delta,
            source: "backfill_watchlist",
            createdAt: tsToDate(w.addedAt),
          });
        }
        written += 1;
      }

      // Recommendations sent
      const recSnap = await db.collection("recommendations").where("fromUid", "==", uid).limit(300).get().catch(() => ({ docs: [] }));
      for (const doc of recSnap.docs) {
        const r = doc.data() || {};
        const titleId = toId(r.titleId);
        if (!titleId) continue;
        const actionType = "suggest_to_friend";
        const meta = ACTION_WEIGHTS[actionType];
        const normalizedValue = meta.normalized;
        const delta = normalizedValue * meta.weight;
        if (!dryRun) {
          await emitSignal(db, uid, {
            actionType,
            titleId,
            rawValue: null,
            normalizedValue,
            actionWeight: meta.weight,
            delta,
            source: "backfill_recommendation",
            createdAt: tsToDate(r.createdAt),
          });
        }
        written += 1;
      }

      // Thread messages (collectionGroup)
      const msgSnap = await db.collectionGroup("messages").where("uid", "==", uid).limit(300).get().catch(() => ({ docs: [] }));
      for (const doc of msgSnap.docs) {
        const msg = doc.data() || {};
        const threadRef = doc.ref.parent.parent;
        const threadDoc = await threadRef.get().catch(() => null);
        const titleId = toId(threadDoc?.data()?.titleId);
        if (!titleId) continue;
        const actionType = "thread_post";
        const meta = ACTION_WEIGHTS[actionType];
        const normalizedValue = meta.normalized;
        const delta = normalizedValue * meta.weight;
        if (!dryRun) {
          await emitSignal(db, uid, {
            actionType,
            titleId,
            rawValue: null,
            normalizedValue,
            actionWeight: meta.weight,
            delta,
            source: "backfill_thread",
            createdAt: tsToDate(msg.createdAt),
          });
        }
        written += 1;
      }
    }

    return {
      processedUsers: users.length,
      written,
      nextStartAfterUid: users.length ? users[users.length - 1].uid : null,
      dryRun,
    };
  });

exports.cleanupDeletedUserListCover = functions
  .region("europe-west1")
  .firestore.document("userLists/{listId}")
  .onDelete(async (snap) => {
    const cover = asObject(snap.data()?.cover);
    const storagePath = String(cover.storagePath || "").trim();
    if (!storagePath || !storagePath.startsWith("listCovers/")) {
      return null;
    }

    await admin.storage().bucket().file(storagePath).delete({ ignoreNotFound: true }).catch(() => {});
    return null;
  });

// ============================================================
// USER LIST SLUG — assign slug on create (mirror onTitleCreatedSlug)
// ============================================================
// Writes `slug` once to a new userList document if missing.
// For editorial lists: uses editorialSlug. For user lists: slugify(title)+last6(id).
// onCreate only — no update loop.
exports.onUserListCreatedSlug = functions
  .region("europe-west1")
  .firestore
  .document("userLists/{listId}")
  .onCreate(async (snap, context) => {
    const data = snap.data() || {};
    // Skip if slug already set.
    if (typeof data.slug === "string" && data.slug.trim()) return null;

    const listId = String(context.params.listId || snap.id || "").trim();
    if (!listId) return null;

    try {
      const slug = computeListSlug(listId, data);
      if (!slug) return null;

      await snap.ref.set(
        { slug, slugUpdatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
    } catch (err) {
      logger.error("[onUserListCreatedSlug] error", err);
    }
    return null;
  });

exports.syncPublicUserListProjection = functions
  .region("europe-west1")
  .firestore
  .document("userLists/{listId}")
  .onWrite(async (change, context) => {
    const db = admin.firestore();
    const listId = String(context.params.listId || "").trim();
    if (!listId) return null;

    try {
      if (!change.after.exists) {
        await db.collection("publicUserLists").doc(listId).delete();
        return null;
      }
      await syncPublicUserListProjection(db, listId, change.after.data() || {});
    } catch (err) {
      logger.error("[syncPublicUserListProjection] error", { listId, err: String(err) });
      throw err;
    }
    return null;
  });

// ============================================================
// FOLLOWERS COUNT — maintain followersCount on userLists/{listId}
// ============================================================
// Triggered on write to users/{uid}/savedLists/{listId}.
// +1 on create, -1 on delete, 0 on pure update (no-op).
// Uses FieldValue.increment for atomic, contention-safe updates.
exports.syncListFollowersCount = functions
  .region("europe-west1")
  .firestore
  .document("users/{uid}/savedLists/{listId}")
  .onWrite(async (change, context) => {
    const listId = String(context.params.listId || "").trim();
    if (!listId) return null;

    const before = change.before.exists;
    const after = change.after.exists;

    // Pure update (doc existed and still exists) — followersCount unchanged.
    if (before && after) return null;

    const delta = after ? 1 : -1;
    try {
      // update() (non set+merge): se la lista è già stata cancellata lancia
      // NOT_FOUND e NON ricrea un doc fantasma {followersCount:-N}.
      await admin.firestore().collection("userLists").doc(listId).update(
        { followersCount: admin.firestore.FieldValue.increment(delta) }
      );
    } catch (err) {
      // Best-effort: list may have been deleted (NOT_FOUND) — log and swallow.
      logger.warn("[syncListFollowersCount] error", { listId, delta, err: String(err) });
    }
    return null;
  });

// ============================================================
// LIST MEMBER PROGRESS — recompute on items or members change
// ============================================================
// Triggers recomputeUserListProgress when items or members subcollection change.
// Debounce-ish: each write fans into a single full recompute.
// Progress is best-effort; public item summary must retry on failure.

async function triggerListProgressRecompute(listId) {
  if (!listId) return;
  try {
    await recomputeUserListProgress({ db: admin.firestore(), listId });
  } catch (err) {
    logger.warn("[triggerListProgressRecompute] error", { listId, err: String(err) });
  }
}

exports.onUserListItemWrittenProgress = functions
  .region("europe-west1")
  .firestore
  .document("userLists/{listId}/items/{titleId}")
  .onWrite(async (_change, context) => {
    const listId = String(context.params.listId || "").trim();
    if (!listId) return null;
    await recomputeUserListItemSummary(admin.firestore(), listId);
    await triggerListProgressRecompute(listId);
    return null;
  });

exports.onUserListMemberWrittenProgress = functions
  .region("europe-west1")
  .firestore
  .document("userLists/{listId}/members/{memberId}")
  .onWrite(async (_change, context) => {
    await triggerListProgressRecompute(String(context.params.listId || "").trim());
    return null;
  });

// ============================================================
// ORPHANED SAVED LISTS — cleanup when a userList is deleted
// ============================================================
// When a userList is deleted, clean up server-owned projections,
// subcollections, and users/{uid}/savedLists/{listId} docs that still point
// to it.
//
// Implementation note: there is no Firestore collectionGroup index on listId
// today. We use a collectionGroup scan on "savedLists" (all sub-docs named
// that across all users) and filter in memory by doc id (the doc id IS the
// listId in this schema). This avoids adding a new composite index and is
// acceptable for the deletion-time latency.
async function deleteUserListSubcollection(db, listId, subcollection) {
  let deleted = 0;
  while (true) {
    const snap = await db.collection("userLists")
      .doc(listId)
      .collection(subcollection)
      .limit(300)
      .get();
    if (snap.empty) break;

    const batch = db.batch();
    snap.docs.forEach((docSnap) => batch.delete(docSnap.ref));
    await batch.commit();
    deleted += snap.size;
    if (snap.size < 300) break;
  }
  return deleted;
}

exports.cleanupSavedListsOnListDelete = functions
  .region("europe-west1")
  .firestore
  .document("userLists/{listId}")
  .onDelete(async (snap, context) => {
    const listId = String(context.params.listId || snap.id || "").trim();
    if (!listId) return null;

    const db = admin.firestore();
    let deleted = 0;
    const subcollectionsDeleted = {};

    await db.collection("publicUserLists").doc(listId).delete();
    for (const subcollection of ["items", "members", "progress"]) {
      subcollectionsDeleted[subcollection] = await deleteUserListSubcollection(db, listId, subcollection);
    }

    try {
      // collectionGroup("savedLists") returns all /users/{uid}/savedLists/{docId}
      // docs. The document id is the listId, so we can filter by id equality
      // using startAt/endAt on the document path.
      // We use a simple where("listId", "==", listId) query — the `listId` field
      // is set on each savedLists doc by the client (validSavedListDoc rule).
      // If the field is missing we fall back to checking the doc id in memory.
      let lastDoc = null;
      let hasMore = true;
      while (hasMore) {
        let query = db
          .collectionGroup("savedLists")
          .where("listId", "==", listId)
          .limit(300);
        if (lastDoc) query = query.startAfter(lastDoc);
        const snap2 = await query.get();
        if (snap2.empty) break;

        let batch = db.batch();
        let ops = 0;
        for (const d of snap2.docs) {
          batch.delete(d.ref);
          ops += 1;
          deleted += 1;
          if (ops >= 450) {
            await batch.commit();
            batch = db.batch();
            ops = 0;
          }
        }
        if (ops > 0) await batch.commit();

        lastDoc = snap2.docs[snap2.docs.length - 1];
        hasMore = snap2.size === 300;
      }
    } catch (err) {
      // Best-effort cleanup: if the collectionGroup query fails (e.g. missing
      // index) log a warning but don't fail the trigger. The integrator can
      // then deploy the index or run a manual cleanup script.
      logger.warn("[cleanupSavedListsOnListDelete] could not clean savedLists", {
        listId,
        deleted,
        err: String(err),
      });
    }

    if (deleted > 0) {
      logger.info("[cleanupSavedListsOnListDelete] done", { listId, deleted, subcollectionsDeleted });
    }
    return null;
  });

// ============================================================
// ANTI-SPOILER (auto-checker regex + moderationQueue triggers)
// ============================================================
// Pipeline:
//   - autore flagga manualmente `containsSpoiler:true` + `spoilerTitleIds:[]`
//     sul contenuto al momento della pubblicazione (threads.messages, posts,
//     posts.comments, recommendations);
//   - se NON flagga, un trigger onCreate fa girare un auto-checker regex
//     deterministico (`functions/modules/spoilerChecker`) e in caso di hit
//     scrive un doc in `moderationQueue` per review umana;
//   - l'admin via callable `confirmSpoilerSuspect` può promuovere il doc
//     originale a `containsSpoiler:true` (rendering blur lato client).
const { looksLikeSpoiler } = require("./modules/spoilerChecker");
const { looksLikeAbuse } = require("./lib/abuseCheck");

// Filtro automatico linguaggio abusivo (Guideline 1.2 — "a method for
// filtering objectionable content"). Gira negli stessi onCreate dei check
// spoiler, PRIMA dell'early-return sul flag spoiler (un contenuto flaggato
// spoiler può comunque essere abusivo). Hit → doc `moderationQueue` di tipo
// `abuse_suspect` + notifica in-app/push agli admin (SLA review 24h).
// Best-effort: non deve mai rompere la pipeline del contenuto.
async function flagAbuseSuspect({ source, doc, text, authorUid }) {
  try {
    const hit = looksLikeAbuse(text);
    if (!hit) return null;

    await admin.firestore().collection("moderationQueue").add({
      type: "abuse_suspect",
      source,
      docPath: doc,
      authorUid: authorUid ? String(authorUid) : null,
      preview: String(text || "").slice(0, 280),
      matchedPattern: hit.pattern,
      matchedText: hit.match,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      status: "pending",
    });

    await notifyAdminsModeration({
      fromUid: authorUid ? String(authorUid) : "system",
      data: {
        kind: "abuse_suspect",
        source,
        docPath: doc,
        matchedPattern: hit.pattern,
      },
    });

    logger.info("[abuse] flagged suspect", { source, docPath: doc, matchedPattern: hit.pattern });
  } catch (err) {
    logger.warn("[abuse] flagAbuseSuspect failed", { source, docPath: doc, error: err?.message || String(err) });
  }
  return null;
}

async function flagSpoilerSuspect({ source, doc, text, authorUid, titleIds }) {
  const sanitizedTitleIds = Array.isArray(titleIds)
    ? titleIds.map((v) => String(v || "").trim()).filter(Boolean).slice(0, 5)
    : [];

  let titleNames = [];
  if (sanitizedTitleIds.length) {
    try {
      const snaps = await Promise.all(
        sanitizedTitleIds.map((id) => admin.firestore().doc(`titles/${id}`).get())
      );
      titleNames = snaps
        .filter((s) => s.exists)
        .map((s) => String(s.data()?.name || "").trim())
        .filter(Boolean);
    } catch (err) {
      logger.warn("[spoiler] failed to fetch titles for checker", { err: String(err) });
    }
  }

  const hit = looksLikeSpoiler(text, titleNames);
  if (!hit) return null;

  await admin.firestore().collection("moderationQueue").add({
    type: "spoiler_suspect",
    source,
    docPath: doc,
    authorUid: authorUid ? String(authorUid) : null,
    preview: String(text || "").slice(0, 280),
    matchedPattern: hit.pattern,
    matchedText: hit.match,
    titleIds: sanitizedTitleIds,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    status: "pending",
  });

  logger.info("[spoiler] flagged suspect", {
    source,
    docPath: doc,
    matchedPattern: hit.pattern,
  });

  return null;
}

exports.flagSuspectedSpoilerThreadMessage = functions
  .region("europe-west1")
  .firestore.document("threads/{tid}/messages/{mid}")
  .onCreate(async (snap) => {
    const m = snap.data() || {};
    await flagAbuseSuspect({
      source: "threads.messages",
      doc: snap.ref.path,
      text: m.text || m.body || "",
      authorUid: m.uid || m.fromUid || null,
    });
    if (m.containsSpoiler === true) return null;
    return flagSpoilerSuspect({
      source: "threads.messages",
      doc: snap.ref.path,
      text: m.text || m.body || "",
      authorUid: m.uid || m.fromUid || null,
      titleIds: Array.isArray(m.spoilerTitleIds) && m.spoilerTitleIds.length
        ? m.spoilerTitleIds
        : (m.titleRef && m.titleRef.titleId ? [m.titleRef.titleId] : []),
    });
  });

exports.flagSuspectedSpoilerPost = functions
  .region("europe-west1")
  .firestore.document("posts/{id}")
  .onCreate(async (snap) => {
    const p = snap.data() || {};
    // I post-eco dei commenti sono già passati dal checker sul messaggio
    // originale (flagSuspectedSpoilerThreadMessage): ricontrollarli
    // raddoppierebbe le voci in moderationQueue sullo stesso testo.
    if (isEchoPostData(p)) return null;
    await flagAbuseSuspect({
      source: "posts",
      doc: snap.ref.path,
      text: p.text || p.body || "",
      authorUid: p.authorUid || p.uid || null,
    });
    if (p.containsSpoiler === true) return null;
    const tidFromPost = p.titleId ? [p.titleId] : [];
    return flagSpoilerSuspect({
      source: "posts",
      doc: snap.ref.path,
      text: p.text || p.body || "",
      authorUid: p.authorUid || p.uid || null,
      titleIds: Array.isArray(p.spoilerTitleIds) && p.spoilerTitleIds.length
        ? p.spoilerTitleIds
        : tidFromPost,
    });
  });

exports.flagSuspectedSpoilerComment = functions
  .region("europe-west1")
  .firestore.document("posts/{pid}/comments/{cid}")
  .onCreate(async (snap) => {
    const c = snap.data() || {};
    await flagAbuseSuspect({
      source: "posts.comments",
      doc: snap.ref.path,
      text: c.text || c.body || "",
      authorUid: c.uid || c.authorUid || null,
    });
    if (c.containsSpoiler === true) return null;
    return flagSpoilerSuspect({
      source: "posts.comments",
      doc: snap.ref.path,
      text: c.text || c.body || "",
      authorUid: c.uid || c.authorUid || null,
      titleIds: Array.isArray(c.spoilerTitleIds) ? c.spoilerTitleIds : [],
    });
  });

exports.flagSuspectedSpoilerRecommendation = functions
  .region("europe-west1")
  .firestore.document("recommendations/{id}")
  .onCreate(async (snap) => {
    const r = snap.data() || {};
    await flagAbuseSuspect({
      source: "recommendations",
      doc: snap.ref.path,
      text: r.message || r.text || "",
      authorUid: r.fromUid || null,
    });
    if (r.containsSpoiler === true) return null;
    const fromTitle = r.titleId ? [r.titleId] : [];
    return flagSpoilerSuspect({
      source: "recommendations",
      doc: snap.ref.path,
      text: r.message || r.text || "",
      authorUid: r.fromUid || null,
      titleIds: Array.isArray(r.spoilerTitleIds) && r.spoilerTitleIds.length
        ? r.spoilerTitleIds
        : fromTitle,
    });
  });

// Callable admin per chiudere un caso in moderationQueue:
//  - decision="confirmed": promuove il doc originale a containsSpoiler:true
//  - decision="false_positive": chiude senza modificare il doc
exports.confirmSpoilerSuspect = functions
  .region("europe-west1")
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid;
    if (!uid) {
      throw new functions.https.HttpsError("unauthenticated", "auth required");
    }
    const userSnap = await admin.firestore().doc(`users/${uid}`).get();
    if (userSnap.data()?.isAdmin !== true) {
      throw new functions.https.HttpsError("permission-denied", "admin only");
    }

    const queueId = String(data?.queueId || "").trim();
    const decision = String(data?.decision || "").trim();
    if (!queueId || !["confirmed", "false_positive"].includes(decision)) {
      throw new functions.https.HttpsError("invalid-argument", "queueId + decision required");
    }

    const queueRef = admin.firestore().doc(`moderationQueue/${queueId}`);
    const queueSnap = await queueRef.get();
    if (!queueSnap.exists) {
      throw new functions.https.HttpsError("not-found", "queue item not found");
    }
    const item = queueSnap.data() || {};

    if (decision === "confirmed") {
      const docPath = String(item.docPath || "").trim();
      if (docPath) {
        try {
          await admin.firestore().doc(docPath).update({
            containsSpoiler: true,
            spoilerConfirmedBy: "admin",
            spoilerConfirmedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        } catch (err) {
          logger.warn("[spoiler] failed to update original doc", { docPath, err: String(err) });
        }
      }
    }

    await queueRef.update({
      status: decision === "confirmed" ? "resolved_confirmed" : "resolved_false_positive",
      resolvedBy: uid,
      resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { ok: true };
  });

// ============================================
// RATING AGGREGATE (per-title denormalization)
// ============================================
//
// Trigger incrementale su /ratings/{ratingId}. Ad ogni create/update/delete
// applica solo il delta su `titles/{titleId}.ratingAggregate`, O(1):
//
//   ratingAggregate = {
//     titleLevel: { sum, count, avg },
//     bySeason:   { "1": { sum, count, avg }, "2": {...}, ... },
//     combined:   number (media pesata 2 decimali — vedi sotto),
//     updatedAt:  timestamp
//   }
//
// Modello `combined` (semplificato, defensible):
//   combined = (titleLevel.sum + Σ bySeason[*].sum) / (titleLevel.count + Σ bySeason[*].count)
//
// Cioè: ogni voto vale 1 unità in media, indipendentemente dal livello. Più
// stagioni vota un utente, più peso ha in combined. Trasparente e robusto
// rispetto a una vera media-di-medie-per-utente (che richiederebbe un'altra
// collection seasonUsers e logica più costosa).
exports.recomputeTitleRatingAggregate = functions
  .region("europe-west1")
  .firestore.document("ratings/{ratingId}")
  .onWrite(async (change, _ctx) => {
    const before = change.before.exists ? change.before.data() : null;
    const after = change.after.exists ? change.after.data() : null;
    const titleId = String((after?.titleId) || (before?.titleId) || "").trim();
    if (!titleId) return null;

    // Voti dei profili guidati (sintetici) ESCLUSI dal voto pubblico community:
    // niente inquinamento di ratingAggregate / AggregateRating SSR/JSON-LD.
    if (isSyntheticDoc(after) || isSyntheticDoc(before)) return null;

    const ratingBefore = Number(before?.rating);
    const ratingAfter = Number(after?.rating);
    const levelBefore = before?.level || null;
    const levelAfter = after?.level || null;
    const seasonBefore = Number.isFinite(Number(before?.season)) ? Number(before.season) : null;
    const seasonAfter = Number.isFinite(Number(after?.season)) ? Number(after.season) : null;

    // No-op: nessun campo rilevante per l'aggregato è cambiato.
    if (
      ratingBefore === ratingAfter &&
      levelBefore === levelAfter &&
      seasonBefore === seasonAfter
    ) {
      return null;
    }

    const titleRef = admin.firestore().doc(`titles/${titleId}`);

    return admin.firestore().runTransaction(async (txn) => {
      const titleSnap = await txn.get(titleRef);
      if (!titleSnap.exists) return null;

      const data = titleSnap.data() || {};
      const seed = data.ratingAggregate || {};
      const agg = {
        titleLevel: {
          sum: Number(seed?.titleLevel?.sum) || 0,
          count: Number(seed?.titleLevel?.count) || 0,
          avg: Number(seed?.titleLevel?.avg) || 0,
        },
        bySeason: { ...(seed.bySeason || {}) },
        combined: 0,
      };

      function ensureSeasonBucket(key) {
        if (!agg.bySeason[key]) {
          agg.bySeason[key] = { sum: 0, count: 0, avg: 0 };
        }
        return agg.bySeason[key];
      }

      function applyDelta(target, deltaSum, deltaCount) {
        target.sum = Math.max(0, (Number(target.sum) || 0) + deltaSum);
        target.count = Math.max(0, (Number(target.count) || 0) + deltaCount);
        target.avg = target.count > 0 ? target.sum / target.count : 0;
      }

      // titleLevel delta
      if (levelBefore === "title" && Number.isFinite(ratingBefore)) {
        applyDelta(agg.titleLevel, -ratingBefore, -1);
      }
      if (levelAfter === "title" && Number.isFinite(ratingAfter)) {
        applyDelta(agg.titleLevel, ratingAfter, 1);
      }

      // bySeason delta
      if (levelBefore === "season" && Number.isFinite(ratingBefore) && Number.isFinite(seasonBefore)) {
        const key = String(seasonBefore);
        const bucket = ensureSeasonBucket(key);
        applyDelta(bucket, -ratingBefore, -1);
        if (bucket.count <= 0) {
          delete agg.bySeason[key];
        }
      }
      if (levelAfter === "season" && Number.isFinite(ratingAfter) && Number.isFinite(seasonAfter)) {
        const key = String(seasonAfter);
        const bucket = ensureSeasonBucket(key);
        applyDelta(bucket, ratingAfter, 1);
      }

      // combined: media pesata title-level + tutti i voti per stagione.
      let totalSum = agg.titleLevel.sum;
      let totalCount = agg.titleLevel.count;
      Object.values(agg.bySeason).forEach((bucket) => {
        totalSum += Number(bucket.sum) || 0;
        totalCount += Number(bucket.count) || 0;
      });
      agg.combined = totalCount > 0 ? Math.round((totalSum / totalCount) * 100) / 100 : 0;

      txn.update(titleRef, {
        ratingAvg: agg.titleLevel.count > 0 ? agg.titleLevel.avg : 0,
        ratingCount: agg.titleLevel.count,
        ratingAggregate: {
          ...agg,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      });
      return null;
    });
  });

// ============================================
// EMOTION AGGREGATE (per-title denormalization)
// ============================================
//
// Trigger incrementale su /titleEmotions/{emotionId} (emozioni post-visione,
// "Che impressione hai avuto?"). Specchio strutturale di
// recomputeTitleRatingAggregate: ad ogni create/update/delete applica solo il
// delta su `titles/{titleId}.emotionAggregate`, O(1), in transazione:
//
//   emotionAggregate = {
//     counts: { touched: 12, thrilled: 9, ... },  // solo chiavi > 0
//     totalSelections: number,   // base delle percentuali (sommano a 100)
//     totalUsers: number,        // doc distinti (1 doc = 1 utente per titolo)
//     updatedAt: timestamp
//   }
//
// Logica delta condivisa in lib/emotionAggregate.js (unit test + backfill
// scripts/backfill-titleEmotionAggregate.js).
exports.recomputeTitleEmotionAggregate = functions
  .region("europe-west1")
  .firestore.document("titleEmotions/{emotionId}")
  .onWrite(async (change, _ctx) => {
    const before = change.before.exists ? change.before.data() : null;
    const after = change.after.exists ? change.after.data() : null;
    const titleId = String((after?.titleId) || (before?.titleId) || "").trim();
    if (!titleId) return null;

    // Emozioni dei profili guidati (sintetici) ESCLUSE dall'aggregato
    // community, come per ratingAggregate.
    if (isSyntheticDoc(after) || isSyntheticDoc(before)) return null;

    // No-op: set di emozioni invariato (es. update che tocca solo updatedAt).
    if (emotionSetsEqual(before?.emotions, after?.emotions)) return null;

    const titleRef = admin.firestore().doc(`titles/${titleId}`);

    return admin.firestore().runTransaction(async (txn) => {
      const titleSnap = await txn.get(titleRef);
      if (!titleSnap.exists) return null;

      const seed = (titleSnap.data() || {}).emotionAggregate || {};
      const agg = applyEmotionAggregateDelta(seed, before?.emotions, after?.emotions);

      txn.update(titleRef, {
        emotionAggregate: {
          ...agg,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      });
      return null;
    });
  });

// ============================================
// EPISODE EMOTION AGGREGATES
// ============================================
//
// Trigger gen2 su /episodeEmotions/{emotionId}. Ogni documento individuale
// aggiorna, con delta O(1), il bucket server-owned:
//   titles/{titleId}/episodeEmotionAggregates/{season}_{episode}
//     { counts, totalSelections, totalUsers, updatedAt }
//
// `titleEmotions` e titles/{id}.emotionAggregate non vengono letti né
// modificati: la migrazione è additiva e non attribuisce retroattivamente
// emozioni title-level a un episodio inventato. Gen2/europe-west1 segue i
// trigger characterVotes perché il database eur3 non accetta nuovi trigger
// Firestore gen1.
exports.recomputeEpisodeEmotionAggregate = functionsV2Firestore.onDocumentWritten(
  {
    document: "episodeEmotions/{emotionId}",
    region: "europe-west1",
  },
  async (event) => {
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const after = event.data?.after?.exists ? event.data.after.data() : null;

    // Profili guidati/sintetici esclusi da tutti gli aggregati community.
    if (isSyntheticDoc(after) || isSyntheticDoc(before)) return null;

    // Le coordinate sono immutabili per security rules. Si prende quindi un
    // unico lato come sorgente, evitando di comporre title/season/episode da
    // versioni diverse dello stesso documento.
    const source = after || before;
    const titleId = String((source && source.titleId) || "").trim();
    const season = Number(source && source.season);
    const episode = Number(source && source.episode);
    if (!titleId || source?.level !== "episode") return null;

    const bucketId = makeEpisodeEmotionBucketId(season, episode);
    if (!bucketId) return null;

    // Update di soli timestamp/source o riordino della stessa selezione.
    if (episodeEmotionSetsEqual(before?.emotions, after?.emotions)) return null;

    const db = admin.firestore();
    const titleRef = db.doc(`titles/${titleId}`);
    const aggregateRef = db.doc(`titles/${titleId}/episodeEmotionAggregates/${bucketId}`);

    return db.runTransaction(async (txn) => {
      const [titleSnap, aggregateSnap] = await Promise.all([
        txn.get(titleRef),
        txn.get(aggregateRef),
      ]);
      // Coerente con recomputeTitleEmotionAggregate: niente aggregati orfani
      // se il titolo non esiste.
      if (!titleSnap.exists) return null;

      const { next, changed } = applyEpisodeEmotionAggregateDelta(
        aggregateSnap.exists ? aggregateSnap.data() : null,
        before?.emotions,
        after?.emotions
      );
      if (!changed) return null;

      txn.set(aggregateRef, {
        ...next,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return null;
    });
  }
);

// ============================================
// DERIVED RATING ROLL-UP (per-user, PRIVATO)
// ============================================
//
// Trigger incrementale su /ratings/{ratingId}: quando cambia un voto EPISODIO,
// ricalcola il voto derivato di stagione+serie per quell'(utente, titolo) e lo
// salva in users/{uid}/derivedRatings/{titleId}. Delta O(#stagioni).
//
//   users/{uid}/derivedRatings/{titleId} = {
//     uid, titleId,
//     episodeAgg: { bySeason: { "1": {sum, count}, ... } },   // grezzo (replay)
//     season:     { "1": {avg, count}, ... },                 // media episodi/stagione
//     series:     { avg, seasonCount, episodeCount } | null,  // media stagioni
//     updatedAt
//   }
//
// PRIVATO by construction: vive fuori da /ratings/, quindi NON tocca
// recomputeTitleRatingAggregate né l'aggregato pubblico community. L'override
// esplicito (voto title/season in /ratings/) è gestito a display e non viene
// mai sovrascritto. `stats.derivedRatingsCount` conta i titoli con voto serie
// derivato (mostrato come "+N dai tuoi voti episodio", separato da ratingsCount
// che resta = voti espliciti). Logica delta pura in lib/derivedRatingAggregate.js.
exports.recomputeUserDerivedRating = functions
  .region("europe-west1")
  .firestore.document("ratings/{ratingId}")
  .onWrite(async (change, _ctx) => {
    const before = change.before.exists ? change.before.data() : null;
    const after = change.after.exists ? change.after.data() : null;

    // Voti sintetici (profili guidati) esclusi, come per gli aggregati pubblici.
    if (isSyntheticDoc(after) || isSyntheticDoc(before)) return null;

    // Solo i voti episodio alimentano il derivato; skip tutto il resto e i
    // no-op (stesso episodio, stesso voto).
    if (derivedDeltaIsNoop(before, after)) return null;

    const uid = String((after?.uid) || (before?.uid) || "").trim();
    const titleId = String((after?.titleId) || (before?.titleId) || "").trim();
    if (!uid || !titleId) return null;

    const derivedRef = admin.firestore()
      .doc(`users/${uid}/derivedRatings/${titleId}`);
    const userRef = admin.firestore().doc(`users/${uid}`);

    return admin.firestore().runTransaction(async (txn) => {
      const snap = await txn.get(derivedRef);
      const seed = snap.exists ? (snap.data() || {}) : null;
      const hadSeries = Boolean(seed && seed.series);

      const next = applyDerivedEpisodeDelta(seed, before, after);
      const hasSeries = Boolean(next.series);

      // Il derivato conta nel profilo (derivedRatingsCount) quando esiste un
      // voto serie; il delta scatta solo alla prima/ultima stagione del titolo.
      let countDelta = 0;
      if (hasSeries && !hadSeries) countDelta = 1;
      if (!hasSeries && hadSeries) countDelta = -1;

      if (next.isEmpty) {
        if (snap.exists) txn.delete(derivedRef);
      } else {
        txn.set(derivedRef, {
          uid,
          titleId,
          episodeAgg: next.episodeAgg,
          season: next.season,
          series: next.series,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      if (countDelta !== 0) {
        txn.set(userRef, {
          stats: {
            derivedRatingsCount: admin.firestore.FieldValue.increment(countDelta),
          },
        }, { merge: true });
      }
      return null;
    });
  });

// ============================================
// CHARACTER VOTE AGGREGATES ("Chi ti ha conquistato?")
// ============================================
//
// Spec: docs/CHARACTER_VOTES_SPEC.md §2-§3. Due hop incrementali, mirror
// strutturale di recomputeTitleEmotionAggregate / recomputeUserDerivedRating:
// logica pura in lib/characterVoteAggregate.js, i trigger sono solo I/O +
// transazioni.
//
// Hop 1 — characterVotes/{voteId} (voto individuale, 1 doc/utente/oggetto
// votato):
//   - aggiorna titles/{titleId}/characterVotes/{s}_{e} (§2.2, volume grezzo,
//     SOLO level="episode"), in transazione;
//   - aggiorna users/{uid}/characterPicks/{titleId} (§2.4, rollup
//     personale), in una SECONDA transazione separata (collection diversa
//     da §2.2, nessuna atomicità congiunta richiesta; ognuna rilegge il
//     proprio doc dentro la propria transazione).
//
// Il rollup NON passa entered/left al hop 2 esplicitamente: il hop 2 li
// ricava diffando prima/dopo la propria scrittura (idempotente, compatibile
// con backfill che scrivono characterPicks direttamente — vedi sotto).
//
// Gen2 (Eventarc), non gen1: il database `eur3` non supporta più trigger
// Firestore gen1 (vedi nota sull'import in cima al file). Region
// "europe-west1" = uno dei due read-write region di eur3 (l'altro è
// europe-west4; europe-north1 è solo witness/quorum) — stessa region usata
// da TUTTI gli altri trigger gen1 del file, quindi nessuna divergenza di
// location. Fonte: https://cloud.google.com/eventarc/docs/locations
// ("eur3: EUROPE-WEST1 and EUROPE-WEST4") +
// https://firebase.google.com/docs/firestore/locations. Nessuna opzione
// `database` esplicita: il default è "(default)", che è il nostro database
// (vedi docs/FIREBASE_DATA_MODEL.md).
exports.recomputeCharacterVoteAggregates = functionsV2Firestore.onDocumentWritten(
  {
    document: "characterVotes/{voteId}",
    region: "europe-west1",
  },
  async (event) => {
    // gen2: event.data è l'intero Change<DocumentSnapshot> — sia event.data
    // stesso sia event.data.before/event.data.after possono essere assenti
    // (create/delete) — in gen1 before/after esistevano SEMPRE come
    // snapshot con .exists=false. L'optional chaining copre tutti i casi e
    // riproduce lo stesso pattern "exists ? data() : null" di prima.
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const after = event.data?.after?.exists ? event.data.after.data() : null;

    // Voti dei profili guidati (sintetici) ESCLUSI, come ratingAggregate/
    // emotionAggregate: niente inquinamento della classifica community.
    if (isSyntheticDoc(after) || isSyntheticDoc(before)) return null;

    // titleId/uid/level/season/episode sono immutabili per rule una volta
    // create (§4 spec): si leggono da UN solo doc sorgente (after se esiste,
    // altrimenti before), mai mischiando campi dei due lati del before/after.
    const source = after || before;
    const uid = String((source && source.uid) || "").trim();
    const titleId = String((source && source.titleId) || "").trim();
    const level = source && source.level;
    if (!uid || !titleId || (level !== "title" && level !== "episode")) return null;

    const season = Number.isInteger(Number(source && source.season)) ? Number(source.season) : 0;
    const episode = Number.isInteger(Number(source && source.episode)) ? Number(source.episode) : 0;

    const beforePicks = normalizePicks(before && before.picks);
    const afterPicks = normalizePicks(after && after.picks);

    // No-op: set di pick invariato (update che tocca solo updatedAt/source).
    if (sameJsonValue(beforePicks, afterPicks)) return null;

    const db = admin.firestore();

    // --- §2.2 aggregato episodio (volume), solo level="episode".
    if (level === "episode") {
      const bucketId = makeEpisodeBucketId(season, episode);
      if (bucketId) {
        const bucketRef = db.doc(`titles/${titleId}/characterVotes/${bucketId}`);
        await db.runTransaction(async (txn) => {
          const snap = await txn.get(bucketRef);
          const { next, changed } = applyEpisodeAggregateDelta(snap.exists ? snap.data() : null, {
            beforePicks,
            afterPicks,
          });
          if (!changed) return null;
          txn.set(bucketRef, {
            ...next,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          return null;
        });
      }
    }

    // --- §2.4 rollup personale.
    const rollupRef = db.doc(`users/${uid}/characterPicks/${titleId}`);
    await db.runTransaction(async (txn) => {
      const snap = await txn.get(rollupRef);
      const current = snap.exists ? snap.data() : null;
      const { next, changed } = applyPersonalRollupDelta(current, {
        level,
        season,
        beforePicks,
        afterPicks,
      });
      if (!changed) return null;
      // merge:true (non plain set): `next` non include ancora `streak` (non
      // calcolato dal modulo oggi, vedi spec §2.4) — merge evita che una
      // futura scrittura di badge/streak da un altro path venga cancellata
      // ad ogni voto personaggio.
      txn.set(rollupRef, {
        uid,
        titleId,
        ...next,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return null;
    });

    return null;
  }
);

// Diff di presenza chiavi tra due mappe personId->count già materializzate
// (non pick grezzi: per quello c'è applyMapDelta dentro lib/characterVoteAggregate.js,
// non esportato perché interno al calcolo del rollup). Usata SOLO dal hop 2
// sotto per ricavare entered/left dal proprio before/after, senza duplicare
// la logica di conteggio del modulo (qui si confrontano solo insiemi di
// chiavi, nessuna aritmetica di count).
function diffPresenceKeys(beforeMap, afterMap) {
  const beforeKeys = Object.keys(beforeMap);
  const afterKeys = Object.keys(afterMap);
  const beforeSet = new Set(beforeKeys);
  const afterSet = new Set(afterKeys);
  const entered = afterKeys.filter((key) => !beforeSet.has(key));
  const left = beforeKeys.filter((key) => !afterSet.has(key));
  return { entered, left };
}

// Hop 2 — users/{uid}/characterPicks/{titleId} (rollup personale) ->
// titles/{titleId}/aggregates/characters (§2.3, utenti unici per
// personaggio). Guard anti-loop: questo trigger scrive SOLO su
// titles/{titleId}/aggregates/characters, mai su characterPicks — non può
// ri-innescare se stesso né il hop 1 (che ascolta solo characterVotes).
//
// Gen2 (Eventarc), stesso motivo/region del hop 1 sopra (database `eur3`,
// vedi nota sull'import in cima al file). Nessuna opzione `database`: default
// "(default)".
exports.recomputeTitleCharacterAggregate = functionsV2Firestore.onDocumentWritten(
  {
    document: "users/{uid}/characterPicks/{titleId}",
    region: "europe-west1",
  },
  async (event) => {
    // gen2: i wildcard del path sono in event.params (sostituisce context.params).
    const uid = String((event.params && event.params.uid) || "").trim();
    const titleId = String((event.params && event.params.titleId) || "").trim();
    if (!uid || !titleId) return null;

    // Profili guidati esclusi: uid sintetico per costruzione (guided_*, mai
    // Auth reale) — stesso guard usato in modules/guidedProfiles/dmResponder.js.
    // Il rollup scritto dal hop 1 oggi non porta `isSynthetic` (il hop 1
    // blocca i voti sintetici PRIMA di scrivere il rollup, quindi in
    // condizioni normali non c'è nulla da propagare); l'isSyntheticDoc sotto
    // resta comunque come difesa in profondità per un futuro backfill/admin
    // script che scrivesse characterPicks direttamente con isSynthetic:true.
    if (isGuidedUid(uid)) return null;

    // gen2: event.data/before/after possono essere assenti (create/delete),
    // in gen1 before/after esistevano sempre come snapshot .exists=false —
    // vedi stessa nota nel hop 1 sopra.
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    if (isSyntheticDoc(after) || isSyntheticDoc(before)) return null;

    const beforeSeries = asObject(before && before.series);
    const afterSeries = asObject(after && after.series);
    const beforeDirect = asObject(before && before.direct);
    const afterDirect = asObject(after && after.direct);
    const beforeBySeason = asObject(before && before.bySeason);
    const afterBySeason = asObject(after && after.bySeason);

    // entered/left + transizione vuoto<->non vuoto per ciascuno scope
    // (§2.3): "series" e "direct" sono singoli, "bySeason" richiede di
    // trovare quali chiavi stagione sono cambiate prima.
    const seriesDiff = diffPresenceKeys(beforeSeries, afterSeries);
    const seriesUserEntered = Object.keys(beforeSeries).length === 0 && Object.keys(afterSeries).length > 0;
    const seriesUserLeft = Object.keys(beforeSeries).length > 0 && Object.keys(afterSeries).length === 0;
    const touchesSeries = Boolean(
      seriesDiff.entered.length || seriesDiff.left.length || seriesUserEntered || seriesUserLeft
    );

    const directDiff = diffPresenceKeys(beforeDirect, afterDirect);
    const directUserEntered = Object.keys(beforeDirect).length === 0 && Object.keys(afterDirect).length > 0;
    const directUserLeft = Object.keys(beforeDirect).length > 0 && Object.keys(afterDirect).length === 0;
    const touchesDirect = Boolean(
      directDiff.entered.length || directDiff.left.length || directUserEntered || directUserLeft
    );

    const seasonKeys = new Set([...Object.keys(beforeBySeason), ...Object.keys(afterBySeason)]);
    const seasonDiffs = [];
    for (const seasonKey of seasonKeys) {
      const seasonNum = Number(seasonKey);
      if (!Number.isInteger(seasonNum) || seasonNum <= 0) continue;
      const beforeSeasonMap = asObject(beforeBySeason[seasonKey]);
      const afterSeasonMap = asObject(afterBySeason[seasonKey]);
      const diff = diffPresenceKeys(beforeSeasonMap, afterSeasonMap);
      const userEntered = Object.keys(beforeSeasonMap).length === 0 && Object.keys(afterSeasonMap).length > 0;
      const userLeft = Object.keys(beforeSeasonMap).length > 0 && Object.keys(afterSeasonMap).length === 0;
      if (diff.entered.length || diff.left.length || userEntered || userLeft) {
        seasonDiffs.push({ seasonKey, entered: diff.entered, left: diff.left, userEntered, userLeft });
      }
    }

    // No-op totale: nessuno scope ha una transizione reale da propagare.
    if (!touchesSeries && !touchesDirect && seasonDiffs.length === 0) return null;

    const aggRef = admin.firestore().doc(`titles/${titleId}/aggregates/characters`);

    return admin.firestore().runTransaction(async (txn) => {
      const snap = await txn.get(aggRef);
      let current = snap.exists ? snap.data() : null;
      let anyChanged = false;

      if (touchesSeries) {
        const { next, changed } = applyUniqueUserAggregateDelta(current, {
          scope: "series",
          entered: seriesDiff.entered,
          left: seriesDiff.left,
          userEntered: seriesUserEntered,
          userLeft: seriesUserLeft,
        });
        current = next;
        anyChanged = anyChanged || changed;
      }

      for (const seasonDiff of seasonDiffs) {
        const { next, changed } = applyUniqueUserAggregateDelta(current, {
          scope: "season",
          seasonKey: seasonDiff.seasonKey,
          entered: seasonDiff.entered,
          left: seasonDiff.left,
          userEntered: seasonDiff.userEntered,
          userLeft: seasonDiff.userLeft,
        });
        current = next;
        anyChanged = anyChanged || changed;
      }

      if (touchesDirect) {
        const { next, changed } = applyUniqueUserAggregateDelta(current, {
          scope: "direct",
          entered: directDiff.entered,
          left: directDiff.left,
          userEntered: directUserEntered,
          userLeft: directUserLeft,
        });
        current = next;
        anyChanged = anyChanged || changed;
      }

      // Guard no-op finale: es. entered/left che si annullano a vicenda
      // dentro applyUniqueUserAggregateDelta (già lui stesso ha un changed).
      if (!anyChanged) return null;

      txn.set(aggRef, {
        ...current,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return null;
    });
  }
);

// Admin-only: correggi la data di uscita di un evento titolo, e/o pubblica un
// draft.
//
// PERCHE' PASSA DA QUI — `titleUpdateEvents` e' deny-all per i client
// (firestore.rules: `allow create, update, delete: if false`), admin inclusi.
// Ogni scrittura deve venire dall'Admin SDK.
//
// PERCHE' SERVE — l'id di un evento release_date e' `tmdb_release_movie_<id>`:
// la data non entra nell'id, quindi lo scanner (che ripassa su ogni titolo ogni
// ~2,5 giorni) riscrive `effectiveAt` col valore TMDB. La patch qui sotto fissa
// i campi corretti in `editorial.lockedFields`, che `mergeExistingEvent`
// rispetta. Senza, una correzione durerebbe due giorni.
//
// Inoltre sblocca i draft: un film senza release italiana confermata resta
// `draft` e oggi non lo puo' pubblicare nessuno.
exports.reviewTitleUpdateEvent = functions
  .region("europe-west1")
  .https.onCall(async (data, context) => {
    const callerUid = context.auth?.uid || null;
    if (!callerUid) throw new functions.https.HttpsError("unauthenticated", "Login richiesto.");
    const db = admin.firestore();
    if (!(await isAdminCaller(db, callerUid))) {
      throw new functions.https.HttpsError("permission-denied", "Solo gli admin possono correggere gli eventi titolo.");
    }

    const eventId = toId(data?.eventId);
    if (!eventId) throw new functions.https.HttpsError("invalid-argument", "eventId richiesto.");

    const ref = db.collection("titleUpdateEvents").doc(eventId);
    const snap = await ref.get();
    if (!snap.exists) throw new functions.https.HttpsError("not-found", "Evento inesistente.");

    let built;
    try {
      built = buildEditorialPatch({
        existing: snap.data() || {},
        // `undefined` = "non toccare questo campo"; una stringa vuota sarebbe
        // una richiesta di cancellarlo, che qui non ha senso.
        effectiveDate: data?.effectiveDate === undefined ? undefined : String(data.effectiveDate || ""),
        region: data?.region === undefined ? undefined : String(data.region || ""),
        releaseType: data?.releaseType === undefined ? undefined : data.releaseType,
        publish: Boolean(data?.publish),
        note: data?.note,
        editedBy: callerUid,
        now: new Date(),
      });
    } catch (err) {
      throw new functions.https.HttpsError("invalid-argument", String(err?.message || err).slice(0, 200));
    }

    // Il dry-run esiste perche' `willNotify` va potuto LEGGERE prima di
    // premere: pubblicare un'uscita imminente manda una push a chiunque abbia
    // il titolo in watchlist, e non si annulla.
    if (data?.dryRun) {
      return {
        ok: true,
        dryRun: true,
        eventId,
        lockedFields: built.lockedFields,
        willNotify: built.willNotify,
        warnings: built.warnings,
      };
    }

    await ref.set(built.patch, { merge: true });

    logger.info("[title-update] correzione editoriale", {
      eventId,
      by: callerUid,
      lockedFields: built.lockedFields,
      published: built.patch.status === "published",
      willNotify: built.willNotify,
    });

    return {
      ok: true,
      dryRun: false,
      eventId,
      lockedFields: built.lockedFields,
      willNotify: built.willNotify,
      warnings: built.warnings,
    };
  });
