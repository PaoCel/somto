const test = require("node:test");
const assert = require("node:assert/strict");

const {
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
} = require("../../lib/importAdapters/tvTimeRatings");

/* ============================= vote id extraction ============================= */

test("extractVoteOptionId reads the numeric suffix after the last hyphen", () => {
  assert.equal(extractVoteOptionId("55452-109813159-28"), 28);
  assert.equal(extractVoteOptionId("26b797ad-2fb4-4ceb-9a2b-61eb83ea248f-109813159-28"), 28);
  assert.equal(extractVoteOptionId("abc-123-3"), 3);
});

test("extractVoteOptionId returns null for empty/malformed input", () => {
  assert.equal(extractVoteOptionId(""), null);
  assert.equal(extractVoteOptionId("nodashesnumericxyz"), null);
  assert.equal(extractVoteOptionId("no-dashes-here-but-not-numeric-xyz"), null);
});

/* ============================= scale-aware id resolution ============================= */

test("resolveVoteToDecimalRating: 3-tier scale decode (Wow/Good/Meh)", () => {
  assert.equal(resolveVoteToDecimalRating(3, "ep_3level"), 10); // Wow
  assert.equal(resolveVoteToDecimalRating(27, "ep_3level"), 7); // Good
  assert.equal(resolveVoteToDecimalRating(29, "ep_3level"), 5); // Meh
});

test("resolveVoteToDecimalRating: default scale is ep_3level", () => {
  assert.equal(resolveVoteToDecimalRating(3), 10);
  assert.equal(resolveVoteToDecimalRating(27), 7);
  assert.equal(resolveVoteToDecimalRating(29), 5);
});

test("resolveVoteToDecimalRating: star_5 scale decode", () => {
  assert.equal(resolveVoteToDecimalRating(26, "star_5"), 4); // Brutto
  assert.equal(resolveVoteToDecimalRating(27, "star_5"), 6); // Ok
  assert.equal(resolveVoteToDecimalRating(28, "star_5"), 7); // Bello
  assert.equal(resolveVoteToDecimalRating(29, "star_5"), 9); // Super
  assert.equal(resolveVoteToDecimalRating(30, "star_5"), 10); // Wow
});

test("resolveVoteToDecimalRating: id 29 flips rank between scales (5 in ep_3level, 9 in star_5)", () => {
  assert.equal(resolveVoteToDecimalRating(29, "ep_3level"), 5);
  assert.equal(resolveVoteToDecimalRating(29, "star_5"), 9);
});

test("resolveVoteToDecimalRating: unrecognized id / unknown scale resolves to null, never guessed", () => {
  assert.equal(resolveVoteToDecimalRating(99, "ep_3level"), null);
  assert.equal(resolveVoteToDecimalRating(26, "ep_3level"), null); // 26 is star_5-only
  assert.equal(resolveVoteToDecimalRating(3, "star_5"), null); // 3 is ep_3level-only
  assert.equal(resolveVoteToDecimalRating(3, "nonexistent_scale"), null);
});

test("TVTIME_VOTE_ID_TO_DECIMAL back-compat map exposes exactly the 3-tier ids", () => {
  assert.deepEqual(
    Object.keys(TVTIME_VOTE_ID_TO_DECIMAL).map(Number).sort((a, b) => a - b),
    [3, 27, 29]
  );
  assert.equal(TVTIME_VOTE_ID_TO_DECIMAL[3], 10);
  assert.equal(TVTIME_VOTE_ID_TO_DECIMAL[27], 7);
  assert.equal(TVTIME_VOTE_ID_TO_DECIMAL[29], 5);
});

/* ============================= scale detection helpers ============================= */

test("tallyVoteIds counts id occurrences and skips nulls", () => {
  assert.deepEqual(tallyVoteIds([3, 3, 27, null, 29, 27]), { 3: 2, 27: 2, 29: 1 });
  assert.deepEqual(tallyVoteIds([]), {});
});

