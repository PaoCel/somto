"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  pageForRelease,
  buildReleaseConversationInput,
  isRedundantConversation,
  pickConversationCopy,
  planConversationSync,
  releaseConversationPostId,
  splitRedundantConversations,
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
  assert.match(input.text, /al cinema dal 22 agosto/i);
  assert.match(input.text, /^Dune: Parte tre/);
});

// Il template e' la voce di quasi tutto il feed: una frase sola rendeva dieci
// uscite di fila dieci fotocopie. Le varianti pero' devono essere stabili nel
// tempo, se no il testo cambia a ogni sync sotto gli occhi di chi l'ha letto.
test("il template varia fra uscite diverse ma resta identico per la stessa", () => {
  const textFor = (id) => buildReleaseConversationInput({
    event: release({ id }),
    title: title(),
    nowMs: NOW_MS,
  }).text;

  const ids = Array.from({ length: 24 }, (_, i) => `tmdb_release_movie_${i}`);
  const texts = ids.map(textFor);
  assert.ok(new Set(texts).size >= 3, `varianti troppo poche: ${new Set(texts).size}`);

  for (const id of ids) assert.equal(textFor(id), textFor(id));
  // Tutte devono restare pubblicabili: la data dentro, niente esitazioni,
  // niente parole che invecchiano.
  for (const text of new Set(texts)) {
    assert.match(text, /22 agosto/);
    assert.doesNotMatch(text, /\b(oggi|domani|ieri|stasera|forse|dovrebbe)\b/i);
  }
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
  assert.match(input.text, /Ted Lasso/);
  assert.match(input.text, /stagione 4/i);
  assert.match(input.text, /su Apple TV/);
  assert.equal(
    buildReleaseConversationInput({ event: { ...premiere, episode: 2 }, title: series, nowMs: NOW_MS }),
    null
  );
});

