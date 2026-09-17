# Voti, emozioni e voti personaggi

Leggi per: voti per livello (title/season/episode), aggregato community, emozioni post-visione, pick personaggi.
Spec estesa personaggi: `docs/CHARACTER_VOTES_SPEC.md`.

## Voti per stagione + aggregato community
- Collection `/ratings/{ratingId}` supporta tre livelli — campo `level ∈ {title, season, episode}`. ID composito: `<uid>__<titleId>__<level>__<season|0>__<episode|0>` (helper `makeRatingId` in PWA, `makeRatingID` in `TitleRepository.swift`). Garantisce 1 voto per utente per item.
- `reviewText` opzionale **su ogni livello** (rules 2026-05-21): cap 5000 char, validate da `validRatingReviewFields` in `firestore.rules`. iOS/PWA composer popolato di conseguenza.
- **Denormalizzato** in `titles/{id}.ratingAggregate`:
  ```
  ratingAggregate = {
    titleLevel: { sum, count, avg },
    bySeason:   { "1": { sum, count, avg }, "2": {...}, ... },
    combined:   number 2dec,  // (titleLevel.sum + Σ bySeason.sum) / (titleLevel.count + Σ bySeason.count)
    updatedAt:  timestamp
  }
  ```
  Modello `combined` trasparente: ogni voto pesa 1, qualunque sia il livello. Una vera media-di-medie-per-utente è TODO (vedi "Pending residui").
- Trigger `recomputeTitleRatingAggregate` (`functions/index.js`) onWrite `/ratings/*`: applica solo il delta su `ratingAggregate`, O(1). Baseline una-tantum: `scripts/backfill-titleRatingAggregate.js` (eseguire DOPO il deploy del trigger).
- **Migrazione 1-tap** title → season:
  - iOS: `TitleRepository.migrateRatingLevel(rating, toLevel:season:episode:)` (batch: setData new + delete old).
  - PWA: `ratings.api.js → migrateRatingLevel({fromLevel, toLevel, toSeason, ...})`.
  - UI: `MyRatingsBreakdownView` (iOS, tab Social) / `#myRatingsBreakdown` (PWA) mostrano la lista voti per stagione + voto generale con menu "Sposta su Stagione N" e "Aggiungi voto per stagione".
- Composer rating preset per stagione:
  - iOS: `RatingPostComposerSheet(level:season:episode:)` — label contestuale, thread pubblico nascosto fuori da title-level. `quickRateSeason` apre il prompt "aggiungi recensione" sulla stagione.
  - PWA: pulsante "Aggiungi review stagione" inline accanto al voto stagione, persiste via `upsertRating({reviewText})`.

