"use strict";

// Digest settimanale: **una** notifica a settimana con le novità sui titoli che
// hai in libreria o in watchlist.
//
// PERCHE' ESISTE — misurato il 2026-08-24: 11.116 richiami di re-engagement
// letti allo 0,5%, mentre gli aggiornamenti sui titoli sono letti dieci volte
// tanto ma arrivano a una mediana di 2 persone per volta. C'e' gia' la materia
// prima (783 eventi titolo notificabili) e c'e' gia' il canale; mancava una
// cadenza che desse un motivo di tornare senza tornare a fare rumore.
//
// COSA NON E' — non e' un secondo canale di notifica titolo. La sweep
// giornaliera (`fanOutDueTitleUpdates`) resta la fonte per le notizie forti del
// giorno; il digest raccoglie quello che quella sweep **non** ha mandato, cosi'
// nessuno riceve la stessa notizia due volte.
//
// Nessun I/O qui dentro: chi chiama passa eventi, stati e preferenze gia' letti.

const {
  buildTitleUpdateMessageByLocale,
  titleStateEligibleForUpdate,
  titleUpdatePreferenceAllows,
  titleUpdateRelevance,
} = require("./titleUpdateNotifications");

const SOMTO_OFFICIAL_UID = "somto_official";
const DIGEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Quante novità entrano in un digest. Tre e' il numero che si legge in
// anteprima di notifica senza scorrere, e tiene la promessa "una tirata sola".
const DEFAULT_DIGEST_LIMIT = 3;

// Una persona che non apre Somto da mesi non e' pubblico da digest ricorrente:
// e' pubblico da un colpo solo di risveglio, che e' un'altra cosa e va deciso a
// mano. Qui dentro entra chi si e' fatto vivo di recente.
const DEFAULT_MAX_INACTIVITY_MS = 60 * 24 * 60 * 60 * 1000;

const RELEVANCE_RANK = { high: 0, medium: 1 };

function safeText(value, maxLength = 240) {
  return String(value || "").trim().slice(0, maxLength);
}

function eventMillis(value) {
  if (!value) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value._seconds === "number") return value._seconds * 1000;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Chiave della settimana ISO a Roma (`2026-W35`): rende l'id della notifica
 * deterministico, quindi un run ripetuto non manda mai due digest.
 */
function digestWeekKey(nowMs = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(Number(nowMs)));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  const date = new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
  // ISO 8601: la settimana appartiene all'anno del suo giovedì.
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((date - firstThursday) / (7 * 24 * 60 * 60 * 1000));
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function digestNotificationId(weekKey) {
  const key = safeText(weekKey, 32);
  if (!key || key.includes("/")) throw new Error("weekKey non valido");
  return `weekly_digest_${key}`;
}

/**
 * Sceglie le novità che vale la pena mettere nel digest di UNA persona.
 *
 * @param {Object} params
 * @param {Array<{id: string, data: Object, titleName?: string}>} params.events
 * @param {Object} params.statesByTitleId       titleId → doc `titleStates`
 * @param {Object} params.prefsByTitleId        titleId → doc `titleUpdatePrefs`
 * @param {Set<string>|Array<string>} params.notifiedEventIds  gia' arrivati singolarmente
 * @returns {Array<{eventId, titleId, titleName, eventType, relevance, effectiveAtMs, messageByLocale}>}
 */
function selectDigestItems({
  events = [],
  statesByTitleId = {},
  prefsByTitleId = {},
  notifiedEventIds = [],
  nowMs = Date.now(),
  limit = DEFAULT_DIGEST_LIMIT,
} = {}) {
  const already = notifiedEventIds instanceof Set
    ? notifiedEventIds
    : new Set((notifiedEventIds || []).filter(Boolean));
  const cap = Math.max(1, Math.min(10, Math.floor(Number(limit) || DEFAULT_DIGEST_LIMIT)));
  const rows = [];

  for (const row of events) {
    const eventId = safeText(row?.id, 240);
    const event = row?.data || {};
    if (!eventId || already.has(eventId)) continue;

    const titleId = safeText(event.titleId, 160);
    const state = statesByTitleId[titleId];
    // Il digest parla solo di roba tua: senza uno stato sul titolo non c'e'
    // niente da raccontare, e un consiglio mascherato da notizia e' pubblicita'.
    if (!state) continue;
    if (!titleStateEligibleForUpdate(state, event)) continue;

    const mode = safeText(prefsByTitleId[titleId]?.mode, 24);
    if (titleUpdatePreferenceAllows(mode, event) === false) continue;

    const relevance = titleUpdateRelevance(state, event, mode);
    if (relevance !== "high" && relevance !== "medium") continue;

    rows.push({
      eventId,
      titleId,
      titleName: safeText(row?.titleName || event.titleName, 160),
      eventType: safeText(event.eventType, 40),
      relevance,
      effectiveAtMs: eventMillis(event.effectiveAt || event.effectiveDate),
      messageByLocale: buildTitleUpdateMessageByLocale(event, row?.titleName || event.titleName, nowMs),
    });
  }

  rows.sort((a, b) => {
    const rank = (RELEVANCE_RANK[a.relevance] ?? 9) - (RELEVANCE_RANK[b.relevance] ?? 9);
    if (rank !== 0) return rank;
    // A parità di rilevanza vince quello che sta per succedere (o e' appena
    // successo): una data lontana in un digest settimanale non e' una notizia.
    const da = a.effectiveAtMs === null ? Number.MAX_SAFE_INTEGER : Math.abs(a.effectiveAtMs - nowMs);
    const dbb = b.effectiveAtMs === null ? Number.MAX_SAFE_INTEGER : Math.abs(b.effectiveAtMs - nowMs);
    if (da !== dbb) return da - dbb;
    return a.eventId.localeCompare(b.eventId);
  });

  // Un titolo, una riga: tre novità sulla stessa serie sono una novità sola
  // ripetuta, e bruciano il digest di quella settimana.
  const seenTitles = new Set();
  const picked = [];
  for (const row of rows) {
    if (seenTitles.has(row.titleId)) continue;
    seenTitles.add(row.titleId);
    picked.push(row);
    if (picked.length >= cap) break;
  }
  return picked;
}

