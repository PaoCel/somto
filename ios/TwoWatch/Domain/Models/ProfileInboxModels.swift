import Foundation

enum ProfileInboxSection: String, CaseIterable, Identifiable {
    case received = "Ricevuti"
    case sent = "Inviati"

    var id: String { rawValue }
}

enum RecommendationStatus: String, Hashable {
    case unread
    case seen
    case archived
}

struct RecommendationItem: Identifiable, Hashable {
    let id: String
    let fromUid: String
    let toUid: String
    let titleId: String
    let message: String
    let status: RecommendationStatus
    let threadId: String?
    let viewedAt: Date?
    let createdAt: Date?
    let counterpart: AppUser?
    let title: Title?
    let containsSpoiler: Bool
    let spoilerTitleIds: [String]

    init(
        id: String,
        fromUid: String,
        toUid: String,
        titleId: String,
        message: String,
        status: RecommendationStatus,
        threadId: String?,
        viewedAt: Date?,
        createdAt: Date?,
        counterpart: AppUser?,
        title: Title?,
        containsSpoiler: Bool = false,
        spoilerTitleIds: [String] = []
    ) {
        self.id = id
        self.fromUid = fromUid
        self.toUid = toUid
        self.titleId = titleId
        self.message = message
        self.status = status
        self.threadId = threadId
        self.viewedAt = viewedAt
        self.createdAt = createdAt
        self.counterpart = counterpart
        self.title = title
        self.containsSpoiler = containsSpoiler
        self.spoilerTitleIds = spoilerTitleIds
    }

    var isUnread: Bool {
        status == .unread
    }
}
