import Foundation

// Formattazioni della scheda titolo, estratte da TitleDetailView.swift.
// Era `private`, cioe' visibile al solo file: gli sheet che ora vivono in
// TitleDetailSheets.swift la usano, quindi diventa internal.
// Spostamento puro, nessuna logica cambiata.

enum TitleDetailFormatter {
    static func displayGenres(for title: Title, resolvedGenres: [String]) -> [String] {
        resolvedGenres.isEmpty ? GenreDisplay.labels(from: title.genres) : resolvedGenres
    }

    static func hasOverview(_ title: Title) -> Bool {
        title.description?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    }

    static func subtitle(for title: Title, seasons: [TitleSeason]) -> String {
        var parts = [title.type.label]

        if let year = title.year {
            parts.append(String(year))
        }

        if let seasonCount = seasonCount(for: title, seasons: seasons), title.type == .tv {
            parts.append(String(localized: "\(seasonCount) stagioni"))
        }

        return parts.joined(separator: " · ")
    }

    static func originalTitle(for title: Title) -> String? {
        guard let original = title.originalName?.trimmingCharacters(in: .whitespacesAndNewlines), !original.isEmpty else {
            return nil
        }
        return original.caseInsensitiveCompare(title.name) == .orderedSame ? nil : original
    }

    static func duration(for title: Title) -> String? {
        if let durationMovie = title.metadata.durationMovie, durationMovie > 0 {
            return "\(durationMovie) min"
        }
        if let durationEpisode = title.metadata.durationEpisode, durationEpisode > 0 {
            return "\(durationEpisode) min / ep"
        }
        return nil
    }

    static func languageName(_ code: String?) -> String? {
        guard let rawValue = code?.trimmingCharacters(in: .whitespacesAndNewlines), !rawValue.isEmpty else { return nil }

        let normalizedCode = rawValue
            .replacingOccurrences(of: "_", with: "-")
            .lowercased()

        if normalizedCode.count <= 3, let localized = Locale.current.localizedString(forLanguageCode: normalizedCode) {
            return localized.localizedCapitalized
        }

        if !normalizedCode.contains(" "),
           let localized = Locale.current.localizedString(forIdentifier: normalizedCode),
           !localized.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            return localized.localizedCapitalized
        }

        if let localized = localizedLanguageName(matching: rawValue) {
            return localized
        }

        return rawValue
            .split(separator: ",")
            .map { part in
                let trimmed = part.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { return trimmed }
                if trimmed == trimmed.lowercased() || trimmed == trimmed.uppercased() {
                    return trimmed.localizedCapitalized
                }
                return trimmed
            }
            .joined(separator: ", ")
    }

    static func countryName(_ code: String?) -> String? {
        guard let rawValue = code?.trimmingCharacters(in: .whitespacesAndNewlines), !rawValue.isEmpty else { return nil }
        if rawValue.count == 2, let localized = Locale.current.localizedString(forRegionCode: rawValue.uppercased()) {
            return localized
        }
        return rawValue
    }

    private static func localizedLanguageName(matching rawValue: String) -> String? {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        let lookup = SearchNormalizer.normalize(trimmed)
        guard !lookup.isEmpty else { return nil }

        let englishLocale = Locale(identifier: "en")
        let italianLocale = Locale(identifier: "it")

        for code in Locale.LanguageCode.isoLanguageCodes {
            let identifier = code.identifier
            let candidates = [
                Locale.current.localizedString(forLanguageCode: identifier),
                englishLocale.localizedString(forLanguageCode: identifier),
                italianLocale.localizedString(forLanguageCode: identifier)
            ]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

            if candidates.contains(where: { SearchNormalizer.normalize($0) == lookup }),
               let localized = Locale.current.localizedString(forLanguageCode: identifier)
            {
                return localized.localizedCapitalized
            }
        }

        return nil
    }

    static func seasonCount(for title: Title, seasons: [TitleSeason]) -> Int? {
        title.metadata.seasonsCount ?? (seasons.isEmpty ? nil : seasons.count)
    }

    static func rating(_ value: Double) -> String {
        // Formato italiano a mezzo punto ("7" / "7,5"), allineato al web.
        RatingDisplayFormat.halfStep(value)
    }

    /// **Wire format, non UI**: il messaggio pubblicato nel thread quando si
    /// vota è salvato come `"7,5/10 — testo"` e sia iOS sia il web lo
    /// riconoscono da quel prefisso (`RatingDisplayFormat.splitRatingPrefix`).
    /// Cambiarlo romperebbe la lettura dei messaggi già scritti: il "/10"
    /// sparisce solo in fase di rendering, mai dal dato.
    static func publicReviewThreadMessage(ratingValue: Double, reviewText: String?) -> String {
        let cleanReview = (reviewText ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let ratingLabel = "\(rating(ratingValue))/10"
        guard !cleanReview.isEmpty else { return ratingLabel }
        return "\(ratingLabel) — \(cleanReview)"
    }

    static func date(_ date: Date?) -> String? {
        guard let date else { return nil }
        return date.formatted(date: .abbreviated, time: .omitted)
    }
}
