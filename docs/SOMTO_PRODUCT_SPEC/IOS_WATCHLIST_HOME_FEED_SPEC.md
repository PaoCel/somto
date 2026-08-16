# SOMTO iOS Watchlist + Home Feed Spec

## 0. Scope

This document defines the target UX, UI, interaction model, post rules, and minimum data/view-model evolution for two iOS areas:

1. Watchlist
2. Home Feed / post system

The goal is product clarity first. This spec is intentionally strict to avoid arbitrary interpretation during design or implementation.

## 1. Product Principles

- SOMTO is not a streaming app.
- The core is social discovery, taste, organization, and conversation around film and TV.
- Watchlist is a decision tool, not a social feed.
- Home Feed is a curated social surface, not a raw activity log.
- iOS-first design: clean hierarchy, native motion, generous spacing, premium legibility.
- No noisy dashboards, no carousels overload, no "everything on screen".
- Private or purely technical actions must not become public feed posts.

## 2. Current App Alignment

These existing models should be reused instead of replaced:

- `TitlePersonalState`
- `TitleSeriesProgress`
- `TitleReminderHints`
- `UserListSummary`
- `UserListItem`
- `UserListDetail`
- `PublicListItemProgress`
- `WatchlistDashboard`
- `UserListEditorDraft`
- `FeedActivity`
- `FeedActivityKind`
- `AppPost`
- `PostVisibility`

Current files to stay aligned with:

- [WatchlistModels.swift](../../ios/TwoWatch/Domain/Models/WatchlistModels.swift)
- [WatchlistRepository.swift](../../ios/TwoWatch/Data/Repositories/WatchlistRepository.swift)
- [WatchlistView.swift](../../ios/TwoWatch/Features/Watchlist/WatchlistView.swift)
- [UserContentModels.swift](../../ios/TwoWatch/Domain/Models/UserContentModels.swift)
- [HomeRepository.swift](../../ios/TwoWatch/Data/Repositories/HomeRepository.swift)
- [PostsRepository.swift](../../ios/TwoWatch/Data/Repositories/PostsRepository.swift)
- [HomeView.swift](../../ios/TwoWatch/Features/Home/HomeView.swift)
- [functions/index.js](../../functions/index.js)

## 3. Watchlist UX/UI Spec

### 3.1 Page Objective

The Watchlist page must help the user answer three questions quickly:

- What should I watch next?
- What do I want to rewatch?
- Which curated or public lists am I following?

It must not become a secondary Home Feed and must not mix unseen, seen, rewatch, and lists inside one noisy surface.

### 3.2 Top-Level Information Architecture

Replace the current top segmentation with exactly 3 macro sections:

- `Da vedere`
- `Rewatch`
- `Liste`

`Da votare` remains a secondary state, not a top-level tab. It should survive as:

- a reminder banner after completion
- a lightweight badge inside title detail / profile / library
- a secondary filter or smart prompt, not a top-level Watchlist section

### 3.3 Page Shell

- Navigation style: iOS large title screen, not a dashboard hero.
- Large title: `Watchlist`
- Subtitle under title, smaller and lighter:
  - `Tutto quello che vuoi vedere, rivedere e completare`
- Top-right actions:
  - search
  - create list
  - filter/sort
- Background:
  - clean light surface
  - subtle branded depth only in section cards, never a loud background wash
- Main layout:
  - vertical scrolling
  - section spacing 20-24 pt
  - content horizontal padding 20 pt
  - cards on white or near-white surfaces
  - section cards radius 24 pt

### 3.4 Shared Watchlist Behavior

- Search button opens an in-page search state scoped to the selected tab.
- Filter/sort opens a bottom sheet with tab-specific controls.
- The segmented control is always pinned immediately below the page header once the user scrolls.
- Default layout is vertical list. No grid as primary mode.
- Swipe actions never full-swipe destructive by default.
- Poster is always visually legible and large enough to aid recognition before text parsing.

### 3.5 Segmented Control

- Style: horizontal segmented pill, iOS-native feel, full-width.
- Labels:
  - `Da vedere`
  - `Rewatch`
  - `Liste`
- Selected state:
  - filled, high contrast, compact
- Unselected state:
  - quiet, low emphasis
- Height: 40-44 pt
- Horizontal padding inside segment: 14-16 pt

## 4. Watchlist - Tab `Da vedere`

### 4.1 Product Rule

This tab contains only titles not yet completed by the user.

