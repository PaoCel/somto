# Firebase Data Model — Somto

Riferimento tecnico del data model Firestore/Storage. Fonti di verità: `firestore.rules`, `firestore.indexes.json`, `storage.rules`, `functions/index.js` + `functions/modules/*.js` + `functions-public-profile/index.js`, i repository client (`public/js/api/*.js`, `ios/TwoWatch/Data/Repositories/*.swift`).

Se un campo/collection non è qui dentro, non esiste nelle rules: non scriverlo/leggerlo assumendo che "probabilmente funzioni".

## 1. Panoramica

- **Database**: Firestore Native, progetto prod **`gia-visto`**, location **`eur3`** (multi-region Europe). Progetto staging **`somto-staging`** (stessa location `eur3`, functions non deployate finché resta su piano Spark). Alias in `.firebaserc`: `default`/`prod`/`production` → `gia-visto`, `staging` → `somto-staging`.
- **Cloud Functions**: due codebase distinte dichiarate in `firebase.json`:
  - `default` → sorgente `functions/` (grosso della logica: import, quiz, titoli, liste, social, admin).
  - `publicprofile` → sorgente `functions-public-profile/` (3 callable read-only per il profilo pubblico: `getPublicProfileActivitySummary`, `getPublicProfileSeriesProgress`, `getTitleWatchersProgress`).
  - Region di default **`europe-west1`**; un solo trigger legacy (`notifyAdminsSupportUpload`, Storage `onFinalize`) resta su `us-central1` per co-locazione col bucket di default.
- **Storage**: bucket `gia-visto.firebasestorage.app`, regole in `storage.rules` (vedi §6).
- **Client**: PWA vanilla ES modules (`public/js/api/*.js`, Firebase Web SDK v10.12.5) e app iOS SwiftUI (`ios/TwoWatch/Data/Repositories/*.swift`). Entrambi parlano direttamente a Firestore via SDK client per le collection che lo permettono; per tutto ciò che è server-owned passano da Cloud Functions callable.
- **Governance rules**: `rules_version = '2'`, un solo `service cloud.firestore` con blocco finale di default-deny (`match /{document=**} { allow read, write: if false; }`). Qualunque collection non esplicitamente matchata sopra è **inaccessibile ai client** (letta/scritta solo da Cloud Functions con Admin SDK, che bypassa le rules).
- **Convenzione ricorrente**: molte collection hanno un campo o un intero doc "server-owned" — mantenuto solo da un trigger Cloud Function — e le rules lo congelano esplicitamente in update (pattern `next.get('campo', default) == prev.get('campo', default)`). Questo pattern anti-forge ricorre su contatori (stats, followersCount), aggregati (ratingAggregate, emotionAggregate), identità (slug, mergedTmdbIds) e flag di sistema (accountType/isSynthetic per i profili guidati).

Mappa rapida area → file client (dove guardare per capire come una collection viene letta/scritta dal client, prima di modificare le rules):

| Area | PWA (`public/js/api/`) | iOS (`ios/TwoWatch/Data/Repositories/`) |
|---|---|---|
| Auth/sessione | `account.api.js` | `AuthenticationRepository.swift` |
| Profilo utente, stats, follow/friend | `users.api.js` | `UserRepository.swift` |
| Titoli/catalogo, TMDB | `titles.api.js`, `tmdb.api.js`, `titleEdits.api.js` | `TitleRepository.swift` |
| Watchlist/titleStates/liste | `watchlist.api.js`, `userLists.api.js`, `watchlistDashboard.api.js`, `titleStates.api.js`, `library.api.js` | `WatchlistRepository.swift` |
| Import (Netflix/TV Time/Trakt) | `imports.api.js` | `TitlesImportRepository.swift` |
| Voti/recensioni | `ratings.api.js` | `TitleRepository.swift` (rating è parte del title domain) |
| Emozioni post-visione | `emotions.api.js` | `TitleRepository.swift` |
| Home/feed | `feed.api.js`, `events.api.js` | `HomeRepository.swift` |
| Social (post, commenti) | `posts.api.js` | `PostsRepository.swift` |
| Thread/chat | `threads.api.js` | `ThreadsRepository.swift` |
| Notifiche | `notifications.api.js` | `NotificationRepository.swift` |
| Match Mode | `match.api.js`, `signals.api.js` | `MatchRepository.swift` |
| Quiz | `quiz.api.js` | `QuizRepository.swift` |
| Consigli/raccomandazioni | `recommendations.api.js` | `SocialInboxRepository.swift` |
| Persone (attori/registi) | `people.api.js` | `TitleRepository.swift` |
| Onboarding | `onboarding.api.js` | (in `UserRepository.swift`) |
| Segnalazioni/moderazione | `reports.api.js`, `safety.api.js` | (in `UserRepository.swift`/`TitleRepository.swift`) |
| Blog | `blogPosts.api.js` | n/a (solo web) |
| Provider streaming | `providers.api.js` | (in `WatchlistRepository.swift`) |

## 2. Indice di tutte le collection

Legenda Write: **client** = scrivibile dal client secondo le rules (con validazione); **server** = scrivibile solo da Cloud Functions (Admin SDK bypassa le rules, rule client-side è `if false` o assente); **admin** = client ammesso solo se `isAdmin()`/`isTrusted()`.

### `users/{userId}` e subcollection

| Path | Contenuto | Read | Write | Note |
|---|---|---|---|---|
| `users/{userId}` | Profilo pubblico (displayName, avatar, trusted/level/isAdmin, stats, onboarding legacy) | qualunque loggato | client (owner, campi vincolati) + admin (tutto) | `stats`, `followersCount`, `friendsCount`, `accountType`, `isSynthetic`, `bio` sono **server-owned**, congelati in update (§3.1) |
| `users/{userId}/library/{titleId}` | Proiezione legacy "titoli visti" (solo lettura profilo) | qualunque loggato | client (owner), **nessuna validazione di schema** | legacy, superseduta da `titleStates`; mantenuta anche server-side (§4) |
| `users/{userId}/watchlist/{entryId}` | Watchlist legacy pre-`titleStates` | solo owner | client (owner), **nessuna validazione di schema** | legacy, superseduta da `titleStates.generalWatchlist` + `userLists`; migrata da `migrateUserWatchlistV2` |
| `users/{userId}/savedLists/{listId}` | Liste pubbliche salvate/pinnate dall'utente | solo owner | client (owner, doc id = listId, richiede lista pubblica esistente) | scrivere qui pilota il trigger che aggiorna `userLists.followersCount` (§4) |
| `users/{userId}/listProgressEntries/{entryId}` | Progresso personale su una lista (liste pubbliche/condivise) | solo owner | client (owner) | alimenta `stats.totalWatchMinutes` (§4) |
| `users/{userId}/titleStates/{titleId}` | Stato di visione per titolo — cuore watchlist/visti | solo owner | client (owner) | vedi schema §3.2 |
| `users/{userId}/episodeViews/{viewId}` | Episodi recuperati da import (TV Time special/righe incomplete) | solo owner | **deny-all** | scritto solo da import pipeline |
| `users/{userId}/derivedRatings/{titleId}` | Voto derivato privato (media episodio→stagione/serie) | solo owner | **deny-all** | trigger `recomputeUserDerivedRating` |
| `users/{userId}/imports/{importId}` | Job di import (Netflix/TV Time/Trakt) | solo owner | **deny-all** | intero lifecycle server-side |
| `users/{userId}/imports/{importId}/items/{itemId}` | Righe parse dell'import, matching risolto/da confermare | solo owner | **deny-all** | |
| `users/{userId}/imports/{importId}/payload/{payloadId}` | Payload raw dell'import | **deny-all anche owner** | **deny-all** | |
| `users/{userId}/imports/{importId}/previousStates/{titleId}` | Snapshot immutabile del `titleState` prima dell'import (`existed`, `state`, `capturedAt`, `schemaVersion`) | **deny-all anche owner** | **deny-all** | Admin SDK; incluso in `exportMyData` |
| `users/{userId}/_system/notificationPrefs` | Preferenze notifiche | solo owner | client (owner) | schema stretto in rules |
| `users/{userId}/titleUpdatePreferences/{titleId}` | Preferenza notifiche per titolo (`auto/follow/important/muted`) | solo owner | client (owner) | doc id = titleId, schema stretto; il fan-out server applica anche l'opt-out globale |
| `users/{userId}/_system/productTracking` | Milestone tecniche pseudonime di adozione tracker (nessun titleId/testo/episodio) | **deny-all client** | **server-only** | export GDPR esplicito; delete account via recursiveDelete `_system`; retention ~13 mesi |
| `users/{userId}/_system/publicThreadFanout` | Stato compatto anti-spam per notifiche dei thread pubblici (cooldown mittente + ultime 100 decisioni evento) | **deny-all client** | **server-only** | nessun testo del commento; sostituzione completa del doc per potatura |
| `users/{userId}/rateLimits/{action}` (solo `recommendations`/`reports`) | Contatore anti-spam client-enforced | solo owner | client (owner, finestra minima 12h) | |
| `users/{userId}/matchFeedback/{titleId}` | Feedback swipe Match Mode (like/skip/superlike/seen) | solo owner | client (owner) | |
| `users/{userId}/friends/{friendUid}` | Relazione amicizia (pending/accepted/blocked) | pubblico se `accepted`, altrimenti le due parti | client (owner o controparte, state machine vincolata) | |
| `users/{userId}/following/{targetUserId}` | Chi segue l'utente `targetUserId` | qualunque loggato | client (owner) | |
| `users/{userId}/followers/{followerUserId}` | Chi segue `userId` | qualunque loggato | client (il follower stesso) | |
| `users/{userId}/blockedUsers/{blockedUid}` | Utenti bloccati | solo owner | client (owner) | |
| `users/{userId}/notificationTokens/{tokenId}` | Token push (FCM) | solo owner | client (owner, `token`/`platform`/`createdAt` frozen su update) | trigger `cleanupDuplicateNotificationToken` dedup |
| `users/{userId}/notifications/{notificationId}` | Notifiche in-app | solo owner | create **server-only**; update solo `read` | scritte da ~18 trigger in `notifications.js` (§3.3) |
| `users/{userId}/onboardingTelemetry/{sessionId}` | Telemetria flusso onboarding | solo owner | client (owner) | |
| `users/{userId}/signals/{signalId}` | Segnali di gusto (azioni su titoli) | solo owner | client (owner, create-only nelle rules) | trigger `updateTasteProfileOnSignal` → `usersPrivate.tasteProfile` |
| `users/{userId}/tasteProfile/{docId}` | Profilo di gusto aggregato (legacy, vedi nota) | solo owner | client (owner) | **nota**: il taste profile "vero" oggi vive in `usersPrivate/{uid}.tasteProfile` (onboarding); questa subcollection è un residuo, verificare consumer prima di rimuoverla |
| `users/{userId}/quizAttempts/{attemptId}` | Tentativi quiz individuali | solo owner | client (owner, full CRUD) | trigger `onQuizAttemptCreated` → leaderboard legacy |
| `users/{userId}/quizStats/{docId}` | Contatori quiz cache (XP, streak, bonus) | qualunque loggato | client (owner, delta per-write limitato) | anche leggibile via collection-group per la classifica |
| `users/{userId}/quizStats/{docId}` (collection-group `{path=**}/quizStats`) | — | qualunque loggato | n/a | abilita query collectionGroup per la leaderboard |

