import XCTest
@testable import Somto

/// Test di `TitleParsing.searchScore` e delle utility di supporto
/// (`stripLeadingArticle`, `bestSearchTokens`): scoring puro condiviso da
/// `searchTitles` e `searchTitlesForListBuilder` (TitleRepository), specchio
/// di `public/js/utils/titleSearchRank.js` sul web — stessa scala, stesso
/// ordine di priorità.
final class TitleSearchScoreTests: XCTestCase {

    private func makeTitle(
        id: String = "t1",
        name: String,
        nameLower: String? = nil,
        originalName: String? = nil,
        aliases: [String] = [],
        collectionName: String? = nil,
        keywords: [String] = [],
        searchableText: String = "",
        description: String? = nil,
        ratingCount: Int = 0,
        year: Int? = nil
    ) -> Title {
        Title(
            id: id,
            name: name,
            nameLower: nameLower ?? SearchNormalizer.normalize(name),
            type: .movie,
            year: year,
            description: description,
            posterPath: nil,
            backdropPath: nil,
            genres: [],
            originalName: originalName,
            aliases: aliases,
            directors: [],
            directorIDs: [],
            cast: [],
            castIDs: [],
            keywords: keywords,
            collectionName: collectionName,
            searchableText: searchableText,
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

    // MARK: - stripLeadingArticle / bestSearchTokens

    func testStripLeadingArticleRemovesOnlyOneLeadingArticleAndNeverEmpties() {
        XCTAssertEqual(TitleParsing.stripLeadingArticle("the beekeeper"), "beekeeper")
        XCTAssertEqual(TitleParsing.stripLeadingArticle("il primo natale"), "primo natale")
        XCTAssertEqual(TitleParsing.stripLeadingArticle("la"), "la")
        XCTAssertEqual(TitleParsing.stripLeadingArticle("beekeeper"), "beekeeper")
    }

    func testBestSearchTokensPrefersLongestNonArticleToken() {
        XCTAssertEqual(TitleParsing.bestSearchTokens(from: ["la", "casa", "di", "carta"], max: 1), ["carta"])
        XCTAssertEqual(TitleParsing.bestSearchTokens(from: ["la", "il"], max: 1), ["il"])
    }

    // MARK: - searchScore

    func testBeekeeperFindsTheBeekeeperViaArticleStrippedMatch() {
        let title = makeTitle(name: "The Beekeeper", nameLower: "the beekeeper")
        let normalized = SearchNormalizer.normalize("beekeeper")
        let score = TitleParsing.searchScore(for: title, normalized: normalized)
        XCTAssertEqual(score, 9)
        XCTAssertGreaterThan(score, 0)
    }

    func testExactMatchNataleARioBeatsIlPrimoNataleAndNataleATuttiICosti() {
        let normalized = SearchNormalizer.normalize("natale a rio")

        let nataleARio = makeTitle(id: "rio", name: "Natale a Rio", nameLower: "natale a rio", ratingCount: 0)
        let ilPrimoNatale = makeTitle(id: "primo", name: "Il Primo Natale", nameLower: "il primo natale", ratingCount: 500)
        let nataleATuttiICosti = makeTitle(id: "costi", name: "Natale a Tutti i Costi", nameLower: "natale a tutti i costi", ratingCount: 500)

        let scoreRio = TitleParsing.searchScore(for: nataleARio, normalized: normalized)
        let scorePrimo = TitleParsing.searchScore(for: ilPrimoNatale, normalized: normalized)
        let scoreCosti = TitleParsing.searchScore(for: nataleATuttiICosti, normalized: normalized)

        XCTAssertEqual(scoreRio, 12)
        XCTAssertGreaterThan(scoreRio, scorePrimo)
        XCTAssertGreaterThan(scoreRio, scoreCosti)
    }

    func testAllTokensInNameBeatsSingleTokenInName() {
        let normalized = SearchNormalizer.normalize("casa carta")
        let bothTokens = makeTitle(name: "La Casa di Carta", nameLower: "la casa di carta")
        let oneToken = makeTitle(name: "Una Casa in Collina", nameLower: "una casa in collina")

        XCTAssertEqual(TitleParsing.searchScore(for: bothTokens, normalized: normalized), 8)
        XCTAssertEqual(TitleParsing.searchScore(for: oneToken, normalized: normalized), 6)
    }

    func testAliasMatchScoresEightLikeAllTokensInName() {
        let title = makeTitle(name: "Money Heist", nameLower: "money heist", aliases: ["La Casa di Carta"])
        let normalized = SearchNormalizer.normalize("casa di carta")
        XCTAssertEqual(TitleParsing.searchScore(for: title, normalized: normalized), 8)
    }

    func testDescriptionOnlyMatchScoresLowestNonZero() {
        let title = makeTitle(
            name: "Un Film Qualunque",
            nameLower: "un film qualunque",
            searchableText: "trama su una astronave perduta nello spazio"
        )
        let normalized = SearchNormalizer.normalize("astronave perduta")
        XCTAssertEqual(TitleParsing.searchScore(for: title, normalized: normalized), 3)
    }

    func testNoMatchScoresZero() {
        let title = makeTitle(name: "Tutt'altra Cosa", nameLower: "tuttaltra cosa")
        let normalized = SearchNormalizer.normalize("astronave perduta")
        XCTAssertEqual(TitleParsing.searchScore(for: title, normalized: normalized), 0)
    }
}
