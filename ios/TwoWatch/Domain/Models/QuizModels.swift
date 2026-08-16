import Foundation

/// Formattazione dei punteggi quiz, in un posto solo.
///
/// Al 2026-08-08 questa funzione esisteva in OTTO copie, tutte dentro
/// `Features/Quiz/`: QuizLeaderboardView (x3), QuizPlayView (x2),
/// QuizChallengeInboxView, QuizChallengeResultView, QuizHomeView. Logica
/// identica, tre grafie diverse. Duplicazione locale, non fra moduli: non
/// serviva nemmeno una decisione di design per toglierla.
enum QuizScore {
    /// Un decimale, ma solo quando serve: 7 -> "7", 7,5 -> "7.5".
    static func format(_ score: Double) -> String {
        let rounded = (score * 10).rounded() / 10
        return rounded == rounded.rounded()
            ? String(format: "%.0f", rounded)
            : String(format: "%.1f", rounded)
    }
}

enum QuizDifficulty: String, Codable, Hashable, CaseIterable {
    case easy
    case medium
    case hard

    var italianLabel: String {
        switch self {
        case .easy: return String(localized: "Facile")
        case .medium: return String(localized: "Media")
        case .hard: return String(localized: "Difficile")
        }
    }
}

enum QuizSpoilerLevel: String, Codable, Hashable, CaseIterable {
    case none
    case light
    case medium
    case heavy

    var italianLabel: String {
        switch self {
        case .none: return String(localized: "Nessuno")
        case .light: return String(localized: "Lieve")
        case .medium: return String(localized: "Medio")
        case .heavy: return String(localized: "Forte")
        }
    }
}

enum QuizConfidence: String, Codable, Hashable, CaseIterable {
    case low
    case medium
    case high
}

enum QuizSourceLevel: String, Codable, Hashable {
    case green = "GREEN"
    case yellow = "YELLOW"
    case red = "RED"
}

enum QuizQuestionStatus: String, Codable, Hashable {
    case betaPendingReview = "beta_pending_review"
    case approved
    case flagged
    case discarded
}

enum QuizCategory: String, Codable, Hashable {
    case anagraphic
    case character
    case plot
    case scene
    case relationship
    case object
    case motivation
    case consequence
    case episode
    case quotePAraphrase = "quote_paraphrase"
    case chronology
    case trivia
}

enum QuizMediaType: String, Codable, Hashable {
    case movie
    case tv
    case unknown
}

struct QuizQuestion: Identifiable, Codable, Hashable {
    var id: String { questionId }
    let questionId: String
    let titleId: String
    let tmdbId: String?
    let mediaType: QuizMediaType
    let title: String
    let questionText: String
    let answers: [String]
    let correctAnswerIndex: Int
    let explanation: String?
    let difficulty: QuizDifficulty
    let category: QuizCategory?
    let spoilerLevel: QuizSpoilerLevel
    let confidence: QuizConfidence
    let sourceLevel: QuizSourceLevel?
    let sourceBasis: String?
    let riskNotes: String?
    let status: QuizQuestionStatus
    let createdBy: String?
    let language: String
    let answerOrderShuffled: Bool?

    enum CodingKeys: String, CodingKey {
        case questionId, titleId, tmdbId, mediaType, title, questionText
        case answers, correctAnswerIndex, explanation, difficulty, category
        case spoilerLevel, confidence, sourceLevel, sourceBasis, riskNotes
        case status, createdBy, language, answerOrderShuffled
    }
}

// MARK: - Playable theme

/// A title that has playable quiz questions — used to populate the solo-game
/// theme picker. Derived from the question pool, never from the watchlist.
struct QuizTheme: Identifiable, Hashable {
    var id: String { titleId }
    let titleId: String
    let title: String
    let mediaType: QuizMediaType
    /// How many playable questions were sampled for this title.
    let questionCount: Int
}

// MARK: - Attempts / Scoring

enum QuizAnswerOutcome: String, Codable, Hashable {
    case correct
    case wrong
    case skipped
}

struct QuizAttemptAnswer: Codable, Hashable {
    let questionId: String
    let selectedIndex: Int?
    let outcome: QuizAnswerOutcome
    let timeMs: Int?
}

enum QuizMode: String, Codable, Hashable {
    case solo
    case challenge
}

