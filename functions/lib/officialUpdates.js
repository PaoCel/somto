const { writeFeedEvents, deleteFeedEvents, uniqueUids } = require("./feedEvents");

const SOMTO_OFFICIAL_UID = "somto_official";
const SOMTO_OFFICIAL_NAME = "Somto";
const OFFICIAL_NOTIFICATION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_LINKED_TITLES = 10;
const MAX_SOURCE_URLS = 6;
const MAX_AUDIENCE = 5000;

const UPDATE_TYPES = new Set([
  "announcement",
  "new_season",
  "new_episode",
  "release_date",
  "renewal",
  "cancellation",
  "sequel",
  "trailer",
  "casting",
  "rumor",
  "not_confirmed",
]);

// Oltre questo ritardo un annuncio non e' piu' un annuncio: la stagione e' gia'
// partita e chi legge o l'ha vista o se l'e' persa. Due giorni tengono dentro
// il post scritto "il giorno dopo", che e' ancora notizia.
const OFFICIAL_UPDATE_STALE_AFTER_MS = 2 * 24 * 60 * 60 * 1000;
const ROME_DAY_FORMATTER = new Intl.DateTimeFormat("it-IT", {
  timeZone: "Europe/Rome",
  day: "numeric",
  month: "long",
});

function clampText(value, maxLen) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.slice(0, Math.max(0, Number(maxLen || 0)));
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s_-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 96);
}

// `scheduledAt` accetta ISO string, epoch ms o Timestamp/Date gia' risolti.
// Ritorna epoch ms, oppure null se assente/non parsabile: una data illeggibile
// non deve mai diventare "pubblica subito".
function normalizeScheduledAtMs(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value > 0 ? value : null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value?.toMillis === "function") {
    const ms = Number(value.toMillis());
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value?._seconds === "number") {
    return value._seconds * 1000;
  }
  const parsed = Date.parse(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.toString().slice(0, 600);
  } catch (_) {
    return "";
  }
}

// Immagine di copertina del post (grafica editoriale su Storage). Whitelist di
// host come per le GIF: un URL arbitrario in un post ufficiale sarebbe un
// tracking pixel servito dal profilo piu' autorevole dell'app.
const MEDIA_URL_HOSTS = ["firebasestorage.googleapis.com", "storage.googleapis.com", "somto.it"];

function normalizeMediaUrl(value) {
  const url = normalizeUrl(value);
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return "";
    if (!MEDIA_URL_HOSTS.includes(parsed.hostname)) return "";
    return url;
  } catch (_) {
    return "";
  }
}