- If the title is not seen and user taps `Aggiungi alla watchlist`, it enters `Da vedere`.
- If the title is already seen, it must not enter `Da vedere`.
- Completed titles are never shown in this tab.

### 4.2 Screen Structure

Order from top to bottom:

1. Optional smart section `Cosa guardare stasera`
2. Main vertical watchlist list
3. Inline empty or filtered-empty state if needed

### 4.3 `Cosa guardare stasera`

This is optional and only appears if there are at least 3 high-confidence suggestions.

- Maximum items shown: 5
- Presentation: horizontal cards
- Card width: 168-184 pt
- Card content:
  - poster
  - title
  - one short reason line
  - one compact metadata line if helpful
- Allowed reasons:
  - `Consigliato per te`
  - `Visto da 4 amici`
  - `Disponibile sulle tue piattaforme`
  - `Match alto con i tuoi gusti`
- This block is editorial and decision-oriented, not a carousel dump.
- If confidence is low, hide the section entirely.

### 4.4 Main List Row Structure

Each row must contain:

- Poster on the left
- Primary text stack in the center
- Trailing affordance / menu on the right

Exact content order:

1. Title
2. Secondary metadata line:
   - year
   - `Film` or `Serie` badge
3. Secondary detail line:
   - duration for film
   - seasons / episodes for series
4. Social context line, only if relevant:
   - `Visto da 3 amici`
   - `Consigliato da Luca`
   - `Giulia gli ha dato 4,5`
5. Contextual badges row, only if present:
   - `Nuova uscita`
   - `Match per te`
   - `Tendenza tra amici`
6. Platforms row, only if availability exists

### 4.5 Row Dimensions and Visual Hierarchy

- Poster size:
  - compact row: 72 x 108 pt
  - regular row: 76 x 114 pt
- Poster radius: 16-18 pt
- Title font: `headline` / semibold
- Metadata font: `subheadline`
- Social line font: `caption`
- Badge font: `caption2` semibold
- Trailing action uses an iOS menu button, not multiple floating icons

### 4.6 Row Actions

Primary quick actions available via trailing menu and swipe:

- `Segna come visto`
- `Rimuovi`
- `Aggiungi a lista`
- `Prioritizza`

Recommended swipe design:

- Leading swipe:
  - `Segna visto`
- Trailing swipe:
  - `Aggiungi a lista`
  - `Prioritizza`
  - `Rimuovi`

`Prioritizza` means move toward the top of the default ranking and mark as intentionally selected.

### 4.7 Sort Options

Bottom sheet order:

1. `Piu rilevanti per te` (default)
2. `Piu recenti aggiunti`
3. `Titolo A-Z`
4. `Anno`
5. `Disponibili sulle tue piattaforme`
6. `Piu popolari tra i tuoi amici`

### 4.8 Filters

Tab-specific filters for `Da vedere`:

- `Tutti`
- `Film`
- `Serie`
- `Genere`
- `Piattaforma`
- `Solo consigliati da amici`
- `Solo visti dai tuoi amici`
- `Solo match alti`
- `Solo non iniziati`

Filtered state must show active filter chips above the list and support one-tap clear.

### 4.9 Empty State

Tone: elegant, calm, non-playful.

- Title:
  - `La tua watchlist e vuota`
- Body:
  - `Salva qui i film e le serie che vuoi guardare in futuro.`
- CTA 1:
  - `Esplora titoli`
- CTA 2:
  - `Scopri liste pubbliche`

### 4.10 Filtered Empty State

- Title:
  - `Nessun titolo con questi filtri`
- Body:
  - `Prova a cambiare filtri o ordinamento per allargare la selezione.`
- CTA:
  - `Azzera filtri`

## 5. Watchlist - Tab `Rewatch`

### 5.1 Product Rule

This tab contains only titles already seen that the user wants to revisit.

- It is not the global archive of watched titles.
- It is an intent queue for rewatch only.

### 5.2 Entry Logic

When user tries to add an already seen title from title detail:

- Open bottom sheet, do not silently add to `Da vedere`
- Sheet actions:
  - `Aggiungi a Rewatch`
  - `Aggiungi a una lista`
  - `Annulla`
- Optional future preference:
  - `Ricorda la mia scelta`

### 5.3 Screen Structure

Order from top to bottom:

1. Optional section `Da rivedere presto`
2. Main vertical rewatch list
3. Empty state if no rewatch items exist

### 5.4 Rewatch Row Content

Each row shows:

- poster
- title
- year
- previous personal rating, if it exists
- last watched date, if it exists
- contextual badge if useful:
  - `Visto 2 volte`
  - `Ultima visione 2024`