### Identità pubblica / privata

| Path | Contenuto | Read | Write | Note |
|---|---|---|---|---|
| `usernames/{displayNameLower}` | Prenotazione handle univoco → uid | qualunque loggato | client (owner del doc, unicità enforced) | |
| `usersPrivate/{userId}` | Dati privati: `tasteProfile`, `onboardingStatus` | solo owner | client (owner) — **nessuna validazione di schema** | full read/write senza validatori, a differenza di `users/` |
| `usersPrivate/{userId}/integrations/{docId}` | Token OAuth (Trakt access/refresh/device code) | **deny-all** | **deny-all** | solo Cloud Functions Admin SDK; segreti, mai esposti al client owner |

### Catalogo

| Path | Contenuto | Read | Write | Note |
|---|---|---|---|---|
| `titles/{titleId}` | Titolo (film/serie), metadati TMDB + moderazione + aggregati | **pubblico** (anche sloggati) | client loggato (create, `status` in `[pending,approved]`); update: admin pieno, trusted senza campi server-owned | vedi campi denormalizzati §3.4 |
| `genres/{genreId}` | Tassonomia generi | pubblico | trusted | |
| `contentCategories/{categoryId}` | Tassonomia categorie contenuto | pubblico | trusted | |
| `metadataIssues/{issueId}` | Problemi di metadati rilevati (es. runtime mancante) | trusted/admin | **deny-all** | coda di lavoro per `recomputeTitleStatesFromTitleMetrics` |
| `people/{personId}` | Attori/registi | pubblico | trusted (create/update), admin (delete) | |
| `titleEdits/{editId}` | Proposte di modifica ai metadati titolo | qualunque loggato | create qualunque loggato; update trusted/admin; delete admin | |
| `upcoming_manual/{docId}` | Prossime uscite gestite a mano | pubblico | admin/trusted | |
| `titleUpdateEvents/{eventId}` | Timeline persistente trailer/teaser/uscite/episodi | pubblico solo se `status=published` | **deny-all** | writer/scanner Admin SDK; id deterministico, URL HTTPS allow-listed, backfill mai notificabile |

### Voti, emozioni, social

| Path | Contenuto | Read | Write | Note |
|---|---|---|---|---|
| `ratings/{ratingId}` | Voto 1-10 + recensione, livello title/season/episode | qualunque loggato | client (owner, id libero ma `uid`/`titleId`/`level` frozen post-create) | vedi §3.5 |
| `titleEmotions/{emotionId}` | Reazione emotiva post-visione ("che impressione hai avuto") | qualunque loggato | client (owner, **doc id vincolato**) | vedi §3.6 |
| `episodeEmotions/{emotionId}` | Reazione emotiva riferita a un episodio preciso | qualunque loggato | client (owner, **doc id vincolato**) | vedi §3.6.1 |
| `titles/{titleId}/episodeEmotionAggregates/{season}_{episode}` | Aggregato community delle emozioni di un episodio | qualunque loggato | **deny-all** | scritto da `recomputeEpisodeEmotionAggregate` |
| `recommendations/{recId}` | Consiglio titolo tra utenti, con link a thread | mittente/destinatario/admin | client (create rate-limited 50/finestra, update state machine) | |
| `threads/{threadId}` | Conversazioni (pubbliche per titolo, DM, gruppi, supporto) | pubbliche a tutti i loggati, private ai partecipanti | client (create), update solo per 2 transizioni ammesse | vedi §3.7 |
| `threads/{threadId}/messages/{messageId}` | Messaggi | come il thread padre | client (create), update solo `reactions` | |
| `threads/{threadId}/typing/{typingUid}` | Indicatore "sta scrivendo" | come il thread padre | client (autore) | |
| `posts/{postId}` | Post feed social (testo, share) + **eco dei commenti** dei thread pubblici | dipende da `visibility` (public/friends/private/comment) | client (owner); gli eco solo admin SDK | campi ufficiali (`isOfficialUpdate`, ecc.) e di provenienza (`sourceKind`, `sourceThreadId`, `sourceMessageId`, `spoilerScope`, `textTruncated`) bloccati lato client |
| `posts/{postId}/likes/{likeUid}` | Like a un post | chi accede al thread post | client (proprio like) | |
| `posts/{postId}/comments/{commentId}` | Commenti a un post | chi accede al thread post | client (create); delete autore/autore post/admin | |
| `posts/{postId}/comments/{commentId}/likes/{likeUid}` | Like a un commento | chi accede al thread post | client (proprio like) | |
| `posts/{postId}/shares/{shareId}` | Evento di condivisione post | qualunque loggato | client (autore) | |
| `ratingFeed/{eventId}` | Thread di discussione ancorato a un voto | qualunque loggato (`get` diretto) | **deny-all** sul doc radice | doc radice mantenuto da `syncRatingFeedThreadDoc`; like/commenti sotto sono client-writable |
| `ratingFeed/{eventId}/likes/{likeUid}` | Like sul voto | qualunque loggato | client (proprio like) | |
| `ratingFeed/{eventId}/comments/{commentId}` | Commenti sul voto | qualunque loggato | client (create); delete autore/admin | |
| `ratingFeed/{eventId}/comments/{commentId}/likes/{likeUid}` | Like su un commento voto | qualunque loggato | client (proprio like) | |
| `feedEvents/{eventId}` | Feed home per-utente, append-only | solo il proprietario dell'evento | **deny-all** | scritto da 5 trigger `on*FeedEvent` (§3.3) |

### Liste

| Path | Contenuto | Read | Write | Note |
|---|---|---|---|---|
| `userLists/{listId}` | Lista utente/watchlist v2 (privacy + membership) | owner/membri/admin (+ compat legacy pubbliche, vedi nota) | client (create solo-owner-membro; update owner/editor/admin) | vedi §3.8, `followersCount`/`slug`/`editorial*` server-owned |
| `userLists/{listId}/items/{titleId}` | Titolo nella lista | chi legge il contenuto (pubblico o membro) | client (editor) | |
| `userLists/{listId}/members/{memberId}` | Membri con ruolo | chi legge la lista | client solo per creare il membro owner iniziale | editor/viewer aggiunti via update del doc radice, non qui |
| `userLists/{listId}/progress/{memberId}` | Progresso di completamento per membro | chi legge la lista | **deny-all** (create/update); delete owner/admin | ricalcolato da trigger/callable |
| `publicUserLists/{listId}` | Proiezione pubblica server-owned delle liste `visibility=="public"` | qualunque loggato | **deny-all** | trigger `syncPublicUserListProjection` |

