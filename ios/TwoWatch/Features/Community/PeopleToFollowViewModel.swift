import Foundation

/// Stato della sezione "Persone da seguire" in Community.
///
/// Il grafo follower esisteva ma non veniva proposto da nessuna schermata: al
/// 2026-08-19 erano 23 utenti su 343 ad aver seguito qualcuno. Senza archi il
/// feed di chiunque resta vuoto, quindi questa sezione e' il primo passo.
@Observable @MainActor
final class PeopleToFollowViewModel {
    private(set) var people: [PersonSuggestion] = []
    private(set) var followedIDs: Set<String> = []
    private(set) var isLoading = false

    private let repository: PeopleSuggestionsRepository
    private let userRepository: UserRepository

    /// Chi sta gia' seguendo: guardia sincrona contro il doppio tap, che
    /// altrimenti scriverebbe due volte lo stesso arco.
    @ObservationIgnored private var pendingFollowIDs: Set<String> = []
    @ObservationIgnored private var hasLoaded = false

    init(repository: PeopleSuggestionsRepository, userRepository: UserRepository) {
        self.repository = repository
        self.userRepository = userRepository
    }

    /// Carica una sola volta per ciclo di vita della View: la lista e' gia'
    /// stabile per 12 ore lato server, ricaricarla a ogni comparsa non
    /// cambierebbe niente e costerebbe una chiamata.
    func loadIfNeeded(userID: String?) async {
        guard let userID, !userID.isEmpty, !hasLoaded, !isLoading else { return }
        hasLoaded = true
        isLoading = true
        defer { isLoading = false }

        do {
            people = try await repository.fetchSuggestions()
        } catch {
            // Suggerimento mancato non e' un errore da mostrare: la sezione
            // sparisce e il feed sotto resta quello che era.
            people = []
            SilentFailure.record(error, context: "peopleSuggestions.load")
        }
    }

    func follow(_ person: PersonSuggestion, myUserID: String?) async {
        guard let myUserID, !myUserID.isEmpty else { return }
        guard !followedIDs.contains(person.id), !pendingFollowIDs.contains(person.id) else { return }

        pendingFollowIDs.insert(person.id)
        defer { pendingFollowIDs.remove(person.id) }

        do {
            try await userRepository.followUser(myUid: myUserID, targetUid: person.id)
            followedIDs.insert(person.id)
        } catch {
            SilentFailure.record(error, context: "peopleSuggestions.follow")
        }
    }

    func isFollowed(_ person: PersonSuggestion) -> Bool {
        followedIDs.contains(person.id)
    }
}
