const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeOfficialUpdateInput,
  normalizeScheduledAtMs,
  titleStateLooksInterested,
  collectInterestedUserUids,
  draftToPublishInput,
  publishDueOfficialUpdates,
} = require("../../lib/officialUpdates");

test("normalizeOfficialUpdateInput builds stable post id and clamps arrays", () => {
  const input = normalizeOfficialUpdateInput({
    title: "Stranger Things 5: data ufficiale!",
    text: "Arriva il finale.",
    updateType: "release_date",
    linkedTitleIds: [" stranger-things-2016 ", "stranger-things-2016", "x"],
    sourceUrls: ["https://example.com/news", "ftp://invalid.local/file"],
  });

  assert.equal(input.slug, "stranger-things-5-data-ufficiale");
  assert.equal(input.postId, "official_stranger-things-5-data-ufficiale");
  assert.equal(input.updateType, "release_date");
  assert.deepEqual(input.linkedTitleIds, ["stranger-things-2016", "x"]);
  assert.deepEqual(input.sourceUrls, ["https://example.com/news"]);
});

test("normalizeScheduledAtMs accetta ISO/epoch/Date e scarta il resto", () => {
  const iso = "2026-07-29T10:00:00.000Z";
  assert.equal(normalizeScheduledAtMs(iso), Date.parse(iso));
  assert.equal(normalizeScheduledAtMs(Date.parse(iso)), Date.parse(iso));
  assert.equal(normalizeScheduledAtMs(new Date(iso)), Date.parse(iso));
  assert.equal(normalizeScheduledAtMs({ toMillis: () => 1234 }), 1234);
  assert.equal(normalizeScheduledAtMs({ _seconds: 2 }), 2000);
  // Una data illeggibile non deve mai diventare "pubblica subito".
  assert.equal(normalizeScheduledAtMs("domani mattina"), null);
  assert.equal(normalizeScheduledAtMs(""), null);
  assert.equal(normalizeScheduledAtMs(undefined), null);
  assert.equal(normalizeScheduledAtMs(0), null);
});

test("normalizeMediaUrl accetta solo https su host noti", () => {
  const { normalizeMediaUrl } = require("../../lib/officialUpdates");
  const ok = "https://firebasestorage.googleapis.com/v0/b/gia-visto.firebasestorage.app/o/editorial%2Fx.png?alt=media&token=abc";
  assert.equal(normalizeMediaUrl(ok), ok);
  assert.equal(normalizeMediaUrl("https://somto.it/og/x.png"), "https://somto.it/og/x.png");
  // Host arbitrario in un post ufficiale = tracking pixel firmato Somto.
  assert.equal(normalizeMediaUrl("https://evil.example/x.png"), "");
  assert.equal(normalizeMediaUrl("http://somto.it/x.png"), "");
  assert.equal(normalizeMediaUrl(""), "");
});

test("normalizeOfficialUpdateInput tiene scheduledAt solo sulle bozze", () => {
  const base = {
    title: "Serie editoriale",
    text: "Testo",
    linkedTitleIds: ["t1"],
    scheduledAt: "2026-07-29T10:00:00.000Z",
  };

  const draft = normalizeOfficialUpdateInput({ ...base, status: "draft" });
  assert.equal(draft.scheduledAtMs, Date.parse("2026-07-29T10:00:00.000Z"));

  const published = normalizeOfficialUpdateInput({ ...base, status: "published" });
  assert.equal(published.scheduledAtMs, null);
});

test("normalizeOfficialUpdateInput conserva il collegamento evento e permette il fanout senza seconda notifica", () => {
  const input = normalizeOfficialUpdateInput({
    title: "Dune: dal 22 agosto",
    text: "Dune arriva al cinema dal 22 agosto.",
    linkedTitleIds: ["dune-3"],
    notificationsEnabled: false,
    sourceEventId: "tmdb_release_movie_1",
    sourceEffectiveAt: "2026-08-22T12:00:00.000Z",
  });

  assert.equal(input.notificationsEnabled, false);
  assert.equal(input.sourceEventId, "tmdb_release_movie_1");
  assert.equal(input.sourceEffectiveAtMs, Date.parse("2026-08-22T12:00:00.000Z"));
});

