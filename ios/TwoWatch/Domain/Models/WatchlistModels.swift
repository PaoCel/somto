import Foundation

enum MoviePersonalStatus: String, CaseIterable, Hashable {
    case unseen
    case seenUnrated = "seen_unrated"
    case rated
}

enum SeriesPersonalStatus: String, CaseIterable, Hashable {
    case notStarted = "not_started"
    case inProgress = "in_progress"
    case completedUnrated = "completed_unrated"
    case rated
}

enum UserListVisibility: String, CaseIterable, Hashable, Identifiable {
    case `private`
    case `public`
    case shared

    var id: String { rawValue }

    var label: String {
        switch self {
        case .private:
            return String(localized: "Privata")
        case .public:
            return String(localized: "Pubblica")
        case .shared:
            return String(localized: "Condivisa")
        }
    }

    var symbolName: String {
        switch self {
        case .private:
            return "lock.fill"
        case .public:
            return "globe.europe.africa.fill"
        case .shared:
            return "person.2.fill"
        }
    }
}

enum UserListKind: String, CaseIterable, Hashable, Identifiable {
    case collection
    case orderedPath = "ordered_path"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .collection:
            return String(localized: "Raccolta")
        case .orderedPath:
            return String(localized: "Percorso")
        }
    }

    var symbolName: String {
        switch self {
        case .collection:
            return "square.grid.2x2.fill"
        case .orderedPath:
            return "point.3.connected.trianglepath.dotted"
        }
    }
}

enum UserListMemberRole: String, Hashable {
    case owner
    case editor
    case viewer

    var canEdit: Bool {
        self == .owner || self == .editor
    }

    var label: String {
        switch self {
        case .owner:
            return String(localized: "Owner")
        case .editor:
            return String(localized: "Collaboratore")
        case .viewer:
            return String(localized: "Viewer")
        }
    }
}

struct TitleSeriesProgress: Hashable {
    let episodesWatchedCount: Int
    let seasonsCompletedCount: Int
    let totalEpisodeCount: Int?
    let totalSeasonCount: Int?
    let lastWatchedEpisodeId: String?
    let lastWatchedEpisodeName: String?
    let lastWatchedSeasonNumber: Int?
    let lastWatchedEpisodeNumber: Int?
    let lastWatchedAt: Date?
    let percentComplete: Double?
    /// Stato personale (`in_progress` / `completed_unrated` / `rated` …) quando il
    /// progresso arriva da `getPublicProfileSeriesProgress`, che lo include nella
    /// stessa mappa. `nil` quando non noto (es. sotto-oggetto seriesProgress di un
    /// watcher, dove lo stato è un campo fratello). Serve a distinguere "Completa".
    var contextState: String? = nil

    static let empty = TitleSeriesProgress(
        episodesWatchedCount: 0,
        seasonsCompletedCount: 0,
        totalEpisodeCount: nil,
        totalSeasonCount: nil,
        lastWatchedEpisodeId: nil,
        lastWatchedEpisodeName: nil,
        lastWatchedSeasonNumber: nil,
        lastWatchedEpisodeNumber: nil,
        lastWatchedAt: nil,
        percentComplete: nil
    )

    /// Decoder difensivo da una mappa `[String: Any]` (es. risposta callable
    /// `getPublicProfileSeriesProgress` / `getTitleWatchersProgress`). I numeri
    /// arrivano come `NSNumber` via `JSONSerialization`, gestiti da
    /// `FirestoreValueReader`. Restituisce sempre un valore valido.
    static func fromMap(_ map: [String: Any]) -> TitleSeriesProgress {
        TitleSeriesProgress(
            episodesWatchedCount: FirestoreValueReader.int(map, key: "episodesWatchedCount") ?? 0,
            seasonsCompletedCount: FirestoreValueReader.int(map, key: "seasonsCompletedCount") ?? 0,
            totalEpisodeCount: FirestoreValueReader.int(map, key: "totalEpisodeCount"),
            totalSeasonCount: FirestoreValueReader.int(map, key: "totalSeasonCount"),
            lastWatchedEpisodeId: FirestoreValueReader.string(map, key: "lastWatchedEpisodeId"),
            lastWatchedEpisodeName: FirestoreValueReader.string(map, key: "lastWatchedEpisodeName"),
            lastWatchedSeasonNumber: FirestoreValueReader.int(map, key: "lastWatchedSeasonNumber"),
            lastWatchedEpisodeNumber: FirestoreValueReader.int(map, key: "lastWatchedEpisodeNumber"),
            lastWatchedAt: FirestoreValueReader.date(map["lastWatchedAt"]),
            percentComplete: FirestoreValueReader.double(map, key: "percentComplete"),
            contextState: FirestoreValueReader.string(map, key: "state")
        )
    }

