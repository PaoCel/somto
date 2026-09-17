import Observation

/// Quali titoli il viewer segue, per il bottone "Segui" delle superfici social.
///
/// PERCHE' UNO STORE E NON UNA LETTURA PER CARD — la preferenza vive in
/// `users/{uid}/titleUpdatePrefs/{titleId}`, e nel feed lo stesso bottone
/// compare su decine di card: una lettura per card sarebbe una lettura ad ogni
/// comparsa in lista. Qui la collezione si legge **una volta**
/// (`fetchTitleUpdatePreferences`) e la mappa resta condivisa fra feed
/// Community e dettaglio post, cosi' seguire da una schermata si vede subito
/// anche nell'altra.
///
/// PERCHE' SOLO `follow` ⇄ `auto` — le sfumature (`important`, `muted`) sono
/// scelte da scheda titolo, dove c'e' il contesto per capirle; da un post
/// serve una decisione sola. Stessa regola del web.
///
/// A COSA SERVE `follow` — senza, l'evento di uscita di un titolo arriva solo
/// a chi ce l'ha in watchlist. Con `follow` arriva anche a chi il titolo non
/// l'ha mai toccato, ed e' proprio il caso di chi ne ha appena letto in un
/// post.
@Observable
@MainActor
final class TitleFollowStore {
    private let titleRepository: any TitleRepositoryProtocol

    /// `titleId -> modo`. I titoli su cui l'utente non ha scelto niente non
    /// compaiono: l'assenza del documento *e'* `auto`.
    private(set) var preferences: [String: TitleUpdatePreference] = [:]

    /// Titoli con una scrittura in volo. Il bottone si disabilita finche' e'
    /// dentro: un doppio tap manderebbe due scritture opposte in fila
    /// (docs/context/IOS_CODE_STYLE.md §4.6).
    private(set) var savingTitleIDs: Set<String> = []

    /// Per chi e' valida la mappa. Nessuna View lo osserva: cambiarlo non deve
    /// ridisegnare niente.
    @ObservationIgnored private var loadedUserID: String?

    init(titleRepository: any TitleRepositoryProtocol) {
        self.titleRepository = titleRepository
    }

    func isFollowing(_ titleID: String) -> Bool {
        preferences[titleID] == .follow
    }

    func isSaving(_ titleID: String) -> Bool {
        savingTitleIDs.contains(titleID)
    }

    /// Carica le preferenze una volta per utente.
    ///
    /// Al cambio account (o al logout) la mappa del vecchio utente sparisce
    /// subito: se restasse, il bottone direbbe "Seguito" a chi non segue
    /// niente — lo stesso difetto di stato residuo gia' visto sul token push.
    func load(userID: String?) async {
        guard let userID, !userID.isEmpty else {
            preferences = [:]
            loadedUserID = nil
            return
        }
        guard loadedUserID != userID else { return }
        // Prima dell'await: due schermate che compaiono insieme non devono
        // fare due volte la stessa query.
        loadedUserID = userID
        preferences = [:]

        do {
            preferences = try await titleRepository.fetchTitleUpdatePreferences(userID: userID)
        } catch {
            // Caricamento accessorio: il bottone nasce spento e resta usabile,
            // e il prossimo ingresso in schermata riprova.
            loadedUserID = nil
            SilentFailure.record(error, context: "TitleFollowStore.load")
        }
    }

    /// Toggle secco `follow ⇄ auto`.
    ///
    /// Rilancia invece di inghiottire: e' una scrittura innescata dall'utente,
    /// quindi l'errore deve arrivargli (§5). Chi chiama lo traduce con
    /// `UserFacingError`.
    ///
    /// Un titolo su `important` o `muted` che viene seguito da qui passa a
    /// `follow`: e' una scelta esplicita e piu' recente, e la sfumatura resta
    /// ricostruibile dalla scheda titolo.
    func toggleFollow(titleID: String, userID: String) async throws {
        guard !titleID.isEmpty, !userID.isEmpty, !savingTitleIDs.contains(titleID) else { return }

        let next: TitleUpdatePreference = isFollowing(titleID) ? .automatic : .follow
        savingTitleIDs.insert(titleID)
        defer { savingTitleIDs.remove(titleID) }

        try await titleRepository.setTitleUpdatePreference(
            userID: userID,
            titleID: titleID,
            preference: next
        )

        // Solo dopo la conferma del server: uno stato ottimistico qui
        // mostrerebbe "Seguito" anche quando la scrittura viene negata.
        if next == .follow {
            preferences[titleID] = .follow
        } else {
            preferences[titleID] = nil
        }
    }
}
