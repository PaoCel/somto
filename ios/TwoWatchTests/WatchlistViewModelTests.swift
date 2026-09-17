import XCTest
@testable import Somto

/// Test sul ViewModel della Watchlist, scrivibili da quando prende i protocolli
/// invece delle classi concrete.
///
/// Cosa si copre: i comportamenti che in produzione **non si vedono finché non
/// si rompono** — la guardia anti doppio-tap, il toggle ottimistico del pin (che
/// deve tornare indietro se il server rifiuta), e il fatto che un errore su un
/// dato accessorio non debba far fallire il caricamento principale.
///
/// Le fixture arrivano da `PreviewSupport`: costruirle a mano diverge dal
/// modello vero appena questo cambia.
@MainActor
final class WatchlistViewModelTests: XCTestCase {

    private var publicList: UserListSummary { TwoWatchPreview.previewPublicList }

    /// Fake + ViewModel costruiti insieme, dentro il test.
    ///
    /// Non in `setUp()`: quell'override e' `nonisolated` anche in una classe
    /// `@MainActor`, quindi assegnare li' dei fake isolati al main actor e'
    /// un attraversamento di isolamento — warning oggi, errore quando il
    /// modulo passera' a strict concurrency completa.
    private struct Harness {
        let watchlist: FakeWatchlistRepository
        let title: FakeTitleRepository
        let viewModel: WatchlistViewModel
    }

    private func makeHarness(
        configure: (FakeWatchlistRepository, FakeTitleRepository) -> Void = { _, _ in }
    ) -> Harness {
        let watchlist = FakeWatchlistRepository(stubState: TwoWatchPreview.generalMovieState)
        let title = FakeTitleRepository()
        configure(watchlist, title)
        return Harness(
            watchlist: watchlist,
            title: title,
            viewModel: WatchlistViewModel(watchlistRepository: watchlist, titleRepository: title)
        )
    }

    // MARK: - Caricamento

    func testLoadFillsTheDashboard() async {
        let harness = makeHarness { watchlist, _ in
            watchlist.stubDashboard = TwoWatchPreview.watchlistDashboard
        }
        let viewModel = harness.viewModel

        await viewModel.load(userID: "uid-1")

        XCTAssertEqual(viewModel.dashboard, TwoWatchPreview.watchlistDashboard)
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertFalse(viewModel.isLoading)
    }

    /// I generi servono solo alle etichette: se falliscono, la watchlist si deve
    /// vedere lo stesso. E' il motivo per cui la chiamata usa `try?`.
    func testGenresFailureDoesNotBlockTheDashboard() async {
        let harness = makeHarness { watchlist, title in
            watchlist.stubDashboard = TwoWatchPreview.watchlistDashboard
            title.errorFor["listGenres"] = FakeRepositoryError.generic
        }
        let viewModel = harness.viewModel

        await viewModel.load(userID: "uid-1")

        XCTAssertEqual(viewModel.dashboard, TwoWatchPreview.watchlistDashboard)
        XCTAssertNil(viewModel.errorMessage)
    }

    /// La regressione da impedire: l'errore tecnico dell'SDK non deve arrivare
    /// in schermo (docs/context/IOS_CODE_STYLE.md §5.1).
    func testDashboardFailureShowsAUserFacingMessage() async {
        let harness = makeHarness { watchlist, _ in
            watchlist.errorFor["fetchWatchlistDashboard"] = FakeRepositoryError(
                message: "Missing or insufficient permissions."
            )
        }
        let viewModel = harness.viewModel

        await viewModel.load(userID: "uid-1")

        // `FakeRepositoryError` e' un `LocalizedError` nostro, quindi il mapper
        // ne rispetta il testo: qui si verifica che il messaggio ci sia e che
        // l'utente non resti davanti a una schermata muta.
        XCTAssertNotNil(viewModel.errorMessage)
        XCTAssertFalse(viewModel.isLoading)
    }

    // MARK: - Liste pubbliche per slug