### Quiz

| Path | Contenuto | Read | Write | Note |
|---|---|---|---|---|
| `quizQuestions/{questionId}` | Domanda quiz + risposta corretta | loggato, solo `status in [approved, beta_pending_review]` | admin | |
| `quizMeta/{docId}` (doc `themes`) | Aggregato pubblico titoli con quiz giocabile | **pubblico** | **deny-all** | ricostruito da `rebuildQuizThemes`/`scheduledRebuildQuizThemes` |
| `quizChallenges/{challengeId}` | Sfida tra utenti (interna o esterna via link) | mittente/destinatario/admin | client (solo `inviteType:"internal"`); esterne solo server | |
| `quizInvites/{inviteId}` | Token invito esterno (hash) | **deny-all** | **deny-all** | solo Cloud Functions `quizInvite.js` |
| `quizQuestionReports/{reportId}` | Segnalazione utente su una domanda | admin | client (create) | |
| `leaderboard_weekly/{leaderboardUid}` | Bucket leaderboard settimanale (legacy) | pubblico | admin (in pratica solo trigger) | mantenuta da `onQuizAttemptCreated`; UI oggi usa collectionGroup `quizStats` |
| `leaderboard_allTime/{leaderboardUid}` | Bucket leaderboard all-time (legacy) | pubblico | admin | idem |

### Piattaforme streaming, governance, contenuti

| Path | Contenuto | Read | Write | Note |
|---|---|---|---|---|
| `leaderboard/{docId}` (doc `global`) | Classifica creator (top raters/adders) | qualunque loggato | **deny-all** | `computeGlobalLeaderboard`, 24h |
| `events/{docId}` | Banner home | qualunque loggato | admin | |
| `reports/{reportId}` | Segnalazioni abuso (utente/post/commento/thread) | admin | client (create, rate-limit 20/finestra) | |
| `moderationQueue/{queueId}` | Coda anti-spoiler auto-checker | admin | **deny-all** | popolata dai 4 trigger `flagSuspected*` |
| `experiments/{docId}` (solo `global`) | Feature flag/experiments | tutti (solo doc `global`) | admin | |
| `blogPosts/{slug}` | Articoli blog DB-driven | pubblico se `published`, trusted/admin se draft | admin | |
| `importMatchCache/{cacheKey}` | Cache cross-utente match titolo per import | **deny-all** | **deny-all** | keyed per hash titolo normalizzato, no PII |
| `importMatchTicks/{tickId}` | Continuazione worker import resumable | **deny-all** | **deny-all** | |
| `appConfig/{docId}` | Config app (es. `guidedProfiles`) | admin | **deny-all** | |
| `guidedProfiles/{guidedUid}` | Profili guidati (account supervisionati) | admin | **deny-all** | |
| `guidedContentDrafts/{draftId}` | Bozze contenuto profili guidati | admin | **deny-all** | |
| `guidedProfileRuns/{runId}` | Log esecuzioni attività profili guidati | admin | **deny-all** | |
| `guidedDmAttempts/{attemptId}` | Tentativi DM verso profili guidati | admin | **deny-all** | |

### Collection senza blocco `match` dedicato (coperte solo dal default-deny finale)

Nota 2026-07-12: `officialUpdates/{slug}` ha ora un match esplicito (read admin, write server-only) e `guestRateLimits/{counterId}` un deny-all esplicito — vedi `firestore.rules`.

Esistono nel codice (scritte da Cloud Functions via Admin SDK, che bypassa le rules) ma **non compaiono affatto in `firestore.rules`**: sono comunque "nelle rules" nel senso che il catch-all finale `match /{document=**} { allow read, write: if false; }` le nega totalmente ai client. Nessun client (nemmeno admin via SDK client-side) può leggerle o scriverle; solo Admin SDK server-side.

| Path | Contenuto | Scritta da |
|---|---|---|
| `tmdbCache/{cacheKey}` | Cache risposte TMDB (TTL 24h) | quasi tutte le funzioni TMDB (`tmdbProxy`, `enrichTitleAssets`, `refreshTitleFromTmdb`, ...); pulita da `cleanupTmdbCache` |
| `titleProviders/{titleId}` | Cache provider streaming per titolo (TTL 7gg) | `getWatchProviders`, `scanTitleUpdates` |
| `titleProviders/{titleId}/suggestions/{id}` | Segnalazioni utente "manca questa piattaforma" | `suggestWatchProvider` |
| `systemJobs/titleUpdateScanner` | Cursore e metriche dell'acquisizione automatica News (nessun dato utente) | `scanTitleUpdates` |
| `accountDeletionRequests/{uid}` | Richiesta di cancellazione account (audit trail GDPR) | `deleteMyAccount` |
| `_system/tmdbAutoImport` (+ `runs/{runId}`) | Report delle run schedulate di import TMDB | `importRecentTmdbTitles` via `writeTmdbImportRunReport` |
| `threads/{threadId}/_system/supportAutoReply` | Cooldown 24h della risposta automatica sui thread di supporto | `autoReplyOnSupportThreadMessage` |

**Osservazione per chi audita la sicurezza**: queste collection sono sicure *oggi* solo grazie al catch-all implicito, non per una regola esplicita e commentata come `importMatchCache`/`quizInvites`/`moderationQueue`. Consigliato aggiungere un blocco esplicito deny-all con commento (stesso pattern) per rendere l'intento verificabile a colpo d'occhio e testabile in `rules.spec.cjs` — vedi §7.

## 3. Sezioni di dettaglio

### 3.1 `users/{userId}` — doc radice

Campi principali: `displayName`, `displayNameLower` (regex `^[A-Za-z0-9]([._-]?[A-Za-z0-9])*$`, 3-24 char), `photoURL`/`avatarURL`, `trusted`, `isAdmin`, `level` (`base` di default), `verified` (badge, indipendente da `trusted`), `stats` (`ratingsCount`, `reviewsCount`, `watchedCount`, `totalWatchMinutes`, `rewatchCount`, `titlesCreated`, `derivedRatingsCount`, `byCategory`), `followersCount`, `friendsCount`, `accountType` (`real_user`/`guided_profile`), `isSynthetic`, `bio`, `onboardingStatus`/`tasteProfile` (legacy, vedi nota `usersPrivate`).

Invarianti:
- **Signup** (`create`): `trusted`/`isAdmin` devono essere `false`/assenti, `level` deve essere `base`/assente, `stats` deve nascere a zero (`userStatsZeroOnCreate`), `followersCount`/`friendsCount` a zero, `accountType`/`isSynthetic` reali (`guidedFieldsRealOnCreate`).
- **Update owner**: non può cambiare `trusted`/`isAdmin`/`level`; `stats`/`followersCount`/`friendsCount` **congelati** (`userServerCountersUnchanged`); `accountType`/`isSynthetic`/`bio` congelati (`guidedFieldsUnchanged`).
- **Admin**: può scrivere qualunque campo.
- **`stats.followersCount`/`stats.friendsCount`**: congelati nelle rules ma **nessun trigger attuale li incrementa** (verificato: nessun trigger su `users/{uid}/friends` o `users/{uid}/followers` scrive sul doc padre). Campi riservati/non ancora collegati — non affidarcisi per contatori reali oggi.
- **`stats.titlesCreated`**: mantenuto da `incrementCreatorTitlesCount`/`decrementCreatorTitlesCount` (onCreate/onDelete su `titles/{titleId}`) e `syncCreatorTitlesCountOnStatus` (onUpdate, quando lo status cambia).
- **`stats.watchedCount`/`totalWatchMinutes`/`rewatchCount`/`ratingsCount`**: `recomputeUserStatsFromTitleStates` (onWrite `titleStates`) + `recomputeUserStatsFromListProgress` (onWrite `listProgressEntries`), delta incrementali O(1). Anti-drift: `reconcileUserStats` (schedulata settimanale) + callable `recomputeUserStats`.
- **`stats.derivedRatingsCount`**: `recomputeUserDerivedRating` (onWrite `ratings`).

### 3.2 `users/{userId}/titleStates/{titleId}` — stato di visione

