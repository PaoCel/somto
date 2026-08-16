@preconcurrency import FirebaseFirestore
import Foundation

@MainActor
final class HomeRepository {
    struct FeedPage {
        let items: [FeedActivity]
        let nextCursor: DocumentSnapshot?
        let hasMore: Bool
    }

    /// Dati del launchpad Home personale.
    /// - `hero`: titoli della watchlist generale non ancora visti (deck "Cosa
    ///   vuoi guardare oggi?").
    /// - `continueWatching`: serie in corso (per riprendere da dove eri).
    /// - `newForYou`: titoli finiti con nuovi contenuti disponibili
    ///   (`dashboard.toResume`, `hasNewContent`).
    struct Launchpad {
        let hero: [TitlePersonalState]
        let continueWatching: [TitlePersonalState]
        let newForYou: [TitlePersonalState]
    }

    struct ProviderLane {
        let providerName: String
        let evidenceTitleCount: Int
        let titles: [Title]
    }

    struct UpcomingRelease: Decodable, Identifiable, Hashable {
        struct Provider: Decodable, Hashable {
            let name: String
            let logoUrl: URL?
        }

        let id: String
        let postId: String?
        let titleId: String
        let name: String
        let type: String
        let releaseDate: Date
        let releaseKind: String?
        let occasion: String
        let season: Int?
        let provider: Provider?
        let posterUrl: URL?

        var resolvedPostID: String? {
            guard let postId, !postId.isEmpty else { return nil }
            return postId
        }
    }

    private struct UpcomingReleaseFeed: Decodable {
        let items: [UpcomingRelease]
    }

    private let db = Firestore.firestore()
    private let titleRepository: TitleRepository
    private let userRepository: UserRepository
    private let watchlistRepository: WatchlistRepository

    init(
        titleRepository: TitleRepository,
        userRepository: UserRepository,
        watchlistRepository: WatchlistRepository
    ) {
        self.titleRepository = titleRepository
        self.userRepository = userRepository
        self.watchlistRepository = watchlistRepository
    }

    func fetchTrendingTitles() async throws -> [Title] {
        try await titleRepository.listPopularTitles(limit: 10)
    }

    func fetchFreshTitles() async throws -> [Title] {
        try await titleRepository.listRecentApprovedTitles(limit: 10)
    }

    /// Feed pubblico gia' usato dal widget: stessa selezione affidabile
    /// (uscite italiane + premiere guardabili), ora con il `postId` della
    /// conversazione condivisa con Community.
    func fetchUpcomingReleases() async throws -> [UpcomingRelease] {
        guard let url = URL(string: "https://somto.it/prossime-uscite.json") else { return [] }
        let (data, response) = try await URLSession.shared.data(from: url)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(UpcomingReleaseFeed.self, from: data).items
    }

    /// Costruisce il launchpad personale riusando la dashboard della watchlist
    /// (una sola read dei titleStates lato repo). `hero` = watchlist generale;
    /// `continueWatching` = serie in corso; `newForYou` = titoli con nuovi
    /// contenuti (`toResume`).
    func fetchLaunchpad(userID: String) async throws -> Launchpad {
        let dashboard = try await watchlistRepository.fetchWatchlistDashboard(userID: userID)

        // `inProgressSeries` è già l'insieme "serie in corso" su TUTTI i
        // titleStates (include il rewatch-in-corso, che il server tiene fuori
        // da `generalWatchlist`): niente filtro extra qui.
        let continueWatching = dashboard.inProgressSeries

        return Launchpad(
            hero: dashboard.generalWatchlist,
            continueWatching: continueWatching,
            newForYou: dashboard.toResume
        )
    }

    /// Corsia piattaforma inferita dai titoli-seed dal backend. Il server
    /// applica la soglia minima di due titoli e tutte le esclusioni personali;
    /// qui idratiamo i soli id restituiti mantenendo l'ordine del ranking.
    func fetchProviderLane() async -> ProviderLane? {
        do {
            let result = try await CloudFunctionsCaller.call(
                name: "getMatchQueue",
                data: ["max": 18, "fastStart": true]
            )
            guard let payload = result.data as? [String: Any] else { return nil }
            let lane = FirestoreValueReader.map(payload["providerLane"])
            let provider = FirestoreValueReader.map(lane["provider"])
            guard provider["inferred"] as? Bool == true,
                  let providerName = FirestoreValueReader.string(provider["name"]),
                  !providerName.isEmpty
            else { return nil }

            let rows = lane["items"] as? [[String: Any]] ?? []
            let ids = rows.compactMap {
                FirestoreValueReader.string($0["id"]) ?? FirestoreValueReader.string($0["titleId"])
            }
            guard !ids.isEmpty else { return nil }
            let titles = try await titleRepository.listTitles(ids: ids)
            let byID = Dictionary(uniqueKeysWithValues: titles.map { ($0.id, $0) })
            let ordered = ids.compactMap { byID[$0] }
            guard !ordered.isEmpty else { return nil }
            return ProviderLane(
                providerName: providerName,
                evidenceTitleCount: max(2, FirestoreValueReader.int(provider["evidenceTitleCount"]) ?? 2),
                titles: ordered
            )
        } catch {
            // Superficie opzionale: Home continua a caricarsi anche se Match è
            // temporaneamente indisponibile o soggetto a rate limit.
            return nil
        }
    }

