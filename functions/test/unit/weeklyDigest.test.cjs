const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildDigestMessageByLocale,
  buildWeeklyDigestNotification,
  digestNotificationId,
  digestWeekKey,
  restLine,
  selectDigestItems,
} = require("../../lib/weeklyDigest");

const NOW = Date.parse("2026-08-25T10:00:00Z");
const ts = (iso) => ({ toMillis: () => Date.parse(iso) });

const adminMock = {
  firestore: {
    FieldValue: { serverTimestamp: () => "SERVER_TIMESTAMP" },
    Timestamp: { fromMillis: (ms) => ({ ms }) },
  },
};

function event(id, overrides = {}) {
  return {
    id,
    titleName: overrides.titleName || "Reacher",
    data: {
      titleId: overrides.titleId || "reacher",
      eventType: overrides.eventType || "new_season",
      mediaType: overrides.mediaType || "tv",
      effectiveAt: overrides.effectiveAt || ts("2026-08-27T12:00:00Z"),
      ...overrides.data,
    },
  };
}

const inProgress = { state: "in_progress" };

test("nel digest entra solo quello che hai in libreria o watchlist", () => {
  const items = selectDigestItems({
    events: [event("e1"), event("e2", { titleId: "sconosciuto" })],
    statesByTitleId: { reacher: inProgress },
    nowMs: NOW,
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].titleId, "reacher");
});

test("quello che la sweep giornaliera ha gia' mandato non si ripete", () => {
  const items = selectDigestItems({
    events: [event("e1")],
    statesByTitleId: { reacher: inProgress },
    notifiedEventIds: ["e1"],
    nowMs: NOW,
  });
  assert.deepEqual(items, []);
});

test("un titolo silenziato resta silenziato anche nel digest", () => {
  const items = selectDigestItems({
    events: [event("e1")],
    statesByTitleId: { reacher: inProgress },
    prefsByTitleId: { reacher: { mode: "muted" } },
    nowMs: NOW,
  });
  assert.deepEqual(items, []);
});

test("le novita' deboli non entrano", () => {
  // Trailer di un titolo gia' visto: rilevanza "low", resta nella timeline.
  const items = selectDigestItems({
    events: [event("e1", { eventType: "trailer" })],
    statesByTitleId: { reacher: { state: "rated" } },
    nowMs: NOW,
  });
  assert.deepEqual(items, []);
});

test("prima le novita' forti, poi quelle piu' vicine nel tempo", () => {
  const items = selectDigestItems({
    events: [
      event("lontano", { titleId: "t1", titleName: "Uno", effectiveAt: ts("2026-09-20T12:00:00Z") }),
      event("vicino", { titleId: "t2", titleName: "Due", effectiveAt: ts("2026-08-26T12:00:00Z") }),
      event("debole", { titleId: "t3", titleName: "Tre", eventType: "release_date", effectiveAt: ts("2026-08-25T12:00:00Z") }),
    ],
    statesByTitleId: {
      t1: inProgress,
      t2: inProgress,
      t3: { generalWatchlist: true },
    },
    nowMs: NOW,
  });
  assert.deepEqual(items.map((i) => i.eventId), ["vicino", "lontano", "debole"]);
});

test("un titolo occupa una riga sola", () => {
  const items = selectDigestItems({
    events: [
      event("a", { effectiveAt: ts("2026-08-26T12:00:00Z") }),
      event("b", { effectiveAt: ts("2026-08-28T12:00:00Z") }),
      event("c", { titleId: "altro", titleName: "Slow Horses", effectiveAt: ts("2026-08-29T12:00:00Z") }),
    ],
    statesByTitleId: { reacher: inProgress, altro: inProgress },
    nowMs: NOW,
  });
  assert.deepEqual(items.map((i) => i.titleId), ["reacher", "altro"]);
});

test("il tetto e' rispettato", () => {
  const events = Array.from({ length: 8 }, (_, i) =>
    event(`e${i}`, { titleId: `t${i}`, titleName: `Titolo ${i}` }));
  const states = {};
  events.forEach((e) => { states[e.data.titleId] = inProgress; });
  assert.equal(selectDigestItems({ events, statesByTitleId: states, nowMs: NOW }).length, 3);
  assert.equal(selectDigestItems({ events, statesByTitleId: states, nowMs: NOW, limit: 1 }).length, 1);
});

