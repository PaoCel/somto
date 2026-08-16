import FirebaseFirestore
import Foundation
import UIKit
@testable import Somto

// Fake in-memoria dei repository, sui protocolli di TwoWatch/Domain/Repositories/.
//
// Ogni fake fa tre cose:
//   - restituisce risultati configurabili (`stub*`),
//   - registra le chiamate ricevute (`calls`), per verificare che un'azione ne
//     scateni una e una sola,
//   - sa fallire su richiesta (`errorFor`), perche' meta' del valore di questi
//     test sta nei percorsi di errore, che in produzione sono invisibili.
//
// Non sono mock generati: sono scritti a mano perche' la superficie e' piccola
// e leggibile, e perche' un generatore sarebbe una dipendenza in piu' su un
// progetto a bus factor 1.

/// Errore di comodo per i percorsi di fallimento.
struct FakeRepositoryError: LocalizedError, Equatable {
    let message: String
    var errorDescription: String? { message }

    static let generic = FakeRepositoryError(message: "errore finto")
}

/// Registro condiviso delle chiamate: `nome(argomenti)` in ordine di arrivo.
@MainActor
final class CallRecorder {
    private(set) var calls: [String] = []

    func record(_ name: String) {
        calls.append(name)
    }

    func count(_ name: String) -> Int {
        calls.filter { $0 == name }.count
    }

    func reset() {
        calls.removeAll()
    }
}

// MARK: - Title

@MainActor
final class FakeTitleRepository: TitleRepositoryProtocol {
    let recorder = CallRecorder()

    var stubTitle: Title?
    var stubCredits = TitleCredits(directors: [], cast: [])
    var stubRelatedTitles: [Title] = []
    var stubProviders: TitleProviders?
    var stubTrailerURL: URL?
    var stubSeasons: [TitleSeason] = []
    var stubGenres: [Genre] = []
    var stubListBuilderResults: [Title] = []
    var stubMyEmotions: [TitleEmotionEntry] = []
    var stubTitleLevelRatings: [Rating] = []
    var stubDerivedRating: DerivedRating?
    var stubUpdates: TitleUpdatesSnapshot = .empty
    var stubUpdatePreference: TitleUpdatePreference = .automatic
    var stubUpdatePreferences: [String: TitleUpdatePreference] = [:]
    /// Cosa e' stato scritto, per titolo: distingue "seguito" da "tornato ad
    /// automatico", che senza questo sarebbero la stessa chiamata registrata.
    private(set) var savedUpdatePreferences: [String: TitleUpdatePreference] = [:]
    var stubUpcomingReleaseDates: [String: Date] = [:]
    /// Gli id chiesti ad ogni chiamata: serve a verificare *quali* titoli
    /// finiscono in query, non solo quante volte.
    private(set) var requestedUpcomingReleaseIDs: [[String]] = []
    var stubCharacterAggregate: TitleCharacterAggregate?
    var stubRefreshResult = TitleRefreshResult(
        ok: true,
        checked: false,
        updated: false,
        reason: nil,
        nextCheckAt: nil
    )
    var stubEnrichment = TitleEnrichmentResult(trailerURL: nil, castWithCharacters: [])

    /// Errori per nome di metodo: `errorFor["fetchTitle"] = .generic`.
    var errorFor: [String: any Error] = [:]

    /// Attesa artificiale prima di rispondere, per ordinare le race nei test.
    var delayFor: [String: Duration] = [:]

    private func enter(_ name: String) async throws {
        recorder.record(name)
        if let delay = delayFor[name] {
            try? await Task.sleep(for: delay)
        }
        if let error = errorFor[name] {
            throw error
        }
    }

    func fetchTitle(id: String) async throws -> Title? {
        try await enter("fetchTitle")
        return stubTitle
    }

    func fetchTitleCredits(for title: Title) async throws -> TitleCredits {
        try await enter("fetchTitleCredits")
        return stubCredits
    }

    func fetchRelatedTitles(for title: Title, limit: Int) async throws -> [Title] {
        try await enter("fetchRelatedTitles")
        return stubRelatedTitles
    }

