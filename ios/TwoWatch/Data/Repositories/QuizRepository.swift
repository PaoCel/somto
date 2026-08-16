@preconcurrency import FirebaseFirestore
import Foundation

/// Firestore repository for the Quiz feature. Read-only by default; the
/// authenticated user can submit attempts and create/play challenges. Admin
/// mutations are gated by `users/{uid}.isAdmin` on the backend rules.
@MainActor
final class QuizRepository {
    private let db = Firestore.firestore()

    /// Status `quizQuestions` leggibili da client: gli unici accettati dalle
    /// rules (firestore.rules `match /quizQuestions`). Le query batched DEVONO
    /// filtrare su questo set, altrimenti il batch viene rifiutato in toto se
    /// include doc pending/flagged.
    private static let playableStatuses: [String] = [
        QuizQuestionStatus.approved.rawValue,
        QuizQuestionStatus.betaPendingReview.rawValue
    ]

    /// Lingua del corpus quiz servito al giocatore. Vedi `decodeQuestion`.
    private static let quizLanguage = "it"

    init() {}

    // MARK: - Question fetching

    /// Fetches up to `count` approved questions sampled from across the whole
    /// catalogue ("Casuale" mode). A plain `quizQuestions` query with `limit`
    /// and no `orderBy` is NOT random: Firestore returns documents in
    /// ascending document-ID order, so the query always read the same fixed
    /// slice — in practice `disney_aladdin_*` + the first few `disney_cars_*`
    /// docs, because `"disney_"` sorts before every `"q_..."` id in the rest
    /// of the catalogue. Every "random" quiz was actually only ever Aladdin
    /// and Cars. Fix: pick a random subset of titleIds from the (already
    /// catalogue-complete) themes aggregate first, then reuse the per-title
    /// fetch below, which has no such bias since it never truncates a
    /// same-order slice of a huge collection.
    func fetchPlayableQuestions(count: Int) async throws -> [QuizQuestion] {
        let themes = try await fetchAllPlayableThemes()
        guard !themes.isEmpty else { return [] }

        var shuffledThemes = themes
        shuffledThemes.shuffle()

        var titleIds: [String] = []
        var running = 0
        for theme in shuffledThemes {
            titleIds.append(theme.titleId)
            running += theme.questionCount
            // Cap at 15 so the downstream chunked-by-15 query stays a single
            // Firestore round trip (see fetchPlayableQuestions(titleIds:count:)).
            if titleIds.count >= 15 || running >= count * 4 { break }
        }

        return try await fetchPlayableQuestions(titleIds: titleIds, count: count)
    }

    /// Resolves a specific set of questions by `questionId`, preserving the
    /// input order. Used by the challenge player so both opponents read the
    /// exact set saved in `quizChallenges/{id}.questionIds`. Reads sono batched
    /// 15-at-a-time perché la query combina `documentId IN (15)` con
    /// `status IN (2)` = 30 disgiunzioni (cap Firestore). Senza il filtro
    /// `status` le rules rifiutano i batch che includono pending/flagged.
    func fetchQuestions(byIds ids: [String]) async throws -> [QuizQuestion] {
        guard !ids.isEmpty else { return [] }
        var map: [String: QuizQuestion] = [:]
        for chunk in Self.chunked(ids, size: 15) {
            let snapshot = try await db.collection("quizQuestions")
                .whereField(FieldPath.documentID(), in: chunk)
                .whereField("status", in: Self.playableStatuses)
                .getDocuments()
            for doc in snapshot.documents {
                if let q = decodeQuestion(doc) {
                    map[q.questionId] = q
                }
            }
        }
        return ids.compactMap { map[$0] }
    }

    /// Returns up to `count` playable questions restricted to the given title
    /// pool. Used by the challenge composer so the contest is on shared
    /// titles. Chunk a 15 perché `titleId IN (15)` × `status IN (2)` = 30
    /// disgiunzioni (cap Firestore); il filtro server-side è obbligatorio per
    /// le rules.
    func fetchPlayableQuestions(titleIds: [String], count: Int) async throws -> [QuizQuestion] {
        guard !titleIds.isEmpty else {
            return try await fetchPlayableQuestions(count: count)
        }
        var pool: [QuizQuestion] = []
        for chunk in Self.chunked(titleIds, size: 15) {
            let snapshot = try await db.collection("quizQuestions")
                .whereField("titleId", in: chunk)
                .whereField("status", in: Self.playableStatuses)
                .getDocuments()
            let filtered = snapshot.documents.compactMap(decodeQuestion)
            pool.append(contentsOf: filtered)
        }
        return Array(pool.shuffled().prefix(count))
    }

