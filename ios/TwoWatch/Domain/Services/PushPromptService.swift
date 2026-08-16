import Foundation
import Observation
import UserNotifications

/// Decide se/quando mostrare il pre-prompt Somto per le notifiche push (solo
/// 4/94 utenti le avevano attive perché l'app non chiedeva mai il permesso al
/// momento giusto — vedi CLAUDE.md). Gate persistito in UserDefaults, mirror
/// del pattern `RatingPromptService`: mostriamo il pre-prompt AL MASSIMO una
/// volta per punto di innesco ("post_onboarding" / "post_import"), mai se il
/// sistema ha già una decisione (authorized/denied/provisional/ephemeral) o se
/// l'utente ha già visto un pre-prompt in questa sessione app.
@Observable
@MainActor
final class PushPromptService {
    /// Punto di innesco del pre-prompt, per analytics e per non confondere i
    /// due gate (onboarding vs import) nello storage.
    enum Trigger: String {
        case postOnboarding = "post_onboarding"
        case postImport = "post_import"
    }

    /// Il banner Home riappare 14 giorni dopo l'ultimo dismiss (TTL, non
    /// one-shot): a differenza del pre-prompt legato a onboarding/import,
    /// qui vogliamo ripresentarci periodicamente finché l'utente non attiva
    /// le notifiche, stesso pattern del banner web.
    private static let homeBannerTTL: TimeInterval = 14 * 24 * 60 * 60

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// True se il pre-prompt Somto non è mai stato mostrato (qualunque
    /// trigger) E il sistema non ha ancora una decisione di authorization
    /// (va richiamato dopo aver controllato `currentAuthorizationStatus()`
    /// sul coordinator: se è già authorized/denied/provisional/ephemeral non
    /// ha senso proporlo di nuovo).
    var hasSeenPrompt: Bool {
        defaults.bool(forKey: SomtoDefaultsKey.pushPromptSeen)
    }

    func markPromptSeen() {
        defaults.set(true, forKey: SomtoDefaultsKey.pushPromptSeen)
    }

    /// Il gate deve considerare SOLO `.notDetermined`: se l'utente ha già
    /// accettato/rifiutato/ha provisional/ephemeral, il pre-prompt Somto non
    /// aggiunge nulla (o rischia di chiedere di nuovo un permesso già negato).
    func shouldOfferPrompt(currentStatus: UNAuthorizationStatus) -> Bool {
        guard !hasSeenPrompt else { return false }
        return currentStatus == .notDetermined
    }

    /// Gate del banner Home "Attiva le notifiche": indipendente da
    /// `hasSeenPrompt` (quel flag riguarda solo il pre-prompt one-shot
    /// onboarding/import). Vero se lo stato è ancora `.notDetermined` e
    /// l'ultimo dismiss del banner è più vecchio di 14 giorni (o non c'è mai
    /// stato).
    func shouldOfferHomeBanner(currentStatus: UNAuthorizationStatus) -> Bool {
        guard currentStatus == .notDetermined else { return false }
        guard defaults.object(forKey: SomtoDefaultsKey.pushBannerDismissedAt) != nil else { return true }
        let dismissedAt = defaults.double(forKey: SomtoDefaultsKey.pushBannerDismissedAt)
        let elapsed = Date().timeIntervalSince1970 - dismissedAt
        return elapsed >= Self.homeBannerTTL
    }

    func markHomeBannerDismissed() {
        defaults.set(Date().timeIntervalSince1970, forKey: SomtoDefaultsKey.pushBannerDismissedAt)
    }
}
