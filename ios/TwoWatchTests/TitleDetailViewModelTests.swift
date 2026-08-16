import XCTest
@testable import Somto

/// Primi test sul view model piu' grande dell'app (~1.020 righe dentro
/// TitleDetailView.swift). Prima dei protocolli in Domain/Repositories/ questo
/// file non era scrivibile: il view model voleva `TitleRepository` concreto,
/// cioe' Firestore vero.
///
/// Cosa si copre qui: i percorsi che, se si rompono, l'utente vede — non la
/// percentuale di righe.
@MainActor
final class TitleDetailViewModelTests: XCTestCase {

    // MARK: - Fixture

    /// Si riusano le fixture di `PreviewSupport` invece di costruire `Title` a
    /// mano: la init ha ~30 parametri, e un fixture scritto a mano diverge dal
    /// vero appena il modello cambia. Sono gia' visibili ai test perche'
    /// `PreviewSupport.swift` e' `#if DEBUG` e i test girano in Debug.
    /// Calcolate, non stored: `TwoWatchPreview` e' `@MainActor`, e
    /// l'inizializzatore di una proprieta' stored di XCTestCase non e'
    /// garantito isolato al main actor.
    private var movieTitle: Title { TwoWatchPreview.featuredTitle }   // "title-dune-2", .movie
    private var seriesTitle: Title { TwoWatchPreview.secondTitle }    // "title-the-bear", .tv

    private func makeRating(
        uid: String,
        value: Double,
        level: String = "title",
        titleID: String,
        season: Int? = nil,
        episode: Int? = nil
    ) -> Rating {
        Rating(
            id: "\(uid)__\(titleID)__\(level)__\(season.map(String.init) ?? "-")__\(episode.map(String.init) ?? "-")",
            uid: uid,
            titleId: titleID,
            level: level,
            season: season,
            episode: episode,
            rating: value,
            reviewText: nil,
            updatedAt: nil,
            author: nil,
            watchedWith: [],
            watchedWithGroup: nil,
            mediaURLs: []
        )
    }

    private struct Harness {
        let viewModel: TitleDetailViewModel
        let titles: FakeTitleRepository
        let watchlist: FakeWatchlistRepository
        let users: FakeUserRepository
        let analytics: SpyAnalyticsLogger
    }

    /// `load()` lancia i caricamenti differiti in `Task {}` STACCATI, che
    /// quindi proseguono dopo il suo ritorno. Senza aspettarli, un
    /// `recorder.reset()` subito dopo `load()` viene inquinato dalle chiamate
    /// che atterrano un istante piu' tardi, e il test misura la cosa sbagliata.
    ///
    /// I fake rispondono all'istante: bastano pochi giri di scheduler.
    private func settleDeferredLoad() async {
        for _ in 0..<20 { await Task.yield() }
    }

    /// `title: nil` simula un titolo inesistente; il `titleID` resta quello
    /// del fixture cosi' il view model cerca comunque un id plausibile.
    private func makeHarness(title: Title?, titleID: String? = nil) -> Harness {
        let titles = FakeTitleRepository()
        titles.stubTitle = title
        let watchlist = FakeWatchlistRepository(stubState: TwoWatchPreview.generalMovieState)
        let users = FakeUserRepository()
        let analytics = SpyAnalyticsLogger()
        let viewModel = TitleDetailViewModel(
            titleID: titleID ?? title?.id ?? movieTitle.id,
            titleRepository: titles,
            watchlistRepository: watchlist,
            userRepository: users,
            analytics: analytics
        )
        return Harness(
            viewModel: viewModel,
            titles: titles,
            watchlist: watchlist,
            users: users,
            analytics: analytics
        )
    }

    // MARK: - load

