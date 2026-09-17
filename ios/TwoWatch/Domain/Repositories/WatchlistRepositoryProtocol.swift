import Foundation
import UIKit

/// Superficie di `WatchlistRepository` consumata dal layer di presentazione.
/// Stesse motivazioni e stesso perimetro incrementale di
/// `TitleRepositoryProtocol`.
@MainActor
protocol WatchlistRepositoryProtocol: AnyObject, Sendable {
    // Dashboard e liste personali
    //
    // Aggiunti quando `WatchlistViewModel` e' passato al protocollo: prima
    // riceveva le classi concrete e non era istanziabile in un test.
    func fetchWatchlistDashboard(userID: String) async throws -> WatchlistDashboard
    func fetchListDetail(userID: String, listID: String) async throws -> UserListDetail
    func updateList(
        userID: String,
        listID: String,
        draft: UserListEditorDraft,
        collaborators: [AppUser]
    ) async throws -> UserListDetail
    func deleteList(userID: String, listID: String) async throws
    func duplicateList(userID: String, sourceListID: String, owner: AppUser?) async throws -> UserListDetail
    func removeTitleFromList(userID: String, listID: String, titleID: String) async throws
    func reorderListItems(userID: String, listID: String, itemIDs: [String]) async throws
    func uploadListCover(userID: String, listID: String, image: UIImage) async throws
    func searchCollaborators(query: String, userID: String, excluding excludedIDs: [String]) async throws -> [AppUser]
    func buildNaturalListPreview(_ phrase: String) async throws -> NaturalListPreview

    // Liste pubbliche di altri
    func fetchPublicListBySlug(_ slug: String, currentUserID: String) async throws -> UserListSummary?
    func togglePublicListPin(userID: String, listID: String, isPinned: Bool) async throws
    func setPublicListMovieSeen(
        userID: String,
        listID: String,
        title: Title,
        isSeen: Bool
    ) async throws -> PublicListItemProgress
    func setPublicListSeriesProgress(
        userID: String,
        listID: String,
        title: Title,
        watchedEpisodesCount: Int,
        completedSeasonsCount: Int,
        lastWatchedSeasonNumber: Int?,
        lastWatchedEpisodeNumber: Int?
    ) async throws -> PublicListItemProgress

    // Profilo — superficie usata da `ProfileViewModel`
    func fetchLibrary(userID: String, limit: Int) async throws -> [LibraryEntry]
    func fetchProfileActivitySummary(userID: String, preloadedUser: AppUser?) async throws -> ProfileActivitySummary
    func fetchProfileReviews(userID: String) async throws -> [ProfileReviewEntry]
    func fetchReviewCount(userID: String, preloadedUser: AppUser?) async throws -> Int
    func fetchPublicPostsByAuthor(userID: String, limit: Int) async throws -> [AppPost]
    func fetchPublicProfileSeriesProgress(userID: String) async throws -> [String: TitleSeriesProgress]
    func detectNewSeasonsForUser(userID: String) async throws -> NewSeasonDetectionResult

    // Stato personale sul titolo
    func fetchTitleState(userID: String, title: Title) async throws -> TitlePersonalState
    func updateGeneralWatchlist(
        userID: String,
        title: Title,
        isIncluded: Bool,
        source: String
    ) async throws -> TitlePersonalState
    func updateRewatchIntent(
        userID: String,
        title: Title,
        isIncluded: Bool,
        source: String
    ) async throws -> TitlePersonalState
    func syncPersonalStateAfterRating(
        userID: String,
        title: Title,
        ratingValue: Double
    ) async throws -> TitlePersonalState
    func markRatingDeferred(userID: String, title: Title) async throws -> TitlePersonalState
    func acknowledgeNewContent(userID: String, title: Title) async throws -> TitlePersonalState

    // Avanzamento film
    func markMovieSeen(userID: String, title: Title) async throws -> TitlePersonalState
    func markMovieUnseen(userID: String, title: Title) async throws -> TitlePersonalState

    // Avanzamento serie
    func markSeriesUnstarted(userID: String, title: Title) async throws -> TitlePersonalState
    func markSeriesEpisodeWatched(userID: String, title: Title) async throws -> TitlePersonalState
    func markSeriesSeasonWatched(userID: String, title: Title) async throws -> TitlePersonalState
    func markSeriesCompleted(userID: String, title: Title) async throws -> TitlePersonalState
    func setSeriesProgress(
        userID: String,
        title: Title,
        watchedEpisodesCount: Int,
        completedSeasonsCount: Int,
        lastWatchedSeasonNumber: Int?,
        lastWatchedEpisodeNumber: Int?,
        source: String
    ) async throws -> TitlePersonalState

    // Liste
    func fetchEditableListSummaries(userID: String, limit: Int) async throws -> [UserListSummary]
    func fetchPublicListsContainingTitle(
        titleID: String,
        currentUserID: String,
        limit: Int
    ) async throws -> [UserListSummary]
    func createList(
        userID: String,
        owner: AppUser?,
        draft: UserListEditorDraft,
        collaborators: [AppUser]
    ) async throws -> UserListDetail
    func addTitleToList(userID: String, listID: String, title: Title) async throws

    // Social
    func fetchTitleWatchersProgress(titleID: String) async throws -> [TitleWatcher]
}

/// Convenienze con i default delle firme concrete: i requisiti di protocollo
/// non ammettono valori di default, e senza queste ogni call site andrebbe
/// riscritto (vedi nota in `TitleRepositoryProtocol`).
extension WatchlistRepositoryProtocol {
    func fetchLibrary(userID: String) async throws -> [LibraryEntry] {
        try await fetchLibrary(userID: userID, limit: 400)
    }

    func fetchPublicPostsByAuthor(userID: String) async throws -> [AppPost] {
        try await fetchPublicPostsByAuthor(userID: userID, limit: 50)
    }

    func updateGeneralWatchlist(
        userID: String,
        title: Title,
        isIncluded: Bool
    ) async throws -> TitlePersonalState {
        try await updateGeneralWatchlist(
            userID: userID,
            title: title,
            isIncluded: isIncluded,
            source: "ios_title_detail"
        )
    }

    func updateRewatchIntent(
        userID: String,
        title: Title,
        isIncluded: Bool
    ) async throws -> TitlePersonalState {
        try await updateRewatchIntent(
            userID: userID,
            title: title,
            isIncluded: isIncluded,
            source: "ios_title_detail_rewatch"
        )
    }

    func fetchEditableListSummaries(userID: String) async throws -> [UserListSummary] {
        try await fetchEditableListSummaries(userID: userID, limit: 80)
    }

    func fetchPublicListsContainingTitle(
        titleID: String,
        currentUserID: String
    ) async throws -> [UserListSummary] {
        try await fetchPublicListsContainingTitle(
            titleID: titleID,
            currentUserID: currentUserID,
            limit: 12
        )
    }
}

extension WatchlistRepository: WatchlistRepositoryProtocol {}
