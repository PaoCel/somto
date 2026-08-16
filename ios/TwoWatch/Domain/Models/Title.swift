import Foundation

enum MediaType: String, Hashable {
    case movie
    case tv

    var label: String {
        switch self {
        case .movie:
            // Chiave esplicita: "Film" da solo collide con la CATEGORIA
            // omonima in ContentCategory, che in inglese e' plurale ("Movies").
            // Qui si parla di UN titolo: "Movie".
            return String(localized: "mediaType.movie", defaultValue: "Film")
        case .tv:
            return String(localized: "mediaType.tv", defaultValue: "Serie")
        }
    }
}

struct TitleMetadata: Hashable {
    let tmdbId: Int?
    let mediaType: MediaType
    let language: String?
    let originalLanguage: String?
    let country: String?
    let originCountry: [String]
    let network: String?
    let durationMovie: Int?
    let durationEpisode: Int?
    let seasonsCount: Int?
    let episodesPerSeason: Int?
    let seasons: [TitleSeason]
    let collectionId: Int?
    let collectionName: String?
    let collectionPosterPath: URL?
    let collectionBackdropPath: URL?

    init(
        tmdbId: Int?,
        mediaType: MediaType,
        language: String?,
        originalLanguage: String? = nil,
        country: String?,
        originCountry: [String] = [],
        network: String?,
        durationMovie: Int?,
        durationEpisode: Int?,
        seasonsCount: Int?,
        episodesPerSeason: Int?,
        seasons: [TitleSeason] = [],
        collectionId: Int?,
        collectionName: String?,
        collectionPosterPath: URL?,
        collectionBackdropPath: URL?
    ) {
        self.tmdbId = tmdbId
        self.mediaType = mediaType
        self.language = language
        self.originalLanguage = originalLanguage
        self.country = country
        self.originCountry = originCountry
        self.network = network
        self.durationMovie = durationMovie
        self.durationEpisode = durationEpisode
        self.seasonsCount = seasonsCount
        self.episodesPerSeason = episodesPerSeason
        self.seasons = seasons
        self.collectionId = collectionId
        self.collectionName = collectionName
        self.collectionPosterPath = collectionPosterPath
        self.collectionBackdropPath = collectionBackdropPath
    }
}

struct TitleRatingAggregateSummary: Hashable {
    let titleAverage: Double
    let titleCount: Int
}

/// Emozioni post-visione ("Che impressione hai avuto?"). Chiavi canoniche
/// stabili condivise col backend (`functions/lib/emotionAggregate.js`), mai
/// esposte come emoji nel DB — label/emoji sono solo client-side.
enum TitleEmotion: String, CaseIterable, Hashable, Identifiable {
    case shocked
    case frustrated
    case sad
    case reflective
    case touched
    case amused
    case scared
    case bored
    case understood
    case thrilled
    case confused
    case tense

    var id: String { rawValue }

    var emoji: String {
        switch self {
        case .shocked: return "🤯"
        case .frustrated: return "😤"
        case .sad: return "😢"
        case .reflective: return "🤔"
        case .touched: return "🥹"
        case .amused: return "😂"
        case .scared: return "😱"
        case .bored: return "🥱"
        case .understood: return "🫶"
        case .thrilled: return "🤩"
        case .confused: return "😵‍💫"
        case .tense: return "😬"
        }
    }

    var label: String {
        switch self {
        case .shocked: return String(localized: "Scioccato")
        case .frustrated: return String(localized: "Frustrato")
        case .sad: return String(localized: "Triste")
        case .reflective: return String(localized: "Riflessivo")
        case .touched: return String(localized: "Commosso")
        case .amused: return String(localized: "Divertito")
        case .scared: return String(localized: "Spaventato")
        case .bored: return String(localized: "Annoiato")
        case .understood: return String(localized: "Mi ci rivedo")
        case .thrilled: return String(localized: "Elettrizzato")
        case .confused: return String(localized: "Confuso")
        case .tense: return String(localized: "Teso")
        }
    }
}

