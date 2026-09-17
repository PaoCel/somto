// confirmPlan.js — pure planning logic for the import confirmation step
// (`confirmTitlesImport` in functions/index.js). NO Firestore / network here:
// the onCall does the I/O (reads item docs, resolves suggestions via TMDB,
// writes titleStates), this module decides WHAT each resolution means and how
// the final counts / status come out. Extracted so the whole decision surface
// is unit-testable without the emulator (same pattern as
// tasteProfileAggregate.js / writeTitleStates.js).
//
// Contract recap (server-authoritative, safe matches are ALREADY imported at
// match time — this step only disposes of the leftover unresolved rows):
//   - resolution { itemId, titleId }          -> import that title
//   - resolution { itemId, acceptSuggestion }  -> import the matcher's best
//        guess, but ONLY if the row already scored in the verified suggestion
//        band (confidence >= SUGGESTION_ACCEPT_MIN_CONFIDENCE and a suggestion
//        with a tmdbId exists). No new threshold is invented.
//   - resolution { itemId, skip:true }         -> explicitly ignore
//   - flag skipRemaining:true                  -> ignore every still-unresolved
//        row after the explicit resolutions (the "Importa i titoli trovati" /
//        "Salta tutti" quick path — zero mandatory per-row decisions).

const { MIN_STUB_SCORE } = require("./matching");

// The matcher only attaches a `suggestion` when the top TMDB hit scored in
// [MIN_STUB_SCORE, HIGH_CONFIDENCE_SCORE): below MIN_STUB_SCORE it returns
// no hint at all, at/above HIGH_CONFIDENCE_SCORE it auto-imports. So a row
// that HAS a suggestion has, by construction, already cleared this bar — we
// reuse it verbatim rather than inventing a "bulk accept" threshold.
const SUGGESTION_ACCEPT_MIN_CONFIDENCE = MIN_STUB_SCORE;

function toIdLike(value) {
  if (value == null) return "";
  const s = String(value).trim();
  return s;
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function suggestionMediaType(item) {
  const raw = String(item?.suggestion?.mediaType || item?.resolvedAsType || item?.refKind || item?.kind || "").toLowerCase();
  return raw === "tv" || raw === "series" ? "tv" : "movie";
}

/**
 * Classify a single confirmation resolution against its persisted item doc.
 * Pure. `item` may be null (doc missing) — that yields an `ignore`.
 * Returns one of:
 *   { action: "import_title",      itemId, titleId }
 *   { action: "accept_suggestion", itemId, tmdbId, mediaType }
 *   { action: "skip",              itemId }
 *   { action: "ignore",            itemId, reason }   // no state change
 */
function classifyResolution(resolution, item, { minConfidence = SUGGESTION_ACCEPT_MIN_CONFIDENCE } = {}) {
  const itemId = toIdLike(resolution?.itemId);
  if (!itemId) return { action: "ignore", itemId: "", reason: "missing_item_id" };
  if (!item) return { action: "ignore", itemId, reason: "item_not_found" };

  if (resolution?.skip === true) {
    return { action: "skip", itemId };
  }

  if (resolution?.acceptSuggestion === true) {
    const tmdbId = positiveInt(item?.suggestion?.tmdbId);
    const confidence = Number(item?.confidence || 0);
    if (tmdbId > 0 && confidence >= minConfidence) {
      return { action: "accept_suggestion", itemId, tmdbId, mediaType: suggestionMediaType(item) };
    }
    // Asked to accept a suggestion that doesn't clear the verified bar (or is
    // absent): never silently import a low-confidence guess. Leave it untouched
    // — skipRemaining, if set, will dispose of it explicitly.
    return { action: "ignore", itemId, reason: "suggestion_below_threshold" };
  }

  const titleId = toIdLike(resolution?.titleId);
  if (titleId) return { action: "import_title", itemId, titleId };

  return { action: "ignore", itemId, reason: "empty_resolution" };
}

/**
 * Plan a batch of explicit resolutions. Pure — `itemsById` is a plain object
 * or Map of persisted item docs keyed by itemId. Returns the classified
 * actions plus a per-action tally and the set of itemIds the caller has now
 * explicitly handled (so skipRemaining can sweep only what's left).
 */
function planResolutions(resolutions, itemsById, opts = {}) {
  const get = (id) => (itemsById instanceof Map ? itemsById.get(id) : itemsById?.[id]) || null;
  const actions = [];
  const handledItemIds = new Set();
  const tally = { importTitle: 0, acceptSuggestion: 0, skip: 0, ignore: 0 };

  for (const resolution of Array.isArray(resolutions) ? resolutions : []) {
    const itemId = toIdLike(resolution?.itemId);
    const action = classifyResolution(resolution, itemId ? get(itemId) : null, opts);
    actions.push(action);
    switch (action.action) {
      case "import_title": tally.importTitle += 1; break;
      case "accept_suggestion": tally.acceptSuggestion += 1; break;
      case "skip": tally.skip += 1; break;
      default: tally.ignore += 1; break;
    }
    // An `ignore` did NOT change the row, so it is NOT "handled" — skipRemaining
    // must still be free to sweep it (e.g. a suggestion below threshold the
    // user then finishes past).
    if (itemId && action.action !== "ignore") handledItemIds.add(itemId);
  }

  return { actions, handledItemIds, tally };
}

/**
 * Given the ids the explicit resolutions already handled and the full set of
 * still-unresolved item ids, return the ids skipRemaining must mark as skipped.
 * Pure. When skipRemaining is false, nothing extra is skipped.
 */
function planSkipRemaining({ skipRemaining, handledItemIds, unresolvedItemIds }) {
  if (!skipRemaining) return [];
  const handled = handledItemIds instanceof Set ? handledItemIds : new Set(handledItemIds || []);
  return (Array.isArray(unresolvedItemIds) ? unresolvedItemIds : [])
    .map(toIdLike)
    .filter((id) => id && !handled.has(id));
}

/**
 * Final status from the remaining unresolved count. `completed` the instant
 * nothing is left to decide (the quick path always lands here); otherwise it
 * stays `awaiting_confirmation` so a partial manual pass can be resumed.
 */
function computeConfirmationStatus(remainingUnresolvedCount) {
  return positiveInt(remainingUnresolvedCount) > 0 ? "awaiting_confirmation" : "completed";
}

module.exports = {
  SUGGESTION_ACCEPT_MIN_CONFIDENCE,
  classifyResolution,
  planResolutions,
  planSkipRemaining,
  computeConfirmationStatus,
  suggestionMediaType,
};
