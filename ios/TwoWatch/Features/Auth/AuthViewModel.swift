import AuthenticationServices
import Observation

enum AuthMode: String, CaseIterable, Identifiable {
    case signIn = "Accedi"
    case signUp = "Registrati"

    var id: String { rawValue }
}

@Observable
@MainActor
final class AuthViewModel {
    private let authRepository: AuthenticationRepository
    private let userRepository: UserRepository
    private let analytics: AnalyticsLogging
    private var resendAvailableAt: Date?

    var mode: AuthMode = .signIn
    var email = ""
    var password = ""
    var confirmPassword = ""
    var displayName = ""
    var hasAcceptedCommunitySafetyTerms = false
    var hasConfirmedMinimumAge = false
    var isAwaitingEmailVerification = false
    var verificationEmail = ""
    var isLoading = false
    var activeSocialProvider: String?
    var errorMessage: String?
    var successMessage: String?

    init(
        authRepository: AuthenticationRepository,
        userRepository: UserRepository,
        analytics: AnalyticsLogging = NoopAnalyticsLogger()
    ) {
        self.authRepository = authRepository
        self.userRepository = userRepository
        self.analytics = analytics
    }

    var canUseGoogleSignIn: Bool { authRepository.isGoogleSignInAvailable }
    var canUseAppleSignIn: Bool { authRepository.isAppleSignInAvailable }

    func submit() async -> Bool {
        errorMessage = nil
        successMessage = nil
        guard hasAcceptedCommunitySafetyTerms else {
            errorMessage = String(localized: "Accetta i Termini di servizio per continuare.")
            return false
        }

        isLoading = true
        defer { isLoading = false }
        do {
            switch mode {
            case .signIn:
                let user = try await authRepository.signIn(email: email, password: password)
                if authRepository.isUnverifiedPasswordUser(user) {
                    let requiresVerification: Bool
                    do {
                        requiresVerification = try await authRepository.signupState().requiresEmailVerification
                    } catch {
                        // Compatibilità durante il rollout: un profilo già
                        // esistente è legacy; auth-only resta bloccato.
                        requiresVerification = try await userRepository.fetchUser(uid: user.uid) == nil
                    }
                    if requiresVerification {
                        presentVerification(for: user.email)
                        return false
                    }
                }
                return true
            case .signUp:
                guard password == confirmPassword else {
                    errorMessage = String(localized: "Le password non coincidono.")
                    return false
                }
                guard hasConfirmedMinimumAge else {
                    errorMessage = String(localized: "Devi confermare di avere almeno 14 anni per registrarti.")
                    return false
                }
                let user = try await authRepository.signUp(email: email, password: password)
                try await authRepository.registerPendingSignup(
                    displayName: displayName,
                    ageConfirmed: hasConfirmedMinimumAge
                )
                try await authRepository.sendSignupVerification()
                resendAvailableAt = Date().addingTimeInterval(60)
                presentVerification(for: user.email)
                successMessage = String(localized: "Link inviato. Controlla anche lo spam.")
                return false
            }
        } catch {
            errorMessage = AuthenticationRepository.friendlyMessage(for: error)
            return false
        }
    }

    func resumePendingSignupIfNeeded() async {
        guard isAwaitingEmailVerification == false,
              let user = authRepository.currentUser,
              authRepository.isUnverifiedPasswordUser(user)
        else { return }
        if authRepository.shouldHoldForEmailVerification(user) {
            presentVerification(for: user.email)
            return
        }
        do {
            let state = try await authRepository.signupState()
            if state.requiresEmailVerification {
                presentVerification(for: user.email)
            }
        } catch {
            // SessionStore mostra il recupero se il backend non è raggiungibile.
        }
    }

    func checkVerification() async -> Bool {
        isLoading = true
        errorMessage = nil
        successMessage = nil
        defer { isLoading = false }
        do {
            let user = try await authRepository.reloadCurrentUser()
            guard user.isEmailVerified else {
                successMessage = String(localized: "Email non ancora verificata.")
                return false
            }
            let completion = try await authRepository.completeVerifiedSignup()
            if completion.pendingCompleted {
                analytics.log(AnalyticsEvent.signupCompleted, ["method": "email"])
            }
            successMessage = String(localized: "Email verificata.")
            return true
        } catch {
            errorMessage = AuthenticationRepository.friendlyMessage(for: error)
            return false
        }
    }

