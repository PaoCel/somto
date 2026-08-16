# iOS — Come si scrive codice su Somto

- **Data**: 2026-08-09 · **Perimetro**: `ios/TwoWatch/` (Swift 6, SwiftUI, iOS 17+)
- **A chi serve**: a chiunque — persona o sessione AI — stia per toccare un file
  Swift di questo repo. Questa è la fonte di verità dello **stile**;
  `docs/IOS_REFACTOR_PLAN.md` è la fonte di verità del **piano di rientro**.

Le regole qui sotto nascono da due fonti: i difetti misurati su questo repo, e i
cheat sheet del corso SwiftUI di Paolo (IBM Skills Network, moduli 1–3 —
`@Observable`/`@AppStorage`/SwiftData, networking e concorrenza, animazioni e
accessibilità). Dove le due dicevano la stessa cosa, ha vinto la formulazione
più stretta.

## 0. Come si usa questo file

Non è un manuale di SwiftUI: è **cosa vale su Somto**, con i motivi presi dai
difetti che questo repo ha davvero avuto. Le regole generiche di SwiftUI le sai
già; qui c'è solo dove Somto ha scelto, o dove Somto si è fatto male.

Ogni regola ha la stessa forma: **cosa fare**, **perché**, **esempio buono nel
repo**, **cosa non copiare**. Se una regola non ha un perché misurato, non è una
regola: è un'opinione, e va discussa prima di essere applicata a tappeto.

**Prima di dire "fatto"**: §12.

**Quando questo file e il codice esistente non sono d'accordo**, vince questo
file *per il codice nuovo*. Il codice vecchio si migra quando lo tocchi per
altro (regola boy-scout), **non** con un passaggio di massa non richiesto.

---

## 1. Le tre regole che non si negoziano

Sono le uniche con un incidente di produzione alle spalle. Violarle non è
"stile": è un crash o una release rotta.

### 1.1 Mai `Dictionary(uniqueKeysWithValues:)` su chiavi derivate

Chiave derivata = lowercase, `SearchNormalizer.normalize`, slug, nome, hash.
Duplicati → `fatalError`, cioè crash in mano all'utente.

```swift
// NO — crasha su due personaggi con lo stesso nome normalizzato
Dictionary(uniqueKeysWithValues: cast.map { (normalize($0.name), $0) })

// SÌ
Dictionary(cast.map { (normalize($0.name), $0) }, uniquingKeysWith: { first, _ in first })
```

Permesso **solo** su doc id Firestore (`.id`, `.uid`, `.titleId`, `.documentID`,
`.tmdbId`), che sono unici per costruzione.

*Perché*: v0.3.22, "La Casa di Carta Korea" crashava a ogni apertura in
`mergeCharacters`. Fix in v0.3.23.
*Chi la fa rispettare*: `scripts/check-swift-footguns.mjs`, via hook pre-commit
**e** job `swift-guards` in CI (non aggirabile con `--no-verify`).

### 1.2 Niente helper dopo un `#if DEBUG` a fondo file

Un helper scritto sotto il blocco `#if DEBUG` delle `#Preview` finisce **dentro**
il blocco: Debug compila, la build Release no. Metti gli helper **prima** del
blocco preview, e comunque compila in Release prima di dichiarare chiuso un
lavoro che ha toccato la struttura di un file.

*Perché*: già successo — Debug verde, archive fallito.
*Chi la fa rispettare*: `scripts/ios-ci.sh --full` (build Release), che gira nel
preflight di `scripts/ios-release.sh`.

### 1.3 Il gate iOS gira sul Mac, e non si salta

- `scripts/ios-ci.sh --lint-only` → footgun + SwiftLint (secondi)
- `scripts/ios-ci.sh --fast` → + xcodegen + build Debug — **è l'hook pre-push**
- `scripts/ios-ci.sh --full` → + build Release + test — prima di rilasciare

Baseline SwiftLint: **18 warning**. Se sale, il push fallisce. Non alzare la
soglia per far passare il tuo diff: o chiudi il warning, o discuti la regola.

*Perché non è su GitHub Actions*: runner macOS ×10 → il monte gratuito basta a
~1 run/mese contro ~138 richieste. Dettagli in `docs/IOS_REFACTOR_PLAN.md` §Fase 0.

---

## 2. Stato e osservabilità

Somto è **già** interamente su Observation. Non c'è un solo `ObservableObject`,
`@Published`, `@StateObject` o `@EnvironmentObject` nel modulo, e non ne deve
entrare uno.

