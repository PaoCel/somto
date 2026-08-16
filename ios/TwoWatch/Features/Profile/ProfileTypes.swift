import SwiftUI

// Tipi e contorno del profilo: chrome delle card, link di condivisione, tab
// di connessioni e contenuti, filtri della sezione "Visti". Estratti da
// ProfileComponents.swift.

struct CardChromeModifier: ViewModifier {
    let isEnabled: Bool
    var padding: CGFloat = 18
    var cornerRadius: CGFloat = 26
    var background: Color = Color(hex: "#FCFBF6")
    var border: Color = Color.black.opacity(0.08)
    var shadowOpacity: Double = 0.10

    func body(content: Content) -> some View {
        if isEnabled {
            content
                .padding(padding)
                .background(background, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .stroke(border, lineWidth: 1)
                )
                .shadow(color: .black.opacity(shadowOpacity), radius: 18, y: 10)
        } else {
            content
        }
    }
}

/// URL pubblico del profilo (pagina web `user.html`), usato per lo `ShareLink`
/// nell'header. Distinto dallo share dell'immagine "Tempo di visione".
func profileShareURL(forUserID uid: String) -> URL? {
    var components = URLComponents(string: "https://somto.it/user.html")
    components?.queryItems = [URLQueryItem(name: "uid", value: uid)]
    return components?.url
}

enum ProfileConnectionsTab: String, CaseIterable, Identifiable {
    case followers
    case following

    var id: String { rawValue }

    var title: String {
        switch self {
        case .followers:
            return "Follower"
        case .following:
            return "Seguiti"
        }
    }

    var systemImage: String {
        switch self {
        case .followers:
            return "person.3.fill"
        case .following:
            return "person.crop.circle.badge.checkmark"
        }
    }
}

enum ProfileContentTab: String, CaseIterable, Identifiable {
    case watched
    case reviews
    case taste

    var id: String { rawValue }

    var title: String {
        switch self {
        case .watched:
            return "Visti"
        case .reviews:
            return "Attività"
        case .taste:
            return "Taste"
        }
    }

    var subtitle: String {
        switch self {
        case .watched:
            return "Libreria completa"
        case .reviews:
            return "Contributi alla community"
        case .taste:
            return "Gusto e segnali"
        }
    }
}

/// Filtro secondario per stato, ortogonale al filtro tipo (la strip categorie).
enum ProfileWatchedStatusFilter: String, CaseIterable, Identifiable {
    case all
    case inProgress
    case rated
    case rewatched

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all:
            return "Tutti"
        case .inProgress:
            return "In corso"
        case .rated:
            return "Votati"
        case .rewatched:
            return "Rivisti"
        }
    }
}

/// Filtro per fascia di voto nel tab "Visti".
///
/// Nasce da una richiesta precisa: guardando il profilo di un amico, poter
/// isolare "i film a cui ha dato 10" per vedere in un colpo i suoi preferiti.
/// Fasce e non soglie libere: sono un tocco, non un cursore da calibrare.
enum ProfileWatchedRatingFilter: String, CaseIterable, Identifiable {
    case all
    case ten
    case ninePlus
    case eightPlus
    case sevenPlus
    case belowSix

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: return "Ogni voto"
        case .ten: return "10"
        case .ninePlus: return "9+"
        case .eightPlus: return "8+"
        case .sevenPlus: return "7+"
        case .belowSix: return "Sotto 6"
        }
    }

    func matches(_ rating: Double?) -> Bool {
        guard self != .all else { return true }
        // Senza voto non si passa nessuna fascia: "9+" non deve restituire
        // titoli visti e mai votati.
        guard let rating else { return false }
        switch self {
        case .all: return true
        case .ten: return rating >= 10
        case .ninePlus: return rating >= 9
        case .eightPlus: return rating >= 8
        case .sevenPlus: return rating >= 7
        case .belowSix: return rating < 6
        }
    }
}

extension Title {
    var profileContentCategory: ContentCategory {
        let isAnimated = genres.contains { genre in
            let token = genre.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            return token == "tmdb_16"
                || token == "16"
                || token == "animation"
                || token == "animazione"
                || token == "anime"
                || token == "cartoon"
                || token == "cartoons"
                || token == "cartoni"
                || token == "cartoni animati"
                || token == "cartone animato"
                || token == "animated"
        }
        if isAnimated {
            return isJapaneseOriginTitle ? .anime : .cartoniAnimati
        }
        return type == .tv ? .serieTV : .film
    }

    var profileContentCategoryLabel: String {
        profileContentCategory.label
    }

    private var isJapaneseOriginTitle: Bool {
        let originalLanguage = metadata.originalLanguage?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if originalLanguage == "ja" || originalLanguage == "jpn" { return true }

        let language = metadata.language?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if language == "giapponese" || language == "japanese" { return true }

        let country = metadata.country?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if country == "giappone" || country == "japan" { return true }

        if metadata.originCountry.contains(where: { $0.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() == "JP" }) {
            return true
        }

        return keywords.contains { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "anime" }
    }
}