    /// Etichetta compatta "a che punto è" questo utente nella serie.
    /// - in corso → `S{stagione}·E{episodio}` (fallback `{percent}%`)
    /// - completata → `Completa`
    /// - altrimenti → nil (nessun badge)
    func progressBadgeLabel(state: String) -> String? {
        switch state {
        case SeriesPersonalStatus.completedUnrated.rawValue, SeriesPersonalStatus.rated.rawValue:
            return String(localized: "Completa")
        case SeriesPersonalStatus.inProgress.rawValue:
            // Guardie > 0 ovunque: i doc storici possono avere 0 letterali o
            // percentComplete == 0 (import "in corso a zero") — "S0·E0" e "0%"
            // sono nonsense, meglio nessun badge (come la PWA).
            if let season = lastWatchedSeasonNumber, season > 0,
               let episode = lastWatchedEpisodeNumber, episode > 0 {
                return String(localized: "S\(season)·E\(episode)")
            }
            if let percent = percentComplete, percent > 0 {
                let clamped = max(0, min(1, percent))
                return String(localized: "\(max(1, Int((clamped * 100).rounded())))%")
            }
            if let season = lastWatchedSeasonNumber, season > 0 {
                return String(localized: "S\(season)")
            }
            return nil
        default:
            // Stato sconosciuto / non-not_started: prova comunque S·E poi %.
            if state == SeriesPersonalStatus.notStarted.rawValue { return nil }
            if let season = lastWatchedSeasonNumber, season > 0,
               let episode = lastWatchedEpisodeNumber, episode > 0 {
                return String(localized: "S\(season)·E\(episode)")
            }
            if let percent = percentComplete, percent > 0 {
                let clamped = max(0, min(1, percent))
                return String(localized: "\(max(1, Int((clamped * 100).rounded())))%")
            }
            return nil
        }
    }
}

/// Traduce gli errori Firestore mostrati all'utente: il permission-denied
/// grezzo dell'SDK ("Missing or insufficient permissions.") non spiega nulla.
/// Stessa copy della PWA (`describeSaveError` in lists-editor.page.js).
func friendlyFirestoreErrorMessage(_ error: Error) -> String {
    let nsError = error as NSError
    let isPermissionDenied = (nsError.domain == "FIRFirestoreErrorDomain" && nsError.code == 7)
        || nsError.localizedDescription.localizedCaseInsensitiveContains("permission")
    if isPermissionDenied {
        return String(localized: "Non hai i permessi per questa operazione. Riprova o contatta l'assistenza.")
    }
    // Il fallback passa dal mapper comune: prima tornava la stringa grezza
    // dell'SDK, cioe' esattamente cio' che questa funzione esiste per evitare.
    return UserFacingError.message(for: error)
}

/// Uno spettatore (amico / seguito del viewer) che sta guardando una serie,
/// con il suo avanzamento. Sorgente: callable `getTitleWatchersProgress`.
struct TitleWatcher: Identifiable, Hashable {
    let uid: String
    let displayName: String
    let photoURL: String?
    let isSynthetic: Bool
    let state: String
    let progress: TitleSeriesProgress?

    var id: String { uid }

    var photoImageURL: URL? {
        guard let photoURL, !photoURL.isEmpty else { return nil }
        return URL(string: photoURL)
    }

    var isInProgress: Bool {
        state == SeriesPersonalStatus.inProgress.rawValue
    }