    func testLoadPopulatesTitleAndClearsLoadingState() async {
        let title = movieTitle
        let harness = makeHarness(title: title)

        await harness.viewModel.load(currentUserID: nil)

        XCTAssertEqual(harness.viewModel.title?.id, title.id)
        XCTAssertFalse(harness.viewModel.isLoading)
        XCTAssertTrue(harness.viewModel.hasCompletedInitialPresentationLoad)
        XCTAssertNil(harness.viewModel.errorMessage)
    }

    /// Titolo inesistente: deve arrivare un messaggio, non una schermata vuota
    /// indistinguibile da "sto ancora caricando".
    func testLoadWithMissingTitleSurfacesAnError() async {
        let harness = makeHarness(title: nil)

        await harness.viewModel.load(currentUserID: nil)

        XCTAssertNil(harness.viewModel.title)
        XCTAssertFalse(harness.viewModel.isLoading)
        XCTAssertNotNil(harness.viewModel.errorMessage)
    }

    func testLoadPropagatesRepositoryFailureAsErrorMessage() async {
        let harness = makeHarness(title: movieTitle)
        harness.titles.errorFor["fetchTitle"] = FakeRepositoryError.generic

        await harness.viewModel.load(currentUserID: nil)

        XCTAssertFalse(harness.viewModel.isLoading)
        XCTAssertNotNil(harness.viewModel.errorMessage)
    }

    /// Senza utente loggato non si devono toccare i dati personali.
    func testLoadWithoutUserSkipsPersonalState() async {
        let harness = makeHarness(title: movieTitle)

        await harness.viewModel.load(currentUserID: nil)

        XCTAssertNil(harness.viewModel.personalState)
        XCTAssertEqual(harness.watchlist.recorder.count("fetchTitleState"), 0)
        XCTAssertTrue(harness.viewModel.editableLists.isEmpty)
    }

    func testLoadWithUserFetchesPersonalState() async {
        let harness = makeHarness(title: movieTitle)

        await harness.viewModel.load(currentUserID: "u1")

        XCTAssertEqual(harness.watchlist.recorder.count("fetchTitleState"), 1)
        XCTAssertNotNil(harness.viewModel.personalState)
    }

    // MARK: - Guardia anti doppio-tap

    /// `beginAction` e' un guard SINCRONO: deve scattare prima della prima
    /// `await`, altrimenti due tap ravvicinati partono entrambi. E' il
    /// contratto di tutte le mutazioni della scheda.
    func testConcurrentMutationsRunOnlyOnce() async {
        let harness = makeHarness(title: movieTitle)
        await harness.viewModel.load(currentUserID: "u1")
        await settleDeferredLoad()
        harness.watchlist.recorder.reset()
        harness.watchlist.delayFor["updateRewatchIntent"] = .milliseconds(50)

        async let first: Void = harness.viewModel.setRewatchIntent(userID: "u1", isIncluded: true)
        async let second: Void = harness.viewModel.setRewatchIntent(userID: "u1", isIncluded: true)
        _ = await (first, second)

        XCTAssertEqual(
            harness.watchlist.recorder.count("updateRewatchIntent"), 1,
            "il secondo tap deve essere scartato dal guard sincrono"
        )
    }

    func testPendingActionLabelIsClearedAfterMutation() async {
        let harness = makeHarness(title: movieTitle)
        await harness.viewModel.load(currentUserID: "u1")

        await harness.viewModel.setRewatchIntent(userID: "u1", isIncluded: true)

        XCTAssertNil(harness.viewModel.pendingActionLabel)
    }

    /// Anche fallendo, il lucchetto deve aprirsi: se no la scheda resta
    /// bloccata per sempre dopo un errore di rete.
    func testPendingActionLabelIsClearedAfterFailure() async {
        let harness = makeHarness(title: movieTitle)
        await harness.viewModel.load(currentUserID: "u1")
        harness.watchlist.errorFor["updateRewatchIntent"] = FakeRepositoryError.generic

        await harness.viewModel.setRewatchIntent(userID: "u1", isIncluded: true)

        XCTAssertNil(harness.viewModel.pendingActionLabel)
        XCTAssertNotNil(harness.viewModel.errorMessage)
    }

