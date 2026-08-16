"use strict";

function nonNegativeInt(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.trunc(number));
}

function commentReviewUrl(data = {}) {
  const explicit = String(data.ctaUrl || "").trim();
  if (explicit.startsWith("/admin-import-comments.html")) return explicit;

  const uid = String(data.importUid || "").trim();
  const importId = String(data.importId || "").trim();
  const params = new URLSearchParams();
  if (uid) params.set("uid", uid);
  if (importId) params.set("importId", importId);
  const query = params.toString();
  return `/admin-import-comments.html${query ? `?${query}` : ""}`;
}

function commentReviewPresentation(data = {}) {
  const eligible = nonNegativeInt(data.eligible);
  const resolved = Math.min(eligible, nonNegativeInt(data.resolved));
  const fromName = String(data.fromName || "Un utente").trim() || "Un utente";
  const title = eligible === 1
    ? "1 commento TV Time da revisionare"
    : `${eligible} commenti TV Time da revisionare`;

  let body;
  if (eligible === 0) {
    body = `${fromName}: nessun commento idoneo`;
  } else if (resolved === eligible) {
    body = eligible === 1
      ? `${fromName}: il commento è pronto per la revisione`
      : `${fromName}: tutti i commenti sono pronti per la revisione`;
  } else {
    body = `${fromName}: ${resolved} di ${eligible} già associati ai titoli`;
  }

  return {
    eligible,
    resolved,
    title,
    body,
    url: commentReviewUrl(data),
  };
}

function localizedValue(value, language, fallback = "") {
  const map = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const rawLanguage = String(language || "").trim().toLowerCase();
  const preferred = rawLanguage.startsWith("en") ? "en-US" : "it-IT";
  return String(map[preferred] || map["en-US"] || map["it-IT"] || map.und || fallback || "").trim();
}

function titleUpdatePresentation(data = {}, language = "it") {
  const english = String(language || "").trim().toLowerCase().startsWith("en");
  const titleName = String(data.titleName || "").trim();
  const fallbackBody = titleName
    ? (english ? `${titleName} has a new update.` : `${titleName} ha un nuovo aggiornamento.`)
    : (english ? "There is a new title update." : "C'è un nuovo aggiornamento su un titolo.");
  const body = localizedValue(
    data.messageByLocale,
    language,
    localizedValue(data.headlineByLocale, language, english ? fallbackBody : (data.preview || fallbackBody))
  ) || fallbackBody;
  const explicitUrl = String(data.ctaUrl || "").trim();
  const titleId = String(data.titleId || "").trim();
  const url = explicitUrl.startsWith("/title.html")
    ? explicitUrl
    : (titleId ? `/title.html?id=${encodeURIComponent(titleId)}&focus=updates` : "/");
  return {
    title: english ? "Title update" : "Aggiornamento titolo",
    body,
    url,
  };
}

module.exports = {
  nonNegativeInt,
  commentReviewUrl,
  commentReviewPresentation,
  localizedValue,
  titleUpdatePresentation,
};
