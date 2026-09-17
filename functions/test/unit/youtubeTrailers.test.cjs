"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildYouTubeVideoCandidate,
  collectYouTubeTrailerCandidates,
  mergePendingRows,
  parseYouTubeVideoTitle,
  pickMatchingTitle,
  selectNewVideos,
  titleTooOldForNewTrailer,
} = require("../../lib/youtubeTrailers");
const { makeTmdbVideoCandidateId } = require("../../lib/titleUpdateCandidates");

const NOW_MS = Date.parse("2026-08-29T10:00:00.000Z");

// Il titolo vero del video che non avevamo intercettato.
const DIPLOMAT = "The Diplomat - Stagione 4 | Teaser ufficiale | Netflix Italia";

test("dal titolo del video si ricavano serie, stagione e tipo", () => {
  const parsed = parseYouTubeVideoTitle(DIPLOMAT);
  assert.equal(parsed.name, "The Diplomat");
  assert.equal(parsed.season, 4);
  assert.equal(parsed.kind, "teaser");
});

test("la stagione si cerca in tutto il titolo, non solo prima della barra", () => {
  const parsed = parseYouTubeVideoTitle("Nome serie | Trailer stagione 2 | Prime Video");
  assert.equal(parsed.name, "Nome serie");
  assert.equal(parsed.season, 2);
  assert.equal(parsed.kind, "trailer");
});

test("se il marcatore apre il titolo, il nome e' il segmento dopo", () => {
  const parsed = parseYouTubeVideoTitle("Trailer ufficiale | Nome serie | Sky");
  assert.equal(parsed.name, "Nome serie");
});

test("season in inglese e film senza stagione", () => {
  assert.equal(parseYouTubeVideoTitle("Nome serie: Season 2 | Official Trailer").season, 2);
  const film = parseYouTubeVideoTitle("Nome film | Trailer ufficiale | Netflix");
  assert.equal(film.season, null);
  assert.equal(film.name, "Nome film");
});

// E' il filtro che tiene fuori il rumore: un canale pubblica soprattutto altro.
test("clip, interviste e classifiche non sono trailer", () => {
  assert.equal(parseYouTubeVideoTitle("I 10 momenti migliori di Nome serie | Netflix"), null);
  assert.equal(parseYouTubeVideoTitle("Intervista al cast | Netflix Italia"), null);
  assert.equal(parseYouTubeVideoTitle("Dietro le quinte | Prime Video"), null);
  assert.equal(parseYouTubeVideoTitle(""), null);
});

test("il teaser resta un teaser anche quando si chiama teaser trailer", () => {
  assert.equal(parseYouTubeVideoTitle("Nome serie | Teaser trailer | Netflix").kind, "teaser");
});

// Casi veri raccolti dal primo giro sui canali il 2026-08-29: erano tutti
// finiti in coda con "titolo non in catalogo" mentre il titolo in catalogo
// c'era eccome.
test("il marcatore dentro il primo segmento non ruba il nome", () => {
  const parsed = parseYouTubeVideoTitle("Slow Horses — Season 6 Official Trailer | Apple TV");
  assert.equal(parsed.name, "Slow Horses");
  assert.equal(parsed.season, 6);
  assert.equal(parseYouTubeVideoTitle("Neagley Trailer Ufficiale").name, "Neagley");
});

test("la stagione abbreviata: S4, S02", () => {
  const sky = parseYouTubeVideoTitle("The Gilded Age S4 | Teaser Ufficiale | Sky Italia");
  assert.equal(sky.name, "The Gilded Age");
  assert.equal(sky.season, 4);
  const paramount = parseYouTubeVideoTitle("MobLand S02 | Trailer ufficiale | Paramount+");
  assert.equal(paramount.name, "MobLand");
  assert.equal(paramount.season, 2);
  const ita = parseYouTubeVideoTitle("Diarra From Detroit | Trailer S2 ITA - Paramount+");
  assert.equal(ita.name, "Diarra From Detroit");
  assert.equal(ita.season, 2);
});

