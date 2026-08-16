// /js/firebase.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { t as i18nT } from "./i18n/index.js";
import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app-check.js";
import { getAuth, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  initializeFirestore,
  connectFirestoreEmulator,
  // Core refs
  doc,
  collection,

  // Reads
  getDoc,
  getDocs,

  // Writes
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,

  // Queries
  query,
  where,
  orderBy,
  limit,

  // Utils
  serverTimestamp,
  increment,
  arrayUnion,
  arrayRemove,

  // Batches
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import { getStorage, connectStorageEmulator } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js";

import { getMessaging, onMessage } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-messaging.js";
import { mountConsentBannerIfNeeded } from "./consent.js";

const EMULATOR_FLAG_KEY = "__2WATCH_USE_FIREBASE_EMULATORS__";
const EMULATOR_CONFIG_KEY = "__2WATCH_FIREBASE_EMULATORS__";
let emulatorBindingsDone = false;
let messagingInstance = null;
let messagingForegroundBound = false;

function parsePort(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(65535, Math.trunc(n)));
}

function safeParseObject(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function readRawEmulatorConfig() {
  let queryFlag = "";
  try {
    queryFlag = new URLSearchParams(window.location.search).get("emulators") || "";
    if (queryFlag === "1") {
      localStorage.setItem(EMULATOR_FLAG_KEY, "1");
    } else if (queryFlag === "0") {
      localStorage.removeItem(EMULATOR_FLAG_KEY);
      localStorage.removeItem(EMULATOR_CONFIG_KEY);
    }
  } catch (_) {}

  let localCfg = {};
  try {
    localCfg = safeParseObject(localStorage.getItem(EMULATOR_CONFIG_KEY));
  } catch (_) {}

  const globalCfg = window.__FIREBASE_EMULATORS__ && typeof window.__FIREBASE_EMULATORS__ === "object"
    ? window.__FIREBASE_EMULATORS__
    : {};

  return { ...globalCfg, ...localCfg, __queryFlag: queryFlag };
}

function shouldUseFirebaseEmulators(rawCfg = null) {
  const cfg = rawCfg || readRawEmulatorConfig();
  if (cfg.__queryFlag === "1") return true;
  if (cfg.__queryFlag === "0") return false;
  if (window.__USE_FIREBASE_EMULATORS__ === true) return true;
  try {
    return localStorage.getItem(EMULATOR_FLAG_KEY) === "1";
  } catch (_) {
    return false;
  }
}

function resolveRuntimeFirebaseConfig(baseConfig) {
  const base = (baseConfig && typeof baseConfig === "object") ? baseConfig : {};
  const next = { ...base };
  const rawCfg = readRawEmulatorConfig();
  if (!shouldUseFirebaseEmulators(rawCfg)) return next;

  const projectId = String(rawCfg.projectId || "demo-2watch").trim();
  if (projectId) {
    next.projectId = projectId;
  }
  return next;
}

async function ensureFirebaseConfig() {
  if (window.firebaseConfig) return;

  // Fallback robusto: se una pagina/route non ha incluso firebaseConfig.js (o SW cache vecchia), lo carichiamo qui.
  await new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-firebase-config]');
    if (existing && window.firebaseConfig) return resolve();

    const s = document.createElement('script');
    s.src = '/firebaseConfig.js';
    s.async = true;
    s.defer = true;
    s.setAttribute('data-firebase-config', '1');
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Impossibile caricare /firebaseConfig.js'));
    document.head.appendChild(s);
  });

  if (!window.firebaseConfig) {
    throw new Error(i18nT("firebaseConfig non trovato: controlla che /firebaseConfig.js esista e venga servito correttamente."));
  }
}

// Top-level await (ESM) per garantire che config sia disponibile prima di inizializzare Firebase
await ensureFirebaseConfig();

const runtimeFirebaseConfig = resolveRuntimeFirebaseConfig(window.firebaseConfig || {});
window.firebaseConfig = runtimeFirebaseConfig;

export const app = initializeApp(runtimeFirebaseConfig);

function readAppCheckConfig() {
  const raw = runtimeFirebaseConfig?.appCheck;
  if (!raw || typeof raw !== "object") {
    return { enabled: false, provider: "recaptchaV3", siteKey: "", debugToken: "", autoRefresh: true };
  }

  return {
    enabled: raw.enabled === true,
    provider: raw.provider === "recaptchaV3" ? "recaptchaV3" : "recaptchaV3",
    siteKey: String(raw.siteKey || "").trim(),
    debugToken: raw.debugToken === true ? true : String(raw.debugToken || "").trim(),
    autoRefresh: raw.autoRefresh !== false,
  };
}

function initializeAppCheckIfNeeded() {
  if (readEmulatorConfig()) return null;

  const cfg = readAppCheckConfig();
  if (!cfg.enabled || !cfg.siteKey) return null;

  if (cfg.debugToken) {
    globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN = cfg.debugToken;
  }

  try {
    return initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(cfg.siteKey),
      isTokenAutoRefreshEnabled: cfg.autoRefresh,
    });
  } catch (err) {
    console.warn("[firebase] initializeAppCheck skipped:", err?.message || err);
    return null;
  }
}