    /// Available themes a solo player can pick from: distinct titles that
    /// actually have playable questions, derived by sampling the approved pool
    /// and grouping by `titleId`. Sorted by how many questions each title has
    /// (descending) so the richest themes surface first. The list is best-effort
    /// — it samples up to `sampleSize` questions rather than scanning the whole
    /// collection, which is plenty to populate the picker without a heavy read.
    func fetchPlayableThemes(sampleSize: Int = 240) async throws -> [QuizTheme] {
        let snapshot = try await db.collection("quizQuestions")
            .whereField("status", in: Self.playableStatuses)
            .limit(to: sampleSize)
            .getDocuments()

        let questions = snapshot.documents.compactMap { decodeQuestion($0) }

        // Group by titleId, keeping the first-seen display title + media type
        // and counting how many questions each title contributes.
        var grouped: [String: QuizTheme] = [:]
        for q in questions {
            if let existing = grouped[q.titleId] {
                grouped[q.titleId] = QuizTheme(
                    titleId: existing.titleId,
                    title: existing.title,
                    mediaType: existing.mediaType,
                    questionCount: existing.questionCount + 1
                )
            } else {
                grouped[q.titleId] = QuizTheme(
                    titleId: q.titleId,
                    title: q.title,
                    mediaType: q.mediaType,
                    questionCount: 1
                )
            }
        }

        return grouped.values.sorted { lhs, rhs in
            if lhs.questionCount != rhs.questionCount {
                return lhs.questionCount > rhs.questionCount
            }
            return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
        }
    }

    /// Complete catalogue of playable themes from the public `quizMeta/themes`
    /// aggregate (every title that currently has playable questions). One read,
    /// already sorted server-side by question count then title — used to power
    /// the "titolo specifico" search/vetrina where completeness matters
    /// (`fetchPlayableThemes` only samples the question pool). Falls back to the
    /// sampled list if the aggregate is missing or empty.
    func fetchAllPlayableThemes() async throws -> [QuizTheme] {
        let snapshot = try await db.collection("quizMeta").document("themes").getDocument()
        guard
            let raw = snapshot.data()?["themes"] as? [[String: Any]],
            !raw.isEmpty
        else {
            return try await fetchPlayableThemes()
        }

        let themes: [QuizTheme] = raw.compactMap { item in
            guard
                let titleId = item["titleId"] as? String,
                !titleId.isEmpty
            else { return nil }
            let media = QuizMediaType(rawValue: (item["mediaType"] as? String) ?? "unknown") ?? .unknown
            return QuizTheme(
                titleId: titleId,
                title: (item["title"] as? String) ?? "",
                mediaType: media,
                questionCount: (item["count"] as? Int) ?? 0
            )
        }
        // The aggregate is pre-sorted; preserve that order.
        return themes.isEmpty ? try await fetchPlayableThemes() : themes
    }

    // MARK: - Attempts / Scoring

    /// Persists an attempt under `users/{uid}/quizAttempts/{attemptId}` and
    /// updates the cached stats document. Uses incremental field updates
    /// (`FieldValue.increment`) instead of a transaction to stay
    /// Sendable-clean under Swift 6 strict concurrency. The weekly bucket is
    /// reset when the cached `weekKey` differs from the current one.
    @discardableResult
    func submitAttempt(_ attempt: QuizAttempt) async throws -> QuizGamificationReward {
        let attemptRef = db.collection("users")
            .document(attempt.uid)
            .collection("quizAttempts")
            .document(attempt.attemptId)
        let statsRef = db.collection("users")
            .document(attempt.uid)
            .collection("quizStats")
            .document("agg")

        let attemptData = try Self.encoder.encodeFirestore(attempt)
        let weekKey = Self.isoWeekKey(for: attempt.createdAt)

        try await attemptRef.setData(attemptData)

        // Reset the weekly bucket if the cached week key drifted.
        let existing = try await statsRef.getDocument()
        let storedWeekKey = (existing.data()?["weekKey"] as? String) ?? ""
        if existing.exists, storedWeekKey != weekKey {
            try await statsRef.setData([
                "weeklyScore": 0,
                "weekKey": weekKey
            ], merge: true)
        }

        let payload: [String: Any] = [
            "totalScore": FieldValue.increment(attempt.score),
            "weeklyScore": FieldValue.increment(attempt.score),
            "weekKey": weekKey,
            "attemptsCount": FieldValue.increment(Int64(1)),
            "correctCount": FieldValue.increment(Int64(attempt.correctCount)),
            "wrongCount": FieldValue.increment(Int64(attempt.wrongCount)),
            "skippedCount": FieldValue.increment(Int64(attempt.skippedCount)),
            "updatedAt": FieldValue.serverTimestamp(),
            "displayName": session?.appUser?.displayName ?? NSNull(),
            "photoURL": session?.appUser?.photoURL?.absoluteString ?? NSNull()
        ]
        try await statsRef.setData(payload, merge: true)

        // Gamification (XP / streak / daily bonus) only applies to solo
        // attempts; challenge attempts are rewarded via `recordChallengePlay`
        // so the same game is never counted twice.
        guard attempt.mode == .solo else { return .none }
        return try await applyGamification(
            uid: attempt.uid,
            correctCount: attempt.correctCount,
            mode: .solo,
            challengeOutcome: nil
        )
    }

