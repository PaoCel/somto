const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_ITEMS,
  _buildFeedItems: buildFeedItems,
  _buildFeedPayload: buildFeedPayload,
  _normalizePosterUrl: normalizePosterUrl,
  _titlePath: titlePath,
  _fetchPublishedReleaseEvents: fetchPublishedReleaseEvents,
} = require("../../modules/upcomingReleasesFeed");

const NOW = new Date("2026-08-12T10:00:00.000Z");

function firestoreTimestamp(iso) {
  return { toDate: () => new Date(iso) };
}

function approvedTitle(overrides = {}) {
  return {
    name: "Dune: Parte tre",
    slug: "dune-parte-tre",
    type: "movie",
    status: "approved",
    posterPath: "https://image.tmdb.org/t/p/w500/poster.jpg",
    ...overrides,
  };
}

// Una serie che torna entra solo se si sa su cosa si vede: il fixture porta il
// provider, chi vuole provare il caso senza lo azzera.
function approvedSeries(overrides = {}) {
  return approvedTitle({
    type: "tv",
    name: "La serie",
    slug: "la-serie",
    watchProviderLogos: [{ name: "Netflix", logoUrl: "https://image.tmdb.org/t/p/original/netflix.jpg" }],
    ...overrides,
  });
}

function releaseEvent(overrides = {}) {
  return {
    id: "tmdb_release_movie_1",
    titleId: "dune-3",
    eventType: "release_date",
    status: "published",
    effectiveAt: firestoreTimestamp("2026-12-18T12:00:00.000Z"),
    ...overrides,
  };
}

// --- forma del JSON --------------------------------------------------------

test("una voce del feed ha i campi che il widget consuma, gia' normalizzati", () => {
  const items = buildFeedItems({
    events: [releaseEvent()],
    titlesById: new Map([["dune-3", approvedTitle()]]),
    now: NOW,
  });

  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    id: "tmdb_release_movie_1",
    postId: "official_uscita-tmdb-release-movie-1",
    titleId: "dune-3",
    name: "Dune: Parte tre",
    type: "movie",
    releaseDate: "2026-12-18T12:00:00.000Z",
    releaseKind: null,
    occasion: "release",
    season: null,
    provider: null,
    posterUrl: "https://image.tmdb.org/t/p/w185/poster.jpg",
    path: "/film/dune-parte-tre",
    url: "https://somto.it/film/dune-parte-tre",
  });
});

// --- dove esce -------------------------------------------------------------

test("il tipo di uscita TMDB diventa cinema/streaming/tv, il resto resta muto", () => {
  const items = buildFeedItems({
    events: [
      releaseEvent({ id: "cinema", titleId: "t3", releaseType: 3 }),
      releaseEvent({ id: "cinema-limitato", titleId: "t2", releaseType: 2 }),
      releaseEvent({ id: "digitale", titleId: "t4", releaseType: 4 }),
      releaseEvent({ id: "tv", titleId: "t6", releaseType: 6 }),
      // Un'anteprima di festival non e' un biglietto che si compra: nessuna
      // etichetta, non "Al cinema".
      releaseEvent({ id: "anteprima", titleId: "t1", releaseType: 1 }),
      releaseEvent({ id: "ignoto", titleId: "t0", releaseType: null }),
    ],
    titlesById: new Map(["t3", "t2", "t4", "t6", "t1", "t0"].map((id) => [id, approvedTitle({ slug: id })])),
    now: NOW,
  });

  assert.deepEqual(
    items.map((item) => [item.id, item.releaseKind]),
    [
      ["cinema", "cinema"],
      ["cinema-limitato", "cinema"],
      ["digitale", "streaming"],
      ["tv", "tv"],
      ["anteprima", null],
      ["ignoto", null],
    ]
  );
});

