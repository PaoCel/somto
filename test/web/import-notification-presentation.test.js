import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  adminImportStartedPresentation,
  genericServerNotificationPresentation,
  importNotificationPresentation,
  importSourceLabel,
  safeNotificationPath,
} from "../../public/js/utils/importNotificationPresentation.js";

test("labels every supported import source without assuming Netflix", () => {
  assert.equal(importSourceLabel("netflix_csv"), "Import Netflix");
  assert.equal(importSourceLabel("tvtime_gdpr"), "Import TV Time");
  assert.equal(importSourceLabel("tvtime_refract"), "Import TV Time");
  assert.equal(importSourceLabel("trakt"), "Import Trakt");
  assert.equal(importSourceLabel("unknown"), "Import");
});

test("review notification preserves server copy and opens the exact import", () => {
  const view = importNotificationPresentation({
    type: "titles_import_needs_review",
    data: {
      source: "tvtime_gdpr",
      importId: "import 42",
      matchedCount: 529,
      unresolvedCount: 12,
      message: "Import TV Time quasi pronto: 529 titoli aggiornati, 12 da controllare.",
      ctaUrl: "/import.html?id=import%2042",
    },
  });

  assert.deepEqual(view, {
    icon: "🧩",
    title: "Import TV Time da controllare",
    text: "Import TV Time quasi pronto: 529 titoli aggiornati, 12 da controllare.",
    url: "/import.html?id=import%2042",
  });
});

test("completed and failed notifications use source-aware fallbacks", () => {
  assert.deepEqual(importNotificationPresentation({
    type: "titles_import_completed",
    data: { source: "trakt", matchedCount: 41 },
  }), {
    icon: "✅",
    title: "Import Trakt completato",
    text: "41 titoli aggiornati nella tua libreria.",
    url: "/watchlist.html",
  });

  assert.deepEqual(importNotificationPresentation({
    type: "titles_import_failed",
    data: {
      source: "netflix_csv",
      importId: "broken",
      // Payload reale legacy: il backend indicava per errore la libreria.
      ctaUrl: "/account.html?tab=watched",
    },
  }), {
    icon: "⚠️",
    title: "Import Netflix non riuscito",
    text: "Controlla i file scelti oppure riprova dall'importazione.",
    url: "/import.html?id=broken",
  });
});

test("notification destinations stay on same-origin paths", () => {
  assert.equal(safeNotificationPath("https://evil.example/path", "/safe"), "/safe");
  assert.equal(safeNotificationPath("//evil.example/path", "/safe"), "/safe");
  assert.equal(safeNotificationPath("/\\evil.example/path", "/safe"), "/safe");
  assert.equal(safeNotificationPath("/\nevil.example/path", "/safe"), "/safe");
  assert.equal(safeNotificationPath("/import.html?id=ok", "/safe"), "/import.html?id=ok");
});

test("admin import notification explains who imported what and where it opens", () => {
  assert.deepEqual(adminImportStartedPresentation({
    type: "admin_import_started",
    fromUid: "user-1",
    data: {
      fromName: "Ayman",
      source: "tvtime_refract",
      totalRows: 703,
      importUid: "user-1",
    },
  }), {
    icon: "📥",
    title: "Ayman ha avviato un import",
    text: "Import TV Time · 703 righe",
    url: "/user.html?uid=user-1",
  });
});

test("unknown server notifications no longer collapse to an empty generic row", () => {
  assert.deepEqual(genericServerNotificationPresentation({
    type: "import_health_alert",
    data: {
      message: "2 import da controllare.",
      ctaUrl: "/admin-analytics.html",
    },
  }), {
    icon: "🔔",
    title: "Somto",
    text: "2 import da controllare.",
    url: "/admin-analytics.html",
  });
});

test("web asset policy revalidates code and service worker is network-first", async () => {
  const [firebaseConfig, serviceWorker] = await Promise.all([
    readFile(new URL("../../firebase.json", import.meta.url), "utf8"),
    readFile(new URL("../../public/service-worker.js", import.meta.url), "utf8"),
  ]);

  const parsed = JSON.parse(firebaseConfig);
  const codeHeader = parsed.hosting.headers.find((entry) => entry.source === "**/*.@(js|css)");
  assert.deepEqual(codeHeader?.headers, [
    { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
  ]);
  assert.match(serviceWorker, /Same-origin JS\/CSS: network-first/);
  assert.doesNotMatch(serviceWorker, /Same-origin JS\/CSS: stale-while-revalidate/);
});