    /// Optional injection of the session store so user metadata can be
    /// denormalized into the stats doc (used by the leaderboard view).
    /// Default `nil`: stats writes still succeed without it.
    weak var session: SessionStore?

    func fetchUserStats(uid: String) async throws -> QuizUserStats {
        let snap = try await db.collection("users")
            .document(uid)
            .collection("quizStats")
            .document("agg")
            .getDocument()
        guard snap.exists, let data = snap.data() else { return .zero }
        let weekKey = (data["weekKey"] as? String) ?? ""
        let currentWeekKey = Self.isoWeekKey(for: Date())
        let weeklyScore: Double = weekKey == currentWeekKey
            ? (data["weeklyScore"] as? Double ?? 0)
            : 0
        let todayKey = Self.dayKey(for: Date())
        let yesterdayKey = Self.yesterdayKey()
        let lastPlayDayKey = data["lastPlayDayKey"] as? String
        let storedStreak = (data["dailyStreak"] as? Int) ?? 0
        // The streak is "alive" only if the last game was today or yesterday.
        let liveStreak = (lastPlayDayKey == todayKey || lastPlayDayKey == yesterdayKey)
            ? storedStreak
            : 0
        let bonusDayKey = data["dailyBonusDayKey"] as? String
        let bonusGames = (bonusDayKey == todayKey) ? ((data["dailyBonusGames"] as? Int) ?? 0) : 0
        return QuizUserStats(
            totalScore: (data["totalScore"] as? Double) ?? 0,
            weeklyScore: weeklyScore,
            weekStartAt: Self.weekStart(forKey: currentWeekKey),
            attemptsCount: (data["attemptsCount"] as? Int) ?? 0,
            correctCount: (data["correctCount"] as? Int) ?? 0,
            wrongCount: (data["wrongCount"] as? Int) ?? 0,
            skippedCount: (data["skippedCount"] as? Int) ?? 0,
            xp: (data["xp"] as? Int) ?? 0,
            dailyStreak: liveStreak,
            bestDailyStreak: (data["bestDailyStreak"] as? Int) ?? 0,
            lastPlayDayKey: lastPlayDayKey,
            dailyBonusDayKey: bonusDayKey,
            dailyBonusGames: bonusGames
        )
    }

    // MARK: - Leaderboard

    func fetchLeaderboard(scope: QuizLeaderboardScope, limit: Int = 50) async throws -> [QuizLeaderboardEntry] {
        // Read directly from each user's cached quizStats agg doc via a
        // collection-group query. Keeps the leaderboard working without a
        // backend fan-out into a denormalized `leaderboard_*` collection.
        let scoreField: String = scope == .weekly ? "weeklyScore" : "totalScore"
        var query: Query = db.collectionGroup("quizStats")
        if scope == .weekly {
            let weekKey = Self.isoWeekKey(for: Date())
            query = query.whereField("weekKey", isEqualTo: weekKey)
        }
        query = query.order(by: scoreField, descending: true).limit(to: limit)

        let snap = try await query.getDocuments()
        return snap.documents.compactMap { doc in
            let data = doc.data()
            // Doc path: users/{uid}/quizStats/{docId} — recover uid from parent.
            guard let uid = doc.reference.parent.parent?.documentID, !uid.isEmpty else { return nil }
            let rawScore = (data[scoreField] as? Double) ?? Double(data[scoreField] as? Int ?? 0)
            guard rawScore > 0 else { return nil }
            let displayName = (data["displayName"] as? String) ?? "Utente"
            return QuizLeaderboardEntry(
                uid: uid,
                displayName: displayName,
                photoURL: (data["photoURL"] as? String).flatMap(URL.init(string:)),
                score: rawScore,
                attemptsCount: (data["attemptsCount"] as? Int) ?? 0
            )
        }
    }

