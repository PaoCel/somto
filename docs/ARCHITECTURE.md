# Architettura Somto

Somto è un'app per tenere traccia di cosa guardi (film/serie TV), votare, scoprire titoli con amici e giocare a quiz. Documento verificato leggendo il codice reale del repo il 2026-07-12.

## Panoramica

Tre superfici client + un backend Firebase condiviso:

- **PWA** (`public/`): multipagina HTML **vanilla JS**, nessun framework/bundler in produzione — ES modules importati direttamente dal browser, Firebase Web SDK **10.12.5** caricato da CDN `https://www.gstatic.com/firebasejs/10.12.5/...`. Ogni pagina è un `.html` a sé (`home.html`, `title.html`, `quiz*.html`, `thread.html`, ecc.) con un controller `.page.js` dedicato. Servita da Firebase Hosting.
- **App iOS** (`ios/TwoWatch/`): SwiftUI, iOS 17+, Swift 6. Il progetto Xcode **non è committato a mano**: è generato da XcodeGen a partire da `ios/project.yml` (`cd ios && xcodegen generate`). Bundle id `com.paolocelestini.twowatch.ios`, team `787YK9YUB3`.
- **Backend Firebase**, progetto `gia-visto`: Firestore, Auth, Storage, Cloud Functions Node 22, Hosting. Le Cloud Functions vivono in **due codebase separate** dichiarate in `firebase.json`:
  - `functions/` → codebase `default`, regione `europe-west1`, **80 export** in `functions/index.js` (file singolo, ~12.5k righe) più moduli in `functions/modules/` e `functions/lib/`.
  - `functions-public-profile/` → codebase `publicprofile`, 3 callable (`getPublicProfileActivitySummary`, `getPublicProfileSeriesProgress`, `getTitleWatchersProgress`), sempre `europe-west1`. Package Node separato con proprio `package.json`/`node_modules`.
- **Blog editoriale** (`blog/`): progetto **Eleventy** a parte (non fa parte del runtime buildless della PWA). Sorgenti Markdown in `blog/src/articoli/`, build (`npm run build`) genera HTML statico dentro `public/blog/`, che **viene committato** nel repo principale ed è servito da Hosting come contenuto statico.

Non esiste un bundler/framework SPA per il web: ogni `.html` in `public/` carica i propri script `type="module"` e importa da `public/js/`. Non c'è build step per il web in produzione (esistono script `build:pwa`/`watch:pwa` con esbuild nel `package.json` root, usati solo per bundling opzionale, non parte del deploy standard).

## Struttura directory

### `public/` (PWA)

- `public/*.html` — una pagina per superficie (`home.html`, `title.html`, `quiz*.html`, `thread.html`, `user.html`, `import.html`, landing marketing `*-film-serie*.html`, ecc.). Niente router SPA: navigazione = link/redirect HTTP reali tra file.
- `public/js/api/` (34 file) — **data layer**: un modulo per dominio (`titleStates.api.js`, `titles.api.js`, `quiz.api.js`, `imports.api.js`, `library.api.js`, ecc.), wrappa letture/scritture Firestore dirette e le chiamate alle Cloud Functions callable.
- `public/js/pages/` (33 file) — **controller per pagina** (`home.page.js`, `title.page.js`, `quiz-setup.page.js`, ecc.), montati dalle rispettive `.html`: leggono lo stato via `js/api/*`, gestiscono eventi DOM, orchestrano i componenti.
- `public/js/components/` (13 file) — componenti UI riusabili tra pagine (`appShell.js` per header+tabbar, `quizTitlePicker.js`, `spoilerGate.js`, `composerSpoiler.js`, ecc.).
- `public/js/services/` — `auth.service.js` (login Google/Apple/email, gestione redirect vs popup).
- `public/js/utils/` — helper puri senza stato Firebase (`tabbar.bootstrap.js`, `tvTimeZip.js` mini-unzip client, `displayMode.js`, `inviteShare.js`, ecc.).
- `public/js/firebase.js` — inizializzazione unica dell'app Firebase Web SDK (vedi "Flussi chiave").
- `public/firebaseConfig.js` — config Firebase pubblica (non è un segreto: è codice client), con switch prod/staging per hostname.
- `public/css/` — `variables.css` (design token, allineati a `TwoWatchTheme.swift` lato iOS), `base.css`, `theme.css`, più `css/components/` e `css/pages/` per stili scoped.
- `public/service-worker.js` — cache tiered (shell/runtime/images) con una costante `VERSION` da bumpare a ogni release di asset (attualmente `v108-...`).
- `public/blog/` — output statico del progetto Eleventy in `blog/` (committato, non editare a mano).