    func testOpeningAMissingPublicListFailsWithItsOwnMessage() async {
        let harness = makeHarness { watchlist, _ in watchlist.stubPublicListBySlug = nil }
        let viewModel = harness.viewModel

        let opened = await viewModel.openPublicList(slug: "lista-sparita", userID: "uid-1")

        XCTAssertFalse(opened)
        XCTAssertEqual(viewModel.errorMessage, String(localized: "Lista non trovata o non più pubblica."))
        XCTAssertNil(viewModel.selectedListDetail)
        XCTAssertFalse(viewModel.isLoadingList)
    }

    // MARK: - Toggle ottimistico del pin

    func testPinTogglesOptimisticallyAndClearsTheOverrideOnSuccess() async {
        let harness = makeHarness()
        let viewModel = harness.viewModel
        let before = viewModel.isPublicListSaved(publicList)

        await viewModel.togglePublicListPin(userID: "uid-1", list: publicList)

        XCTAssertEqual(harness.watchlist.recorder.count("togglePublicListPin"), 1)
        // A operazione riuscita l'override sparisce: da li' in poi comanda il
        // dashboard ricaricato, non lo stato ottimistico.
        XCTAssertEqual(viewModel.isPublicListSaved(publicList), before)
        XCTAssertNil(viewModel.errorMessage)
    }

    /// Se il server rifiuta, la stellina non deve restare accesa.
    func testPinRevertsWhenTheServerRefuses() async {
        let harness = makeHarness { watchlist, _ in
            watchlist.errorFor["togglePublicListPin"] = FakeRepositoryError.generic
        }
        let viewModel = harness.viewModel
        let before = viewModel.isPublicListSaved(publicList)

        await viewModel.togglePublicListPin(userID: "uid-1", list: publicList)

        XCTAssertEqual(viewModel.isPublicListSaved(publicList), before)
        XCTAssertNotNil(viewModel.errorMessage)
    }

    /// Anti doppio-tap: la seconda chiamata mentre la prima e' in volo non deve
    /// arrivare al server. Senza questa guardia un tap ripetuto scrive due volte.
    func testASecondActionIsIgnoredWhileTheFirstIsInFlight() async {
        let harness = makeHarness { watchlist, _ in
            watchlist.delayFor["togglePublicListPin"] = .milliseconds(120)
        }
        let viewModel = harness.viewModel
        // Locale, non `self.publicList`: `async let` porterebbe `self` (non
        // Sendable) dentro un contesto isolato al main actor.
        let list = publicList

        async let first: Void = viewModel.togglePublicListPin(userID: "uid-1", list: list)
        // Lascia partire la prima prima di tentare la seconda.
        try? await Task.sleep(for: .milliseconds(20))
        await viewModel.togglePublicListPin(userID: "uid-1", list: list)
        await first

        XCTAssertEqual(harness.watchlist.recorder.count("togglePublicListPin"), 1)
    }

    // MARK: - Stato "salvata"

    func testTheOptimisticOverrideWinsOverTheDashboardValue() async {
        let harness = makeHarness { watchlist, _ in
            watchlist.delayFor["togglePublicListPin"] = .milliseconds(80)
        }
        let viewModel = harness.viewModel
        let list = publicList
        let before = viewModel.isPublicListSaved(list)

        async let toggle: Void = viewModel.togglePublicListPin(userID: "uid-1", list: list)
        try? await Task.sleep(for: .milliseconds(20))

        // Mentre la chiamata e' in volo l'utente deve gia' vedere il nuovo stato.
        XCTAssertEqual(viewModel.isPublicListSaved(list), !before)
        await toggle
    }

    // MARK: - Badge "In uscita"

    /// La selezione dei candidati e' pura e prende l'anno da fuori proprio per
    /// non dipendere dalla data di esecuzione del test.
    private var movieState: TitlePersonalState { TwoWatchPreview.generalMovieState } // film 2024
    private var seriesState: TitlePersonalState { TwoWatchPreview.generalSeriesState }

