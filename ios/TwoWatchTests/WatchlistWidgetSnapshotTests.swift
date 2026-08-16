import XCTest
@testable import Somto

/// Il riassunto che l'app lascia al widget "Watchlist".
///
/// Cosa si copre — le tre cose che si vedono da fuori dall'app, cioe' sulla
/// schermata Home di chi il widget ce l'ha: che le serie in corso non vengano
/// sepolte dalla coda, che un titolo non compaia due volte con due risposte
/// diverse ("sei a S3·E7" e "da guardare"), e che una riga senza titolo idratato
/// non diventi una riga senza nome.
///
/// Non si copre lo `Store`: scrive in un App Group, che in un test unitario non
/// esiste (`containerURL(...)` torna `nil` e le funzioni escono in silenzio,
/// come devono).
final class WatchlistWidgetSnapshotTests: XCTestCase {

    // MARK: - Come si dividono le righe

    func testLaCodaNonSiPrendePiuDellaSuaQuota() {
        let rows = Self.rows(inProgress: 6, upNext: 4)

        let large = WatchlistWidgetRowPlan.rows(from: rows, rowCount: 5)

        XCTAssertEqual(large.count, 5)
        XCTAssertEqual(large.filter { $0.kind == .upNext }.count, 2)
        // Le serie in corso vengono prima: e' la domanda che porta al widget.
        XCTAssertEqual(large.prefix(3).filter { $0.kind == .inProgress }.count, 3)
    }

    func testInDueRigheNonCEPostoPerLaCoda() {
        let rows = Self.rows(inProgress: 3, upNext: 3)

        let medium = WatchlistWidgetRowPlan.rows(from: rows, rowCount: 2)

        XCTAssertEqual(medium.map(\.kind), [.inProgress, .inProgress])
    }

    func testSenzaSerieInCorsoLaCodaSiAllarga() {
        let rows = Self.rows(inProgress: 0, upNext: 4)

        let large = WatchlistWidgetRowPlan.rows(from: rows, rowCount: 5)

        // Meglio un widget pieno di una cosa sola che un widget mezzo vuoto.
        XCTAssertEqual(large.count, 4)
        XCTAssertTrue(large.allSatisfy { $0.kind == .upNext })
    }

    func testSenzaCodaLeSerieInCorsoRiempionoTutto() {
        let rows = Self.rows(inProgress: 6, upNext: 0)

        let large = WatchlistWidgetRowPlan.rows(from: rows, rowCount: 5)

        XCTAssertEqual(large.count, 5)
        XCTAssertTrue(large.allSatisfy { $0.kind == .inProgress })
    }

    // MARK: - Dal dashboard al riassunto

    func testUnaSerieInCorsoPortaStagioneEdEpisodio() {
        let progress = TitleSeriesProgress(
            episodesWatchedCount: 12,
            seasonsCompletedCount: 2,
            totalEpisodeCount: 24,
            totalSeasonCount: 3,
            lastWatchedEpisodeId: "ep",
            lastWatchedEpisodeName: "Episodio",
            lastWatchedSeasonNumber: 3,
            lastWatchedEpisodeNumber: 7,
            lastWatchedAt: nil,
            percentComplete: 0.5
        )
        let dashboard = Self.dashboard(
            inProgressSeries: [Self.state(id: "serie", name: "La serie", isSeries: true, progress: progress)],
            generalWatchlist: []
        )

        let snapshot = WatchlistWidgetSnapshotBuilder.snapshot(from: dashboard)

        XCTAssertEqual(snapshot.version, WatchlistWidgetSnapshot.currentVersion)
        XCTAssertEqual(snapshot.rows.count, 1)
        let row = try? XCTUnwrap(snapshot.rows.first)
        XCTAssertEqual(row?.kind, .inProgress)
        XCTAssertEqual(row?.season, 3)
        XCTAssertEqual(row?.episode, 7)
        XCTAssertEqual(row?.episodesWatched, 12)
        XCTAssertEqual(row?.episodesTotal, 24)
        // Il doc id, non lo slug: `/film/<slug>` con un doc id non risolve.
        XCTAssertEqual(row?.path, "/share/title/serie")
    }

