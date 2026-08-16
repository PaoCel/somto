const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildTitleUpdateMessageByLocale,
  dayKeyForMs,
  fanOutDueTitleUpdates,
  fanOutTitleUpdate,
  titleUpdateWaitsForAirDate,
  shouldFanOutTitleUpdate,
  titleStateEligibleForUpdate,
  titleUpdatePreferenceAllows,
  titleUpdateRelevance,
  titleUpdateNotificationId,
  writeCappedTitleUpdateNotification,
} = require("../../lib/titleUpdateNotifications");
const {
  backfillCandidateWindow,
  scheduledCandidateWindow,
  titleUpdateNotificationsEnabled,
  titleUpdateScannerEnabled,
} = require("../../modules/titleUpdates");

const NOW_MS = Date.parse("2026-08-02T10:00:00.000Z");
const admin = {
  firestore: {
    FieldValue: { serverTimestamp: () => new Date(NOW_MS) },
    Timestamp: { fromMillis: (ms) => new Date(ms) },
  },
};

function event(overrides = {}) {
  return {
    titleId: "ted-lasso",
    mediaType: "tv",
    eventType: "trailer",
    status: "published",
    acquisitionMode: "live",
    notificationEligible: true,
    official: true,
    sourceUrl: "https://youtube.com/watch?v=abc",
    headlineByLocale: { "it-IT": "Trailer ufficiale", "en-US": "Official trailer" },
    ...overrides,
  };
}

function refFor(path, store) {
  return {
    path,
    id: path.split("/").at(-1),
    collection(name) { return collectionFor(`${path}/${name}`, store); },
    async get() {
      const data = store.get(path);
      return { exists: data !== undefined, data: () => data };
    },
  };
}

function collectionFor(path, store) {
  return { doc: (id) => refFor(`${path}/${id}`, store) };
}

function makeDb(stateDocs = [], preferenceDocs = []) {
  const store = new Map([["titles/ted-lasso", { name: "Ted Lasso" }]]);
  return {
    store,
    collection(name) { return collectionFor(name, store); },
    collectionGroup(name) {
      assert.ok(["titleStates", "titleUpdatePrefs"].includes(name));
      const docs = name === "titleStates" ? stateDocs : preferenceDocs;
      return {
        where(field, op, value) {
          assert.deepEqual([field, op, value], ["titleId", "==", "ted-lasso"]);
          return {
            limit() {
              return { get: async () => ({ docs }) };
            },
          };
        },
      };
    },
    async runTransaction(fn) {
      return fn({
        async get(ref) {
          const data = store.get(ref.path);
          return { exists: data !== undefined, data: () => data };
        },
        set(ref, data, options) {
          store.set(ref.path, options?.merge ? { ...(store.get(ref.path) || {}), ...data } : data);
        },
      });
    },
  };
}

function stateDoc(uid, data) {
  return {
    data: () => ({ titleId: "ted-lasso", mediaType: "tv", ...data }),
    ref: { parent: { parent: { id: uid } } },
  };
}

function preferenceDoc(uid, mode) {
  return {
    data: () => ({ titleId: "ted-lasso", mode }),
    ref: { parent: { parent: { id: uid } } },
  };
}

test("fanout richiede prima pubblicazione live e mai il backfill", () => {
  assert.equal(shouldFanOutTitleUpdate(null, event()), true);
  assert.equal(shouldFanOutTitleUpdate({ status: "draft" }, event()), true);
  assert.equal(shouldFanOutTitleUpdate({ status: "published" }, event()), false);
  assert.equal(shouldFanOutTitleUpdate(null, event({ acquisitionMode: "backfill" })), false);
  assert.equal(shouldFanOutTitleUpdate(null, event({ notificationEligible: false })), false);
});

// Un evento pubblicato a mano dalla console deve poter notificare: il gate
// serve a escludere il BACKFILL (notizie vecchie scoperte alla prima scansione),
// non la decisione deliberata di una persona. Senza questo, un draft
// pubblicato a mano resterebbe muto per sempre — ed e' proprio il caso dei film
// senza data di uscita italiana confermata, che oggi nessuno puo' sbloccare.
test("una pubblicazione manuale notifica, un backfill no", () => {
  assert.equal(shouldFanOutTitleUpdate({ status: "draft" }, event({ acquisitionMode: "manual" })), true);
  assert.equal(shouldFanOutTitleUpdate({ status: "draft" }, event({ acquisitionMode: "backfill" })), false);
});

