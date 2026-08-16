import CoreSpotlight
import XCTest
@testable import Somto

/// L'indicizzazione dei titoli dell'utente nella ricerca di sistema.
///
/// Cosa si copre — le tre cose che, se si rompono, si vedono da FUORI dall'app:
/// il tetto che non tiene (batteria e indice gonfi), il tap che non risolve
/// nessun titolo (risultato Spotlight che apre l'app e non fa niente), e
/// soprattutto l'indice del vecchio account che sopravvive al cambio utente —
/// che non e' un difetto estetico ma una fuga di dati fra due persone che usano
/// lo stesso telefono.
///
/// Non si copre CoreSpotlight: `CSSearchableIndex.default()` scrive nell'indice
/// della macchina che esegue i test. La scrittura sta dietro
/// `SpotlightIndexWriting` proprio per poterla sostituire qui.
@MainActor
final class SpotlightIndexerTests: XCTestCase {

    // MARK: - Attributi mostrati

    func testSubtitleJoinsTypeYearAndGenres() {
        let snapshot = SpotlightTitleSnapshot(TwoWatchPreview.featuredTitle)

        XCTAssertEqual(snapshot.name, "Dune: Parte Due")
        // "Sci Fi" e non "Sci-Fi": i generi passano da `GenreDisplay`, che
        // normalizza anche quelli gia' scritti a parole.
        XCTAssertEqual(snapshot.subtitle, "Film · 2024 · Sci Fi, Adventure")
    }

    func testSubtitleSkipsMissingYearAndGenres() {
        let snapshot = SpotlightTitleSnapshot(makeTitle(id: "t1", name: "Senza dati", extra: ["type": "tv"]))

        XCTAssertEqual(snapshot.subtitle, "Serie")
    }

    /// Il difetto visto su device: `Title.genres` contiene id TMDB, e Spotlight
    /// mostrava "Film · 2026 · tmdb_27, tmdb_53".
    func testSubtitleTranslatesGenreIDs() {
        let snapshot = SpotlightTitleSnapshot(
            makeTitle(
                id: "t1",
                name: "Titolo",
                extra: ["type": "movie", "year": 2026, "genres": ["tmdb_27", "tmdb_53"]]
            )
        )

        XCTAssertEqual(snapshot.subtitle, "Film · 2026 · Horror, Thriller")
    }

    /// La tabella caricata dalla Watchlist vince sulla tabella di riserva: e' il
    /// motivo per cui la si passa fin qui.
    func testSubtitleUsesTheProvidedGenreLookup() {
        let lookup = GenreDisplay.lookup(from: [Genre(id: "tmdb_10767", name: "Talk show", nameLower: "talk show")])

        let snapshot = SpotlightTitleSnapshot(
            makeTitle(id: "t1", name: "Titolo", extra: ["type": "tv", "genres": ["tmdb_10767"]]),
            genreLookup: lookup
        )

        XCTAssertEqual(snapshot.subtitle, "Serie · Talk Show")
    }

    /// Un id che nessuna tabella sa tradurre sparisce: meglio "Film · 2024" che
    /// una riga che finisce con un separatore a vuoto.
    func testSubtitleDropsUntranslatableGenres() {
        let snapshot = SpotlightTitleSnapshot(
            makeTitle(
                id: "t1",
                name: "Titolo",
                extra: ["type": "movie", "year": 2024, "genres": ["tmdb_99999"]]
            )
        )

        XCTAssertEqual(snapshot.subtitle, "Film · 2024")
    }

    func testSnapshotsCarryTheGenreLookupToEveryRow() {
        let lookup = GenreDisplay.lookup(from: [Genre(id: "tmdb_10767", name: "Talk show", nameLower: "talk show")])
        let dashboard = makeDashboard(
            generalWatchlist: [
                makeState(
                    title: makeTitle(id: "t1", name: "Titolo", extra: ["type": "tv", "genres": ["tmdb_10767"]]),
                    id: "s1"
                )
            ]
        )

        let snapshots = SpotlightTitleSnapshot.snapshots(from: dashboard, genreLookup: lookup)

        XCTAssertEqual(snapshots.first?.subtitle, "Serie · Talk Show")
    }

    /// La descrizione dell'item: generi e trama devono restare separati anche
    /// da collassati su una riga sola, che e' come Spotlight la disegna.
    func testDescriptionSeparatesSubtitleFromOverview() {
        let snapshot = SpotlightTitleSnapshot(TwoWatchPreview.featuredTitle)

        let description = CoreSpotlightIndexWriter.itemDescription(for: snapshot)

        XCTAssertTrue(description.hasPrefix(snapshot.subtitle + " — "), description)
        XCTAssertFalse(description.contains("\n"), "un a capo lo collassa Spotlight: \(description)")
    }

