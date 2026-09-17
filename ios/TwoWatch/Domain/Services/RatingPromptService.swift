import Foundation
import Observation

/// Decides if/when to surface the in-app rating prompt and persists the user's
/// reaction so we never nag the same person twice for the same release.
@Observable
@MainActor
final class RatingPromptService {
    enum Outcome: String {
        case loved
        case complained
        case postponed
    }

    private let defaults: UserDefaults
    private let minimumQualifyingEvents = 2
    private let minimumIntervalBetweenPrompts: TimeInterval = 60 * 60 * 24 * 30 // 30 days

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// Marks that a "positive-investment" event happened (e.g. quiz finished
    /// with decent accuracy). We only prompt after the user has earned a
    /// couple of these — first-launch users get a clean experience.
    func recordQualifyingEvent() {
        let current = defaults.integer(forKey: SomtoDefaultsKey.ratingPromptQualifyingEvents)
        defaults.set(current + 1, forKey: SomtoDefaultsKey.ratingPromptQualifyingEvents)
    }

    /// True when we should ask the user how they're feeling about the app.
    /// Throttles by: positive outcome already given on current version,
    /// last prompt date within 30 days, not enough qualifying events yet.
    func shouldPresentPrompt(currentVersion: String) -> Bool {
        if defaults.string(forKey: SomtoDefaultsKey.ratingPromptPositiveVersion) == currentVersion {
            return false
        }
        if defaults.integer(forKey: SomtoDefaultsKey.ratingPromptQualifyingEvents) < minimumQualifyingEvents {
            return false
        }
        if defaults.string(forKey: SomtoDefaultsKey.ratingPromptLastVersion) == currentVersion {
            return false
        }
        if let lastPrompt = defaults.object(forKey: SomtoDefaultsKey.ratingPromptLastDate) as? Date,
           Date().timeIntervalSince(lastPrompt) < minimumIntervalBetweenPrompts {
            return false
        }
        return true
    }

    func recordPromptShown(version: String) {
        defaults.set(Date(), forKey: SomtoDefaultsKey.ratingPromptLastDate)
        defaults.set(version, forKey: SomtoDefaultsKey.ratingPromptLastVersion)
    }

    func recordOutcome(_ outcome: Outcome, version: String) {
        switch outcome {
        case .loved:
            defaults.set(version, forKey: SomtoDefaultsKey.ratingPromptPositiveVersion)
            defaults.set(Date(), forKey: SomtoDefaultsKey.ratingPromptPositiveDate)
        case .complained, .postponed:
            break
        }
    }

    static var currentAppVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown"
    }
}