    func resendVerification() async {
        if let resendAvailableAt, resendAvailableAt > Date() {
            let seconds = max(1, Int(resendAvailableAt.timeIntervalSinceNow.rounded(.up)))
            successMessage = String(localized: "Puoi inviare di nuovo tra \(seconds) secondi.")
            return
        }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            if displayName.isEmpty == false && hasConfirmedMinimumAge {
                try await authRepository.registerPendingSignup(
                    displayName: displayName,
                    ageConfirmed: hasConfirmedMinimumAge
                )
            }
            try await authRepository.sendSignupVerification()
            resendAvailableAt = Date().addingTimeInterval(60)
            successMessage = String(localized: "Link inviato. Controlla anche lo spam.")
        } catch {
            errorMessage = AuthenticationRepository.friendlyMessage(for: error)
        }
    }

    func useAnotherEmail() {
        do {
            try authRepository.signOut()
            isAwaitingEmailVerification = false
            mode = .signUp
            email = ""
            password = ""
            confirmPassword = ""
            errorMessage = nil
            successMessage = nil
        } catch {
            errorMessage = AuthenticationRepository.friendlyMessage(for: error)
        }
    }

    func exitVerification() {
        do {
            try authRepository.signOut()
            isAwaitingEmailVerification = false
            mode = .signIn
            password = ""
            confirmPassword = ""
            errorMessage = nil
            successMessage = nil
        } catch {
            errorMessage = AuthenticationRepository.friendlyMessage(for: error)
        }
    }

    func sendPasswordReset() async {
        guard email.isEmpty == false else {
            errorMessage = String(localized: "Inserisci l'email per ricevere il link di reset.")
            successMessage = nil
            return
        }
        isLoading = true
        errorMessage = nil
        successMessage = nil
        defer { isLoading = false }
        do {
            try await authRepository.resetPassword(email: email)
            successMessage = String(localized: "Ti abbiamo inviato il link per il reset.")
        } catch {
            errorMessage = AuthenticationRepository.friendlyMessage(for: error)
        }
    }

    func signInWithGoogle() async -> Bool {
        guard hasAcceptedCommunitySafetyTerms else {
            errorMessage = String(localized: "Accetta i Termini di servizio per continuare.")
            return false
        }
        isLoading = true
        activeSocialProvider = "google"
        errorMessage = nil
        successMessage = nil
        defer { isLoading = false; activeSocialProvider = nil }
        do {
            let result = try await authRepository.signInWithGoogle()
            if result.isNewUser {
                try await userRepository.acceptCommunitySafetyTerms(userID: result.user.uid)
                analytics.log(AnalyticsEvent.signupCompleted, ["method": "google"])
            }
            return true
        } catch {
            errorMessage = AuthenticationRepository.friendlyMessage(for: error)
            return false
        }
    }

    func prepareAppleSignIn(_ request: ASAuthorizationAppleIDRequest) {
        authRepository.prepareAppleSignInRequest(request)
    }

    func signInWithApple(_ result: Result<ASAuthorization, Error>) async -> Bool {
        guard hasAcceptedCommunitySafetyTerms else {
            errorMessage = String(localized: "Accetta i Termini di servizio per continuare.")
            return false
        }
        isLoading = true
        activeSocialProvider = "apple"
        errorMessage = nil
        successMessage = nil
        defer { isLoading = false; activeSocialProvider = nil }
        do {
            let authResult = try await authRepository.signInWithApple(result: result)
            if authResult.isNewUser {
                try await userRepository.acceptCommunitySafetyTerms(userID: authResult.user.uid)
                analytics.log(AnalyticsEvent.signupCompleted, ["method": "apple"])
            }
            return true
        } catch {
            errorMessage = AuthenticationRepository.friendlyMessage(for: error)
            return false
        }
    }

    private func presentVerification(for email: String?) {
        verificationEmail = Self.maskedEmail(email ?? self.email)
        isAwaitingEmailVerification = true
    }

    nonisolated static func maskedEmail(_ value: String) -> String {
        let parts = value.split(separator: "@", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return value }
        let local = parts[0]
        let visible = String(local.prefix(min(2, local.count)))
        return "\(visible)•••@\(parts[1])"
    }
}
