# iOS — Analisi tecnica e piano di refactoring

- **Data**: 2026-08-08
- **Commit di riferimento**: `7bb33c0` (`main`, working tree pulito)
- **Perimetro**: `ios/TwoWatch/` — 128 file Swift, 73.764 righe
- **Contesto**: l'app è **live su App Store (1.6.0)** con 1.7.0 su TestFlight. Ogni
  intervento qui descritto deve essere *reversibile, verificabile e spedibile a pezzi*.
- **Precedente**: `docs/SOMTO_CRITICAL_REVIEW.md` (2026-07-12) — sezioni 13 e 16.
  Questo documento ne verifica lo stato un mese dopo e lo rende operativo sul solo iOS.

---

## 1. Verdetto

**PASS WITH CONCERNS.**

L'architettura *scelta* è corretta e moderna: MVVM con `@Observable`, `@MainActor`,
dependency injection via `init`, navigazione centralizzata e tipizzata, Swift 6
language mode attivo. Nessun `as!`, nessun `catch {}` vuoto, commenti di dominio
di qualità alta (spiegano il *perché*, non il *cosa*).

Il problema non è l'architettura: è che **non è mai stata materializzata in
struttura di file, in confini testabili e in un design system**. Il risultato è
un'app che funziona ma in cui:

1. nessun ViewModel esiste come file — vivono tutti dentro le View;
2. i repository sono classi concrete senza protocollo → i ViewModel **non sono
   testabili**, e infatti ci sono **97 righe di test su 73.764 di codice**;
3. la CI **non compila e non testa iOS**, per niente;
4. il design system è solo una palette: zero token di spacing/raggi/tipografia,
   e la stessa "card" è reimplementata a mano ~476 volte;
5. tre file superano le 100 KB e uno le **420 KB** (`TitleDetailView.swift`).

Nessuno di questi è un bug. Tutti insieme sono il motivo per cui il ciclo
"spedisci → il tester trova il bug → patcha" descritto a luglio è ancora il ciclo
di oggi.

**Il rischio da mitigare prima di tutto il resto: refattorizzare 10.000 righe di
scheda titolo senza una rete di test, su un'app live, è la cosa più pericolosa
che possiamo fare.** Il piano qui sotto mette la rete *prima* di toccare la UI.

---

## 2. Cosa è stato misurato (numeri, non impressioni)

### 2.1 Monoliti

| File | Righe | KB | `struct …: View` | `@State` |
|---|---:|---:|---:|---:|
| `Features/TitleDetail/TitleDetailView.swift` | **10.437** | **424 KB** | **73** | **115** |
| `Features/Watchlist/WatchlistView.swift` | 5.923 | 246 KB | 38 | 35 |
| `Features/Community/CommunityView.swift` | 3.677 | 144 KB | 17 | 23 |
| `Data/Repositories/TitleRepository.swift` | 3.561 | — | — (130 func) | — |
| `Features/Profile/ProfileComponents.swift` | 2.693 | — | 22 | 23 |
| `Data/Repositories/WatchlistRepository.swift` | 2.501 | — | — | — |
| `Features/Import/TitlesImportView.swift` | 2.411 | — | — | 48 |
| `Features/Search/SearchView.swift` | 1.876 | — | 12 | 16 |

**Trend**: a luglio la review misurava `TitleDetail` a 9.924 righe distribuite su
4 file. Oggi il solo `TitleDetailView.swift` ne ha 10.437 (+19% in un mese, e più
concentrate). Il monolite **non si sta stabilizzando: sta crescendo**.

Conseguenze concrete, non teoriche:
- il type-checker SwiftUI su file di questa dimensione è la causa nota di build
  lente e di errori "unable to type-check this expression in reasonable time";
- le Preview di Xcode su questo file sono di fatto inutilizzabili;
- ogni review del diff è superficiale per forza;
- due sessioni che toccano la scheda titolo entrano in conflitto quasi certo.

### 2.2 MVVM — presente, ma non materializzato

- **34 classi `@Observable`** in tutta l'app: la separazione VM/View *esiste*.
- **0 file `*ViewModel.swift`**: nessuna di quelle classi vive in un file proprio.
  `TitleDetailViewModel` occupa le righe 29–1053 di `TitleDetailView.swift`.
- La qualità *interna* dei VM è buona: DI completa via `init`, `@MainActor`,
  `@ObservationIgnored` usato correttamente, guardie di generazione
  (`loadGeneration`) contro le race di navigazione, guardia sincrona anti
  doppio-tap (`beginAction`). Questo va detto: **non è codice da riscrivere, è
  codice da spostare e da rendere testabile.**
- **Prop drilling grave**: `TitleDetailScreen` riceve **28 parametri**, di cui 17
  closure — *e in più* riceve il `viewModel` intero. Convivono due modelli di
  propagazione opposti nello stesso tipo. Ogni sezione nuova aggiunge parametri
  a una firma già ingestibile.
- **Due View bypassano il container**: `ProfileView` e `UserProfileDetailView`
  istanziano `TitleRepository()` come default di parametro, saltando `AppContainer`.

### 2.3 Testabilità — il blocco vero

- **Test totali: 97 righe, 2 file** (`TitleUpdateSupportTests` 22,
  `EpisodeSeenCoordinatorTests` 75).
- Il target `TwoWatchTests` **esiste già** in `project.yml` ed è agganciato allo
  scheme (`scheme.testTargets`). L'infrastruttura c'è: manca il contenuto.
