const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildOfficialSourceDraft,
  classifyOfficialAnnouncement,
  decodeHtmlEntities,
  extractArticleLinks,
  extractLocUrls,
  extractTitleHints,
  mergeSeenUrls,
  mergeUnmatchedAnnouncements,
  normalizeOfficialSourceUrl,
  parseOfficialArticle,
  resolveArticleTitle,
  seasonNumberFromArticle,
  sourceIdForUrl,
} = require("../../lib/officialSourceIngestion");
const { officialSourceIngestionEnabled } = require("../../modules/officialUpdates");

const onlyMurdersUrl = "https://press.disney.co.uk/news/only-murders-season-six";

test("accetta soltanto articoli HTTPS dai path ufficiali allowlisted", () => {
  assert.equal(normalizeOfficialSourceUrl(`${onlyMurdersUrl}?utm_source=x#top`), onlyMurdersUrl);
  assert.equal(normalizeOfficialSourceUrl("https://press.hulu.com/pressrelease/show-renewed/"), "https://press.hulu.com/pressrelease/show-renewed");
  assert.equal(normalizeOfficialSourceUrl("https://press.disney.co.uk/gallery/show"), "");
  assert.equal(normalizeOfficialSourceUrl("https://evil.example/news/show"), "");
  assert.equal(normalizeOfficialSourceUrl("http://press.disney.co.uk/news/show"), "");
  assert.equal(normalizeOfficialSourceUrl("https://user:pass@press.disney.co.uk/news/show"), "");
});

test("source id e deduplica URL sono deterministici", () => {
  const first = sourceIdForUrl(onlyMurdersUrl);
  assert.equal(first.length, 24);
  assert.equal(sourceIdForUrl(`${onlyMurdersUrl}?tracking=1`), first);
  assert.deepEqual(mergeSeenUrls([onlyMurdersUrl], [`${onlyMurdersUrl}?x=1`]), [onlyMurdersUrl]);
});

test("gli annunci senza match restano nel report senza duplicarsi", () => {
  const previous = [{ url: onlyMurdersUrl, headline: "Titolo precedente", detectedAtMs: 10 }];
  const rows = mergeUnmatchedAnnouncements(previous, [{
    status: "unmatched",
    url: `${onlyMurdersUrl}?tracking=1`,
    article: { headline: "Titolo aggiornato" },
  }], 20);
  assert.deepEqual(rows, [{ url: onlyMurdersUrl, headline: "Titolo aggiornato", detectedAtMs: 20 }]);
});

test("decodifica sitemap e link senza accettare host o path laterali", () => {
  assert.deepEqual(extractLocUrls(`
    <urlset><url><loc>${onlyMurdersUrl}</loc></url>
    <url><loc>https://press.disney.co.uk/news/a&amp;b</loc></url></urlset>
  `), [onlyMurdersUrl, "https://press.disney.co.uk/news/a&b"]);
  assert.deepEqual(extractArticleLinks(`
    <a href="/pressrelease/show-renewed/">A</a>
    <a href="https://press.hulu.com/shows/show/">B</a>
    <a href="https://evil.example/pressrelease/no">C</a>
  `, "hulu_press"), ["https://press.hulu.com/pressrelease/show-renewed"]);
  assert.equal(decodeHtmlEntities("A &amp; B &#39;C&#39;"), "A & B 'C'");
  assert.equal(decodeHtmlEntities("fuori range: &#99999999;"), "fuori range: ");
});

test("parsa il NewsArticle Disney e conserva solo il canonical ufficiale", () => {
  const html = `
    <meta property="og:url" content="${onlyMurdersUrl}">
    <script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      headline: "DISNEY+ RENEWS “ONLY MURDERS IN THE BUILDING” FOR A SIXTH SEASON",
      datePublished: "2025-10-28T10:00:00Z",
      description: "The comedy returns for ten episodes in the United Kingdom.",
      mainEntityOfPage: onlyMurdersUrl,
    })}</script>`;
  const article = parseOfficialArticle(html, onlyMurdersUrl);
  assert.equal(article.provider, "disney_press_uk");
  assert.equal(article.headline, "DISNEY+ RENEWS “ONLY MURDERS IN THE BUILDING” FOR A SIXTH SEASON");
  assert.equal(article.publishedAtMs, Date.parse("2025-10-28T10:00:00Z"));
});

test("accetta il canonical JSON-LD nel formato oggetto Schema.org", () => {
  const article = parseOfficialArticle(`
    <script type="application/ld+json">${JSON.stringify({
      "@type": "NewsArticle",
      headline: "Show renewed for season 2",
      mainEntityOfPage: { "@id": onlyMurdersUrl },
    })}</script>
  `, onlyMurdersUrl);
  assert.equal(article.sourceUrl, onlyMurdersUrl);
});