// Chi decide se notificare e' la callable, che valorizza notificationEligible
// (regola attuale: solo se l'uscita e' entro due settimane). Il gate si limita
// a rispettarlo.
test("la pubblicazione manuale resta muta se non e' notificabile", () => {
  assert.equal(
    shouldFanOutTitleUpdate({ status: "draft" }, event({ acquisitionMode: "manual", notificationEligible: false })),
    false
  );
});

test("interesse copre seguito, parziale e completato ma esclude rimosso", () => {
  assert.equal(titleStateEligibleForUpdate({ generalWatchlist: true, state: "not_started" }, event()), true);
  assert.equal(titleStateEligibleForUpdate({ state: "in_progress" }, event()), true);
  assert.equal(titleStateEligibleForUpdate({ state: "completed_unrated" }, event()), true);
  assert.equal(titleStateEligibleForUpdate({ state: "dismissed", generalWatchlist: true }, event()), false);
  assert.equal(titleStateEligibleForUpdate({ state: "unseen" }, event({ mediaType: "movie" })), false);
  assert.equal(titleStateEligibleForUpdate({ state: "seen_unrated" }, event({ mediaType: "movie" })), true);
  assert.equal(titleStateEligibleForUpdate({ state: "seen_unrated" }, event({ mediaType: "movie", eventType: "new_episode" })), false);
});

test("preferenza esplicita segue, limita agli importanti o silenzia", () => {
  assert.equal(titleUpdatePreferenceAllows("follow", event({ eventType: "new_episode" })), true);
  assert.equal(titleUpdatePreferenceAllows("important", event({ eventType: "trailer" })), true);
  assert.equal(titleUpdatePreferenceAllows("important", event({ eventType: "new_episode" })), false);
  assert.equal(titleUpdatePreferenceAllows("muted", event()), false);
  assert.equal(titleUpdatePreferenceAllows("", event()), null);
});

test("la rilevanza premia le serie in corso e scarta i trailer su roba già vista", () => {
  const newEpisode = event({ eventType: "new_episode", mediaType: "tv" });
  assert.equal(titleUpdateRelevance({ state: "in_progress" }, newEpisode), "high");
  assert.equal(titleUpdateRelevance({ state: "rated" }, newEpisode), "medium");

  const trailer = event({ eventType: "trailer" });
  assert.equal(titleUpdateRelevance({ generalWatchlist: true }, trailer), "medium");
  assert.equal(titleUpdateRelevance({ state: "in_progress" }, trailer), "medium");
  assert.equal(titleUpdateRelevance({ state: "rated" }, trailer), "low");

  const release = event({ eventType: "release_date" });
  assert.equal(titleUpdateRelevance({ generalWatchlist: true }, release), "medium");
  assert.equal(titleUpdateRelevance({ state: "seen_unrated" }, release), "low");

  // Un follow esplicito non viene mai declassato.
  assert.equal(titleUpdateRelevance({ state: "rated" }, trailer, "follow"), "high");
});

test("un evento di media rilevanza lascia libero l'ultimo slot del giorno", async () => {
  const db = makeDb();
  const base = { db, admin, uid: "alice", event: event(), titleName: "Ted Lasso", nowMs: NOW_MS, dailyCap: 3 };
  assert.equal((await writeCappedTitleUpdateNotification({ ...base, eventId: "m1", relevance: "medium" })).status, "written");
  assert.equal((await writeCappedTitleUpdateNotification({ ...base, eventId: "m2", relevance: "medium" })).status, "written");
  // Terzo medium: fermato dal margine, lo slot resta per una notizia forte.
  assert.equal((await writeCappedTitleUpdateNotification({ ...base, eventId: "m3", relevance: "medium" })).status, "daily_cap");
  assert.equal((await writeCappedTitleUpdateNotification({ ...base, eventId: "h1", relevance: "high" })).status, "written");
  assert.equal((await writeCappedTitleUpdateNotification({ ...base, eventId: "h2", relevance: "high" })).status, "daily_cap");
});