struct QuizAttempt: Identifiable, Codable, Hashable {
    var id: String { attemptId }
    let attemptId: String
    let uid: String
    let mode: QuizMode
    let challengeId: String?
    let questionIds: [String]
    let answers: [QuizAttemptAnswer]
    let score: Double
    let correctCount: Int
    let wrongCount: Int
    let skippedCount: Int
    let createdAt: Date
}

/// Scoring rules: +1 correct, -0.2 wrong, 0 skipped.
enum QuizScoring {
    static let correctPoints: Double = 1.0
    static let wrongPoints: Double = -0.2
    static let skipPoints: Double = 0.0

    static func points(for outcome: QuizAnswerOutcome) -> Double {
        switch outcome {
        case .correct: return correctPoints
        case .wrong: return wrongPoints
        case .skipped: return skipPoints
        }
    }

    static func score(for answers: [QuizAttemptAnswer]) -> Double {
        answers.reduce(0) { partial, ans in
            partial + points(for: ans.outcome)
        }
    }
}

// MARK: - Challenges

enum QuizChallengeStatus: String, Codable, Hashable {
    case pending
    case played
    /// External invite created, waiting for the invited person to sign up.
    case pendingExternalSignup = "pending_external_signup"
    /// Invited person signed up, waiting for them to confirm watched titles.
    case pendingOpponentTitles = "pending_opponent_titles"
    /// Questions assigned, waiting for the opponent to play.
    case pendingOpponentPlay = "pending_opponent_play"
    case inProgress = "in_progress"
    case completed
    case expired
    case cancelled
}

/// Whether a challenge targets a registered Somto friend or an external
/// person reached through a share link.
enum QuizInviteType: String, Codable, Hashable {
    case `internal`
    case external
}

enum QuizChallengeOutcome: String, Codable, Hashable {
    case win
    case loss
    case draw
}

struct QuizChallenge: Identifiable, Codable, Hashable {
    var id: String { challengeId }
    let challengeId: String
    let fromUid: String
    /// nil while an external invite is still waiting for the invited person
    /// to sign up; set to their uid once the invite is claimed.
    let toUid: String?
    let questionIds: [String]
    let numQuestions: Int
    let status: QuizChallengeStatus
    let fromScore: Double?
    let toScore: Double?
    let createdAt: Date
    let completedAt: Date?
    let sharedTitleIds: [String]
    /// Per-question answers of each side, stored on the challenge doc so the
    /// opponent can review them once both have played. Empty until that side
    /// completes (or for challenges created before answer review existed).
    var fromAnswers: [QuizAttemptAnswer] = []
    var toAnswers: [QuizAttemptAnswer] = []

    // MARK: External invite

    var inviteType: QuizInviteType = .internal
    /// Real display name of the opponent once known (set on invite claim).
    var opponentDisplayName: String? = nil
    /// Optional label the inviter typed before sharing ("Marco"). Shown while
    /// the invite is still unclaimed.
    var opponentPlaceholderName: String? = nil
    /// Titles the inviter has seen — shown to the invitee during onboarding.
    var inviterSeenTitleIds: [String] = []
    /// Titles the invitee confirmed having seen.
    var opponentConfirmedSeenTitleIds: [String] = []
    var expiresAt: Date? = nil

    /// True once both players have a recorded score.
    var isComplete: Bool { fromScore != nil && toScore != nil }

    /// True while an external invite has not yet been claimed by a real user.
    var isAwaitingExternalSignup: Bool {
        inviteType == .external && (toUid == nil || toUid?.isEmpty == true)
    }

    /// Best label available for the opponent at any invite stage.
    var opponentLabel: String {
        if let opponentDisplayName, !opponentDisplayName.isEmpty {
            return opponentDisplayName
        }
        if let opponentPlaceholderName, !opponentPlaceholderName.isEmpty {
            return opponentPlaceholderName
        }
        return inviteType == .external ? "Invito esterno" : "Avversario"
    }

    /// Match outcome from the challenge creator's perspective.
    var creatorOutcome: QuizChallengeOutcome? {
        guard let fromScore, let toScore else { return nil }
        if fromScore > toScore { return .win }
        if fromScore < toScore { return .loss }
        return .draw
    }
}

/// Result of creating an external invite — what the iOS client needs to open
/// the system share sheet.
struct QuizExternalInviteResult: Hashable {
    let challengeId: String
    let inviteToken: String
    let inviteURL: URL
}

/// What the iOS client needs after claiming an external invite — drives the
/// "titoli visti" onboarding screen.
struct QuizClaimResult: Hashable, Identifiable {
    let challengeId: String
    let inviterUid: String
    let inviterDisplayName: String
    let inviterSeenTitleIds: [String]
    let numQuestions: Int