    /// Le serie hanno i loro eventi (`new_episode`): interrogarle qui sarebbe
    /// una query per niente.
    func testOnlyMoviesAreCandidatesForTheReleaseDate() {
        let ids = WatchlistViewModel.upcomingReleaseCandidateIDs(
            from: [movieState, seriesState],
            referenceYear: 2024
        )

        XCTAssertEqual(ids, [movieState.titleId])
    }

    /// Il filtro che tiene piccola la query: un film uscito anni fa non puo'
    /// avere un'uscita futura.
    func testOldMoviesAreNotQueried() {
        let ids = WatchlistViewModel.upcomingReleaseCandidateIDs(
            from: [movieState],
            referenceYear: 2030
        )

        XCTAssertTrue(ids.isEmpty)
    }

    /// Un anno di tolleranza: il film uscito altrove l'anno scorso e
    /// distribuito in Italia adesso deve restare interrogabile.
    func testLastYearMoviesStayCandidates() {
        let ids = WatchlistViewModel.upcomingReleaseCandidateIDs(
            from: [movieState],
            referenceYear: 2025
        )

        XCTAssertEqual(ids, [movieState.titleId])
    }

    func testCandidatesExcludeTitlesAlreadyQueried() {
        let ids = WatchlistViewModel.upcomingReleaseCandidateIDs(
            from: [movieState],
            referenceYear: 2024,
            alreadyChecked: [movieState.titleId]
        )

        XCTAssertTrue(ids.isEmpty)
    }

    /// Una seconda passata sulla stessa schermata (la `.task` riparte quando la
    /// lista cambia) non deve rifare la query: "nessuna uscita futura" e' il
    /// caso normale e non lascia traccia in `upcomingReleaseByTitle`.
    func testTheSecondPassDoesNotQueryAgain() async {
        let harness = makeHarness()
        let viewModel = harness.viewModel
        let states = [Self.undatedMovieState]

        await viewModel.loadUpcomingReleases(for: states)
        await viewModel.loadUpcomingReleases(for: states)

        XCTAssertEqual(harness.title.recorder.count("fetchUpcomingReleaseDates"), 1)
    }

    func testTheReleaseDateReachesTheCard() async {
        let expected = Date(timeIntervalSince1970: 1_791_547_200) // 2026-10-08, 12:00 UTC
        let harness = makeHarness { _, title in
            title.stubUpcomingReleaseDates = [Self.undatedMovieState.titleId: expected]
        }
        let viewModel = harness.viewModel

        await viewModel.loadUpcomingReleases(for: [Self.undatedMovieState])

        XCTAssertEqual(viewModel.upcomingReleaseDate(for: Self.undatedMovieState), expected)
    }

    /// Il badge e' accessorio: se la query fallisce (tipicamente un indice non
    /// ancora deployato) la watchlist non deve mostrare un errore.
    func testAReleaseDateFailureIsSilentForTheUser() async {
        let harness = makeHarness { _, title in
            title.errorFor["fetchUpcomingReleaseDates"] = FakeRepositoryError.generic
        }
        let viewModel = harness.viewModel

        await viewModel.loadUpcomingReleases(for: [Self.undatedMovieState])

        XCTAssertNil(viewModel.errorMessage)
        XCTAssertTrue(viewModel.upcomingReleaseByTitle.isEmpty)
    }

    /// Film senza `title` idratato, quindi senza anno: e' il caso "annunciato e
    /// non ancora datato", che resta candidato qualunque sia l'anno corrente.
    /// Le fixture di `PreviewSupport` hanno anni fissi e renderebbero i test
    /// dipendenti dalla data di esecuzione.
    private static let undatedMovieState = TitlePersonalState(
        id: "state-undated-movie",
        titleId: "title-undated-movie",
        mediaType: .movie,
        generalWatchlist: true,
        rewatchIntent: false,
        movieStatus: .unseen,
        seriesStatus: nil,
        seriesProgress: nil,
        ratingValue: nil,
        hasTitleRating: false,
        seenAt: nil,
        completedAt: nil,
        ratedAt: nil,
        rewatchAddedAt: nil,
        createdAt: nil,
        updatedAt: nil,
        lastInteractionAt: nil,
        source: "test",
        reminderHints: .empty,
        title: nil
    )
}
