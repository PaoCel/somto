const test = require("node:test");
const assert = require("node:assert/strict");

const { parseTvTimeEpisodeCommentsCsv } = require("../../lib/importAdapters/tvTimeRatings");
const {
  passesQualityGate,
  meaningfulChars,
  wordCount,
  selectPublishableEpisodeComments,
  episodeCommentMessageId,
  reviewCandidateId,
  buildReviewCandidate,
  buildThreadMessage,
} = require("../../lib/importAdapters/tvTimeCommentsPublish");

// Real header from a live TV Time export (24 columns, order is authoritative).
const HEADER = "spoiler_count,lang,extended_comment,source,nb_likes,comment_type,valid,same_ip_likes,tv_show_name,id,user_id,updated_at,posted_on_twitter,parent_comment_id,episode_season_number,highlight_level,nb_points,episode_id,comment,created_at,posted_on_fb,unappropriate_count,depth,episode_number";
const COLS = HEADER.split(",");

// Build one CSV data row from field overrides (fields not set default to "").
function row(overrides) {
  const rec = COLS.map((c) => {
    const v = overrides[c];
    return v === undefined || v === null ? "" : String(v);
  });
  return rec.join(",");
}
function csv(...rows) {
  return [HEADER, ...rows].join("\n");
}

/* ============================= classification ============================= */

test("standalone comment: empty parent_comment_id -> classification 'standalone'", () => {
  const text = csv(row({ tv_show_name: "The Simpsons", id: "100", user_id: "u1", parent_comment_id: "", episode_season_number: "1", comment: "un commento vero e proprio", episode_number: "1", created_at: "2026-07-05 19:18:49" }));
  const { comments } = parseTvTimeEpisodeCommentsCsv(text);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].classification, "standalone");
  assert.equal(comments[0].commentId, "100");
});

test("self-thread: reply whose parent id is present in the SAME export -> 'self_thread'", () => {
  const text = csv(
    row({ tv_show_name: "Lost", id: "200", user_id: "u1", parent_comment_id: "", episode_season_number: "1", comment: "prima parte del pensiero", episode_number: "3", created_at: "2026-07-05 19:00:00" }),
    row({ tv_show_name: "Lost", id: "201", user_id: "u1", parent_comment_id: "200", episode_season_number: "1", comment: "seconda parte dello stesso pensiero", episode_number: "3", created_at: "2026-07-05 19:01:00" }),
  );
  const { comments } = parseTvTimeEpisodeCommentsCsv(text);
  const byId = Object.fromEntries(comments.map((c) => [c.commentId, c]));
  assert.equal(byId["200"].classification, "standalone");
  assert.equal(byId["201"].classification, "self_thread");
});

test("reply-to-other: parent id NOT in export -> 'reply_other' (dropped from publish)", () => {
  const text = csv(row({ tv_show_name: "Dark", id: "300", user_id: "u1", parent_comment_id: "99999", episode_season_number: "2", comment: "risposta al commento di qualcun altro", episode_number: "1", created_at: "2026-07-05 19:00:00" }));
  const { comments } = parseTvTimeEpisodeCommentsCsv(text);
  assert.equal(comments[0].classification, "reply_other");
  const { eligible } = selectPublishableEpisodeComments(comments);
  assert.equal(eligible.length, 0);
});

test("extended_comment fallback: used when `comment` empty and it is textual", () => {
  const text = csv(row({ tv_show_name: "Fringe", id: "400", user_id: "u1", extended_comment: "questo era il testo lungo", comment: "", episode_season_number: "1", episode_number: "1", created_at: "2026-07-05 19:00:00" }));
  const { comments } = parseTvTimeEpisodeCommentsCsv(text);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].text, "questo era il testo lungo");
});

test("extended_comment fallback IGNORED when it is a boolean/number flag", () => {
  const text = csv(row({ tv_show_name: "Fringe", id: "401", user_id: "u1", extended_comment: "true", comment: "", episode_season_number: "1", episode_number: "1", created_at: "2026-07-05 19:00:00" }));
  const { comments } = parseTvTimeEpisodeCommentsCsv(text);
  assert.equal(comments.length, 0); // no usable text
});

test("spoilerCount is captured for the publish path", () => {
  const text = csv(row({ spoiler_count: "3", tv_show_name: "Severance", id: "500", user_id: "u1", parent_comment_id: "", episode_season_number: "1", comment: "occhio a questo colpo di scena", episode_number: "9", created_at: "2026-07-05 19:00:00" }));
  const { comments } = parseTvTimeEpisodeCommentsCsv(text);
  assert.equal(comments[0].spoilerCount, 3);
});

/* ============================= quality gate ============================= */

test("passesQualityGate rejects pure-emoji / hashtag-only / one-word / empty", () => {
  assert.equal(passesQualityGate("😍❤"), false);
  assert.equal(passesQualityGate("#love"), false);
  assert.equal(passesQualityGate("bello"), false);      // one word
  assert.equal(passesQualityGate(""), false);
  assert.equal(passesQualityGate("null"), false);
  assert.equal(passesQualityGate("ok 👍"), false);       // < 8 meaningful chars
});

