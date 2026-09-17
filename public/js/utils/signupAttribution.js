const UTM_KEYS = Object.freeze(["utm_source", "utm_medium", "utm_campaign"]);

function cleanToken(value, max = 64) {
  const token = String(value || "").trim().replace(/[^A-Za-z0-9._~-]+/g, "").slice(0, max);
  return token || null;
}

export function buildSignupAttribution({
  pageUrl = "",
  referrer = "",
  language = "",
  analyticsConsent = null,
  appVersion = "web",
} = {}) {
  let url = null;
  try { url = new URL(pageUrl, "https://somto.it"); } catch (_) {}
  let referrerHost = null;
  try { referrerHost = new URL(referrer).hostname.toLowerCase() || null; } catch (_) {}
  const params = url?.searchParams || new URLSearchParams();
  const utm = Object.fromEntries(UTM_KEYS.map((key) => [key, cleanToken(params.get(key))]));
  return {
    surface: "web",
    appVersion: cleanToken(appVersion, 32),
    landingPath: url?.pathname?.startsWith("/") ? url.pathname.slice(0, 160) : null,
    referrerHost,
    utmSource: utm.utm_source,
    utmMedium: utm.utm_medium,
    utmCampaign: utm.utm_campaign,
    language: cleanToken(language, 16),
    analyticsConsent: typeof analyticsConsent === "boolean" ? analyticsConsent : null,
    selfReportedSource: null,
  };
}