    /// Chip "a che punto è": S·E / Completa / % — nil se nessun dato.
    var progressChipLabel: String? {
        if let label = progress?.progressBadgeLabel(state: state) {
            return label
        }
        switch state {
        case SeriesPersonalStatus.completedUnrated.rawValue, SeriesPersonalStatus.rated.rawValue:
            return String(localized: "Completa")
        default:
            return nil
        }
    }
}

struct TitleReminderHints: Hashable {
    let ratingReminderEligible: Bool
    let resumeReminderEligible: Bool
    let lastProgressAt: Date?
    let suggestedReminderAt: Date?

    static let empty = TitleReminderHints(
        ratingReminderEligible: false,
        resumeReminderEligible: false,
        lastProgressAt: nil,
        suggestedReminderAt: nil
    )
}

enum PublicListProgressStatus: String, Hashable {
    case notStarted = "not_started"
    case inProgress = "in_progress"
    case completed
}

struct PublicListItemProgress: Hashable {
    let listId: String
    let titleId: String
    let mediaType: MediaType
    let status: PublicListProgressStatus
    let seriesProgress: TitleSeriesProgress?
    let completedAt: Date?
    let updatedAt: Date?
    let lastInteractionAt: Date?
    let watchMinutesContribution: Int

    var isCompleted: Bool {
        status == .completed
    }

    var isInProgressSeries: Bool {
        mediaType == .tv && status == .inProgress
    }

    var statusTitle: String {
        switch mediaType {
        case .movie:
            return isCompleted ? String(localized: "Visto in questa lista") : String(localized: "Da vedere in questa lista")
        case .tv:
            switch status {
            case .notStarted:
                return String(localized: "Non iniziata in questa lista")
            case .inProgress:
                return String(localized: "In corso in questa lista")
            case .completed:
                return String(localized: "Completata in questa lista")
            }
        }
    }

    var statusSubtitle: String {
        switch mediaType {
        case .movie:
            return isCompleted ? String(localized: "Segnato come visto nel percorso pubblico.") : String(localized: "Ancora da segnare nel percorso pubblico.")
        case .tv:
            if let seriesProgress, status == .inProgress {
                let watched = max(0, seriesProgress.episodesWatchedCount)
                if let total = seriesProgress.totalEpisodeCount, total > 0 {
                    return String(localized: "\(watched)/\(total) episodi")
                }
                return String(localized: "\(watched) episodi visti")
            }
            switch status {
            case .notStarted:
                return String(localized: "Ancora da iniziare in questo percorso.")
            case .inProgress:
                return String(localized: "Serie in corso dentro questa lista.")
            case .completed:
                return String(localized: "Serie completata per questa lista.")
            }
        }
    }

    var progressText: String? {
        guard mediaType == .tv, let seriesProgress else { return nil }

        if let percentComplete = seriesProgress.percentComplete {
            let clamped = max(0, min(1, percentComplete))
            return String(localized: "\(Int((clamped * 100).rounded()))%")
        }

        let watched = max(0, seriesProgress.episodesWatchedCount)
        if watched == 0 { return nil }
        return String(localized: "\(watched) episodi")
    }
}

struct TitlePersonalState: Identifiable, Hashable {
    let id: String
    let titleId: String
    let mediaType: MediaType
    let generalWatchlist: Bool
    let rewatchIntent: Bool
    let movieStatus: MoviePersonalStatus?
    let seriesStatus: SeriesPersonalStatus?
    let seriesProgress: TitleSeriesProgress?
    let ratingValue: Double?
    let hasTitleRating: Bool
    let seenAt: Date?
    let completedAt: Date?
    let ratedAt: Date?
    let rewatchAddedAt: Date?
    let createdAt: Date?
    let updatedAt: Date?
    let lastInteractionAt: Date?
    let source: String?
    let reminderHints: TitleReminderHints
    let completedCount: Int
    let watchMinutesContribution: Int
    let completedAtTotalEpisodes: Int?
    let completedAtTotalSeasons: Int?
    let hasNewContent: Bool
    let latestSeasonNumber: Int?
    let latestSeasonAirDate: String?
    let newContentDetectedAt: Date?
    let title: Title?

