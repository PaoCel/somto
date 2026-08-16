/**
 * Guided Profiles — routine di attivita'.
 *
 * Nucleo riusabile da: scheduler (`runGuidedProfileActivity`), callable admin
 * (`runGuidedProfileActivityNow`) e script CLI (`run-guided-activity.js`).
 *
 * Tutto scritto via admin SDK (bypassa le rules). Ogni contenuto e' marcato
 * `isSynthetic: true` cosi' i trigger reali (rating aggregate pubblico,
 * leaderboard) lo escludono. Fan-out feed limitato per modalita'.
 *
 * Supporta dry-run (ZERO scritture) e randomizzazione controllata.
 */

const {
  ACTION_TYPE,
  CONTENT_STATUS,
  COLLECTIONS,
  ACTIVITY_LEVEL_ACT_PROBABILITY,
  ACTIVITY_LEVEL_MAX_ACTIONS_PER_RUN,
} = require("./constants");
const { evaluateGate } = require("./config");
const { generateGuidedProfileContent } = require("./contentGenerator");
const { writeFeedEvents, collectFeedRecipientUids } = require("../../lib/feedEvents");

const TITLE_POOL_LIMIT = 300;
const TARGET_POST_LIMIT = 25;

// Azioni che generano TESTO -> soggette a human review se attiva.
const TEXT_ACTIONS = new Set([ACTION_TYPE.REVIEW, ACTION_TYPE.POST, ACTION_TYPE.COMMENT]);

// ---------------------------------------------------------------------------
// Helpers puri (testabili senza Firestore)
// ---------------------------------------------------------------------------

// Allineato a safePart() della PWA (ratings.api.js): mantiene `_` e `-`.
function safePart(value) {
  return String(value ?? "0").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function makeRatingId(uid, titleId) {
  return `${safePart(uid)}__${safePart(titleId)}__title__0__0`;
}

function dateKeyRome(ms) {
  // YYYY-MM-DD nel fuso Europe/Rome (en-CA produce il formato ISO).
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: "Europe/Rome" });
}

function pickOne(list, rng) {
  if (!list || !list.length) return null;
  return list[Math.floor(rng() * list.length)];
}

function normalizeMediaType(title) {
  const t = String((title && (title.type || title.mediaType)) || "").toLowerCase();
  if (["tv", "serie", "serie_tv", "series", "show"].includes(t)) return "tv";
  return "movie";
}

function remainingDailyBudget(profile, todayKey, maxPerDay) {
  const daily = profile.dailyActions || {};
  const used = daily.dateKey === todayKey ? Number(daily.count || 0) : 0;
  return Math.max(0, Number(maxPerDay || 0) - used);
}

/**
 * Pianifica quante azioni fa ogni profilo in questo run, con randomizzazione
 * per livello di attivita' e rispetto dei cap (per-profilo/giorno e globale).
 * Helper PURO: rng iniettabile per i test.
 *
 * @returns {Array<{uid, profile, actionCount}>}
 */
