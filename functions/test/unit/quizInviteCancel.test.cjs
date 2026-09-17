// Precondizioni di cancelQuizExternalInvite (functions/modules/quizInvite.js).
// La callable in se' vuole Firestore, quindi qui si testa solo la guardia
// pura: chi puo' annullare, e con quale errore rimbalzano gli altri.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  _assertCancellableExternalChallenge: assertCancellable,
} = require("../../modules/quizInvite");

const PENDING_EXTERNAL = {
  fromUid: "inviter-1",
  toUid: null,
  inviteType: "external",
  status: "pending_external_signup",
};

function errorOf(challenge, uid) {
  try {
    assertCancellable(challenge, uid);
    return null;
  } catch (err) {
    return { code: err.code, message: err.message };
  }
}

test("il mittente puo' annullare un invito esterno non accettato", () => {
  assert.equal(errorOf(PENDING_EXTERNAL, "inviter-1"), null);
});

test("un altro utente non puo' annullare", () => {
  assert.deepEqual(errorOf(PENDING_EXTERNAL, "altro"), {
    code: "permission-denied",
    message: "Non sei il mittente di questa sfida.",
  });
});

test("senza uid non si annulla niente", () => {
  assert.equal(errorOf(PENDING_EXTERNAL, "").code, "permission-denied");
  assert.equal(errorOf(PENDING_EXTERNAL, undefined).code, "permission-denied");
});

test("una sfida interna non e' annullabile da qui", () => {
  assert.deepEqual(errorOf({ ...PENDING_EXTERNAL, inviteType: "internal" }, "inviter-1"), {
    code: "failed-precondition",
    message: "Sfida non valida.",
  });
});

test("invito gia' accettato: non si annulla piu'", () => {
  for (const status of ["pending_opponent_titles", "in_progress", "completed"]) {
    assert.deepEqual(errorOf({ ...PENDING_EXTERNAL, status }, "inviter-1"), {
      code: "failed-precondition",
      message: "Questo invito è già stato accettato.",
    }, `stato ${status}`);
  }
});

test("sfida mancante: not-found, senza leak", () => {
  assert.deepEqual(errorOf(null, "inviter-1"), {
    code: "not-found",
    message: "Sfida non trovata.",
  });
});

test("l'ownership viene prima del tipo e dello stato", () => {
  // Un estraneo non deve poter distinguere una sfida interna da una esterna
  // gia' accettata: la prima cosa che si controlla e' che sia sua.
  const altrui = { fromUid: "inviter-1", inviteType: "internal", status: "completed" };
  assert.equal(errorOf(altrui, "curioso").code, "permission-denied");
});