    init(
        id: String,
        titleId: String,
        mediaType: MediaType,
        generalWatchlist: Bool,
        rewatchIntent: Bool,
        movieStatus: MoviePersonalStatus?,
        seriesStatus: SeriesPersonalStatus?,
        seriesProgress: TitleSeriesProgress?,
        ratingValue: Double?,
        hasTitleRating: Bool,
        seenAt: Date?,
        completedAt: Date?,
        ratedAt: Date?,
        rewatchAddedAt: Date?,
        createdAt: Date?,
        updatedAt: Date?,
        lastInteractionAt: Date?,
        source: String?,
        reminderHints: TitleReminderHints,
        completedCount: Int = 0,
        watchMinutesContribution: Int = 0,
        completedAtTotalEpisodes: Int? = nil,
        completedAtTotalSeasons: Int? = nil,
        hasNewContent: Bool = false,
        latestSeasonNumber: Int? = nil,
        latestSeasonAirDate: String? = nil,
        newContentDetectedAt: Date? = nil,
        title: Title?
    ) {
        self.id = id
        self.titleId = titleId
        self.mediaType = mediaType
        self.generalWatchlist = generalWatchlist
        self.rewatchIntent = rewatchIntent
        self.movieStatus = movieStatus
        self.seriesStatus = seriesStatus
        self.seriesProgress = seriesProgress
        self.ratingValue = ratingValue
        self.hasTitleRating = hasTitleRating
        self.seenAt = seenAt
        self.completedAt = completedAt
        self.ratedAt = ratedAt
        self.rewatchAddedAt = rewatchAddedAt
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.lastInteractionAt = lastInteractionAt
        self.source = source
        self.reminderHints = reminderHints
        self.completedCount = completedCount
        self.watchMinutesContribution = watchMinutesContribution
        self.completedAtTotalEpisodes = completedAtTotalEpisodes
        self.completedAtTotalSeasons = completedAtTotalSeasons
        self.hasNewContent = hasNewContent
        self.latestSeasonNumber = latestSeasonNumber
        self.latestSeasonAirDate = latestSeasonAirDate
        self.newContentDetectedAt = newContentDetectedAt
        self.title = title
    }

    var statusValue: String {
        switch mediaType {
        case .movie:
            return (movieStatus ?? .unseen).rawValue
        case .tv:
            return (seriesStatus ?? .notStarted).rawValue
        }
    }

    var isAwaitingRating: Bool {
        switch mediaType {
        case .movie:
            return movieStatus == .seenUnrated
        case .tv:
            return seriesStatus == .completedUnrated
        }
    }

    var hasStartedWatching: Bool {
        switch mediaType {
        case .movie:
            return movieStatus == .seenUnrated || movieStatus == .rated
        case .tv:
            return seriesStatus == .inProgress
                || seriesStatus == .completedUnrated
                || seriesStatus == .rated
        }
    }

    var isCompleted: Bool {
        switch mediaType {
        case .movie:
            return movieStatus == .seenUnrated || movieStatus == .rated
        case .tv:
            return seriesStatus == .completedUnrated || seriesStatus == .rated
        }
    }

    var isRated: Bool {
        hasTitleRating || ratingValue != nil || movieStatus == .rated || seriesStatus == .rated
    }

    var isInRewatch: Bool {
        rewatchIntent && hasStartedWatching
    }

    var isInProgressSeries: Bool {
        mediaType == .tv && seriesStatus == .inProgress
    }

    var isInToWatchQueue: Bool {
        // Tieni il titolo in "Da vedere" finché non è completo (tutti gli episodi/stagioni)
        // o finché l'utente non lo rimuove esplicitamente. Le serie in corso restano qui
        // perché il server preserva `generalWatchlist` fino al completamento
        // (fix in functions/lib/titleStates.js, commit 82ea25e): `generalWatchlist` è la
        // fonte unica di verità, così "rimuovi dalla watchlist" resta coerente ovunque.
        generalWatchlist && !isCompleted
    }

