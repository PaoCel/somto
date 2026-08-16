import FirebaseFirestore
import Foundation

/// Parsing e normalizzazione dei payload Firestore/TMDB della scheda titolo.
///
/// PERCHE' ESISTE — queste funzioni erano `private` dentro `TitleRepository`,
/// una classe che parla con Firestore: non erano richiamabili da un test.
/// Eppure sono il punto in cui un campo rinominato lato backend diventa un
/// `nil` silenzioso invece di un errore (docs/IOS_REFACTOR_PLAN.md §2.8).
/// Sono pure, sincrone e senza stato: spostarle qui le rende verificabili.
///
/// NON sono qui `pickBestTitleMatch`, `mergedCreditNames` e
/// `makeTitleCreditPeople`: dipendono da un tipo annidato e da una proprieta'
/// della classe, e trascinarle avrebbe portato via mezza `TitleRepository`.
///
/// Spostamento puro: nessun corpo cambiato, solo `private func` -> `static func`.
enum TitleParsing {
    static func localizedTitleUpdateText(_ value: Any?) -> String? {
        let locale = (Bundle.main.preferredLocalizations.first ?? "it").lowercased()
        return TitleUpdateSupport.localizedText(value, preferredLocalization: locale)
    }

    static func tmdbDate(_ value: String?) -> Date? {
        guard let value, !value.isEmpty else { return nil }
        if value.count == 10 {
            let formatter = DateFormatter()
            formatter.calendar = Calendar(identifier: .gregorian)
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.dateFormat = "yyyy-MM-dd"
            return formatter.date(from: value)
        }
        return ISO8601DateFormatter().date(from: value)
    }

    /// Vero solo se `titleID` è già nella forma che le Firestore rules di
    /// `characterVotes` pretendono (`^[A-Za-z0-9_-]+$`): la rule confronta
    /// l'id del doc con una concatenazione GREZZA (`uid+"__"+titleId+...`,
    /// nessuna sanitizzazione lato regola), quindi un titleId con caratteri
    /// fuori whitelist farebbe fallire il create/update con permission-denied
    /// a prescindere da come costruiamo l'id lato client.
    static func isSanitizedCharacterVoteTitleID(_ titleID: String) -> Bool {
        !titleID.isEmpty && titleID.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil
    }

    /// Normalizza i pick lato client prima della scrittura, a specchio di
    /// `normalizePicks` in `functions/lib/characterVoteAggregate.js`: max 3,
    /// personId non vuoti/distinti (<=32 char), character troncato a 120
    /// char (vuoto -> nil), reaction ammessa solo se è una delle 12
    /// `TitleEmotion` esistenti (altrimenti scartata silenziosamente — le
    /// rules rifiuterebbero l'intero doc per una reaction fuori whitelist).
    static func normalizedCharacterPicks(_ raw: [CharacterPick]) -> [CharacterPick] {
        var out: [CharacterPick] = []
        var seenPersonIDs = Set<String>()

        for pick in raw {
            if out.count >= 3 { break }
            let personId = pick.personId.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !personId.isEmpty, personId.count <= 32, !seenPersonIDs.contains(personId) else { continue }
            seenPersonIDs.insert(personId)

            let trimmedCharacter = pick.character?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let character = trimmedCharacter.isEmpty ? nil : String(trimmedCharacter.prefix(120))

            let reaction = pick.reaction.flatMap { TitleEmotion(rawValue: $0) != nil ? $0 : nil }

            out.append(CharacterPick(personId: personId, character: character, reaction: reaction))
        }

        return out
    }

    /// Parsing difensivo di `picks` letto da un doc `characterVotes`: righe
    /// senza `personId` valido sono scartate, `character`/`reaction` mancanti
    /// o di tipo sbagliato diventano nil.
    static func parseCharacterPicks(_ raw: Any?) -> [CharacterPick] {
        guard let items = raw as? [[String: Any]] else { return [] }
        return items.compactMap { item -> CharacterPick? in
            guard let personId = FirestoreValueReader.string(item, key: "personId"), !personId.isEmpty else {
                return nil
            }
            return CharacterPick(
                personId: personId,
                character: FirestoreValueReader.string(item, key: "character"),
                reaction: FirestoreValueReader.string(item, key: "reaction")
            )
        }
    }

