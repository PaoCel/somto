"use strict";

// Curated "anthology split" table for viewing-history imports.
//
// Some services — notably TV Time / TheTVDB — track a Netflix-style anthology
// as ONE series with multiple seasons, while TMDB (and therefore Somto) model
// each installment as its OWN standalone series. Example: TheTVDB series
// 389492 "Monster (2022)" (Ryan Murphy's Netflix anthology) is, on TMDB:
//   season 1 -> "Dahmer - Monster: la storia di Jeffrey Dahmer" (TMDB 113988)
//   season 2 -> "Mostri: la storia di Lyle ed Erik Menéndez"    (TMDB 225634)
//   season 3 -> "Monster: la storia di Ed Gein"                 (TMDB 286801)
// The normal name/tvdb matching cascade CANNOT resolve "Monster (2022)" to any
// single title (it isn't one), so every such row lands unresolved and the
// user's watch history for these titles is silently lost. This table maps each
// (anthology series, season) -> a concrete Somto titleId + the season number to
// use on THAT title (each installment is a 1-season series -> season 1).
//
// KEYED ON tvdbSeriesId, NOT name — deliberately. "The Monster of Florence"
// (TheTVDB 440698) also contains "monster" but is a completely unrelated show;
// a name-based rule would corrupt it. A normalized-name fallback is allowed
// ONLY as an exact, year-qualified string ("monster 2022"), for sources that
// carry no tvdb id (e.g. Refract) — it still cannot collide with
// "the monster of florence" or the 2004 anime "monster".
//
// This transform runs in the PARSER path (parseTitlesImportPayload /
// parseImportRows), NOT the matcher — the resumable import re-parses rows at
// finalize and pairs the persisted item (titleId) with the FRESH row
// (season/episode), so the season remap must live where every re-parse sees
// it. The matcher (resolveRowMatch) honors the `forcedTitleId` this sets.

function normalizeAnthologyName(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// One entry per anthology. `seasons[N] = { titleId, targetSeason }` maps the
// anthology's season N to a Somto title + the season to record on it.
const ANTHOLOGY_SPLITS = [
  {
    label: "Monster (Ryan Murphy Netflix anthology)",
    tvdbSeriesIds: [389492],
    // Exact normalized-name fallback for tvdb-less sources. Must stay EXACT
    // (not substring) — see module docstring.
    nameKeys: ["monster 2022"],
    seasons: {
      1: { titleId: "tmdb_tv_113988", targetSeason: 1 },                          // Dahmer
      2: { titleId: "la-storia-di-lyle-ed-erik-menendez-2024", targetSeason: 1 }, // Menéndez
      3: { titleId: "N0e8PVbOfvKpSEP8Xe4D", targetSeason: 1 },                    // Ed Gein
    },
  },
];

function findAnthology(row) {
  const tvdbId = Number(row?.tvdbSeriesId);
  const name = normalizeAnthologyName(row?.seriesNameGuess);
  for (const entry of ANTHOLOGY_SPLITS) {
    if (Number.isFinite(tvdbId) && entry.tvdbSeriesIds.includes(tvdbId)) return entry;
    if (name && entry.nameKeys.includes(name)) return entry;
  }
  return null;
}

// Returns { titleId, targetSeason, label } for an anthology tv_episode row
// whose season is mapped, else null. Pure, no IO.
function resolveAnthologySplit(row) {
  if (!row || row.kind !== "tv_episode") return null;
  const entry = findAnthology(row);
  if (!entry) return null;
  const season = Number(row.seasonNumber);
  if (!Number.isInteger(season) || season <= 0) return null; // specials/unknown -> normal path
  const target = entry.seasons[season];
  if (!target) return null; // season with no mapping -> normal path
  return { titleId: target.titleId, targetSeason: target.targetSeason, label: entry.label };
}

// Mutates `row` in place when it's an anthology installment: pins the resolved
// titleId (honored by resolveRowMatch) and remaps the season to the target
// title's own numbering, preserving the episode number. Guarded against
// double-application (once `forcedTitleId` is set, re-applying is a no-op) —
// important because remapping S2->S1 would otherwise re-match S1 to a
// DIFFERENT installment on a second pass. Returns true if applied.
function applyAnthologySplit(row) {
  if (!row || row.forcedTitleId) return false;
  const split = resolveAnthologySplit(row);
  if (!split) return false;
  row.anthologySourceSeason = Number(row.seasonNumber); // audit trail
  row.forcedTitleId = split.titleId;
  row.forcedTitleStrategy = "anthology_split";
  row.seasonNumber = split.targetSeason;
  return true;
}

function applyAnthologySplitsToRows(rows) {
  if (Array.isArray(rows)) {
    for (const row of rows) applyAnthologySplit(row);
  }
  return rows;
}

module.exports = {
  ANTHOLOGY_SPLITS,
  normalizeAnthologyName,
  resolveAnthologySplit,
  applyAnthologySplit,
  applyAnthologySplitsToRows,
};