- **Causa radice**: nell'intero modulo esiste **un solo protocollo**
  (`AnalyticsLogging` in `Data/Analytics/AnalyticsService.swift`). I 12 repository
  sono classi concrete che parlano direttamente a Firestore. Un ViewModel che
  riceve `TitleRepository` non può essere istanziato in un test senza una rete
  reale e un progetto Firebase.
  → **Non è che i test non siano stati scritti: non erano scrivibili.**
- **Asset già pronto**: `App/PreviewSupport.swift` (959 righe) contiene fixture
  ricche e realistiche (utenti, titoli, feed, watchlist, stati personali,
  provider, rating, notifiche, match). Sono già il 70% del lavoro di fixture per
  i test — oggi servono solo alle Preview.

### 2.4 CI — iOS assente

`.github/workflows/ci.yml` ha 3 job: `unit` (backend), `rules`, `blog-build`.
**Nessun job compila l'app iOS. Nessun job esegue i test iOS.** Una regressione
Swift viene scoperta al primo `xcodebuild archive` manuale, o dal tester.

Nota correlata già registrata in memoria: il footgun `#if DEBUG` + `#Preview`
(helper che finisce nel blocco debug → Debug verde, Release rotto) **oggi non è
intercettato da niente** se non da una build Release manuale.

### 2.5 Design system — è solo una palette

`DesignSystem/Theme/TwoWatchTheme.swift` = 17 costanti, **tutte colori e gradienti**.
Non esiste un token di spacing, raggio, tipografia o elevazione.

Conseguenza misurata su tutto il modulo:

| Cosa | Numero |
|---|---:|
| `RoundedRectangle` scritti a mano | **476** |
| usi di `GlassCard` (la card condivisa) | 62 |
| valori distinti di `cornerRadius` | **26** (18, 14, 16, 22, 20, 12, 24, 10, 8, 28, 26, 4, 30, 15, 6, 19, 13, 7, 34, 999, 40, 3, 11, 9, 2, 1) |
| valori distinti di `spacing:` | **15+** (10×258, 12×228, 8×169, 6×131, 14×107, …) |
| `Color(hex:` fuori dal Theme | 86 |
| `.shadow(` sparsi | 47 |

Il risultato è che **"la card" e "il chip" di Somto non esistono come oggetti**:
esistono 476 approssimazioni della stessa idea, e cambiare il raggio delle card
del prodotto oggi è un lavoro manuale su decine di file.

**Correzione a una misura di questo documento (2026-08-08).** La prima stesura
riportava «253 `.font(.system(...))` hardcoded» lasciando intendere che non
esistesse una scala tipografica. È fuorviante: l'app usa **1.271 font semantici**
(`.caption` ×421, `.subheadline` ×419, `.caption2` ×138, `.headline` ×123,
`.title3` ×85, …) contro 253 a dimensione fissa. **Dynamic Type è già la norma**,
e le dimensioni fisse sono il 17% dei casi. La tipografia sta meglio di come
l'avevo descritta: i buchi veri sono spaziature, raggi ed elevazione.

**Sulla scala 4/8**: la tentazione è normalizzare a 8/16. Non si fa. Il codice
usa massicciamente 10 (258 volte), 6 (131) e 14 (107): forzarli sposterebbe
pixel su decine di schermate, cioè un redesign travestito da refactoring. I
token nascono con i valori già dominanti. I raggi invece si riducono davvero,
da 26 valori a 6, perché quelli fuori scala erano una manciata ciascuno.

### 2.6 Duplicazione di componenti e helper

Stesse funzioni, riscritte identiche in file diversi:

| Helper | Copie | Dove |
|---|---:|---|
| `initials(for:)` | **10** | PostDetail ×2, TitleDetail ×2, Community ×3, AppMenu, ThreadsList, CharacterPickRow |
| `avatarFallback(…)` / `avatar(…)` | **9** | Quiz ×3, TitleDetail ×2, Search, Threads, UserProfileDetail, CharacterPickRow |
| `formatScore(_:)` | **8** | tutte dentro `Features/Quiz/` (QuizLeaderboard ×3, QuizPlay ×2, …) |

Sul piano dei componenti: **6 View "avatar" distinte**
(`MentionSuggestionAvatarView`, `PostCommentAvatarView`, `PostDetailAvatarView`,
`RatingAuthorAvatarView`, `TitleReviewAvatar`, `AvatarZoomOverlay`), e una
famiglia di ~15 `…Chip` / `…Badge` / `…Row` che fanno la stessa cosa con nomi e
misure diverse per feature.

`formatScore` ×8 dentro la stessa cartella è il caso limite: è duplicazione
*locale*, non cross-feature. Non richiede nemmeno una decisione di design per
essere risolta.

### 2.7 Performance e fluidità

**(a) Ricarica totale dopo ogni voto — il problema più impattante.**
`TitleDetailViewModel.submitRating` e `deleteRating` terminano con
`await load(currentUserID: userID)`. `load()` rifà `fetchTitle` e riarma
`loadDeferredDetailData`, che spara **~14 richieste** (`fetchProviders`,
`fetchRelatedTitles`, `fetchTrailerURL`, `fetchTitleUpdates`,
`fetchSeasonMetadata`, `listGenres(limit: 400)`, `fetchTitleCredits`,
`fetchTitleLevelRatings`, `fetchEditableListSummaries`, `listFollowing`,
`fetchTitleWatchersProgress`, `fetchPublicListsContainingTitle`,
`fetchTitleUpdatePreference`, + enrichment TMDB).
**Un tap su una stella ricarica trailer, provider, cast e generi.** Da qui
arrivano sia la latenza percepita che una quota non banale delle letture
Firestore (cfr. incidente costi di luglio).

