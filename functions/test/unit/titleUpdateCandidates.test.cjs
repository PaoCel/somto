const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildTmdbReleaseCandidates,
  buildTmdbTitleUpdateCandidates,
  buildTmdbVideoCandidates,
  makeTmdbReleaseCandidateId,
  makeTmdbVideoCandidateId,
  mergeTmdbVideoPayloads,
} = require("../../lib/titleUpdateCandidates");

function video(key, overrides = {}) {
  return {
    key,
    site: "YouTube",
    type: "Trailer",
    name: `Trailer ${key}`,
    official: true,
    published_at: "2026-07-20T10:00:00.000Z",
    ...overrides,
  };
}

test("unisce italiano, inglese e fallback senza duplicati", () => {
  const result = mergeTmdbVideoPayloads({
    localizedPayload: { results: [video("same", { name: "Trailer italiano" })] },
    englishPayload: {
      results: [
        video("same", { name: "English trailer" }),
        video("english", { name: "English teaser", type: "Teaser" }),
      ],
    },
    fallbackPayload: {
      results: [
        video("same", { name: "Fallback name must not override", iso_639_1: "en" }),
        video("fallback", { iso_639_1: null }),
      ],
    },
  });

  assert.deepEqual(result.map((row) => row.key), ["same", "english", "fallback"]);
  assert.equal(result.find((row) => row.key === "same").name, "Trailer italiano");
  assert.equal(result.find((row) => row.key === "same").locale, "it-IT");
  assert.deepEqual(result.find((row) => row.key === "same").localizedNames, {
    "it-IT": "Trailer italiano",
    "en-US": "English trailer",
  });
  assert.equal(result.find((row) => row.key === "english").locale, "en-US");
  assert.equal(result.find((row) => row.key === "fallback").locale, "und");
});

test("risposta globale usa iso_639_1 quando disponibile", () => {
  const result = mergeTmdbVideoPayloads({
    fallbackPayload: {
      results: [
        video("global-en", { iso_639_1: "en", name: "English global" }),
        video("global-it", { iso_639_1: "it", name: "Italiano globale" }),
      ],
    },
  });

  assert.equal(result.find((row) => row.key === "global-en").locale, "en-US");
  assert.equal(result.find((row) => row.key === "global-it").locale, "it-IT");
});

test("scarta siti e tipi che non sono trailer o teaser YouTube", () => {
  const result = mergeTmdbVideoPayloads({
    localizedPayload: {
      results: [
        video("clip", { type: "Clip" }),
        video("vimeo", { site: "Vimeo" }),
        video("teaser", { type: "Teaser" }),
      ],
    },
  });

  assert.deepEqual(result.map((row) => row.key), ["teaser"]);
  assert.equal(result[0].type, "teaser");
});

test("genera id deterministico separato per film e serie", () => {
  assert.equal(
    makeTmdbVideoCandidateId({ mediaType: "tv", tmdbId: 97546, videoKey: "abc-_123" }),
    "tmdb_video_tv_97546_abc-_123"
  );
  assert.equal(
    makeTmdbVideoCandidateId({ mediaType: "movie", tmdbId: 97546, videoKey: "abc-_123" }),
    "tmdb_video_movie_97546_abc-_123"
  );
  assert.equal(makeTmdbVideoCandidateId({ mediaType: "tv", tmdbId: 0, videoKey: "abc" }), null);
});

test("marca auto-publish solo per video dichiarati ufficiali", () => {
  const candidates = buildTmdbVideoCandidates({
    titleId: "ted-lasso",
    tmdbId: 97546,
    mediaType: "tv",
    localizedPayload: { results: [] },
    englishPayload: { results: [video("english-only", { name: "Official trailer" })] },
    fallbackPayload: {
      results: [
        video("official"),
        video("unverified", { official: false, type: "Teaser" }),
      ],
    },
  });

  assert.equal(candidates.length, 3);
  assert.equal(candidates.find((row) => row.sourceId === "official").autoPublishEligible, true);
  assert.equal(candidates.find((row) => row.sourceId === "unverified").autoPublishEligible, false);
  assert.equal(candidates.find((row) => row.sourceId === "english-only").sourceLocale, "en-US");
  assert.equal(candidates[0].titleId, "ted-lasso");
  assert.equal(candidates[0].source, "tmdb");
});

