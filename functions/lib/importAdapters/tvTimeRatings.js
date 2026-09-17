"use strict";

// TV Time GDPR export adapter — PARSER for votes (star ratings), movie/episode
// "emotions", and comments, covering both movies and TV episodes. Produces
// normalized intermediate rows that the caller matches against Somto's catalog
// (same cascade as the rest of the import) and turns into `ratings/{id}` writes
// (ratings) or `titleEmotions/{id}` writes (emotions). PURE parser: no
// Firestore, no TMDB, no I/O.
//
// ============================================================================
// TWO SEPARATE NAMESPACES — DISAMBIGUATED BY SOURCE FILE, NEVER BY ID VALUE
// ============================================================================
// TV Time encodes both a numeric RATING and, separately, an EMOTION reaction as
// the suffix of `vote_key` (`<uuid>-<userId>-<optionId>`). The two namespaces
// COLLIDE (e.g. id 3 = "Wow" as a rating BUT "Sad" as an emotion; id 29 = "Meh"
// rating BUT "Frustrated" emotion) — so the meaning of an id is decided ONLY by
// which FILE it came from:
//
//   ratings-3-prod-episode_votes.csv -> EPISODE ratings   (3-level scale)  -> rating level=episode
//   ratings-live-votes.csv           -> MOVIE   ratings   (3-level scale)  -> rating level=title
//   emotions-live-votes.csv          -> MOVIE   emotions  (12-reaction)    -> titleEmotions (NOT a rating)
//   emotions-3-prod-episode_votes.csv-> EPISODE emotions  (12-reaction)    -> future (not parsed yet)
//
// HISTORY OF THE BUG (fixed 2026-07-09): the movie file `emotions-live-votes.csv`
// was mistakenly imported as a STAR RATING via a flat {26..30} map. That turned
// an emotion like "Sad" (id 30) into a 10/10 rating and "Shocked" (id 28) into
// 7/10 — corrupting user profiles AND public community averages. Movies never
// had a star-rating file wired at all; real movie ratings live in
// `ratings-live-votes.csv` (now read). Movie *emotions* are stashed into
// titleEmotions for the (separate) emotion feature, never as ratings.
//
// ============================================================================
// RATING SCALE — SCALE-AWARE (ids are NOT universal)
// ============================================================================
// TV Time's rating UI evolved (emotion-derived score -> 3-level -> 5-star), and
// the GDPR export is a raw DynamoDB dump, so different files/eras carry
// DIFFERENT id namespaces that collide with OPPOSITE rank:
//
//   id | 3-level (ep_3level)      | 5-star (star_5)
//   ---+-------------------------+-----------------
//    3 | WOW (best)              | —
//   26 | —                       | BRUTTO
//   27 | GOOD                    | OK
//   28 | —                       | BELLO
//   29 | MEH (worst)             | SUPER
//   30 | —                       | WOW
//
// id 29 = worst in ep_3level but near-best in star_5 -> we MUST resolve the
// SCALE of a file first, then map id -> ordinal -> Somto decimal. Detection is
// per-FILE (not per-row: 27/29 are ambiguous), from unambiguous marker ids
// (SCALE_MARKERS). The 3-level scale (3/27/29 = Wow/Good/Meh) is CONFIRMED on
// real exports (decoded via the community tool tv-time-capsule + cross-checked
// on real users). Somto decimals (admin's choice, 2026-07-09):
//   Wow -> 10    Good -> 7    Meh -> 5
// The 5-star scale is defined for completeness but not currently produced by
// any wired file. Any id NOT in the detected scale is COUNTED (unrecognized),
// never guessed; if the single most-common id in a file is unrecognized the
// file is flagged (dominantIdUnrecognized) — the signal a new scale arrived.

// Rating scale registry. Add a new entry (+ its unambiguous marker ids in
// SCALE_MARKERS) when a new export surfaces an unknown scale.
const VOTE_SCALES = {
  ep_3level: {
    ids: { 3: "wow", 27: "good", 29: "meh" },
    decimals: { wow: 10, good: 7, meh: 5 },
  },
  star_5: {
    ids: { 26: "brutto", 27: "ok", 28: "bello", 29: "super", 30: "wow" },
    decimals: { brutto: 4, ok: 6, bello: 7, super: 9, wow: 10 },
  },
};