Da riconoscere: `loadDeferredDetailData` è scritto **bene** — `async let` in
parallelo, guardie di generazione, `isLoading` abbassato prima dei deferred per
far apparire subito la scheda. Il difetto non è lì: è che una mutazione
puntuale invoca un caricamento pensato per l'apertura della schermata.

**(b) Rendering eager.**
`TitleDetailView.swift`: **22 `ScrollView`, 0 `LazyVStack`**. Il corpo della
scheda è un `VStack` dentro uno `ScrollView`: tutte le sezioni della tab attiva
vengono costruite subito, e ricostruite a ogni cambio di stato del VM (115 `@State`
nel file).

**Correzione a una misura di questo documento (2026-08-08).** La prima stesura
diceva «**194 `ForEach` contro 21 `LazyVStack`**», che fa sembrare il problema
molto più grande di quanto sia. Scomponendo:

| | |
|---|---:|
| `ForEach` su range fissi / enum (skeleton, tab, filtri) — la pigrizia non c'entra | 51 |
| `ForEach` su collezioni del modello | 143 |
| …di cui già dentro `Lazy*` / `List` | 35 |

E soprattutto: **le due liste più pesanti erano già lazy** — il feed Community è
un `LazyVStack`, la griglia Watchlist un `LazyVGrid`.

I casi realmente problematici trovati sono **due**, entrambi liste senza tetto
costruite per intero: l'**inbox notifiche** e i **commenti di un post**. Corretti.

I ~106 `ForEach` restanti in stack non-lazy sono in larga parte `HStack`
orizzontali su insiemi in pratica limitati (generi di un titolo, chip del cast):
convertirli sarebbe rumore con rischio visivo non nullo e guadagno nullo.

**(c) Nessuna barriera di ricalcolo.** Le sezioni ricevono liste e closure
inline: nessun `Equatable` custom, quindi SwiftUI non può saltare i sotto-alberi.
Con 73 View nello stesso file e closure ricreate a ogni `body`, il diffing è
sempre completo.

### 2.8 Robustezza

- **169 `try? await`**: l'errore viene inghiottito senza log e senza stato di
  errore. Nella scheda titolo questo significa che una sezione che fallisce
  appare *vuota*, identica a una sezione senza dati. Non arriva niente a
  Crashlytics. In alcuni punti è una scelta corretta (sezione accessoria che non
  deve bloccare il render); in altri nasconde un fallimento reale all'utente e a noi.
- **Decoding manuale**: 168 occorrenze di `[String: Any]`, 7 `fromMap(_:)`, e solo
  **2 modelli su 11** usano `Codable` (`QuizModels`, `CharacterVote`). Un campo
  rinominato lato backend non produce un errore: produce un `nil` silenzioso.
  `Core/Utilities/FirestoreValueReader` è un buon mitigatore (coercizione
  tollerante dei tipi) ma non dà nessun segnale di campo mancante.
- **Nessun linter**: né SwiftLint né SwiftFormat. Niente che impedisca al
  prossimo file da 10.000 righe di nascere.

**Due comportamenti scoperti dai primi test sul parsing (2026-08-09).** Non
erano osservabili prima perché `tmdbDate` era `private` dentro `TitleRepository`.
Nessuno dei due è stato "corretto": sono caratteristiche reali, e cambiarle su
un'app live non è materia da refactoring. Sono fissate da test che le
documentano.

1. **`tmdbDate` dipende dal fuso del dispositivo.** Non fissa il `timeZone`,
   quindi `"2024-02-28"` è mezzanotte *locale*: a Roma diventa il 27 alle 23:00
   UTC. Invisibile finché si scrive e si legge in locale; un confronto con una
   soglia UTC slitterebbe di un giorno. Portarlo a UTC sposterebbe di un giorno
   le date d'uscita mostrate agli utenti a ovest di UTC.
2. **`tmdbDate` fa rotolare le date impossibili invece di rifiutarle.**
   `"2023-02-29"` (2023 non è bisestile) non torna `nil`: torna il 1° marzo.
   Innocuo con TMDB come sorgente. Diventerebbe un problema se lo stesso parser
   venisse puntato su input utente.
- **Build**: `xcodebuild build -configuration Debug` **passa** (exit 0), con **15
  warning**. Di questi, **12 sono di isolamento concorrenza** e vanno chiusi:
  `main actor-isolated property 'isPreparingPhoto' can not be referenced from a
  nonisolated context` (×4, `Features/Profile/EditProfileView.swift`),
  `main actor-isolated class property 'shared'` (×4),
  `call to main actor-isolated instance method 'open(_:options:completionHandler:)'`
  (×2), `call to main actor-isolated initializer 'init(url:transaction:onImageSize:content:)'`
  (×2). Sono warning oggi perché il modulo non è ancora in strict concurrency
  completa: nella direzione in cui va Swift 6 diventeranno errori. I restanti 3
  sono di build system (script phase senza output dichiarati → rieseguiti a ogni
  build, quindi anche build incrementali più lente del necessario).
- **Cose che invece reggono**: Swift 6 language mode; zero `as!`; 4 `try!` solo su
  invarianti di boot; `CachedAsyncImage` usato ovunque (0 `AsyncImage` grezze);
  navigazione centralizzata e tipizzata in `AppShellStore`
  (`AppPresentedDestination` con `id` esplicito); solo 3 `addSnapshotListener` in
  tutta l'app, tutti nei repository e con `remove()`.