    func testLoStessoTitoloNonCompareDueVolte() {
        let inProgress = Self.state(id: "serie", name: "La serie", isSeries: true, progress: .empty)
        let dashboard = Self.dashboard(
            inProgressSeries: [inProgress],
            generalWatchlist: [inProgress, Self.state(id: "film", name: "Un film", isSeries: false, progress: nil)]
        )

        let snapshot = WatchlistWidgetSnapshotBuilder.snapshot(from: dashboard)

        XCTAssertEqual(snapshot.rows.map(\.id), ["serie", "film"])
        XCTAssertEqual(snapshot.rows.map(\.kind), [.inProgress, .upNext])
    }

    func testUnaRigaSenzaTitoloIdratatoNonEntra() {
        let dashboard = Self.dashboard(
            inProgressSeries: [Self.state(id: "orfano", name: nil, isSeries: true, progress: .empty)],
            generalWatchlist: [Self.state(id: "film", name: "Un film", isSeries: false, progress: nil)]
        )

        let snapshot = WatchlistWidgetSnapshotBuilder.snapshot(from: dashboard)

        XCTAssertEqual(snapshot.rows.map(\.id), ["film"])
    }

    // MARK: - Dove porta il tasto guarda

    func testIlLinkDirettoVinceSuTutto() {
        let direct = URL(string: "https://www.netflix.com/title/81234567")!
        let destination = StreamingDestinationResolver.destination(
            providerName: "Netflix",
            deepLinks: ["Netflix": direct],
            titleName: "Glass City",
            tmdbId: 999,
            isSeries: true
        )

        XCTAssertEqual(destination?.url, direct)
        XCTAssertEqual(destination?.source, .direct)
        XCTAssertTrue(destination?.isExact ?? false)
    }

    func testFraDuePiattaformeVinceQuellaConIlLinkEsatto() {
        // Anche se TMDB mette Prime davanti: meglio la seconda piattaforma sulla
        // scheda esatta che la prima su una ricerca.
        let netflix = URL(string: "https://www.netflix.com/title/81234567")!
        let best = StreamingDestinationResolver.best(
            providerNames: ["Amazon Prime Video", "Netflix"],
            deepLinks: ["Netflix": netflix],
            titleName: "Glass City",
            tmdbId: 999,
            isSeries: true
        )

        XCTAssertEqual(best?.providerName, "Netflix")
        XCTAssertEqual(best?.source, .direct)
    }

    func testSenzaLinkDirettoSiApreLaRicercaDellaPiattaforma() {
        let destination = StreamingDestinationResolver.destination(
            providerName: "Netflix",
            deepLinks: [:],
            titleName: "Glass City",
            tmdbId: nil,
            isSeries: true
        )

        XCTAssertEqual(destination?.url.absoluteString, "https://www.netflix.com/search?q=Glass%20City")
        XCTAssertEqual(destination?.source, .providerSearch)
        XCTAssertFalse(destination?.isExact ?? true)
    }

    // MARK: - Il tap sul widget non deve finire nel browser interno

    func testGliIndirizziDiStreamingEsconoDaSomto() {
        // Un tap su un widget consegna l'URL all'app contenitrice: se Somto non
        // riconosce questi domini li apre nel suo browser, e chi ha toccato
        // "guarda" resta dentro Somto (visto sul device il 2026-08-16).
        for indirizzo in [
            "https://tv.apple.com/show/umc.cmc.vtoh0mn0xn7t3c643xqonfzy",
            "https://www.netflix.com/title/70143836",
            "https://www.disneyplus.com/series/wp/3jLIGMDYINqD",
            "https://play.max.com/show/93ba22b1",
            "https://www.primevideo.com/search/?phrase=Ted%20Lasso",
            "https://www.themoviedb.org/tv/97546/watch?locale=IT",
        ] {
            let url = URL(string: indirizzo)!
            XCTAssertTrue(
                StreamingDestinationResolver.isExternalWatchDestination(url),
                "\(indirizzo) doveva uscire da Somto"
            )
        }
    }

