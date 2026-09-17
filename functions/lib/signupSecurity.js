"use strict";

const RESERVED_EMAIL_DOMAINS = new Set(["example.com", "example.net", "example.org"]);
const RESERVED_EMAIL_SUFFIXES = [".invalid", ".test", ".localhost"];
const PENDING_SIGNUP_RETENTION_HOURS = 72;
const ATTRIBUTION_TEXT_PATTERN = /[^A-Za-z0-9._~-]+/g;
const SELF_REPORTED_SOURCES = new Set(["search", "social", "word_of_mouth", "tv_time", "article", "other"]);

function providerIdsForAuthUser(authUser = {}) {
  const ids = new Set();
  for (const row of Array.isArray(authUser?.providerData) ? authUser.providerData : []) {
    const providerId = String(row?.providerId || "").trim();
    if (providerId) ids.add(providerId);
  }
  return [...ids];
}

function emailDomain(value) {
  const email = String(value || "").trim().toLowerCase();
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).replace(/\.+$/, "") : "";
}

function isReservedEmailDomain(value) {
  const domain = String(value || "").includes("@") ? emailDomain(value) : String(value || "").trim().toLowerCase();
  if (!domain) return false;
  return RESERVED_EMAIL_DOMAINS.has(domain)
    || [...RESERVED_EMAIL_DOMAINS].some((reserved) => domain.endsWith(`.${reserved}`))
    || domain === "invalid"
    || domain === "test"
    || domain === "localhost"
    || RESERVED_EMAIL_SUFFIXES.some((suffix) => domain.endsWith(suffix));
}

function classifySignupLifecycle({
  authPresent = false,
  profilePresent = false,
  providerIds = [],
  emailVerified = false,
  isSynthetic = false,
  pendingStatus = null,
  deletionStatus = null,
} = {}) {
  if (isSynthetic) return "synthetic_guided";
  if (!authPresent && !profilePresent && deletionStatus === "completed") return "deleted";
  if (!authPresent && profilePresent) return "orphan_profile";
  if (authPresent && !profilePresent) {
    if (providerIds.includes("password") && !emailVerified) return "pending_verification";
    return "auth_only";
  }
  if (authPresent && profilePresent && providerIds.includes("password") && !emailVerified) {
    return "legacy_unverified";
  }
  if (authPresent && profilePresent) return "active";
  if (pendingStatus === "pending") return "pending_verification";
  return "unknown";
}

// Migrazione morbida della verifica email (decisa il 2026-08-29).
//
// Nessuno viene bloccato: un account password non verificato resta
// `legacy_unverified` — cioe' un invito, non un cancello — fino alla scadenza.
// Passata quella, lo stesso account viene raccontato ai client come
// `pending_verification`: web e iOS gia' distinguono i due casi e chiedono la
// verifica da soli, quindi la migrazione non richiede una nuova build.
//
// Il social non c'entra mai: Google e Apple portano gia' un'email verificata.
function isVerificationGraceExpired({
  lifecycleStatus = "",
  providerIds = [],
  emailVerified = false,
  graceUntilMs = 0,
  nowMs = Date.now(),
} = {}) {
  if (emailVerified) return false;
  if (!providerIds.includes("password")) return false;
  if (lifecycleStatus !== "legacy_unverified") return false;
  const deadline = Number(graceUntilMs || 0);
  if (!Number.isFinite(deadline) || deadline <= 0) return false;
  return nowMs > deadline;
}