/**
 * Il testo del digest. Una riga sola: la novità più forte, e quante altre ce ne
 * sono. Il dettaglio sta nella lista dentro `data.items`, che i client aprono.
 */
function buildDigestMessageByLocale(items = []) {
  const first = items[0]?.messageByLocale || {};
  const italian = safeText(first["it-IT"], 200);
  const english = safeText(first["en-US"], 200);
  const rest = Math.max(0, items.length - 1);
  if (!rest) return { "it-IT": italian, "en-US": english };
  if (rest === 1) {
    return {
      "it-IT": `${italian} E un'altra novità sui tuoi titoli.`,
      "en-US": `${english} Plus one more update on your titles.`,
    };
  }
  return {
    "it-IT": `${italian} E altre ${rest} novità sui tuoi titoli.`,
    "en-US": `${english} Plus ${rest} more updates on your titles.`,
  };
}

/** Le novità dalla seconda in poi, una riga sola. Vuota se ce n'è una sola. */
function restLine(items = [], locale = "it-IT") {
  return items
    .slice(1)
    .map((row) => safeText(row?.messageByLocale?.[locale], 160))
    .filter(Boolean)
    .join(" · ");
}

/**
 * Il documento notifica. Id deterministico sulla settimana: se il run gira due
 * volte, la seconda non scrive niente.
 */
function buildWeeklyDigestNotification({
  admin,
  uid,
  items = [],
  weekKey,
  nowMs = Date.now(),
}) {
  if (!admin) throw new Error("admin obbligatorio");
  const recipientUid = safeText(uid, 128);
  if (!recipientUid) throw new Error("uid non valido");
  if (!items.length) throw new Error("un digest senza novità non si manda");

  const messageByLocale = buildDigestMessageByLocale(items);
  const first = items[0];
  return {
    toUid: recipientUid,
    fromUid: SOMTO_OFFICIAL_UID,
    type: "weekly_digest",
    data: {
      fromName: "Somto",
      count: items.length,
      weekKey: safeText(weekKey, 32),
      messageByLocale,
      // `message` in chiaro per i client vecchi: iOS senza il caso
      // `weekly_digest` cade nel ramo di default, che legge questo campo. Senza,
      // in campanella comparirebbe "Nuova attività" — e la coorte App Store si
      // aggiorna in settimane, non in un giorno.
      message: messageByLocale["it-IT"],
      // La seconda riga NOMINA le altre novità invece di contarle. Il ramo di
      // default di iOS la mostra sotto il titolo e la campanella web pure,
      // quindi le novità dalla seconda in poi si leggono senza aggiornare
      // l'app: prima esistevano solo dentro `items`, che nessuno rendeva.
      preview: restLine(items, "it-IT"),
      previewByLocale: {
        "it-IT": restLine(items, "it-IT"),
        "en-US": restLine(items, "en-US"),
      },
      items: items.map((row) => ({
        eventId: row.eventId,
        titleId: row.titleId,
        titleName: row.titleName,
        eventType: row.eventType,
        messageByLocale: row.messageByLocale,
      })),
      // Sempre il titolo della novità più forte, anche quando ce n'è più di
      // una. Provato su iPhone il 2026-08-25: mandare alla lista notifiche
      // apriva il browser in-app (`/notifications.html` non ha una
      // destinazione nativa) e il tap girava in tondo — lista, browser, lista.
      // Il testo della notifica nomina già quel titolo, quindi finirci sopra è
      // anche quello che la persona si aspetta; le altre righe restano in
      // campanella.
      ctaUrl: `/title.html?id=${encodeURIComponent(first.titleId)}&focus=updates&event=${encodeURIComponent(first.eventId)}`,
      titleId: first.titleId,
    },
    read: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + DIGEST_TTL_MS),
  };
}

module.exports = {
  DEFAULT_DIGEST_LIMIT,
  DEFAULT_MAX_INACTIVITY_MS,
  DIGEST_TTL_MS,
  buildDigestMessageByLocale,
  buildWeeklyDigestNotification,
  digestNotificationId,
  digestWeekKey,
  restLine,
  selectDigestItems,
};
