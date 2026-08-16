import Foundation
import Observation

// View model della scheda titolo, estratto da TitleDetailView.swift dove
// occupava le righe 29-1055 di un file da 10.437. Spostamento puro: nessuna
// riga del corpo e' cambiata. Vedi docs/IOS_REFACTOR_PLAN.md, Fase 3a.
//
// Riceve protocolli e non classi concrete (TwoWatch/Domain/Repositories/):
// e' cio' che lo rende istanziabile nei test.

/// Una fascia della distribuzione voti community su /10 (es. "9–10").
struct TitleRatingBucket: Identifiable {
    let label: String
    let count: Int
    /// Quota sul totale dei voti caricati (0...1).
    let fraction: Double

    var id: String { label }

    /// Fasce ordinate dall'alto (9–10) al basso (1–2), come il web.
    static let orderedRanges: [(lowerBound: Int, upperBound: Int, label: String)] = [
        (9, 10, "9–10"),
        (7, 8, "7–8"),
        (5, 6, "5–6"),
        (3, 4, "3–4"),
        (1, 2, "1–2")
    ]
}

@Observable
@MainActor
final class TitleDetailViewModel {
    private let titleID: String
    // Protocolli, non classi concrete: e' cio' che rende questo view model
    // istanziabile in un test senza rete ne' progetto Firebase.
    // Vedi TwoWatch/Domain/Repositories/ e docs/IOS_REFACTOR_PLAN.md §Fase 1.
    private let titleRepository: any TitleRepositoryProtocol
    private let watchlistRepository: any WatchlistRepositoryProtocol
    private let userRepository: any UserRepositoryProtocol

    var title: Title?
    var providers: TitleProviders?
    var ratings: [Rating] = []
    /// Voto serie/stagione DERIVATO dai voti episodio dell'utente (privato).
    var derivedRating: DerivedRating?
    var relatedTitles: [Title] = []
    var trailerURL: URL?
    var updates: TitleUpdatesSnapshot = .empty
    var titleUpdatePreference: TitleUpdatePreference = .automatic
    var isSavingTitleUpdatePreference = false
    var isUpdatesLoading = false
    var updatesErrorMessage: String?
    var seasons: [TitleSeason] = []
    var resolvedGenres: [String] = []
    var directorCredits: [TitleCreditPerson] = []
    var castCredits: [TitleCreditPerson] = []
    /// Pick community del titolo: alimenta l'etichetta di apprezzamento sul
    /// cast. Facoltativo, non blocca il render della scheda.
    var characterBucket: CharacterVoteBucket?
    /// Persone seguite: contano nelle medie "Chi segui" quanto gli amici.
    var followedUsers: [AppUser] = []
    var watchers: [TitleWatcher] = []
    var personalState: TitlePersonalState?
    var editableLists: [UserListSummary] = []
    /// Public lists that include this title, surfaced as a discovery section.
    var publicListsContainingTitle: [UserListSummary] = []
    var isLoading = false
    var isLoadingSeasons = false
    var isLoadingEditableLists = false
    /// Sezioni che arrivano DOPO il primo render: provider, trailer e cast si
    /// risolvono in `loadDeferredDetailData`, che gira quando `isLoading` è già
    /// falso. Senza questi flag le tre sezioni non esistono affatto finché il
    /// server non risponde, e la scheda sembra semplicemente vuota.
    var isLoadingProviders = false
    var isLoadingTrailer = false
    var isLoadingCredits = false
    var isCreatingQuickList = false
    var pendingActionLabel: String?
    var hasCompletedInitialPresentationLoad = false
    var errorMessage: String?
    var currentUserID: String?
    @ObservationIgnored private var hasAttemptedAutomaticTMDBRefresh = false
    @ObservationIgnored private var loadGeneration = 0
    @ObservationIgnored private var hasLoadedExtendedRatings = false
    @ObservationIgnored private var isLoadingExtendedRatings = false

    private let analytics: AnalyticsLogging

    init(
        titleID: String,
        titleRepository: any TitleRepositoryProtocol,
        watchlistRepository: any WatchlistRepositoryProtocol,
        userRepository: any UserRepositoryProtocol,
        analytics: AnalyticsLogging = NoopAnalyticsLogger()
    ) {
        self.titleID = titleID
        self.titleRepository = titleRepository
        self.watchlistRepository = watchlistRepository
        self.userRepository = userRepository
        self.analytics = analytics
    }

    /// Logga `title_opened` una volta sola per titleID per sessione: il view
    /// model viene ricreato per ogni navigazione, quindi un guard interno è
    /// sufficiente.
    @ObservationIgnored private var hasLoggedTitleOpen = false

    func logTitleOpenedIfNeeded() {
        guard !hasLoggedTitleOpen else { return }
        hasLoggedTitleOpen = true
        analytics.log(AnalyticsEvent.titleOpened, ["title_id": titleID])
    }

    /// Contratto unico per le mutazioni della scheda: il guard è sincrono,
    /// quindi previene doppi tap prima ancora che parta la prima `await`.
    private func beginAction(_ label: String) -> Bool {
        guard pendingActionLabel == nil else { return false }
        pendingActionLabel = label
        return true
    }