### `functions/` (Cloud Functions, codebase `default`)

- `functions/index.js` — entrypoint unico: importa gli helper da `lib/`, registra i moduli da `modules/`, dichiara trigger/callable/scheduled function con `.region("europe-west1")`. 80 `exports.*`.
- `functions/modules/` — funzionalità auto-contenute che si "registrano" su `index.js` tramite una factory (`registerNotifications`, `registerQuizLeaderboard`, `registerQuizInvite`, `registerTitlePage`, `registerQuizPage`, `registerListPage`, `registerGuidedProfiles`, `registerOfficialUpdates`) più moduli usati direttamente:
  - `notifications.js` — creazione/gestione notifiche in-app + push FCM.
  - `quizLeaderboard.js` — trigger su ogni `quizAttempts` che aggiorna `leaderboard_weekly`/`leaderboard_allTime` (legacy: la classifica live oggi legge via `collectionGroup` su `quizStats`).
  - `quizInvite.js` — inviti esterni al quiz (utenti non Somto) via token, landing HTTP `quizInvitePreview`.
  - `titlePage.js` / `listPage.js` / `quizPage.js` — SSR pubblico (vedi sotto).
  - `guidedProfiles/` — sotto-package dei profili guidati (persona, config, generatore contenuti, routine di attività).
  - `officialUpdates.js` — publish/unpublish changelog ufficiale in-app (solo admin).
  - `publicUserLists.js` — proiezione pubblica denormalizzata delle liste utente.
  - `titleSlug.js` / `listSlug.js` — calcolo slug deterministico per URL `/film|serie/{slug}` e `/lista/{slug}`.
  - `tmdb.js` — proxy/cache verso l'API TMDB (circuit breaker incluso).
  - `spoilerChecker.js` — matcher regex deterministico per sospetti spoiler nei contenuti social.
- `functions/lib/` — logica pura/condivisa, pensata per essere testata senza emulatore: `titleStates.js` (stato titolo/watchlist), `userStats.js`, `feedEvents.js`, `leaderboard.js`, `watchProviders.js`, `tmdbDurations.js`, `rateLimiter.js`, `emotionAggregate.js`, `episodeEmotionAggregate.js`, `derivedRatingAggregate.js`, `circuitBreaker.js`, `officialUpdates.js`, `titleStatesBackfill.js`, e la sottocartella `importAdapters/` (parser Netflix/TV Time GDPR/TV Time Refract/Trakt + matching TMDB, tutti puri/testabili).
- `functions/test/unit/*.test.cjs` — 416 unit test (`node --test`, nessun emulatore).
- `functions/test/rules.spec.cjs` — 120 test sulle Firestore/Storage rules (richiede emulatore Firestore+Storage).
- `functions/scripts/` — script one-off/admin (backfill, audit, migrazioni), eseguiti con `firebase-admin` e credenziali ADC, mai automatici.

Nel solo `index.js` (senza contare le funzioni registrate dai moduli) si contano circa: 32 callable (`.https.onCall`), 13 trigger `onWrite`, 18 `onCreate`, 2 `onUpdate`, 3 `onDelete`, 10 funzioni schedulate (`pubsub.schedule`) e alcune HTTP dirette (`onRequest`); i moduli SSR (`titlePage`, `listPage`, `quizPage`, `quizInvite`) aggiungono altre funzioni HTTP proprie.

### `functions-public-profile/` (codebase `publicprofile`)

Package Node **separato** (proprio `package.json`, `node_modules`, `package-lock.json`), un solo file `index.js` (~200 righe). Espone 3 callable read-only che leggono dati **owner-only** di un altro utente (progresso serie, watchers, activity summary) bypassando le rules perché girano con l'Admin SDK — la logica di chi può vedere cosa è quindi nel codice della function, non nelle rules.

### `ios/TwoWatch/`

