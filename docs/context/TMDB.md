# TMDB — proxy, arricchimento, merge manuale

Leggi per: tmdbProxy, enrichTitleAssets, refreshTitleFromTmdb, titoli accorpati (`mergedTmdbIds`).
Vedi anche `docs/TMDB_CACHE.md` e `docs/TMDB_AUTO_IMPORT.md`.

## TMDB
- Client lato Firestore: `tmdbCache/` per cache
- Callable `tmdbProxy` in `functions/index.js` — actions: `searchMulti`, `details`, `videos`, `upcomingCinema`, `upcomingStreaming`, **`personCredits`** (`/person/{id}/combined_credits`)
- Callable `enrichTitleAssets` — trailer + cast su `castWithCharacters`
- Callable `refreshTitleFromTmdb`
- Swift: `TitleRepository.fetchTMDBPersonCredits(personTMDBID:)` + `enrichLocalCatalog(forPersonTMDBID:currentUser:)` per import dinamico in Person page
- Cache import: `enrichedPersonTMDBIDs: Set<Int>` lato `TitleRepository`
- **Titoli merge manuale**: `tmdbSync.syncDisabled: true` su un titolo lo rende immune al sync TMDB (`refreshTitleFromTmdb` anche con force, `adminBackfillTitleMetadata` lo saltano). Campo root `mergedTmdbIds: [int]` = id TMDB assorbiti dentro quel titolo: `linkPersonToTitles` e `importRecentTmdbTitles`/`existsLogicalDuplicateTitle` risolvono il proprietario via `tmdbId`/`mergedTmdbIds` e non ricreano stub `tmdb_*`. Caso live: doc `berlino` accorpa TMDB 146176 (stagione 1, "i gioielli di Parigi") + 308014 (stagione 2, "la Dama con l'ermellino").
