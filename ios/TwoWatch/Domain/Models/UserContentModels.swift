import Foundation

enum RatingDisplayFormatter {
    static func social(_ value: Double) -> String {
        let normalized = max(1, min(10, (value * 4).rounded() / 4))
        let base = Int(normalized.rounded(.down))
        let fraction = Int(((normalized - Double(base)) * 4).rounded())

        switch fraction {
        case 0:
            return "\(base)"
        case 1:
            return "\(base)+"
        case 2:
            return String(format: "%.1f", normalized)
        case 3:
            return "\(min(base + 1, 10))-"
        default:
            return "\(base)"
        }
    }
}

struct WatchlistEntry: Identifiable, Hashable {
    let id: String
    let titleId: String?
    let watchState: String
    let priority: String
    let addedAt: Date?
    let title: Title?
}

struct LibraryEntry: Identifiable, Hashable {
    let id: String
    let titleId: String
    let lastRating: Double?
    let ratedAt: Date?
    let seenAt: Date?
    let updatedAt: Date?
    let createdAt: Date?
    /// Stato titleStates proiettato (es. "in_progress", "completed_unrated", "rated",
    /// "seen_unrated"). Nil sui doc legacy scritti prima di questo campo.
    let state: String?
    /// Numero di run completi (rewatch inclusi) proiettato da `titleStates.completedCount`
    /// (`buildLegacyLibraryProjection`, `functions/lib/titleStates.js`). 0/assente sui doc
    /// legacy: badge rewatch (`completedCount > 1`) semplicemente non appare.
    /// `var` con default: incluso nell'init memberwise (i preview lo omettono,
    /// il repo lo passa esplicito; un `let` con default sarebbe escluso).
    var completedCount: Int = 0
    let title: Title?

    var hasRating: Bool {
        lastRating != nil
    }

    /// Vero per le serie ancora in corso (non finite): il badge primario deve
    /// dire "In corso" invece di "Visto", altrimenti sembrerebbe completata.
    var isInProgress: Bool {
        lastRating == nil && state?.lowercased() == "in_progress"
    }

    /// Titolo davvero **finito**, con la stessa regola del contatore "Visti"
    /// (`computeUserStatsContribution` in functions/lib/titleStates.js):
    /// un run completo, oppure uno stato di visione conclusa.
    /// I doc legacy senza `state` valgono come visti: la proiezione `library`
    /// nasceva solo per i titoli finiti, le serie in corso sono arrivate dopo
    /// insieme al campo.
    var isCompletedWatch: Bool {
        if completedCount > 0 { return true }
        guard let raw = state?.lowercased(), !raw.isEmpty else { return true }
        return raw == "seen_unrated" || raw == "rated" || raw == "completed_unrated"
    }

    var activitySortDate: Date {
        [ratedAt, seenAt, updatedAt, createdAt]
            .compactMap { $0 }
            .max() ?? .distantPast
    }

    var formattedRating: String? {
        guard let lastRating else { return nil }
        return RatingDisplayFormatter.social(lastRating)
    }
}

struct ProfileReviewEntry: Identifiable, Hashable {
    let id: String
    let titleId: String
    let rating: Double
    let reviewText: String
    let updatedAt: Date?
    let title: Title?
    /// Livello del voto (`title` / `season` / `episode`), come da `ratings.level`.
    /// Default "title" per compatibilità coi doc legacy senza il campo.
    /// `var` con default: incluso nell'init memberwise (vedi nota su LibraryEntry).
    var level: String = "title"
    /// Presenti solo per `level in {season, episode}`, altrimenti nil.
    var season: Int? = nil
    var episode: Int? = nil

    var sortDate: Date {
        updatedAt ?? .distantPast
    }

    var formattedRating: String {
        RatingDisplayFormatter.social(rating)
    }