/// Aggregato community denormalizzato su `titles/{id}.emotionAggregate`
/// (server-owned, sola lettura lato client). Percentuale = counts[k] /
/// totalSelections. Se `totalUsers < 3` la UI mostra le emoji più scelte
/// senza percentuali (numeri piccoli fuorvianti).
struct TitleEmotionAggregate: Hashable {
    let counts: [String: Int]
    let totalSelections: Int
    let totalUsers: Int

    /// Emozioni ordinate per popolarità decrescente, chiavi valide + count > 0.
    var rankedEmotions: [(emotion: TitleEmotion, count: Int)] {
        counts.compactMap { key, count -> (TitleEmotion, Int)? in
            guard count > 0, let emotion = TitleEmotion(rawValue: key) else { return nil }
            return (emotion, count)
        }
        .sorted { lhs, rhs in
            lhs.1 != rhs.1 ? lhs.1 > rhs.1 : lhs.0.rawValue < rhs.0.rawValue
        }
    }

    func percentage(for emotion: TitleEmotion) -> Double {
        guard totalSelections > 0 else { return 0 }
        return Double(counts[emotion.rawValue] ?? 0) / Double(totalSelections)
    }

    static func fromMap(_ map: [String: Any]) -> TitleEmotionAggregate? {
        guard !map.isEmpty else { return nil }
        let countsMap = FirestoreValueReader.map(map["counts"])
        var counts: [String: Int] = [:]
        for (key, value) in countsMap {
            guard TitleEmotion(rawValue: key) != nil, let intValue = FirestoreValueReader.int(value) else { continue }
            counts[key] = intValue
        }
        let totalSelections = FirestoreValueReader.int(map, key: "totalSelections") ?? 0
        let totalUsers = FirestoreValueReader.int(map, key: "totalUsers") ?? 0
        guard totalSelections > 0 || totalUsers > 0 || !counts.isEmpty else { return nil }
        return TitleEmotionAggregate(counts: counts, totalSelections: totalSelections, totalUsers: totalUsers)
    }
}

/// Una riga `titleEmotions/{id}` dell'utente ("Che impressione hai avuto?").
/// A differenza dell'enum `TitleEmotion` (una singola chiave), questo modello
/// rappresenta l'intero doc: titolo + fino a 3 emozioni scelte + quando.
/// Usato dal tab Community/Attività del profilo (`TitleRepository.fetchMyEmotions`).
struct TitleEmotionEntry: Identifiable, Hashable {
    let id: String
    let titleId: String
    let emotions: [TitleEmotion]
    let updatedAt: Date?
    let title: Title?

    init(id: String, titleId: String, emotions: [TitleEmotion], updatedAt: Date?, title: Title? = nil) {
        self.id = id
        self.titleId = titleId
        self.emotions = emotions
        self.updatedAt = updatedAt
        self.title = title
    }

    var sortDate: Date {
        updatedAt ?? .distantPast
    }
}

struct TitleSeason: Identifiable, Hashable {
    let seasonNumber: Int
    let episodeCount: Int
    let name: String?
    let airDate: String?

    init(seasonNumber: Int, episodeCount: Int, name: String?, airDate: String? = nil) {
        self.seasonNumber = seasonNumber
        self.episodeCount = episodeCount
        self.name = name
        self.airDate = airDate
    }

    var id: Int { seasonNumber }
}

/// Singolo episodio di una stagione, arricchito da TMDB (nome + data di messa
/// in onda). Il catalogo Somto non conserva questi dati per episodio: vengono
/// letti on-demand via `tmdbProxy` (action `seasonEpisodes`) e usati solo per
/// popolare la lista episodi per-riga nella scheda titolo. Nessuna persistenza.
struct TitleEpisode: Identifiable, Hashable {
    let number: Int
    let name: String
    /// Formato TMDB "yyyy-MM-dd" oppure nil se sconosciuta.
    let airDate: String?
    let overview: String?
    let voteAverage: Double