    // MARK: - Preferenza aggiornamenti (rollback ottimistico)

    func testUpdatePreferenceRollsBackOnFailure() async {
        let harness = makeHarness(title: movieTitle)
        await harness.viewModel.load(currentUserID: "u1")
        let original = harness.viewModel.titleUpdatePreference
        harness.titles.errorFor["setTitleUpdatePreference"] = FakeRepositoryError.generic

        await harness.viewModel.setTitleUpdatePreference(.muted, userID: "u1")

        XCTAssertEqual(
            harness.viewModel.titleUpdatePreference, original,
            "in caso di errore la preferenza deve tornare com'era"
        )
        XCTAssertNotNil(harness.viewModel.errorMessage)
        XCTAssertFalse(harness.viewModel.isSavingTitleUpdatePreference)
    }

    func testUpdatePreferenceKeepsNewValueOnSuccess() async {
        let harness = makeHarness(title: movieTitle)
        await harness.viewModel.load(currentUserID: "u1")

        await harness.viewModel.setTitleUpdatePreference(.muted, userID: "u1")

        XCTAssertEqual(harness.viewModel.titleUpdatePreference, .muted)
        XCTAssertFalse(harness.viewModel.isSavingTitleUpdatePreference)
    }

    // MARK: - Aggiornamenti: stato di errore esplicito

    /// Il retry degli aggiornamenti e' uno dei pochi punti dell'app con uno
    /// stato di errore vero invece di una sezione vuota. Va protetto.
    func testRetryTitleUpdatesSetsErrorMessageOnFailure() async {
        let harness = makeHarness(title: movieTitle)
        await harness.viewModel.load(currentUserID: nil)
        harness.titles.errorFor["fetchTitleUpdates"] = FakeRepositoryError.generic

        await harness.viewModel.retryTitleUpdates()

        XCTAssertNotNil(harness.viewModel.updatesErrorMessage)
        XCTAssertFalse(harness.viewModel.isUpdatesLoading)
    }

    func testRetryTitleUpdatesClearsErrorOnSuccess() async {
        let harness = makeHarness(title: movieTitle)
        await harness.viewModel.load(currentUserID: nil)
        harness.titles.errorFor["fetchTitleUpdates"] = FakeRepositoryError.generic
        await harness.viewModel.retryTitleUpdates()
        XCTAssertNotNil(harness.viewModel.updatesErrorMessage)

        harness.titles.errorFor.removeValue(forKey: "fetchTitleUpdates")
        await harness.viewModel.retryTitleUpdates()

        XCTAssertNil(harness.viewModel.updatesErrorMessage)
    }

    // MARK: - Analytics

    func testTitleOpenedIsLoggedOnlyOncePerViewModel() {
        let harness = makeHarness(title: movieTitle)

        harness.viewModel.logTitleOpenedIfNeeded()
        harness.viewModel.logTitleOpenedIfNeeded()
        harness.viewModel.logTitleOpenedIfNeeded()

        XCTAssertEqual(harness.analytics.count(of: AnalyticsEvent.titleOpened), 1)
    }

    // MARK: - Distribuzione voti (logica pura)

