@preconcurrency import FirebaseFirestore
import FirebaseAuth
import Foundation

@MainActor
final class PostsRepository {
    private let db = Firestore.firestore()
    private let titleRepository: TitleRepository
    private let userRepository: UserRepository

    init(titleRepository: TitleRepository, userRepository: UserRepository) {
        self.titleRepository = titleRepository
        self.userRepository = userRepository
    }

    func createPost(
        authorUID: String,
        authorName: String,
        text: String,
        titleID: String? = nil,
        visibility: PostVisibility = .public,
        containsSpoiler: Bool = false,
        spoilerTitleIDs: [String] = []
    ) async throws -> AppPost {
        let trimmedUID = authorUID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedUID.isEmpty else {
            throw PostWriteError.missingAuthor
        }

        let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedText.isEmpty else {
            throw PostWriteError.emptyBody
        }
        guard trimmedText.count <= 1000 else {
            throw PostWriteError.bodyTooLong(limit: 1000)
        }

        let safeName = authorName.trimmingCharacters(in: .whitespacesAndNewlines)
        let displayName = safeName.isEmpty ? "User" : String(safeName.prefix(80))
        let cleanedSpoilerIDs = spoilerTitleIDs
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        let normalizedSpoilerIDs = Array(cleanedSpoilerIDs.prefix(5))

        var payload: [String: Any] = [
            "authorUid": trimmedUID,
            "authorName": displayName,
            "text": trimmedText,
            "kind": PostKind.post.rawValue,
            "visibility": visibility.rawValue,
            "createdAt": FieldValue.serverTimestamp(),
            "updatedAt": FieldValue.serverTimestamp()
        ]
        if let titleID, !titleID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            payload["titleId"] = titleID
        }
        if containsSpoiler {
            payload["containsSpoiler"] = true
            payload["spoilerTitleIds"] = normalizedSpoilerIDs
        }

        let reference = try await db.collection("posts").addDocument(data: payload)
        let author = userSummary(uid: trimmedUID, fallbackName: displayName, user: nil)

