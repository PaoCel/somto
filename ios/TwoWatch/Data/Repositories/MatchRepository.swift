@preconcurrency import FirebaseFirestore
import Foundation

@MainActor
final class MatchRepository {
    private let db = Firestore.firestore()

    func fetchQueue(limit: Int = 18, excluding ids: [String] = []) async throws -> [MatchCandidate] {
        let max = max(5, min(36, limit))
        let payload: [String: any Sendable] = [
            "max": max,
            "fastStart": true,
            "excludeTitleIds": ids
        ]

        let result = try await callCallable(name: "getMatchQueue", payload: payload)
        guard let data = result.data as? [String: Any] else { return [] }
        let items = data["items"] as? [[String: Any]] ?? []
        let candidates = items.compactMap(snapshotToCandidate)
        return Self.diversify(candidates)
    }

    static func diversify(_ items: [MatchCandidate], minGap: Int = 2) -> [MatchCandidate] {
        guard items.count > 2 else { return items }
        var pool = items
        var out: [MatchCandidate] = []
        out.reserveCapacity(pool.count)

        while !pool.isEmpty {
            let recent = Array(out.suffix(minGap))
            var pickedIndex: Int? = nil
            for idx in pool.indices {
                let candidate = pool[idx]
                let conflict = recent.contains { Self.areTooSimilar(candidate, $0) }
                if !conflict {
                    pickedIndex = idx
                    break
                }
            }
            let index = pickedIndex ?? 0
            out.append(pool.remove(at: index))
        }
        return out
    }

    static func areTooSimilar(_ a: MatchCandidate, _ b: MatchCandidate) -> Bool {
        if a.id == b.id { return true }
        let keyA = sagaKey(a)
        let keyB = sagaKey(b)
        if !keyA.isEmpty, keyA == keyB { return true }

        let nameA = normalizeTitle(a.name)
        let nameB = normalizeTitle(b.name)
        guard !nameA.isEmpty, !nameB.isEmpty else { return false }
        if nameA.count >= 7, nameB.contains(nameA) { return true }
        if nameB.count >= 7, nameA.contains(nameB) { return true }
        return false
    }

    private static func normalizeTitle(_ raw: String) -> String {
        let lowered = raw
            .folding(options: .diacriticInsensitive, locale: .current)
            .lowercased()
        var cleaned = ""
        cleaned.reserveCapacity(lowered.count)
        for scalar in lowered.unicodeScalars {
            if CharacterSet.alphanumerics.contains(scalar) {
                cleaned.unicodeScalars.append(scalar)
            } else {
                cleaned.append(" ")
            }
        }
        return cleaned
            .split(separator: " ", omittingEmptySubsequences: true)
            .joined(separator: " ")
    }

    private static let sagaExclusionRegex: NSRegularExpression? = {
        try? NSRegularExpression(pattern: "^(ii|iii|iv|v|vi|vii|viii|ix|x|[0-9]+)$", options: [])
    }()

    private static func sagaKey(_ candidate: MatchCandidate) -> String {
        let base = normalizeTitle(candidate.name)
        guard !base.isEmpty else { return "" }
        let tokens = base.split(separator: " ").map(String.init).filter { token in
            guard let regex = sagaExclusionRegex else { return true }
            let range = NSRange(token.startIndex..<token.endIndex, in: token)
            return regex.firstMatch(in: token, options: [], range: range) == nil
        }
        guard !tokens.isEmpty else { return "" }
        return tokens.prefix(min(2, tokens.count)).joined(separator: " ")
    }

    func markShown(userID: String, candidate: MatchCandidate) async throws {
        try await db.collection("users")
            .document(userID)
            .collection("matchFeedback")
            .document(candidate.id)
            .setData([
                "titleId": candidate.id,
                "shownAt": FieldValue.serverTimestamp(),
                "shownCount": FieldValue.increment(Int64(1)),
                "scoreSnapshot": candidate.score,
                "matchPercentSnapshot": candidate.matchPercent,
                "source": "ios_match_mode",
                "reasonsSnapshot": candidate.reasons,
                "updatedAt": FieldValue.serverTimestamp()
            ], merge: true)
    }

