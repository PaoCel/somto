import XCTest
@testable import Somto

/// La migrazione delle chiavi locali gira **una volta sola sui device degli
/// utenti**, e se sbaglia non si accorge nessuno: nessun crash, nessun log,
/// solo un flag che torna al valore di default. Concretamente: tutti i thread
/// improvvisamente non letti, o il tour della scheda titolo che ricompare a chi
/// lo aveva gia' chiuso. Per questo e' coperta caso per caso.
final class SomtoDefaultsMigrationTests: XCTestCase {

    private var suiteName = ""
    private var defaults = UserDefaults.standard

    override func setUp() {
        super.setUp()
        suiteName = "somto.tests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName) ?? .standard
    }

    override func tearDown() {
        UserDefaults.standard.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    // MARK: - Rinomine

    func testRenamesPreserveValuesAndTypes() {
        defaults.set("hm", forKey: "somto_watchtime_unit")
        defaults.set(3, forKey: "titleDetailVNextTourVersion")
        defaults.set(2026080902, forKey: "recommendedUpdateDismissedBuild")
        defaults.set(["thread-1": 1_723_000_000.0], forKey: "twowatch_thread_reads")
        defaults.set(true, forKey: "somto.matchHintSeen")
        defaults.set(true, forKey: "pushPromptSeenV1")
        defaults.set(true, forKey: "wlWelcomeDismissed")
        defaults.set(true, forKey: "wlCreateTipDismissed")

        SomtoDefaultsMigration.run(on: defaults)

        XCTAssertEqual(defaults.string(forKey: SomtoDefaultsKey.watchTimeUnit), "hm")
        XCTAssertEqual(defaults.integer(forKey: SomtoDefaultsKey.titleDetailTourVersion), 3)
        XCTAssertEqual(
            defaults.integer(forKey: SomtoDefaultsKey.recommendedUpdateDismissedBuild),
            2026080902
        )
        XCTAssertEqual(
            defaults.dictionary(forKey: SomtoDefaultsKey.threadReads) as? [String: Double],
            ["thread-1": 1_723_000_000.0]
        )
        XCTAssertTrue(defaults.bool(forKey: SomtoDefaultsKey.matchHintSeen))
        XCTAssertTrue(defaults.bool(forKey: SomtoDefaultsKey.pushPromptSeen))
        XCTAssertTrue(defaults.bool(forKey: SomtoDefaultsKey.watchlistWelcomeDismissed))
        XCTAssertTrue(defaults.bool(forKey: SomtoDefaultsKey.watchlistCreateTipDismissed))
    }

    /// L'invariante che protegge gli utenti gia' sullo Store: la migrazione
    /// **non cancella**. Se la copia avesse un difetto e la legacy fosse
    /// sparita, il dato sul device sarebbe perso per sempre.
    func testLegacyKeysSurviveSoTheMigrationStaysReversible() {
        defaults.set(true, forKey: "wlWelcomeDismissed")
        defaults.set(["dune"], forKey: "search.history.v1.titles")
        defaults.set(true, forKey: "home_import_reveal_seen_import-1")

        SomtoDefaultsMigration.run(on: defaults)

        XCTAssertTrue(defaults.bool(forKey: "wlWelcomeDismissed"))
        XCTAssertEqual(defaults.stringArray(forKey: "search.history.v1.titles"), ["dune"])
        XCTAssertTrue(defaults.bool(forKey: "home_import_reveal_seen_import-1"))
    }

    /// Build mista o rollback: se l'utente ha gia' scritto sulla chiave nuova,
    /// il valore recente non deve essere sovrascritto da quello vecchio.
    func testExistingCanonicalValueWins() {
        defaults.set(1, forKey: "titleDetailVNextTourVersion")
        defaults.set(7, forKey: SomtoDefaultsKey.titleDetailTourVersion)

        SomtoDefaultsMigration.run(on: defaults)

        XCTAssertEqual(defaults.integer(forKey: SomtoDefaultsKey.titleDetailTourVersion), 7)
    }

    /// La seconda esecuzione non deve ricopiare: se l'utente ha nel frattempo
    /// cambiato il valore sulla chiave nuova, la legacy (ferma al vecchio) non
    /// deve tornare a vincere.
    func testMigrationRunsOnlyOnce() {
        defaults.set(1, forKey: "titleDetailVNextTourVersion")
        SomtoDefaultsMigration.run(on: defaults)
        // L'utente vede il tour nuovo: l'app scrive sulla chiave canonica.
        defaults.set(9, forKey: SomtoDefaultsKey.titleDetailTourVersion)

        SomtoDefaultsMigration.run(on: defaults)

        XCTAssertEqual(defaults.integer(forKey: SomtoDefaultsKey.titleDetailTourVersion), 9)
    }

    // MARK: - Chiavi dinamiche

    func testImportRevealKeysCollapseIntoOneCappedList() {
        for index in 0..<30 {
            defaults.set(true, forKey: "home_import_reveal_seen_import-\(index)")
        }
        // Un import mostrato ma non ancora chiuso: valore false, non va nella lista.
        defaults.set(false, forKey: "home_import_reveal_seen_import-open")

        SomtoDefaultsMigration.run(on: defaults)

        let seen = defaults.stringArray(forKey: SomtoDefaultsKey.importRevealSeenIDs) ?? []
        XCTAssertEqual(seen.count, ImportRevealStore.limit)
        XCTAssertFalse(seen.contains("import-open"))
    }

    func testSearchHistoryKeepsItsEntriesUnderTheNewPrefix() {
        defaults.set(["dune", "matrix"], forKey: "search.history.v1.titles")

        SomtoDefaultsMigration.run(on: defaults)

        XCTAssertEqual(
            defaults.stringArray(forKey: SomtoDefaultsKey.searchHistoryPrefix + "titles"),
            ["dune", "matrix"]
        )
    }

    // MARK: - Store con tetto

    @MainActor
    func testImportRevealStoreCapsAndRemembersMostRecent() {
        let store = ImportRevealStore(defaults: defaults)

        for index in 0..<(ImportRevealStore.limit + 5) {
            store.markRevealSeen(importID: "import-\(index)")
        }

        XCTAssertTrue(store.hasSeenReveal(importID: "import-\(ImportRevealStore.limit + 4)"))
        XCTAssertFalse(store.hasSeenReveal(importID: "import-0"))
        XCTAssertEqual(
            defaults.stringArray(forKey: SomtoDefaultsKey.importRevealSeenIDs)?.count,
            ImportRevealStore.limit
        )
    }

    @MainActor
    func testMarkingTheSameImportTwiceDoesNotDuplicate() {
        let store = ImportRevealStore(defaults: defaults)

        store.markRevealSeen(importID: "import-1")
        store.markRevealSeen(importID: "import-1")

        XCTAssertEqual(defaults.stringArray(forKey: SomtoDefaultsKey.importRevealSeenIDs), ["import-1"])
    }
}