    func testDescriptionIsJustTheSubtitleWithoutOverview() {
        let snapshot = SpotlightTitleSnapshot(
            makeTitle(id: "t1", name: "Titolo", extra: ["type": "movie", "year": 2024])
        )

        XCTAssertEqual(CoreSpotlightIndexWriter.itemDescription(for: snapshot), "Film · 2024")
    }

    /// Un anno non e' un numero da raggruppare: "2.024" sarebbe un difetto
    /// visibile, ed e' esattamente cio' che farebbe un formatter numerico.
    func testSubtitleYearHasNoGroupingSeparator() {
        let snapshot = SpotlightTitleSnapshot(
            makeTitle(id: "t1", name: "Titolo", extra: ["type": "movie", "year": 2024])
        )

        XCTAssertTrue(snapshot.subtitle.contains("2024"), "anno raggruppato: \(snapshot.subtitle)")
    }

    /// Il titolo originale e' il motivo per cui le keyword esistono: chi cerca
    /// "Money Heist" deve trovare "La Casa di Carta".
    func testKeywordsCarryOriginalNameAndAliasesWithoutDuplicates() {
        let title = makeTitle(
            id: "t1",
            name: "La Casa di Carta",
            extra: [
                "type": "tv",
                "originalName": "Money Heist",
                "aliases": ["la casa di carta", "Bella Ciao"],
                "genres": ["Crime", "Crime"]
            ]
        )

        let keywords = SpotlightTitleSnapshot(title).keywords

        XCTAssertTrue(keywords.contains("Money Heist"))
        XCTAssertTrue(keywords.contains("Bella Ciao"))
        XCTAssertEqual(keywords.filter { $0.lowercased() == "la casa di carta" }.count, 1)
        XCTAssertEqual(keywords.filter { $0 == "Crime" }.count, 1)
    }

    func testKeywordsAreCapped() {
        let title = makeTitle(
            id: "t1",
            name: "Titolo",
            extra: [
                "type": "tv",
                "aliases": (1...20).map { "alias-\($0)" },
                "genres": (1...20).map { "genere-\($0)" }
            ]
        )

        XCTAssertEqual(
            SpotlightTitleSnapshot(title).keywords.count,
            SpotlightTitleSnapshot.keywordLimit
        )
    }

    /// Nelle keyword vanno i nomi, non gli id: "tmdb_27" non lo cerca nessuno.
    func testKeywordsUseGenreNamesNotIDs() {
        let title = makeTitle(id: "t1", name: "Titolo", extra: ["type": "movie", "genres": ["tmdb_27"]])

        let keywords = SpotlightTitleSnapshot(title).keywords

        XCTAssertTrue(keywords.contains("Horror"))
        XCTAssertFalse(keywords.contains("tmdb_27"))
    }

    func testOverviewIsTruncatedAndEmptyBecomesNil() {
        let long = String(repeating: "a", count: SpotlightTitleSnapshot.overviewLimit + 50)

        let truncated = SpotlightTitleSnapshot.shortOverview(long)
        XCTAssertEqual(truncated?.count, SpotlightTitleSnapshot.overviewLimit + 1) // +1 = ellissi
        XCTAssertEqual(truncated?.last, "…")

        XCTAssertNil(SpotlightTitleSnapshot.shortOverview("   "))
        XCTAssertNil(SpotlightTitleSnapshot.shortOverview(nil))
        XCTAssertEqual(SpotlightTitleSnapshot.shortOverview(" corta "), "corta")
    }

    // MARK: - Cosa si indicizza

    func testSnapshotsDeduplicateAcrossSections() {
        // `generalSeriesState` sta sia in `generalWatchlist` sia in
        // `inProgressSeries`: la stessa serie non deve produrre due righe.
        let snapshots = SpotlightTitleSnapshot.snapshots(from: TwoWatchPreview.watchlistDashboard)
        let ids = snapshots.map(\.id)

        XCTAssertEqual(Set(ids).count, ids.count, "id duplicati: \(ids)")
        XCTAssertTrue(ids.contains(TwoWatchPreview.secondTitle.id))
        XCTAssertTrue(ids.contains(TwoWatchPreview.featuredTitle.id))
    }