    private func endAction() {
        pendingActionLabel = nil
    }

    func load(currentUserID: String?) async {
        isLoading = true
        errorMessage = nil
        self.currentUserID = currentUserID
        loadGeneration += 1
        let generation = loadGeneration
        hasLoadedExtendedRatings = false

        do {
            guard let title = try await titleRepository.fetchTitle(id: titleID) else {
                errorMessage = String(localized: "Titolo non trovato.")
                isLoading = false
                setDeferredSectionsLoading(false)
                return
            }

            self.title = title
            trailerURL = nil
            updates = .empty
            titleUpdatePreference = .automatic
            isUpdatesLoading = true
            updatesErrorMessage = nil
            // Alzati qui e non in `loadDeferredDetailData`: quel Task parte dopo
            // il primo render, e nel frattempo le sezioni sarebbero sparite.
            setDeferredSectionsLoading(true)
            resolvedGenres = GenreDisplay.labels(from: title.genres)

            if let currentUserID {
                do {
                    personalState = try await watchlistRepository.fetchTitleState(userID: currentUserID, title: title)
                } catch {
                    SilentFailure.record(error, context: "TitleDetail.personalState")
                    personalState = nil
                }
            } else {
                personalState = nil
                editableLists = []
                followedUsers = []
                isLoadingEditableLists = false
            }

            hasCompletedInitialPresentationLoad = true
            isLoading = false

            Task { await loadDeferredDetailData(for: title, currentUserID: currentUserID, generation: generation) }
            Task { await maybeRefreshTitleFromTMDBIfNeeded(for: title, currentUserID: currentUserID, generation: generation) }
        } catch {
            errorMessage = UserFacingError.message(for: error)
            isLoading = false
            setDeferredSectionsLoading(false)
        }
    }


    private func setDeferredSectionsLoading(_ isLoading: Bool) {
        isLoadingProviders = isLoading
        isLoadingTrailer = isLoading
        isLoadingCredits = isLoading
    }

