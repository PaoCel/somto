import FirebaseAnalytics
import Foundation

/// Loggatore di eventi prodotto. Mantiene parità con il wrapper PWA
/// (`public/js/analytics.js`): nomi evento e chiavi devono restare allineati
/// così le dashboard mostrano i due client uniti.
///
/// Non passare PII al logger. UID utente è già impostato come user property
/// da Firebase Analytics. Niente email, displayName, testo libero o contenuti
/// generati dall'utente.
protocol AnalyticsLogging: Sendable {
    func log(_ event: String, _ params: [String: Any])
}

extension AnalyticsLogging {
    /// Convenience per loggare un evento senza parametri.
    func log(_ event: String) {
        log(event, [:])
    }
}

/// Logger di produzione: scrive direttamente su Firebase Analytics.
final class FirebaseAnalyticsLogger: AnalyticsLogging {
    init() {}

    func log(_ event: String, _ params: [String: Any] = [:]) {
        let sanitizedName = AnalyticsKeys.sanitizeEventName(event)
        guard !sanitizedName.isEmpty else { return }
        let sanitizedParams = AnalyticsKeys.sanitizeParams(params)
        Analytics.logEvent(sanitizedName, parameters: sanitizedParams.isEmpty ? nil : sanitizedParams)
    }
}

/// Logger no-op per preview/test (l'app reale usa `FirebaseAnalyticsLogger`).
final class NoopAnalyticsLogger: AnalyticsLogging {
    init() {}
    func log(_ event: String, _ params: [String: Any] = [:]) {}
}

/// Nomi evento usati da iOS — devono restare allineati a `public/js/*` per
/// la parità web/app. Aggiungere nuovi nomi qui prima di chiamarli a giro.
enum AnalyticsEvent {
    static let signupCompleted = "signup_completed"
    static let onboardingStarted = "onboarding_started"
    static let onboardingSourceChosen = "onboarding_source_chosen"
    static let onboardingStepWatchlist = "onboarding_step_watchlist"
    static let onboardingStepLibrary = "onboarding_step_library"
    static let onboardingStepFollow = "onboarding_step_follow"
    static let onboardingStepComment = "onboarding_step_comment"
    static let onboardingAvatarSet = "onboarding_avatar_set"
    static let onboardingCompleted = "onboarding_completed"
    static let tutorialStarted = "tutorial_started"
    static let tutorialCompleted = "tutorial_completed"
    static let matchDeckLoaded = "match_deck_loaded"
    static let matchAction = "match_action"
    static let watchlistItemAdded = "watchlist_item_added"
    static let titleOpened = "title_opened"
    /// Una forma LEGACY di documento e' stata incontrata al decoding. Emesso
    /// una volta per chiave per sessione da `FallbackProbe`: serve a scoprire
    /// quali fallback dei mapper Firestore siano ancora vivi, per poter
    /// cancellare i rami morti. Vedi docs/IOS_REFACTOR_PLAN.md.
    static let legacyShapeSeen = "legacy_shape_seen"
    static let recommendationSent = "recommendation_sent"
    static let notificationOpened = "notification_opened"
    static let threadMessageSent = "thread_message_sent"
    static let pushPromptShown = "push_prompt_shown"
    static let pushPromptEnabled = "push_prompt_enabled"
    static let pushPromptDismissed = "push_prompt_dismissed"
    static let episodeSeenSheetShown = "post_episode_sheet_opened"
    static let episodeEmotionsSaved = "episode_emotions_saved"
    static let episodeEmotionsFailed = "episode_emotions_failed"
    static let episodeCharacterPicksSaved = "episode_characters_saved"
    static let episodeCharacterPicksFailed = "episode_characters_failed"
    static let episodeDiscussionOpened = "post_episode_discussion_opened"
    // Import cronologia — quick confirm flow (parità con public/js/pages/import.page.js).
    static let importStarted = "import_started"
    static let importReadyForConfirmation = "import_ready_for_confirmation"
    static let importConfirmationOpened = "import_confirmation_opened"
    static let importQuickConfirmed = "import_quick_confirmed"
    static let importManualReviewOpened = "import_manual_review_opened"
    static let importCompleted = "import_completed"
    static let importFailed = "import_failed"
    static let importPostActionClicked = "import_post_action_clicked"
}

/// Helpers di sanitizzazione condivisi: replicano la logica del wrapper PWA
/// (`sanitizeEventName` / `sanitizePropKey` / `sanitizePropValue`) così i
/// vincoli Firebase Analytics sono rispettati anche da iOS.
private enum AnalyticsKeys {
    private static let maxEventNameLength = 40
    private static let maxParamKeyLength = 40
    private static let maxStringValueLength = 100
    private static let maxParamCount = 24

    static func sanitizeEventName(_ name: String) -> String {
        sanitizeIdentifier(name, maxLength: maxEventNameLength, fallbackPrefix: "evt_")
    }

    static func sanitizeParamKey(_ key: String) -> String {
        sanitizeIdentifier(key, maxLength: maxParamKeyLength, fallbackPrefix: "p_")
    }

    static func sanitizeParams(_ raw: [String: Any]) -> [String: Any] {
        var out: [String: Any] = [:]
        out.reserveCapacity(raw.count)
        for (rawKey, rawValue) in raw {
            if out.count >= maxParamCount { break }
            let key = sanitizeParamKey(rawKey)
            guard !key.isEmpty else { continue }
            guard let value = sanitizeParamValue(rawValue) else { continue }
            out[key] = value
        }
        return out
    }

    private static func sanitizeIdentifier(_ input: String, maxLength: Int, fallbackPrefix: String) -> String {
        let lower = input.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !lower.isEmpty else { return "" }

        var collapsed = ""
        collapsed.reserveCapacity(lower.count)
        var lastWasUnderscore = false
        for char in lower.unicodeScalars {
            let isAllowed = (char >= "a" && char <= "z") ||
                (char >= "0" && char <= "9") ||
                char == "_"
            if isAllowed {
                if char == "_" {
                    if lastWasUnderscore { continue }
                    lastWasUnderscore = true
                } else {
                    lastWasUnderscore = false
                }
                collapsed.unicodeScalars.append(char)
            } else {
                if lastWasUnderscore { continue }
                lastWasUnderscore = true
                collapsed.append("_")
            }
        }

        let trimmed = collapsed.trimmingCharacters(in: CharacterSet(charactersIn: "_"))
        guard !trimmed.isEmpty else { return "" }

        let needsPrefix = !(trimmed.first?.isLetter ?? false)
        let candidate = needsPrefix ? fallbackPrefix + trimmed : trimmed
        if candidate.count <= maxLength { return candidate }
        return String(candidate.prefix(maxLength))
    }

    private static func sanitizeParamValue(_ value: Any) -> Any? {
        switch value {
        case let bool as Bool:
            return bool
        case let number as NSNumber:
            return number
        case let string as String:
            let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return nil }
            if trimmed.count <= maxStringValueLength { return trimmed }
            return String(trimmed.prefix(maxStringValueLength))
        case let date as Date:
            let iso = ISO8601DateFormatter().string(from: date)
            return iso.count <= maxStringValueLength ? iso : String(iso.prefix(maxStringValueLength))
        default:
            let described = String(describing: value)
            if described.isEmpty { return nil }
            return described.count <= maxStringValueLength ? described : String(described.prefix(maxStringValueLength))
        }
    }
}