test("un'uscita in supporto fisico non e' una prossima uscita", () => {
  const items = buildFeedItems({
    events: [
      releaseEvent({ id: "dvd", titleId: "t5", releaseType: 5 }),
      releaseEvent({ id: "sala", titleId: "t3", releaseType: 3 }),
    ],
    titlesById: new Map([
      ["t5", approvedTitle({ slug: "t5" })],
      ["t3", approvedTitle({ slug: "t3" })],
    ]),
    now: NOW,
  });

  assert.deepEqual(items.map((item) => item.id), ["sala"]);
});

// --- serie: torna una stagione, non arriva un episodio ---------------------

function episodeEvent(overrides = {}) {
  return releaseEvent({
    id: "tmdb_release_tv_9_s2_e1",
    titleId: "serie-1",
    eventType: "new_episode",
    season: 2,
    episode: 1,
    ...overrides,
  });
}

test("una premiere di stagione entra nel feed, un episodio a meta' stagione no", () => {
  const items = buildFeedItems({
    events: [
      episodeEvent({ id: "premiere", titleId: "serie-1" }),
      // Le serie in onda ne producono uno a settimana: in tre righe di widget
      // vincerebbero sempre loro, e non e' cio' che si va a cercare li'.
      episodeEvent({ id: "giovedi", titleId: "serie-2", season: 2, episode: 7 }),
      episodeEvent({ id: "senza-numero", titleId: "serie-3", season: 1, episode: null }),
    ],
    titlesById: new Map([
      ["serie-1", approvedSeries({ slug: "serie-1" })],
      ["serie-2", approvedSeries({ slug: "serie-2", name: "Altra serie" })],
      ["serie-3", approvedSeries({ slug: "serie-3", name: "Terza serie" })],
    ]),
    now: NOW,
  });

  assert.deepEqual(items.map((item) => [item.id, item.occasion, item.season]), [
    ["premiere", "season_premiere", 2],
  ]);
});

test("la stagione esce solo per le premiere, e solo se e' un numero vero", () => {
  const items = buildFeedItems({
    events: [
      episodeEvent({ id: "senza-stagione", titleId: "serie-1", season: null }),
      releaseEvent({ id: "film", titleId: "film-1", season: 4 }),
    ],
    titlesById: new Map([
      ["serie-1", approvedSeries({ slug: "serie-1" })],
      ["film-1", approvedTitle({ slug: "film-1" })],
    ]),
    now: NOW,
  });

  assert.deepEqual(items.map((item) => [item.id, item.season]), [
    ["senza-stagione", null],
    // `season` su un evento film e' rumore: il feed non lo propaga.
    ["film", null],
  ]);
});

test("una serie senza piattaforma italiana non entra, e il logo esce ridotto", () => {
  const items = buildFeedItems({
    events: [
      episodeEvent({ id: "guardabile", titleId: "serie-1" }),
      // Le soap estere mai arrivate in Italia sono esattamente queste: nessun
      // provider, e nessun motivo di occupare una riga.
      episodeEvent({ id: "mai-arrivata", titleId: "serie-2" }),
    ],
    titlesById: new Map([
      ["serie-1", approvedSeries({ slug: "serie-1" })],
      ["serie-2", approvedSeries({ slug: "serie-2", watchProviderLogos: [] })],
    ]),
    now: NOW,
  });

  assert.deepEqual(items.map((item) => item.id), ["guardabile"]);
  assert.deepEqual(items[0].provider, {
    name: "Netflix",
    logoUrl: "https://image.tmdb.org/t/p/w92/netflix.jpg",
  });
});

test("fra due righe dello stesso marchio vince quella che non e' un canale dentro un altro", () => {
  const items = buildFeedItems({
    events: [episodeEvent({ id: "premiere", titleId: "serie-1" })],
    titlesById: new Map([["serie-1", approvedSeries({
      watchProviderLogos: [
        { name: "HBO Max Amazon Channel", logoUrl: "https://image.tmdb.org/t/p/original/amazon.jpg" },
        { name: "HBO Max", logoUrl: "https://image.tmdb.org/t/p/original/hbo.jpg" },
      ],
    })]]),
    now: NOW,
  });

  assert.equal(items[0].provider.name, "HBO Max");
});

// --- film e serie si dividono le righe -------------------------------------

