// Deterministic, human-readable slug helper for user lists.
//
// A slug is computed once from the list `title` and stored on the
// `userLists/{id}` document as the `slug` field. It powers the public URLs
//   /lista/{slug}
// served by the `listPage` Cloud Function.
//
// For editorial lists: the `editorialSlug` field is reused as the slug value.
// For user lists: slugify(title) + "-" + last 6 chars of listId (uniqueness).
//
// This module is intentionally dependency-free CommonJS so it can be reused by:
//  * the one-shot backfill script  (functions/scripts/backfill-list-slugs.js)
//  * the onCreate Firestore trigger (functions/index.js)
//  * the SSR list page             (functions/modules/listPage.js)

// Slugify a plain-text title.
//
// Rules (deterministic):
//  1. lowercase
//  2. strip accents/diacritics — NFD normalize, then drop combining marks
//  3. replace any run of non-alphanumeric characters with a single "-"
//  4. trim leading/trailing "-"
//
// Returns "" only when the title produces no alphanumeric characters.
function slugifyTitle(title) {
  return String(title == null ? "" : title)
    .normalize("NFD")
    // Drop Unicode combining marks left behind by NFD (the accents).
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    // Any run of non [a-z0-9] characters collapses to a single hyphen.
    .replace(/[^a-z0-9]+/g, "-")
    // Trim hyphens off both ends.
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

// Computes the slug for a user list document.
//
// For editorial lists (`editorialSlug` field present and non-empty):
//   -> returns editorialSlug unchanged (it is already canonical)
//
// For user lists (no editorialSlug):
//   -> slugifyTitle(title) + "-" + last6(listId)
//   The 6-char suffix guarantees uniqueness without a collision scan at
//   create-time. The suffix is kept short to remain human-friendly.
//
// Falls back to the listId itself if no slug can be produced.
function computeListSlug(listId, listData) {
  // Editorial lists: reuse the editorial slug verbatim.
  const editorial = String(listData && listData.editorialSlug != null ? listData.editorialSlug : "").trim();
  if (editorial) return editorial;

  // User lists: title slug + uniqueness suffix.
  const base = slugifyTitle(listData && listData.title ? listData.title : "");
  const suffix = String(listId || "").slice(-6);

  if (base && suffix) return `${base}-${suffix}`;
  if (base) return base;
  // Fall back to the last 12 chars of the listId to keep URLs short.
  return String(listId || "").slice(-12) || listId;
}

module.exports = { slugifyTitle, computeListSlug };
