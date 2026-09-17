const test = require("node:test");
const assert = require("node:assert/strict");
const {
  LINKED_TITLE_IDS_MAX,
  managedDocumentsEqual,
  mergeExistingEvent,
  normalizeLinkedTitleIds,
  resolveLinkedTitleIds,
  writeTitleUpdateEvent,
  writeTitleUpdateEvents,
} = require("../../lib/titleUpdateEvents");

const NOW = new Date("2026-08-02T10:00:00.000Z");

function trailer(overrides = {}) {
  return {
    id: "tmdb_video_tv_97546_abc",
    titleId: "ted-lasso",
    tmdbId: 97546,
    mediaType: "tv",
    eventType: "trailer",
    source: "tmdb",
    sourceId: "abc",
    sourceUrl: "https://www.youtube.com/watch?v=abc",
    publishedAt: "2026-08-01T10:00:00.000Z",
    headlineByLocale: { "it-IT": "Trailer ufficiale", "en-US": "Official Trailer" },
    official: true,
    confidence: 1,
    autoPublishEligible: true,
    ...overrides,
  };
}

function makeDb(initial = {}) {
  const store = new Map(Object.entries(initial));
  const writes = [];
  return {
    store,
    writes,
    collection(name) {
      assert.equal(name, "titleUpdateEvents");
      return { doc: (id) => ({ id }) };
    },
    async runTransaction(fn) {
      return fn({
        async get(ref) {
          const data = store.get(ref.id);
          return { exists: Boolean(data), data: () => data };
        },
        set(ref, data, options) {
          writes.push({ id: ref.id, data, options });
          store.set(ref.id, options?.merge ? { ...(store.get(ref.id) || {}), ...data } : data);
        },
      });
    },
  };
}

test("crea evento backfill pubblicato ma non notificabile", async () => {
  const db = makeDb();
  const result = await writeTitleUpdateEvent({
    db,
    candidate: trailer(),
    acquisitionMode: "backfill",
    publishEligible: true,
    now: NOW,
  });

  assert.equal(result.created, true);
  assert.equal(result.notificationEligible, false);
  assert.equal(db.writes.length, 1);
  assert.equal(db.store.get(trailer().id).status, "published");
  assert.equal(db.store.get(trailer().id).acquisitionMode, "backfill");
});

test("seconda importazione identica è idempotente", async () => {
  const db = makeDb();
  await writeTitleUpdateEvent({ db, candidate: trailer(), acquisitionMode: "backfill", publishEligible: true, now: NOW });
  const second = await writeTitleUpdateEvent({ db, candidate: trailer(), acquisitionMode: "backfill", publishEligible: true, now: NOW });

  assert.equal(second.updated, false);
  assert.equal(db.writes.length, 1);
});

test("evento nato da backfill non diventa notificabile in una run live", async () => {
  const db = makeDb();
  await writeTitleUpdateEvent({ db, candidate: trailer(), acquisitionMode: "backfill", publishEligible: true, now: NOW });
  const later = await writeTitleUpdateEvent({
    db,
    candidate: trailer({ headlineByLocale: { "it-IT": "Trailer aggiornato", "en-US": "Updated trailer" } }),
    acquisitionMode: "live",
    publishEligible: true,
    now: new Date("2026-08-03T10:00:00Z"),
  });

  assert.equal(later.updated, true);
  assert.equal(later.notificationEligible, false);
  assert.equal(db.store.get(trailer().id).acquisitionMode, "backfill");
});

test("evento retired non viene ripubblicato dallo scanner", async () => {
  const original = (await writeTitleUpdateEvent({
    db: makeDb(), candidate: trailer(), acquisitionMode: "live", publishEligible: true, now: NOW, dryRun: true,
  })).document;
  const db = makeDb({ [trailer().id]: { ...original, status: "retired", notificationEligible: false } });
  const result = await writeTitleUpdateEvent({ db, candidate: trailer(), acquisitionMode: "live", publishEligible: true, now: NOW });

  assert.equal(result.status, "retired");
  assert.equal(result.notificationEligible, false);
  assert.equal(db.store.get(trailer().id).status, "retired");
});