    /// Contesto leggibile per la UI ("Stagione N" / "Episodio N", eventualmente
    /// combinati) quando la review non è a livello titolo.
    var levelContextLabel: String? {
        switch (level, season, episode) {
        case ("episode", .some(let s), .some(let e)):
            return "S\(s)E\(e)"
        case ("season", .some(let s), _):
            return "Stagione \(s)"
        default:
            return nil
        }
    }
}

/// Macro-categoria di un titolo. I raw value combaciano con il campo
/// derivato lato server da `deriveContentCategory`.
enum ContentCategory: String, CaseIterable, Hashable {
    case film
    case serieTV = "serie_tv"
    case cartoniAnimati = "cartoni_animati"
    case anime

    var label: String {
        switch self {
        case .film: return String(localized: "category.movies", defaultValue: "Film")
        case .serieTV: return String(localized: "Serie TV")
        case .cartoniAnimati: return String(localized: "Cartoni")
        case .anime: return String(localized: "Anime")
        }
    }
}

/// Contatori attività di una singola categoria (una voce di `stats.byCategory`).
struct CategoryActivity: Hashable {
    let watchedCount: Int
    let ratingsCount: Int
    let totalWatchMinutes: Int
    let rewatchCount: Int

    static let empty = CategoryActivity(
        watchedCount: 0,
        ratingsCount: 0,
        totalWatchMinutes: 0,
        rewatchCount: 0
    )
}

extension CategoryActivity {
    /// Parsa una mappa `byCategory` (cache stats o risposta del callable) in un
    /// dizionario tipato; le categorie assenti restano fuori dal dizionario.
    static func breakdown(from raw: Any?) -> [ContentCategory: CategoryActivity] {
        let byCategory = FirestoreValueReader.map(raw)
        var result: [ContentCategory: CategoryActivity] = [:]
        for category in ContentCategory.allCases {
            let bucket = FirestoreValueReader.map(byCategory[category.rawValue])
            guard !bucket.isEmpty else { continue }
            result[category] = CategoryActivity(
                watchedCount: FirestoreValueReader.int(bucket, key: "watchedCount") ?? 0,
                ratingsCount: FirestoreValueReader.int(bucket, key: "ratingsCount") ?? 0,
                totalWatchMinutes: FirestoreValueReader.int(bucket, key: "totalWatchMinutes") ?? 0,
                rewatchCount: FirestoreValueReader.int(bucket, key: "rewatchCount") ?? 0
            )
        }
        return result
    }
}

struct ProfileActivitySummary: Hashable {
    let ratedTitlesCount: Int
    let watchedTitlesCount: Int
    let totalWatchMinutes: Int
    /// Voti serie derivati dai voti episodio (privato, solo profilo proprio).
    let derivedRatingsCount: Int
    let byCategory: [ContentCategory: CategoryActivity]

    init(
        ratedTitlesCount: Int,
        watchedTitlesCount: Int,
        totalWatchMinutes: Int,
        derivedRatingsCount: Int = 0,
        byCategory: [ContentCategory: CategoryActivity] = [:]
    ) {
        self.ratedTitlesCount = ratedTitlesCount
        self.watchedTitlesCount = watchedTitlesCount
        self.totalWatchMinutes = totalWatchMinutes
        self.derivedRatingsCount = derivedRatingsCount
        self.byCategory = byCategory
    }

    static let empty = ProfileActivitySummary(
        ratedTitlesCount: 0,
        watchedTitlesCount: 0,
        totalWatchMinutes: 0
    )

    /// True quando almeno una categoria ha titoli visti.
    var hasCategoryBreakdown: Bool {
        byCategory.values.contains { $0.watchedCount > 0 }
    }

    var formattedWatchTime: String {
        let safeMinutes = max(0, totalWatchMinutes)
        let days = safeMinutes / 1_440
        let hours = (safeMinutes % 1_440) / 60
        let minutes = safeMinutes % 60

        if days > 0 {
            if hours > 0 {
                return String(localized: "\(days) g \(hours) h")
            }
            return String(localized: "\(days) g")
        }

        if hours > 0 {
            if minutes > 0 {
                return String(localized: "\(hours) h \(minutes) min")
            }
            return String(localized: "\(hours) h")
        }

        return String(localized: "\(minutes) min")
    }
}