test("detectVoteScale: marker id 3 present -> ep_3level", () => {
  assert.deepEqual(detectVoteScale({ 3: 2, 27: 1 }), { scale: "ep_3level", ambiguous: false });
});

test("detectVoteScale: markers 26/28/30 present -> star_5", () => {
  assert.deepEqual(detectVoteScale({ 26: 1, 28: 1, 30: 1 }), { scale: "star_5", ambiguous: false });
});

test("detectVoteScale: only ambiguous 27/29 -> falls back to default (ep_3level)", () => {
  assert.deepEqual(detectVoteScale({ 27: 3, 29: 2 }), { scale: "ep_3level", ambiguous: false });
});

test("detectVoteScale: conflicting markers -> majority wins, flagged ambiguous", () => {
  assert.deepEqual(detectVoteScale({ 3: 5, 30: 1 }), { scale: "ep_3level", ambiguous: true });
  assert.deepEqual(detectVoteScale({ 3: 1, 26: 3, 28: 2 }), { scale: "star_5", ambiguous: true });
});

test("dominantId returns the most-frequent id, or null when empty", () => {
  assert.equal(dominantId({ 3: 1, 99: 4, 27: 2 }), 99);
  assert.equal(dominantId({}), null);
});

/* ============================= episode ratings ============================= */

const EP_VOTES_HEADER = "episode_number,vote_key,episode_id,user_id,series_name,season_number";

test("parseTvTimeEpisodeVotesCsv: 3-tier decode (3->10, 27->7, 29->5) with scale ep_3level", () => {
  const csv = [
    EP_VOTES_HEADER,
    "1,abc-123-3,e1,u1,The Simpsons,1",
    "2,abc-123-27,e2,u1,The Simpsons,1",
    "3,abc-123-29,e3,u1,The Simpsons,1",
  ].join("\n");
  const { votes, errors, scale, dominantIdUnrecognized } = parseTvTimeEpisodeVotesCsv(csv);
  assert.equal(errors.length, 0);
  assert.equal(scale, "ep_3level");
  assert.equal(dominantIdUnrecognized, false);
  assert.equal(votes.length, 3);
  assert.equal(votes[0].kind, "tv_episode");
  assert.equal(votes[0].seriesNameGuess, "The Simpsons");
  assert.equal(votes[0].seasonNumber, 1);
  assert.equal(votes[0].episodeNumber, 1);
  assert.equal(votes[0].voteOptionId, 3);
  assert.equal(votes[0].decimalRating, 10);
  assert.equal(votes[1].decimalRating, 7);
  assert.equal(votes[2].decimalRating, 5);
});

test("parseTvTimeEpisodeVotesCsv is tolerant to reordered columns (resolves by header name)", () => {
  const reordered = [
    "season_number,series_name,vote_key,user_id,episode_id,episode_number",
    "1,FROM,abc-123-3,u1,e1,1",
    "1,FROM,abc-123-27,u1,e2,2",
  ].join("\n");
  const { votes, scale } = parseTvTimeEpisodeVotesCsv(reordered);
  assert.equal(scale, "ep_3level");
  assert.equal(votes.length, 2);
  assert.equal(votes[0].seriesNameGuess, "FROM");
  assert.equal(votes[0].decimalRating, 10);
  assert.equal(votes[1].decimalRating, 7);
});

test("parseTvTimeEpisodeVotesCsv: absent/empty file is not an error (optional CSV)", () => {
  const { votes, errors, scale } = parseTvTimeEpisodeVotesCsv("");
  assert.equal(votes.length, 0);
  assert.equal(errors.length, 0);
  assert.equal(scale, null);
});

/* ============================= movie ratings ============================= */

const MOVIE_RATINGS_HEADER = "vote_key,episode_id,user_id,uuid,movie_name";