    func testGliIndirizziDiSomtoRestanoInSomto() {
        // Il deep link del titolo deve continuare ad aprire la scheda in app,
        // non il browser di sistema.
        for indirizzo in [
            "https://somto.it/share/title/tmdb_tv_97546",
            "https://somto.it/serie/ted-lasso",
            "https://somto.it/widget",
        ] {
            let url = URL(string: indirizzo)!
            XCTAssertFalse(
                StreamingDestinationResolver.isExternalWatchDestination(url),
                "\(indirizzo) doveva restare in Somto"
            )
        }
    }

    // MARK: - Quale piattaforma conta davvero

    func testPrimeNonRubaLaCasaAUnaSerieApple() {
        // Ted Lasso, dal device il 2026-08-15: TMDB per l'Italia risponde
        // Prime, Apple TV, Apple TV Amazon Channel, Prime with Ads — e l'app
        // diceva "Prime Video" su una serie Apple.
        let nomi = ["Amazon Prime Video", "Apple TV", "Apple TV Amazon Channel", "Amazon Prime Video with Ads"]

        XCTAssertEqual(StreamingProviderRanking.primary(nomi), "Apple TV")
        // Prime resta in elenco, ma in fondo: e' un posto dove si puo' guardare.
        XCTAssertEqual(StreamingProviderRanking.ranked(nomi), ["Apple TV", "Amazon Prime Video"])
    }

    func testQuandoPrimeECasaSuaResta() {
        // Nessun altro servizio: allora e' davvero Prime.
        XCTAssertEqual(
            StreamingProviderRanking.primary(["Amazon Prime Video", "Amazon Prime Video with Ads"]),
            "Amazon Prime Video"
        )
    }

    func testUnServizioCompratoDentroAmazonApreIlSuoDiApp() {
        // "Apple TV Amazon Channel" e' Apple TV: la scheda del titolo sta li'.
        let destination = StreamingDestinationResolver.destination(
            providerName: "Apple TV Amazon Channel",
            deepLinks: [:],
            titleName: "Ted Lasso",
            tmdbId: 97546,
            isSeries: true
        )

        XCTAssertTrue(destination?.url.absoluteString.hasPrefix("https://tv.apple.com/") ?? false)
    }

    func testIlLinkDirettoSiTrovaAncheColNomeLungo() {
        let apple = URL(string: "https://tv.apple.com/show/umc.cmc.vtoh0mn0xn7t3c643xqonfzy")!
        let destination = StreamingDestinationResolver.destination(
            providerName: "Apple TV Amazon Channel",
            deepLinks: ["Apple TV": apple],
            titleName: "Ted Lasso",
            tmdbId: 97546,
            isSeries: true
        )

        XCTAssertEqual(destination?.url, apple)
        XCTAssertEqual(destination?.source, .direct)
    }

    func testICanaliVendutiDentroPrimeAproneProprioPrime() {
        // I canali di marchi che non sappiamo aprire da soli restano in Prime,
        // che e' dove si guardano davvero.
        let destination = StreamingDestinationResolver.destination(
            providerName: "MGM Plus Amazon Channel",
            deepLinks: [:],
            titleName: "Un titolo",
            tmdbId: 76331,
            isSeries: true
        )

        XCTAssertEqual(destination?.source, .providerSearch)
        XCTAssertTrue(destination?.url.absoluteString.hasPrefix("https://www.primevideo.com/") ?? false)
    }

    func testRaiPlayLoScriveConLoSpazio() {
        // Il nome che arriva da TMDB e' "Rai Play": con la sola chiave
        // "raiplay" quei titoli finivano sul ripiego.
        let destination = StreamingDestinationResolver.destination(
            providerName: "Rai Play",
            deepLinks: [:],
            titleName: "Mare Fuori",
            tmdbId: 118743,
            isSeries: true
        )

        XCTAssertEqual(destination?.source, .providerSearch)
        XCTAssertTrue(destination?.url.absoluteString.hasPrefix("https://www.raiplay.it/") ?? false)
    }