function uniqueStrings(values, { max = 20, maxLen = 160 } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const value = clampText(raw, maxLen);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeOfficialUpdateInput(input = {}) {
  const title = clampText(input.title || input.headline, 160);
  const text = clampText(input.text || input.body || input.summary, 2000);
  const summary = clampText(input.summary || text, 240);
  const slug = slugify(input.slug || title);
  const updateType = UPDATE_TYPES.has(String(input.updateType || "").trim())
    ? String(input.updateType).trim()
    : "announcement";
  const status = String(input.status || "published").trim() === "draft" ? "draft" : "published";
  const linkedTitleIds = uniqueStrings(input.linkedTitleIds || input.titleIds, {
    max: MAX_LINKED_TITLES,
    maxLen: 120,
  });
  const sourceUrls = uniqueStrings(input.sourceUrls || input.sources, {
    max: MAX_SOURCE_URLS,
    maxLen: 600,
  }).map(normalizeUrl).filter(Boolean);
  const audienceUids = uniqueStrings(input.audienceUids || input.testUids, {
    max: MAX_AUDIENCE,
    maxLen: 128,
  });
  const sourceEventId = clampText(input.sourceEventId, 240);
  const sourceEffectiveAtMs = normalizeScheduledAtMs(input.sourceEffectiveAt);

  if (!slug) throw new Error("slug non valido");
  if (!title) throw new Error("title obbligatorio");
  if (!text) throw new Error("text/body obbligatorio");
  if (!linkedTitleIds.length) throw new Error("linkedTitleIds obbligatorio");

  return {
    slug,
    postId: `official_${slug}`,
    title,
    text,
    summary,
    updateType,
    status,
    linkedTitleIds,
    sourceUrls,
    audienceUids,
    mediaUrl: normalizeMediaUrl(input.mediaUrl),
    // I post generati da un evento titolo riusano la notifica `title_update`,
    // che rispetta follow/mute e cap giornaliero. Il default resta `true` per
    // non cambiare il comportamento della console editoriale esistente.
    notificationsEnabled: input.notificationsEnabled !== false,
    sourceEventId: sourceEventId || null,
    sourceEffectiveAtMs,
    // Ha senso solo sulle bozze: e' l'orario a cui lo scheduler le pubblichera'.
    scheduledAtMs: status === "draft" ? normalizeScheduledAtMs(input.scheduledAt) : null,
  };
}

/**
 * Data di partenza dell'ultima stagione conosciuta (`meta.seasons` di TMDB).
 * `air_date` e' una data senza ora: si legge a mezzogiorno UTC, cosi' nessun
 * fuso la sposta al giorno prima.
 */
function latestSeasonPremiereMs(titleData = {}) {
  const seasons = Array.isArray(titleData?.meta?.seasons) ? titleData.meta.seasons : [];
  let latest = null;
  for (const season of seasons) {
    if (Math.floor(Number(season?.season)) <= 0) continue;
    const raw = String(season?.air_date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) continue;
    const ms = Date.parse(`${raw}T12:00:00.000Z`);
    if (!Number.isFinite(ms)) continue;
    if (latest === null || ms > latest) latest = ms;
  }
  return latest;
}

/**
 * "Questa notizia e' vecchia": avverte chi pubblica, non blocca.
 *
 * PERCHE' ESISTE — il post su Ted Lasso 4 e' uscito il 13 agosto dicendo "la
 * stagione e' iniziata su Apple TV", con la stagione partita il 4. La notifica
 * ripete il sommario, quindi chi la riceve legge un annuncio in ritardo di
 * nove giorni. Il contenuto restava giusto: sbagliata era la voce, che doveva
 * essere di RICHIAMO ("Hai iniziato X? Nuovi episodi dal 4 agosto") e non di
 * annuncio. Vedi `docs/EDITORIAL_VOICE.md`.
 *
 * LIMITE NOTO: si valuta solo `new_season`, l'unico tipo per cui la data di
 * riferimento sta gia' sul titolo (`meta.seasons`). Per `release_date` e
 * `new_episode` servirebbe leggere gli eventi del titolo: si aggiunge se
 * capita davvero.
 */
function officialUpdateStaleness({
  updateType,
  titleData = {},
  titleName = "",
  nowMs = Date.now(),
  staleAfterMs = OFFICIAL_UPDATE_STALE_AFTER_MS,
} = {}) {
  if (String(updateType || "").trim() !== "new_season") return null;
  const referenceMs = latestSeasonPremiereMs(titleData);
  if (referenceMs === null || nowMs - referenceMs <= staleAfterMs) return null;

  // Arrotondato, non troncato: `referenceMs` e' mezzogiorno, quindi il conto
  // che torna e' quello dei giorni di calendario ("nove giorni fa"), non le
  // 8,9 giornate esatte.
  const daysLate = Math.round((nowMs - referenceMs) / (24 * 60 * 60 * 1000));
  const startedOn = ROME_DAY_FORMATTER.format(new Date(referenceMs));
  const name = clampText(titleName || titleData?.name || "", 160) || "questo titolo";
  return {
    code: "season_already_started",
    updateType: "new_season",
    referenceMs,
    daysLate,
    message: `La stagione è partita il ${startedOn}, ${daysLate} giorni fa: `
      + `non annunciarla, richiamala — «Hai iniziato ${name}? Nuovi episodi dal ${startedOn}».`,
  };
}

async function collectOfficialUpdateWarnings({ db, input, nowMs = Date.now() }) {
  if (String(input?.updateType || "") !== "new_season") return [];
  const titleId = String(input?.linkedTitleIds?.[0] || "").trim();
  if (!titleId) return [];

  let titleData = {};
  try {
    const snap = await db.collection("titles").doc(titleId).get();
    titleData = snap.exists ? (snap.data() || {}) : {};
  } catch (_) {
    // Un avviso mancato non deve impedire una pubblicazione.
    return [];
  }

  const staleness = officialUpdateStaleness({
    updateType: input.updateType,
    titleData,
    titleName: titleData?.name || "",
    nowMs,
  });
  return staleness ? [staleness] : [];
}

function titleStateLooksInterested(data = {}) {
  const state = String(data.state || "").trim();
  if (state === "removed" || state === "none" || state === "dismissed") return false;
  if (data.generalWatchlist === true) return true;
  if (state) return true;
  if (data.completedAt || data.seenAt || data.updatedAt || data.lastInteractionAt) return true;
  return false;
}

async function collectInterestedUserUids(db, linkedTitleIds, opts = {}) {
  const exactAudience = uniqueUids(opts.audienceUids || []);
  if (exactAudience.length) {
    return exactAudience.filter((uid) => uid !== SOMTO_OFFICIAL_UID);
  }

  const titleIds = uniqueStrings(linkedTitleIds, { max: MAX_LINKED_TITLES, maxLen: 120 });
  const maxAudience = Math.max(1, Math.min(MAX_AUDIENCE, Number(opts.maxAudience || MAX_AUDIENCE)));
  const out = new Set();

  for (let i = 0; i < titleIds.length && out.size < maxAudience; i += 10) {
    const chunk = titleIds.slice(i, i + 10);
    const snap = await db.collectionGroup("titleStates")
      .where("titleId", "in", chunk)
      .limit(maxAudience)
      .get();

    for (const docSnap of snap.docs || []) {
      if (out.size >= maxAudience) break;
      if (!titleStateLooksInterested(docSnap.data() || {})) continue;
      const uid = docSnap.ref?.parent?.parent?.id;
      if (uid && uid !== SOMTO_OFFICIAL_UID) out.add(uid);
    }
  }

  return [...out];
}

async function ensureOfficialSomtoUser({ db, admin }) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  await db.collection("users").doc(SOMTO_OFFICIAL_UID).set({
    displayName: SOMTO_OFFICIAL_NAME,
    displayNameLower: "somto",
    username: "somto",
    photoURL: "https://somto.it/icons/icon-192.png",
    avatarURL: "https://somto.it/icons/icon-192.png",
    privacyDefault: "public",
    accountType: "official",
    isOfficial: true,
    isAdmin: false,
    trusted: true,
    createdAt: now,
    updatedAt: now,
  }, { merge: true });
}

