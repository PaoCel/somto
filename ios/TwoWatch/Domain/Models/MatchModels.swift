import Foundation

enum MatchAction: String, CaseIterable, Identifiable {
    case dislike = "skip"
    case seen
    case like
    case superlike

    var id: String { rawValue }

    var title: String {
        switch self {
        case .dislike:
            return String(localized: "Non mi piace")
        case .seen:
            return String(localized: "Gia visto")
        case .like:
            return String(localized: "Like")
        case .superlike:
            return String(localized: "Superlike")
        }
    }

    var signalType: String {
        switch self {
        case .dislike:
            return "match_dislike"
        case .seen:
            return "match_seen"
        case .like:
            return "match_ok"
        case .superlike:
            return "match_love"
        }
    }
}

struct MatchCandidate: Identifiable, Hashable {
    let id: String
    let name: String
    let type: MediaType
    let year: Int?
    let overview: String
    let posterURL: URL?
    let genres: [String]
    let cast: [String]
    let reasons: [String]
    let score: Double
    let matchPercent: Int
    let ratingAvg: Double
    let ratingCount: Int

    var subtitle: String {
        if let year {
            return String(localized: "\(type.label) • \(year)")
        }
        return type.label
    }
}
