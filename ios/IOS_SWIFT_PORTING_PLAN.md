# 2watch iOS: analisi, piano operativo e prompt per Codex 5.4

## 1. Sintesi del prodotto attuale

2watch non e' una semplice watchlist. E' una PWA social mobile-first per film e serie con:

- autenticazione Firebase
- profilo utente e onboarding gusti
- watchlist e libreria "visti"
- voti e recensioni
- feed social
- post, commenti, like, share
- suggerimenti ad amici
- thread pubblici, DM e gruppi
- notifiche
- match engine stile swipe deck
- sezione "In arrivo / Per te"
- import e refresh dati via TMDB

Stack attuale:

- frontend: HTML + CSS + Vanilla JS modulare
- backend: Firebase Auth, Firestore, Storage, Cloud Functions, FCM
- hosting: Firebase Hosting
- test: Playwright + emulatori Firebase

File chiave analizzati:

- `package.json`
- `functions/index.js`
- `public/js/pages/*.js`
- `public/js/api/*.js`
- `public/js/components/*.js`
- `public/css/*.css`
- `public/*.html`

## 2. Architettura funzionale dell'app web

### Navigazione principale

La tab bar ha 5 voci fisse:

1. Home
2. Match
3. Watchlist
4. Notifiche
5. Profilo

Sopra la tab bar esiste anche una shell globale con:

- menu/drawer
- ricerca overlay
- badge realtime

### Schermate principali

#### Home

File principali:

- `public/home.html`
- `public/js/pages/home.page.js`

Funzioni reali:

- feed di attivita' social
- composer per post
- mentions `@utente` e tagging `#titolo`
- visibilita' post `public/friends/private`
- like, commenti, share
- dropdown notifiche
- leaderboard
- quick action / social insight / eventi correnti

#### Search

File principali:

- `public/search.html`
- `public/js/pages/search.page.js`

Scope di ricerca:

- titoli
- utenti
- generi
- persone

Funzioni reali:

- ricerca locale Firestore
- risultati TMDB
- import on-tap da TMDB
- filtri tipo `film/serie`
- filtri ruolo `attori/registi`
- sheet generi
- filmografia persona
- entry verso "Uscite e trailer"

#### Title Detail

File principali:

- `public/title.html`
- `public/js/pages/title.page.js`

Schermata piu' ricca dell'app. Include:

- hero con poster e backdrop blur
- watchlist toggle
- share
- statistiche community/amici/esperti
- tab interne `Info / Voti / Correlati / Social`
- trailer
- watch providers
- dettagli titolo
- rating title/seasons/episodes
- recensione con testo, foto e "watched with"
- thread pubblici, DM, gruppi
- suggerimento ad amico
- titoli correlati
- editing titolo / proposta modifica
- refresh metadata da TMDB

#### Match

File principali:

- `public/match.html`
- `public/js/pages/match.page.js`

E' una feature core, non accessoria:

- deck a swipe
- gesture left/right/up/down
- azioni `skip / like / superlike / seen`
- persistenza feedback
- ragioni del match
- fallback CTA se swipe non usato

#### Upcoming / Per te

File principali:

- `public/upcoming.html`
- `public/js/pages/upcoming.page.js`

Funzione:

- feed verticale stile reel
- tab `In arrivo / Per te`
- trailer inline
- contenuti da TMDB + feed personalizzato via match engine
- open titolo / like / share / YouTube

#### Account / Watchlist / Activity

File principali:

- `public/account.html`
- `public/watchlist.html`
- `public/js/pages/account.page.js`

La pagina account accorpa tre aree:

- profilo
- watchlist
- activity

Funzioni:

- header profilo con stats
- avatar upload
- wizard identita' e gusti
- richieste amicizia
- amici / following
- watchlist con filtri e sorting
- suggerimenti ricevuti e inviati
- notification prefs
- rating sheet
- flash suggestion
- accesso moderazione

`watchlist.html` e' di fatto una variante standalone della stessa experience.

#### Notifiche

File principali:

- `public/notifications.html`
- `public/js/pages/notifications.page.js`

Funzioni:

- inbox attivita'
- filtro `tutte / non lette`
- mark all read
- badge realtime

#### Thread list + thread detail

File principali:

- `public/threads.html`
- `public/thread.html`
- `public/js/pages/threads.page.js`
- `public/js/pages/thread.page.js`

Funzioni:

- thread pubblici/privati/gruppi
- unread state
- typing
- reactions
- mentions
- add member nei gruppi

#### Auth

File principali:

- `public/login.html`
- `public/js/pages/login.page.js`

Funzioni:

- email/password
- Google login
- registrazione
- reset password
- creazione `users` doc e riserva display name

## 3. Modello dati e backend da riusare su iOS

### Collection principali Firestore

- `users`
- `usersPrivate`
- `usernames`
- `genres`
- `titles`
- `people`
- `posts`
- `ratings`
- `recommendations`
- `threads`
- `feedEvents`
- `upcoming_manual`
- `titleEdits`
- `titleProviders`
- `leaderboard`
- `tmdbCache`

### Subcollection utente

- `users/{uid}/watchlist`
- `users/{uid}/library`
- `users/{uid}/friends`
- `users/{uid}/following`
- `users/{uid}/followers`
- `users/{uid}/notifications`
- `users/{uid}/signals`
- `users/{uid}/matchFeedback`
- `users/{uid}/onboardingTelemetry`
- `users/{uid}/tasteProfile/agg`

### Cloud Functions / callable importanti

Da `functions/index.js`:

- `tmdbProxy`
- `getWatchProviders`
- `suggestWatchProvider`
- `refreshTitleFromTmdb`
- `getMatchQueue`
- `recommendTitlesByTaste`

Trigger/scheduled da tenere presenti:

- feed events su rating/post/recommendation/follow/comment
- update taste profile on signal
- compute leaderboard
- import titoli recenti da TMDB
- cleanup notifiche/cache

### Implicazione per iOS

La versione iOS non deve reinventare il backend. Deve:

- riusare schema Firestore esistente
- riusare le callable esistenti
- rispettare pagination/listener correnti
- tipizzare il modello dati lato Swift

## 4. Design system attuale da tradurre in SwiftUI

Dai file CSS emerge un linguaggio preciso:

- dark-first
- background quasi nero con radial gradient
- card glassmorphism leggere
- blur diffuso
- tab bar floating/blurred
- angoli molto arrotondati
- brand gradient caldo `coral -> pink -> purple`
- accent cyan
- tipografia molto iOS-like
- motion soft e mobile-first

Token principali:

- background base: `#0A0A0A`
- testo: `#F5F5F5`
- testo secondario: `#A8A8A8`
- brand primary: `#E91E63`
- brand secondary: `#9C27B0`
- accent: `#00D9FF`
- radius frequenti: `14 / 20 / 28`

### Cosa mantenere su iOS

- identita' visiva scura
- gradient brand
- schede glass
- hero immersive
- CTA tonde e compatte
- forte enfasi su poster, avatar, metriche, badge

### Cosa adattare in modo nativo

- usare `TabView` e `NavigationStack`, non imitare la tabbar web 1:1
- usare `sheet`, `confirmationDialog`, `Menu`, `PhotosPicker`, `ShareLink`
- usare `searchable` per la ricerca
- usare bottom sheet native per filtri, review, suggerimenti, creazione thread
- sostituire dropdown web con componenti iOS
- usare gesture + haptics nel Match

## 5. Proposta architetturale iOS

### Scelte consigliate

- target: iOS 17+
- UI: SwiftUI
- stato: Observation (`@Observable`) dove possibile
- concorrenza: async/await
- backend: Firebase iOS SDK via SPM
- auth: Firebase Auth + Google Sign-In
- immagini: caching dedicato solo se serve; partire con `AsyncImage` + layer di caching se insufficiente

### Struttura moduli consigliata

- `AppCore`
- `DesignSystem`
- `Domain`
- `Data`
- `Features/Auth`
- `Features/Home`
- `Features/Search`
- `Features/TitleDetail`
- `Features/Match`
- `Features/Upcoming`
- `Features/Notifications`
- `Features/Profile`
- `Features/Threads`
- `Features/Settings`

### Layer tecnico

- `Models`: DTO Firestore + domain model
- `Repositories`: Firestore/Functions/Storage wrappers
- `Services`: auth, notifications, deep links, media, sharing
- `ViewModels`: 1 per schermata o flow
- `Components`: card, poster, avatar, badge, segmented chips, stat tile