### 5.5 Rewatch Row Actions

- `Segna come rivisto`
- `Rimuovi dal rewatch`
- `Aggiungi a una lista`

`Segna come rivisto` updates seen history and keeps rewatch intent only if user explicitly keeps it.

### 5.6 Sorting

Default sorting:

1. `Da rivedere presto`
2. `Aggiunti di recente`
3. `Ultima visione piu lontana`
4. `Titolo A-Z`

### 5.7 Empty State

- Title:
  - `Nessun titolo in rewatch`
- Body:
  - `Quando vuoi rivedere qualcosa che hai gia visto, lo ritrovi qui.`
- CTA:
  - `Aggiungi titoli da rivedere`

## 6. Watchlist - Tab `Liste`

### 6.1 Product Rule

Lists are first-class content. They must feel valuable and curated, not like a hidden utility.

### 6.2 Top Structure

This tab has 2 clear subsections:

- `Le tue liste`
- `Liste salvate`

Top entry action:

- prominent `Crea nuova lista` card or button

### 6.3 Section Order

1. `Crea nuova lista`
2. `Le tue liste`
3. `Liste salvate`

`Liste salvate` includes:

- saved public lists
- pinned public lists
- followed public lists if the follow mechanic is kept

### 6.4 List Card Content

Each list card shows:

- collage cover with 3-4 posters
- list name
- short description
- creator
- visibility status:
  - `Pubblica`
  - `Privata`
  - `Condivisa`
- number of titles
- personal progress bar
- progress text:
  - `8/23 completati`
- optional social metadata:
  - `Salvata da 125 utenti`
  - `Seguita da 3 amici`

### 6.5 List Card Layout

- Card radius: 24 pt
- Cover height:
  - 136-164 pt depending on card size
- Text block under cover, left aligned
- Progress bar always visible if `itemCount > 0`
- Entire card tappable

### 6.6 List Detail Header

The list detail header contains:

- hero collage / cover
- name
- description
- creator
- visibility
- actions:
  - `Salva lista`
  - `Condividi`
  - `Segui` / `Unfollow` only if that mechanic is relevant
- personal progress block:
  - progress bar
  - percentage
  - completed / total text

### 6.7 List Detail Items

Each title row inside a list contains:

- position number if list order is meaningful
- poster
- title
- year
- `Film` / `Serie` badge
- personal state:
  - `visto`
  - `non visto`
  - `in watchlist`
  - `in rewatch`
- quick actions:
  - `Segna visto`
  - `Aggiungi/Rimuovi da watchlist`
  - `Aggiungi/Rimuovi da rewatch`

If `kind == ordered_path`, curator order is never auto-resorted by personal progress.

### 6.8 Filters in List Detail

- `Tutti`
- `Visti`
- `Non visti`
- `In rewatch`

These filters affect only the item list, never the hero header.

### 6.9 Public List Rule

Public lists may contain both watched and unwatched titles.

The user must always see personal progress in the context of that list, regardless of global library state.

## 7. Watchlist - Required Interaction Rules

- General watchlist never contains already completed titles.
- Seen titles cannot silently re-enter `Da vedere`.
- Seen titles go to `Rewatch` or to a list.
- `Da vedere` stays decision-focused and low-noise.
- `Liste` stays editorial and collection-oriented.
- `Da votare` is not promoted as a primary tab.

## 8. Home Feed / Post System Spec

### 8.1 Feed Objective

The Home Feed must:

- inspire what to watch
- show taste and opinions
- generate conversation
- surface useful public lists and meaningful milestones

The feed must not be a log of every app action.

### 8.2 Home Feed Structure

Top-to-bottom layout:

1. compact pinned app header
2. composer entry card
3. feed list

Do not insert noisy discovery carousels above the feed body.

### 8.3 Composer Entry

Home should use a compact composer entry that opens a dedicated compose sheet.

Collapsed composer card content:

- avatar
- placeholder:
  - `Condividi un pensiero, una recensione o un consiglio`
- quick type chips:
  - `Post`
  - `Titolo`
  - `Piu titoli`
  - `Foto`

Tapping any part opens `NewPostComposerView`.

### 8.4 Full Composer

Composer presentation:

- full-screen sheet
- large title: `Nuovo post`
- top-right publish button
- visibility menu:
  - `Pubblico`
  - `Amici`
  - `Privato`

The compose sheet supports 4 manual modes:

