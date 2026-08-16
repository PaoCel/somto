const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseTvTimeListsCsv,
  parseListObjects,
  splitGoMapArray,
  buildMovieUuidNameLookup,
  resolveListItemNames,
} = require("../../lib/importAdapters/tvTimeLists");

/* ============================= splitGoMapArray / parseListObjects ============================= */

test("splitGoMapArray extracts a single map[...] segment's inner content", () => {
  const raw = "[map[created_at:1.783279308e+09 type:movie uuid:a6890b92-8731-4d5c-acbb-0e4e403fe3e6]]";
  const segments = splitGoMapArray(raw);
  assert.equal(segments.length, 1);
  assert.match(segments[0], /type:movie/);
  assert.match(segments[0], /uuid:a6890b92/);
});

test("splitGoMapArray extracts multiple map[...] segments", () => {
  const raw = "[map[type:movie uuid:aaa] map[type:series uuid:bbb id:12345]]";
  const segments = splitGoMapArray(raw);
  assert.equal(segments.length, 2);
});

test("splitGoMapArray handles a nested array value inside a map (e.g. fanart:[...]) without breaking segmentation", () => {
  const raw = "[map[name:Foo fanart:[https://a.example.com/1.jpg https://a.example.com/2.jpg] type:list] map[name:Bar type:list]]";
  const segments = splitGoMapArray(raw);
  assert.equal(segments.length, 2);
  assert.match(segments[0], /name:Foo/);
  assert.match(segments[1], /name:Bar/);
});

test("splitGoMapArray returns [] for non-array input", () => {
  assert.deepEqual(splitGoMapArray(""), []);
  assert.deepEqual(splitGoMapArray("not-an-array"), []);
});

test("parseListObjects: movie item -> mediaTypeGuess movie, uuid only (no tvdbSeriesId)", () => {
  const raw = "[map[created_at:1.783279308e+09 type:movie uuid:a6890b92-8731-4d5c-acbb-0e4e403fe3e6]]";
  const items = parseListObjects(raw);
  assert.equal(items.length, 1);
  assert.equal(items[0].mediaTypeGuess, "movie");
  assert.equal(items[0].uuid, "a6890b92-8731-4d5c-acbb-0e4e403fe3e6");
  assert.equal(items[0].tvdbSeriesId, null);
});

test("parseListObjects: series item -> mediaTypeGuess tv, tvdbSeriesId from id", () => {
  const raw = "[map[created_at:1.783279205e+09 id:401003 type:series uuid:643dde38-b90f-4c29-b4a8-785db05a627e]]";
  const items = parseListObjects(raw);
  assert.equal(items.length, 1);
  assert.equal(items[0].mediaTypeGuess, "tv");
  assert.equal(items[0].tvdbSeriesId, 401003);
});

test("parseListObjects: multiple items in the same list", () => {
  const raw = "[map[type:movie uuid:aaa] map[type:movie uuid:bbb]]";
  const items = parseListObjects(raw);
  assert.equal(items.length, 2);
});

test("parseListObjects: unknown item type is skipped defensively", () => {
  const raw = "[map[type:unknown_future_type uuid:aaa]]";
  const items = parseListObjects(raw);
  assert.equal(items.length, 0);
});

/* ============================= parseTvTimeListsCsv ============================= */

const LISTS_HEADER = "user_id,type,name,created_at,ordering,description,objects,s_key,is_public,lists";

test("parseTvTimeListsCsv parses a private list with one movie item", () => {
  const csv = [
    LISTS_HEADER,
    '109813159,list,nuova lista,2026-07-05 19:21:48,0,,[map[created_at:1.783279308e+09 type:movie uuid:a6890b92-8731-4d5c-acbb-0e4e403fe3e6]],856b0c88-af25-4cd9-83b5-ac4f3b97a1f9,false,',
  ].join("\n");
  const { lists, errors } = parseTvTimeListsCsv(csv);
  assert.equal(errors.length, 0);
  assert.equal(lists.length, 1);
  assert.equal(lists[0].name, "nuova lista");
  assert.equal(lists[0].isPublic, false);
  assert.equal(lists[0].items.length, 1);
  assert.equal(lists[0].items[0].uuid, "a6890b92-8731-4d5c-acbb-0e4e403fe3e6");
});

test("parseTvTimeListsCsv parses a public list (is_public=true)", () => {
  const csv = [
    LISTS_HEADER,
    '109813159,list,generale,2026-07-05 19:20:25,0,,[map[created_at:1.783279225e+09 type:movie uuid:611350c4-7d50-48ad-bf2b-84c0a1e1201a]],c675dbae-3023-4825-b005-fb19ade89e42,true,',
  ].join("\n");
  const { lists } = parseTvTimeListsCsv(csv);
  assert.equal(lists.length, 1);
  assert.equal(lists[0].isPublic, true);
});

