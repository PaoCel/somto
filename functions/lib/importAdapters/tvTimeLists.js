"use strict";

// TV Time GDPR export adapter for `lists-prod-lists.csv`.
// (the user's custom lists: "Watchlist", "Favorite Shows", any list they
// created themselves). This module produces a normalized intermediate
// representation of each list; it does NOT write anything to Firestore.
//
// The Firestore writer lives in tvTimeListsWriter.js. Imported lists always
// start PRIVATE on Somto even when TV Time marked them public: publishing is
// an explicit user action and must never be inferred during a data migration.
//
// CSV shape observed (`lists-prod-lists.csv`, DynamoDB dump — column order
// varies between exports, ALWAYS resolve by header name):
//   user_id, type, name, created_at, ordering, description, objects,
//   s_key, is_public, lists
//
// Two row shapes:
//   - `type == "list"`: a real user list. `name`, `is_public` (bool),
//     `objects` = a Go `%v` array-of-maps dump (NOT JSON) — one entry per
//     item, each `map[created_at:<epoch> type:movie|series uuid:<uuid>
//     id:<tvdbId>?]` (`id` present only for series = TheTVDB numeric id).
//   - `s_key == "collection"` (with `type` EMPTY): a redundant aggregate row
//     dumping ALL of the user's lists again into a `lists` column (itself a
//     Go array-of-maps of maps) — this is NOT a distinct list, just TV
//     Time's own denormalized index; MUST be ignored to avoid double-import.
//
// Movie items only carry a `uuid` (no direct title). That uuid is the SAME
// uuid TV Time uses in tracking-prod-records.csv (v1)'s `uuid` column for
// watch/follow/towatch rows — resolving a movie item to a name requires the
// caller to pass in a uuid->movieName lookup built from the v1 rows (see
// `resolveListItemNames` below). Series items carry `id` (TheTVDB id)
// directly — no name lookup needed, matching.js's tvdbSeriesId path handles
// it directly.

const { parseCsv } = require("./csv");

function safeString(value, maxLen = 500) {
  return String(value ?? "").trim().slice(0, maxLen);
}

