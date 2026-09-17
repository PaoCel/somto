const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PROPERTIES,
  buildQuery,
  buildLinksFromBindings,
  canonicalProvider,
  filterByAvailability,
  queryWikidata,
} = require("../../lib/wikidataStreamingLinks");

// I link diretti alle piattaforme, presi da Wikidata.
//
// Cosa si copre — le cose che, sbagliate, mandano un utente nel posto sbagliato:
// il confine fra "dove si vede" e "dove porta il bottone", la forma degli URL, e
// il fatto che un guasto di Wikidata non diventi un guasto di Somto.

test("la query lega l'id TMDB alla proprieta' giusta per tipo", () => {
  assert.match(buildQuery([1396], "tv"), /wdt:P4983/);
  assert.match(buildQuery([438631], "movie"), /wdt:P4947/);
  // Tutte le proprieta' sono OPTIONAL: un titolo che ha solo Netflix deve
  // tornare lo stesso, non sparire perche' gli manca Disney+.
  for (const property of PROPERTIES) {
    assert.match(buildQuery([1], "tv"), new RegExp(`OPTIONAL \\{ \\?item wdt:${property.pid}`));
  }
  assert.equal(buildQuery([], "tv"), null);
  assert.equal(buildQuery(["non-un-numero"], "tv"), null);
});

test("dagli id agli URL, uno per piattaforma", () => {
  const links = buildLinksFromBindings([{
    tmdb: { value: "1396" },
    netflix: { value: "70143836" },
    appleShow: { value: "umc.cmc.1v90fu25sgywa1e14jwnrt9uc" },
  }]);

  assert.deepEqual(links.get("1396"), {
    Netflix: "https://www.netflix.com/title/70143836",
    "Apple TV": "https://tv.apple.com/show/umc.cmc.1v90fu25sgywa1e14jwnrt9uc",
  });
});

test("quando una piattaforma ha piu' proprieta' vince la piu' specifica", () => {
  // Disney+ ne ha tre: serie, film e "browse". L'ordine in PROPERTIES decide.
  const links = buildLinksFromBindings([{
    tmdb: { value: "82856" },
    disneyBrowse: { value: "entity-422f6dcc" },
    disneySeries: { value: "3jLIGMDYINqD" },
  }]);

  assert.equal(links.get("82856")["Disney Plus"], "https://www.disneyplus.com/series/wp/3jLIGMDYINqD");
});

// --- il confine che tiene in piedi tutto ------------------------------------

test("un link a una piattaforma che qui non ha il titolo non passa", () => {
  // L'id Netflix di un titolo ESISTE anche dove Netflix non lo ha in catalogo:
  // e' un id globale. Chi decide cosa mostrare sono i watch provider TMDB, che
  // sono per regione. Senza questo filtro, il bottone "Guarda su Netflix"
  // comparirebbe su titoli che in Italia stanno altrove.
  const links = {
    Netflix: "https://www.netflix.com/title/70143836",
    "Apple TV": "https://tv.apple.com/show/umc.cmc.x",
  };

  assert.deepEqual(filterByAvailability(links, ["Apple TV"]), {
    "Apple TV": "https://tv.apple.com/show/umc.cmc.x",
  });
  assert.deepEqual(filterByAvailability(links, []), {});
  assert.deepEqual(filterByAvailability(links, ["Rai Play"]), {});
});

test("un servizio comprato dentro Amazon resta quel servizio", () => {
  // Ted Lasso: TMDB elenca "Apple TV" E "Apple TV Amazon Channel". Il secondo
  // e' solo il modo in cui lo paghi, la serie e' di Apple.
  assert.equal(canonicalProvider("Apple TV Amazon Channel"), "Apple TV");
  assert.equal(canonicalProvider("Paramount Plus Amazon Channel"), "Paramount Plus");
  assert.equal(canonicalProvider("Amazon Prime Video with Ads"), null);

  // Il link salvato deve sopravvivere anche se in quella regione il titolo
  // risulta disponibile SOLO come canale.
  const links = { "Apple TV": "https://tv.apple.com/show/umc.cmc.x" };
  assert.deepEqual(filterByAvailability(links, ["Apple TV Amazon Channel"]), links);
});

test("i nomi che TMDB scrive in modo diverso finiscono sulla stessa piattaforma", () => {
  assert.equal(canonicalProvider("Netflix basic with Ads"), "Netflix");
  assert.equal(canonicalProvider("Disney Plus"), "Disney Plus");
  assert.equal(canonicalProvider("Max"), "HBO Max");
  assert.equal(canonicalProvider("Apple TV+"), "Apple TV");
  assert.equal(canonicalProvider("Piattaforma sconosciuta"), null);
});

// --- un guasto di Wikidata non e' un guasto di Somto ------------------------

test("429, timeout o risposta rotta: nessun link, nessuna eccezione", async () => {
  const tooManyRequests = await queryWikidata({
    tmdbIds: [1396],
    mediaType: "tv",
    fetchImpl: async () => ({ ok: false, status: 429 }),
  });
  assert.equal(tooManyRequests, null);

  const boom = await queryWikidata({
    tmdbIds: [1396],
    mediaType: "tv",
    fetchImpl: async () => { throw new Error("rete assente"); },
  });
  assert.equal(boom, null);

  const garbage = await queryWikidata({
    tmdbIds: [1396],
    mediaType: "tv",
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  assert.equal(garbage.size, 0);
});

test("la richiesta si presenta con lo user agent che Wikimedia pretende", async () => {
  let seen = null;
  await queryWikidata({
    tmdbIds: [1396],
    mediaType: "tv",
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return { ok: true, json: async () => ({ results: { bindings: [] } }) };
    },
  });

  assert.match(seen.options.headers["User-Agent"], /Somto/);
  assert.match(seen.options.headers["User-Agent"], /somto\.it/);
  assert.match(seen.url, /query\.wikidata\.org/);
});