test("draftToPublishInput ricostruisce il payload dalla bozza salvata", () => {
  const input = draftToPublishInput("serie-1", {
    title: "T",
    text: "Body",
    summary: "S",
    updateType: "announcement",
    linkedTitleIds: ["a", "b"],
    sourceUrls: ["https://somto.it/blog/x/"],
    audienceUids: ["u1"],
    status: "draft",
  });

  assert.equal(input.slug, "serie-1");
  assert.equal(input.status, "published");
  assert.deepEqual(input.linkedTitleIds, ["a", "b"]);
  assert.deepEqual(input.sourceUrls, ["https://somto.it/blog/x/"]);
  assert.deepEqual(input.audienceUids, ["u1"]);
});

function makeSchedulerDb(drafts) {
  const store = new Map(drafts.map((row) => [row.id, { ...row.data }]));
  const refs = new Map();

  function refFor(slug) {
    if (!refs.has(slug)) {
      refs.set(slug, {
        id: slug,
        async set(data, opts) {
          store.set(slug, opts?.merge ? { ...(store.get(slug) || {}), ...data } : { ...data });
        },
      });
    }
    return refs.get(slug);
  }

  const db = {
    store,
    collection(name) {
      assert.equal(name, "officialUpdates");
      const query = {
        where: () => query,
        orderBy: () => query,
        limit: () => query,
        async get() {
          const docs = [...store.entries()]
            .filter(([, data]) => data.status === "draft" && data.scheduledAt)
            .map(([id, data]) => ({ id, data: () => data }));
          return { size: docs.length, docs };
        },
      };
      return { ...query, doc: (slug) => refFor(slug) };
    },
    async runTransaction(fn) {
      return fn({
        async get(ref) {
          const data = store.get(ref.id);
          return { exists: !!data, data: () => data };
        },
        set(ref, data, opts) {
          store.set(ref.id, opts?.merge ? { ...(store.get(ref.id) || {}), ...data } : { ...data });
        },
      });
    },
  };
  return db;
}

const schedulerAdminMock = {
  firestore: {
    FieldValue: { serverTimestamp: () => "TS" },
    Timestamp: { fromMillis: (ms) => ({ ms, toMillis: () => ms }) },
  },
};

test("publishDueOfficialUpdates pubblica le bozze scadute una sola volta", async () => {
  const nowMs = Date.parse("2026-07-29T10:05:00.000Z");
  const db = makeSchedulerDb([
    {
      id: "film-che-fanno-riflettere",
      data: {
        status: "draft",
        title: "Film che fanno riflettere",
        text: "Testo del post",
        linkedTitleIds: ["tmdb_movie_37165"],
        scheduledAt: { toMillis: () => nowMs - 60000 },
      },
    },
  ]);

  const calls = [];
  const results = await publishDueOfficialUpdates({
    db,
    admin: schedulerAdminMock,
    nowMs,
    publish: async ({ input }) => {
      calls.push(input);
      // Il publish reale porta il registro a "published": simulalo.
      db.store.set(input.slug, { ...(db.store.get(input.slug) || {}), status: "published" });
      return { recipientCount: 42 };
    },
  });

  assert.equal(results.checked, 1);
  assert.deepEqual(results.published, [{ slug: "film-che-fanno-riflettere", recipientCount: 42 }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].status, "published");

  // Secondo giro: la bozza e' ormai published, niente doppia pubblicazione.
  const second = await publishDueOfficialUpdates({
    db,
    admin: schedulerAdminMock,
    nowMs: nowMs + 60000,
    publish: async () => {
      throw new Error("non deve essere richiamata");
    },
  });
  assert.equal(second.checked, 0);
});