Schema (`validTitleStateDoc`): `titleId` (== id doc), `mediaType` (`movie`/`tv`), `state` (`unseen`/`seen_unrated`/`rated`/`not_started`/`in_progress`/`completed_unrated`), `generalWatchlist:bool`, `rewatchIntent:bool`, `hasTitleRating:bool`, `ratingValue:number|null`, `seenAt`/`completedAt`/`ratedAt`/`rewatchAddedAt`/`createdAt`/`updatedAt`/`lastInteractionAt` (timestamp o null), `source:string` (es. `import_tvtime_gdpr`, usato per sopprimere fan-out sociale su bulk import), `seriesProgress:map`, `completedCount:number`, `watchMinutesContribution:number`, `schemaVersion:number`, `reminders:map`, `titleSnapshot:map` (denorm minimale per liste veloci).

Scritture: `applyTitleStateAction` (callable, transazione — mark visto/watchlist/rating), `syncTitleStateFromTitleRating` (trigger da `ratings`), `recomputeTitleStatesFromTitleMetrics` (trigger da `titles`, ripara `watchMinutesContribution` quando cambiano le metriche di durata, pilotato dalla coda `metadataIssues`), import pipeline (batch da `confirmTitlesImport`/`finalizeTitlesImportUpload`/`runImportMatchTick`), `migrateUserWatchlistV2` (migrazione da `watchlist`/`library` legacy).

Ogni scrittura server-side di `titleStates` aggiorna in coppia (stesso batch) la proiezione legacy `users/{uid}/library/{titleId}` (`buildLegacyLibraryProjection` in `functions/lib/titleStates.js`) — non è un trigger separato, è scrittura sincrona nello stesso batch di chi tocca `titleStates`.

Guardia costi: `onSeriesStartedFeedEvent` (trigger feed) e i trigger `notifyFriendsOnRating`/social salta i titleStates/ratings con `source` che inizia per `import_` (bulk import non deve spammare feed/notifiche amici).

#### 3.2.1 `_system/productTracking` — milestone tracker minimizzate

Documento server-only, deny-all ai client anche owner/admin. Non è anonimo: il path è associato all'UID, quindi è dato personale pseudonimo. Non contiene `titleId`, testo, sorgente UI, stagione o episodio.

Campi v1: `schemaVersion`, `cohortOrigin` (`prospective`/`legacy_backfill`), `migrationVersion`, `firstSuccessfulImportAt`, `lastSuccessfulImportAt`, `firstManualProgressAt`, `lastManualProgressAt`, `firstManualProgressAfterImportAt`, `firstManualProgressAtOrAfterD1`, `firstManualProgressAtOrAfterD3`, `firstManualProgressAtOrAfterD7`, `updatedAt`, `expiresAt`.

- `applyTitleStateAction` aggiorna le milestone **nella stessa transazione** del `titleState`, soltanto quando la firma semantica del progresso aumenta; no-op, watchlist, reset e correzioni verso il basso non contano.
- La classificazione dipende dal tipo azione server-side, mai dal `source` controllabile dal client.
- I due terminal path degli import registrano min/max degli import riusciti con almeno un titolo scritto. Lo script `functions/scripts/backfill-product-tracking-import-cohorts.js` semina solo la baseline legacy, senza inventare milestone storiche.
- `computeProductMetricsSnapshot` legge i doc privati e scrive in `productMetrics` solo aggregati. Le soglie indicano adozione ritardata (≥24/72/168 ore), non retention in una finestra esatta.
- Export GDPR: campo `productTracking` esplicito. Delete account: già coperto da recursive delete di `_system`. Retention: `expiresAt` circa 13 mesi, con cleanup nello snapshot giornaliero.

### 3.3 Notifiche e feed

`users/{uid}/notifications/{id}` è **create: deny-all lato client** — ogni notifica nasce da uno dei trigger in `functions/modules/notifications.js` (registrati con `region europe-west1`): `notifyOnFollow`, `notifyOnFriendRequest`, `notifyOnFriendAccept`, `notifyOnRecommendation`, `notifyAdminOnUserSignup`, `notifyPendingTitle`, `notifyPendingEdit`, `notifyOnQuizChallengeCreate`, `notifyOnQuizChallengeComplete`, `notifyOnReportCreate`, `pushOnNotificationCreate` (invia la push FCM, non scrive Firestore), `notifyOnThreadMessage`, `notifyOnThreadReaction`, `notifyOnThreadMentions`, `notifyOnPostCreateMentions`, `notifyOnPostLike`, `notifyOnPostComment`, `notifyOnPostCommentLike`, `notifyOnRatingLike`, `notifyOnRatingComment`, più `cleanupDuplicateNotificationToken` (dedup token FCM). A questi si aggiungono i job schedulati `sendInactivityNudges`, `sendWatchlistReminders`, `sendFriendActivityDigest` e la callable `claimQuizExternalInvite`. Il client può solo marcare `read:true` e cancellare le proprie.

Nei thread pubblici, `notifyOnThreadMessage` avvisa gli autori distinti dei 300 messaggi precedenti più recenti (massimo 50 destinatari), escludendo mittente, utenti già coperti da una mention e coppie bloccate. Un cooldown globale di 30 secondi per mittente limita il fan-out; le ultime 100 decisioni evento sono conservate nel doc server-only `users/{senderUid}/_system/publicThreadFanout` per retry idempotenti. Messaggi importati con id deterministico o timestamp storico non generano notifiche. `notifyOnThreadReaction` accetta soltanto l'aggiunta autenticata di una singola reazione canonica al commento di un altro utente e usa un id logico deterministico, quindi rimuovere e riaggiungere la stessa reazione non produce spam.

`feedEvents/{id}` (home feed) è interamente append-only e server-owned, scritto da 5 trigger: `onRatingCreatedFeedEvent`, `onRatingUpdatedFeedEvent` (entrambi su `ratings`), `onSeriesStartedFeedEvent` (su `users/{uid}/titleStates`, con guardia anti bulk-import), `onPostCreatedFeedEvent` (su `posts`), `onFollowCreatedFeedEvent` (su `users/{uid}/following`), `onPostCommentCreatedFeedEvent` (su `posts/{id}/comments`). `onRecommendationCreatedFeedEvent` è un no-op esplicito: le recommendation restano private, mai nel feed home.

### 3.4 `titles/{titleId}` — campi denormalizzati

Oltre ai metadati TMDB standard (`name`, `nameLower`, `posterPath`, `overview`, `genres[]`, `castIds[]`, `directorIds[]`, `search.tokens[]`, `tmdbId`/`meta.tmdbId`, `status`, `createdAt`), i campi server-owned interessanti:

