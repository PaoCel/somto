"use strict";

const SOMTO_OFFICIAL_UID = "somto_official";
const TITLE_UPDATE_NOTIFICATION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RECIPIENTS = 500;
const DEFAULT_DAILY_CAP = 3;

const MOVIE_STARTED_STATES = new Set(["seen_unrated", "rated"]);
const TV_STARTED_STATES = new Set(["in_progress", "completed_unrated", "rated"]);
const IMPORTANT_EVENT_TYPES = new Set([
  "trailer",
  "teaser",
  "release_date",
  "new_season",
  "renewal",
  "cancellation",
  "sequel",
]);
// Eventi che riguardano il proseguimento di una serie: se la stai guardando
// adesso è la notizia più forte che possiamo darti.
const SERIES_PROGRESS_EVENT_TYPES = new Set([
  "new_episode",
  "new_season",
  "renewal",
  "cancellation",
]);
// Un evento di media rilevanza non può consumare l'ultimo slot del giorno:
// resta un posto per un'eventuale notizia forte in arrivo più tardi.
const MEDIUM_RELEVANCE_CAP_MARGIN = 1;

// Eventi che si notificano IL GIORNO in cui succedono, non quando li scopriamo.
// Vedi `titleUpdateWaitsForAirDate`.
const AIR_DATE_EVENT_TYPES = new Set(["new_episode"]);

// Quanto indietro guarda la sweep giornaliera: copre un run saltato senza
// rincorrere per sempre episodi vecchi.
//
// GRAZIA E TETTO VANNO INSIEME. In prod escono 20-50 eventi `new_episode` al
// giorno (soap e daily comprese): con la query ordinata per data crescente, una
// grazia larga e un tetto basso significano riempire il tetto con gli episodi
// di ieri e non arrivare mai a quelli di oggi. Se alzi la grazia, alza il
// tetto.
const DUE_SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;
const DUE_SWEEP_LIMIT = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

function safeText(value, maxLength = 240) {
  return String(value || "").trim().slice(0, maxLength);
}

// `manual` sta accanto a `live` perche' il gate serve a tenere fuori il
// BACKFILL — la prima scansione di un titolo, che scopre notizie vecchie e non
// deve svegliare nessuno. Una persona che pubblica deliberatamente un evento e'
// l'opposto del backfill: e' il caso piu' meritevole di notifica che ci sia.
// Chi decide *se* notificare resta la callable admin, che valorizza
// `notificationEligible` (oggi: solo se l'uscita e' entro due settimane).
const FANOUT_ACQUISITION_MODES = new Set(["live", "manual"]);

// Di quanto deve spostarsi un'uscita gia' annunciata perche' valga una seconda
// notifica.
//
// PERCHE' NON ZERO — le date si assestano: un film annunciato "8 ottobre" puo'
// diventare "9 ottobre" per un aggiustamento di listino, e notificarlo sarebbe
// rumore. Una settimana e' la soglia oltre la quale i piani di una persona
// cambiano davvero: non e' piu' "il film esce fra poco", e' "il film non esce
// piu' quando pensavi".
const RESCHEDULE_NOTIFY_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

function effectiveMillis(data) {
  const value = data?.effectiveAt;
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toMillis === "function") return Number(value.toMillis());
  if (typeof value._seconds === "number") return value._seconds * 1000;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Un'uscita gia' annunciata e' stata SPOSTATA in modo significativo.
 *
 * PERCHE' ESISTE — il fanout scattava solo al passaggio a `published`, quindi
 * un film che slittava da ottobre a dicembre non lo scopriva nessuno: chi
 * l'aveva in watchlist restava con la data vecchia in testa. Per un prodotto
 * che si e' messo a fare editoriale sulle uscite, quello e' il fallimento che
 * rende inutile tutto il resto.
 *
 * Si confronta `before` con `after` e basta: nessun campo marcatore da scrivere
 * sul documento, quindi nessuna scrittura di ritorno e nessun rischio che il
 * trigger richiami se stesso. Una volta spostata, alla scrittura dopo
 * `before === after` e il caso non si ripete.
 *
 * LIMITE NOTO: tanti spostamenti piccoli sotto soglia (8 → 12 → 20 ottobre) non
 * notificano mai, pur sommando dodici giorni. Chiuderlo richiederebbe ricordare
 * l'ultima data notificata sul documento, cioe' proprio la scrittura di ritorno
 * che qui si evita. Si valuta se capita davvero.
 */