test("parseTvTimeListsCsv ignores the redundant 'collection' aggregate row (would double-import every list)", () => {
  const csv = [
    LISTS_HEADER,
    '109813159,,,,,,,collection,,[map[name:Favorite Shows type:list] map[name:generale type:list]]',
  ].join("\n");
  const { lists, errors } = parseTvTimeListsCsv(csv);
  assert.equal(lists.length, 0);
  assert.equal(errors.length, 0);
});

test("parseTvTimeListsCsv: series list item carries tvdbSeriesId directly", () => {
  const csv = [
    LISTS_HEADER,
    '109813159,list,Favorite Shows,2026-07-05 19:20:05,0,,[map[created_at:1.783279205e+09 id:401003 type:series uuid:643dde38-b90f-4c29-b4a8-785db05a627e]],favorite-series,false,',
  ].join("\n");
  const { lists } = parseTvTimeListsCsv(csv);
  assert.equal(lists.length, 1);
  assert.equal(lists[0].items[0].mediaTypeGuess, "tv");
  assert.equal(lists[0].items[0].tvdbSeriesId, 401003);
});

test("parseTvTimeListsCsv: missing name is an explicit error", () => {
  const csv = [
    LISTS_HEADER,
    '109813159,list,,2026-07-05 19:20:05,0,,[map[type:movie uuid:aaa]],some-key,false,',
  ].join("\n");
  const { lists, errors } = parseTvTimeListsCsv(csv);
  assert.equal(lists.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /mancante/i);
});

test("parseTvTimeListsCsv: empty file reports an explicit error", () => {
  const { lists, errors } = parseTvTimeListsCsv("");
  assert.equal(lists.length, 0);
  assert.equal(errors.length, 1);
});

test("parseTvTimeListsCsv: column order doesn't matter (resolves by header name)", () => {
  const reordered = "is_public,name,type,objects,s_key,user_id,created_at,ordering,description,lists";
  const csv = [
    reordered,
    'true,MyList,list,[map[type:movie uuid:xyz]],my-key,109813159,2026-07-05 19:20:05,0,,',
  ].join("\n");
  const { lists } = parseTvTimeListsCsv(csv);
  assert.equal(lists.length, 1);
  assert.equal(lists[0].name, "MyList");
  assert.equal(lists[0].isPublic, true);
});

/* ============================= buildMovieUuidNameLookup + resolveListItemNames ============================= */

const MOVIES_HEADER = "type-uuid-n,watch_count,watches,user_id,entity_type,movie_name,uuid,rewatch_count,follow_date_range_key,release_date,created_at,alpha_range_key,updated_at,release_date_range_key,type,total_movies_runtime,runtime,watch_date_range_key,country";

test("buildMovieUuidNameLookup maps uuid -> movie_name from the v1 raw CSV", () => {
  const csv = [
    MOVIES_HEADER,
    'follow-a6890b92-8731-4d5c-acbb-0e4e403fe3e6-0,,,109813159,movie,Enola Holmes 3,a6890b92-8731-4d5c-acbb-0e4e403fe3e6,0,follow-follow-date-x,2026-07-01 00:00:00,2026-07-05 19:17:02,follow-alpha-x,2026-07-05 19:17:02,follow-release-date-x,follow,,,,',
  ].join("\n");
  const lookup = buildMovieUuidNameLookup(csv);
  assert.equal(lookup.get("a6890b92-8731-4d5c-acbb-0e4e403fe3e6"), "Enola Holmes 3");
});

test("resolveListItemNames: movie item resolves nameGuess via the uuid lookup; series item needs no name (tvdbSeriesId path)", () => {
  const lists = [{
    name: "Test",
    isPublic: false,
    sKey: "k1",
    createdAt: null,
    items: [
      { mediaTypeGuess: "movie", uuid: "uuid1", tvdbSeriesId: null },
      { mediaTypeGuess: "tv", uuid: "uuid2", tvdbSeriesId: 401003 },
    ],
  }];
  const lookup = new Map([["uuid1", "Some Movie"]]);
  const resolved = resolveListItemNames(lists, lookup);
  assert.equal(resolved[0].items[0].nameGuess, "Some Movie");
  assert.equal(resolved[0].items[1].nameGuess, null); // tv items never need a name lookup
});

test("resolveListItemNames: movie item with no matching uuid in the lookup -> nameGuess null (caller decides fate)", () => {
  const lists = [{ name: "Test", isPublic: false, sKey: "k1", createdAt: null, items: [{ mediaTypeGuess: "movie", uuid: "unknown-uuid", tvdbSeriesId: null }] }];
  const resolved = resolveListItemNames(lists, new Map());
  assert.equal(resolved[0].items[0].nameGuess, null);
});