test("draft live può diventare published quando la fonte diventa ufficiale", async () => {
  const db = makeDb();
  await writeTitleUpdateEvent({
    db,
    candidate: trailer({ official: false, confidence: 0.7, autoPublishEligible: false }),
    acquisitionMode: "live",
    publishEligible: true,
    now: NOW,
  });
  const published = await writeTitleUpdateEvent({
    db,
    candidate: trailer(),
    acquisitionMode: "live",
    publishEligible: true,
    now: new Date("2026-08-03T10:00:00Z"),
  });

  assert.equal(published.status, "published");
  assert.equal(published.notificationEligible, true);
  assert.equal(db.store.get(trailer().id).firstPublishedAt.toISOString(), "2026-08-03T10:00:00.000Z");
  assert.equal(db.store.get(trailer().id).reviewReason, null);
});

test("evento published non regredisce a draft né riattiva il fanout", async () => {
  const original = (await writeTitleUpdateEvent({
    db: makeDb(), candidate: trailer(), acquisitionMode: "live", publishEligible: true, now: NOW, dryRun: true,
  })).document;
  const db = makeDb({
    [trailer().id]: { ...original, notificationEligible: false, reviewReason: "old_review" },
  });
  const result = await writeTitleUpdateEvent({
    db,
    candidate: trailer({ official: false, confidence: 0.7, autoPublishEligible: false }),
    acquisitionMode: "live",
    publishEligible: true,
    now: new Date("2026-08-04T10:00:00Z"),
  });

  assert.equal(result.status, "published");
  assert.equal(result.notificationEligible, false);
  assert.equal(db.store.get(trailer().id).reviewReason, null);
});

test("bulk deduplica, applica cap e isola candidati invalidi", async () => {
  const db = makeDb();
  const report = await writeTitleUpdateEvents({
    db,
    candidates: [trailer(), trailer(), trailer({ id: "bad", eventType: "rumor" }), trailer({ id: "second", sourceId: "second" })],
    acquisitionMode: "backfill",
    publishEligible: true,
    now: NOW,
    maxEvents: 3,
  });

  assert.equal(report.requested, 4);
  assert.equal(report.unique, 3);
  assert.equal(report.created, 2);
  assert.equal(report.errors.length, 1);
});

test("merge preserva retire, discoveredAt e acquisitionMode", () => {
  const discoveredAt = new Date("2026-07-01T00:00:00Z");
  const merged = mergeExistingEvent(
    { status: "retired", acquisitionMode: "backfill", discoveredAt, notificationEligible: false },
    { status: "published", acquisitionMode: "live", discoveredAt: NOW, updatedAt: NOW, notificationEligible: true },
    NOW
  );
  assert.equal(merged.status, "retired");
  assert.equal(merged.acquisitionMode, "backfill");
  assert.equal(merged.discoveredAt, discoveredAt);
  assert.equal(merged.notificationEligible, false);
});

// ---------------------------------------------------------------------------
// Blocchi editoriali
//
// Contesto: l'id di un evento release_date e' `tmdb_release_movie_<tmdbId>` —
// la data NON entra nell'id. C'e' un documento solo per titolo, e lo scanner
// ripassa su ogni titolo ogni ~2,5 giorni riscrivendo `effectiveAt` col valore
// TMDB. Senza questi blocchi una correzione a mano durerebbe due giorni.
// ---------------------------------------------------------------------------

const LOCKED_DATE = new Date("2026-10-08T12:00:00.000Z");
const TMDB_DATE = new Date("2026-11-20T12:00:00.000Z");