    func fetchFeed(userID: String, limit: Int = 18, after cursor: DocumentSnapshot? = nil) async throws -> FeedPage {
        var query: Query = db.collection("feedEvents")
            .whereField("ownerUid", isEqualTo: userID)
            .order(by: "createdAt", descending: true)
            .limit(to: limit)

        if let cursor {
            query = query.start(afterDocument: cursor)
        }

        let snapshot = try await query.getDocuments()
        let documents = snapshot.documents
        let userIDs = collectUserIDs(from: documents)
        let titleIDs = collectTitleIDs(from: documents)

        async let usersTask = userRepository.listUsers(ids: userIDs)
        async let titlesTask = titleRepository.listTitles(ids: titleIDs)
        let (users, titles) = try await (usersTask, titlesTask)

        let userMap = Dictionary(uniqueKeysWithValues: users.map { ($0.id, $0) })
        let titleMap = Dictionary(uniqueKeysWithValues: titles.map { ($0.id, $0) })
        let items = documents.compactMap { mapFeedActivity(document: $0, users: userMap, titles: titleMap) }

        return FeedPage(
            items: items,
            nextCursor: documents.last,
            hasMore: documents.count >= limit && documents.last != nil
        )
    }

    private func collectUserIDs(from documents: [QueryDocumentSnapshot]) -> [String] {
        var ids: Set<String> = []
        for document in documents {
            let data = document.data()
            if let actorUid = FirestoreValueReader.string(data, key: "actorUid") {
                ids.insert(actorUid)
            }
            if let targetUid = FirestoreValueReader.string(data, key: "targetUid") {
                ids.insert(targetUid)
            }

            let sharedPost = FirestoreValueReader.map(data["sharedPost"])
            if let authorUid = FirestoreValueReader.string(sharedPost, key: "authorUid") {
                ids.insert(authorUid)
            }
        }
        return Array(ids)
    }

    private func collectTitleIDs(from documents: [QueryDocumentSnapshot]) -> [String] {
        var ids: Set<String> = []
        for document in documents {
            let data = document.data()
            if let titleId = FirestoreValueReader.string(data, key: "titleId") {
                ids.insert(titleId)
            }

            for taggedTitleID in taggedTitleIDs(from: data) {
                ids.insert(taggedTitleID)
            }

            let sharedPost = FirestoreValueReader.map(data["sharedPost"])
            if let sharedTitleId = FirestoreValueReader.string(sharedPost, key: "titleId") {
                ids.insert(sharedTitleId)
            }
        }
        return Array(ids)
    }