export const appCheck = initializeAppCheckIfNeeded();
export const auth = getAuth(app);

function shouldForceFirestoreLongPolling() {
  if (typeof navigator === "undefined") return false;
  const ua = String(navigator.userAgent || "");
  const vendor = String(navigator.vendor || "");
  return /Safari/i.test(ua)
    && /Apple/i.test(vendor)
    && !/(Chrome|Chromium|CriOS|FxiOS|Edg|EdgiOS|OPR|OPiOS)/i.test(ua);
}

function getFirestoreSettings() {
  // Safari/WebKit can log noisy CORS failures on the streaming Listen channel.
  if (shouldForceFirestoreLongPolling()) {
    return {
      experimentalForceLongPolling: true,
      useFetchStreams: false,
    };
  }
  return {
    experimentalAutoDetectLongPolling: true,
    useFetchStreams: false,
  };
}

export const db = initializeFirestore(app, getFirestoreSettings());
export const storage = getStorage(app);

function readEmulatorConfig() {
  const merged = readRawEmulatorConfig();
  if (!shouldUseFirebaseEmulators(merged)) return null;
  const host = String(merged.host || "127.0.0.1").trim() || "127.0.0.1";

  return {
    host,
    projectId: String(merged.projectId || runtimeFirebaseConfig.projectId || "demo-2watch").trim() || "demo-2watch",
    authPort: parsePort(merged.authPort, 59099),
    firestorePort: parsePort(merged.firestorePort, 58080),
    storagePort: parsePort(merged.storagePort, 58081),
  };
}

function connectFirebaseEmulatorsIfNeeded() {
  if (emulatorBindingsDone) return;
  const cfg = readEmulatorConfig();
  if (!cfg) return;

  try {
    connectAuthEmulator(auth, `http://${cfg.host}:${cfg.authPort}`, { disableWarnings: true });
  } catch (err) {
    console.warn("[firebase] connectAuthEmulator skipped:", err?.message || err);
  }

  try {
    connectFirestoreEmulator(db, cfg.host, cfg.firestorePort);
  } catch (err) {
    console.warn("[firebase] connectFirestoreEmulator skipped:", err?.message || err);
  }

  try {
    connectStorageEmulator(storage, cfg.host, cfg.storagePort);
  } catch (err) {
    console.warn("[firebase] connectStorageEmulator skipped:", err?.message || err);
  }

  emulatorBindingsDone = true;
  window.__2WATCH_EMULATORS_CONNECTED__ = true;
  window.__2WATCH_EMULATORS_CONFIG__ = cfg;
}

connectFirebaseEmulatorsIfNeeded();
mountConsentBannerIfNeeded();

function bindForegroundMessagingIfNeeded() {
  if (messagingForegroundBound || !messagingInstance) return;
  messagingForegroundBound = true;

  // Foreground push: quando l'app è aperta, FCM consegna qui (non al SW).
  // Mostra una notifica anche in foreground per feedback visivo.
  onMessage(messagingInstance, (payload) => {
    console.log("[FCM] onMessage (foreground):", payload);

    const n = payload?.notification || {};
    const d = payload?.data || {};
    const title = n.title || d.title || i18nT("Somto");
    const body = n.body || d.body || d.preview || "";

    if (Notification.permission === "granted" && navigator.serviceWorker?.controller) {
      navigator.serviceWorker.ready.then((reg) => {
        reg.showNotification(title, {
          body,
          icon: "/icons/icon-192.png",
          data: d,
        });
      });
    }
  });
}

export function getMessagingClient() {
  if (!messagingInstance) {
    messagingInstance = getMessaging(app);
    window.messaging = messagingInstance;
    bindForegroundMessagingIfNeeded();
  }
  return messagingInstance;
}

/**
 * Espone Firestore su window per i moduli che usano safe-check (es: correlati).
 * Non è “pulitissimo” come architettura, ma è il fix più rapido senza refactor.
 */
window.auth = auth;
window.db = db;
window.storage = storage;
window.appCheck = appCheck;
window.getMessagingClient = getMessagingClient;

// Firestore functions (usate da varie pagine / helper safe)
window.doc = doc;
window.collection = collection;

window.getDoc = getDoc;
window.getDocs = getDocs;

window.addDoc = addDoc;
window.setDoc = setDoc;
window.updateDoc = updateDoc;
window.deleteDoc = deleteDoc;

window.query = query;
window.where = where;
window.orderBy = orderBy;
window.limit = limit;

window.serverTimestamp = serverTimestamp;
window.increment = increment;
window.arrayUnion = arrayUnion;
window.arrayRemove = arrayRemove;

window.writeBatch = writeBatch;

// (Opzionale) esporti anche le funzioni per import diretto altrove
export {
  doc,
  collection,
  getDoc,
  getDocs,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  increment,
  arrayUnion,
  arrayRemove,
  writeBatch,
};