function publicArticleDoc(input, { admin, requestedByUid, postId, audienceCount, feedEventsWritten, notificationsWritten }) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  const scheduled = input.status === "draft" && input.scheduledAtMs
    ? { scheduledAt: admin.firestore.Timestamp.fromMillis(input.scheduledAtMs) }
    : {};
  const sourceEffectiveAt = input.sourceEffectiveAtMs
    ? admin.firestore.Timestamp.fromMillis(input.sourceEffectiveAtMs)
    : null;
  return {
    ...scheduled,
    slug: input.slug,
    title: input.title,
    text: input.text,
    summary: input.summary,
    status: input.status,
    updateType: input.updateType,
    linkedTitleIds: input.linkedTitleIds,
    sourceUrls: input.sourceUrls,
    mediaUrl: input.mediaUrl || null,
    notificationsEnabled: input.notificationsEnabled !== false,
    sourceEventId: input.sourceEventId || null,
    sourceEffectiveAt,
    authorUid: SOMTO_OFFICIAL_UID,
    postId: postId || null,
    audienceCount: Number(audienceCount || 0),
    feedEventsWritten: Number(feedEventsWritten || 0),
    notificationsWritten: Number(notificationsWritten || 0),
    requestedByUid: requestedByUid || null,
    publishedAt: input.status === "published" ? now : null,
    updatedAt: now,
  };
}

