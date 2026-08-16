import AppIntents
import Foundation

/// Errori di dominio degli App Intent.
///
/// Esistono per la stessa ragione di §5.1: quello che l'intent lancia lo
/// **legge Siri ad alta voce**, quindi non puo' essere un errore tecnico.
/// `UserFacingError` rispetta i `LocalizedError` di dominio, quindi queste
/// frasi vincono senza dover allargare la tabella generica.
enum SomtoIntentError: Error, LocalizedError {
    case notSignedIn
    case titleUnavailable

    var errorDescription: String? {
        switch self {
        case .notSignedIn:
            String(localized: "Apri Somto e accedi per aggiungere titoli alla watchlist.")
        case .titleUnavailable:
            String(localized: "Non trovo questo titolo su Somto.")
        }
    }
}

struct AddToWatchlistIntent: AppIntent {
    static let title: LocalizedStringResource = "Aggiungi a watchlist"
    static let description = IntentDescription("Salva un film o una serie nella tua watchlist Somto.")

    /// L'intent scrive e basta: non c'e' niente da guardare. Aprire l'app
    /// strapperebbe fuori dal contesto chi l'ha invocato a mani libere, e in
    /// un'automazione la aprirebbe senza che nessuno stia guardando.
    static let openAppWhenRun = false

    /// NASCOSTO DI PROPOSITO (2026-08-12) — sul dispositivo l'intent risponde
    /// "c'e' stato un problema", cioe' l'errore GENERICO di sistema: se il
    /// guasto fosse arrivato al codice qui sotto avremmo letto una delle frasi
    /// di `SomtoIntentError`. Il difetto sta quindi PRIMA di `perform()`, nella
    /// query dell'entity o nel bootstrap headless.
    ///
    /// Una scorciatoia visibile che fallisce e' peggio di una assente, e questa
    /// build va a utenti reali. Finche' non e' diagnosticato:
    /// `isDiscoverable = false` la toglie anche dall'app Scorciatoie — togliere
    /// solo `AppShortcutsProvider` avrebbe tolto le frasi Siri e Spotlight ma
    /// l'avrebbe lasciata li'.
    ///
    /// Il codice resta: serve comunque, perche' i bottoni dei widget
    /// interattivi sono App Intent.
    static let isDiscoverable = false

    /// Distingue le scritture fatte da qui nelle metriche prodotto, senza
    /// dover indovinare l'adozione dai numeri aggregati.
    static let analyticsSource = "ios_app_intent"

    @Parameter(title: "Titolo")
    var titleEntity: SomtoTitleEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Aggiungi \(\.$titleEntity) a watchlist")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let context = SomtoIntentContext.shared

        // Controllo per primo: il caso "non loggato" non deve pagare un round
        // trip per scoprirlo.
        guard let userID = context.currentUserID else {
            throw SomtoIntentError.notSignedIn
        }

        let title = try await resolveTitle(context: context, userID: userID)

        // Gia' dentro: niente scrittura. Risparmia un'invocazione della
        // callable e il budget di rate limit (20/10s, 1200/giorno per uid).
        //
        // La guardia legge `generalWatchlist`, cioe' ESATTAMENTE il campo che
        // la scrittura qui sotto imposta. `isInWatchlist` sembrerebbe la
        // funzione giusta ma risponde a un'altra domanda: su un titolo gia'
        // iniziato ritorna `rewatchIntent`, non `generalWatchlist`
        // (WatchlistRepository.swift:751-766). Usandola, per ogni serie in
        // corso la guardia non sarebbe mai scattata e ogni invocazione avrebbe
        // riscritto.
        let currentState = try await context.watchlistRepository.fetchTitleState(userID: userID, title: title)
        if currentState.generalWatchlist {
            return .result(dialog: "Già in watchlist")
        }

        // Idempotente per costruzione. `WatchlistRepository` espone anche
        // `toggleWatchlist`, che qui sarebbe un bug: Siri ritenta e le
        // automazioni Scorciatoie ciclano, quindi alla seconda esecuzione un
        // toggle **toglierebbe** il titolo dalla watchlist.
        _ = try await context.watchlistRepository.updateGeneralWatchlist(
            userID: userID,
            title: title,
            isIncluded: true,
            source: Self.analyticsSource
        )

        return .result(dialog: "\(title.name) è in watchlist")
    }

    /// Dall'entity al `Title` su cui si scrive davvero.
    @MainActor
    private func resolveTitle(context: SomtoIntentContext, userID: String) async throws -> Title {
        if let existing = try await context.titleRepository.fetchTitle(id: titleEntity.id) {
            return existing
        }

        guard let tmdbID = titleEntity.pendingTMDBID else {
            throw SomtoIntentError.titleUnavailable
        }

        // Il titolo non e' ancora in catalogo. Lo si crea SOLO ora, dopo che
        // l'utente ha scelto questa voce — non mentre gliele mostravamo: una
        // disambiguazione annullata non deve lasciare titoli nuovi in giro.
        //
        // E' l'unico ramo che paga la lettura del profilo: `importTMDBTitle`
        // vuole un `AppUser` per `permissions.canAutoApproveTitles`
        // (TitleRepository.swift:1077), non un uid. Sul catalogo locale la
        // lettura non si fa.
        guard let appUser = try await context.userRepository.fetchUser(uid: userID) else {
            throw SomtoIntentError.titleUnavailable
        }

        // `resolveTMDBSearchResult` e' la STESSA funzione di `SearchView`, con
        // i suoi tre dedupe prima di creare. Ricostruire il risultato dai
        // campi dell'entity e' sicuro: `fetchTMDBDetails` rilegge tutto da
        // TMDB per `tmdbId` + `mediaType`, e usa `title` solo come fallback.
        let searchResult = TMDBSearchResult(
            id: titleEntity.id,
            tmdbId: tmdbID,
            mediaType: titleEntity.mediaType,
            title: titleEntity.name,
            originalTitle: titleEntity.name,
            year: titleEntity.year,
            overview: "",
            posterURL: nil,
            genreIds: []
        )

        return try await context.titleRepository.resolveTMDBSearchResult(searchResult, currentUser: appUser)
    }
}