    /// Un cast member normalizzato da `tmdbProxy` (action `episodecredits`):
    /// stessa forma di `castWithCharacters` (`personId,name,character,profilePath,order`).
    static func parseTMDBCharacterCandidate(_ row: [String: Any], isGuest: Bool) -> CharacterCandidate? {
        guard let personId = FirestoreValueReader.string(row, key: "personId"), !personId.isEmpty else { return nil }
        guard let name = FirestoreValueReader.string(row, key: "name"), !name.isEmpty else { return nil }
        return CharacterCandidate(
            personId: personId,
            name: name,
            character: FirestoreValueReader.string(row, key: "character").flatMap { $0.isEmpty ? nil : $0 },
            profileURL: URL(string: FirestoreValueReader.string(row, key: "profilePath") ?? ""),
            order: FirestoreValueReader.int(row, key: "order") ?? 999,
            isGuest: isGuest
        )
    }

    /// `titles/{id}.watchProviderLogos` = `[{name, logoUrl}]`, stessa copertura graduale
    /// di `watchProviderNames`. Parse difensivo: righe senza name/logoUrl validi sono
    /// scartate; `name` è testo libero dal backend (non un doc id) quindi eventuali
    /// duplicati vanno deduplicati con `uniquingKeysWith`, mai `uniqueKeysWithValues`.
    static func parseWatchProviderLogos(from data: [String: Any]) -> [String: URL] {
        guard let arr = data["watchProviderLogos"] as? [[String: Any]], !arr.isEmpty else { return [:] }
        let pairs: [(String, URL)] = arr.compactMap { row in
            guard let name = FirestoreValueReader.string(row, key: "name"), !name.isEmpty else { return nil }
            guard let logoUrl = URL(string: FirestoreValueReader.string(row, key: "logoUrl") ?? "") else { return nil }
            return (name, logoUrl)
        }
        return Dictionary(pairs, uniquingKeysWith: { first, _ in first })
    }

    static func parseCastWithCharacters(from data: [String: Any]) -> [TitleCastMember] {
        guard let arr = data["castWithCharacters"] as? [[String: Any]], !arr.isEmpty else { return [] }
        return arr.enumerated().compactMap { offset, row -> TitleCastMember? in
            guard let personId = FirestoreValueReader.string(row, key: "personId"), !personId.isEmpty else { return nil }
            guard let name = FirestoreValueReader.string(row, key: "name"), !name.isEmpty else { return nil }
            return TitleCastMember(
                personId: personId,
                name: name,
                character: (FirestoreValueReader.string(row, key: "character"))
                    .flatMap { $0.isEmpty ? nil : $0 },
                profileURL: URL(string: FirestoreValueReader.string(row, key: "profilePath") ?? ""),
                order: FirestoreValueReader.int(row, key: "order") ?? offset
            )
        }
    }

    static func snapshotToPerson(_ snapshot: DocumentSnapshot) -> Person? {
        guard let data = snapshot.data() else { return nil }
        let avatarData = FirestoreValueReader.map(data["avatar"])
        let searchData = FirestoreValueReader.map(data["search"])
        let name = FirestoreValueReader.string(data, key: "name") ?? ""
        return Person(
            id: snapshot.documentID,
            name: name,
            nameLower: FirestoreValueReader.string(data, key: "nameLower")
                ?? FirestoreValueReader.string(searchData, key: "normalized")
                ?? SearchNormalizer.normalize(name),
            avatarURL: URL(string:
                FirestoreValueReader.string(data, key: "avatarUrl")
                ?? FirestoreValueReader.string(data, key: "avatarURL")
                ?? FirestoreValueReader.string(avatarData, key: "url")
                ?? FirestoreValueReader.string(avatarData, key: "storageUrl")
                ?? FirestoreValueReader.string(avatarData, key: "externalUrl")
                ?? ""
            ),
            roles: FirestoreValueReader.stringArray(data["roles"]),
            occurrences: FirestoreValueReader.int(data, key: "occurrences") ?? 0
        )
    }

