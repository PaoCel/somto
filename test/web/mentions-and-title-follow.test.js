import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

// Il token che il backend riconosce come menzione e' `@{Nome}(uid)`
// (functions/lib/mentions.js). Lo compone solo il picker: un composer senza
// picker e' un composer dove taggare non fa niente, in silenzio.
test("ogni composer che invia testo monta il picker condiviso", async () => {
  const [shared, community, thread, title] = await Promise.all([
    read("public/js/components/mentionAutocomplete.js"),
    read("public/js/pages/community.page.js"),
    read("public/js/pages/thread.page.js"),
    read("public/js/pages/title.page.js"),
  ]);

  assert.match(shared, /export function attachMentionAutocomplete\(/);
  for (const page of [community, thread, title]) {
    assert.match(page, /import \{[\s\S]*attachMentionAutocomplete[\s\S]*\} from "\.\.\/components\/mentionAutocomplete\.js"/);
  }

  // Composer del post, commento a un post, risposta inline sulla card commento.
  assert.equal((community.match(/attachMentionAutocomplete\(/g) || []).length, 3);
  // Chat/thread e discussione episodio.
  assert.match(thread, /mentionCtrl = attachMentionAutocomplete\(els\.msgText, els\.mentionDropdown/);
  assert.match(title, /epDiscMentionCtrl = attachMentionAutocomplete\(epDiscComposerInput, epDiscMentionDropdown\)/);
});

// Il motivo per cui il modulo esiste: la logica era gia' copiata tre volte, e i
// due composer nuovi l'avrebbero portata a cinque.
test("la logica del picker non e' ricopiata nelle pagine", async () => {
  const pages = await Promise.all([
    read("public/js/pages/community.page.js"),
    read("public/js/pages/thread.page.js"),
    read("public/js/pages/title.page.js"),
  ]);

  for (const page of pages) {
    assert.doesNotMatch(page, /function getActiveMention\(/);
    assert.doesNotMatch(page, /function buildMentionToken\(/);
    assert.doesNotMatch(page, /function insertMention/);
    assert.doesNotMatch(page, /function renderMention/);
    // Nessuna pagina ricompone a mano il token canonico.
    assert.doesNotMatch(page, /real: `@\{/);
  }
});

test("i due composer che non taggavano hanno dropdown e wiring", async () => {
  const [community, titleHtml, titleCss] = await Promise.all([
    read("public/js/pages/community.page.js"),
    read("public/title.html"),
    read("public/css/pages/title.css"),
  ]);

  // (a) risposta inline sulla card commento del feed
  assert.match(community, /data-feed-comment-mention="1"/);
  assert.match(community, /class="feed-comment-input-wrap"/);
  assert.match(community, /function wireFeedCommentMention\(composerEl\)/);

  // (b) discussione episodio nella scheda titolo
  assert.match(titleHtml, /id="epDiscMentionDropdown" class="mention-dropdown"/);
  assert.match(titleHtml, /class="ep-disc-composer-field"/);
  // title.bundle.css non importa home.css/thread.css: senza queste regole il
  // dropdown esisterebbe ma non si vedrebbe dove deve.
  assert.match(titleCss, /\.mention-dropdown \{/);
  assert.match(titleCss, /\.ep-disc-composer-field \{[\s\S]*position: relative;/);
});

// Anche con un token valido, `escapeHtml` grezzo lo lascia a schermo come
// testo: la menzione notifica ma non e' cliccabile e sembra rotta.
test("i messaggi episodio rendono i tag come link, non come testo", async () => {
  const title = await read("public/js/pages/title.page.js");

  assert.match(title, /class="ep-disc-msg-text">\$\{renderMentionRichText\(msg\.text \|\| "", \{ lineBreaks: false \}\)\}/);
  assert.doesNotMatch(title, /class="ep-disc-msg-text">\$\{escapeHtml\(msg\.text/);
});

// Rete di sicurezza: il picker non copre chi scrive `@nome` e va avanti senza
// selezionare dal menu. Quel caso si chiude all'invio.
test("gli @handle battuti a mano diventano token canonici prima del salvataggio", async () => {
  const [shared, users, community, thread, title] = await Promise.all([
    read("public/js/components/mentionAutocomplete.js"),
    read("public/js/api/users.api.js"),
    read("public/js/pages/community.page.js"),
    read("public/js/pages/thread.page.js"),
    read("public/js/pages/title.page.js"),
  ]);

  // Una getDoc su `usernames/{handle}`, leggibile da qualunque utente loggato.
  assert.match(users, /export async function getUserByHandle\(handle\)/);
  assert.match(users, /doc\(db, "usernames", key\)/);
  assert.match(shared, /export async function resolveTypedHandles\(/);
  assert.match(shared, /`\$\{lead\}@\{\$\{hit\.displayName\}\}\(\$\{hit\.uid\}\)`/);
  // Handle inesistente = resta testo.
  assert.match(shared, /if \(!hit\) return whole;/);
  // Stesso tetto del server (functions/lib/mentions.js ne notifica al massimo 10).
  assert.match(shared, /export const MAX_RESOLVED_HANDLES = 10;/);

  // Ogni invio passa da resolveForSend: post, commento a un post, risposta
  // inline, messaggio di thread, messaggio della discussione episodio.
  assert.equal((community.match(/resolveForSend\(/g) || []).length, 3);
  assert.match(thread, /const text = mentionCtrl \? await mentionCtrl\.resolveForSend\(rawText\) : rawText;/);
  assert.match(title, /const text = epDiscMentionCtrl \? await epDiscMentionCtrl\.resolveForSend\(raw\) : raw;/);
});

// Un post editoriale su un film che esce lo legge anche chi quel film non ha
// mai toccato: senza follow non ricevera' la notifica dell'uscita.
test("la card di un post permette di seguire il titolo", async () => {
  const [community, api] = await Promise.all([
    read("public/js/pages/community.page.js"),
    read("public/js/api/titleUpdates.api.js"),
  ]);

  // Il ramo con copertina (post editoriali) e la mini card hanno entrambi il bottone.
  assert.match(community, /function inlineTitleHtml[\s\S]*titleFollowButtonHtml\(t, \{ variant: "text" \}\)/);
  assert.match(community, /function miniTitleHtml[\s\S]*titleFollowButtonHtml\(t, \{ variant: "icon" \}\)/);

  // Toggle secco follow ⇄ auto sulla preferenza gia' esistente.
  assert.match(community, /const nextMode = wasFollowing \? "auto" : "follow";/);
  assert.match(community, /setTitleUpdatePreference\(state\.me\.uid, titleId, nextMode\)/);

  // Lo stato e' noto PRIMA di disegnare, se no il bottone lampeggia.
  assert.match(community, /await ensureTitleUpdatePrefs\(\);/);
  assert.match(api, /export async function listMyTitleUpdatePreferences\(/);
  assert.match(community, /const following = state\.titleUpdatePrefs\.get\(t\.id\) === "follow";/);

  // Niente copy nuovo: le stesse frasi della scheda titolo.
  assert.match(community, /i18nT\("Preferenza salvata\."\), i18nT\("Aggiornamenti"\)/);
});