test("parsa il fallback OpenGraph/data di Hulu", () => {
  const url = "https://press.hulu.com/pressrelease/show-renewed";
  const article = parseOfficialArticle(`
    <meta property="og:title" content="Hulu Renews &quot;The Show&quot; for Season 3">
    <meta property="og:description" content="A third season is official.">
    <meta property="og:url" content="${url}">
    <span class="posted-on">August 20, 2026</span>
  `, url);
  assert.equal(article.provider, "hulu_press");
  assert.equal(article.headline, 'Hulu Renews "The Show" for Season 3');
  assert.equal(article.publishedAtMs, Date.parse("August 20, 2026"));
});

test("rifiuta canonical che esce dall'host ufficiale", () => {
  assert.throws(() => parseOfficialArticle(`
    <meta property="og:title" content="Show renewed">
    <meta property="og:url" content="https://evil.example/news/show">
  `, onlyMurdersUrl), /Canonical fuori/);
});

test("classifica solo tipi editoriali espliciti", () => {
  assert.equal(classifyOfficialAnnouncement({ headline: "Disney renews Show for a third season" }), "renewal");
  assert.equal(classifyOfficialAnnouncement({ headline: "Show cancelled after two seasons" }), "cancellation");
  assert.equal(classifyOfficialAnnouncement({ headline: "Show season 3 premieres November 20" }), "new_season");
  assert.equal(classifyOfficialAnnouncement({ headline: "Actor joins the cast of Show" }), "casting");
  assert.equal(classifyOfficialAnnouncement({ headline: "Stars attend a gala screening" }), null);
});

test("estrae numero stagione inglese e italiano per la deduplica", () => {
  assert.equal(seasonNumberFromArticle({ headline: "Show renewed for season 6" }), 6);
  assert.equal(seasonNumberFromArticle({ headline: "Show renewed for a sixth season" }), 6);
  assert.equal(seasonNumberFromArticle({ description: "rinnovata per una sesta stagione" }), 6);
});

test("estrae prima i titoli fra virgolette e poi suffissi prudenti", () => {
  const hints = extractTitleHints({
    headline: 'DISNEY+ RENEWS "ONLY MURDERS IN THE BUILDING" FOR A SIXTH SEASON',
  });
  assert.equal(hints[0].normalized, "only murders in the building");

  const rivals = extractTitleHints({ headline: "TRIUMPHANT HIT DRAMA RIVALS GREENLIT FOR A THIRD SEASON" });
  assert.ok(rivals.some((hint) => hint.normalized === "rivals"));

  assert.deepEqual(extractTitleHints({ headline: "Actor joins the cast of Show" }), []);
});

test("risolve il titolo solo con match esatto approvato e del tipo corretto", async () => {
  const titleDoc = {
    id: "only-murders",
    data: () => ({ status: "approved", type: "tv", name: "Only Murders in the Building" }),
  };
  const db = {
    collection(name) {
      assert.equal(name, "titles");
      return {
        where(field, op, value) {
          assert.equal(op, "==");
          const query = {
            limit: () => query,
            get: async () => ({
              docs: (field === "search.normalized" && value === "only murders in the building") ? [titleDoc] : [],
            }),
          };
          return query;
        },
      };
    },
  };
  const match = await resolveArticleTitle(db, {
    headline: 'Disney renews "Only Murders in the Building" for season 6',
  });
  assert.equal(match.id, "only-murders");
});

test("la bozza porta un warning visibile e non abilita notifiche", () => {
  const article = {
    provider: "disney_press_uk",
    sourceName: "Disney UK Press",
    sourceUrl: onlyMurdersUrl,
    sourceId: sourceIdForUrl(onlyMurdersUrl),
    headline: 'Disney renews "Only Murders in the Building" for season 6',
    description: "Ten episodes in the United Kingdom.",
    publishedAtMs: Date.parse("2025-10-28"),
  };
  const draft = buildOfficialSourceDraft(article, {
    id: "only-murders",
    name: "Only Murders in the Building",
    matchedHint: "Only Murders in the Building",
  });
  assert.match(draft.title, /^Da rivedere:/);
  assert.match(draft.text, /riscrivi il testo prima di pubblicare/i);
  assert.equal(draft.status, "draft");
  assert.equal(draft.notificationsEnabled, false);
  assert.equal(draft.ingestion.reviewRequired, true);
  // Lo slug deve gia' essere normalizzato: il merge `ingestion` scrive sullo
  // stesso doc della bozza, non su un id con underscore.
  assert.equal(draft.slug, `source-disney-press-uk-${sourceIdForUrl(onlyMurdersUrl)}`);
});

test("kill switch fonti ufficiali è prod-only ma sovrascrivibile", () => {
  assert.equal(officialSourceIngestionEnabled({ GCLOUD_PROJECT: "gia-visto" }), true);
  assert.equal(officialSourceIngestionEnabled({ GCLOUD_PROJECT: "somto-staging" }), false);
  assert.equal(officialSourceIngestionEnabled({ GCLOUD_PROJECT: "gia-visto", OFFICIAL_SOURCE_INGESTION_ENABLED: "false" }), false);
  assert.equal(officialSourceIngestionEnabled({ GCLOUD_PROJECT: "somto-staging", OFFICIAL_SOURCE_INGESTION_ENABLED: "true" }), true);
});
