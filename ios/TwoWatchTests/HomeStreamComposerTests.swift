import XCTest
@testable import Somto

/// L'intreccio fra post e corsie personali nella Home (`HomeStreamComposer`).
///
/// PERCHE' — le corsie ("Per te", uscite, novita') entrano nel flusso a
/// posizioni fisse. Se il feed e' corto o vuoto (guest, primo giorno, utente
/// che non segue nessuno) devono comparire lo stesso: in coda, nell'ordine
/// dato. Un errore qui non crasha, semplicemente fa sparire una corsia — che e'
/// il tipo di regressione che nessuno nota per settimane.
final class HomeStreamComposerTests: XCTestCase {
    private func post(_ id: String) -> FeedActivity {
        FeedActivity(
            id: id,
            kind: .post,
            actor: UserSummary(id: "u1", displayName: "Utente", photoURL: nil),
            relatedUser: nil,
            title: nil,
            titleId: nil,
            postId: id,
            recommendationId: nil,
            sourceId: nil,
            sourcePath: nil,
            rating: nil,
            previousRating: nil,
            text: "post \(id)",
            snippet: nil,
            reviewText: nil,
            taggedTitles: [],
            mediaURL: nil,
            mediaURLs: [],
            watchedWith: [],
            watchedWithGroup: nil,
            sharedPost: nil,
            createdAt: nil,
            webURL: nil
        )
    }

    private func ids(_ items: [HomeStreamItem]) -> [String] { items.map(\.id) }

    func testInsertsLandRightAfterTheirPost() {
        let posts = (1...6).map { post("p\($0)") }
        let items = HomeStreamComposer.compose(
            posts: posts,
            inserts: [
                HomeStreamInsert(afterPost: 5, item: .upcoming),
                HomeStreamInsert(afterPost: 2, item: .forYou),
                HomeStreamInsert(afterPost: 3, item: .discussions)
            ]
        )
        XCTAssertEqual(
            ids(items),
            ["post-p1", "post-p2", "for-you", "post-p3", "discussions", "post-p4", "post-p5", "upcoming", "post-p6"]
        )
    }

    func testShortFeedKeepsEveryInsertInOrder() {
        let items = HomeStreamComposer.compose(
            posts: [post("p1")],
            inserts: [
                HomeStreamInsert(afterPost: 2, item: .forYou),
                HomeStreamInsert(afterPost: 9, item: .newForYou),
                HomeStreamInsert(afterPost: 5, item: .upcoming)
            ]
        )
        XCTAssertEqual(ids(items), ["post-p1", "for-you", "upcoming", "new-for-you"])
    }

    func testEmptyFeedShowsOnlyInsertsInOrder() {
        let items = HomeStreamComposer.compose(
            posts: [],
            inserts: [
                HomeStreamInsert(afterPost: 6, item: .people),
                HomeStreamInsert(afterPost: 2, item: .forYou)
            ]
        )
        XCTAssertEqual(ids(items), ["for-you", "people"])
        XCTAssertFalse(items.contains { $0.isPost })
    }

    func testTwoInsertsAtTheSamePositionKeepTheirOrder() {
        let posts = (1...3).map { post("p\($0)") }
        let items = HomeStreamComposer.compose(
            posts: posts,
            inserts: [
                HomeStreamInsert(afterPost: 2, item: .forYou),
                HomeStreamInsert(afterPost: 2, item: .discussions)
            ]
        )
        XCTAssertEqual(ids(items), ["post-p1", "post-p2", "for-you", "discussions", "post-p3"])
    }
}