test("le serie non si prendono piu' di meta' feed finche' ci sono film", () => {
  const events = [];
  const titlesById = new Map();
  // Venti premiere tutte prima del primo film: senza tetto riempirebbero il
  // feed e il film piu' vicino non si vedrebbe mai.
  for (let i = 0; i < 20; i++) {
    const titleId = `serie-${i}`;
    events.push(episodeEvent({
      id: `premiere-${i}`,
      titleId,
      effectiveAt: firestoreTimestamp(`2026-08-${String(13 + (i % 10)).padStart(2, "0")}T12:00:00.000Z`),
    }));
    titlesById.set(titleId, approvedSeries({ slug: titleId }));
  }
  for (let i = 0; i < 20; i++) {
    const titleId = `film-${i}`;
    events.push(releaseEvent({
      id: `film-${i}`,
      titleId,
      effectiveAt: firestoreTimestamp(`2026-09-${String((i % 28) + 1).padStart(2, "0")}T12:00:00.000Z`),
    }));
    titlesById.set(titleId, approvedTitle({ slug: titleId }));
  }

  const items = buildFeedItems({ events, titlesById, now: NOW });
  const premieres = items.filter((item) => item.occasion === "season_premiere");

  assert.equal(items.length, MAX_ITEMS);
  assert.equal(premieres.length, Math.ceil(MAX_ITEMS / 2));
  // L'ordine resta quello delle date, anche dopo il riequilibrio.
  assert.deepEqual(items.map((item) => item.releaseDate), [...items.map((item) => item.releaseDate)].sort());
});

test("senza film il tetto si allarga invece di lasciare il widget mezzo vuoto", () => {
  const events = [];
  const titlesById = new Map();
  for (let i = 0; i < 20; i++) {
    const titleId = `serie-${i}`;
    events.push(episodeEvent({
      id: `premiere-${i}`,
      titleId,
      effectiveAt: firestoreTimestamp(`2026-08-${String(13 + (i % 10)).padStart(2, "0")}T12:00:00.000Z`),
    }));
    titlesById.set(titleId, approvedSeries({ slug: titleId }));
  }

  assert.equal(buildFeedItems({ events, titlesById, now: NOW }).length, MAX_ITEMS);
});

// --- una data da verificare non e' una data --------------------------------

test("un evento marcato da verificare non entra nel widget", () => {
  const items = buildFeedItems({
    events: [
      releaseEvent({ id: "globale", titleId: "a", reviewReason: "missing_it_release_date" }),
      releaseEvent({ id: "confermato", titleId: "b", region: "IT", releaseType: 3 }),
    ],
    titlesById: new Map([
      ["a", approvedTitle({ slug: "a" })],
      ["b", approvedTitle({ slug: "b" })],
    ]),
    now: NOW,
  });

  assert.deepEqual(items.map((item) => item.id), ["confermato"]);
});

test("il payload dichiara versione, istante e conteggio", () => {
  const payload = buildFeedPayload(
    buildFeedItems({
      events: [releaseEvent()],
      titlesById: new Map([["dune-3", approvedTitle()]]),
      now: NOW,
    }),
    NOW
  );

  assert.equal(payload.version, 1);
  assert.equal(payload.generatedAt, "2026-08-12T10:00:00.000Z");
  assert.equal(payload.count, 1);
  assert.equal(payload.items.length, 1);
  // Deve restare serializzabile senza sorprese: e' il contratto col widget.
  assert.equal(typeof JSON.parse(JSON.stringify(payload)).items[0].name, "string");
});

test("una serie usa /serie e il titolo senza slug ripiega su /share/title", () => {
  const items = buildFeedItems({
    events: [
      releaseEvent({ id: "ev-tv", titleId: "serie-1" }),
      releaseEvent({ id: "ev-noslug", titleId: "film-2" }),
    ],
    titlesById: new Map([
      ["serie-1", approvedTitle({ type: "tv", slug: "la-serie", name: "La serie" })],
      ["film-2", approvedTitle({ slug: "", name: "Film senza slug" })],
    ]),
    now: NOW,
  });

  assert.equal(items[0].path, "/serie/la-serie");
  assert.equal(items[0].type, "tv");
  // Un doc id non si risolve via `titles.slug` su iOS: /share/title si'.
  assert.equal(items[1].path, "/share/title/film-2");
});