    func toggleWatchlist(userID: String) async {
        guard let title, beginAction("Aggiorno la Watchlist…") else { return }
        defer { endAction() }
        do {
            let currentState = try await watchlistRepository.fetchTitleState(userID: userID, title: title)
            personalState = try await watchlistRepository.updateGeneralWatchlist(
                userID: userID,
                title: title,
                isIncluded: !currentState.generalWatchlist
            )
            await refreshPersonalContext(userID: userID, title: title)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    func retryTitleUpdates() async {
        guard let title else { return }
        isUpdatesLoading = true
        updatesErrorMessage = nil
        do {
            updates = try await titleRepository.fetchTitleUpdates(
                for: title,
                includeOfficialUpdates: currentUserID != nil
            )
        } catch {
            updatesErrorMessage = String(localized: "Impossibile caricare gli aggiornamenti.")
        }
        isUpdatesLoading = false
    }

    func setTitleUpdatePreference(_ preference: TitleUpdatePreference, userID: String) async {
        guard !isSavingTitleUpdatePreference else { return }
        let previous = titleUpdatePreference
        titleUpdatePreference = preference
        isSavingTitleUpdatePreference = true
        defer { isSavingTitleUpdatePreference = false }
        do {
            try await titleRepository.setTitleUpdatePreference(
                userID: userID,
                titleID: titleID,
                preference: preference
            )
        } catch {
            titleUpdatePreference = previous
            errorMessage = String(localized: "Impossibile salvare la preferenza. Riprova.")
        }
    }

    func setRewatchIntent(userID: String, isIncluded: Bool) async {
        guard let title, beginAction("Aggiorno il Rewatch…") else { return }
        defer { endAction() }
        do {
            personalState = try await watchlistRepository.updateRewatchIntent(
                userID: userID,
                title: title,
                isIncluded: isIncluded
            )
            await refreshPersonalContext(userID: userID, title: title)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    @discardableResult
    func submitRating(
        userID: String,
        level: String,
        season: Int? = nil,
        episode: Int? = nil,
        value: Double,
        reviewText: String? = nil,
        details: RatingSocialDetails? = nil
    ) async -> Bool {
        guard beginAction("Salvo il voto…") else { return false }
        defer { endAction() }
        do {
            try await titleRepository.submitRating(
                userID: userID,
                titleID: titleID,
                level: level,
                season: season,
                episode: episode,
                value: value,
                reviewText: reviewText,
                details: details
            )
            if level == "title", let title {
                _ = try await watchlistRepository.syncPersonalStateAfterRating(
                    userID: userID,
                    title: title,
                    ratingValue: value
                )
            }
            await refreshAfterRatingChange(userID: userID)
            return true
        } catch {
            errorMessage = UserFacingError.message(for: error)
            return false
        }
    }

    /// Rimuove il voto dell'utente su un livello (titolo/stagione/episodio) e
    /// ricarica. Usato da "Annulla voto" sulla riga episodio. Il backend
    /// (trigger) risistema aggregato community e stato titolo.
    func deleteRating(userID: String, level: String, season: Int? = nil, episode: Int? = nil) async {
        guard beginAction("Rimuovo il voto…") else { return }
        defer { endAction() }
        do {
            try await titleRepository.deleteRating(
                userID: userID,
                titleID: titleID,
                level: level,
                season: season,
                episode: episode
            )
            await refreshAfterRatingChange(userID: userID)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    private func mergeCharacters(
        into people: [TitleCreditPerson],
        with castWithCharacters: [TitleCastMember]
    ) -> [TitleCreditPerson] {
        guard !castWithCharacters.isEmpty else { return people }
        let charByPersonId: [String: String] = Dictionary(
            castWithCharacters.compactMap { member -> (String, String)? in
                guard let character = member.character, !character.isEmpty else { return nil }
                return (member.personId, character)
            },
            uniquingKeysWith: { first, _ in first }
        )
        let charByName: [String: String] = Dictionary(
            castWithCharacters.compactMap { member -> (String, String)? in
                guard let character = member.character, !character.isEmpty else { return nil }
                return (SearchNormalizer.normalize(member.name), character)
            },
            uniquingKeysWith: { first, _ in first }
        )
        return people.map { person in
            let key = person.personID ?? ""
            if let ch = charByPersonId[key] ?? charByName[person.nameLower] {
                var updated = person
                updated.character = ch
                return updated
            }
            return person
        }
    }

    func refreshFromTMDB() async {
        do {
            try await titleRepository.refreshTitleFromTMDB(titleID: titleID)
            await load(currentUserID: currentUserID)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    func saveEditorialContent(
        currentUser: AppUser,
        overview: String?,
        trailerInput: String?
    ) async throws {
        guard let title else {
            throw NSError(domain: "TwoWatch", code: 404, userInfo: [
                NSLocalizedDescriptionKey: "Titolo non disponibile."
            ])
        }

        try await titleRepository.updateEditorialContent(
            title: title,
            currentUser: currentUser,
            overview: overview,
            trailerInput: trailerInput
        )
        await load(currentUserID: currentUserID)

        if let errorMessage {
            throw NSError(domain: "TwoWatch", code: 500, userInfo: [
                NSLocalizedDescriptionKey: errorMessage
            ])
        }
    }

    var titleRatings: [Rating] {
        ratings.filter { $0.level == "title" }
    }

    var currentUserTitleRating: Rating? {
        rating(level: "title")
    }

    var currentUserTitleRatingValue: Double? {
        currentUserTitleRating?.rating ?? personalState?.ratingValue
    }

    /// Mappa stagione → rating dell'utente corrente (solo livello "season").
    var currentUserSeasonRatings: [Int: Rating] {
        guard let uid = currentUserID else { return [:] }
        var out: [Int: Rating] = [:]
        for r in ratings where r.uid == uid && r.level == "season" {
            if let s = r.season { out[s] = r }
        }
        return out
    }

    /// Numeri di stagione disponibili (preferisci la lista dal viewModel,
    /// fallback ai voti per stagione presenti se la lista non è caricata).
    var availableSeasonNumbers: [Int] {
        if !seasons.isEmpty {
            return seasons.map(\.seasonNumber).sorted()
        }
        return currentUserSeasonRatings.keys.sorted()
    }

    var reviews: [Rating] {
        titleRatings.filter { ($0.reviewText ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false }
    }

    var communityReviewPreview: [Rating] {
        let others = reviews.filter { $0.uid != currentUserID }
        return Array(others.prefix(2))
    }

    /// Le persone di cui contano i voti nella pastiglia "Chi segui": i seguiti.
    ///
    /// Prima erano gli **amici accettati**, un grafo che il prodotto non ha
    /// più: restano follower e seguiti. Ecco perché su un titolo votato da chi
    /// segui la media risultava vuota.
    var friendIDs: Set<String> {
        Set(followedUsers.map(\.id))
    }

    var communityAverageText: String {
        guard let value = communityAverageValue else { return "—" }
        return String(format: "%.1f", value)
    }

    /// Voto medio community numerico (per l'anello): stessa fonte del testo,
    /// con gli stessi fallback (aggregato server → media locale → ratingAvg).
    var communityAverageValue: Double? {
        if let aggregate = title?.ratingAggregate, aggregate.titleCount > 0 {
            return aggregate.titleAverage
        }
        if let average = average(level: "title") {
            return average
        }
        if let title, title.ratingCount > 0 {
            return title.ratingAvg
        }
        return nil
    }

    var friendsAverageText: String {
        averageText(level: "title", among: friendIDs)
    }

    var expertsAverageText: String {
        "—"
    }

    var communityVotesCount: Int {
        if let aggregate = title?.ratingAggregate, aggregate.titleCount > 0 {
            return aggregate.titleCount
        }
        let liveCount = filteredRatings(level: "title").count
        if liveCount > 0 {
            return liveCount
        }
        return max(0, title?.ratingCount ?? 0)
    }

    var friendsVotesCount: Int {
        filteredRatings(level: "title", among: friendIDs).count
    }

    var expertsVotesCount: Int {
        0
    }

    var isInWatchlist: Bool {
        guard let personalState else { return false }
        return personalState.generalWatchlist || personalState.isInRewatch
    }

    var isInRewatch: Bool {
        personalState?.isInRewatch ?? false
    }

    var statusTitle: String? {
        personalState?.statusTitle
    }

    /// Voti dei seguiti, coerente con `friendIDs`: la lista che si apre
    /// toccando la pastiglia contiene esattamente le persone che hanno
    /// prodotto quella media.
    var friendVoteEntries: [FriendVoteEntry] {
        followedUsers.compactMap { person in
            guard let rating = rating(level: "title", userID: person.id) else { return nil }
            return FriendVoteEntry(friend: person, rating: rating)
        }
        .sorted { lhs, rhs in
            (lhs.rating.updatedAt ?? .distantPast) > (rhs.rating.updatedAt ?? .distantPast)
        }
    }

    func rating(level: String, season: Int? = nil, episode: Int? = nil, userID: String? = nil) -> Rating? {
        guard let targetUserID = userID ?? currentUserID else { return nil }
        return ratings.first { item in
            item.uid == targetUserID &&
                item.level == level &&
                item.season == season &&
                item.episode == episode
        }
    }

    func averageText(level: String, season: Int? = nil, episode: Int? = nil, among userIDs: Set<String>? = nil) -> String {
        guard let average = average(level: level, season: season, episode: episode, among: userIDs) else {
            return "—"
        }
        return String(format: "%.1f", average)
    }

    func average(level: String, season: Int? = nil, episode: Int? = nil, among userIDs: Set<String>? = nil) -> Double? {
        let values = filteredRatings(level: level, season: season, episode: episode, among: userIDs)
            .map(\.rating)
        guard !values.isEmpty else { return nil }
        return values.reduce(0, +) / Double(values.count)
    }

    func filteredRatings(level: String, season: Int? = nil, episode: Int? = nil, among userIDs: Set<String>? = nil) -> [Rating] {
        ratings.filter { item in
            guard item.titleId == titleID, item.level == level, item.season == season, item.episode == episode else { return false }
            if let userIDs {
                return userIDs.contains(item.uid)
            }
            return true
        }
    }

    /// Distribuzione dei voti community su /10 a 5 fasce (9–10 / 7–8 / 5–6 /
    /// 3–4 / 1–2), calcolata in memoria dai rating title-level già caricati
    /// (nessuna read aggiuntiva). Allineata al web: ogni voto è arrotondato a
    /// intero e incasellato nella fascia che lo contiene.
    var titleRatingBuckets: [TitleRatingBucket] {
        let titleRatings = filteredRatings(level: "title")
        // reduce(into:) su chiavi derivate (bucket index) — mai
        // Dictionary(uniqueKeysWithValues:) su chiavi calcolate.
        var counts = [Int: Int]()
        var total = 0
        for rating in titleRatings {
            let rounded = Int(rating.rating.rounded())
            let bounded = max(1, min(10, rounded))
            let index = TitleRatingBucket.orderedRanges.firstIndex { bounded >= $0.lowerBound && bounded <= $0.upperBound }
            guard let index else { continue }
            counts[index, default: 0] += 1
            total += 1
        }
        return TitleRatingBucket.orderedRanges.enumerated().map { index, range in
            let count = counts[index, default: 0]
            return TitleRatingBucket(
                label: range.label,
                count: count,
                fraction: total > 0 ? Double(count) / Double(total) : 0
            )
        }
    }

    /// Numero di voti community caricati in memoria (cap 50 lato fetch). Se
    /// `communityVotesCount` (aggregato server) è maggiore, l'UI mostra un
    /// disclaimer perché la distribuzione locale è un campione parziale.
    var loadedTitleVotesCount: Int {
        filteredRatings(level: "title").count
    }

    private func watchProvidersRegion() -> String {
        // La PWA usa sempre IT per questa sezione: manteniamo lo stesso comportamento
        // finché non esiste una selezione regione condivisa tra client.
        "IT"
    }

    private func loadDeferredDetailData(for title: Title, currentUserID: String?, generation: Int) async {
        if title.type == .tv && seasons.isEmpty {
            isLoadingSeasons = true
        }

        async let providersTask = titleRepository.fetchProviders(for: titleID, region: watchProvidersRegion())
        async let relatedTask = titleRepository.fetchRelatedTitles(for: title)
        async let trailerTask = titleRepository.fetchTrailerURL(for: title)
        async let updatesTask = titleRepository.fetchTitleUpdates(
            for: title,
            includeOfficialUpdates: currentUserID != nil
        )
        async let seasonsTask = titleRepository.fetchSeasonMetadata(for: title)
        async let genresTask = titleRepository.listGenres(limit: 400)
        async let creditsTask = titleRepository.fetchTitleCredits(for: title)
        async let titleRatingsTask = titleRepository.fetchTitleLevelRatings(for: titleID)

        var fetchedTitleRatings: [Rating]?
        do {
            fetchedTitleRatings = try await titleRatingsTask
        } catch {
            SilentFailure.record(error, context: "TitleDetail.ratings")
        }
        if let titleRatings = fetchedTitleRatings, isCurrentGeneration(generation) {
            ratings = titleRatings
            hasLoadedExtendedRatings = title.type == .movie
        }

        if let currentUserID {
            isLoadingEditableLists = true
            async let editableListsTask = watchlistRepository.fetchEditableListSummaries(userID: currentUserID)
            async let followingTask = userRepository.listFollowing(userID: currentUserID)

            let editableListResults: [UserListSummary]
            do {
                editableListResults = try await editableListsTask
            } catch {
                SilentFailure.record(error, context: "TitleDetail.editableLists")
                editableListResults = []
            }
            if isCurrentGeneration(generation) {
                editableLists = editableListResults
                isLoadingEditableLists = false
            }

            let followingResults: [AppUser]
            do {
                followingResults = try await followingTask
            } catch {
                SilentFailure.record(error, context: "TitleDetail.following")
                followingResults = []
            }
            if isCurrentGeneration(generation) {
                followedUsers = followingResults
            }

            // String(localized: "Chi la sta guardando"): solo per le serie e con viewer loggato.
            // La CF restituisce amici + seguiti che guardano la serie, ordinati.
            if title.type == .tv {
                var watcherResults: [TitleWatcher] = []
                do {
                    watcherResults = try await watchlistRepository.fetchTitleWatchersProgress(titleID: titleID)
                } catch {
                    SilentFailure.record(error, context: "TitleDetail.watchers")
                }
                if isCurrentGeneration(generation) {
                    watchers = watcherResults
                }
            } else if isCurrentGeneration(generation) {
                watchers = []
            }

            // "Liste che includono questo titolo": liste pubbliche che contengono
            // il titolo, mostrate come spunto di scoperta.
            var publicListResults: [UserListSummary] = []
            do {
                publicListResults = try await watchlistRepository.fetchPublicListsContainingTitle(
                    titleID: titleID,
                    currentUserID: currentUserID
                )
            } catch {
                SilentFailure.record(error, context: "TitleDetail.publicLists")
            }
            if isCurrentGeneration(generation) {
                publicListsContainingTitle = publicListResults
            }
        } else if isCurrentGeneration(generation) {
            editableLists = []
            followedUsers = []
            watchers = []
            publicListsContainingTitle = []
            isLoadingEditableLists = false
        }

        var fetchedProviders: TitleProviders?
        do {
            fetchedProviders = try await providersTask
        } catch {
            // Registrato e non mostrato: la sezione si degrada, ma non siamo
            // piu' gli ultimi a saperlo. SilentFailure scarta da se'
            // cancellazioni e rete assente.
            SilentFailure.record(error, context: "TitleDetail.providers")
        }
        if isCurrentGeneration(generation) {
            if let fetchedProviders {
                self.providers = fetchedProviders
            }
            isLoadingProviders = false
        }

        var fetchedRelated: [Title]?
        do {
            fetchedRelated = try await relatedTask
        } catch {
            SilentFailure.record(error, context: "TitleDetail.related")
        }
        if let relatedTitles = fetchedRelated, isCurrentGeneration(generation) {
            self.relatedTitles = relatedTitles
        }

        var fetchedTrailerURL: URL??
        do {
            fetchedTrailerURL = try await trailerTask
        } catch {
            SilentFailure.record(error, context: "TitleDetail.trailer")
        }
        if isCurrentGeneration(generation) {
            self.trailerURL = fetchedTrailerURL ?? nil
            // Se il trailer c'è lo skeleton sparisce subito; se manca resta su
            // fino all'enrichment TMDB qui sotto, che è l'ultima possibilità.
            if self.trailerURL != nil {
                isLoadingTrailer = false
            }
        }

        do {
            let fetchedUpdates = try await updatesTask
            if isCurrentGeneration(generation) {
                updates = fetchedUpdates
                updatesErrorMessage = nil
                isUpdatesLoading = false
            }
        } catch {
            if isCurrentGeneration(generation) {
                updatesErrorMessage = String(localized: "Impossibile caricare gli aggiornamenti.")
                isUpdatesLoading = false
            }
        }

        if let currentUserID {
            var fetchedPreference: TitleUpdatePreference = .automatic
            do {
                fetchedPreference = try await titleRepository.fetchTitleUpdatePreference(
                    userID: currentUserID,
                    titleID: titleID
                )
            } catch {
                SilentFailure.record(error, context: "TitleDetail.updatePreference")
            }
            if isCurrentGeneration(generation) {
                titleUpdatePreference = fetchedPreference
            }
        }

        var fetchedSeasons: [TitleSeason]?
        do {
            fetchedSeasons = try await seasonsTask
        } catch {
            SilentFailure.record(error, context: "TitleDetail.seasons")
        }
        if isCurrentGeneration(generation) {
            if let fetchedSeasons {
                self.seasons = fetchedSeasons
            }
            isLoadingSeasons = false
        }

        var fetchedCredits: TitleCredits?
        do {
            fetchedCredits = try await creditsTask
        } catch {
            SilentFailure.record(error, context: "TitleDetail.credits")
        }
        if let credits = fetchedCredits, isCurrentGeneration(generation) {
            directorCredits = credits.directors
            castCredits = mergeCharacters(into: credits.cast, with: title.castWithCharacters)
            if !castCredits.isEmpty || !directorCredits.isEmpty {
                isLoadingCredits = false
            }

            // Pick community: alimenta l'etichetta di apprezzamento. Facoltativo
            // e non bloccante — senza, il cast si vede lo stesso.
            do {
                characterBucket = try await titleRepository.fetchTitleCharacterAggregate(titleID: title.id)?.communityBucket
            } catch {
                SilentFailure.record(error, context: "TitleDetail.characterAggregate")
                characterBucket = nil
            }
        }

        // Lazy enrichment: if trailer URL or cast characters are missing on the
        // title doc, ask the cloud function to fetch from TMDb once and cache.
        // Subsequent opens read directly from Firestore.
        let needsTrailer = title.trailerURL == nil && self.trailerURL == nil
        let needsCast = title.castWithCharacters.isEmpty
        if (needsTrailer || needsCast),
           let tmdbId = title.metadata.tmdbId, tmdbId > 0 {
            var enrichment: TitleEnrichmentResult?
            do {
                enrichment = try await titleRepository.enrichTitleAssets(
                    title: title,
                    includeTrailer: needsTrailer,
                    includeCast: needsCast
                )
            } catch {
                SilentFailure.record(error, context: "TitleDetail.enrichAssets")
            }
            if let enriched = enrichment, isCurrentGeneration(generation) {
                if needsTrailer, let url = enriched.trailerURL {
                    self.trailerURL = url
                }
                if needsCast, !enriched.castWithCharacters.isEmpty {
                    castCredits = mergeCharacters(into: castCredits, with: enriched.castWithCharacters)
                }
            }
        }

        // Ultima parola sui due skeleton rimasti: oltre l'enrichment non c'è
        // altra fonte, quindi da qui in poi "vuoto" vuol dire davvero vuoto.
        if isCurrentGeneration(generation) {
            isLoadingTrailer = false
            isLoadingCredits = false
        }

        var fetchedGenres: [Genre]?
        do {
            fetchedGenres = try await genresTask
        } catch {
            SilentFailure.record(error, context: "TitleDetail.genres")
        }
        if let genres = fetchedGenres, isCurrentGeneration(generation) {
            resolvedGenres = GenreDisplay.labels(from: title.genres, lookup: GenreDisplay.lookup(from: genres))
        }

        if title.type == .tv {
            Task { await loadExtendedRatingsIfNeeded(generation: generation) }
        }
    }

    func markMovieSeen(userID: String) async {
        guard let title, beginAction("Salvo come visto…") else { return }
        defer { endAction() }
        do {
            personalState = try await watchlistRepository.markMovieSeen(userID: userID, title: title)
            await refreshPersonalContext(userID: userID, title: title)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    func markMovieUnseen(userID: String) async {
        guard let title, beginAction("Aggiorno lo stato…") else { return }
        defer { endAction() }
        do {
            personalState = try await watchlistRepository.markMovieUnseen(userID: userID, title: title)
            await refreshPersonalContext(userID: userID, title: title)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    func markSeriesUnstarted(userID: String) async {
        guard let title, beginAction("Azzero il progresso…") else { return }
        defer { endAction() }
        do {
            personalState = try await watchlistRepository.markSeriesUnstarted(userID: userID, title: title)
            await refreshPersonalContext(userID: userID, title: title)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    /// Rimuove il voto generale (title-level) dell'utente: cancella il doc
    /// `/ratings`. Il titolo resta "visto senza voto" (il trigger backend azzera
    /// il flag di voto sullo state e aggiorna l'aggregato community).
    func deleteTitleRating(userID: String) async {
        guard let title, beginAction("Rimuovo il voto…") else { return }
        defer { endAction() }
        do {
            try await titleRepository.deleteRating(userID: userID, titleID: title.id, level: "title")
            await refreshAfterRatingChange(userID: userID)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    /// Rimuove il voto di una singola stagione. Non tocca lo stato di visione
    /// (i voti per stagione non sono tracciati dal titleState) né gli altri voti.
    func deleteSeasonRating(userID: String, season: Int) async {
        guard let title, beginAction("Rimuovo il voto…") else { return }
        defer { endAction() }
        do {
            try await titleRepository.deleteRating(
                userID: userID,
                titleID: title.id,
                level: "season",
                season: season
            )
            await refreshAfterRatingChange(userID: userID)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    /// "Segna come non visto": riporta il titolo a "Da vedere". Se esiste un
    /// voto generale lo cancella PRIMA (altrimenti resterebbe un voto orfano che
    /// gonfia l'aggregato community, dato che l'unsee azzera solo il flag di
    /// stato ma non tocca il doc `/ratings`). Poi applica l'azione di reset
    /// appropriata al tipo (film → mark_movie_unseen, serie → mark_series_unstarted).
    func markUnseen(userID: String) async {
        guard let title, beginAction("Aggiorno lo stato…") else { return }
        defer { endAction() }
        do {
            let hadTitleRating = currentUserTitleRating != nil
                || personalState?.isRated == true
            if hadTitleRating {
                try await titleRepository.deleteRating(userID: userID, titleID: title.id, level: "title")
            }
            switch title.type {
            case .movie:
                personalState = try await watchlistRepository.markMovieUnseen(userID: userID, title: title)
            case .tv:
                personalState = try await watchlistRepository.markSeriesUnstarted(userID: userID, title: title)
            }
            // Rilegge voti + stato personale, così il breakdown voti e le
            // sezioni recensione spariscono subito dalla scheda. Non serve
            // altro: provider, cast e trailer non cambiano perché hai tolto
            // il "visto".
            await refreshAfterRatingChange(userID: userID)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    /// True quando il titolo ha un voto generale rimovibile.
    var hasRemovableTitleRating: Bool {
        currentUserTitleRating != nil || personalState?.isRated == true
    }

    func acknowledgeNewContent(userID: String) async {
        guard let title, beginAction("Aggiorno le novità…") else { return }
        defer { endAction() }
        do {
            personalState = try await watchlistRepository.acknowledgeNewContent(userID: userID, title: title)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    func markSeriesEpisodeWatched(userID: String) async {
        guard let title, beginAction("Salvo l'episodio…") else { return }
        defer { endAction() }
        do {
            personalState = try await watchlistRepository.markSeriesEpisodeWatched(userID: userID, title: title)
            await refreshPersonalContext(userID: userID, title: title)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    func markSeriesSeasonWatched(userID: String) async {
        guard let title, beginAction("Salvo la stagione…") else { return }
        defer { endAction() }
        do {
            personalState = try await watchlistRepository.markSeriesSeasonWatched(userID: userID, title: title)
            await refreshPersonalContext(userID: userID, title: title)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    func markSeriesCompleted(userID: String) async {
        guard let title, beginAction("Salvo come completata…") else { return }
        defer { endAction() }
        do {
            personalState = try await watchlistRepository.markSeriesCompleted(userID: userID, title: title)
            await refreshPersonalContext(userID: userID, title: title)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    func setSeriesProgress(
        userID: String,
        watchedEpisodesCount: Int,
        completedSeasonsCount: Int,
        lastWatchedSeasonNumber: Int?,
        lastWatchedEpisodeNumber: Int?,
        source: String
    ) async {
        guard let title, beginAction("Salvo il progresso…") else { return }
        defer { endAction() }
        do {
            personalState = try await watchlistRepository.setSeriesProgress(
                userID: userID,
                title: title,
                watchedEpisodesCount: watchedEpisodesCount,
                completedSeasonsCount: completedSeasonsCount,
                lastWatchedSeasonNumber: lastWatchedSeasonNumber,
                lastWatchedEpisodeNumber: lastWatchedEpisodeNumber,
                source: source
            )
            await refreshPersonalContext(userID: userID, title: title)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    func addTitleToList(userID: String, listID: String) async {
        guard let title, beginAction("Aggiungo alla lista…") else { return }
        defer { endAction() }
        do {
            try await watchlistRepository.addTitleToList(userID: userID, listID: listID, title: title)
            analytics.log(AnalyticsEvent.watchlistItemAdded, [
                "title_id": title.id,
                "list_id": listID
            ])
            await refreshPersonalContext(userID: userID, title: title)
        } catch {
            errorMessage = friendlyFirestoreErrorMessage(error)
        }
    }

    func createQuickList(
        userID: String,
        owner: AppUser?,
        name: String,
        visibility: UserListVisibility,
        kind: UserListKind
    ) async {
        guard let title, !isCreatingQuickList, beginAction("Creo la lista…") else { return }
        isCreatingQuickList = true
        defer {
            isCreatingQuickList = false
            endAction()
        }

        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let finalName = trimmedName.isEmpty ? title.name : trimmedName

        do {
            let draft = UserListEditorDraft(
                title: finalName,
                description: "",
                visibility: visibility,
                kind: kind,
                coverImageURL: nil,
                coverStoragePath: nil,
                collaboratorIDs: [],
                selectedTitleIDs: [title.id],
                naturalPrompt: ""
            )
            _ = try await watchlistRepository.createList(
                userID: userID,
                owner: owner,
                draft: draft,
                collaborators: []
            )
            await refreshPersonalContext(userID: userID, title: title)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    func deferRating(userID: String) async {
        guard let title, beginAction("Salvo per dopo…") else { return }
        defer { endAction() }
        do {
            personalState = try await watchlistRepository.markRatingDeferred(userID: userID, title: title)
            await refreshPersonalContext(userID: userID, title: title)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    func migrateTitleRating(_ rating: Rating, toSeason season: Int, userID: String) async {
        guard beginAction("Sposto il voto…") else { return }
        defer { endAction() }
        do {
            try await titleRepository.migrateRatingLevel(
                rating: rating,
                toLevel: "season",
                season: season,
                episode: nil
            )
            await refreshAfterRatingChange(userID: userID)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    private func maybeRefreshTitleFromTMDBIfNeeded(for title: Title, currentUserID: String?, generation: Int) async {
        guard shouldAutoRefreshFromTMDB(title), !hasAttemptedAutomaticTMDBRefresh else { return }
        hasAttemptedAutomaticTMDBRefresh = true

        do {
            let result = try await titleRepository.refreshTitleFromTMDBIfNeeded(titleID: title.id)
            guard result.updated, let refreshedTitle = try await titleRepository.fetchTitle(id: title.id) else { return }
            guard isCurrentGeneration(generation) else { return }

            self.title = refreshedTitle
            resolvedGenres = GenreDisplay.labels(from: refreshedTitle.genres)
            Task { await loadDeferredDetailData(for: refreshedTitle, currentUserID: currentUserID, generation: generation) }
        } catch {
            // L'auto-refresh non deve bloccare la schermata se il backend non risponde.
        }
    }

    private func shouldAutoRefreshFromTMDB(_ title: Title, now: Date = .now) -> Bool {
        if let nextRefreshAt = title.tmdbNextRefreshAt {
            return nextRefreshAt <= now
        }

        guard let updatedAt = title.updatedAt else { return true }
        let fifteenDays: TimeInterval = 15 * 24 * 60 * 60
        return now.timeIntervalSince(updatedAt) >= fifteenDays
    }

    /// Ricarica SOLO cio' che un voto cambia: i voti del titolo, lo stato
    /// personale, il voto derivato e — sulle serie — i voti per stagione o
    /// episodio.
    ///
    /// Prima qui c'era `load()`, cioe' il caricamento pensato per l'APERTURA
    /// della scheda: rifaceva `fetchTitle` e riarmava `loadDeferredDetailData`,
    /// che spara una quindicina di richieste. Un tap su una stella ricaricava
    /// trailer, provider, cast, generi, liste pubbliche e chi sta guardando —
    /// nessuno dei quali cambia perche' hai votato. Da li' arrivavano sia la
    /// latenza percepita sia una quota non banale delle letture Firestore.
    ///
    /// Restano 3-4 richieste invece di ~15. Il contratto e' presidiato da
    /// `TitleDetailViewModelTests.testSubmitRatingDoesNotReloadTheWholeTitle`.
    private func refreshAfterRatingChange(userID: String) async {
        async let ratingsTask = titleRepository.fetchTitleLevelRatings(for: titleID)
        async let derivedTask = titleRepository.fetchDerivedRating(for: titleID, userID: userID)

        do {
            ratings = try await ratingsTask
        } catch {
            SilentFailure.record(error, context: "TitleDetail.ratingsAfterVote")
        }
        do {
            derivedRating = try await derivedTask
        } catch {
            SilentFailure.record(error, context: "TitleDetail.derivedAfterVote")
            derivedRating = nil
        }

        if let title {
            do {
                personalState = try await watchlistRepository.fetchTitleState(userID: userID, title: title)
            } catch {
                SilentFailure.record(error, context: "TitleDetail.personalStateAfterVote")
            }

            // Sulle serie i voti stagione/episodio stanno in una pagina a
            // parte: si ricarica solo se era gia' stata caricata, se no la si
            // lascia alla prima apertura della tab che la usa.
            if title.type == .tv, hasLoadedExtendedRatings {
                hasLoadedExtendedRatings = false
                await loadExtendedRatingsIfNeeded(generation: loadGeneration)
            }
        }
    }

    private func refreshPersonalContext(userID: String, title: Title) async {
        do {
            personalState = try await watchlistRepository.fetchTitleState(userID: userID, title: title)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }

        isLoadingEditableLists = true
        var refreshedLists: [UserListSummary]?
        do {
            refreshedLists = try await watchlistRepository.fetchEditableListSummaries(userID: userID)
        } catch {
            SilentFailure.record(error, context: "TitleDetail.refreshEditableLists")
        }
        if let refreshedLists {
            editableLists = refreshedLists
        }
        isLoadingEditableLists = false
    }

    private func loadExtendedRatingsIfNeeded(generation: Int) async {
        guard title?.type == .tv, !hasLoadedExtendedRatings, !isLoadingExtendedRatings else { return }
        isLoadingExtendedRatings = true
        defer { isLoadingExtendedRatings = false }

        do {
            // TODO: pagination — UI mostra solo prima pagina (50 rating). Per
            // un'esperienza completa caricare ulteriori pagine via `cursor`.
            let page = try await titleRepository.fetchRatings(for: titleID)
            guard isCurrentGeneration(generation) else { return }
            ratings = page.ratings
            hasLoadedExtendedRatings = true
        } catch {
            // La tab info deve restare fluida anche se i rating episodio/stagione falliscono.
        }

        await loadDerivedRatingIfNeeded(generation: generation)
    }

    /// Carica il voto derivato dai voti episodio (solo serie, utente loggato).
    /// Fail-soft: un errore non deve mai rompere la tab.
    private func loadDerivedRatingIfNeeded(generation: Int) async {
        guard title?.type == .tv, let uid = currentUserID else { return }
        var derived: DerivedRating?
        do {
            derived = try await titleRepository.fetchDerivedRating(for: titleID, userID: uid)
        } catch {
            SilentFailure.record(error, context: "TitleDetail.derivedRating")
        }
        guard isCurrentGeneration(generation) else { return }
        derivedRating = derived
    }

    private func isCurrentGeneration(_ generation: Int) -> Bool {
        loadGeneration == generation
    }
}

struct FriendVoteEntry: Identifiable {
    let friend: AppUser
    let rating: Rating

    var id: String { friend.id }
}
