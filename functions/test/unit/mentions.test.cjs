const test = require("node:test");
const assert = require("node:assert/strict");
const { extractMentionUids, MAX_MENTIONS_PER_TEXT } = require("../../lib/mentions");

function token(name, uid) {
  return `@{${name}}(${uid})`;
}

test("estrae gli uid dai token del picker", () => {
  const text = `ciao ${token("Pulart", "uid-1")} e ${token("Ada", "uid-2")}`;
  assert.deepEqual(extractMentionUids(text).uids, ["uid-1", "uid-2"]);
});

test("un handle scritto a mano NON e' una menzione", () => {
  // E' esattamente il caso segnalato: `@pulart` sembra un tag e non lo e'.
  // La risoluzione handle->uid avviene a monte, al momento dell'invio.
  assert.deepEqual(extractMentionUids("ciao @pulart come va").uids, []);
});

test("lo stesso utente menzionato due volte conta una volta", () => {
  const text = `${token("Pulart", "uid-1")} ${token("Pulart", "uid-1")}`;
  assert.deepEqual(extractMentionUids(text).uids, ["uid-1"]);
  assert.equal(extractMentionUids(text).total, 1);
});

test("oltre il tetto si tronca e lo si puo' sapere", () => {
  const many = Array.from({ length: 25 }, (_, i) => token(`U${i}`, `uid-${i}`)).join(" ");
  const { uids, total } = extractMentionUids(many);

  assert.equal(uids.length, MAX_MENTIONS_PER_TEXT);
  // `total` esiste perche' un troncamento silenzioso si legge come "ho
  // notificato tutti": il chiamante deve poterlo scrivere nei log.
  assert.equal(total, 25);
});

test("testo vuoto o assente non esplode", () => {
  assert.deepEqual(extractMentionUids("").uids, []);
  assert.deepEqual(extractMentionUids(null).uids, []);
  assert.deepEqual(extractMentionUids(undefined).total, 0);
});

test("la regex non e' stateful fra chiamate", () => {
  // Una regex /g riusata conserva lastIndex: se il modulo esportasse la stessa
  // istanza, la seconda chiamata salterebbe l'inizio del testo.
  const text = token("Pulart", "uid-1");
  assert.deepEqual(extractMentionUids(text).uids, ["uid-1"]);
  assert.deepEqual(extractMentionUids(text).uids, ["uid-1"]);
});