### Pattern di navigazione consigliato

- `TabView` con 5 tab
- `NavigationStack` indipendente per tab
- search globale come sheet o full screen search
- detail screens pushate
- composer/review/thread creation come sheet

## 6. Porting iOS: cosa fare e in che ordine

### Fase 0. Bootstrap

- creare app iOS in cartella `ios/`
- collegare Firebase
- configurare env/config
- impostare Design System SwiftUI
- impostare router/tab shell

### Fase 1. Fondamenta prodotto

- sessione utente
- auth email/password
- Google sign-in
- bootstrap profilo `users`
- tab shell con badge notifiche

### Fase 2. Search + Title come asse principale

- Search multi-scope
- import TMDB da ricerca
- Title Detail completa:
  - hero
  - watchlist
  - stats
  - trailer
  - providers
  - rating/review
  - related
  - thread/suggest

### Fase 3. Profilo e libreria personale

- Profile header
- account stats
- watchlist filtrabile
- watched list
- suggestions inbox/sent
- friend requests / friends
- notification prefs

### Fase 4. Feed social

- home feed
- composer post
- likes
- comments
- shares
- inline social cards
- leaderboard / quick insight

### Fase 5. Threads e notifiche

- notifications inbox
- thread list
- thread detail
- typing
- reactions
- mentions

### Fase 6. Personalizzazione e discovery avanzata

- Match deck
- Upcoming / Per te reel
- onboarding gusti
- analytics principali

### Fase 7. Polishing

- haptics
- skeletons
- error state persistenti
- caching immagini e pagination
- deep links
- push scaffolding FCM/APNs

## 7. Scope consigliato per v1 iOS

### In scope

- auth
- search
- title detail
- watchlist
- profile
- notifications
- threads
- home feed
- match
- upcoming

### Da rimandare a v1.1 o admin build

- moderation completa
- people avatar moderation
- strumenti di backoffice
- ottimizzazioni avanzate di analytics/experiments

## 8. Decisioni UX da imporre a Codex

- non fare una trasposizione HTML->SwiftUI
- rispettare l'identita' visiva, ma usare componenti iOS nativi
- privilegiare leggibilita', poster e gerarchia
- niente WebView salvo casi strettamente necessari:
  - trailer inline YouTube
  - eventuale fallback esterno
- i flussi complessi devono essere spezzati in sheet e sottoflussi nativi

## 9. Prompt pronto per Codex 5.4

Copiaincolla questo prompt in Codex 5.4:

```text
Hai accesso al repository 2watch e devi creare la relativa app iOS nativa in Swift, molto fedele al design e al prodotto attuale ma ottimizzata per SwiftUI e per pattern iOS reali.

Workspace:
- repository root

Obiettivo:
- creare una nuova app iOS nativa in una cartella `ios/`
- usare SwiftUI
- riusare backend e schema dati esistenti Firebase
- non fare un porting letterale di HTML/CSS/JS
- mantenere molto simili stile, gerarchia visiva e feature principali
- adattare navigazione, sheet, toolbar, ricerca e gesture al linguaggio iOS

Tecnologia richiesta:
- Swift 5.10+
- SwiftUI
- target iOS 17+
- async/await
- Observation dove sensato
- Firebase Auth
- Firestore
- Firebase Functions
- Firebase Storage
- Firebase Messaging solo come scaffolding se configurazione APNs non e' pronta
- Google Sign-In se la configurazione e' disponibile

Prima di scrivere codice, analizza questi file del progetto web:
- ./public/home.html
- ./public/title.html
- ./public/search.html
- ./public/account.html
- ./public/watchlist.html
- ./public/notifications.html
- ./public/threads.html
- ./public/thread.html
- ./public/upcoming.html
- ./public/match.html
- ./public/login.html
- ./public/js/pages/home.page.js
- ./public/js/pages/title.page.js
- ./public/js/pages/search.page.js
- ./public/js/pages/account.page.js
- ./public/js/pages/thread.page.js
- ./public/js/pages/threads.page.js
- ./public/js/pages/upcoming.page.js
- ./public/js/pages/match.page.js
- ./public/js/api/users.api.js
- ./public/js/api/titles.api.js
- ./public/js/api/watchlist.api.js
- ./public/js/api/ratings.api.js
- ./public/js/api/posts.api.js
- ./public/js/api/threads.api.js
- ./public/js/api/recommendations.api.js
- ./public/js/api/notifications.api.js
- ./public/js/api/match.api.js
- ./public/js/api/tmdb.api.js
- ./public/js/api/providers.api.js
- ./public/js/api/feed.api.js
- ./public/css/variables.css
- ./public/css/base.css
- ./public/css/pages/home.css
- ./public/css/pages/title.css
- ./public/css/pages/search.css
- ./public/css/pages/account.css
- ./public/css/pages/thread.css
- ./functions/index.js

Vincoli di prodotto:
- la tab bar deve restare a 5 sezioni: Home, Match, Watchlist, Notifiche, Profilo
- Search e Title Detail sono due feature centrali
- Title Detail deve includere almeno:
  - hero con poster/backdrop
  - watchlist
  - community/friends stats
  - trailer
  - watch providers
  - rating e review
  - related titles
  - suggest to friend
  - accesso ai thread
- Match deve essere un deck swipe nativo con gesture e haptics
- Upcoming deve essere una experience verticale immersiva stile reel ma in SwiftUI
- Profile/Watchlist deve unire header profilo, stats, watchlist, activity e recommendation inbox
- Threads e notifiche devono funzionare davvero sul backend esistente

Vincoli di design:
- mantieni il mood dark-first dell'app web
- mantieni il gradient brand caldo coral/pink/purple e l'accent cyan
- usa card con materiale/blur, bordi soft, grandi radius e look iOS premium
- evita UI generica da template
- evita di copiare fedelmente tutte le stranezze web
- usa componenti e micro-interazioni native iOS quando migliorano l'usabilita'

Traduzione UX richiesta:
- usa `TabView` + `NavigationStack`
- usa `.searchable` per la ricerca
- usa sheet native per filtri, review, compose, suggest, create thread
- usa `PhotosPicker` per avatar/review photo
- usa `ShareLink` dove possibile
- usa `refreshable` nelle liste principali
- usa `safeAreaInset` e materiali per toolbar/tab treatment

Architettura richiesta:
- separa `Domain`, `Data`, `Features`, `DesignSystem`
- crea model Swift tipizzati per le collection Firestore esistenti
- crea repository layer per:
  - auth
  - users
  - titles
  - ratings
  - watchlist
  - feed/posts
  - recommendations
  - notifications
  - threads
  - match
  - TMDB/providers
- wrappa le callable functions esistenti:
  - `tmdbProxy`
  - `getWatchProviders`
  - `suggestWatchProvider`
  - `refreshTitleFromTmdb`
  - `getMatchQueue`
  - `recommendTitlesByTaste`

Roadmap di implementazione:
1. bootstrap progetto iOS e design system
2. auth + sessione utente + profilo base
3. shell a tab + badge notifiche
4. search + title detail
5. profile/watchlist/activity
6. home feed social
7. notifications + thread list + thread detail
8. match deck
9. upcoming reel
10. polish, error states, caching, deep links

Deliverable concreti richiesti:
- codice Swift organizzato e compilabile
- cartella `ios/`
- README tecnico nella cartella iOS
- elenco assumptions/TODO se manca qualche configurazione Apple/Firebase
- se possibile, build o almeno verifica statica del progetto

Cose da NON fare:
- non usare webview per rifare l'app web
- non creare una UI generica da starter template
- non cambiare backend senza necessita'
- non implementare per primo il backoffice admin

Approccio operativo:
- parti da un piano breve
- poi implementa davvero i file
- fai il lavoro in piu' step coerenti
- ogni volta che fai una scelta architetturale, tienila allineata ai file reali del repo

Output atteso da te:
- app iOS iniziale concreta, non solo spec
- struttura pulita e pronta da estendere
- design molto vicino a 2watch web, ma chiaramente nativo iOS
```

## 10. Nota pratica

Se vuoi un prompt ancora piu' aggressivo, si puo' fare una variante "MVP first" che chiede a Codex di implementare solo:

- Auth
- Tab shell
- Search
- Title Detail
- Watchlist/Profile

e lasciare `Home social`, `Threads`, `Match`, `Upcoming` al secondo passaggio.