    func fetchProviders(for titleID: String, region: String) async throws -> TitleProviders? {
        try await enter("fetchProviders")
        return stubProviders
    }

    func fetchTrailerURL(for title: Title) async throws -> URL? {
        try await enter("fetchTrailerURL")
        return stubTrailerURL
    }

    func fetchSeasonMetadata(for title: Title) async throws -> [TitleSeason] {
        try await enter("fetchSeasonMetadata")
        return stubSeasons
    }

    func listGenres(limit: Int) async throws -> [Genre] {
        try await enter("listGenres")
        return stubGenres
    }

    func searchTitlesForListBuilder(_ query: String, limit: Int) async throws -> [Title] {
        try await enter("searchTitlesForListBuilder")
        return stubListBuilderResults
    }

    func fetchMyEmotions(userID: String, limit: Int) async throws -> [TitleEmotionEntry] {
        try await enter("fetchMyEmotions")
        return stubMyEmotions
    }

    func fetchTitleLevelRatings(for titleID: String) async throws -> [Rating] {
        try await enter("fetchTitleLevelRatings")
        return stubTitleLevelRatings
    }

    func fetchRatings(
        for titleID: String,
        level: String?,
        cursor: DocumentSnapshot?,
        limit: Int
    ) async throws -> (ratings: [Rating], next: DocumentSnapshot?) {
        try await enter("fetchRatings")
        // `next: nil` chiude la paginazione: un fake non puo' costruire un
        // DocumentSnapshot, ed e' il motivo per cui quel tipo Firestore nel
        // protocollo e' segnato come debito.
        return (stubTitleLevelRatings, nil)
    }

    func fetchDerivedRating(for titleID: String, userID: String) async throws -> DerivedRating? {
        try await enter("fetchDerivedRating")
        return stubDerivedRating
    }

    func submitRating(
        userID: String,
        titleID: String,
        level: String,
        season: Int?,
        episode: Int?,
        value: Double,
        reviewText: String?,
        details: RatingSocialDetails?
    ) async throws {
        try await enter("submitRating")
    }

    func deleteRating(
        userID: String,
        titleID: String,
        level: String,
        season: Int?,
        episode: Int?
    ) async throws {
        try await enter("deleteRating")
    }

    func migrateRatingLevel(
        rating: Rating,
        toLevel newLevel: String,
        season: Int?,
        episode: Int?
    ) async throws {
        try await enter("migrateRatingLevel")
    }

    func fetchTitleUpdates(
        for title: Title,
        includeOfficialUpdates: Bool
    ) async throws -> TitleUpdatesSnapshot {
        try await enter("fetchTitleUpdates")
        return stubUpdates
    }

    func fetchUpcomingReleaseDates(titleIDs: [String]) async throws -> [String: Date] {
        try await enter("fetchUpcomingReleaseDates")
        requestedUpcomingReleaseIDs.append(titleIDs)
        return stubUpcomingReleaseDates
    }

    func fetchTitleUpdatePreference(userID: String, titleID: String) async throws -> TitleUpdatePreference {
        try await enter("fetchTitleUpdatePreference")
        return stubUpdatePreference
    }

    func fetchTitleUpdatePreferences(userID: String) async throws -> [String: TitleUpdatePreference] {
        try await enter("fetchTitleUpdatePreferences")
        return stubUpdatePreferences
    }

    func setTitleUpdatePreference(
        userID: String,
        titleID: String,
        preference: TitleUpdatePreference
    ) async throws {
        try await enter("setTitleUpdatePreference")
        savedUpdatePreferences[titleID] = preference
    }

    func fetchTitleCharacterAggregate(titleID: String) async throws -> TitleCharacterAggregate? {
        try await enter("fetchTitleCharacterAggregate")
        return stubCharacterAggregate
    }

    @discardableResult
    func enrichTitleAssets(
        title: Title,
        includeTrailer: Bool,
        includeCast: Bool
    ) async throws -> TitleEnrichmentResult {
        try await enter("enrichTitleAssets")
        return stubEnrichment
    }