function lockedExisting(overrides = {}) {
  return {
    status: "published",
    acquisitionMode: "live",
    notificationEligible: true,
    // Un doc gia' pubblicato ce l'ha sempre; senza, il merge lo riscrive a
    // `now` a ogni passata e nessuna scansione risulterebbe mai "invariata".
    firstPublishedAt: new Date("2026-08-10T10:00:00.000Z"),
    effectiveAt: LOCKED_DATE,
    sortAt: LOCKED_DATE,
    editorial: {
      lockedFields: ["effectiveAt", "sortAt"],
      editedBy: "admin-uid",
      editedAt: new Date("2026-08-12T09:00:00.000Z"),
      note: null,
      sourceConflict: null,
    },
    ...overrides,
  };
}

function scannerDoc(date = TMDB_DATE, overrides = {}) {
  return {
    status: "published",
    acquisitionMode: "live",
    notificationEligible: true,
    effectiveAt: date,
    sortAt: date,
    region: "IT",
    ...overrides,
  };
}

test("un campo bloccato non viene sovrascritto dallo scanner", () => {
  const next = mergeExistingEvent(lockedExisting(), scannerDoc(), NOW);

  assert.deepEqual(next.effectiveAt, LOCKED_DATE);
  assert.deepEqual(next.sortAt, LOCKED_DATE);
});

test("il disaccordo con la fonte viene registrato, non soppresso", () => {
  const next = mergeExistingEvent(lockedExisting(), scannerDoc(), NOW);

  assert.equal(next.editorial.sourceConflict.field, "effectiveAt");
  assert.deepEqual(next.editorial.sourceConflict.sourceValue, TMDB_DATE);
  assert.deepEqual(next.editorial.sourceConflict.detectedAt, NOW);
});

test("i campi NON bloccati continuano ad aggiornarsi", () => {
  const existing = lockedExisting({ region: "US" });
  const next = mergeExistingEvent(existing, scannerDoc(), NOW);

  assert.equal(next.region, "IT");
});

// Se `detectedAt` si muovesse a ogni passata, il documento risulterebbe sempre
// diverso e ogni scansione produrrebbe una scrittura: 20k titoli ogni 2,5
// giorni, per sempre.
test("detectedAt non si muove se la fonte ripete lo stesso valore", () => {
  const first = mergeExistingEvent(lockedExisting(), scannerDoc(), NOW);
  const later = new Date(NOW.getTime() + 86_400_000);

  const second = mergeExistingEvent(
    lockedExisting({ editorial: first.editorial }),
    scannerDoc(),
    later
  );

  assert.deepEqual(second.editorial.sourceConflict.detectedAt, NOW);
});

test("una scansione senza novita' lascia il documento invariato", () => {
  const existing = lockedExisting();
  const first = mergeExistingEvent(existing, scannerDoc(), NOW);
  const settled = { ...existing, editorial: first.editorial, region: "IT" };

  const second = mergeExistingEvent(settled, scannerDoc(), new Date(NOW.getTime() + 86_400_000));

  assert.equal(managedDocumentsEqual(settled, second), true);
});

test("il conflitto sparisce quando la fonte torna d'accordo", () => {
  const conflicted = mergeExistingEvent(lockedExisting(), scannerDoc(), NOW);
  const existing = lockedExisting({ editorial: conflicted.editorial });

  const next = mergeExistingEvent(existing, scannerDoc(LOCKED_DATE), NOW);

  assert.equal(next.editorial.sourceConflict, null);
});

test("senza blocchi il comportamento resta quello di prima", () => {
  const existing = { status: "published", acquisitionMode: "live", effectiveAt: LOCKED_DATE };
  const next = mergeExistingEvent(existing, scannerDoc(), NOW);

  assert.deepEqual(next.effectiveAt, TMDB_DATE);
  assert.equal(next.editorial, undefined);
});

// ---------------------------------------------------------------------------
// linkedTitleIds (CONTRACT 3: saga fanout)
// ---------------------------------------------------------------------------