---

## 3. Dove mettere mano — piano in 6 fasi

Principio guida: **prima la rete, poi il trapezio.** Le fasi 0–1 non cambiano una
riga di UI e non sono spedibili all'utente in senso visibile; sono ciò che rende
le fasi 2–5 sicure. Saltarle significa rifare a mano lo stesso lavoro di QA per
ogni fase successiva.

Ogni fase è indipendente, spedibile e reversibile. Nessuna richiede un branch
lungo: si lavora su `main` a commit piccoli, come da CLAUDE.md.

---

### Fase 0 — Rete di sicurezza ✅ FATTA (2026-08-08)

**Obiettivo**: rendere *visibile* una rottura prima che arrivi al tester.

#### Deviazione dal piano iniziale: il gate iOS non sta su GitHub Actions

Il piano diceva "job iOS in CI". **Non è stato fatto, e non va fatto.** I conti:

- Il repo è **privato** su **piano GitHub Free** → 2.000 minuti/mese di Actions.
- I runner macOS hanno **moltiplicatore ×10** → il monte reale è **200 minuti
  macOS/mese**.
- Una run iOS completa (checkout, risoluzione SPM, build Debug + Release, test)
  sta realisticamente sui 15–25 minuti → **150–250 minuti addebitati per run**.
- Cadenza reale del repo: **277 commit su `ios/` in 60 giorni** (~4,6 al giorno).

Cioè: il monte gratuito basta a **una sola run al mese**, contro ~138 al mese.
Un job iOS su GitHub Actions non è "un po' caro": è **fuori scala di due ordini
di grandezza**, e l'unica alternativa sarebbe pagare l'overage.

**Scelta**: il gate iOS vive sul Mac, dove le build già avvengono e costano zero.
Su GitHub Actions resta solo ciò che gira gratis su Linux.

#### Cosa è stato costruito

| Dove | Cosa | Costo |
|---|---|---|
| `scripts/ios-ci.sh` | **fonte di verità unica** dei controlli iOS: `--lint-only` / `--fast` / `--full` | — |
| `scripts/hooks/pre-push` | invoca `--fast` **solo se il push tocca `ios/`** | 0 € |
| `.github/workflows/ci.yml` → job `swift-guards` | footgun check su ubuntu | 0 € |
| `scripts/ios-release.sh` | gate `--lint-only` nel preflight | 0 € |
| `ios/.swiftlint.yml` | configurazione ratchet | — |
| `scripts/check-swift-footguns.mjs` | logica footgun condivisa hook + CI | — |

Modalità di `ios-ci.sh`:
- `--lint-only` — footgun + SwiftLint, nessun compilatore (secondi)
- `--fast` — + xcodegen + build Debug → **hook pre-push**
- `--full` — + build Release + test → pre-rilascio

La build **Release** resta obbligatoria prima di rilasciare (`ios-release.sh` la
fa già archiviando): è l'unico controllo che intercetta il footgun
`#if DEBUG` + `#Preview`. Metterla nel pre-push costerebbe minuti a ogni push,
per un difetto che si manifesta solo al rilascio.

Due dettagli operativi:

- **DerivedData dedicata** in `ios/build/ci-derived-data` (già in `.gitignore`),
  separata da quella di Xcode: il gate non tocca lo stato di una sessione Xcode
  aperta. Costo: **~5 GB** di disco a regime. Si azzera con
  `rm -rf ios/build/ci-derived-data` (la run successiva sarà a freddo).
  Restando calda, `--fast` è nell'ordine del minuto; a freddo sono diversi minuti.

  **Disco esterno: provato, NON conviene.** `SOMTO_IOS_DERIVED_DATA` permette di
  spostarla, e il 2026-08-08 si è tentato per liberare l'interno. Due ostacoli,
  il secondo insormontabile:

  1. il disco è **exFAT**, che non ha symlink, permessi POSIX né attributi
     estesi — DerivedData ci si rompe. Aggirabile con un'immagine APFS sparsa
     (`hdiutil create -type SPARSEBUNDLE -fs APFS`) montata sopra;
  2. **throughput: 23 MB/s contro 1.032 MB/s dell'interno — 44×.** Misurato con
     `dd`. Una build cold ci mette un ordine di grandezza in più, e il gate
     pre-push diventa inutilizzabile.

  **Il vincolo reale non è lo spazio, è la banda.** Su un disco esterno lento la
  DerivedData va tenuta locale e semmai svuotata più spesso. Prima di rifare
  questo tentativo su un altro disco, misurare:
  `dd if=/dev/zero of=<percorso>/test bs=1m count=200`. Sotto i ~300 MB/s non
  vale la pena.
- **Destination non hardcoded**: `build` usa `generic/platform=iOS Simulator`,
  che compila senza pretendere un simulatore concreto; solo `test` risolve un
  UDID a runtime. La prima versione aveva `name=iPhone 16` fisso e falliva con
  `Unable to find a device matching the provided destination specifier`, perché
  su questa macchina quel device esiste solo sul runtime 18.5. Un gate che si
  rompe quando cambiano i simulatori installati viene disattivato in un giorno.

#### Perché il footgun check è l'unico controllo rimasto in CI

L'hook pre-push è aggirabile con `--no-verify`. Il crash
`Dictionary(uniqueKeysWithValues:)` (v0.3.22, "La Casa di Carta Korea") è
l'unico difetto di questa lista che ha **già mandato l'app in crash in
produzione**: quel controllo non deve essere aggirabile, e gira gratis su Linux.

