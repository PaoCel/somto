"use strict";

// Republish path for TV Time episode comments (see docs / CLAUDE.md "TV Time
// comment republish"). PURE module: no Firestore, no I/O. Given the parsed
// episode-comment rows (parseTvTimeEpisodeCommentsCsv output), it decides which
// ones are eligible to be republished as Somto episode-thread messages ON
// BEHALF OF THE IMPORTING USER, and shapes the review-queue + thread-message
// payloads. Actual writes (and the human review gate) live in index.js.
//
// Two independent filters gate a comment:
//   1. classification — only "standalone" and "self_thread" survive. A
//      "reply_other" is a reply to a comment we don't have on Somto (it lived
//      on TV Time), so it would be an orphan reply with no context.
//   2. quality — drop pure-emoji / hashtag-only / one-word / too-short blurbs
//      (TV Time comments were often just meme captions like "😍❤" or "#love").

const { createHash } = require("crypto");

const PUBLISHABLE_CLASSIFICATIONS = new Set(["standalone", "self_thread"]);

const DEFAULT_QUALITY = {
  minMeaningfulChars: 8, // letters/digits after stripping emoji, punctuation, whitespace
  minWords: 2,           // at least two whitespace-separated tokens
  maxChars: 5000,        // Somto thread message hard cap (rules)
};

// Strip emoji, symbols, punctuation and whitespace — leaves letters/numbers
// (any script) so "meaningful length" isn't inflated by emoji or "#". Uses
// Unicode property escapes (Node >= 12); falls back gracefully if unsupported.
function meaningfulChars(text) {
  const s = String(text || "");
  try {
    return s.replace(/[^\p{L}\p{N}]/gu, "");
  } catch (_) {
    // Environment without Unicode property escapes — approximate with a
    // conservative ASCII+word fallback (never throws).
    return s.replace(/[^0-9A-Za-zÀ-ÿ]/g, "");
  }
}

