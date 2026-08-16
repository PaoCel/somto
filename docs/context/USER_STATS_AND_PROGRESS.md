# Stats utente e progresso serie

Leggi per: ore viste, titoli visti, contatori `users/{uid}.stats`, seriesProgress, watchers di un titolo.

## Stats utente (ore viste / titoli visti)
- `users/{uid}.stats` = cache `{ watchedCount, ratingsCount, totalWatchMinutes, rewatchCount }`. **Mantenuta lato server, NON scrivere da client** (sovrascriverebbe i contatori incrementali).
- Fonte di verità: `users/{uid}/titleStates` (campo `watchMinutesContribution` per doc) + `users/{uid}/listProgressEntries`. La collection legacy `library` è solo proiezione/lettura; gli utenti legacy `library`-only sono stati migrati a `titleStates` il 2026-05-17 (`scripts/migrate-legacy-library-to-titlestates.js`).
- Trigger incrementali `onWrite` in `functions/index.js`: `recomputeUserStatsFromTitleStates` + `recomputeUserStatsFromListProgress` → applicano solo il delta via `FieldValue.increment`, O(1).
- Anti-drift: `reconcileUserStats` (schedulata settimanale) + callable `recomputeUserStats` (admin/self). Logica condivisa `recomputeUserStatsForUid`. Baseline una-tantum: `scripts/recompute-user-stats.js`.
- `watchMinutesContribution`: backfill ESEGUITO il 2026-07-05 (fix fallback durationEpisode `last_episode_to_air` + 27 serie / 78 film arricchiti via `scripts/enrich-missing-durations.js` + 226 titleStates ricalcolati). Residuo noto: ~4 titoli senza runtime su TMDB in nessuna forma (metadataIssues aperte, auto-repair al primo enrichment utile).
- iOS `fetchProfileActivitySummary` e `getPublicProfileActivitySummary` leggono solo `stats`, niente rescan.

## Progresso serie visibile + watchers (2026-06-16)
"A che punto è" una persona nelle serie TV (film esclusi: niente minutaggio). **Nessun rewatch per-titolo** nel data model — esiste solo il globale `users/{uid}.stats.rewatchCount`; la feature copre quindi solo il progresso serie.
- **Dato**: `users/{uid}/titleStates/{titleId}.seriesProgress` è owner-only. Esposto via 2 callable admin SDK in `functions-public-profile/index.js` (codebase `publicprofile`, europe-west1):
  - `getPublicProfileSeriesProgress({userId})` → mappa `titleId → {state, ...seriesProgress}`, solo serie TV iniziate/finite. Gate: signed-in (come la `library` pubblica, read `isSignedIn`).
  - `getTitleWatchersProgress({titleId})` → amici (accepted) ∪ seguiti del CHIAMANTE che guardano quella serie, con progresso; pre-ordinati (in corso prima), cap 60. Resta nel grafo del chiamante (nessun estraneo). Solo TV. Helper condivisi `normalizeSeriesProgress`/`hasWatchSignal`.
- **iOS**: `WatchlistRepository.fetchPublicProfileSeriesProgress`/`fetchTitleWatchersProgress`; modello `TitleWatcher` + `TitleSeriesProgress.fromMap`/`progressBadgeLabel(state:)` + campo `contextState`. Badge su `ProfilePosterTile` (tab Visti, profilo proprio e altrui) + `TitleWatchersSection`/`TitleWatcherRow` su `TitleDetailView` (tab social, gate `title.type == .tv`).
- **Web**: wrapper in `library.api.js`; badge `.profile-progress-badge` in `user.page.js`; sezione `#seriesWatchersCard` in `title.html` + `renderSeriesWatchers()` in `title.page.js`.
- **Nessuna modifica a `firestore.rules`** (le CF usano admin SDK, bypassano le rules owner-only).
- **Live dal 2026-06-16** (v1.2.5 / hosting): le 2 CF sono deployate (codebase `publicprofile`).

## Contatori del profilo: cosa contano davvero (2026-08-05)

Audit su prod: i contatori memorizzati sono **esatti** rispetto a un ricalcolo
da zero (4 account campione, totali e `byCategory` identici al documento). Le
differenze che si notano guardando le liste hanno cause diverse:

- **"Visti" ≠ griglia dei visti.** Il contatore (`stats.watchedCount`) conta i
  titoli **finiti**; la griglia legge la proiezione `library`, che per scelta
  esplicita include anche le **serie iniziate e non finite**
  (`buildLegacyLibraryProjection`). Scarti reali misurati: da +10 a +181 titoli.
  Su iOS `fetchLibrary` ha anche un cap a 400 doc → librerie grandi appaiono
  troncate. **Aperto**: decidere se contare le serie in corso, toglierle dalla
  griglia o mostrarle come numero a parte.
- **"Review" contava i voti.** L'etichetta è stata corretta in **"Voti"** su web
  e iOS: il numero sono i titoli votati (`stats.ratingsCount`), mentre il tab
  Review elenca solo i voti con testo (sull'account admin: 143 vs 41).
- **`stats.reviewsCount` non lo aggiorna nessuno** (nasce 0 e resta 0): non va
  usato come fonte. Il profilo altrui lo leggeva e mostrava 0 a tutti.
- **Non contare i doc `ratings`**: un titolo accorpato lascia un doc con il
  vecchio id nel nome e gonfia il conteggio. Fonte buona = `stats.ratingsCount`.
- I voti di **stagione/episodio** non entrano in nessun contatore di profilo.

Script di riparazione: `functions/scripts/repair-rating-title-state-desync.js`
(dry-run di default). Copre due difetti: doc `ratings` duplicati per lo stesso
(utente, titolo) e voti il cui `titleState` non ha `hasTitleRating` (il voto
esiste ma sparisce da libreria e contatori). Eseguito su prod il 2026-08-05:
1 duplicato rimosso, 3 voti risincronizzati, riscansione successiva pulita.

**Ordine obbligatorio**: cancellare un doc `ratings` fa scattare
`syncTitleStateFromTitleRating`, che **azzera** il flag sul titleState di quel
titolo anche se sopravvive un altro voto per lo stesso titolo. Il ripristino
dello state va fatto DOPO la cancellazione, non prima.