async function writeOfficialUpdateNotifications({ db, admin, recipientUids, input }) {
  const recipients = uniqueUids(recipientUids).filter((uid) => uid !== SOMTO_OFFICIAL_UID);
  if (!recipients.length) return 0;

  const chunks = [];
  for (let i = 0; i < recipients.length; i += 350) {
    chunks.push(recipients.slice(i, i + 350));
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + OFFICIAL_NOTIFICATION_TTL_MS);
  // Il deep-link ?post= e' gestito da community.page.js (home.page.js non lo legge).
  const ctaUrl = `/community.html?post=${encodeURIComponent(input.postId)}`;
  let writes = 0;

  for (const chunk of chunks) {
    const batch = db.batch();
    for (const uid of chunk) {
      const ref = db.collection("users").doc(uid)
        .collection("notifications").doc(`official_update_${input.slug}`);
      batch.set(ref, {
        toUid: uid,
        fromUid: SOMTO_OFFICIAL_UID,
        type: "official_update",
        data: {
          fromName: SOMTO_OFFICIAL_NAME,
          postId: input.postId,
          titleId: input.linkedTitleIds[0] || null,
          linkedTitleIds: input.linkedTitleIds,
          updateType: input.updateType,
          title: input.title,
          preview: input.summary,
          ctaUrl,
          isOfficial: true,
        },
        read: false,
        createdAt: now,
        expiresAt,
      }, { merge: false });
      writes++;
    }
    await batch.commit();
  }

  return writes;
}

async function publishOfficialUpdate({ db, admin, input: rawInput, requestedByUid = null, dryRun = false } = {}) {
  if (!db || !admin) throw new Error("db e admin sono obbligatori");
  const input = normalizeOfficialUpdateInput(rawInput || {});

  const result = {
    slug: input.slug,
    status: input.status,
    postId: input.postId,
    linkedTitleIds: input.linkedTitleIds,
    recipientCount: 0,
    feedEventsWritten: 0,
    notificationsWritten: 0,
    dryRun: !!dryRun,
    // Avvisi editoriali (voce sbagliata per una notizia vecchia): informano,
    // non bloccano. Chi pubblica decide.
    warnings: await collectOfficialUpdateWarnings({ db, input }),
  };

  // Una bozza non fa fan-out: evita la scansione collection-group di
  // titleStates (costosa e inutile qui). L'anteprima destinatari passa da
  // dryRun con status "published", che e' quello che fa la console admin.
  if (input.status === "draft") {
    if (dryRun) return result;
    await ensureOfficialSomtoUser({ db, admin });
    await db.collection("officialUpdates").doc(input.slug).set(
      publicArticleDoc(input, { admin, requestedByUid }),
      { merge: true }
    );
    return result;
  }

  const recipientUids = await collectInterestedUserUids(db, input.linkedTitleIds, {
    audienceUids: input.audienceUids,
    maxAudience: rawInput?.maxAudience,
  });
  result.recipientCount = recipientUids.length;

  if (dryRun) return result;

  await ensureOfficialSomtoUser({ db, admin });

  const now = admin.firestore.FieldValue.serverTimestamp();
  const postRef = db.collection("posts").doc(input.postId);
  // Una correzione di data/copy sullo stesso evento deve conservare anzianita',
  // commenti e ranking del post. Riscrivere `createdAt` lo riporterebbe ogni
  // sei ore in cima alla Community come se fosse una notizia nuova.
  let postCreatedAt = now;
  if (typeof postRef.get === "function") {
    const existingPost = await postRef.get().catch(() => null);
    postCreatedAt = existingPost?.data?.()?.createdAt || now;
  }
  await postRef.set({
    authorUid: SOMTO_OFFICIAL_UID,
    authorName: SOMTO_OFFICIAL_NAME,
    text: input.text,
    titleId: input.linkedTitleIds[0] || null,
    linkedTitleIds: input.linkedTitleIds,
    ...(input.mediaUrl ? { mediaUrl: input.mediaUrl, mediaUrls: [input.mediaUrl] } : {}),
    kind: "post",
    visibility: "public",
    isOfficialUpdate: true,
    officialUpdate: {
      slug: input.slug,
      updateType: input.updateType,
      sourceUrls: input.sourceUrls,
      title: input.title,
      summary: input.summary,
      sourceEventId: input.sourceEventId || null,
      sourceEffectiveAt: input.sourceEffectiveAtMs
        ? admin.firestore.Timestamp.fromMillis(input.sourceEffectiveAtMs)
        : null,
    },
    skipAutoFeedFanout: true,
    createdAt: postCreatedAt,
    updatedAt: now,
  }, { merge: true });

  result.feedEventsWritten = await writeFeedEvents({
    db,
    recipientUids,
    eventKey: `official_update:${input.slug}`,
    payload: {
      actorUid: SOMTO_OFFICIAL_UID,
      eventType: "post",
      sourceId: input.postId,
      sourcePath: postRef.path,
      postId: input.postId,
      titleId: input.linkedTitleIds[0] || null,
      postKind: "post",
      text: input.text,
      ...(input.mediaUrl ? { mediaUrl: input.mediaUrl, mediaUrls: [input.mediaUrl] } : {}),
    },
    serverTimestamp: now,
  });

  if (input.notificationsEnabled) {
    result.notificationsWritten = await writeOfficialUpdateNotifications({
      db,
      admin,
      recipientUids,
      input,
    });
  }

  await db.collection("officialUpdates").doc(input.slug).set(
    publicArticleDoc(input, {
      admin,
      requestedByUid,
      postId: input.postId,
      audienceCount: recipientUids.length,
      feedEventsWritten: result.feedEventsWritten,
      notificationsWritten: result.notificationsWritten,
    }),
    { merge: true }
  );

  return result;
}

