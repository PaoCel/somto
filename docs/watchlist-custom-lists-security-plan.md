# Watchlist custom lists: security and implementation plan

Date: 2026-07-01

## Summary

The repository already has a `userLists` model for custom lists with
`private`, `shared`, and `public` visibility. The PWA watchlist also already
has an editor sheet for custom lists.

The multi-agent review found that a product/UI-only first phase is not safe if
it increases usage of public/shared lists before hardening the data contract and
rules. The first code phase should therefore be a security/data-contract phase,
not a visual expansion of public/private list flows.

## Current architecture

- PWA watchlist page: `public/watchlist.html`
- PWA watchlist controller: `public/js/pages/watchlist.page.js`
- PWA list editor: `public/js/pages/lists-editor.page.js`
- Custom lists API: `public/js/api/userLists.api.js`
- Watchlist dashboard aggregation: `public/js/api/watchlistDashboard.api.js`
- Firestore rules: `firestore.rules`
- Firestore indexes: `firestore.indexes.json`
- Public list SSR/sitemap: `functions/modules/listPage.js`, `functions/index.js`
- iOS parity surfaces: `ios/TwoWatch/Features/Watchlist/`, `ios/TwoWatch/Data/Repositories/WatchlistRepository.swift`

## Consolidated agent verdicts

- Product Manager: PASS WITH CONCERNS
- UX Reviewer: PASS WITH CONCERNS
- UI Reviewer: PASS WITH CONCERNS
- Software Architect: PASS WITH CONCERNS
- Database Architect: PASS WITH CONCERNS
- Security & Privacy Reviewer: BLOCKED
- QA Tester: BLOCKED
- Code Quality Reviewer: BLOCKED

Consolidated decision: do not expand or promote public/shared/private custom-list
flows until the blockers below are addressed and covered by rules/function tests.

## Blockers

### 1. Visibility can be changed by non-owner editors

Current concern:
- `lists-editor.page.js` sends `visibility` during edit.
- `firestore.rules` allows updates via edit permissions that include editors.
- A non-owner editor can potentially turn a private/shared list into a public
  list.

Required behavior:
- Only owner/admin can change `visibility`.
- Editors can update content fields only, not privacy boundaries.

### 2. Membership can be written without user acceptance

Current concern:
- The API can add collaborators by writing `memberUids` / `editorUids`.
- Rules permit allowed editors/owners to mutate membership without a verified
  invite acceptance flow.
- Cloud Functions may compute list progress for member UIDs using Admin SDK,
  so arbitrary membership can leak private progress summaries.

Required behavior:
- Users must not become list members without acceptance.
- Progress recompute must use accepted members only.
- Shared-list membership changes should be server-authoritative or rules-backed
  by a strict invitation state machine.

### 3. Client-owned or forgeable public fields

Current concern:
- `userLists` validation does not appear to use a strict field allowlist.
- Fields such as `slug`, `editorialSlug`, `editorial`, `itemCount`,
  `itemTitleIds`, and cover fields can drift or be forged.
- `followersCount` is already treated as server-owned; similar treatment is
  needed for other derived/public metadata.

Required behavior:
- Add `keys().hasOnly(...)` style validation for `userLists`.
- Make public SEO/editorial fields server-owned.
- Decide whether summary fields are server-owned triggers/callables or
  client-owned under exact rules.

### 4. List summary can drift from list items

Current concern:
- Creating a list with selected titles writes `items`, but the root doc can
  still start with `itemCount: 0`.
- `addTitleToList` / `removeTitleFromList` update `itemCount`, but not all
  title-id summary fields used by discovery.

Required behavior:
- `items/{titleId}` remains the canonical membership per list.
- `itemCount`, `itemTitleIds`, preview title IDs, and `updatedAt` are updated
  consistently.
- Prefer server-side maintenance for derived fields before treating lists as
  public discovery surfaces.

## Proposed data contract

### `userLists/{listId}` root

Client-created fields:
- `ownerUid`
- `title`
- `description`
- `visibility`
- `kind`
- `memberUids` at create: `[uid]` only
- `editorUids` at create: `[]`
- `cover` with approved fields only
- `owner` summary with safe public owner data
- `createdAt`
- `updatedAt`