| Cosa ti serve | Cosa usi |
|---|---|
| Modello osservabile (ViewModel, store, service) | `@Observable @MainActor final class` |
| La View **possiede** quel modello | `@State private var vm: XViewModel` |
| La View lo **riceve** già vivo | `let vm: XViewModel` (semplice property) |
| Ti serve un `Binding` verso il modello ricevuto | `@Bindable var vm: XViewModel` |
| Stato locale di UI (sheet aperto, testo di un campo) | `@State private var` |
| Dipendenza di processo | `@Environment(SessionStore.self)` / `AppShellStore` / `AppContainer` |

**Regole:**

1. Il ViewModel è `@Observable` **e** `@MainActor`, `final class`. Sempre tutte e tre.
2. Le dipendenze entrano da `init`, mai da singleton letti dentro i metodi.
   Esempio: [`AppContainer`](../../ios/TwoWatch/App/AppContainer.swift) costruisce
   tutto una volta e lo passa giù.
3. Campi che non devono ridisegnare la View (contatori di generazione, cache,
   handle di task) vanno marcati `@ObservationIgnored`. Esempio corretto:
   `loadGeneration` in [TitleDetailViewModel.swift:83](../../ios/TwoWatch/Features/TitleDetail/TitleDetailViewModel.swift:83).
4. **Un ViewModel per schermata, in un file suo** `XViewModel.swift`. Non dentro
   il file della View. (Debito noto: alcuni VM vivono ancora nel file della View
   — vedi Fase 3 del piano. Quelli nuovi nascono già separati.)
5. Il modello **non** conosce SwiftUI: niente `View`, `Color`, `Font` dentro un
   ViewModel se non per token già definiti.

**Anti-pattern da non reintrodurre**: due sorgenti di verità per lo stesso dato
— un `@State` che copia un valore che vive anche altrove. Se lo copi, devi
risincronizzarlo a mano, e prima o poi te ne dimentichi (§3.3).

---

## 3. Persistenza locale — `UserDefaults` e `@AppStorage`

Fino al 2026-08-09 convivevano tre stili di accesso e cinque convenzioni di
chiave. Ora c'è un registro unico,
[`SomtoDefaultsKey`](../../ios/TwoWatch/Core/Persistence/SomtoDefaults.swift):
**ogni chiave nuova si dichiara lì**, nessuna stringa letterale sparsa nel codice.

### 3.1 Convenzione di chiave — unica

```
somto.<area><Cosa>.v<N>
```

minuscolo dopo il prefisso, camelCase per il resto, versione **sempre**.
Esempi validi: `somto.watchlistIntroSeen.v1`, `somto.pushBannerDismissedAt.v1`.

Vietati: prefisso `twowatch` (brand vecchio), snake_case, chiavi senza prefisso,
chiavi senza `.vN`.

La versione non è decorazione: quando cambia il *significato* o il *tipo* di un
flag, si incrementa `.vN` invece di reinterpretare i valori già scritti sui
device degli utenti. Un `Bool` che diventa `Int` senza bump legge spazzatura.

### 3.2 Chiavi dinamiche: vietate

Una chiave che contiene un id (`somto.importSeen.<importID>`) è una **perdita di
memoria su disco**: cresce a ogni import e non viene ripulita mai. `UserDefaults`
è caricato per intero all'avvio dell'app.

Se ti serve "ricorda le ultime N cose viste": **una** chiave con dentro una
collezione **con un tetto esplicito** (es. ultimi 20, FIFO). Se non puoi mettere
un tetto sensato, il dato non va in `UserDefaults`: va in Firestore.

Forma di riferimento:
[`ImportRevealStore`](../../ios/TwoWatch/Domain/Services/ImportRevealStore.swift),
che ha sostituito `home_import_reveal_seen_<importID>` — una chiave nuova a ogni
import, mai cancellata.

**Rinominare una chiave non è gratis**: il valore vive sui device di utenti
reali, su un'app già pubblicata. Va aggiunta una voce in
`SomtoDefaultsMigration` — che **copia e non cancella**. Una rinomina secca
avrebbe rimesso a "non letti" tutti i thread di tutti.

La cancellazione delle chiavi vecchie è un passo **separato e successivo**, da
fare solo quando la coorte App Store è passata (`docs/PENDING.md`). Il motivo è
che su un device non si torna indietro: se la copia avesse un difetto e la
legacy fosse già sparita, il dato dell'utente sarebbe perso e nessuna release
potrebbe recuperarlo. Tenerla costa byte, toglierla costa il dato.

