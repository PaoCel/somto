"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildReleaseConversationInput,
  planConversationSync,
  releaseConversationPostId,
  selectBalancedConversationInputs,
  samePublishedConversation,
  syncReleaseConversationPosts,
} = require("../../lib/releaseConversationPosts");

const NOW_MS = Date.parse("2026-08-16T10:00:00.000Z");

function title(overrides = {}) {
  return {
    name: "Dune: Parte tre",
    type: "movie",
    status: "approved",
    ...overrides,
  };
}

function release(overrides = {}) {
  return {
    id: "tmdb_release_movie_1",
    titleId: "dune-3",
    mediaType: "movie",
    eventType: "release_date",
    status: "published",
    effectiveAt: new Date("2026-08-22T12:00:00.000Z"),
    region: "IT",
    releaseType: 3,
    sourceTrust: "structured",
    sourceUrl: "https://www.themoviedb.org/movie/1",
    ...overrides,
  };
}

test("un'uscita italiana diventa un post pubblico deterministico e senza doppia notifica", () => {
  const input = buildReleaseConversationInput({ event: release(), title: title(), nowMs: NOW_MS });

  assert.equal(input.slug, "uscita-tmdb-release-movie-1");
  assert.equal(releaseConversationPostId(release().id), "official_uscita-tmdb-release-movie-1");
  assert.equal(input.updateType, "release_date");
  assert.equal(input.notificationsEnabled, false);
  assert.equal(input.sourceEventId, release().id);
  assert.equal(input.sourceEffectiveAt, Date.parse("2026-08-22T12:00:00.000Z"));
  assert.match(input.text, /arriva al cinema dal 22 agosto/i);
  assert.match(input.text, /Lo aspettavi\?/);
});

test("la premiere di stagione produce un post, gli altri episodi no", () => {
  const series = title({
    name: "Ted Lasso",
    type: "tv",
    watchProviderNames: ["Apple TV"],
  });
  const premiere = release({
    id: "tmdb_release_tv_9_s4_e1",
    titleId: "ted-lasso",
    mediaType: "tv",
    eventType: "new_episode",
    season: 4,
    episode: 1,
    region: null,
    releaseType: null,
  });

  const input = buildReleaseConversationInput({ event: premiere, title: series, nowMs: NOW_MS });
  assert.equal(input.updateType, "new_season");
  assert.match(input.text, /stagione 4 di Ted Lasso/i);
  assert.match(input.text, /su Apple TV/);
  assert.equal(
    buildReleaseConversationInput({ event: { ...premiere, episode: 2 }, title: series, nowMs: NOW_MS }),
    null
  );
});

test("scarta date dubbie, supporti fisici, titoli non approvati e serie senza disponibilita' italiana", () => {
  assert.equal(buildReleaseConversationInput({ event: release({ reviewReason: "missing_it_release_date" }), title: title(), nowMs: NOW_MS }), null);
  assert.equal(buildReleaseConversationInput({ event: release({ releaseType: 5 }), title: title(), nowMs: NOW_MS }), null);
  assert.equal(buildReleaseConversationInput({ event: release(), title: title({ status: "pending" }), nowMs: NOW_MS }), null);
  assert.equal(buildReleaseConversationInput({
    event: release({ mediaType: "tv", eventType: "new_episode", season: 2, episode: 1 }),
    title: title({ type: "tv", watchProviderNames: [] }),
    nowMs: NOW_MS,
  }), null);
});

test("il confronto idempotente rileva solo cambi reali di data o copy", () => {
  const input = buildReleaseConversationInput({ event: release(), title: title(), nowMs: NOW_MS });
  const existing = {
    status: "published",
    sourceEventId: input.sourceEventId,
    sourceEffectiveAt: new Date(input.sourceEffectiveAt),
    title: input.title,
    text: input.text,
  };
  assert.equal(samePublishedConversation(existing, input), true);
  assert.equal(samePublishedConversation({ ...existing, text: "copy vecchio" }, input), false);
  assert.equal(samePublishedConversation({ ...existing, sourceEffectiveAt: new Date("2026-08-23") }, input), false);
});