test("publishDueOfficialUpdates salta le bozze appena reclamate da un altro run", async () => {
  const nowMs = Date.parse("2026-07-29T10:05:00.000Z");
  const db = makeSchedulerDb([
    {
      id: "gia-in-corso",
      data: {
        status: "draft",
        title: "T",
        text: "Body",
        linkedTitleIds: ["x"],
        scheduledAt: { toMillis: () => nowMs - 60000 },
        scheduleClaimedAt: { toMillis: () => nowMs - 1000 },
      },
    },
  ]);

  const results = await publishDueOfficialUpdates({
    db,
    admin: schedulerAdminMock,
    nowMs,
    publish: async () => {
      throw new Error("non deve essere richiamata");
    },
  });

  assert.deepEqual(results.skipped, ["gia-in-corso"]);
  assert.deepEqual(results.published, []);
});

test("publishDueOfficialUpdates lascia la bozza riprovabile se il publish fallisce", async () => {
  const nowMs = Date.parse("2026-07-29T10:05:00.000Z");
  const db = makeSchedulerDb([
    {
      id: "rotta",
      data: {
        status: "draft",
        title: "T",
        text: "Body",
        linkedTitleIds: ["x"],
        scheduledAt: { toMillis: () => nowMs - 60000 },
      },
    },
  ]);

  const results = await publishDueOfficialUpdates({
    db,
    admin: schedulerAdminMock,
    nowMs,
    publish: async () => {
      throw new Error("fan-out KO");
    },
  });

  assert.equal(results.failed.length, 1);
  assert.match(results.failed[0].error, /fan-out KO/);
  const saved = db.store.get("rotta");
  assert.equal(saved.status, "draft");
  assert.match(saved.lastScheduleError, /fan-out KO/);
});

test("publishOfficialUpdate su bozza non scansiona titleStates", async () => {
  const { publishOfficialUpdate } = require("../../lib/officialUpdates");
  const written = [];
  const db = {
    collectionGroup() {
      throw new Error("una bozza non deve calcolare l'audience");
    },
    collection: (name) => ({
      doc: (id) => ({
        async set(data, opts) { written.push({ path: `${name}/${id}`, data, opts }); },
      }),
    }),
  };

  const result = await publishOfficialUpdate({
    db,
    admin: schedulerAdminMock,
    requestedByUid: "admin1",
    input: {
      title: "Serie editoriale",
      text: "Testo",
      status: "draft",
      scheduledAt: "2026-07-29T10:00:00+02:00",
      linkedTitleIds: ["tmdb_movie_13"],
    },
  });

  assert.equal(result.status, "draft");
  assert.equal(result.recipientCount, 0);
  const registry = written.find((w) => w.path.startsWith("officialUpdates/"));
  assert.ok(registry, "registro scritto");
  assert.equal(registry.data.scheduledAt.ms, Date.parse("2026-07-29T10:00:00+02:00"));
});

test("titleStateLooksInterested rejects empty removed states", () => {
  assert.equal(titleStateLooksInterested({ state: "removed" }), false);
  assert.equal(titleStateLooksInterested({ state: "none" }), false);
  assert.equal(titleStateLooksInterested({ state: "in_progress" }), true);
  assert.equal(titleStateLooksInterested({ generalWatchlist: true }), true);
});

