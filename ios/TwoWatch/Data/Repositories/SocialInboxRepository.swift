@preconcurrency import FirebaseFirestore
import Foundation

@MainActor
final class SocialInboxRepository {
    private let db = Firestore.firestore()
    private let userRepository: UserRepository
    private let titleRepository: TitleRepository

    init(userRepository: UserRepository, titleRepository: TitleRepository) {
        self.userRepository = userRepository
        self.titleRepository = titleRepository
    }

    func fetchReceivedRecommendations(userID: String, limit: Int = 30) async throws -> [RecommendationItem] {
        let snapshot = try await db.collection("recommendations")
            .whereField("toUid", isEqualTo: userID)
            .whereField("status", isEqualTo: RecommendationStatus.unread.rawValue)
            .order(by: "createdAt", descending: true)
            .limit(to: limit)
            .getDocuments()

        return try await mapRecommendations(documents: snapshot.documents, counterpartField: "fromUid")
    }

    func fetchSentRecommendations(userID: String, limit: Int = 30) async throws -> [RecommendationItem] {
        let snapshot = try await db.collection("recommendations")
            .whereField("fromUid", isEqualTo: userID)
            .order(by: "createdAt", descending: true)
            .limit(to: limit)
            .getDocuments()

        return try await mapRecommendations(documents: snapshot.documents, counterpartField: "toUid")
    }

    /// Crea un suggerimento `recommendations/{id}` passando per il rate-limit
    /// helper: le rules richiedono che `users/{uid}/rateLimits/recommendations`
    /// sia incrementato atomicamente con la create (cap 50/24h). La rule impone
    /// anche `createdAt == request.time`, quindi `createdAt` è un Timestamp
    /// corrente (non `serverTimestamp()` che non sarebbe ancora risolto al
    /// check). Il `threadId` viene linkato dopo via `setData(... merge: true)`
    /// — path consentito dalla rule `validRecommendationThreadLinkUpdate` —
    /// quando il chiamante lo passa esplicitamente.
    func createRecommendation(
        fromUid: String,
        toUid: String,
        titleID: String,
        message: String = "",
        threadID: String? = nil,
        containsSpoiler: Bool = false,
        spoilerTitleIDs: [String] = []
    ) async throws -> String {
        guard !fromUid.isEmpty, !toUid.isEmpty, !titleID.isEmpty, fromUid != toUid else {
            throw NSError(domain: "TwoWatch", code: 400, userInfo: [
                NSLocalizedDescriptionKey: String(localized: "Parametri recommendation non validi.")
            ])
        }

        let ref = db.collection("recommendations").document()
        let cleanMessage = message.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanedSpoilerIDs = spoilerTitleIDs
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        let normalizedSpoilerIDs = Array(cleanedSpoilerIDs.prefix(5))

        // Le rules: `validRecommendationBase.keys().hasOnly([...])` ammette
        // anche `containsSpoiler` e `spoilerTitleIds`; threadId su create deve
        // essere `null`.
        var payload: [String: Any] = [
            "fromUid": fromUid,
            "toUid": toUid,
            "titleId": titleID,
            "message": cleanMessage,
            // serverTimestamp: nel check rules il transform vale `request.time`
            // (createdAt == request.time), un Timestamp client non lo eguaglia
            // MAI (clock skew) → permission denied. Provato in emulatore
            // (rules-repro-suggestion.spec.cjs, 2026-07-30).
            "createdAt": FieldValue.serverTimestamp(),
            "status": RecommendationStatus.unread.rawValue,
            "threadId": NSNull(),
            "viewedAt": NSNull()
        ]
        if containsSpoiler {
            payload["containsSpoiler"] = true
            payload["spoilerTitleIds"] = normalizedSpoilerIDs
        }

        _ = try await RateLimitedCreate.createWithRateLimit(
            uid: fromUid,
            action: .recommendations,
            targetRef: ref,
            payload: payload
        )

        // Il threadId viene linkato post-create via update (rule
        // `validRecommendationThreadLinkUpdate`).
        if let threadID, !threadID.isEmpty {
            try await ref.setData(["threadId": threadID], merge: true)
        }

        return ref.documentID
    }

    func markRecommendationViewed(_ recommendationID: String) async throws {
        try await db.collection("recommendations").document(recommendationID).setData([
            "status": RecommendationStatus.seen.rawValue,
            "viewedAt": FieldValue.serverTimestamp()
        ], merge: true)
    }

    func archiveRecommendation(_ recommendationID: String) async throws {
        try await db.collection("recommendations").document(recommendationID).setData([
            "status": RecommendationStatus.archived.rawValue
        ], merge: true)
    }

    private func mapRecommendations(
        documents: [QueryDocumentSnapshot],
        counterpartField: String
    ) async throws -> [RecommendationItem] {
        let counterpartIDs = Array(Set(documents.compactMap {
            FirestoreValueReader.string($0.data(), key: counterpartField)
        }))
        let titleIDs = Array(Set(documents.compactMap {
            FirestoreValueReader.string($0.data(), key: "titleId")
        }))

        async let usersTask = userRepository.listUsers(ids: counterpartIDs)
        async let titlesTask = titleRepository.listTitles(ids: titleIDs)
        let (users, titles) = try await (usersTask, titlesTask)

        let userMap = Dictionary(uniqueKeysWithValues: users.map { ($0.id, $0) })
        let titleMap = Dictionary(uniqueKeysWithValues: titles.map { ($0.id, $0) })

        return documents.compactMap { document in
            let data = document.data()
            guard let fromUid = FirestoreValueReader.string(data, key: "fromUid"),
                  let toUid = FirestoreValueReader.string(data, key: "toUid"),
                  let titleId = FirestoreValueReader.string(data, key: "titleId")
            else {
                return nil
            }

            return RecommendationItem(
                id: document.documentID,
                fromUid: fromUid,
                toUid: toUid,
                titleId: titleId,
                message: FirestoreValueReader.string(data, key: "message") ?? "",
                status: RecommendationStatus(rawValue: FirestoreValueReader.string(data, key: "status") ?? "") ?? .unread,
                threadId: FirestoreValueReader.string(data, key: "threadId"),
                viewedAt: FirestoreValueReader.date(data["viewedAt"]),
                createdAt: FirestoreValueReader.date(data["createdAt"]),
                counterpart: userMap[FirestoreValueReader.string(data, key: counterpartField) ?? ""],
                title: titleMap[titleId],
                containsSpoiler: (data["containsSpoiler"] as? Bool) ?? false,
                spoilerTitleIds: FirestoreValueReader.stringArray(data["spoilerTitleIds"])
            )
        }
    }
}