// Caso vero 2026-09-16: il trailer di South Park s29 e' finito in coda come
// "South America" (il nome dell'episodio) mentre la serie era in catalogo.
test("il segmento con la stagione e' un nome di riserva", () => {
  const parsed = parseYouTubeVideoTitle("South America | Trailer ufficiale | Paramount+ | South Park s29");
  assert.equal(parsed.name, "South America");
  assert.equal(parsed.season, 29);
  assert.deepEqual(parsed.altNames, ["South Park"]);
});

test("il marcatore da solo non diventa un nome di riserva", () => {
  assert.deepEqual(parseYouTubeVideoTitle("Nome serie | Trailer stagione 2 | Prime Video").altNames, []);
  assert.deepEqual(parseYouTubeVideoTitle("The Gilded Age S4 | Teaser Ufficiale | Sky Italia").altNames, []);
  assert.deepEqual(parseYouTubeVideoTitle("Nome film | Trailer ufficiale | Netflix").altNames, []);
});

test("le etichette del canale non fanno parte del nome", () => {
  assert.equal(parseYouTubeVideoTitle("FX's The Shards | Trailer Ufficiale | Disney+ Italia").name, "The Shards");
  assert.equal(parseYouTubeVideoTitle("Titolo: Golden Axe | Trailer Ufficiale | Paramount+").name, "Golden Axe");
  assert.equal(parseYouTubeVideoTitle("Golden Axe | Trailer Ufficiale (Sub ITA) | Paramount+").name, "Golden Axe");
});

test("il watermark per canale scarta cio' che era gia' stato visto", () => {
  const items = [
    { snippet: { title: "vecchio", publishedAt: "2026-08-01T10:00:00Z", resourceId: { videoId: "a" } } },
    { snippet: { title: "nuovo", publishedAt: "2026-08-28T10:00:00Z", resourceId: { videoId: "b" } } },
    { snippet: { title: "futuro", publishedAt: "2026-09-10T10:00:00Z", resourceId: { videoId: "c" } } },
  ];
  const rows = selectNewVideos(items, { sinceMs: Date.parse("2026-08-15T00:00:00Z"), nowMs: NOW_MS });
  assert.deepEqual(rows.map((row) => row.videoId), ["b"]);
});

test("nel dubbio non si sceglie: due serie omonime restano in coda", () => {
  const parsed = parseYouTubeVideoTitle(DIPLOMAT);
  const uno = { id: "the-diplomat-na-tv", type: "tv", watchProviderNames: ["Netflix"] };
  const due = { id: "the-diplomat-2023-tv", type: "tv", watchProviderNames: ["Sky"] };
  const tre = { id: "the-diplomat-altra-tv", type: "tv", watchProviderNames: [] };

  assert.equal(pickMatchingTitle([uno], { parsed, platform: "Netflix" }), uno);
  // La piattaforma del canale scioglie il pareggio...
  assert.equal(pickMatchingTitle([uno, due], { parsed, platform: "Netflix" }), uno);
  // ...ma se non lo scioglie non si tira a indovinare.
  assert.equal(pickMatchingTitle([uno, due, tre], { parsed, platform: "Apple TV" }), null);
});

test("una stagione nel titolo esclude i film omonimi", () => {
  const parsed = parseYouTubeVideoTitle(DIPLOMAT);
  const serie = { id: "x-tv", type: "tv" };
  const film = { id: "x-movie", type: "movie" };
  assert.equal(pickMatchingTitle([serie, film], { parsed, platform: "Netflix" }), serie);
});

// L'invariante anti-doppione: un evento e' "questo video su questo titolo",
// da qualunque parte lo si sia scoperto.
test("l'id e' lo stesso che userebbe la pipeline TMDB per quel video", () => {
  const parsed = parseYouTubeVideoTitle(DIPLOMAT);
  const candidate = buildYouTubeVideoCandidate({
    video: { videoId: "2hAN2-4zr0k", title: DIPLOMAT, publishedAt: "2026-08-18T12:00:00Z" },
    title: { id: "the-diplomat-na-tv", type: "tv", tmdbId: 203857 },
    channel: { key: "netflix_it", platform: "Netflix" },
    parsed,
  });
  assert.equal(
    candidate.id,
    makeTmdbVideoCandidateId({ mediaType: "tv", tmdbId: 203857, videoKey: "2hAN2-4zr0k" })
  );
  assert.equal(candidate.source, "youtube");
  assert.equal(candidate.eventType, "teaser");
  assert.equal(candidate.season, 4);
  assert.equal(candidate.official, true);
  assert.equal(candidate.sourceUrl, "https://www.youtube.com/watch?v=2hAN2-4zr0k");
});

