@preconcurrency import FirebaseFirestore
@preconcurrency import FirebaseStorage
import Foundation
import UIKit

enum TitleUpdateSupport {
    static func localizedText(_ value: Any?, preferredLocalization: String) -> String? {
        let map = FirestoreValueReader.map(value)
        let preferred = preferredLocalization.lowercased().hasPrefix("en") ? "en-US" : "it-IT"
        for key in [preferred, "en-US", "it-IT"] {
            if let text = FirestoreValueReader.string(map[key]), !text.isEmpty { return text }
        }
        return map.values.compactMap(FirestoreValueReader.string).first(where: { !$0.isEmpty })
    }

    static func safeSourceURL(_ rawValue: String?) -> URL? {
        guard let rawValue, let url = URL(string: rawValue),
              url.scheme?.lowercased() == "https",
              let host = url.host?.lowercased()
        else { return nil }
        let allowedHosts = ["youtube.com", "www.youtube.com", "youtu.be", "themoviedb.org", "www.themoviedb.org"]
        return allowedHosts.contains(host) ? url : nil
    }

    static func deepLinkFocus(focus: String?, eventID: String?) -> String? {
        guard let eventID, !eventID.isEmpty else { return focus }
        let baseFocus = focus.flatMap { $0.isEmpty ? nil : $0 } ?? "updates"
        return "\(baseFocus)|\(eventID)"
    }
}

struct TitleUpdateVideo: Identifiable, Sendable {
    let id: String
    let name: String
    let kind: String
    let isOfficial: Bool
    let publishedAt: Date?

    var youtubeURL: URL? {
        URL(string: "https://www.youtube.com/watch?v=\(id)")
    }

    var thumbnailURL: URL? {
        URL(string: "https://img.youtube.com/vi/\(id)/hqdefault.jpg")
    }
}

struct TitleReleaseUpdate: Sendable {
    let date: Date
    let season: Int?
    let episode: Int?
    let name: String?
    let isEpisode: Bool
}

enum TitleUpdatePreference: String, CaseIterable, Identifiable, Sendable {
    case automatic = "auto"
    case follow
    case important
    case muted

    var id: String { rawValue }

    var label: String {
        switch self {
        case .automatic: String(localized: "Automatico")
        case .follow: String(localized: "Segui tutto")
        case .important: String(localized: "Solo importanti")
        case .muted: String(localized: "Silenzia")
        }
    }
}

struct TitleUpdateEvent: Identifiable, Sendable {
    let id: String
    let eventType: String
    let headline: String
    let entityName: String?
    let sourceID: String
    let sourceURL: URL?
    let isOfficial: Bool
    let sortAt: Date?
    /// Quando l'evento accade davvero: uscita del film, messa in onda
    /// dell'episodio. Diverso da `sortAt`, che e' solo la chiave di
    /// ordinamento della timeline (`sourcePublishedAt ?? effectiveAt ??
    /// discoveredAt`) e quindi per un trailer e' la data di pubblicazione del
    /// video, non quella dell'uscita.
    ///
    /// Il writer lo salva a mezzogiorno UTC del giorno di uscita: e' una data
    /// di calendario travestita da istante, e va formattata a fuso fisso (vedi
    /// `WatchlistUpcomingBadge`).
    let effectiveAt: Date?

    var displayName: String {
        guard let entityName, !entityName.isEmpty else { return headline }
        return entityName
    }

    var video: TitleUpdateVideo? {
        guard eventType == "trailer" || eventType == "teaser", !sourceID.isEmpty else { return nil }
        return TitleUpdateVideo(
            id: sourceID,
            name: displayName,
            kind: eventType,
            isOfficial: isOfficial,
            publishedAt: sortAt
        )
    }
}

struct TitleOfficialUpdate: Identifiable, Sendable {
    let id: String
    let title: String
    let createdAt: Date?

    var url: URL? {
        URL(string: "https://somto.it/?post=\(id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? id)")
    }
}

struct TitleUpdatesSnapshot: Sendable {
    let release: TitleReleaseUpdate?
    let videos: [TitleUpdateVideo]
    let events: [TitleUpdateEvent]
    let officialUpdates: [TitleOfficialUpdate]

    static let empty = TitleUpdatesSnapshot(release: nil, videos: [], events: [], officialUpdates: [])
}

private struct TitleTMDBUpdatesResult: Sendable {
    let release: TitleReleaseUpdate?
    let videos: [TitleUpdateVideo]
}

@MainActor
final class TitleRepository {
    private let db = Firestore.firestore()
    private var cachedGenres: [Genre] = []
    private var cachedGenresLimit = 0
    private var cachedTitleSearches: [String: CachedTitleSearchEntry] = [:]
    private var cachedTMDBSearches: [String: CachedTMDBSearchEntry] = [:]
    private var cachedTitlesByID: [String: CachedTitleEntry] = [:]
    /// Cache in memoria degli episodi TMDB per (tmdbId, stagione). Evita di
    /// ricolpire il proxy ad ogni cambio di stagione nella scheda titolo.
    /// Key = "\(tmdbId)_\(season)". Vale per la vita della sessione app.
    private var cachedSeasonEpisodes: [String: [TitleEpisode]] = [:]

    private struct CachedTitleSearchEntry {
        let value: TitleSearchResults
        let expiresAt: Date
    }

    private struct CachedTitleEntry {
        let value: Title
        let expiresAt: Date
    }

    private struct CachedTMDBSearchEntry {
        let value: [TMDBSearchResult]
        let expiresAt: Date
    }

    private struct TMDBCreditAvatar: Sendable {
        let name: String
        let avatarURL: URL?
    }

    private struct TMDBCreditFallbacks: Sendable {
        let directors: [String: TMDBCreditAvatar]
        let cast: [String: TMDBCreditAvatar]

        static let empty = TMDBCreditFallbacks(directors: [:], cast: [:])
    }

    init() {}

    func updateEditorialContent(
        title: Title,
        currentUser: AppUser,
        overview: String?,
        trailerInput: String?
    ) async throws {
        guard currentUser.canEditTitleEditorialContent else {
            throw NSError(domain: "TwoWatch", code: 403, userInfo: [
                NSLocalizedDescriptionKey: String(localized: "Questo account non può modificare sinossi o trailer.")
            ])
        }

        let normalizedOverview = overview.flatMap { TitleParsing.sanitizedOptionalText($0, maxLength: 4000) }
        let normalizedTrailerURL = try trailerInput.flatMap { try TitleParsing.normalizedEditorialTrailerURL(from: $0) }

        var payload: [String: Any] = [
            "updatedAt": FieldValue.serverTimestamp()
        ]
        var hasChanges = false

        if let normalizedOverview {
            let searchableText = TitleParsing.buildSearchableText(
                name: title.name,
                originalName: title.originalName,
                aliases: title.aliases,
                collectionName: title.collectionName,
                keywords: title.keywords,
                overview: normalizedOverview
            )
            let searchCorpus = [
                title.name,
                title.originalName ?? "",
                title.aliases.joined(separator: " "),
                title.collectionName ?? "",
                title.keywords.joined(separator: " "),
                searchableText
            ]
                .joined(separator: " ")

            payload["description"] = normalizedOverview
            payload["searchableText"] = searchableText
            payload["search.searchableText"] = searchableText
            payload["search.tokens"] = SearchNormalizer.tokens(from: searchCorpus)
            hasChanges = true
        }

        if let normalizedTrailerURL {
            payload["trailerUrl"] = normalizedTrailerURL.absoluteString
            hasChanges = true
        }

        guard hasChanges else {
            throw NSError(domain: "TwoWatch", code: 422, userInfo: [
                NSLocalizedDescriptionKey: String(localized: "Inserisci almeno una sinossi o un link YouTube valido.")
            ])
        }

        try await db.collection("titles").document(title.id).setData(payload, merge: true)
        invalidateCachedTitle(id: title.id)
    }

    /// Risolve lo slug SEO di una pagina pubblica (`/film/{slug}`,
    /// `/serie/{slug}`) nel doc id del titolo.
    ///
    /// Serve ai universal link: quelle rotte sono la superficie SEO principale
    /// ma usano lo slug leggibile, non il doc id, quindi senza questa risoluzione
    /// l'app non saprebbe che titolo aprire. Query su campo singolo: l'indice lo
    /// crea Firestore da solo, nessun indice composito da deployare.
    func fetchTitleID(forSlug slug: String) async throws -> String? {
        let clean = slug.trimmingCharacters(in: CharacterSet(charactersIn: "/ "))
        guard !clean.isEmpty else { return nil }
        let snapshot = try await db.collection("titles")
            .whereField("slug", isEqualTo: clean)
            .limit(to: 1)
            .getDocuments()
        return snapshot.documents.first?.documentID
    }

    func listPopularTitles(limit: Int = 12) async throws -> [Title] {
        do {
            let snapshot = try await db.collection("titles")
                .whereField("status", isEqualTo: "approved")
                .order(by: "ratingCount", descending: true)
                .limit(to: limit)
                .getDocuments()
            return snapshot.documents.compactMap(snapshotToTitle)
        } catch {
            let snapshot = try await db.collection("titles").limit(to: 80).getDocuments()
            return snapshot.documents
                .compactMap(snapshotToTitle)
                .filter { $0.status == "approved" }
                .sorted { lhs, rhs in lhs.ratingCount > rhs.ratingCount }
                .prefix(limit)
                .map { $0 }
        }
    }

    func listRecentApprovedTitles(limit: Int = 12) async throws -> [Title] {
        do {
            let snapshot = try await db.collection("titles")
                .whereField("status", isEqualTo: "approved")
                .order(by: "createdAt", descending: true)
                .limit(to: limit)
                .getDocuments()
            return snapshot.documents.compactMap(snapshotToTitle)
        } catch {
            let snapshot = try await db.collection("titles").limit(to: 80).getDocuments()
            return snapshot.documents
                .compactMap(snapshotToTitle)
                .filter { $0.status == "approved" }
                .sorted { ($0.year ?? 0) > ($1.year ?? 0) }
                .prefix(limit)
                .map { $0 }
        }
    }

    func searchTitles(_ query: String, limit: Int = 20) async throws -> [Title] {
        let normalized = SearchNormalizer.normalize(query)
        guard !normalized.isEmpty else { return [] }

        let tokens = SearchNormalizer.tokens(from: normalized).sorted { $0.count > $1.count }
        if let firstToken = tokens.first {
            do {
                let tokenSnapshot = try await db.collection("titles")
                    .whereField("status", isEqualTo: "approved")
                    .whereField("search.tokens", arrayContains: firstToken)
                    .limit(to: min(80, limit * 4))
                    .getDocuments()

                let filtered = tokenSnapshot.documents
                    .compactMap(snapshotToTitle)
                    .filter { title in
                        title.nameLower.contains(normalized) || SearchNormalizer.tokens(from: title.nameLower).contains(firstToken)
                    }
                    .sorted { lhs, rhs in
                        let leftScore = TitleParsing.searchScore(for: lhs, normalized: normalized)
                        let rightScore = TitleParsing.searchScore(for: rhs, normalized: normalized)
                        if leftScore != rightScore { return leftScore > rightScore }
                        return lhs.ratingCount > rhs.ratingCount
                    }

                if !filtered.isEmpty {
                    return Array(filtered.prefix(limit))
                }
            } catch {
                // Fallback below.
            }
        }

        let snapshot = try await db.collection("titles")
            .whereField("status", isEqualTo: "approved")
            .order(by: "nameLower")
            .start(at: [normalized])
            .end(at: [normalized + "\u{f8ff}"])
            .limit(to: limit)
            .getDocuments()

        return snapshot.documents.compactMap(snapshotToTitle)
    }

    func searchCatalogTitles(_ query: String, limit: Int = 20) async throws -> TitleSearchResults {
        let normalized = SearchNormalizer.normalize(query)
        guard !normalized.isEmpty else { return .empty }

        if let cached = cachedCatalogSearchResults(query, limit: limit) {
            return cached
        }

        async let localTask = searchTitles(query, limit: limit)
        async let remoteTask: [TMDBSearchResult] = normalized.count >= 2
            ? ((try? await searchTMDBCached(query, limit: max(8, min(12, limit)))) ?? [])
            : []

        let localTitles = try await localTask
        let remoteTitles = await remoteTask
        let value = mergeCatalogSearchResults(localTitles: localTitles, remoteResults: remoteTitles)

        cacheCatalogSearchResults(value, query: query, limit: limit)
        return value
    }

    func cachedCatalogSearchResults(_ query: String, limit: Int = 20) -> TitleSearchResults? {
        let normalized = SearchNormalizer.normalize(query)
        guard !normalized.isEmpty else { return nil }

        let cacheKey = "\(normalized)#\(limit)"
        guard let cached = cachedTitleSearches[cacheKey], cached.expiresAt > Date() else {
            cachedTitleSearches.removeValue(forKey: cacheKey)
            return nil
        }
        return cached.value
    }

    func cacheCatalogSearchResults(_ results: TitleSearchResults, query: String, limit: Int = 20) {
        let normalized = SearchNormalizer.normalize(query)
        guard !normalized.isEmpty else { return }

        let cacheKey = "\(normalized)#\(limit)"
        cachedTitleSearches[cacheKey] = CachedTitleSearchEntry(
            value: results,
            expiresAt: Date().addingTimeInterval(45)
        )
        trimCachedTitleSearches()
    }

    func searchTitlesForListBuilder(_ query: String, limit: Int = 40) async throws -> [Title] {
        let normalized = SearchNormalizer.normalize(query)
        guard !normalized.isEmpty else { return [] }

        let tokens = SearchNormalizer.tokens(from: normalized)
        guard let firstToken = tokens.sorted(by: { $0.count > $1.count }).first else {
            return try await searchTitles(query, limit: limit)
        }

        do {
            let snapshot = try await db.collection("titles")
                .whereField("status", isEqualTo: "approved")
                .whereField("search.tokens", arrayContains: firstToken)
                .limit(to: min(120, max(limit * 4, 40)))
                .getDocuments()

            let ranked = snapshot.documents
                .compactMap(snapshotToTitle)
                .map { title -> (Title, Int) in
                    (title, smartListSearchScore(for: title, normalized: normalized, tokens: tokens))
                }
                .filter { $0.1 > 0 }
                .sorted { lhs, rhs in
                    if lhs.1 != rhs.1 { return lhs.1 > rhs.1 }
                    if lhs.0.ratingCount != rhs.0.ratingCount { return lhs.0.ratingCount > rhs.0.ratingCount }
                    return lhs.0.nameLower < rhs.0.nameLower
                }

            if !ranked.isEmpty {
                return Array(ranked.prefix(limit).map(\.0))
            }
        } catch {
            // Fallback below.
        }

        return try await searchTitles(query, limit: limit)
    }

