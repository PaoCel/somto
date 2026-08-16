import Foundation

enum TaggedTextTokenKind: Hashable {
    case user
    case title
    case person
    case unresolvedUser
}

struct TaggedTextToken: Hashable {
    let kind: TaggedTextTokenKind
    let label: String
    let targetID: String
    let range: NSRange

    var displayText: String {
        switch kind {
        case .user, .unresolvedUser:
            return "@\(label)"
        case .title, .person:
            return "#\(label)"
        }
    }
}

enum TaggedTextFormatter {
    private static let userRegex = try! NSRegularExpression(pattern: "@\\{([^}]+)\\}\\(([^)]+)\\)")
    private static let topicRegex = try! NSRegularExpression(pattern: "#\\[([^\\]]+)\\]\\(([^)]+)\\)")
    private static let plainMentionRegex = try! NSRegularExpression(pattern: "(?<=\\s|^)@([A-Za-z0-9_\\.]{2,30})(?=\\s|$|[.,;:!?)])")

    static func tokens(in source: String?) -> [TaggedTextToken] {
        guard let source else { return [] }
        let nsSource = source as NSString
        let fullRange = NSRange(location: 0, length: nsSource.length)

        let userTokens = userRegex.matches(in: source, range: fullRange).compactMap { match -> TaggedTextToken? in
            guard match.numberOfRanges >= 3 else { return nil }
            let label = nsSource.substring(with: match.range(at: 1))
            let uid = nsSource.substring(with: match.range(at: 2)).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !label.isEmpty, !uid.isEmpty else { return nil }
            return TaggedTextToken(kind: .user, label: label, targetID: uid, range: match.range)
        }

        let topicTokens = topicRegex.matches(in: source, range: fullRange).compactMap { match -> TaggedTextToken? in
            guard match.numberOfRanges >= 3 else { return nil }
            let label = nsSource.substring(with: match.range(at: 1))
            let rawID = nsSource.substring(with: match.range(at: 2)).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !label.isEmpty, !rawID.isEmpty else { return nil }

            if rawID.hasPrefix("person:") {
                return TaggedTextToken(
                    kind: .person,
                    label: label,
                    targetID: String(rawID.dropFirst("person:".count)),
                    range: match.range
                )
            }

            return TaggedTextToken(kind: .title, label: label, targetID: rawID, range: match.range)
        }

        let resolvedRanges = (userTokens + topicTokens).map(\.range)
        let plainMentionTokens = plainMentionRegex.matches(in: source, range: fullRange).compactMap { match -> TaggedTextToken? in
            guard match.numberOfRanges >= 2 else { return nil }
            let overlaps = resolvedRanges.contains { NSIntersectionRange($0, match.range).length > 0 }
            guard !overlaps else { return nil }
            let label = nsSource.substring(with: match.range(at: 1))
            guard !label.isEmpty else { return nil }
            return TaggedTextToken(kind: .unresolvedUser, label: label, targetID: "", range: match.range)
        }

        return (userTokens + topicTokens + plainMentionTokens).sorted { lhs, rhs in
            lhs.range.location < rhs.range.location
        }
    }

    static func plainText(from source: String?) -> String? {
        guard let source else { return nil }
        let withUsers = replacingMatches(in: source, regex: userRegex) { match, nsSource in
            "@\(nsSource.substring(with: match.range(at: 1)))"
        }
        return replacingMatches(in: withUsers, regex: topicRegex) { match, nsSource in
            "#\(nsSource.substring(with: match.range(at: 1)))"
        }
    }

    static func firstTaggedTitleID(in source: String) -> String? {
        let nsSource = source as NSString
        let matches = topicRegex.matches(in: source, range: NSRange(location: 0, length: nsSource.length))
        for match in matches where match.numberOfRanges >= 3 {
            let rawID = nsSource.substring(with: match.range(at: 2)).trimmingCharacters(in: .whitespacesAndNewlines)
            if !rawID.isEmpty, !rawID.hasPrefix("person:") {
                return rawID
            }
        }
        return nil
    }

    static func taggedTitleIDs(in source: String?) -> [String] {
        orderedUnique(tokens(in: source).compactMap { token in
            guard token.kind == .title else { return nil }
            return token.targetID
        })
    }

    static func taggedTitleIDs(in sources: [String?]) -> [String] {
        orderedUnique(sources.flatMap { taggedTitleIDs(in: $0) })
    }

    private static func replacingMatches(
        in source: String,
        regex: NSRegularExpression,
        replacement: (_ match: NSTextCheckingResult, _ nsSource: NSString) -> String
    ) -> String {
        let nsSource = source as NSString
        let matches = regex.matches(in: source, range: NSRange(location: 0, length: nsSource.length))
        guard !matches.isEmpty else { return source }

        var output = source
        for match in matches.reversed() {
            guard match.numberOfRanges >= 2 else { continue }
            let replacementValue = replacement(match, nsSource)
            if let range = Range(match.range, in: output) {
                output.replaceSubrange(range, with: replacementValue)
            }
        }
        return output
    }

