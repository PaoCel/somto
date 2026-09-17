import XCTest
@testable import Somto

/// Test sul calcolo dei default di "Con chi l'hai visto?"
/// (`CompanionDefaults`). Pure, senza Firebase: copre le soglie di campioni,
/// la preselezione di "Da solo" e il ranking dei compagni frequenti.
final class CompanionDefaultsTests: XCTestCase {

    private func sample(
        _ mediaType: MediaType,
        companions: [FeedTaggedUser] = [],
        daysAgo: Double = 0,
        now: Date
    ) -> CompanionRatingSample {
        CompanionRatingSample(
            mediaType: mediaType,
            companions: companions,
            occurredAt: now.addingTimeInterval(-daysAgo * 86400)
        )
    }

    // MARK: - Nessun dato

    func testEmptyRatingsYieldEmptyDefaults() {
        let result = CompanionDefaults.compute(recentRatings: [], mediaType: .movie)
        XCTAssertEqual(result, .empty)
    }

    func testBelowMinimumSampleCountYieldsEmptyDefaults() {
        let now = Date()
        let ratings = (0..<(CompanionDefaults.minimumSampleCount - 1)).map { _ in
            sample(.movie, now: now)
        }

        let result = CompanionDefaults.compute(recentRatings: ratings, mediaType: .movie, now: now)
        XCTAssertEqual(result, .empty)
    }

    // MARK: - Preselezione "Da solo"

    func testPreselectsAloneWhenShareAboveThreshold() {
        let now = Date()
        // 8 voti, 7 da solo (87.5% >= 70%).
        var ratings = (0..<7).map { _ in sample(.movie, now: now) }
        ratings.append(sample(.movie, companions: [FeedTaggedUser(id: "u1", displayName: "Ada")], now: now))

        let result = CompanionDefaults.compute(recentRatings: ratings, mediaType: .movie, now: now)
        XCTAssertTrue(result.preselectAlone)
    }

    func testDoesNotPreselectAloneWhenShareBelowThreshold() {
        let now = Date()
        // 5 voti, 3 da solo (60% < 70%).
        var ratings = (0..<3).map { _ in sample(.movie, now: now) }
        ratings.append(contentsOf: (0..<2).map { _ in
            sample(.movie, companions: [FeedTaggedUser(id: "u1", displayName: "Ada")], now: now)
        })

        let result = CompanionDefaults.compute(recentRatings: ratings, mediaType: .movie, now: now)
        XCTAssertFalse(result.preselectAlone)
    }

    // MARK: - Filtro per tipo

    func testUsesOnlyMatchingMediaTypeWhenItHasEnoughSamples() {
        let now = Date()
        // 5 film sempre da solo, 5 serie sempre in compagnia: chiedendo il
        // default per un film deve vedere solo i 5 campioni film.
        var ratings = (0..<5).map { _ in sample(.movie, now: now) }
        ratings.append(contentsOf: (0..<5).map { _ in
            sample(.tv, companions: [FeedTaggedUser(id: "u1", displayName: "Ada")], now: now)
        })

        let result = CompanionDefaults.compute(recentRatings: ratings, mediaType: .movie, now: now)
        XCTAssertTrue(result.preselectAlone)
        XCTAssertTrue(result.frequentCompanions.isEmpty)
    }

    func testFallsBackToAllSamplesWhenTypeHasTooFew() {
        let now = Date()
        // Solo 2 film (sotto soglia) ma 3 serie: con soglia minima 5 totali
        // raggiunta, il default per un film usa tutti i 5 campioni insieme.
        var ratings = (0..<2).map { _ in
            sample(.movie, companions: [FeedTaggedUser(id: "u1", displayName: "Ada")], now: now)
        }
        ratings.append(contentsOf: (0..<3).map { _ in
            sample(.tv, companions: [FeedTaggedUser(id: "u1", displayName: "Ada")], now: now)
        })

        let result = CompanionDefaults.compute(recentRatings: ratings, mediaType: .movie, now: now)
        XCTAssertFalse(result.frequentCompanions.isEmpty)
    }

    // MARK: - Compagni frequenti

    func testRanksFrequentCompanionsByWeightedCount() {
        let now = Date()
        let ada = FeedTaggedUser(id: "ada", displayName: "Ada")
        let bea = FeedTaggedUser(id: "bea", displayName: "Bea")
        let cin = FeedTaggedUser(id: "cin", displayName: "Cin")

        var ratings: [CompanionRatingSample] = []
        ratings.append(contentsOf: (0..<4).map { _ in sample(.movie, companions: [ada], now: now) })
        ratings.append(contentsOf: (0..<2).map { _ in sample(.movie, companions: [bea], now: now) })
        ratings.append(sample(.movie, companions: [cin], now: now))

        let result = CompanionDefaults.compute(recentRatings: ratings, mediaType: .movie, now: now)
        XCTAssertEqual(result.frequentCompanions.map(\.id), ["ada", "bea", "cin"])
    }

    func testCapsFrequentCompanionsToThree() {
        let now = Date()
        let people = (0..<5).map { FeedTaggedUser(id: "u\($0)", displayName: "U\($0)") }
        // Ogni persona compare un numero decrescente di volte cosi' il
        // ranking e' univoco: u0 il piu' frequente, u4 il meno.
        var ratings: [CompanionRatingSample] = []
        for (index, person) in people.enumerated() {
            let occurrences = 5 - index
            ratings.append(contentsOf: (0..<occurrences).map { _ in
                sample(.movie, companions: [person], now: now)
            })
        }

        let result = CompanionDefaults.compute(recentRatings: ratings, mediaType: .movie, now: now)
        XCTAssertEqual(result.frequentCompanions.count, CompanionDefaults.maxFrequentCompanions)
        XCTAssertEqual(result.frequentCompanions.map(\.id), ["u0", "u1", "u2"])
    }

    func testOlderCompanionsWeighLessThanRecentOnes() {
        let now = Date()
        let recentFriend = FeedTaggedUser(id: "recent", displayName: "Recent")
        let oldFriend = FeedTaggedUser(id: "old", displayName: "Old")

        // Stesso numero di apparizioni (2 ciascuno), ma quelle con
        // `oldFriend` sono molto piu' vecchie: deve vincere `recentFriend`.
        var ratings: [CompanionRatingSample] = []
        ratings.append(contentsOf: (0..<2).map { _ in sample(.movie, companions: [recentFriend], daysAgo: 1, now: now) })
        ratings.append(contentsOf: (0..<2).map { _ in sample(.movie, companions: [oldFriend], daysAgo: 300, now: now) })
        ratings.append(contentsOf: (0..<1).map { _ in sample(.movie, now: now) })

        let result = CompanionDefaults.compute(recentRatings: ratings, mediaType: .movie, now: now)
        XCTAssertEqual(result.frequentCompanions.first?.id, "recent")
    }

    func testDefaultWithNoDataPreselectsNothingAndHasNoChips() {
        let result = CompanionDefaultsResult.empty
        XCTAssertFalse(result.preselectAlone)
        XCTAssertTrue(result.frequentCompanions.isEmpty)
    }
}