### 3.3 Chi può leggere `UserDefaults`, e come

**Mai dentro una View, in nessuna forma diretta.** In particolare mai così:

```swift
// NO — snapshot congelato al primo init della View. Se un'altra schermata
// scrive quella chiave, questa View non lo saprà mai.
@State private var isDismissed = UserDefaults.standard.bool(forKey: someKey)
```

(Era `HomeView`, corretto il 2026-08-09.)

Due modi ammessi, in ordine di preferenza:

**(a) Un service `@Observable` — default per qualsiasi flag con logica.**
`UserDefaults` iniettabile da `init` (così è testabile), chiavi in un `enum Key`
privato, l'esterno vede solo proprietà di dominio. Modello di riferimento:
[MatchHintService.swift](../../ios/TwoWatch/Domain/Services/MatchHintService.swift).

```swift
@Observable @MainActor
final class MatchHintService {
    private enum Key { static let hintSeen = "somto.matchHintSeen.v1" }
    private let defaults: UserDefaults
    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    var shouldShowHint: Bool { !defaults.bool(forKey: Key.hintSeen) }
    func markHintSeen() { defaults.set(true, forKey: Key.hintSeen) }
}
```

Il service si registra in `AppContainer` e arriva alla View per `init` o
`@Environment`. Il vantaggio non è teorico: un test può passargli un
`UserDefaults(suiteName:)` usa e getta e verificare la logica senza device.

**(b) `@AppStorage` — solo per preferenze di pura UI, lette e scritte da una
sola View, senza logica attorno.** Es. l'unità di misura di una schermata, un
"intro visto" di quella schermata e basta. Appena il flag serve a due punti o ha
una regola ("mostra al massimo una volta a settimana"), diventa un service (a).

**Regola d'oro**: un flag ha **un solo** proprietario. Se lo leggi con
`@AppStorage` in una View e lo scrivi con `UserDefaults.standard.set` in
un'altra, hai già il bug — sono due sorgenti di verità che non si parlano.

### 3.4 `@AppStorage` va tipizzato, non lasciato grezzo

`@AppStorage` supporta `Bool`, `Int`, `Double`, `String`, `URL`, `Data` **e
qualsiasi enum `RawRepresentable`** con raw value `String` o `Int`. Usa l'enum:
il compilatore garantisce che sul disco finiscano solo casi validi, e sparisce la
conversione a mano a ogni lettura.

```swift
// NO — raw String + conversione difensiva sparsa nella View
@AppStorage(SomtoDefaultsKey.watchTimeUnit) private var raw = WatchTimeUnitMode.dhm.rawValue
private var mode: WatchTimeUnitMode { WatchTimeUnitMode(rawValue: raw) ?? .dhm }

// SÌ
@AppStorage(SomtoDefaultsKey.watchTimeUnit) private var mode: WatchTimeUnitMode = .dhm
```

### 3.5 Dove NON va `UserDefaults`

Niente PII, token, credenziali (→ Keychain). Niente dati che devono seguire
l'utente fra device (→ Firestore). Niente cache di rete (→ memoria o disco con
policy propria). `UserDefaults` è per **preferenze e flag di attrito**: piccoli,
locali, sacrificabili.

---

## 4. Concorrenza

Swift 6 language mode è attivo. L'obiettivo dichiarato è
`SWIFT_STRICT_CONCURRENCY: complete` a zero warning (Fase 5 del piano).

1. **UI su `@MainActor`.** ViewModel e service di UI sono `@MainActor` a livello
   di tipo, non con annotazioni sparse sui metodi.
2. **`DispatchQueue.main.async` è un residuo.** In codice nuovo non esiste: c'è
   `@MainActor` e `await`. (7 usi residui da migrare quando li tocchi.)
3. **Lavoro legato alla vita di una View → `.task` / `.task(id:)`**, che si
   cancella da solo quando la View sparisce o l'id cambia. `Task { }` dentro il
   `body` o in `onAppear` è vietato per il *caricamento*: non viene cancellato,
   e navigare avanti e indietro accumula lavoro. `Task { }` dentro l'azione di un
   `Button` va bene — è un evento, non un ciclo di vita.
4. **`Task.detached` quasi mai.** Perde contesto e priorità. Se ti serve, spiega
   perché in un commento.