test("copy notifica è disponibile in italiano e inglese", () => {
  assert.deepEqual(buildTitleUpdateMessageByLocale(event(), "Ted Lasso"), {
    "it-IT": "È uscito un nuovo trailer di Ted Lasso.",
    "en-US": "A new trailer for Ted Lasso is out.",
  });
  assert.match(buildTitleUpdateMessageByLocale(event({ eventType: "new_episode" }), "Ted Lasso")["en-US"], /new episode/);
  assert.equal(buildTitleUpdateMessageByLocale(event(), "")["en-US"], "A new trailer for this title is out.");
});

// "In arrivo" senza data si legge come "e' uscito adesso": l'episodio deve
// dire QUANDO esce, o dire che esce oggi.
test("un episodio non ancora uscito porta con se' la data", () => {
  const upcoming = event({ eventType: "new_episode", effectiveAt: new Date(Date.parse("2026-08-09T12:00:00.000Z")) });
  assert.deepEqual(buildTitleUpdateMessageByLocale(upcoming, "Ted Lasso", NOW_MS), {
    "it-IT": "Nuovo episodio di Ted Lasso il 9 agosto.",
    "en-US": "New episode of Ted Lasso on August 9.",
  });

  const today = event({ eventType: "new_episode", effectiveAt: new Date(NOW_MS + (2 * 60 * 60 * 1000)) });
  assert.deepEqual(buildTitleUpdateMessageByLocale(today, "Ted Lasso", NOW_MS), {
    "it-IT": "Oggi nuovo episodio di Ted Lasso.",
    "en-US": "New episode of Ted Lasso today.",
  });

  const aired = event({ eventType: "new_episode", effectiveAt: new Date(NOW_MS - (2 * 24 * 60 * 60 * 1000)) });
  assert.equal(
    buildTitleUpdateMessageByLocale(aired, "Ted Lasso", NOW_MS)["it-IT"],
    "È disponibile un nuovo episodio di Ted Lasso."
  );
});

// L'incidente: TMDB sposta next_episode_to_air appena il precedente va in onda,
// quindi la notifica partiva ~5 giorni prima dell'episodio, il giorno dopo
// l'uscita di quello che stavi per guardare.
test("un episodio di un giorno futuro aspetta la sua data", () => {
  const future = event({ eventType: "new_episode", effectiveAt: new Date(NOW_MS + (5 * 24 * 60 * 60 * 1000)) });
  assert.equal(titleUpdateWaitsForAirDate(future, NOW_MS), true);
  assert.equal(shouldFanOutTitleUpdate(null, future, NOW_MS), false);

  const today = event({ eventType: "new_episode", effectiveAt: new Date(NOW_MS + (2 * 60 * 60 * 1000)) });
  assert.equal(titleUpdateWaitsForAirDate(today, NOW_MS), false);
  assert.equal(shouldFanOutTitleUpdate(null, today, NOW_MS), true);

  // Un trailer parla di adesso: la sua data non rimanda niente.
  const trailer = event({ effectiveAt: new Date(NOW_MS + (5 * 24 * 60 * 60 * 1000)) });
  assert.equal(titleUpdateWaitsForAirDate(trailer, NOW_MS), false);
  assert.equal(shouldFanOutTitleUpdate(null, trailer, NOW_MS), true);
});

function makeEventsDb(rows) {
  const written = new Map();
  const query = {
    where: () => query,
    orderBy: () => query,
    limit: () => query,
    get: async () => ({
      docs: rows.map((row) => ({
        id: row.id,
        data: () => row.data,
        ref: { set: async (patch) => written.set(row.id, patch) },
      })),
    }),
  };
  return { written, collection: () => query };
}