test("collectInterestedUserUids dedupes users from titleStates collection group", async () => {
  const docs = [
    {
      data: () => ({ titleId: "t1", state: "in_progress" }),
      ref: { parent: { parent: { id: "alice" } } },
    },
    {
      data: () => ({ titleId: "t1", state: "removed" }),
      ref: { parent: { parent: { id: "bob" } } },
    },
    {
      data: () => ({ titleId: "t2", generalWatchlist: true }),
      ref: { parent: { parent: { id: "alice" } } },
    },
    {
      data: () => ({ titleId: "t2", state: "rated" }),
      ref: { parent: { parent: { id: "carla" } } },
    },
  ];
  const db = {
    collectionGroup(name) {
      assert.equal(name, "titleStates");
      return {
        where(field, op, values) {
          assert.equal(field, "titleId");
          assert.equal(op, "in");
          return {
            limit() {
              return {
                async get() {
                  return { docs: docs.filter((row) => values.includes(row.data().titleId)) };
                },
              };
            },
          };
        },
      };
    },
  };

  const uids = await collectInterestedUserUids(db, ["t1", "t2"]);
  assert.deepEqual(uids.sort(), ["alice", "carla"]);
});

test("unpublishOfficialUpdate ritira post, feedEvents e notifiche", async () => {
  const { unpublishOfficialUpdate } = require("../../lib/officialUpdates");

  const store = new Map();
  store.set("officialUpdates/su", { postId: "official_su", status: "published" });
  store.set("posts/official_su", { authorUid: "somto_official" });
  const feedDocs = [
    { data: () => ({ ownerUid: "alice", eventKey: "official_update:su" }) },
    { data: () => ({ ownerUid: "bob", eventKey: "official_update:su" }) },
  ];
  const deletedPaths = [];
  const setCalls = [];

  function docRef(path) {
    return {
      path,
      async get() {
        return { exists: store.has(path), data: () => store.get(path) };
      },
      async set(data, opts) {
        setCalls.push({ path, data, opts });
        store.set(path, { ...(store.get(path) || {}), ...data });
      },
      async delete() {
        deletedPaths.push(path);
        store.delete(path);
      },
      collection(sub) {
        return collectionRef(`${path}/${sub}`);
      },
    };
  }

  function collectionRef(name) {
    return {
      doc(id) {
        return docRef(`${name}/${id}`);
      },
      where(field, op, value) {
        assert.equal(name, "feedEvents");
        assert.equal(field, "eventKey");
        assert.equal(op, "==");
        assert.equal(value, "official_update:su");
        return { async get() { return { docs: feedDocs }; } };
      },
    };
  }

  const db = {
    collection: (name) => collectionRef(name),
    batch() {
      const ops = [];
      return {
        delete(ref) { ops.push(ref); },
        set(ref, data, opts) { ops.push({ ref, data, opts }); },
        async commit() {
          for (const op of ops) {
            if (op.path) deletedPaths.push(op.path);
            else if (op.ref?.path) deletedPaths.push(op.ref.path);
          }
        },
      };
    },
  };

  const adminMock = {
    firestore: {
      FieldValue: { serverTimestamp: () => "TS" },
      Timestamp: { fromMillis: (ms) => ({ ms }) },
    },
  };

  const result = await unpublishOfficialUpdate({
    db,
    admin: adminMock,
    slug: "su",
    requestedByUid: "admin1",
  });

  assert.equal(result.status, "retired");
  assert.equal(result.postId, "official_su");
  assert.equal(result.feedEventsDeleted, 2);
  assert.equal(result.notificationsDeleted, 2);

  // Post cancellato
  assert.ok(deletedPaths.includes("posts/official_su"));
  // Notifiche deterministiche cancellate per entrambi i destinatari
  assert.ok(deletedPaths.includes("users/alice/notifications/official_update_su"));
  assert.ok(deletedPaths.includes("users/bob/notifications/official_update_su"));
  // 2 feedEvents cancellati (id deterministici da owner+eventKey)
  assert.equal(deletedPaths.filter((p) => p.startsWith("feedEvents/")).length, 2);
  // Registro marcato retired
  const reg = store.get("officialUpdates/su");
  assert.equal(reg.status, "retired");
  assert.equal(reg.retiredByUid, "admin1");
});

