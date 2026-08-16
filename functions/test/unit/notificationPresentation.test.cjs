const test = require("node:test");
const assert = require("node:assert/strict");

const {
  nonNegativeInt,
  commentReviewUrl,
  commentReviewPresentation,
  titleUpdatePresentation,
} = require("../../lib/notificationPresentation");

test("nonNegativeInt normalizza valori mancanti, corrotti e negativi", () => {
  assert.equal(nonNegativeInt(undefined), 0);
  assert.equal(nonNegativeInt("NaN"), 0);
  assert.equal(nonNegativeInt(-3), 0);
  assert.equal(nonNegativeInt("4.9"), 4);
});

test("commentReviewUrl punta alla coda specifica dell'import", () => {
  assert.equal(
    commentReviewUrl({ importUid: "user one", importId: "import/1" }),
    "/admin-import-comments.html?uid=user+one&importId=import%2F1"
  );
  assert.equal(
    commentReviewUrl({ ctaUrl: "/admin-import-comments.html?uid=u&importId=i" }),
    "/admin-import-comments.html?uid=u&importId=i"
  );
});

test("commentReviewPresentation usa gli idonei nel titolo e distingue i risolti", () => {
  assert.deepEqual(
    commentReviewPresentation({
      fromName: "Ayman",
      eligible: 5,
      resolved: 3,
      importUid: "u1",
      importId: "i1",
    }),
    {
      eligible: 5,
      resolved: 3,
      title: "5 commenti TV Time da revisionare",
      body: "Ayman: 3 di 5 già associati ai titoli",
      url: "/admin-import-comments.html?uid=u1&importId=i1",
    }
  );
});

test("commentReviewPresentation gestisce singolare, tutti risolti e clamp", () => {
  const one = commentReviewPresentation({ fromName: "Ada", eligible: 1, resolved: 9 });
  assert.equal(one.title, "1 commento TV Time da revisionare");
  assert.equal(one.body, "Ada: il commento è pronto per la revisione");
  assert.equal(one.resolved, 1);

  const many = commentReviewPresentation({ fromName: "Ada", eligible: 2, resolved: 2 });
  assert.equal(many.body, "Ada: tutti i commenti sono pronti per la revisione");
});

test("titleUpdatePresentation usa copy italiano o inglese e deep link aggiornamenti", () => {
  const data = {
    titleId: "ted-lasso",
    messageByLocale: {
      "it-IT": "È uscito un nuovo trailer di Ted Lasso.",
      "en-US": "A new trailer for Ted Lasso is out.",
    },
    ctaUrl: "/title.html?id=ted-lasso&focus=updates&event=e1",
  };
  assert.deepEqual(titleUpdatePresentation(data, "it"), {
    title: "Aggiornamento titolo",
    body: "È uscito un nuovo trailer di Ted Lasso.",
    url: data.ctaUrl,
  });
  assert.deepEqual(titleUpdatePresentation(data, "en-US"), {
    title: "Title update",
    body: "A new trailer for Ted Lasso is out.",
    url: data.ctaUrl,
  });
});