function titleUpdateRescheduled(before, after, now = Date.now()) {
  // Solo le date di uscita: se si sposta un trailer non e' la stessa notizia.
  if (after?.eventType !== "release_date") return false;

  const previous = effectiveMillis(before);
  const next = effectiveMillis(after);
  if (previous === null || next === null) return false;

  // Un'uscita spostata nel passato e' storia, non un piano da rifare.
  if (next <= now) return false;

  return Math.abs(next - previous) >= RESCHEDULE_NOTIFY_THRESHOLD_MS;
}

/**
 * L'evento parla di qualcosa che succede in un GIORNO FUTURO: la notifica
 * aspetta quel giorno.
 *
 * PERCHE' ESISTE — TMDB sposta `next_episode_to_air` sull'episodio successivo
 * subito dopo che il precedente e' andato in onda. Notificando alla scoperta,
 * su ogni serie settimanale la notifica partiva un giorno o due dopo l'uscita
 * dell'episodio che stavi per guardare, per annunciarne uno a 5-6 giorni di
 * distanza: il momento peggiore possibile, e senza data in copy si legge come
 * "e' uscito adesso". (Incidente Ted Lasso S4E3, 2026-08-13.)
 *
 * Il confronto e' per GIORNO di calendario a Roma, non per millisecondi:
 * `air_date` di TMDB e' una data senza ora, che noi normalizziamo a mezzogiorno
 * UTC. Un evento di oggi si notifica subito; da domani in poi ci pensa la sweep
 * `fanOutDueTitleUpdates`.
 */
function titleUpdateWaitsForAirDate(event, nowMs = Date.now()) {
  if (!AIR_DATE_EVENT_TYPES.has(safeText(event?.eventType, 40))) return false;
  const airMs = effectiveMillis(event);
  if (airMs === null) return false;
  return Number(dayKeyForMs(airMs)) > Number(dayKeyForMs(nowMs));
}

function shouldFanOutTitleUpdate(before, after, now = Date.now()) {
  if (!after || after.status !== "published") return false;
  if (!FANOUT_ACQUISITION_MODES.has(after.acquisitionMode)) return false;

  // Prima pubblicazione: decide `notificationEligible`, che valorizza chi
  // pubblica (la callable admin lo mette a true solo se l'uscita e' entro due
  // settimane).
  if (!before || before.status !== "published") {
    if (titleUpdateWaitsForAirDate(after, now)) return false;
    return after.notificationEligible === true;
  }

  // Gia' pubblicato: si rinotifica SOLO se l'uscita e' stata spostata sul
  // serio. Una correzione di copy, di region o di `releaseType` non sveglia
  // nessuno.
  //
  // Qui `notificationEligible` NON si guarda, ed e' deliberato:
  // `mergeExistingEvent` lo spegne per tutto cio' che non e' `live`, quindi su
  // ogni evento toccato a mano diventa false alla prima passata dello scanner.
  // Richiederlo vorrebbe dire che proprio i titoli curati editorialmente — gli
  // unici su cui qualcuno ha lavorato — non avvisano mai di uno slittamento.
  return titleUpdateRescheduled(before, after, now);
}

function titleStateEligibleForUpdate(stateData = {}, event = {}) {
  const eventType = safeText(event.eventType, 40);
  const mediaType = event.mediaType === "tv" ? "tv" : "movie";
  const state = safeText(stateData.state, 40).toLowerCase();

  if (["removed", "none", "dismissed", "unseen"].includes(state)) return false;
  if (eventType === "new_episode" && mediaType !== "tv") return false;
  if (stateData.generalWatchlist === true) return true;

  if (mediaType === "tv") return TV_STARTED_STATES.has(state);
  return MOVIE_STARTED_STATES.has(state);
}