    // MARK: - Challenges

    func sendChallenge(_ challenge: QuizChallenge) async throws {
        let ref = db.collection("quizChallenges").document(challenge.challengeId)
        let data = try Self.encoder.encodeFirestore(challenge)
        try await ref.setData(data, merge: false)
    }

    func fetchReceivedChallenges(uid: String, limit: Int = 30) async throws -> [QuizChallenge] {
        let snap = try await db.collection("quizChallenges")
            .whereField("toUid", isEqualTo: uid)
            .order(by: "createdAt", descending: true)
            .limit(to: limit)
            .getDocuments()
        return snap.documents.compactMap { decodeChallenge($0) }
    }

    func fetchSentChallenges(uid: String, limit: Int = 30) async throws -> [QuizChallenge] {
        let snap = try await db.collection("quizChallenges")
            .whereField("fromUid", isEqualTo: uid)
            .order(by: "createdAt", descending: true)
            .limit(to: limit)
            .getDocuments()
        return snap.documents.compactMap { decodeChallenge($0) }
    }

    func fetchChallenge(id: String) async throws -> QuizChallenge? {
        let snap = try await db.collection("quizChallenges").document(id).getDocument()
        guard snap.exists else { return nil }
        return decodeChallenge(snap)
    }

    /// Records one side's outcome on the challenge doc: the final score and
    /// the per-question answers. The answers are denormalized here (rather
    /// than only into `quizAttempts`) so the opponent — who can read the
    /// challenge doc but not the other user's attempts — can review them.
    func recordChallengePlay(
        challengeId: String,
        side: ChallengeSide,
        playerUid: String,
        score: Double,
        correctCount: Int,
        answers: [QuizAttemptAnswer]
    ) async throws -> QuizGamificationReward {
        let ref = db.collection("quizChallenges").document(challengeId)

        // Read the opponent's current score (if any) before writing ours, so
        // the challenge outcome can be resolved for the XP award.
        let beforeSnap = try? await ref.getDocument()
        let opponentScore: Double? = {
            guard let data = beforeSnap?.data() else { return nil }
            return side == .from ? (data["toScore"] as? Double) : (data["fromScore"] as? Double)
        }()

        let answersData: [[String: Any]] = answers.map { answer in
            var dict: [String: Any] = [
                "questionId": answer.questionId,
                "outcome": answer.outcome.rawValue
            ]
            if let selectedIndex = answer.selectedIndex {
                dict["selectedIndex"] = selectedIndex
            }
            if let timeMs = answer.timeMs {
                dict["timeMs"] = timeMs
            }
            return dict
        }
        var updates: [String: Any] = [
            "completedAt": FieldValue.serverTimestamp()
        ]
        switch side {
        case .from:
            updates["fromScore"] = score
            updates["fromAnswers"] = answersData
        case .to:
            updates["toScore"] = score
            updates["toAnswers"] = answersData
        }
        // Once both sides have a score the challenge is fully resolved.
        if opponentScore != nil {
            updates["status"] = QuizChallengeStatus.completed.rawValue
        }
        try await ref.setData(updates, merge: true)

        let outcome: QuizChallengeOutcome?
        if let opponentScore {
            if score > opponentScore {
                outcome = .win
            } else if score < opponentScore {
                outcome = .loss
            } else {
                outcome = .draw
            }
        } else {
            outcome = nil
        }
        return try await applyGamification(
            uid: playerUid,
            correctCount: correctCount,
            mode: .challenge,
            challengeOutcome: outcome
        )
    }

    enum ChallengeSide { case from, to }

    // MARK: - Question reports (user-submitted)

    /// Persists a user-submitted report against a specific question. Reviewed
    /// later in the admin area.
    func reportQuestionProblem(
        questionId: String,
        reportedBy uid: String,
        reason: String,
        attemptOutcome: QuizAnswerOutcome?
    ) async throws {
        let ref = db.collection("quizQuestionReports").document()
        let payload: [String: Any] = [
            "questionId": questionId,
            "reportedBy": uid,
            "reason": reason,
            "outcome": attemptOutcome?.rawValue ?? "unknown",
            "createdAt": FieldValue.serverTimestamp()
        ]
        try await ref.setData(payload)
        // Counter bump on quizQuestions.reportsCount/lastReportAt happens
        // server-side (bumpQuizQuestionReportCount trigger) — quizQuestions
        // writes are admin-only, clients can't do it directly.
    }