test("la sweep notifica gli episodi di oggi e non tocca quelli di domani", async () => {
  const rows = [
    { id: "oggi", data: event({ eventType: "new_episode", effectiveAt: new Date(NOW_MS + (2 * 60 * 60 * 1000)) }) },
    { id: "domani", data: event({ eventType: "new_episode", effectiveAt: new Date(NOW_MS + (30 * 60 * 60 * 1000)) }) },
    { id: "gia_fatto", data: event({
      eventType: "new_episode",
      effectiveAt: new Date(NOW_MS - (60 * 60 * 1000)),
      notifiedAtMs: NOW_MS - 1000,
    }) },
    { id: "backfill", data: event({
      eventType: "new_episode",
      acquisitionMode: "backfill",
      effectiveAt: new Date(NOW_MS - (60 * 60 * 1000)),
    }) },
  ];
  const db = makeEventsDb(rows);
  const seen = [];
  const report = await fanOutDueTitleUpdates({
    db,
    admin,
    nowMs: NOW_MS,
    fanOut: async ({ eventId, before, after, nowMs }) => {
      if (!shouldFanOutTitleUpdate(before, after, nowMs)) return { skipped: true, written: 0 };
      seen.push(eventId);
      return { skipped: false, written: 2 };
    },
  });

  assert.deepEqual(seen, ["oggi"]);
  assert.equal(report.written, 2);
  assert.equal(report.fanned, 1);
  assert.equal(report.skipped, 3);
  assert.deepEqual([...db.written.keys()], ["oggi"]);
  assert.equal(db.written.get("oggi").notifiedAtMs, NOW_MS);
  assert.equal(report.capReached, false);
});

// In prod escono 20-50 eventi new_episode al giorno: se il tetto si riempie,
// qualche episodio di oggi resta fuori e va detto nei log.
test("la sweep dichiara quando il tetto tronca la giornata", async () => {
  const rows = [1, 2].map((n) => ({
    id: `ep${n}`,
    data: event({ eventType: "new_episode", effectiveAt: new Date(NOW_MS + (60 * 60 * 1000)) }),
  }));
  const report = await fanOutDueTitleUpdates({
    db: makeEventsDb(rows),
    admin,
    nowMs: NOW_MS,
    limit: 2,
    fanOut: async () => ({ skipped: false, written: 1 }),
  });
  assert.equal(report.capReached, true);
  assert.equal(report.fanned, 2);
});

test("ID e giorno europeo sono deterministici", () => {
  assert.equal(titleUpdateNotificationId("tmdb_video_tv_97546_abc"), "title_update_tmdb_video_tv_97546_abc");
  assert.throws(() => titleUpdateNotificationId("bad/id"), /eventId/);
  assert.equal(dayKeyForMs(Date.parse("2026-08-02T23:30:00Z")), "20260803");
});

test("writer non duplica e applica il cap giornaliero", async () => {
  const db = makeDb();
  const base = { db, admin, uid: "alice", event: event(), titleName: "Ted Lasso", nowMs: NOW_MS, dailyCap: 2 };
  assert.equal((await writeCappedTitleUpdateNotification({ ...base, eventId: "e1" })).status, "written");
  assert.equal((await writeCappedTitleUpdateNotification({ ...base, eventId: "e1" })).status, "duplicate");
  assert.equal((await writeCappedTitleUpdateNotification({ ...base, eventId: "e2" })).status, "written");
  assert.equal((await writeCappedTitleUpdateNotification({ ...base, eventId: "e3" })).status, "daily_cap");
  assert.equal(db.store.get("users/alice/notifications/title_update_e1").data.messageByLocale["en-US"], "A new trailer for Ted Lasso is out.");
});

test("fanout scrive una volta agli utenti interessati", async () => {
  const db = makeDb([
    // Serie finita: un trailer non è una notizia per lei -> rilevanza bassa.
    stateDoc("alice", { state: "completed_unrated" }),
    stateDoc("bob", { state: "not_started", generalWatchlist: false }),
    stateDoc("carol", { state: "in_progress" }),
    stateDoc("dave", { state: "not_started", generalWatchlist: true }),
  ]);
  const result = await fanOutTitleUpdate({ db, admin, eventId: "e1", before: null, after: event(), nowMs: NOW_MS });
  assert.equal(result.eligible, 2);
  assert.equal(result.written, 2);
  assert.equal(result.lowRelevance, 1);
  assert.equal(db.store.has("users/carol/notifications/title_update_e1"), true);
  assert.equal(db.store.has("users/dave/notifications/title_update_e1"), true);
  assert.equal(db.store.has("users/alice/notifications/title_update_e1"), false);
  assert.equal(db.store.has("users/bob/notifications/title_update_e1"), false);
  const retry = await fanOutTitleUpdate({ db, admin, eventId: "e1", before: null, after: event(), nowMs: NOW_MS });
  assert.equal(retry.duplicates, 2);
  assert.equal(retry.written, 0);
});

