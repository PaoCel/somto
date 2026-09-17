// commentEcho.js — trasforma un messaggio di thread pubblico (commento su
// film / serie / episodio) in un "post gemello" nella collection `posts`, così
// che compaia nel feed Community senza duplicare card, like, condivisione e
// deep-link lato client.
//
// Invarianti:
// - l'id del post è DETERMINISTICO (`tm_<hash(threadId:messageId)>`): il
//   trigger e lo script di backfill possono girare più volte senza creare
//   doppioni, e la cancellazione del messaggio sa quale post rimuovere;
// - il post è server-owned: `skipAutoFeedFanout` blocca il fan-out `feedEvents`
//   e la notifica "ha pubblicato un post" (vedi onPostCreatedFeedEvent), il
//   post raggiunge il feed solo via query pubblica;
// - `spoilerScope` porta le coordinate (titolo / stagione / episodio) su cui il
//   client calcola il gate anti-spoiler in base al progresso del viewer.
//
// Modulo PURO: nessun admin SDK, nessuna I/O. Tutto testabile a mano.

const { createHash } = require("crypto");

const ECHO_SOURCE_KIND = "thread_message";
const ECHO_ID_PREFIX = "tm_";
// Visibilità DEDICATA, non "public": i client vecchi (iOS già sullo Store,
// tab Community del profilo) interrogano `visibility == "public"` e
// mostrerebbero questi contenuti SENZA il gate anti-spoiler per progresso,
// che non conoscono. Con un valore proprio restano invisibili a loro e
// visibili solo a chi sa gatearli. Le rules lo trattano come pubblico in
// lettura per gli utenti loggati; i client non possono crearlo (la whitelist
// di `validPostPayload` resta public/friends/private).
const ECHO_VISIBILITY = "comment";
// Stesso tetto di `posts.text` nelle rules. I messaggi thread arrivano fino a
// 5000 caratteri: quelli più lunghi vengono clippati e marcati `textTruncated`,
// la card rimanda al thread per il testo intero.
const MAX_ECHO_TEXT_LEN = 2000;
const MAX_AUTHOR_NAME_LEN = 80;
const MAX_ID_LEN = 120;

function safeString(value, maxLen) {
  const s = String(value == null ? "" : value).trim();
  if (!s) return "";
  return s.slice(0, Math.max(0, Number(maxLen || 0)));
}

function toId(value) {
  return safeString(value, MAX_ID_LEN);
}

/**
 * Riconosce gli id dei thread pubblici e ne estrae le coordinate.
 *
 *   public_<titleId>            → { level: "title" }
 *   public_<titleId>_s3e7       → { level: "episode", season: 3, episode: 7 }
 *
 * Ritorna null per dm_*, group_* e per qualunque id non pubblico: quei thread
 * NON vengono mai eco-postati.
 */
function parsePublicThreadId(threadId) {
  const id = String(threadId || "").trim();
  if (!id.startsWith("public_")) return null;

  // Il titleId può contenere underscore: si ancora la coda `_sNeM` alla fine.
  const episodeMatch = id.match(/^public_(.+)_s(\d+)e(\d+)$/);
  if (episodeMatch) {
    const titleId = toId(episodeMatch[1]);
    const season = Number(episodeMatch[2]);
    const episode = Number(episodeMatch[3]);
    if (!titleId || !Number.isFinite(season) || !Number.isFinite(episode)) return null;
    if (season <= 0 || episode <= 0) return null;
    return { titleId, level: "episode", season, episode };
  }

  const titleId = toId(id.slice("public_".length));
  if (!titleId) return null;
  return { titleId, level: "title", season: null, episode: null };
}

/** Id deterministico del post gemello. Stabile fra trigger e backfill. */
function buildEchoPostId(threadId, messageId) {
  const tid = String(threadId || "").trim();
  const mid = String(messageId || "").trim();
  if (!tid || !mid) throw new Error("threadId and messageId are required");
  const hash = createHash("sha1").update(`${tid}::${mid}`).digest("hex").slice(0, 32);
  return `${ECHO_ID_PREFIX}${hash}`;
}

function isEchoPostId(postId) {
  return String(postId || "").startsWith(ECHO_ID_PREFIX);
}

/** Il doc `posts` è un eco di un commento? (guardia per i trigger su posts) */
function isEchoPostData(data) {
  return Boolean(data) && String(data.sourceKind || "") === ECHO_SOURCE_KIND;
}

