"use strict";

const { releaseConversationPostId } = require("./releaseConversationPosts");

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

// Tipi di evento che vale la pena inoltrare anche a chi segue un ALTRO titolo
// della stessa saga (`event.linkedTitleIds`, CONTRACT 3). Scelti fra i soli 4
// eventType realmente prodotti da buildTitleUpdateEventDocument
// (titleUpdateEventModel.EVENT_TYPES): annuncio/uscita (`release_date`) e
// materiale promozionale (`trailer`, `teaser`). `new_episode` resta escluso —
// un episodio della serie A non e' una notizia per chi segue la serie B della
// stessa saga, e' semplice continuita' che vale solo per chi guarda A.
const LINKED_FANOUT_EVENT_TYPES = new Set(["trailer", "teaser", "release_date"]);

// Quanto scende la rilevanza per un destinatario "collegato" (segue un altro
// titolo della saga, non quello a cui l'evento si riferisce davvero). Un
// passo sotto la rilevanza che avrebbe come destinatario PRIMARIO: la notizia
// resta pertinente ma non è "sua" quanto lo è per chi segue il titolo giusto.
const RELEVANCE_DOWNGRADE = { high: "medium", medium: "low", low: "low" };

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
// `linked: true` = il destinatario non segue il titolo a cui l'evento si
// riferisce (`event.titleId`), ma un ALTRO titolo della stessa saga
// (`event.linkedTitleIds`, CONTRACT 3). Un follow/important esplicito resta
// "alta" anche collegato — è comunque una richiesta diretta della persona,
// non va declassata solo perché il match è avvenuto su un titolo diverso.
function titleUpdateRelevance(stateData = {}, event = {}, explicitMode = null, { linked = false } = {}) {
  const eventType = safeText(event.eventType, 40);
  const state = safeText(stateData.state, 40).toLowerCase();
  const mode = safeText(explicitMode, 24).toLowerCase();
  const inProgress = state === "in_progress";
  const watchlisted = stateData.generalWatchlist === true;

  // Un follow esplicito è una richiesta diretta: non la declassiamo mai.
  if (mode === "follow" || mode === "important") return "high";

  let relevance;
  if (SERIES_PROGRESS_EVENT_TYPES.has(eventType)) {
    relevance = inProgress ? "high" : "medium";
  } else if (eventType === "release_date") {
    relevance = (watchlisted || inProgress) ? "medium" : "low";
  } else {
    // trailer, teaser e resto: interessano solo se il titolo è ancora davanti
    // a te, non se l'hai già visto.
    relevance = (watchlisted || inProgress) ? "medium" : "low";
  }
  return linked ? RELEVANCE_DOWNGRADE[relevance] : relevance;
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

// `linkedContext.titleName`, quando presente, e' il nome del titolo che il
// DESTINATARIO segue davvero — diverso da `titleName` (il titolo a cui
// l'evento si riferisce). Serve a spiegare in una frase perche' arriva questo
// aggiornamento: "nuovo trailer di X" da solo non dice nulla a chi segue Y.
function buildTitleUpdateMessageByLocale(event = {}, titleName = "", nowMs = Date.now(), linkedContext = null) {
  const base = buildBaseTitleUpdateMessageByLocale(event, titleName, nowMs);
  const linkedName = safeText(linkedContext?.titleName, 160);
  if (!linkedName) return base;
  return {
    "it-IT": `${base["it-IT"]} Dalla stessa saga di ${linkedName}.`,
    "en-US": `${base["en-US"]} From the same saga as ${linkedName}.`,
  };
}

function buildBaseTitleUpdateMessageByLocale(event = {}, titleName = "", nowMs = Date.now()) {
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
    // La premiere di una stagione dalla seconda in poi dice la stagione: e'
    // quella la notizia. Una serie nuova (S1E1) resta sul copy dell'episodio,
    // perche' "uscito/uscita" dipenderebbe dal titolo.
    const season = Number(event.season);
    if (Number(event.episode) === 1 && Number.isInteger(season) && season >= 2) {
      if (dayDelta > 0) {
        return {
          "it-IT": `La stagione ${season} di ${italianName} inizia il ${formatEventDay(airMs, "it-IT")}.`,
          "en-US": `Season ${season} of ${englishName} starts on ${formatEventDay(airMs, "en-US")}.`,
        };
      }
      if (dayDelta === 0 && airMs !== null) {
        return {
          "it-IT": `Oggi inizia la stagione ${season} di ${italianName}.`,
          "en-US": `Season ${season} of ${englishName} starts today.`,
        };
      }
      return {
        "it-IT": `È iniziata la stagione ${season} di ${italianName}.`,
        "en-US": `Season ${season} of ${englishName} has started.`,
      };
    }
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

/**
 * Episodio 1 di una stagione: e' l'uscita, non un appuntamento settimanale.
 * Dal 2026-09-10 le premiere hanno la loro push il giorno in cui escono; gli
 * altri episodi restano nel digest del giovedi'.
 */
function isSeasonPremiere(event = {}) {
  return safeText(event.eventType, 40) === "new_episode" && Number(event.episode) === 1;
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

function buildTitleUpdateNotificationDocument({
  admin,
  uid,
  eventId,
  event,
  titleName,
  nowMs,
  conversationPostId = "",
  // CONTRACT 3 — solo per un destinatario raggiunto via `linkedTitleIds`
  // (segue un ALTRO titolo della stessa saga, non `event.titleId`).
  // `linkedFromTitleId` e' l'id del titolo a cui l'evento si riferisce
  // davvero (identico a `data.titleId`: e' una marca esplicita di
  // provenienza per analytics/debug, non una destinazione diversa — il tap
  // porta comunque sull'evento reale). `linkedTitleName` e' il nome del
  // titolo che il destinatario segue, usato solo per il copy del messaggio.
  linkedFromTitleId = "",
  linkedTitleName = "",
}) {
  const linkedFrom = safeText(linkedFromTitleId, 160);
  const messageByLocale = buildTitleUpdateMessageByLocale(
    event,
    titleName,
    nowMs,
    linkedFrom ? { titleName: linkedTitleName } : null
  );
  const titleId = safeText(event.titleId, 160);
  // Se l'uscita ha gia' il suo post commentabile, la notifica porta LI'.
  // La scheda titolo dice "e' uscito"; il post e' l'unico posto dove si puo'
  // rispondere a qualcuno, ed e' quello che manca: 42 post ufficiali in un
  // mese, 2 commenti. Senza post si resta sulla scheda, come prima.
  const postId = safeText(conversationPostId, 200);
  const ctaUrl = postId
    ? `/community.html?post=${encodeURIComponent(postId)}`
    : `/title.html?id=${encodeURIComponent(titleId)}&focus=updates&event=${encodeURIComponent(eventId)}`;
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
      // I client che sanno aprire un post lo fanno da qui, senza interpretare
      // la URL: iOS naviga per id.
      ...(postId ? { postId } : {}),
      ...(linkedFrom ? { linkedFromTitleId: linkedFrom } : {}),
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
  conversationPostId = "",
  linkedFromTitleId = "",
  linkedTitleName = "",
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
      conversationPostId,
      linkedFromTitleId,
      linkedTitleName,
    }), { merge: false });
    return { status: "written", notificationId };
  });
}