test("una nuova stagione raggiunge anche chi la serie l'ha finita", async () => {
  const db = makeDb([
    stateDoc("alice", { state: "completed_unrated" }),
    stateDoc("carol", { state: "in_progress" }),
  ]);
  const after = event({ eventType: "new_episode" });
  const result = await fanOutTitleUpdate({ db, admin, eventId: "s1", before: null, after, nowMs: NOW_MS });
  assert.equal(result.lowRelevance, 0);
  assert.equal(result.written, 2);
  assert.equal(result.highRelevance, 1);
});

test("fanout rispetta follow senza stato, mute e opt-out globale", async () => {
  const db = makeDb([
    stateDoc("alice", { state: "completed_unrated" }),
    stateDoc("carol", { state: "in_progress" }),
  ], [
    preferenceDoc("alice", "muted"),
    preferenceDoc("bob", "follow"),
  ]);
  db.store.set("users/carol/_system/notificationPrefs", { disabledTypes: ["title_update"] });

  const result = await fanOutTitleUpdate({ db, admin, eventId: "e2", before: null, after: event(), nowMs: NOW_MS });
  assert.equal(result.eligible, 1);
  assert.equal(result.globallyDisabled, 1);
  assert.equal(db.store.has("users/alice/notifications/title_update_e2"), false);
  assert.equal(db.store.has("users/bob/notifications/title_update_e2"), true);
  assert.equal(db.store.has("users/carol/notifications/title_update_e2"), false);
});

test("trigger è automatico solo in produzione e conserva il kill switch", () => {
  assert.equal(titleUpdateNotificationsEnabled({}), false);
  assert.equal(titleUpdateNotificationsEnabled({ GCLOUD_PROJECT: "gia-visto" }), true);
  assert.equal(titleUpdateNotificationsEnabled({ GOOGLE_CLOUD_PROJECT: "gia-visto" }), true);
  assert.equal(titleUpdateNotificationsEnabled({ GCLOUD_PROJECT: "torneo-multiplo-staging" }), false);
  assert.equal(titleUpdateNotificationsEnabled({ GCLOUD_PROJECT: "gia-visto", TITLE_UPDATE_NOTIFICATIONS_ENABLED: "false" }), false);
  assert.equal(titleUpdateNotificationsEnabled({ TITLE_UPDATE_NOTIFICATIONS_ENABLED: "false" }), false);
  assert.equal(titleUpdateNotificationsEnabled({ TITLE_UPDATE_NOTIFICATIONS_ENABLED: "TRUE" }), true);
});

test("scanner è automatico solo in produzione e conserva il kill switch", () => {
  assert.equal(titleUpdateScannerEnabled({}), false);
  assert.equal(titleUpdateScannerEnabled({ GCLOUD_PROJECT: "gia-visto" }), true);
  assert.equal(titleUpdateScannerEnabled({ GCLOUD_PROJECT: "torneo-multiplo-staging" }), false);
  assert.equal(titleUpdateScannerEnabled({ GCLOUD_PROJECT: "gia-visto", TITLE_UPDATE_SCANNER_ENABLED: "false" }), false);
  assert.equal(titleUpdateScannerEnabled({ TITLE_UPDATE_SCANNER_ENABLED: "false" }), false);
  assert.equal(titleUpdateScannerEnabled({ TITLE_UPDATE_SCANNER_ENABLED: "TRUE" }), true);
});

test("scanner live prende trailer recenti e uscite vicine, non lo storico", () => {
  const rows = [
    { id: "old", publishedAt: "2026-07-20T10:00:00Z" },
    { id: "new", publishedAt: "2026-08-02T09:00:00Z" },
    { id: "soon", effectiveDate: "2026-09-15" },
    { id: "far", effectiveDate: "2027-01-01" },
  ];
  assert.deepEqual(scheduledCandidateWindow(rows, NOW_MS).map((row) => row.id), ["new", "soon"]);
});