    private static func orderedUnique(_ values: [String]) -> [String] {
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

enum PostKind: String, Hashable {
    case post
    case share
    case rating
    case watchTogether = "watch_together"
}

enum PostVisibility: String, Hashable, CaseIterable {
    case `public`
    case friends
    case `private`

    /// Cosa può scegliere l'autore in un composer. `friends` è esclusa: con il
    /// grafo amicizie in dismissione la rule `isFriendWith` è falsa per tutti,
    /// quindi un post "Amici" oggi non lo leggerebbe nessuno. Il case resta per
    /// decodificare i post storici.
    static let selectableCases: [PostVisibility] = [.public, .private]

    var label: String {
        switch self {
        case .public:
            return String(localized: "Pubblico")
        case .friends:
            return String(localized: "Amici")
        case .private:
            return String(localized: "Privato")
        }
    }
}

struct AppPost: Identifiable, Hashable {
    let id: String
    let kind: PostKind
    let author: UserSummary
    let titleId: String?
    let title: Title?
    let text: String?
    let sharedPost: FeedSharedPost?
    let visibility: PostVisibility?
    let rating: Double?
    let reviewText: String?
    let taggedTitles: [Title]
    let mediaURL: URL?
    let mediaURLs: [URL]
    let watchedWith: [FeedTaggedUser]
    let watchedWithGroup: FeedTaggedGroup?
    let createdAt: Date?
    let updatedAt: Date?
    let containsSpoiler: Bool
    let spoilerTitleIds: [String]

    init(
        id: String,
        kind: PostKind,
        author: UserSummary,
        titleId: String?,
        title: Title?,
        text: String?,
        sharedPost: FeedSharedPost?,
        visibility: PostVisibility?,
        rating: Double?,
        reviewText: String?,
        taggedTitles: [Title],
        mediaURL: URL?,
        mediaURLs: [URL],
        watchedWith: [FeedTaggedUser],
        watchedWithGroup: FeedTaggedGroup?,
        createdAt: Date?,
        updatedAt: Date?,
        containsSpoiler: Bool = false,
        spoilerTitleIds: [String] = []
    ) {
        self.id = id
        self.kind = kind
        self.author = author
        self.titleId = titleId
        self.title = title
        self.text = text
        self.sharedPost = sharedPost
        self.visibility = visibility
        self.rating = rating
        self.reviewText = reviewText
        self.taggedTitles = taggedTitles
        self.mediaURL = mediaURL
        self.mediaURLs = mediaURLs
        self.watchedWith = watchedWith
        self.watchedWithGroup = watchedWithGroup
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.containsSpoiler = containsSpoiler
        self.spoilerTitleIds = spoilerTitleIds
    }

    var isRatingThread: Bool {
        kind == .rating || kind == .watchTogether
    }

    var primarySourceText: String? {
        if let reviewText, !reviewText.isEmpty {
            return reviewText
        }
        if let text, !text.isEmpty {
            return text
        }
        return nil
    }

    var primaryText: String? {
        TaggedTextFormatter.plainText(from: primarySourceText)
    }

    var actionTitle: String {
        switch kind {
        case .post, .share:
            return String(localized: "Discussione")
        case .rating:
            return String(localized: "Commenti sul voto")
        case .watchTogether:
            return String(localized: "Commenti sulla visione")
        }
    }
}

struct PostSocialCounts: Hashable {
    let likes: Int
    let comments: Int
    let shares: Int
}

struct PostComment: Identifiable, Hashable {
    let id: String
    let uid: String
    let authorName: String
    let avatarURL: URL?
    let text: String
    let createdAt: Date?
    let likes: Int
    let likedByMe: Bool
    let parentCommentId: String?
    let parentAuthorName: String?
    let containsSpoiler: Bool
    let spoilerTitleIds: [String]

    init(
        id: String,
        uid: String,
        authorName: String,
        avatarURL: URL?,
        text: String,
        createdAt: Date?,
        likes: Int,
        likedByMe: Bool,
        parentCommentId: String?,
        parentAuthorName: String?,
        containsSpoiler: Bool = false,
        spoilerTitleIds: [String] = []
    ) {
        self.id = id
        self.uid = uid
        self.authorName = authorName
        self.avatarURL = avatarURL
        self.text = text
        self.createdAt = createdAt
        self.likes = likes
        self.likedByMe = likedByMe
        self.parentCommentId = parentCommentId
        self.parentAuthorName = parentAuthorName
        self.containsSpoiler = containsSpoiler
        self.spoilerTitleIds = spoilerTitleIds
    }

    var displayText: String {
        TaggedTextFormatter.plainText(from: text) ?? text
    }

    var isReply: Bool {
        guard let parentCommentId else { return false }
        return !parentCommentId.isEmpty
    }
}
