import Foundation

struct Genre: Identifiable, Hashable {
    let id: String
    let name: String
    let nameLower: String
}

struct Person: Identifiable, Hashable {
    let id: String
    let name: String
    let nameLower: String
    let avatarURL: URL?
    let roles: [String]
    let occurrences: Int
}

struct TitleCreditPerson: Identifiable, Hashable {
    let personID: String?
    let name: String
    let nameLower: String
    let avatarURL: URL?
    let roles: [String]
    let occurrences: Int
    let primaryRole: String
    var character: String? = nil

    var id: String {
        personID ?? "\(primaryRole)-\(nameLower)"
    }

    var roleLabel: String {
        switch primaryRole {
        case "director":
            return String(localized: "Regia")
        case "actor":
            return String(localized: "Cast")
        default:
            return primaryRole.capitalized
        }
    }

    var navigationPerson: Person? {
        guard let personID, !personID.isEmpty else { return nil }
        return Person(
            id: personID,
            name: name,
            nameLower: nameLower,
            avatarURL: avatarURL,
            roles: roles.isEmpty ? [primaryRole] : roles,
            occurrences: occurrences
        )
    }
}

struct TitleCredits: Hashable {
    let directors: [TitleCreditPerson]
    let cast: [TitleCreditPerson]
}

struct TMDBSearchResult: Identifiable, Hashable {
    let id: String
    let tmdbId: Int
    let mediaType: MediaType
    let title: String
    let originalTitle: String
    let year: Int?
    let overview: String
    let posterURL: URL?
    let genreIds: [Int]
}

struct TitleSearchResults: Hashable {
    let titles: [Title]
    let tmdbResults: [TMDBSearchResult]

    static let empty = TitleSearchResults(titles: [], tmdbResults: [])
}
