import assert from "node:assert/strict";
import test from "node:test";

import {
  bestStreamingDestination,
  providerBaseName,
  rankProviders,
  streamingDestination,
} from "../../public/js/utils/streamingDestination.js";

// Gemello dei test Swift in `ios/TwoWatchTests/WatchlistWidgetSnapshotTests.swift`
// (sezione "Dove porta il tasto guarda"): stesso comportamento atteso, perche' lo
// stesso titolo deve mandare l'utente nello stesso posto su web e su iOS.

test("il link diretto vince su tutto", () => {
  const direct = "https://www.netflix.com/title/81234567";
  const destination = streamingDestination({
    providerName: "Netflix",
    deepLinks: { Netflix: direct },
    titleName: "Glass City",
    tmdbId: 999,
    isSeries: true,
  });

  assert.equal(destination.url, direct);
  assert.equal(destination.source, "direct");
  assert.equal(destination.isExact, true);
});

test("senza link diretto si apre la ricerca della piattaforma", () => {
  const destination = streamingDestination({
    providerName: "Netflix",
    deepLinks: {},
    titleName: "Glass City",
    tmdbId: null,
    isSeries: true,
  });

  assert.equal(destination.url, "https://www.netflix.com/search?q=Glass%20City");
  assert.equal(destination.source, "providerSearch");
  assert.equal(destination.isExact, false);
});

test("Prime non ruba la casa a una serie Apple", () => {
  // Ted Lasso: TMDB per l'Italia mette Prime davanti perche' RIVENDE Apple TV+.
  const nomi = ["Amazon Prime Video", "Apple TV", "Apple TV Amazon Channel", "Amazon Prime Video with Ads"];
  assert.deepEqual(rankProviders(nomi), ["Apple TV", "Amazon Prime Video"]);
});

test("quando Prime e' casa sua resta", () => {
  assert.deepEqual(
    rankProviders(["Amazon Prime Video", "Amazon Prime Video with Ads"]),
    ["Amazon Prime Video"],
  );
});

test("fra due piattaforme vince quella con il link esatto", () => {
  const best = bestStreamingDestination({
    providerNames: ["Amazon Prime Video", "Netflix"],
    deepLinks: { Netflix: "https://www.netflix.com/title/81234567" },
    titleName: "Glass City",
    tmdbId: 999,
    isSeries: true,
  });

  assert.equal(best.providerName, "Netflix");
  assert.equal(best.source, "direct");
});

test("il link diretto si trova anche col nome lungo", () => {
  const apple = "https://tv.apple.com/show/umc.cmc.vtoh0mn0xn7t3c643xqonfzy";
  const destination = streamingDestination({
    providerName: "Apple TV Amazon Channel",
    deepLinks: { "Apple TV": apple },
    titleName: "Ted Lasso",
    tmdbId: 97546,
    isSeries: true,
  });

  assert.equal(destination.url, apple);
  // Il nome mostrato e' quello corto: "Apple TV Amazon Channel" e' il nome di un
  // abbonamento, non di un'app.
  assert.equal(destination.providerName, "Apple TV");
});

test("la migliore piattaforma non perde il canale Amazon", () => {
  // REGRESSIONE — `rankProviders` collassa "MGM Plus Amazon Channel" in "MGM
  // Plus", che non e' fra i modelli di ricerca: risolvendo sul nome collassato
  // il tasto finiva sulla pagina TMDB invece che dentro Prime Video.
  const best = bestStreamingDestination({
    providerNames: ["MGM Plus Amazon Channel"],
    deepLinks: {},
    titleName: "Un titolo",
    tmdbId: 76331,
    isSeries: true,
  });

  assert.equal(best.source, "providerSearch");
  assert.ok(best.url.startsWith("https://www.primevideo.com/"));
  assert.equal(best.providerName, "MGM Plus");
});

test("Rai Play lo scrive con lo spazio", () => {
  const destination = streamingDestination({
    providerName: "Rai Play",
    deepLinks: {},
    titleName: "Mare Fuori",
    tmdbId: 118743,
    isSeries: true,
  });

  assert.equal(destination.source, "providerSearch");
  assert.ok(destination.url.startsWith("https://www.raiplay.it/"));
});

test("una piattaforma che non sappiamo aprire ripiega su TMDB", () => {
  const destination = streamingDestination({
    providerName: "Piattaforma X",
    deepLinks: {},
    titleName: "Qualcosa",
    tmdbId: 1234,
    isSeries: true,
  });

  assert.equal(destination.url, "https://www.themoviedb.org/tv/1234/watch?locale=IT");
  assert.equal(destination.source, "tmdbWatchPage");

  // Senza nemmeno l'id TMDB non si promette niente: il tasto sparisce.
  assert.equal(
    streamingDestination({ providerName: "Piattaforma X", deepLinks: {}, titleName: "Qualcosa", isSeries: true }),
    null,
  );
});

test("i nomi lunghi si collassano", () => {
  assert.equal(providerBaseName("Apple TV Amazon Channel"), "Apple TV");
  assert.equal(providerBaseName("Netflix"), "Netflix");
  assert.equal(providerBaseName("  Disney Plus  "), "Disney Plus");
});

test("una piattaforma senza ricerca funzionante ripiega su TMDB, non su un 404", () => {
  // REGRESSIONE — i modelli di Disney+, NOW, Sky Go, Mediaset Infinity e
  // discovery+ rispondevano 404 (verificato l'8/9/2026): il tasto portava sulla
  // pagina di errore della piattaforma, indistinguibile da un bug di Somto.
  for (const nome of ["Disney Plus", "Now TV", "Sky Go", "Mediaset Infinity", "discovery+", "TIMVISION"]) {
    const destination = streamingDestination({
      providerName: nome,
      deepLinks: {},
      titleName: "Un titolo",
      tmdbId: 1234,
      isSeries: true,
    });
    assert.equal(destination.source, "tmdbWatchPage", `${nome} doveva ripiegare su TMDB`);
  }
});

test("Apple TV cerca nel catalogo italiano", () => {
  // Senza il paese Apple redirige su /us/.
  const destination = streamingDestination({
    providerName: "Apple TV",
    deepLinks: {},
    titleName: "Severance",
    tmdbId: 95396,
    isSeries: true,
  });

  assert.equal(destination.url, "https://tv.apple.com/it/search?term=Severance");
});