test("il batch riserva spazio sia ai film sia alle stagioni", () => {
  const inputs = [
    ...Array.from({ length: 12 }, (_, index) => ({
      sourceEventId: `film-${index}`,
      sourceEffectiveAt: NOW_MS + index,
      updateType: "release_date",
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      sourceEventId: `serie-${index}`,
      sourceEffectiveAt: NOW_MS + 100 + index,
      updateType: "new_season",
    })),
  ];
  const selected = selectBalancedConversationInputs(inputs, 10);
  assert.equal(selected.length, 10);
  assert.equal(selected.filter((input) => input.updateType === "new_season").length, 4);
  assert.equal(selected.filter((input) => input.updateType === "release_date").length, 6);
});

test("i thread gia' allineati non bloccano il batch successivo", () => {
  const inputs = Array.from({ length: 25 }, (_, index) => ({
    slug: `uscita-${index}`,
    sourceEventId: `evento-${index}`,
    sourceEffectiveAt: NOW_MS + index,
    updateType: index % 2 ? "new_season" : "release_date",
    status: "published",
    title: `Titolo ${index}`,
    text: `Testo ${index}`,
  }));
  const existing = new Map(inputs.slice(0, 20).map((input) => [input.slug, {
    status: "published",
    sourceEventId: input.sourceEventId,
    sourceEffectiveAt: new Date(input.sourceEffectiveAt),
    title: input.title,
    text: input.text,
  }]));

  const plan = planConversationSync(inputs, existing, 20);
  assert.equal(plan.skipped.length, 20);
  assert.deepEqual(plan.selected.map((input) => input.sourceEventId), [
    "evento-20",
    "evento-21",
    "evento-22",
    "evento-23",
    "evento-24",
  ]);
});

function makeSyncDb({ existingUpdate = null } = {}) {
  const eventRows = [release()];
  const refs = new Map();
  const ref = (collection, id) => {
    const key = `${collection}/${id}`;
    if (!refs.has(key)) refs.set(key, { collection, id, path: key });
    return refs.get(key);
  };
  const eventQuery = {
    where: () => eventQuery,
    orderBy: () => eventQuery,
    limit: () => eventQuery,
    get: async () => ({
      docs: eventRows.map((row) => ({ id: row.id, data: () => row })),
    }),
  };
  return {
    collection(name) {
      if (name === "titleUpdateEvents") return eventQuery;
      return { doc: (id) => ref(name, id) };
    },
    async getAll(...requested) {
      return requested.map((requestedRef) => {
        if (requestedRef.collection === "titles") {
          return { id: requestedRef.id, exists: true, data: () => title() };
        }
        if (requestedRef.collection === "officialUpdates" && existingUpdate) {
          return { id: requestedRef.id, exists: true, data: () => existingUpdate };
        }
        return { id: requestedRef.id, exists: false, data: () => null };
      });
    },
  };
}

const adminMock = {
  firestore: {
    Timestamp: { fromMillis: (ms) => new Date(ms) },
  },
};

test("la sync pubblica una volta e salta una conversazione gia' allineata", async () => {
  const calls = [];
  const first = await syncReleaseConversationPosts({
    db: makeSyncDb(),
    admin: adminMock,
    nowMs: NOW_MS,
    publish: async ({ input }) => calls.push(input),
  });
  assert.deepEqual(first.published, [release().id]);
  assert.equal(calls.length, 1);

  const input = calls[0];
  const secondCalls = [];
  const second = await syncReleaseConversationPosts({
    db: makeSyncDb({
      existingUpdate: {
        status: "published",
        sourceEventId: input.sourceEventId,
        sourceEffectiveAt: new Date(input.sourceEffectiveAt),
        title: input.title,
        text: input.text,
      },
    }),
    admin: adminMock,
    nowMs: NOW_MS,
    publish: async ({ input: secondInput }) => secondCalls.push(secondInput),
  });
  assert.deepEqual(second.skipped, [release().id]);
  assert.equal(secondCalls.length, 0);
});