    func listTitles(ids: [String]) async throws -> [Title] {
        let uniqueIDs = Array(Set(ids.filter { !$0.isEmpty }))
        guard !uniqueIDs.isEmpty else { return [] }

        // Cache in-memory TTL 60s (stesso modello di `cachedTitleSearches`, e
        // parità col web `getTitlesByIds` cache 60s): serve dal cache gli id già
        // noti e scarica solo i mancanti — l'apertura profilo richiama listTitles
        // più volte (library, review, post) con id in gran parte sovrapposti.
        let now = Date()
        var titleByID: [String: Title] = [:]
        var missingIDs: [String] = []
        for id in uniqueIDs {
            if let cached = cachedTitlesByID[id], cached.expiresAt > now {
                titleByID[id] = cached.value
            } else {
                missingIDs.append(id)
            }
        }

        if !missingIDs.isEmpty {
            // Chunk in parallelo (max 30 id per query `in`, limite Firestore):
            // concorrenti via task group. Un chunk che fallisce non deve far
            // fallire l'intera lista → ritorna [] per quel chunk invece di
            // propagare l'errore. Il decode (`snapshotToTitle`, isolato al
            // MainActor) resta fuori dai child task: i task catturano solo `db`
            // (Firestore, `@preconcurrency`) + `chunk` ([String], Sendable), non
            // `self`, ed espongono i documenti grezzi al chiamante MainActor.
            let db = db
            var allDocuments: [QueryDocumentSnapshot] = []
            try await withThrowingTaskGroup(of: [QueryDocumentSnapshot].self) { group in
                for chunk in missingIDs.chunked(into: 30) {
                    group.addTask {
                        do {
                            let snapshot = try await db.collection("titles")
                                .whereField(FieldPath.documentID(), in: chunk)
                                .getDocuments()
                            return snapshot.documents
                        } catch {
                            return []
                        }
                    }
                }
                for try await documents in group {
                    allDocuments.append(contentsOf: documents)
                }
            }

            for document in allDocuments {
                if let title = snapshotToTitle(document) {
                    titleByID[title.id] = title
                    storeCachedTitle(title)
                }
            }
        }

        return uniqueIDs.compactMap { titleByID[$0] }
    }

    func fetchTitle(id: String) async throws -> Title? {
        if let cached = cachedTitlesByID[id], cached.expiresAt > Date() {
            return cached.value
        }
        let snapshot = try await db.collection("titles").document(id).getDocument()
        let title = snapshotToTitle(snapshot)
        if let title {
            storeCachedTitle(title)
        }
        return title
    }

    func fetchPeople(ids: [String]) async throws -> [Person] {
        var uniqueIDs: [String] = []
        var seenIDs: Set<String> = []
        for rawID in ids.map({ $0.trimmingCharacters(in: .whitespacesAndNewlines) }).filter({ !$0.isEmpty }) {
            guard seenIDs.insert(rawID).inserted else { continue }
            uniqueIDs.append(rawID)
        }
        guard !uniqueIDs.isEmpty else { return [] }

        var peopleByID: [String: Person] = [:]
        for chunk in uniqueIDs.chunked(into: 10) {
            let snapshot = try await db.collection("people")
                .whereField(FieldPath.documentID(), in: chunk)
                .getDocuments()

            for document in snapshot.documents {
                if let person = TitleParsing.snapshotToPerson(document) {
                    peopleByID[person.id] = person
                }
            }
        }

        return uniqueIDs.compactMap { peopleByID[$0] }
    }

    func fetchPeople(named names: [String]) async throws -> [Person] {
        var orderedNormalizedNames: [String] = []
        var seenNames: Set<String> = []
        var originalNameByNormalized: [String: String] = [:]

        for name in names {
            let normalized = SearchNormalizer.normalize(name)
            guard !normalized.isEmpty, seenNames.insert(normalized).inserted else { continue }
            orderedNormalizedNames.append(normalized)
            originalNameByNormalized[normalized] = name.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        guard !orderedNormalizedNames.isEmpty else { return [] }

        var peopleByName: [String: Person] = [:]

        func storePeople(from documents: [QueryDocumentSnapshot]) {
            for document in documents {
                guard let person = TitleParsing.snapshotToPerson(document) else { continue }
                let normalizedName = person.nameLower.isEmpty ? SearchNormalizer.normalize(person.name) : person.nameLower
                guard !normalizedName.isEmpty else { continue }
                if peopleByName[normalizedName] == nil {
                    peopleByName[normalizedName] = person
                }
            }
        }

        for chunk in orderedNormalizedNames.chunked(into: 10) {
            let primarySnapshot = try await db.collection("people")
                .whereField("nameLower", in: chunk)
                .getDocuments()
            storePeople(from: primarySnapshot.documents)

            let missingNormalizedNames = chunk.filter { peopleByName[$0] == nil }
            if !missingNormalizedNames.isEmpty {
                let normalizedSnapshot = try await db.collection("people")
                    .whereField("search.normalized", in: missingNormalizedNames)
                    .getDocuments()
                storePeople(from: normalizedSnapshot.documents)
            }

            let stillMissingRawNames = missingNormalizedNames
                .filter { peopleByName[$0] == nil }
                .compactMap { originalNameByNormalized[$0] }
                .filter { !$0.isEmpty }

            if !stillMissingRawNames.isEmpty {
                let rawNameSnapshot = try await db.collection("people")
                    .whereField("name", in: stillMissingRawNames)
                    .getDocuments()
                storePeople(from: rawNameSnapshot.documents)
            }
        }

        return orderedNormalizedNames.compactMap { peopleByName[$0] }
    }

    func fetchTitleCredits(for title: Title) async throws -> TitleCredits {
        async let directorIDMatches = fetchPeople(ids: title.directorIDs)
        async let directorNameMatches = fetchPeople(named: title.directors)
        async let castIDMatches = fetchPeople(ids: title.castIDs)
        async let castNameMatches = fetchPeople(named: title.cast)
        async let tmdbFallbacks = fetchTMDBCreditFallbacks(for: title)

        let fallbackAvatars = (try? await tmdbFallbacks) ?? .empty
        let directorsByName = mergedCreditNames(primary: title.directors, fallbackAvatars: fallbackAvatars.directors)
        let castByName = mergedCreditNames(primary: title.cast, fallbackAvatars: fallbackAvatars.cast)

        let directors = makeTitleCreditPeople(
            names: directorsByName,
            ids: title.directorIDs,
            matchedPeople: TitleParsing.mergePeople(
                (try? await directorIDMatches) ?? [],
                (try? await directorNameMatches) ?? []
            ),
            primaryRole: "director",
            fallbackAvatarsByName: fallbackAvatars.directors
        )
        let cast = makeTitleCreditPeople(
            names: castByName,
            ids: title.castIDs,
            matchedPeople: TitleParsing.mergePeople(
                (try? await castIDMatches) ?? [],
                (try? await castNameMatches) ?? []
            ),
            primaryRole: "actor",
            fallbackAvatarsByName: fallbackAvatars.cast
        )

        return TitleCredits(directors: directors, cast: cast)
    }

    func findTitleByTMDBID(_ tmdbId: Int, mediaType: MediaType) async throws -> Title? {
        let canonicalID = TitleParsing.canonicalTitleID(tmdbId: tmdbId, mediaType: mediaType)
        let canonical = try await fetchTitle(id: canonicalID)
        if let canonical {
            return canonical
        }

        var candidates: [Title] = []

        let queries: [Query] = [
            db.collection("titles")
                .whereField("status", isEqualTo: "approved")
                .whereField("tmdbId", isEqualTo: tmdbId)
                .limit(to: 8),
            db.collection("titles")
                .whereField("status", isEqualTo: "approved")
                .whereField("meta.tmdbId", isEqualTo: tmdbId)
                .limit(to: 8),
        ]

        for query in queries {
            do {
                let snapshot = try await query.getDocuments()
                candidates.append(contentsOf: snapshot.documents.compactMap(snapshotToTitle))
            } catch {
                // Best effort: if an index is missing, keep the remaining fallbacks.
            }
        }

        return pickBestTitleMatch(candidates, preferredType: mediaType, preferredTMDBID: tmdbId)
    }

    func findTitleByDedupeKey(_ dedupeKey: String) async throws -> Title? {
        guard !dedupeKey.isEmpty else { return nil }
        let snapshot = try await db.collection("titles")
            .whereField("status", isEqualTo: "approved")
            .whereField("search.dedupeKey", isEqualTo: dedupeKey)
            .limit(to: 1)
            .getDocuments()
        if let direct = snapshot.documents.compactMap(snapshotToTitle).first {
            return direct
        }

        guard let parsed = TitleParsing.parseDedupeKey(dedupeKey) else { return nil }
        let prefixSeed = parsed.nameLower
            .split(separator: " ")
            .prefix(3)
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let searchSeed = prefixSeed.isEmpty ? parsed.nameLower : prefixSeed

        let fallbackSnapshot = try await db.collection("titles")
            .whereField("status", isEqualTo: "approved")
            .order(by: "nameLower")
            .start(at: [searchSeed])
            .end(at: [searchSeed + "\u{f8ff}"])
            .limit(to: 40)
            .getDocuments()

        let candidates = fallbackSnapshot.documents
            .compactMap(snapshotToTitle)
            .filter { title in
                guard title.nameLower == parsed.nameLower else { return false }
                if let type = parsed.type, title.type != type { return false }
                if let year = parsed.year, title.year != year { return false }
                return true
            }

        return pickBestTitleMatch(candidates, preferredType: parsed.type)
    }

    func fetchRelatedTitles(for title: Title, limit: Int = 12) async throws -> [Title] {
        guard !title.genres.isEmpty else {
            return try await listPopularTitles(limit: limit).filter { $0.id != title.id }
        }

        do {
            let snapshot = try await db.collection("titles")
                .whereField("status", isEqualTo: "approved")
                .whereField("genres", arrayContainsAny: Array(title.genres.prefix(10)))
                .limit(to: limit * 2)
                .getDocuments()

            return snapshot.documents
                .compactMap(snapshotToTitle)
                .filter { $0.id != title.id }
                .sorted { lhs, rhs in
                    if lhs.ratingCount != rhs.ratingCount { return lhs.ratingCount > rhs.ratingCount }
                    return (lhs.year ?? 0) > (rhs.year ?? 0)
                }
                .prefix(limit)
                .map { $0 }
        } catch {
            return try await listPopularTitles(limit: limit).filter { $0.id != title.id }
        }
    }

    func listGenres(limit: Int = 200) async throws -> [Genre] {
        if cachedGenresLimit >= limit, !cachedGenres.isEmpty {
            return Array(cachedGenres.prefix(limit))
        }

        let snapshot = try await db.collection("genres")
            .order(by: "nameLower")
            .limit(to: limit)
            .getDocuments()

        let fetchedGenres = snapshot.documents.map { document in
            let data = document.data()
            return GenreDisplay.normalized(
                Genre(
                id: document.documentID,
                name: FirestoreValueReader.string(data, key: "name") ?? document.documentID,
                nameLower: FirestoreValueReader.string(data, key: "nameLower") ?? document.documentID.lowercased()
            )
            )
        }
        let seenIDs = Set(fetchedGenres.map(\.id))
        let genres = (fetchedGenres + GenreDisplay.fallbackGenres.filter { !seenIDs.contains($0.id) })
            .sorted { lhs, rhs in
                lhs.nameLower.localizedCaseInsensitiveCompare(rhs.nameLower) == .orderedAscending
            }

        if genres.count >= cachedGenres.count || limit >= cachedGenresLimit {
            cachedGenres = genres
            cachedGenresLimit = limit
        }

        return genres
    }

    func listPopularPeople(limit: Int = 20) async throws -> [Person] {
        do {
            let snapshot = try await db.collection("people")
                .order(by: "occurrences", descending: true)
                .limit(to: limit)
                .getDocuments()
            return snapshot.documents.compactMap(TitleParsing.snapshotToPerson)
        } catch {
            let snapshot = try await db.collection("people")
                .limit(to: limit * 2)
                .getDocuments()
            return snapshot.documents
                .compactMap(TitleParsing.snapshotToPerson)
                .sorted { lhs, rhs in
                    if lhs.occurrences != rhs.occurrences { return lhs.occurrences > rhs.occurrences }
                    return lhs.nameLower < rhs.nameLower
                }
                .prefix(limit)
                .map { $0 }
        }
    }

    func searchPeople(_ query: String, role: String = "all", limit: Int = 20) async throws -> [Person] {
        let normalized = SearchNormalizer.normalize(query)
        guard !normalized.isEmpty else { return [] }

        let snapshot = try await db.collection("people")
            .whereField("search.prefixes", arrayContains: normalized)
            .limit(to: min(60, limit * 3))
            .getDocuments()

        let people = snapshot.documents.compactMap(TitleParsing.snapshotToPerson)
        let filtered = people.filter { person in
            role == "all" || person.roles.contains(role)
        }

        return Array(filtered.sorted { lhs, rhs in
            let lhsStarts = lhs.nameLower.hasPrefix(normalized)
            let rhsStarts = rhs.nameLower.hasPrefix(normalized)
            if lhsStarts != rhsStarts { return lhsStarts }
            return lhs.nameLower < rhs.nameLower
        }.prefix(limit))
    }

    func titlesForGenre(_ genreID: String, type: MediaType? = nil, limit: Int = 60) async throws -> [Title] {
        var query: Query = db.collection("titles")
            .whereField("status", isEqualTo: "approved")
            .whereField("genres", arrayContains: genreID)
            .limit(to: limit)

        if let type {
            query = query.whereField("type", isEqualTo: type.rawValue)
        }

        let snapshot = try await query.getDocuments()
        return snapshot.documents
            .compactMap(snapshotToTitle)
            .sorted { lhs, rhs in
                if lhs.ratingCount != rhs.ratingCount { return lhs.ratingCount > rhs.ratingCount }
                return (lhs.year ?? 0) > (rhs.year ?? 0)
            }
    }

    /// Cerca titoli per nome attore quando non abbiamo un personID indicizzato.
    /// Usa la query `cast arrayContains <name>` (campo già presente nei titoli).
    /// Fallback search: se TMDB ha un personId omonimo lo proviamo dopo.
    func titlesForPersonName(_ rawName: String, limit: Int = 60) async throws -> [Title] {
        let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return [] }
        let base = db.collection("titles").whereField("status", isEqualTo: "approved")

        var deduped: [String: Title] = [:]

        // Match esatto su cast/directors string array.
        let castSnap = try? await base.whereField("cast", arrayContains: name).limit(to: limit).getDocuments()
        for document in castSnap?.documents ?? [] {
            if let title = snapshotToTitle(document) { deduped[title.id] = title }
        }

        let dirSnap = try? await base.whereField("directors", arrayContains: name).limit(to: limit).getDocuments()
        for document in dirSnap?.documents ?? [] {
            if let title = snapshotToTitle(document) { deduped[title.id] = title }
        }

        return deduped.values.sorted { lhs, rhs in
            if lhs.ratingCount != rhs.ratingCount { return lhs.ratingCount > rhs.ratingCount }
            return (lhs.year ?? 0) > (rhs.year ?? 0)
        }
    }