test("parseTvTimeMovieRatingsCsv: 3-tier decode (3->10, 27->7, 29->5) with scale ep_3level", () => {
  const csv = [
    MOVIE_RATINGS_HEADER,
    "abc-123-3,0,u1,uuid1,Dune",
    "abc-123-27,0,u1,uuid2,Oppenheimer",
    "abc-123-29,0,u1,uuid3,Barbie",
  ].join("\n");
  const { votes, errors, scale } = parseTvTimeMovieRatingsCsv(csv);
  assert.equal(errors.length, 0);
  assert.equal(scale, "ep_3level");
  assert.equal(votes.length, 3);
  assert.equal(votes[0].kind, "movie");
  assert.equal(votes[0].movieNameGuess, "Dune");
  assert.equal(votes[0].voteOptionId, 3);
  assert.equal(votes[0].decimalRating, 10);
  assert.equal(votes[1].decimalRating, 7);
  assert.equal(votes[2].decimalRating, 5);
});

test("parseTvTimeMovieRatingsCsv: file with markers 26/28/30 -> star_5 scale + decode", () => {
  const csv = [
    MOVIE_RATINGS_HEADER,
    "abc-123-26,0,u1,uuid1,A",
    "abc-123-28,0,u1,uuid2,B",
    "abc-123-30,0,u1,uuid3,C",
  ].join("\n");
  const { votes, scale, ambiguousScale } = parseTvTimeMovieRatingsCsv(csv);
  assert.equal(scale, "star_5");
  assert.equal(ambiguousScale, false);
  assert.equal(votes[0].decimalRating, 4); // 26 Brutto
  assert.equal(votes[1].decimalRating, 7); // 28 Bello
  assert.equal(votes[2].decimalRating, 10); // 30 Wow
});

test("parseTvTimeMovieRatingsCsv: only ambiguous 27/29 -> falls back to ep_3level", () => {
  const csv = [
    MOVIE_RATINGS_HEADER,
    "abc-123-27,0,u1,uuid1,A",
    "abc-123-29,0,u1,uuid2,B",
  ].join("\n");
  const { votes, scale } = parseTvTimeMovieRatingsCsv(csv);
  assert.equal(scale, "ep_3level");
  assert.equal(votes[0].decimalRating, 7); // 27 Good (ep_3level)
  assert.equal(votes[1].decimalRating, 5); // 29 Meh (ep_3level)
});

test("parseTvTimeMovieRatingsCsv: unrecognized id -> row decimalRating null", () => {
  const csv = [
    MOVIE_RATINGS_HEADER,
    "abc-123-3,0,u1,uuid1,Known",
    "abc-123-99,0,u1,uuid2,Mystery",
  ].join("\n");
  const { votes } = parseTvTimeMovieRatingsCsv(csv);
  assert.equal(votes.length, 2);
  assert.equal(votes[0].decimalRating, 10);
  assert.equal(votes[1].voteOptionId, 99);
  assert.equal(votes[1].decimalRating, null);
});

test("parseTvTimeMovieRatingsCsv: unrecognized DOMINANT id flags dominantIdUnrecognized", () => {
  const csv = [
    MOVIE_RATINGS_HEADER,
    "abc-123-99,0,u1,uuid1,A",
    "abc-123-99,0,u1,uuid2,B",
    "abc-123-27,0,u1,uuid3,C",
  ].join("\n");
  const { votes, scale, dominantIdUnrecognized } = parseTvTimeMovieRatingsCsv(csv);
  assert.equal(scale, "ep_3level"); // no markers -> default
  assert.equal(dominantIdUnrecognized, true); // 99 is most common, undecodable
  assert.equal(votes[0].decimalRating, null);
  assert.equal(votes[1].decimalRating, null);
  assert.equal(votes[2].decimalRating, 7); // 27 still decodes
});

/* ============================= movie emotions ============================= */

const EMO_HEADER = "vote_key,episode_id,user_id,uuid,movie_name";
const emoRow = (id, movie) => `x-1-${id},0,u1,uuid,${movie}`;