test("primo backfill amplia la finestra ma resta limitato", () => {
  const rows = [
    { id: "too-old", publishedAt: "2026-01-01T10:00:00Z" },
    { id: "old", publishedAt: "2026-04-15T10:00:00Z" },
    { id: "new", publishedAt: "2026-08-02T09:00:00Z" },
    { id: "future", effectiveDate: "2027-06-01" },
    { id: "too-far", effectiveDate: "2027-09-01" },
  ];
  assert.deepEqual(
    backfillCandidateWindow(rows, NOW_MS).map((row) => row.id),
    ["old", "new", "future"]
  );
});

// ---------------------------------------------------------------------------
// Uscita spostata dopo la pubblicazione
//
// Il fanout scattava solo al passaggio a `published`: un film che slittava da
// ottobre a dicembre non lo scopriva nessuno, e chi l'aveva in watchlist
// restava con la data vecchia in testa.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const RESCHEDULE_NOW = Date.parse("2026-08-12T10:00:00.000Z");

function releaseEvent(daysFromNow, overrides = {}) {
  return {
    eventType: "release_date",
    status: "published",
    acquisitionMode: "live",
    notificationEligible: true,
    effectiveAt: new Date(RESCHEDULE_NOW + daysFromNow * DAY),
    ...overrides,
  };
}

test("uno slittamento oltre la settimana rinotifica", () => {
  const before = releaseEvent(30);
  const after = releaseEvent(75);
  assert.equal(shouldFanOutTitleUpdate(before, after, RESCHEDULE_NOW), true);
});

test("un aggiustamento di pochi giorni non sveglia nessuno", () => {
  assert.equal(
    shouldFanOutTitleUpdate(releaseEvent(30), releaseEvent(33), RESCHEDULE_NOW),
    false
  );
});

test("anche un'uscita ANTICIPATA di molto e' una notizia", () => {
  // Il caso opposto e' altrettanto azionabile: il film esce prima.
  assert.equal(
    shouldFanOutTitleUpdate(releaseEvent(60), releaseEvent(10), RESCHEDULE_NOW),
    true
  );
});

test("correggere copy o region su un evento pubblicato non rinotifica", () => {
  const before = releaseEvent(30, { region: "US" });
  const after = releaseEvent(30, { region: "IT" });
  assert.equal(shouldFanOutTitleUpdate(before, after, RESCHEDULE_NOW), false);
});

// Il punto piu' importante: `mergeExistingEvent` spegne notificationEligible su
// tutto cio' che non e' `live`, quindi ogni evento corretto a mano ce l'ha
// false. Se il ramo dello slittamento lo richiedesse, i titoli curati
// editorialmente — gli unici su cui qualcuno ha lavorato — non avviserebbero
// mai di uno spostamento.
test("uno slittamento notifica anche su un evento corretto a mano", () => {
  const before = releaseEvent(30, { acquisitionMode: "manual", notificationEligible: false });
  const after = releaseEvent(75, { acquisitionMode: "manual", notificationEligible: false });
  assert.equal(shouldFanOutTitleUpdate(before, after, RESCHEDULE_NOW), true);
});

test("un'uscita spostata nel passato e' storia, non notizia", () => {
  assert.equal(
    shouldFanOutTitleUpdate(releaseEvent(5), releaseEvent(-20), RESCHEDULE_NOW),
    false
  );
});

test("lo spostamento di un trailer non e' uno slittamento d'uscita", () => {
  const before = releaseEvent(30, { eventType: "trailer" });
  const after = releaseEvent(75, { eventType: "trailer" });
  assert.equal(shouldFanOutTitleUpdate(before, after, RESCHEDULE_NOW), false);
});

test("il backfill resta escluso anche quando la data si sposta", () => {
  const before = releaseEvent(30, { acquisitionMode: "backfill" });
  const after = releaseEvent(75, { acquisitionMode: "backfill" });
  assert.equal(shouldFanOutTitleUpdate(before, after, RESCHEDULE_NOW), false);
});

test("il Timestamp Firestore viene letto come una Date", () => {
  const asTimestamp = (d) => ({ toMillis: () => d.getTime() });
  const before = releaseEvent(30);
  const after = releaseEvent(75);
  before.effectiveAt = asTimestamp(before.effectiveAt);
  after.effectiveAt = asTimestamp(after.effectiveAt);
  assert.equal(shouldFanOutTitleUpdate(before, after, RESCHEDULE_NOW), true);
});