function wordCount(text) {
  const t = String(text || "").trim();
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

/**
 * True when `text` is substantial enough to be worth republishing publicly.
 * Rejects empty/"null", pure-emoji, single hashtags, one-word blurbs e le
 * risposte @qualcuno.
 */
function passesQualityGate(text, opts = {}) {
  const cfg = { ...DEFAULT_QUALITY, ...opts };
  const raw = String(text || "").trim();
  if (!raw || raw.toLowerCase() === "null") return false;
  if (raw.length > cfg.maxChars) return false; // absurdly long — treat as junk, don't truncate silently
  // "@Silvia Giaimo È che ci stanno rendendo il compito fin troppo facile":
  // una risposta a un utente TV Time che su Somto non esiste. La
  // classificazione la vede come standalone (il thread di origine non e' nei
  // dati), quindi solo il testo la smaschera. Su 164 candidati reali erano 22.
  if (raw.startsWith("@")) return false;
  if (meaningfulChars(raw).length < cfg.minMeaningfulChars) return false;
  if (wordCount(raw) < cfg.minWords) return false;
  return true;
}

/**
 * Classifies every parsed comment into one bucket for reporting, and returns
 * the subset that is eligible to enter the review queue (publishable class +
 * quality gate). Never throws.
 *
 * @returns {{
 *   counts: {total,standalone,selfThread,replyOther,qualityRejected,eligible},
 *   eligible: Array<object>   // the comments that passed BOTH gates
 * }}
 */
function selectPublishableEpisodeComments(comments, opts = {}) {
  const list = Array.isArray(comments) ? comments : [];
  const counts = { total: list.length, standalone: 0, selfThread: 0, replyOther: 0, qualityRejected: 0, eligible: 0 };
  const eligible = [];
  for (const c of list) {
    const klass = c && c.classification;
    if (klass === "standalone") counts.standalone += 1;
    else if (klass === "self_thread") counts.selfThread += 1;
    else { counts.replyOther += 1; continue; }

    if (!PUBLISHABLE_CLASSIFICATIONS.has(klass)) continue;
    if (!passesQualityGate(c.text, opts.quality)) { counts.qualityRejected += 1; continue; }
    eligible.push(c);
  }
  counts.eligible = eligible.length;
  return { counts, eligible };
}

/**
 * Deterministic Somto thread-message doc id for an imported comment. Stable
 * across re-runs of the import so a re-processed job overwrites (merges) the
 * same message instead of duplicating it. Also lets us find/rollback imported
 * messages later without a marker field (a `source` key would break the thread
 * reaction rule's hasOnly()).
 */
function episodeCommentMessageId({ uid, titleId, season, episode, commentId }) {
  const identity = commentId
    ? `cid:${commentId}`
    : `se:${season}:${episode}`;
  return createHash("sha256")
    .update(`tvtime-comment|${uid}|${titleId}|${season}|${episode}|${identity}`)
    .digest("hex")
    .slice(0, 40);
}

/**
 * Stable review-queue candidate doc id (independent of match resolution so it
 * survives an unresolved→resolved re-run). One per source comment.
 */
function reviewCandidateId({ commentId, seriesNameGuess, season, episode }) {
  const identity = commentId
    ? `cid:${commentId}`
    : `sn:${String(seriesNameGuess || "").toLowerCase()}:${season}:${episode}`;
  return createHash("sha256").update(`tvtime-comment-review|${identity}`).digest("hex").slice(0, 40);
}

/**
 * Builds the review-queue candidate payload (server-written, admin-read). Holds
 * everything the human reviewer + the publish step need. `titleId` is null when
 * the series didn't resolve to a Somto title (surfaced, never silently lost).
 * The message is NOT published here — publishImportComments does that after a
 * human approves.
 */
function buildReviewCandidate({ uid, importId, comment, titleId, now }) {
  const text = String(comment.text || "").trim();
  const season = Number(comment.seasonNumber);
  const episode = Number(comment.episodeNumber);
  return {
    id: reviewCandidateId({ commentId: comment.commentId, seriesNameGuess: comment.seriesNameGuess, season, episode }),
    payload: {
      uid,
      importId,
      status: "pending",        // pending | approved | rejected
      published: false,
      publishedMessageId: null,
      seriesName: String(comment.seriesNameGuess || "").slice(0, 500),
      season,
      episode,
      text: text.slice(0, 5000),
      classification: comment.classification || null,
      spoilerCount: Number(comment.spoilerCount) || 0,
      nbLikes: Number(comment.nbLikes) || 0,
      titleId: titleId || null,
      resolved: Boolean(titleId),
      sourceCommentId: comment.commentId || null,
      originalCreatedAt: comment.createdAt instanceof Date ? comment.createdAt : null,
      createdAt: now || null,
      updatedAt: now || null,
    },
  };
}

/**
 * Shapes the Somto thread-message document for a candidate at publish time.
 * Keys stay within the thread-message rule allow-list (uid, displayName, text,
 * type, createdAt, containsSpoiler, spoilerTitleIds) so imported messages read
 * and react exactly like native ones. containsSpoiler defaults ON when the
 * source had any spoiler flag OR the caller forces it.
 */
function buildThreadMessage({ uid, displayName, candidate, forceSpoiler = false }) {
  const spoiler = forceSpoiler || (Number(candidate.spoilerCount) || 0) > 0;
  const msg = {
    uid,
    displayName: String(displayName || "").slice(0, 80) || "Anonimo",
    text: String(candidate.text || "").slice(0, 5000),
    type: "text",
    // createdAt is set by the caller (serverTimestamp OR Timestamp.fromDate of
    // the original date) — kept out of this pure builder.
  };
  if (spoiler) {
    msg.containsSpoiler = true;
    msg.spoilerTitleIds = candidate.titleId ? [String(candidate.titleId)] : [];
  }
  return msg;
}

module.exports = {
  DEFAULT_QUALITY,
  PUBLISHABLE_CLASSIFICATIONS,
  meaningfulChars,
  wordCount,
  passesQualityGate,
  selectPublishableEpisodeComments,
  episodeCommentMessageId,
  reviewCandidateId,
  buildReviewCandidate,
  buildThreadMessage,
};