    init(number: Int, name: String, airDate: String? = nil, overview: String? = nil, voteAverage: Double = 0) {
        self.number = number
        self.name = name
        self.airDate = airDate
        self.overview = overview
        self.voteAverage = voteAverage
    }

    var id: Int { number }

    /// Nome mostrabile: fallback "Episodio N" quando TMDB non ha il titolo
    /// (comune sulle stagioni assorbite dei titoli merge multi-tmdb).
    func displayName() -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Episodio \(number)" : trimmed
    }
}

struct TitleCastMember: Hashable, Identifiable {
    let personId: String
    let name: String
    let character: String?
    let profileURL: URL?
    let order: Int

    var id: String { personId }
}

struct Title: Identifiable, Hashable {
    let id: String
    let name: String
    let nameLower: String
    let type: MediaType
    let year: Int?
    let description: String?
    let posterPath: URL?
    let backdropPath: URL?
    let genres: [String]
    let originalName: String?
    let aliases: [String]
    let directors: [String]
    let directorIDs: [String]
    let cast: [String]
    let castIDs: [String]
    let keywords: [String]
    let collectionName: String?
    let searchableText: String
    let ratingAvg: Double
    let ratingCount: Int
    let ratingAggregate: TitleRatingAggregateSummary?
    let emotionAggregate: TitleEmotionAggregate?
    let reviewCount: Int
    let createdBy: String?
    let status: String
    let metadata: TitleMetadata
    let searchDedupeKey: String?
    let updatedAt: Date?
    let tmdbNextRefreshAt: Date?
    let trailerURL: URL?
    let castWithCharacters: [TitleCastMember]
    /// Nomi delle piattaforme streaming (abbonamento/gratis) denormalizzati su
    /// `titles/{id}.watchProviderNames` dal backend. Usati per filtrare/raggruppare
    /// la watchlist per piattaforma senza fetch extra.
    let watchProviderNames: [String]
    /// Loghi piattaforma (TMDB w154) denormalizzati su `titles/{id}.watchProviderLogos`
    /// (`[{name, logoUrl}]`), stessa fonte/copertura di `watchProviderNames`. Mappa
    /// name→URL logo; nomi senza logo semplicemente non hanno una entry (fallback testo).
    let watchProviderLogos: [String: URL]

    init(
        id: String,
        name: String,
        nameLower: String,
        type: MediaType,
        year: Int?,
        description: String?,
        posterPath: URL?,
        backdropPath: URL?,
        genres: [String],
        originalName: String?,
        aliases: [String],
        directors: [String],
        directorIDs: [String],
        cast: [String],
        castIDs: [String],
        keywords: [String],
        collectionName: String?,
        searchableText: String,
        ratingAvg: Double,
        ratingCount: Int,
        ratingAggregate: TitleRatingAggregateSummary?,
        emotionAggregate: TitleEmotionAggregate? = nil,
        reviewCount: Int,
        createdBy: String?,
        status: String,
        metadata: TitleMetadata,
        searchDedupeKey: String?,
        updatedAt: Date?,
        tmdbNextRefreshAt: Date?,
        trailerURL: URL? = nil,
        castWithCharacters: [TitleCastMember] = [],
        watchProviderNames: [String] = [],
        watchProviderLogos: [String: URL] = [:]
    ) {
        self.id = id
        self.name = name
        self.nameLower = nameLower
        self.type = type
        self.year = year
        self.description = description
        self.posterPath = posterPath
        self.backdropPath = backdropPath
        self.genres = genres
        self.originalName = originalName
        self.aliases = aliases
        self.directors = directors
        self.directorIDs = directorIDs
        self.cast = cast
        self.castIDs = castIDs
        self.keywords = keywords
        self.collectionName = collectionName
        self.searchableText = searchableText
        self.ratingAvg = ratingAvg
        self.ratingCount = ratingCount
        self.ratingAggregate = ratingAggregate
        self.emotionAggregate = emotionAggregate
        self.reviewCount = reviewCount
        self.createdBy = createdBy
        self.status = status
        self.metadata = metadata
        self.searchDedupeKey = searchDedupeKey
        self.updatedAt = updatedAt
        self.tmdbNextRefreshAt = tmdbNextRefreshAt
        self.trailerURL = trailerURL
        self.castWithCharacters = castWithCharacters
        self.watchProviderNames = watchProviderNames
        self.watchProviderLogos = watchProviderLogos
    }