5. **Race di navigazione**: se un caricamento può essere superato da un altro
   (l'utente apre un titolo, torna, ne apre un altro), serve una **guardia di
   generazione** — incrementi un contatore e scarti i risultati vecchi. Modello:
   `loadGeneration` in [TitleDetailViewModel.swift:130](../../ios/TwoWatch/Features/TitleDetail/TitleDetailViewModel.swift:130).
6. **Doppio tap**: le azioni che scrivono passano da una guardia sincrona.
   Modello: `beginAction(_:)` in [TitleDetailViewModel.swift:116](../../ios/TwoWatch/Features/TitleDetail/TitleDetailViewModel.swift:116).
7. **`HTTPSCallable.call(_:)` async non si usa**: crasha (`async let` fatalError
   in `SendableHTTPSCallable.call`). Passa sempre da `CloudFunctionsCaller`.
8. **Uno snapshot listener si rimuove.** Oggi sono 3 in tutta l'app, tutti nei
   repository, tutti con `remove()`. Se ne aggiungi uno, mantieni l'invariante.

---

## 5. Errori — il silenzio è una decisione, non un default

Nel modulo ci sono **169 `try? await`**. In molti casi tacere è giusto: una
sezione accessoria che non carica non deve bloccare la schermata. Ma "non lo
mostro all'utente" non deve voler dire "non lo so".

```swift
// NO — se fallisce, la sezione appare vuota. Identica a "nessun dato".
// Non arriva niente a Crashlytics, nessuno se ne accorge.
let providers = try? await repo.fetchProviders(for: id)

// SÌ — l'utente non viene disturbato, noi lo sappiamo.
do {
    providers = try await repo.fetchProviders(for: id)
} catch {
    SilentFailure.record(error, context: "TitleDetail.providers")
}
```

- Errori su un **percorso che l'utente ha innescato** (salva, vota, invia):
  stato di errore visibile + copy che dice cosa fare. Mai silenzio.
- Errori su **contenuto accessorio**: `SilentFailure.record`, mai `try?` nudo.
- [`SilentFailure`](../../ios/TwoWatch/Core/Utilities/SilentFailure.swift) scarta
  già cancellazioni e rete assente — non serve filtrarle a monte, e **non**
  aggiungere altri filtri senza motivo misurato.
- Mai `catch {}` vuoto. Mai `try!` fuori da un invariante di boot.

### 5.1 `error.localizedDescription` non è copy

`error.localizedDescription` è la stringa che arriva da Firestore, dalle
Functions o da URLSession: scritta per uno sviluppatore, **sempre in inglese**
anche con l'app in italiano (non passa dal catalogo di traduzione), e muta su
cosa l'utente possa farci. È da lì che è uscito il
*"Missing or insufficient permissions."* letto dagli utenti al cambio account.

**Non va mai in uno stato mostrato all'utente.** Il mapper comune è
[`UserFacingError`](../../ios/TwoWatch/Core/Utilities/UserFacingError.swift):
classifica per dominio e codice (Firestore/Functions, URLSession, Auth) e
restituisce una delle cinque frasi già condivise con il web.

```swift
// NO
errorMessage = error.localizedDescription

// SÌ
errorMessage = UserFacingError.message(for: error)
```

Quando un errore ha un significato di dominio proprio, **non allargare il
mapper**: scrivi un enum che conforma a `Error` e `LocalizedError`.
`UserFacingError` lo riconosce e ne rispetta il testo — è così che convivono i
messaggi generici e quelli specifici (`TitlesImportError`, `QuizInviteError`,
`CallableError`, …).

Aggiungere un sesto caso generico significa aggiungere una frase: prima cercala
su iOS **e** sul web e riusala identica (§8).

Regola operativa: **l'errore tecnico va a `SilentFailure`, all'utente va la frase
di dominio.** I due non sono alternativi — servono entrambi, sempre.

---

## 6. View

### 6.1 Niente `AnyView`

`AnyView` cancella il tipo: SwiftUI perde l'identità della View e non può più
saltare i sotto-alberi nel diffing. Il 100% dei casi in Somto è risolvibile con
`@ViewBuilder`:

```swift
// NO
func row(_ state: State) -> some View {
    guard let title = state.title else { return AnyView(EmptyView()) }
    return AnyView(TitleRow(title: title))
}

// SÌ
@ViewBuilder
func row(_ state: State) -> some View {
    if let title = state.title { TitleRow(title: title) }
}
```

Nota: `body` è già un contesto `@ViewBuilder`, quindi dentro `body` l'`if let`
basta da solo — l'attributo serve solo sulle funzioni e sulle property che
costruisci a mano.

Quando l'`AnyView` è una **property** e non un ritorno di funzione (era il caso di
`SearchSuggestionStrip.trailing`), la soluzione è un parametro generico più un
overload per il caso vuoto:

```swift
struct SearchSuggestionStrip<Trailing: View, Content: View>: View {
    @ViewBuilder var trailing: () -> Trailing
    @ViewBuilder var content: () -> Content
}

extension SearchSuggestionStrip where Trailing == EmptyView {
    init(title: LocalizedStringKey, icon: String, @ViewBuilder content: @escaping () -> Content) {
        self.init(title: title, icon: icon, trailing: { EmptyView() }, content: content)
    }
}
```

Al 2026-08-09 il modulo ha **zero** `AnyView`. È un'invariante: se ne rientra uno,
è perché una firma va resa generica, non perché serviva la type erasure.

### 6.2 Liste: `Lazy*` quando la lista è illimitata

Una lista **senza tetto** (feed, inbox, commenti, risultati di ricerca) va in
`LazyVStack` / `LazyVGrid` / `List`. Una lista **limitata per costruzione**
(generi di un titolo, 4 tab, 5 chip di filtro) resta in `VStack`/`HStack`: la
pigrizia lì costa più di quanto rende, e convertirla è rumore con rischio visivo.

Il criterio è "può crescere con i dati dell'utente?", non "è un `ForEach`?".

### 6.3 Dimensione e composizione

- **Nessun file sopra le 800 righe.** È il criterio di uscita del piano di
  refactoring, e vale già oggi per i file nuovi.
- Una `struct View` che supera ~150 righe di `body` si spezza in sotto-View
  **con un nome**, non in `var section: some View` a catena.
- **Prop drilling**: una View che riceve più di ~8 parametri, o più di 3 closure,
  sta chiedendo un ViewModel o uno store, non altri parametri. (Precedente:
  `TitleDetailScreen` era a 28 parametri di cui 17 closure — portato a 12.)
- `GeometryReader` solo quando serve davvero la misura del contenitore: rompe il
  sizing naturale ed è la causa tipica dei layout che collassano.

### 6.4 Accessibilità

L'app ha già 62 `accessibilityElement` e 26 `@ScaledMetric`: la disciplina esiste,
va solo applicata a ciò che si scrive di nuovo.

- **Icona senza testo** → `.accessibilityLabel` breve e descrittiva. Su un
  bottone, la label descrive l'**azione**, l'hint descrive l'**esito**.
- **Più view che sono un concetto solo** (icona + numero + unità) →
  `.accessibilityElement(children: .combine)` + una label unica. Senza,
  VoiceOver legge tre frammenti scollegati.
