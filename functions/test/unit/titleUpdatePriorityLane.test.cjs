"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { readPriorityTitleIds, PRIORITY_WINDOW_MS } = require("../../modules/titleUpdates");

const NOW_MS = Date.parse("2026-09-02T21:00:00.000Z");

function ts(iso) {
  const ms = Date.parse(iso);
  return { toMillis: () => ms };
}

/**
 * Firestore finto: registra le query e restituisce le righe per eventType.
 * Non simula gli operatori, verifica solo cosa chiediamo e come lo usiamo.
 */
function makeDb(rowsByType, calls = []) {
  return {
    collection: () => {
      const state = { eventType: null, limit: null };
      const query = {
        where: (field, _op, value) => {
          if (field === "eventType") state.eventType = value;
          calls.push({ field, value });
          return query;
        },
        orderBy: () => query,
        limit: (value) => { state.limit = value; return query; },
        get: async () => ({
          docs: (rowsByType[state.eventType] || []).slice(0, state.limit || 50)
            .map((row) => ({ data: () => row })),
        }),
      };
      return query;
    },
  };
}

test("prende i titoli in uscita, deduplicati, in ordine di data", async () => {
  const db = makeDb({
    release_date: [
      { titleId: "film-a", effectiveAt: ts("2026-09-10T12:00:00Z") },
      { titleId: "film-b", effectiveAt: ts("2026-11-01T12:00:00Z") },
    ],
    // Una serie ha un evento per episodio: senza dedup si mangia il giro.
    new_episode: [
      { titleId: "serie-x", effectiveAt: ts("2026-09-05T12:00:00Z") },
      { titleId: "serie-x", effectiveAt: ts("2026-09-12T12:00:00Z") },
      { titleId: "serie-x", effectiveAt: ts("2026-09-19T12:00:00Z") },
    ],
  });

  const out = await readPriorityTitleIds({ db, nowMs: NOW_MS, limit: 3 });
  assert.deepEqual(out.titleIds, ["serie-x", "film-a", "film-b"]);
});

test("il cursore avanza e poi torna all'inizio quando la finestra finisce", async () => {
  const rows = {
    release_date: Array.from({ length: 8 }, (_, index) => ({
      titleId: `film-${index}`,
      effectiveAt: ts(new Date(NOW_MS + ((index + 1) * 24 * 60 * 60 * 1000)).toISOString()),
    })),
    new_episode: [],
  };
  const pieno = await readPriorityTitleIds({ db: makeDb(rows), nowMs: NOW_MS, limit: 2 });
  assert.deepEqual(pieno.titleIds, ["film-0", "film-1"]);
  assert.ok(pieno.nextCursorMs > NOW_MS, "il cursore deve avanzare");

  // Poche righe rimaste: il giro dopo riparte da adesso, se no la corsia si
  // ferma sull'ultima uscita e non ripassa piu' sui titoli vicini.
  const coda = await readPriorityTitleIds({
    db: makeDb({ release_date: [rows.release_date[7]], new_episode: [] }),
    nowMs: NOW_MS,
    limit: 6,
  });
  assert.deepEqual(coda.titleIds, ["film-7"]);
  assert.equal(coda.nextCursorMs, 0);
});

test("resta dentro la finestra e non guarda il passato", async () => {
  const calls = [];
  const db = makeDb({ release_date: [], new_episode: [] }, calls);
  await readPriorityTitleIds({ db, nowMs: NOW_MS, limit: 4, cursorMs: NOW_MS - (10 * 24 * 60 * 60 * 1000) });

  const lower = calls.filter((row) => row.field === "effectiveAt")[0];
  const upper = calls.filter((row) => row.field === "effectiveAt")[1];
  // Un cursore vecchio non riapre il passato: si riparte da adesso.
  assert.equal(lower.value.getTime(), NOW_MS);
  assert.equal(upper.value.getTime(), NOW_MS + PRIORITY_WINDOW_MS);
  assert.ok(calls.some((row) => row.field === "status" && row.value === "published"));
});

test("una query che fallisce non fa saltare il giro", async () => {
  const db = {
    collection: () => {
      const query = {
        where: () => query,
        orderBy: () => query,
        limit: () => query,
        get: async () => { throw new Error("indice mancante"); },
      };
      return query;
    },
  };
  const out = await readPriorityTitleIds({ db, nowMs: NOW_MS, limit: 3 });
  assert.deepEqual(out.titleIds, []);
});

const { pickTrailerRefreshes } = require("../../modules/titleUpdates");

function cachedAt(iso) {
  const ms = Date.parse(iso);
  return { toMillis: () => ms };
}

test("il trailer in scheda passa al video nuovo", () => {
  // Il caso vero: teaser di marzo in scheda, teaser nuovo il 2 settembre.
  const out = pickTrailerRefreshes({
    candidates: [{
      titleId: "tmdb_tv_224377",
      eventType: "trailer",
      sourceId: "SJVmeJaS44s",
      publishedAt: "2026-09-02T15:00:03.000Z",
    }],
    titles: [{
      id: "tmdb_tv_224377",
      trailerUrl: "https://www.youtube.com/watch?v=EuiiddcyBX0",
      trailerCachedAt: cachedAt("2026-07-10T14:08:44.475Z"),
    }],
  });
  assert.deepEqual(out, [{
    titleId: "tmdb_tv_224377",
    trailerUrl: "https://www.youtube.com/watch?v=SJVmeJaS44s",
  }]);
});

test("un video vecchio non sostituisce quello gia' in scheda", () => {
  const out = pickTrailerRefreshes({
    candidates: [{
      titleId: "t1",
      eventType: "teaser",
      sourceId: "vecchio",
      publishedAt: "2026-01-01T00:00:00.000Z",
    }],
    titles: [{ id: "t1", trailerUrl: "https://www.youtube.com/watch?v=nuovo", trailerCachedAt: cachedAt("2026-08-01T00:00:00Z") }],
  });
  assert.deepEqual(out, []);
});

test("fra piu' video dello stesso titolo vince il piu' recente", () => {
  const out = pickTrailerRefreshes({
    candidates: [
      { titleId: "t1", eventType: "teaser", sourceId: "a", publishedAt: "2026-09-01T00:00:00Z" },
      { titleId: "t1", eventType: "trailer", sourceId: "b", publishedAt: "2026-09-02T00:00:00Z" },
      // Non e' un video: non deve finire in scheda.
      { titleId: "t1", eventType: "new_episode", sourceId: "c", publishedAt: "2026-09-03T00:00:00Z" },
    ],
    titles: [{ id: "t1", trailerUrl: "", trailerCachedAt: null }],
  });
  assert.deepEqual(out, [{ titleId: "t1", trailerUrl: "https://www.youtube.com/watch?v=b" }]);
});

test("titolo senza trailer: si riempie anche senza data di cache", () => {
  const out = pickTrailerRefreshes({
    candidates: [{ titleId: "t1", eventType: "trailer", sourceId: "x", publishedAt: "2026-09-02T00:00:00Z" }],
    titles: [{ id: "t1" }],
  });
  assert.equal(out.length, 1);
});

test("stesso video gia' in scheda: nessuna scrittura", () => {
  const out = pickTrailerRefreshes({
    candidates: [{ titleId: "t1", eventType: "trailer", sourceId: "x", publishedAt: "2026-09-02T00:00:00Z" }],
    titles: [{ id: "t1", trailerUrl: "https://www.youtube.com/watch?v=x", trailerCachedAt: cachedAt("2026-01-01T00:00:00Z") }],
  });
  assert.deepEqual(out, []);
});
