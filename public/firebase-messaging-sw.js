// Compatibility service worker for legacy Firebase Messaging default path.
// Main push + offline logic lives in /service-worker.js.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