    static func snapshotToUser(_ snapshot: DocumentSnapshot) -> AppUser? {
        guard let data = snapshot.data() else { return nil }
        let stats = FirestoreValueReader.map(data["stats"])

        return AppUser(
            id: snapshot.documentID,
            displayName: FirestoreValueReader.string(data, key: "displayName") ?? "User",
            displayNameLower: FirestoreValueReader.string(data, key: "displayNameLower") ?? "",
            photoURL: URL(string: FirestoreValueReader.string(data, key: "photoURL") ?? ""),
            avatarURL: URL(string: FirestoreValueReader.string(data, key: "avatarURL") ?? ""),
            trusted: FirestoreValueReader.bool(data["trusted"]) ?? false,
            isAdmin: FirestoreValueReader.bool(data["isAdmin"]) ?? false,
            level: UserLevel(rawValue: FirestoreValueReader.string(data, key: "level") ?? "") ?? .base,
            stats: UserStats(
                ratingsCount: FirestoreValueReader.int(stats, key: "ratingsCount") ?? 0,
                reviewsCount: FirestoreValueReader.int(stats, key: "reviewsCount") ?? 0,
                watchedCount: FirestoreValueReader.int(stats, key: "watchedCount") ?? 0,
                totalWatchMinutes: FirestoreValueReader.int(stats, key: "totalWatchMinutes") ?? 0,
                rewatchCount: FirestoreValueReader.int(stats, key: "rewatchCount") ?? 0,
                derivedRatingsCount: FirestoreValueReader.int(stats, key: "derivedRatingsCount") ?? 0
            ),
            favoriteGenres: FirestoreValueReader.stringArray(data["favoriteGenres"]),
            communitySafetyAcceptedAt: FirestoreValueReader.date(data["communitySafetyAcceptedAt"]),
            communitySafetyVersion: FirestoreValueReader.int(data, key: "communitySafetyVersion") ?? 0,
            verified: FirestoreValueReader.bool(data["verified"]) ?? false
        )
    }

    static func userSummary(uid: String, fallbackName: String?, user: AppUser?) -> UserSummary {
        UserSummary(
            id: uid,
            displayName: user?.displayName ?? fallbackName ?? "User",
            photoURL: user?.photoURL ?? user?.avatarURL
        )
    }

    static func searchScore(for title: Title, normalized: String) -> Int {
        let aliasHits = title.aliases.contains { SearchNormalizer.normalize($0).contains(normalized) }
        let keywordHits = title.keywords.contains { SearchNormalizer.normalize($0).contains(normalized) }
        let collectionHit = SearchNormalizer.normalize(title.collectionName ?? "").contains(normalized)
        let searchableHit = SearchNormalizer.normalize(title.searchableText).contains(normalized)

        if title.nameLower == normalized { return 12 }
        if title.nameLower.hasPrefix(normalized) { return 10 }
        if aliasHits { return 8 }
        if collectionHit { return 7 }
        if keywordHits { return 6 }
        if title.nameLower.contains(normalized) { return 5 }
        if searchableHit { return 4 }
        return 0
    }

    static func buildSearchableText(
        name: String,
        originalName: String?,
        aliases: [String],
        collectionName: String?,
        keywords: [String],
        overview: String?
    ) -> String {
        [
            name,
            originalName ?? "",
            aliases.joined(separator: " "),
            collectionName ?? "",
            keywords.joined(separator: " "),
            overview ?? ""
        ]
            .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .joined(separator: " • ")
    }