test("il testo dice la novita' piu' forte e quante altre ce ne sono", () => {
  const uno = buildDigestMessageByLocale([
    { messageByLocale: { "it-IT": "Nuovo episodio di Reacher il 27 agosto.", "en-US": "New episode of Reacher on August 27." } },
  ]);
  assert.equal(uno["it-IT"], "Nuovo episodio di Reacher il 27 agosto.");

  const tre = buildDigestMessageByLocale([
    { messageByLocale: { "it-IT": "Nuovo episodio di Reacher il 27 agosto.", "en-US": "New episode of Reacher on August 27." } },
    { messageByLocale: { "it-IT": "x", "en-US": "x" } },
    { messageByLocale: { "it-IT": "y", "en-US": "y" } },
  ]);
  assert.match(tre["it-IT"], /E altre 2 novità sui tuoi titoli\.$/);
  assert.match(tre["en-US"], /Plus 2 more updates on your titles\.$/);

  // "E altre 1 novità" e' quello che usciva davvero dal primo dry-run.
  const due = buildDigestMessageByLocale([
    { messageByLocale: { "it-IT": "Nuovo episodio di Silo il 27 agosto.", "en-US": "New episode of Silo on August 27." } },
    { messageByLocale: { "it-IT": "x", "en-US": "x" } },
  ]);
  assert.match(due["it-IT"], /E un'altra novità sui tuoi titoli\.$/);
  assert.match(due["en-US"], /Plus one more update on your titles\.$/);
});

test("la settimana ISO da' un id stabile e non duplica", () => {
  const lunedi = digestWeekKey(Date.parse("2026-08-24T06:00:00Z"));
  const giovedi = digestWeekKey(Date.parse("2026-08-27T22:00:00Z"));
  const settimanaDopo = digestWeekKey(Date.parse("2026-08-31T06:00:00Z"));
  assert.equal(lunedi, giovedi);
  assert.notEqual(lunedi, settimanaDopo);
  assert.match(digestNotificationId(lunedi), /^weekly_digest_\d{4}-W\d{2}$/);
  assert.throws(() => digestNotificationId("../altro"));
});

test("la notifica porta la lista quando le novita' sono piu' di una", () => {
  const items = selectDigestItems({
    events: [
      event("a", { effectiveAt: ts("2026-08-26T12:00:00Z") }),
      event("b", { titleId: "altro", titleName: "Slow Horses", effectiveAt: ts("2026-08-28T12:00:00Z") }),
    ],
    statesByTitleId: { reacher: inProgress, altro: inProgress },
    nowMs: NOW,
  });
  const notif = buildWeeklyDigestNotification({
    admin: adminMock, uid: "alice", items, weekKey: "2026-W35", nowMs: NOW,
  });
  assert.equal(notif.type, "weekly_digest");
  assert.equal(notif.toUid, "alice");
  assert.equal(notif.data.count, 2);
  // Anche con piu' novita' si atterra sul titolo nominato nel testo: la lista
  // notifiche non ha destinazione nativa su iOS e il tap girava in tondo.
  assert.match(notif.data.ctaUrl, /^\/title\.html\?id=reacher/);
  assert.equal(notif.data.items.length, 2);
  assert.equal(notif.read, false);
  // I client vecchi leggono `message`: senza, in campanella esce "Nuova attività".
  assert.equal(notif.data.message, notif.data.messageByLocale["it-IT"]);
  // La seconda riga NOMINA la novita' rimasta, non la conta: e' l'unico modo
  // di scoprirla senza aggiornare l'app.
  assert.match(notif.data.preview, /Slow Horses/);
  assert.equal(notif.data.preview.includes("Reacher"), false);
});

test("con una novita' sola la seconda riga resta vuota", () => {
  const items = selectDigestItems({
    events: [event("a")],
    statesByTitleId: { reacher: inProgress },
    nowMs: NOW,
  });
  const notif = buildWeeklyDigestNotification({
    admin: adminMock, uid: "alice", items, weekKey: "2026-W35", nowMs: NOW,
  });
  assert.equal(notif.data.preview, "");
});

test("le altre novita' si leggono in fila, separate", () => {
  assert.equal(restLine([
    { messageByLocale: { "it-IT": "prima" } },
    { messageByLocale: { "it-IT": "seconda" } },
    { messageByLocale: { "it-IT": "terza" } },
  ]), "seconda · terza");
  assert.equal(restLine([{ messageByLocale: { "it-IT": "sola" } }]), "");
  assert.equal(restLine([]), "");
});

test("con una novita' sola la notifica porta dritta al titolo", () => {
  const items = selectDigestItems({
    events: [event("a")],
    statesByTitleId: { reacher: inProgress },
    nowMs: NOW,
  });
  const notif = buildWeeklyDigestNotification({
    admin: adminMock, uid: "alice", items, weekKey: "2026-W35", nowMs: NOW,
  });
  assert.match(notif.data.ctaUrl, /^\/title\.html\?id=reacher/);
});

test("un digest vuoto non si manda", () => {
  assert.throws(
    () => buildWeeklyDigestNotification({ admin: adminMock, uid: "alice", items: [], weekKey: "2026-W35" }),
    /senza novità/
  );
});