    func titlesForPerson(_ personID: String, type: MediaType? = nil, role: String = "all", limit: Int = 60) async throws -> [Title] {
        var queries: [Query] = []
        var base: Query = db.collection("titles").whereField("status", isEqualTo: "approved")
        if let type {
            base = base.whereField("type", isEqualTo: type.rawValue)
        }

        if role == "all" || role == "actor" {
            queries.append(base.whereField("castIds", arrayContains: personID).limit(to: limit))
        }
        if role == "all" || role == "director" {
            queries.append(base.whereField("directorIds", arrayContains: personID).limit(to: limit))
        }

        var deduped: [String: Title] = [:]
        for query in queries {
            let snapshot = try await query.getDocuments()
            for document in snapshot.documents {
                if let title = snapshotToTitle(document) {
                    deduped[title.id] = title
                }
            }
        }

        return deduped.values.sorted { lhs, rhs in
            if lhs.ratingCount != rhs.ratingCount { return lhs.ratingCount > rhs.ratingCount }
            return (lhs.year ?? 0) > (rhs.year ?? 0)
        }
    }

    func searchTMDB(_ query: String, limit: Int = 12) async throws -> [TMDBSearchResult] {
        let payload = try await callTMDBProxy(action: "searchMulti", payload: [
            "query": query,
            "language": "it-IT",
            "page": "1"
        ])

        let results = payload["results"] as? [[String: Any]] ?? []
        return Array(results.compactMap { item in
            guard
                let mediaTypeRaw = FirestoreValueReader.string(item["media_type"]),
                mediaTypeRaw == "movie" || mediaTypeRaw == "tv",
                let tmdbId = FirestoreValueReader.int(item["id"])
            else {
                return nil
            }

            let mediaType: MediaType = mediaTypeRaw == "tv" ? .tv : .movie
            let title = mediaType == .tv
                ? (FirestoreValueReader.string(item["name"]) ?? "")
                : (FirestoreValueReader.string(item["title"]) ?? "")
            let originalTitle = mediaType == .tv
                ? (FirestoreValueReader.string(item["original_name"]) ?? "")
                : (FirestoreValueReader.string(item["original_title"]) ?? "")

            let yearString = mediaType == .tv
                ? FirestoreValueReader.string(item["first_air_date"])
                : FirestoreValueReader.string(item["release_date"])

            let year = yearString.flatMap { Int($0.prefix(4)) }
            let posterPath = FirestoreValueReader.string(item["poster_path"]).flatMap {
                URL(string: "https://image.tmdb.org/t/p/w342\($0)")
            }
            let genreIDs = (item["genre_ids"] as? [Any] ?? []).compactMap(FirestoreValueReader.int)

            return TMDBSearchResult(
                id: "tmdb_\(mediaType.rawValue)_\(tmdbId)",
                tmdbId: tmdbId,
                mediaType: mediaType,
                title: title,
                originalTitle: originalTitle,
                year: year,
                overview: FirestoreValueReader.string(item["overview"]) ?? "",
                posterURL: posterPath,
                genreIds: genreIDs
            )
        }
        .prefix(limit))
    }

    func searchTMDBCached(_ query: String, limit: Int = 12) async throws -> [TMDBSearchResult] {
        let normalized = SearchNormalizer.normalize(query)
        guard !normalized.isEmpty else { return [] }

        let cacheKey = "\(normalized)#\(limit)"
        if let cached = cachedTMDBSearches[cacheKey], cached.expiresAt > Date() {
            return cached.value
        }

        let results = try await searchTMDB(query, limit: limit)
        cachedTMDBSearches[cacheKey] = CachedTMDBSearchEntry(
            value: results,
            expiresAt: Date().addingTimeInterval(90)
        )
        trimCachedTMDBSearches()
        return results
    }

    /// Fetches the combined filmography (cast + crew) for a TMDB person via
    /// the `tmdbProxy` callable. Returns each credit tagged with its role so
    /// downstream code can decide whether the person belongs in `castIds`
    /// (acting credits) or `directorIds` (directing credits).
    func fetchTMDBPersonCredits(personTMDBID: Int) async throws -> [TMDBPersonCredit] {
        guard personTMDBID > 0 else { return [] }
        let payload = try await callTMDBProxy(action: "personCredits", payload: [
            "personId": String(personTMDBID),
            "language": "it-IT"
        ])

        let cast = payload["cast"] as? [[String: Any]] ?? []
        let crew = payload["crew"] as? [[String: Any]] ?? []

        var seenKeys: [String: TMDBPersonCredit] = [:]
        var ordered: [String] = []

        func append(_ item: [String: Any], role: TMDBPersonCredit.Role) {
            guard
                let mediaTypeRaw = FirestoreValueReader.string(item["media_type"]),
                mediaTypeRaw == "movie" || mediaTypeRaw == "tv",
                let tmdbId = FirestoreValueReader.int(item["id"])
            else { return }

            let mediaType: MediaType = mediaTypeRaw == "tv" ? .tv : .movie
            let key = "\(mediaType.rawValue)_\(tmdbId)"

            let title = mediaType == .tv
                ? (FirestoreValueReader.string(item["name"]) ?? "")
                : (FirestoreValueReader.string(item["title"]) ?? "")
            let originalTitle = mediaType == .tv
                ? (FirestoreValueReader.string(item["original_name"]) ?? "")
                : (FirestoreValueReader.string(item["original_title"]) ?? "")
            let yearString = mediaType == .tv
                ? FirestoreValueReader.string(item["first_air_date"])
                : FirestoreValueReader.string(item["release_date"])
            let year = yearString.flatMap { Int($0.prefix(4)) }
            let posterPath = FirestoreValueReader.string(item["poster_path"]).flatMap {
                URL(string: "https://image.tmdb.org/t/p/w342\($0)")
            }
            let genreIDs = (item["genre_ids"] as? [Any] ?? []).compactMap(FirestoreValueReader.int)

            let result = TMDBSearchResult(
                id: "tmdb_\(mediaType.rawValue)_\(tmdbId)",
                tmdbId: tmdbId,
                mediaType: mediaType,
                title: title,
                originalTitle: originalTitle,
                year: year,
                overview: FirestoreValueReader.string(item["overview"]) ?? "",
                posterURL: posterPath,
                genreIds: genreIDs
            )

            if let existing = seenKeys[key] {
                // Same title can show up twice when the person is both cast
                // and crew. Prefer the cast role for surfacing in the cast
                // tab, otherwise promote a director credit over generic crew.
                if existing.role == .cast { return }
                if role == .cast || (existing.role == .crewOther && role == .director) {
                    seenKeys[key] = TMDBPersonCredit(result: result, role: role)
                }
                return
            }

            seenKeys[key] = TMDBPersonCredit(result: result, role: role)
            ordered.append(key)
        }

        for item in cast { append(item, role: .cast) }
        for item in crew {
            let job = FirestoreValueReader.string(item["job"]) ?? ""
            let role: TMDBPersonCredit.Role = job == "Director" ? .director : .crewOther
            append(item, role: role)
        }

        return ordered.compactMap { seenKeys[$0] }
    }

    /// Episodi (nome + data + sinossi) di una singola stagione, letti da TMDB
    /// via `tmdbProxy` (action `seasonEpisodes`). Alimentano la lista episodi
    /// per-riga della scheda titolo. Read-only, cache 7g lato server + cache in
    /// memoria per (tmdbId, stagione) lato client. Nessuna scrittura.
    func fetchTMDBSeasonEpisodes(tmdbID: Int, season: Int) async throws -> [TitleEpisode] {
        guard tmdbID > 0, season >= 0 else { return [] }
        let cacheKey = "\(tmdbID)_\(season)"
        if let cached = cachedSeasonEpisodes[cacheKey] { return cached }

        let payload = try await callTMDBProxy(action: "seasonEpisodes", payload: [
            "tmdbId": String(tmdbID),
            "season": String(season),
            "language": "it-IT"
        ])

        let rawEpisodes = payload["episodes"] as? [[String: Any]] ?? []
        let episodes = rawEpisodes
            .compactMap { item -> TitleEpisode? in
                guard let number = FirestoreValueReader.int(item["episode_number"]), number > 0 else { return nil }
                return TitleEpisode(
                    number: number,
                    name: FirestoreValueReader.string(item["name"]) ?? "",
                    airDate: FirestoreValueReader.string(item["air_date"]),
                    overview: FirestoreValueReader.string(item["overview"]),
                    voteAverage: FirestoreValueReader.double(item["vote_average"]) ?? 0
                )
            }
            .sorted { $0.number < $1.number }

        cachedSeasonEpisodes[cacheKey] = episodes
        return episodes
    }

    /// Asks the `linkPersonToTitles` cloud function to reconcile the local
    /// catalog with the TMDB filmography of `personTMDBID`: existing local
    /// titles get the personId arrayUnion'd into `castIds` / `directorIds`,
    /// missing titles get auto-created as approved stubs. The server runs
    /// with admin privileges so this works for every signed-in account, not
    /// just admins. Returns the number of documents that changed so the
    /// caller can decide whether to refresh the UI.
    @discardableResult
    func enrichLocalCatalog(forPersonTMDBID personTMDBID: Int, currentUser: AppUser?) async -> Int {
        guard personTMDBID > 0 else { return 0 }
        do {
            let response = try await invokeCallable(name: "linkPersonToTitles", payload: [
                "personId": String(personTMDBID)
            ])
            let payload = (response.data as? [String: Any]) ?? [:]
            let imported = FirestoreValueReader.int(payload["imported"]) ?? 0
            let linked = FirestoreValueReader.int(payload["linked"]) ?? 0
            return imported + linked
        } catch {
            return 0
        }
    }

    func resolveTMDBSearchResult(
        _ result: TMDBSearchResult,
        localCandidates: [Title] = [],
        currentUser: AppUser?
    ) async throws -> Title {
        if let localMatch = pickBestTitleMatch(
            localCandidates.filter { matchesTMDBSearchResult(result, title: $0) },
            preferredType: result.mediaType,
            preferredTMDBID: result.tmdbId
        ) {
            return localMatch
        }

        if let existing = try await findTitleByTMDBID(result.tmdbId, mediaType: result.mediaType) {
            return existing
        }

        let dedupeKey = TitleParsing.makeDedupeKey(name: result.title, type: result.mediaType, year: result.year)
        if let existing = try await findTitleByDedupeKey(dedupeKey) {
            return existing
        }

        return try await importTMDBTitle(result, currentUser: currentUser)
    }

    func importTMDBTitle(_ result: TMDBSearchResult, currentUser: AppUser?) async throws -> Title {
        guard let currentUser, currentUser.permissions.canAutoApproveTitles else {
            throw NSError(domain: "TwoWatch", code: 401, userInfo: [
                NSLocalizedDescriptionKey: String(localized: "Questo account non può auto-approvare import da TMDB.")
            ])
        }

        if let existing = try await findTitleByTMDBID(result.tmdbId, mediaType: result.mediaType) {
            return existing
        }

        let mapped = try await fetchTMDBDetails(result)
        let dedupeKey = TitleParsing.makeDedupeKey(name: mapped.name, type: mapped.type, year: mapped.year)
        if let existing = try await findTitleByDedupeKey(dedupeKey) {
            return existing
        }

        let documentID = "tmdb_\(mapped.type.rawValue)_\(mapped.tmdbID)"
        let metadata: [String: Any] = [
            "tmdbId": mapped.tmdbID,
            "mediaType": mapped.type.rawValue,
            "source": "tmdb-search",
            "language": mapped.language as Any,
            "country": mapped.country as Any,
            "network": mapped.network as Any,
            "durationMovie": mapped.durationMovie as Any,
            "durationEpisode": mapped.durationEpisode as Any,
            "seasonsCount": mapped.seasonsCount as Any,
            "episodesPerSeason": mapped.episodesPerSeason as Any,
            "collectionId": mapped.collectionID as Any,
            "collectionName": mapped.collectionName as Any,
            "collectionPosterPath": mapped.collectionPosterURL?.absoluteString as Any,
            "collectionBackdropPath": mapped.collectionBackdropURL?.absoluteString as Any
        ].compactMapValues { value in
            value as? AnyHashable == nil && value is NSNull ? nil : value
        }

        let searchableText = TitleParsing.buildSearchableText(
            name: mapped.name,
            originalName: mapped.originalName,
            aliases: mapped.aliases,
            collectionName: mapped.collectionName,
            keywords: mapped.keywords,
            overview: mapped.description
        )
        let searchCorpus = [
            mapped.name,
            mapped.originalName ?? "",
            mapped.aliases.joined(separator: " "),
            mapped.collectionName ?? "",
            mapped.keywords.joined(separator: " "),
            searchableText
        ]
            .joined(separator: " ")

        try await db.collection("titles").document(documentID).setData([
            "type": mapped.type.rawValue,
            "name": mapped.name,
            "nameLower": SearchNormalizer.normalize(mapped.name),
            "year": mapped.year as Any,
            "genres": mapped.genres,
            "originalName": mapped.originalName as Any,
            "aliases": mapped.aliases,
            "directors": mapped.directors,
            "directorIds": mapped.directorIDs,
            "cast": mapped.cast,
            "castIds": mapped.castIDs,
            "castWithCharacters": mapped.castWithCharacters,
            "keywords": mapped.keywords,
            "collectionId": mapped.collectionID as Any,
            "collectionName": mapped.collectionName as Any,
            "collectionPosterPath": mapped.collectionPosterURL?.absoluteString as Any,
            "collectionBackdropPath": mapped.collectionBackdropURL?.absoluteString as Any,
            "searchableText": searchableText,
            "description": mapped.description as Any,
            "posterPath": mapped.posterURL?.absoluteString as Any,
            "backdropPath": mapped.backdropURL?.absoluteString as Any,
            "createdBy": currentUser.id,
            "createdAt": FieldValue.serverTimestamp(),
            "updatedAt": FieldValue.serverTimestamp(),
            "status": "approved",
            "search": [
                "normalized": SearchNormalizer.normalize(mapped.name),
                "dedupeKey": dedupeKey,
                "prefixes": SearchNormalizer.prefixes(from: mapped.name, maxLength: 6),
                "tokens": SearchNormalizer.tokens(from: searchCorpus),
                "searchableText": searchableText
            ],
            "meta": metadata,
            "tmdbId": mapped.tmdbID,
            "ratingCount": 0,
            "ratingAvg": 0,
            "reviewCount": 0
        ])
        cachedTitleSearches.removeAll()
        invalidateCachedTitle(id: documentID)

        guard let created = try await fetchTitle(id: documentID) else {
            throw NSError(domain: "TwoWatch", code: 500, userInfo: [NSLocalizedDescriptionKey: String(localized: "Import TMDB completato ma documento non leggibile.")])
        }
        return created
    }

