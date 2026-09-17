import XCTest
@testable import Somto

/// Mirror di `test/web/related-ranking.test.js`: stessi casi, stesso ordine
/// atteso. `RelatedTitlesRanking` deve produrre lo stesso risultato di
/// `public/js/utils/relatedRanking.js` a parità di input — iOS e web
/// condividono la stessa nozione di "correlati".
final class RelatedTitlesRankingTests: XCTestCase {

    private func makeTitle(
        id: String,
        genres: [String] = [],
        castIDs: [String] = [],
        ratingCount: Int = 0
    ) -> Title {
        Title(
            id: id,
            name: id,
            nameLower: id,
            type: .movie,
            year: nil,
            description: nil,
            posterPath: nil,
            backdropPath: nil,
            genres: genres,
            originalName: nil,
            aliases: [],
            directors: [],
            directorIDs: [],
            cast: [],
            castIDs: castIDs,
            keywords: [],
            collectionName: nil,
            searchableText: "",
            ratingAvg: 0,
            ratingCount: ratingCount,
            ratingAggregate: nil,
            emotionAggregate: nil,
            reviewCount: 0,
            createdBy: nil,
            status: "approved",
            metadata: TitleMetadata(
                tmdbId: nil,
                mediaType: .movie,
                language: nil,
                country: nil,
                network: nil,
                durationMovie: nil,
                durationEpisode: nil,
                seasonsCount: nil,
                episodesPerSeason: nil,
                collectionId: nil,
                collectionName: nil,
                collectionPosterPath: nil,
                collectionBackdropPath: nil
            ),
            searchDedupeKey: nil,
            updatedAt: nil,
            tmdbNextRefreshAt: nil
        )
    }

    func testCuratedTitlesAlwaysComeFirstInGivenOrder() {
        let candidates = [
            makeTitle(id: "collab-high", ratingCount: 1000),
            makeTitle(id: "curated-b"),
            makeTitle(id: "curated-a"),
        ]
        let ranked = RelatedTitlesRanking.rank(
            curatedIDs: ["curated-a", "curated-b"],
            candidates: candidates,
            similarityByID: ["collab-high": 0.9]
        )
        XCTAssertEqual(ranked.map(\.id), ["curated-a", "curated-b", "collab-high"])
    }

    func testNonCuratedTitlesOrderedByCollaborativeScoreFirst() {
        let candidates = [makeTitle(id: "low"), makeTitle(id: "high")]
        let ranked = RelatedTitlesRanking.rank(
            curatedIDs: [],
            candidates: candidates,
            similarityByID: ["low": 0.1, "high": 0.8]
        )
        XCTAssertEqual(ranked.map(\.id), ["high", "low"])
    }

    func testExcludedIDsNeverAppear() {
        let candidates = [makeTitle(id: "keep"), makeTitle(id: "page-title"), makeTitle(id: "saga-2")]
        let ranked = RelatedTitlesRanking.rank(
            curatedIDs: [],
            candidates: candidates,
            excludeIDs: ["page-title", "saga-2"]
        )
        XCTAssertEqual(ranked.map(\.id), ["keep"])
    }

    func testDuplicateCandidatesAreDedupedFirstOccurrenceWins() {
        let a = makeTitle(id: "dup", ratingCount: 1)
        let b = makeTitle(id: "dup", ratingCount: 999)
        let ranked = RelatedTitlesRanking.rank(curatedIDs: [], candidates: [a, b])
        XCTAssertEqual(ranked.count, 1)
        XCTAssertEqual(ranked.first?.ratingCount, 1)
    }

    func testPopularityBreaksTiesAmongEquallySimilarTitles() {
        let candidates = [
            makeTitle(id: "obscure", ratingCount: 2),
            makeTitle(id: "popular", ratingCount: 500),
        ]
        let ranked = RelatedTitlesRanking.rank(curatedIDs: [], candidates: candidates)
        XCTAssertEqual(ranked.map(\.id), ["popular", "obscure"])
    }

    func testTasteAffinityIsZeroWithoutATasteProfile() {
        let title = makeTitle(id: "x", genres: ["drama"])
        XCTAssertEqual(RelatedTitlesRanking.tasteAffinity(for: title, featureSums: nil), 0)
    }

    func testTasteAffinityRewardsLovedGenresAndPenalizesDislikedOnes() {
        let featureSums = TasteFeatureSums(
            genres: [
                "drama": TasteFeatureEntry(sum: 8, weight: 5),
                "horror": TasteFeatureEntry(sum: -6, weight: 5),
            ]
        )
        let loved = RelatedTitlesRanking.tasteAffinity(for: makeTitle(id: "a", genres: ["drama"]), featureSums: featureSums)
        let hated = RelatedTitlesRanking.tasteAffinity(for: makeTitle(id: "b", genres: ["horror"]), featureSums: featureSums)
        let neutral = RelatedTitlesRanking.tasteAffinity(for: makeTitle(id: "c", genres: ["sci-fi"]), featureSums: featureSums)

        XCTAssertGreaterThan(loved, 0)
        XCTAssertLessThan(hated, 0)
        XCTAssertEqual(neutral, 0)
        XCTAssertGreaterThan(loved, hated)
    }

    func testTasteAffinityNudgesRankingAboveRawCollaborativeScore() {
        let candidates = [
            makeTitle(id: "no-taste-match", genres: ["horror"]),
            makeTitle(id: "taste-match", genres: ["drama"]),
        ]
        let similarityByID = ["no-taste-match": 0.5, "taste-match": 0.5]
        let featureSums = TasteFeatureSums(genres: ["drama": TasteFeatureEntry(sum: 10, weight: 5)])

        let ranked = RelatedTitlesRanking.rank(
            curatedIDs: [],
            candidates: candidates,
            similarityByID: similarityByID,
            featureSums: featureSums
        )
        XCTAssertEqual(ranked.map(\.id), ["taste-match", "no-taste-match"])
    }
}
