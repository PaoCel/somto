const test = require("node:test");
const assert = require("node:assert/strict");

const {
  nonNegativeInt,
  commentReviewUrl,
  commentReviewPresentation,
  notificationPresentation,
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

test("commentReviewPresentation localizza il copy inglese", () => {
  const out = commentReviewPresentation({ fromName: "Ada", eligible: 2, resolved: 2 }, "en");
  assert.equal(out.title, "2 TV Time comments to review");
  assert.equal(out.body, "Ada: all comments are ready for review");
});

test("notificationPresentation localizza le push social e ignora fallback italiani per EN", () => {
  assert.deepEqual(
    notificationPresentation("post_comment", { fromName: "Ada" }, "en"),
    { title: "Ada", body: "commented on your post" }
  );
  assert.deepEqual(
    notificationPresentation("engagement_watchlist_reminder", { message: "Hai 8 titoli in watchlist" }, "en-US"),
    { title: "Somto", body: "You have watchlist titles to catch up on" }
  );
});

test("notificationPresentation usa la mappa localizzata quando presente", () => {
  const data = {
    message: "Torna su Somto",
    messageByLocale: { "it-IT": "Torna su Somto", "en-US": "Come back to Somto" },
  };
  assert.deepEqual(notificationPresentation("engagement_nudge", data, "en"), {
    title: "Somto",
    body: "Come back to Somto",
  });
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

test("l'aggiornamento titolo puo' puntare al post dell'uscita", () => {
  const out = titleUpdatePresentation({
    titleId: "ted-lasso",
    ctaUrl: "/community.html?post=official_uscita-tmdb-release-tv-97546-s4-e1",
  });
  assert.equal(out.url, "/community.html?post=official_uscita-tmdb-release-tv-97546-s4-e1");
});

test("una ctaUrl fuori dalle destinazioni ammesse ricade sulla scheda", () => {
  const out = titleUpdatePresentation({ titleId: "ted-lasso", ctaUrl: "/account.html?tab=activity" });
  assert.equal(out.url, "/title.html?id=ted-lasso&focus=updates");
});
