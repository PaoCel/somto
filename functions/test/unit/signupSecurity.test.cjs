const test = require("node:test");
const assert = require("node:assert/strict");

const {
  aggregateActivationTiming,
  aggregateSignupLifecycleMetrics,
  classifySignupLifecycle,
  claimsWithoutLegacyBypass,
  emailDomain,
  isReservedEmailDomain,
  providerIdsForAuthUser,
  pendingSignupCleanupPlan,
  sanitizeDisplayName,
  sanitizeSignupAttribution,
} = require("../../lib/signupSecurity");

test("classifica provider Firebase senza duplicati", () => {
  assert.deepEqual(providerIdsForAuthUser({
    providerData: [
      { providerId: "password" },
      { providerId: "google.com" },
      { providerId: "google.com" },
    ],
  }), ["password", "google.com"]);
  assert.deepEqual(providerIdsForAuthUser(null), []);
});

test("valida nome e minimizza attribution", () => {
  assert.deepEqual(sanitizeDisplayName("  Paolo Cèl!  "), {
    displayName: "Paolo_Cel",
    displayNameLower: "paolo_cel",
  });
  assert.equal(sanitizeDisplayName("x"), null);

  assert.deepEqual(sanitizeSignupAttribution({
    surface: "web",
    appVersion: " 1.7.2 beta<script> ",
    landingPath: "/quiz?token=secret#fragment",
    referrerHost: "https://News.Example.COM/path?q=secret",
    utmSource: "newsletter / summer",
    analyticsConsent: true,
    selfReportedSource: "word_of_mouth",
  }), {
    surface: "web",
    appVersion: "1.7.2betascript",
    landingPath: "/quiz",
    referrerHost: "news.example.com",
    utmSource: "newslettersummer",
    utmMedium: null,
    utmCampaign: null,
    language: null,
    analyticsConsent: true,
    selfReportedSource: "word_of_mouth",
  });
});

test("riconosce i domini IANA riservati senza colpire domini simili", () => {
  for (const value of [
    "probe@example.com",
    "example.net",
    "mail.example.org",
    "probe@domain.invalid",
    "probe@qa.test",
    "probe@app.localhost",
  ]) {
    assert.equal(isReservedEmailDomain(value), true, value);
  }
  assert.equal(isReservedEmailDomain("user@example.co"), false);
  assert.equal(isReservedEmailDomain("user@invalid.example.com.evil.tld"), false);
  assert.equal(emailDomain(" User@Example.COM. "), "example.com");
});

test("classifica gli stati lifecycle senza dedurre active dal solo profilo", () => {
  assert.equal(classifySignupLifecycle({ authPresent: false, profilePresent: true }), "orphan_profile");
  assert.equal(classifySignupLifecycle({ authPresent: true, profilePresent: false, providerIds: ["google.com"], emailVerified: true }), "auth_only");
  assert.equal(classifySignupLifecycle({ authPresent: true, profilePresent: false, providerIds: ["password"], emailVerified: false }), "pending_verification");
  assert.equal(classifySignupLifecycle({ authPresent: true, profilePresent: true, providerIds: ["password"], emailVerified: false }), "legacy_unverified");
  assert.equal(classifySignupLifecycle({ authPresent: true, profilePresent: true, providerIds: ["google.com"], emailVerified: true }), "active");
  assert.equal(classifySignupLifecycle({ authPresent: false, profilePresent: true, isSynthetic: true }), "synthetic_guided");
  assert.equal(classifySignupLifecycle({ authPresent: false, profilePresent: false, deletionStatus: "completed" }), "deleted");
});

test("rimuove solo il bypass legacy e preserva tutti gli altri claim", () => {
  assert.deepEqual(claimsWithoutLegacyBypass({
    legacyEmailUnverified: true,
    admin: true,
    role: "moderator",
    nested: { enabled: true },
  }), {
    admin: true,
    role: "moderator",
    nested: { enabled: true },
  });
});

test("cleanup pending applica cutoff e salta legacy, admin e provider social", () => {
  const nowMs = Date.parse("2026-08-22T12:00:00Z");
  const old = "2026-08-18T12:00:00Z";
  const recent = "2026-08-21T12:00:00Z";
  const password = (uid, creationTime, claims = {}) => ({
    uid,
    emailVerified: false,
    providerData: [{ providerId: "password" }],
    customClaims: claims,
    metadata: { creationTime },
  });
  const plan = pendingSignupCleanupPlan([
    password("eligible", old),
    password("recent", recent),
    password("legacy", old, { legacyEmailUnverified: true }),
    password("admin", old, { admin: true }),
    { uid: "google", emailVerified: true, providerData: [{ providerId: "google.com" }], metadata: { creationTime: old } },
  ], { nowMs, maxRatio: 1 });

  assert.deepEqual(plan.candidates.map((row) => row.uid), ["eligible"]);
  assert.equal(plan.skipped.recent, 1);
  assert.equal(plan.skipped.legacy, 1);
  assert.equal(plan.skipped.admin, 1);
  assert.equal(plan.skipped.nonPassword, 1);
});

test("cleanup pending apre il circuit breaker assoluto o percentuale", () => {
  const accounts = Array.from({ length: 10 }, (_, index) => ({
    uid: `u${index}`,
    emailVerified: false,
    providerData: [{ providerId: "password" }],
    metadata: { creationTime: "2026-08-01T00:00:00Z" },
  }));
  const absolute = pendingSignupCleanupPlan(accounts, {
    nowMs: Date.parse("2026-08-22T00:00:00Z"),
    maxAbsolute: 5,
    maxRatio: 1,
  });
  const ratio = pendingSignupCleanupPlan(accounts.slice(0, 2), {
    nowMs: Date.parse("2026-08-22T00:00:00Z"),
    maxAbsolute: 10,
    maxRatio: 0.5,
  });
  assert.equal(absolute.circuitBreakerReason, "absolute-threshold");
  assert.equal(ratio.circuitBreakerReason, "ratio-threshold");
});