// La coda e' una coda, non una fotografia. Il 2026-08-29: 24 righe raccolte
// alle 11:19, coda vuota alle 12:19 perche' il giro dopo non aveva trovato
// niente e ha sovrascritto. La routine editoriale si e' trovata a mani vuote.
test("la coda dei non riconosciuti si accumula fra un giro e l'altro", () => {
  const vecchie = [{ videoId: "a", parsedName: "Uno" }, { videoId: "b", parsedName: "Due" }];
  const nuove = [{ videoId: "c", parsedName: "Tre" }, { videoId: "a", parsedName: "Uno" }];
  assert.deepEqual(
    mergePendingRows(vecchie, nuove).map((row) => row.videoId),
    ["c", "a", "b"]
  );
  // Un giro che non trova niente non deve cancellare quello che c'era.
  assert.equal(mergePendingRows(vecchie, []).length, 2);
  // A coda piena cade il vecchio, non il nuovo.
  assert.deepEqual(mergePendingRows(vecchie, nuove, 2).map((row) => row.videoId), ["c", "a"]);
});

function makeDb(rows) {
  const query = {
    where: () => query,
    limit: () => query,
    get: async () => ({ docs: rows.map((row) => ({ id: row.id, data: () => row })) }),
  };
  return { collection: () => query };
}

test("un giro completo trova il teaser e consuma due unita' di quota", async () => {
  const calls = [];
  const fetchJson = async (url) => {
    calls.push(url);
    if (url.includes("/channels")) {
      return { items: [{ contentDetails: { relatedPlaylists: { uploads: "UU_netflix_it" } } }] };
    }
    return {
      items: [
        { snippet: { title: DIPLOMAT, publishedAt: "2026-08-18T12:00:00Z", resourceId: { videoId: "2hAN2-4zr0k" } } },
        { snippet: { title: "Intervista al cast | Netflix Italia", publishedAt: "2026-08-20T12:00:00Z", resourceId: { videoId: "zzz" } } },
      ],
    };
  };

  const report = await collectYouTubeTrailerCandidates({
    db: makeDb([{ id: "the-diplomat-na-tv", type: "tv", tmdbId: 203857, watchProviderNames: ["Netflix"] }]),
    apiKey: "chiave",
    fetchJson,
    channels: [{ key: "netflix_it", handle: "@NetflixItalia", platform: "Netflix" }],
    nowMs: NOW_MS,
  });

  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0].titleId, "the-diplomat-na-tv");
  assert.equal(report.quotaUsed, 2);
  assert.equal(report.errors.length, 0);
  assert.equal(report.channelState.netflix_it.uploadsPlaylistId, "UU_netflix_it");
  assert.equal(report.channelState.netflix_it.lastPublishedAt, "2026-08-20T12:00:00Z");
  // Mai search.list: costa 100 unita' contro 1.
  assert.equal(calls.some((url) => url.includes("/search")), false);
});

test("la playlist gia' in cache non ricosta una chiamata", async () => {
  const fetchJson = async (url) => {
    if (url.includes("/channels")) throw new Error("non doveva risolvere l'handle");
    return { items: [] };
  };
  const report = await collectYouTubeTrailerCandidates({
    db: makeDb([]),
    apiKey: "chiave",
    fetchJson,
    channels: [{ key: "netflix_it", handle: "@NetflixItalia", platform: "Netflix" }],
    state: { channels: { netflix_it: { uploadsPlaylistId: "UU_netflix_it", lastPublishedAt: "2026-08-01T00:00:00Z" } } },
    nowMs: NOW_MS,
  });
  assert.equal(report.quotaUsed, 1);
  assert.equal(report.errors.length, 0);
});

