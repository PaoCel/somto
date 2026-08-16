import {
  getAnalytics,
  isSupported,
  logEvent as fbLogEvent,
  setUserId as fbSetUserId,
  setUserProperties as fbSetUserProperties,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-analytics.js";
import { app } from "./firebase.js";
import {
  preloadExperiments,
  getCachedExperimentsContext,
  setExperimentsIdentity,
} from "./experiments.js";
import { canUseAnalytics } from "./consent.js";

const MAX_PROP_KEY = 40;
const MAX_STRING_VALUE = 100;
const DEBUG_KEY = "debugAnalytics";

let analyticsPromise = null;
let experimentsWarmupStarted = false;

function hasMeasurementId() {
  return Boolean(window?.firebaseConfig?.measurementId);
}

function debugEnabled() {
  try {
    return window.localStorage?.getItem(DEBUG_KEY) === "1";
  } catch (_) {
    return false;
  }
}

function debugLog(...args) {
  if (!debugEnabled()) return;
  console.info("[analytics]", ...args);
}

function sanitizeEventName(name) {
  const raw = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!raw) return "";
  if (!/^[a-z]/.test(raw)) return `evt_${raw}`.slice(0, 40);
  return raw.slice(0, 40);
}

function sanitizePropKey(key) {
  const raw = String(key || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!raw) return "";
  if (!/^[a-z]/.test(raw)) return `p_${raw}`.slice(0, MAX_PROP_KEY);
  return raw.slice(0, MAX_PROP_KEY);
}

function sanitizePropValue(value) {
  if (value == null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value;
  }
  if (typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString().slice(0, MAX_STRING_VALUE);
  return String(value).slice(0, MAX_STRING_VALUE);
}

function sanitizeProps(rawProps = {}) {
  const src = rawProps && typeof rawProps === "object" ? rawProps : {};
  const out = {};
  let count = 0;
  for (const [k, v] of Object.entries(src)) {
    if (count >= 24) break;
    const key = sanitizePropKey(k);
    if (!key) continue;
    const value = sanitizePropValue(v);
    if (value == null) continue;
    out[key] = value;
    count += 1;
  }
  return out;
}

async function getAnalyticsInstance() {
  if (!hasMeasurementId() || !canUseAnalytics()) return null;
  if (!analyticsPromise) {
    analyticsPromise = (async () => {
      try {
        const ok = await isSupported();
        if (!ok) return null;
        return getAnalytics(app);
      } catch (err) {
        debugLog("analytics init failed", err?.message || err);
        return null;
      }
    })();
  }
  return analyticsPromise;
}

function ensureExperimentsWarmup() {
  if (experimentsWarmupStarted) return;
  experimentsWarmupStarted = true;
  preloadExperiments().catch((err) => {
    debugLog("experiments warmup failed", err?.message || err);
  });
}

export async function setAnalyticsUser(user) {
  if (!canUseAnalytics()) return false;
  const analytics = await getAnalyticsInstance();
  if (!analytics) return false;
  const uid = String(user?.uid || "").trim();
  setExperimentsIdentity(uid);
  if (uid) {
    fbSetUserId(analytics, uid);
    fbSetUserProperties(analytics, { signed_in: "1" });
  } else {
    fbSetUserId(analytics, null);
    fbSetUserProperties(analytics, { signed_in: "0" });
  }
  ensureExperimentsWarmup();
  return true;
}

/**
 * Lingua del CONTENUTO che l'utente sta guardando, presa dall'attributo `lang`
 * della pagina — non da `navigator.language`.
 *
 * La differenza conta: GA4 raccoglie gia' da solo la lingua del browser, ma un
 * utente italiano puo' benissimo atterrare su una pagina inglese da una ricerca
 * in inglese, e viceversa. Senza questa dimensione non si puo' rispondere alla
 * domanda che giustifica l'intero investimento sull'inglese: converte?
 *
 * Va misurata PRIMA di pubblicare le pagine EN, altrimenti manca il termine di
 * paragone. Vedi docs/I18N-ANALYSIS-2026-07-29.md §3.5.
 */
function currentContentLocale() {
  const raw = document.documentElement.getAttribute("lang") || "it";
  return String(raw).toLowerCase().replace("_", "-").split("-")[0];
}

export async function logEvent(name, props = {}, opts = {}) {
  if (!canUseAnalytics()) return false;
  const eventName = sanitizeEventName(name);
  if (!eventName) return false;

  const analytics = await getAnalyticsInstance();
  if (!analytics) return false;

  ensureExperimentsWarmup();

  const payload = sanitizeProps(props);
  if (opts.includeExperiments !== false) {
    const context = getCachedExperimentsContext({ maxItems: 6 });
    Object.assign(payload, sanitizeProps(context));
  }
  if (payload.content_locale == null) {
    payload.content_locale = currentContentLocale();
  }

  try {
    fbLogEvent(analytics, eventName, payload);
    debugLog("event", eventName, payload);
    return true;
  } catch (err) {
    debugLog("event failed", eventName, err?.message || err);
    return false;
  }
}
