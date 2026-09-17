"use strict";

// Pure helpers for the resumable import matcher (index.js: runImportMatchTick /
// reconstructMatchResultsFromItems / processImportMatchTick). Kept free of any
// Firestore/Storage IO so the tricky resume logic is unit-testable — index.js
// does the reads/writes and delegates the shape/decisions here.

/**
 * Bounds of the row window a single tick processes: [start, end). `start` is
 * the persisted cursor (clamped into range); `end` is at most windowMax rows
 * later, never past `total`. A tick may still stop before `end` on the time
 * budget — this only caps the maximum.
 */
function computeMatchWindow(cursor, total, windowMax) {
  const safeTotal = Math.max(0, Number(total) || 0);
  const start = Math.max(0, Math.min(Number(cursor) || 0, safeTotal));
  const end = Math.min(start + Math.max(1, Number(windowMax) || 1), safeTotal);
  return { start, end };
}

/**
 * Rebuilds the { row, match }[] the finalize tail consumes, sourcing each
 * row's resolution from the persisted `items` docs (written incrementally by
 * the tick worker) + the batch-fetched title docs. A row is "resolved" only if
 * its item exists, is resolved, was not user-skipped, AND its title doc is
 * still present (a vanished title downgrades to unresolved rather than crashing
 * the tail). Pure: `itemById` (Map itemId->item), `titleById` (Map
 * titleId->titleDoc), `itemIdFor(row)->string`.
 */
function buildMatchResultsFromItems({ rows, itemById, titleById, itemIdFor }) {
  return rows.map((row) => {
    const itemId = itemIdFor(row);
    const item = itemById.get(itemId);
    const resolved = Boolean(
      item && item.resolved && item.titleId && item.skip !== true && titleById.has(item.titleId)
    );
    if (!resolved) {
      return {
        row,
        match: { resolved: false, titleId: null, title: null, confidence: 0, strategy: null, resolvedAsType: null, suggestion: null },
      };
    }
    return {
      row,
      match: {
        resolved: true,
        titleId: item.titleId,
        title: titleById.get(item.titleId),
        resolvedAsType: item.resolvedAsType || null,
        confidence: Number(item.confidence || 0),
        strategy: item.strategy || null,
        suggestion: null,
      },
    };
  });
}

/**
 * Deterministic, resumable ordering of the DISTINCT resolved titleIds an import
 * produced, for the metadata-enrichment phase (index.js: enrichImportTitlesTick).
 * Sourced from the persisted `items` docs — the same durable state
 * buildMatchResultsFromItems reads — so it survives crashes without persisting a
 * separate list, and every enrichment tick recomputes the SAME order from the
 * same items (idempotent). A title is included once, on first resolved+kept
 * occurrence; order is the first-seen order among the sorted item ids (item ids
 * are deterministic per row via buildImportItemId), so it's stable across ticks.
 *
 * @param {Map<string, object>} itemById - itemId -> persisted item doc.
 * @returns {string[]} distinct titleIds, stable order.
 */
function distinctResolvedTitleIds(itemById) {
  const seen = new Set();
  const ordered = [];
  const ids = Array.from(itemById.keys()).sort();
  for (const id of ids) {
    const item = itemById.get(id) || {};
    if (!item.resolved || !item.titleId || item.skip === true) continue;
    if (seen.has(item.titleId)) continue;
    seen.add(item.titleId);
    ordered.push(item.titleId);
  }
  return ordered;
}

/**
 * Bounds of the enrichment window [start, end) for a tick — identical shape to
 * computeMatchWindow but over the distinct-titleId list length. A tick may stop
 * before `end` on its time budget; this only caps the max per tick.
 */
function computeEnrichWindow(cursor, total, windowMax) {
  return computeMatchWindow(cursor, total, windowMax);
}

module.exports = {
  computeMatchWindow,
  computeEnrichWindow,
  buildMatchResultsFromItems,
  distinctResolvedTitleIds,
};