- **Decorazioni** → `.accessibilityHidden(true)`.
- **Numeri che devono scalare** (lato di un'icona, padding di una card) →
  `@ScaledMetric(relativeTo:)`, non una costante. I font semantici scalano già
  da soli; le misure no.

### 6.5 Formattazione: locale-aware, non "italiana"

`Text(value, format:)` e `.formatted()` scelgono separatore decimale, gruppi e
nomi dei giorni in base al locale dell'utente. Un formatter costruito a mano no.

```swift
// NO
Text(String(format: "%.1f", rating).replacingOccurrences(of: ".", with: ","))

// SÌ
Text(rating, format: .number.precision(.fractionLength(1)))
```

**Distinzione che conta**: `Locale(identifier: "en_US_POSIX")` per **fare il
parsing** di un formato fisso (le date TMDB) è l'idioma corretto e va lasciato.
Un locale fisso per **mostrare** un valore è un bug: l'app è bilingue dal
2026-07-29, e un utente inglese si vede `7,5` invece di `7.5`.

*Debito noto*: `RatingDisplayFormat` forza `it_IT` di proposito. Non cambiarlo di
iniziativa — la stessa scelta esiste sul web e vanno decisi insieme.

### 6.6 Immagini

`CachedAsyncImage` sempre, `AsyncImage` mai (oggi: 0 usi grezzi — invariante da
mantenere). Poster e avatar hanno già i loro componenti: `PosterImageView`,
`SomtoAvatar`.

---

## 7. Design system

`DesignSystem/Theme/SomtoTokens.swift` definisce spaziature, raggi, elevazioni,
superfici. `TwoWatchTheme` i colori.

- **Mai un numero magico** per `spacing`, `cornerRadius`, `shadow` in codice
  nuovo: `SomtoSpacing.*`, `SomtoRadius.*`, `SomtoElevation.*`.
- **Mai `Color(hex:)` fuori dal Theme.** Se un colore ti manca, si aggiunge al
  Theme e si discute — non si inventa nel file della feature.
- **Componenti prima di tutto**: `GlassCard`, `SomtoAvatar`, `SomtoInitials`,
  `EmptyStateView`, `MetricTile`, `PosterImageView`, `PrimaryButtonStyle`,
  `SpoilerGate`. Prima di scrivere una card, una chip o un avatar nuovi,
  **cerca**: la duplicazione qui è il difetto storico numero uno (`initials(for:)`
  esisteva in 10 copie, `formatScore` in 8).
- **I token valgono gli stessi pixel di oggi.** Migrare un call site ai token non
  deve cambiare l'aspetto. Se una schermata cambia, è un errore di migrazione.
- **Vincolo di prodotto**: niente redesign, logo invariato, palette e tipografia
  invariate (CLAUDE.md).

### 7.1 La forma di un pezzo di design system

Tre forme, in ordine di scelta:

**(a) Un componente**, quando c'è contenuto proprio (`GlassCard`, `SomtoAvatar`).

**(b) Un `ViewModifier` + una `extension View`**, quando è *trattamento* applicato
a contenuto altrui — sfondo, bordo, ombra, padding. È la forma che manca oggi, ed
è il motivo per cui esistono 476 `RoundedRectangle` scritti a mano: senza un
`.somtoCard()` chiamabile, ognuno se lo riscrive.

```swift
struct SomtoCardModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(SomtoSpacing.xl)
            .background(SomtoSurface.panel)
            .clipShape(RoundedRectangle(cornerRadius: SomtoRadius.l, style: .continuous))
    }
}

extension View {
    func somtoCard() -> some View { modifier(SomtoCardModifier()) }
}
```

**(c) Un container `@ViewBuilder` generico**, quando il pezzo condiviso è il
*guscio* (header + layout) e il contenuto è arbitrario. Generico sul contenuto,
mai `AnyView`: vedi `SearchSuggestionStrip`, che è la forma di riferimento anche
per la view accessoria opzionale (parametro generico + overload
`where Trailing == EmptyView`).

### 7.2 Tipografia: nomi, non misure

Le dimensioni fisse residue non vanno sostituite una per una con altri numeri: si
dichiarano una volta come `extension Font` e si usa il nome. Un cambio di peso o
di scala diventa una riga, non una battuta di caccia.

```swift
extension Font {
    static let somtoSectionTitle = Font.headline.weight(.bold)
}
```

I font semantici (`.caption`, `.subheadline`, …) restano la norma: sono già 1.271
contro 253 a dimensione fissa, e scalano da soli.

### 7.3 Griglie

`LazyVGrid`/`LazyVHGrid` con `GridItem(.adaptive(minimum:))` quando il numero di
colonne deve dipendere dalla larghezza disponibile — è più robusto di un conteggio
fisso e si adatta da solo alla rotazione e alle taglie accessibility.
`.flexible()` per colonne che si dividono lo spazio in parti uguali, `.fixed()`
solo quando la misura è un vincolo reale.

### 7.4 Dynamic Type

L'app è già in larga parte su font semantici (`.caption`, `.subheadline`, …).
Le dimensioni fisse restano ~225 punti e vanno convertite **a vista**, guardando
la schermata alle taglie accessibility: ingrandire un'etichetta da 11pt su una
chip stretta ne rompe il layout. Per i casi che devono scalare da dimensione
fissa c'è `SomtoScaledFont`.

Eccezione documentata: le iniziali di `SomtoAvatar` **non** scalano (la
dimensione è calcolata sul diametro del cerchio). Non "correggerla".

---

## 8. Copy e i18n

- **Una frase sola per un concetto solo, su iOS e web.** La chiave di traduzione
  *è* la stringa italiana: `"Thread non trovato"` e `"Thread non trovato."` sono
  due chiavi, due traduzioni, due cose da mantenere.
- Prima di scrivere copy nuovo, **cerca** in `Localizable.xcstrings` e in
  `public/js/i18n/en.js` e riusa identico. Se va cambiato, si cambia su entrambe
  le piattaforme.
- A parità di senso vince la formulazione più corta.
- Casi reali e glossario: `docs/I18N_GLOSSARY.md`.

---

## 9. Dati, dipendenze, testabilità

- I ViewModel dipendono da **protocolli**, non da classi concrete, altrimenti non
  sono istanziabili in un test senza Firebase. Oggi esistono
  `TitleRepositoryProtocol`, `UserRepositoryProtocol`,
  `WatchlistRepositoryProtocol`, `AnalyticsLogging`: il repository che tocchi
  per primo si porta dietro il suo protocollo.
- **Nessuna View istanzia un repository.** Tutto passa da `AppContainer`.
  (Precedente da non ripetere: `ProfileView` e `UserProfileDetailView` avevano
  `TitleRepository()` come default di parametro.)
- **Decoding**: i modelli nuovi sono `Codable`. Il decoding manuale da
  `[String: Any]` è debito (168 occorrenze, 2 modelli su 11 su `Codable`): un
  campo rinominato lato backend non dà errore, dà `nil` silenzioso.
  `Core/Utilities/FirestoreValueReader` mitiga i tipi, non i campi mancanti.
- **Fixture**: `App/PreviewSupport.swift` (959 righe) ha già utenti, titoli, feed,
  watchlist, rating, notifiche realistici. Servono alle Preview **e** ai test:
  non scrivere fixture nuove senza aver guardato lì.
- **Ogni bug corretto lascia un test**, se la logica è isolabile. È il modo in cui
  si esce dal ciclo "spedisci → il tester lo trova → patcha".

---

## 10. File, naming, struttura

```
ios/TwoWatch/
  App/            container, sessione, shell, push, preview support
  Core/           extension e utility trasversali
  Data/           repository (Firebase), analytics, import
  Domain/         modelli, protocolli di repository, service di dominio
  DesignSystem/   Theme (token, colori) + Components (riusabili)
  Features/<X>/   una cartella per schermata/area
```

- Feature nuova → cartella sua sotto `Features/`, con
  `XView.swift` + `XViewModel.swift` + eventuali `XComponents.swift`.
- Un tipo pubblico per file, nome file = nome tipo.
- I componenti riusabili stanno in `DesignSystem/Components`, **non** in
  `Features/`. Se lo useranno in due, si sposta subito.
- I commenti spiegano il **perché**, non il **cosa**. Questo repo lo fa già bene:
  è una qualità da preservare, non da tagliare per brevità.

### 10.1 Spostare un tipo `private` in un altro file

`private` su una dichiarazione top-level vale **fileprivate**: due file possono
avere ognuno il proprio `private struct Card` senza accorgersene. Quando ne
estrai uno deve diventare `internal`, per restare visibile all'originale — e a
quel punto il gemello omonimo diventa `invalid redeclaration`.

Prima di estrarre, cerca il nome nel modulo. Se esiste un gemello:

- **due componenti diversi con lo stesso nome** → rinomina quello che sposti in
  modo che dica cosa fa, e lascia l'altro dov'è. Non unificarli: se hanno
  palette o misure diverse, unificarli **cambia l'aspetto** di una schermata, e
  un refactoring non cambia l'aspetto (§13);
- **stessa identica implementazione** → allora è duplicazione vera, e va in
  `DesignSystem/Components` con un nome solo.

Caso reale (2026-08-09): `WrapChipsView` esisteva in `ProfileComponents` con la
palette chiara della paper card e in `UserProfileDetailView` con quella scura del
tema. Il primo è diventato `ProfileTasteChipsView`.

---

## 11. Git e rilascio (estratto operativo)

Il canone è in `CLAUDE.md`; qui solo ciò che si dimentica su iOS:

- Si lavora su `main`, commit piccoli, push subito. Niente branch lunghi di
  refactoring.
- Commit separati per area (iOS / functions / rules).
- Prima di un archive: bump di **`MARKETING_VERSION` e `CURRENT_PROJECT_VERSION`**
  in `ios/project.yml` (mai in `Info.plist`: `CFBundleVersion` deve restare
  `$(CURRENT_PROJECT_VERSION)`).
- Dopo `xcodegen generate`, non committare `ios/build/` né `xcuserdata/`.
- Niente deploy senza dirlo prima all'utente.

---

## 12. Checklist — prima di dire "fatto"

- [ ] `scripts/ios-ci.sh --fast` verde (lo fa già l'hook pre-push, ma se hai
      toccato la struttura di un file, fai `--full`: la Release è l'unica cosa
      che intercetta il footgun `#if DEBUG`)
- [ ] SwiftLint non è salito sopra i **18** warning
- [ ] zero `AnyView`, zero `DispatchQueue.main.async`, zero `try?` nudo **nel
      codice che hai scritto**
- [ ] nessun `error.localizedDescription` finisce in uno stato mostrato
      all'utente (§5.1); i valori che l'utente vede sono formattati con
      `format:`/`.formatted()`, non con un locale fisso (§6.5)
- [ ] chiavi `UserDefaults` nuove: prefisso `somto.`, `.vN`, **non** dinamiche,
      proprietario unico
- [ ] nessun file che hai creato supera le 800 righe
- [ ] spaziature/raggi/colori presi dai token, nessun numero magico nuovo
- [ ] copy nuovo cercato prima su iOS **e** web, riusato identico se esiste
- [ ] se hai corretto un bug con logica isolabile, c'è un test che lo fissa
- [ ] `git status --short` pulito e tutto pushato su `main`

---

## 13. Cosa NON fare

- **Non introdurre un'architettura nuova** (TCA, Redux, Clean a 5 layer). Il
  problema di questo codice è disciplina di struttura, non il pattern. Un cambio
  di paradigma su un'app live a bus factor 1 è il rischio più grande di tutti.
- **Non riscrivere i ViewModel**: sono buoni. Vanno spostati e resi testabili.
- **Non fare passaggi di massa non richiesti** (normalizzare tutti gli spacing,
  convertire tutti i `ForEach` in `LazyVStack`, "sistemare" tutte le stringhe).
  Rumore ad alto rischio visivo e guadagno nullo. Si migra ciò che si tocca.
- **Non cambiare il look** durante un refactoring. Il redesign, se lo si vuole, è
  un progetto separato *dopo*.
- **Non toccare Firestore, rules o Functions** dentro un lavoro di qualità
  client-side. Se emerge un bisogno backend, va in una proposta a parte con
  Database Architect + Security Reviewer (CLAUDE.md).
- **Non fidarsi del client** per privacy, ownership, permessi.

---

## 14. Debito aperto tracciato altrove

Questo file dice come si scrive **da adesso**. Cosa resta da bonificare, con
fasi, rischi e criteri di uscita: `docs/IOS_REFACTOR_PLAN.md` §3 e §4.

In sintesi, al 2026-08-09:

| Debito | Misura | §  |
|---|---:|---|
| `try? await` non strumentati | 169, di cui 7 con `SilentFailure` | 5 |
| File oltre 800 righe | **25** (max: `TitleRepository` 2.954) | 6.3 |
| Repository senza protocollo | 8 su 12 (3 ViewModel su ~20 testabili) | 9 |
| Modelli senza `Codable` | 9 su 11, 168 `[String: Any]` | 9 |
| Warning di isolamento concorrenza | 12 | 4 |
| `DispatchQueue.main.async` residui | 7 | 4 |

**Chiuso il 2026-08-09**:
- persistenza locale unificata (§3) — registro unico, migrazione senza perdita di
  dati, chiavi dinamiche sostituite da una lista con tetto, `@AppStorage` tipizzato;
- **zero `AnyView`** nel modulo (§6.1) — 6 `body` con `guard`+`AnyView` riscritti
  come `if let`, `SearchSuggestionStrip` reso generico sulla view accessoria;
- **zero `error.localizedDescription` mostrati all'utente** (§5.1) — 124 call
  site passano da `UserFacingError`, con cinque frasi già condivise col web;
- **i tre monoliti di View spezzati** (§6.3), solo spostamento di codice:
  `WatchlistView` 5.913 → 1.268 (11 file), `CommunityView` 3.583 → 316 (9 file),
  `TitleDetailSections` 3.185 → 8 file (guscio eliminato).

**Chiuso il 2026-08-09 (secondo giro)**: `WatchlistViewModel` e
`ProfileViewModel` passano ai protocolli e hanno test (16 nuovi, 108 in tutto
su 2.301 righe, contro le 97 righe di agosto); chiusi i due bypass di
`AppContainer` (`titleRepository: TitleRepository = TitleRepository()` come
default di parametro, cioè una seconda istanza con cache proprie).

**Non convertito di proposito**: `SearchViewModel`. Tre delle sue chiamate
(`cacheCatalogSearchResults`, `cachedCatalogSearchResults`,
`mergeCatalogSearchResults`) sono la cache interna del repository che affiora nel
ViewModel: metterle in un protocollo di dominio sancirebbe la perdita invece di
chiuderla. Prima va deciso dove vive quella cache.

Restano **25 file sopra le 800 righe**. I due repository più grandi
(`TitleRepository` 2.954, `WatchlistRepository` 2.501) **non** si spezzano
ulteriormente: richiederebbe rendere `internal` `db` e le cache, cioè esporre
Firestore a tutto il modulo per guadagnare una divisione di file.
