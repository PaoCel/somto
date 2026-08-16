const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildTmdbUpdateRequestPlan,
  filterCandidatesByWindow,
  normalizeTitleForUpdateScan,
  scanTitleForUpdateCandidates,
  summarizeTitleUpdateScan,
} = require("../../lib/titleUpdateScanner");

test("normalizza tmdbId legacy e costruisce sei richieste IT/EN/global", () => {
  const title = normalizeTitleForUpdateScan({ id: "ted", type: "tv", meta: { tmdbId: 97546 } });
  const plan = buildTmdbUpdateRequestPlan(title);

  assert.equal(title.tmdbId, 97546);
  assert.equal(plan.length, 6);
  assert.deepEqual(plan.map((row) => row.params.language || "global"), [
    "it-IT", "en-US", "global", "it-IT", "en-US", "global",
  ]);
  assert.equal(plan[0].path, "/tv/97546/videos");
  assert.equal(plan[5].path, "/tv/97546");
});

test("per un film aggiunge la richiesta release_dates regionale", () => {
  const plan = buildTmdbUpdateRequestPlan({ id: "movie", type: "movie", tmdbId: 12 });
  assert.equal(plan.length, 7);
  assert.deepEqual(plan[6], { key: "releaseDatesPayload", path: "/movie/12/release_dates", params: {} });
});

test("scanner aggrega risposte senza scrivere e conserva errori parziali", async () => {
  const calls = [];
  const result = await scanTitleForUpdateCandidates({
    title: { id: "film", type: "movie", tmdbId: 12 },
    fetchJson: async (path, params) => {
      calls.push({ path, params });
      if (path.endsWith("/videos") && params.language === "it-IT") throw new Error("TMDB temporaneamente non disponibile");
      if (path.endsWith("/videos") && params.language === "en-US") {
        return { results: [{ key: "eng", site: "YouTube", type: "Trailer", name: "Official Trailer", official: true, published_at: "2026-07-20T10:00:00Z" }] };
      }
      if (!path.endsWith("/videos") && params.language === "en-US") return { release_date: "2026-08-10" };
      if (path.endsWith("/release_dates")) {
        return { results: [{ iso_3166_1: "IT", release_dates: [{ type: 3, release_date: "2026-08-12T00:00:00Z" }] }] };
      }
      return {};
    },
  });

  assert.equal(calls.length, 7);
  assert.equal(result.errors.length, 1);
  assert.deepEqual(result.candidates.map((row) => row.eventType).sort(), ["release_date", "trailer"]);
  assert.equal(result.candidates.find((row) => row.eventType === "trailer").sourceLocale, "en-US");
});

test("finestra temporale esclude candidati vecchi, futuri e senza data", () => {
  const sinceMs = Date.parse("2026-01-01T00:00:00Z");
  const untilMs = Date.parse("2026-12-31T23:59:59Z");
  const rows = [
    { id: "old", publishedAt: "2025-12-31T00:00:00Z" },
    { id: "video", publishedAt: "2026-07-01T00:00:00Z" },
    { id: "release", effectiveDate: "2026-10-10" },
    { id: "future", effectiveDate: "2027-01-01" },
    { id: "undated" },
  ];
  assert.deepEqual(filterCandidatesByWindow(rows, { sinceMs, untilMs }).map((row) => row.id), ["video", "release"]);
});

test("report separa auto-publish, review, tipi, lingue ed errori", () => {
  const results = [{
    title: { id: "t1" },
    errors: [{ request: "localizedPayload", message: "x" }],
    candidates: [
      { eventType: "trailer", availableLocales: ["en-US"], publishedAt: "2026-07-01", autoPublishEligible: true },
      { eventType: "teaser", availableLocales: ["it-IT", "en-US"], publishedAt: "2025-01-01", autoPublishEligible: false },
    ],
  }];
  const summary = summarizeTitleUpdateScan(results, {
    sinceMs: Date.parse("2026-01-01"),
    untilMs: Date.parse("2026-12-31"),
    apiCalls: 6,
  });

  assert.equal(summary.readOnly, true);
  assert.equal(summary.titlesScanned, 1);
  assert.equal(summary.candidatesFound, 2);
  assert.equal(summary.recentCandidates, 1);
  assert.equal(summary.autoPublishEligible, 1);
  assert.equal(summary.reviewRequired, 1);
  assert.equal(summary.requestErrors, 1);
  assert.deepEqual(summary.byType, { trailer: 1, teaser: 1 });
  assert.deepEqual(summary.byLocale, { "en-US": 2, "it-IT": 1 });
});