    /// Chi sta guardando qualcosa adesso viene prima: se il tetto taglia, deve
    /// tagliare dalla coda meno urgente.
    func testSnapshotsPutInProgressSeriesFirst() {
        let snapshots = SpotlightTitleSnapshot.snapshots(from: TwoWatchPreview.watchlistDashboard)

        XCTAssertEqual(snapshots.first?.id, TwoWatchPreview.secondTitle.id)
    }

    func testSnapshotsRespectTheLimit() {
        let dashboard = makeDashboard(generalWatchlist: makeStates(count: 500))

        XCTAssertEqual(SpotlightTitleSnapshot.snapshots(from: dashboard).count, SpotlightTitleSnapshot.indexLimit)
        XCTAssertEqual(SpotlightTitleSnapshot.snapshots(from: dashboard, limit: 3).count, 3)
        XCTAssertTrue(SpotlightTitleSnapshot.snapshots(from: dashboard, limit: 0).isEmpty)
    }

    /// Uno stato senza titolo idratato non ha niente da mostrare: una riga con
    /// il solo doc id sarebbe peggio dell'assenza.
    func testSnapshotsSkipStatesWithoutTitle() {
        let dashboard = makeDashboard(generalWatchlist: [makeState(title: nil, id: "orfano")])

        XCTAssertTrue(SpotlightTitleSnapshot.snapshots(from: dashboard).isEmpty)
    }

    // MARK: - Miniature

    /// La miniatura si scarica alla misura che serve a Spotlight: la stessa
    /// poster in `w154` sono ~10 KB invece di ~60, e il budget di richieste e'
    /// stretto proprio perche' non deve pesare.
    func testThumbnailURLAsksTMDBForASmallerImage() {
        let url = URL(string: "https://image.tmdb.org/t/p/w500/abc.jpg")!

        XCTAssertEqual(
            CoreSpotlightIndexWriter.thumbnailURL(for: url).absoluteString,
            "https://image.tmdb.org/t/p/w154/abc.jpg"
        )

        let original = URL(string: "https://image.tmdb.org/t/p/original/abc.jpg")!
        XCTAssertEqual(
            CoreSpotlightIndexWriter.thumbnailURL(for: original).absoluteString,
            "https://image.tmdb.org/t/p/w154/abc.jpg"
        )
    }

    /// Una poster gia' piccola resta com'e': ingrandirla sarebbe una richiesta
    /// in piu' per un'immagine peggiore. E cio' che non e' TMDB non si tocca.
    func testThumbnailURLLeavesSmallAndForeignURLsAlone() {
        for raw in [
            "https://image.tmdb.org/t/p/w92/abc.jpg",
            "https://image.tmdb.org/t/p/w154/abc.jpg",
            "https://example.com/t/p/w500/abc.jpg",
            "https://image.tmdb.org/abc.jpg"
        ] {
            let url = URL(string: raw)!
            XCTAssertEqual(CoreSpotlightIndexWriter.thumbnailURL(for: url).absoluteString, raw)
        }
    }

    // MARK: - Scrittura

    func testIndexWritesOnceForUnchangedData() async {
        let (indexer, writer, _) = makeIndexer()
        let snapshots = SpotlightTitleSnapshot.snapshots(from: TwoWatchPreview.watchlistDashboard)

        await indexer.index(snapshots: snapshots, userID: "u1")
        await indexer.index(snapshots: snapshots, userID: "u1")

        let replaced = await writer.replacedBatches
        XCTAssertEqual(replaced.count, 1)
        XCTAssertEqual(replaced.first?.count, snapshots.count)
    }

    func testIndexRewritesWhenDataChanges() async {
        let (indexer, writer, _) = makeIndexer()
        let snapshots = SpotlightTitleSnapshot.snapshots(from: TwoWatchPreview.watchlistDashboard)

        await indexer.index(snapshots: snapshots, userID: "u1")
        await indexer.index(snapshots: Array(snapshots.dropLast()), userID: "u1")

        let replaced = await writer.replacedBatches
        XCTAssertEqual(replaced.count, 2)
    }

    /// Un utente diverso e' un contenuto diverso, anche a parita' di titoli.
    func testIndexRewritesWhenUserChanges() async {
        let (indexer, writer, _) = makeIndexer()
        let snapshots = SpotlightTitleSnapshot.snapshots(from: TwoWatchPreview.watchlistDashboard)

        await indexer.index(snapshots: snapshots, userID: "u1")
        await indexer.index(snapshots: snapshots, userID: "u2")

        let replaced = await writer.replacedBatches
        XCTAssertEqual(replaced.count, 2)
    }

