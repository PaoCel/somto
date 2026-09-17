"use strict";

// Deve restare allineato al registro PWA: i18n-check-locales fallisce se una
// lingua viene esposta nell'app senza copy push e privacy iOS corrispondenti.
const SUPPORTED_NOTIFICATION_LANGUAGES = Object.freeze(["it", "en"]);

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

function commentReviewPresentation(data = {}, language = "it") {
  const english = String(language || "").trim().toLowerCase().startsWith("en");
  const eligible = nonNegativeInt(data.eligible);
  const resolved = Math.min(eligible, nonNegativeInt(data.resolved));
  const fromName = String(data.fromName || (english ? "A user" : "Un utente")).trim() || (english ? "A user" : "Un utente");
  const title = eligible === 1
    ? (english ? "1 TV Time comment to review" : "1 commento TV Time da revisionare")
    : (english ? `${eligible} TV Time comments to review` : `${eligible} commenti TV Time da revisionare`);

  let body;
  if (eligible === 0) {
    body = english ? `${fromName}: no eligible comments` : `${fromName}: nessun commento idoneo`;
  } else if (resolved === eligible) {
    body = eligible === 1
      ? (english ? `${fromName}: the comment is ready for review` : `${fromName}: il commento è pronto per la revisione`)
      : (english ? `${fromName}: all comments are ready for review` : `${fromName}: tutti i commenti sono pronti per la revisione`);
  } else {
    body = english
      ? `${fromName}: ${resolved} of ${eligible} already matched to titles`
      : `${fromName}: ${resolved} di ${eligible} già associati ai titoli`;
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
  // Destinazioni ammesse per un aggiornamento titolo: la scheda e il post
  // dell'uscita. L'allowlist esiste perche' la ctaUrl viene da un doc: senza,
  // basterebbe scriverci dentro un'altra pagina per dirottare il tap.
  const allowed = explicitUrl.startsWith("/title.html") || explicitUrl.startsWith("/community.html?post=");
  const url = allowed
    ? explicitUrl
    : (titleId ? `/title.html?id=${encodeURIComponent(titleId)}&focus=updates` : "/");
  return {
    title: english ? "Title update" : "Aggiornamento titolo",
    body,
    url,
  };
}

function localizedOrFallback(data, mapKey, sourceKey, language, italian, english) {
  const localized = localizedValue(data?.[mapKey], language);
  if (localized) return localized;
  const isEnglish = String(language || "").trim().toLowerCase().startsWith("en");
  if (!isEnglish) {
    const source = String(data?.[sourceKey] || "").trim();
    if (source) return source;
  }
  return isEnglish ? english : italian;
}

function importLabel(source) {
  const value = String(source || "").trim().toLowerCase();
  if (value === "netflix_csv") return "Import Netflix";
  if (value === "tvtime_gdpr" || value === "tvtime_refract") return "Import TV Time";
  if (value === "trakt") return "Import Trakt";
  return "Import";
}

function importSourceLabel(source, language) {
  const english = String(language || "").trim().toLowerCase().startsWith("en");
  const value = String(source || "").trim();
  if (value === "tvtime_gdpr") return english ? "TV Time (data export)" : "TV Time (export dati)";
  if (value === "tvtime_refract") return "TV Time (Refract)";
  if (value === "netflix_csv") return "Netflix";
  if (value === "trakt") return "Trakt";
  return value || (english ? "a service" : "un servizio");
}

/** Copy push localizzato. Il contenuto scritto dagli utenti (preview) resta invariato. */
function notificationPresentation(type, data = {}, language = "it") {
  const english = String(language || "").trim().toLowerCase().startsWith("en");
  const tr = (italian, translated) => english ? translated : italian;
  const fromName = String(data.fromName || tr("Qualcuno", "Someone")).trim() || tr("Qualcuno", "Someone");
  const preview = String(data.preview || "").slice(0, 80);
  const titleName = String(data.titleName || tr("un titolo", "a title")).trim();
  const label = importLabel(data.source);
  const titleUpdate = titleUpdatePresentation(data, language);
  const review = commentReviewPresentation(data, language);
  let title = tr("Nuova notifica", "New notification");
  let body = tr("Hai una nuova notifica", "You have a new notification");

  switch (type) {
  case "thread_message": title = fromName; body = preview || tr("nuovo messaggio", "new message"); break;
  case "thread_mention": title = fromName; body = tr("ti ha menzionato in un thread", "mentioned you in a thread"); break;
  case "recommendation": title = tr("Nuovo consiglio", "New recommendation"); body = tr(`${fromName} ti ha consigliato un titolo`, `${fromName} recommended a title to you`); break;
  case "follow": title = fromName; body = tr("ha iniziato a seguirti", "started following you"); break;
  case "friend_request": title = fromName; body = tr("ti ha inviato una richiesta", "sent you a request"); break;
  case "friend_accept": title = fromName; body = tr("ha accettato la richiesta", "accepted your request"); break;
  case "post_mention":
    title = fromName;
    body = String(data.context || "") === "rating_comment"
      ? tr("ti ha menzionato su un voto", "mentioned you on a rating")
      : tr("ti ha menzionato in un commento/post", "mentioned you in a comment/post");
    break;
  case "post_like": title = fromName; body = tr("ha messo like al tuo post", "liked your post"); break;
  case "post_comment": title = fromName; body = tr("ha commentato il tuo post", "commented on your post"); break;
  case "comment_reply": title = fromName; body = tr("ha risposto al tuo commento", "replied to your comment"); break;
  case "comment_like":
    title = fromName;
    body = data.threadId
      ? tr(`ha reagito ${String(data.reaction || "").trim()} al tuo commento`, `reacted ${String(data.reaction || "").trim()} to your comment`).replace(/\s+/g, " ").trim()
      : tr("ha messo like al tuo commento", "liked your comment");
    break;
  case "rating_like": title = fromName; body = tr("ha reagito al tuo voto", "reacted to your rating"); break;
  case "rating_comment": title = fromName; body = tr("ha commentato la tua recensione", "commented on your review"); break;
  case "watched_with_tag": title = fromName; body = tr("ti ha taggato in una visione insieme", "tagged you in a watch together"); break;
  case "quiz_challenge_completed": title = tr("Sfida quiz completata", "Quiz challenge completed"); body = tr(`${fromName} ha finito la sfida — vedi chi ha vinto`, `${fromName} finished the challenge — see who won`); break;
  case "new_user": title = tr("Nuovo iscritto", "New member"); body = tr(`${fromName} si è appena iscritto`, `${fromName} just signed up`); break;
  case "moderation_pending": title = tr("Moderazione", "Moderation"); body = tr("Nuovo elemento da approvare", "New item to review"); break;
  case "engagement_nudge": title = "Somto"; body = localizedOrFallback(data, "messageByLocale", "message", language, "Torna su Somto: ci sono nuovi titoli per te", "Come back to Somto: new titles are waiting for you"); break;
  case "engagement_friend_watched": title = fromName; body = english ? `${fromName} watched ${titleName}` : (String(data.message || "").trim() || `${fromName} ha visto ${titleName}`); break;
  case "engagement_watchlist_reminder": title = "Somto"; body = localizedOrFallback(data, "messageByLocale", "message", language, "Hai titoli in watchlist da recuperare", "You have watchlist titles to catch up on"); break;
  case "engagement_friend_activity": title = "Somto"; body = localizedOrFallback(data, "messageByLocale", "message", language, "I tuoi amici sono stati attivi questa settimana", "Your friends were active this week"); break;
  case "new_season_available": {
    const season = nonNegativeInt(data.latestSeasonNumber);
    const series = String(data.titleName || tr("una serie che segui", "a series you follow"));
    title = tr("Nuova stagione disponibile", "New season available");
    body = season > 0 ? tr(`Stagione ${season} di ${series} disponibile`, `Season ${season} of ${series} is available`) : tr(`${series} ha nuovi episodi`, `${series} has new episodes`);
    break;
  }
  case "official_update": title = tr("Aggiornamento Somto", "Somto update"); body = preview || String(data.title || "").trim() || tr("C'è un aggiornamento ufficiale su Somto", "There is an official update on Somto"); break;
  case "weekly_digest": title = tr("Novità sui tuoi titoli", "Updates on your titles"); body = localizedOrFallback(data, "messageByLocale", "message", language, String(data.preview || "").trim() || "Ci sono novità sui titoli che segui", "There are updates on titles you follow"); break;
  case "title_update": title = titleUpdate.title; body = titleUpdate.body; break;
  case "titles_import_completed": title = tr(`${label} completato`, `${label} completed`); body = localizedOrFallback(data, "messageByLocale", "message", language, "I risultati sono nella tua libreria", "The results are in your library"); break;
  case "titles_import_needs_review": title = tr(`${label} da controllare`, `${label} to review`); body = localizedOrFallback(data, "messageByLocale", "message", language, "Apri Somto per confermare alcuni titoli", "Open Somto to confirm some titles"); break;
  case "titles_import_failed": title = tr(`${label} non riuscito`, `${label} failed`); body = localizedOrFallback(data, "messageByLocale", "message", language, "Puoi riprovare quando vuoi", "You can try again whenever you want"); break;
  case "admin_import_started": {
    const rows = nonNegativeInt(data.totalRows);
    const rowsPart = rows > 0 ? tr(` (${rows} righe)`, ` (${rows} rows)`) : "";
    title = tr("Nuovo import", "New import");
    body = tr(`${fromName} ha avviato un import ${importSourceLabel(data.source, language)}${rowsPart}`, `${fromName} started a ${importSourceLabel(data.source, language)} import${rowsPart}`);
    break;
  }
  case "admin_activity": title = fromName; body = String(data.message || "").trim() || tr("Nuova attività su Somto", "New activity on Somto"); break;
  case "client_error_alert": title = tr("Errore web rilevato", "Web error detected"); body = String(data.message || "").trim() || tr("Somto ha rilevato un errore web", "Somto detected a web error"); break;
  case "push_coverage_report": title = tr("Copertura notifiche", "Notification coverage"); body = String(data.message || "").trim() || tr("Report settimanale della copertura push", "Weekly push coverage report"); break;
  case "official_source_report": title = tr("Fonti ufficiali da controllare", "Official sources to review"); body = String(data.message || "").trim() || tr("Ci sono annunci ufficiali da rivedere", "There are official announcements to review"); break;
  case "import_health_alert": title = tr("Import da controllare", "Imports to review"); body = String(data.message || "").trim() || tr("Ci sono import da controllare", "There are imports to review"); break;
  case "notification_health_alert": title = data.state === "recovered" ? tr("Notifiche di nuovo regolari", "Notifications back to normal") : tr("Notifiche da controllare", "Notifications to review"); body = String(data.message || "").trim() || tr("Ci sono notifiche da controllare", "There are notifications to review"); break;
  case "comment_review_pending": title = review.title; body = review.body; break;
  case "friend_post": title = fromName; body = preview || tr("ha pubblicato un post", "published a post"); break;
  default: break;
  }

  return { title, body };
}

module.exports = {
  SUPPORTED_NOTIFICATION_LANGUAGES,
  nonNegativeInt,
  commentReviewUrl,
  commentReviewPresentation,
  localizedValue,
  notificationPresentation,
  titleUpdatePresentation,
};