// --- il filtro che conta: niente uscite gia' avvenute ----------------------

test("le uscite passate non entrano nel feed", () => {
  const items = buildFeedItems({
    events: [
      releaseEvent({ id: "ieri", titleId: "vecchio", effectiveAt: firestoreTimestamp("2026-08-11T12:00:00.000Z") }),
      releaseEvent({ id: "adesso", titleId: "esatto", effectiveAt: firestoreTimestamp("2026-08-12T10:00:00.000Z") }),
      releaseEvent({ id: "domani", titleId: "futuro", effectiveAt: firestoreTimestamp("2026-08-13T12:00:00.000Z") }),
    ],
    titlesById: new Map([
      ["vecchio", approvedTitle({ slug: "vecchio" })],
      ["esatto", approvedTitle({ slug: "esatto" })],
      ["futuro", approvedTitle({ slug: "futuro" })],
    ]),
    now: NOW,
  });

  assert.deepEqual(items.map((item) => item.id), ["domani"]);
});

test("un evento senza data valida viene scartato invece di finire in fondo", () => {
  const items = buildFeedItems({
    events: [
      releaseEvent({ id: "senza-data", titleId: "a", effectiveAt: null }),
      releaseEvent({ id: "buono", titleId: "b" }),
    ],
    titlesById: new Map([
      ["a", approvedTitle({ slug: "a" })],
      ["b", approvedTitle({ slug: "b" })],
    ]),
    now: NOW,
  });

  assert.deepEqual(items.map((item) => item.id), ["buono"]);
});

// --- cap e deduplica -------------------------------------------------------

test("il feed si ferma al cap, anche se la query ne ha restituiti di piu'", () => {
  const events = [];
  const titlesById = new Map();
  for (let i = 0; i < MAX_ITEMS + 15; i++) {
    const titleId = `t-${i}`;
    events.push(releaseEvent({
      id: `ev-${i}`,
      titleId,
      effectiveAt: firestoreTimestamp(`2026-09-${String((i % 28) + 1).padStart(2, "0")}T12:00:00.000Z`),
    }));
    titlesById.set(titleId, approvedTitle({ slug: titleId }));
  }

  assert.equal(buildFeedItems({ events, titlesById, now: NOW }).length, MAX_ITEMS);
  assert.equal(buildFeedItems({ events, titlesById, now: NOW, max: 3 }).length, 3);
  // `max` non puo' essere usato per sfondare il tetto del modulo.
  assert.equal(buildFeedItems({ events, titlesById, now: NOW, max: 500 }).length, MAX_ITEMS);
});

test("uno stesso titolo compare una volta sola, con la data piu' vicina", () => {
  const items = buildFeedItems({
    events: [
      releaseEvent({ id: "cinema", titleId: "dune-3", effectiveAt: firestoreTimestamp("2026-12-18T12:00:00.000Z") }),
      releaseEvent({ id: "usa", titleId: "dune-3", effectiveAt: firestoreTimestamp("2026-12-20T12:00:00.000Z") }),
    ],
    titlesById: new Map([["dune-3", approvedTitle()]]),
    now: NOW,
  });

  assert.deepEqual(items.map((item) => item.id), ["cinema"]);
});

// --- si linka solo cio' che si apre ---------------------------------------

test("titolo mancante, non approvato o senza nome: riga saltata", () => {
  const items = buildFeedItems({
    events: [
      releaseEvent({ id: "orfano", titleId: "sparito" }),
      releaseEvent({ id: "pending", titleId: "in-attesa" }),
      releaseEvent({ id: "anonimo", titleId: "senza-nome" }),
      releaseEvent({ id: "buono", titleId: "ok" }),
    ],
    titlesById: new Map([
      ["in-attesa", approvedTitle({ status: "pending", slug: "in-attesa" })],
      ["senza-nome", approvedTitle({ name: "", originalName: "", slug: "senza-nome" })],
      ["ok", approvedTitle({ slug: "ok" })],
    ]),
    now: NOW,
  });

  assert.deepEqual(items.map((item) => item.id), ["buono"]);
});

