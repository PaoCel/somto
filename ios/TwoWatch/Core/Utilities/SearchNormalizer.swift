import Foundation

enum SearchNormalizer {
    static func normalize(_ value: String) -> String {
        let folded = value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
            .lowercased()

        let filtered = folded.map { character -> Character in
            if character.isLetter || character.isNumber || character.isWhitespace {
                return character
            }
            return " "
        }

        return String(filtered)
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
    }

    static func tokens(from value: String) -> [String] {
        Array(
            Set(
                normalize(value)
                    .split(separator: " ")
                    .map(String.init)
                    .filter { $0.count >= 2 }
            )
        )
    }

    static func prefixes(from value: String, maxLength: Int) -> [String] {
        let normalized = normalize(value)
        guard !normalized.isEmpty else { return [] }
        return (1 ... Swift.min(maxLength, normalized.count)).map {
            String(normalized.prefix($0))
        }
    }
}

enum GenreDisplay {
    static let fallbackGenres: [Genre] = fallbackByID
        .map { key, value in
            Genre(id: key, name: value, nameLower: value.lowercased())
        }
        .sorted { lhs, rhs in
            lhs.nameLower.localizedCaseInsensitiveCompare(rhs.nameLower) == .orderedAscending
        }

    static func lookup(from genres: [Genre]) -> [String: String] {
        var output: [String: String] = [:]

        for genre in genres {
            let normalizedGenre = normalized(genre)

            for key in candidateKeys(for: genre.id) {
                output[key] = normalizedGenre.name
            }

            for key in candidateKeys(for: genre.name) {
                output[key] = normalizedGenre.name
            }
        }

        return output
    }

    static func normalized(_ genre: Genre) -> Genre {
        let resolvedName = label(for: genre.name) ?? label(for: genre.id) ?? genre.name
        let normalizedNameLower = SearchNormalizer.normalize(resolvedName)

        return Genre(
            id: genre.id,
            name: resolvedName,
            nameLower: normalizedNameLower.isEmpty ? resolvedName.lowercased() : normalizedNameLower
        )
    }

    static func labels(from rawValues: [String], lookup: [String: String] = [:]) -> [String] {
        var output: [String] = []
        var seen: Set<String> = []

        for rawValue in rawValues {
            guard let label = label(for: rawValue, lookup: lookup), seen.insert(label).inserted else {
                continue
            }
            output.append(label)
        }

        return output
    }

    static func label(for rawValue: String, lookup: [String: String] = [:]) -> String? {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        for key in candidateKeys(for: trimmed) {
            if let resolved = lookup[key], !resolved.isEmpty {
                return resolved
            }
            if let fallback = fallbackByID[key], !fallback.isEmpty {
                return fallback
            }
        }

        return prettifiedLabel(from: trimmed)
    }

    private static func candidateKeys(for rawValue: String) -> [String] {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }

        var keys: [String] = []

        func append(_ value: String) {
            guard !value.isEmpty, !keys.contains(value) else { return }
            keys.append(value)
        }

        append(trimmed)
        append(trimmed.lowercased())

        let lowercased = trimmed.lowercased()
        for prefix in ["tmdb_", "genre_"] {
            if lowercased.hasPrefix(prefix) {
                let stripped = String(trimmed.dropFirst(prefix.count))
                append(stripped)
                append(stripped.lowercased())
            }
        }

        if trimmed.allSatisfy(\.isNumber) {
            append("tmdb_\(trimmed)")
        }

        return keys
    }

    private static func prettifiedLabel(from rawValue: String) -> String? {
        let cleaned = rawValue
            .replacingOccurrences(of: "tmdb_", with: "", options: .caseInsensitive)
            .replacingOccurrences(of: "genre_", with: "", options: .caseInsensitive)
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        guard cleaned.rangeOfCharacter(from: .letters) != nil else { return nil }

        return cleaned
            .split(whereSeparator: \.isWhitespace)
            .map { token in
                let value = String(token)
                guard let first = value.first else { return value }
                return first.uppercased() + value.dropFirst().lowercased()
            }
            .joined(separator: " ")
    }

    private static let fallbackByID: [String: String] = [
        "tmdb_28": "Azione",
        "tmdb_12": "Avventura",
        "tmdb_16": "Animazione",
        "tmdb_35": "Commedia",
        "tmdb_80": "Crime",
        "tmdb_99": "Documentario",
        "tmdb_18": "Dramma",
        "tmdb_10751": "Famiglia",
        "tmdb_10759": "Azione & Avventura",
        "tmdb_14": "Fantasy",
        "tmdb_10765": "Fantascienza & Fantasy",
        "tmdb_36": "Storia",
        "tmdb_27": "Horror",
        "tmdb_10402": "Musica",
        "tmdb_9648": "Mistero",
        "tmdb_10749": "Romantico",
        "tmdb_878": "Fantascienza",
        "tmdb_10770": "Film TV",
        "tmdb_53": "Thriller",
        "tmdb_10752": "Guerra",
        "tmdb_37": "Western",
        "tmdb_10768": "Guerra & Politica",
        "tmdb_10766": "Soap"
    ]
}