    func refreshTitleFromTMDB(titleID: String) async throws {
        try await enter("refreshTitleFromTMDB")
    }

    func refreshTitleFromTMDBIfNeeded(titleID: String) async throws -> TitleRefreshResult {
        try await enter("refreshTitleFromTMDBIfNeeded")
        return stubRefreshResult
    }

    func updateEditorialContent(
        title: Title,
        currentUser: AppUser,
        overview: String?,
        trailerInput: String?
    ) async throws {
        try await enter("updateEditorialContent")
    }
}

// MARK: - Watchlist

@MainActor
final class FakeWatchlistRepository: WatchlistRepositoryProtocol {
    let recorder = CallRecorder()

    /// Stato restituito da tutte le mutazioni. I test che verificano una
    /// transizione lo riassegnano fra una chiamata e l'altra.
    var stubState: TitlePersonalState
    var stubEditableLists: [UserListSummary] = []
    var stubPublicLists: [UserListSummary] = []
    var stubWatchers: [TitleWatcher] = []
    var stubCreatedList: UserListDetail?
    var stubDashboard: WatchlistDashboard = .empty
    var stubListDetail: UserListDetail?
    var stubPublicListBySlug: UserListSummary?
    var stubPublicListProgress: PublicListItemProgress?
    var stubCollaborators: [AppUser] = []
    var stubNaturalListPreview: NaturalListPreview?
    var stubLibrary: [LibraryEntry] = []
    var stubActivitySummary = ProfileActivitySummary(
        ratedTitlesCount: 0,
        watchedTitlesCount: 0,
        totalWatchMinutes: 0
    )
    var stubProfileReviews: [ProfileReviewEntry] = []
    var stubReviewCount = 0
    var stubPublicPosts: [AppPost] = []
    var stubSeriesProgress: [String: TitleSeriesProgress] = [:]
    var stubNewSeasons: NewSeasonDetectionResult?

    var errorFor: [String: any Error] = [:]
    var delayFor: [String: Duration] = [:]

    init(stubState: TitlePersonalState) {
        self.stubState = stubState
    }

    private func enter(_ name: String) async throws {
        recorder.record(name)
        if let delay = delayFor[name] {
            try? await Task.sleep(for: delay)
        }
        if let error = errorFor[name] {
            throw error
        }
    }

    private func mutate(_ name: String) async throws -> TitlePersonalState {
        try await enter(name)
        return stubState
    }

    func fetchTitleState(userID: String, title: Title) async throws -> TitlePersonalState {
        try await mutate("fetchTitleState")
    }

    func updateGeneralWatchlist(
        userID: String,
        title: Title,
        isIncluded: Bool,
        source: String
    ) async throws -> TitlePersonalState {
        try await mutate("updateGeneralWatchlist")
    }

    func updateRewatchIntent(
        userID: String,
        title: Title,
        isIncluded: Bool,
        source: String
    ) async throws -> TitlePersonalState {
        try await mutate("updateRewatchIntent")
    }

    func syncPersonalStateAfterRating(
        userID: String,
        title: Title,
        ratingValue: Double
    ) async throws -> TitlePersonalState {
        try await mutate("syncPersonalStateAfterRating")
    }

    func markRatingDeferred(userID: String, title: Title) async throws -> TitlePersonalState {
        try await mutate("markRatingDeferred")
    }

    func acknowledgeNewContent(userID: String, title: Title) async throws -> TitlePersonalState {
        try await mutate("acknowledgeNewContent")
    }

    func markMovieSeen(userID: String, title: Title) async throws -> TitlePersonalState {
        try await mutate("markMovieSeen")
    }

    func markMovieUnseen(userID: String, title: Title) async throws -> TitlePersonalState {
        try await mutate("markMovieUnseen")
    }

    func markSeriesUnstarted(userID: String, title: Title) async throws -> TitlePersonalState {
        try await mutate("markSeriesUnstarted")
    }

