import XCTest
@testable import Somto

final class EpisodeSeenCoordinatorTests: XCTestCase {
    func testEveryAtomicAdvancePresentsTheEpisodeSheet() {
        let entryPoints = [
            "title_detail_quick_add",
            "title_detail_episode_grid",
            "title_watch_actions",
            "watchlist_episode_toggle",
            "public_list_episode_toggle",
            "custom_list_quick_menu"
        ]

        for entryPoint in entryPoints {
            let decision = EpisodeSeenDecision.evaluate(
                previousEpisodeCount: 6,
                updatedEpisodeCount: 7,
                season: 1,
                episode: 7,
                completesSeries: false,
                hasTitleRating: false
            )
            XCTAssertTrue(decision.shouldPresent, entryPoint)
            XCTAssertFalse(decision.shouldOfferTitleComposer, entryPoint)
        }
    }

    func testBulkNoOpStepBackAndInvalidCoordinatesDoNotPresent() {
        let cases: [(before: Int, after: Int?, season: Int?, episode: Int?)] = [
            (2, 8, 1, 8),
            (4, 4, 1, 4),
            (7, 6, 1, 6),
            (6, 7, nil, 7),
            (6, 7, 1, 0)
        ]

        for item in cases {
            let decision = EpisodeSeenDecision.evaluate(
                previousEpisodeCount: item.before,
                updatedEpisodeCount: item.after,
                season: item.season,
                episode: item.episode,
                completesSeries: false,
                hasTitleRating: false
            )
            XCTAssertFalse(decision.shouldPresent)
            XCTAssertFalse(decision.shouldOfferTitleComposer)
        }
    }

    func testFinalEpisodeQueuesTitleComposerOnlyWithoutTitleRating() {
        let unrated = EpisodeSeenDecision.evaluate(
            previousEpisodeCount: 9,
            updatedEpisodeCount: 10,
            season: 1,
            episode: 10,
            completesSeries: true,
            hasTitleRating: false
        )
        XCTAssertTrue(unrated.shouldPresent)
        XCTAssertTrue(unrated.shouldOfferTitleComposer)

        let rated = EpisodeSeenDecision.evaluate(
            previousEpisodeCount: 9,
            updatedEpisodeCount: 10,
            season: 1,
            episode: 10,
            completesSeries: true,
            hasTitleRating: true
        )
        XCTAssertTrue(rated.shouldPresent)
        XCTAssertFalse(rated.shouldOfferTitleComposer)
    }
}