test("parseTvTimeMovieEmotionsCsv: current + legacy emotion id decode", () => {
  const csv = [
    EMO_HEADER,
    emoRow(28, "A"), // shocked
    emoRow(30, "B"), // sad
    emoRow(31, "C"), // reflective
    emoRow(32, "D"), // touched
    emoRow(37, "E"), // thrilled
    emoRow(39, "F"), // tense
    emoRow(1, "G"), // legacy touched
    emoRow(2, "H"), // legacy confused
    emoRow(3, "I"), // legacy sad
    emoRow(6, "J"), // legacy amused
    emoRow(7, "K"), // legacy bored
    emoRow(8, "L"), // legacy frustrated
  ].join("\n");
  const { emotions, errors, unrecognized } = parseTvTimeMovieEmotionsCsv(csv);
  assert.equal(errors.length, 0);
  assert.equal(unrecognized, 0);
  assert.deepEqual(
    emotions.map((e) => e.emotionKey),
    ["shocked", "sad", "reflective", "touched", "thrilled", "tense",
      "touched", "confused", "sad", "amused", "bored", "frustrated"]
  );
  assert.equal(emotions[0].kind, "movie");
  assert.equal(emotions[0].movieNameGuess, "A");
  assert.equal(emotions[0].emotionId, 28);
});

test("parseTvTimeMovieEmotionsCsv: id NOT in the map -> not emitted, counted in unrecognized", () => {
  const csv = [
    EMO_HEADER,
    emoRow(28, "A"), // shocked (valid)
    emoRow(13, "B"), // not an emotion id
  ].join("\n");
  const { emotions, unrecognized } = parseTvTimeMovieEmotionsCsv(csv);
  assert.equal(emotions.length, 1);
  assert.equal(emotions[0].emotionKey, "shocked");
  assert.equal(unrecognized, 1);
});

test("resolveEmotionKey resolves known ids and returns null otherwise", () => {
  assert.equal(resolveEmotionKey(30), "sad");
  assert.equal(resolveEmotionKey(3), "sad"); // legacy
  assert.equal(resolveEmotionKey(13), null);
});

/* ============================= THE COLLISION (id 3) ============================= */

test("COLLISION: id 3 is rating 10 (Wow) in a RATINGS file but emotion 'sad' in an EMOTIONS file", () => {
  // Same numeric option id (3) — meaning is decided by the SOURCE FILE, never by value.
  const ratingsCsv = [MOVIE_RATINGS_HEADER, "abc-123-3,0,u1,uuid1,Interstellar"].join("\n");
  const { votes } = parseTvTimeMovieRatingsCsv(ratingsCsv);
  assert.equal(votes.length, 1);
  assert.equal(votes[0].voteOptionId, 3);
  assert.equal(votes[0].decimalRating, 10); // Wow rating

  const emotionsCsv = [EMO_HEADER, emoRow(3, "Interstellar")].join("\n");
  const { emotions } = parseTvTimeMovieEmotionsCsv(emotionsCsv);
  assert.equal(emotions.length, 1);
  assert.equal(emotions[0].emotionId, 3);
  assert.equal(emotions[0].emotionKey, "sad"); // sad emotion

  // Episode ratings file: id 3 is also a Wow rating (same namespace as movie ratings).
  const epCsv = [EP_VOTES_HEADER, "1,abc-123-3,e1,u1,Show,1"].join("\n");
  const { votes: epVotes } = parseTvTimeEpisodeVotesCsv(epCsv);
  assert.equal(epVotes[0].decimalRating, 10);
});

/* ============================= buildEmotionStashByTitle ============================= */

test("buildEmotionStashByTitle: dedupes keys, caps at MAX_EMOTIONS_PER_TITLE, preserves first-seen order", () => {
  assert.equal(MAX_EMOTIONS_PER_TITLE, 3);
  const emotions = [
    { kind: "movie", movieNameGuess: "Dune", emotionKey: "thrilled" },
    { kind: "movie", movieNameGuess: "Dune", emotionKey: "tense" },
    { kind: "movie", movieNameGuess: "Dune", emotionKey: "thrilled" }, // dup
    { kind: "movie", movieNameGuess: "Dune", emotionKey: "shocked" },
    { kind: "movie", movieNameGuess: "Dune", emotionKey: "sad" }, // 4th distinct -> capped out
    { kind: "movie", movieNameGuess: "Barbie", emotionKey: "amused" },
  ];
  const stash = buildEmotionStashByTitle(emotions);
  assert.equal(stash.length, 2);
  const dune = stash.find((s) => s.movieNameGuess === "Dune");
  const barbie = stash.find((s) => s.movieNameGuess === "Barbie");
  assert.deepEqual(dune.emotionKeys, ["thrilled", "tense", "shocked"]);
  assert.deepEqual(barbie.emotionKeys, ["amused"]);
});