1. `Testo`
2. `Titolo in focus`
3. `Piu titoli`
4. `Foto + commento`

### 8.5 Manual Post Types

#### A. Manual text post

- large text area
- supports tagging:
  - users
  - titles
  - actors / directors / characters
- optional one image attachment
- publish CTA always visible in nav bar

#### B. Post with title in focus

- same text area
- one required attached title card
- title card is shown inline in composer
- card can be removed or replaced

#### C. Post with multiple titles

- text area remains primary
- ordered selection of 2-6 titles
- intended uses:
  - comparisons
  - rankings
  - narrative top lists
- selected titles shown as reorderable chips plus preview cells

#### D. Photo + comment

- text area
- one optional image attachment as the visual anchor
- titles and users can still be tagged
- this is supported but never visually prioritized over title-centric posts

### 8.6 Feed Card Types

#### Manual text post card

- avatar
- author name
- timestamp
- text up to 4 lines collapsed
- tagged title chips under text if relevant
- optional image
- footer:
  - reactions
  - comments
  - save
  - share

#### Review post card

- avatar/header
- embedded title card
- highly visible rating pill
- review excerpt
- CTA:
  - `Leggi recensione`

#### Rating post card

- compact height
- sentence:
  - `X ha dato 4,5 a [titolo]`
- small poster / title lockup
- optional micro-comment up to 2 lines

#### Completed / milestone post card

- clear milestone message
- optional badge:
  - `Serie completata`
  - `Saga completata`
  - `Obiettivo raggiunto`
- CTA to title, rating, review, or list

#### List post card

- collage
- list name
- description
- count or progress
- CTA:
  - `Apri lista`
  - `Salva`

### 8.7 Feed Card Hierarchy

Every card uses the same visual rhythm:

1. Header
2. Main text or title block
3. Optional media/title/list module
4. Footer actions

Rules:

- No more than one main visual block per card
- No stacked chips overload
- No more than 4 visible footer actions
- Use compact metadata, never technical metadata

### 8.8 Footer Actions

The footer must standardize on:

- reaction
- comment
- save
- share

`Save` is a feed-level action for later revisit, not the same as Watchlist.

## 9. Feed Ranking and Quality Rules

Priority order:

1. reviews with text
2. manual posts with actual opinion
3. public list creation
4. public list important updates
5. completion milestones
6. contextual ratings

Downrank:

- raw ratings without text or significance
- repeated low-signal actions from the same account
- consecutive events about the same title with no new information
- content from weak social ties if richer content exists

Suppression rules:

- max 2 feed posts per author in the first 20 visible items
- never show duplicate variants of the same event
- private events never enter ranking
- muted/blocked users are excluded before ranking

## 10. Automatic Post Generation Rules

### 10.1 Source of Truth

Automatic post generation should be evaluated on the server before writing `feedEvents`.

Current backend events that must be reconsidered:

- `rating`
- `watch_together`
- `post`
- `post_share`
- `recommendation`
- `follow`
- `post_comment`

Target rule: not every backend event becomes a Home post.

### 10.2 Decision Table