- `App/` — entry point (`TwoWatchApp.swift`), `AppContainer.swift` (dependency injection: istanzia tutti i repository), `SessionStore.swift` (utente corrente, stato auth), `AppShellStore.swift` (stato di navigazione/presentazione globale).
- `Core/` — `Extensions/`, `Utilities/` trasversali.
- `Data/` — `Firebase/` (`FirebaseConfig.swift` + `CloudFunctionsCaller.swift`), `Repositories/` (12 file: `AuthenticationRepository`, `UserRepository`, `TitleRepository`, `WatchlistRepository`, `QuizRepository`, `ThreadsRepository`, `MatchRepository`, `HomeRepository`, `NotificationRepository`, `PostsRepository`, `SocialInboxRepository`, `TitlesImportRepository`), `Analytics/`, `Import/` (parser ZIP TV Time lato iOS).
- `Domain/` — `Models/` (struct dei documenti Firestore), `Services/`.
- `DesignSystem/` — `Components/`, `Theme/` (`TwoWatchTheme.swift`, allineato a `public/css/variables.css`).
- `Features/` — una cartella per area prodotto: `AppShell`, `Home`, `Match`, `Watchlist`, `Quiz`, `Profile`, `Community`, `Search`, `Threads`, `TitleDetail`, `PostDetail`, `Onboarding`, `Notifications`, `Import`, `Auth`, `Admin`. Ogni repository è iniettato via `AppContainer` e usato dalle view/viewmodel della feature corrispondente.

### Firestore / config di deploy (root)

- `firestore.rules` — regole di sicurezza (unico file, >100KB), organizzato per collection con helper condivisi (`isSignedIn()`, `isOwner()`, ecc. in testa al file).
- `firestore.indexes.json` — indici compositi.
- `storage.rules` — regole Storage.
- `firebase.json` — config Hosting (headers, rewrites verso le Cloud Functions SSR) + dichiarazione delle 2 codebase functions + porte emulatori.
- `firebase.staging.json` — variante Hosting-only per l'ambiente staging (niente rewrites verso functions: su staging le Functions non sono deployate).
- `.firebaserc` — alias progetto: `default`/`prod`/`production` → `gia-visto`, `staging` → `somto-staging`.

## Modello dati (Firestore) — collection principali

Ricavato direttamente dai `match` di primo livello in `firestore.rules`. Solo un riepilogo: la fonte di verità per i vincoli esatti resta il file rules.

**Utenti e identità**
- `users/{uid}` — profilo pubblico, letto ovunque; i contatori (`stats`) sono server-owned.
- `usersPrivate/{uid}` — dati privati owner-only; sottocollezione `integrations/{docId}` (token OAuth Trakt) è **deny-all anche per il proprietario**, scritta solo da Cloud Functions.
- `usernames/{displayNameLower}` — riserva atomica dell'handle univoco (transazione lato client, sia web sia iOS).

**Catalogo**
- `titles/{titleId}` — documento titolo (film/serie), lettura pubblica; aggregati denormalizzati (`ratingAggregate`, `emotionAggregate`, `watchProviderLogos`, ecc.) server-owned. Le emozioni episodio usano bucket server-owned separati in `episodeEmotionAggregates/{season}_{episode}`.
- `genres/{genreId}`, `contentCategories/{categoryId}`, `people/{personId}` — tassonomie/anagrafiche, lettura pubblica, scrittura riservata a utenti `trusted`.
- `titleEdits/{editId}` — proposte di modifica ai titoli (creazione libera per chi è loggato, approvazione trusted/admin).
- `metadataIssues/{issueId}` — coda interna di problemi metadati (es. TMDB mancante), solo lettura trusted/admin.
- `upcoming_manual/{docId}` — override manuali per "titoli in arrivo", lettura pubblica.

**Attività personale sul titolo** (sotto `users/{uid}/...`)
- `library/{titleId}`, `watchlist/{entryId}` — proiezioni legacy di sola lettura del catalogo personale.
- `titleStates/{titleId}` — **fonte di verità** dello stato personale (visto/da vedere/voto/progresso serie), include `seriesProgress` e `watchMinutesContribution`.
- `derivedRatings/{titleId}` — roll-up privato episodio→stagione→serie.
- `savedLists/{listId}`, `listProgressEntries/{entryId}` — liste salvate/seguite e relativo progresso personale.
- `episodeViews/{viewId}` — vista per singolo episodio.
- `imports/{importId}` (+ `items/`, `payload/`) — stato di un import (Netflix/TV Time/Trakt) e i suoi item.
- `rateLimits/{action}` — contatori atomici anti-abuso lato server.

**Social**
- `threads/{threadId}` (+ `messages/{messageId}`) — DM e discussioni pubbliche per titolo.
- `posts/{postId}` (+ `likes/`, `comments/{commentId}` con proprie `likes/`, `shares/`) — post del feed.
- `recommendations/{recId}` — consigli diretti tra utenti.
- `feedEvents/{eventId}` — feed "server-driven" append-only, lettura solo del proprio `ownerUid`.
- `ratingFeed/{eventId}` — thread di commenti/like sotto un voto.
- `reports/{reportId}` — segnalazioni abuso, rate-limited.
- `moderationQueue` — coda di revisione (es. spoiler sospetti), solo admin.