Server-owned or tightly controlled fields:
- `slug`
- `editorialSlug`
- `editorial`
- `followersCount`
- `itemCount`
- `completedCount`
- `itemTitleIds`
- preview/cover fallback fields if used for public discovery

Recommended normalization:
- Standardize cover image naming to `cover.imageUrl`.
- Keep backward-compatible reads for existing `cover.imageURL` while migrating.

### `userLists/{listId}/items/{titleId}`

Canonical list contents:
- `titleId`
- `orderIndex`
- `addedByUid`
- `note`
- `addedAt`
- `updatedAt`

Do not duplicate user progress or watch state here. Keep that in
`users/{uid}/titleStates` and list progress entries.

### Membership/invites

Recommended model:
- `userLists/{listId}/invites/{inviteId}` or a callable-backed equivalent.
- States: `pending`, `accepted`, `declined`, `revoked`.
- Only accepted members are included in `memberUids` and progress recompute.
- Editors are a role on accepted members, not a raw UID array that can be
  written directly by arbitrary editors.

## Consolidated phases

### Phase 0: rules tests that should fail today

Add red tests for:
- editor cannot change `visibility`
- editor cannot add arbitrary members
- pending invite cannot read private/shared list
- client cannot forge `slug`, `editorial`, `followersCount`, `itemCount`,
  `itemTitleIds`, or unsupported extra fields
- private/shared SSR and sitemap remain inaccessible unless public

### Phase 1: security/data contract hardening

Likely files:
- `firestore.rules`
- `scripts/test-rules/**`
- `functions/index.js`
- `functions/modules/listSlug.js`
- `functions/modules/listPage.js`
- `public/js/api/userLists.api.js`

Implement:
- owner-only visibility transitions
- strict `userLists` field allowlist
- server-owned SEO/editorial/derived fields
- accepted-member-only progress recompute
- summary field maintenance plan via trigger/callable

Do not implement:
- new public-list UX promotion
- new shared-list collaborator UX
- migration of the base watchlist into `userLists`

### Phase 2: PWA UX/UI cleanup using safe existing behavior

Likely files:
- `public/watchlist.html`
- `public/js/pages/watchlist.page.js`
- `public/js/pages/lists-editor.page.js`
- `public/js/api/watchlistDashboard.api.js`
- `public/css/pages/watchlist.css`
- `public/service-worker.js`

Implement:
- rename/clarify Watchlist areas
- remove or implement dead `pending` filter
- fix `__general__` so it routes to `Da vedere`, not `/lista.html?id=__general__`
- make owned list cards open detail; expose edit as secondary action
- add visibility badges and clear copy
- add dashboard error/retry state
- remove unused rating sheet markup if still unused
- bump service worker version for PWA asset changes

Do not implement:
- shared invite flow without Phase 1
- public/private privacy changes only in frontend

### Phase 3: full custom-list UX

Implement after Phase 1/2:
- quick create with safe default `private`
- public-list confirmation
- accepted collaborator flow
- add/remove/reorder titles from list detail
- better empty/loading/error states
- mobile and accessibility polish
- iOS parity review

## First implementation decision

Overall risk: high until rules and membership are hardened.

First code phase to implement after review:
- Phase 1 security/data-contract hardening with tests.

Not implemented in this pass:
- No product code changes.
- No schema/rules changes.
- No migration.
- No new public/private/shared list UX.
- No frontend-only privacy workaround.

## Required verification

Run, as applicable:
- `npm --prefix scripts/test-rules test`
- `npm run build:pwa`
- `npm run e2e`
- targeted Firebase emulator tests for `userLists`, `savedLists`, and
  `listProgressEntries`
- manual QA on mobile width for the PWA watchlist after UI changes

## Open review questions

- Should shared lists require explicit user acceptance before read access, edit
  access, and progress computation?
- Should derived list summary fields be maintained by Firestore triggers or by
  callable writes only?
- Should public-list discovery sort by `followersCount` or `updatedAt` across
  web and iOS?
- Should the base watchlist remain virtual forever, or eventually become a
  private `userList` after a dual-write migration?