    // MARK: - Admin

    enum AdminFilter: String, CaseIterable, Hashable {
        case pendingReview = "Da revisionare"
        case flagged = "Segnalate"
        case verified = "Verificate"
        case heavySpoiler = "Heavy spoiler"
    }

    func fetchAdminQuestions(filter: AdminFilter, limit: Int = 100) async throws -> [QuizQuestion] {
        var query: Query = db.collection("quizQuestions").limit(to: limit)
        switch filter {
        case .pendingReview:
            query = query.whereField("status", isEqualTo: QuizQuestionStatus.betaPendingReview.rawValue)
        case .flagged:
            query = query.whereField("status", isEqualTo: QuizQuestionStatus.flagged.rawValue)
        case .verified:
            query = query.whereField("status", isEqualTo: QuizQuestionStatus.approved.rawValue)
        case .heavySpoiler:
            query = query.whereField("spoilerLevel", isEqualTo: QuizSpoilerLevel.heavy.rawValue)
        }
        let snap = try await query.getDocuments()
        return snap.documents.compactMap(decodeQuestion)
    }

    struct AdminStats: Hashable {
        let total: Int
        let mediumConfidence: Int
        let heavySpoiler: Int
        let pendingReview: Int
    }

    func fetchAdminStats() async throws -> AdminStats {
        async let totalSnap = db.collection("quizQuestions").count.getAggregation(source: .server)
        async let mediumSnap = db.collection("quizQuestions")
            .whereField("confidence", isEqualTo: QuizConfidence.medium.rawValue)
            .count.getAggregation(source: .server)
        async let heavySnap = db.collection("quizQuestions")
            .whereField("spoilerLevel", isEqualTo: QuizSpoilerLevel.heavy.rawValue)
            .count.getAggregation(source: .server)
        async let pendingSnap = db.collection("quizQuestions")
            .whereField("status", isEqualTo: QuizQuestionStatus.betaPendingReview.rawValue)
            .count.getAggregation(source: .server)
        let total = try await totalSnap.count.intValue
        let medium = try await mediumSnap.count.intValue
        let heavy = try await heavySnap.count.intValue
        let pending = try await pendingSnap.count.intValue
        return AdminStats(total: total, mediumConfidence: medium, heavySpoiler: heavy, pendingReview: pending)
    }

    func saveAdminEdit(
        questionId: String,
        questionText: String,
        answers: [String],
        correctAnswerIndex: Int,
        difficulty: QuizDifficulty,
        spoilerLevel: QuizSpoilerLevel,
        editedBy uid: String
    ) async throws {
        let ref = db.collection("quizQuestions").document(questionId)
        let payload: [String: Any] = [
            "questionText": questionText,
            "answers": answers,
            "correctAnswerIndex": correctAnswerIndex,
            "difficulty": difficulty.rawValue,
            "spoilerLevel": spoilerLevel.rawValue,
            "moderation": [
                "lastEditedBy": uid,
                "lastEditedAt": FieldValue.serverTimestamp()
            ]
        ]
        try await ref.setData(payload, merge: true)
    }

    func setQuestionStatus(_ status: QuizQuestionStatus, questionId: String, by uid: String) async throws {
        let ref = db.collection("quizQuestions").document(questionId)
        let payload: [String: Any] = [
            "status": status.rawValue,
            "moderation": [
                "lastStatusBy": uid,
                "lastStatusAt": FieldValue.serverTimestamp()
            ]
        ]
        try await ref.setData(payload, merge: true)
    }

    // MARK: - External invites

    enum QuizInviteError: LocalizedError {
        case invalidResponse

        var errorDescription: String? {
            switch self {
            case .invalidResponse: return String(localized: "Risposta non valida dal server.")
            }
        }
    }