- **`ratingAggregate`** — `{ titleLevel:{sum,count,avg}, bySeason:{"1":{...},...}, combined:number, updatedAt }`. Mantenuto da `recomputeTitleRatingAggregate` (trigger `ratings` onWrite, delta transazionale O(1)). `combined` pesa ogni voto 1, a qualunque livello.
- **`emotionAggregate`** — `{ counts:{...solo valori >0}, totalSelections, totalUsers, updatedAt }`. Mantenuto da `recomputeTitleEmotionAggregate` (trigger `titleEmotions` onWrite).
- **`slug`** — url leggibile (`/film/{slug}` o `/serie/{slug}`), assegnato una tantum da `onTitleCreatedSlug` (onCreate). Congelato per i trusted in update.
- **`altNamesLower[]`** — nomi alternativi normalizzati (titolo originale + alternative titles IT/US/GB, cap 10) usati dal matching import. Mantenuto da `buildTmdbTitleRefreshPatch` (tutti e 3 i path di enrichment: import stub, `refreshTitleFromTmdb`, `enrichTitleAssets`).
- **`watchProviderLogos`** — `[{name, logoUrl}]` — e **`watchProviderNames`** — `[string]`, la versione solo-nomi più vecchia — denormalizzati insieme dalla callable `getWatchProviders` e dal job `scanTitleUpdates` durante il giro progressivo del catalogo.
- **`tmdbSync.syncDisabled`** — se `true`, il titolo è immune a qualunque sync TMDB (merge manuale). `mergedTmdbIds:[int]` — id TMDB assorbiti in questo doc dopo un merge manuale; consultato da `linkPersonToTitles`/`importRecentTmdbTitles`/dedup logic per non ricreare stub duplicati.
- **`status`**: solo `pending`/`approved` ammessi in create; nessun altro valore vincolato nelle rules per update (l'admin può settare quello che vuole; niente `rejected`/`flagged` osservato nel codice attuale).

### 3.5 `ratings/{ratingId}` — voti

Id convention: `<uid>__<titleId>__<level>__<season|0>__<episode|0>` (garantisce 1 voto per utente per item; helper `makeRatingId`/`makeRatingID` lato client, non enforced dalle rules sul formato dell'id — solo sui campi).

Schema: `uid`, `titleId`, `rating:number [1,10]`, `level ∈ {title, season, episode}`, `season`/`episode:number>0` coerenti col level (`validRatingLevelFields`), `reviewText` opzionale ≤5000 char, `reviewPhotoUrl`/`reviewPhotoStoragePath` opzionali ≤2000 char, `mediaUrls:list`, `watchedWith:list`, `watchedWithGroup:map`, `createdAt`/`updatedAt`.

Su ogni write (`onWrite`) si attivano in parallelo: `syncRatingFeedThreadDoc` (mirror/elimina `ratingFeed/{eventId}`), `syncTitleStateFromTitleRating` (propaga a `titleStates`), `recomputeTitleRatingAggregate` (denorm su `titles`), `recomputeUserDerivedRating` (rollup privato su `derivedRatings`); su `onCreate`/`onUpdate` separati: `notifyFriendsOnRating`, `onRatingCreatedFeedEvent`/`onRatingUpdatedFeedEvent` (feed home).

### 3.6 `titleEmotions/{emotionId}` — emozioni post-visione

Id vincolato **nella rule stessa**: `emotionId == uid + "__" + titleId + "__title__0__0"` — impossibile creare più doc per lo stesso titolo/utente (anti-gonfiaggio aggregato). Livello fisso `title` in v1 (formato pronto per stagioni). `emotions:list` 1-3 elementi **unici**, whitelist chiusa: `shocked frustrated sad reflective touched amused scared bored understood thrilled confused tense`. `isSynthetic` (profili guidati) non è tra le keys ammesse in `validEmotionDoc` → un client non può nemmeno provare a impostarlo.

### 3.6.1 `episodeEmotions/{emotionId}` — emozioni del singolo episodio

Collection additiva e distinta da `titleEmotions`: un'impressione generale sulla serie non viene attribuita retroattivamente a un episodio. L'id è vincolato nelle rules a `<uid>__<titleId>__episode__<season>__<episode>`; `level` è sempre `episode`, stagione ed episodio sono interi positivi e restano immutabili dopo la create. `emotions` contiene 1-3 chiavi canoniche uniche della stessa whitelist di `titleEmotions`; array vuoto significa cancellazione del documento.

Il trigger gen2 `recomputeEpisodeEmotionAggregate` (`europe-west1`) applica un delta O(1) a `titles/{titleId}/episodeEmotionAggregates/{season}_{episode}` con schema `{counts,totalSelections,totalUsers,updatedAt}`. Il bucket è leggibile dagli utenti autenticati ma interamente server-owned. I documenti sintetici scritti via Admin SDK non entrano nell'aggregato. Non esiste backfill: i dati title-level legacy restano semanticamente separati e il nuovo aggregato nasce dai soli salvataggi episodio.

### 3.7 `threads/{threadId}` — messaggistica

3 varianti a create-time, tutte validate da `validThreadCreateData`:
- **pubblico** (`visibility:"public"`, `contextType:"public"`): id deve iniziare con `public_`, `participants` vuoto, richiede `titleId`.
- **DM** (`visibility:"private"`, `contextType:"dm"`): `participants.size()==2`, l'autore deve essere tra i partecipanti, `groupName:""`.
- **gruppo** (`visibility:"private"`, `contextType:"group"`): `participants.size()>=2`.

`lastMessageAt`/`lastMessagePreview`/`lastSenderUid`/`lastMessageId` nascono vuoti/null e sono aggiornabili **solo** in coppia con la creazione di un messaggio reale (`validThreadMessageMetadataUpdate`, verifica via `getAfter` che il messaggio referenziato esista davvero). L'unico altro update ammesso sul doc thread è l'aggiunta di **un solo membro per write** a un gruppo (`validGroupMembershipUpdate`, esclusi i thread `support_*`). Sui messaggi, l'unico campo mutabile dopo la creazione sono le `reactions`.

Thread di supporto: `support_{uid}` creati da `ensureMySupportThread`/`ensureUserDocsOnAuthCreate`; `autoReplyOnSupportThreadMessage` risponde in automatico con cooldown 24h (stato in `threads/{id}/_system/supportAutoReply`, non coperto da rule dedicata — vedi §2). `sendThreadMessage` (callable) scrive messaggi server-side quando serve bypassare write diretto client.

### 3.8 `userLists/{listId}` — liste/watchlist v2

Root doc: `ownerUid`, `title` (2-80 char), `description` (≤280), `visibility ∈ {private,public,shared}`, `kind ∈ {collection,ordered_path}`, `memberUids`/`editorUids`/`viewerUids`, `cover:map`, `itemTitleIds`/`previewTitleIds` (cap 500), `itemCount`/`completedCount`, `slug`/`editorialSlug`/`editorial` (server-owned), `followersCount` (server-owned).

Create: la lista nasce **solo con il creatore come unico membro** (`memberUids == [uid()]`); editor/viewer si aggiungono dopo via update (flow inviti), per impedere di preinserire utenti che non hanno accettato. `itemTitleIds`/`cover`/`itemCount` possono nascere già popolati (max 500) perché sono contenuto scelto dal creatore stesso, non dati altrui.

Update: 3 varianti alternative — admin (tutto), owner (`title`/`description`/`visibility`/`kind`), editor non-owner (`title`/`description`/`kind`, non `visibility`). In tutti i casi `followersCount` è frozen.

**Compat legacy**: `allow list: if isSignedIn() && resource.data.visibility == 'public'` riespone il root doc (incl. `memberUids`) a query dirette sulla root da build iOS ≤1.2.11 (App Store 1.2.3) — da rimuovere quando quella coorte è su build ≥1.3.0, i dati pubblici passano normalmente da `publicUserLists`.

Trigger collegati: `onUserListCreatedSlug` (slug), `syncPublicUserListProjection` (proietta/rimuove da `publicUserLists`), `syncListFollowersCount` (su `users/{uid}/savedLists` onWrite, incrementa/decrementa il target), `onUserListItemWrittenProgress`/`onUserListMemberWrittenProgress` (ricalcolo progress), `cleanupSavedListsOnListDelete`/`cleanupDeletedUserListCover` (onDelete, pulizia cascata + Storage).

### 3.9 Quiz

`quizQuestions` è contenuto moderato (AI/seed), read filtrata a `status in [approved, beta_pending_review]` — le query per id/titleId che non filtrano lato query possono fallire se il batch include doc `pending`/`flagged` (TODO noto in PWA/iOS). `quizMeta/{themes}` è l'aggregato pubblico (nessuna risposta dentro) usato dal picker temi, anche per i guest.

`quizChallenges`: create client-side ammessa solo per `inviteType:"internal"` (sfide tra amici Somto); le sfide esterne (link di invito a chi non è su Somto) sono create server-side da `quizInvite.js` (`createQuizExternalInvite`/`claimQuizExternalInvite`/`finalizeQuizExternalChallenge`) e il token vive in `quizInvites` (deny-all totale ai client, anche in lettura — il token grezzo non è mai esposto lato Firestore).

`users/{uid}/quizStats/{docId}`: `quizStatsDeltaOk` limita ogni singola write a un delta plausibile-per-partita (`totalScore`/`weeklyScore` +50, `xp` +200, `attemptsCount` +5, `correctCount`/`wrongCount`/`skippedCount` +50, `dailyStreak`/`bestDailyStreak` +1, `dailyBonusGames` +5) — anti-cheat rules-level, non elimina il rischio ma lo rende rate-limitabile/rilevabile. Leaderboard corrente: query collectionGroup su `quizStats` (`weekKey`+`weeklyScore`); `leaderboard_weekly`/`leaderboard_allTime` sono legacy, ancora mantenute da `onQuizAttemptCreated` ma non più il path di lettura primario.

### 3.10 Import pipeline: `users/{uid}/imports/{importId}`

Job doc con lifecycle interamente server-owned (`allow write: if false` sia sul job che su `items`/`payload`). Due modalità di trasporto del payload sorgente:
- **Body callable inline** (`startTitlesImport`) — per CSV piccoli (Netflix, TV Time GDPR sotto soglia).
- **Upload Storage** (`createTitlesImportUploadSession` → upload diretto browser/app su `/manualImports/{userId}/{importId}/{fileName}` → `finalizeTitlesImportUpload`) — obbligatorio per TV Time Refract e per qualunque file oltre ~900KB, perché un doc/body Firestore ha un tetto ~1MB.

Per i due formati TV Time che condividono gli slot `movies`/`series`, il server
valida la struttura effettiva (array JSON Refract oppure header CSV GDPR),
corregge `source` quando il formato valido è stato selezionato nella UI
sbagliata e conserva `requestedSource`, `detectedSource` e
`sourceAutoDetected` per audit. Payload misti, malformati o ambigui falliscono
senza avviare il matching.

Prima di modificare qualsiasi `titleState`, il server crea documenti immutabili
in `previousStates/{titleId}`, compreso il sentinel `existed:false` per titoli
senza stato precedente. Le scritture sono create-only e un errore interrompe
l'import prima delle mutazioni. Il parent espone solo il marker versionato
`previousStateSnapshot` (`storage:"subcollection_v1"`, `schemaVersion`, `status`,
`count`, `capturedAt`, `verifiedAt`); i legacy con `previousStateSnapshots` inline restano
invariati e non richiedono backfill. Le snapshot sono dati forensi di recovery,
non un rollback completo delle proiezioni derivate, e vengono incluse
nell'export GDPR; la cancellazione account le rimuove tramite `recursiveDelete`.

Stati tipici del job (`status`): `queued` → `matching` (o `uploading` mentre i file Storage arrivano) → `awaiting_confirmation` (match ambigui da risolvere) → `enriching` → `done`/`failed`. Il matching gira a **tick resumabili**: `processQueuedTitlesImport` (trigger onCreate) arma il primo tick, `runImportMatchTick` (trigger onCreate su `importMatchTicks/{tickId}`, finestra 540s) processa un batch e si ri-arma finché non finisce, `reviveStalledTitlesImports` (schedulata ogni 10 minuti) ripara chain rotte o marca `failed` gli import abbandonati oltre una soglia. `confirmTitlesImport` (callable) applica le scelte dell'utente sui match ambigui e scrive il batch finale di `titleStates`/`library`/`watchlist`/`ratings`/`titleEmotions`/`episodeViews`/`userLists` a seconda del contenuto sorgente.

Cache di supporto, entrambe deny-all client: `importMatchCache/{cacheKey}` (match titolo↔TMDB cross-utente, keyed per hash del titolo normalizzato — chi importa per secondo su un titolo già visto da un altro utente non ripaga il costo del matching) e `importMatchTicks/{tickId}` (doc di continuazione del worker, effimero).

Import Trakt: OAuth device flow via `startTraktConnect`/`pollTraktConnect`/`startTraktImport`/`disconnectTrakt`, token access/refresh **mai** in un doc leggibile dal client — vivono solo in `usersPrivate/{uid}/integrations/trakt` (deny-all anche per l'owner, letto solo da Admin SDK).

Notifiche collegate: `notifyAdminsSupportUpload` (trigger Storage `onFinalize` su `supportImports/{uid}/...`, unica funzione rimasta su `us-central1`) avvisa gli admin quando un utente usa la via di recupero manuale.

### 3.11 Moderazione anti-spoiler

4 trigger `onCreate` identici nel pattern, uno per superficie di contenuto — `flagSuspectedSpoilerThreadMessage` (`threads/{tid}/messages/{mid}`), `flagSuspectedSpoilerPost` (`posts/{id}`), `flagSuspectedSpoilerComment` (`posts/{pid}/comments/{cid}`), `flagSuspectedSpoilerRecommendation` (`recommendations/{id}`) — ognuno esce subito se `containsSpoiler === true` (già dichiarato dall'autore), altrimenti passa il testo a `modules/spoilerChecker.js` (`looksLikeSpoiler`, regex deterministica IT + anchor per titolo) e se trova un match scrive un doc in `moderationQueue` (`type:"spoiler_suspect"`, `status:"pending"`, preview 280 char, `matchedPattern`/`matchedText`, `docPath` del contenuto originale). La chiusura passa sempre dalla callable admin `confirmSpoilerSuspect`: se `decision:"confirmed"` promuove il doc originale a `containsSpoiler:true` (retroattivo — il blur si attiva anche su contenuto già pubblicato).

### 3.12 Funzioni schedulate (`pubsub.schedule`)

| Funzione | Frequenza | Cosa fa |
|---|---|---|
| `sendInactivityNudges` | ogni 24h | notifica gli utenti inattivi da più di qualche giorno (cooldown proprio) |
| `sendWatchlistReminders` | ogni 24h | promemoria watchlist per utenti "leggermente disimpegnati" con titoli in sospeso |
| `sendFriendActivityDigest` | ogni 168h (settimanale) | digest attività amici recenti |
| `cleanupOldNotifications` | ogni 24h | elimina `notifications`/`signals` scaduti (TTL), via collectionGroup |
| `cleanupTmdbCache` | ogni 24h | elimina `tmdbCache` scaduto (TTL 24h) |
| `reviveStalledTitlesImports` | ogni 10 minuti | watchdog import bloccati (riarma o marca `failed`) |
| `reconcileUserStats` | ogni 168h (settimanale) | ricalcolo integrale `users.stats` (safety net anti-drift) |
| `scheduledRebuildQuizThemes` | ogni 24h | ricostruisce `quizMeta/themes` |
| `computeGlobalLeaderboard` | ogni 24h | ricalcola `leaderboard/global` |
| `importRecentTmdbTitles` | `0 2,10,18 * * *` (Europe/Rome) | importa titoli recenti/random da TMDB in `titles` |
| `generateTitlesSitemap` | ogni 24h (Europe/Rome) | rigenera la sitemap titoli su Cloud Storage (nessuna scrittura Firestore) |
| `runGuidedProfileActivity` | `0 11,19 * * *` (Europe/Rome) | esegue l'attività simulata dei profili guidati (voti/post/commenti/like), gate da `appConfig/guidedProfiles` |

### 3.13 Funzioni callable per area (Firestore-facing)

| Area | Callable |
|---|---|
| Import libreria | `startTitlesImport`, `createTitlesImportUploadSession`, `finalizeTitlesImportUpload`, `confirmTitlesImport`, `startTraktConnect`, `pollTraktConnect`, `startTraktImport`, `disconnectTrakt`, `migrateUserWatchlistV2` |
| Titoli/TMDB | `refreshTitleFromTmdb`, `enrichTitleAssets`, `linkPersonToTitles`, `getWatchProviders`, `suggestWatchProvider`, `tmdbProxy`, `adminBackfillTitleMetadata` (admin) |
| Stato di visione | `applyTitleStateAction`, `detectNewSeasonsForUser`, `recomputeUserStats` |
| Liste | `recomputeListProgress`, `uploadUserListCover` |
| Quiz | `rebuildQuizThemes` (admin), `getGuestQuiz`, `submitGuestQuiz`, `createQuizExternalInvite`, `claimQuizExternalInvite`, `finalizeQuizExternalChallenge` |
| Chat/community | `ensureMySupportThread`, `sendThreadMessage` |
| Match/consigli (sola lettura, zero scritture Firestore) | `getMatchQueue`, `recommendTitlesByTaste` |
| Account | `deleteMyAccount` |
| Admin/moderazione | `confirmSpoilerSuspect`, `backfillTasteSignals`, `getPersonalAdminAnalytics` (sola lettura, allowlist email), `publishOfficialUpdate`/`unpublishOfficialUpdate`, `setGuidedProfilesConfig`, `runGuidedProfileActivityNow` |
| Profilo pubblico (codebase `publicprofile`, sola lettura) | `getPublicProfileActivitySummary`, `getPublicProfileSeriesProgress`, `getTitleWatchersProgress` |

### 3.14 Cheat-sheet enum ed id compositi

| Campo | Valori ammessi | Dove |
|---|---|---|
| `titleStates.state` | `unseen`, `seen_unrated`, `rated`, `not_started`, `in_progress`, `completed_unrated` | `users/{uid}/titleStates/{titleId}` |
| `listProgressEntries.state` | `not_started`, `in_progress`, `completed` | `users/{uid}/listProgressEntries/{entryId}` |
| `ratings.level` | `title`, `season`, `episode` | `ratings/{ratingId}` |
| `titles.status` | `pending`, `approved` (solo questi vincolati in create; l'admin può settare altro in update) | `titles/{titleId}` |
| `userLists.visibility` | `private`, `public`, `shared` | `userLists/{listId}` |
| `userLists.kind` | `collection`, `ordered_path` | `userLists/{listId}` |
| `threads.visibility` | `public`, `private` | `threads/{threadId}` |
| `threads.contextType` | `public`, `dm`, `group` | `threads/{threadId}` |
| `quizChallenges.status` | `pending`, ... (transizioni gestite server-side per le esterne) | `quizChallenges/{challengeId}` |
| `quizChallenges.inviteType` | `internal` (client), esterne solo server | `quizChallenges/{challengeId}` |
| `recommendations.status` | `unread` → `seen` → `archived` (solo avanti, mai indietro) | `recommendations/{recId}` |
| `friends.status` | `pending` → `accepted` \| `blocked` | `users/{uid}/friends/{friendUid}` |
| `posts.kind` | `post`, `share` | `posts/{postId}` |
| `posts.visibility` | `public`, `friends`, `private` (default `public` se assente), `comment` (eco di un commento thread: leggibile da chi e' loggato, scrivibile solo dall'admin SDK — valore separato da `public` perche' i client vecchi che non conoscono il gate anti-spoiler per progresso interrogano solo `public`) | `posts/{postId}` |
| `blogPosts.status` | `draft`, `published` | `blogPosts/{slug}` |
| `imports.status` | `queued`, `uploading`, `matching`, `awaiting_confirmation`, `enriching`, `done`, `failed` | `users/{uid}/imports/{importId}` |

Id compositi (mai auto-generati, calcolati per garantire unicità/idempotenza):
- `ratings/{ratingId}` = `<uid>__<titleId>__<level>__<season|0>__<episode|0>`
- `titleEmotions/{emotionId}` = `<uid>__<titleId>__title__0__0` (vincolato nella rule stessa, non solo per convenzione client)
- `episodeEmotions/{emotionId}` = `<uid>__<titleId>__episode__<season>__<episode>` (vincolato nella rule stessa)
- `users/{uid}/notifications/{notificationId}` per alcuni tipi usa id deterministici (es. `official_update_{slug}`) per garantire "una sola notifica per evento", non un id random

## 4. Denormalizzazioni intenzionali

| Campo/collection | Dove | Perché | Chi la mantiene | Backfill/reconcile |
|---|---|---|---|---|
| `titles/{id}.ratingAggregate` | titles | evitare fan-in su ogni lettura scheda titolo/SSR (JSON-LD AggregateRating) | trigger `recomputeTitleRatingAggregate` (delta O(1)) | `scripts/backfill-titleRatingAggregate.cjs` |
| `titles/{id}.emotionAggregate` | titles | idem, per il grid emozioni community | trigger `recomputeTitleEmotionAggregate` | `scripts/backfill-titleEmotionAggregate.cjs` |
| `titles/{id}/episodeEmotionAggregates/{season}_{episode}` | sottocollezione title | evitare fan-in per le emozioni del singolo episodio | trigger gen2 `recomputeEpisodeEmotionAggregate` (delta O(1)) | nessuno intenzionalmente: niente inferenza da `titleEmotions` |
| `titles/{id}.slug` | titles | URL leggibile/SEO, redirect 301 dal docId | trigger `onTitleCreatedSlug` (one-shot su create) | `functions/scripts/backfill-title-slugs.js` |
| `titles/{id}.altNamesLower` | titles | matching import senza query TMDB ripetute | `buildTmdbTitleRefreshPatch` su ogni path enrichment | `functions/scripts/backfill-title-altnames.js` |
| `titles/{id}.watchProviderLogos`/`.watchProviderNames` | titles | evitare round-trip TMDB ad ogni render "dove guardarlo" | callable `getWatchProviders` (best-effort su cache-hit, stesso `set` per entrambi i campi) | `functions/scripts/backfill-watch-provider-names.js` |
| `titles/{id}.mergedTmdbIds` | titles | tracciare id TMDB assorbiti in un merge manuale, evitare stub duplicati | admin manuale/script (`fix-rome-empire-titles.js`, `dedup-titles.js`), consumato da `linkPersonToTitles`/`importRecentTmdbTitles` | nessuno strutturale, operazione ad-hoc |
| `users/{uid}.stats` | users | evitare scan `titleStates`/`ratings` ad ogni visita profilo | `recomputeUserStatsFromTitleStates`, `recomputeUserStatsFromListProgress`, `incrementCreatorTitlesCount`/`decrementCreatorTitlesCount`/`syncCreatorTitlesCountOnStatus`, `recomputeUserDerivedRating` | `functions/scripts/recompute-user-stats.js` + schedulata `reconcileUserStats` (settimanale, safety net) |
| `users/{uid}/_system/productTracking` | users/_system | milestone minimizzate per misurare adozione manuale post-import senza event log per titolo | `applyTitleStateAction` + terminal path import; aggregazione giornaliera in `productMetrics` | `functions/scripts/backfill-product-tracking-import-cohorts.js` (dry-run default, rollback sicuro) |
| `users/{uid}/library/{titleId}` | users | proiezione legacy per tab "Visti" pre-`titleStates` | scrittura sincrona nello stesso batch di chi tocca `titleStates` (`buildLegacyLibraryProjection`, non un trigger separato) | `functions/scripts/migrate-legacy-library-to-titlestates.js` (utenti legacy library-only) |
| `userLists/{listId}.followersCount` | userLists | contatore follower senza scan `savedLists` cross-utente | trigger `syncListFollowersCount` (su `users/{uid}/savedLists` onWrite) | `functions/scripts/backfill-list-followers.js` |
| `userLists/{listId}.slug`/`editorialSlug` | userLists | URL leggibile `/lista/{slug}`, SSR indicizzabile | trigger `onUserListCreatedSlug` | `functions/scripts/backfill-list-slugs.js` |
| `publicUserLists/{listId}` | root collection | separare i dati pubblici dalla root privata (privacy: root ha `memberUids` ecc.) | trigger `syncPublicUserListProjection` (onWrite `userLists`) | `functions/scripts/backfill-public-user-lists.js` |
| `userLists/{listId}.itemCount`/`completedCount` | userLists | evitare COUNT() su `items`/`progress` ad ogni render lista | client a create-time + callable `recomputeListProgress` + trigger `onUserListItemWrittenProgress`/`onUserListMemberWrittenProgress` | ricalcolo on-demand via callable |
| `quizMeta/themes` | root doc | listing completo + ricerca titoli quiz in 1 read (anche per i guest) | callable admin `rebuildQuizThemes` + schedulata `scheduledRebuildQuizThemes` (24h) | `functions/scripts/rebuild-quiz-themes.js` |
| `leaderboard_weekly`/`leaderboard_allTime` | root collection | leaderboard quiz pre-collectionGroup (legacy, ancora scritta) | trigger `onQuizAttemptCreated` (su `users/{uid}/quizAttempts` onCreate) | nessuno (path di lettura sostituito da collectionGroup `quizStats`) |
| `leaderboard/global` | root doc | classifica creator/rater senza scan `users` ad ogni richiesta | schedulata `computeGlobalLeaderboard` (24h, rigenerata ex-novo ogni run) | nessuno (rigenerazione totale ad ogni run) |
| `users/{uid}/derivedRatings/{titleId}` | users | media privata episodio→stagione/serie, non inquina il voto pubblico | trigger `recomputeUserDerivedRating` (onWrite `ratings`) | `scripts/backfill-derivedRatings.cjs` — **nota**: feature in codice, rollout end-to-end non ancora completo (vedi CLAUDE.md pending) |
| `usersPrivate/{uid}.tasteProfile` | usersPrivate | profilazione gusto senza esporre segnali grezzi in `users` pubblico | trigger `updateTasteProfileOnSignal` (onCreate `users/{uid}/signals`) | callable admin `backfillTasteSignals` (ripopola `signals` da storico ratings/matchFeedback/watchlist) |
| `titleStates.watchMinutesContribution`/`seriesProgress` | titleStates | cache minuti visti/progresso senza ricalcolo runtime ad ogni read | client + auto-repair `recomputeTitleStatesFromTitleMetrics` (su `titles` onWrite, quando cambia la durata) | `functions/scripts/backfill-watch-minutes.js`, `enrich-missing-durations.js` |
| `officialUpdates/{slug}` + `posts` (isOfficialUpdate) | root + posts | pubblicazione annunci ufficiali come post feed + articolo pubblico | callable admin `publishOfficialUpdate`/`unpublishOfficialUpdate` | nessuno |

## 5. Indici compositi (`firestore.indexes.json`)

**42 indici totali** (39 `COLLECTION`, 3 `COLLECTION_GROUP`: `imports`, `messages`, `quizStats`) + **14 `fieldOverrides`**.

| Collection | # indici | Campi |
|---|---|---|
| `titles` | 9 | `genres`(CONTAINS)+`ratingCount`↓; `status`+`castIds`(CONTAINS); `status`+`directorIds`(CONTAINS); `search.tokens`(CONTAINS)+`ratingCount`↓; `status`+`createdAt`↓; `status`+`nameLower`; `status`+`tmdbId`; `status`+`meta.tmdbId`; `status`+`ratingCount`↓ |
| `recommendations` | 4 | `toUid`+`createdAt`↓; `toUid`+`status`+`createdAt`↓; `fromUid`+`createdAt`↓; `status`+`toUid`+`createdAt`↓ |
| `userLists` | 4 | `memberUids`(CONTAINS)+`updatedAt`↓; `visibility`+`followersCount`↓; `visibility`+`updatedAt`↓; `visibility`+`itemTitleIds`(CONTAINS)+`followersCount`↓ |
| `quizQuestions` | 4 | `status`+`createdAt`↓; `titleId`+`status`; `spoilerLevel`+`createdAt`↓; `confidence`+`createdAt`↓ |
| `posts` | 4 | `authorUid`+`createdAt`↓; `visibility`+`createdAt`↓; `authorUid`+`visibility`+`createdAt`↓; `visibility`+`titleId`+`createdAt`↓ |
| `threads` | 2 | `participants`(CONTAINS)+`lastMessageAt`↓; `visibility`+`lastMessageAt`↓ |
| `quizChallenges` | 2 | `toUid`+`createdAt`↓; `fromUid`+`createdAt`↓ |
| `imports` (COLLECTION_GROUP) | 1 | `status`+`updatedAt` — necessario perché `reviveStalledTitlesImports` interroga tutti gli import di tutti gli utenti |
| `messages` (COLLECTION_GROUP) | 1 | `uid`+`createdAt`↓ |
| `quizStats` (COLLECTION_GROUP) | 1 | `weekKey`+`weeklyScore`↓ — la leaderboard settimanale |
| `ratings` | 1 | `uid`+`level` |
| `feedEvents` | 1 | `ownerUid`+`createdAt`↓ |
| `titleEdits` | 1 | `status`+`createdAt`↓ |
| `publicUserLists` | 1 | `itemTitleIds`(CONTAINS)+`followersCount`↓ |
| `titleStates` | 1 | `mediaType`+`state` |
| `leaderboard_weekly` | 1 | `weekKey`+`score`↓ |
| `blogPosts` | 1 | `status`+`publishedAt`↓ |

**`fieldOverrides`** (indici single-field espliciti, spesso per abilitare/disabilitare collectionGroup):
- `savedLists.listId` — ASC su COLLECTION_GROUP e COLLECTION (serve al trigger `syncListFollowersCount`/backfill per query cross-utente su un listId specifico).
- `quizStats.totalScore` — DESC/ASC su entrambi gli scope (leaderboard all-time via collectionGroup).
- `users.stats.titlesCreated` — DESC/ASC su COLLECTION (query dirette per `computeGlobalLeaderboard`).
- `messages.uid` — ASC su COLLECTION_GROUP + ASC/DESC su COLLECTION.

Prima di deployare una query nuova con `where`/`orderBy` su campi combinati, verificare qui — Firestore rifiuta la query a runtime se manca l'indice, e il fix richiede un deploy `firestore:indexes` che impiega minuti/ore per costruirsi su collection grandi.

## 6. Storage (`storage.rules`)

Bucket unico, root `/b/{bucket}/o`. Helper: `isSignedIn()`, `isOwner(userId)`, `isImageUpload()` (`image/.*`), `isJsonUpload()` (`application/json.*`), `isCsvUpload()` (`text/csv.*`), `canReadListCover(listId)`/`canEditListCover(listId)` (quest'ultima definita ma **non usata** in nessun match — entrambi i path `listCovers` sono `write,delete: if false` incondizionato), `userImportPath`/`canWriteManualImportUpload`.

| Path | Read | Write | Limite size | Content-type |
|---|---|---|---|---|
| `/avatars/{userId}/{fileName}` | pubblico | owner | < 2 MB | `image/.*` |
| `/posters/{userId}/{rest=**}` | pubblico | owner | < 6 MB | `image/.*` |
| `/reviewPhotos/{userId}/{rest=**}` | pubblico | owner | < 6 MB | `image/.*` |
| `/listCovers/{listId}/{fileName}` | pubblico/membro/owner della lista (`canReadListCover`) | **deny-all** (solo backend/admin) | — | — |
| `/listCovers/{userId}/{listId}/{fileName}` (legacy) | idem | **deny-all** | — | — |
| `/peopleAvatars/{personId}/{fileName}` | pubblico | qualunque loggato | < 300 KB | `image/jpeg|jpg|png|webp|gif` (**SVG escluso esplicitamente**, rischio XSS) |
| `/peopleAvatars/{fileName}` (flat, legacy) | pubblico | **deny-all** | — | — |
| `/users/{userId}/{rest=**}` (legacy) | pubblico | owner | < 2 MB | `image/.*` |
| `/manualImports/{userId}/{importId}/{fileName}` | owner | owner, **solo se** `users/{userId}/imports/{importId}.status=="uploading"` esiste | < 50 MB | whitelist filename per formato: `movies.json`/`series.json` (JSON), `movies.csv`/`series.csv`/`episode_votes.csv`/`movie_ratings.csv`/`movie_votes.csv`/`movie_comments.csv`/`episode_comments.csv`/`lists.csv`/`netflix.csv` (CSV) |
| `/supportImports/{userId}/{fileName}` | owner | owner | < 30 MB | nessun vincolo (MIME variabile per ZIP: `application/zip`, `x-zip-compressed`, o vuoto su iOS Safari) |
| `/{allPaths=**}` | **deny-all** | **deny-all** | — | — |

Il path `/manualImports` esiste perché i payload di import (TV Time Refract JSON, TV Time GDPR CSV, Netflix CSV) superano il limite ~1MB di un doc Firestore/body callable: il client carica su Storage, poi una Cloud Function (`createTitlesImportUploadSession`/`finalizeTitlesImportUpload`) finalizza server-side. `/supportImports` è la via di recupero manuale quando il flusso automatico si inceppa (l'utente carica l'export grezzo, un admin lo processa via script/Admin SDK).

## 7. Regole d'oro per chi modifica lo schema

1. **Mai scrivere dal client un campo server-owned.** Se un campo è congelato in una `allow update` (pattern `next.get('x', d) == prev.get('x', d)`) è perché un trigger/callable lo mantiene altrove — bypassarlo via un altro percorso client rompe l'invariante e falsifica dati (contatori, aggregati, leaderboard).
2. **Ogni nuova collection richiede rules esplicite.** Il default è deny (`match /{document=**} { allow read, write: if false; }`). Una collection scritta solo da Cloud Function funziona anche senza un blocco dedicato (§2, "senza blocco match dedicato"), ma **aggiungilo comunque** con un commento che spiega chi scrive e perché è deny-all — è quello che rende l'intento verificabile e testabile, non solo "funziona per caso".
3. **Aggiornare `firestore.indexes.json` PRIMA di deployare una query nuova** con `where`/`orderBy` composito o `array-contains`. Una query senza indice fallisce a runtime in prod, non in review.
4. **Testare in emulatore prima del deploy**: `cd functions && npm run test:rules` (avvia `firebase emulators:exec --only firestore,storage` e gira `test/rules.spec.cjs`). `npm run test:unit` per la logica dei trigger/callable (`test/unit/*.test.cjs`). `npm test` fa entrambi in sequenza. Usare JDK 21 per l'emulatore Firestore/Storage (versioni più vecchie danno errori di avvio non riconducibili alle rules stesse) — non dedurre il comportamento di una rule, verificarlo sempre in emulatore prima del deploy.
5. **Non fidarsi del client per privacy/ownership/permessi** — ogni check di autorizzazione deve vivere nelle rules o in una callable con verifica esplicita di `context.auth`/`isAdmin`, mai solo nella UI.
6. **Le collection senza validazione di schema sono un rischio silenzioso.** `usersPrivate/{userId}` e le proiezioni legacy `library`/`watchlist` permettono al client owner di scrivere qualunque shape — se aggiungi un consumer che si fida ciecamente di questi campi, valida lato lettura o aggiungi validatori alle rules.
7. **Backfill/reconcile vanno eseguiti nell'ordine giusto**: prima il deploy del trigger che mantiene un campo denormalizzato, poi lo script di backfill one-shot (altrimenti il trigger sovrascrive/combatte con dati non ancora coerenti). Gli script sono in `functions/scripts/` (dry-run di default, `--write` per applicare) e in `scripts/` root (`.cjs`, stesso pattern).
8. **Non toccare Firestore schema/rules/indexes/Cloud Functions senza una proposta esplicita di sicurezza e migrazione** (vedi `CLAUDE.md`) — coinvolgere Database Architect + Security/Privacy Reviewer per qualunque cambio che tocchi ownership, permessi o PII.
9. **Verificare lo stato deployato prima di diagnosticare un bug di produzione.** Prod può divergere da quanto committato in `main` (deploy fatti da worktree isolate, sessioni parallele, deploy targeted parziali). Scaricare il ruleset live (console Firebase → Firestore → Rules → cronologia, o API Firebase Rules REST) prima di assumere che il file nel repo rispecchi prod.
10. **Un nuovo trigger su `ratings`/`titleStates` deve escludere esplicitamente il traffico da import bulk.** Il campo `source` (es. `import_tvtime_gdpr`) marca le scritture generate da import massivi; i trigger di feed/notifica lo controllano (`isBulkImportRatingSource`) per non spammare migliaia di eventi durante un'ondata di import — già successo una volta, vedi nota di progetto `firestore_cost_import_wave`.