    func testIndexIgnoresEmptyUserID() async {
        let (indexer, writer, _) = makeIndexer()

        await indexer.index(snapshots: [SpotlightTitleSnapshot(TwoWatchPreview.featuredTitle)], userID: "   ")

        let replaced = await writer.replacedBatches
        XCTAssertTrue(replaced.isEmpty)
    }

    /// Il fallimento e' silenzioso per l'utente, ma non deve lasciare l'indice
    /// marcato come "di u1": il prossimo cambio account deve comunque pulire.
    func testFailedIndexLeavesNoOwner() async {
        let (indexer, writer, defaults) = makeIndexer()
        await writer.setFailing(true)

        await indexer.index(snapshots: [SpotlightTitleSnapshot(TwoWatchPreview.featuredTitle)], userID: "u1")
        XCTAssertNil(defaults.string(forKey: SomtoDefaultsKey.spotlightIndexOwner))

        await writer.setFailing(false)
        await indexer.handleAuthenticatedUserChange(to: "u1")

        let removals = await writer.removeCount
        XCTAssertEqual(removals, 1, "un indice di proprietario ignoto va svuotato, non tenuto")
    }

    // MARK: - Privacy: cambio account e logout

    func testAuthChangeToADifferentUserClearsTheIndex() async {
        let (indexer, writer, _) = makeIndexer()
        await indexer.index(snapshots: [SpotlightTitleSnapshot(TwoWatchPreview.featuredTitle)], userID: "u1")

        await indexer.handleAuthenticatedUserChange(to: "u2")

        let removals = await writer.removeCount
        XCTAssertEqual(removals, 1)
    }

    func testLogoutClearsTheIndex() async {
        let (indexer, writer, _) = makeIndexer()
        await indexer.index(snapshots: [SpotlightTitleSnapshot(TwoWatchPreview.featuredTitle)], userID: "u1")

        await indexer.handleAuthenticatedUserChange(to: nil)

        let removals = await writer.removeCount
        XCTAssertEqual(removals, 1)
    }

    func testAuthChangeToTheSameUserKeepsTheIndex() async {
        let (indexer, writer, _) = makeIndexer()
        await indexer.index(snapshots: [SpotlightTitleSnapshot(TwoWatchPreview.featuredTitle)], userID: "u1")

        await indexer.handleAuthenticatedUserChange(to: "u1")

        let removals = await writer.removeCount
        XCTAssertEqual(removals, 0, "un riavvio con lo stesso account non deve svuotare l'indice")
    }

    /// L'indice di sistema sopravvive alla chiusura dell'app: un processo nuovo
    /// che trova un proprietario diverso deve cancellare prima di scrivere.
    func testAFreshProcessClearsAnIndexLeftByAnotherAccount() async {
        let defaults = makeDefaults()
        let (first, _, _) = makeIndexer(defaults: defaults)
        await first.index(snapshots: [SpotlightTitleSnapshot(TwoWatchPreview.featuredTitle)], userID: "u1")

        // Nuovo processo: stesso disco, stato in memoria azzerato.
        let (second, secondWriter, _) = makeIndexer(defaults: defaults)
        await second.handleAuthenticatedUserChange(to: "u2")

        let removals = await secondWriter.removeCount
        XCTAssertEqual(removals, 1)
    }

    func testAFreshProcessKeepsTheIndexOfTheSameAccount() async {
        let defaults = makeDefaults()
        let (first, _, _) = makeIndexer(defaults: defaults)
        await first.index(snapshots: [SpotlightTitleSnapshot(TwoWatchPreview.featuredTitle)], userID: "u1")

        let (second, secondWriter, _) = makeIndexer(defaults: defaults)
        await second.handleAuthenticatedUserChange(to: "u1")

        let removals = await secondWriter.removeCount
        XCTAssertEqual(removals, 0)
    }

    func testClearForgetsTheOwner() async {
        let defaults = makeDefaults()
        let (indexer, _, _) = makeIndexer(defaults: defaults)
        await indexer.index(snapshots: [SpotlightTitleSnapshot(TwoWatchPreview.featuredTitle)], userID: "u1")

        await indexer.clear()

        XCTAssertNil(defaults.string(forKey: SomtoDefaultsKey.spotlightIndexOwner))
    }