test("normalizeLinkedTitleIds: titleId sempre primo, deduplica, cap a 12", () => {
  assert.deepEqual(normalizeLinkedTitleIds("a", ["b", "c"]), ["a", "b", "c"]);
  assert.deepEqual(normalizeLinkedTitleIds("a", ["a", "b", "a", "b"]), ["a", "b"]);
  assert.deepEqual(normalizeLinkedTitleIds("a", ["", null, undefined, "b"]), ["a", "b"]);
  assert.deepEqual(normalizeLinkedTitleIds("", ["a", "b"]), ["a", "b"]);

  const many = Array.from({ length: 20 }, (_, i) => `t${i}`);
  const capped = normalizeLinkedTitleIds("primary", many);
  assert.equal(capped.length, LINKED_TITLE_IDS_MAX);
  assert.equal(capped[0], "primary");
});

function makeTitlesDb(titles = {}) {
  return {
    collection(name) {
      assert.equal(name, "titles");
      return {
        doc: (id) => ({
          async get() {
            const data = titles[id];
            return { exists: Boolean(data), data: () => data };
          },
        }),
        where(field, op, value) {
          const filters = [[field, op, value]];
          const self = {
            where(f2, o2, v2) {
              filters.push([f2, o2, v2]);
              return self;
            },
            limit() {
              return {
                async get() {
                  const [, , collectionId] = filters.find(([f]) => f === "collectionId") || [];
                  const [, , status] = filters.find(([f]) => f === "status") || [];
                  const docs = Object.entries(titles)
                    .filter(([, t]) => t.collectionId === collectionId && t.status === status)
                    .map(([id]) => ({ id }));
                  return { docs };
                },
              };
            },
          };
          return self;
        },
      };
    },
  };
}

test("resolveLinkedTitleIds: le serie TV non toccano il db (niente collectionId TMDB)", async () => {
  const dbThatThrows = { collection() { throw new Error("non doveva essere chiamato"); } };
  const result = await resolveLinkedTitleIds(dbThatThrows, { titleId: "ted-lasso", mediaType: "tv" });
  assert.deepEqual(result, ["ted-lasso"]);
});

test("resolveLinkedTitleIds: senza db (dry-run da script) resta [titleId]", async () => {
  const result = await resolveLinkedTitleIds(null, { titleId: "tmdb_movie_1", mediaType: "movie" });
  assert.deepEqual(result, ["tmdb_movie_1"]);
});

test("resolveLinkedTitleIds: film senza collectionId resta [titleId]", async () => {
  const db = makeTitlesDb({ tmdb_movie_1: { status: "approved" } });
  const result = await resolveLinkedTitleIds(db, { titleId: "tmdb_movie_1", mediaType: "movie" });
  assert.deepEqual(result, ["tmdb_movie_1"]);
});

test("resolveLinkedTitleIds: film in saga porta i fratelli approvati, se stesso escluso", async () => {
  const db = makeTitlesDb({
    tmdb_movie_1: { status: "approved", collectionId: 99 },
    tmdb_movie_2: { status: "approved", collectionId: 99 },
    tmdb_movie_3: { status: "pending", collectionId: 99 }, // non approvato: escluso
    tmdb_movie_9: { status: "approved", collectionId: 1 }, // altra saga: escluso
  });
  const result = await resolveLinkedTitleIds(db, { titleId: "tmdb_movie_1", mediaType: "movie" });
  assert.deepEqual(result, ["tmdb_movie_1", "tmdb_movie_2"]);
});

test("resolveLinkedTitleIds: un errore di lettura degrada a [titleId], non fa fallire la scrittura", async () => {
  const dbThatThrows = {
    collection() {
      return { doc: () => ({ async get() { throw new Error("boom"); } }) };
    },
  };
  const result = await resolveLinkedTitleIds(dbThatThrows, { titleId: "tmdb_movie_1", mediaType: "movie" });
  assert.deepEqual(result, ["tmdb_movie_1"]);
});

test("writeTitleUpdateEvent: un evento tv scrive linkedTitleIds = [titleId]", async () => {
  const db = makeDb();
  const result = await writeTitleUpdateEvent({ db, candidate: trailer(), acquisitionMode: "backfill", publishEligible: true, now: NOW });
  assert.equal(result.created, true);
  assert.deepEqual(db.store.get(trailer().id).linkedTitleIds, ["ted-lasso"]);
});