// Quanto vale questa notizia PER QUESTA PERSONA. I 3 slot giornalieri sono
// pochi e vanno a chi arriva primo: senza una scala, un teaser di un film già
// visto brucia lo slot che sarebbe servito alla nuova stagione della serie che
// stai guardando. "low" non notifica affatto — la novità resta comunque nella
// timeline del titolo.
function titleUpdateRelevance(stateData = {}, event = {}, explicitMode = null) {
  const eventType = safeText(event.eventType, 40);
  const state = safeText(stateData.state, 40).toLowerCase();
  const mode = safeText(explicitMode, 24).toLowerCase();
  const inProgress = state === "in_progress";
  const watchlisted = stateData.generalWatchlist === true;

  // Un follow esplicito è una richiesta diretta: non la declassiamo mai.
  if (mode === "follow" || mode === "important") return "high";

  if (SERIES_PROGRESS_EVENT_TYPES.has(eventType)) {
    return inProgress ? "high" : "medium";
  }
  if (eventType === "release_date") {
    return (watchlisted || inProgress) ? "medium" : "low";
  }
  // trailer, teaser e resto: interessano solo se il titolo è ancora davanti a
  // te, non se l'hai già visto.
  return (watchlisted || inProgress) ? "medium" : "low";
}

function titleUpdatePreferenceAllows(mode, event = {}) {
  const normalized = safeText(mode, 24).toLowerCase();
  if (normalized === "muted") return false;
  if (normalized === "follow") return true;
  if (normalized === "important") {
    return IMPORTANT_EVENT_TYPES.has(safeText(event.eventType, 40));
  }
  return null;
}

async function hasGlobalTitleUpdateOptOut(db, uid) {
  try {
    const snap = await db.collection("users").doc(uid).collection("_system").doc("notificationPrefs").get();
    const disabled = snap.exists ? snap.data()?.disabledTypes : [];
    return Array.isArray(disabled) && disabled.includes("title_update");
  } catch (_) {
    // Fail closed for push delivery: a transient preferences read must not
    // generate a notification the user may have disabled.
    return true;
  }
}

function eventMillis(value) {
  if (!value) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value._seconds === "number") return value._seconds * 1000;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

// "18 agosto" / "August 18", sempre nel fuso in cui vive l'utente tipo.
const DAY_FORMATTERS = new Map();
function formatEventDay(ms, locale) {
  if (!DAY_FORMATTERS.has(locale)) {
    DAY_FORMATTERS.set(locale, new Intl.DateTimeFormat(locale, {
      timeZone: "Europe/Rome",
      day: "numeric",
      month: "long",
    }));
  }
  return DAY_FORMATTERS.get(locale).format(new Date(Number(ms)));
}

function buildTitleUpdateMessageByLocale(event = {}, titleName = "", nowMs = Date.now()) {
  const normalizedName = safeText(titleName, 160);
  const italianName = normalizedName || "questo titolo";
  const englishName = normalizedName || "this title";
  const eventType = safeText(event.eventType, 40);

  if (eventType === "teaser") {
    return {
      "it-IT": `È uscito un nuovo teaser di ${italianName}.`,
      "en-US": `A new teaser for ${englishName} is out.`,
    };
  }
  if (eventType === "release_date") {
    return {
      "it-IT": `${italianName} ha una nuova data di uscita.`,
      "en-US": `${englishName} has a new release date.`,
    };
  }
  if (eventType === "new_episode") {
    // next_episode_to_air arriva fino a 60 giorni prima della messa in onda:
    // dire "è disponibile" per un episodio non ancora uscito manda l'utente su
    // una scheda vuota. "In arrivo" senza data faceva il danno opposto: si
    // legge come "è uscito adesso" mentre l'episodio è fra sei giorni.
    const airMs = eventMillis(event.effectiveAt || event.effectiveDate);
    const dayDelta = airMs === null
      ? 0
      : Number(dayKeyForMs(airMs)) - Number(dayKeyForMs(nowMs));
    if (dayDelta > 0) {
      return {
        "it-IT": `Nuovo episodio di ${italianName} il ${formatEventDay(airMs, "it-IT")}.`,
        "en-US": `New episode of ${englishName} on ${formatEventDay(airMs, "en-US")}.`,
      };
    }
    if (dayDelta === 0 && airMs !== null) {
      return {
        "it-IT": `Oggi nuovo episodio di ${italianName}.`,
        "en-US": `New episode of ${englishName} today.`,
      };
    }
    return {
      "it-IT": `È disponibile un nuovo episodio di ${italianName}.`,
      "en-US": `A new episode of ${englishName} is available.`,
    };
  }
  return {
    "it-IT": `È uscito un nuovo trailer di ${italianName}.`,
    "en-US": `A new trailer for ${englishName} is out.`,
  };
}

function titleUpdateNotificationId(eventId) {
  const id = safeText(eventId, 240);
  if (!id || id.includes("/")) throw new Error("eventId non valido");
  return `title_update_${id}`;
}

