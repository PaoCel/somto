const TMDB_PROVIDER_LOGO_BASE = "https://image.tmdb.org/t/p/w154";

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeString(value, maxLen = 240) {
  return String(value || "").slice(0, maxLen);
}

function sanitizeHttpUrl(value, maxLen = 500) {
  const raw = safeString(value, maxLen).trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return parsed.toString();
  } catch (_) {
    return "";
  }
}

function providerLogoUrl(logoPath) {
  const raw = safeString(logoPath, 260).trim();
  if (!raw) return "";
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  return `${TMDB_PROVIDER_LOGO_BASE}${raw}`;
}

function normalizeProviderRows(rows) {
  const dedupe = new Map();

  safeArray(rows).forEach((row) => {
    const providerId = Number(row?.provider_id || 0);
    const name = safeString(row?.provider_name, 120).trim();
    if (!providerId || !name) return;
    if (dedupe.has(providerId)) return;

    dedupe.set(providerId, {
      providerId,
      name,
      logoPath: safeString(row?.logo_path, 260).trim(),
      logoUrl: providerLogoUrl(row?.logo_path),
      priority: Number(row?.display_priority || 0) || 0,
    });
  });

  return Array.from(dedupe.values());
}

function normalizeCustomProviders(rows) {
  return safeArray(rows)
    .map((row) => ({
      name: safeString(row?.name, 120).trim(),
      url: sanitizeHttpUrl(row?.url),
      note: safeString(row?.note, 180).trim(),
      by: safeString(row?.by, 80).trim(),
    }))
    .filter((row) => row.name)
    .slice(0, 20);
}

function normalizeProvidersForRegion(tmdbPayload, region = "IT") {
  const reg = String(region || "IT").trim().toUpperCase() || "IT";
  const regionData = tmdbPayload?.results?.[reg] || {};

  return {
    region: reg,
    link: sanitizeHttpUrl(regionData?.link),
    flatrate: normalizeProviderRows(regionData?.flatrate),
    rent: normalizeProviderRows(regionData?.rent),
    buy: normalizeProviderRows(regionData?.buy),
    free: normalizeProviderRows(regionData?.free),
    ads: normalizeProviderRows(regionData?.ads),
  };
}

function hasAnyProvidersBundle(bundle) {
  const b = bundle || {};
  return ["flatrate", "rent", "buy", "free", "ads"].some((key) => safeArray(b[key]).length > 0);
}

// Nomi piattaforma "watchabili con abbonamento/gratis" (flatrate/free/ads + override
// admin), deduplicati. Esclude rent/buy (transazionali, renderebbero il raggruppamento
// inutile perché quasi ogni titolo è noleggiabile ovunque). Denormalizzato su
// titles/{id}.watchProviderNames per filtrare/raggruppare la watchlist senza fetch extra.
function extractStreamingPlatformNames(bundle, customAdmin) {
  const b = bundle || {};
  const rows = [
    ...safeArray(b.flatrate),
    ...safeArray(b.free),
    ...safeArray(b.ads),
    ...safeArray(customAdmin),
  ];
  const names = rows.map((p) => safeString(p && p.name, 120).trim()).filter(Boolean);
  return [...new Set(names)];
}

// Coppie {name, logoUrl} per lo stesso sottoinsieme streaming di
// extractStreamingPlatformNames. Denormalizzate su titles/{id}.watchProviderLogos
// (array, non mappa: i nomi provider possono contenere caratteri vietati nelle
// chiavi Firestore) per mostrare i loghi su chip/badge watchlist senza fetch
// extra. I provider custom admin non hanno logo: restano fuori, il client fa
// fallback sul nome testuale.
function extractStreamingPlatformLogos(bundle, customAdmin) {
  const b = bundle || {};
  const rows = [
    ...safeArray(b.flatrate),
    ...safeArray(b.free),
    ...safeArray(b.ads),
    ...safeArray(customAdmin),
  ];
  const seen = new Set();
  const logos = [];
  rows.forEach((p) => {
    const name = safeString(p && p.name, 120).trim();
    const logoUrl = sanitizeHttpUrl(p && p.logoUrl);
    if (!name || !logoUrl || seen.has(name)) return;
    seen.add(name);
    logos.push({ name, logoUrl });
  });
  return logos.slice(0, 20);
}

module.exports = {
  sanitizeHttpUrl,
  normalizeProviderRows,
  normalizeCustomProviders,
  normalizeProvidersForRegion,
  hasAnyProvidersBundle,
  extractStreamingPlatformNames,
  extractStreamingPlatformLogos,
};