    func fetchProviders(for titleID: String, region: String) async throws -> TitleProviders? {
        let response = try await invokeCallable(name: "getWatchProviders", payload: [
            "titleId": titleID,
            "region": region
        ])
        guard let payload = response.data as? [String: Any] else { return nil }

        let providerBundle = FirestoreValueReader.map(payload["providers"])
        let customRows = payload["customAdmin"] as? [[String: Any]] ?? []

        let providers = TitleParsing.providerRows(from: providerBundle).map {
            StreamingProvider(id: $0.id, name: $0.name, logoURL: $0.logoURL, type: $0.type)
        }

        let customProviders = customRows.compactMap { row -> StreamingProvider? in
            guard let name = FirestoreValueReader.string(row["name"]) else { return nil }
            return StreamingProvider(
                id: "custom-\(name)",
                name: name,
                logoURL: URL(string: FirestoreValueReader.string(row["logoUrl"]) ?? FirestoreValueReader.string(row["logoPath"]) ?? ""),
                type: "custom"
            )
        }

        // I link diretti arrivano come mappa nome→URL. Parse difensivo: una
        // voce malformata si salta, non fa cadere l'intera risposta.
        var deepLinks: [String: URL] = [:]
        if let raw = payload["deepLinks"] as? [String: Any] {
            for (name, value) in raw {
                guard let string = value as? String,
                      let url = URL(string: string),
                      url.scheme?.lowercased() == "https"
                else { continue }
                deepLinks[name] = url
            }
        }

        return TitleProviders(
            region: FirestoreValueReader.string(payload["region"]) ?? region,
            link: URL(string: FirestoreValueReader.string(providerBundle["link"]) ?? ""),
            providers: providers,
            customProviders: customProviders,
            deepLinks: deepLinks
        )
    }

    func fetchTrailerURL(for title: Title) async throws -> URL? {
        // 1. Cached on the title doc → use directly, no roundtrip.
        if let cached = title.trailerURL {
            return cached
        }
        if let manualTrailerURL = try await fetchManualTrailerURL(for: title.id) {
            return manualTrailerURL
        }

        // 2. Otherwise ask the cache-or-enrich callable. It writes back to
        //    Firestore so the next open hits step 1 with no TMDb hop.
        if let enriched = try? await enrichTitleAssets(title: title, includeCast: false),
           let url = enriched.trailerURL {
            return url
        }

        // 3. Last-resort fallback (legacy path) for titles without a tmdbId or
        //    when the callable failed.
        guard let target = try await resolveTrailerTarget(for: title) else { return nil }

        let localizedPayload = try await callTMDBProxy(action: "videos", payload: [
            "tmdbId": String(target.tmdbId),
            "mediaType": target.mediaType.rawValue,
            "language": "it-IT"
        ])

        if let url = bestTrailerURL(from: localizedPayload) {
            return url
        }

        let fallbackPayload = try await callTMDBProxy(action: "videos", payload: [
            "tmdbId": String(target.tmdbId),
            "mediaType": target.mediaType.rawValue
        ])
        return bestTrailerURL(from: fallbackPayload)
    }

    /// Timeline persistita e fallback TMDB live. Le query pubbliche includono
    /// sempre `status == published` / `visibility == public`, come richiesto
    /// dalle Firestore rules.
    func fetchTitleUpdates(for title: Title, includeOfficialUpdates: Bool = true) async throws -> TitleUpdatesSnapshot {
        async let eventsTask = fetchPersistedTitleUpdates(titleID: title.id)
        async let officialUpdatesTask = fetchLinkedOfficialUpdates(
            titleID: title.id,
            includeOfficialUpdates: includeOfficialUpdates
        )
        async let tmdbTask = fetchTMDBTitleUpdates(for: title)

        var firstError: Error?
        let events: [TitleUpdateEvent]
        do {
            events = try await eventsTask
        } catch {
            firstError = error
            events = []
        }

        let officialUpdates: [TitleOfficialUpdate]
        do {
            officialUpdates = try await officialUpdatesTask
        } catch {
            if firstError == nil { firstError = error }
            officialUpdates = []
        }

        let tmdbUpdates: TitleTMDBUpdatesResult
        do {
            tmdbUpdates = try await tmdbTask
        } catch {
            if firstError == nil { firstError = error }
            tmdbUpdates = TitleTMDBUpdatesResult(release: nil, videos: [])
        }

        if events.isEmpty, officialUpdates.isEmpty, tmdbUpdates.videos.isEmpty, tmdbUpdates.release == nil, let firstError {
            throw firstError
        }
        let persistedVideoIDs = Set(events.compactMap { $0.video?.id })
        return TitleUpdatesSnapshot(
            release: tmdbUpdates.release,
            videos: tmdbUpdates.videos.filter { !persistedVideoIDs.contains($0.id) },
            events: events,
            officialUpdates: officialUpdates
        )
    }

    private func fetchTMDBTitleUpdates(for title: Title) async throws -> TitleTMDBUpdatesResult {
        guard let tmdbID = title.metadata.tmdbId, tmdbID > 0 else {
            return TitleTMDBUpdatesResult(release: nil, videos: [])
        }
        let mediaType = title.type == .tv ? "tv" : "movie"
        async let localizedVideosTask = fetchTMDBUpdateVideos(tmdbID: tmdbID, mediaType: mediaType, language: "it-IT")
        async let englishVideosTask = fetchTMDBUpdateVideos(tmdbID: tmdbID, mediaType: mediaType, language: "en-US")
        async let releaseTask = fetchTMDBReleaseUpdate(tmdbID: tmdbID, mediaType: mediaType, titleType: title.type)

        var firstError: Error?
        var succeededRequests = 0
        let localizedVideos: [TitleUpdateVideo]
        do {
            localizedVideos = try await localizedVideosTask
            succeededRequests += 1
        } catch {
            firstError = error
            localizedVideos = []
        }
        let englishVideos: [TitleUpdateVideo]
        do {
            englishVideos = try await englishVideosTask
            succeededRequests += 1
        } catch {
            if firstError == nil { firstError = error }
            englishVideos = []
        }
        let release: TitleReleaseUpdate?
        do {
            release = try await releaseTask
            succeededRequests += 1
        } catch {
            if firstError == nil { firstError = error }
            release = nil
        }

        var seenVideoIDs = Set<String>()
        let videos = (localizedVideos + englishVideos)
            .filter { video in
                seenVideoIDs.insert(video.id).inserted
            }
            .sorted { ($0.publishedAt ?? .distantPast) > ($1.publishedAt ?? .distantPast) }
            .prefix(6)

        if succeededRequests == 0, let firstError {
            throw firstError
        }
        return TitleTMDBUpdatesResult(release: release, videos: Array(videos))
    }

    private func fetchTMDBUpdateVideos(tmdbID: Int, mediaType: String, language: String) async throws -> [TitleUpdateVideo] {
        let payload = try await callTMDBProxy(action: "videos", payload: [
            "tmdbId": String(tmdbID), "mediaType": mediaType, "language": language
        ])
        return (payload["results"] as? [[String: Any]] ?? []).compactMap { row in
            guard FirestoreValueReader.string(row, key: "site")?.lowercased() == "youtube",
                  let key = FirestoreValueReader.string(row, key: "key"), !key.isEmpty
            else { return nil }
            let rawType = FirestoreValueReader.string(row, key: "type")?.lowercased() ?? ""
            guard rawType == "trailer" || rawType == "teaser" else { return nil }
            return TitleUpdateVideo(
                id: key,
                name: FirestoreValueReader.string(row, key: "name") ?? (rawType == "teaser" ? "Teaser" : "Trailer"),
                kind: rawType,
                isOfficial: FirestoreValueReader.bool(row["official"]) ?? false,
                publishedAt: TitleParsing.tmdbDate(FirestoreValueReader.string(row, key: "published_at"))
            )
        }
    }

    private func fetchTMDBReleaseUpdate(tmdbID: Int, mediaType: String, titleType: MediaType) async throws -> TitleReleaseUpdate? {
        let payload = try await callTMDBProxy(action: "details", payload: [
            "tmdbId": String(tmdbID), "mediaType": mediaType, "language": "it-IT"
        ])
        guard titleType == .tv else {
            // La data globale dei film non prova la disponibilità italiana.
            return nil
        }
        let nextEpisode = FirestoreValueReader.map(payload["next_episode_to_air"])
        guard let date = TitleParsing.tmdbDate(FirestoreValueReader.string(nextEpisode, key: "air_date")),
              date >= Calendar.current.startOfDay(for: Date())
        else { return nil }
        return TitleReleaseUpdate(
            date: date,
            season: FirestoreValueReader.int(nextEpisode, key: "season_number"),
            episode: FirestoreValueReader.int(nextEpisode, key: "episode_number"),
            name: FirestoreValueReader.string(nextEpisode, key: "name"),
            isEpisode: true
        )
    }

    func fetchTitleUpdatePreference(userID: String, titleID: String) async throws -> TitleUpdatePreference {
        let snapshot = try await db.collection("users").document(userID)
            .collection("titleUpdatePrefs").document(titleID)
            .getDocument()
        let data = snapshot.data() ?? [:]
        guard snapshot.exists,
              let rawValue = FirestoreValueReader.string(data, key: "mode")
        else { return .automatic }
        return TitleUpdatePreference(rawValue: rawValue) ?? .automatic
    }

    /// Tetto alla lettura in blocco delle preferenze: la collezione e' piccola
    /// per costruzione (un documento solo per i titoli su cui l'utente ha
    /// scelto qualcosa), ma una query senza limite su dati dell'utente e' un
    /// costo che nessuno controlla.
    private static let titleUpdatePrefsPageSize = 300

    /// Tutte le preferenze "aggiornamenti" del viewer, come `titleId -> modo`.
    ///
    /// PERCHE' IN BLOCCO — il bottone "Segui" delle card social deve nascere
    /// gia' nello stato giusto, e una card non e' una: nel feed sono decine.
    /// Con `fetchTitleUpdatePreference` sarebbe una lettura per card ad ogni
    /// comparsa in lista; qui e' una query per schermata.
    ///
    /// I titoli assenti valgono `auto`, che e' anche il significato
    /// dell'assenza del documento: per questo `auto` non compare mai fra i
    /// valori restituiti. Stessa forma di `listMyTitleUpdatePreferences` sul
    /// web, e stessa rule che la copre (`read: isOwner(userId)`).
    func fetchTitleUpdatePreferences(userID: String) async throws -> [String: TitleUpdatePreference] {
        guard !userID.isEmpty else { return [:] }
        let snapshot = try await db.collection("users").document(userID)
            .collection("titleUpdatePrefs")
            .limit(to: Self.titleUpdatePrefsPageSize)
            .getDocuments()

        var result: [String: TitleUpdatePreference] = [:]
        for document in snapshot.documents {
            guard let rawValue = FirestoreValueReader.string(document.data(), key: "mode"),
                  let preference = TitleUpdatePreference(rawValue: rawValue),
                  preference != .automatic
            else { continue }
            result[document.documentID] = preference
        }
        return result
    }

    func setTitleUpdatePreference(userID: String, titleID: String, preference: TitleUpdatePreference) async throws {
        let reference = db.collection("users").document(userID)
            .collection("titleUpdatePrefs").document(titleID)
        if preference == .automatic {
            try await reference.delete()
            return
        }
        try await reference.setData([
            "titleId": titleID,
            "mode": preference.rawValue,
            "updatedAt": FieldValue.serverTimestamp()
        ])
    }

    private func fetchPersistedTitleUpdates(titleID: String) async throws -> [TitleUpdateEvent] {
        let snapshot = try await db.collection("titleUpdateEvents")
            .whereField("titleId", isEqualTo: titleID)
            .whereField("status", isEqualTo: "published")
            .order(by: "sortAt", descending: true)
            .limit(to: 20)
            .getDocuments()
        return snapshot.documents.compactMap {
            Self.makeUpdateEvent(id: $0.documentID, data: $0.data())
        }
    }

    /// Decodifica di un documento `titleUpdateEvents`, unica per tutti i
    /// consumer: la timeline della scheda titolo e il badge "In uscita" della
    /// watchlist leggono lo stesso contratto, quindi un campo rinominato lato
    /// backend si corregge in un punto solo.
    private static func makeUpdateEvent(id: String, data: [String: Any]) -> TitleUpdateEvent? {
        guard let eventType = FirestoreValueReader.string(data, key: "eventType"),
              let sourceID = FirestoreValueReader.string(data, key: "sourceId"),
              let headline = TitleParsing.localizedTitleUpdateText(data["headlineByLocale"]),
              !headline.isEmpty
        else { return nil }
        return TitleUpdateEvent(
            id: id,
            eventType: eventType,
            headline: headline,
            entityName: TitleParsing.localizedTitleUpdateText(data["entityNameByLocale"]),
            sourceID: sourceID,
            sourceURL: TitleUpdateSupport.safeSourceURL(FirestoreValueReader.string(data, key: "sourceUrl")),
            isOfficial: FirestoreValueReader.bool(data, key: "official") ?? false,
            sortAt: FirestoreValueReader.date(data["sortAt"]),
            effectiveAt: FirestoreValueReader.date(data["effectiveAt"])
        )
    }

    /// Quanti valori accetta una `in` di Firestore.
    private static let inFilterLimit = 30

    /// Date di uscita **future** gia' pubblicate, per un gruppo di titoli.
    ///
    /// PERCHE' IN BLOCCO — la watchlist deve marcare "In uscita" molte righe
    /// insieme: una query per riga sarebbe una lettura per card ad ogni
    /// comparsa in lista. Firestore accetta al massimo 30 valori in una `in`,
    /// quindi gli id vanno a blocchi da 30, sequenziali come nel resto dei
    /// repository (`ThreadsRepository`): il chiamante ne passa pochi per
    /// costruzione, e le richieste in parallelo qui costerebbero un
    /// attraversamento di isolamento senza guadagno misurabile.
    ///
    /// SOGLIA — mezzanotte di stanotte. `effectiveAt` e' ancorato a
    /// mezzogiorno UTC del giorno di uscita, quindi il giorno stesso resta
    /// "uscito": la stessa convenzione di `EpisodeAirDate.isFuture`.
    ///
    /// INDICE — richiede il composito
    /// `titleId ASC, eventType ASC, status ASC, effectiveAt ASC`
    /// (`firestore.indexes.json`). Il filtro `status == published` non e'
    /// opzionale: senza, le rules rifiutano l'intera query.
    func fetchUpcomingReleaseDates(titleIDs: [String]) async throws -> [String: Date] {
        var seen: Set<String> = []
        let ids = titleIDs.filter { !$0.isEmpty && seen.insert($0).inserted }
        guard !ids.isEmpty else { return [:] }

        let threshold = Self.upcomingReleaseThreshold()
        var result: [String: Date] = [:]

        for chunk in ids.chunked(into: Self.inFilterLimit) {
            let snapshot = try await db.collection("titleUpdateEvents")
                .whereField("titleId", in: chunk)
                .whereField("eventType", isEqualTo: "release_date")
                .whereField("status", isEqualTo: "published")
                .whereField("effectiveAt", isGreaterThan: Timestamp(date: threshold))
                .getDocuments()

            for document in snapshot.documents {
                let data = document.data()
                guard let titleID = FirestoreValueReader.string(data, key: "titleId"),
                      let event = Self.makeUpdateEvent(id: document.documentID, data: data),
                      let effectiveAt = event.effectiveAt
                else { continue }
                // Un titolo ha un solo evento `release_date` (id deterministico
                // `tmdb_release_movie_{tmdbId}`); se ne arrivassero due, vince
                // la data piu' vicina, che e' quella che l'utente aspetta.
                if let existing = result[titleID], existing <= effectiveAt { continue }
                result[titleID] = effectiveAt
            }
        }
        return result
    }

