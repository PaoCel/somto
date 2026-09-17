import { t as i18nT } from "../i18n/index.js";
const IMPORT_NOTIFICATION_TYPES = new Set([
  "titles_import_completed",
  "titles_import_needs_review",
  "titles_import_failed",
]);

function nonNegativeInt(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

export function importSourceLabel(source) {
  switch (String(source || "").trim()) {
    case "netflix_csv":
      return "Import Netflix";
    case "tvtime_gdpr":
    case "tvtime_refract":
      return "Import TV Time";
    case "trakt":
      return "Import Trakt";
    default:
      return "Import";
  }
}

export function safeNotificationPath(value, fallback) {
  const path = String(value || "").trim();
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[\u0000-\u001F\u007F\\]/.test(path)
  ) return fallback;
  try {
    const base = new URL("https://somto.invalid");
    const parsed = new URL(path, base);
    if (parsed.origin !== base.origin) return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

export function importNotificationPresentation(notification = {}) {
  const type = String(notification?.type || "").trim();
  if (!IMPORT_NOTIFICATION_TYPES.has(type)) return null;

  const data = notification?.data || {};
  const label = importSourceLabel(data.source);
  const matchedCount = nonNegativeInt(data.matchedCount);
  const unresolvedCount = nonNegativeInt(data.unresolvedCount);
  const explicitMessage = String(data.message || "").trim();

  if (type === "titles_import_needs_review") {
    return {
      icon: "🧩",
      title: `${label} da controllare`,
      text: explicitMessage || i18nT("{matched} titoli aggiornati, {unresolved} da controllare.", { matched: matchedCount, unresolved: unresolvedCount }),
      url: safeNotificationPath(data.ctaUrl, data.importId
        ? `/import.html?id=${encodeURIComponent(String(data.importId))}`
        : "/import.html"),
    };
  }

  if (type === "titles_import_completed") {
    return {
      icon: "✅",
      title: i18nT("{label} completato", { label }),
      text: explicitMessage || i18nT("{matchedCount} titoli aggiornati nella tua libreria.", { matchedCount }),
      url: safeNotificationPath(data.ctaUrl, "/watchlist.html"),
    };
  }

  return {
    icon: "⚠️",
    title: i18nT("{label} non riuscito", { label }),
    text: explicitMessage || i18nT("Controlla i file scelti oppure riprova dall'importazione."),
    // Le notifiche create prima della correzione server contenevano
    // erroneamente la CTA della libreria. Per un fallimento la destinazione
    // utile è sempre il flusso import/retry, derivato dall'id server-owned.
    url: data.importId
      ? `/import.html?id=${encodeURIComponent(String(data.importId))}`
      : "/import.html",
  };
}

export function adminImportStartedPresentation(notification = {}, fallbackName = i18nT("Un utente")) {
  if (String(notification?.type || "").trim() !== "admin_import_started") return null;

  const data = notification?.data || {};
  const fromName = String(data.fromName || fallbackName || i18nT("Un utente")).trim() || i18nT("Un utente");
  const rows = nonNegativeInt(data.totalRows);
  const importUid = String(data.importUid || notification?.fromUid || "").trim();
  const label = importSourceLabel(data.source);

  return {
    icon: "📥",
    title: i18nT("{fromName} ha avviato un import", { fromName }),
    text: `${label}${rows > 0 ? ` · ${rows} righe` : ""}`,
    url: importUid ? `/user.html?uid=${encodeURIComponent(importUid)}` : "/admin-analytics.html",
  };
}

export function genericServerNotificationPresentation(notification = {}) {
  const data = notification?.data || {};
  const message = String(data.message || data.body || "").trim();
  const ctaUrl = safeNotificationPath(data.ctaUrl, "");
  if (!message && !ctaUrl) return null;

  return {
    icon: "🔔",
    title: i18nT("Somto"),
    text: message,
    url: ctaUrl || "/notifications.html",
  };
}
