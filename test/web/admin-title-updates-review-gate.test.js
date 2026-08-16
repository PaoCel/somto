import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("admin title updates page follows the private admin console shell", async () => {
  const html = await read("public/admin-title-updates.html");

  assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(html, /id="appSplash"/);
  assert.match(html, /<section id="gate"[^>]*hidden/);
  assert.match(html, /<section id="mainContent" hidden>/);
  assert.match(html, /css\/pages\/admin-editorial\.css/);
  assert.match(html, /js\/pages\/admin-title-updates\.page\.js/);
});

// L'invariante che questa console deve garantire: pubblicare un evento di un
// film che esce entro due settimane manda una push che non si annulla, quindi
// `willNotify` va visto PRIMA di scrivere.
test("writing is gated behind a dry run that shows willNotify", async () => {
  const [html, page] = await Promise.all([
    read("public/admin-title-updates.html"),
    read("public/js/pages/admin-title-updates.page.js"),
  ]);

  // Il bottone che scrive nasce disabilitato nel markup.
  assert.match(html, /<button id="applyBtn"[^>]*disabled>/);
  // L'esito sta in pagina, non in un tooltip.
  assert.match(html, /id="checkPanel"[\s\S]*id="checkNotify"/);

  // La verifica passa dal dry run.
  assert.match(page, /reviewTitleUpdateEvent\(\{ \.\.\.payload, dryRun: true \}\)/);
  // Solo dopo il dry run il bottone si sblocca.
  assert.match(page, /renderCheck\(result, payload\);\s*\n\s*applyBtn\.disabled = false;/);
  // Qualunque modifica al form riporta il bottone a disabilitato.
  assert.match(page, /function invalidateCheck\(\)[\s\S]*applyBtn\.disabled = true;/);
  assert.match(page, /\[effectiveDateInput, regionInput, noteInput\][\s\S]*addEventListener\("input", invalidateCheck\)/);
  assert.match(page, /publishCheck\?\.addEventListener\("change", \(\) => \{\s*\n\s*invalidateCheck\(\);/);
  // Cintura di sicurezza nel punto in cui si scrive davvero.
  assert.match(page, /if \(!verified \|\| verified\.signature !== signatureOf\(payload\)\)/);
  assert.match(page, /if \(verified\.result\?\.willNotify\)[\s\S]*window\.confirm\(/);
  // Finita la scrittura il bottone NON torna cliccabile da solo: la verifica
  // appena consumata e' stata azzerata, quindi serve un nuovo dry run.
  assert.doesNotMatch(page, /^\s*setButtonLoading\(applyBtn, false\);/m);
  assert.match(page, /function refreshApplyState\(\)[\s\S]*applyBtn\.disabled = !verified;/);
});

test("the admin events list needs no composite Firestore index", async () => {
  const api = await read("public/js/api/titleUpdatesAdmin.api.js");

  // Un orderBy insieme a un where di uguaglianza vorrebbe un indice composito:
  // qui l'ordinamento lo fa il client su insiemi piccoli.
  assert.doesNotMatch(api, /orderBy\(/);
  assert.doesNotMatch(api, /^\s*orderBy,\s*$/m);
  assert.match(api, /where\(field, "==", value\)/);
  // Se Firestore chiedesse comunque un indice, si ripiega su una sola uguaglianza.
  assert.match(api, /failed-precondition/);
});
