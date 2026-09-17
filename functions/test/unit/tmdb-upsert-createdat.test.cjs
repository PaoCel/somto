const test = require("node:test");
const assert = require("node:assert/strict");
const { upsertTmdbTitle } = require("../../modules/tmdb");

// Firestore finto con doc().get()/set(merge) e where(), quanto basta a
// `upsertTmdbTitle`. Il poster non parte: `uploadTmdbPosterToStorage` esce
// subito se il row non ha `poster_path`, quindi niente rete.
function makeDb(seed = {}) {
  const store = new Map(Object.entries(seed).map(([id, data]) => [id, { ...data }]));
  const writes = [];

  const query = (filters) => ({
    where: (field, op, value) => query([...filters, { field, op, value }]),
    limit: () => query(filters),
    async get() {
      let rows = [...store.entries()].map(([id, data]) => ({ id, data }));
      for (const f of filters) {
        if (f.op === "==") rows = rows.filter((r) => r.data[f.field] === f.value);
        else if (f.op === "array-contains") {
          rows = rows.filter((r) => Array.isArray(r.data[f.field]) && r.data[f.field].includes(f.value));
        }
      }
      const docs = rows.map((r) => ({ id: r.id, data: () => r.data, get: (k) => r.data[k] }));
      return { empty: docs.length === 0, docs };
    },
  });

  return {
    store,
    writes,
    collection() {
      return {
        ...query([]),
        doc(id) {
          return {
            id,
            async get() {
              const data = store.get(id);
              return { exists: Boolean(data), id, data: () => data };
            },
            async set(payload, options) {
              writes.push({ id, payload, options });
              store.set(id, { ...(store.get(id) || {}), ...payload });
            },
          };
        },
      };
    },
  };
}

const BUCKET = {};
const ROW = { type: "tv", tmdbId: 1396, id: 1396, name: "Breaking Bad", first_air_date: "2008-01-20" };

test("su un titolo che esiste gia' la fusione NON riscrive createdAt", async () => {
  // Caso reale: `reacher`, creato da un utente, si ritrovava createdAt di oggi
  // dopo ogni run del cron. `titles` si ordina per createdAt desc in
  // "aggiunti di recente", quindi i titoli vecchi risalivano in cima.
  const db = makeDb({
    "tmdb_tv_1396": { type: "tv", tmdbId: 1396, nameLower: "breaking bad", year: 2008, createdAt: "ORIGINALE" },
  });

  const res = await upsertTmdbTitle(db, BUCKET, ROW, new Map());
  assert.equal(res.imported, true);

  const written = db.writes.at(-1);
  assert.equal(written.options.merge, true);
  assert.ok(!("createdAt" in written.payload), "createdAt non deve essere nel payload di una fusione");
  assert.equal(db.store.get("tmdb_tv_1396").createdAt, "ORIGINALE");
});

test("su un titolo nuovo createdAt viene scritto", async () => {
  const db = makeDb({});
  const res = await upsertTmdbTitle(db, BUCKET, ROW, new Map());
  assert.equal(res.imported, true);
  assert.equal(res.duplicate, false);

  const written = db.writes.at(-1);
  assert.ok("createdAt" in written.payload, "un titolo nuovo deve avere createdAt");
});

test("il resto dei campi continua ad aggiornarsi sulla fusione", async () => {
  const db = makeDb({
    "tmdb_tv_1396": { type: "tv", tmdbId: 1396, nameLower: "vecchio nome", year: 2008, createdAt: "ORIGINALE" },
  });
  await upsertTmdbTitle(db, BUCKET, ROW, new Map());
  const written = db.writes.at(-1);
  assert.equal(written.payload.nameLower, "breaking bad");
  assert.equal(written.payload.status, "approved");
});

test("un titolo sync-locked resta intoccato", async () => {
  const db = makeDb({
    "tmdb_tv_1396": {
      type: "tv", tmdbId: 1396, nameLower: "breaking bad", year: 2008,
      createdAt: "ORIGINALE", tmdbSync: { syncDisabled: true },
    },
  });
  const res = await upsertTmdbTitle(db, BUCKET, ROW, new Map());
  assert.equal(res.duplicate, true);
  assert.equal(db.writes.length, 0, "non deve essere scritto niente");
});
