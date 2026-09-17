// Landing dell'invito esterno (/quiz/invite/{token} → quizInvitePreview).
// La sfida e' giocabile anche sul web: la pagina deve offrire il link a
// /quiz-invite.html?token=... senza perdere il CTA App Store come primario.

const test = require("node:test");
const assert = require("node:assert/strict");

const { _renderInvitePage: renderInvitePage } = require("../../modules/quizInvite");

const VALID = {
  valid: true,
  inviterName: "Paolo",
  numQuestions: 10,
  token: "abc123_-XYZ",
};

test("invito valido: App Store primario + continua nel browser", () => {
  const html = renderInvitePage(VALID);
  const appStoreAt = html.indexOf("apps.apple.com");
  const browserAt = html.indexOf("/quiz-invite.html?token=abc123_-XYZ");
  assert.ok(appStoreAt > -1, "manca il CTA App Store");
  assert.ok(browserAt > -1, "manca il link alla pagina web dell'invito");
  assert.ok(appStoreAt < browserAt, "il CTA App Store deve restare il primo");
  assert.match(html, /Continua nel browser/);
});

test("invito non valido: nessun link di gioco", () => {
  const html = renderInvitePage({ ...VALID, valid: false });
  assert.ok(!html.includes("/quiz-invite.html"), "un invito scaduto non deve rimandare al player");
  assert.ok(!html.includes("apps.apple.com"), "un invito scaduto non deve rimandare all'App Store");
  assert.match(html, /Invito non più disponibile/);
});

test("il token finisce nell'href codificato ed escapato", () => {
  const html = renderInvitePage({ ...VALID, token: '"><script>alert(1)</script>' });
  assert.ok(!html.includes("<script>alert(1)</script>"), "token non escapato nel markup");
  assert.ok(
    html.includes("/quiz-invite.html?token=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E"),
    "il token deve essere percent-encoded nell'href"
  );
});

test("token assente: href senza valore, nessun undefined", () => {
  const html = renderInvitePage({ ...VALID, token: "" });
  assert.ok(html.includes("/quiz-invite.html?token="));
  assert.ok(!html.includes("token=undefined"));
});

// --- invito annullato dal mittente (cancelQuizExternalInvite) --------------
// La landing deve dire "Invito annullato" e non offrire nessun modo di
// giocare: il link e' gia' in giro, chi lo apre non deve entrare in partita.

test("invito annullato: titolo dedicato, nessun link di gioco", () => {
  const html = renderInvitePage({ ...VALID, valid: false, reason: "revoked" });
  assert.match(html, /<h1>Invito annullato<\/h1>/);
  assert.ok(!html.includes("/quiz-invite.html"), "un invito annullato non deve rimandare al player");
  assert.ok(!html.includes("apps.apple.com"), "un invito annullato non deve rimandare all'App Store");
  assert.ok(!html.includes("Continua nel browser"), "nessun CTA di gioco su un invito annullato");
});

test("invito annullato: nessun dato dell'invito in pagina", () => {
  const html = renderInvitePage({ ...VALID, valid: false, reason: "revoked" });
  assert.ok(!html.includes("Paolo"), "il nome del mittente non deve uscire");
  assert.ok(!html.includes("abc123_-XYZ"), "il token non deve comparire in pagina");
});

test("scaduto e annullato hanno copy diverse", () => {
  const scaduto = renderInvitePage({ ...VALID, valid: false, reason: "" });
  const annullato = renderInvitePage({ ...VALID, valid: false, reason: "revoked" });
  assert.match(scaduto, /Invito non più disponibile/);
  assert.ok(!scaduto.includes("Invito annullato"));
  assert.ok(!annullato.includes("Invito non più disponibile"));
});

test("un invito valido ignora reason", () => {
  const html = renderInvitePage({ ...VALID, reason: "revoked" });
  assert.ok(!html.includes("Invito annullato"));
  assert.match(html, /Continua nel browser/);
});
