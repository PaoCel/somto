const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ECHO_SOURCE_KIND,
  ECHO_VISIBILITY,
  MAX_ECHO_TEXT_LEN,
  parsePublicThreadId,
  buildEchoPostId,
  isEchoPostId,
  isEchoPostData,
  shouldEchoThreadMessage,
  buildEchoPostData,
} = require("../../lib/commentEcho");

const MSG = {
  uid: "u1",
  displayName: "Paolo",
  text: "Il finale di stagione mi ha distrutto",
  type: "text",
  createdAt: { seconds: 1700000000, nanoseconds: 0 },
};

test("parsePublicThreadId: thread title-level", () => {
  assert.deepEqual(parsePublicThreadId("public_abc123"), {
    titleId: "abc123",
    level: "title",
    season: null,
    episode: null,
  });
});

test("parsePublicThreadId: thread episodio", () => {
  assert.deepEqual(parsePublicThreadId("public_abc123_s3e7"), {
    titleId: "abc123",
    level: "episode",
    season: 3,
    episode: 7,
  });
});

test("parsePublicThreadId: titleId con underscore tiene la coda sNeM", () => {
  assert.deepEqual(parsePublicThreadId("public_ted_lasso_x_s2e10"), {
    titleId: "ted_lasso_x",
    level: "episode",
    season: 2,
    episode: 10,
  });
});

test("parsePublicThreadId: dm/gruppi/vuoti esclusi", () => {
  assert.equal(parsePublicThreadId("dm_t1_a_b"), null);
  assert.equal(parsePublicThreadId("group_t1_abc"), null);
  assert.equal(parsePublicThreadId("public_"), null);
  assert.equal(parsePublicThreadId(""), null);
  assert.equal(parsePublicThreadId(null), null);
});

test("parsePublicThreadId: stagione/episodio zero non è episodio valido", () => {
  const parsed = parsePublicThreadId("public_abc_s0e0");
  assert.equal(parsed, null);
});

test("buildEchoPostId: deterministico e distinto per messaggio", () => {
  const a = buildEchoPostId("public_t1", "m1");
  const b = buildEchoPostId("public_t1", "m1");
  const c = buildEchoPostId("public_t1", "m2");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(isEchoPostId(a));
  assert.ok(!isEchoPostId("randomPostId"));
});

test("buildEchoPostId: richiede entrambi gli id", () => {
  assert.throws(() => buildEchoPostId("", "m1"));
  assert.throws(() => buildEchoPostId("public_t1", ""));
});

test("shouldEchoThreadMessage: solo thread pubblici con contenuto", () => {
  const ok = shouldEchoThreadMessage({
    threadId: "public_t1",
    threadData: { visibility: "public", titleId: "t1" },
    message: MSG,
  });
  assert.equal(ok, true);

  assert.equal(shouldEchoThreadMessage({
    threadId: "dm_t1_a_b",
    threadData: { visibility: "private" },
    message: MSG,
  }), false);

  assert.equal(shouldEchoThreadMessage({
    threadId: "public_t1",
    threadData: { visibility: "private" },
    message: MSG,
  }), false);

  assert.equal(shouldEchoThreadMessage({
    threadId: "public_t1",
    threadData: { visibility: "public" },
    message: { ...MSG, text: "   " },
  }), false);

  assert.equal(shouldEchoThreadMessage({
    threadId: "public_t1",
    threadData: { visibility: "public" },
    message: { ...MSG, uid: "" },
  }), false);
});

test("shouldEchoThreadMessage: thread legacy senza visibility vale l'id", () => {
  assert.equal(shouldEchoThreadMessage({
    threadId: "public_t1",
    threadData: { titleId: "t1" },
    message: MSG,
  }), true);
});

test("shouldEchoThreadMessage: gif senza testo passa, testo senza gif no", () => {
  assert.equal(shouldEchoThreadMessage({
    threadId: "public_t1",
    threadData: { visibility: "public" },
    message: { ...MSG, type: "gif", text: "", gifUrl: "https://media.giphy.com/x.gif" },
  }), true);

  assert.equal(shouldEchoThreadMessage({
    threadId: "public_t1",
    threadData: { visibility: "public" },
    message: { ...MSG, type: "gif", text: "", gifUrl: "" },
  }), false);
});