async function postExists(db, postId) {
  if (!postId) return false;
  try {
    const snap = await db.collection("posts").doc(postId).get();
    return Boolean(snap.exists);
  } catch (_) {
    return false;
  }
}

/**
 * Post della premiere di stagione. L'automatismo crea un post solo per il
 * primo episodio: senza questo ripiego, una serie settimanale — il caso di
 * Ted Lasso — manderebbe la notifica alla scheda titolo per tutta la stagione,
 * mentre la conversazione di quella stagione esiste gia' ed e' viva.
 */
function seasonPremierePostId(event = {}) {
  if (event?.mediaType !== "tv") return "";
  const tmdbId = Math.floor(Number(event.tmdbId));
  const season = Math.floor(Number(event.season));
  const episode = Math.floor(Number(event.episode));
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) return "";
  if (!Number.isFinite(season) || season <= 0) return "";
  // Sul primo episodio il post diretto e' gia' quello giusto.
  if (!Number.isFinite(episode) || episode <= 1) return "";
  return releaseConversationPostId(`tmdb_release_tv_${tmdbId}_s${season}_e1`);
}

/**
 * Dove portare il tap: il post di questa uscita se esiste, altrimenti quello
 * della premiere della stessa stagione. Best effort: un errore di lettura non
 * deve far saltare le notifiche.
 */
