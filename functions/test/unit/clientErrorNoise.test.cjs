const test = require("node:test");
const assert = require("node:assert/strict");

const { isIgnorableClientError } = require("../../lib/clientErrorNoise");

test("errori di estensioni del browser sono rumore", () => {
  // Caso reale: alert admin 2026-08-24 su /community.html, Safari iOS.
  assert.equal(
    isIgnorableClientError({ message: "Invalid call to runtime.sendMessage(). Tab not found." }),
    true
  );
  assert.equal(isIgnorableClientError({ message: "Extension context invalidated." }), true);
  assert.equal(
    isIgnorableClientError({ message: "Could not establish connection. Receiving end does not exist." }),
    true
  );
  assert.equal(
    isIgnorableClientError({ message: "boom", source: "chrome-extension://abc/content.js" }),
    true
  );
  assert.equal(
    isIgnorableClientError({ message: "boom", stack: "at f (safari-web-extension://abc/inject.js:1:1)" }),
    true
  );
});

test("rumore del motore del browser non e' un bug Somto", () => {
  assert.equal(
    isIgnorableClientError({ message: "Skipping view transition because skipTransition() was called." }),
    true
  );
  assert.equal(
    isIgnorableClientError({ message: "ResizeObserver loop completed with undelivered notifications." }),
    true
  );
  assert.equal(isIgnorableClientError({ message: "Script error." }), true);
  // Con uno stack utilizzabile l'errore opaco resta segnalabile.
  assert.equal(
    isIgnorableClientError({ message: "Script error.", stack: "at goAll (/js/pages/watchlist.page.js:589:54)" }),
    false
  );
});

test("gli errori veri del codice Somto passano", () => {
  assert.equal(
    isIgnorableClientError({
      message: "Uncaught TypeError: Cannot read properties of undefined (reading 'catch')",
      source: "https://somto.it/js/pages/watchlist.page.js",
      stack: "at goAll (https://somto.it/js/pages/watchlist.page.js:589:54)",
    }),
    false
  );
  assert.equal(isIgnorableClientError({}), false);
  assert.equal(isIgnorableClientError(), false);
});
