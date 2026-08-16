// service-worker.js - PWA offline/cache + FCM push notifications (unified)
// v42-2026-05-21: cache tiered (shell/runtime/images) con eviction LRU,
//                 stale-while-revalidate per asset code/img, network-first navigate.
// importScripts cross-origin (gstatic.com) fallisce su custom domain in Chrome
// → Firebase compat servito da same-origin.

// ─── FCM: import libs Firebase compat (locali) ──────────────────────
// Polyfill: firebase-app-compat.js accede "window" anche in SW context
// (bug: d() ritorna true via WorkerGlobalScope check, poi fa window.firebase).
// Creiamo un alias window→self per evitare il crash.
if (typeof window === "undefined") {
  self.window = self;
}

let _fcmReady = false;
try {
  importScripts("/firebase-app-compat.js");
  importScripts("/firebase-messaging-compat.js");
  _fcmReady = true;
  console.log("[SW] FCM libs loaded OK");
} catch (e) {
  console.warn("[SW] importScripts FCM failed — push disabilitato, PWA ok:", e.message);
}

// ─── FCM: init + background handler ─────────────────────────────────
if (_fcmReady) {
  try {
    firebase.initializeApp({
      apiKey: "AIzaSyCf5Gi9TZNzJGeZGhW_7zM9zASplIC6GBw",
      authDomain: "somto.it",
      projectId: "gia-visto",
      storageBucket: "gia-visto.firebasestorage.app",
      messagingSenderId: "538597925021",
      appId: "1:538597925021:web:30d160b1a8c5e71c293474",
      measurementId: "G-K9B19SSJEY"
    });

    const messaging = firebase.messaging();

    messaging.onBackgroundMessage((payload) => {
      console.log("[SW-FCM] onBackgroundMessage:", payload);

      if (payload?.notification?.title) {
        return;
      }

      const data = payload?.data || {};
      const title = data.title || "Somto";
      const body = data.body || data.preview || "Hai una nuova notifica";

      self.registration.showNotification(title, {
        body,
        icon: "/icons/icon-192.png",
        data: data,
      });
    });

    console.log("[SW] FCM initialized OK");
  } catch (e) {
    console.warn("[SW] FCM initializeApp failed:", e.message);
  }
}

// ─── Deep link: click sulla notifica → apri la pagina corretta ───────
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  let url = data.url || "/notifications.html";

  if (url.startsWith("/")) {
    url = self.location.origin + url;
  }

  console.log("[SW] notificationclick → navigating to:", url);

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.startsWith(self.location.origin) && "focus" in client) {
          return client.focus().then(() => client.navigate(url));
        }
      }
      return clients.openWindow(url);
    })
  );
});

// ─── PWA CONFIG ──────────────────────────────────────────────────────
// Bumpa VERSION ad ogni release di asset.
const VERSION = "v197-2026-08-16-home-upcoming";
const SHELL_CACHE = `somto-shell-${VERSION}`;
const RUNTIME_CACHE = `somto-runtime-${VERSION}`;
const IMAGE_CACHE = `somto-images-${VERSION}`;

const MAX_RUNTIME_ENTRIES = 50;
const MAX_IMAGE_ENTRIES = 200;

const OFFLINE_URL = "/offline.html";

// Solo l'essenziale: fallback offline + landing + manifest/icone.
// Tutto il resto va nei cache runtime/image al primo fetch.
const SHELL_PRECACHE = [
  "/",
  "/index.html",
  "/offline.html",
  "/login.html",
  "/manifest.json",
  "/favicon.ico",
  "/css/variables.css",
  "/css/base.css",
  "/js/pwa.js",
  "/firebase-messaging-sw.js",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-180.png",
];