| Evento | Genera post? | Condizioni | Visibilita |
|---|---|---|---|
| Post manuale testuale | Si | Sempre, perche e una scelta esplicita dell'utente | `public` o `friends`; `private` resta fuori dalla Home altrui |
| Post manuale con titolo in focus | Si | Sempre | `public` o `friends`; `private` escluso dalla Home altrui |
| Post manuale con piu titoli | Si | Sempre | `public` o `friends`; `private` escluso dalla Home altrui |
| Post foto + commento | Si | Sempre, ma solo se contiene testo o contesto reale | `public` o `friends`; `private` escluso dalla Home altrui |
| Nuova recensione scritta | Si | Sempre se esiste `reviewText` non vuoto | stessa visibilita del rating/review |
| Rating forte | Si | `rating >= 8.5` o `rating <= 3.0` | stessa visibilita del rating |
| Rating contestualizzato | Si | Se esiste microcommento, reaction testuale, titolo popolare o alta rilevanza sociale | stessa visibilita del rating |
| Rating ordinario senza contesto | No | Nessun testo, nessuna rilevanza, nessun segnale sociale | nessuna Home, solo dato personale |
| Visione con amici / watch together | Si | Solo se accompagnata da rating, review, commento o milestone; non come log grezzo | stessa visibilita del contenuto sorgente |
| Fine serie | Si | Sempre se utente completa l'intera serie | `public` o `friends` |
| Fine stagione importante | Si | Solo stagione finale o stagione editoriale/socialmente significativa | `public` o `friends` |
| Singolo episodio visto | No | Salvo che sblocchi una milestone maggiore | nessuna Home |
| Completamento saga o percorso importante | Si | Se lista/saga e marcata significativa o completata | `public` o `friends` |
| Creazione lista pubblica | Si | Sempre se `visibility == public` | `public` |
| Update importante lista pubblica | Si | Solo se aggiunge >= 3 titoli, diventa pubblica, viene completata, o avvia collaborazione | `public` |
| Modifica lieve lista pubblica | No | 1 titolo aggiunto, fix copy, reorder minore | nessuna Home |
| Modifica lista privata | No | Sempre | privata |
| Suggerimento pubblico con motivazione | Si | Solo se e un post pubblico esplicito, non una recommendation privata riciclata | `public` o `friends` |
| Suggerimento privato inviato a un amico | No | Sempre escluso | privata / notifica privata |
| Aggiunta alla watchlist | No | Sempre escluso | personale |
| Rimozione dalla watchlist | No | Sempre escluso | personale |
| Aggiunta al rewatch | No | Sempre escluso | personale |
| Follow utente | No | Non aiuta a scegliere cosa guardare | notifica privata o activity secondaria |
| Commento a un post altrui | No | Resta nel thread del post | nessuna Home autonoma |
| Like / reaction | No | Microazione tecnica | nessuna Home |
| 100 film visti nell'anno | Si | Solo milestone curate e non spam | `public` o `friends` |
| 10 recensioni pubblicate | Si | Solo soglie curate | `public` o `friends` |
| Obiettivo personale raggiunto | Si | Solo se leggibile e rilevante per gli altri | `public` o `friends` |

## 11. Home Feed - Backend Consequences

To respect the rules above:

- `recommendation` feed events generated from private recommendation flow must stop becoming Home posts
- `follow` feed events should leave Home and become notification/profile activity only
- `post_comment` feed events should not become standalone Home posts
- `rating` stays but must pass an eligibility check before write
- `review` should be treated as the highest-value rating variant, not as a raw rating
- `watch_together` should only survive when attached to meaningful opinion or milestone
- new event families should be introduced:
  - `list_created`
  - `list_updated`
  - `completion`
  - `milestone`
  - `public_recommendation`

## 12. SwiftUI Components Required

### 12.1 Watchlist

- `WatchlistScreen`
- `WatchlistHeaderView`
- `WatchlistSegmentedControl`
- `WatchlistSearchBar`
- `WatchlistFilterSortSheet`
- `TonightSuggestionsSection`
- `TonightSuggestionCard`
- `ToWatchListSection`
- `ToWatchRow`
- `ToWatchRowContextMenu`
- `RewatchListSection`
- `RewatchRow`
- `SeenTitleRoutingSheet`
- `ListsHubSection`
- `CreateListEntryCard`
- `OwnedListsSection`
- `SavedListsSection`
- `UserListCard`
- `UserListDetailHeader`
- `UserListProgressBlock`
- `UserListItemRow`
- `UserListDetailFilterBar`

### 12.2 Home Feed / Posts

- `HomeFeedScreen`
- `HomeFeedComposerEntryCard`
- `NewPostComposerView`
- `PostComposerModePicker`
- `TaggedEntityPickerSheet`
- `AttachedTitleCard`
- `AttachedTitlesReorderList`
- `PostImageAttachmentView`
- `FeedPostCard`
- `ManualTextPostCard`
- `ReviewPostCard`
- `RatingCompactPostCard`
- `CompletionPostCard`
- `ListPostCard`
- `PostFooterActionsBar`
- `PostSaveButton`

## 13. States to Manage

### 13.1 Watchlist

- `loading`
  - first load skeleton
  - tab-level placeholder rows
- `empty`
  - per-tab dedicated copy
- `populated`
  - default state
- `errore`
  - inline message + retry
- `filtered`
  - active filter chips visible
- `searching`
  - local search active
- `reordering`
  - list detail ordered-path editing
- `multi-select`
  - not part of V1 main Watchlist; do not introduce batch select in first implementation

### 13.2 Home Feed

- `loading`
  - first feed skeleton
- `empty`
  - empty feed explanation
- `populated`
  - default feed
- `errore`
  - inline retry
- `composer_draft`
  - dirty draft, unsaved changes prompt on dismiss
- `composer_validating`
  - publish in progress
- `filtered`
  - if future feed scopes are added
- `multi-select`
  - not applicable