    func testRatingBucketsGroupVotesIntoTheFiveWebRanges() async {
        let harness = makeHarness(title: movieTitle)
        harness.titles.stubTitleLevelRatings = [
            makeRating(uid: "a", value: 10, titleID: movieTitle.id),
            makeRating(uid: "b", value: 9, titleID: movieTitle.id),
            makeRating(uid: "c", value: 7, titleID: movieTitle.id),
            makeRating(uid: "d", value: 5, titleID: movieTitle.id),
            makeRating(uid: "e", value: 1, titleID: movieTitle.id)
        ]

        await harness.viewModel.load(currentUserID: nil)
        // I voti arrivano dal caricamento differito: attendo che si posi.
        await Task.yield()
        harness.viewModel.ratings = harness.titles.stubTitleLevelRatings

        let buckets = harness.viewModel.titleRatingBuckets

        XCTAssertEqual(buckets.count, 5)
        XCTAssertEqual(buckets.map(\.label), ["9–10", "7–8", "5–6", "3–4", "1–2"])
        XCTAssertEqual(buckets[0].count, 2, "10 e 9 stanno entrambi in 9–10")
        XCTAssertEqual(buckets[1].count, 1)
        XCTAssertEqual(buckets[2].count, 1)
        XCTAssertEqual(buckets[3].count, 0)
        XCTAssertEqual(buckets[4].count, 1)
        XCTAssertEqual(buckets.map(\.count).reduce(0, +), 5)
    }

    /// I voti a quarti di punto arrivano dal web: 8,75 deve arrotondare a 9 e
    /// finire in 9–10, non in 7–8.
    func testRatingBucketsRoundQuarterPointVotes() async {
        let harness = makeHarness(title: movieTitle)
        await harness.viewModel.load(currentUserID: nil)
        harness.viewModel.ratings = [
            makeRating(uid: "a", value: 8.75, titleID: movieTitle.id),
            makeRating(uid: "b", value: 8.25, titleID: movieTitle.id)
        ]

        let buckets = harness.viewModel.titleRatingBuckets

        XCTAssertEqual(buckets[0].count, 1, "8,75 → 9 → fascia 9–10")
        XCTAssertEqual(buckets[1].count, 1, "8,25 → 8 → fascia 7–8")
    }

    func testRatingBucketsAreEmptyWithoutVotes() async {
        let harness = makeHarness(title: movieTitle)
        await harness.viewModel.load(currentUserID: nil)
        harness.viewModel.ratings = []

        let buckets = harness.viewModel.titleRatingBuckets

        XCTAssertEqual(buckets.count, 5)
        XCTAssertTrue(buckets.allSatisfy { $0.count == 0 })
        XCTAssertTrue(buckets.allSatisfy { $0.fraction == 0 }, "niente divisione per zero")
    }

    // MARK: - Medie filtrate

    func testAverageAmongSubsetOfUsersIgnoresEveryoneElse() async {
        let harness = makeHarness(title: movieTitle)
        await harness.viewModel.load(currentUserID: nil)
        harness.viewModel.ratings = [
            makeRating(uid: "amico1", value: 8, titleID: movieTitle.id),
            makeRating(uid: "amico2", value: 6, titleID: movieTitle.id),
            makeRating(uid: "estraneo", value: 1, titleID: movieTitle.id)
        ]

        let friendsAverage = harness.viewModel.average(level: "title", among: ["amico1", "amico2"])

        XCTAssertEqual(friendsAverage ?? 0, 7, accuracy: 0.001)
    }

    func testAverageIsNilWhenNobodyInTheSubsetVoted() async {
        let harness = makeHarness(title: movieTitle)
        await harness.viewModel.load(currentUserID: nil)
        harness.viewModel.ratings = [makeRating(uid: "estraneo", value: 9, titleID: movieTitle.id)]

        XCTAssertNil(harness.viewModel.average(level: "title", among: ["amico1"]))
    }

    /// Un voto di stagione non deve inquinare la media del titolo.
    func testAverageSeparatesLevels() async {
        let harness = makeHarness(title: seriesTitle)
        await harness.viewModel.load(currentUserID: nil)
        harness.viewModel.ratings = [
            makeRating(uid: "a", value: 10, level: "title", titleID: seriesTitle.id),
            makeRating(uid: "a", value: 2, level: "season", titleID: seriesTitle.id, season: 1)
        ]

        XCTAssertEqual(harness.viewModel.average(level: "title") ?? 0, 10, accuracy: 0.001)
        XCTAssertEqual(harness.viewModel.average(level: "season", season: 1) ?? 0, 2, accuracy: 0.001)
    }