test("un titolo che non e' in catalogo finisce in coda, non negli eventi", async () => {
  const fetchJson = async (url) => (url.includes("/channels")
    ? { items: [{ contentDetails: { relatedPlaylists: { uploads: "UU_x" } } }] }
    : { items: [{ snippet: { title: "Serie mai sentita | Trailer ufficiale | Netflix", publishedAt: "2026-08-28T12:00:00Z", resourceId: { videoId: "q" } } }] });

  const report = await collectYouTubeTrailerCandidates({
    db: makeDb([]),
    apiKey: "chiave",
    fetchJson,
    channels: [{ key: "netflix_it", handle: "@NetflixItalia", platform: "Netflix" }],
    nowMs: NOW_MS,
  });
  assert.equal(report.candidates.length, 0);
  assert.deepEqual(report.pending.map((row) => row.reason), ["titolo non in catalogo"]);
});

test("un canale rotto non ferma gli altri", async () => {
  const fetchJson = async (url) => {
    if (url.includes("forHandle=%40Rotto")) return { items: [] };
    if (url.includes("/channels")) return { items: [{ contentDetails: { relatedPlaylists: { uploads: "UU_ok" } } }] };
    return { items: [] };
  };
  const report = await collectYouTubeTrailerCandidates({
    db: makeDb([]),
    apiKey: "chiave",
    fetchJson,
    channels: [
      { key: "rotto", handle: "@Rotto", platform: "Boh" },
      { key: "ok", handle: "@Ok", platform: "Netflix" },
    ],
    nowMs: NOW_MS,
  });
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0].message, /handle non risolto/);
  assert.ok(report.channelState.ok.uploadsPlaylistId);
});

// Il caso Harry Potter, 2026-09-02: HBO Max Italia pubblica "HARRY POTTER E LA
// PIETRA FILOSOFALE | TEASER TRAILER | HBO Max" per la serie del 2026, ma in
// catalogo quel nome esatto ce l'ha solo il film del 2001.
const HARRY_POTTER = "HARRY POTTER E LA PIETRA FILOSOFALE | TEASER TRAILER | HBO Max";

test("il match esatto su un titolo molto piu' vecchio del video non va in scheda", async () => {
  const fetchJson = async (url) => {
    if (url.includes("/channels")) {
      return { items: [{ contentDetails: { relatedPlaylists: { uploads: "UU_hbomax_it" } } }] };
    }
    return {
      items: [
        { snippet: { title: HARRY_POTTER, publishedAt: "2026-09-02T15:00:44Z", resourceId: { videoId: "SJVmeJaS44s" } } },
      ],
    };
  };

  const report = await collectYouTubeTrailerCandidates({
    db: makeDb([{
      id: "harry-potter-e-la-pietra-filosofale-2001",
      type: "movie",
      tmdbId: 671,
      year: 2001,
      watchProviderNames: ["HBO Max"],
    }]),
    apiKey: "chiave",
    fetchJson,
    channels: [{ key: "hbomax_it", handle: "@HBOMaxIT", platform: "HBO Max" }],
    nowMs: Date.parse("2026-09-02T21:00:00.000Z"),
  });

  assert.equal(report.candidates.length, 0);
  assert.equal(report.pending.length, 1);
  assert.equal(report.pending[0].videoId, "SJVmeJaS44s");
  assert.match(report.pending[0].reason, /piu' vecchio/);
});

test("un titolo dell'anno resta un match valido", () => {
  const published = Date.parse("2026-09-02T15:00:44Z");
  assert.equal(titleTooOldForNewTrailer({ year: 2026 }, published), false);
  assert.equal(titleTooOldForNewTrailer({ year: 2023 }, published), false);
  assert.equal(titleTooOldForNewTrailer({ year: 2022 }, published), true);
  assert.equal(titleTooOldForNewTrailer({ year: 2001 }, published), true);
  // Senza anno non si inventa una regola: passa e decide il resto della catena.
  assert.equal(titleTooOldForNewTrailer({}, published), false);
  assert.equal(titleTooOldForNewTrailer({ year: 2001 }, null), false);
});