struct UserSummary: Identifiable, Hashable {
    let id: String
    let displayName: String
    let photoURL: URL?
}

struct FeedTaggedUser: Identifiable, Hashable {
    let id: String
    let displayName: String
}

struct FeedTaggedGroup: Identifiable, Hashable {
    let id: String
    let groupName: String
}

struct FeedSharedPost: Hashable {
    let postId: String
    let author: UserSummary
    let text: String
    let titleId: String?

    var displayText: String {
        TaggedTextFormatter.plainText(from: text) ?? text
    }
}

enum FeedActivityKind: String, Hashable {
    case rating
    case watchTogether = "watch_together"
    case post
    case postShare = "post_share"
    case recommendation
    case follow
    case postComment = "post_comment"
    case seriesStarted = "series_started"
    /// Commento su film / serie / episodio, eco di un messaggio di thread
    /// pubblico (`posts` con `visibility:"comment"`, vedi
    /// functions/lib/commentEcho.js). Non arriva da `feedEvents`: è costruito
    /// lato client da `PostsRepository.listCommentActivities`.
    case titleComment = "title_comment"
}

struct FeedActivity: Identifiable, Hashable {
    let id: String
    let kind: FeedActivityKind
    let actor: UserSummary
    let relatedUser: UserSummary?
    let title: Title?
    let titleId: String?
    let postId: String?
    let recommendationId: String?
    let sourceId: String?
    let sourcePath: String?
    let rating: Double?
    let previousRating: Double?
    var level: String = "title"
    var season: Int?
    var episode: Int?
    let text: String?
    let snippet: String?
    let reviewText: String?
    let taggedTitles: [Title]
    let mediaURL: URL?
    let mediaURLs: [URL]
    let watchedWith: [FeedTaggedUser]
    let watchedWithGroup: FeedTaggedGroup?
    let sharedPost: FeedSharedPost?
    let createdAt: Date?
    let webURL: URL?

    var primarySourceText: String? {
        if let reviewText, !reviewText.isEmpty {
            return reviewText
        }
        if let text, !text.isEmpty {
            return text
        }
        if let snippet, !snippet.isEmpty {
            return snippet
        }
        return nil
    }

    var primaryText: String? {
        TaggedTextFormatter.plainText(from: primarySourceText)
    }

    var resolvedPostID: String? {
        if let postId, !postId.isEmpty {
            return postId
        }

        if let sourcePath, sourcePath.hasPrefix("posts/") {
            return sourcePath.split(separator: "/").last.map(String.init)
        }

        if (kind == .rating || kind == .watchTogether),
           let titleId,
           !titleId.isEmpty {
            if kind == .rating, level == "season", let season {
                return "rating::\(actor.id)::\(titleId)::season::\(season)"
            }
            if kind == .rating, level == "episode", let season, let episode {
                return "rating::\(actor.id)::\(titleId)::episode::\(season)::\(episode)"
            }
            return "rating::\(actor.id)::\(titleId)"
        }

        return nil
    }

    var actionText: String {
        switch kind {
        case .rating:
            if level == "season", let season {
                return String(localized: "ha terminato la stagione \(season)")
            }
            if level == "episode", let season, let episode {
                return String(localized: "ha visto S\(season) E\(episode)")
            }
            return String(localized: "ha votato")
        case .watchTogether:
            return String(localized: "ha visto un titolo con amici")
        case .post:
            return String(localized: "ha pubblicato un post")
        case .postShare:
            return String(localized: "ha condiviso un post")
        case .recommendation:
            return String(localized: "ha consigliato un titolo")
        case .follow:
            return String(localized: "ha iniziato a seguire")
        case .postComment:
            return String(localized: "ha commentato un post")
        case .seriesStarted:
            return String(localized: "ha iniziato a guardare una serie")
        case .titleComment:
            return String(localized: "ha commentato")
        }
    }
}

