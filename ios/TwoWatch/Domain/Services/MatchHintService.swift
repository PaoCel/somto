import Foundation
import Observation

/// Decides whether to auto-present the Match "come funziona" coach-mark the
/// very first time a user reaches a successfully loaded deck. Stamped on
/// `RatingPromptService`: injectable `UserDefaults` for testability, one
/// persisted flag, no nagging on repeat visits.
@Observable
@MainActor
final class MatchHintService {
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// True only the first time it's called after a fresh install/reset —
    /// callers should gate the coach-mark presentation on this.
    var shouldShowHint: Bool {
        !defaults.bool(forKey: SomtoDefaultsKey.matchHintSeen)
    }

    func markHintSeen() {
        defaults.set(true, forKey: SomtoDefaultsKey.matchHintSeen)
    }
}
