import Foundation

struct SignupLifecycleState: Equatable {
    let lifecycleStatus: String
    let emailVerified: Bool
    let legacyEmailUnverified: Bool
    let profilePresent: Bool
    let pendingStatus: String?

    var requiresEmailVerification: Bool {
        emailVerified == false
            && legacyEmailUnverified == false
            && (lifecycleStatus == "pending_verification" || pendingStatus == "pending")
    }

    var recommendsEmailVerification: Bool {
        emailVerified == false
            && (legacyEmailUnverified || lifecycleStatus == "legacy_unverified")
            && pendingStatus != "pending"
    }

    var requiresServerCompletion: Bool {
        emailVerified && (profilePresent == false || pendingStatus == "pending")
    }
}

struct SignupCompletionResult: Equatable {
    let created: Bool
    let pendingCompleted: Bool
}