function dayKeyForMs(nowMs) {
  const date = new Date(Number(nowMs));
  if (!Number.isFinite(date.getTime())) throw new Error("nowMs non valido");
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date).replaceAll("-", "");
}

function titleNameFromData(titleData = {}, fallbackStates = []) {
  const direct = safeText(titleData.name || titleData.title, 160);
  if (direct) return direct;
  for (const state of fallbackStates) {
    const snapshot = state?.data?.titleSnapshot || {};
    const name = safeText(snapshot.name || snapshot.title, 160);
    if (name) return name;
  }
  return "";
}

function buildTitleUpdateNotificationDocument({ admin, uid, eventId, event, titleName, nowMs }) {
  const messageByLocale = buildTitleUpdateMessageByLocale(event, titleName, nowMs);
  const titleId = safeText(event.titleId, 160);
  const ctaUrl = `/title.html?id=${encodeURIComponent(titleId)}&focus=updates&event=${encodeURIComponent(eventId)}`;
  return {
    toUid: uid,
    fromUid: SOMTO_OFFICIAL_UID,
    type: "title_update",
    data: {
      fromName: "Somto",
      eventId,
      titleId,
      eventType: safeText(event.eventType, 40),
      titleName: safeText(titleName, 160),
      headlineByLocale: event.headlineByLocale || {},
      messageByLocale,
      preview: messageByLocale["it-IT"],
      sourceUrl: safeText(event.sourceUrl, 600),
      ctaUrl,
      isOfficial: event.official === true,
    },
    read: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + TITLE_UPDATE_NOTIFICATION_TTL_MS),
  };
}

