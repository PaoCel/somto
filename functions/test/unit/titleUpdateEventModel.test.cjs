const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildTitleUpdateEventDocument,
  normalizeSourceUrl,
  pickLocalizedText,
} = require("../../lib/titleUpdateEventModel");

const NOW = "2026-08-01T12:00:00.000Z";

function officialTrailer(overrides = {}) {
  return {
    id: "tmdb_video_tv_97546_abc",
    titleId: "ted-lasso",
    tmdbId: 97546,
    mediaType: "tv",
    eventType: "trailer",
    source: "tmdb",
    sourceId: "abc",
    sourceUrl: "https://www.youtube.com/watch?v=abc",
    publishedAt: "2026-07-20T10:00:00.000Z",
    headlineByLocale: { "en-US": "Official Trailer" },
    official: true,
    confidence: 1,
    autoPublishEligible: true,
    ...overrides,
  };
}

test("backfill può popolare la timeline ma non è mai notificabile", () => {
  const event = buildTitleUpdateEventDocument(officialTrailer(), {
    acquisitionMode: "backfill",
    publishEligible: true,
    now: NOW,
  });

  assert.equal(event.id, "tmdb_video_tv_97546_abc");
  assert.equal(event.document.status, "published");
  assert.equal(event.document.notificationEligible, false);
  assert.equal(event.document.sourceTrust, "official");
  assert.deepEqual(event.document.entityNameByLocale, {});
  assert.equal(event.document.effectiveAt, null);
  assert.equal(event.document.reviewReason, null);
  assert.equal(event.document.firstPublishedAt.toISOString(), NOW);
  assert.equal(event.document.sortAt.toISOString(), "2026-07-20T10:00:00.000Z");
});

test("solo evento live pubblicato può essere notificabile", () => {
  const published = buildTitleUpdateEventDocument(officialTrailer(), {
    acquisitionMode: "live",
    publishEligible: true,
    now: NOW,
  });
  const draft = buildTitleUpdateEventDocument(officialTrailer({ official: false, confidence: 0.7 }), {
    acquisitionMode: "live",
    publishEligible: true,
    now: NOW,
  });

  assert.equal(published.document.notificationEligible, true);
  assert.equal(draft.document.status, "draft");
  assert.equal(draft.document.notificationEligible, false);
  assert.equal(draft.document.sourceTrust, "unverified");
});

test("release non confermata per l'Italia resta draft", () => {
  const event = buildTitleUpdateEventDocument({
    id: "tmdb_release_movie_42",
    titleId: "film",
    tmdbId: 42,
    mediaType: "movie",
    eventType: "release_date",
    source: "tmdb",
    sourceId: "movie:42:release",
    sourceUrl: "https://www.themoviedb.org/movie/42",
    effectiveDate: "2026-10-03",
    headlineByLocale: { "it-IT": "Data da verificare", "en-US": "Date requires review" },
    official: false,
    confidence: 0.6,
    autoPublishEligible: false,
    reviewReason: "missing_it_release_date",
  }, { acquisitionMode: "live", publishEligible: true, now: NOW });

  assert.equal(event.document.status, "draft");
  assert.equal(event.document.reviewReason, "missing_it_release_date");
  assert.equal(event.document.effectiveAt.toISOString(), "2026-10-03T12:00:00.000Z");
});

test("rifiuta URL esterni, HTTP, tipi sconosciuti e documenti senza data", () => {
  assert.equal(normalizeSourceUrl("https://evil.example/tracker"), null);
  assert.equal(normalizeSourceUrl("http://youtube.com/watch?v=x"), null);
  assert.equal(normalizeSourceUrl("https://user:secret@youtube.com/watch?v=x"), null);
  assert.equal(normalizeSourceUrl("https://youtube.com:444/watch?v=x"), null);
  assert.throws(() => buildTitleUpdateEventDocument(officialTrailer({ sourceUrl: "https://evil.example/x" })), /sourceUrl/);
  assert.throws(() => buildTitleUpdateEventDocument(officialTrailer({ eventType: "rumor" })), /Tipo evento/);
  assert.throws(() => buildTitleUpdateEventDocument(officialTrailer({ publishedAt: null })), /senza data/);
});

test("fallback lingua usa richiesta, inglese, italiano e poi nessun testo", () => {
  const map = { "it-IT": "Ciao", "en-US": "Hello" };
  assert.deepEqual(pickLocalizedText(map, "it-IT"), { locale: "it-IT", text: "Ciao" });
  assert.deepEqual(pickLocalizedText(map, "en-GB"), { locale: "en-US", text: "Hello" });
  assert.deepEqual(pickLocalizedText({ "it-IT": "Ciao" }, "fr-FR"), { locale: "it-IT", text: "Ciao" });
  assert.deepEqual(pickLocalizedText({ und: "Language unknown" }, "fr-FR"), { locale: "und", text: "Language unknown" });
  assert.equal(pickLocalizedText({}, "en-US"), null);
});