`scripts/check-swift-footguns.mjs` è **codice, non una regola SwiftLint**, per un
motivo misurato: una regex secca non distingue una chiave doc-id (legittima) da
una chiave derivata (crash), e sul repo produceva **23 segnalazioni quasi tutte
corrette**. Serve l'allowlist. Stesso schema già usato dal repo per
`check-i18n-regressions.mjs` (una logica, due consumatori).

#### Baseline misurate su `7bb33c0`

| Metrica | Valore | Nota |
|---|---:|---|
| Warning SwiftLint | **18** | soglia nello script; se sale, il push fallisce |
| Warning di compilazione | 15 → **12** | 3 di build system chiusi (vedi sotto) |
| Footgun Swift | **0** | su 128 file |
| Violazioni SwiftLint `error` | **0** | |

Le 18 sono tutte con un contenuto: `force_unwrapping` 4, `force_try` 4,
`type_body_length` 3, `empty_count` 3, `cyclomatic_complexity` 3,
`redundant_nil_coalescing` 1.

**Nota sulla taratura**: la prima configurazione produceva **91** warning, di cui
**73 di sola formattazione** (42 solo `implicit_optional_initialization`, poi
a-capo, virgole, righe vuote). Sono state disattivate: un linter che urla per il
vuoto viene ignorato anche quando ha ragione. Quella è materia da SwiftFormat,
non da gate di qualità.

I 3 warning di build system sono stati chiusi dichiarando `inputFiles`/
`outputFiles` sulle due script phase in `project.yml` — le rieseguiva a **ogni**
build, incrementali comprese. È anche un guadagno diretto sui tempi di build.

**Restano aperti**: i **12 warning di isolamento concorrenza** (§2.8), che vanno
in Fase 5 insieme a `SWIFT_STRICT_CONCURRENCY: complete`.

**Rischio**: nullo — nessun file applicativo Swift toccato.
**Verifica fatta**: `--lint-only` e `--full` eseguiti; hook testato sui quattro
rami (push con `ios/`, push senza, cancellazione di ref, override).

---

### Fase 1 — Confini testabili + primi test (nessun cambio di comportamento)

**Obiettivo**: sbloccare i test. È il singolo intervento con più leva del piano.

1. **Protocolli sui repository.** Per ognuno dei 12 repository, estrarre un
   protocollo con i soli metodi effettivamente consumati dai ViewModel
   (`TitleRepositoryProtocol`, `WatchlistRepositoryProtocol`, …). La classe
   esistente lo adotta senza modifiche: è un `extension … : Protocol {}` più il
   cambio di tipo nelle `init` dei VM. `AppContainer` continua a fornire le
   implementazioni concrete.
   → **Zero cambi di runtime**, il compilatore verifica tutto.
2. **Fixture condivise**: promuovere le fixture di `PreviewSupport.swift` a un
   `Fixtures.swift` visibile anche al target di test. Sono già scritte.
3. **Fake repository** generati sui protocolli (in-memory, con hook per errori e
   ritardi).
4. **Prima ondata di test** sui ViewModel a più alto valore, in quest'ordine:
   - `TitleDetailViewModel` — toggle watchlist, submit/delete rating, guardie di
     generazione, `beginAction` anti doppio-tap, `mergeCharacters`
     (il footgun che ha causato il crash di v0.3.22)
   - `WatchlistViewModel` — filtri, ordinamenti, progresso serie
   - `QuizPlayViewModel` — punteggio, XP, streak (che oggi è la logica duplicata
     su 3 piattaforme, cfr. D4 della review)
   - logica pura: `TitleDetailFormatter`, `RatingDisplayFormat`,
     `SearchNormalizer`, `GenreDisplay`, `CommunityFeedRanking`
   **Target realistico: 60–100 test.** Non è copertura totale: è copertura dei
   percorsi che, se si rompono, l'utente vede.
5. **Correggere il bypass del container** in `ProfileView` e
   `UserProfileDetailView` (rimuovere i default `= TitleRepository()`).

**Rischio**: molto basso — è tipizzazione, non logica.
**Sforzo**: M (2–4 giorni).
**Verifica**: `xcodebuild test` verde in CI; i test falliscono davvero se si
rompe di proposito una guardia.

---

### Fase 2 — Design system reale

**Obiettivo**: che "la card di Somto" esista come oggetto, una volta sola.
**Vincolo assoluto (CLAUDE.md): nessun redesign, palette e look invariati.**
Questa fase deve essere *pixel-neutra*: si sostituiscono valori magici con token
che valgono esattamente gli stessi numeri.