// Ids UNIQUE to a single rating scale — the only ones that can DISCRIMINATE
// which scale a file uses (27 & 29 exist in both with opposite rank).
const SCALE_MARKERS = {
  ep_3level: new Set([3]),
  star_5: new Set([26, 28, 30]),
};

// Back-compat export: the decimal map for the CONFIRMED episode scale, by id.
const TVTIME_VOTE_ID_TO_DECIMAL = Object.fromEntries(
  Object.entries(VOTE_SCALES.ep_3level.ids).map(([id, label]) => [
    Number(id),
    VOTE_SCALES.ep_3level.decimals[label],
  ])
);

// ============================================================================
// EMOTION REGISTRY (separate namespace — emotions-* files ONLY)
// ============================================================================
// TV Time's 12 movie/episode "impression" reactions map 1:1, in order, onto
// Somto's canonical emotion keys (functions/lib/emotionAggregate.js EMOTION_KEYS
// / firestore.rules). Verified via tv-time-capsule REACTION_LABELS on a real
// movie export. Ids 28..39 are the current set; 1/2/3/6/7/8 are a legacy set
// seen on older accounts. NEVER applied to a ratings-* file (see the namespace
// note above — id 3 is "Sad" here but "Wow" as a rating).
const EMOTION_ID_TO_KEY = {
  // current 12-reaction set
  28: "shocked",
  29: "frustrated",
  30: "sad",
  31: "reflective",
  32: "touched",
  33: "amused",
  34: "scared",
  35: "bored",
  36: "understood",
  37: "thrilled",
  38: "confused",
  39: "tense",
  // legacy set (older accounts)
  1: "touched",
  2: "confused",
  3: "sad",
  6: "amused",
  7: "bored",
  8: "frustrated",
};

// Max emotions Somto stores per title (mirrors the titleEmotions schema: 1..3).
const MAX_EMOTIONS_PER_TITLE = 3;

function safeString(value, maxLen = 500) {
  return String(value ?? "").trim().slice(0, maxLen);
}