    /// Sul disco non finisce l'uid, ma un digest che risponde solo a "e' lo
    /// stesso di prima?".
    func testOwnerOnDiskIsNotTheUserID() async {
        let defaults = makeDefaults()
        let (indexer, _, _) = makeIndexer(defaults: defaults)

        await indexer.index(snapshots: [SpotlightTitleSnapshot(TwoWatchPreview.featuredTitle)], userID: "uid-reale-123")

        let stored = defaults.string(forKey: SomtoDefaultsKey.spotlightIndexOwner)
        XCTAssertNotNil(stored)
        XCTAssertFalse(stored?.contains("uid-reale-123") ?? true)
        XCTAssertEqual(stored, SpotlightIndexer.ownerFingerprint(for: "uid-reale-123"))
    }

    // MARK: - Tap su un risultato

    func testTitleIDIsReadFromASpotlightActivity() {
        let activity = NSUserActivity(activityType: CSSearchableItemActionType)
        activity.userInfo = [CSSearchableItemActivityIdentifier: "title-dune-2"]

        XCTAssertEqual(SpotlightIndexer.titleID(from: activity), "title-dune-2")
    }

    /// Un link universale arriva con un altro activity type: non deve essere
    /// scambiato per un tap Spotlight.
    func testTitleIDIgnoresOtherActivityTypes() {
        let activity = NSUserActivity(activityType: NSUserActivityTypeBrowsingWeb)
        activity.userInfo = [CSSearchableItemActivityIdentifier: "title-dune-2"]

        XCTAssertNil(SpotlightIndexer.titleID(from: activity))
    }

    func testTitleIDIgnoresMissingOrEmptyIdentifier() {
        let empty = NSUserActivity(activityType: CSSearchableItemActionType)
        empty.userInfo = [CSSearchableItemActivityIdentifier: "  "]
        XCTAssertNil(SpotlightIndexer.titleID(from: empty))

        let missing = NSUserActivity(activityType: CSSearchableItemActionType)
        XCTAssertNil(SpotlightIndexer.titleID(from: missing))
    }

    // MARK: - Helper

    private func makeDefaults() -> UserDefaults {
        // Suite usa-e-getta: i test non devono toccare i default dell'app.
        UserDefaults(suiteName: "somto.tests.spotlight.\(UUID().uuidString)") ?? .standard
    }

    private func makeIndexer(
        defaults: UserDefaults? = nil
    ) -> (SpotlightIndexer, FakeSpotlightIndexWriter, UserDefaults) {
        let store = defaults ?? makeDefaults()
        let writer = FakeSpotlightIndexWriter()
        return (SpotlightIndexer(writer: writer, defaults: store), writer, store)
    }

    private func makeTitle(id: String, name: String, extra: [String: Any]) -> Title {
        var data: [String: Any] = ["name": name]
        data.merge(extra) { _, new in new }
        return TitleParsing.title(from: data, documentID: id)
    }

    private func makeStates(count: Int) -> [TitlePersonalState] {
        (1...count).map { index in
            makeState(
                title: makeTitle(id: "title-\(index)", name: "Titolo \(index)", extra: ["type": "movie"]),
                id: "state-\(index)"
            )
        }
    }

    private func makeState(title: Title?, id: String) -> TitlePersonalState {
        TitlePersonalState(
            id: id,
            titleId: title?.id ?? id,
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
            title: title
        )
    }

    private func makeDashboard(generalWatchlist: [TitlePersonalState]) -> WatchlistDashboard {
        WatchlistDashboard(
            generalWatchlist: generalWatchlist,
            rewatch: [],
            toRate: [],
            toResume: [],
            inProgressSeries: [],
            myLists: [],
            sharedLists: [],
            publicLists: []
        )
    }
}

/// Doppio della scrittura CoreSpotlight. `actor` perche' `SpotlightIndexWriting`
/// e' `Sendable` e i suoi metodi sono `async`: l'isolamento arriva gratis, senza
/// lock scritti a mano.
private actor FakeSpotlightIndexWriter: SpotlightIndexWriting {
    private(set) var replacedBatches: [[SpotlightTitleSnapshot]] = []
    private(set) var removeCount = 0
    private var isFailing = false

    func setFailing(_ value: Bool) {
        isFailing = value
    }

    func replaceAll(with snapshots: [SpotlightTitleSnapshot], domainIdentifier: String) async throws {
        if isFailing { throw CocoaError(.fileWriteUnknown) }
        replacedBatches.append(snapshots)
    }

    func removeAll(domainIdentifier: String) async throws {
        if isFailing { throw CocoaError(.fileWriteUnknown) }
        removeCount += 1
    }
}
