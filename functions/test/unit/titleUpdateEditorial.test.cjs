const test = require("node:test");
const assert = require("node:assert/strict");
const { buildEditorialPatch, MANUAL_NOTIFY_WINDOW_MS } = require("../../lib/titleUpdateEditorial");

const NOW = new Date("2026-08-12T10:00:00.000Z");
const EDITOR = "admin-uid";

function draftEvent(overrides = {}) {
  return {
    eventType: "release_date",
    status: "draft",
    acquisitionMode: "backfill",
    effectiveAt: new Date("2026-10-08T12:00:00.000Z"),
    ...overrides,
  };
}

function inDays(days) {
  return new Date(NOW.getTime() + days * 86_400_000);
}

test("correggere la data fissa anche l'ordinamento", () => {
  const { patch, lockedFields } = buildEditorialPatch({
    existing: draftEvent(),
    effectiveDate: "2026-11-20",
    editedBy: EDITOR,
    now: NOW,
  });

  assert.deepEqual(patch.effectiveAt, new Date("2026-11-20T12:00:00.000Z"));
  // Senza sortAt l'evento resterebbe in timeline nella posizione vecchia.
  assert.deepEqual(patch.sortAt, patch.effectiveAt);
  assert.deepEqual(lockedFields, ["effectiveAt", "sortAt"]);
});

test("una data di calendario non scivola di un giorno", () => {
  const { patch } = buildEditorialPatch({
    existing: draftEvent(),
    effectiveDate: "2026-11-20",
    editedBy: EDITOR,
    now: NOW,
  });

  assert.equal(patch.effectiveAt.toISOString().slice(0, 10), "2026-11-20");
});

test("l'evento resta marcato come toccato da una persona", () => {
  const { patch } = buildEditorialPatch({
    existing: draftEvent(),
    effectiveDate: "2026-11-20",
    editedBy: EDITOR,
    now: NOW,
  });

  assert.equal(patch.acquisitionMode, "manual");
  assert.equal(patch.editorial.editedBy, EDITOR);
});

// La regola di prodotto: notifichi solo se l'uscita e' azionabile.
test("pubblicare notifica se l'uscita e' entro due settimane", () => {
  const { patch, willNotify, warnings } = buildEditorialPatch({
    existing: draftEvent({ effectiveAt: inDays(10) }),
    publish: true,
    effectiveDate: inDays(10).toISOString(),
    editedBy: EDITOR,
    now: NOW,
  });

  assert.equal(patch.status, "published");
  assert.equal(patch.notificationEligible, true);
  assert.equal(willNotify, true);
  assert.deepEqual(warnings, []);
});

test("pubblicare NON notifica se l'uscita e' lontana", () => {
  const { patch, willNotify, warnings } = buildEditorialPatch({
    existing: draftEvent(),
    publish: true,
    effectiveDate: inDays(60).toISOString(),
    editedBy: EDITOR,
    now: NOW,
  });

  assert.equal(patch.status, "published");
  assert.equal(patch.notificationEligible, false);
  assert.equal(willNotify, false);
  assert.match(warnings[0], /oltre due settimane/);
});

test("un'uscita gia' passata non notifica", () => {
  const { willNotify, warnings } = buildEditorialPatch({
    existing: draftEvent(),
    publish: true,
    effectiveDate: inDays(-3).toISOString(),
    editedBy: EDITOR,
    now: NOW,
  });

  assert.equal(willNotify, false);
  assert.match(warnings[0], /gia' passata/);
});

test("ripubblicare un evento gia' pubblicato non rinotifica", () => {
  const { patch, willNotify } = buildEditorialPatch({
    existing: draftEvent({ status: "published", effectiveAt: inDays(5) }),
    publish: true,
    effectiveDate: inDays(5).toISOString(),
    editedBy: EDITOR,
    now: NOW,
  });

  assert.equal(willNotify, false);
  assert.equal(patch.notificationEligible, undefined);
});

// Il confine esatto: 14 giorni dentro, 15 fuori.
test("la finestra di notifica e' esattamente due settimane", () => {
  const atLimit = buildEditorialPatch({
    existing: draftEvent(),
    publish: true,
    effectiveDate: new Date(NOW.getTime() + MANUAL_NOTIFY_WINDOW_MS).toISOString(),
    editedBy: EDITOR,
    now: NOW,
  });
  const past = buildEditorialPatch({
    existing: draftEvent(),
    publish: true,
    effectiveDate: new Date(NOW.getTime() + MANUAL_NOTIFY_WINDOW_MS + 60_000).toISOString(),
    editedBy: EDITOR,
    now: NOW,
  });

  assert.equal(atLimit.willNotify, true);
  assert.equal(past.willNotify, false);
});

test("pubblicare senza correggere preserva il blocco e azzera il conflitto", () => {
  const editorial = {
    lockedFields: ["effectiveAt", "sortAt"],
    editedBy: "qualcun-altro",
    editedAt: NOW,
    note: null,
    sourceConflict: { field: "effectiveAt", sourceValue: NOW, detectedAt: NOW },
  };

  const { patch } = buildEditorialPatch({
    existing: draftEvent({ editorial }),
    publish: true,
    editedBy: EDITOR,
    now: NOW,
  });

  assert.deepEqual(patch.editorial.lockedFields, ["effectiveAt", "sortAt"]);
  assert.equal(patch.editorial.sourceConflict, null);
});

test("rifiuta i tipi di evento diversi da release_date", () => {
  assert.throws(
    () => buildEditorialPatch({
      existing: draftEvent({ eventType: "trailer" }),
      effectiveDate: "2026-11-20",
      editedBy: EDITOR,
      now: NOW,
    }),
    /release_date/
  );
});

test("rifiuta una richiesta che non cambia niente", () => {
  assert.throws(
    () => buildEditorialPatch({ existing: draftEvent(), editedBy: EDITOR, now: NOW }),
    /Niente da correggere/
  );
});

test("rifiuta una data non parsabile e un editore anonimo", () => {
  assert.throws(
    () => buildEditorialPatch({ existing: draftEvent(), effectiveDate: "domani", editedBy: EDITOR, now: NOW }),
    /Data non valida/
  );
  assert.throws(
    () => buildEditorialPatch({ existing: draftEvent(), effectiveDate: "2026-11-20", editedBy: "", now: NOW }),
    /editedBy/
  );
});