    func testUnaPiattaformaCheNonSappiamoAprireRipiegaSuTmdb() {
        // La pagina "dove guardare" di TMDB e' quella che apre gia' la scheda
        // titolo, e i link dentro sono quelli veri: un giro in piu', ma si
        // arriva sul titolo esatto.
        let destination = StreamingDestinationResolver.destination(
            providerName: "Piattaforma X",
            deepLinks: [:],
            titleName: "Qualcosa",
            tmdbId: 1234,
            isSeries: true
        )

        XCTAssertEqual(destination?.url.absoluteString, "https://www.themoviedb.org/tv/1234/watch?locale=IT")
        XCTAssertEqual(destination?.source, .tmdbWatchPage)

        // Senza nemmeno l'id TMDB non si promette niente: il tasto sparisce.
        XCTAssertNil(StreamingDestinationResolver.destination(
            providerName: "Piattaforma X",
            deepLinks: [:],
            titleName: "Qualcosa",
            tmdbId: nil,
            isSeries: true
        ))
    }

    func testLaLocandinaEsceRidottaAllaMisuraDelWidget() {
        let url = URL(string: "https://image.tmdb.org/t/p/w500/poster.jpg")
        XCTAssertEqual(
            WatchlistWidgetSnapshotBuilder.widgetPosterURL(url)?.absoluteString,
            "https://image.tmdb.org/t/p/w185/poster.jpg"
        )
        // Altro host: passa intatto, non e' compito nostro riscriverlo.
        let storage = URL(string: "https://firebasestorage.googleapis.com/x.jpg")
        XCTAssertEqual(WatchlistWidgetSnapshotBuilder.widgetPosterURL(storage), storage)
        XCTAssertNil(WatchlistWidgetSnapshotBuilder.widgetPosterURL(nil))
    }

    // MARK: - Fixture

    private static func rows(inProgress: Int, upNext: Int) -> [WatchlistWidgetSnapshot.Row] {
        let serie = (0..<inProgress).map { index in
            row(id: "serie-\(index)", kind: .inProgress)
        }
        let coda = (0..<upNext).map { index in
            row(id: "coda-\(index)", kind: .upNext)
        }
        return serie + coda
    }

    private static func row(id: String, kind: WatchlistWidgetSnapshot.Row.Kind) -> WatchlistWidgetSnapshot.Row {
        WatchlistWidgetSnapshot.Row(
            id: id,
            name: id,
            isSeries: kind == .inProgress,
            kind: kind,
            season: nil,
            episode: nil,
            episodesWatched: nil,
            episodesTotal: nil,
            percentComplete: nil,
            episodeMinutes: nil,
            providerName: nil,
            providerLogoUrl: nil,
            watchUrl: nil,
            tmdbId: nil,
            posterUrl: nil,
            path: "/share/title/\(id)"
        )
    }

    private static func state(
        id: String,
        name: String?,
        isSeries: Bool,
        progress: TitleSeriesProgress?
    ) -> TitlePersonalState {
        let title = name.map { TitleParsing.title(from: ["name": $0, "type": isSeries ? "tv" : "movie"], documentID: id) }
        return TitlePersonalState(
            id: id,
            titleId: id,
            mediaType: isSeries ? .tv : .movie,
            generalWatchlist: true,
            rewatchIntent: false,
            movieStatus: isSeries ? nil : .unseen,
            seriesStatus: isSeries ? .inProgress : nil,
            seriesProgress: progress,
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
            title: title
        )
    }

    private static func dashboard(
        inProgressSeries: [TitlePersonalState],
        generalWatchlist: [TitlePersonalState]
    ) -> WatchlistDashboard {
        WatchlistDashboard(
            generalWatchlist: generalWatchlist,
            rewatch: [],
            toRate: [],
            toResume: [],
            inProgressSeries: inProgressSeries,
            myLists: [],
            sharedLists: [],
            publicLists: []
        )
    }
}
