@preconcurrency import FirebaseAuth
import Foundation

/// Cablaggio minimo condiviso dagli App Intent.
///
/// PERCHE' NON USA `AppContainer` — un App Intent gira **nel processo
/// dell'app**, che il sistema puo' lanciare in background senza mai mostrare
/// UI. In quel lancio `AppContainer` puo' non esistere affatto: e' uno
/// `@State` di `TwoWatchApp` (TwoWatchApp.swift:7), quindi il suo
/// inizializzatore parte solo quando SwiftUI valuta la scena.
///
/// E costruirlo qui sarebbe peggio che inutile: `AppContainer.init` avvia il
/// listener di `SessionStore`, che a ogni cambio di stato auth fa
/// `ensureUserDocument` (una **scrittura**), `fetchUser`,
/// `fetchOnboardingNeedsPrompt` e due refresh di cache in background
/// (SessionStore.swift:190-246). Cinque operazioni Firestore per un "aggiungi
/// alla watchlist", ogni volta, ad app chiusa.
///
/// DEVIAZIONE CONSAPEVOLE da §9 di docs/context/IOS_CODE_STYLE.md ("nessuna
/// View istanzia un repository, tutto passa da AppContainer"): qui nascono
/// istanze separate con cache proprie. Il danno che quella regola previene —
/// due viste della stessa schermata che divergono — non si applica a un
/// processo headless che scrive tramite callable e non renderizza niente. La
/// fonte di verita' resta Firestore, e la UI rilegge lo stato quando compare.
@MainActor
final class SomtoIntentContext {
    static let shared = SomtoIntentContext()

    let titleRepository: TitleRepository
    let userRepository: UserRepository
    let watchlistRepository: WatchlistRepository

    private init() {
        // Idempotente (`guard FirebaseApp.app() == nil`), quindi innocua anche
        // se l'app era gia' viva in foreground. Va prima di qualunque
        // `Auth.auth()`.
        FirebaseBootstrap.configureIfNeeded()

        let titles = TitleRepository()
        let users = UserRepository()
        titleRepository = titles
        userRepository = users
        watchlistRepository = WatchlistRepository(titleRepository: titles, userRepository: users)
    }

    /// L'uid dell'utente loggato, letto direttamente da Firebase Auth.
    ///
    /// Non passa da `SessionStore` di proposito: la callable vuole solo
    /// `context.auth.uid`, non il profilo. Auth ripopola `currentUser` dal
    /// Keychain quando l'istanza nasce, quindi il valore e' disponibile subito
    /// dopo `configureIfNeeded()` senza aspettare il listener di stato — e non
    /// si attraversa il percorso limbo `firebaseUser`-senza-`appUser`.
    var currentUserID: String? {
        Auth.auth().currentUser?.uid
    }
}