**Liste**
- `userLists/{listId}` (+ `progress/{memberId}`) — liste custom (private/condivise/pubbliche).
- `publicUserLists/{listId}` — proiezione pubblica denormalizzata (lettura signed-in, scrittura solo server).

**Quiz**
- `quizQuestions/{questionId}` — banca domande, lettura filtrata su status giocabile (`approved`/`beta_pending_review`).
- `quizMeta/{docId}` — aggregato pubblico dei titoli con quiz (nessuna risposta dentro), lettura pubblica, scrittura solo server.
- `users/{uid}/quizAttempts`, `users/{uid}/quizStats` — tentativi e statistiche per utente; `quizStats` leggibile anche via `collectionGroup` per la classifica globale.
- `quizChallenges/{challengeId}`, `quizInvites/{inviteId}` (deny-all client, solo Cloud Functions), `quizQuestionReports/{reportId}` — sfide tra utenti, inviti esterni, segnalazioni domande.

**Profili guidati** (contenuto sintetico, mai reale)
- `guidedProfiles/{uid}`, `guidedProfileRuns`, `guidedContentDrafts`, `guidedDmAttempts` — tutte scritte solo da Cloud Functions.

**Import: infrastruttura condivisa**
- `importMatchCache/{cacheKey}` — cache cross-utente del matching TMDB per import, deny-all client.
- `importMatchTicks/{tickId}` — checkpoint del worker di matching resumabile a tick.

**Config, operazioni, contenuti**
- `appConfig/{docId}`, `experiments/{docId}` — feature flag e config runtime (letti anche dal client dove serve, es. `experiments/global`).
- `events/{docId}` — banner Home, gestiti da admin.
- `officialUpdates/{slug}` — changelog ufficiale in-app, gestito via callable admin (`publishOfficialUpdate`/`unpublishOfficialUpdate`); i client ricevono l'annuncio tramite le notifiche generate dal publish, non leggendo direttamente questa collection.
- `leaderboard/{docId}`, `leaderboard_weekly`, `leaderboard_allTime` — leggibili da chi è loggato, scrittura solo Cloud Functions; le ultime due sono legacy (la classifica quiz oggi usa `collectionGroup` su `quizStats`).
- `blogPosts/{slug}` — articoli blog gestiti anche via Firestore (oltre alla build statica Eleventy) per contenuti DB-driven; i draft sono visibili solo a trusted/admin.

## Flussi chiave

### Pagina web → Firestore

`public/js/firebase.js` è il punto di inizializzazione unico, importato (direttamente o transitivamente) da ogni pagina:

1. `ensureFirebaseConfig()` si assicura che `window.firebaseConfig` esista, caricando `/firebaseConfig.js` se la pagina non lo ha già incluso in `<head>`.
2. `public/firebaseConfig.js` sceglie la config in base all'hostname: `somto-staging.web.app`/`somto-staging.firebaseapp.com` → progetto `somto-staging`, **qualsiasi altro host** (incluso `somto.it`, `gia-visto.web.app`, `localhost`) → progetto prod `gia-visto`.
3. Se l'URL ha `?emulators=1` (o `localStorage.__2WATCH_USE_FIREBASE_EMULATORS__ === "1"`), `firebase.js` reindirizza Auth/Firestore/Storage SDK verso `127.0.0.1` sulle porte degli emulatori (`connectAuthEmulator`/`connectFirestoreEmulator`/`connectStorageEmulator`). Il flag persiste in `localStorage`; `?emulators=0` lo rimuove.
4. `db`/`auth`/`storage`/`app` vengono esportati come moduli ES **e** appesi a `window` per i pochi helper legacy che li leggono da lì.

Le pagine leggono/scrivono Firestore quasi sempre tramite `public/js/api/*.js` (mai query ad-hoc sparse nei controller pagina), che importano `db` da `firebase.js` e usano le funzioni Firestore modulari (`doc`, `getDoc`, `query`, `where`, `onSnapshot`, ecc.).

### Pagina web → Cloud Functions

Per le callable, ogni modulo `api` che ne ha bisogno crea il proprio client:

```js
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";
const functions = getFunctions(app, "europe-west1");
const applyTitleStateActionCallable = httpsCallable(functions, "applyTitleStateAction");
```