async function resolveConversationPostId(db, eventId, event = null) {
  const direct = releaseConversationPostId(eventId);
  if (await postExists(db, direct)) return direct;

  const premiere = seasonPremierePostId(event || {});
  if (premiere && premiere !== direct && await postExists(db, premiere)) return premiere;
  return "";
}

/**
 * Scansiona titleStates + titleUpdatePrefs per UN titolo (`queryTitleId`) e
 * restituisce i destinatari idonei, con lo stesso criterio usato per il
 * titolo primario. Estratta cosi' il fanout collegato (CONTRACT 3) puo'
 * ripetere esattamente la stessa logica su ogni `linkedTitleIds` senza
 * duplicarla. `event` resta quello vero (per eventType/mediaType); solo
 * `queryTitleId` cambia fra la chiamata primaria e quelle collegate.
 * `seenUids` e' condiviso fra tutte le chiamate della stessa fanout: chi e'
 * gia' stato scelto (dal titolo primario o da un altro titolo collegato) non
 * viene ricontato ne' rinotificato.
 */
async function scanEligibleRecipientsForTitle(db, {
  queryTitleId,
  event,
  scanLimit,
  cap,
  seenUids,
  linked = false,
}) {
  const stateSnap = await db.collectionGroup("titleStates")
    .where("titleId", "==", queryTitleId)
    .limit(scanLimit)
    .get();

  // Se questa query fallisce (tipicamente: indice collection-group mancante) i
  // "muto" per titolo verrebbero ignorati e notificheremmo chi ha chiesto
  // silenzio. Meglio saperlo dai log che degradare in silenzio.
  const preferenceSnap = await db.collectionGroup("titleUpdatePrefs")
    .where("titleId", "==", queryTitleId)
    .limit(scanLimit)
    .get()
    .catch((err) => {
      console.error("[titleUpdates] lettura titleUpdatePrefs fallita", {
        titleId: queryTitleId,
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

  const rows = [];
  let lowRelevance = 0;
  for (const docSnap of stateSnap.docs || []) {
    const data = docSnap.data() || {};
    const uid = safeText(docSnap.ref?.parent?.parent?.id, 128);
    if (!uid || uid === SOMTO_OFFICIAL_UID || seenUids.has(uid)) continue;
    const mode = preferencesByUid.get(uid);
    const explicit = titleUpdatePreferenceAllows(mode, event);
    if (explicit === false || (explicit === null && !titleStateEligibleForUpdate(data, event))) continue;
    const relevance = titleUpdateRelevance(data, event, mode, { linked });
    if (relevance === "low") { lowRelevance += 1; continue; }
    seenUids.add(uid);
    rows.push({ uid, data, relevance });
    if (rows.length >= cap) break;
  }

  // Un follow esplicito vale anche senza watchlist/stato di visione.
  for (const [uid, mode] of preferencesByUid.entries()) {
    if (rows.length >= cap) break;
    if (uid === SOMTO_OFFICIAL_UID || seenUids.has(uid)) continue;
    if (titleUpdatePreferenceAllows(mode, event) !== true) continue;
    seenUids.add(uid);
    rows.push({ uid, data: {}, relevance: titleUpdateRelevance({}, event, mode, { linked }) });
  }

  return {
    rows,
    lowRelevance,
    scanned: (stateSnap.docs || []).length,
    explicitPreferences: (preferenceSnap.docs || []).length,
    scanLimitReached: (stateSnap.docs || []).length >= scanLimit || (preferenceSnap.docs || []).length >= scanLimit,
  };
}

// Filtra l'opt-out globale (`users/{uid}/_system/notificationPrefs`) su un
// gruppo di righe {uid,...}, in chunk da 30 letture parallele.
async function filterGloballyOptedOut(db, rows) {
  const optedOut = new Set();
  for (let i = 0; i < rows.length; i += 30) {
    const chunk = rows.slice(i, i + 30);
    const checked = await Promise.all(chunk.map(async ({ uid }) => ({
      uid,
      disabled: await hasGlobalTitleUpdateOptOut(db, uid),
    })));
    checked.forEach(({ uid, disabled }) => { if (disabled) optedOut.add(uid); });
  }
  return { deliverableRows: rows.filter(({ uid }) => !optedOut.has(uid)), optedOut };
}

async function titleNameById(db, titleId) {
  try {
    const snap = await db.collection("titles").doc(titleId).get();
    return snap.exists ? safeText(snap.data()?.name || snap.data()?.title, 160) : "";
  } catch (_) {
    return "";
  }
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
  const seenUids = new Set();

  const primaryScan = await scanEligibleRecipientsForTitle(db, {
    queryTitleId: after.titleId,
    event: after,
    scanLimit,
    cap,
    seenUids,
    linked: false,
  });

  const { deliverableRows, optedOut } = await filterGloballyOptedOut(db, primaryScan.rows);

  let titleData = {};
  try {
    const titleSnap = await db.collection("titles").doc(after.titleId).get();
    titleData = titleSnap.exists ? (titleSnap.data() || {}) : {};
  } catch (_) {}
  const titleName = titleNameFromData(titleData, deliverableRows);

  // Una lettura per evento, non per destinatario. Se il post e' stato ritirato
  // il doc non esiste piu' e la notifica torna a puntare alla scheda titolo.
  const conversationPostId = await resolveConversationPostId(db, eventId, after);

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
      conversationPostId,
    }))));
  }

  // CONTRACT 3 — fanout collegato: chi segue un ALTRO titolo della stessa
  // saga (`after.linkedTitleIds`, scritto da writeTitleUpdateEvent) riceve lo
  // stesso evento, con rilevanza degradata di un passo e un `linkedFromTitleId`
  // esplicito. Solo per gli eventType in LINKED_FANOUT_EVENT_TYPES: un nuovo
  // episodio della serie A non e' notizia per chi segue la serie B della
  // stessa saga. `seenUids` e' condiviso col primario: chi e' gia' stato
  // scelto (o e' opted-out) non viene ricontato.
  let linkedScanned = 0;
  let linkedExplicitPreferences = 0;
  let linkedLowRelevance = 0;
  let linkedScanLimitReached = false;
  let linkedEligible = 0;
  const linkedResults = [];
  const linkedIds = LINKED_FANOUT_EVENT_TYPES.has(safeText(after.eventType, 40))
    ? (Array.isArray(after.linkedTitleIds) ? after.linkedTitleIds : [])
      .map((id) => safeText(id, 160))
      .filter((id) => id && id !== after.titleId)
    : [];

  for (const linkedTitleId of linkedIds) {
    const remainingCap = cap - seenUids.size;
    if (remainingCap <= 0) break;

    const linkedScan = await scanEligibleRecipientsForTitle(db, {
      queryTitleId: linkedTitleId,
      event: after,
      scanLimit,
      cap: remainingCap,
      seenUids,
      linked: true,
    });
    linkedScanned += linkedScan.scanned;
    linkedExplicitPreferences += linkedScan.explicitPreferences;
    linkedLowRelevance += linkedScan.lowRelevance;
    linkedScanLimitReached = linkedScanLimitReached || linkedScan.scanLimitReached;
    if (!linkedScan.rows.length) continue;

    const { deliverableRows: linkedDeliverable } = await filterGloballyOptedOut(db, linkedScan.rows);
    if (!linkedDeliverable.length) continue;
    linkedEligible += linkedDeliverable.length;

    const linkedTitleName = await titleNameById(db, linkedTitleId);
    for (let i = 0; i < linkedDeliverable.length; i += 20) {
      const chunk = linkedDeliverable.slice(i, i + 20);
      linkedResults.push(...await Promise.all(chunk.map(({ uid, relevance }) => writeCappedTitleUpdateNotification({
        db,
        admin,
        uid,
        eventId,
        event: after,
        titleName,
        nowMs,
        dailyCap,
        relevance,
        conversationPostId,
        linkedFromTitleId: after.titleId,
        linkedTitleName,
      }))));
    }
  }

  return {
    skipped: false,
    scanned: primaryScan.scanned,
    explicitPreferences: primaryScan.explicitPreferences,
    eligible: deliverableRows.length,
    lowRelevance: primaryScan.lowRelevance,
    highRelevance: deliverableRows.filter((row) => row.relevance === "high").length,
    globallyDisabled: optedOut.size,
    written: results.filter((row) => row.status === "written").length,
    duplicates: results.filter((row) => row.status === "duplicate").length,
    dailyCapped: results.filter((row) => row.status === "daily_cap").length,
    scanLimitReached: primaryScan.scanLimitReached,
    // CONTRACT 3 — sempre presenti (0 quando l'evento non ha titoli collegati
    // o il suo eventType non e' nella allowlist), cosi' il caller non deve
    // distinguere i due casi.
    linkedEligible,
    linkedWritten: linkedResults.filter((row) => row.status === "written").length,
    linkedScanned,
    linkedExplicitPreferences,
    linkedLowRelevance,
    linkedScanLimitReached,
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
  premieresOnly = false,
} = {}) {
  if (!db || !admin) throw new Error("db e admin sono obbligatori");
  const cap = Math.max(1, Math.min(500, Math.floor(Number(limit) || DUE_SWEEP_LIMIT)));
  const todayKey = Number(dayKeyForMs(nowMs));

  let query = db.collection("titleUpdateEvents")
    .where("eventType", "==", "new_episode")
    .where("status", "==", "published");
  // Solo le premiere quando la sweep per episodio e' spenta. Stesso indice
  // (eventType + status + episode + effectiveAt), gia' in firestore.indexes.json.
  if (premieresOnly) query = query.where("episode", "==", 1);
  const snap = await query
    // Il limite alto e' un giorno pieno, non `nowMs`: `air_date` e' una data
    // senza ora, normalizzata a mezzogiorno UTC, quindi un episodio di oggi ha
    // un timestamp piu' avanti dell'orario in cui gira la sweep.
    .where("effectiveAt", ">=", admin.firestore.Timestamp.fromMillis(nowMs - graceMs))
    .where("effectiveAt", "<=", admin.firestore.Timestamp.fromMillis(nowMs + DAY_MS))
    .orderBy("effectiveAt", "asc")
    .limit(cap)
    .get();

  const report = {
    premieresOnly,
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
    if ((premieresOnly && !isSeasonPremiere(event))
      || Number(event.notifiedAtMs) > 0
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
  hasGlobalTitleUpdateOptOut,
  DEFAULT_MAX_RECIPIENTS,
  DUE_SWEEP_GRACE_MS,
  DUE_SWEEP_LIMIT,
  LINKED_FANOUT_EVENT_TYPES,
  fanOutDueTitleUpdates,
  isSeasonPremiere,
  titleUpdateWaitsForAirDate,
  SOMTO_OFFICIAL_UID,
  TITLE_UPDATE_NOTIFICATION_TTL_MS,
  buildTitleUpdateMessageByLocale,
  buildTitleUpdateNotificationDocument,
  dayKeyForMs,
  fanOutTitleUpdate,
  scanEligibleRecipientsForTitle,
  shouldFanOutTitleUpdate,
  titleUpdateRescheduled,
  RESCHEDULE_NOTIFY_THRESHOLD_MS,
  titleNameFromData,
  titleStateEligibleForUpdate,
  titleUpdatePreferenceAllows,
  titleUpdateRelevance,
  titleUpdateNotificationId,
  resolveConversationPostId,
  seasonPremierePostId,
  writeCappedTitleUpdateNotification,
};