## Emozioni post-visione ("Che impressione hai avuto?", 2026-07-06; episodio 2026-07-27)
Griglia 12 emoji stile TV Time con percentuali community. Il livello titolo è live; l'estensione per singolo episodio è additiva e resta semanticamente separata.
- **Dati**: collection `/titleEmotions/{emotionId}`, 1 doc/utente/titolo, id composito `{uid}__{titleId}__title__0__0` (stesso formato/sanitizzazione dei ratings, level fisso `title` in v1 — formato pronto per stagioni). Campi: `uid, titleId, level, season:null, episode:null, emotions:[1..3 chiavi uniche], source?, createdAt, updatedAt`. Chiavi canoniche (mai emoji nel DB): `shocked frustrated sad reflective touched amused scared bored understood thrilled confused tense` — whitelist condivisa in `functions/lib/emotionAggregate.js` (`EMOTION_KEYS`), `firestore.rules`, `TitleEmotion` (iOS), `emotions.api.js` (web). Label IT: Scioccato/Frustrato/Triste/Riflessivo/Commosso/Divertito/Spaventato/Annoiato/Mi ci rivedo/Elettrizzato/Confuso/Teso.
- **Rules**: read `isSignedIn` (come ratings), create con **doc-id vincolato** `uid+"__"+titleId+"__title__0__0"` (niente multi-doc spam per gonfiare l'aggregato — hardening che i ratings non hanno), `hasOnly` stretto, no duplicati (`toSet()`), `isSynthetic` solo admin SDK. Deselezione totale = delete (i client fanno get-prima-di-delete: delete su doc inesistente = deny).
- **Aggregato**: `titles/{id}.emotionAggregate = { counts:{...solo >0}, totalSelections, totalUsers, updatedAt }` — server-owned (in `titleServerFieldsUnchanged`), trigger `recomputeTitleEmotionAggregate` (specchio del rating trigger: transazione delta O(1), guard `isSyntheticDoc`, no-op guard su set invariato). % = counts/totalSelections; UI nasconde le % sotto 3 utenti (mostra solo emoji). Reconcile/baseline: `scripts/backfill-titleEmotionAggregate.cjs` (esclude sintetici; da rilanciare dopo import bulk).
- **iOS**: `TitleEmotion`/`TitleEmotionAggregate` in Title.swift, `submitTitleEmotions`/`fetchMyTitleEmotions` in TitleRepository, `EmotionGridPicker` (DesignSystem), sezione nel `RatingPostComposerSheet` (solo title-level), prompt post-visto `PostSeenEmotionPromptSheet` sequenziato PRIMA del quiz prompt (`onDismiss`), `TitleEmotionCommunitySection` + `TitleEmotionEditSheet` nel tab Social.
- **Web**: `public/js/api/emotions.api.js`, picker card tab Social (save debounced 600ms, fetch 1×/titolo cache `_emotionsFetchedForTitleId`), sezione nel modal review, card `#emotionsCommunityCard`. SW **v74**.
- **Test**: unit `functions/test/unit/emotionAggregate.test.cjs` (8) + 8 rules test in `rules.spec.cjs`.
- **Import TV Time**: l'adapter `tvTimeGdpr.js` NON estrae ancora le emozioni (`emotions-*.csv` citato solo in commento). Retrofit futuro: mapping `emotion_id` numerici → `EMOTION_KEYS` (TBD dal file demo), write `titleEmotions` admin SDK con `source:"tvtime_import"` merge non distruttivo, poi backfill aggregati.
- **Singolo episodio**: `episodeEmotions/{uid}__{titleId}__episode__{season}__{episode}` con coordinate immutabili, 1-3 chiavi canoniche e nessun backfill da `titleEmotions`. Aggregato server-owned per episodio in `titles/{id}/episodeEmotionAggregates/{season}_{episode}`, mantenuto dal trigger gen2 `recomputeEpisodeEmotionAggregate` (`europe-west1`). iOS e web usano il foglio post-episodio centralizzato: voto episodio, emozioni episodio, fino a 3 personaggi e discussione; l'eventuale composer titolo arriva solo dopo.

## Voti personaggi ("Chi ti ha conquistato?", 2026-07-25)
Pick positivo del personaggio preferito per titolo (mai un voto numerico all'attore), modellato sul comportamento reale degli export TV Time (`show_character_episode_vote.csv`). Spec completa: `docs/CHARACTER_VOTES_SPEC.md`.
- **Dati**: `characterVotes/{uid}__{titleId}__{level}__{s}__{e}` (1 doc/utente/item, fino a 3 pick + reazione opzionale dalle chiavi emozione esistenti). Aggregati: `titles/{id}/characterVotes/{s}_{e}` (episodio, a volume) + `titles/{id}/aggregates/characters` (serie/stagione, a **utenti unici** — un binge di 73 episodi conta 1) + rollup personale `users/{uid}/characterPicks/{titleId}`.
- **Server**: `functions/lib/characterVoteAggregate.js` + 2 trigger **gen2** (`europe-west1`, i primi del progetto — vedi Pending per il gotcha gen1) + `tmdbProxy` `seasoncredits`/`episodecredits` (guest star, fallback su 404).
- **iOS**: `CharacterPickRow` (in `EpisodeSeenSheet`, composer film, tab social). **Web**: `public/js/api/characterVotes.api.js` + picker + card risultati (prima il cast era solo testo).
- **Anti-spoiler**: risultati visibili solo a titolo completato (scelta conservativa, follow-up per-stagione in spec §9-bis).