function toPositiveIntOrNull(value) {
  const n = Number(String(value ?? "").trim());
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function parseEpochSeconds(value) {
  const seconds = Number(String(value ?? "").trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Parses ONE `map[key:value key2:value2 ...]` segment into a plain object.
// Values are whitespace-separated EXCEPT for nested `[...]` arrays (e.g.
// `fanart:[url1 url2]`), which are kept as a raw bracketed string (unused by
// this parser — list items never have array-valued fields, but the
// segmenter must not choke on lists that DO contain them, e.g. the ignored
// "collection" aggregate row's nested list dumps).
function parseGoMapEntries(segment) {
  const entries = {};
  let i = 0;
  const len = segment.length;
  while (i < len) {
    // Skip whitespace between key:value pairs.
    while (i < len && segment[i] === " ") i += 1;
    if (i >= len) break;
    const colonIdx = segment.indexOf(":", i);
    if (colonIdx === -1) break;
    const key = segment.slice(i, colonIdx).trim();
    let valueEnd;
    if (segment[colonIdx + 1] === "[") {
      // Nested array value: scan to the matching closing bracket.
      let depth = 0;
      let j = colonIdx + 1;
      for (; j < len; j += 1) {
        if (segment[j] === "[") depth += 1;
        else if (segment[j] === "]") {
          depth -= 1;
          if (depth === 0) { j += 1; break; }
        }
      }
      valueEnd = j;
    } else {
      const nextSpace = segment.indexOf(" ", colonIdx + 1);
      valueEnd = nextSpace === -1 ? len : nextSpace;
    }
    const value = segment.slice(colonIdx + 1, valueEnd).trim();
    if (key) entries[key] = value;
    i = valueEnd;
  }
  return entries;
}

// Splits a Go `[map[...] map[...] ...]` array dump into its individual
// `map[...]` segment CONTENTS (without the outer `map[`/`]` wrapper). Each
// element of the OUTER array is always prefixed by the literal "map" before
// its own `[...]` — bracket-depth scanning alone can't tell an outer
// element's `[` apart from a NESTED array value's `[` (e.g.
// `fanart:[url1 url2]` inside a map), so segments are found by locating each
// "map[" marker and then depth-scanning ONLY from there to its matching `]`.
function splitGoMapArray(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  const inner = trimmed.slice(1, -1); // drop outer [ ]
  const segments = [];
  let i = 0;
  const len = inner.length;
  while (i < len) {
    const mapStart = inner.indexOf("map[", i);
    if (mapStart === -1) break;
    const bracketStart = mapStart + 3; // index of the "[" right after "map"
    let depth = 0;
    let j = bracketStart;
    for (; j < len; j += 1) {
      if (inner[j] === "[") depth += 1;
      else if (inner[j] === "]") {
        depth -= 1;
        if (depth === 0) { j += 1; break; }
      }
    }
    // Content between the map's own brackets (exclusive).
    segments.push(inner.slice(bracketStart + 1, j - 1));
    i = j;
  }
  return segments;
}

/**
 * Parses one list row's `objects` column into normalized items:
 *   Array<{ mediaTypeGuess: "movie"|"tv", uuid: string|null, tvdbSeriesId: number|null }>
 * `type: "movie"` -> mediaTypeGuess "movie", only a uuid (needs a separate
 * name lookup — see resolveListItemNames). `type: "series"` -> mediaTypeGuess
 * "tv", carries `id` directly as tvdbSeriesId (near-deterministic match, same
 * path as the v2 series CSV).
 */
function parseListObjects(rawObjects) {
  const mapSegments = splitGoMapArray(rawObjects);
  const items = [];
  for (const segment of mapSegments) {
    const fields = parseGoMapEntries(segment);
    const rawType = safeString(fields.type, 20).toLowerCase();
    if (rawType !== "movie" && rawType !== "series") continue; // unknown item shape, skip defensively
    items.push({
      mediaTypeGuess: rawType === "series" ? "tv" : "movie",
      uuid: safeString(fields.uuid, 60) || null,
      tvdbSeriesId: rawType === "series" ? toPositiveIntOrNull(fields.id) : null,
      createdAt: parseEpochSeconds(fields.created_at),
    });
  }
  return items;
}

/**
 * Parses `lists-prod-lists.csv` into normalized lists. Returns
 * { lists, errors }, where each list is:
 *   {
 *     name: string,
 *     isPublic: boolean,
 *     sKey: string,       // TV Time's internal list key (stable id)
 *     createdAt: Date | null,
 *     items: Array<{ mediaTypeGuess, uuid, tvdbSeriesId }>,
 *   }
 * The redundant "collection" aggregate row is silently skipped (not an
 * error — it's expected structural noise, same treatment as the tracking
 * CSVs' own aggregate rows).
 */
function parseTvTimeListsCsv(rawText) {
  const lists = [];
  const errors = [];
  const table = parseCsv(rawText);

  if (table.length === 0) {
    return { lists, errors: [{ line: 0, name: "", reason: "File CSV liste vuoto." }] };
  }

  const header = table[0].map((h) => safeString(h, 60).toLowerCase());
  const col = (name) => header.indexOf(name);
  const idx = {
    type: col("type"),
    name: col("name"),
    createdAt: col("created_at"),
    objects: col("objects"),
    ordering: col("ordering"),
    description: col("description"),
    sKey: col("s_key"),
    isPublic: col("is_public"),
  };

  if (idx.type === -1 || idx.name === -1) {
    return {
      lists,
      errors: [{ line: 1, name: "", reason: "Header CSV liste inatteso (attese colonne type,name,objects,...)." }],
    };
  }

  for (let i = 1; i < table.length; i += 1) {
    const line = i + 1;
    const record = table[i];
    if (!record || record.length === 0) continue;

    const rowType = safeString(record[idx.type], 40).toLowerCase();
    const sKey = idx.sKey !== -1 ? safeString(record[idx.sKey], 120) : "";
    if (rowType !== "list") {
      // The "collection" aggregate row (rowType empty, sKey == "collection")
      // is expected structural noise — every list it contains is ALSO
      // present as its own `type: "list"` row, so skipping it here avoids
      // double-importing. Anything else with an empty/unknown type in this
      // CSV is unexpected — surface it rather than silently dropping it.
      if (sKey !== "collection") {
        errors.push({ line, name: safeString(record[idx.name], 200), reason: `Tipo riga lista non riconosciuto: "${rowType || sKey}".` });
      }
      continue;
    }

    const name = safeString(record[idx.name], 200);
    if (!name) {
      errors.push({ line, name: "", reason: "Nome lista mancante." });
      continue;
    }

    const isPublic = idx.isPublic !== -1 && safeString(record[idx.isPublic], 10).toLowerCase() === "true";
    const createdAtRaw = idx.createdAt !== -1 ? record[idx.createdAt] : "";
    const createdAtMatch = safeString(createdAtRaw, 32).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
    const createdAt = createdAtMatch
      ? new Date(Date.UTC(
        Number(createdAtMatch[1]), Number(createdAtMatch[2]) - 1, Number(createdAtMatch[3]),
        Number(createdAtMatch[4]), Number(createdAtMatch[5]), Number(createdAtMatch[6])
      ))
      : null;

    const items = idx.objects !== -1 ? parseListObjects(record[idx.objects]) : [];
    const description = idx.description !== -1 ? safeString(record[idx.description], 2000) : "";
    const ordering = idx.ordering !== -1 ? safeString(record[idx.ordering], 2000) : "";

    lists.push({
      name,
      description: description || null,
      isPublic,
      sKey,
      createdAt,
      ordering: ordering || null,
      items,
    });
  }

  return { lists, errors };
}

/**
 * Builds a uuid -> movieName lookup from the v1 movies NormalizedRow[]
 * (tvTimeGdpr.js's parseTvTimeMoviesCsv output does NOT keep the uuid — this
 * works directly off the RAW v1 CSV rows instead, since the uuid is only
 * needed for this list-resolution step, not the main viewing-history
 * import). Callers pass the same raw `moviesCsv` text already sent to
 * parseTvTimeMoviesCsv.
 */
function buildMovieUuidNameLookup(moviesRawCsv) {
  const lookup = new Map();
  const table = parseCsv(moviesRawCsv || "");
  if (table.length === 0) return lookup;
  const header = table[0].map((h) => safeString(h, 60).toLowerCase());
  const uuidIdx = header.indexOf("uuid");
  const nameIdx = header.indexOf("movie_name");
  if (uuidIdx === -1 || nameIdx === -1) return lookup;
  for (let i = 1; i < table.length; i += 1) {
    const record = table[i];
    if (!record || record.length === 0) continue;
    const uuid = safeString(record[uuidIdx], 60);
    const name = safeString(record[nameIdx], 500);
    if (uuid && name && !lookup.has(uuid)) lookup.set(uuid, name);
  }
  return lookup;
}

/**
 * Resolves each list item to a name/type guess suitable for feeding into
 * the same matching cascade the main import uses (resolveRowMatch's
 * movie/tv paths): movie items resolve via the uuid->name lookup (from the
 * v1 CSV); series items already carry a tvdbSeriesId and need no name at
 * all (matchViaTvdbId path). Items that can't be resolved (movie uuid not
 * found in the v1 lookup) are returned with `nameGuess: null` — the caller
 * decides whether to drop them or surface them for manual resolution.
 */
function resolveListItemNames(lists, movieUuidLookup) {
  return lists.map((list) => ({
    ...list,
    items: list.items.map((item) => {
      if (item.mediaTypeGuess === "tv") {
        return { ...item, nameGuess: null }; // resolved via tvdbSeriesId directly, no name needed
      }
      const nameGuess = item.uuid ? movieUuidLookup.get(item.uuid) || null : null;
      return { ...item, nameGuess };
    }),
  }));
}

module.exports = {
  parseTvTimeListsCsv,
  parseListObjects,
  splitGoMapArray,
  parseGoMapEntries,
  buildMovieUuidNameLookup,
  resolveListItemNames,
};