test("buildEchoPostData: post pubblico con scope episodio", () => {
  const data = buildEchoPostData({
    threadId: "public_t1_s3e7",
    messageId: "m1",
    message: MSG,
    threadData: { visibility: "public", titleId: "t1" },
    now: "NOW",
  });

  assert.equal(data.authorUid, "u1");
  assert.equal(data.authorName, "Paolo");
  assert.equal(data.text, MSG.text);
  assert.equal(data.titleId, "t1");
  assert.equal(data.kind, "post");
  assert.equal(data.visibility, ECHO_VISIBILITY);
  assert.equal(data.visibility, "comment");
  assert.equal(data.createdAt, MSG.createdAt);
  assert.equal(data.updatedAt, "NOW");
  assert.equal(data.sourceKind, ECHO_SOURCE_KIND);
  assert.equal(data.sourceThreadId, "public_t1_s3e7");
  assert.equal(data.sourceMessageId, "m1");
  assert.deepEqual(data.spoilerScope, {
    titleId: "t1",
    level: "episode",
    season: 3,
    episode: 7,
  });
  assert.equal(data.skipAutoFeedFanout, true);
  assert.ok(isEchoPostData(data));
  assert.ok(!("textTruncated" in data));
  assert.ok(!("mediaUrl" in data));
});

test("buildEchoPostData: titleId del doc thread vince sull'id", () => {
  const data = buildEchoPostData({
    threadId: "public_vecchioId_s1e1",
    messageId: "m1",
    message: MSG,
    threadData: { visibility: "public", titleId: "titoloReale" },
  });
  assert.equal(data.titleId, "titoloReale");
  assert.equal(data.spoilerScope.titleId, "titoloReale");
});

test("buildEchoPostData: testo oltre il tetto viene clippato e marcato", () => {
  const long = "x".repeat(MAX_ECHO_TEXT_LEN + 500);
  const data = buildEchoPostData({
    threadId: "public_t1",
    messageId: "m1",
    message: { ...MSG, text: long },
    threadData: { visibility: "public", titleId: "t1" },
  });
  assert.equal(data.text.length, MAX_ECHO_TEXT_LEN);
  assert.equal(data.textTruncated, true);
});

test("buildEchoPostData: gif finisce in mediaUrl", () => {
  const data = buildEchoPostData({
    threadId: "public_t1",
    messageId: "m1",
    message: { ...MSG, type: "gif", text: "", gifUrl: "https://media.giphy.com/x.gif" },
    threadData: { visibility: "public", titleId: "t1" },
  });
  assert.equal(data.mediaUrl, "https://media.giphy.com/x.gif");
  assert.equal(data.text, "");
});

test("buildEchoPostData: propaga flag spoiler manuale e sintetico", () => {
  const data = buildEchoPostData({
    threadId: "public_t1",
    messageId: "m1",
    message: {
      ...MSG,
      containsSpoiler: true,
      spoilerTitleIds: ["t1", "t2", "", "t3", "t4", "t5", "t6"],
      isSynthetic: true,
    },
    threadData: { visibility: "public", titleId: "t1" },
  });
  assert.equal(data.containsSpoiler, true);
  assert.deepEqual(data.spoilerTitleIds, ["t1", "t2", "t3", "t4", "t5"]);
  assert.equal(data.isSynthetic, true);
});

test("buildEchoPostData: null quando il messaggio non è eco-abile", () => {
  assert.equal(buildEchoPostData({
    threadId: "dm_t1_a_b",
    messageId: "m1",
    message: MSG,
    threadData: { visibility: "private" },
  }), null);

  assert.equal(buildEchoPostData({
    threadId: "public_t1",
    messageId: "m1",
    message: { ...MSG, text: "" },
    threadData: { visibility: "public" },
  }), null);
});

test("buildEchoPostData: authorName vuoto ha un fallback valido per le rules", () => {
  const data = buildEchoPostData({
    threadId: "public_t1",
    messageId: "m1",
    message: { ...MSG, displayName: "  " },
    threadData: { visibility: "public", titleId: "t1" },
  });
  assert.equal(data.authorName, "User");
});