    func markSeriesEpisodeWatched(userID: String, title: Title) async throws -> TitlePersonalState {
        try await mutate("markSeriesEpisodeWatched")
    }

    func markSeriesSeasonWatched(userID: String, title: Title) async throws -> TitlePersonalState {
        try await mutate("markSeriesSeasonWatched")
    }

    func markSeriesCompleted(userID: String, title: Title) async throws -> TitlePersonalState {
        try await mutate("markSeriesCompleted")
    }

    func setSeriesProgress(
        userID: String,
        title: Title,
        watchedEpisodesCount: Int,
        completedSeasonsCount: Int,
        lastWatchedSeasonNumber: Int?,
        lastWatchedEpisodeNumber: Int?,
        source: String
    ) async throws -> TitlePersonalState {
        try await mutate("setSeriesProgress")
    }

    func fetchEditableListSummaries(userID: String, limit: Int) async throws -> [UserListSummary] {
        try await enter("fetchEditableListSummaries")
        return stubEditableLists
    }

    func fetchPublicListsContainingTitle(
        titleID: String,
        currentUserID: String,
        limit: Int
    ) async throws -> [UserListSummary] {
        try await enter("fetchPublicListsContainingTitle")
        return stubPublicLists
    }

    func createList(
        userID: String,
        owner: AppUser?,
        draft: UserListEditorDraft,
        collaborators: [AppUser]
    ) async throws -> UserListDetail {
        try await enter("createList")
        guard let stubCreatedList else { throw FakeRepositoryError(message: "stubCreatedList non impostato") }
        return stubCreatedList
    }

    func addTitleToList(userID: String, listID: String, title: Title) async throws {
        try await enter("addTitleToList")
    }

    // MARK: Liste personali

    func fetchWatchlistDashboard(userID: String) async throws -> WatchlistDashboard {
        try await enter("fetchWatchlistDashboard")
        return stubDashboard
    }

    func fetchListDetail(userID: String, listID: String) async throws -> UserListDetail {
        try await enter("fetchListDetail")
        return try requireListDetail()
    }

    func updateList(
        userID: String,
        listID: String,
        draft: UserListEditorDraft,
        collaborators: [AppUser]
    ) async throws -> UserListDetail {
        try await enter("updateList")
        return try requireListDetail()
    }

    func deleteList(userID: String, listID: String) async throws {
        try await enter("deleteList")
    }

    func duplicateList(userID: String, sourceListID: String, owner: AppUser?) async throws -> UserListDetail {
        try await enter("duplicateList")
        return try requireListDetail()
    }

    func removeTitleFromList(userID: String, listID: String, titleID: String) async throws {
        try await enter("removeTitleFromList")
    }

    func reorderListItems(userID: String, listID: String, itemIDs: [String]) async throws {
        try await enter("reorderListItems")
    }

    func uploadListCover(userID: String, listID: String, image: UIImage) async throws {
        try await enter("uploadListCover")
    }

    func searchCollaborators(
        query: String,
        userID: String,
        excluding excludedIDs: [String]
    ) async throws -> [AppUser] {
        try await enter("searchCollaborators")
        return stubCollaborators
    }

    func buildNaturalListPreview(_ phrase: String) async throws -> NaturalListPreview {
        try await enter("buildNaturalListPreview")
        guard let stubNaturalListPreview else {
            throw FakeRepositoryError(message: "stubNaturalListPreview non impostato")
        }
        return stubNaturalListPreview
    }

    // MARK: Liste pubbliche di altri

    func fetchPublicListBySlug(_ slug: String, currentUserID: String) async throws -> UserListSummary? {
        try await enter("fetchPublicListBySlug")
        return stubPublicListBySlug
    }

    func togglePublicListPin(userID: String, listID: String, isPinned: Bool) async throws {
        try await enter("togglePublicListPin")
    }

    func setPublicListMovieSeen(
        userID: String,
        listID: String,
        title: Title,
        isSeen: Bool
    ) async throws -> PublicListItemProgress {
        try await enter("setPublicListMovieSeen")
        return try requirePublicListProgress()
    }