    /// Mezzanotte di stanotte nel fuso del device: un film che esce oggi non e'
    /// "in uscita", e' uscito.
    private static func upcomingReleaseThreshold(now: Date = Date()) -> Date {
        let calendar = Calendar.current
        let startOfToday = calendar.startOfDay(for: now)
        return calendar.date(byAdding: .day, value: 1, to: startOfToday) ?? startOfToday
    }

    private func fetchLinkedOfficialUpdates(titleID: String, includeOfficialUpdates: Bool) async throws -> [TitleOfficialUpdate] {
        guard includeOfficialUpdates else { return [] }
        let snapshot = try await db.collection("posts")
            .whereField("linkedTitleIds", arrayContains: titleID)
            .whereField("visibility", isEqualTo: "public")
            .limit(to: 12)
            .getDocuments()
        return snapshot.documents.compactMap { document in
            let data = document.data()
            guard FirestoreValueReader.bool(data, key: "isOfficialUpdate") == true else { return nil }
            let official = FirestoreValueReader.map(data["officialUpdate"])
            let title = FirestoreValueReader.string(official, key: "title")
                ?? FirestoreValueReader.string(data, key: "text")
                ?? String(localized: "Aggiornamento ufficiale")
            return TitleOfficialUpdate(
                id: document.documentID,
                title: title,
                createdAt: FirestoreValueReader.date(data["createdAt"])
            )
        }
        .sorted { ($0.createdAt ?? .distantPast) > ($1.createdAt ?? .distantPast) }
    }

    /// Calls the `enrichTitleAssets` cloud function. CF is idempotent and
    /// caches results back on the title doc, so subsequent reads can use
    /// `Title.trailerURL` / `Title.castWithCharacters` directly.
    @discardableResult
    func enrichTitleAssets(
        title: Title,
        includeTrailer: Bool = true,
        includeCast: Bool = true
    ) async throws -> TitleEnrichmentResult {
        var payload: [String: any Sendable] = [
            "titleId": title.id,
            "includeTrailer": includeTrailer,
            "includeCast": includeCast
        ]
        if let tmdbId = title.metadata.tmdbId {
            payload["tmdbId"] = tmdbId
        }
        payload["mediaType"] = title.metadata.mediaType.rawValue
        let result = try await CloudFunctionsCaller.call(name: "enrichTitleAssets", data: payload)
        // La CF scrive trailer/cast sul doc titolo: il cache non deve servire
        // la versione pre-enrichment.
        invalidateCachedTitle(id: title.id)
        let dict = (result.data as? [String: Any]) ?? [:]
        var url: URL?
        if let raw = dict["trailerUrl"] as? String, !raw.isEmpty {
            url = (try? TitleParsing.normalizedEditorialTrailerURL(from: raw)) ?? URL(string: raw)
        }
        var members: [TitleCastMember] = []
        if let arr = dict["castWithCharacters"] as? [[String: Any]] {
            for (offset, row) in arr.enumerated() {
                guard let personId = row["personId"] as? String, !personId.isEmpty,
                      let name = row["name"] as? String, !name.isEmpty else { continue }
                let character = (row["character"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                let profileURL = (row["profilePath"] as? String).flatMap { URL(string: $0) }
                let order = (row["order"] as? Int) ?? offset
                members.append(TitleCastMember(
                    personId: personId,
                    name: name,
                    character: character,
                    profileURL: profileURL,
                    order: order
                ))
            }
        }
        return TitleEnrichmentResult(trailerURL: url, castWithCharacters: members)
    }

    func fetchSeasonMetadata(for title: Title) async throws -> [TitleSeason] {
        if title.type != .tv {
            return []
        }

        guard let tmdbId = title.metadata.tmdbId else {
            return TitleParsing.fallbackSeasonMetadata(from: title.metadata)
        }

        do {
            let payload = try await callTMDBProxy(action: "details", payload: [
                "tmdbId": String(tmdbId),
                "mediaType": title.type.rawValue,
                "language": "it-IT"
            ])

            let seasons = (payload["seasons"] as? [[String: Any]] ?? []).compactMap { row -> TitleSeason? in
                guard let seasonNumber = FirestoreValueReader.int(row["season_number"]), seasonNumber > 0 else { return nil }
                return TitleSeason(
                    seasonNumber: seasonNumber,
                    episodeCount: FirestoreValueReader.int(row["episode_count"]) ?? 0,
                    name: FirestoreValueReader.string(row["name"]),
                    airDate: FirestoreValueReader.string(row["air_date"])
                )
            }

            if !seasons.isEmpty {
                return seasons.sorted { $0.seasonNumber < $1.seasonNumber }
            }
        } catch {
            // Fallback below.
        }

        return TitleParsing.fallbackSeasonMetadata(from: title.metadata)
    }

    func fetchTitleLevelRatings(for titleID: String) async throws -> [Rating] {
        let page = try await fetchRatings(for: titleID, level: "title")
        return page.ratings
    }

    /// Carica al massimo `limit` ratings per `titleID` (default 50). Per
    /// paginare, ripassa `cursor: result.next` alla chiamata successiva.
    /// Cap obbligatorio: senza `.limit(to:)` la query è O(N) sul numero di
    /// review e fa risplodere i costi Firestore su titoli popolari.
    func fetchRatings(
        for titleID: String,
        level: String? = nil,
        cursor: DocumentSnapshot? = nil,
        limit: Int = 50
    ) async throws -> (ratings: [Rating], next: DocumentSnapshot?) {
        var query: Query = db.collection("ratings")
            .whereField("titleId", isEqualTo: titleID)

        if let level {
            query = query.whereField("level", isEqualTo: level)
        }

        query = query.order(by: "updatedAt", descending: true)

        if let cursor {
            query = query.start(afterDocument: cursor)
        }

        query = query.limit(to: limit)

        let snapshot = try await query.getDocuments()

        let userIDs = Array(Set(snapshot.documents.compactMap { FirestoreValueReader.string($0.data(), key: "uid") }))
        let usersByID = try await fetchUsersMap(userIDs: userIDs)

        let ratings = snapshot.documents.compactMap { snapshotToRating($0, usersByID: usersByID) }
            .sorted { ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast) }

        let next = snapshot.documents.count >= limit ? snapshot.documents.last : nil
        return (ratings, next)
    }

    func submitTitleRating(
        userID: String,
        titleID: String,
        value: Double,
        reviewText: String?
    ) async throws {
        try await submitRating(
            userID: userID,
            titleID: titleID,
            level: "title",
            season: nil,
            episode: nil,
            value: value,
            reviewText: reviewText,
            details: nil
        )
    }

    /// Migrazione 1-tap: sposta un rating esistente da un livello a un altro
    /// (es. title → season). Mantiene voto, reviewText, watchedWith, media e
    /// crea un nuovo documento con id composito coerente, poi elimina il
    /// vecchio. Tutto in batch atomico.
    func migrateRatingLevel(
        rating: Rating,
        toLevel newLevel: String,
        season: Int?,
        episode: Int?
    ) async throws {
        let newRatingID = TitleParsing.makeRatingID(
            userID: rating.uid,
            titleID: rating.titleId,
            level: newLevel,
            season: season,
            episode: episode
        )
        // Se l'id non cambia non c'è nulla da migrare.
        guard newRatingID != rating.id else { return }

        let oldRef = db.collection("ratings").document(rating.id)
        let newRef = db.collection("ratings").document(newRatingID)

        let oldSnap = try await oldRef.getDocument()
        guard let oldData = oldSnap.data() else { return }

        var newData = oldData
        newData["level"] = newLevel
        newData["season"] = season.map { $0 as Any } ?? NSNull()
        newData["episode"] = episode.map { $0 as Any } ?? NSNull()
        newData["source"] = "user"
        newData["updatedAt"] = FieldValue.serverTimestamp()

        let batch = db.batch()
        batch.setData(newData, forDocument: newRef, merge: false)
        batch.deleteDocument(oldRef)
        try await batch.commit()
    }

    func submitRating(
        userID: String,
        titleID: String,
        level: String,
        season: Int?,
        episode: Int?,
        value: Double,
        reviewText: String?,
        details: RatingSocialDetails? = nil
    ) async throws {
        let ratingID = TitleParsing.makeRatingID(userID: userID, titleID: titleID, level: level, season: season, episode: episode)
        let ratingRef = db.collection("ratings").document(ratingID)

        let existing = try await ratingRef.getDocument()
        let batch = db.batch()

        // Le Firestore rules accettano solo 1 <= rating <= 10: clamp difensivo
        // così nessun controllo UI può produrre un permission denied.
        let clampedValue = max(1, min(10, value))

        var payload: [String: Any] = [
            "uid": userID,
            "titleId": titleID,
            "level": level,
            "season": season.map { $0 as Any } ?? NSNull(),
            "episode": episode.map { $0 as Any } ?? NSNull(),
            "rating": clampedValue,
            "source": "user",
            "updatedAt": FieldValue.serverTimestamp()
        ]
        if !existing.exists {
            payload["createdAt"] = FieldValue.serverTimestamp()
        }
        if let reviewText, !reviewText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            payload["reviewText"] = String(reviewText.prefix(5000))
        }

        if let details {
            let normalizedReview = details.reviewText?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if let normalizedReview, !normalizedReview.isEmpty {
                payload["reviewText"] = String(normalizedReview.prefix(5000))
            } else if existing.exists {
                payload["reviewText"] = FieldValue.delete()
            }

            let watchedWithRows = TitleParsing.normalizedWatchedWith(details.watchedWith)
            if !watchedWithRows.isEmpty {
                payload["watchedWith"] = watchedWithRows
            } else if existing.exists {
                payload["watchedWith"] = FieldValue.delete()
            }

            if let watchedWithGroup = details.watchedWithGroup {
                payload["watchedWithGroup"] = [
                    "threadId": watchedWithGroup.id,
                    "groupName": String(watchedWithGroup.groupName.prefix(80))
                ]
            } else if existing.exists {
                payload["watchedWithGroup"] = FieldValue.delete()
            }

            let mediaUrls = TitleParsing.normalizedMediaURLs(details.mediaURLs)
            if let firstMediaURL = mediaUrls.first {
                payload["reviewPhotoUrl"] = firstMediaURL
                payload["mediaUrls"] = mediaUrls
            } else if existing.exists {
                payload["reviewPhotoUrl"] = FieldValue.delete()
                payload["mediaUrls"] = FieldValue.delete()
            }
        }

        batch.setData(payload, forDocument: ratingRef, merge: true)

        try await batch.commit()
    }

    /// Rimuove un voto dell'utente cancellando il documento `/ratings/{id}`.
    /// Il resto è a carico del backend: il trigger `recomputeTitleRatingAggregate`
    /// sottrae il voto dall'aggregato community e `syncTitleStateFromTitleRating`
    /// azzera il flag di voto sul titleState (il titolo resta "visto senza voto").
    /// Nessuna gestione client dell'aggregato o dello stato è necessaria.
    /// La cancellazione di un doc inesistente è un no-op lato Firestore.
    func deleteRating(
        userID: String,
        titleID: String,
        level: String = "title",
        season: Int? = nil,
        episode: Int? = nil
    ) async throws {
        let ratingID = TitleParsing.makeRatingID(userID: userID, titleID: titleID, level: level, season: season, episode: episode)
        try await db.collection("ratings").document(ratingID).delete()
    }

    /// Emozioni post-visione ("Che impressione hai avuto?"). 1 doc per utente
    /// per titolo (id composito identico ai ratings, level fisso "title").
    /// Deselezione totale (`emotions` vuoto) = delete del doc.
    func submitTitleEmotions(
        userID: String,
        titleID: String,
        emotions: [TitleEmotion]
    ) async throws {
        let emotionID = makeEmotionID(userID: userID, titleID: titleID)
        let emotionRef = db.collection("titleEmotions").document(emotionID)

        guard !emotions.isEmpty else {
            // Delete su doc inesistente = permission denied dalle rules
            // (resource null): capita se l'utente deseleziona tutto senza
            // aver mai salvato.
            let snapshot = try await emotionRef.getDocument()
            if snapshot.exists {
                try await emotionRef.delete()
            }
            return
        }

        let existing = try await emotionRef.getDocument()

        var uniqueKeys: [String] = []
        var seenKeys = Set<String>()
        for emotion in emotions where !seenKeys.contains(emotion.rawValue) {
            seenKeys.insert(emotion.rawValue)
            uniqueKeys.append(emotion.rawValue)
        }

        var payload: [String: Any] = [
            "uid": userID,
            "titleId": titleID,
            "level": "title",
            "season": NSNull(),
            "episode": NSNull(),
            "emotions": Array(uniqueKeys.prefix(3)),
            "updatedAt": FieldValue.serverTimestamp()
        ]
        if !existing.exists {
            payload["createdAt"] = FieldValue.serverTimestamp()
        }

        try await emotionRef.setData(payload, merge: true)
    }

    /// Get diretto per doc id: nessuna query, 1 read.
    func fetchMyTitleEmotions(userID: String, titleID: String) async throws -> [TitleEmotion] {
        let emotionID = makeEmotionID(userID: userID, titleID: titleID)
        let snapshot = try await db.collection("titleEmotions").document(emotionID).getDocument()
        guard let data = snapshot.data() else { return [] }
        return FirestoreValueReader.stringArray(data["emotions"]).compactMap(TitleEmotion.init(rawValue:))
    }

    /// Emozioni relative a un singolo episodio. Restano intenzionalmente
    /// separate dalle impressioni generali in `titleEmotions`.
    func submitEpisodeEmotions(
        userID: String,
        titleID: String,
        season: Int,
        episode: Int,
        emotions: [TitleEmotion]
    ) async throws {
        guard season > 0, episode > 0 else {
            throw NSError(domain: "TwoWatch", code: 422, userInfo: [
                NSLocalizedDescriptionKey: String(localized: "Stagione o episodio non validi per le emozioni.")
            ])
        }

        let emotionID = TitleParsing.makeRatingID(
            userID: userID,
            titleID: titleID,
            level: "episode",
            season: season,
            episode: episode
        )
        let emotionRef = db.collection("episodeEmotions").document(emotionID)

        guard !emotions.isEmpty else {
            let snapshot = try await emotionRef.getDocument()
            if snapshot.exists {
                try await emotionRef.delete()
            }
            return
        }

        let existing = try await emotionRef.getDocument()
        var uniqueKeys: [String] = []
        var seenKeys = Set<String>()
        for emotion in emotions where !seenKeys.contains(emotion.rawValue) {
            seenKeys.insert(emotion.rawValue)
            uniqueKeys.append(emotion.rawValue)
        }

        var payload: [String: Any] = [
            "uid": userID,
            "titleId": titleID,
            "level": "episode",
            "season": season,
            "episode": episode,
            "emotions": Array(uniqueKeys.prefix(3)),
            "updatedAt": FieldValue.serverTimestamp()
        ]
        if !existing.exists {
            payload["createdAt"] = FieldValue.serverTimestamp()
        }
        try await emotionRef.setData(payload, merge: true)
    }