    var subtitle: String {
        if let year {
            return String(localized: "\(type.label) • \(year)")
        }
        return type.label
    }

    var shareURL: URL? {
        URL(string: "https://somto.it/share/title/\(id)")
    }
}

struct StreamingProvider: Identifiable, Hashable {
    let id: String
    let name: String
    let logoURL: URL?
    let type: String
}

struct TitleProviders: Hashable {
    let region: String
    let link: URL?
    let providers: [StreamingProvider]
    let customProviders: [StreamingProvider]
    /// Link che aprono il titolo DENTRO la piattaforma, per nome del provider.
    /// Li risolve il server (Wikidata) e arrivano solo per le piattaforme che
    /// in questa regione hanno davvero il titolo. Vuoto = si ripiega, vedi
    /// `StreamingDestinationResolver`.
    var deepLinks: [String: URL] = [:]

    var isEmpty: Bool {
        providers.isEmpty && customProviders.isEmpty
    }
}

struct Rating: Identifiable, Hashable {
    let id: String
    let uid: String
    let titleId: String
    let level: String
    let season: Int?
    let episode: Int?
    let rating: Double
    let reviewText: String?
    let updatedAt: Date?
    let author: UserSummary?
    let watchedWith: [FeedTaggedUser]
    let watchedWithGroup: FeedTaggedGroup?
    let mediaURLs: [URL]
}

struct RatingSocialDetails: Hashable {
    let reviewText: String?
    let watchedWith: [FeedTaggedUser]
    let watchedWithGroup: FeedTaggedGroup?
    let mediaURLs: [URL]
}

/// Voto DERIVATO e PRIVATO: media dei voti episodio dell'utente, calcolata
/// server-side in users/{uid}/derivedRatings/{titleId}. `seriesAvg` è la media
/// delle stagioni (nil se nessun episodio votato); `seasonAvgs` mappa numero
/// stagione → media episodi di quella stagione.
struct DerivedRating: Hashable {
    let titleId: String
    let seriesAvg: Double?
    let seasonCount: Int
    let episodeCount: Int
    let seasonAvgs: [Int: Double]

    static func from(map: [String: Any], titleId: String) -> DerivedRating {
        let seriesMap = FirestoreValueReader.map(map["series"])
        let seriesAvg = FirestoreValueReader.double(seriesMap, key: "avg")
        let seasonCount = FirestoreValueReader.int(seriesMap, key: "seasonCount") ?? 0
        let episodeCount = FirestoreValueReader.int(seriesMap, key: "episodeCount") ?? 0

        var seasonAvgs: [Int: Double] = [:]
        for (key, value) in FirestoreValueReader.map(map["season"]) {
            guard let season = Int(key),
                  let avg = FirestoreValueReader.double(FirestoreValueReader.map(value), key: "avg")
            else { continue }
            seasonAvgs[season] = avg
        }

        return DerivedRating(
            titleId: titleId,
            seriesAvg: seriesAvg,
            seasonCount: seasonCount,
            episodeCount: episodeCount,
            seasonAvgs: seasonAvgs
        )
    }
}

/// Esito di `enrichTitleAssets`. Era annidato in `TitleRepository`: e' uscito
/// perche' compare nella firma di `TitleRepositoryProtocol`, e un protocollo
/// che nomina un tipo interno alla propria implementazione concreta non
/// disaccoppia niente.
struct TitleEnrichmentResult {
    let trailerURL: URL?
    let castWithCharacters: [TitleCastMember]
}

struct TitleRefreshResult: Hashable {
    let ok: Bool
    let checked: Bool
    let updated: Bool
    let reason: String?
    let nextCheckAt: Date?
}