test("buildEmotionStashByTitle: groups case-insensitively, keeps first-seen display name", () => {
  const stash = buildEmotionStashByTitle([
    { movieNameGuess: "Dune", emotionKey: "thrilled" },
    { movieNameGuess: "dune", emotionKey: "tense" },
  ]);
  assert.equal(stash.length, 1);
  assert.equal(stash[0].movieNameGuess, "Dune");
  assert.deepEqual(stash[0].emotionKeys, ["thrilled", "tense"]);
});

/* ============================= comments (reviews) ============================= */

const MOVIE_COMMENTS_HEADER = "report_count,comment_id,entity_uuid,sort_key,inappropriate_count,tenant,user_id,created_at,type,lang,replies,spoiler_count,updated_at,entity_type,text,reply_count,image,like_count,movie_name,is_spoiler,uuid,parent_uuid,comment_uuid,last_read,expires_at";

test("parseTvTimeMovieCommentsCsv: real comment row (type=comment, entity_type=movie, non-empty text)", () => {
  const csv = [
    MOVIE_COMMENTS_HEADER,
    '0,,26b797ad,comment-123,0,tvt,109813159,2026-07-05 19:22:24,comment,,,0,2026-07-05 19:22:24,movie,top,0,,0,Supergirl,false,47678ada,,47678ada,,',
  ].join("\n");
  const { comments } = parseTvTimeMovieCommentsCsv(csv);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].movieNameGuess, "Supergirl");
  assert.equal(comments[0].text, "top");
  assert.equal(comments[0].containsSpoiler, false);
});

test("parseTvTimeMovieCommentsCsv: is_spoiler=true maps to containsSpoiler:true", () => {
  const csv = [
    MOVIE_COMMENTS_HEADER,
    '0,,uuid1,comment-123,0,tvt,109813159,2026-07-05 19:22:24,comment,,,0,2026-07-05 19:22:24,movie,il finale e triste,0,,0,SomeMovie,true,uuid2,,uuid2,,',
  ].join("\n");
  const { comments } = parseTvTimeMovieCommentsCsv(csv);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].containsSpoiler, true);
});

test("parseTvTimeMovieCommentsCsv: user-read-* marker rows (no text) are not comments", () => {
  const csv = [
    MOVIE_COMMENTS_HEADER,
    ',,uuid1,user-read-109813159,,,109813159,,,,,,,,,,,,Supergirl,,,,,1783279339953658,1785871339953658',
  ].join("\n");
  const { comments } = parseTvTimeMovieCommentsCsv(csv);
  assert.equal(comments.length, 0);
});

const EPISODE_COMMENTS_HEADER = "spoiler_count,lang,extended_comment,source,nb_likes,comment_type,valid,same_ip_likes,tv_show_name,id,user_id,updated_at,posted_on_twitter,parent_comment_id,episode_season_number,highlight_level,nb_points,episode_id,comment,created_at,posted_on_fb,unappropriate_count,depth,episode_number";

test("parseTvTimeEpisodeCommentsCsv: real comment row", () => {
  const csv = [
    EPISODE_COMMENTS_HEADER,
    "0,it,null,mobile,0,comment,0,0,The Simpsons,42964274,109813159,2026-07-05 19:18:49,0,,1,5,0,55452,evergreen,2026-07-05 19:18:49,0,0,0,1",
  ].join("\n");
  const { comments } = parseTvTimeEpisodeCommentsCsv(csv);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].seriesNameGuess, "The Simpsons");
  assert.equal(comments[0].seasonNumber, 1);
  assert.equal(comments[0].episodeNumber, 1);
  assert.equal(comments[0].text, "evergreen");
});