    func fetchMyEpisodeEmotions(
        userID: String,
        titleID: String,
        season: Int,
        episode: Int
    ) async throws -> [TitleEmotion] {
        guard season > 0, episode > 0 else { return [] }
        let emotionID = TitleParsing.makeRatingID(
            userID: userID,
            titleID: titleID,
            level: "episode",
            season: season,
            episode: episode
        )
        let snapshot = try await db.collection("episodeEmotions").document(emotionID).getDocument()
        guard let data = snapshot.data() else { return [] }
        return FirestoreValueReader.stringArray(data["emotions"]).compactMap(TitleEmotion.init(rawValue:))
    }

    /// Tutte le emozioni scelte dall'utente su tutti i titoli (tab
    /// Community/Attività del profilo). Query a singola uguaglianza
    /// (`uid==userID`, indice automatico, nessun composito richiesto),
    /// nessun `order(by:)` server-side. Cap obbligatorio. Risolve anche il
    /// `Title` associato (batch via `listTitles`) per poster/nome in UI.
    func fetchMyEmotions(userID: String, limit: Int = 300) async throws -> [TitleEmotionEntry] {
        let trimmedUserID = userID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedUserID.isEmpty else { return [] }

        let snapshot = try await db.collection("titleEmotions")
            .whereField("uid", isEqualTo: trimmedUserID)
            .limit(to: limit)
            .getDocuments()

        let rawEntries: [(id: String, titleId: String, emotions: [TitleEmotion], updatedAt: Date?)] =
            snapshot.documents.compactMap { document in
                let data = document.data()
                guard let titleID = FirestoreValueReader.string(data, key: "titleId"), !titleID.isEmpty else {
                    return nil
                }
                let emotions = FirestoreValueReader.stringArray(data["emotions"]).compactMap(TitleEmotion.init(rawValue:))
                guard !emotions.isEmpty else { return nil }
                return (document.documentID, titleID, emotions, FirestoreValueReader.date(data["updatedAt"]))
            }

        let titles = try await listTitles(ids: rawEntries.map(\.titleId))
        let titleMap = Dictionary(titles.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })

        return rawEntries.map { entry in
            TitleEmotionEntry(
                id: entry.id,
                titleId: entry.titleId,
                emotions: entry.emotions,
                updatedAt: entry.updatedAt,
                title: titleMap[entry.titleId]
            )
        }
    }

    /// Voto derivato (privato) dai voti episodio: users/{uid}/derivedRatings/{titleId}.
    /// Read owner-only; nil se l'utente non ha voti episodio su quel titolo.
    func fetchDerivedRating(for titleID: String, userID: String) async throws -> DerivedRating? {
        let snapshot = try await db.collection("users").document(userID)
            .collection("derivedRatings").document(titleID).getDocument()
        guard let data = snapshot.data() else { return nil }
        return DerivedRating.from(map: data, titleId: titleID)
    }

    // ============================================
    // CHARACTER VOTES ("Chi ti ha conquistato?")
    // ============================================
    // Spec: docs/CHARACTER_VOTES_SPEC.md. Gemello di titleEmotions (stesso id
    // composito, stessa sanitizzazione via `TitleParsing.makeRatingID`) ma con una
    // collection propria `characterVotes` + 2 aggregati server-owned +
    // un rollup personale. Solo pick POSITIVI su personaggi, mai un voto su
    // una persona reale. Contratto consumato da Features/: non cambiare
    // nomi/firme senza coordinarsi con chi scrive la UI.

    /// Candidati per il pick a livello titolo (film, o "pick diretto" di una
    /// serie senza episodio in contesto): il cast principale già
    /// denormalizzato su `titles/{id}.castWithCharacters`, nessuna chiamata
    /// di rete. Nessuna guest star a questo livello — è un concetto solo
    /// episodio (spec §6).
    func fetchTitleCharacterCandidates(title: Title) async throws -> [CharacterCandidate] {
        title.castWithCharacters.map { member in
            CharacterCandidate(
                personId: member.personId,
                name: member.name,
                character: member.character,
                profileURL: member.profileURL,
                order: member.order,
                isGuest: false
            )
        }
    }

    /// Candidati per il picker "Chi ti ha conquistato?" di un episodio: guest
    /// star PRIMA (motivo d'essere della feature), poi il cast fisso
    /// Cast COMPLETO del titolo, per il "vedi tutto il cast" della scheda —
    /// via `tmdbProxy` action `titlecredits`. In DB c'è solo
    /// `castWithCharacters`, il top-20 denormalizzato: va bene come anteprima,
    /// non come "tutti". Fallback SILENZIOSO su quei 20 se il titolo non ha
    /// `tmdbId`, se la chiamata fallisce o se TMDB non ha i credits — la lista
    /// non deve mai restare vuota per un errore di rete.
    func fetchFullTitleCast(title: Title) async throws -> [CharacterCandidate] {
        let fallback = try await fetchTitleCharacterCandidates(title: title)

        guard let tmdbId = title.metadata.tmdbId, tmdbId > 0 else { return fallback }

        let payload: [String: Any]
        do {
            payload = try await callTMDBProxy(action: "titlecredits", payload: [
                "tmdbId": String(tmdbId),
                "mediaType": title.type == .tv ? "tv" : "movie",
                "language": "it-IT"
            ])
        } catch {
            return fallback
        }

        if FirestoreValueReader.bool(payload["missing"]) == true {
            return fallback
        }

        var seenPersonIDs = Set<String>()
        let full = (payload["cast"] as? [[String: Any]] ?? [])
            .compactMap { row -> CharacterCandidate? in
                guard let candidate = TitleParsing.parseTMDBCharacterCandidate(row, isGuest: false),
                      !seenPersonIDs.contains(candidate.personId) else { return nil }
                seenPersonIDs.insert(candidate.personId)
                return candidate
            }

        return full.isEmpty ? fallback : full
    }

    /// dell'episodio ordinato per `order` — via `tmdbProxy` action
    /// `episodecredits` (spec §6). Fallback SILENZIOSO su
    /// `title.castWithCharacters` (mai un errore mostrato all'utente, mai una
    /// schermata vuota) se: il titolo non ha `tmdbId`, la chiamata fallisce,
    /// TMDB segnala `missing`, o non restituisce nessun credit utilizzabile.
    func fetchEpisodeCharacterCandidates(title: Title, season: Int, episode: Int) async throws -> [CharacterCandidate] {
        let fallback = try await fetchTitleCharacterCandidates(title: title)

        guard let tmdbId = title.metadata.tmdbId, tmdbId > 0, season > 0, episode > 0 else {
            return fallback
        }

        let payload: [String: Any]
        do {
            payload = try await callTMDBProxy(action: "episodecredits", payload: [
                "tmdbId": String(tmdbId),
                "season": String(season),
                "episode": String(episode),
                "language": "it-IT"
            ])
        } catch {
            // Rete/rate-limit/qualsiasi errore TMDB: mai propagato, si degrada
            // al cast del titolo (spec §6, "mai schermata vuota").
            return fallback
        }

        if FirestoreValueReader.bool(payload["missing"]) == true {
            return fallback
        }

        var seenPersonIDs = Set<String>()
        let guestCandidates = (payload["guestStars"] as? [[String: Any]] ?? [])
            .compactMap { row -> CharacterCandidate? in
                guard let candidate = TitleParsing.parseTMDBCharacterCandidate(row, isGuest: true),
                      !seenPersonIDs.contains(candidate.personId) else { return nil }
                seenPersonIDs.insert(candidate.personId)
                return candidate
            }
        let castCandidates = (payload["cast"] as? [[String: Any]] ?? [])
            .compactMap { row -> CharacterCandidate? in
                guard let candidate = TitleParsing.parseTMDBCharacterCandidate(row, isGuest: false),
                      !seenPersonIDs.contains(candidate.personId) else { return nil }
                seenPersonIDs.insert(candidate.personId)
                return candidate
            }

        let combined = guestCandidates + castCandidates
        return combined.isEmpty ? fallback : combined
    }

    /// Scrive/aggiorna i pick personaggio dell'utente per un episodio/titolo
    /// (spec §2.1). Deselezione totale (`picks` vuoto dopo normalizzazione) =
    /// delete del doc, con get-prima-di-delete (delete su doc inesistente =
    /// deny dalle rules). `titleID` deve già rispettare `^[A-Za-z0-9_-]+$`:
    /// è il vincolo hard delle rules sull'id composito, controllato qui
    /// PRIMA di scrivere per non far arrivare all'utente un permission-denied
    /// illeggibile.
    func submitCharacterPicks(
        titleID: String,
        level: String,
        season: Int,
        episode: Int,
        picks: [CharacterPick],
        userID: String
    ) async throws {
        guard TitleParsing.isSanitizedCharacterVoteTitleID(titleID) else {
            throw NSError(domain: "TwoWatch", code: 422, userInfo: [
                NSLocalizedDescriptionKey: String(localized: "Questo titolo ha un identificativo non compatibile con i voti personaggio.")
            ])
        }
        guard level == "title" || level == "episode" else {
            throw NSError(domain: "TwoWatch", code: 422, userInfo: [
                NSLocalizedDescriptionKey: String(localized: "Livello di voto personaggio non valido.")
            ])
        }

        // level=="title": season/episode fissi a 0 (unico valore accettato
        // dalla rule validCharacterVoteLevelFields). level=="episode":
        // entrambi devono essere > 0.
        let normalizedSeason = level == "title" ? 0 : season
        let normalizedEpisode = level == "title" ? 0 : episode
        if level == "episode" && (normalizedSeason <= 0 || normalizedEpisode <= 0) {
            throw NSError(domain: "TwoWatch", code: 422, userInfo: [
                NSLocalizedDescriptionKey: String(localized: "Stagione o episodio non validi per il voto personaggio.")
            ])
        }

        let voteRef = db.collection("characterVotes").document(TitleParsing.makeRatingID(
            userID: userID,
            titleID: titleID,
            level: level,
            season: normalizedSeason,
            episode: normalizedEpisode
        ))

        let normalizedPicks = TitleParsing.normalizedCharacterPicks(picks)
        guard !normalizedPicks.isEmpty else {
            // Delete su doc inesistente = permission denied dalle rules
            // (resource null): capita se l'utente deseleziona tutto senza
            // aver mai salvato.
            let snapshot = try await voteRef.getDocument()
            if snapshot.exists {
                try await voteRef.delete()
            }
            return
        }

        let existing = try await voteRef.getDocument()
        let picksPayload: [[String: Any]] = normalizedPicks.map { pick in
            var item: [String: Any] = ["personId": pick.personId]
            if let character = pick.character { item["character"] = character }
            if let reaction = pick.reaction { item["reaction"] = reaction }
            return item
        }

        var payload: [String: Any] = [
            "uid": userID,
            "titleId": titleID,
            "level": level,
            "season": normalizedSeason,
            "episode": normalizedEpisode,
            "picks": picksPayload,
            "updatedAt": FieldValue.serverTimestamp()
        ]
        if !existing.exists {
            payload["createdAt"] = FieldValue.serverTimestamp()
        }

        try await voteRef.setData(payload, merge: true)
    }

    /// Get diretto per doc id (nessuna query): i pick dell'utente per UN
    /// episodio/titolo specifico. [] se non ha ancora votato quell'item o se
    /// `level` è fuori enum — mai un errore.
    func fetchMyCharacterPicksForItem(
        titleID: String,
        level: String,
        season: Int,
        episode: Int,
        uid: String
    ) async throws -> [CharacterPick] {
        guard level == "title" || level == "episode" else { return [] }
        let normalizedSeason = level == "title" ? 0 : season
        let normalizedEpisode = level == "title" ? 0 : episode

        let voteID = TitleParsing.makeRatingID(
            userID: uid,
            titleID: titleID,
            level: level,
            season: normalizedSeason,
            episode: normalizedEpisode
        )
        let snapshot = try await db.collection("characterVotes").document(voteID).getDocument()
        guard let data = snapshot.data() else { return [] }
        return TitleParsing.parseCharacterPicks(data["picks"])
    }

    /// Aggregato volume (non utenti unici) di un singolo episodio —
    /// `titles/{titleId}/characterVotes/{season}_{episode}`, spec §2.2. nil
    /// se il doc non esiste ancora (nessuno ha votato quell'episodio).
    func fetchEpisodeCharacterBucket(titleID: String, season: Int, episode: Int) async throws -> CharacterVoteBucket? {
        let snapshot = try await db.collection("titles").document(titleID)
            .collection("characterVotes").document("\(season)_\(episode)")
            .getDocument()
        guard let data = snapshot.data() else { return nil }
        let bucket = CharacterVoteBucket.fromMap(data)
        return (bucket.totalUsers > 0 || !bucket.counts.isEmpty) ? bucket : nil
    }

    /// Tutti i bucket episodio di un titolo, chiavati "{stagione}_{episodio}".
    /// Una sola read di collection invece di N get: serve per mostrare i
    /// personaggi piu' votati per episodio e per stagione (la stagione non ha
    /// un aggregato server, si somma qui dai suoi episodi).
    func fetchEpisodeCharacterBuckets(titleID: String) async throws -> [String: CharacterVoteBucket] {
        let snapshot = try await db.collection("titles").document(titleID)
            .collection("characterVotes")
            .getDocuments()
        var out: [String: CharacterVoteBucket] = [:]
        for doc in snapshot.documents {
            let bucket = CharacterVoteBucket.fromMap(doc.data())
            guard bucket.totalUsers > 0 || !bucket.counts.isEmpty else { continue }
            out[doc.documentID] = bucket
        }
        return out
    }

    /// Aggregato community serie/stagione a utenti unici —
    /// `titles/{titleId}/aggregates/characters`, spec §2.3. nil se nessuno ha
    /// ancora votato un personaggio per questo titolo.
    func fetchTitleCharacterAggregate(titleID: String) async throws -> TitleCharacterAggregate? {
        let snapshot = try await db.collection("titles").document(titleID)
            .collection("aggregates").document("characters")
            .getDocument()
        guard let data = snapshot.data() else { return nil }
        return TitleCharacterAggregate.fromMap(data)
    }

    /// Rollup personale privato — `users/{uid}/characterPicks/{titleId}`,
    /// spec §2.4. nil se l'utente non ha ancora votato nessun personaggio per
    /// questo titolo.
    func fetchMyCharacterPicks(titleID: String, uid: String) async throws -> MyCharacterPicks? {
        let snapshot = try await db.collection("users").document(uid)
            .collection("characterPicks").document(titleID)
            .getDocument()
        guard let data = snapshot.data() else { return nil }
        return MyCharacterPicks.fromMap(data)
    }

    func uploadRatingMedia(
        userID: String,
        titleID: String,
        images: [UIImage]
    ) async throws -> [URL] {
        let trimmedUserID = userID.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedTitleID = titleID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedUserID.isEmpty, !trimmedTitleID.isEmpty else { return [] }

        var uploadedURLs: [URL] = []
        let storage = Storage.storage()
        let now = Int(Date().timeIntervalSince1970)

        for (index, image) in images.prefix(2).enumerated() {
            let preparedImage = image.prepareForRatingUpload()
            guard let imageData = preparedImage.jpegData(compressionQuality: 0.82) else {
                continue
            }

            let fileName = "\(now)_\(index)_\(UUID().uuidString).jpg"
            let path = "reviewPhotos/\(trimmedUserID)/\(trimmedTitleID)/\(fileName)"
            let reference = storage.reference(withPath: path)
            let metadata = StorageMetadata()
            metadata.contentType = "image/jpeg"

            _ = try await putImageData(imageData, metadata: metadata, in: reference)
            let downloadURL = try await downloadURL(for: reference)
            uploadedURLs.append(downloadURL)
        }

        return uploadedURLs
    }

    func refreshTitleFromTMDB(titleID: String) async throws {
        _ = try await runTMDBRefresh(titleID: titleID, force: true)
    }

    func refreshTitleFromTMDBIfNeeded(titleID: String) async throws -> TitleRefreshResult {
        try await runTMDBRefresh(titleID: titleID, force: false)
    }

    private func runTMDBRefresh(titleID: String, force: Bool) async throws -> TitleRefreshResult {
        var payload: [String: any Sendable] = ["titleId": titleID]
        if force {
            payload["force"] = true
        }

        let response = try await invokeCallable(name: "refreshTitleFromTmdb", payload: payload)
        let data = response.data as? [String: Any] ?? [:]
        // La callable può aver riscritto il doc titolo lato server.
        invalidateCachedTitle(id: titleID)

        return TitleRefreshResult(
            ok: FirestoreValueReader.bool(data["ok"]) ?? false,
            checked: FirestoreValueReader.bool(data["checked"]) ?? false,
            updated: FirestoreValueReader.bool(data["updated"]) ?? false,
            reason: FirestoreValueReader.string(data["reason"]),
            nextCheckAt: FirestoreValueReader.date(data["nextCheckAt"]) ?? FirestoreValueReader.dateFromMilliseconds(data["nextCheckAtMs"])
        )
    }

    private func snapshotToTitle(_ snapshot: DocumentSnapshot) -> Title? {
        guard let data = snapshot.data() else { return nil }
        return TitleParsing.title(from: data, documentID: snapshot.documentID)
    }


    private func snapshotToRating(_ snapshot: QueryDocumentSnapshot, usersByID: [String: AppUser]) -> Rating? {
        let data = snapshot.data()
        guard let uid = FirestoreValueReader.string(data, key: "uid"),
              let titleId = FirestoreValueReader.string(data, key: "titleId")
        else {
            return nil
        }

        let watchedWith = (data["watchedWith"] as? [Any] ?? []).compactMap { row -> FeedTaggedUser? in
            let entry = FirestoreValueReader.map(row)
            guard let watchedUID = FirestoreValueReader.string(entry, key: "uid") else { return nil }
            let displayName = FirestoreValueReader.string(entry, key: "displayName")
                ?? usersByID[watchedUID]?.displayName
                ?? "Amico"
            return FeedTaggedUser(id: watchedUID, displayName: displayName)
        }

        let watchedWithGroup = TitleParsing.ratingGroup(from: data)
        let mediaURLs = TitleParsing.ratingMediaURLs(from: data)

        return Rating(
            id: snapshot.documentID,
            uid: uid,
            titleId: titleId,
            level: FirestoreValueReader.string(data, key: "level") ?? "title",
            season: FirestoreValueReader.int(data, key: "season"),
            episode: FirestoreValueReader.int(data, key: "episode"),
            rating: FirestoreValueReader.double(data, key: "rating") ?? 0,
            reviewText: FirestoreValueReader.string(data, key: "reviewText"),
            updatedAt: FirestoreValueReader.date(data["updatedAt"]),
            author: TitleParsing.userSummary(uid: uid, fallbackName: nil, user: usersByID[uid]),
            watchedWith: watchedWith,
            watchedWithGroup: watchedWithGroup,
            mediaURLs: mediaURLs
        )
    }

    private func fetchUsersMap(userIDs: [String]) async throws -> [String: AppUser] {
        guard !userIDs.isEmpty else { return [:] }

        var output: [String: AppUser] = [:]
        let chunks = stride(from: 0, to: userIDs.count, by: 10).map {
            Array(userIDs[$0 ..< min($0 + 10, userIDs.count)])
        }

        for group in chunks {
            let snapshot = try await db.collection("users")
                .whereField(FieldPath.documentID(), in: group)
                .getDocuments()

            for document in snapshot.documents {
                if let user = TitleParsing.snapshotToUser(document) {
                    output[user.id] = user
                }
            }
        }

        return output
    }

    private func callTMDBProxy(action: String, payload: [String: String]) async throws -> [String: Any] {
        let response = try await invokeCallable(
            name: "tmdbProxy",
            payload: payload.merging(["action": action]) { _, new in new }
        )
        if let data = response.data as? [String: Any] {
            if let payload = data["payload"] as? [String: Any] {
                return payload
            }
            if let nested = data["data"] as? [String: Any] {
                return nested
            }
            return data
        }
        return [:]
    }

    private func invokeCallable(name: String, payload: [String: String]) async throws -> CloudFunctionsCaller.CallableResult {
        try await CloudFunctionsCaller.call(name: name, data: payload)
    }

    private func invokeCallable(name: String, payload: [String: any Sendable]) async throws -> CloudFunctionsCaller.CallableResult {
        try await CloudFunctionsCaller.call(name: name, data: payload)
    }

    func mergeCatalogSearchResults(localTitles: [Title], remoteResults: [TMDBSearchResult]) -> TitleSearchResults {
        let filteredRemote = remoteResults.filter { result in
            !localTitles.contains { matchesTMDBSearchResult(result, title: $0) }
        }

        return TitleSearchResults(
            titles: localTitles,
            tmdbResults: filteredRemote
        )
    }

    private func storeCachedTitle(_ title: Title) {
        cachedTitlesByID[title.id] = CachedTitleEntry(
            value: title,
            expiresAt: Date().addingTimeInterval(60)
        )
        trimCachedTitles()
    }

    /// Da chiamare dopo ogni scrittura (client o via callable) sul doc titolo,
    /// così la lettura successiva non serve dati pre-modifica dal cache.
    private func invalidateCachedTitle(id: String) {
        cachedTitlesByID.removeValue(forKey: id)
    }

    private func trimCachedTitles(maxEntries: Int = 600) {
        let now = Date()
        cachedTitlesByID = cachedTitlesByID.filter { $0.value.expiresAt > now }
        guard cachedTitlesByID.count > maxEntries else { return }

        let keysToRemove = cachedTitlesByID
            .sorted { $0.value.expiresAt < $1.value.expiresAt }
            .prefix(cachedTitlesByID.count - maxEntries)
            .map(\.key)

        for key in keysToRemove {
            cachedTitlesByID.removeValue(forKey: key)
        }
    }

    private func trimCachedTitleSearches(maxEntries: Int = 24) {
        let now = Date()
        cachedTitleSearches = cachedTitleSearches.filter { $0.value.expiresAt > now }
        guard cachedTitleSearches.count > maxEntries else { return }

        let keysToRemove = cachedTitleSearches
            .sorted { $0.value.expiresAt < $1.value.expiresAt }
            .prefix(cachedTitleSearches.count - maxEntries)
            .map(\.key)

        for key in keysToRemove {
            cachedTitleSearches.removeValue(forKey: key)
        }
    }

    private func trimCachedTMDBSearches(maxEntries: Int = 32) {
        let now = Date()
        cachedTMDBSearches = cachedTMDBSearches.filter { $0.value.expiresAt > now }
        guard cachedTMDBSearches.count > maxEntries else { return }

        let keysToRemove = cachedTMDBSearches
            .sorted { $0.value.expiresAt < $1.value.expiresAt }
            .prefix(cachedTMDBSearches.count - maxEntries)
            .map(\.key)

        for key in keysToRemove {
            cachedTMDBSearches.removeValue(forKey: key)
        }
    }

    private func matchesTMDBSearchResult(_ result: TMDBSearchResult, title: Title) -> Bool {
        if let identity = titleTMDBIdentity(for: title),
           identity.tmdbId == result.tmdbId,
           identity.mediaType == result.mediaType {
            return true
        }

        let remoteDedupeKey = TitleParsing.makeDedupeKey(name: result.title, type: result.mediaType, year: result.year)
        if titleDedupeKey(for: title) == remoteDedupeKey {
            return true
        }

        guard title.type == result.mediaType else { return false }

        let normalizedRemoteTitle = SearchNormalizer.normalize(result.title)
        let normalizedRemoteOriginalTitle = SearchNormalizer.normalize(result.originalTitle)
        let normalizedOriginalName = SearchNormalizer.normalize(title.originalName ?? "")
        let aliasMatches = title.aliases
            .map(SearchNormalizer.normalize)
            .contains { alias in
                alias == normalizedRemoteTitle || (!normalizedRemoteOriginalTitle.isEmpty && alias == normalizedRemoteOriginalTitle)
            }

        let hasExactNameMatch =
            title.nameLower == normalizedRemoteTitle
            || (!normalizedRemoteOriginalTitle.isEmpty && title.nameLower == normalizedRemoteOriginalTitle)
            || (!normalizedOriginalName.isEmpty && (
                normalizedOriginalName == normalizedRemoteTitle
                    || (!normalizedRemoteOriginalTitle.isEmpty && normalizedOriginalName == normalizedRemoteOriginalTitle)
            ))
            || aliasMatches

        guard hasExactNameMatch else { return false }

        guard let resultYear = result.year, let titleYear = title.year else { return true }
        return abs(titleYear - resultYear) <= 1
    }

    private func titleTMDBIdentity(for title: Title) -> (tmdbId: Int, mediaType: MediaType)? {
        if let tmdbId = title.metadata.tmdbId, tmdbId > 0 {
            return (tmdbId, title.metadata.mediaType)
        }
        return TitleParsing.parsedTMDBIdentity(from: title.id)
    }

    private func titleDedupeKey(for title: Title) -> String {
        title.searchDedupeKey ?? TitleParsing.makeDedupeKey(name: title.name, type: title.type, year: title.year)
    }

    private func pickBestTitleMatch(
        _ titles: [Title],
        preferredType: MediaType? = nil,
        preferredTMDBID: Int? = nil
    ) -> Title? {
        guard !titles.isEmpty else { return nil }

        return titles.sorted { lhs, rhs in
            let leftIdentity = titleTMDBIdentity(for: lhs)
            let rightIdentity = titleTMDBIdentity(for: rhs)

            let leftTMDBScore = leftIdentity?.tmdbId == preferredTMDBID ? 2 : (leftIdentity == nil ? 0 : 1)
            let rightTMDBScore = rightIdentity?.tmdbId == preferredTMDBID ? 2 : (rightIdentity == nil ? 0 : 1)
            if leftTMDBScore != rightTMDBScore { return leftTMDBScore > rightTMDBScore }

            let leftTypeScore = preferredType != nil && lhs.type == preferredType ? 1 : 0
            let rightTypeScore = preferredType != nil && rhs.type == preferredType ? 1 : 0
            if leftTypeScore != rightTypeScore { return leftTypeScore > rightTypeScore }

            let leftCanonical = lhs.id.hasPrefix("tmdb_") ? 1 : 0
            let rightCanonical = rhs.id.hasPrefix("tmdb_") ? 1 : 0
            if leftCanonical != rightCanonical { return leftCanonical > rightCanonical }

            if lhs.ratingCount != rhs.ratingCount { return lhs.ratingCount > rhs.ratingCount }
            return (lhs.updatedAt ?? .distantPast) > (rhs.updatedAt ?? .distantPast)
        }.first
    }

    private func smartListSearchScore(for title: Title, normalized: String, tokens: [String]) -> Int {
        let haystacks = [
            title.name,
            title.originalName ?? "",
            title.collectionName ?? "",
            title.description ?? "",
            title.searchableText,
            title.aliases.joined(separator: " "),
            title.keywords.joined(separator: " ")
        ]
            .map(SearchNormalizer.normalize)

        var score = TitleParsing.searchScore(for: title, normalized: normalized) * 10

        for token in tokens {
            guard token.count >= 2 else { continue }
            if haystacks.contains(where: { $0.contains(token) }) {
                score += 4
            }
            if SearchNormalizer.normalize(title.collectionName ?? "").contains(token) {
                score += 6
            }
            if title.keywords.contains(where: { SearchNormalizer.normalize($0).contains(token) }) {
                score += 5
            }
        }

        if title.type == .movie, normalized.contains("film") {
            score += 1
        }
        if title.type == .tv, (normalized.contains("serie") || normalized.contains("show")) {
            score += 1
        }

        return score
    }

    /// Stessa sanitizzazione di `TitleParsing.makeRatingID`, level fisso "title" (v1: solo
    /// livello titolo per le emozioni post-visione).
    private func makeEmotionID(userID: String, titleID: String) -> String {
        TitleParsing.makeRatingID(userID: userID, titleID: titleID, level: "title", season: nil, episode: nil)
    }

    private func fetchTMDBDetails(_ result: TMDBSearchResult) async throws -> TMDBMappedTitle {
        let payload = try await callTMDBProxy(action: "details", payload: [
            "tmdbId": String(result.tmdbId),
            "mediaType": result.mediaType.rawValue,
            "language": "it-IT"
        ])

        let credits = FirestoreValueReader.map(payload["credits"])
        let crew = credits["crew"] as? [[String: Any]] ?? []
        let cast = credits["cast"] as? [[String: Any]] ?? []
        let genres = (payload["genres"] as? [[String: Any]] ?? []).compactMap { genre -> String? in
            guard let id = FirestoreValueReader.int(genre["id"]) else { return nil }
            return "tmdb_\(id)"
        }

        let isTV = result.mediaType == .tv
        let name = isTV ? (FirestoreValueReader.string(payload["name"]) ?? result.title) : (FirestoreValueReader.string(payload["title"]) ?? result.title)
        let originalName = isTV ? FirestoreValueReader.string(payload["original_name"]) : FirestoreValueReader.string(payload["original_title"])
        let dateString = isTV ? FirestoreValueReader.string(payload["first_air_date"]) : FirestoreValueReader.string(payload["release_date"])
        let year = dateString.flatMap { Int($0.prefix(4)) }

        let directorRows = crew.filter { FirestoreValueReader.string($0["job"]) == "Director" }
        let directors = directorRows.compactMap { FirestoreValueReader.string($0["name"]) }
        let directorIDs: [String] = directorRows.compactMap { row in
            FirestoreValueReader.int(row["id"]).map(String.init)
        }
        let castNames = cast.prefix(10).compactMap { FirestoreValueReader.string($0["name"]) }
        let castIDs: [String] = cast.prefix(20).compactMap { row in
            FirestoreValueReader.int(row["id"]).map(String.init)
        }
        let castWithCharacters: [[String: Any]] = cast.prefix(20).enumerated().compactMap { offset, row in
            guard
                let personID = FirestoreValueReader.int(row["id"]).map(String.init),
                let name = FirestoreValueReader.string(row["name"]), !name.isEmpty
            else { return nil }
            let character = FirestoreValueReader.string(row["character"]) ?? ""
            let profilePath = FirestoreValueReader.string(row["profile_path"]).map {
                "https://image.tmdb.org/t/p/w500\($0)"
            } ?? ""
            let order = FirestoreValueReader.int(row["order"]) ?? offset
            return [
                "personId": personID,
                "name": name,
                "character": character,
                "profilePath": profilePath,
                "order": order
            ]
        }

        let spokenLanguages = payload["spoken_languages"] as? [[String: Any]] ?? []
        let countries = payload["production_countries"] as? [[String: Any]] ?? []
        let networks = payload["networks"] as? [[String: Any]] ?? []
        let episodeRunTime = (payload["episode_run_time"] as? [Any] ?? []).compactMap(FirestoreValueReader.int).first
        let keywordsPayload = FirestoreValueReader.map(payload["keywords"])
        let keywordsRows = (keywordsPayload["keywords"] as? [[String: Any]] ?? [])
            + (keywordsPayload["results"] as? [[String: Any]] ?? [])
        let alternativeTitlesPayload = FirestoreValueReader.map(payload["alternative_titles"])
        let alternativeTitlesRows = (alternativeTitlesPayload["titles"] as? [[String: Any]] ?? [])
            + (alternativeTitlesPayload["results"] as? [[String: Any]] ?? [])
        let collection = FirestoreValueReader.map(payload["belongs_to_collection"])

        return TMDBMappedTitle(
            tmdbID: result.tmdbId,
            type: result.mediaType,
            name: name,
            year: year,
            originalName: originalName,
            genres: genres,
            directors: directors,
            directorIDs: directorIDs,
            cast: castNames,
            castIDs: castIDs,
            castWithCharacters: castWithCharacters,
            aliases: TitleParsing.uniqueStrings(
                alternativeTitlesRows.compactMap { row in
                    FirestoreValueReader.string(row["title"])
                        ?? FirestoreValueReader.string(row["name"])
                }
            ),
            keywords: TitleParsing.uniqueStrings(keywordsRows.compactMap { FirestoreValueReader.string($0["name"]) }),
            collectionID: FirestoreValueReader.int(collection["id"]),
            collectionName: FirestoreValueReader.string(collection["name"]),
            collectionPosterURL: FirestoreValueReader.string(collection["poster_path"]).flatMap {
                URL(string: "https://image.tmdb.org/t/p/w500\($0)")
            },
            collectionBackdropURL: FirestoreValueReader.string(collection["backdrop_path"]).flatMap {
                URL(string: "https://image.tmdb.org/t/p/w780\($0)")
            },
            description: FirestoreValueReader.string(payload["overview"]),
            posterURL: FirestoreValueReader.string(payload["poster_path"]).flatMap { URL(string: "https://image.tmdb.org/t/p/w500\($0)") },
            backdropURL: FirestoreValueReader.string(payload["backdrop_path"]).flatMap { URL(string: "https://image.tmdb.org/t/p/w780\($0)") },
            language: FirestoreValueReader.string(spokenLanguages.first?["italian_name"])
                ?? FirestoreValueReader.string(spokenLanguages.first?["english_name"])
                ?? FirestoreValueReader.string(spokenLanguages.first?["name"]),
            country: FirestoreValueReader.string(countries.first?["name"]),
            network: FirestoreValueReader.string(networks.first?["name"]),
            durationMovie: FirestoreValueReader.int(payload["runtime"]),
            durationEpisode: episodeRunTime,
            seasonsCount: FirestoreValueReader.int(payload["number_of_seasons"]),
            episodesPerSeason: nil
        )
    }

    private func fetchManualTrailerURL(for titleID: String) async throws -> URL? {
        let snapshot = try await db.collection("titles").document(titleID).getDocument()
        guard let data = snapshot.data(),
              let rawValue = FirestoreValueReader.string(data, key: "trailerUrl") else {
            return nil
        }

        return (try? TitleParsing.normalizedEditorialTrailerURL(from: rawValue))
            ?? URL(string: rawValue)
    }


    private func bestTrailerURL(from payload: [String: Any]) -> URL? {
        let videos = payload["results"] as? [[String: Any]] ?? []
        let youtube = videos.filter { row in
            (FirestoreValueReader.string(row["site"]) ?? "").lowercased() == "youtube"
        }

        let best = youtube.sorted { lhs, rhs in
            TitleParsing.videoScore(lhs) > TitleParsing.videoScore(rhs)
        }.first

        guard let key = FirestoreValueReader.string(best?["key"]) else { return nil }
        return URL(string: "https://www.youtube.com/watch?v=\(key)")
    }


    private func resolveTrailerTarget(for title: Title) async throws -> (tmdbId: Int, mediaType: MediaType)? {
        if let tmdbId = title.metadata.tmdbId {
            return (tmdbId, title.metadata.mediaType)
        }

        if let canonicalIdentity = TitleParsing.parsedTMDBIdentity(from: title.id) {
            return canonicalIdentity
        }

        let results = try await searchTMDB(title.name)
        let normalizedName = SearchNormalizer.normalize(title.name)
        let normalizedOriginalName = SearchNormalizer.normalize(title.originalName ?? "")

        let bestMatch = results
            .map { result -> (TMDBSearchResult, Int) in
                let normalizedResultTitle = SearchNormalizer.normalize(result.title)
                let normalizedResultOriginalTitle = SearchNormalizer.normalize(result.originalTitle)
                var score = 0

                if result.mediaType == title.type {
                    score += 2
                }
                if normalizedResultTitle == normalizedName
                    || (!normalizedOriginalName.isEmpty && normalizedResultOriginalTitle == normalizedOriginalName) {
                    score += 4
                } else if normalizedResultTitle.hasPrefix(normalizedName) || normalizedName.hasPrefix(normalizedResultTitle) {
                    score += 2
                } else if normalizedResultTitle.contains(normalizedName) {
                    score += 1
                }

                if let titleYear = title.year, let resultYear = result.year {
                    if titleYear == resultYear {
                        score += 2
                    } else if abs(titleYear - resultYear) == 1 {
                        score += 1
                    }
                }

                return (result, score)
            }
            .sorted { lhs, rhs in
                if lhs.1 != rhs.1 {
                    return lhs.1 > rhs.1
                }
                let leftDistance = abs((lhs.0.year ?? title.year ?? 0) - (title.year ?? 0))
                let rightDistance = abs((rhs.0.year ?? title.year ?? 0) - (title.year ?? 0))
                return leftDistance < rightDistance
            }
            .first

        guard let bestMatch, bestMatch.1 > 0 else { return nil }
        return (bestMatch.0.tmdbId, bestMatch.0.mediaType)
    }

    private func fetchTMDBCreditFallbacks(for title: Title) async throws -> TMDBCreditFallbacks {
        guard !title.directors.isEmpty || !title.cast.isEmpty else { return .empty }
        guard let target = try await resolveTrailerTarget(for: title) else { return .empty }

        let payload = try await callTMDBProxy(action: "details", payload: [
            "tmdbId": String(target.tmdbId),
            "mediaType": target.mediaType.rawValue,
            "language": "it-IT"
        ])

        let credits = FirestoreValueReader.map(payload["credits"])
        let crew = credits["crew"] as? [[String: Any]] ?? []
        let cast = credits["cast"] as? [[String: Any]] ?? []

        let directors = crew.reduce(into: [String: TMDBCreditAvatar]()) { partialResult, item in
            guard FirestoreValueReader.string(item["job"]) == "Director" else { return }
            guard let name = FirestoreValueReader.string(item["name"]) else { return }
            let normalizedName = SearchNormalizer.normalize(name)
            guard !normalizedName.isEmpty, partialResult[normalizedName] == nil else { return }
            partialResult[normalizedName] = TMDBCreditAvatar(
                name: name,
                avatarURL: TitleParsing.tmdbProfileURL(from: FirestoreValueReader.string(item["profile_path"]))
            )
        }

        let castFallbacks = cast.reduce(into: [String: TMDBCreditAvatar]()) { partialResult, item in
            guard let name = FirestoreValueReader.string(item["name"]) else { return }
            let normalizedName = SearchNormalizer.normalize(name)
            guard !normalizedName.isEmpty, partialResult[normalizedName] == nil else { return }
            partialResult[normalizedName] = TMDBCreditAvatar(
                name: name,
                avatarURL: TitleParsing.tmdbProfileURL(from: FirestoreValueReader.string(item["profile_path"]))
            )
        }

        return TMDBCreditFallbacks(directors: directors, cast: castFallbacks)
    }

    private func mergedCreditNames(
        primary names: [String],
        fallbackAvatars: [String: TMDBCreditAvatar]
    ) -> [String] {
        var merged: [String] = []
        var seen: Set<String> = []

        for name in names {
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
            let normalized = SearchNormalizer.normalize(trimmed)
            guard !trimmed.isEmpty, !normalized.isEmpty, seen.insert(normalized).inserted else { continue }
            merged.append(trimmed)
        }

        for avatar in fallbackAvatars.values {
            let trimmed = avatar.name.trimmingCharacters(in: .whitespacesAndNewlines)
            let normalized = SearchNormalizer.normalize(trimmed)
            guard !trimmed.isEmpty, !normalized.isEmpty, seen.insert(normalized).inserted else { continue }
            merged.append(trimmed)
        }

        return merged
    }

    private func makeTitleCreditPeople(
        names: [String],
        ids: [String],
        matchedPeople: [Person],
        primaryRole: String,
        fallbackAvatarsByName: [String: TMDBCreditAvatar]
    ) -> [TitleCreditPerson] {
        let peopleByID = matchedPeople.reduce(into: [String: Person]()) { partialResult, person in
            partialResult[person.id] = person
        }
        let peopleByName = matchedPeople.reduce(into: [String: Person]()) { partialResult, person in
            partialResult[person.nameLower] = person
        }

        var entries: [TitleCreditPerson] = []
        var seenEntryIDs: Set<String> = []
        let totalCount = max(names.count, ids.count)

        for index in 0 ..< totalCount {
            let rawID: String? = index < ids.count
                ? ids[index].trimmingCharacters(in: .whitespacesAndNewlines)
                : nil
            let rawName: String? = index < names.count
                ? names[index].trimmingCharacters(in: .whitespacesAndNewlines)
                : nil
            let matchedPerson: Person? = rawID.flatMap { id in
                guard !id.isEmpty else { return nil }
                return peopleByID[id]
            } ?? rawName.flatMap { name in
                let normalizedName = SearchNormalizer.normalize(name)
                guard !normalizedName.isEmpty else { return nil }
                return peopleByName[normalizedName]
            }

            let normalizedFallbackName = SearchNormalizer.normalize(rawName ?? matchedPerson?.name ?? "")
            let tmdbFallback = normalizedFallbackName.isEmpty ? nil : fallbackAvatarsByName[normalizedFallbackName]
            let displayName = matchedPerson?.name ?? tmdbFallback?.name ?? rawName ?? ""
            guard !displayName.isEmpty else { continue }

            let nameLower = matchedPerson?.nameLower ?? SearchNormalizer.normalize(displayName)
            let entry = TitleCreditPerson(
                personID: (rawID?.isEmpty == false ? rawID : nil) ?? matchedPerson?.id,
                name: displayName,
                nameLower: nameLower,
                avatarURL: matchedPerson?.avatarURL ?? tmdbFallback?.avatarURL,
                roles: matchedPerson?.roles ?? [primaryRole],
                occurrences: matchedPerson?.occurrences ?? 0,
                primaryRole: primaryRole
            )

            guard seenEntryIDs.insert(entry.id).inserted else { continue }
            entries.append(entry)
        }

        for personID in ids.map({ $0.trimmingCharacters(in: .whitespacesAndNewlines) }).filter({ !$0.isEmpty }) {
            guard let person = peopleByID[personID] else { continue }
            let entry = TitleCreditPerson(
                personID: person.id,
                name: person.name,
                nameLower: person.nameLower,
                avatarURL: person.avatarURL ?? fallbackAvatarsByName[person.nameLower]?.avatarURL,
                roles: person.roles,
                occurrences: person.occurrences,
                primaryRole: primaryRole
            )

            guard seenEntryIDs.insert(entry.id).inserted else { continue }
            entries.append(entry)
        }

        if entries.isEmpty {
            for person in matchedPeople {
                let entry = TitleCreditPerson(
                    personID: person.id,
                    name: person.name,
                    nameLower: person.nameLower,
                    avatarURL: person.avatarURL ?? fallbackAvatarsByName[person.nameLower]?.avatarURL,
                    roles: person.roles,
                    occurrences: person.occurrences,
                    primaryRole: primaryRole
                )

                guard seenEntryIDs.insert(entry.id).inserted else { continue }
                entries.append(entry)
            }
        }

        return entries
    }

    private func putImageData(_ data: Data, metadata: StorageMetadata, in reference: StorageReference) async throws -> StorageMetadata {
        try await withCheckedThrowingContinuation { continuation in
            reference.putData(data, metadata: metadata) { returnedMetadata, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: returnedMetadata ?? metadata)
                }
            }
        }
    }

    private func downloadURL(for reference: StorageReference) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            reference.downloadURL { url, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let url {
                    continuation.resume(returning: url)
                } else {
                    continuation.resume(throwing: NSError(
                        domain: "TwoWatch",
                        code: 500,
                        userInfo: [NSLocalizedDescriptionKey: String(localized: "URL immagine non disponibile.")]
                    ))
                }
            }
        }
    }
}