    private func mapFeedActivity(
        document: QueryDocumentSnapshot,
        users: [String: AppUser],
        titles: [String: Title]
    ) -> FeedActivity? {
        let data = document.data()
        guard
            let rawKind = FirestoreValueReader.string(data, key: "eventType"),
            let kind = FeedActivityKind(rawValue: rawKind),
            kind != .recommendation,
            let actorUid = FirestoreValueReader.string(data, key: "actorUid")
        else {
            return nil
        }

        let actor = userSummary(
            uid: actorUid,
            fallbackName: nil,
            user: users[actorUid]
        )

        let titleId = FirestoreValueReader.string(data, key: "titleId")
        let relatedUid = FirestoreValueReader.string(data, key: "targetUid")
        let relatedUser = relatedUid.map {
            userSummary(uid: $0, fallbackName: nil, user: users[$0])
        }
        let sharedPostPayload = FirestoreValueReader.map(data["sharedPost"])
        let sharedAuthorUid = FirestoreValueReader.string(sharedPostPayload, key: "authorUid")
        let sharedAuthor = sharedAuthorUid.map {
            userSummary(
                uid: $0,
                fallbackName: FirestoreValueReader.string(sharedPostPayload, key: "authorName"),
                user: users[$0]
            )
        }

        let sharedPost = sharedAuthor.map { author in
            FeedSharedPost(
                postId: FirestoreValueReader.string(sharedPostPayload, key: "postId") ?? "shared-post",
                author: author,
                text: FirestoreValueReader.string(sharedPostPayload, key: "text") ?? "",
                titleId: FirestoreValueReader.string(sharedPostPayload, key: "titleId")
            )
        }

        let watchedWith = (data["watchedWith"] as? [Any] ?? []).compactMap { row -> FeedTaggedUser? in
            let entry = FirestoreValueReader.map(row)
            guard let uid = FirestoreValueReader.string(entry, key: "uid") else { return nil }
            let name = FirestoreValueReader.string(entry, key: "displayName") ?? users[uid]?.displayName ?? "Amico"
            return FeedTaggedUser(id: uid, displayName: name)
        }
        let watchedWithGroup = feedGroup(from: data)
        let mediaURLs = feedMediaURLs(from: data)

        let resolvedTaggedTitles = resolveTaggedTitles(from: data, titles: titles)

        return FeedActivity(
            id: document.documentID,
            kind: kind,
            actor: actor,
            relatedUser: relatedUser,
            title: titleId.flatMap { titles[$0] } ?? sharedPost?.titleId.flatMap { titles[$0] },
            titleId: titleId ?? sharedPost?.titleId,
            postId: FirestoreValueReader.string(data, key: "postId"),
            recommendationId: FirestoreValueReader.string(data, key: "recommendationId"),
            sourceId: FirestoreValueReader.string(data, key: "sourceId"),
            sourcePath: FirestoreValueReader.string(data, key: "sourcePath"),
            rating: FirestoreValueReader.double(data, key: "rating"),
            previousRating: FirestoreValueReader.double(data, key: "previousRating"),
            level: FirestoreValueReader.string(data, key: "level") ?? "title",
            season: FirestoreValueReader.int(data, key: "season"),
            episode: FirestoreValueReader.int(data, key: "episode"),
            text: FirestoreValueReader.string(data, key: "text"),
            snippet: FirestoreValueReader.string(data, key: "snippet"),
            reviewText: FirestoreValueReader.string(data, key: "reviewText"),
            taggedTitles: resolvedTaggedTitles,
            mediaURL: mediaURLs.first,
            mediaURLs: mediaURLs,
            watchedWith: watchedWith,
            watchedWithGroup: watchedWithGroup,
            sharedPost: sharedPost,
            createdAt: FirestoreValueReader.date(data["createdAt"]),
            webURL: webURL(
                for: kind,
                postId: FirestoreValueReader.string(data, key: "postId"),
                titleId: titleId,
                relatedUid: relatedUid
            )
        )
    }

    private func taggedTitleIDs(from data: [String: Any]) -> [String] {
        TaggedTextFormatter.taggedTitleIDs(in: [
            FirestoreValueReader.string(data, key: "reviewText"),
            FirestoreValueReader.string(data, key: "text"),
            FirestoreValueReader.string(data, key: "snippet")
        ])
    }

    private func resolveTaggedTitles(from data: [String: Any], titles: [String: Title]) -> [Title] {
        let taggedIDs = taggedTitleIDs(from: data)
        if !taggedIDs.isEmpty {
            return taggedIDs.compactMap { titles[$0] }
        }

        if let titleID = FirestoreValueReader.string(data, key: "titleId"),
           let title = titles[titleID] {
            return [title]
        }

        return []
    }

    private func feedMediaURLs(from data: [String: Any]) -> [URL] {
        let rawMediaURLs = FirestoreValueReader.stringArray(data["mediaUrls"])
        if !rawMediaURLs.isEmpty {
            return rawMediaURLs.compactMap(URL.init(string:))
        }

        return FirestoreValueReader.string(data, key: "mediaUrl")
            .flatMap(URL.init(string:))
            .map { [$0] } ?? []
    }

    private func feedGroup(from data: [String: Any]) -> FeedTaggedGroup? {
        let rawGroup = FirestoreValueReader.map(data["watchedWithGroup"])
        guard let threadID = FirestoreValueReader.string(rawGroup, key: "threadId") else { return nil }
        return FeedTaggedGroup(
            id: threadID,
            groupName: FirestoreValueReader.string(rawGroup, key: "groupName") ?? "Gruppo"
        )
    }

    private func userSummary(uid: String, fallbackName: String?, user: AppUser?) -> UserSummary {
        UserSummary(
            id: uid,
            displayName: user?.displayName ?? fallbackName ?? "User",
            photoURL: user?.photoURL ?? user?.avatarURL
        )
    }

    private func webURL(for kind: FeedActivityKind, postId: String?, titleId: String?, relatedUid: String?) -> URL? {
        switch kind {
        case .rating, .watchTogether, .recommendation, .seriesStarted, .titleComment:
            guard let titleId else { return nil }
            return makeURL(path: "/title.html?id=\(titleId)")
        case .post, .postShare, .postComment:
            guard let postId else { return nil }
            return makeURL(path: "/?post=\(postId)")
        case .follow:
            guard let relatedUid else { return nil }
            return makeURL(path: "/user.html?uid=\(relatedUid)")
        }
    }

    private func makeURL(path: String) -> URL? {
        guard var components = URLComponents(string: "https://somto.it"),
              let relative = URLComponents(string: path)
        else {
            return nil
        }

        components.path = relative.path
        components.query = relative.query
        components.fragment = relative.fragment
        return components.url
    }
}