// La scadenza si configura come data ISO. Valore assente o illeggibile =
// nessuna scadenza: si resta nel comportamento morbido di oggi.
function parseVerificationGraceUntil(value) {
  const raw = String(value || "").trim();
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

function sanitizeDisplayName(value) {
  const displayName = String(value || "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/[._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24)
    .replace(/^_+|_+$/g, "");
  if (displayName.length < 3) return null;
  return { displayName, displayNameLower: displayName.toLowerCase() };
}

function safeAttributionText(value, max) {
  const text = String(value || "").trim().replace(ATTRIBUTION_TEXT_PATTERN, "").slice(0, max);
  return text || null;
}

function sanitizeLandingPath(value) {
  const raw = String(value || "").trim();
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  const path = raw.split(/[?#]/, 1)[0].slice(0, 160);
  return /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(path) ? path : null;
}

function sanitizeReferrerHost(value) {
  let raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  try {
    if (raw.includes("://")) raw = new URL(raw).hostname.toLowerCase();
  } catch (_) {
    return null;
  }
  raw = raw.replace(/\.+$/, "");
  if (!/^[a-z0-9.-]+$/.test(raw) || raw.length > 253 || raw.includes("..")) return null;
  return raw;
}

function sanitizeSignupAttribution(value = {}) {
  const input = value && typeof value === "object" ? value : {};
  const surface = ["web", "ios", "unknown"].includes(input.surface) ? input.surface : "unknown";
  const consent = typeof input.analyticsConsent === "boolean" ? input.analyticsConsent : null;
  const selfReported = String(input.selfReportedSource || "").trim().toLowerCase();
  return {
    surface,
    appVersion: safeAttributionText(input.appVersion, 32),
    landingPath: sanitizeLandingPath(input.landingPath),
    referrerHost: sanitizeReferrerHost(input.referrerHost),
    utmSource: safeAttributionText(input.utmSource, 64),
    utmMedium: safeAttributionText(input.utmMedium, 64),
    utmCampaign: safeAttributionText(input.utmCampaign, 64),
    language: safeAttributionText(input.language, 16),
    analyticsConsent: consent,
    selfReportedSource: SELF_REPORTED_SOURCES.has(selfReported) ? selfReported : null,
  };
}

function isApprovedVerifiedProvider(authUser = {}) {
  if (authUser?.emailVerified !== true) return false;
  const ids = providerIdsForAuthUser(authUser);
  return ids.includes("password") || ids.includes("google.com") || ids.includes("apple.com");
}

function claimsWithoutLegacyBypass(value = {}) {
  const claims = value && typeof value === "object" ? { ...value } : {};
  delete claims.legacyEmailUnverified;
  return claims;
}

function pendingSignupCleanupPlan(accounts = [], options = {}) {
  const nowMs = Number(options.nowMs || Date.now());
  const retentionHours = Number(options.retentionHours || PENDING_SIGNUP_RETENTION_HOURS);
  const cutoffMs = nowMs - retentionHours * 60 * 60 * 1000;
  const adminUids = new Set(options.adminUids || []);
  const excludedUids = new Set(options.excludedUids || []);
  const maxAbsolute = Math.max(1, Number(options.maxAbsolute || 25));
  const maxRatio = Math.max(0, Number(options.maxRatio || 0.02));
  const candidates = [];
  const skipped = {
    recent: 0,
    verified: 0,
    nonPassword: 0,
    legacy: 0,
    admin: 0,
    excluded: 0,
    invalidCreatedAt: 0,
  };

  for (const account of Array.isArray(accounts) ? accounts : []) {
    const uid = String(account?.uid || "").trim();
    const claims = account?.customClaims || {};
    const providers = providerIdsForAuthUser(account);
    if (!uid || excludedUids.has(uid) || claims.signupCleanupExcluded === true) {
      skipped.excluded += 1;
      continue;
    }
    if (adminUids.has(uid) || claims.admin === true || claims.isAdmin === true) {
      skipped.admin += 1;
      continue;
    }
    if (claims.legacyEmailUnverified === true) {
      skipped.legacy += 1;
      continue;
    }
    if (!providers.includes("password")) {
      skipped.nonPassword += 1;
      continue;
    }
    if (account.emailVerified === true) {
      skipped.verified += 1;
      continue;
    }
    const createdAtMs = Number(account.createdAtMs || Date.parse(account?.metadata?.creationTime || ""));
    if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) {
      skipped.invalidCreatedAt += 1;
      continue;
    }
    if (createdAtMs > cutoffMs) {
      skipped.recent += 1;
      continue;
    }
    candidates.push({ uid, createdAtMs });
  }

  const population = Math.max(1, Array.isArray(accounts) ? accounts.length : 0);
  const candidateRatio = candidates.length / population;
  const circuitBreakerOpen = candidates.length > maxAbsolute || candidateRatio > maxRatio;
  return {
    cutoffMs,
    candidates,
    skipped,
    population,
    candidateRatio,
    circuitBreakerOpen,
    circuitBreakerReason: candidates.length > maxAbsolute
      ? "absolute-threshold"
      : (candidateRatio > maxRatio ? "ratio-threshold" : null),
  };
}

function aggregateSignupLifecycleMetrics(records = []) {
  const lifecycleCounts = {};
  const providerCounts = {};
  const surfaceCounts = {};
  const deletionSourceCounts = {};
  const verificationDurations = [];
  let pendingCount = 0;
  let completedCount = 0;
  let reservedDomainCount = 0;
  let authCreatedCount = 0;
  let expiredCount = 0;
  let deletionCompletedCount = 0;

  for (const record of Array.isArray(records) ? records : []) {
    const providerIds = Array.isArray(record?.providerIds) ? record.providerIds : [];
    const lifecycle = classifySignupLifecycle(record);
    lifecycleCounts[lifecycle] = Number(lifecycleCounts[lifecycle] || 0) + 1;
    if (record?.authPresent === true) authCreatedCount += 1;
    for (const provider of providerIds.length ? providerIds : ["unknown"]) {
      providerCounts[provider] = Number(providerCounts[provider] || 0) + 1;
    }
    const surface = ["web", "ios"].includes(record?.surface) ? record.surface : "unknown";
    surfaceCounts[surface] = Number(surfaceCounts[surface] || 0) + 1;
    if (record?.pendingStatus === "pending") pendingCount += 1;
    if (record?.pendingStatus === "completed") completedCount += 1;
    if (record?.reservedEmailDomain === true) reservedDomainCount += 1;
    const deletionSource = String(record?.deletionSource || "").trim();
    if (deletionSource) {
      deletionSourceCounts[deletionSource] = Number(deletionSourceCounts[deletionSource] || 0) + 1;
    }
    if (deletionSource === "pending-expiry" && record?.deletionStatus === "completed") expiredCount += 1;
    if (record?.deletionStatus === "completed") deletionCompletedCount += 1;
    const createdAtMs = Number(record?.pendingCreatedAtMs || 0);
    const completedAtMs = Number(record?.pendingCompletedAtMs || 0);
    if (createdAtMs > 0 && completedAtMs >= createdAtMs) {
      verificationDurations.push(completedAtMs - createdAtMs);
    }
  }

  verificationDurations.sort((left, right) => left - right);
  const medianVerificationMs = verificationDurations.length
    ? verificationDurations[Math.floor(verificationDurations.length / 2)]
    : null;
  const knownAttribution = Number(surfaceCounts.web || 0) + Number(surfaceCounts.ios || 0);
  const population = Array.isArray(records) ? records.length : 0;
  return {
    population,
    authCreatedCount,
    lifecycleCounts,
    providerCounts,
    surfaceCounts,
    deletionSourceCounts,
    pendingCount,
    completedCount,
    pendingToCompletedRate: pendingCount + completedCount
      ? completedCount / (pendingCount + completedCount)
      : 0,
    medianVerificationMs,
    reservedDomainCount,
    expiredCount,
    deletionCompletedCount,
    unknownAttributionRate: population ? 1 - (knownAttribution / population) : 0,
  };
}

function aggregateActivationTiming(records = []) {
  const durations = [];
  for (const record of Array.isArray(records) ? records : []) {
    const createdAtMs = Number(record?.createdAtMs || 0);
    const firstUsefulAtMs = Number(record?.firstUsefulAtMs || 0);
    if (createdAtMs > 0 && firstUsefulAtMs >= createdAtMs) {
      durations.push(firstUsefulAtMs - createdAtMs);
    }
  }
  durations.sort((left, right) => left - right);
  return {
    population: Array.isArray(records) ? records.length : 0,
    observedCount: durations.length,
    medianFirstUsefulMs: durations.length
      ? durations[Math.floor(durations.length / 2)]
      : null,
  };
}

module.exports = {
  isVerificationGraceExpired,
  parseVerificationGraceUntil,
  RESERVED_EMAIL_DOMAINS,
  PENDING_SIGNUP_RETENTION_HOURS,
  classifySignupLifecycle,
  claimsWithoutLegacyBypass,
  aggregateActivationTiming,
  aggregateSignupLifecycleMetrics,
  emailDomain,
  isReservedEmailDomain,
  isApprovedVerifiedProvider,
  pendingSignupCleanupPlan,
  providerIdsForAuthUser,
  sanitizeDisplayName,
  sanitizeLandingPath,
  sanitizeReferrerHost,
  sanitizeSignupAttribution,
};