// Ricostruisce il payload di publishOfficialUpdate da una bozza salvata in
// `officialUpdates/{slug}`: la bozza contiene gia' tutti i campi editoriali,
// quindi lo scheduler non deve conoscere il contenuto, solo rimetterlo in
// circolo con status "published".
function draftToPublishInput(slug, data = {}) {
  return {
    slug,
    title: data.title,
    text: data.text,
    summary: data.summary,
    updateType: data.updateType,
    linkedTitleIds: Array.isArray(data.linkedTitleIds) ? data.linkedTitleIds : [],
    sourceUrls: Array.isArray(data.sourceUrls) ? data.sourceUrls : [],
    mediaUrl: data.mediaUrl || "",
    audienceUids: Array.isArray(data.audienceUids) ? data.audienceUids : [],
    notificationsEnabled: data.notificationsEnabled !== false,
    sourceEventId: data.sourceEventId || null,
    sourceEffectiveAt: data.sourceEffectiveAt || null,
    status: "published",
  };
}

/**
 * Pubblica le bozze con `scheduledAt` scaduto (chiamata dallo scheduler).
 *
 * Idempotenza: `publishOfficialUpdate` scrive con id deterministici (post,
 * feedEvents, notifiche) e porta il registro a status "published", quindi la
 * bozza esce dalla query al giro dopo. Il claim in transazione serve solo a
 * evitare che due run sovrapposti facciano lo stesso lavoro due volte; dopo
 * `claimStaleAfterMs` un claim orfano (crash a meta') viene riprovato.
 */
