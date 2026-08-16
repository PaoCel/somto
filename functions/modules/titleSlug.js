// Deterministic, human-readable slug helper for catalogue titles.
//
// A slug is computed once from the title `name` + `year` and stored on the
// `titles/{id}` document as the `slug` field. It powers the public URLs
//   /film/{slug}  and  /serie/{slug}
// served by the `titlePage` Cloud Function.
//
// This module is intentionally dependency-free CommonJS so it can be reused by:
//  * the one-shot backfill script  (functions/scripts/backfill-title-slugs.js)
//  * the onCreate Firestore trigger (functions/index.js)
//  * the SSR title page            (functions/modules/titlePage.js)

// Builds the *base* slug from a name and an optional year.
//
// Rules (deterministic):
//  1. lowercase
//  2. strip accents/diacritics — NFD normalize, then drop combining marks
//  3. replace any run of non-alphanumeric characters with a single "-"
//  4. trim leading/trailing "-"
//  5. append "-{year}" when `year` is a positive integer
//
// Returns "" only when the name produces no alphanumeric characters AND there
// is no positive year — callers must fall back to the document id in that case.
function slugify(name, year) {
  const base = String(name == null ? "" : name)
    .normalize("NFD")
    // Drop Unicode combining marks left behind by NFD (the accents).
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    // Any run of non [a-z0-9] characters collapses to a single hyphen.
    .replace(/[^a-z0-9]+/g, "-")
    // Trim hyphens off both ends.
    .replace(/^-+/, "")
    .replace(/-+$/, "");

  const numericYear = Number(year);
  const hasYear = Number.isFinite(numericYear) && numericYear > 0;
  const yearSuffix = hasYear ? String(Math.trunc(numericYear)) : "";

  if (base && yearSuffix) return `${base}-${yearSuffix}`;
  if (base) return base;
  if (yearSuffix) return yearSuffix;
  return "";
}

// Resolves a collision-free slug given a base slug and a set of slugs that are
// already taken. The first caller for a given base keeps it untouched; the
// next ones get "-2", "-3", … appended deterministically.
//
// `takenSlugs` must be a Set of strings. This function does NOT mutate it —
// the caller decides when to record the returned slug as taken.
function resolveUniqueSlug(baseSlug, takenSlugs) {
  const taken = takenSlugs instanceof Set ? takenSlugs : new Set();
  const base = String(baseSlug == null ? "" : baseSlug);
  if (!base) return base;
  if (!taken.has(base)) return base;
  let suffix = 2;
  let candidate = `${base}-${suffix}`;
  while (taken.has(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

module.exports = { slugify, resolveUniqueSlug };