test("metriche lifecycle aggregano conversione, mediana e unknown senza PII", () => {
  const metrics = aggregateSignupLifecycleMetrics([
    {
      authPresent: true,
      profilePresent: false,
      providerIds: ["password"],
      emailVerified: false,
      pendingStatus: "pending",
      surface: "web",
      reservedEmailDomain: true,
      pendingCreatedAtMs: 1000,
    },
    {
      authPresent: true,
      profilePresent: true,
      providerIds: ["password"],
      emailVerified: true,
      pendingStatus: "completed",
      surface: "ios",
      pendingCreatedAtMs: 1000,
      pendingCompletedAtMs: 5000,
    },
    {
      authPresent: true,
      profilePresent: true,
      providerIds: ["google.com"],
      emailVerified: true,
      surface: "unknown",
      deletionSource: "self-serve",
      deletionStatus: "completed",
    },
    {
      authPresent: false,
      profilePresent: false,
      deletionStatus: "completed",
      deletionSource: "pending-expiry",
    },
  ]);

  assert.equal(metrics.population, 4);
  assert.equal(metrics.authCreatedCount, 3);
  assert.equal(metrics.pendingToCompletedRate, 0.5);
  assert.equal(metrics.medianVerificationMs, 4000);
  assert.equal(metrics.lifecycleCounts.pending_verification, 1);
  assert.equal(metrics.providerCounts.password, 2);
  assert.equal(metrics.deletionSourceCounts["self-serve"], 1);
  assert.equal(metrics.reservedDomainCount, 1);
  assert.equal(metrics.expiredCount, 1);
  assert.equal(metrics.deletionCompletedCount, 2);
  assert.equal(Math.round(metrics.unknownAttributionRate * 100), 50);
  assert.equal(JSON.stringify(metrics).includes("@"), false);
});

test("tempo alla prima azione ignora righe incomplete e calcola la mediana", () => {
  const metrics = aggregateActivationTiming([
    { createdAtMs: 1_000, firstUsefulAtMs: 3_000 },
    { createdAtMs: 1_000, firstUsefulAtMs: 10_000 },
    { createdAtMs: 1_000, firstUsefulAtMs: 5_000 },
    { createdAtMs: 1_000, firstUsefulAtMs: 0 },
  ]);
  assert.deepEqual(metrics, {
    population: 4,
    observedCount: 3,
    medianFirstUsefulMs: 4_000,
  });
});

// --- migrazione morbida della verifica email (2026-08-29) -----------------
//
// La regola decisa: nessun blocco, 30 giorni di tempo, e solo per chi e'
// entrato con email e password. Passata la scadenza, al prossimo ingresso
// l'account viene raccontato ai client come "da verificare" — che e' uno
// stato che web e iOS gia' sanno gestire, quindi non serve una nuova build.

const {
  isVerificationGraceExpired,
  parseVerificationGraceUntil,
} = require("../../lib/signupSecurity");

const GRACE = Date.parse("2026-09-28T00:00:00Z");
const PRIMA = Date.parse("2026-09-01T00:00:00Z");
const DOPO = Date.parse("2026-10-01T00:00:00Z");

test("dentro i 30 giorni resta un invito, non un blocco", () => {
  assert.equal(isVerificationGraceExpired({
    lifecycleStatus: "legacy_unverified",
    providerIds: ["password"],
    emailVerified: false,
    graceUntilMs: GRACE,
    nowMs: PRIMA,
  }), false);
});

test("dopo la scadenza si chiede la verifica", () => {
  assert.equal(isVerificationGraceExpired({
    lifecycleStatus: "legacy_unverified",
    providerIds: ["password"],
    emailVerified: false,
    graceUntilMs: GRACE,
    nowMs: DOPO,
  }), true);
});

test("chi entra con Google o Apple non viene mai toccato", () => {
  for (const provider of ["google.com", "apple.com"]) {
    assert.equal(isVerificationGraceExpired({
      lifecycleStatus: "legacy_unverified",
      providerIds: [provider],
      emailVerified: false,
      graceUntilMs: GRACE,
      nowMs: DOPO,
    }), false, `${provider} non deve ricevere la richiesta di verifica`);
  }
});

test("chi ha gia' verificato non viene disturbato", () => {
  assert.equal(isVerificationGraceExpired({
    lifecycleStatus: "active",
    providerIds: ["password"],
    emailVerified: true,
    graceUntilMs: GRACE,
    nowMs: DOPO,
  }), false);
});

test("senza scadenza configurata non cambia niente per nessuno", () => {
  assert.equal(isVerificationGraceExpired({
    lifecycleStatus: "legacy_unverified",
    providerIds: ["password"],
    emailVerified: false,
    graceUntilMs: 0,
    nowMs: DOPO,
  }), false);
  assert.equal(parseVerificationGraceUntil(""), 0);
  assert.equal(parseVerificationGraceUntil("non una data"), 0);
  assert.equal(parseVerificationGraceUntil("2026-09-28T00:00:00Z"), GRACE);
});

test("una registrazione appena iniziata non e' un legacy scaduto", () => {
  // `pending_verification` e' gia' il flusso nuovo: la finestra morbida vale
  // solo per chi un profilo ce l'ha gia'.
  assert.equal(isVerificationGraceExpired({
    lifecycleStatus: "pending_verification",
    providerIds: ["password"],
    emailVerified: false,
    graceUntilMs: GRACE,
    nowMs: DOPO,
  }), false);
});