function planRun(profiles, { todayKey, maxActionsPerRun, maxActionsPerProfilePerDay, rng = Math.random } = {}) {
  const plans = [];
  let budgetLeft = Math.max(0, Number(maxActionsPerRun || 0));

  // Ordine casuale: niente pattern fisso su chi agisce prima.
  const shuffled = profiles
    .map((p) => ({ p, k: rng() }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.p);

  for (const profile of shuffled) {
    if (budgetLeft <= 0) break;
    const level = String(profile.activityLevel || "low");
    const actProb = ACTIVITY_LEVEL_ACT_PROBABILITY[level] ?? 0.1;
    if (rng() > actProb) continue; // oggi non fa nulla

    const perRunCap = ACTIVITY_LEVEL_MAX_ACTIONS_PER_RUN[level] ?? 1;
    const dailyLeft = remainingDailyBudget(profile, todayKey, maxActionsPerProfilePerDay);
    // 1..perRunCap azioni, ma non oltre budget giornaliero/globale.
    let actionCount = 1 + Math.floor(rng() * perRunCap);
    actionCount = Math.min(actionCount, perRunCap, dailyLeft, budgetLeft);
    if (actionCount <= 0) continue;

    budgetLeft -= actionCount;
    plans.push({ uid: profile.uid, profile, actionCount });
  }

  return plans;
}

/** Sceglie il tipo di azione tra quelle consentite, con piccola preferenza. */
function chooseActionType(allowedActionTypes, rng = Math.random) {
  const allowed = (allowedActionTypes || []).filter(Boolean);
  if (!allowed.length) return null;
  // Pesi: comportamento da utente vero -> la RECENSIONE (voto + testo) e' l'azione
  // principale; post e commenti animano le discussioni; il voto secco e' minoranza.
  const weights = {
    [ACTION_TYPE.REVIEW]: 5,
    [ACTION_TYPE.COMMENT]: 3,
    [ACTION_TYPE.POST]: 2,
    [ACTION_TYPE.RATE]: 2,
    [ACTION_TYPE.MARK_SEEN]: 2,
    [ACTION_TYPE.ADD_WATCHLIST]: 2,
    [ACTION_TYPE.REACT]: 2,
  };
  const bag = [];
  for (const a of allowed) {
    const w = weights[a] || 1;
    for (let i = 0; i < w; i++) bag.push(a);
  }
  return pickOne(bag, rng);
}

// ---------------------------------------------------------------------------
// Esecuzione (impura: tocca Firestore, salvo dryRun)
// ---------------------------------------------------------------------------

/**
 * Esegue la routine guidata.
 *
 * @param {object} deps { db, admin, logger }
 * @param {object} opts {
 *   config,                // config gia' normalizzata
 *   dryRunOverride,        // bool|undefined -> forza dry-run
 *   isEmulator,            // bool
 *   adminUids,             // string[] (per fan-out test_only)
 *   runId,                 // string
 *   nowMs,                 // number (default Date.now())
 *   rng,                   // () => number (default Math.random)
 * }
 * @returns {Promise<object>} report
 */
async function runGuidedActivity({ db, admin, logger }, opts = {}) {
  const config = opts.config;
  const rng = opts.rng || Math.random;
  const nowMs = Number(opts.nowMs) || Date.now();
  const todayKey = dateKeyRome(nowMs);
  const dryRun = opts.dryRunOverride === true || config.dryRun === true;
  const adminUids = Array.isArray(opts.adminUids) ? opts.adminUids : [];

  const report = {
    runId: opts.runId || `run_${nowMs}`,
    startedAtMs: nowMs,
    dryRun,
    mode: config.guidedProfilesMode,
    requireHumanReview: config.requireHumanReview === true,
    gate: null,
    selectedProfiles: [],
    actions: [],
    drafts: 0,
    published: 0,
    feedEventsWritten: 0,
    errors: [],
  };

  const gate = evaluateGate(config, { isEmulator: opts.isEmulator === true });
  report.gate = gate;
  if (!gate.allowed) {
    report.skipped = true;
    return report;
  }

  // 1) Profili guidati attivi.
  const profilesSnap = await db.collection(COLLECTIONS.GUIDED_PROFILES)
    .where("status", "==", "active")
    .get();
  const profiles = profilesSnap.docs.map((d) => ({ uid: d.id, ...(d.data() || {}) }));
  if (!profiles.length) {
    report.skipped = true;
    report.reason = "no_active_profiles";
    return report;
  }

  // 2) Pool titoli approvati (campione).
  const titlesSnap = await db.collection("titles")
    .where("status", "==", "approved")
    .limit(TITLE_POOL_LIMIT)
    .get();
  const titlePool = titlesSnap.docs.map((d) => {
    const t = d.data() || {};
    return { id: d.id, name: t.title || t.name || d.id, type: t.type || t.mediaType || "movie" };
  });
  if (!titlePool.length) {
    report.skipped = true;
    report.reason = "no_titles";
    return report;
  }

  // 3) Pool post guidati esistenti (target per commenti/reazioni).
  let guidedPosts = [];
  try {
    const postsSnap = await db.collection("posts")
      .where("isSynthetic", "==", true)
      .limit(TARGET_POST_LIMIT)
      .get();
    guidedPosts = postsSnap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
  } catch (err) {
    logger.warn("[guided] target posts query failed", { error: err?.message || String(err) });
  }

  // 4) Pianifica chi agisce e quante azioni.
  const plans = planRun(profiles, {
    todayKey,
    maxActionsPerRun: config.maxActionsPerRun,
    maxActionsPerProfilePerDay: config.maxActionsPerProfilePerDay,
    rng,
  });
  report.selectedProfiles = plans.map((p) => ({ uid: p.uid, actionCount: p.actionCount, level: p.profile.activityLevel }));

  const serverTimestamp = admin.firestore.FieldValue.serverTimestamp();

  // 5) Esegui per profilo.
  for (const plan of plans) {
    const profile = plan.profile;
    const persona = { genres: profile.genres || [], tone: profile.tone || "", flavor: profile.flavor || [] };
    let executedForProfile = 0;

    for (let i = 0; i < plan.actionCount; i++) {
      const actionType = chooseActionType(config.allowedActionTypes, rng);
      if (!actionType) continue;

      try {
        const result = await executeAction({
          db, admin, logger, dryRun,
          profile, persona, actionType,
          titlePool, guidedPosts,
          config, gate, adminUids, serverTimestamp, rng,
        });
        if (result) {
          report.actions.push({ uid: plan.uid, actionType, ...result.summary });
          if (result.draft) report.drafts += 1;
          if (result.published) report.published += 1;
          report.feedEventsWritten += result.feedEventsWritten || 0;
          executedForProfile += 1;
        }
      } catch (err) {
        report.errors.push({ uid: plan.uid, actionType, error: err?.message || String(err) });
        logger.warn("[guided] action failed", { uid: plan.uid, actionType, error: err?.message || String(err) });
      }
    }

    // Aggiorna contatore giornaliero + lastActiveAt (salvo dry-run).
    if (!dryRun && executedForProfile > 0) {
      const prevDaily = profile.dailyActions || {};
      const baseCount = prevDaily.dateKey === todayKey ? Number(prevDaily.count || 0) : 0;
      await db.collection(COLLECTIONS.GUIDED_PROFILES).doc(plan.uid).set({
        dailyActions: { dateKey: todayKey, count: baseCount + executedForProfile },
        lastActiveAt: serverTimestamp,
        updatedAt: serverTimestamp,
      }, { merge: true });
    }
  }

  report.finishedAtMs = Date.now();

  // 6) Report del run (salvo dry-run -> nessuna scrittura).
  if (!dryRun) {
    try {
      await db.collection(COLLECTIONS.RUNS).doc(report.runId).set({
        ...report,
        createdAt: serverTimestamp,
      }, { merge: true });
    } catch (err) {
      logger.warn("[guided] run report write failed", { error: err?.message || String(err) });
    }
  }

  return report;
}

/**
 * Esegue una singola azione. Ritorna { summary, feedEventsWritten, draft, published }.
 */
async function executeAction(ctx) {
  const {
    db, admin, dryRun, profile, persona, actionType,
    titlePool, guidedPosts, config, gate, adminUids, serverTimestamp, rng,
  } = ctx;

  const uid = profile.uid;
  const displayName = profile.displayName || "Profilo guidato";
  const requireReview = config.requireHumanReview === true && TEXT_ACTIONS.has(actionType);
  const seed = Math.floor(rng() * 1e9);

  // Destinatari del fan-out feed per modalita'.
  async function fanout(payload, eventKey) {
    if (gate.fanoutScope === "none") return 0;
    let recipients;
    if (gate.fanoutScope === "test_only") {
      recipients = Array.from(new Set([...(adminUids || []), ...(config.testAccountUids || []), uid]));
    } else {
      recipients = await collectFeedRecipientUids(db, uid, { extraUids: config.testAccountUids || [] });
    }
    if (!recipients.length) return 0;
    return writeFeedEvents({ db, recipientUids: recipients, eventKey, payload, serverTimestamp });
  }

  switch (actionType) {
    case ACTION_TYPE.MARK_SEEN: {
      const title = pickOne(titlePool, rng);
      const mediaType = normalizeMediaType(title);
      const summary = { titleId: title.id, mediaType };
      if (dryRun) return { summary, feedEventsWritten: 0 };
      const stateRef = db.collection("users").doc(uid).collection("titleStates").doc(title.id);
      await stateRef.set({
        titleId: title.id,
        mediaType,
        generalWatchlist: false,
        ...(mediaType === "tv"
          ? { seriesStatus: "completed_unrated", completedAt: serverTimestamp }
          : { movieStatus: "seen_unrated", seenAt: serverTimestamp }),
        watchMinutesContribution: 0,
        source: "guided",
        isSynthetic: true,
        createdAt: serverTimestamp,
        updatedAt: serverTimestamp,
        lastInteractionAt: serverTimestamp,
      }, { merge: true });
      return { summary, feedEventsWritten: 0 };
    }

    case ACTION_TYPE.ADD_WATCHLIST: {
      const title = pickOne(titlePool, rng);
      const mediaType = normalizeMediaType(title);
      const summary = { titleId: title.id, mediaType };
      if (dryRun) return { summary, feedEventsWritten: 0 };
      const stateRef = db.collection("users").doc(uid).collection("titleStates").doc(title.id);
      await stateRef.set({
        titleId: title.id,
        mediaType,
        generalWatchlist: true,
        source: "guided",
        isSynthetic: true,
        createdAt: serverTimestamp,
        updatedAt: serverTimestamp,
        lastInteractionAt: serverTimestamp,
      }, { merge: true });
      return { summary, feedEventsWritten: 0 };
    }

    case ACTION_TYPE.RATE:
    case ACTION_TYPE.REVIEW: {
      const title = pickOne(titlePool, rng);
      const rating = 5 + Math.floor(rng() * 6); // 5..10 (bias positivo realistico)
      let reviewText = "";
      if (actionType === ACTION_TYPE.REVIEW) {
        const gen = await generateGuidedProfileContent({
          persona, actionType: "review", title, rating, maxLength: 280, seed,
        });
        reviewText = gen.text;
      }
      const summary = { titleId: title.id, rating, hasReview: Boolean(reviewText) };

      if (dryRun) return { summary, feedEventsWritten: 0, draft: requireReview };

      // Human review: il testo va in draft, niente pubblicazione.
      if (requireReview) {
        await writeDraft(db, serverTimestamp, {
          guidedUid: uid, actionType: "review", titleId: title.id, rating, text: reviewText,
          targetCollection: "ratings", targetDocId: makeRatingId(uid, title.id),
        });
        return { summary, feedEventsWritten: 0, draft: true };
      }

      const ratingRef = db.collection("ratings").doc(makeRatingId(uid, title.id));
      await ratingRef.set({
        uid, titleId: title.id, level: "title", season: null, episode: null,
        rating,
        ...(reviewText ? { reviewText } : {}),
        isSynthetic: true,
        createdAt: serverTimestamp,
        updatedAt: serverTimestamp,
      }, { merge: true });

      const feedEventsWritten = await fanout({
        actorUid: uid, eventType: "rating", titleId: title.id, rating,
        level: "title", reviewText, createdAt: serverTimestamp,
        sourcePath: `ratings/${ratingRef.id}`,
      }, `rating_${ratingRef.id}`);

      return { summary, feedEventsWritten, published: true };
    }

    case ACTION_TYPE.POST: {
      const title = rng() < 0.6 ? pickOne(titlePool, rng) : null;
      const gen = await generateGuidedProfileContent({
        persona, actionType: "post", title, maxLength: 500, seed,
      });
      const text = gen.text;
      const summary = { titleId: title ? title.id : null, textLen: text.length };
      if (dryRun) return { summary, feedEventsWritten: 0, draft: requireReview };

      if (requireReview) {
        await writeDraft(db, serverTimestamp, {
          guidedUid: uid, actionType: "post", titleId: title ? title.id : null, text,
          targetCollection: "posts", targetDocId: null,
        });
        return { summary, feedEventsWritten: 0, draft: true };
      }

      const postRef = db.collection("posts").doc();
      await postRef.set({
        authorUid: uid, authorName: displayName, text,
        titleId: title ? title.id : null,
        kind: "post", visibility: "public",
        containsSpoiler: false, spoilerTitleIds: [],
        isSynthetic: true,
        createdAt: serverTimestamp, updatedAt: serverTimestamp,
      });

      const feedEventsWritten = await fanout({
        actorUid: uid, eventType: "post", postId: postRef.id, postKind: "post",
        text, titleId: title ? title.id : null, createdAt: serverTimestamp,
        sourcePath: `posts/${postRef.id}`,
      }, `post_${postRef.id}`);

      return { summary, feedEventsWritten, published: true };
    }

    case ACTION_TYPE.COMMENT: {
      const target = (guidedPosts || []).filter((p) => p.authorUid !== uid);
      const post = pickOne(target, rng);
      if (!post) return null; // niente post guidati su cui commentare
      const gen = await generateGuidedProfileContent({
        persona, actionType: "comment", context: { text: post.text }, maxLength: 280, seed,
      });
      const text = gen.text;
      const summary = { postId: post.id, textLen: text.length };
      if (dryRun) return { summary, feedEventsWritten: 0, draft: requireReview };

      if (requireReview) {
        await writeDraft(db, serverTimestamp, {
          guidedUid: uid, actionType: "comment", postId: post.id, text,
          targetCollection: `posts/${post.id}/comments`, targetDocId: null,
        });
        return { summary, feedEventsWritten: 0, draft: true };
      }

      const commentRef = db.collection("posts").doc(post.id).collection("comments").doc();
      await commentRef.set({
        uid, authorName: displayName, text,
        containsSpoiler: false, spoilerTitleIds: [],
        isSynthetic: true,
        createdAt: serverTimestamp,
      });
      return { summary, feedEventsWritten: 0, published: true };
    }

    case ACTION_TYPE.REACT: {
      const target = (guidedPosts || []).filter((p) => p.authorUid !== uid);
      const post = pickOne(target, rng);
      if (!post) return null;
      const summary = { postId: post.id };
      if (dryRun) return { summary, feedEventsWritten: 0 };
      const likeRef = db.collection("posts").doc(post.id).collection("likes").doc(uid);
      await likeRef.set({
        uid, isSynthetic: true, createdAt: serverTimestamp,
      }, { merge: true });
      return { summary, feedEventsWritten: 0 };
    }

    default:
      return null;
  }
}

async function writeDraft(db, serverTimestamp, payload) {
  await db.collection(COLLECTIONS.CONTENT_DRAFTS).doc().set({
    ...payload,
    status: CONTENT_STATUS.DRAFT,
    isSynthetic: true,
    createdAt: serverTimestamp,
    updatedAt: serverTimestamp,
  });
}

module.exports = {
  runGuidedActivity,
  // helper puri esportati per i test
  planRun,
  chooseActionType,
  makeRatingId,
  normalizeMediaType,
  dateKeyRome,
  remainingDailyBudget,
};