async function publishDueOfficialUpdates({
  db,
  admin,
  nowMs = Date.now(),
  limit = 10,
  claimStaleAfterMs = 10 * 60 * 1000,
  publish = publishOfficialUpdate,
} = {}) {
  if (!db || !admin) throw new Error("db e admin sono obbligatori");

  const dueSnap = await db.collection("officialUpdates")
    .where("status", "==", "draft")
    .where("scheduledAt", "<=", admin.firestore.Timestamp.fromMillis(nowMs))
    .orderBy("scheduledAt", "asc")
    .limit(Math.max(1, Math.min(50, Number(limit) || 10)))
    .get();

  const results = { checked: dueSnap.size || 0, published: [], skipped: [], failed: [] };

  for (const docSnap of dueSnap.docs || []) {
    const slug = docSnap.id;
    const ref = db.collection("officialUpdates").doc(slug);

    // Claim: nessun altro run deve ripubblicare la stessa bozza.
    const claimed = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(ref);
      if (!fresh.exists) return false;
      const data = fresh.data() || {};
      if (data.status !== "draft") return false;
      const claimedAtMs = normalizeScheduledAtMs(data.scheduleClaimedAt);
      if (claimedAtMs && nowMs - claimedAtMs < claimStaleAfterMs) return false;
      tx.set(ref, {
        scheduleClaimedAt: admin.firestore.Timestamp.fromMillis(nowMs),
      }, { merge: true });
      return true;
    });

    if (!claimed) {
      results.skipped.push(slug);
      continue;
    }

    try {
      const outcome = await publish({
        db,
        admin,
        input: draftToPublishInput(slug, docSnap.data() || {}),
        requestedByUid: docSnap.data()?.requestedByUid || null,
      });
      results.published.push({ slug, recipientCount: outcome?.recipientCount || 0 });
    } catch (err) {
      const message = String(err?.message || err).slice(0, 300);
      results.failed.push({ slug, error: message });
      // La bozza resta draft: al prossimo giro, scaduto il claim, si riprova.
      await ref.set({
        lastScheduleError: message,
        lastScheduleErrorAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true }).catch(() => {});
    }
  }

  return results;
}

async function unpublishOfficialUpdate({ db, admin, slug: rawSlug, requestedByUid = null } = {}) {
  if (!db || !admin) throw new Error("db e admin sono obbligatori");
  const slug = slugify(rawSlug);
  if (!slug) throw new Error("slug non valido");

  const updateRef = db.collection("officialUpdates").doc(slug);
  const updateSnap = await updateRef.get();
  if (!updateSnap.exists) throw new Error("aggiornamento non trovato");

  const data = updateSnap.data() || {};
  const postId = String(data.postId || `official_${slug}`);
  const eventKey = `official_update:${slug}`;

  // Recupera i destinatari dal fan-out feed (doc id deterministico owner+eventKey),
  // cosi' possiamo cancellare sia feedEvents sia le notifiche corrispondenti.
  const feedSnap = await db.collection("feedEvents")
    .where("eventKey", "==", eventKey)
    .get();
  const recipientUids = uniqueUids(
    (feedSnap.docs || []).map((docSnap) => (docSnap.data() || {}).ownerUid)
  );

  let feedEventsDeleted = 0;
  if (recipientUids.length) {
    feedEventsDeleted = await deleteFeedEvents({ db, recipientUids, eventKey });
  }

  let notificationsDeleted = 0;
  for (let i = 0; i < recipientUids.length; i += 350) {
    const chunk = recipientUids.slice(i, i + 350);
    const batch = db.batch();
    for (const uid of chunk) {
      batch.delete(
        db.collection("users").doc(uid)
          .collection("notifications").doc(`official_update_${slug}`)
      );
      notificationsDeleted++;
    }
    await batch.commit();
  }

  await db.collection("posts").doc(postId).delete();

  const now = admin.firestore.FieldValue.serverTimestamp();
  await updateRef.set({
    status: "retired",
    retiredAt: now,
    retiredByUid: requestedByUid || null,
    updatedAt: now,
  }, { merge: true });

  return {
    slug,
    postId,
    status: "retired",
    feedEventsDeleted,
    notificationsDeleted,
  };
}

module.exports = {
  SOMTO_OFFICIAL_UID,
  SOMTO_OFFICIAL_NAME,
  UPDATE_TYPES,
  OFFICIAL_UPDATE_STALE_AFTER_MS,
  collectOfficialUpdateWarnings,
  latestSeasonPremiereMs,
  officialUpdateStaleness,
  slugify,
  normalizeScheduledAtMs,
  normalizeMediaUrl,
  normalizeOfficialUpdateInput,
  titleStateLooksInterested,
  collectInterestedUserUids,
  ensureOfficialSomtoUser,
  draftToPublishInput,
  publishOfficialUpdate,
  publishDueOfficialUpdates,
  unpublishOfficialUpdate,
};
