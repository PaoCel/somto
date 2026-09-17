import Foundation

enum UserLevel: String {
    case base
    case associate
    case doctor
}

enum CommunitySafetyPolicy {
    static let currentVersion = 1
    static let acceptanceSource = "ios_live_chat"
    static let termsURL = URL(string: "https://somto.it/terms.html")!
    static let supportURL = URL(string: "https://somto.it/support.html")!
}

enum SomtoWebLinks {
    static let blogURL = URL(string: "https://somto.it/blog/")!
    static let importURL = URL(string: "https://somto.it/import.html")!
}

struct UserStats: Hashable {
    var ratingsCount: Int
    var reviewsCount: Int
    var watchedCount: Int
    var totalWatchMinutes: Int
    var rewatchCount: Int = 0
    /// Voti serie DERIVATI dai voti episodio (privati): contati a parte da
    /// ratingsCount, mostrati come "+N dai tuoi voti episodio".
    var derivedRatingsCount: Int = 0
    var byCategory: [ContentCategory: CategoryActivity] = [:]
}

struct AppPermissionSet: Hashable {
    let isSignedIn: Bool
    let canSearchUsers: Bool
    let canAutoApproveTitles: Bool
    let canRunAdminTools: Bool

    static let guest = AppPermissionSet(
        isSignedIn: false,
        canSearchUsers: false,
        canAutoApproveTitles: false,
        canRunAdminTools: false
    )
}

/// Profilo proposto nello step "Segui qualcuno" dell'onboarding, con il motivo
/// per cui lo stiamo proponendo: `sharedTitleCount > 0` significa che ha in
/// libreria titoli che l'utente ha appena scelto.
struct SuggestedProfile: Identifiable, Hashable {
    let user: AppUser
    let sharedTitleCount: Int

    var id: String { user.id }
    var hasSharedTitles: Bool { sharedTitleCount > 0 }
}

struct AppUser: Identifiable, Hashable {
    let id: String
    let displayName: String
    let displayNameLower: String
    let photoURL: URL?
    let avatarURL: URL?
    let trusted: Bool
    let isAdmin: Bool
    let level: UserLevel
    let stats: UserStats
    let favoriteGenres: [String]
    let communitySafetyAcceptedAt: Date?
    let communitySafetyVersion: Int
    var accountType: String = "real_user"
    var isSynthetic: Bool = false
    var bio: String = ""
    /// Badge "Verificato" sul profilo. Segnale selettivo, NON legato a `trusted`
    /// (che e' il ruolo curatore): assegnato a chi lo merita, es. utenti che
    /// segnalano bug utili. Reso su profilo proprio e altrui (iOS + web).
    var verified: Bool = false

    /// Un profilo guidato (sintetico) di Somto: account non-umano usato per
    /// popolare e testare l'esperienza. Da segnalare con disclosure visibile.
    var isGuidedProfile: Bool {
        accountType == "guided_profile" || isSynthetic
    }

    var permissions: AppPermissionSet {
        AppPermissionSet(
            isSignedIn: true,
            canSearchUsers: true,
            // Aggiungere un titolo dal catalogo (import da TMDB via ricerca) e'
            // un'azione base per ogni utente loggato: le rules consentono
            // titles.create a isSignedIn(). Nessun gate trusted/level.
            canAutoApproveTitles: true,
            canRunAdminTools: isAdmin
        )
    }

    var canEditTitleEditorialContent: Bool {
        isAdmin || (trusted && level == .doctor)
    }

    var hasAcceptedCommunitySafetyTerms: Bool {
        guard let communitySafetyAcceptedAt else { return false }
        return communitySafetyAcceptedAt.timeIntervalSince1970 > 0
            && communitySafetyVersion >= CommunitySafetyPolicy.currentVersion
    }
}