1. **Token** in `DesignSystem/Theme/`:
   - `SomtoSpacing` — scala 4/8 (2, 4, 8, 12, 16, 20, 24, 32). I valori fuori
     scala oggi in uso (10, 6, 14, 18, 22) si mappano al valore vicino **solo
     dove la differenza è invisibile**; dove è deliberata, resta esplicita e commentata.
   - `SomtoRadius` — da 26 valori a 5 (`sm 8`, `md 14`, `lg 18`, `xl 24`, `pill`).
     Il picco d'uso è già su 18/14/16: la scala non è un'invenzione, è una
     normalizzazione dei valori dominanti.
   - `SomtoTypography` — scala semantica (`titleL`, `titleM`, `body`, `caption`,
     `mono`) che sostituisce le 253 `.font(.system(...))`, con Dynamic Type
     rispettato (finding aperto dell'audit iOS 2026-06-19).
   - `SomtoElevation` — 3 livelli, al posto delle 47 `.shadow` sparse.
2. **Componenti canonici** in `DesignSystem/Components/`:
   - `SomtoCard` con varianti (`.glass`, `.panel`, `.flat`) — assorbe `GlassCard`,
     `TitleSectionCard` e le 476 `RoundedRectangle` inline
   - `SomtoAvatar` — **una** View: URL + fallback iniziali + dimensione + zoom
     opzionale. Cancella le 6 View avatar e le 19 funzioni
     `initials`/`avatarFallback`
   - `SomtoChip`, `SomtoBadge`, `SomtoSectionHeader`, `SomtoListRow`
   - `SomtoScore.format(_:)` — cancella le 8 copie di `formatScore`
3. **Migrazione incrementale**: un commit per file, partendo dai file piccoli
   (Quiz, Notifications, Threads) per validare i componenti prima di toccare i
   monoliti. Il monolite scheda titolo si migra **dopo** la Fase 3, quando sarà
   già spezzato.

**Rischio**: medio (è l'unica fase che tocca la resa visiva).
**Mitigazione**: screenshot di riferimento nel Simulatore prima/dopo, per ogni
schermata migrata, con confronto diretto. Le fixture della Fase 1 rendono le
Preview di nuovo utilizzabili come banco di prova.
**Sforzo**: L (1–2 settimane, ma spedibile a fette da mezza giornata).

---

### Fase 3 — Spezzare i monoliti (solo spostamento di codice)

**Obiettivo**: nessun file sopra ~800 righe. È un lavoro **meccanico**: si
spostano tipi già esistenti in file nuovi, senza cambiare una riga di corpo.
Con XcodeGen non serve nemmeno toccare il progetto (le sorgenti sono per
cartella): `xcodegen generate` e basta.

**`TitleDetailView.swift` (10.437 → ~15 file)**, in quest'ordine:
1. `TitleDetail/TitleDetailViewModel.swift` — righe 29–1053, tal quali
2. `TitleDetail/Sections/` — una per tab: `Overview`, `Episodes`, `Updates`,
   `Community`
3. `TitleDetail/Components/` — hero, rating ring, distribuzione, chip, badge,
   skeleton, person card (molti verranno poi assorbiti dal design system)
4. `TitleDetail/Sheets/` — rating composer, watch actions, cast completo,
   editorial editor, group discussion, friends votes, recommendation composer
5. `TitleDetail/TitleDetailFormatter.swift`

**Poi, quando la Fase 1 copre le rispettive aree**: `WatchlistView` (5.923),
`CommunityView` (3.677), `ProfileComponents` (2.693), `TitlesImportView` (2.411).

**`TitleRepository.swift` (3.561 righe, 130 func)** — split per dominio, gli assi
sono già evidenti dai nomi dei metodi:
`TitleCatalogRepository` (fetch/list/search) · `TitleTMDBRepository` (12 metodi
`fetchTMDB*` + import + refresh) · `TitleRatingsRepository` · `TitleEmotionsRepository`
· `TitleUpdatesRepository` · `TitleCreditsRepository`.
Ogni pezzo adotta il protocollo definito in Fase 1 → i chiamanti non cambiano.

**Rischio**: basso *se e solo se* resta puro spostamento. Regola: **un commit che
sposta non modifica**. Se durante lo spostamento si nota un difetto, va in un
commit separato.
**Sforzo**: M–L (3–5 giorni per TitleDetail, poi a scendere).
**Verifica**: build Debug + Release + test verdi; diff leggibile come "move".

---

### Fase 4 — Fluidità

1. **Refresh mirato al posto della ricarica totale** (il punto 2.7a). Sostituire
   `await load()` in `submitRating`/`deleteRating` con un
   `refreshRatingContext(userID:)` che aggiorna solo `ratings`, `personalState`,
   `derivedRating` e l'aggregato. **Da solo elimina ~11 richieste per tap.**
   Stesso trattamento a `toggleWatchlist` e agli altri percorsi che oggi
   ricaricano tutto.
2. **`LazyVStack`** nei corpi lunghi: scheda titolo, Search, ProfileComponents,
   QuizPlay, Notifications, Import.
3. **Barriere di ricalcolo**: rendere `Equatable` le sezioni che ricevono liste
   grandi; sostituire il prop drilling di `TitleDetailScreen` (28 parametri) con
   un `TitleDetailActions` (uno `struct` di closure) + il VM. Riduce la firma a
   3–4 parametri e taglia la ricreazione di closure a ogni `body`.
4. **Misura**: Instruments (Time Profiler + SwiftUI) su apertura scheda titolo e
   su scroll watchlist, prima e dopo. Senza misura questa fase non ha criterio
   di completamento.

**Rischio**: medio (cambia comportamento reale).
**Mitigazione**: i test della Fase 1 coprono esattamente `submitRating`/`load`.
**Sforzo**: M (3–4 giorni).

---

### Fase 5 — Robustezza

1. **Triage dei 169 `try? await`**: classificare in
   *(a)* accessorio, silenzio corretto → aggiungere solo un log Crashlytics
   non-fatal; *(b)* utente-visibile → stato di errore esplicito con retry
   (il pattern esiste già: `updatesErrorMessage` + `retryTitleUpdates`, va esteso).
2. **Chiudere i 12 warning di isolamento** (§2.8) e valutare
   `SWIFT_STRICT_CONCURRENCY: complete` esplicito in `project.yml`, così che la
   CI della Fase 0 impedisca a nuovi warning di concorrenza di entrare.
3. **`Codable` sui modelli di dominio** dove lo schema è stabile, mantenendo
   `FirestoreValueReader` come fallback tollerante per i campi legacy. Priorità a
   `Title`, `WatchlistModels`, `PostModels`.
4. **Accessibilità**: Dynamic Type e VoiceOver, finding ancora aperto dall'audit
   iOS del 2026-06-19. La `SomtoTypography` della Fase 2 è il prerequisito.

**Rischio**: basso.
**Sforzo**: M.

---

## 4. Ordine consigliato e criterio di uscita

| Fase | Contenuto | Sforzo | Rischio | Spedibile da solo |
|---|---|---|---|---|
| ~~0~~ | ~~Gate iOS locale + SwiftLint ratchet + footgun in CI~~ ✅ | S | nullo | — |
| ~~1~~ | ~~Protocolli + fake + test~~ ✅ | M | molto basso | — |
| ~~2~~ | ~~Token, `.somtoCard()`, `SomtoAvatar`, `QuizScore` + migrazione avatar~~ ✅ | L | medio | — |
| ~~3a~~ | ~~Split `TitleDetailView` (10.437 → 1.547)~~ ✅ | M–L | basso | — |
| ~~3b~~ | ~~`TitleParsing` estratto e messo sotto test~~ ✅ | M | basso | — |
| ~~4a~~ | ~~Refresh mirato dopo il voto (~15 → 3-4 richieste)~~ ✅ | S | medio | — |
| ~~4b~~ | ~~`LazyVStack` + `TitleDetailScreen` da 28 a 12 parametri~~ ✅ | M | medio | — |
| ~~5a~~ | ~~Warning di isolamento concorrenza (6 → 0)~~ ✅ | S | basso | — |
| 5b | Triage dei 169 `try? await` + `Codable` + accessibilità | M | basso | sì |

### Cosa resta davvero aperto

- ~~**Triage dei `try? await`**~~ — **affrontato il 2026-08-09, con un taglio
  diverso da quello previsto.** Convertirli tutti in stati d'errore avrebbe
  richiesto una UI d'errore per ogni sezione: cambio di prodotto, non di codice.
  Il buco vero era un altro — Crashlytics era configurato ma **`recordError` non
  era chiamato da nessuna parte**, quindi nessun non-fatal è mai arrivato: una
  sezione che falliva era indistinguibile da una senza dati, e lo si scopriva
  solo da una segnalazione.

  Introdotto `SilentFailure.record(_:context:)`, applicato ai 7 caricamenti
  differiti della scheda titolo. La parte progettata con cura è **cosa scarta**:
  cancellazioni (navigare via cancella i task) e rete assente (un utente in
  metropolitana ne genererebbe decine al minuto). Un reporter che manda tutto
  viene silenziato entro una settimana. 8 test sul filtro.

  Gli altri `try?` restano: il valore sta nell'avere il canale, non nel numero
  di siti convertiti. Estenderlo a un altro punto è una riga.
- ~~**`Codable` sui modelli**~~ — **scartato il 2026-08-09, dopo averlo misurato.**
  La premessa di questo documento («dove lo schema è stabile») era sbagliata: lo
  schema **non** è stabile. I mapper Firestore contengono **191 operatori `??`
  su ~632 righe**, uno ogni tre righe; `snapshotToTitle` da solo ne ha 33. Non
  sono ridondanza, sono la forma reale dei dati — `tmdbId` sta in tre posti
  diversi a seconda di chi ha scritto il documento e quando (iOS, web, Cloud
  Functions, importer):

  ```swift
  tmdbId: FirestoreValueReader.int(data, key: "tmdbId")
      ?? FirestoreValueReader.int(metadataData, key: "tmdbId")
      ?? canonicalTMDB?.tmdbId,
  ```

  `Codable` si aspetta una forma sola. Convertire perderebbe ogni fallback, e
  documenti che oggi si leggono comincerebbero a tornare `nil` — in silenzio, e
  senza che un test lo colga, perché i dati di produzione non stanno nei test.
  **Le catene di fallback SONO lo schema.**

  **Fatto invece (2026-08-09), punti 1 e 2 di un percorso in tre:**

  1. **`FallbackProbe`** registra quale ramo viene preso. Otto sonde su
     `TitleParsing.title(from:documentID:)`. Volume contenuto per costruzione:
     una volta per chiave **per sessione**, non per documento — la domanda è
     «esiste ancora», non «quante volte», e il decoding gira migliaia di volte.
     Il reporter è **iniettato** da `AppContainer`, così i parser restano puri.
  2. **`snapshotToTitle` da 101 righe a 4**: la logica è ora
     `TitleParsing.title(from:documentID:)`, pura e testabile, con **12 fixture,
     una per forma reale**. Il test sulla forma moderna asserisce che *nessun*
     fallback scatti: è la verifica che le sonde siano piazzate giuste.

  **Come si leggono i risultati.** L'evento è `legacy_shape_seen`, parametro
  `shape`. In Firebase Analytics → Eventi, dopo due settimane di traffico:

  | Esito | Cosa significa | Cosa fare |
  |---|---|---|
  | chiave **assente** | quella forma non esiste più | cancellare il ramo e la sua fixture |
  | chiave **rara** | pochi documenti legacy | backfill mirato, poi cancellare |
  | chiave **frequente** | forma viva | non è debito: è un requisito, documentato dal test |

  Il ramo da guardare per primo è **`Title.type.defaultMovie`**: un documento
  senza `type` e con id non canonico viene letto come **film**. Una serie in
  quelle condizioni perde stagioni e progresso episodi. Se è vivo, non è un
  fallback da conservare — è un bug di dati da riparare.

  **Punto 3 (normalizzare i dati con un backfill) NON fatto**, ed è giusto così:
  va deciso con i numeri davanti, non prima.
- **Accessibilità** — **misurata il 2026-08-09, il quadro è diverso dall'audit
  di giugno.** VoiceOver **è coperto**: 273 `accessibilityLabel`, 62
  `accessibilityElement`, 52 `accessibilityHidden`, 41 `accessibilityHint`. Non
  è lì il buco.

  Il buco è **Dynamic Type**: 240 `.font(.system(size:))` a dimensione fissa che
  non scalano, contro 24 `@ScaledMetric`. Chi ingrandisce il testo di sistema
  perché altrimenti non legge, in quei punti non vede cambiare niente.

  Fatto: `.somtoScaledFont(size:weight:relativeTo:)` — la dimensione resta
  quella scelta ma cresce con le impostazioni dell'utente — applicato ai **15
  font del design system**. Con la regola per `relativeTo` scritta nel file
  (<13pt → `.caption`, ≤20 → `.body`, oltre → `.title`) e una Preview che
  mostra fisso contro scalato a tre taglie.

  **Restano ~225 punti**, e vanno fatti a vista: ingrandire un'etichetta da 11pt
  su una chip stretta ne rompe il layout, e serve guardare ogni schermata alle
  taglie accessibility. È lavoro per schermata, non per sostituzione di massa.

  Un'eccezione motivata: le iniziali di `SomtoAvatar` **non** scalano, perché la
  loro dimensione è calcolata sul diametro del cerchio. Documentata nel codice
  perché non venga "corretta".
- **`TitleRepository` a 3.114 righe.** Spezzarla oltre richiederebbe di rendere
  `internal` `db` e le cache, cioè esporre Firestore all'intero modulo per
  guadagnare una divisione di file. Scambio non conveniente: lasciata così.
- **`tmdbDate`**: dipendenza dal fuso e roll-over delle date impossibili (§2.8).
- **Verifica visiva** delle schermate toccate dall'unificazione avatar: podio
  quiz, elenco thread, "chi sta guardando" passano da fondo piatto a gradiente.
| 3b | Split Watchlist / Community / Profile / Import | M | basso | sì |
| 5 | Errori espliciti + Codable + accessibilità | M | basso | sì |

**Nota sull'ordine**: 3a prima di 2 perché migrare al design system dentro un
file da 424 KB è molto più lento e più rischioso che migrarlo in 15 file già
separati.

**Criterio di uscita del refactoring (da verificare prima del rilascio App Store):**

- [x] gate iOS attivo: `--fast` a ogni push che tocca `ios/`, `--full` prima del
      rilascio, footgun check non aggirabile in CI
- [ ] ≥ 60 test verdi sui ViewModel e sulla logica pura
- [ ] nessun file sopra 800 righe
- [ ] `TwoWatchTheme` ha token di spacing, raggio, tipografia, elevazione
- [ ] `SomtoCard` / `SomtoAvatar` / `SomtoChip` usati ovunque; zero copie di
      `initials` / `avatarFallback` / `formatScore`
- [ ] apertura scheda titolo e voto misurati con Instruments, con delta documentato
- [ ] zero `try? await` su percorsi utente-visibili senza stato di errore
- [ ] zero warning di isolamento concorrenza (da 12 a 0)
- [ ] build Release archiviabile e TestFlight verde

---

## 5. Cosa NON fare

- **Non riscrivere i ViewModel.** Sono buoni. Vanno spostati e resi testabili, non rifatti.
- **Non introdurre un'architettura nuova** (TCA, Redux, Clean a 5 layer). Il
  problema è disciplina di struttura, non il pattern. Un cambio di paradigma su
  un'app live e su un progetto a bus factor 1 sarebbe il rischio più grande di tutti.
- **Non fare un branch lungo "refactor".** Ogni fase su `main`, a commit piccoli
  (CLAUDE.md, sezione git workflow). Un branch di due settimane su questi file
  produce conflitti irrisolvibili.
- **Non cambiare il look** durante la Fase 2: token e componenti devono valere gli
  stessi pixel di oggi. Il redesign, se lo si vuole, è un progetto separato *dopo*.
- **Non toccare Firestore, rules o Functions** in questo lavoro: è refactoring
  client-side puro. Se emerge un bisogno backend, va in una proposta a parte.

---

## 6. Riferimenti incrociati

- `docs/context/IOS_CODE_STYLE.md` — **come si scrive codice iOS da adesso in poi**
  (questo documento dice cosa bonificare; quello dice cosa non far più nascere)
- `docs/SOMTO_CRITICAL_REVIEW.md` §13 (manutenibilità 2/5), §16 (D1 zero test client)
- `docs/PENDING.md` — debiti aperti, alcuni con "iOS pending prossima build"
- `docs/context/IOS_APP_MAP.md` — mappa shell, tab bar, header
- `docs/context/RELEASE_PROCESS.md` — numerazione e archive
- Memoria: footgun `#if DEBUG` + `#Preview` (build Release rotta), footgun
  `Dictionary(uniqueKeysWithValues:)` su chiavi derivate (crash v0.3.22)