## 14. Edge Cases to Cover

### 14.1 Watchlist

- User taps `Aggiungi alla watchlist` on a completed film
- User taps `Aggiungi alla watchlist` on a completed series
- User marks a `Da vedere` item as seen from swipe action
- User marks a series as completed and it must disappear from `Da vedere`
- User removes an item from `Rewatch` but it remains in library history
- Public list contains titles already watched by the user
- Public list progress differs from global title state
- Ordered list must keep curator order even if user completed late items first
- User has no platforms configured and platform filter is opened
- Social proof exists but is stale or partial; row should gracefully hide the line
- Title metadata is incomplete: missing year, duration, seasons, poster

### 14.2 Home Feed

- Manual post has only image and no text
- Manual post has only text and no title/image
- Title focus post loses attached title before publish
- Multi-title post has 1 title only
- Private post is created and must not leak into public feed
- Review exists but visibility is `friends`
- Rating update should not create repeated low-value posts
- User comments on a post; comment must not create a new Home card
- Private recommendation should never become a public feed card
- Same user produces many ratings in a short window
- Same title appears in rating + completion + list update in the same day
- Muted/blocked user content must be excluded before ranking

## 15. Data / View Model Proposal Without Stravolgere Current Model

### 15.1 Watchlist

Keep `TitlePersonalState` as the per-title source of truth and extend it minimally:

- add `rewatchIntent: Bool`
- add `rewatchAddedAt: Date?`
- add `watchPriority: Int?`

Do not overload `generalWatchlist` to also mean rewatch.

Recommended `WatchlistDashboard` evolution:

- `toWatch: [TitlePersonalState]`
- `rewatch: [TitlePersonalState]`
- `ratingQueue: [TitlePersonalState]`
- `ownedLists: [UserListSummary]`
- `sharedLists: [UserListSummary]`
- `savedLists: [UserListSummary]`
- `tonightSuggestions: [WatchSuggestionItem]`

`savedLists` should be derived from current public lists + `isSavedByCurrentUser`.

Suggested new lightweight struct:

```swift
struct WatchSuggestionItem: Identifiable, Hashable {
    let id: String
    let title: Title
    let reason: WatchSuggestionReason
    let socialProofText: String?
    let platformText: String?
}
```

Suggested new UI state enums:

```swift
enum WatchlistSectionTab: String, CaseIterable, Identifiable {
    case toWatch = "Da vedere"
    case rewatch = "Rewatch"
    case lists = "Liste"

    var id: String { rawValue }
}

enum ToWatchSortOption: String, CaseIterable, Identifiable {
    case relevance
    case recentlyAdded
    case titleAZ
    case year
    case myPlatforms
    case friendsPopularity

    var id: String { rawValue }
}
```

### 15.2 Home Feed

Keep `FeedActivity` as the feed consumption model, but adjust event semantics.

Recommended evolution:

- keep:
  - `rating`
  - `watch_together`
  - `post`
  - `post_share` only if explicit commentary remains supported
- deprecate from Home:
  - `recommendation`
  - `follow`
  - `post_comment`
- add:
  - `list_created`
  - `list_updated`
  - `completion`
  - `milestone`
  - `public_recommendation`

Recommended additive card typing:

```swift
enum FeedCardStyle: Hashable {
    case manualText
    case review
    case ratingCompact
    case completion
    case list
}
```

Composer models should be explicit:

```swift
enum ManualPostComposerMode: String, CaseIterable, Identifiable {
    case text
    case focusTitle
    case multipleTitles
    case photoComment

    var id: String { rawValue }
}

struct ManualPostDraft: Hashable {
    var mode: ManualPostComposerMode
    var visibility: PostVisibility
    var text: String
    var taggedUserIDs: [String]
    var taggedTitleIDs: [String]
    var taggedPersonIDs: [String]
    var attachedTitleID: String?
    var attachedTitleIDs: [String]
    var attachedImageLocalID: String?
}
```

## 16. Implementation Notes

- Watchlist refactor should happen before visual polishing, because the current IA still reflects `Watchlist / Da votare / Liste / Pubbliche`.
- Feed work should start by changing generation rules before polishing cards, otherwise the UI will still display low-value events.
- The product target is additive over the current codebase, not a rewrite.

## 17. Non-Negotiables

- Do not treat SOMTO like a streaming product.
- Do not turn Watchlist into a social feed.
- Do not publish private suggestions as Home posts.
- Do not generate Home posts for insignificant or technical actions.
- Do not sacrifice readability for density.