function threadIsPublic(threadId, threadData) {
  const visibility = String(threadData?.visibility || "").trim().toLowerCase();
  if (visibility === "private") return false;
  if (visibility === "public") return true;
  // Thread legacy senza `visibility`: vale l'id (stessa euristica delle rules).
  return String(threadId || "").startsWith("public_");
}

/**
 * Un messaggio va eco-postato solo se: thread pubblico con coordinate valide,
 * autore presente, e contenuto reale (testo non vuoto oppure GIF).
 */
function shouldEchoThreadMessage({ threadId, threadData, message } = {}) {
  const scope = parsePublicThreadId(threadId);
  if (!scope) return false;
  if (!threadIsPublic(threadId, threadData)) return false;
  if (!message || typeof message !== "object") return false;
  if (!toId(message.uid)) return false;

  const type = String(message.type || "text").trim().toLowerCase();
  if (type !== "text" && type !== "gif") return false;

  const hasText = safeString(message.text, MAX_ECHO_TEXT_LEN).length > 0;
  const hasGif = safeString(message.gifUrl, 600).length > 0;
  if (type === "gif") return hasGif;
  return hasText;
}

/**
 * Costruisce il doc `posts` gemello. `createdAt` resta quello del messaggio
 * originale (niente date finte: i commenti storici del backfill mantengono la
 * loro data e vengono fatti emergere dal ranking per titolo, non per recency).
 *
 * @param {Object} args
 * @param {string} args.threadId
 * @param {string} args.messageId
 * @param {Object} args.message      doc `threads/{tid}/messages/{mid}`
 * @param {Object} [args.threadData] doc `threads/{tid}` (per visibility/titleId)
 * @param {*} [args.now]             valore per `updatedAt` (serverTimestamp)
 * @returns {Object|null}
 */
function buildEchoPostData({ threadId, messageId, message, threadData = null, now = null } = {}) {
  if (!shouldEchoThreadMessage({ threadId, threadData, message })) return null;

  const scope = parsePublicThreadId(threadId);
  // Il titleId del doc thread ha la precedenza: l'id è solo il fallback per i
  // thread scritti prima che il campo esistesse.
  const titleId = toId(threadData?.titleId) || scope.titleId;
  if (!titleId) return null;

  const rawText = String(message.text || "").trim();
  const text = safeString(rawText, MAX_ECHO_TEXT_LEN);
  const gifUrl = safeString(message.gifUrl, 600);

  const data = {
    authorUid: toId(message.uid),
    authorName: safeString(message.displayName, MAX_AUTHOR_NAME_LEN) || "User",
    text,
    titleId,
    kind: "post",
    visibility: ECHO_VISIBILITY,
    createdAt: message.createdAt || null,
    updatedAt: now || message.createdAt || null,

    // Provenienza + coordinate anti-spoiler (lette dal client).
    sourceKind: ECHO_SOURCE_KIND,
    sourceThreadId: toId(threadId),
    sourceMessageId: toId(messageId),
    spoilerScope: {
      titleId,
      level: scope.level,
      season: scope.season,
      episode: scope.episode,
    },

    // Niente fan-out feedEvents né notifica "ha pubblicato un post": l'eco
    // vive solo nella query pubblica del feed.
    skipAutoFeedFanout: true,
  };

  if (rawText.length > MAX_ECHO_TEXT_LEN) {
    data.textTruncated = true;
  }
  if (gifUrl) {
    data.mediaUrl = gifUrl;
  }
  if (message.containsSpoiler === true) {
    data.containsSpoiler = true;
    data.spoilerTitleIds = Array.isArray(message.spoilerTitleIds)
      ? message.spoilerTitleIds.map((v) => toId(v)).filter(Boolean).slice(0, 5)
      : [];
  }
  if (message.isSynthetic === true) {
    data.isSynthetic = true;
  }

  return data;
}

module.exports = {
  ECHO_SOURCE_KIND,
  ECHO_ID_PREFIX,
  ECHO_VISIBILITY,
  MAX_ECHO_TEXT_LEN,
  parsePublicThreadId,
  buildEchoPostId,
  isEchoPostId,
  isEchoPostData,
  threadIsPublic,
  shouldEchoThreadMessage,
  buildEchoPostData,
};