        return AppPost(
            id: reference.documentID,
            kind: .post,
            author: author,
            titleId: titleID,
            title: nil,
            text: trimmedText,
            sharedPost: nil,
            visibility: visibility,
            rating: nil,
            reviewText: nil,
            taggedTitles: [],
            mediaURL: nil,
            mediaURLs: [],
            watchedWith: [],
            watchedWithGroup: nil,
            createdAt: nil,
            updatedAt: nil,
            containsSpoiler: containsSpoiler,
            spoilerTitleIds: normalizedSpoilerIDs
        )
    }

    func fetchPost(postID: String) async throws -> AppPost? {
        if isRatingThread(postID),
           let ratingThread = try await fetchRatingThread(postID: postID) {
            return ratingThread
        }

        do {
            if let storedPost = try await fetchStoredPost(postID: postID) {
                return storedPost
            }
        } catch {
            guard isPermissionDenied(error) else { throw error }
        }

        return try await fetchFeedBackedPost(postID: postID)
    }

    func fetchSocialCounts(postID: String) async throws -> PostSocialCounts {
        let socialRef = socialThreadRef(postID: postID)
        let isRating = isRatingThread(postID)
        async let likesTask = aggregateCount(socialRef.collection("likes"))
        async let commentsTask = aggregateCount(socialRef.collection("comments"))
        let likes = try await likesTask
        let comments = try await commentsTask
        let shares: Int
        if isRating {
            shares = 0
        } else {
            shares = try await aggregateCount(socialRef.collection("shares"))
        }
        return PostSocialCounts(likes: likes, comments: comments, shares: shares)
    }

    /// Le corsie editoriali mostrano solo la conversazione: una singola
    /// aggregazione evita di contare inutilmente anche like e condivisioni.
    func fetchCommentCount(postID: String) async throws -> Int {
        try await aggregateCount(socialThreadRef(postID: postID).collection("comments"))
    }

    /// Conta i documenti senza scaricarli. Sostituisce il vecchio
    /// `countDocuments` (che faceva `getDocuments()` e contava in memoria) —
    /// la versione legacy resta solo per back-compat ma è marcata deprecated.
    private func aggregateCount(_ collection: CollectionReference) async throws -> Int {
        let snapshot = try await collection.count.getAggregation(source: .server)
        return snapshot.count.intValue
    }

    func isLikedByMe(postID: String, uid: String) async throws -> Bool {
        guard !postID.isEmpty, !uid.isEmpty else { return false }
        let snapshot = try await socialThreadRef(postID: postID)
            .collection("likes")
            .document(uid)
            .getDocument()
        return snapshot.exists
    }

    func toggleLike(postID: String, uid: String) async throws -> Bool {
        let ref = socialThreadRef(postID: postID).collection("likes").document(uid)
        let snapshot = try await ref.getDocument()
        if snapshot.exists {
            try await ref.delete()
            return false
        }

        try await ref.setData([
            "uid": uid,
            "createdAt": FieldValue.serverTimestamp()
        ], merge: true)
        return true
    }

    func fetchComments(postID: String, viewerUID: String?, limit: Int = 20) async throws -> [PostComment] {
        let snapshot = try await socialThreadRef(postID: postID)
            .collection("comments")
            .order(by: "createdAt", descending: true)
            .limit(to: limit)
            .getDocuments()

        let documents = snapshot.documents.reversed()
        let rawComments = documents.map { document -> (document: QueryDocumentSnapshot, data: [String: Any], uid: String) in
            let data = document.data()
            return (document, data, string(data["uid"]) ?? "")
        }
        let authorIDs = rawComments.map(\.uid)
        let authors = try await userRepository.listUsers(ids: authorIDs)
        let authorMap = Dictionary(uniqueKeysWithValues: authors.map { ($0.id, $0) })
        var comments: [PostComment] = []
        comments.reserveCapacity(rawComments.count)

        for item in rawComments {
            let document = item.document
            let data = item.data
            let author = authorMap[item.uid]
            let likesCount = try await aggregateCount(document.reference.collection("likes"))
            let likedByMe: Bool
            if let viewerUID, !viewerUID.isEmpty {
                let likeSnapshot = try await document.reference.collection("likes").document(viewerUID).getDocument()
                likedByMe = likeSnapshot.exists
            } else {
                likedByMe = false
            }

            let containsSpoiler = (data["containsSpoiler"] as? Bool) ?? false
            let spoilerTitleIDs = FirestoreValueReader.stringArray(data["spoilerTitleIds"])

            comments.append(PostComment(
                id: document.documentID,
                uid: item.uid,
                authorName: string(data["authorName"]) ?? author?.displayName ?? "User",
                avatarURL: FirestoreValueReader.string(data, key: "authorAvatarURL").flatMap(URL.init(string:))
                    ?? author?.photoURL
                    ?? author?.avatarURL,
                text: string(data["text"]) ?? "",
                createdAt: FirestoreValueReader.date(data["createdAt"]),
                likes: likesCount,
                likedByMe: likedByMe,
                parentCommentId: string(data["parentCommentId"]),
                parentAuthorName: string(data["parentAuthorName"]),
                containsSpoiler: containsSpoiler,
                spoilerTitleIds: spoilerTitleIDs
            ))
        }

        return comments
    }

    func addComment(
        postID: String,
        uid: String,
        authorName: String,
        text: String,
        authorAvatarURL: URL? = nil,
        parentCommentID: String? = nil,
        parentUID: String? = nil,
        parentAuthorName: String? = nil,
        containsSpoiler: Bool = false,
        spoilerTitleIDs: [String] = []
    ) async throws {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !uid.isEmpty else { return }
        guard !body.isEmpty else { return }

        var payload: [String: Any] = [
            "uid": uid,
            "authorName": String(authorName.prefix(80)),
            "text": String(body.prefix(5000)),
            "createdAt": FieldValue.serverTimestamp()
        ]
        if let authorAvatarURL {
            payload["authorAvatarURL"] = authorAvatarURL.absoluteString
        }
        if let parentCommentID, !parentCommentID.isEmpty {
            payload["parentCommentId"] = parentCommentID
        }
        if let parentUID, !parentUID.isEmpty {
            payload["parentUid"] = parentUID
        }
        if let parentAuthorName, !parentAuthorName.isEmpty {
            payload["parentAuthorName"] = String(parentAuthorName.prefix(80))
        }
        if containsSpoiler {
            payload["containsSpoiler"] = true
            let cleaned = spoilerTitleIDs
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
            payload["spoilerTitleIds"] = Array(cleaned.prefix(5))
        }

        try await socialThreadRef(postID: postID)
            .collection("comments")
            .addDocument(data: payload)
    }

    func toggleCommentLike(postID: String, commentID: String, uid: String) async throws -> Bool {
        let ref = socialThreadRef(postID: postID)
            .collection("comments")
            .document(commentID)
            .collection("likes")
            .document(uid)

        let snapshot = try await ref.getDocument()
        if snapshot.exists {
            try await ref.delete()
            return false
        }

        try await ref.setData([
            "uid": uid,
            "createdAt": FieldValue.serverTimestamp()
        ], merge: true)
        return true
    }

    private func fetchRatingThread(postID: String) async throws -> AppPost? {
        guard let parsed = parseRatingThread(postID) else { return nil }

        let ratingID = makeRatingID(
            uid: parsed.actorUID,
            titleID: parsed.titleID,
            level: parsed.level,
            season: parsed.season,
            episode: parsed.episode
        )
        async let authorTask = userRepository.fetchUser(uid: parsed.actorUID)
        let ratingSnapshot = try await db.collection("ratings").document(ratingID).getDocument()
        let author = try await authorTask
        let ratingData = ratingSnapshot.data() ?? [:]
        let taggedTitleIDs = TaggedTextFormatter.taggedTitleIDs(in: [FirestoreValueReader.string(ratingData, key: "reviewText")])
        let requestedTitleIDs = orderedUnique([parsed.titleID] + taggedTitleIDs)
        let resolvedTitles = try await titleRepository.listTitles(ids: requestedTitleIDs)
        let titleMap = Dictionary(uniqueKeysWithValues: resolvedTitles.map { ($0.id, $0) })
        let title = titleMap[parsed.titleID]
        let authorSummary = userSummary(
            uid: parsed.actorUID,
            fallbackName: author?.displayName ?? "User",
            user: author
        )

        let watchedWith = (ratingData["watchedWith"] as? [Any] ?? []).compactMap { row -> FeedTaggedUser? in
            let data = FirestoreValueReader.map(row)
            guard let uid = FirestoreValueReader.string(data, key: "uid") else { return nil }
            return FeedTaggedUser(
                id: uid,
                displayName: FirestoreValueReader.string(data, key: "displayName") ?? "Amico"
            )
        }
        let watchedWithGroup = group(from: ratingData["watchedWithGroup"])
        let mediaURLs = mediaURLs(from: ratingData, arrayKey: "mediaUrls", singleKey: "reviewPhotoUrl")

        let resolvedTaggedTitles = !taggedTitleIDs.isEmpty
            ? taggedTitleIDs.compactMap { titleMap[$0] }
            : title.map { [$0] } ?? []

        return AppPost(
            id: postID,
            kind: watchedWith.isEmpty ? .rating : .watchTogether,
            author: authorSummary,
            titleId: parsed.titleID,
            title: title,
            text: nil,
            sharedPost: nil,
            visibility: nil,
            rating: FirestoreValueReader.double(ratingData, key: "rating"),
            reviewText: FirestoreValueReader.string(ratingData, key: "reviewText"),
            taggedTitles: resolvedTaggedTitles,
            mediaURL: mediaURLs.first,
            mediaURLs: mediaURLs,
            watchedWith: watchedWith,
            watchedWithGroup: watchedWithGroup,
            createdAt: FirestoreValueReader.date(ratingData["createdAt"]),
            updatedAt: FirestoreValueReader.date(ratingData["updatedAt"])
        )
    }

    /// Un post pubblico già arricchito con i contatori social (like/commenti),
    /// così il feed Community può fare ranking e hydration senza una seconda
    /// passata di read per card.
    struct PublicPost: Hashable {
        let post: AppPost
        let counts: PostSocialCounts
    }

    struct PublicPostsPage {
        let items: [PublicPost]
        let nextCursor: DocumentSnapshot?
        let hasMore: Bool
    }

    /// Pagina di TUTTI i post pubblici (`visibility == "public"`), ordinati per
    /// `createdAt` desc. L'indice `posts(visibility ASC, createdAt DESC)` è già
    /// deployato. I contatori social vengono letti in parallelo (cap = pageSize)
    /// per alimentare il ranking popolarità×recency del feed Community.
    func listPublicPostsPage(
        pageSize: Int = 40,
        after cursor: DocumentSnapshot? = nil
    ) async throws -> PublicPostsPage {
        var query: Query = db.collection("posts")
            .whereField("visibility", isEqualTo: PostVisibility.public.rawValue)
            .order(by: "createdAt", descending: true)
            .limit(to: pageSize)

        if let cursor {
            query = query.start(afterDocument: cursor)
        }

        let snapshot = try await query.getDocuments()
        let documents = snapshot.documents

        // Mappa i post: `buildStoredPost` è isolato su MainActor (nessun vantaggio
        // reale da un task group, e `data` non è Sendable). Sequenziale + tollerante.
        var posts: [AppPost] = []
        posts.reserveCapacity(documents.count)
        for document in documents {
            let data = document.data()
            let mapped = try await buildStoredPost(
                id: document.documentID,
                data: data,
                defaultKind: .post,
                fallbackAuthorUID: FirestoreValueReader.string(data, key: "authorUid") ?? "",
                fallbackAuthorName: FirestoreValueReader.string(data, key: "authorName") ?? "User",
                fallbackText: FirestoreValueReader.string(data, key: "text"),
                fallbackRating: nil,
                fallbackReviewText: nil,
                fallbackWatchedWith: [],
                fallbackCreatedAt: FirestoreValueReader.date(data["createdAt"]),
                fallbackUpdatedAt: FirestoreValueReader.date(data["updatedAt"]),
                visibility: .public
            )
            posts.append(mapped)
        }

        // Contatori social in parallelo per id (String è Sendable), bounded dal
        // pageSize. Tollerante agli errori: post senza sottocollezione → zero.
        let postIDs = posts.map(\.id)
        let counts: [String: PostSocialCounts] = await withTaskGroup(of: (String, PostSocialCounts).self) { group in
            for postID in postIDs {
                group.addTask { [self] in
                    let value = (try? await fetchSocialCounts(postID: postID)) ?? PostSocialCounts(likes: 0, comments: 0, shares: 0)
                    return (postID, value)
                }
            }
            var map: [String: PostSocialCounts] = [:]
            for await (id, value) in group {
                map[id] = value
            }
            return map
        }

        let items = posts.map { post in
            PublicPost(post: post, counts: counts[post.id] ?? PostSocialCounts(likes: 0, comments: 0, shares: 0))
        }

        return PublicPostsPage(
            items: items,
            nextCursor: documents.last,
            hasMore: documents.count >= pageSize && documents.last != nil
        )
    }

    // MARK: - Commenti (post-eco dei thread pubblici)

    /// Visibilità dedicata degli eco dei commenti (functions/lib/commentEcho.js).
    /// Separata da `public` così i client che non conoscono il gate anti-spoiler
    /// per progresso non li mostrano mai in chiaro.
    static let commentVisibility = "comment"

    /// Commenti più recenti di tutta la community. Usa lo stesso indice
    /// `posts(visibility, createdAt↓)` dei post pubblici.
    func listCommentActivities(pageSize: Int = 24) async throws -> [FeedActivity] {
        let snapshot = try await db.collection("posts")
            .whereField("visibility", isEqualTo: Self.commentVisibility)
            .order(by: "createdAt", descending: true)
            .limit(to: pageSize)
            .getDocuments()
        return try await commentActivities(from: snapshot.documents)
    }

    /// Commenti sui titoli passati, a QUALSIASI età: è la sorgente che fa
    /// emergere lo storico (backfill), che con la sola query per recency non
    /// uscirebbe mai. Indice `posts(visibility, titleId, createdAt↓)`.
    func listCommentActivitiesByTitleIDs(_ titleIDs: [String], perChunkLimit: Int = 12) async throws -> [FeedActivity] {
        let ids = Array(Set(titleIDs.filter { !$0.isEmpty })).prefix(60)
        guard !ids.isEmpty else { return [] }

        var documents: [QueryDocumentSnapshot] = []
        for chunk in Array(ids).chunked(into: 30) {
            let snapshot = try await db.collection("posts")
                .whereField("visibility", isEqualTo: Self.commentVisibility)
                .whereField("titleId", in: chunk)
                .order(by: "createdAt", descending: true)
                .limit(to: perChunkLimit)
                .getDocuments()
            documents.append(contentsOf: snapshot.documents)
        }
        return try await commentActivities(from: documents)
    }

    /// Mappa i doc eco su `FeedActivity` (kind `.titleComment`): niente
    /// contatori social — la conversazione vive nel thread, non sul post
    /// gemello, quindi like/commenti del post non si leggono nemmeno.
    private func commentActivities(from documents: [QueryDocumentSnapshot]) async throws -> [FeedActivity] {
        guard !documents.isEmpty else { return [] }

        var authorIDs: Set<String> = []
        var titleIDs: Set<String> = []
        for document in documents {
            let data = document.data()
            if let uid = FirestoreValueReader.string(data, key: "authorUid"), !uid.isEmpty {
                authorIDs.insert(uid)
            }
            if let titleID = FirestoreValueReader.string(data, key: "titleId"), !titleID.isEmpty {
                titleIDs.insert(titleID)
            }
        }

        async let usersTask = userRepository.listUsers(ids: Array(authorIDs))
        async let titlesTask = titleRepository.listTitles(ids: Array(titleIDs))
        let (users, titles) = try await (usersTask, titlesTask)
        let userMap = Dictionary(users.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let titleMap = Dictionary(titles.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })

        var activities: [FeedActivity] = []
        activities.reserveCapacity(documents.count)
        for document in documents {
            let data = document.data()
            guard
                let authorUID = FirestoreValueReader.string(data, key: "authorUid"), !authorUID.isEmpty,
                let titleID = FirestoreValueReader.string(data, key: "titleId"), !titleID.isEmpty
            else { continue }

            let scope = FirestoreValueReader.map(data["spoilerScope"])
            let level = FirestoreValueReader.string(scope, key: "level") ?? "title"
            let mediaURL = mediaURLs(from: data, arrayKey: "mediaUrls", singleKey: "mediaUrl").first

            activities.append(FeedActivity(
                id: document.documentID,
                kind: .titleComment,
                actor: userSummary(
                    uid: authorUID,
                    fallbackName: FirestoreValueReader.string(data, key: "authorName") ?? "User",
                    user: userMap[authorUID]
                ),
                relatedUser: nil,
                title: titleMap[titleID],
                titleId: titleID,
                postId: document.documentID,
                recommendationId: nil,
                // Il thread di origine: la risposta dalla card ci scrive dentro.
                sourceId: FirestoreValueReader.string(data, key: "sourceThreadId"),
                sourcePath: nil,
                rating: nil,
                previousRating: nil,
                level: level,
                season: FirestoreValueReader.int(scope, key: "season"),
                episode: FirestoreValueReader.int(scope, key: "episode"),
                text: FirestoreValueReader.string(data, key: "text"),
                snippet: nil,
                reviewText: nil,
                taggedTitles: [],
                mediaURL: mediaURL,
                mediaURLs: mediaURL.map { [$0] } ?? [],
                watchedWith: [],
                watchedWithGroup: nil,
                sharedPost: nil,
                createdAt: FirestoreValueReader.date(data["createdAt"]),
                webURL: nil
            ))
        }
        return activities
    }

    private func fetchStoredPost(postID: String) async throws -> AppPost? {
        let snapshot = try await db.collection("posts").document(postID).getDocument()
        guard snapshot.exists, let data = snapshot.data() else { return nil }
        return try await buildStoredPost(
            id: snapshot.documentID,
            data: data,
            defaultKind: .post,
            fallbackAuthorUID: string(data["authorUid"]) ?? "",
            fallbackAuthorName: string(data["authorName"]) ?? "User",
            fallbackText: string(data["text"]),
            fallbackRating: nil,
            fallbackReviewText: nil,
            fallbackWatchedWith: [],
            fallbackCreatedAt: FirestoreValueReader.date(data["createdAt"]),
            fallbackUpdatedAt: FirestoreValueReader.date(data["updatedAt"]),
            visibility: PostVisibility(rawValue: string(data["visibility"]) ?? "")
        )
    }

    private func fetchFeedBackedPost(postID: String) async throws -> AppPost? {
        guard let viewerUID = activeViewerUID() else { return nil }

        let snapshot = try await db.collection("feedEvents")
            .whereField("ownerUid", isEqualTo: viewerUID)
            .whereField("postId", isEqualTo: postID)
            .limit(to: 8)
            .getDocuments()

        let documents = snapshot.documents.sorted { lhs, rhs in
            let leftDate = FirestoreValueReader.date(lhs.data()["createdAt"]) ?? .distantPast
            let rightDate = FirestoreValueReader.date(rhs.data()["createdAt"]) ?? .distantPast
            return leftDate > rightDate
        }

        guard let document = documents.first else { return nil }
        let data = document.data()
        let eventType = FeedActivityKind(rawValue: string(data["eventType"]) ?? "")
        let postKind = postKind(from: eventType)

        return try await buildStoredPost(
            id: postID,
            data: data,
            defaultKind: postKind,
            fallbackAuthorUID: string(data["actorUid"]) ?? "",
            fallbackAuthorName: "User",
            fallbackText: string(data["text"]) ?? string(data["snippet"]),
            fallbackRating: FirestoreValueReader.double(data, key: "rating"),
            fallbackReviewText: string(data["reviewText"]),
            fallbackWatchedWith: watchedWith(from: data["watchedWith"]),
            fallbackCreatedAt: FirestoreValueReader.date(data["createdAt"]),
            fallbackUpdatedAt: FirestoreValueReader.date(data["createdAt"]),
            visibility: nil
        )
    }

    private func buildStoredPost(
        id: String,
        data: [String: Any],
        defaultKind: PostKind,
        fallbackAuthorUID: String,
        fallbackAuthorName: String,
        fallbackText: String?,
        fallbackRating: Double?,
        fallbackReviewText: String?,
        fallbackWatchedWith: [FeedTaggedUser],
        fallbackCreatedAt: Date?,
        fallbackUpdatedAt: Date?,
        visibility: PostVisibility?
    ) async throws -> AppPost {
        let authorUID = string(data["authorUid"]) ?? string(data["actorUid"]) ?? fallbackAuthorUID
        let authorName = string(data["authorName"]) ?? fallbackAuthorName
        let titleID = string(data["titleId"])
        let sharedPayload = dictionary(data["sharedPost"])
        let sharedAuthorUID = string(sharedPayload["authorUid"])
        let sharedAuthorName = string(sharedPayload["authorName"]) ?? "User"
        let sharedTitleID = string(sharedPayload["titleId"])
        let taggedTitleIDs = TaggedTextFormatter.taggedTitleIDs(in: [
            string(data["reviewText"]),
            string(data["text"]),
            string(data["snippet"]),
            fallbackText
        ])

        let userIDs = [authorUID, sharedAuthorUID].compactMap { $0 }.filter { !$0.isEmpty }
        let titleIDs = orderedUnique([titleID, sharedTitleID].compactMap { $0 }.filter { !$0.isEmpty } + taggedTitleIDs)
        async let usersTask = userRepository.listUsers(ids: userIDs)
        async let titlesTask = titleRepository.listTitles(ids: titleIDs)
        let (users, titles) = try await (usersTask, titlesTask)

        let userMap = Dictionary(uniqueKeysWithValues: users.map { ($0.id, $0) })
        let titleMap = Dictionary(uniqueKeysWithValues: titles.map { ($0.id, $0) })
        let author = userSummary(uid: authorUID, fallbackName: authorName, user: userMap[authorUID])
        let resolvedTaggedTitles = !taggedTitleIDs.isEmpty
            ? taggedTitleIDs.compactMap { titleMap[$0] }
            : titleID.flatMap { titleMap[$0] }.map { [$0] } ?? []

        let sharedPost: FeedSharedPost? = {
            guard let sharedAuthorUID, !sharedAuthorUID.isEmpty else { return nil }
            return FeedSharedPost(
                postId: string(sharedPayload["postId"]) ?? "shared-post",
                author: userSummary(uid: sharedAuthorUID, fallbackName: sharedAuthorName, user: userMap[sharedAuthorUID]),
                text: string(sharedPayload["text"]) ?? "",
                titleId: sharedTitleID
            )
        }()

        return AppPost(
            id: id,
            kind: PostKind(rawValue: string(data["kind"]) ?? "") ?? defaultKind,
            author: author,
            titleId: titleID,
            title: titleID.flatMap { titleMap[$0] },
            text: string(data["text"]) ?? fallbackText,
            sharedPost: sharedPost,
            visibility: visibility,
            rating: FirestoreValueReader.double(data, key: "rating") ?? fallbackRating,
            reviewText: string(data["reviewText"]) ?? fallbackReviewText,
            taggedTitles: resolvedTaggedTitles,
            mediaURL: mediaURLs(from: data, arrayKey: "mediaUrls", singleKey: "mediaUrl").first,
            mediaURLs: mediaURLs(from: data, arrayKey: "mediaUrls", singleKey: "mediaUrl"),
            watchedWith: watchedWith(from: data["watchedWith"]).isEmpty ? fallbackWatchedWith : watchedWith(from: data["watchedWith"]),
            watchedWithGroup: group(from: data["watchedWithGroup"]),
            createdAt: FirestoreValueReader.date(data["createdAt"]) ?? fallbackCreatedAt,
            updatedAt: FirestoreValueReader.date(data["updatedAt"]) ?? fallbackUpdatedAt,
            containsSpoiler: (data["containsSpoiler"] as? Bool) ?? false,
            spoilerTitleIds: FirestoreValueReader.stringArray(data["spoilerTitleIds"])
        )
    }

    private func socialThreadRef(postID: String) -> DocumentReference {
        if isRatingThread(postID) {
            return db.collection("ratingFeed").document(postID)
        }
        return db.collection("posts").document(postID)
    }

    private func isRatingThread(_ postID: String) -> Bool {
        postID.hasPrefix("rating::")
    }

    private func parseRatingThread(_ postID: String) -> (actorUID: String, titleID: String, level: String, season: Int?, episode: Int?)? {
        let parts = postID.components(separatedBy: "::")
        guard parts.count >= 3 else { return nil }
        let actorUID = parts[1].trimmingCharacters(in: .whitespacesAndNewlines)
        let titleID = parts[2].trimmingCharacters(in: .whitespacesAndNewlines)
        guard !actorUID.isEmpty, !titleID.isEmpty else { return nil }

        let marker = parts.count > 3 ? parts[3] : "title"
        if marker == "season" {
            return (actorUID, titleID, "season", parts.count > 4 ? Int(parts[4]) : nil, nil)
        }
        if marker == "episode" {
            return (actorUID, titleID, "episode", parts.count > 4 ? Int(parts[4]) : nil, parts.count > 5 ? Int(parts[5]) : nil)
        }
        return (actorUID, titleID, "title", nil, nil)
    }

    private func makeRatingID(uid: String, titleID: String, level: String, season: Int?, episode: Int?) -> String {
        [
            safePart(uid),
            safePart(titleID),
            safePart(level),
            safePart(String(season ?? 0)),
            safePart(String(episode ?? 0))
        ].joined(separator: "__")
    }

    private func safePart(_ value: String) -> String {
        String(value.map { character in
            if character.isLetter || character.isNumber || character == "_" || character == "-" {
                return character
            }
            return "_"
        })
    }

    private func postKind(from eventType: FeedActivityKind?) -> PostKind {
        switch eventType {
        case .rating:
            return .rating
        case .watchTogether:
            return .watchTogether
        case .postShare:
            return .share
        case .post, .postComment, .recommendation, .follow, .seriesStarted, .titleComment, .none:
            return .post
        }
    }

    private func watchedWith(from value: Any?) -> [FeedTaggedUser] {
        (value as? [Any] ?? []).compactMap { row -> FeedTaggedUser? in
            let data = FirestoreValueReader.map(row)
            guard let uid = FirestoreValueReader.string(data, key: "uid") else { return nil }
            return FeedTaggedUser(
                id: uid,
                displayName: FirestoreValueReader.string(data, key: "displayName") ?? "Amico"
            )
        }
    }

    private func group(from value: Any?) -> FeedTaggedGroup? {
        let data = FirestoreValueReader.map(value)
        guard let threadID = FirestoreValueReader.string(data, key: "threadId") else { return nil }
        return FeedTaggedGroup(
            id: threadID,
            groupName: FirestoreValueReader.string(data, key: "groupName") ?? "Gruppo"
        )
    }

    private func mediaURLs(from data: [String: Any], arrayKey: String, singleKey: String) -> [URL] {
        let rawArray = FirestoreValueReader.stringArray(data[arrayKey])
        if !rawArray.isEmpty {
            return rawArray.compactMap(URL.init(string:))
        }

        return string(data[singleKey]).flatMap(URL.init(string:)).map { [$0] } ?? []
    }

    private func activeViewerUID() -> String? {
        let rawValue = Auth.auth().currentUser?.uid.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let rawValue, !rawValue.isEmpty else { return nil }
        return rawValue
    }

    private func isPermissionDenied(_ error: Error) -> Bool {
        let nsError = error as NSError
        guard let code = FirestoreErrorCode.Code(rawValue: nsError.code) else { return false }
        return code == .permissionDenied
    }

    private func userSummary(uid: String, fallbackName: String, user: AppUser?) -> UserSummary {
        UserSummary(
            id: uid,
            displayName: user?.displayName ?? fallbackName,
            photoURL: user?.photoURL ?? user?.avatarURL
        )
    }

    @available(*, deprecated, message: "Usa `.count.getAggregation(source: .server)` per evitare di scaricare l'intera collection.")
    private func countDocuments(in collection: CollectionReference) async throws -> Int {
        let aggregate = try await collection.count.getAggregation(source: .server)
        return aggregate.count.intValue
    }

    private func string(_ value: Any?) -> String? {
        guard let value else { return nil }
        if let string = value as? String {
            return string.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if let number = value as? NSNumber {
            return number.stringValue
        }
        return nil
    }

    private func dictionary(_ value: Any?) -> [String: Any] {
        value as? [String: Any] ?? [:]
    }

    private func orderedUnique(_ values: [String]) -> [String] {
        var seen: Set<String> = []
        var ordered: [String] = []
        for value in values where !value.isEmpty {
            if seen.insert(value).inserted {
                ordered.append(value)
            }
        }
        return ordered
    }
}

private enum PostWriteError: LocalizedError {
    case missingAuthor
    case emptyBody
    case bodyTooLong(limit: Int)

    var errorDescription: String? {
        switch self {
        case .missingAuthor:
            return String(localized: "Sessione utente non valida.")
        case .emptyBody:
            return "Scrivi qualcosa prima di pubblicare."
        case let .bodyTooLong(limit):
            return "Il post supera il limite di \(limit) caratteri."
        }
    }
}