    var statusTitle: String {
        switch mediaType {
        case .movie:
            switch movieStatus ?? .unseen {
            case .unseen:
                return String(localized: "Da vedere")
            case .seenUnrated:
                return String(localized: "Visto")
            case .rated:
                return String(localized: "Visto e votato")
            }
        case .tv:
            switch seriesStatus ?? .notStarted {
            case .notStarted:
                return String(localized: "Da vedere")
            case .inProgress:
                return String(localized: "In corso")
            case .completedUnrated:
                return hasNewContent ? "In pari • Nuova stagione" : "In pari"
            case .rated:
                return hasNewContent ? "In pari • Nuova stagione" : "In pari · Votata"
            }
        }
    }

    /// Pill simplificata per il selettore di stato delle serie: 3 valori (notStarted/inProgress/caughtUp).
    var seriesSegmentedStatus: SeriesPersonalStatus {
        switch seriesStatus ?? .notStarted {
        case .notStarted: return .notStarted
        case .inProgress: return .inProgress
        case .completedUnrated, .rated: return .completedUnrated
        }
    }

    var canResumeFromNewContent: Bool {
        mediaType == .tv && hasNewContent && (seriesStatus == .completedUnrated || seriesStatus == .rated)
    }

    var statusSubtitle: String {
        switch mediaType {
        case .movie:
            if isRated, let ratingValue {
                return String(localized: "Hai gia dato \(RatingDisplayFormatter.social(ratingValue))")
            }
            return generalWatchlist ? String(localized: "Nella watchlist generale") : String(localized: "Fuori dalla watchlist")
        case .tv:
            if let seriesProgress, seriesStatus == .inProgress {
                let watched = max(0, seriesProgress.episodesWatchedCount)
                if let total = seriesProgress.totalEpisodeCount, total > 0 {
                    return String(localized: "\(watched)/\(total) episodi")
                }
                return String(localized: "\(watched) episodi visti")
            }
            if isRated, let ratingValue {
                return String(localized: "Hai gia dato \(RatingDisplayFormatter.social(ratingValue))")
            }
            return generalWatchlist ? String(localized: "Percorso ancora attivo") : String(localized: "Percorso chiuso")
        }
    }

    var progressText: String? {
        guard mediaType == .tv, let seriesProgress else { return nil }

        if let percentComplete = seriesProgress.percentComplete {
            let clamped = max(0, min(1, percentComplete))
            return String(localized: "\(Int((clamped * 100).rounded()))%")
        }

        let watched = max(0, seriesProgress.episodesWatchedCount)
        if watched == 0 { return nil }
        return String(localized: "\(watched) episodi")
    }
}

struct UserListCover: Hashable {
    let imageURL: URL?
    let storagePath: String?
    let fallbackTitleIds: [String]
    let accentHex: String?
}

struct UserListSummary: Identifiable, Hashable {
    let id: String
    let title: String
    let description: String?
    let visibility: UserListVisibility
    let kind: UserListKind
    let ownerUid: String
    let owner: UserSummary?
    let memberUids: [String]
    let editorUids: [String]
    let cover: UserListCover
    let itemCount: Int
    let completedCount: Int
    let followersCount: Int
    let createdAt: Date?
    let updatedAt: Date?
    let isOwnedByCurrentUser: Bool
    let canEdit: Bool
    let isSavedByCurrentUser: Bool
    let previewTitles: [Title]
    /// Pretty, indexable slug for the public list page (`/lista/{slug}`). User
    /// lists store it on `slug`; editorial lists reuse `editorialSlug`.
    var slug: String? = nil
    /// Editorial-only slug (legacy). Used as the share/deep-link slug when
    /// `slug` is missing.
    var editorialSlug: String? = nil

    var progressFraction: Double {
        guard itemCount > 0 else { return 0 }
        return min(1, max(0, Double(completedCount) / Double(itemCount)))
    }

    var progressText: String {
        guard itemCount > 0 else { return String(localized: "Vuota") }
        return String(localized: "\(completedCount)/\(itemCount)")
    }

    /// Slug used to build the public share URL `https://somto.it/lista/{...}`,
    /// falling back to the document id when no slug is available.
    var shareSlug: String {
        slug ?? editorialSlug ?? id
    }

    /// Public share URL for this list. Only meaningful when `visibility` is public.
    var shareURL: URL? {
        URL(string: "https://somto.it/lista/\(shareSlug)")
    }
}

struct UserListMember: Identifiable, Hashable {
    let id: String
    let displayName: String
    let photoURL: URL?
    let role: UserListMemberRole
    let joinedAt: Date?

