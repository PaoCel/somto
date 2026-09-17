import XCTest
@testable import Somto

/// Test sul ViewModel del profilo proprio.
///
/// `load` legge sette cose in parallelo e le tratta in modo **deliberatamente
/// diverso**: la libreria e il riepilogo attività alzano un errore visibile, il
/// resto degrada in silenzio. È una gerarchia scritta a mano, invisibile
/// leggendo la UI, e finora niente la fissava: bastava un `try?` messo sul ramo
/// sbagliato per far sparire il profilo di qualcuno, o per lasciare l'utente
/// davanti a una schermata muta.
@MainActor
final class ProfileViewModelTests: XCTestCase {

    /// Fake + ViewModel costruiti insieme, dentro il test: `setUp()` e'
    /// `nonisolated` anche in una classe `@MainActor`, e assegnare li' dei fake
    /// isolati al main actor attraversa l'isolamento.
    private struct Harness {
        let watchlist: FakeWatchlistRepository
        let user: FakeUserRepository
        let title: FakeTitleRepository
        let viewModel: ProfileViewModel
    }

    private func makeHarness(
        configure: (FakeWatchlistRepository, FakeUserRepository, FakeTitleRepository) -> Void = { _, _, _ in }
    ) -> Harness {
        let watchlist = FakeWatchlistRepository(stubState: TwoWatchPreview.generalMovieState)
        let user = FakeUserRepository()
        let title = FakeTitleRepository()
        configure(watchlist, user, title)
        return Harness(
            watchlist: watchlist,
            user: user,
            title: title,
            viewModel: ProfileViewModel(
                watchlistRepository: watchlist,
                userRepository: user,
                titleRepository: title
            )
        )
    }

    // MARK: - Gerarchia degli errori

    /// La libreria è il profilo: se non arriva, l'utente deve saperlo.
    func testLibraryFailureIsVisibleToTheUser() async {
        let harness = makeHarness { watchlist, _, _ in
            watchlist.errorFor["fetchLibrary"] = FakeRepositoryError.generic
        }
        let viewModel = harness.viewModel

        await viewModel.load(userID: "uid-1")

        XCTAssertTrue(viewModel.watchedEntries.isEmpty)
        XCTAssertNotNil(viewModel.errorMessage)
        XCTAssertFalse(viewModel.isLoading)
    }

    /// Follower, following e conteggio recensioni sono contorno: se falliscono,
    /// il profilo si vede lo stesso e senza allarmi.
    func testAccessoryFailuresDegradeSilently() async {
        let harness = makeHarness { watchlist, user, _ in
            user.errorFor["listFollowers"] = FakeRepositoryError.generic
            user.errorFor["listFollowing"] = FakeRepositoryError.generic
            watchlist.errorFor["fetchReviewCount"] = FakeRepositoryError.generic
            watchlist.errorFor["fetchPublicProfileSeriesProgress"] = FakeRepositoryError.generic
        }
        let viewModel = harness.viewModel

        await viewModel.load(userID: "uid-1")

        XCTAssertNil(viewModel.errorMessage)
        XCTAssertTrue(viewModel.followers.isEmpty)
        XCTAssertTrue(viewModel.following.isEmpty)
        XCTAssertEqual(viewModel.reviewCount, 0)
        XCTAssertTrue(viewModel.seriesProgress.isEmpty)
    }

    /// Se falliscono sia libreria sia riepilogo, all'utente resta **un**
    /// messaggio: quello del primo, non l'ultimo che sovrascrive.
    func testTheFirstErrorIsTheOneShown() async {
        let harness = makeHarness { watchlist, _, _ in
            watchlist.errorFor["fetchLibrary"] = FakeRepositoryError(message: "errore libreria")
            watchlist.errorFor["fetchProfileActivitySummary"] = FakeRepositoryError(message: "errore riepilogo")
        }
        let viewModel = harness.viewModel

        await viewModel.load(userID: "uid-1")

        XCTAssertEqual(viewModel.errorMessage, "errore libreria")
    }

    // MARK: - users/{uid} letto una volta sola

    /// Riepilogo e conteggio recensioni rileggevano ognuno `users/{uid}`.
    /// Ora la lettura è una e viene passata a entrambi: se questa regredisce,
    /// tornano due letture Firestore per ogni apertura di profilo.
    func testTheUserDocumentIsReadOnce() async {
        let harness = makeHarness()

        await harness.viewModel.load(userID: "uid-1")

        XCTAssertEqual(harness.user.recorder.count("fetchUser"), 1)
    }

    // MARK: - Tab Attività pigro

    func testActivityIsNotLoadedUntilTheTabIsOpened() async {
        let harness = makeHarness()

        await harness.viewModel.load(userID: "uid-1")

        XCTAssertEqual(harness.watchlist.recorder.count("fetchProfileReviews"), 0)
        XCTAssertEqual(harness.title.recorder.count("fetchMyEmotions"), 0)
    }

    func testActivityLoadsOnceAndNotAgain() async {
        let harness = makeHarness()
        await harness.viewModel.load(userID: "uid-1")

        await harness.viewModel.loadActivityIfNeeded(userID: "uid-1")
        await harness.viewModel.loadActivityIfNeeded(userID: "uid-1")

        XCTAssertEqual(harness.watchlist.recorder.count("fetchProfileReviews"), 1)
        XCTAssertEqual(harness.title.recorder.count("fetchMyEmotions"), 1)
        XCTAssertFalse(harness.viewModel.isLoadingActivity)
    }

    /// Un reload completo (es. cambio account) deve azzerare il tab Attività,
    /// altrimenti resta in schermo la roba dell'account precedente.
    func testReloadResetsTheActivityTab() async {
        let harness = makeHarness()
        await harness.viewModel.load(userID: "uid-1")
        await harness.viewModel.loadActivityIfNeeded(userID: "uid-1")

        await harness.viewModel.load(userID: "uid-2")
        await harness.viewModel.loadActivityIfNeeded(userID: "uid-2")

        XCTAssertEqual(harness.watchlist.recorder.count("fetchProfileReviews"), 2)
    }

    // MARK: - Rilevamento nuove stagioni

    /// È opzionale: se fallisce non deve toccare lo stato d'errore della UI.
    func testNewSeasonDetectionFailureIsNeverShown() async {
        let harness = makeHarness { watchlist, _, _ in
            watchlist.errorFor["detectNewSeasonsForUser"] = FakeRepositoryError.generic
        }
        let viewModel = harness.viewModel

        await viewModel.detectNewSeasonsIfNeeded(userID: "uid-1")

        XCTAssertNil(viewModel.errorMessage)
        XCTAssertTrue(viewModel.newSeasonHits.isEmpty)
    }

    /// Ha un intervallo minimo: due chiamate ravvicinate valgono una sola
    /// query, che è quello che tiene basso il costo Firestore all'apertura.
    func testNewSeasonDetectionIsThrottled() async {
        let harness = makeHarness()

        await harness.viewModel.detectNewSeasonsIfNeeded(userID: "uid-1")
        await harness.viewModel.detectNewSeasonsIfNeeded(userID: "uid-1")

        XCTAssertEqual(harness.watchlist.recorder.count("detectNewSeasonsForUser"), 1)
    }
}