// ─── PWA: Install (precache shell) ───────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) =>
        // addAll fallisce atomicamente: usa add per-item per resilienza
        // (se un file manca dal deploy non bricka l'install).
        Promise.all(
          SHELL_PRECACHE.map((url) =>
            cache.add(url).catch((err) => {
              console.warn("[SW] precache miss:", url, err.message);
            })
          )
        )
      )
    // Niente skipWaiting() qui: il nuovo SW resta in "waiting" finché l'utente
    // non tocca "Aggiorna" (pwa.js posta SKIP_WAITING all'handler message in
    // fondo). Evita il reload forzato di tutte le tab aperte a ogni deploy.
  );
});

// ─── PWA: Activate (cleanup old caches + take control) ───────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("somto-") && !k.endsWith(VERSION))
          // legacy: cache pre-tiered (Somto-web-vXX) → eviction totale
          .concat(keys.filter((k) => k.startsWith("Somto-web-")))
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

// ─── Helper: LRU-style eviction su cache name ────────────────────────
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > maxEntries) {
    // FIFO: scarta gli inserimenti più vecchi (cache.keys() preserva insertion order)
    await Promise.all(
      keys.slice(0, keys.length - maxEntries).map((k) => cache.delete(k))
    );
  }
}

// ─── PWA: Fetch ──────────────────────────────────────────────────────
// Strategie:
//   - immagini:          stale-while-revalidate su IMAGE_CACHE (TTL via eviction)
//   - navigate (HTML):   network-first → cache → /offline.html
//   - same-origin JS/CSS: network-first → cache (evita grafi ES module misti)
//   - cross-origin con `token=`: bypass (Storage signed URLs, Google auth, ecc.)
//   - resto cross-origin: bypass (CORS / opaque)
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Bypass auth-tokened cross-origin (Storage signed URLs etc) per non
  // bloccarli in cache: il token cambia e renderebbe la cache stale o leak.
  if (url.origin !== self.location.origin && url.search.includes("token=")) return;

  // Cross-origin generico: passa al browser (no opaque cache, no CORS issues).
  if (url.origin !== self.location.origin) return;

  // Image cache: stale-while-revalidate
  if (
    request.destination === "image" ||
    /\.(png|jpe?g|webp|gif|svg|avif|ico)$/i.test(url.pathname)
  ) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(IMAGE_CACHE);
        const cached = await cache.match(request);
        const fetchP = fetch(request)
          .then((resp) => {
            if (resp && resp.ok) {
              cache.put(request, resp.clone());
              trimCache(IMAGE_CACHE, MAX_IMAGE_ENTRIES);
            }
            return resp;
          })
          .catch(() => cached);
        return cached || fetchP;
      })()
    );
    return;
  }

  // Navigation: network-first con fallback cache → offline
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const resp = await fetch(request);
          const cache = await caches.open(RUNTIME_CACHE);
          if (resp && resp.ok) {
            cache.put(request, resp.clone());
            trimCache(RUNTIME_CACHE, MAX_RUNTIME_ENTRIES);
          }
          return resp;
        } catch {
          const cached =
            (await caches.match(request)) ||
            (await caches.match(OFFLINE_URL));
          return cached || new Response("Offline", { status: 503 });
        }
      })()
    );
    return;
  }

  // Same-origin JS/CSS: network-first. Con ES modules buildless, servire il
  // controller nuovo insieme a una dipendenza vecchia può impedire del tutto
  // l'avvio della pagina (export mancanti). La cache resta solo come fallback
  // offline; una risposta 304 rende il costo della revalidazione minimo.
  if (/\.(js|css)$/i.test(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(RUNTIME_CACHE);
        const cached = await cache.match(request);
        try {
          const resp = await fetch(request);
          if (resp && resp.ok) {
            cache.put(request, resp.clone());
            trimCache(RUNTIME_CACHE, MAX_RUNTIME_ENTRIES);
          }
          return resp;
        } catch {
          return cached || new Response("Offline", { status: 503 });
        }
      })()
    );
    return;
  }

  // Default same-origin (manifest, json, fonts, ecc.): cache-first opportunistico
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  );
});