    // MARK: - Voto: comportamento attuale, da cambiare in Fase 4

    /// Il contratto della Fase 4: un voto NON ricarica la scheda.
    ///
    /// Prima di questa fase il test asseriva l'opposto (`fetchTitle` == 1) e
    /// documentava il difetto: `submitRating` chiudeva con `load()`, cioe' il
    /// caricamento pensato per l'apertura della schermata, ~15 richieste fra
    /// trailer, provider, cast, generi, liste pubbliche e chi sta guardando.
    /// Nessuno di quei dati cambia perche' hai votato.
    ///
    /// Ora deve restare cosi': se qualcuno rimette un `load()` su un percorso
    /// di mutazione, questo test lo ferma.
    func testSubmitRatingDoesNotReloadTheWholeTitle() async {
        let harness = makeHarness(title: movieTitle)
        await harness.viewModel.load(currentUserID: "u1")
        await settleDeferredLoad()
        harness.titles.recorder.reset()
        await settleDeferredLoad()
        harness.watchlist.recorder.reset()

        _ = await harness.viewModel.submitRating(userID: "u1", level: "title", value: 8, reviewText: nil)

        XCTAssertEqual(harness.titles.recorder.count("submitRating"), 1)
        XCTAssertEqual(
            harness.titles.recorder.count("fetchTitle"), 0,
            "un voto non deve rifare il load della scheda"
        )
        for section in ["fetchProviders", "fetchTrailerURL", "fetchTitleCredits", "listGenres", "fetchSeasonMetadata"] {
            XCTAssertEqual(
                harness.titles.recorder.count(section), 0,
                "\(section) non c'entra niente con un voto"
            )
        }
        XCTAssertEqual(harness.watchlist.recorder.count("fetchTitleWatchersProgress"), 0)
        XCTAssertEqual(harness.watchlist.recorder.count("fetchPublicListsContainingTitle"), 0)
    }

    /// Il refresh mirato deve comunque riportare i dati che un voto CAMBIA:
    /// se no la stella si accende ma il resto della scheda resta indietro.
    func testSubmitRatingRefreshesRatingsAndPersonalState() async {
        let harness = makeHarness(title: movieTitle)
        await harness.viewModel.load(currentUserID: "u1")
        await settleDeferredLoad()
        harness.titles.recorder.reset()
        await settleDeferredLoad()
        harness.watchlist.recorder.reset()

        _ = await harness.viewModel.submitRating(userID: "u1", level: "title", value: 8, reviewText: nil)

        XCTAssertEqual(harness.titles.recorder.count("fetchTitleLevelRatings"), 1)
        XCTAssertEqual(harness.titles.recorder.count("fetchDerivedRating"), 1)
        XCTAssertEqual(harness.watchlist.recorder.count("fetchTitleState"), 1)
    }

    func testDeleteRatingAlsoUsesTheTargetedRefresh() async {
        let harness = makeHarness(title: movieTitle)
        await harness.viewModel.load(currentUserID: "u1")
        await settleDeferredLoad()
        harness.titles.recorder.reset()

        await harness.viewModel.deleteRating(userID: "u1", level: "title")

        XCTAssertEqual(harness.titles.recorder.count("deleteRating"), 1)
        XCTAssertEqual(harness.titles.recorder.count("fetchTitle"), 0)
        XCTAssertEqual(harness.titles.recorder.count("fetchTitleLevelRatings"), 1)
    }

    func testSubmitRatingSurfacesFailure() async {
        let harness = makeHarness(title: movieTitle)
        await harness.viewModel.load(currentUserID: "u1")
        harness.titles.errorFor["submitRating"] = FakeRepositoryError.generic

        _ = await harness.viewModel.submitRating(userID: "u1", level: "title", value: 8, reviewText: nil)

        XCTAssertNotNil(harness.viewModel.errorMessage)
        XCTAssertNil(harness.viewModel.pendingActionLabel)
    }
}