private extension UIImage {
    func prepareForRatingUpload(maxDimension: CGFloat = 1_800) -> UIImage {
        let currentMaxDimension = max(size.width, size.height)
        guard currentMaxDimension > maxDimension else { return self }

        let scale = maxDimension / currentMaxDimension
        let targetSize = CGSize(width: size.width * scale, height: size.height * scale)
        let renderer = UIGraphicsImageRenderer(size: targetSize)
        return renderer.image { _ in
            draw(in: CGRect(origin: .zero, size: targetSize))
        }
    }
}

struct TMDBPersonCredit {
    enum Role: Hashable {
        case cast
        case director
        case crewOther
    }

    let result: TMDBSearchResult
    let role: Role
}

private struct TMDBMappedTitle {
    let tmdbID: Int
    let type: MediaType
    let name: String
    let year: Int?
    let originalName: String?
    let genres: [String]
    let directors: [String]
    let directorIDs: [String]
    let cast: [String]
    let castIDs: [String]
    let castWithCharacters: [[String: Any]]
    let aliases: [String]
    let keywords: [String]
    let collectionID: Int?
    let collectionName: String?
    let collectionPosterURL: URL?
    let collectionBackdropURL: URL?
    let description: String?
    let posterURL: URL?
    let backdropURL: URL?
    let language: String?
    let country: String?
    let network: String?
    let durationMovie: Int?
    let durationEpisode: Int?
    let seasonsCount: Int?
    let episodesPerSeason: Int?
}