test("non produce candidati senza titolo o tmdb id valido", () => {
  assert.deepEqual(buildTmdbVideoCandidates({ tmdbId: 1, fallbackPayload: { results: [video("x")] } }), []);
  assert.deepEqual(buildTmdbVideoCandidates({ titleId: "x", tmdbId: null, fallbackPayload: { results: [video("x")] } }), []);
});

test("genera una release film IT bilingue con id stabile anche se cambia data", () => {
  const base = {
    titleId: "film-x",
    tmdbId: 42,
    mediaType: "movie",
    localizedDetails: { release_date: "2026-10-02" },
    englishDetails: { release_date: "2026-10-03" },
    releaseDatesPayload: {
      results: [{
        iso_3166_1: "IT",
        release_dates: [{ type: 3, release_date: "2026-10-09T00:00:00.000Z" }],
      }],
    },
  };
  const first = buildTmdbReleaseCandidates(base)[0];
  const moved = buildTmdbReleaseCandidates({
    ...base,
    localizedDetails: { release_date: "2026-11-06" },
  })[0];

  assert.equal(first.id, "tmdb_release_movie_42");
  assert.equal(moved.id, first.id);
  assert.equal(first.effectiveDate, "2026-10-09");
  assert.equal(first.region, "IT");
  assert.deepEqual(first.headlineByLocale, {
    "it-IT": "Data di uscita in Italia aggiornata",
    "en-US": "Italian release date updated",
  });
  assert.equal(first.autoPublishEligible, true);
});

test("data film generica senza conferma IT richiede revisione", () => {
  const candidate = buildTmdbReleaseCandidates({
    titleId: "film-x",
    tmdbId: 43,
    mediaType: "movie",
    englishDetails: { release_date: "2026-10-03" },
    releaseDatesPayload: { results: [] },
  })[0];

  assert.equal(candidate.effectiveDate, "2026-10-03");
  assert.equal(candidate.region, null);
  assert.equal(candidate.autoPublishEligible, false);
  assert.equal(candidate.reviewReason, "missing_it_release_date");
  assert.equal(candidate.confidence, 0.6);
});

test("genera prossimo episodio con nomi IT/EN solo per le stesse coordinate", () => {
  const candidates = buildTmdbReleaseCandidates({
    titleId: "ted-lasso",
    tmdbId: 97546,
    mediaType: "tv",
    localizedDetails: {
      next_episode_to_air: {
        season_number: 4,
        episode_number: 1,
        air_date: "2026-09-15",
        name: "Si ricomincia",
      },
    },
    englishDetails: {
      next_episode_to_air: {
        season_number: 4,
        episode_number: 1,
        air_date: "2026-09-15",
        name: "Back Again",
      },
    },
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, "tmdb_release_tv_97546_s4_e1");
  assert.equal(candidates[0].eventType, "new_episode");
  assert.equal(candidates[0].effectiveDate, "2026-09-15");
  assert.deepEqual(candidates[0].entityNameByLocale, {
    "it-IT": "Si ricomincia",
    "en-US": "Back Again",
  });
  assert.equal(candidates[0].headlineByLocale["en-US"], "New episode: Back Again");
});

test("non mescola il nome inglese quando TMDB restituisce un altro episodio", () => {
  const candidate = buildTmdbReleaseCandidates({
    titleId: "show",
    tmdbId: 9,
    mediaType: "tv",
    localizedDetails: {
      next_episode_to_air: { season_number: 2, episode_number: 3, air_date: "2026-09-15", name: "Titolo IT" },
    },
    englishDetails: {
      next_episode_to_air: { season_number: 2, episode_number: 4, air_date: "2026-09-22", name: "Wrong episode" },
    },
  })[0];

  assert.deepEqual(candidate.entityNameByLocale, { "it-IT": "Titolo IT" });
  assert.equal(candidate.headlineByLocale["en-US"], "New episode: S2E3");
});

test("combina video e release nel contratto titolo", () => {
  const candidates = buildTmdbTitleUpdateCandidates({
    titleId: "movie",
    tmdbId: 88,
    mediaType: "movie",
    englishPayload: { results: [video("trailer-88")] },
    englishDetails: { release_date: "2026-12-18" },
    releaseDatesPayload: {
      results: [{ iso_3166_1: "IT", release_dates: [{ type: 4, release_date: "2026-12-20T00:00:00Z" }] }],
    },
  });

  assert.deepEqual(candidates.map((row) => row.eventType).sort(), ["release_date", "trailer"]);
  assert.equal(makeTmdbReleaseCandidateId({ mediaType: "movie", tmdbId: 88 }), "tmdb_release_movie_88");
});