test("scarta date dubbie, supporti fisici, titoli non approvati e serie senza disponibilita' italiana", () => {
  assert.equal(buildReleaseConversationInput({ event: release({ reviewReason: "missing_it_release_date" }), title: title(), nowMs: NOW_MS }), null);
  assert.equal(buildReleaseConversationInput({ event: release({ releaseType: 5 }), title: title(), nowMs: NOW_MS }), null);
  // Venezia 2026: tre film in cartellone erano usciti come "arriva dal 5
  // settembre" mentre a quella data non li poteva vedere nessuno.
  assert.equal(buildReleaseConversationInput({ event: release({ releaseType: 1 }), title: title(), nowMs: NOW_MS }), null);
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

function makeSyncDb({ existingUpdate = null, existingByTitle = [] } = {}) {
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
  const updatesQuery = {
    where: () => updatesQuery,
    orderBy: () => updatesQuery,
    limit: () => updatesQuery,
    get: async () => ({
      docs: existingByTitle.map((row) => ({ id: row.slug, data: () => row })),
    }),
  };
  return {
    collection(name) {
      if (name === "titleUpdateEvents") return eventQuery;
      if (name === "officialUpdates") return { ...updatesQuery, doc: (id) => ref(name, id) };
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

// --- Copy nella voce di Paolo (2026-08-29) ---
// Scritto dalla routine locale, validato qui: il template non e' bello ma ha
// due garanzie che un testo scritto altrove non ha per forza.

const COPY_FALLBACK = { title: "T", text: "F", summary: "S", source: "template" };

test("un copy che dice la data e non invecchia viene usato", () => {
  const out = pickConversationCopy({
    copy: {
      title: "Dune: Parte tre, dal 22 agosto al cinema",
      text: "Villeneuve chiude la trilogia il 22 agosto. Dopo due film costruiti sull'attesa, questo deve consegnare qualcosa.",
    },
    date: "22 agosto",
    fallback: COPY_FALLBACK,
  });
  assert.equal(out.source, "editorial");
  assert.match(out.summary, /^Villeneuve chiude la trilogia il 22 agosto$/);
});

test("un copy che non nomina la data non si pubblica", () => {
  const out = pickConversationCopy({
    copy: { title: "Dune: Parte tre", text: "Villeneuve chiude la trilogia. Da vedere." },
    date: "22 agosto",
    fallback: COPY_FALLBACK,
  });
  assert.equal(out, COPY_FALLBACK);
});

test("niente copy che invecchia: lo stesso post viene aggiornato, non ricreato", () => {
  const out = pickConversationCopy({
    copy: { title: "Dune", text: "Esce domani, il 22 agosto, al cinema." },
    date: "22 agosto",
    fallback: COPY_FALLBACK,
  });
  assert.equal(out, COPY_FALLBACK);
});

// L'errore del 28/08 in una riga di test.
test("niente esitazioni su un fatto che abbiamo come structured", () => {
  for (const text of [
    "Dovrebbe uscire il 22 agosto al cinema.",
    "Il 22 agosto, ma non e' ancora confermato.",
    "Forse arriva il 22 agosto.",
  ]) {
    assert.equal(pickConversationCopy({ copy: { title: "Dune", text }, date: "22 agosto", fallback: COPY_FALLBACK }), COPY_FALLBACK);
  }
});

test("senza copy si usa il template, e il post lo dichiara", () => {
  const input = buildReleaseConversationInput({ event: release(), title: title(), nowMs: NOW_MS });
  assert.equal(input.copySource, "template");
  assert.match(input.text, /^Dune: Parte tre/);
  assert.match(input.text, /22 agosto/);
});

test("con copy valido sull'evento il post esce nella voce di Paolo", () => {
  const input = buildReleaseConversationInput({
    event: release({
      editorialCopy: {
        title: "Dune: Parte tre, dal 22 agosto",
        text: "Villeneuve chiude la trilogia il 22 agosto. Secondo me e' il film piu' difficile dei tre.",
        summary: "Villeneuve chiude la trilogia il 22 agosto.",
      },
    }),
    title: title(),
    nowMs: NOW_MS,
  });
  assert.equal(input.copySource, "editorial");
  assert.match(input.title, /^Dune: Parte tre, dal 22 agosto$/);
  assert.match(input.text, /^Villeneuve chiude la trilogia/);
});

// --- Niente doppioni (2026-08-29) ---
// Incidente: post editoriale "The Diplomat 4" del 28/08 con la data del 15
// ottobre; due giorni dopo la stessa data entrava nella finestra della sync.

test("un post gia' pubblicato sullo stesso titolo blocca il doppione automatico", async () => {
  const calls = [];
  const report = await syncReleaseConversationPosts({
    db: makeSyncDb({
      existingByTitle: [{
        slug: "dune-3-tutto-quello-che-sappiamo",
        status: "published",
        updateType: "release_date",
        linkedTitleIds: ["dune-3"],
        sourceEffectiveAt: null,
        publishedAt: new Date(NOW_MS - (2 * 24 * 60 * 60 * 1000)),
      }],
    }),
    admin: adminMock,
    nowMs: NOW_MS,
    publish: async ({ input }) => calls.push(input),
  });
  assert.deepEqual(report.redundant, [release().id]);
  assert.equal(calls.length, 0);
});

test("stesso titolo ma notizia diversa: il post automatico esce lo stesso", async () => {
  const calls = [];
  const report = await syncReleaseConversationPosts({
    db: makeSyncDb({
      existingByTitle: [{
        slug: "dune-3-il-cast",
        status: "published",
        updateType: "new_season",
        linkedTitleIds: ["dune-3"],
        sourceEffectiveAt: null,
        publishedAt: new Date(NOW_MS - (2 * 24 * 60 * 60 * 1000)),
      }],
    }),
    admin: adminMock,
    nowMs: NOW_MS,
    publish: async ({ input }) => calls.push(input),
  });
  assert.deepEqual(report.redundant, []);
  assert.equal(calls.length, 1);
});

test("la deduplica guarda la data quando c'e', non solo il tipo", () => {
  const input = buildReleaseConversationInput({ event: release(), title: title(), nowMs: NOW_MS });
  const sameDay = {
    slug: "altro-post",
    status: "published",
    updateType: "release_date",
    sourceEffectiveAt: new Date("2026-08-22T20:00:00.000Z"),
  };
  const otherDay = { ...sameDay, sourceEffectiveAt: new Date("2026-09-22T12:00:00.000Z") };
  assert.equal(isRedundantConversation(input, [sameDay], NOW_MS), true);
  assert.equal(isRedundantConversation(input, [otherDay], NOW_MS), false);
});

test("un pezzo vecchio non blocca per sempre le uscite di quel titolo", () => {
  const input = buildReleaseConversationInput({ event: release(), title: title(), nowMs: NOW_MS });
  const old = {
    slug: "pezzo-del-2025",
    status: "published",
    updateType: "release_date",
    sourceEffectiveAt: null,
    publishedAt: new Date(NOW_MS - (200 * 24 * 60 * 60 * 1000)),
  };
  assert.equal(isRedundantConversation(input, [old], NOW_MS), false);
});

test("il post che sta aggiornando se stesso non e' un doppione di se stesso", () => {
  const input = buildReleaseConversationInput({ event: release(), title: title(), nowMs: NOW_MS });
  const itself = {
    slug: input.slug,
    status: "published",
    updateType: input.updateType,
    sourceEffectiveAt: new Date(input.sourceEffectiveAt),
  };
  assert.equal(isRedundantConversation(input, [itself], NOW_MS), false);
  const { kept, redundant } = splitRedundantConversations([input], new Map([["dune-3", [itself]]]), NOW_MS);
  assert.equal(kept.length, 1);
  assert.deepEqual(redundant, []);
});

// --- Instradamento per tema (2026-08-20) ---
// Un post che esce sempre da Somto non da' a nessuno un motivo per seguire
// qualcosa in particolare.
test("il tema vince sul formato: una serie crime va sulla pagina crime", () => {
  assert.equal(pageForRelease({ genres: ["tmdb_80", "tmdb_18"] }, "tv"), "page_crime");
  assert.equal(pageForRelease({ genres: ["tmdb_80"] }, "movie"), "page_crime");
});

test("anime solo se animazione E provenienza giapponese", () => {
  assert.equal(pageForRelease({ genres: ["tmdb_16"], meta: { originalLanguage: "ja" } }, "tv"), "page_anime");
  assert.equal(pageForRelease({ genres: ["tmdb_16"], meta: { originCountry: ["JP"] } }, "tv"), "page_anime");
  // Pixar non e' anime.
  assert.equal(
    pageForRelease({ genres: ["tmdb_16"], meta: { originalLanguage: "en", originCountry: ["US"] } }, "movie"),
    "page_uscite"
  );
});

test("senza tema si ripiega sul formato", () => {
  assert.equal(pageForRelease({ genres: ["tmdb_27", "tmdb_53"] }, "movie"), "page_uscite");
  assert.equal(pageForRelease({ genres: ["tmdb_18"] }, "tv"), "page_serie");
  assert.equal(pageForRelease({}, "movie"), "page_uscite");
});

test("il thriller da solo non finisce nel crime", () => {
  // 53 sta su mezzo catalogo horror: svuoterebbe le altre pagine.
  assert.equal(pageForRelease({ genres: ["tmdb_53"] }, "movie"), "page_uscite");
});