    static func uniqueStrings(_ values: [String]) -> [String] {
        var output: [String] = []
        var seen: Set<String> = []

        for value in values {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            let normalized = SearchNormalizer.normalize(trimmed)
            guard !trimmed.isEmpty, !normalized.isEmpty, seen.insert(normalized).inserted else { continue }
            output.append(trimmed)
        }

        return output
    }

    static func videoScore(_ row: [String: Any]) -> Int {
        var score = 0
        if (FirestoreValueReader.string(row["type"]) ?? "").lowercased() == "trailer" {
            score += 2
        }
        if FirestoreValueReader.bool(row["official"]) == true {
            score += 2
        }
        if (FirestoreValueReader.string(row["name"]) ?? "").lowercased().contains("trailer") {
            score += 1
        }
        return score
    }

    static func makeDedupeKey(name: String, type: MediaType, year: Int?) -> String {
        "\(SearchNormalizer.normalize(name))_\(type.rawValue)_\(year.map(String.init) ?? "null")"
    }

    static func canonicalTitleID(tmdbId: Int, mediaType: MediaType) -> String {
        "tmdb_\(mediaType.rawValue)_\(tmdbId)"
    }

    static func parseDedupeKey(_ rawKey: String) -> (nameLower: String, type: MediaType?, year: Int?)? {
        var key = rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return nil }

        if let legacyRange = key.range(of: "_tmdb_", options: .backwards) {
            key = String(key[..<legacyRange.lowerBound])
        }

        let parts = key.split(separator: "_", omittingEmptySubsequences: false)
        guard parts.count >= 3 else { return nil }

        let yearPart = String(parts[parts.count - 1]).lowercased()
        let typePart = String(parts[parts.count - 2]).lowercased()
        let namePart = parts.dropLast(2).joined(separator: "_")
        let nameLower = SearchNormalizer.normalize(namePart)
        guard !nameLower.isEmpty else { return nil }

        let type: MediaType?
        switch typePart {
        case "movie":
            type = .movie
        case "tv":
            type = .tv
        default:
            type = nil
        }