// --- poster ----------------------------------------------------------------

test("il poster esce ridotto, oppure null: mai una stringa da interpretare", () => {
  assert.equal(
    normalizePosterUrl("https://image.tmdb.org/t/p/original/a.jpg"),
    "https://image.tmdb.org/t/p/w185/a.jpg"
  );
  assert.equal(
    normalizePosterUrl("https://image.tmdb.org/t/p/w500/a.jpg"),
    "https://image.tmdb.org/t/p/w185/a.jpg"
  );
  // Altro host https: passa intatto, non e' compito nostro riscriverlo.
  assert.equal(
    normalizePosterUrl("https://firebasestorage.googleapis.com/x.jpg"),
    "https://firebasestorage.googleapis.com/x.jpg"
  );
  assert.equal(normalizePosterUrl("http://image.tmdb.org/t/p/w500/a.jpg"), null);
  assert.equal(normalizePosterUrl("/w500/a.jpg"), null);
  assert.equal(normalizePosterUrl(""), null);
  assert.equal(normalizePosterUrl(null), null);

  const items = buildFeedItems({
    events: [releaseEvent()],
    titlesById: new Map([["dune-3", approvedTitle({ posterPath: "" })]]),
    now: NOW,
  });
  assert.equal(items[0].posterUrl, null);
});

test("titlePath codifica lo slug e non inventa percorsi senza id", () => {
  assert.equal(titlePath("movie", "il film/rotto", "id"), "/film/il%20film%2Frotto");
  assert.equal(titlePath("tv", "", "abc"), "/share/title/abc");
  assert.equal(titlePath("movie", "", ""), "");
});

// --- query -----------------------------------------------------------------

test("due query separate: le uscite, e le sole premiere di stagione", async () => {
  // Ogni query si porta dietro i propri `where`: il fake ne apre una nuova a
  // ogni `collection()`, come fa Firestore.
  const queries = [];
  function makeQuery(docs) {
    const calls = [];
    const query = {
      calls,
      where(field, op, value) { calls.push(["where", field, op, value]); return query; },
      orderBy(field, dir) { calls.push(["orderBy", field, dir]); return query; },
      limit(value) { calls.push(["limit", value]); return query; },
      async get() { return { docs }; },
    };
    return query;
  }
  const docsByCall = [
    [{ id: "film", data: () => ({ titleId: "f", effectiveAt: firestoreTimestamp("2026-09-01T12:00:00.000Z") }) }],
    [{ id: "premiere", data: () => ({ titleId: "s", effectiveAt: firestoreTimestamp("2026-08-20T12:00:00.000Z") }) }],
  ];
  const db = {
    collection() {
      const query = makeQuery(docsByCall[queries.length] || []);
      queries.push(query);
      return query;
    },
  };

  const events = await fetchPublishedReleaseEvents(db, NOW, 40);

  assert.deepEqual(queries[0].calls, [
    ["where", "eventType", "==", "release_date"],
    ["where", "status", "==", "published"],
    ["where", "effectiveAt", ">", NOW],
    ["orderBy", "effectiveAt", "asc"],
    ["limit", 40],
  ]);
  assert.deepEqual(queries[1].calls, [
    ["where", "eventType", "==", "new_episode"],
    ["where", "status", "==", "published"],
    // Il filtro sulle premiere sta NELL'INDICE: leggere ogni episodio e poi
    // buttarlo significava pagare letture per niente (feed a 4 voci su 10).
    ["where", "episode", "==", 1],
    ["where", "effectiveAt", ">", NOW],
    ["orderBy", "effectiveAt", "asc"],
    ["limit", 40],
  ]);
  // Le due liste tornano fuse in ordine di data, non una dietro l'altra.
  assert.deepEqual(events.map((event) => event.id), ["premiere", "film"]);
});
