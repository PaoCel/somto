/**
 * Guided Profiles — config admin (kill switch, modalita', cap).
 *
 * Persistita in `appConfig/guidedProfiles` (deny-all ai client, solo admin SDK).
 * Letta da scheduler / callable / script. Mai hardcodare valori fragili: la
 * config runtime vive qui, i default in constants.js.
 */

const { COLLECTIONS, DEFAULT_CONFIG, GUIDED_MODE, ALL_ACTION_TYPES } = require("./constants");

function configRef(db) {
  return db.collection(COLLECTIONS.APP_CONFIG).doc(COLLECTIONS.CONFIG_DOC_ID);
}

function coerceBool(value, fallback) {
  if (value === true || value === false) return value;
  return fallback;
}

function coerceInt(value, fallback, { min = 0, max = 100000 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function coerceMode(value) {
  const v = String(value || "").trim();
  return Object.values(GUIDED_MODE).includes(v) ? v : DEFAULT_CONFIG.guidedProfilesMode;
}

function coerceActionTypes(value) {
  if (!Array.isArray(value)) return DEFAULT_CONFIG.allowedActionTypes.slice();
  const filtered = value
    .map((v) => String(v || "").trim())
    .filter((v) => ALL_ACTION_TYPES.includes(v));
  return filtered.length ? Array.from(new Set(filtered)) : DEFAULT_CONFIG.allowedActionTypes.slice();
}

function coerceUidList(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value.map((v) => String(v || "").trim()).filter(Boolean)
  )).slice(0, 50);
}

/** Normalizza un payload parziale sopra i default. */
function normalizeConfig(raw = {}) {
  return {
    enableGuidedProfiles: coerceBool(raw.enableGuidedProfiles, DEFAULT_CONFIG.enableGuidedProfiles),
    guidedProfilesMode: coerceMode(raw.guidedProfilesMode),
    requireHumanReview: coerceBool(raw.requireHumanReview, DEFAULT_CONFIG.requireHumanReview),
    maxActionsPerRun: coerceInt(raw.maxActionsPerRun, DEFAULT_CONFIG.maxActionsPerRun, { min: 1, max: 1000 }),
    maxActionsPerProfilePerDay: coerceInt(raw.maxActionsPerProfilePerDay, DEFAULT_CONFIG.maxActionsPerProfilePerDay, { min: 1, max: 100 }),
    allowedActionTypes: coerceActionTypes(raw.allowedActionTypes),
    dryRun: coerceBool(raw.dryRun, DEFAULT_CONFIG.dryRun),
    killSwitch: coerceBool(raw.killSwitch, DEFAULT_CONFIG.killSwitch),
    testAccountUids: coerceUidList(raw.testAccountUids),
  };
}

/** Legge la config; ritorna sempre un oggetto normalizzato (default se assente). */
async function getGuidedConfig(db) {
  const snap = await configRef(db).get().catch(() => null);
  const raw = snap && snap.exists ? (snap.data() || {}) : {};
  return normalizeConfig(raw);
}

/** Merge di un patch parziale sulla config. Ritorna la config risultante. */
async function setGuidedConfig(db, patch = {}, serverTimestamp) {
  const current = await getGuidedConfig(db);
  const next = normalizeConfig({ ...current, ...patch });
  await configRef(db).set(
    { ...next, updatedAt: serverTimestamp || null },
    { merge: true }
  );
  return next;
}

/**
 * Decide se la routine puo' agire, e con quali destinatari per il fan-out feed.
 * Ritorna { allowed, reason, fanoutScope }.
 *   fanoutScope: "followers" (public_guided) | "test_only" (private_test) | "none".
 *
 * Semantica modalita':
 *  - killSwitch / !enable / mode=off  -> niente attivita'.
 *  - staging_only -> attivita' SOLO in emulatore (no progetto staging separato).
 *  - private_test -> attivita' in prod, feed visibile solo ad admin/test.
 *  - public_guided -> fan-out normale ai follower del profilo guidato.
 */
function evaluateGate(config, { isEmulator = false } = {}) {
  if (config.killSwitch) return { allowed: false, reason: "kill_switch" };
  if (!config.enableGuidedProfiles) return { allowed: false, reason: "disabled" };

  const mode = config.guidedProfilesMode;
  if (mode === GUIDED_MODE.OFF) return { allowed: false, reason: "mode_off" };

  if (mode === GUIDED_MODE.STAGING_ONLY) {
    if (!isEmulator) return { allowed: false, reason: "staging_only_in_prod" };
    return { allowed: true, reason: "ok", fanoutScope: "test_only" };
  }

  if (mode === GUIDED_MODE.PRIVATE_TEST) {
    return { allowed: true, reason: "ok", fanoutScope: "test_only" };
  }

  // public_guided
  return { allowed: true, reason: "ok", fanoutScope: "followers" };
}

module.exports = {
  configRef,
  normalizeConfig,
  getGuidedConfig,
  setGuidedConfig,
  evaluateGate,
};