enum AppDestination: Hashable {
    case notifications
    case threads
    case thread(id: String)
    case watchlist
    /// Come si usa il widget. Ci si arriva solo dal widget stesso
    /// (`somto.it/widget`): e' li' che nasce la domanda.
    case widgetGuide
    case profileInbox
    case profile(uid: String)
    case title(id: String, focus: String?)
    /// Pagina titolo pubblica SSR (`/film/{slug}`, `/serie/{slug}`): porta lo
    /// slug SEO, non il doc id. Va risolto in `.title` prima di navigare.
    case titleSlug(slug: String, focus: String?)
    case post(id: String)
    case quizChallenges
    case titlesImport(importId: String?)
    /// External quiz-invite share link (`/quiz/invite/{token}`).
    case quizInvite(token: String)
    /// Public shared list share link (`/lista/{slug}`).
    case publicList(slug: String)
    case web(URL)
}

extension AppDestination {
    var requiresAuthenticatedSession: Bool {
        switch self {
        case .title, .titleSlug, .web, .widgetGuide:
            return false
        default:
            return true
        }
    }
}

struct AppNotification: Identifiable, Hashable {
    let id: String
    let type: String
    let fromUid: String?
    let toUid: String?
    var read: Bool
    let createdAt: Date?
    let title: String
    let text: String?
    let icon: String
    let avatarURL: URL?
    let avatarText: String
    let destination: AppDestination
}

// MARK: - Engagement notification types (server-side + local hints)

enum EngagementNotificationType: String {
    /// A friend watched a title you might like
    case friendWatched = "engagement_friend_watched"
    /// A friend added something to their watchlist
    case friendWatchlistAdd = "engagement_friend_watchlist_add"
    /// New personalized suggestions available
    case newSuggestions = "engagement_new_suggestions"
    /// You have unwatched titles in your watchlist
    case watchlistReminder = "engagement_watchlist_reminder"
    /// Friends have new activity
    case friendActivity = "engagement_friend_activity"
}

enum EngagementNotificationFactory {
    static func watchlistReminder(watchlistCount: Int) -> AppNotification? {
        guard watchlistCount >= 3 else { return nil }
        return AppNotification(
            id: "engagement_watchlist_\(Date().timeIntervalSince1970)",
            type: EngagementNotificationType.watchlistReminder.rawValue,
            fromUid: nil,
            toUid: nil,
            read: false,
            createdAt: Date(),
            title: String(localized: "Hai \(watchlistCount) titoli in watchlist da recuperare"),
            text: String(localized: "Trova il momento giusto per il prossimo titolo dalla tua lista."),
            icon: "bookmark.fill",
            avatarURL: nil,
            avatarText: "📺",
            destination: .watchlist
        )
    }

    static func friendWatched(friendName: String, titleName: String, titleID: String) -> AppNotification {
        AppNotification(
            id: "engagement_fw_\(Date().timeIntervalSince1970)",
            type: EngagementNotificationType.friendWatched.rawValue,
            fromUid: nil,
            toUid: nil,
            read: false,
            createdAt: Date(),
            title: "\(friendName) ha visto \(titleName)",
            text: String(localized: "Potrebbe interessarti. Dai un'occhiata!"),
            icon: "eye.fill",
            avatarURL: nil,
            avatarText: String(friendName.prefix(1)).uppercased(),
            destination: .title(id: titleID, focus: nil)
        )
    }

    static func friendActivity(count: Int) -> AppNotification? {
        guard count > 0 else { return nil }
        return AppNotification(
            id: "engagement_fa_\(Date().timeIntervalSince1970)",
            type: EngagementNotificationType.friendActivity.rawValue,
            fromUid: nil,
            toUid: nil,
            read: false,
            createdAt: Date(),
            title: String(localized: "\(count) nuove attività dai tuoi amici"),
            text: "Scopri cosa hanno visto e recensito di recente.",
            icon: "person.2.fill",
            avatarURL: nil,
            avatarText: "👥",
            destination: .notifications
        )
    }
}