    /// Creates an external (share-link) challenge via a Cloud Function and
    /// returns the share token + URL. The challenge doc and the invite token
    /// hash are written server-side with the admin SDK so the raw token is
    /// never exposed to other clients.
    func createExternalInvite(
        placeholderName: String?,
        numQuestions: Int,
        inviterSeenTitleIds: [String]
    ) async throws -> QuizExternalInviteResult {
        var payload: [String: Any] = [
            "numQuestions": numQuestions,
            "inviterSeenTitleIds": inviterSeenTitleIds
        ]
        if let placeholderName,
           !placeholderName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            payload["placeholderName"] = placeholderName
        }
        let result = try await CloudFunctionsCaller.call(
            name: "createQuizExternalInvite",
            data: payload
        )
        guard
            let dict = result.data as? [String: Any],
            let challengeId = dict["challengeId"] as? String,
            let token = dict["inviteToken"] as? String,
            let urlString = dict["inviteUrl"] as? String,
            let url = URL(string: urlString)
        else { throw QuizInviteError.invalidResponse }
        return QuizExternalInviteResult(
            challengeId: challengeId,
            inviteToken: token,
            inviteURL: url
        )
    }

    /// Binds the signed-in user to an external invite. Must be called after
    /// authentication. Returns the data needed for the titles onboarding.
    func claimExternalInvite(token: String) async throws -> QuizClaimResult {
        let result = try await CloudFunctionsCaller.call(
            name: "claimQuizExternalInvite",
            data: ["token": token]
        )
        guard
            let dict = result.data as? [String: Any],
            let challengeId = dict["challengeId"] as? String
        else { throw QuizInviteError.invalidResponse }
        return QuizClaimResult(
            challengeId: challengeId,
            inviterUid: dict["inviterUid"] as? String ?? "",
            inviterDisplayName: dict["inviterDisplayName"] as? String ?? String(localized: "Un amico"),
            inviterSeenTitleIds: dict["inviterSeenTitleIds"] as? [String] ?? [],
            numQuestions: dict["numQuestions"] as? Int ?? 10
        )
    }

    /// Locks in the invitee's confirmed titles and asks the backend to build
    /// the question pool. Returns `.needMoreTitles` when the pool is too thin.
    func finalizeExternalChallenge(
        challengeId: String,
        confirmedTitleIds: [String]
    ) async throws -> QuizFinalizeResult {
        let result = try await CloudFunctionsCaller.call(
            name: "finalizeQuizExternalChallenge",
            data: [
                "challengeId": challengeId,
                "opponentConfirmedSeenTitleIds": confirmedTitleIds
            ]
        )
        guard let dict = result.data as? [String: Any] else {
            throw QuizInviteError.invalidResponse
        }
        if let ok = dict["ok"] as? Bool, ok == false {
            return .needMoreTitles(availableQuestions: dict["available"] as? Int ?? 0)
        }
        guard let count = dict["questionCount"] as? Int else {
            throw QuizInviteError.invalidResponse
        }
        return .ready(questionCount: count)
    }

    // MARK: - Gamification

    /// Read-modify-write of the streak / daily-bonus / XP fields on the cached
    /// stats doc. Applied exactly once per finished game.
    @discardableResult
    private func applyGamification(
        uid: String,
        correctCount: Int,
        mode: QuizMode,
        challengeOutcome: QuizChallengeOutcome?
    ) async throws -> QuizGamificationReward {
        let statsRef = db.collection("users").document(uid)
            .collection("quizStats").document("agg")
        let snap = try await statsRef.getDocument()
        let data = snap.data() ?? [:]
        let today = Self.dayKey(for: Date())
        let yesterday = Self.yesterdayKey()

        // Daily streak: +1 if the last game was yesterday, reset to 1 if the
        // chain is broken, unchanged if already played today.
        let lastDay = data["lastPlayDayKey"] as? String
        let storedStreak = (data["dailyStreak"] as? Int) ?? 0
        let newStreak: Int
        if lastDay == today {
            newStreak = max(storedStreak, 1)
        } else if lastDay == yesterday {
            newStreak = storedStreak + 1
        } else {
            newStreak = 1
        }
        let bestStreak = max((data["bestDailyStreak"] as? Int) ?? 0, newStreak)

        // Daily bonus progress (resets when the day rolls over).
        let bonusDay = data["dailyBonusDayKey"] as? String
        let priorGames = (bonusDay == today) ? ((data["dailyBonusGames"] as? Int) ?? 0) : 0
        let newGames = priorGames + 1
        let bonusActive = newGames >= QuizXP.dailyBonusGamesRequired

        let baseXP: Int
        switch mode {
        case .solo:
            baseXP = QuizXP.soloXP(correctCount: correctCount)
        case .challenge:
            baseXP = QuizXP.challengeXP(correctCount: correctCount, outcome: challengeOutcome)
        }
        let awardedXP = QuizXP.applyDailyBonus(baseXP, active: bonusActive)

        try await statsRef.setData([
            "xp": FieldValue.increment(Int64(awardedXP)),
            "dailyStreak": newStreak,
            "bestDailyStreak": bestStreak,
            "lastPlayDayKey": today,
            "dailyBonusDayKey": today,
            "dailyBonusGames": newGames,
            "updatedAt": FieldValue.serverTimestamp()
        ], merge: true)

        return QuizGamificationReward(
            xpAwarded: awardedXP,
            dailyStreak: newStreak,
            dailyBonusActive: bonusActive
        )
    }

    private static func dayKey(for date: Date) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = .current
        let c = cal.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    private static func yesterdayKey(from date: Date = Date()) -> String {
        let cal = Calendar(identifier: .gregorian)
        let prior = cal.date(byAdding: .day, value: -1, to: date) ?? date
        return dayKey(for: prior)
    }

    // MARK: - Helpers

    private func decodeQuestion(_ doc: QueryDocumentSnapshot) -> QuizQuestion? {
        decodeQuestion(doc as DocumentSnapshot)
    }

    private func decodeQuestion(_ snap: DocumentSnapshot) -> QuizQuestion? {
        guard let data = snap.data() else { return nil }
        // Lingua del pool. Ogni doc `quizQuestions` ha da sempre un campo
        // `language` (verificato su prod il 2026-07-29: 10.525 domande, tutte
        // "it") ma nessuna query lo usava: una sola domanda in inglese avrebbe
        // mescolato le lingue dentro la stessa partita. Il filtro sta qui e non
        // nella query perche' a livello di query servirebbero nuovi indici
        // compositi, da deployare PRIMA del codice che li usa (vedi
        // docs/DECISIONS.md, 2026-07-28). Finche' il corpus e' monolingua e'
        // un no-op. Stessa scelta lato web in `public/js/api/quiz.api.js`.
        guard ((data["language"] as? String) ?? Self.quizLanguage) == Self.quizLanguage else { return nil }
        guard
            let questionText = data["questionText"] as? String,
            let titleId = data["titleId"] as? String,
            let title = data["title"] as? String,
            let answers = data["answers"] as? [String],
            answers.count == 4,
            let correctIdx = data["correctAnswerIndex"] as? Int,
            (0...3).contains(correctIdx)
        else { return nil }

        let difficulty = QuizDifficulty(rawValue: (data["difficulty"] as? String) ?? "medium") ?? .medium
        let spoiler = QuizSpoilerLevel(rawValue: (data["spoilerLevel"] as? String) ?? "none") ?? .none
        let confidence = QuizConfidence(rawValue: (data["confidence"] as? String) ?? "high") ?? .high
        let sourceLevelRaw = (data["sourceLevel"] as? String) ?? "GREEN"
        let category = QuizCategory(rawValue: (data["category"] as? String) ?? "")
        let mediaType = QuizMediaType(rawValue: (data["mediaType"] as? String) ?? "unknown") ?? .unknown
        let status = QuizQuestionStatus(rawValue: (data["status"] as? String) ?? "beta_pending_review") ?? .betaPendingReview

        return QuizQuestion(
            questionId: (data["questionId"] as? String) ?? snap.documentID,
            titleId: titleId,
            tmdbId: data["tmdbId"] as? String,
            mediaType: mediaType,
            title: title,
            questionText: questionText,
            answers: answers,
            correctAnswerIndex: correctIdx,
            explanation: data["explanation"] as? String,
            difficulty: difficulty,
            category: category,
            spoilerLevel: spoiler,
            confidence: confidence,
            sourceLevel: QuizSourceLevel(rawValue: sourceLevelRaw),
            sourceBasis: data["sourceBasis"] as? String,
            riskNotes: data["riskNotes"] as? String,
            status: status,
            createdBy: data["createdBy"] as? String,
            language: (data["language"] as? String) ?? "it",
            answerOrderShuffled: data["answerOrderShuffled"] as? Bool
        )
    }

    private func decodeChallenge(_ snap: DocumentSnapshot) -> QuizChallenge? {
        guard let data = snap.data() else { return nil }
        guard
            let fromUid = data["fromUid"] as? String,
            let qids = data["questionIds"] as? [String]
        else { return nil }
        // `toUid` is absent / null on external invites until they are claimed.
        let toUid = data["toUid"] as? String
        let status = QuizChallengeStatus(rawValue: (data["status"] as? String) ?? "pending") ?? .pending
        let inviteType = QuizInviteType(rawValue: (data["inviteType"] as? String) ?? "internal") ?? .internal
        let createdAt: Date
        if let ts = data["createdAt"] as? Timestamp {
            createdAt = ts.dateValue()
        } else {
            createdAt = Date()
        }
        let completedAt = (data["completedAt"] as? Timestamp)?.dateValue()
        let expiresAt = (data["expiresAt"] as? Timestamp)?.dateValue()
        let numQuestions = (data["numQuestions"] as? Int) ?? qids.count
        return QuizChallenge(
            challengeId: snap.documentID,
            fromUid: fromUid,
            toUid: toUid,
            questionIds: qids,
            numQuestions: numQuestions,
            status: status,
            fromScore: data["fromScore"] as? Double,
            toScore: data["toScore"] as? Double,
            createdAt: createdAt,
            completedAt: completedAt,
            sharedTitleIds: (data["sharedTitleIds"] as? [String]) ?? [],
            fromAnswers: Self.decodeChallengeAnswers(data["fromAnswers"]),
            toAnswers: Self.decodeChallengeAnswers(data["toAnswers"]),
            inviteType: inviteType,
            opponentDisplayName: data["opponentDisplayName"] as? String,
            opponentPlaceholderName: data["opponentPlaceholderName"] as? String,
            inviterSeenTitleIds: (data["inviterSeenTitleIds"] as? [String]) ?? [],
            opponentConfirmedSeenTitleIds: (data["opponentConfirmedSeenTitleIds"] as? [String]) ?? [],
            expiresAt: expiresAt
        )
    }

    private static func decodeChallengeAnswers(_ raw: Any?) -> [QuizAttemptAnswer] {
        guard let array = raw as? [[String: Any]] else { return [] }
        return array.compactMap { dict in
            guard
                let questionId = dict["questionId"] as? String,
                let outcomeRaw = dict["outcome"] as? String,
                let outcome = QuizAnswerOutcome(rawValue: outcomeRaw)
            else { return nil }
            return QuizAttemptAnswer(
                questionId: questionId,
                selectedIndex: dict["selectedIndex"] as? Int,
                outcome: outcome,
                timeMs: dict["timeMs"] as? Int
            )
        }
    }

    private static func chunked<T>(_ array: [T], size: Int) -> [[T]] {
        guard size > 0 else { return [array] }
        var result: [[T]] = []
        var idx = 0
        while idx < array.count {
            let end = min(idx + size, array.count)
            result.append(Array(array[idx..<end]))
            idx = end
        }
        return result
    }

    private static func isoWeekKey(for date: Date) -> String {
        var cal = Calendar(identifier: .iso8601)
        cal.firstWeekday = 2
        cal.minimumDaysInFirstWeek = 4
        let year = cal.component(.yearForWeekOfYear, from: date)
        let week = cal.component(.weekOfYear, from: date)
        return String(format: "%04d-W%02d", year, week)
    }

    private static func weekStart(forKey key: String) -> Date? {
        let parts = key.split(separator: "-W")
        guard parts.count == 2,
              let year = Int(parts[0]),
              let week = Int(parts[1]) else { return nil }
        var cal = Calendar(identifier: .iso8601)
        cal.firstWeekday = 2
        cal.minimumDaysInFirstWeek = 4
        var comps = DateComponents()
        comps.yearForWeekOfYear = year
        comps.weekOfYear = week
        comps.weekday = 2
        return cal.date(from: comps)
    }

    private struct FirestoreEncoder {
        let inner = JSONEncoder()

        init() {
            inner.dateEncodingStrategy = .iso8601
        }

        func encodeFirestore<T: Encodable>(_ value: T) throws -> [String: Any] {
            let data = try inner.encode(value)
            let json = try JSONSerialization.jsonObject(with: data, options: [])
            guard var dict = json as? [String: Any] else {
                throw NSError(domain: "QuizRepository", code: 0)
            }
            // Replace ISO-8601 dates with Firestore Timestamp so query/order works.
            for (k, v) in dict {
                if let s = v as? String, let date = Self.parseISO(s) {
                    dict[k] = Timestamp(date: date)
                }
            }
            return dict
        }

        private static func parseISO(_ s: String) -> Date? {
            let primary = ISO8601DateFormatter()
            primary.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let d = primary.date(from: s) { return d }
            let fallback = ISO8601DateFormatter()
            fallback.formatOptions = [.withInternetDateTime]
            return fallback.date(from: s)
        }
    }

    private static let encoder = FirestoreEncoder()
}