    var id: String { challengeId }
}

/// Outcome of finalizing an external challenge's question pool.
enum QuizFinalizeResult: Hashable {
    /// Pool is ready — the challenge can be played with this many questions.
    case ready(questionCount: Int)
    /// Not enough approved questions — the invitee should pick more titles.
    case needMoreTitles(availableQuestions: Int)
}

// MARK: - Leaderboard

enum QuizLeaderboardScope: String, Codable, Hashable, CaseIterable {
    case weekly
    case allTime

    var italianLabel: String {
        switch self {
        case .weekly: return String(localized: "Settimanale")
        case .allTime: return String(localized: "All time")
        }
    }
}

struct QuizLeaderboardEntry: Identifiable, Codable, Hashable {
    var id: String { uid }
    let uid: String
    let displayName: String
    let photoURL: URL?
    let score: Double
    let attemptsCount: Int
}

struct QuizUserStats: Codable, Hashable {
    var totalScore: Double
    var weeklyScore: Double
    var weekStartAt: Date?
    var attemptsCount: Int
    var correctCount: Int
    var wrongCount: Int
    var skippedCount: Int

    // MARK: Gamification (XP / streak / daily bonus)

    /// Engagement points — kept separate from the leaderboard score.
    var xp: Int = 0
    /// Consecutive days with at least one completed quiz or challenge.
    var dailyStreak: Int = 0
    var bestDailyStreak: Int = 0
    /// Day key ("yyyy-MM-dd") of the last completed game — drives the streak.
    var lastPlayDayKey: String?
    /// Day key the daily-bonus progress belongs to.
    var dailyBonusDayKey: String?
    /// Games played today, counted toward the daily bonus.
    var dailyBonusGames: Int = 0

    static let zero = QuizUserStats(
        totalScore: 0,
        weeklyScore: 0,
        weekStartAt: nil,
        attemptsCount: 0,
        correctCount: 0,
        wrongCount: 0,
        skippedCount: 0,
        xp: 0,
        dailyStreak: 0,
        bestDailyStreak: 0,
        lastPlayDayKey: nil,
        dailyBonusDayKey: nil,
        dailyBonusGames: 0
    )

    var accuracyPct: Double? {
        let answered = correctCount + wrongCount
        guard answered > 0 else { return nil }
        return Double(correctCount) / Double(answered) * 100
    }

    /// Daily bonus is unlocked once enough games have been played today.
    var isDailyBonusActive: Bool {
        dailyBonusGames >= QuizXP.dailyBonusGamesRequired
    }

    /// Clamped 0...required progress for the bonus card.
    var dailyBonusProgress: Int {
        min(dailyBonusGames, QuizXP.dailyBonusGamesRequired)
    }
}

// MARK: - XP rewards

/// Engagement XP — deliberately separate from `QuizScoring` (the leaderboard
/// score). XP never goes negative and exists purely to drive streaks/bonuses.
enum QuizXP {
    static let perCorrectAnswer = 2
    static let quizCompletion = 10
    static let challengeCompletion = 15
    static let challengeWinBonus = 10
    static let challengeDrawBonus = 5

    static let dailyBonusGamesRequired = 3
    static let dailyBonusMultiplier = 1.2

    /// XP for finishing a solo quiz.
    static func soloXP(correctCount: Int) -> Int {
        quizCompletion + perCorrectAnswer * max(0, correctCount)
    }

    /// XP for finishing a challenge, including the win/draw bonus.
    static func challengeXP(correctCount: Int, outcome: QuizChallengeOutcome?) -> Int {
        var xp = challengeCompletion + perCorrectAnswer * max(0, correctCount)
        switch outcome {
        case .win: xp += challengeWinBonus
        case .draw: xp += challengeDrawBonus
        case .loss, .none: break
        }
        return xp
    }

    /// Applies the +20% daily bonus when active.
    static func applyDailyBonus(_ xp: Int, active: Bool) -> Int {
        active ? Int((Double(xp) * dailyBonusMultiplier).rounded()) : xp
    }
}

/// Reward summary produced after finishing a game — drives the result screen
/// XP / streak / bonus feedback.
struct QuizGamificationReward: Hashable {
    let xpAwarded: Int
    let dailyStreak: Int
    let dailyBonusActive: Bool

    static let none = QuizGamificationReward(
        xpAwarded: 0,
        dailyStreak: 0,
        dailyBonusActive: false
    )
}
