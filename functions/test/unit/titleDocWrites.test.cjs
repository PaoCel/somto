const test = require("node:test");
const assert = require("node:assert/strict");
const { patchExistingTitle } = require("../../lib/titleDocWrites");

// Fake Firestore minimale: `update()` su un doc assente fallisce con NOT_FOUND
// (code 5), come il client reale. E' esattamente il comportamento che serve:
// una denormalizzazione non deve poter creare il titolo.
function makeFakeDb(existingIds = []) {
  const docs = new Map(existingIds.map((id) => [id, {}]));
  const writes = [];
  return {
    writes,
    docs,
    collection(name) {
      assert.equal(name, "titles");
      return {
        doc(id) {
          return {
            async update(patch) {
              if (!docs.has(id)) {
                const err = new Error("NOT_FOUND: no document to update");
                err.code = 5;
                throw err;
              }
              Object.assign(docs.get(id), patch);
              writes.push({ id, patch });
            },
          };
        },
      };
    },
  };
}

test("scrive sul titolo che esiste", async () => {
  const db = makeFakeDb(["berlino"]);
  const written = await patchExistingTitle(db, "berlino", { watchProviderNames: ["Netflix"] });
  assert.equal(written, true);
  assert.deepEqual(db.writes, [{ id: "berlino", patch: { watchProviderNames: ["Netflix"] } }]);
});

test("non crea il titolo assente: niente fantasmi senza name", async () => {
  const db = makeFakeDb([]);
  const written = await patchExistingTitle(db, "tmdb_tv_308014", { watchProviderNames: ["Netflix"] });
  assert.equal(written, false);
  assert.equal(db.docs.has("tmdb_tv_308014"), false);
  assert.deepEqual(db.writes, []);
});

test("id vuoto o patch vuoto: nessuna scrittura", async () => {
  const db = makeFakeDb(["berlino"]);
  assert.equal(await patchExistingTitle(db, "", { a: 1 }), false);
  assert.equal(await patchExistingTitle(db, "berlino", {}), false);
  assert.equal(await patchExistingTitle(db, "berlino", null), false);
  assert.deepEqual(db.writes, []);
});

test("un errore diverso da NOT_FOUND risale al chiamante", async () => {
  const db = {
    collection: () => ({
      doc: () => ({
        async update() {
          const err = new Error("PERMISSION_DENIED");
          err.code = 7;
          throw err;
        },
      }),
    }),
  };
  await assert.rejects(
    () => patchExistingTitle(db, "berlino", { watchProviderNames: [] }),
    /PERMISSION_DENIED/
  );
});