test("unpublishOfficialUpdate rifiuta slug invalido o mancante", async () => {
  const { unpublishOfficialUpdate } = require("../../lib/officialUpdates");
  const adminMock = { firestore: { FieldValue: { serverTimestamp: () => "TS" } } };

  await assert.rejects(
    () => unpublishOfficialUpdate({ db: { collection() { throw new Error("no"); }, batch() {} }, admin: adminMock, slug: "" }),
    /slug non valido/
  );

  const dbMissing = {
    collection: () => ({
      doc: () => ({ async get() { return { exists: false, data: () => undefined }; } }),
    }),
    batch() {},
  };
  await assert.rejects(
    () => unpublishOfficialUpdate({ db: dbMissing, admin: adminMock, slug: "ghost" }),
    /non trovato/
  );
});

// Il post su Ted Lasso 4 e' uscito il 13 agosto con voce da annuncio, ma la
// stagione era partita il 4: la notifica ripete il sommario, quindi chi la
// riceve legge un annuncio vecchio di nove giorni.
test("officialUpdateStaleness avvisa quando la stagione e' gia' partita", () => {
  const { officialUpdateStaleness, latestSeasonPremiereMs } = require("../../lib/officialUpdates");
  const tedLasso = {
    name: "Ted Lasso",
    meta: {
      seasons: [
        { season: 3, episodes: 12, air_date: "2023-03-14" },
        { season: 4, episodes: 10, air_date: "2026-08-04" },
      ],
    },
  };
  const nowMs = Date.parse("2026-08-13T10:00:00.000Z");

  assert.equal(latestSeasonPremiereMs(tedLasso), Date.parse("2026-08-04T12:00:00.000Z"));

  const stale = officialUpdateStaleness({ updateType: "new_season", titleData: tedLasso, nowMs });
  assert.equal(stale.code, "season_already_started");
  assert.equal(stale.daysLate, 9);
  assert.match(stale.message, /4 agosto/);
  assert.match(stale.message, /Hai iniziato Ted Lasso\?/);

  // Il giorno dopo la partenza e' ancora notizia: nessun avviso.
  assert.equal(
    officialUpdateStaleness({
      updateType: "new_season",
      titleData: tedLasso,
      nowMs: Date.parse("2026-08-05T10:00:00.000Z"),
    }),
    null
  );
  // Una stagione che deve ancora partire non e' in ritardo.
  assert.equal(
    officialUpdateStaleness({
      updateType: "new_season",
      titleData: tedLasso,
      nowMs: Date.parse("2026-07-20T10:00:00.000Z"),
    }),
    null
  );
  // Solo new_season: per gli altri tipi la data di riferimento non sta sul titolo.
  assert.equal(officialUpdateStaleness({ updateType: "trailer", titleData: tedLasso, nowMs }), null);
  assert.equal(officialUpdateStaleness({ updateType: "new_season", titleData: {}, nowMs }), null);
});

test("collectOfficialUpdateWarnings legge il titolo collegato e non blocca sugli errori", async () => {
  const { collectOfficialUpdateWarnings } = require("../../lib/officialUpdates");
  const titleData = { name: "Ted Lasso", meta: { seasons: [{ season: 4, air_date: "2026-08-04" }] } };
  const db = {
    collection: () => ({
      doc: () => ({ async get() { return { exists: true, data: () => titleData }; } }),
    }),
  };
  const nowMs = Date.parse("2026-08-13T10:00:00.000Z");

  const warnings = await collectOfficialUpdateWarnings({
    db,
    input: { updateType: "new_season", linkedTitleIds: ["ted-lasso"] },
    nowMs,
  });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "season_already_started");

  const brokenDb = { collection: () => ({ doc: () => ({ async get() { throw new Error("offline"); } }) }) };
  assert.deepEqual(
    await collectOfficialUpdateWarnings({
      db: brokenDb,
      input: { updateType: "new_season", linkedTitleIds: ["ted-lasso"] },
      nowMs,
    }),
    []
  );
});
