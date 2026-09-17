import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { db } from "./firebase.js";
import { canUseAnalytics } from "./consent.js";

const CACHE_KEY = "tw_experiments_cache_v1";
const CLIENT_ID_KEY = "tw_experiments_client_id";
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_FLAGS = 80;
const MAX_EXPERIMENTS = 40;

let memoryCache = null;
let inflight = null;
let identityUid = "";

function nowMs() {
  return Date.now();
}

function safeStorage() {
  if (!canUseAnalytics()) return null;
  try {
    return window.localStorage || null;
  } catch (_) {
    return null;
  }
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function safeString(value, maxLen = 120) {
  return String(value || "").slice(0, maxLen);
}

function toFlagKey(value) {
  return safeString(value, 64)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeFlags(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {};
  let i = 0;
  for (const [k, v] of Object.entries(src)) {
    if (i >= MAX_FLAGS) break;
    const key = toFlagKey(k);
    if (!key) continue;
    out[key] = v === true;
    i += 1;
  }
  return out;
}

function normalizeVariant(value) {
  const raw = safeString(value, 40).trim().toLowerCase();
  return raw || "control";
}

function normalizeExperimentConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const enabled = src.enabled !== false;
  const variant = normalizeVariant(src.variant);
  const rollout = clampInt(src.rollout, 0, 100, 100);

  return {
    enabled,
    variant,
    rollout,
  };
}

function normalizeExperiments(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {};
  let i = 0;
  for (const [k, v] of Object.entries(src)) {
    if (i >= MAX_EXPERIMENTS) break;
    const key = toFlagKey(k);
    if (!key) continue;
    out[key] = normalizeExperimentConfig(v);
    i += 1;
  }
  return out;
}

function normalizePayload(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    flags: normalizeFlags(src.flags),
    experiments: normalizeExperiments(src.experiments),
    updatedAtMs: nowMs(),
  };
}

function readLocalCache() {
  const storage = safeStorage();
  if (!storage) return null;
  try {
    const parsed = JSON.parse(storage.getItem(CACHE_KEY) || "null");
    if (!parsed || typeof parsed !== "object") return null;
    const fetchedAtMs = Number(parsed.fetchedAtMs || 0);
    if (!Number.isFinite(fetchedAtMs) || fetchedAtMs <= 0) return null;
    return {
      fetchedAtMs,
      payload: normalizePayload(parsed.payload || {}),
    };
  } catch (_) {
    return null;
  }
}

function writeLocalCache(row) {
  const storage = safeStorage();
  if (!storage || !row) return;
  try {
    storage.setItem(
      CACHE_KEY,
      JSON.stringify({
        fetchedAtMs: Number(row.fetchedAtMs || nowMs()),
        payload: row.payload || { flags: {}, experiments: {}, updatedAtMs: nowMs() },
      })
    );
  } catch (_) {}
}

function ensureClientId() {
  const storage = safeStorage();
  if (!storage) return "anon";
  try {
    const existing = safeString(storage.getItem(CLIENT_ID_KEY), 80).trim();
    if (existing) return existing;
    const generated = `anon_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-6)}`;
    storage.setItem(CLIENT_ID_KEY, generated);
    return generated;
  } catch (_) {
    return "anon";
  }
}

function hashToBucket(input) {
  const s = String(input || "");
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h % 100;
}

function identityKey() {
  if (!canUseAnalytics()) return "anon";
  return identityUid || ensureClientId();
}

function isFresh(cacheRow, ttlMs = CACHE_TTL_MS) {
  if (!cacheRow) return false;
  return (nowMs() - Number(cacheRow.fetchedAtMs || 0)) <= ttlMs;
}

function getMemoryOrLocal(ttlMs = CACHE_TTL_MS) {
  if (isFresh(memoryCache, ttlMs)) return memoryCache;
  const local = readLocalCache();
  if (isFresh(local, ttlMs)) {
    memoryCache = local;
    return local;
  }
  return null;
}

async function fetchRemoteExperiments() {
  const ref = doc(db, "experiments", "global");
  const snap = await getDoc(ref);
  const payload = normalizePayload(snap.exists() ? snap.data() : {});
  const row = {
    fetchedAtMs: nowMs(),
    payload,
  };
  memoryCache = row;
  writeLocalCache(row);
  return row;
}

export function setExperimentsIdentity(uid) {
  identityUid = safeString(uid, 80).trim();
}

export async function preloadExperiments({ force = false, ttlMs = CACHE_TTL_MS } = {}) {
  if (!canUseAnalytics()) {
    return { flags: {}, experiments: {}, updatedAtMs: 0 };
  }
  if (!force) {
    const cached = getMemoryOrLocal(ttlMs);
    if (cached) return cached.payload;
  }

  if (!inflight) {
    inflight = fetchRemoteExperiments()
      .catch((err) => {
        const cached = getMemoryOrLocal(24 * 60 * 60 * 1000);
        if (cached) return cached;
        throw err;
      })
      .finally(() => {
        inflight = null;
      });
  }

  const row = await inflight;
  return row.payload;
}

export function getCachedExperiments() {
  if (!canUseAnalytics()) {
    return { flags: {}, experiments: {}, updatedAtMs: 0 };
  }
  const cached = getMemoryOrLocal(24 * 60 * 60 * 1000);
  return cached ? cached.payload : { flags: {}, experiments: {}, updatedAtMs: 0 };
}

export async function isFeatureEnabled(flagKey, fallback = false) {
  const key = toFlagKey(flagKey);
  if (!key) return fallback === true;

  const payload = await preloadExperiments().catch(() => getCachedExperiments());
  const direct = payload.flags?.[key];
  if (typeof direct === "boolean") return direct;

  const exp = payload.experiments?.[key];
  if (!exp || exp.enabled === false) return fallback === true;

  const bucket = hashToBucket(`${key}:${identityKey()}`);
  const rollout = clampInt(exp.rollout, 0, 100, 100);
  if (bucket >= rollout) return false;
  return exp.variant !== "control";
}

export async function getExperimentVariant(experimentKey, { fallback = "control" } = {}) {
  const key = toFlagKey(experimentKey);
  if (!key) return normalizeVariant(fallback);

  const payload = await preloadExperiments().catch(() => getCachedExperiments());
  const exp = payload.experiments?.[key];
  if (!exp || exp.enabled === false) return normalizeVariant(fallback);

  const bucket = hashToBucket(`${key}:${identityKey()}`);
  const rollout = clampInt(exp.rollout, 0, 100, 100);
  if (bucket >= rollout) return "control";
  return normalizeVariant(exp.variant);
}

export function getCachedExperimentsContext({ maxItems = 6 } = {}) {
  const payload = getCachedExperiments();
  const out = {};
  const limit = clampInt(maxItems, 1, 20, 6);
  let count = 0;

  for (const [k, v] of Object.entries(payload.flags || {})) {
    if (count >= limit) break;
    out[`ff_${k}`] = v ? "on" : "off";
    count += 1;
  }

  for (const [k, v] of Object.entries(payload.experiments || {})) {
    if (count >= limit) break;
    out[`exp_${k}`] = normalizeVariant(v?.variant || "control");
    count += 1;
  }

  return out;
}
