const test = require("node:test");
const assert = require("node:assert/strict");
const {
  sanitizeHttpUrl,
  normalizeProviderRows,
  normalizeCustomProviders,
  normalizeProvidersForRegion,
  hasAnyProvidersBundle,
} = require("../../lib/watchProviders");

test("sanitizeHttpUrl keeps only http/https URLs", () => {
  assert.equal(sanitizeHttpUrl("https://example.com/x"), "https://example.com/x");
  assert.equal(sanitizeHttpUrl("http://example.com/x"), "http://example.com/x");
  assert.equal(sanitizeHttpUrl("javascript:alert(1)"), "");
  assert.equal(sanitizeHttpUrl(""), "");
});

test("normalizeProviderRows deduplicates and enriches provider rows", () => {
  const out = normalizeProviderRows([
    { provider_id: 8, provider_name: "Netflix", logo_path: "/abc.png", display_priority: 2 },
    { provider_id: 8, provider_name: "Netflix duplicate", logo_path: "/dup.png", display_priority: 9 },
    { provider_id: 337, provider_name: "Disney+", logo_path: "/def.png", display_priority: 3 },
  ]);

  assert.equal(out.length, 2);
  assert.equal(out[0].providerId, 8);
  assert.equal(out[0].name, "Netflix");
  assert.match(out[0].logoUrl, /^https:\/\/image\.tmdb\.org\/t\/p\/w154\//);
});

test("normalizeProvidersForRegion extracts IT bundle and availability", () => {
  const payload = {
    results: {
      IT: {
        link: "https://www.themoviedb.org/movie/1/watch",
        flatrate: [{ provider_id: 8, provider_name: "Netflix", logo_path: "/a.png" }],
        rent: [],
      },
    },
  };

  const bundle = normalizeProvidersForRegion(payload, "IT");
  assert.equal(bundle.region, "IT");
  assert.equal(bundle.link, "https://www.themoviedb.org/movie/1/watch");
  assert.equal(bundle.flatrate.length, 1);
  assert.equal(hasAnyProvidersBundle(bundle), true);
});

test("normalizeCustomProviders keeps admin suggestions with safe URL", () => {
  const out = normalizeCustomProviders([
    { name: "Piattaforma locale", url: "https://example.com/watch", note: "Admin", by: "admin" },
    { name: "Unsafe", url: "javascript:alert(1)" },
    { name: "", url: "https://example.com/empty" },
  ]);

  assert.equal(out.length, 2);
  assert.equal(out[0].name, "Piattaforma locale");
  assert.equal(out[0].url, "https://example.com/watch");
  assert.equal(out[1].url, "");
});