(esempio reale da `public/js/api/titleStates.api.js`). La regione **deve** combaciare con quella dichiarata lato backend (`europe-west1`, sempre, sia per `default` che per `publicprofile`).

### App iOS → Firestore/Auth/Storage

- `ios/TwoWatch/Data/Firebase/FirebaseConfig.swift` legge `FirebaseConfig.plist` dal bundle (chiavi: `API_KEY`, `PROJECT_ID`, `GOOGLE_APP_ID`, `GCM_SENDER_ID`, `STORAGE_BUCKET`, `FUNCTIONS_REGION`, `APP_CHECK_DEBUG_PROVIDER`, `USE_EMULATORS`, `EMULATOR_HOST`, `AUTH_PORT`, `FIRESTORE_PORT`, `FUNCTIONS_PORT`, `STORAGE_PORT`). Il plist committato nel repo punta oggi a **prod** (`gia-visto`) con `USE_EMULATORS=false`.
- I repository in `Data/Repositories/` (uno per dominio: `TitleRepository`, `WatchlistRepository`, ecc.) sono l'unico punto che parla con Firestore/Auth/Storage; le view SwiftUI non toccano mai l'SDK Firebase direttamente.

### App iOS → Cloud Functions

**Mai** usare `Functions.functions().httpsCallable(...).call(...)` (l'API async del Firebase Functions SDK per iOS) per nuove chiamate: ha un crash noto in produzione (`HTTPSCallable.SendableHTTPSCallable.call(_:)` → crash `async let` → `SIGABRT`, causa root di un crash reale confermato da crashlog TestFlight). Tutti i repository passano invece da:

```swift
// ios/TwoWatch/Data/Firebase/CloudFunctionsCaller.swift
enum CloudFunctionsCaller {
    @MainActor
    static func call(name: String, data: Any, region: String = ..., projectID: String = ...) async throws -> CallableResult
}
```

che fa **POST HTTP diretto** a `https://{region}-{projectID}.cloudfunctions.net/{name}` con `Authorization: Bearer <ID token>`, bypassando completamente l'SDK Functions. Il file `CloudFunctionsCaller.swift` documenta il motivo nel commento di testa. `TitlesImportRepository` era l'unico repository rimasto sull'`httpsCallable` async del SDK (7 call point) fino al fix che le ha migrate tutte a `CloudFunctionsCaller` — vedi changelog in `CLAUDE.md`.

### SSR pubblico via Cloud Functions

Alcune pagine pubbliche indicizzabili non sono file statici ma **Cloud Functions che renderizzano HTML server-side**, agganciate via rewrite in `firebase.json`:

| Rewrite hosting | Function | Codebase |
|---|---|---|
| `/film/**`, `/serie/**` | `titlePage` | default |
| `/sitemap-titoli.xml`, `/sitemap-titoli-index.xml`, `/sitemap-titoli-*.xml` | `sitemapTitles` | default |
| `/lista/**` | `listPage` | default |
| `/sitemap-lista.xml` | `sitemapLists` | default |
| `/quiz/invite/**` | `quizInvitePreview` | default |
| `/quiz/**` | `quizPage` | default |
| `/sitemap-quiz.xml` | `sitemapQuiz` | default |
| `/share/title/**` | `shareTitlePreview` | default |

Sono registrate dai rispettivi moduli in `functions/modules/` (`titlePage.js`, `listPage.js`, `quizPage.js`, `quizInvite.js`) e rendono HTML con JSON-LD, OG tag, 404 `noindex` per contenuto non pubblico/non approvato, redirect 301 dal vecchio docId allo slug.

### Service worker

`public/service-worker.js` ha una costante `const VERSION = "v108-..."` in testa: **va bumpata ad ogni deploy che cambia asset serviti** (JS/CSS/HTML cacheati), altrimenti i client restano sulla cache vecchia. Cache a livelli (shell/runtime/images) con eviction.

## Principi architetturali vigenti

- **Il client non è mai fidato per privacy/ownership/contatori.** Ogni vincolo di accesso (chi può leggere/scrivere cosa) è enforced da `firestore.rules`/`storage.rules` o, quando serve bypassare le rules per un caso legittimo (es. profilo pubblico di un altro utente), da una Cloud Function che usa l'Admin SDK e applica la sua propria logica di autorizzazione nel codice (vedi `functions-public-profile`).
- **Campi server-owned**: contatori e aggregati denormalizzati (`users.stats`, `titles.ratingAggregate`, `userLists.followersCount`, `titles.emotionAggregate`, ecc.) sono scrivibili **solo** da trigger/Admin SDK; le rules bloccano esplicitamente l'update di questi campi dal client (pattern `xxxServerFieldsUnchanged()` ripetuto in `firestore.rules`).
- **Denormalizzazione con trigger O(1) + reconcile.** I contatori aggregati non vengono ricalcolati per intero a ogni scrittura: un trigger `onWrite` applica solo il **delta** (es. `recomputeTitleRatingAggregate`, `recomputeUserStatsFromTitleStates`), e uno script di backfill/una funzione schedulata (`reconcileUserStats`, ecc.) ricalcola tutto da zero periodicamente come rete di sicurezza anti-drift.
- **Feature flag e config runtime** vivono in Firestore, non nel codice: collection `appConfig/{docId}` (es. `guidedProfiles`, deny-all client) ed `experiments/{docId}` (letta anche dal client per A/B/rollout, es. `experiments/global`).
- **Import e dati bulk isolati.** Le pipeline di import (Netflix CSV, TV Time GDPR/Refract, Trakt) scrivono su collection dedicate (`importMatchCache`, `importMatchTicks`, `users/{uid}/imports`) invece che toccare direttamente `titleStates`/`ratings` in un colpo solo, e i trigger social (feed/notifiche) hanno guardie esplicite anti-fan-out per non generare spam quando l'origine è un bulk import.
- **Guardrail di deploy per ambiente**: script `scripts/check-deploy-safety.mjs` (invocato dagli script `npm run deploy:staging`/`deploy:prod` in root `package.json`) blocca il deploy su staging se punta a `gia-visto` o a un progetto `demo-*`, e blocca il deploy su prod se il branch non è `main`, il working tree è sporco, o manca la conferma esplicita `CONFIRM_PROD=gia-visto`. Dettagli in `docs/ENVIRONMENTS_AND_RELEASE_GUARDRAILS.md`.

## Testing

La piramide di test riflette la separazione codice puro / codice legato a Firebase:

- **Unit test** (`functions/test/unit/*.test.cjs`, 416 test, `node --test`) — colpiscono solo `functions/lib/**` (parser import, calcolo stati, aggregati), nessun emulatore richiesto: veloci, girano anche in CI su ogni push/PR (`.github/workflows/ci.yml`, job `unit`).
- **Rules test** (`functions/test/rules.spec.cjs`, 120 test, `@firebase/rules-unit-testing`) — verificano `firestore.rules`/`storage.rules` contro scenari di autorizzazione reali, richiedono l'emulatore Firestore+Storage (quindi JDK). Job CI separato (`rules`, JDK 21 Temurin).
- **E2E** (`e2e/`, Playwright) — flusso completo browser contro gli emulatori (Auth+Firestore+Storage+Hosting, progetto `demo-2watch`), con seed dati via `e2e/scripts/seed-emulator.mjs` prima di ogni run.

Non esiste una suite di test automatica per l'app iOS in questo repo (verifica manuale su simulatore/device prima di ogni archive).

## Ambienti

- **Produzione** — progetto Firebase `gia-visto`, dominio `somto.it` (Hosting). Entrambe le codebase Functions (`default` + `publicprofile`) deployate in `europe-west1`. È l'unico ambiente su cui girano oggi sia il web sia l'app iOS (il plist iOS committato punta sempre qui).
- **Staging** — progetto Firebase `somto-staging` (creato 2026-07-12), Hosting su `somto-staging.web.app`/`.firebaseapp.com` con header `X-Robots-Tag: noindex, nofollow` (config separata `firebase.staging.json`, senza rewrites verso le functions). Sul piano Spark attuale **le Cloud Functions non sono deployate su staging**. Selezionato lato web tramite lo switch per hostname in `public/firebaseConfig.js`; lato iOS non esiste ancora una build/config staging dedicata (gap aperto, vedi `docs/ENVIRONMENTS_AND_RELEASE_GUARDRAILS.md`).
- **Emulatori locali** — porte dichiarate in `firebase.json` (non le default di firebase-tools): Auth `59099`, Firestore `58080`, Storage `58081`, Hosting `5500`, Hub `58400`, Logging `58401`. Usati dai test rules (`firebase emulators:exec`) e dalla suite e2e (progetto demo `demo-2watch`). Il web si collega agli emulatori solo se esplicitamente richiesto (`?emulators=1`); l'iOS solo se `USE_EMULATORS=true` nel `FirebaseConfig.plist` in bundle.