    func saveFeedback(userID: String, candidate: MatchCandidate, action: MatchAction) async throws {
        let matchFeedbackRef = db.collection("users")
            .document(userID)
            .collection("matchFeedback")
            .document(candidate.id)

        try await matchFeedbackRef.setData([
            "titleId": candidate.id,
            "action": action.rawValue,
            "actionAt": FieldValue.serverTimestamp(),
            "shownAt": FieldValue.serverTimestamp(),
            "scoreSnapshot": candidate.score,
            "matchPercentSnapshot": candidate.matchPercent,
            "source": "ios_match_mode",
            "reasonsSnapshot": candidate.reasons,
                "updatedAt": FieldValue.serverTimestamp()
            ], merge: true)

        let signalRef = db.collection("users")
            .document(userID)
            .collection("signals")
            .document()

        try await signalRef.setData([
            "titleId": candidate.id,
            "actionType": action.signalType,
            "rawValue": NSNull(),
            "normalizedValue": normalizedValue(for: action),
            "actionWeight": actionWeight(for: action),
            "delta": normalizedValue(for: action) * actionWeight(for: action),
            "source": "ios_match_mode",
            "dedupeKey": "\(action.signalType)_\(candidate.id)_\(todayKeyUTC())",
            "multiplier": 1,
            "createdAt": FieldValue.serverTimestamp()
        ])
    }

    private func snapshotToCandidate(_ raw: [String: Any]) -> MatchCandidate? {
        let id = FirestoreValueReader.string(raw["id"]) ?? FirestoreValueReader.string(raw["titleId"])
        guard let id, !id.isEmpty else { return nil }

        let type = MediaType(rawValue: FirestoreValueReader.string(raw["type"]) ?? "") ?? .movie
        let posterURL = FirestoreValueReader.string(raw["posterPath"]).flatMap(URL.init(string:))
        let genres = FirestoreValueReader.stringArray(raw["genres"]).prefix(4).map { $0 }
        let cast = FirestoreValueReader.stringArray(raw["cast"]).prefix(3).map { $0 }
        let reasons = FirestoreValueReader.stringArray(raw["reasons"]).prefix(3).map { $0 }

        return MatchCandidate(
            id: id,
            name: FirestoreValueReader.string(raw["name"]) ?? "(senza titolo)",
            type: type,
            year: FirestoreValueReader.int(raw["year"]),
            overview: FirestoreValueReader.string(raw["overview"]) ?? "",
            posterURL: posterURL,
            genres: genres,
            cast: cast,
            reasons: reasons,
            score: FirestoreValueReader.double(raw["score"]) ?? 0,
            matchPercent: max(0, min(100, FirestoreValueReader.int(raw["matchPercent"]) ?? 0)),
            ratingAvg: FirestoreValueReader.double(raw["ratingAvg"]) ?? 0,
            ratingCount: FirestoreValueReader.int(raw["ratingCount"]) ?? 0
        )
    }

    private func normalizedValue(for action: MatchAction) -> Double {
        switch action {
        case .dislike:
            return -1
        case .seen:
            return 0
        case .like:
            return 1
        case .superlike:
            return 1
        }
    }

    private func actionWeight(for action: MatchAction) -> Double {
        switch action {
        case .dislike:
            return 0.55
        case .seen:
            return 0.05
        case .like:
            return 0.15
        case .superlike:
            return 0.60
        }
    }

    private func todayKeyUTC() -> String {
        let now = Date()
        let calendar = Calendar(identifier: .gregorian)
        let components = calendar.dateComponents(in: TimeZone(secondsFromGMT: 0) ?? .current, from: now)
        let year = components.year ?? 0
        let month = components.month ?? 0
        let day = components.day ?? 0
        return String(format: "%04d%02d%02d", year, month, day)
    }

    private func callCallable(name: String, payload: [String: any Sendable]) async throws -> CloudFunctionsCaller.CallableResult {
        try await CloudFunctionsCaller.call(name: name, data: payload)
    }
}