async function writeCappedTitleUpdateNotification({
  db,
  admin,
  uid,
  eventId,
  event,
  titleName,
  nowMs = Date.now(),
  dailyCap = DEFAULT_DAILY_CAP,
  relevance = "high",
} = {}) {
  if (!db || !admin) throw new Error("db e admin sono obbligatori");
  const recipientUid = safeText(uid, 128);
  if (!recipientUid || recipientUid === SOMTO_OFFICIAL_UID) return { status: "ineligible" };

  const notificationId = titleUpdateNotificationId(eventId);
  const dayKey = dayKeyForMs(nowMs);
  const dayCap = Math.max(1, Math.min(10, Math.floor(Number(dailyCap) || DEFAULT_DAILY_CAP)));
  const cap = safeText(relevance, 12) === "high"
    ? dayCap
    : Math.max(1, dayCap - MEDIUM_RELEVANCE_CAP_MARGIN);
  const userRef = db.collection("users").doc(recipientUid);
  const notificationRef = userRef.collection("notifications").doc(notificationId);
  const counterRef = userRef.collection("_system").doc(`titleUpdateDaily_${dayKey}`);

  return db.runTransaction(async (tx) => {
    const existing = await tx.get(notificationRef);
    if (existing.exists) return { status: "duplicate", notificationId };

    const counterSnap = await tx.get(counterRef);
    const count = Math.max(0, Math.floor(Number(counterSnap.data()?.count) || 0));
    if (count >= cap) return { status: "daily_cap", notificationId };

    tx.set(counterRef, {
      count: count + 1,
      dayKey,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.set(notificationRef, buildTitleUpdateNotificationDocument({
      admin,
      uid: recipientUid,
      eventId,
      event,
      titleName,
      nowMs,
    }), { merge: false });
    return { status: "written", notificationId };
  });
}

async function fanOutTitleUpdate({
  db,
  admin,
  eventId,
  before,
  after,
  nowMs = Date.now(),
  maxRecipients = DEFAULT_MAX_RECIPIENTS,
  dailyCap = DEFAULT_DAILY_CAP,
} = {}) {
  if (!db || !admin) throw new Error("db e admin sono obbligatori");
  if (!shouldFanOutTitleUpdate(before, after, nowMs)) {
    const reason = titleUpdateWaitsForAirDate(after, nowMs)
      ? "waiting_for_air_date"
      : "event_not_eligible";
    return { skipped: true, reason, scanned: 0, eligible: 0, written: 0 };
  }

  const cap = Math.max(1, Math.min(2000, Math.floor(Number(maxRecipients) || DEFAULT_MAX_RECIPIENTS)));
  const scanLimit = Math.min(5000, Math.max(cap, cap * 4));
  const stateSnap = await db.collectionGroup("titleStates")
    .where("titleId", "==", after.titleId)
    .limit(scanLimit)
    .get();

  // Se questa query fallisce (tipicamente: indice collection-group mancante) i
  // "muto" per titolo verrebbero ignorati e notificheremmo chi ha chiesto
  // silenzio. Meglio saperlo dai log che degradare in silenzio.
  const preferenceSnap = await db.collectionGroup("titleUpdatePrefs")
    .where("titleId", "==", after.titleId)
    .limit(scanLimit)
    .get()
    .catch((err) => {
      console.error("[titleUpdates] lettura titleUpdatePrefs fallita", {
        titleId: after.titleId,
        error: String(err?.message || err).slice(0, 240),
      });
      return { docs: [] };
    });

  const preferencesByUid = new Map();
  for (const docSnap of preferenceSnap.docs || []) {
    const uid = safeText(docSnap.ref?.parent?.parent?.id, 128);
    const mode = safeText(docSnap.data()?.mode, 24).toLowerCase();
    if (uid && ["follow", "important", "muted"].includes(mode)) preferencesByUid.set(uid, mode);
  }

  const recipientRows = [];
  const seenUids = new Set();
  let lowRelevance = 0;
  for (const docSnap of stateSnap.docs || []) {
    const data = docSnap.data() || {};
    const uid = safeText(docSnap.ref?.parent?.parent?.id, 128);
    if (!uid || uid === SOMTO_OFFICIAL_UID || seenUids.has(uid)) continue;
    const mode = preferencesByUid.get(uid);
    const explicit = titleUpdatePreferenceAllows(mode, after);
    if (explicit === false || (explicit === null && !titleStateEligibleForUpdate(data, after))) continue;
    const relevance = titleUpdateRelevance(data, after, mode);
    if (relevance === "low") { lowRelevance += 1; continue; }
    seenUids.add(uid);
    recipientRows.push({ uid, data, relevance });
    if (recipientRows.length >= cap) break;
  }

  // Un follow esplicito vale anche senza watchlist/stato di visione.
  for (const [uid, mode] of preferencesByUid.entries()) {
    if (recipientRows.length >= cap) break;
    if (uid === SOMTO_OFFICIAL_UID || seenUids.has(uid)) continue;
    if (titleUpdatePreferenceAllows(mode, after) !== true) continue;
    seenUids.add(uid);
    recipientRows.push({ uid, data: {}, relevance: titleUpdateRelevance({}, after, mode) });
  }

  const optedOut = new Set();
  for (let i = 0; i < recipientRows.length; i += 30) {
    const chunk = recipientRows.slice(i, i + 30);
    const rows = await Promise.all(chunk.map(async ({ uid }) => ({
      uid,
      disabled: await hasGlobalTitleUpdateOptOut(db, uid),
    })));
    rows.forEach(({ uid, disabled }) => { if (disabled) optedOut.add(uid); });
  }
  const deliverableRows = recipientRows.filter(({ uid }) => !optedOut.has(uid));

  let titleData = {};
  try {
    const titleSnap = await db.collection("titles").doc(after.titleId).get();
    titleData = titleSnap.exists ? (titleSnap.data() || {}) : {};
  } catch (_) {}
  const titleName = titleNameFromData(titleData, deliverableRows);

  const results = [];
  for (let i = 0; i < deliverableRows.length; i += 20) {
    const chunk = deliverableRows.slice(i, i + 20);
    results.push(...await Promise.all(chunk.map(({ uid, relevance }) => writeCappedTitleUpdateNotification({
      db,
      admin,
      uid,
      eventId,
      event: after,
      titleName,
      nowMs,
      dailyCap,
      relevance,
    }))));
  }

  return {
    skipped: false,
    scanned: (stateSnap.docs || []).length,
    explicitPreferences: (preferenceSnap.docs || []).length,
    eligible: deliverableRows.length,
    lowRelevance,
    highRelevance: deliverableRows.filter((row) => row.relevance === "high").length,
    globallyDisabled: optedOut.size,
    written: results.filter((row) => row.status === "written").length,
    duplicates: results.filter((row) => row.status === "duplicate").length,
    dailyCapped: results.filter((row) => row.status === "daily_cap").length,
    scanLimitReached: (stateSnap.docs || []).length >= scanLimit || (preferenceSnap.docs || []).length >= scanLimit,
  };
}

/**
 * Notifica gli eventi "a data" arrivati a scadenza (oggi o nei giorni di
 * grazia). E' l'altra meta' di `titleUpdateWaitsForAirDate`: il trigger di
 * pubblicazione non sveglia nessuno per un episodio di fra sei giorni, questa
 * sweep lo fa il giorno in cui esce.
 *
 * Idempotenza a due livelli: il marcatore `notifiedAtMs` sull'evento evita di
 * rifare il lavoro al giro dopo, e comunque le notifiche hanno id
 * deterministico (`title_update_{eventId}`), quindi un doppio giro non
 * duplica nulla. Il marcatore si scrive in merge: lo scanner riscrive
 * l'evento senza toccarlo e `managedDocumentsEqual` lo ignora.
 */
async function fanOutDueTitleUpdates({
  db,
  admin,
  nowMs = Date.now(),
  limit = DUE_SWEEP_LIMIT,
  graceMs = DUE_SWEEP_GRACE_MS,
  fanOut = fanOutTitleUpdate,
  maxRecipients = DEFAULT_MAX_RECIPIENTS,
  dailyCap = DEFAULT_DAILY_CAP,
} = {}) {
  if (!db || !admin) throw new Error("db e admin sono obbligatori");
  const cap = Math.max(1, Math.min(500, Math.floor(Number(limit) || DUE_SWEEP_LIMIT)));
  const todayKey = Number(dayKeyForMs(nowMs));

  const snap = await db.collection("titleUpdateEvents")
    .where("eventType", "==", "new_episode")
    .where("status", "==", "published")
    // Il limite alto e' un giorno pieno, non `nowMs`: `air_date` e' una data
    // senza ora, normalizzata a mezzogiorno UTC, quindi un episodio di oggi ha
    // un timestamp piu' avanti dell'orario in cui gira la sweep.
    .where("effectiveAt", ">=", admin.firestore.Timestamp.fromMillis(nowMs - graceMs))
    .where("effectiveAt", "<=", admin.firestore.Timestamp.fromMillis(nowMs + DAY_MS))
    .orderBy("effectiveAt", "asc")
    .limit(cap)
    .get();

  const report = {
    checked: (snap.docs || []).length,
    // Tetto raggiunto = qualche episodio di oggi e' rimasto fuori. Va detto:
    // una troncatura silenziosa si legge come "fatto tutto".
    capReached: (snap.docs || []).length >= cap,
    fanned: 0,
    written: 0,
    skipped: 0,
    errors: [],
  };
  for (const docSnap of snap.docs || []) {
    const event = docSnap.data() || {};
    const airMs = effectiveMillis(event);
    if (Number(event.notifiedAtMs) > 0
      || airMs === null
      || Number(dayKeyForMs(airMs)) > todayKey) {
      report.skipped += 1;
      continue;
    }

    try {
      const result = await fanOut({
        db,
        admin,
        eventId: docSnap.id,
        before: null,
        after: event,
        nowMs,
        maxRecipients,
        dailyCap,
      });
      if (result?.skipped) {
        report.skipped += 1;
        continue;
      }
      await docSnap.ref.set({ notifiedAtMs: nowMs }, { merge: true });
      report.fanned += 1;
      report.written += Number(result?.written || 0);
    } catch (err) {
      report.errors.push({
        eventId: docSnap.id,
        error: String(err?.message || err).slice(0, 240),
      });
    }
  }

  return report;
}

module.exports = {
  DEFAULT_DAILY_CAP,
  DEFAULT_MAX_RECIPIENTS,
  DUE_SWEEP_GRACE_MS,
  DUE_SWEEP_LIMIT,
  fanOutDueTitleUpdates,
  titleUpdateWaitsForAirDate,
  SOMTO_OFFICIAL_UID,
  TITLE_UPDATE_NOTIFICATION_TTL_MS,
  buildTitleUpdateMessageByLocale,
  buildTitleUpdateNotificationDocument,
  dayKeyForMs,
  fanOutTitleUpdate,
  shouldFanOutTitleUpdate,
  titleUpdateRescheduled,
  RESCHEDULE_NOTIFY_THRESHOLD_MS,
  titleNameFromData,
  titleStateEligibleForUpdate,
  titleUpdatePreferenceAllows,
  titleUpdateRelevance,
  titleUpdateNotificationId,
  writeCappedTitleUpdateNotification,
};