        let year = yearPart == "null" ? nil : Int(yearPart)
        return (nameLower, type, year)
    }

    static func makeRatingID(userID: String, titleID: String, level: String, season: Int?, episode: Int?) -> String {
        [userID, titleID, level, String(season ?? 0), String(episode ?? 0)]
            .map { raw in
                raw.replacingOccurrences(of: #"[^a-zA-Z0-9_-]"#, with: "_", options: .regularExpression)
            }
            .joined(separator: "__")
    }

    static func sanitizedOptionalText(_ value: String, maxLength: Int) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return String(trimmed.prefix(maxLength))
    }

    static func fallbackSeasonMetadata(from metadata: TitleMetadata) -> [TitleSeason] {
        guard let seasonsCount = metadata.seasonsCount, seasonsCount > 0 else { return [] }
        return (1 ... seasonsCount).map { season in
            TitleSeason(
                seasonNumber: season,
                episodeCount: max(0, metadata.episodesPerSeason ?? 0),
                name: nil
            )
        }
    }

    static func parsedSeasons(from raw: Any?) -> [TitleSeason] {
        let rows = raw as? [[String: Any]] ?? []
        return rows.compactMap { row -> TitleSeason? in
            let seasonNumber = FirestoreValueReader.int(row, key: "season")
                ?? FirestoreValueReader.int(row, key: "season_number")
            guard let seasonNumber, seasonNumber > 0 else { return nil }
            let episodeCount = FirestoreValueReader.int(row, key: "episodes")
                ?? FirestoreValueReader.int(row, key: "episode_count")
                ?? 0
            return TitleSeason(
                seasonNumber: seasonNumber,
                episodeCount: episodeCount,
                name: FirestoreValueReader.string(row, key: "name"),
                airDate: FirestoreValueReader.string(row, key: "air_date")
                    ?? FirestoreValueReader.string(row, key: "airDate")
            )
        }
        .sorted { $0.seasonNumber < $1.seasonNumber }
    }

    static func providerRows(from bundle: [String: Any]) -> [(id: String, type: String, name: String, logoURL: URL?, priority: Int)] {
        let categories = ["flatrate", "rent", "buy", "free", "ads"]
        var rows: [(id: String, type: String, name: String, logoURL: URL?, priority: Int)] = []

        for category in categories {
            let items = bundle[category] as? [[String: Any]] ?? []
            rows.append(contentsOf: items.compactMap { item in
                guard let name = FirestoreValueReader.string(item["name"]) ?? FirestoreValueReader.string(item["provider_name"]) else { return nil }

                let explicitLogoURL = FirestoreValueReader.string(item["logoUrl"]) ?? FirestoreValueReader.string(item["logoURL"])
                let logoURL = explicitLogoURL.flatMap(URL.init(string:))
                    ?? FirestoreValueReader.string(item["logo_path"]).flatMap {
                    URL(string: "https://image.tmdb.org/t/p/w154\($0)")
                }
                let providerIdentifier = FirestoreValueReader.int(item["providerId"])
                    ?? FirestoreValueReader.int(item["provider_id"])
                let identifier = providerIdentifier.map { "\(category)-\($0)" } ?? "\(category)-\(name.lowercased())"
                let priority = FirestoreValueReader.int(item["priority"])
                    ?? FirestoreValueReader.int(item["display_priority"])
                    ?? 0
                return (identifier, category, name, logoURL, priority)
            })
        }

        return rows.sorted { lhs, rhs in
            if lhs.priority != rhs.priority {
                return lhs.priority < rhs.priority
            }
            return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
        }
    }

    static func validatedYouTubeVideoID(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let allowedCharacters = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
        guard trimmed.count == 11,
              trimmed.unicodeScalars.allSatisfy(allowedCharacters.contains) else {
            return nil
        }
        return trimmed
    }

    static func mergePeople(_ first: [Person], _ second: [Person]) -> [Person] {
        var seen: Set<String> = []
        var merged: [Person] = []

        for person in first + second {
            guard seen.insert(person.id).inserted else { continue }
            merged.append(person)
        }

        return merged
    }

    static func tmdbProfileURL(from profilePath: String?) -> URL? {
        guard let profilePath, !profilePath.isEmpty else { return nil }
        return URL(string: "https://image.tmdb.org/t/p/w185\(profilePath)")
    }

    static func parsedTMDBIdentity(from titleID: String) -> (tmdbId: Int, mediaType: MediaType)? {
        let parts = titleID.split(separator: "_")
        guard parts.count >= 3, parts[0] == "tmdb", let mediaType = MediaType(rawValue: String(parts[1])), let tmdbId = Int(parts[2]) else {
            return nil
        }
        return (tmdbId, mediaType)
    }

    static func normalizedWatchedWith(_ values: [FeedTaggedUser]) -> [[String: String]] {
        var rows: [[String: String]] = []
        var seen: Set<String> = []

        for value in values {
            let id = value.id.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !id.isEmpty, seen.insert(id).inserted else { continue }
            let displayName = value.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
            rows.append([
                "uid": id,
                "displayName": String((displayName.isEmpty ? "Amico" : displayName).prefix(80))
            ])
        }

        return Array(rows.prefix(12))
    }

    static func normalizedMediaURLs(_ values: [URL]) -> [String] {
        var output: [String] = []
        var seen: Set<String> = []

        for value in values {
            let absoluteString = value.absoluteString.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !absoluteString.isEmpty, seen.insert(absoluteString).inserted else { continue }
            output.append(absoluteString)
            if output.count >= 2 {
                break
            }
        }

        return output
    }

    static func ratingMediaURLs(from data: [String: Any]) -> [URL] {
        let rawURLs = FirestoreValueReader.stringArray(data["mediaUrls"])
        if !rawURLs.isEmpty {
            return rawURLs.compactMap(URL.init(string:))
        }

        return FirestoreValueReader.string(data, key: "reviewPhotoUrl")
            .flatMap(URL.init(string:))
            .map { [$0] } ?? []
    }

    static func ratingGroup(from data: [String: Any]) -> FeedTaggedGroup? {
        let group = FirestoreValueReader.map(data["watchedWithGroup"])
        guard let threadID = FirestoreValueReader.string(group, key: "threadId") else { return nil }
        let groupName = FirestoreValueReader.string(group, key: "groupName") ?? "Gruppo"
        return FeedTaggedGroup(id: threadID, groupName: groupName)
    }

    /// Costruisce un `Title` dai campi grezzi di un documento Firestore.
    ///
    /// PERCHE' PRENDE `[String: Any]` E NON UN `DocumentSnapshot` — separare
    /// "leggi i byte" da "decidi il valore" e' cio' che rende questa logica
    /// verificabile: prima viveva dentro `TitleRepository` come `private` e
    /// nessun test poteva costruirle un input.
    ///
    /// LE CATENE `??` SONO LO SCHEMA. Il catalogo e' stato scritto da iOS, dal
    /// web, dalle Cloud Functions e dagli importer, in anni diversi: `tmdbId`
    /// sta al root, dentro `meta`, o si ricava dal doc id. Ogni ramo qui sotto
    /// e' una forma di documento realmente esistita. I rami sono marcati con
    /// `FallbackProbe` per scoprire quali siano ancora vivi: quelli a zero si
    /// potranno cancellare, gli altri smettono di essere debito e diventano un
    /// requisito documentato.
    static func title(from data: [String: Any], documentID: String) -> Title {
                let metadataData = FirestoreValueReader.map(data["meta"])
        let tmdbSyncData = FirestoreValueReader.map(data["tmdbSync"])
        let canonicalTMDB = parsedTMDBIdentity(from: documentID)
        let mediaType = MediaType(rawValue: FirestoreValueReader.string(data, key: "type") ?? "")
            ?? FallbackProbe.used("Title.type.fromDocID", canonicalTMDB?.mediaType)
            ?? { FallbackProbe.hit("Title.type.defaultMovie"); return .movie }()

        let seasons = parsedSeasons(from: metadataData["seasons"])
        let metadata = TitleMetadata(
            tmdbId: FirestoreValueReader.int(data, key: "tmdbId")
                ?? FallbackProbe.used("Title.tmdbId.fromMeta", FirestoreValueReader.int(metadataData, key: "tmdbId"))
                ?? FallbackProbe.used("Title.tmdbId.fromDocID", canonicalTMDB?.tmdbId),
            mediaType: MediaType(rawValue: FirestoreValueReader.string(metadataData, key: "mediaType") ?? "")
                ?? FallbackProbe.used("Title.meta.mediaType.fromDocID", canonicalTMDB?.mediaType)
                ?? { FallbackProbe.hit("Title.meta.mediaType.fromRootType"); return mediaType }(),
            language: FirestoreValueReader.string(metadataData, key: "language"),
            originalLanguage: FirestoreValueReader.string(metadataData, key: "originalLanguage")
                ?? FallbackProbe.used("Title.originalLanguage.fromRoot", FirestoreValueReader.string(data, key: "originalLanguage")),
            country: FirestoreValueReader.string(metadataData, key: "country"),
            originCountry: FirestoreValueReader.stringArray(metadataData["originCountry"])
                + FirestoreValueReader.stringArray(data["originCountry"]),
            network: FirestoreValueReader.string(metadataData, key: "network"),
            durationMovie: FirestoreValueReader.int(metadataData, key: "durationMovie"),
            durationEpisode: FirestoreValueReader.int(metadataData, key: "durationEpisode"),
            seasonsCount: FirestoreValueReader.int(metadataData, key: "seasonsCount"),
            episodesPerSeason: FirestoreValueReader.int(metadataData, key: "episodesPerSeason"),
            seasons: seasons,
            collectionId: FirestoreValueReader.int(metadataData, key: "collectionId")
                ?? FallbackProbe.used("Title.collectionId.fromRoot", FirestoreValueReader.int(data, key: "collectionId")),
            collectionName: FirestoreValueReader.string(metadataData, key: "collectionName")
                ?? FallbackProbe.used("Title.collectionName.fromRoot", FirestoreValueReader.string(data, key: "collectionName")),
            collectionPosterPath: URL(string:
                FirestoreValueReader.string(metadataData, key: "collectionPosterPath")
                ?? FirestoreValueReader.string(data, key: "collectionPosterPath")
                ?? ""
            ),
            collectionBackdropPath: URL(string:
                FirestoreValueReader.string(metadataData, key: "collectionBackdropPath")
                ?? FirestoreValueReader.string(data, key: "collectionBackdropPath")
                ?? ""
            )
        )

        let searchData = FirestoreValueReader.map(data["search"])
        let aggregateData = FirestoreValueReader.map(data["ratingAggregate"])
        let titleLevelAggregateData = FirestoreValueReader.map(aggregateData["titleLevel"])
        let titleRatingAggregate = TitleRatingAggregateSummary(
            titleAverage: FirestoreValueReader.double(titleLevelAggregateData, key: "avg") ?? 0,
            titleCount: FirestoreValueReader.int(titleLevelAggregateData, key: "count") ?? 0
        )
        let collectionName = FirestoreValueReader.string(data, key: "collectionName") ?? metadata.collectionName
        let keywords = FirestoreValueReader.stringArray(data["keywords"])
        let searchableText = FirestoreValueReader.string(searchData, key: "searchableText")
            ?? FallbackProbe.used("Title.searchableText.fromRoot", FirestoreValueReader.string(data, key: "searchableText"))
            ?? [FirestoreValueReader.string(data, key: "name") ?? "",
                FirestoreValueReader.string(data, key: "originalName") ?? "",
                collectionName ?? "",
                FirestoreValueReader.string(data, key: "description") ?? "",
                keywords.joined(separator: " "),
                FirestoreValueReader.stringArray(data["aliases"]).joined(separator: " ")]
                .joined(separator: " ")
        if FirestoreValueReader.string(searchData, key: "searchableText") == nil,
           FirestoreValueReader.string(data, key: "searchableText") == nil {
            // Nessun searchableText salvato: viene ricomposto a runtime. Se
            // questo ramo e' vivo, la ricerca su quei documenti dipende da una
            // stringa che il server non ha mai visto.
            FallbackProbe.hit("Title.searchableText.recomputed")
        }

        return Title(
            id: documentID,
            name: FirestoreValueReader.string(data, key: "name") ?? "Senza titolo",
            nameLower: FirestoreValueReader.string(data, key: "nameLower") ?? "",
            type: mediaType,
            year: FirestoreValueReader.int(data, key: "year"),
            description: FirestoreValueReader.string(data, key: "description"),
            posterPath: URL(string: FirestoreValueReader.string(data, key: "posterPath") ?? ""),
            backdropPath: URL(string: FirestoreValueReader.string(data, key: "backdropPath") ?? ""),
            genres: FirestoreValueReader.stringArray(data["genres"]),
            originalName: FirestoreValueReader.string(data, key: "originalName"),
            aliases: FirestoreValueReader.stringArray(data["aliases"]),
            directors: FirestoreValueReader.stringArray(data["directors"]),
            directorIDs: FirestoreValueReader.stringArray(data["directorIds"]),
            cast: FirestoreValueReader.stringArray(data["cast"]),
            castIDs: FirestoreValueReader.stringArray(data["castIds"]),
            keywords: keywords,
            collectionName: collectionName,
            searchableText: searchableText,
            ratingAvg: FirestoreValueReader.double(data, key: "ratingAvg") ?? 0,
            ratingCount: FirestoreValueReader.int(data, key: "ratingCount") ?? 0,
            ratingAggregate: titleRatingAggregate.titleCount > 0 ? titleRatingAggregate : nil,
            emotionAggregate: TitleEmotionAggregate.fromMap(FirestoreValueReader.map(data["emotionAggregate"])),
            reviewCount: FirestoreValueReader.int(data, key: "reviewCount") ?? 0,
            createdBy: FirestoreValueReader.string(data, key: "createdBy"),
            status: FirestoreValueReader.string(data, key: "status") ?? "approved",
            metadata: metadata,
            searchDedupeKey: FirestoreValueReader.string(searchData, key: "dedupeKey"),
            updatedAt: FirestoreValueReader.date(data["updatedAt"]),
            tmdbNextRefreshAt: FirestoreValueReader.date(tmdbSyncData["nextCheckAt"])
                ?? FallbackProbe.used("Title.nextCheckAt.fromMillis", FirestoreValueReader.dateFromMilliseconds(tmdbSyncData["nextCheckAtMs"])),
            trailerURL: parseTrailerURL(from: data),
            castWithCharacters: parseCastWithCharacters(from: data),
            watchProviderNames: FirestoreValueReader.stringArray(data["watchProviderNames"]),
            watchProviderLogos: parseWatchProviderLogos(from: data)
        )
    }

    static func parseTrailerURL(from data: [String: Any]) -> URL? {
        guard let raw = FirestoreValueReader.string(data, key: "trailerUrl"), !raw.isEmpty else { return nil }
        return (try? normalizedEditorialTrailerURL(from: raw)) ?? URL(string: raw)
    }

    static func normalizedEditorialTrailerURL(from rawValue: String) throws -> URL? {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        if let videoID = TitleParsing.validatedYouTubeVideoID(trimmed) {
            return URL(string: "https://www.youtube.com/watch?v=\(videoID)")
        }

        let lowercased = trimmed.lowercased()
        let candidateURLString: String
        if trimmed.contains("://") {
            candidateURLString = trimmed
        } else if lowercased.hasPrefix("youtube.com")
            || lowercased.hasPrefix("www.youtube.com")
            || lowercased.hasPrefix("m.youtube.com")
            || lowercased.hasPrefix("youtu.be")
            || lowercased.hasPrefix("www.youtu.be") {
            candidateURLString = "https://\(trimmed)"
        } else {
            throw NSError(domain: "TwoWatch", code: 422, userInfo: [
                NSLocalizedDescriptionKey: String(localized: "Inserisci un link YouTube valido.")
            ])
        }

        guard let url = URL(string: candidateURLString),
              let videoID = youtubeVideoID(from: url) else {
            throw NSError(domain: "TwoWatch", code: 422, userInfo: [
                NSLocalizedDescriptionKey: String(localized: "Inserisci un link YouTube valido.")
            ])
        }

        return URL(string: "https://www.youtube.com/watch?v=\(videoID)")
    }

    static func youtubeVideoID(from url: URL) -> String? {
        let host = url.host?.lowercased() ?? ""
        let pathComponents = url.pathComponents.filter { $0 != "/" }

        if host.contains("youtu.be"),
           let first = pathComponents.first,
           let videoID = TitleParsing.validatedYouTubeVideoID(first) {
            return videoID
        }

        guard host.contains("youtube.com") else { return nil }

        if let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
           let candidate = components.queryItems?.first(where: { $0.name == "v" })?.value,
           let videoID = TitleParsing.validatedYouTubeVideoID(candidate) {
            return videoID
        }

        if pathComponents.count >= 2,
           ["embed", "shorts", "live"].contains(pathComponents[0]),
           let videoID = TitleParsing.validatedYouTubeVideoID(pathComponents[1]) {
            return videoID
        }

        return nil
    }
}
