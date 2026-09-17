const { writeFeedEvents, deleteFeedEvents, uniqueUids } = require("./feedEvents");
const {
  DEFAULT_TASTE_AUDIENCE_LIMIT,
  MAX_TASTE_AUDIENCE_LIMIT,
  rankTasteAudience,
  filterByDailyCap,
  selectTasteNotifyUids,
  tasteDayKey,
} = require("./tasteAudience");

// Sotto questo numero di destinatari in notifica scatta un avviso in anteprima.
// Non blocca: vedi il commento in publishOfficialUpdate.
const MIN_NOTIFY_REACH_WARNING = 5;

const SOMTO_OFFICIAL_UID = "somto_official";
const SOMTO_OFFICIAL_NAME = "Somto";

// Un post ufficiale puo' uscire da Somto o da una **pagina editoriale**
// («Uscite al cinema», «Crime», ...). La pagina e' un doc utente sintetico con
// `accountType: "page"`: cosi' ha profilo, follower e post come chiunque altro,
// senza un secondo modello sociale da mantenere.
const PAGE_ACCOUNT_TYPE = "page";
// Follower serviti per post. Oltre questo tetto il fan-out costerebbe piu' di
// quanto vale: chi resta fuori vede comunque il post in Community.
const MAX_PAGE_FOLLOWERS = 2000;
// Profili gusti letti per calcolare il pubblico per affinita': una lettura a
// utente. Oggi sono 196 su 387 iscritti; il tetto e' li' per il giorno in cui
// non lo saranno piu' — oltre, serve un indice invertito genere→utenti.
const MAX_TASTE_PROFILE_SCAN = 1500;
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
  const authorUid = clampText(input.authorUid, 128) || SOMTO_OFFICIAL_UID;
  // 0 = spento. Chi pubblica decide se allargare al pubblico per affinita';
  // il default resta spento perche' e' una scelta editoriale, non un'impostazione.
  const tasteAudienceLimit = Math.max(0, Math.min(
    MAX_TASTE_AUDIENCE_LIMIT,
    Math.floor(Number(input.tasteAudienceLimit) || 0)
  ));
  const sourceEffectiveAtMs = normalizeScheduledAtMs(input.sourceEffectiveAt);

  if (!slug) throw new Error("slug non valido");
  if (!title) throw new Error("title obbligatorio");
  if (!text) throw new Error("text/body obbligatorio");
  if (!linkedTitleIds.length) throw new Error("linkedTitleIds obbligatorio");

  return {
    slug,
    authorUid,
    tasteAudienceLimit,
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

/**
 * Chi firma il post. Somto si crea da solo; una pagina deve esistere gia' ed
 * essere marcata come tale — altrimenti basterebbe passare l'uid di un utente
 * vero per pubblicare a suo nome.
 */
async function resolvePublisher({ db, admin, authorUid }) {
  const uid = clampText(authorUid, 128) || SOMTO_OFFICIAL_UID;
  if (uid === SOMTO_OFFICIAL_UID) {
    await ensureOfficialSomtoUser({ db, admin });
    return { uid: SOMTO_OFFICIAL_UID, name: SOMTO_OFFICIAL_NAME };
  }

  const snap = await db.collection("users").doc(uid).get();
  const data = snap.exists ? (snap.data() || {}) : null;
  if (!data || data.accountType !== PAGE_ACCOUNT_TYPE) {
    throw new Error(`authorUid non e' una pagina editoriale: ${uid}`);
  }
  return { uid, name: clampText(data.displayName || data.username, 160) || uid };
}

/**
 * Follower della pagina: sono il pubblico che l'ha scelta, e vanno raggiunti
 * anche quando il titolo del post non e' nella loro libreria. E' il motivo per
 * cui le pagine esistono.
 */
async function collectPageFollowerUids(db, authorUid, { max = MAX_PAGE_FOLLOWERS } = {}) {
  const uid = clampText(authorUid, 128);
  if (!uid || uid === SOMTO_OFFICIAL_UID) return [];
  const snap = await db.collection("users").doc(uid).collection("followers")
    .limit(Math.max(1, Math.min(MAX_PAGE_FOLLOWERS, max)))
    .get()
    .catch(() => null);
  return (snap?.docs || []).map((docSnap) => docSnap.id).filter((row) => row && row !== uid);
}

/**
 * Pubblico per affinita' di gusto sul primo titolo collegato. Costa una lettura
 * per profilo: si fa una volta per post, mai per destinatario.
 */
// Torna le righe (uid + punteggio), non i soli uid: chi pubblica decide con il
// punteggio chi merita anche una notifica (vedi selectTasteNotifyUids).
async function collectTasteAudienceRows(db, {
  admin,
  titleId,
  limit,
  excludeUids = [],
  dryRun = false,
  nowMs = Date.now(),
} = {}) {
  const id = clampText(titleId, 160);
  if (!id || !limit) return [];

  const titleSnap = await db.collection("titles").doc(id).get().catch(() => null);
  if (!titleSnap?.exists) return [];

  const snap = await db.collectionGroup("tasteProfile")
    .limit(MAX_TASTE_PROFILE_SCAN)
    .get()
    .catch(() => null);
  if (!snap) return [];

  const profiles = (snap.docs || [])
    .map((docSnap) => ({ uid: docSnap.ref?.parent?.parent?.id || "", data: docSnap.data() || {} }))
    .filter((row) => row.uid);

  // Si classifica largo: profili cancellati/sintetici e tetto giornaliero si
  // scoprono solo dopo, e senza margine il post finirebbe a meno gente del
  // dovuto.
  const ranked = rankTasteAudience({
    titleData: titleSnap.data() || {},
    profiles,
    excludeUids,
    limit: limit * 3,
  });
  if (!ranked.length) return [];

  const userDocs = await db.getAll(...ranked.map((row) => db.collection("users").doc(row.uid)));
  const alive = ranked.filter((row, index) => {
    const data = userDocs[index]?.exists ? (userDocs[index].data() || {}) : null;
    if (!data) return false;
    // Gli account cancellati e quelli sintetici (pagine, profili guidati) non
    // hanno un feed che qualcuno legge.
    return data.isDeleted !== true && data.deleted !== true && data.isSynthetic !== true;
  });
  if (!alive.length) return [];

  const dayKey = tasteDayKey(nowMs);
  const counterRefs = alive.map((row) => db.collection("users").doc(row.uid)
    .collection("_system").doc(`tasteFeedDaily_${dayKey}`));
  const counters = await db.getAll(...counterRefs);
  const counts = new Map(alive.map((row, index) => [row.uid, Number(counters[index]?.data()?.count || 0)]));

  const selected = filterByDailyCap(alive, counts).slice(0, limit);
  if (!selected.length || dryRun) return selected;

  // Il contatore si incrementa solo quando il post esce davvero.
  const batch = db.batch();
  selected.forEach((row) => {
    batch.set(
      db.collection("users").doc(row.uid).collection("_system").doc(`tasteFeedDaily_${dayKey}`),
      { count: Number(counts.get(row.uid) || 0) + 1, dayKey, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
  });
  await batch.commit();

  return selected;
}

function publicArticleDoc(input, {
  admin,
  requestedByUid,
  postId,
  audienceCount,
  tasteAudienceCount,
  tasteNotifyCount,
  feedEventsWritten,
  notificationsWritten,
}) {
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
    authorUid: input.authorUid || SOMTO_OFFICIAL_UID,
    // Serve alle bozze: lo scheduler ricostruisce l'input da qui, senza questo
    // campo una bozza programmata perde il pubblico per affinita'.
    tasteAudienceLimit: Number(input.tasteAudienceLimit || 0),
    postId: postId || null,
    audienceCount: Number(audienceCount || 0),
    tasteAudienceCount: Number(tasteAudienceCount || 0),
    tasteNotifyCount: Number(tasteNotifyCount || 0),
    feedEventsWritten: Number(feedEventsWritten || 0),
    notificationsWritten: Number(notificationsWritten || 0),
    requestedByUid: requestedByUid || null,
    publishedAt: input.status === "published" ? now : null,
    updatedAt: now,
  };
}

async function writeOfficialUpdateNotifications({ db, admin, recipientUids, input, publisher = null }) {
  const author = publisher || { uid: SOMTO_OFFICIAL_UID, name: SOMTO_OFFICIAL_NAME };
  const recipients = uniqueUids(recipientUids).filter((uid) => uid !== author.uid);
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
        fromUid: author.uid,
        type: "official_update",
        data: {
          fromName: author.name,
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
    tasteNotifyCount: 0,
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
    // Anche su bozza si valida l'autore: scoprire che la pagina non esiste
    // quando lo scheduler prova a pubblicare sarebbe troppo tardi.
    await resolvePublisher({ db, admin, authorUid: input.authorUid });
    await db.collection("officialUpdates").doc(input.slug).set(
      publicArticleDoc(input, { admin, requestedByUid }),
      { merge: true }
    );
    return result;
  }

  const interestedUids = await collectInterestedUserUids(db, input.linkedTitleIds, {
    audienceUids: input.audienceUids,
    maxAudience: rawInput?.maxAudience,
  });
  // Su un'audience di test non si aggiungono i follower: "manda solo a me"
  // deve restare esattamente questo.
  const followerUids = input.audienceUids.length
    ? []
    : await collectPageFollowerUids(db, input.authorUid);
  const recipientUids = uniqueUids([...interestedUids, ...followerUids])
    .filter((uid) => uid !== input.authorUid);
  // Pubblico per affinita': va SOLO nel feed, mai in notifica/push. Si calcola
  // anche in anteprima, cosi' la console mostra i due numeri separati.
  const tasteRows = input.audienceUids.length
    ? []
    : await collectTasteAudienceRows(db, {
      admin,
      titleId: input.linkedTitleIds[0],
      limit: input.tasteAudienceLimit,
      excludeUids: [...recipientUids, input.authorUid],
      dryRun,
    });
  const tasteUids = tasteRows.map((row) => row.uid);
  // I primissimi della classifica ricevono anche la notifica, non solo il post
  // nel feed. Gli altri restano un post che non sveglia nessuno.
  const tasteNotifyUids = input.notificationsEnabled ? selectTasteNotifyUids(tasteRows) : [];
  result.recipientCount = recipientUids.length;
  result.followerCount = followerUids.length;
  result.tasteAudienceCount = tasteUids.length;
  result.tasteNotifyCount = tasteNotifyUids.length;

  // Portata prevista, in anteprima (dryRun) come in pubblicazione. Misura del
  // 2026-08-24: 16 post su 62 sono usciti con audience e feed a zero, cioe'
  // lavoro editoriale buttato. Qui **si avvisa e basta**: un aggiornamento che
  // arriva a due persone che hanno quella serie in libreria e' la notifica piu'
  // pertinente che Somto sappia mandare, e bloccarla sarebbe un danno. Chi
  // pubblica vede il numero prima di premere e decide.
  const feedReach = recipientUids.length + tasteUids.length;
  const notifyReach = recipientUids.length + tasteNotifyUids.length;
  if (!feedReach) {
    result.warnings.push({
      code: "audience_empty",
      message: "Nessuno riceve questo aggiornamento: nessun utente ha i titoli collegati "
        + "in libreria o watchlist e il pubblico per affinità è spento o vuoto. "
        + "Resta un post pubblico in Community: collega un titolo più diffuso "
        + "oppure accendi il pubblico per affinità.",
    });
  } else if (input.notificationsEnabled && notifyReach < MIN_NOTIFY_REACH_WARNING) {
    result.warnings.push({
      code: "audience_tiny",
      notifyReach,
      feedReach,
      message: `Solo ${notifyReach} ${notifyReach === 1 ? "persona riceve" : "persone ricevono"} `
        + `la notifica (${feedReach} nel feed). Pertinente ma piccolo: se cercavi portata, `
        + "collega anche i capitoli precedenti della saga o accendi il pubblico per affinità.",
    });
  }

  if (dryRun) return result;

  const publisher = await resolvePublisher({ db, admin, authorUid: input.authorUid });

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
    authorUid: publisher.uid,
    authorName: publisher.name,
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
      actorUid: publisher.uid,
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

  if (tasteUids.length) {
    // Stesso eventKey: l'id del doc feed e' deterministico per (utente, evento),
    // quindi una ripubblicazione non duplica niente.
    result.feedEventsWritten += await writeFeedEvents({
      db,
      recipientUids: tasteUids,
      eventKey: `official_update:${input.slug}`,
      payload: {
        actorUid: publisher.uid,
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
  }

  if (input.notificationsEnabled) {
    result.notificationsWritten = await writeOfficialUpdateNotifications({
      db,
      admin,
      recipientUids: [...recipientUids, ...tasteNotifyUids],
      input,
      publisher,
    });
  }

  await db.collection("officialUpdates").doc(input.slug).set(
    publicArticleDoc(input, {
      admin,
      requestedByUid,
      postId: input.postId,
      audienceCount: recipientUids.length,
      tasteAudienceCount: tasteUids.length,
      tasteNotifyCount: tasteNotifyUids.length,
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
    authorUid: data.authorUid || undefined,
    tasteAudienceLimit: Number(data.tasteAudienceLimit || 0),
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
  PAGE_ACCOUNT_TYPE,
  MAX_PAGE_FOLLOWERS,
  resolvePublisher,
  collectTasteAudienceRows,
  collectPageFollowerUids,
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