function toPositiveIntOrNull(value) {
  const n = Number(String(value ?? "").trim());
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function parseTvTimeDateTime(raw) {
  const trimmed = safeString(raw, 32);
  const m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const hh = m[4] ? Number(m[4]) : 12;
  const mm = m[5] ? Number(m[5]) : 0;
  const ss = m[6] ? Number(m[6]) : 0;
  const d = new Date(Date.UTC(year, month - 1, day, hh, mm, ss));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d;
}

/**
 * Extracts the numeric vote-option-id suffix from a `vote_key` like
 * "55452-109813159-28" -> 28 (the last hyphen-separated segment).
 */
function extractVoteOptionId(voteKey) {
  const raw = safeString(voteKey, 200);
  if (!raw) return null;
  const lastDash = raw.lastIndexOf("-");
  if (lastDash === -1) return null;
  return toPositiveIntOrNull(raw.slice(lastDash + 1));
}

/**
 * Resolves a vote-option-id to a Somto 1-10 rating WITHIN a known scale, or
 * null if the id isn't part of that scale — callers must count these as
 * "unrecognized votes", never guess. `scale` is a key of VOTE_SCALES.
 */
function resolveVoteToDecimalRating(voteOptionId, scale = "ep_3level") {
  const def = VOTE_SCALES[scale];
  if (!def) return null;
  const label = def.ids[voteOptionId];
  if (!label) return null;
  return def.decimals[label] ?? null;
}

/**
 * Resolves an emotion-option-id (emotions-* files only) to a canonical Somto
 * emotion key, or null if unknown (counted, never guessed).
 */
function resolveEmotionKey(emotionOptionId) {
  return EMOTION_ID_TO_KEY[emotionOptionId] || null;
}

/**
 * Counts how many times each vote-option-id appears (id -> count), for scale
 * detection and for surfacing per-id histograms in the import summary.
 */
function tallyVoteIds(voteOptionIds) {
  const counts = {};
  for (const id of voteOptionIds) {
    if (id == null) continue;
    counts[id] = (counts[id] || 0) + 1;
  }
  return counts;
}

/**
 * Detects which rating scale a file uses from its id histogram, using ONLY the
 * unambiguous marker ids (SCALE_MARKERS). Ambiguous-only files (just 27/29)
 * fall back to `defaultScale`. Conflicting markers -> majority wins + ambiguous.
 */
function detectVoteScale(idCounts, { defaultScale = "ep_3level" } = {}) {
  let ep = 0;
  let star = 0;
  for (const [id, n] of Object.entries(idCounts)) {
    const k = Number(id);
    if (SCALE_MARKERS.ep_3level.has(k)) ep += n;
    if (SCALE_MARKERS.star_5.has(k)) star += n;
  }
  if (ep > 0 && star === 0) return { scale: "ep_3level", ambiguous: false };
  if (star > 0 && ep === 0) return { scale: "star_5", ambiguous: false };
  if (ep === 0 && star === 0) return { scale: defaultScale, ambiguous: false }; // only 27/29 present
  return { scale: ep >= star ? "ep_3level" : "star_5", ambiguous: true }; // conflicting markers
}

/**
 * Returns the single most-frequent id in a histogram, or null if empty.
 */
function dominantId(idCounts) {
  let best = null;
  let bestN = -1;
  for (const [id, n] of Object.entries(idCounts)) {
    if (n > bestN) { bestN = n; best = Number(id); }
  }
  return best;
}

/* ===== shared: parse a "<items>-<user>-<optionId>" votes CSV into rows ===== */
// ratings-3-prod-episode_votes.csv AND ratings-live-votes.csv share the same
// suffix encoding; the difference is the item key (series+season+episode vs
// movie_name). This helper does the two-pass scale-aware decode; `mapRow`
// projects each raw record into the caller's row shape.
function parseScaleAwareVotesCsv(rawText, { requiredCols, mapRow }) {
  const { parseCsv } = require("./csv");
  const table = parseCsv(rawText || "");
  const empty = { rows: [], errors: [], scale: null, idCounts: {}, dominantIdUnrecognized: false, ambiguousScale: false };
  if (table.length === 0) return empty; // absent/empty file is fine (optional CSV)

  const header = table[0].map((h) => safeString(h, 60).toLowerCase());
  const col = (name) => header.indexOf(name);
  const idx = {};
  for (const name of requiredCols) idx[name] = col(name);
  if (requiredCols.some((name) => idx[name] === -1)) {
    return { ...empty, errors: [{ line: 1, reason: "Header CSV voti inatteso." }] };
  }
  const voteKeyIdx = col("vote_key");

  // Pass 1: project rows + collect the id histogram (needed to pick a scale
  // before resolving any decimal — 27/29 are ambiguous per-row).
  const raw = [];
  for (let i = 1; i < table.length; i += 1) {
    const record = table[i];
    if (!record || record.length === 0) continue;
    const projected = mapRow(record, idx, col);
    if (!projected) continue; // sparse/malformed row (not user data worth erroring on)
    projected.voteOptionId = voteKeyIdx !== -1 ? extractVoteOptionId(record[voteKeyIdx]) : null;
    raw.push(projected);
  }

  const idCounts = tallyVoteIds(raw.map((r) => r.voteOptionId));
  const { scale, ambiguous } = detectVoteScale(idCounts, { defaultScale: "ep_3level" });

  // Pass 2: resolve each row's decimal within the detected scale.
  const rows = raw.map((r) => ({
    ...r,
    decimalRating: r.voteOptionId != null ? resolveVoteToDecimalRating(r.voteOptionId, scale) : null,
  }));

  const domId = dominantId(idCounts);
  const dominantIdUnrecognized = domId != null && resolveVoteToDecimalRating(domId, scale) == null;

  return { rows, errors: [], scale, idCounts, dominantIdUnrecognized, ambiguousScale: ambiguous };
}

/* ============================= episode ratings ============================= */
// ratings-3-prod-episode_votes.csv: episode_number, vote_key, episode_id,
// user_id, series_name, season_number (column order varies — resolve by name).

function parseTvTimeEpisodeVotesCsv(rawText) {
  const { rows, errors, scale, idCounts, dominantIdUnrecognized, ambiguousScale } = parseScaleAwareVotesCsv(rawText, {
    requiredCols: ["vote_key", "series_name"],
    mapRow: (record, idx, col) => {
      const seriesName = safeString(record[idx.series_name], 500);
      const seasonIdx = col("season_number");
      const episodeIdx = col("episode_number");
      const seasonNumber = seasonIdx !== -1 ? toPositiveIntOrNull(record[seasonIdx]) : null;
      const episodeNumber = episodeIdx !== -1 ? toPositiveIntOrNull(record[episodeIdx]) : null;
      if (!seriesName || seasonNumber == null || episodeNumber == null) return null;
      return { kind: "tv_episode", seriesNameGuess: seriesName, seasonNumber, episodeNumber };
    },
  });
  return { votes: rows, errors, scale, idCounts, dominantIdUnrecognized, ambiguousScale };
}

/* ============================= movie ratings ============================= */
// ratings-live-votes.csv: vote_key, movie_name, uuid, user_id (column order
// varies). This is the REAL movie star-rating file (3-level scale, same as
// episodes) — distinct from emotions-live-votes.csv (emotions, below).

function parseTvTimeMovieRatingsCsv(rawText) {
  const { rows, errors, scale, idCounts, dominantIdUnrecognized, ambiguousScale } = parseScaleAwareVotesCsv(rawText, {
    requiredCols: ["vote_key", "movie_name"],
    mapRow: (record, idx, col) => {
      const movieName = safeString(record[idx.movie_name], 500);
      if (!movieName) return null;
      const uuidIdx = col("uuid");
      return { kind: "movie", movieNameGuess: movieName, uuid: uuidIdx !== -1 ? (safeString(record[uuidIdx], 60) || null) : null };
    },
  });
  return { votes: rows, errors, scale, idCounts, dominantIdUnrecognized, ambiguousScale };
}

/* ============================= movie emotions ============================= */
// emotions-live-votes.csv: vote_key, episode_id, user_id, uuid, movie_name.
// The suffix here is an EMOTION option id (EMOTION_ID_TO_KEY), NOT a rating —
// one row per (movie, emotion), so a movie can have several. Produces emotion
// rows the caller groups per title (buildEmotionStashByTitle) and stashes into
// titleEmotions. NEVER turned into a rating.

function parseTvTimeMovieEmotionsCsv(rawText) {
  const { parseCsv } = require("./csv");
  const emotions = [];
  const table = parseCsv(rawText || "");
  const idCounts = {};
  if (table.length === 0) return { emotions, errors: [], idCounts, unrecognized: 0 };

  const header = table[0].map((h) => safeString(h, 60).toLowerCase());
  const col = (name) => header.indexOf(name);
  const idx = { voteKey: col("vote_key"), movieName: col("movie_name"), uuid: col("uuid") };
  if (idx.voteKey === -1 || idx.movieName === -1) {
    return { emotions, errors: [{ line: 1, reason: "Header CSV emozioni film inatteso." }], idCounts, unrecognized: 0 };
  }

  let unrecognized = 0;
  for (let i = 1; i < table.length; i += 1) {
    const record = table[i];
    if (!record || record.length === 0) continue;
    const movieName = safeString(record[idx.movieName], 500);
    if (!movieName) continue;
    const emotionId = extractVoteOptionId(record[idx.voteKey]);
    if (emotionId != null) idCounts[emotionId] = (idCounts[emotionId] || 0) + 1;
    const emotionKey = emotionId != null ? resolveEmotionKey(emotionId) : null;
    if (!emotionKey) { unrecognized += 1; continue; } // unknown emotion id -> counted, never guessed
    emotions.push({
      kind: "movie",
      movieNameGuess: movieName,
      uuid: idx.uuid !== -1 ? (safeString(record[idx.uuid], 60) || null) : null,
      emotionId,
      emotionKey,
    });
  }
  return { emotions, errors: [], idCounts, unrecognized };
}

/* ============================= movie comments (reviews) ============================= */
// comments-prod-comments.csv: comment_id, entity_uuid, sort_key, user_id,
// created_at, type, text, entity_type, movie_name, is_spoiler, uuid, ...
// Rows with sort_key "user-read-*" are read-markers, NOT comments (no text).
// Only type=="comment" with non-empty `text` and entity_type=="movie" are
// real movie reviews.

function parseTvTimeMovieCommentsCsv(rawText) {
  const { parseCsv } = require("./csv");
  const comments = [];
  const table = parseCsv(rawText || "");
  if (table.length === 0) return { comments, errors: [] };

  const header = table[0].map((h) => safeString(h, 60).toLowerCase());
  const col = (name) => header.indexOf(name);
  const idx = {
    type: col("type"),
    text: col("text"),
    entityType: col("entity_type"),
    movieName: col("movie_name"),
    isSpoiler: col("is_spoiler"),
    createdAt: col("created_at"),
    uuid: col("uuid"),
  };
  if (idx.type === -1 || idx.movieName === -1) {
    return { comments, errors: [{ line: 1, reason: "Header CSV commenti film inatteso." }] };
  }

  for (let i = 1; i < table.length; i += 1) {
    const record = table[i];
    if (!record || record.length === 0) continue;
    const type = safeString(record[idx.type], 40).toLowerCase();
    if (type !== "comment") continue; // e.g. user-read-* marker rows, not comments
    const entityType = idx.entityType !== -1 ? safeString(record[idx.entityType], 40).toLowerCase() : "";
    if (entityType !== "movie") continue; // out of scope for this parser (episode comments handled separately)
    const text = idx.text !== -1 ? safeString(record[idx.text], 5000) : "";
    if (!text) continue; // no reviewText to attach, not user data worth surfacing as an error
    const movieName = safeString(record[idx.movieName], 500);
    if (!movieName) continue;

    comments.push({
      kind: "movie",
      movieNameGuess: movieName,
      uuid: idx.uuid !== -1 ? (safeString(record[idx.uuid], 60) || null) : null,
      text,
      containsSpoiler: idx.isSpoiler !== -1 && safeString(record[idx.isSpoiler], 10).toLowerCase() === "true",
      createdAt: idx.createdAt !== -1 ? parseTvTimeDateTime(record[idx.createdAt]) : null,
    });
  }
  return { comments, errors: [] };
}

/* ============================= episode comments (reviews) ============================= */
// episode_comment.csv (real column set, confirmed from a live export header):
//   spoiler_count, lang, extended_comment, source, nb_likes, comment_type,
//   valid, same_ip_likes, tv_show_name, id, user_id, updated_at,
//   posted_on_twitter, parent_comment_id, episode_season_number,
//   highlight_level, nb_points, episode_id, comment, created_at, posted_on_fb,
//   unappropriate_count, depth, episode_number
//
// The file is the exporting user's OWN comments. Each comment carries an `id`;
// a REPLY carries a non-empty `parent_comment_id`. Because the export only
// contains this user's comments, a parent whose id ALSO appears in this file is
// a reply to the user's own earlier comment (a "self thread"), while a parent
// id NOT present in the file is a reply to SOMEBODY ELSE's comment — an orphan
// on Somto (we don't have that other comment). We tag each row with
// `classification` ∈ {standalone, self_thread, reply_other} so the republish
// path (tvTimeCommentsPublish.js) can keep only the first two.
//
// Shape stays backward compatible with the movie-comments path
// (mergeVotesAndComments only reads text/seriesNameGuess/season/episode/
// containsSpoiler) — the identity/classification fields are additive.

function parseTvTimeEpisodeCommentsCsv(rawText) {
  const { parseCsv } = require("./csv");
  const comments = [];
  const table = parseCsv(rawText || "");
  if (table.length === 0) return { comments, errors: [] };

  const header = table[0].map((h) => safeString(h, 60).toLowerCase());
  const col = (name) => header.indexOf(name);
  const idx = {
    tvShowName: col("tv_show_name"),
    seasonNumber: col("episode_season_number"),
    episodeNumber: col("episode_number"),
    comment: col("comment"),
    extendedComment: col("extended_comment"),
    createdAt: col("created_at"),
    commentId: col("id"),
    userId: col("user_id"),
    parentCommentId: col("parent_comment_id"),
    depth: col("depth"),
    episodeId: col("episode_id"),
    spoilerCount: col("spoiler_count"),
    nbLikes: col("nb_likes"),
  };
  if (idx.tvShowName === -1 || idx.comment === -1) {
    return { comments, errors: [{ line: 1, reason: "Header CSV commenti episodio inatteso." }] };
  }

  // First pass: the set of ALL comment ids present in THIS export (every row,
  // regardless of whether it has publishable text) — used to distinguish a
  // reply-to-self (parent in this set) from a reply-to-other (parent absent).
  const ownCommentIds = new Set();
  if (idx.commentId !== -1) {
    for (let i = 1; i < table.length; i += 1) {
      const record = table[i];
      if (!record || record.length === 0) continue;
      const id = safeString(record[idx.commentId], 80);
      if (id && id !== "null") ownCommentIds.add(id);
    }
  }

  const pickText = (record) => {
    const primary = safeString(record[idx.comment], 5000);
    if (primary && primary !== "null") return primary;
    // Some rows carry the full text in `extended_comment` when `comment` is
    // truncated/empty. Only treat it as text when it isn't a boolean/number
    // flag (the column name is ambiguous across export snapshots).
    if (idx.extendedComment === -1) return "";
    const ext = safeString(record[idx.extendedComment], 5000);
    if (!ext || ext === "null") return "";
    const low = ext.toLowerCase();
    if (low === "true" || low === "false" || /^[0-9]+$/.test(low)) return "";
    return ext;
  };

  for (let i = 1; i < table.length; i += 1) {
    const record = table[i];
    if (!record || record.length === 0) continue;
    const seriesName = safeString(record[idx.tvShowName], 500);
    const seasonNumber = idx.seasonNumber !== -1 ? toPositiveIntOrNull(record[idx.seasonNumber]) : null;
    const episodeNumber = idx.episodeNumber !== -1 ? toPositiveIntOrNull(record[idx.episodeNumber]) : null;
    const text = pickText(record);
    if (!seriesName || seasonNumber == null || episodeNumber == null || !text) continue;

    const commentId = idx.commentId !== -1 ? (safeString(record[idx.commentId], 80) || null) : null;
    const parentCommentId = idx.parentCommentId !== -1 ? safeString(record[idx.parentCommentId], 80) : "";
    const hasParent = Boolean(parentCommentId) && parentCommentId !== "null" && parentCommentId !== "0";
    const classification = !hasParent
      ? "standalone"
      : (ownCommentIds.has(parentCommentId) ? "self_thread" : "reply_other");
    const spoilerCount = idx.spoilerCount !== -1 ? (toPositiveIntOrNull(record[idx.spoilerCount]) || 0) : 0;

    comments.push({
      kind: "tv_episode",
      seriesNameGuess: seriesName,
      seasonNumber,
      episodeNumber,
      text,
      containsSpoiler: false, // no author is_spoiler column here; publish path derives from spoilerCount
      createdAt: idx.createdAt !== -1 ? parseTvTimeDateTime(record[idx.createdAt]) : null,
      // --- identity/classification extras (additive; ignored by rating merge) ---
      commentId,
      userId: idx.userId !== -1 ? (safeString(record[idx.userId], 80) || null) : null,
      parentCommentId: hasParent ? parentCommentId : null,
      classification,
      spoilerCount,
      nbLikes: idx.nbLikes !== -1 ? (toPositiveIntOrNull(record[idx.nbLikes]) || 0) : 0,
      tvdbEpisodeId: idx.episodeId !== -1 ? toPositiveIntOrNull(record[idx.episodeId]) : null,
    });
  }
  return { comments, errors: [] };
}

/**
 * Merges rating votes + comments for the SAME item (movie, or
 * series+season+episode) into a single list of "rating intents": { kind,
 * ...itemKey, decimalRating, reviewText, containsSpoiler }.
 *
 * A vote with no comment -> rating with no reviewText.
 * A comment with no vote -> DROPPED (Somto's rating schema REQUIRES a numeric
 * `rating` 1-10 — there is no "review-only" rating shape) — counted in
 * `commentsWithoutVote`, never silently lost.
 * A vote with an unrecognized option id (decimalRating == null) -> DROPPED
 * (counted in `unrecognizedVotes`) rather than guessed.
 */
function mergeVotesAndComments(votes, comments) {
  function itemKey(row) {
    return row.kind === "movie"
      ? `movie|${(row.movieNameGuess || "").trim().toLowerCase()}`
      : `tv|${(row.seriesNameGuess || "").trim().toLowerCase()}|${row.seasonNumber}|${row.episodeNumber}`;
  }

  const byKey = new Map();
  let unrecognizedVotes = 0;

  for (const vote of votes) {
    if (vote.decimalRating == null) {
      unrecognizedVotes += 1;
      continue;
    }
    const key = itemKey(vote);
    byKey.set(key, { ...vote, reviewText: null, containsSpoiler: false });
  }

  let commentsWithoutVote = 0;
  for (const comment of comments) {
    const key = itemKey(comment);
    const existing = byKey.get(key);
    if (existing) {
      existing.reviewText = comment.text;
      existing.containsSpoiler = Boolean(comment.containsSpoiler);
    } else {
      commentsWithoutVote += 1; // no numeric vote for this item -> can't create a rating
    }
  }

  return {
    intents: Array.from(byKey.values()),
    unrecognizedVotes,
    commentsWithoutVote,
  };
}

/**
 * Groups per-emotion rows (parseTvTimeMovieEmotionsCsv output) by movie into
 * one stash intent per movie: { kind:"movie", movieNameGuess, emotionKeys }.
 * Dedupes keys and caps at MAX_EMOTIONS_PER_TITLE (Somto stores 1..3), keeping
 * the FIRST-seen order (TV Time export order). Movies with 0 recognized
 * emotions never produce an intent.
 */
function buildEmotionStashByTitle(emotions) {
  const byMovie = new Map();
  for (const e of emotions) {
    const name = (e.movieNameGuess || "").trim();
    if (!name || !e.emotionKey) continue;
    const key = name.toLowerCase();
    let entry = byMovie.get(key);
    if (!entry) { entry = { kind: "movie", movieNameGuess: name, emotionKeys: [] }; byMovie.set(key, entry); }
    if (!entry.emotionKeys.includes(e.emotionKey) && entry.emotionKeys.length < MAX_EMOTIONS_PER_TITLE) {
      entry.emotionKeys.push(e.emotionKey);
    }
  }
  return Array.from(byMovie.values());
}

module.exports = {
  VOTE_SCALES,
  SCALE_MARKERS,
  EMOTION_ID_TO_KEY,
  MAX_EMOTIONS_PER_TITLE,
  TVTIME_VOTE_ID_TO_DECIMAL,
  extractVoteOptionId,
  resolveVoteToDecimalRating,
  resolveEmotionKey,
  tallyVoteIds,
  detectVoteScale,
  dominantId,
  parseTvTimeEpisodeVotesCsv,
  parseTvTimeMovieRatingsCsv,
  parseTvTimeMovieEmotionsCsv,
  parseTvTimeMovieCommentsCsv,
  parseTvTimeEpisodeCommentsCsv,
  mergeVotesAndComments,
  buildEmotionStashByTitle,
};
