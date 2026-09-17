import Foundation

enum ThreadVisibility: String, Hashable {
    case publicThread = "public"
    case privateThread = "private"
}

enum ThreadContextType: String, Hashable {
    case `public` = "public"
    case dm
    case group
}

enum ThreadFilter: String, CaseIterable, Identifiable {
    case all = "Tutti"
    case publicOnly = "Pubblici"
    case privateOnly = "Privati"

    var id: String { rawValue }
}

struct AppThread: Identifiable, Hashable {
    let id: String
    let titleId: String?
    let visibility: ThreadVisibility
    let contextType: ThreadContextType
    let contextId: String?
    let participants: [String]
    let groupName: String
    let createdBy: String
    let createdAt: Date?
    let lastMessageAt: Date?
    let lastMessagePreview: String
    let lastSenderUid: String?
    let title: Title?
    let participantUsers: [AppUser]

    var isPublic: Bool {
        visibility == .publicThread
    }

    func displayName(currentUserID: String?) -> String {
        if let title {
            return title.name
        }

        if contextType == .group, !groupName.isEmpty {
            return groupName
        }

        let others = participantUsers.filter { $0.id != currentUserID }
        if let first = others.first {
            if others.count > 1 {
                return "\(first.displayName) +\(others.count - 1)"
            }
            return first.displayName
        }

        if !groupName.isEmpty {
            return groupName
        }

        return "Discussione"
    }

    func subtitle(currentUserID: String?) -> String {
        if !lastMessagePreview.isEmpty {
            return TaggedTextFormatter.plainText(from: lastMessagePreview) ?? lastMessagePreview
        }

        switch contextType {
        case .public:
            return String(localized: "Thread pubblico")
        case .group:
            return String(localized: "Gruppo")
        case .dm:
            let others = participantUsers.filter { $0.id != currentUserID }
            if let first = others.first {
                return String(localized: "Chat con \(first.displayName)")
            }
            return String(localized: "Messaggi diretti")
        }
    }
}

struct ThreadMessage: Identifiable, Hashable {
    let id: String
    let uid: String
    let displayName: String
    let text: String
    let type: String
    let createdAt: Date?
    let reactions: [String: [String]]
    let containsSpoiler: Bool
    let spoilerTitleIds: [String]
    /// URL della GIF (host giphy.com) quando `type == "gif"`. `nil` per i
    /// messaggi testuali. Ultimo parametro con default per non rompere i call
    /// site esistenti dell'init membrowise.
    let gifUrl: String?

    init(
        id: String,
        uid: String,
        displayName: String,
        text: String,
        type: String,
        createdAt: Date?,
        reactions: [String: [String]],
        containsSpoiler: Bool = false,
        spoilerTitleIds: [String] = [],
        gifUrl: String? = nil
    ) {
        self.id = id
        self.uid = uid
        self.displayName = displayName
        self.text = text
        self.type = type
        self.createdAt = createdAt
        self.reactions = reactions
        self.containsSpoiler = containsSpoiler
        self.spoilerTitleIds = spoilerTitleIds
        self.gifUrl = gifUrl
    }

    /// True quando il messaggio è una GIF con URL valido.
    var isGif: Bool {
        type == "gif" && !(gifUrl ?? "").isEmpty
    }

    var displayText: String {
        TaggedTextFormatter.plainText(from: text) ?? text
    }
}

/// Risultato della ricerca GIF (callable `gifSearch`, backend Giphy).
struct GifResult: Identifiable, Hashable {
    let id: String
    let gifUrl: String
    let previewUrl: String
    let width: Int
    let height: Int
}

struct ThreadTypingUser: Identifiable, Hashable {
    let id: String
    let displayName: String
}