    var canEdit: Bool {
        role.canEdit
    }
}

struct UserListItem: Identifiable, Hashable {
    let id: String
    let titleId: String
    let orderIndex: Int
    let addedByUid: String?
    let note: String?
    let addedAt: Date?
    let updatedAt: Date?
    let title: Title?
    let personalState: TitlePersonalState?
    let publicProgress: PublicListItemProgress?

    var completionText: String {
        if let publicProgress {
            return publicProgress.statusTitle
        }
        guard let personalState else { return String(localized: "Non iniziato") }
        return personalState.statusTitle
    }
}

struct UserListProgressSummary: Identifiable, Hashable {
    let id: String
    let uid: String
    let displayName: String
    let photoURL: URL?
    let completedCount: Int
    let totalCount: Int
    let percentComplete: Double
    let lastCompletedTitleId: String?
    let lastCompletedTitleName: String?
    let lastCompletedAt: Date?
    let inProgressTitleId: String?
    let inProgressTitleName: String?
    let updatedAt: Date?

    var progressText: String {
        guard totalCount > 0 else { return String(localized: "0%") }
        return String(localized: "\(Int((max(0, min(1, percentComplete)) * 100).rounded()))%")
    }
}

struct UserListDetail: Identifiable, Hashable {
    let list: UserListSummary
    let members: [UserListMember]
    let items: [UserListItem]
    let progress: [UserListProgressSummary]

    var id: String { list.id }

    var nextSuggestedItem: UserListItem? {
        guard list.kind == .orderedPath else { return nil }
        return items.first {
            if let publicProgress = $0.publicProgress {
                return !publicProgress.isCompleted
            }
            return !($0.personalState?.isCompleted ?? false)
        }
    }
}

struct WatchlistDashboard: Hashable {
    let generalWatchlist: [TitlePersonalState]
    let rewatch: [TitlePersonalState]
    let toRate: [TitlePersonalState]
    let toResume: [TitlePersonalState]
    /// Serie in corso su TUTTI i titleStates (non solo `generalWatchlist`), così
    /// include anche il rewatch-in-corso, che il server tiene fuori dalla
    /// watchlist generale (`generalWatchlist == false`) ma che resta comunque
    /// `seriesStatus == .inProgress`. Vedi `TitlePersonalState.isInProgressSeries`.
    let inProgressSeries: [TitlePersonalState]
    let myLists: [UserListSummary]
    let sharedLists: [UserListSummary]
    let publicLists: [UserListSummary]

    static let empty = WatchlistDashboard(
        generalWatchlist: [],
        rewatch: [],
        toRate: [],
        toResume: [],
        inProgressSeries: [],
        myLists: [],
        sharedLists: [],
        publicLists: []
    )
}

struct UserListEditorDraft: Hashable {
    var title: String = ""
    var description: String = ""
    var visibility: UserListVisibility = .private
    var kind: UserListKind = .collection
    var coverImageURL: URL?
    var coverStoragePath: String?
    var collaboratorIDs: [String] = []
    var selectedTitleIDs: [String] = []
    var naturalPrompt: String = ""

    var trimmedTitle: String {
        title.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

struct NaturalListCandidate: Identifiable, Hashable {
    let id: String
    let title: Title
    let reason: String
}

struct NaturalListPreview: Hashable {
    let suggestedName: String
    let suggestedDescription: String?
    let suggestedKind: UserListKind
    let candidates: [NaturalListCandidate]
}

struct UserMigrationResult: Hashable {
    let migratedCount: Int
    let skippedCount: Int
    let alreadyMigrated: Bool
}

struct NewSeasonDetectionItem: Hashable, Identifiable {
    let titleId: String
    let titleName: String
    let latestSeasonNumber: Int?
    let notified: Bool

    var id: String { titleId }
}

struct NewSeasonDetectionResult: Hashable {
    let scanned: Int
    let detected: [NewSeasonDetectionItem]
}

struct AdminBackfillResult: Hashable {
    let scannedCount: Int
    let updatedCount: Int
    let skippedCount: Int
    let nextCursor: String?
    let message: String?
}