test("passesQualityGate accepts a real sentence", () => {
  assert.equal(passesQualityGate("finale pazzesco, non me lo aspettavo"), true);
  assert.equal(passesQualityGate("bellissimo episodio davvero"), true);
});

test("meaningfulChars strips emoji/punctuation, wordCount splits on whitespace", () => {
  assert.equal(meaningfulChars("😍 a!b?c"), "abc");
  assert.equal(wordCount("  due   parole "), 2);
  assert.equal(wordCount(""), 0);
});

/* ============================= selection ============================= */

test("selectPublishableEpisodeComments keeps standalone+self_thread that pass quality, with counts", () => {
  const comments = [
    { classification: "standalone", text: "un bel commento lungo abbastanza" },
    { classification: "self_thread", text: "continua il ragionamento qui" },
    { classification: "standalone", text: "😍" },              // quality reject
    { classification: "reply_other", text: "risposta ad altri qui" }, // class reject
  ];
  const { counts, eligible } = selectPublishableEpisodeComments(comments);
  assert.equal(eligible.length, 2);
  assert.equal(counts.total, 4);
  assert.equal(counts.standalone, 2);
  assert.equal(counts.selfThread, 1);
  assert.equal(counts.replyOther, 1);
  assert.equal(counts.qualityRejected, 1);
  assert.equal(counts.eligible, 2);
});

/* ============================= deterministic ids ============================= */

test("episodeCommentMessageId is deterministic and depends on commentId", () => {
  const a = episodeCommentMessageId({ uid: "u1", titleId: "t1", season: 1, episode: 2, commentId: "c1" });
  const b = episodeCommentMessageId({ uid: "u1", titleId: "t1", season: 1, episode: 2, commentId: "c1" });
  const c = episodeCommentMessageId({ uid: "u1", titleId: "t1", season: 1, episode: 2, commentId: "c2" });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{40}$/);
});

test("reviewCandidateId is stable per source comment id", () => {
  const a = reviewCandidateId({ commentId: "c1", seriesNameGuess: "X", season: 1, episode: 1 });
  const b = reviewCandidateId({ commentId: "c1", seriesNameGuess: "Y", season: 9, episode: 9 });
  assert.equal(a, b); // keyed on commentId when present
});

/* ============================= payload builders ============================= */

test("buildReviewCandidate shapes a pending, unpublished candidate", () => {
  const comment = { text: "commento sensato e lungo", seriesNameGuess: "The Wire", seasonNumber: 1, episodeNumber: 4, classification: "standalone", spoilerCount: 0, nbLikes: 2, commentId: "c9", createdAt: new Date("2026-07-05T19:00:00Z") };
  const { id, payload } = buildReviewCandidate({ uid: "u1", importId: "imp1", comment, titleId: "t1", now: null });
  assert.match(id, /^[0-9a-f]{40}$/);
  assert.equal(payload.status, "pending");
  assert.equal(payload.published, false);
  assert.equal(payload.titleId, "t1");
  assert.equal(payload.resolved, true);
  assert.equal(payload.season, 1);
  assert.equal(payload.episode, 4);
  assert.equal(payload.sourceCommentId, "c9");
});

test("buildReviewCandidate marks unresolved when titleId is null", () => {
  const comment = { text: "altro commento valido", seriesNameGuess: "Unknown", seasonNumber: 2, episodeNumber: 2, classification: "self_thread", commentId: "c10" };
  const { payload } = buildReviewCandidate({ uid: "u1", importId: "imp1", comment, titleId: null, now: null });
  assert.equal(payload.titleId, null);
  assert.equal(payload.resolved, false);
});

test("buildThreadMessage stays within the thread-message rule allow-list keys", () => {
  const candidate = { text: "che episodio", titleId: "t1", spoilerCount: 0 };
  const msg = buildThreadMessage({ uid: "u1", displayName: "Mario", candidate });
  assert.deepEqual(Object.keys(msg).sort(), ["displayName", "text", "type", "uid"]);
  assert.equal(msg.type, "text");
  assert.equal(msg.uid, "u1");
});

test("buildThreadMessage turns on the spoiler gate when the source had a spoiler flag", () => {
  const candidate = { text: "colpo di scena grosso", titleId: "t1", spoilerCount: 2 };
  const msg = buildThreadMessage({ uid: "u1", displayName: "Mario", candidate });
  assert.equal(msg.containsSpoiler, true);
  assert.deepEqual(msg.spoilerTitleIds, ["t1"]);
});

test("passesQualityGate scarta le risposte @qualcuno (utente TV Time, non nostro)", () => {
  // Caso reale: 22 candidati su 164 erano risposte a persone che su Somto non
  // esistono — pubblicate diventerebbero repliche a un interlocutore assente.
  assert.equal(passesQualityGate("@Silvia Giaimo È che ci stanno rendendo il compito fin troppo facile"), false);
  assert.equal(passesQualityGate("@Cicciotis non parliamone, stavo per vomitare!"), false);
  // Una @ in mezzo al testo non e' una risposta: resta pubblicabile.
  assert.equal(passesQualityGate("Bellissimo episodio, secondo me @ metà stagione crolla"), true);
});