    func setPublicListSeriesProgress(
        userID: String,
        listID: String,
        title: Title,
        watchedEpisodesCount: Int,
        completedSeasonsCount: Int,
        lastWatchedSeasonNumber: Int?,
        lastWatchedEpisodeNumber: Int?
    ) async throws -> PublicListItemProgress {
        try await enter("setPublicListSeriesProgress")
        return try requirePublicListProgress()
    }

    private func requireListDetail() throws -> UserListDetail {
        guard let stubListDetail else {
            throw FakeRepositoryError(message: "stubListDetail non impostato")
        }
        return stubListDetail
    }

    private func requirePublicListProgress() throws -> PublicListItemProgress {
        guard let stubPublicListProgress else {
            throw FakeRepositoryError(message: "stubPublicListProgress non impostato")
        }
        return stubPublicListProgress
    }

    func fetchTitleWatchersProgress(titleID: String) async throws -> [TitleWatcher] {
        try await enter("fetchTitleWatchersProgress")
        return stubWatchers
    }

    // MARK: Profilo

    func fetchLibrary(userID: String, limit: Int) async throws -> [LibraryEntry] {
        try await enter("fetchLibrary")
        return stubLibrary
    }

    func fetchProfileActivitySummary(
        userID: String,
        preloadedUser: AppUser?
    ) async throws -> ProfileActivitySummary {
        try await enter("fetchProfileActivitySummary")
        return stubActivitySummary
    }

    func fetchProfileReviews(userID: String) async throws -> [ProfileReviewEntry] {
        try await enter("fetchProfileReviews")
        return stubProfileReviews
    }

    func fetchReviewCount(userID: String, preloadedUser: AppUser?) async throws -> Int {
        try await enter("fetchReviewCount")
        return stubReviewCount
    }

    func fetchPublicPostsByAuthor(userID: String, limit: Int) async throws -> [AppPost] {
        try await enter("fetchPublicPostsByAuthor")
        return stubPublicPosts
    }

    func fetchPublicProfileSeriesProgress(userID: String) async throws -> [String: TitleSeriesProgress] {
        try await enter("fetchPublicProfileSeriesProgress")
        return stubSeriesProgress
    }

    func detectNewSeasonsForUser(userID: String) async throws -> NewSeasonDetectionResult {
        try await enter("detectNewSeasonsForUser")
        guard let stubNewSeasons else {
            throw FakeRepositoryError(message: "stubNewSeasons non impostato")
        }
        return stubNewSeasons
    }
}

// MARK: - User

@MainActor
final class FakeUserRepository: UserRepositoryProtocol {
    let recorder = CallRecorder()

    var stubFollowing: [AppUser] = []
    var stubFollowers: [AppUser] = []
    var stubUser: AppUser?
    var errorFor: [String: any Error] = [:]

    private func enter(_ name: String) throws {
        recorder.record(name)
        if let error = errorFor[name] { throw error }
    }

    func listFollowing(userID: String, limit: Int) async throws -> [AppUser] {
        try enter("listFollowing")
        return stubFollowing
    }

    func listFollowers(userID: String, limit: Int) async throws -> [AppUser] {
        try enter("listFollowers")
        return stubFollowers
    }

    func fetchUser(uid: String) async throws -> AppUser? {
        try enter("fetchUser")
        return stubUser
    }
}

// MARK: - Analytics

/// Raccoglie gli eventi invece di spedirli, per verificare che
/// `title_opened` sia loggato una volta sola.
final class SpyAnalyticsLogger: AnalyticsLogging, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [(name: String, parameters: [String: Any])] = []

    var events: [(name: String, parameters: [String: Any])] {
        lock.lock(); defer { lock.unlock() }
        return storage
    }

    func log(_ event: String, _ params: [String: Any]) {
        lock.lock(); defer { lock.unlock() }
        storage.append((event, params))
    }

    func count(of name: String) -> Int {
        events.filter { $0.name == name }.count
    }
}