/* ============================= mergeVotesAndComments ============================= */

test("mergeVotesAndComments: vote with no comment -> intent with reviewText null", () => {
  const votes = [{ kind: "movie", movieNameGuess: "Deadpool", decimalRating: 10 }];
  const { intents, unrecognizedVotes, commentsWithoutVote } = mergeVotesAndComments(votes, []);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].reviewText, null);
  assert.equal(unrecognizedVotes, 0);
  assert.equal(commentsWithoutVote, 0);
});

test("mergeVotesAndComments: vote + matching movie comment merge into one intent with reviewText", () => {
  const votes = [{ kind: "movie", movieNameGuess: "Supergirl", decimalRating: 7 }];
  const comments = [{ kind: "movie", movieNameGuess: "Supergirl", text: "top", containsSpoiler: false }];
  const { intents } = mergeVotesAndComments(votes, comments);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].decimalRating, 7);
  assert.equal(intents[0].reviewText, "top");
});

test("mergeVotesAndComments: vote + matching episode comment (series+season+episode key) merge", () => {
  const votes = [{ kind: "tv_episode", seriesNameGuess: "The Simpsons", seasonNumber: 1, episodeNumber: 1, decimalRating: 7 }];
  const comments = [{ kind: "tv_episode", seriesNameGuess: "The Simpsons", seasonNumber: 1, episodeNumber: 1, text: "evergreen", containsSpoiler: false }];
  const { intents } = mergeVotesAndComments(votes, comments);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].reviewText, "evergreen");
});

test("mergeVotesAndComments: comment with NO matching vote is dropped and counted", () => {
  const comments = [{ kind: "movie", movieNameGuess: "OrphanComment", text: "no vote for this one", containsSpoiler: false }];
  const { intents, commentsWithoutVote } = mergeVotesAndComments([], comments);
  assert.equal(intents.length, 0);
  assert.equal(commentsWithoutVote, 1);
});

test("mergeVotesAndComments: unrecognized vote (decimalRating null) is dropped and counted, never guessed", () => {
  const votes = [{ kind: "movie", movieNameGuess: "Mystery", decimalRating: null, voteOptionId: 99 }];
  const { intents, unrecognizedVotes } = mergeVotesAndComments(votes, []);
  assert.equal(intents.length, 0);
  assert.equal(unrecognizedVotes, 1);
});

test("mergeVotesAndComments: different episodes of the same series never collide", () => {
  const votes = [
    { kind: "tv_episode", seriesNameGuess: "FROM", seasonNumber: 1, episodeNumber: 1, decimalRating: 7 },
    { kind: "tv_episode", seriesNameGuess: "FROM", seasonNumber: 1, episodeNumber: 2, decimalRating: 6 },
  ];
  const { intents } = mergeVotesAndComments(votes, []);
  assert.equal(intents.length, 2);
});

/* ============================= registry sanity ============================= */

test("VOTE_SCALES / SCALE_MARKERS registry shape is intact", () => {
  assert.deepEqual(VOTE_SCALES.ep_3level.ids, { 3: "wow", 27: "good", 29: "meh" });
  assert.deepEqual(VOTE_SCALES.ep_3level.decimals, { wow: 10, good: 7, meh: 5 });
  assert.ok(SCALE_MARKERS.ep_3level.has(3));
  assert.ok(SCALE_MARKERS.star_5.has(26));
  assert.ok(SCALE_MARKERS.star_5.has(28));
  assert.ok(SCALE_MARKERS.star_5.has(30));
});

test("EMOTION_ID_TO_KEY covers the collision anchor: id 3 -> sad (never a rating here)", () => {
  assert.equal(EMOTION_ID_TO_KEY[3], "sad");
  assert.equal(EMOTION_ID_TO_KEY[28], "shocked");
});
